// ==================================================================
// ===== MERCHANT MANAGER ===========================================
// ==================================================================
//
// State, interaction claiming, recipient policy, and the GM-authoritative handler.

import {
    MODULE, MERCHANT_FLAG, STOCK, PAR_FLAG, FREE_FLAG, DEFAULT_RESTOCK_DAYS, DEFAULT_SHOP_KIND,
    DEFAULT_MAX_PRODUCTS, DEFAULT_MAX_PER_ITEM,
    DEFAULT_TILL, INVENTORY_FLAG, INVENTORY_TYPE, INVENTORY_TYPES, DEFAULT_TABLE_ROLLS,
    inventoryType, isPurchased, isScheduledOpen, hourAt, secondsPerDay, SOURCE, DEFAULT_SOURCE,
    DEFAULT_STOCK_DEPTH, depthScale, typeCaps, rarityCaps
} from './const.js';
import {
    grantItem, grantItems, grantCurrency, isPhysical, exchange, hasExchange, setCurrency, hasSetCurrency
} from './utility-inventory.js';
import {
    resolvePrice, resolvePurchasePrice, planSettlement, purseValue, fromBase, stockDepth
} from './utility-pricing.js';
import { ShopWindow } from './window-shop.js';
import { notify } from './utility-feedback.js';
import { resolveReputation, invalidateReputation } from './utility-reputation.js';
import { marketRate } from './utility-market.js';
import { emit, on, SOCKET_EVENT } from './utility-sockets.js';
import { hasQuery, queryStock } from './utility-compendium.js';

const CONTEXT = 'merchant-interaction';

/**
 * The inventory schema this build writes.
 *
 * **Nothing migrates, and nothing needs to.** Merchant has not shipped, so no world
 * holds a shape this build cannot read — five schema versions and their migration
 * passes came out on 2026-08-24 along with the flag rename, the type derivation and the
 * par backfill they carried. Two of that week's bugs were *in* migration code that would
 * never have run, which is the argument against writing it early rather than for it.
 *
 * The number stays because it costs one line and the first release makes it real: from
 * then on, a stored shape that changes needs moving rather than reading around, and the
 * version is what says which world is which. Bump it and write the pass at the same time.
 */
const SCHEMA_VERSION = 1;

/**
 * Whether a value contains an array anywhere a flag merge would mangle.
 *
 * Foundry merges arrays by index, so a shorter list never replaces a longer one. Scalars
 * and plain objects merge correctly and need no clearing.
 */
function _holdsList(value) {
    if (Array.isArray(value)) return true;
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(_holdsList);
}

export class MerchantManager {
    static _interactionId = null;

    static initialize() {
        this._registerTokenInteraction();
        this._registerRequestOp();
        this._registerRefreshListener();
        this._registerScheduleWatcher();
        this._registerStockWatcher();
        // Every client, because every client is showing prices. Blacksmith emits the
        // change to all of them, so this needs no GM gate and no broadcast of ours.
        this.hook('blacksmith.partyReputationChanged', 'Reprice open shops when the party\'s standing changes', (data) => {
            invalidateReputation(data);
            for (const win of ShopWindow.openWindows()) void win.render(false);
        });
    }

    static teardown() {
        const tokens = game.modules.get('coffee-pub-blacksmith')?.api?.tokens;
        if (this._interactionId && typeof tokens?.disposeByContext === 'function') {
            tokens.disposeByContext(CONTEXT);
        }
        this._interactionId = null;
        // Now that the hooks are registered under a context, teardown can undo all of
        // it rather than half. It used to dispose the token claim and leave three
        // `Hooks.on` callbacks running for the rest of the session.
        globalThis.BlacksmithHookManager?.disposeByContext?.(CONTEXT);
    }

    /**
     * Register a hook under this module's context.
     *
     * Through Blacksmith's manager so `teardown` can dispose the lot by context, the
     * same way the token claim already is. Falls back to a bare `Hooks.on` if the
     * manager is not there: a hook that cannot be disposed is worse than one that can,
     * and much better than a module that does not react to anything.
     *
     * **No throttling here, deliberately.** The obvious move is `throttleMs` on the
     * item watchers, and it would be wrong: a throttle drops whole events rather than
     * coalescing them, so a burst touching two different merchants could lose the
     * second one's refresh entirely. The coalescing belongs on the broadcast, where it
     * knows what it is merging — see `broadcastActorRefresh`.
     *
     * **No `canCancel` either, because nothing here is a `pre*` hook.** Blacksmith made
     * cancellation opt-in on 2026-08-22, after the previous behaviour let any callback
     * returning a falsy value veto the operation *world-wide* — one Foundry handler
     * serves every callback on a hook name, so `(doc) => this.tracked.has(doc.id)` on
     * `preCreateItem` silently blocked item creation for every module in the world.
     * Merchant watches only `updateItem`, `createItem`, `deleteItem`, `updateWorldTime`,
     * `userConnected`, `getHeaderControlsApplicationV2` and two Blacksmith events; none
     * of them cancels anything. If a `pre*` watcher is ever added here it must pass
     * `canCancel: true` at the **top level** — inside `options` it is ignored with a
     * warning — and the callbacks below must keep returning nothing.
     */
    static hook(name, description, callback) {
        const manager = globalThis.BlacksmithHookManager;
        if (typeof manager?.registerHook === 'function') {
            return manager.registerHook({ name, description, context: CONTEXT, callback });
        }
        return Hooks.on(name, callback);
    }

    // ==============================================================
    // ===== STATE ==================================================
    // ==============================================================
    // On the Actor, never the Token. A shop is a persistent entity: flagging the
    // token would make every placed instance a separate shop, and deleting the token
    // would lose the configuration.

    static getConfig(actor) {
        return actor?.getFlag(MODULE.ID, MERCHANT_FLAG) ?? null;
    }

    static isMerchant(actor) {
        return this.getConfig(actor)?.enabled === true;
    }

    /** Token-shaped convenience for the interaction claim, which sees documents. */
    static isMerchantToken(tokenDocument) {
        return this.isMerchant(tokenDocument?.actor);
    }

    static defaultConfig() {
        return {
            enabled: true,
            name: null,
            kind: DEFAULT_SHOP_KIND,
            // Free text, GM-authored, optional. Enriched when shown, so a GM can put
            // a journal link or an inline roll in it.
            description: '',
            // Open for business. A closed shop still opens for browsing — you can
            // look through the window — but nothing changes hands.
            // Only consulted when there is no schedule. With one, the schedule
            // decides and `override` is the GM's exception to it — see `isOpen`.
            open: true,
            hours: null,
            // `{ open, against }` — what the GM chose, and what the schedule said at
            // the moment they chose it. Null when they have not overruled anything.
            override: null,
            // `markup` is the shop's baseline — an expensive quarter, or the middle of
            // nowhere — and every inventory multiplies against it rather than
            // replacing it. `reputation` opts into the party's standing moving prices
            // at all: off by default, because a shop whose prices move for a reason
            // the GM never chose is a mystery.
            pricing: { markup: 1.0, reputation: false, overrides: {} }
        };
    }

    static async setConfig(actor, changes) {
        const current = this.getConfig(actor) ?? this.defaultConfig();
        return actor.setFlag(MODULE.ID, MERCHANT_FLAG, { ...current, ...changes });
    }

    /**
     * Open for business. A closed shop is browsable but nothing can be acquired.
     *
     * **Derived, not stored.** With a schedule, the schedule decides and the GM's
     * override is an exception to it that lapses at the next boundary. Nothing has to
     * fire for this to be right: no hook, no write, no ordering. Read it at any
     * moment and it is the answer for that moment.
     *
     * It used to be a stored flag that a `updateWorldTime` handler kept in step, and
     * a shop whose handler missed a crossing stayed open past its closing hour
     * wearing an override notice it had never been given. Every version of that bug
     * is a version of "the thing that syncs the state did not run", so the state
     * stopped being something to sync.
     *
     * An override stands only while the schedule still says what it said when the
     * override was made. The moment the schedule changes its mind — opening hour,
     * closing hour, a GM editing the hours — `against` no longer matches and the
     * exception is spent.
     */
    static isOpen(actor) {
        const config = this.getConfig(actor);
        if (!config) return false;

        const scheduled = isScheduledOpen(this.getHours(actor), hourAt());
        if (scheduled === null) return config.open !== false;

        const override = config.override;
        if (override && override.against === scheduled) return override.open === true;
        return scheduled;
    }

    /**
     * Whether a GM is currently overruling the schedule.
     *
     * Derived from the same two facts as `isOpen`, so the notice and the state can
     * never disagree — which they did while one was stored and the other computed.
     */
    static isOverridden(actor) {
        const scheduled = isScheduledOpen(this.getHours(actor), hourAt());
        if (scheduled === null) return false;
        const override = this.getConfig(actor)?.override;
        return Boolean(override) && override.against === scheduled && override.open !== scheduled;
    }

    static async setOpen(actor, open) {
        if (!game.user.isGM) return null;
        const wanted = Boolean(open);
        const scheduled = isScheduledOpen(this.getHours(actor), hourAt());

        // No schedule: the toggle is the whole story.
        if (scheduled === null) return this.setConfig(actor, { open: wanted, override: null });

        // Agreeing with the schedule is not an exception to it, so it clears rather
        // than records one — which is how a GM cancels an override by toggling back.
        if (wanted === scheduled) return this.setConfig(actor, { open: wanted, override: null });

        return this.setConfig(actor, { open: wanted, override: { open: wanted, against: scheduled } });
    }

    static getHours(actor) {
        const hours = this.getConfig(actor)?.hours;
        return hours && Number.isFinite(Number(hours.open)) && Number.isFinite(Number(hours.close))
            ? { open: Number(hours.open), close: Number(hours.close) }
            : null;
    }

    static async setHours(actor, hours) {
        if (!game.user.isGM) return null;
        // The override goes with the old hours. Nothing else is needed: `isOpen` is
        // derived, so a shop set to 9-to-6 at noon is open the instant this returns.
        await this.setConfig(actor, { hours, override: null });
        this.broadcastActorRefresh(actor);
        return true;
    }

    /**
     * Drop any standing override.
     *
     * Called when the hours change: an exception made against the old schedule means
     * nothing under a new one, and leaving it would silently apply to hours the GM
     * never overruled.
     */
    static async clearOverride(actor) {
        if (!this.getConfig(actor)?.override) return false;
        await this.setConfig(actor, { override: null });
        this.broadcastActorRefresh(actor);
        return true;
    }

    /**
     * Open and close shops as the world clock passes their hours.
     *
     * GM-only, because every client running this would race the same write. Compares
     * the schedule before and after the jump rather than watching for an exact hour,
     * so advancing eight hours at once still lands on the right state.
     */
    static _registerScheduleWatcher() {
        this.hook('updateWorldTime', 'Open, close and restock shops as the clock moves', () => {
            if (!game.user.isGM) return;
            void this._onWorldTimeChange();
        });
    }

    /**
     * The clock moved.
     *
     * **Nothing here decides whether a shop is open.** `isOpen` reads the schedule
     * every time it is asked, so the state is already right; this only tells open
     * windows to look again, and runs the restocks that genuinely do need a clock.
     *
     * A missed or mis-shaped event is now a stale window rather than a wrong shop,
     * and the next refresh fixes it. That is the whole reason the state stopped being
     * stored.
     */
    static async _onWorldTimeChange() {
        // Independent of the schedule: a restock that throws must not take the
        // opening hours down with it, which sharing one try did.
        try {
            await this._applyRestocks(game.time.worldTime);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not apply restocks:`, error);
        }

        // Only when the schedule's answer has actually changed, so a clock ticking
        // every few seconds is not a refresh every few seconds. Keyed by `actor.uuid`,
        // which is distinct per unlinked token, so three Flippers open and close
        // independently rather than the first one answering for all three.
        for (const actor of this.worldMerchants()) {
            if (!this.getHours(actor)) continue;
            const scheduled = isScheduledOpen(this.getHours(actor), hourAt());
            if (scheduled === this._lastScheduled.get(actor.uuid)) continue;
            this._lastScheduled.set(actor.uuid, scheduled);
            this.broadcastActorRefresh(actor);
        }
    }

    /** Per client and in memory: it decides when to redraw, never what is true. */
    static _lastScheduled = new Map();

    /**
     * Every merchant **in the world**, which is not the same set as every merchant Actor.
     *
     * A linked token *is* its sidebar Actor: Bob keeps a shop in Phlan, and what the
     * party does to his till is still true next season and in whatever city he turns up
     * in. He is a shop whether or not a token of him happens to be on the current map,
     * so he is yielded from `game.actors`.
     *
     * An **unlinked** token is a shop in its own right, with its own ActorDelta, and
     * there can be several of them at once — Flipper the travelling salesman, placed
     * three times, is three shops that know nothing about each other. Each one's
     * `token.actor` is a synthetic Actor living on a scene and is in `game.actors`
     * nowhere, which is why the clock never reached them.
     *
     * And an unlinked merchant Actor sitting in the sidebar is **not** a shop. It is the
     * mould Flipper is cast from. It was the only thing being restocked: the clock ticked
     * on the template, and because an unlinked token inherits anything its delta has not
     * overridden, the template's new stock was then *delivered* into every placed copy.
     * That is not a shop restocking, it is a leak with a schedule.
     *
     * Walks every scene, not the viewed one. A shop does not stop keeping stock because
     * nobody is looking at the map it stands on.
     */
    static *worldMerchants() {
        for (const actor of game.actors ?? []) {
            // `prototypeToken.actorLink` is the whole test: linked means persistent and
            // one of a kind, unlinked means this Actor is a template.
            if (!actor.prototypeToken?.actorLink) continue;
            if (this.isMerchant(actor)) yield actor;
        }

        for (const scene of game.scenes ?? []) {
            for (const token of scene.tokens ?? []) {
                if (token.actorLink) continue;          // already yielded, as its Actor
                // Two cheap reads before the expensive one. This runs on every world-time
                // tick, and `token.actor` on an unlinked token resolves a synthetic Actor;
                // a big world is thousands of tokens and almost none of them are shops.
                if (!token.actorId) continue;
                const actor = token.actor;
                if (this.isMerchant(actor)) yield actor;
            }
        }
    }


    /**
     * Set the gold in the till.
     *
     * **Written directly, and this is the one place Merchant touches currency without
     * `api.inventory`.** The primitives move deltas between purses and refuse negative
     * amounts, so there is no way to express "this shop now holds 40 gp" when it holds
     * 250 — and this is not a transaction, it is a GM editing an NPC's own purse, the
     * same thing dnd5e's sheet does. Nothing leaves or arrives anywhere.
     *
     * Only gold, so a shop with mixed coin does not lose its silver to a round number
     * typed in a settings box.
     */
    static async setTillCoin(actor, denomination, amount) {
        if (!game.user.isGM || !actor || !denomination) return null;
        const value = Math.max(0, Math.trunc(Number(amount) || 0));

        // Only the named coin is written, which is what makes a five-box till safe:
        // editing the silver leaves the gold exactly where it was, and `setCurrency`
        // writes only the denominations it is handed.
        if (hasSetCurrency()) {
            const result = await setCurrency({ targetActorUuid: actor.uuid, currency: { [denomination]: value } });
            if (!result?.ok) {
                console.error(`${MODULE.TITLE} | Could not set the till on ${actor.name}:`, result);
                return null;
            }
            return actor;
        }

        await actor.update({ [`system.currency.${denomination}`]: value });
        return actor;
    }

    /** @deprecated Kept for the gold-only call sites; `setTillCoin` is the general one. */
    static async setTillGold(actor, gold) {
        if (!game.user.isGM || !actor) return null;
        const value = Math.max(0, Math.trunc(Number(gold) || 0));

        // Through the primitive, so the write takes the inventory lock. A raw
        // `actor.update()` takes none, and since `exchange` shipped that is a live race
        // rather than a stylistic point: a settlement reads the till under the lock, an
        // unlocked edit lands in between, and the settlement then writes `stale + delta`
        // straight over it. The GM's edit is gone and nothing says so.
        //
        // Only `gp` is named, so silver and copper are left alone rather than zeroed --
        // this field is "gold to spend", not "the whole purse".
        if (hasSetCurrency()) {
            const result = await setCurrency({ targetActorUuid: actor.uuid, currency: { gp: value } });
            if (!result?.ok) {
                console.error(`${MODULE.TITLE} | Could not set the till on ${actor.name}:`, result);
                return null;
            }
            return actor;
        }

        // A Blacksmith without the primitive still has to be able to set a till. The
        // race is real but rare, and refusing outright would be worse than running it.
        await actor.update({ 'system.currency.gp': value });
        return actor;
    }

    // ==============================================================
    // ===== SHELVES ================================================
    // ==============================================================
    // Stock is what sits on an inventory. Everything else on the Actor is the
    // shopkeeper's own gear and is never for sale — which is the whole reason
    // inventories exist rather than treating every physical item as stock.

    /**
     * An inventory's configuration, with its type guaranteed.
     *
     * A stored type that is not one we know falls back to `general` rather than to
     * nothing — a container copied in from another world, or one a macro made by hand,
     * should read as *a shelf* rather than as a shop with no settings.
     */
    static getInventoryConfig(item) {
        const stored = item?.getFlag(MODULE.ID, INVENTORY_FLAG) ?? null;
        if (!stored) return null;
        if (INVENTORY_TYPES[stored.type]) return stored;
        return { ...stored, type: INVENTORY_TYPE.GENERAL };
    }


    /**
     * Whether an item is one of this merchant's inventories.
     *
     * A container **and** carrying our config: a shopkeeper's own backpack is a container
     * too, and treating it as a shelf would put their bedroll on sale.
     */
    static isInventory(item) {
        return item?.type === 'container' && Boolean(this.getInventoryConfig(item));
    }

    /** The inventory the shop buys into, or null when this merchant buys nothing. */
    static getPurchasedInventory(actor) {
        return this.getInventories(actor, { includeHidden: true })
            .find(({ config }) => isPurchased(config.type)) ?? null;
    }

    // ==============================================================
    // ===== MIGRATION ==============================================
    // ==============================================================


    /** Inventories in display order. Hidden ones are omitted unless asked for. */
    static getInventories(actor, { includeHidden = false } = {}) {
        if (!actor) return [];
        return actor.items
            .filter((item) => this.isInventory(item))
            .filter((item) => includeHidden || this.getInventoryConfig(item).visible !== false)
            .map((item) => ({ item, config: this.getInventoryConfig(item) }))
            // Preset order first, then by name — which is the container's name,
            // because that is the only name an inventory has.
            .sort((a, b) => (a.config.order ?? 0) - (b.config.order ?? 0)
                || String(a.item.name).localeCompare(String(b.item.name)));
    }

    /**
     * What is on an inventory.
     *
     * Inventories are excluded, not merely containers. A container *is* physical and is
     * ordinary stock — a backpack for sale is a backpack for sale — but a GM can drag
     * one inventory into another on the Actor sheet, and nothing stops them. A nested
     * inventory would otherwise appear twice: once as its own section, and once as an item
     * for sale on its parent.
     */
    static getInventoryContents(actor, inventoryItem) {
        return actor.items.filter((item) => item.system?.container === inventoryItem.id
            && isPhysical(item.type)
            && !this.isInventory(item));
    }

    /** The inventory an item sits on, or null if it is the shopkeeper's own gear. */
    static getInventoryFor(actor, item) {
        const containerId = item?.system?.container;
        if (!containerId) return null;
        const container = actor.items.get(containerId);
        return this.isInventory(container) ? container : null;
    }

    /**
     * Create an inventory from a preset.
     *
     * `weightlessContents` and no capacity, so it is unlimited and weighs nothing.
     * Created here rather than shipped in a compendium: a pack is a thing to
     * maintain and its items can be edited into something malformed, whereas this
     * cannot produce an inventory with the wrong flags.
     */
    static async addInventory(actor, typeKey) {
        const definition = INVENTORY_TYPES[typeKey];
        if (!actor || !definition) return null;

        const [created] = await actor.createEmbeddedDocuments('Item', [{
            // The type names it once. After that the container's name is the
            // inventory's name and a GM may call it anything — several inventories of
            // one type is an ordinary shop, and they need telling apart.
            name: definition.name,
            type: 'container',
            img: definition.img,
            system: {
                properties: ['weightlessContents'],
                description: { value: `<p>${definition.hint}</p>` }
            },
            flags: {
                [MODULE.ID]: {
                    [INVENTORY_FLAG]: { type: definition.key, ...definition.defaults }
                }
            }
        }]);
        return created ?? null;
    }

    /**
     * Show or hide a whole inventory. GM-only and written directly: this is the GM
     * curating their own shop, not a player action, so it does not route through the
     * request handler.
     *
     * Deliberately a flag rather than the container's `equipped` state. Equipped is
     * inert on containers so it would have worked, but it is transient state the rest
     * of the ecosystem clears on transfer, it can change without anyone deciding to
     * change it, and it would put one of the three inventory properties somewhere the
     * other two are not.
     */
    static async setInventoryVisible(actor, inventoryId, visible) {
        return this.setInventoryConfig(actor, inventoryId, { visible: Boolean(visible) });
    }

    /** Merge changes into an inventory's configuration. GM-only, written directly. */
    static async setInventoryConfig(actor, inventoryId, changes) {
        if (!game.user.isGM) return null;
        const inventory = actor?.items?.get(inventoryId);
        const config = this.getInventoryConfig(inventory);
        if (!config) return null;

        // **The flag is cleared before it is rewritten, and only when it holds a list.**
        // `setFlag` merges, and Foundry merges an array *by index* — so writing
        // `['weapon']` over a stored `['weapon', 'tool', 'loot']` leaves the last two in
        // place, and the stored value comes back as `{0: …, 1: …, 2: …}` rather than an
        // array at all. Unticking a chip therefore did nothing, twice over: the entry
        // survived the merge, and the shape it survived as no longer read as a list.
        //
        // `-=` first is Foundry's own idiom for "replace, do not merge", and is the same
        // one the schema migration uses. Only for keys that hold arrays: a plain scalar
        // merges correctly and an extra write per keystroke is a write nobody needs.
        const next = { ...config, ...changes };
        const nested = Object.keys(changes).filter((key) => _holdsList(changes[key]));
        if (nested.length) {
            const path = `flags.${MODULE.ID}.${INVENTORY_FLAG}`;
            await inventory.update(Object.fromEntries(nested.map((key) => [`${path}.-=${key}`, null])));
        }
        await inventory.setFlag(MODULE.ID, INVENTORY_FLAG, next);
        return inventory;
    }

    /**
     * Put an item on an inventory from a UUID — a compendium entry, a sidebar item, or
     * anything else Foundry hands over in a drop payload.
     *
     * **One write, and the restock target goes in it.** This used to grant and then
     * `setFlag` the par, which is two sequential writes to one Actor — the shape that
     * trips dnd5e's encumbrance recompute into creating `dnd5eencumbered0` twice and
     * having the server reject the second. `api-inventory.md` is explicit that arrival
     * flags belong in the write and that no amount of awaiting avoids it.
     *
     * `grantItem` takes the container too, so the item arrives on the inventory rather
     * than landing at the root and being moved there.
     */
    static async addToInventory(actor, inventoryId, itemUuid, quantity) {
        if (!game.user.isGM) return { ok: false, code: 'NOT_ALLOWED' };
        const inventory = actor?.items?.get(inventoryId);
        if (!this.isInventory(inventory)) return { ok: false, code: 'NOT_AN_INVENTORY' };

        const config = this.getInventoryConfig(inventory);
        const { maxPerItem } = this.getInventoryLimits(config);

        // The par has to be known before the write, so the arriving quantity is
        // resolved here rather than read back off the result.
        const source = await fromUuid(itemUuid);
        let arriving = Math.trunc(Number(quantity));
        if (!Number.isFinite(arriving) || arriving < 1) {
            // **A drop goes through the same three ceilings a roll does.** A compendium
            // entry reads 1 because that is what one crowbar *is*, not because a shop
            // keeps one; taking that literally is what made every dragged row land as a
            // single item. Armour still lands alone -- that is the rarity and the price
            // agreeing, which is the answer we wanted.
            arriving = stockDepth(source, {
                maxPerItem,
                scale: depthScale(config?.depth ?? DEFAULT_STOCK_DEPTH),
                typeCaps: typeCaps(),
                rarityCaps: rarityCaps()
            });
        }

        // **Par counts what the row will hold, not what this drop carried.** A merge
        // writes only the flags passed here, so sending the arriving quantity alone
        // would set the target *below* the stock standing on the shelf -- and the next
        // restock would look at a full row and see it as over-full.
        const existing = source
            ? this.getInventoryContents(actor, inventory)
                .find((item) => item.name === source.name && item.type === source.type)
            : null;
        const held = Math.max(0, Math.trunc(Number(existing?.system?.quantity ?? 0)));
        const par = Math.min(held + arriving, maxPerItem);

        return grantItem({
            targetActorUuid: actor.uuid,
            itemUuid,
            quantity: arriving,
            // Container membership is part of merge identity, so a merge can only
            // land on a row already on this inventory — stock the GM put elsewhere is
            // never relocated by a restock.
            container: inventoryId,
            // What a GM stocks is what the inventory keeps. On a merge only the flags
            // passed here are written, so topping up an inventory by hand does redefine
            // its target — which is the rule the shop window's editable quantity
            // already follows.
            flags: { [MODULE.ID]: { [PAR_FLAG]: par } }
        });
    }

    /**
     * Remove an inventory through dnd5e's own delete dialog, which asks whether the
     * contents go with it and handles the recursion. Curator learned this the same
     * way: reimplementing it would mean a second answer to a question the system
     * already asks, and the wrong answer orphans everything inside.
     */
    static async removeInventory(actor, inventoryId) {
        if (!game.user.isGM) return false;
        const inventory = actor?.items?.get(inventoryId);
        if (!this.isInventory(inventory)) return false;
        await inventory.deleteDialog();
        // deleteDialog resolves whether or not the GM went through with it, so check
        // rather than assume.
        return !actor.items.get(inventoryId);
    }

    static async setEnabled(actor, enabled) {
        const current = this.getConfig(actor);
        if (!enabled) {
            if (!current) return null;
            // Disabled rather than unset, so pricing and stock survive a shop being
            // closed and later reopened.
            return actor.setFlag(MODULE.ID, MERCHANT_FLAG, { ...current, enabled: false });
        }
        await actor.setFlag(MODULE.ID, MERCHANT_FLAG, { ...this.defaultConfig(), ...(current ?? {}), enabled: true });

        // A merchant with no inventory is an empty window and a puzzle. Give the zero
        // config path something to look at.
        if (!this.getInventories(actor, { includeHidden: true }).length) {
            await this.addInventory(actor, 'storefront');
        }

        // And a merchant with no coin cannot buy anything, which surfaces later as a
        // refusal a GM has no reason to expect. Only ever on an empty purse, so a
        // shop deliberately emptied stays that way.
        if (purseValue(actor) === 0) {
            const seeded = await grantCurrency({ targetActorUuid: actor.uuid, currency: { ...DEFAULT_TILL } });
            if (!seeded?.ok) {
                console.warn(`${MODULE.TITLE} | Could not seed the till for ${actor.name}:`, seeded);
            }
        }
        return this.getConfig(actor);
    }

    // ==============================================================
    // ===== STOCK POLICY ===========================================
    // ==============================================================
    // Stock is a count, not a document. A sale grants the buyer a copy and adjusts
    // the number on the merchant's own item; nothing is moved off an inventory. That is
    // what lets a sold-out row stay put, marked out of stock -- which finite stock
    // prefers and restocking stock requires, since a deleted row is not a row
    // anything can restock. See documentation/DECISIONS-TO-REVIEW.md.

    /**
     * Which policy governs an inventory.
     *
     * **Stated per inventory, never inherited.** There used to be a shop-wide default
     * an inventory could fall back to, and the inheritance was not wrong so much as
     * invisible: two places set one thing, one of them silently, and a GM reading
     * "Same as the shop" could not tell what it meant without going to look. One
     * number, in one place, on the thing it governs.
     *
     * A purchased inventory is finite whatever it says. Its stock is whatever the
     * party sold it, so there is no level to return to.
     */
    static resolveStockPolicy(actor, inventoryConfig) {
        if (isPurchased(inventoryConfig?.type)) return STOCK.FINITE;
        const policies = Object.values(STOCK);
        if (policies.includes(inventoryConfig?.stock)) return inventoryConfig.stock;
        return inventoryType(inventoryConfig?.type).defaults.stock ?? STOCK.INFINITE;
    }

    /**
     * What is on the inventory, and what it refills to.
     *
     * `par` falls back to the current quantity so an inventory stocked before this
     * existed reads as full rather than as due for a restock to zero.
     */
    static getStock(actor, item, inventoryConfig) {
        const config = inventoryConfig ?? this.getInventoryConfig(this.getInventoryFor(actor, item));
        const policy = this.resolveStockPolicy(actor, config);
        if (policy === STOCK.INFINITE) {
            return { policy, unlimited: true, available: Infinity, par: null };
        }
        const available = Math.max(0, Math.trunc(Number(item?.system?.quantity ?? 0)));

        // **A buyback inventory has no restock target, and must not inherit one.** Its stock
        // is whatever the party sold; there is nothing it is "kept at".
        //
        // This is a guard against a real leak, not a tidiness rule. `registerTransientFlag`
        // makes a flag invisible to *merge comparison* -- it does not strip it from the
        // payload -- so `par` travels with a bought item into the buyer's inventory and
        // back again if they sell it. A bedroll bought from an inventory kept at six arrives
        // on the buyback inventory still claiming a par of six, and the next Restock
        // Everything manufactures five bedrolls the shop never had, from a target it
        // never set.
        //
        // Blacksmith's `omitFlags` will stop the flag arriving at all. This stays after
        // that lands: it is correct on its own terms, and it covers every item already in
        // a world with the flag on it.
        if (isPurchased(config?.type)) {
            return { policy, unlimited: false, available, par: available };
        }

        const stored = Number(item?.getFlag(MODULE.ID, PAR_FLAG));

        // No par flag means "as many as are there", which is right for something a GM
        // dropped on an inventory and never thought about again -- and is why a row that
        // only ever arrived by table roll creeps upward: each delivery raises the
        // quantity, which raises the target, which the next restock then protects.
        //
        // Read through the ceiling as well as written through it, because an inventory's
        // limit can be lowered after a target was set and the stored flag would then
        // be the higher of the two.
        const raw = Number.isFinite(stored) ? Math.max(0, Math.trunc(stored)) : available;
        const par = Math.min(raw, this.getInventoryLimits(config).maxPerItem);
        return { policy, unlimited: false, available, par };
    }

    /**
     * What an inventory will hold: distinct rows, and how many of any one thing.
     *
     * Per inventory rather than per shop, because a storefront and a back room are
     * different sizes in every shop that has both.
     */
    static getInventoryLimits(inventoryConfig) {
        const products = Math.trunc(Number(inventoryConfig?.maxProducts));
        const perItem = Math.trunc(Number(inventoryConfig?.maxPerItem));
        return {
            maxProducts: Number.isFinite(products) && products > 0 ? products : DEFAULT_MAX_PRODUCTS,
            maxPerItem: Number.isFinite(perItem) && perItem > 0 ? perItem : DEFAULT_MAX_PER_ITEM
        };
    }

    /**
     * Set a count by hand, which also sets what the inventory restocks to.
     *
     * A GM saying "I keep six of these" is describing the shop, not making a sale, so
     * both numbers move. A purchase lowers the count and leaves the target alone.
     */
    static async setStockQuantity(actor, itemId, quantity) {
        if (!game.user.isGM) return null;
        const item = actor?.items?.get(itemId);
        if (!item) return null;

        const wanted = Math.max(0, Math.trunc(Number(quantity) || 0));
        // Clamped to the inventory's ceiling rather than accepted and quietly undone.
        // Storing 10 under a limit of 5 would leave the row reading 10 while its
        // restock target read 5 -- two numbers disagreeing with no way to see why.
        // One number governs, and the inventory's limit is where it is raised.
        const inventoryConfig = this.getInventoryConfig(this.getInventoryFor(actor, item));
        const { maxPerItem } = this.getInventoryLimits(inventoryConfig);
        const value = Math.min(wanted, maxPerItem);

        await item.update({
            'system.quantity': value,
            [`flags.${MODULE.ID}.${PAR_FLAG}`]: value
        });
        return { item, value, clamped: value !== wanted, maxPerItem };
    }

    /**
     * Set what an item is worth, in base units. GM only.
     *
     * **The item's own price, not an agreement.** An agreement is one price for one
     * trade and is cleared when that trade settles; this is what the thing costs, and
     * it outlives the person standing at the counter. So it is written to
     * `system.price` — where the item sheet shows it, where a copy dragged out of the
     * shop carries it, and where every multiplier in `resolvePrice` starts from.
     *
     * Stored in **gp** whatever the item arrived in. Base units are copper and writing
     * 1000 cp for a 10 gp potion would be true and unreadable on the sheet; the
     * denomination is a display choice, and gp is the one dnd5e prices in.
     *
     * `null` clears the price, putting the item back to having none.
     */
    static async setListPrice(actor, itemId, base) {
        if (!game.user.isGM) return null;
        const item = actor?.items?.get(itemId);
        if (!item) return null;

        // **Three states, and 0 is not the absence of one.** Clearing puts the row back
        // to having no price, which is a row nobody has valued; 0 puts it on the house,
        // which is a decision. Both store `price.value` at 0 -- dnd5e has nowhere else
        // to put "nothing" -- so the flag is what tells them apart. See `FREE_FLAG`.
        if (base === null) {
            await item.update({
                'system.price.value': 0,
                [`flags.${MODULE.ID}.-=${FREE_FLAG}`]: null
            });
            return { item, base: null };
        }

        const value = Math.max(0, Number(base) || 0);
        if (value === 0) {
            await item.update({
                'system.price.value': 0,
                [`flags.${MODULE.ID}.${FREE_FLAG}`]: true
            });
            return { item, base: 0 };
        }

        await item.update({
            'system.price.value': fromBase(value, 'gp'),
            'system.price.denomination': 'gp',
            [`flags.${MODULE.ID}.-=${FREE_FLAG}`]: null
        });
        return { item, base: value };
    }

    /**
     * Agree a price for one thing, in base units.
     *
     * **Written to the merchant, not carried in the request.** A price is the one
     * number in a transaction a player must not be able to name, and a slate is
     * client state. Putting it on the document means the GM handler reads the same
     * figure whoever presses the button.
     *
     * `side` says which way it runs: what the shop charges for its own goods, or what
     * it will pay for one of yours. Two different agreements about two different
     * items, which is why they are two maps rather than one.
     *
     * `null` clears it, and clearing a negotiate-inventory item puts it back to having no
     * price at all — which is the state that inventory exists to express.
     */
    static async setNegotiatedPrice(merchant, itemId, base, { side = 'buy' } = {}) {
        if (!game.user.isGM || !merchant || !itemId) return null;

        const key = side === 'sell' ? 'purchaseOverrides' : 'overrides';
        const pricing = { ...(this.getConfig(merchant)?.pricing ?? {}) };
        const agreed = { ...(pricing[key] ?? {}) };

        if (base === null || base === undefined) delete agreed[itemId];
        else agreed[itemId] = Math.max(0, Math.round(Number(base) || 0));

        pricing[key] = agreed;
        await this.setConfig(merchant, { pricing });
        this.broadcastActorRefresh(merchant);
        return true;
    }

    /**
     * Serialise everything that reads a count and then writes it.
     *
     * Only restocking, now that every transaction is a single `exchange`: that
     * primitive takes its own locks over every Actor named and validates each leg
     * against the state at the start of the call, so two players racing for the last
     * item are settled inside it. Restocking is our own read-modify-write and is
     * still ours to serialise.
     *
     * A promise chain is enough because exactly one client runs this. `activeGM` is
     * deterministic across clients, so every request lands on the same GM and there
     * is no second process to coordinate with.
     */
    static _stockLocks = new Map();

    static _withStockLock(actor, fn) {
        const key = actor?.uuid ?? 'unknown';
        const previous = this._stockLocks.get(key) ?? Promise.resolve();
        // Both handlers, so one caller's failure does not strand the queue behind it.
        const run = previous.then(fn, fn);
        const tail = run.then(() => {}, () => {});
        this._stockLocks.set(key, tail);
        void tail.then(() => {
            if (this._stockLocks.get(key) === tail) this._stockLocks.delete(key);
        });
        return run;
    }

    /**
     * The tables an inventory restocks from, each with its own number of rolls.
     *
     * A shop is rarely one table. A general store might roll on *common goods* three
     * times, *potions* once, and *whatever fell off a cart* once — and expressing
     * that as one table means building a combined table for every shop.
     *
     * Uuids rather than ids, so a table in a compendium works the same as one in the
     * world — which is where a GM keeps this sort of table.
     *
     * Reads a single `table` from before this took a list, so an inventory configured
     * earlier keeps working without a migration pass.
     */
    static getInventoryTables(inventory) {
        const config = this.getInventoryConfig(inventory);
        if (!config) return [];

        const list = Array.isArray(config.tables) ? config.tables : [];
        if (list.length) {
            return list
                .filter((entry) => entry?.uuid)
                .map((entry) => ({
                    uuid: entry.uuid,
                    rolls: this._rollCount(entry.rolls),
                    // Off by default: a table that fires on every restock adds stock
                    // for ever, and a shop quietly filling up is a worse surprise than
                    // one that needs a switch thrown.
                    auto: entry.auto === true,
                    // **Absent means on.** A table configured before this existed was
                    // rolling, and a flag that silently switched off every table in
                    // every world would be a bad way to introduce a switch.
                    enabled: entry.enabled !== false
                }));
        }
        return config.table
            ? [{ uuid: config.table, rolls: this._rollCount(config.tableRolls), auto: false, enabled: true }]
            : [];
    }

    /** One to twenty. An inventory rolling nothing is an inventory with no table on it. */
    static _rollCount(value) {
        return Math.min(20, Math.max(1, Math.trunc(Number(value) || 1)));
    }

    static async addInventoryTable(actor, inventoryId, uuid) {
        if (!uuid) return null;
        const inventory = actor?.items?.get(inventoryId);
        const tables = this.getInventoryTables(inventory);
        // Dropping the same table twice is a slip, not a request for double rolls;
        // the roll count is how you ask for that.
        if (tables.some((entry) => entry.uuid === uuid)) return null;
        return this.setInventoryConfig(actor, inventoryId, {
            tables: [...tables, { uuid, rolls: DEFAULT_TABLE_ROLLS, auto: false }],
            // The single-table fields are what this list replaced.
            table: null,
            tableRolls: null
        });
    }

    static async removeInventoryTable(actor, inventoryId, uuid) {
        const inventory = actor?.items?.get(inventoryId);
        const tables = this.getInventoryTables(inventory).filter((entry) => entry.uuid !== uuid);
        return this.setInventoryConfig(actor, inventoryId, { tables, table: null, tableRolls: null });
    }

    static async setInventoryTableRolls(actor, inventoryId, uuid, rolls) {
        return this._updateInventoryTable(actor, inventoryId, uuid, { rolls: this._rollCount(rolls) });
    }

    /** Whether a table contributes at all. Off keeps it configured and dormant. */
    static async setInventoryTableEnabled(actor, inventoryId, uuid, enabled) {
        return this._updateInventoryTable(actor, inventoryId, uuid, { enabled: Boolean(enabled) });
    }

    /** Whether this table also fires when the clock brings a restock round. */

    static async _updateInventoryTable(actor, inventoryId, uuid, changes) {
        const inventory = actor?.items?.get(inventoryId);
        const tables = this.getInventoryTables(inventory)
            .map((entry) => (entry.uuid === uuid ? { ...entry, ...changes } : entry));
        return this.setInventoryConfig(actor, inventoryId, { tables, table: null, tableRolls: null });
    }

    /**
     * Roll an inventory's tables and put what comes up on it.
     *
     * **`roll()`, not `draw()`.** Drawing marks results as drawn, so a shop restocking
     * from a table would exhaust it and then quietly stock nothing. A shop's table is
     * a description of what it tends to carry, not a bag things are taken out of.
     *
     * Non-item results are skipped rather than refused: a table with a "nothing this
     * week" text row is a reasonable table, and so is one mixing items with flavour.
     *
     * **`automatic` is the difference between stocking a shop and running one.** A GM
     * pressing Restock has asked for it, so every table rolls. The clock coming round
     * only rolls the tables marked to reroll — otherwise every table would add stock
     * on every cycle and a shop left alone would fill up for ever. Most tables are
     * there to furnish an inventory once; the ones that are not say so.
     */
    static async rollInventoryTable(actor, inventoryId, { automatic = false, onStep = null } = {}) {
        if (!game.user.isGM) return 0;
        const inventory = actor?.items?.get(inventoryId);
        if (!this.getInventoryConfig(inventory)) return 0;
        const step = typeof onStep === 'function' ? onStep : () => {};

        const drawn = [];
        // uuid -> the table that drew it. Only needed when something fails to resolve,
        // which is exactly when a bare uuid is no use to anybody.
        const source = new Map();
        for (const entry of this.getInventoryTables(inventory)) {
            // A table switched off is configured and dormant: it keeps its rolls and
            // its place, and contributes nothing until it is switched back on.
            if (!entry.enabled) continue;
            if (automatic && !entry.auto) continue;
            let table = null;
            try {
                table = await fromUuid(entry.uuid);
            } catch (_error) {
                table = null;
            }
            // A table deleted since it was assigned is skipped, not fatal: the other
            // tables on the inventory should still deliver.
            if (table?.documentName !== 'RollTable') {
                console.warn(`${MODULE.TITLE} | ${inventory.name} names a roll table that no longer resolves:`, entry.uuid);
                continue;
            }

            for (let i = 0; i < entry.rolls; i++) {
                let results = [];
                try {
                    ({ results = [] } = await table.roll());
                } catch (error) {
                    console.error(`${MODULE.TITLE} | Could not roll ${table.name}:`, error);
                    // The rolls this table will not now make are still owed to the
                    // bar, or it stops short of its own end.
                    for (let owed = i; owed < entry.rolls; owed++) step(game.i18n.format('coffee-pub-merchant.progress.rolling', { table: table.name }));
                    break;
                }
                for (const result of results) {
                    if (!result?.documentUuid) continue;
                    drawn.push(result.documentUuid);
                    if (!source.has(result.documentUuid)) source.set(result.documentUuid, table.name);
                }
                step(game.i18n.format('coffee-pub-merchant.progress.rollingOf', { table: table.name, done: i + 1, total: entry.rolls }));
            }
        }
        if (!drawn.length) { step(game.i18n.format('coffee-pub-merchant.progress.nothingRolled', { inventory: inventory.name })); return 0; }

        // Resolved once per distinct uuid: several tables rolling the same row should
        // cost one lookup, and only physical items can sit on an inventory.
        const resolved = new Map();
        for (const uuid of drawn) {
            if (resolved.has(uuid)) continue;
            let item = null;
            try {
                item = await fromUuid(uuid);
            } catch (_error) {
                item = null;
            }
            resolved.set(uuid, item?.documentName === 'Item' && isPhysical(item.type) ? item : null);
        }

        const broken = [...resolved].filter(([, item]) => !item).map(([uuid]) => uuid);
        if (broken.length) {
            console.warn(
                `${MODULE.TITLE} | ${broken.length} rolled result${broken.length === 1 ? '' : 's'} `
                + `did not resolve to a physical item and were skipped:`,
                broken.map((uuid) => ({ uuid, table: source.get(uuid) ?? '(unknown table)' }))
            );
            // Named by table, because the fix is in the table rather than in the shop.
            const tables = [...new Set(broken.map((uuid) => source.get(uuid)).filter(Boolean))];
            notify.warn(game.i18n.format('coffee-pub-merchant.notify.brokenTableRows', {
                count: broken.length,
                tables: tables.join(', ') || game.i18n.localize('coffee-pub-merchant.common.unknownTable')
            }));
        }

        const items = this._withinLimits(actor, inventory, drawn, resolved);
        if (!items.length) { step(game.i18n.format('coffee-pub-merchant.progress.inventoryFull', { inventory: inventory.name })); return 0; }
        step(game.i18n.format('coffee-pub-merchant.progress.stocking', { inventory: inventory.name }));

        // One call for every table on the inventory, so the same potion rolled by two of
        // them lands as one row of two — see grantItems.
        const result = await grantItems({ targetActorUuid: actor.uuid, items, container: inventoryId });

        // `results` is index-aligned with what was sent and entries fail independently,
        // so the top-level flag alone says only "something went wrong somewhere". A GM
        // reading the console needs to know *which* row and *why* -- a bare
        // `{ ok: false, results: Array(20) }` is not a report, it is a shrug.
        const failures = (result?.results ?? [])
            .map((entry, index) => ({ entry, item: items[index] }))
            .filter(({ entry }) => entry && entry.ok === false);

        if (failures.length) {
            console.error(
                `${MODULE.TITLE} | ${failures.length} of ${items.length} item`
                + `${items.length === 1 ? '' : 's'} did not reach ${inventory.name}:`,
                failures.map(({ entry, item }) => ({
                    uuid: item?.itemUuid,
                    name: resolved.get(item?.itemUuid)?.name ?? '(unresolved)',
                    quantity: item?.quantity,
                    reason: entry?.code ?? entry?.error ?? entry?.reason ?? entry
                }))
            );

            // One cause is worth naming outright, because no amount of looking at this
            // module explains it. Grant paths used to validate a requested quantity
            // against the source document's own -- 1, for a compendium template -- so a
            // inventory asking for five of anything was refused wholesale. Fixed upstream;
            // an install still carrying the old primitive fails here and nowhere else,
            // and the symptom (every row arrives at one, or not at all) looks exactly
            // like a Merchant bug.
            if (failures.some(({ entry }) => entry?.code === 'INSUFFICIENT_QUANTITY')) {
                console.error(
                    `${MODULE.TITLE} | Those refusals mean Blacksmith is out of date. A grant takes nothing `
                    + 'from its source, so a compendium entry\'s own quantity is not a ceiling — update '
                    + 'Coffee Pub Blacksmith and restock again.'
                );
                notify.error(game.i18n.localize('coffee-pub-merchant.notify.blacksmithOutOfDate'));
            }
        } else if (!result?.ok) {
            console.error(`${MODULE.TITLE} | Could not stock ${inventory.name} from its tables:`, result);
        }

        return items.length - failures.length;
    }

    /**
     * Trim a set of rolled results to what the inventory will actually hold.
     *
     * Two ceilings, checked against what is already there plus what this delivery has
     * allocated so far. Without them an inventory rolling weekly grows an ever longer list
     * of one-offs, and an inventory that keeps rolling rations builds toward thousands of
     * them — neither of which announces itself until a fortnight of game time has
     * passed.
     *
     * Rows are matched by name and type. That is the dominant part of the merge
     * identity `grantItems` uses, and a cap that is approximately right is worth far
     * more than one that reimplements the predicate and drifts from it.
     */
    static _withinLimits(actor, inventory, drawn, resolved) {
        const config = this.getInventoryConfig(inventory);
        const { maxProducts, maxPerItem } = this.getInventoryLimits(config);
        const scale = depthScale(config?.depth ?? DEFAULT_STOCK_DEPTH);
        const caps = { typeCaps: typeCaps(), rarityCaps: rarityCaps() };
        const key = (name, type) => `${name}\u0000${type}`;

        const held = new Set();
        for (const item of this.getInventoryContents(actor, inventory)) {
            held.add(key(item.name, item.type));
        }
        let rows = held.size;

        const allowed = [];
        let carried = 0;
        let full = 0;
        for (const uuid of drawn) {
            const item = resolved.get(uuid);
            if (!item) continue;
            const k = key(item.name, item.type);

            // **A roll brings new products, never more of what is already here.**
            // Topping up is what a restock does, and it refills to the level the GM
            // set; a table adding to the same row would push it past that level and
            // make the number they typed mean nothing. It is also where duplicate
            // rows came from. So the shelf's own stock is left entirely alone and the
            // table answers the other question: what else has this shop got hold of.
            if (held.has(k)) { carried++; continue; }

            // The product count is a **target**, not a ceiling to clip against: a
            // shelf that carries twenty and has fifteen rolls for five more. Once it
            // is back to twenty there is nothing left to ask for.
            if (rows >= maxProducts) { full++; continue; }

            // A roll is a delivery, not a unit. How deep it goes is what it is first,
            // then how rare, then what it costs -- see `stockDepth`.
            const depth = stockDepth(item, { maxPerItem, scale, ...caps });
            held.add(k);
            rows++;

            // **The delivery sets the level.** A new row arrives maintained, so the
            // next restock brings it back to what turned up rather than to whatever
            // is left of it. Without this the row has no target at all and `getStock`
            // falls back to the current quantity, which can only ever ratchet down.
            allowed.push({
                itemUuid: uuid,
                quantity: depth,
                flags: { [MODULE.ID]: { [PAR_FLAG]: depth } }
            });
        }

        if (carried || full) {
            console.debug(
                `${MODULE.TITLE} | ${inventory.name}: ${carried} rolled result${carried === 1 ? '' : 's'} `
                + `already carried, ${full} refused for want of a product slot (${maxProducts}).`
            );
        }
        return allowed;
    }

    /**
     * Stock an inventory from the compendiums.
     *
     * The query twin of `rollInventoryTable`, and deliberately the same shape: resolve
     * candidates, hand them to `_withinLimits`, grant what survives. Everything that
     * decides *what lands* -- new products only, the product target, depth by type,
     * rarity and price -- is shared, so a shelf does not behave differently for having
     * been stocked one way rather than the other.
     *
     * **Candidates are shuffled and over-fetched.** The query returns matches in scan
     * order, so taking the first N would give every shop in the world the same opening
     * inventory, in the same order, from the same pack. Asking for several times the
     * product target and shuffling is what makes two general stores different shops.
     */
    static async queryInventory(actor, inventoryId, { onStep = null } = {}) {
        if (!game.user.isGM) return 0;
        const inventory = actor?.items?.get(inventoryId);
        const config = this.getInventoryConfig(inventory);
        if (!config) return 0;
        const step = typeof onStep === 'function' ? onStep : () => {};

        if (!hasQuery()) {
            console.warn(`${MODULE.TITLE} | ${inventory.name} stocks by query, but this Blacksmith has none.`);
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.queryUnavailable'));
            return 0;
        }

        step(game.i18n.format('coffee-pub-merchant.progress.querying', { inventory: inventory.name }));
        const { maxProducts } = this.getInventoryLimits(config);
        const rows = await queryStock(config.query, Math.max(50, maxProducts * 4));
        if (!rows.length) {
            step(game.i18n.format('coffee-pub-merchant.progress.queryEmpty', { inventory: inventory.name }));
            notify.info(game.i18n.format('coffee-pub-merchant.notify.queryEmpty', { inventory: inventory.name }));
            return 0;
        }

        // Fisher-Yates over a copy. `sort(() => Math.random() - 0.5)` is the tempting
        // one-liner and is not a shuffle -- it biases heavily toward the original order,
        // which is the exact thing being shuffled away here.
        const pool = [...rows];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }

        const drawn = [];
        const resolved = new Map();
        for (const row of pool) {
            if (!row?.uuid || resolved.has(row.uuid)) continue;
            let item = null;
            try {
                item = await fromUuid(row.uuid);
            } catch (_error) {
                item = null;
            }
            // Unlike a table, a miss here is not rot -- the query answered from a live
            // index a moment ago -- so it is skipped quietly rather than reported.
            if (item?.documentName !== 'Item' || !isPhysical(item.type)) continue;
            resolved.set(row.uuid, item);
            drawn.push(row.uuid);
        }

        const items = this._withinLimits(actor, inventory, drawn, resolved);
        if (!items.length) {
            step(game.i18n.format('coffee-pub-merchant.progress.inventoryFull', { inventory: inventory.name }));
            return 0;
        }

        step(game.i18n.format('coffee-pub-merchant.progress.stocking', { inventory: inventory.name }));
        const result = await grantItems({ targetActorUuid: actor.uuid, items, container: inventoryId });
        if (!result?.ok) {
            console.error(`${MODULE.TITLE} | Some stock did not reach ${inventory.name}:`, result);
        }
        this.broadcastActorRefresh(actor);
        return items.length;
    }

    /**
     * Can this inventory be restocked at all?
     *
     * **The button's question, which is not quite the clock's.** `restockInventory`
     * decides whether an *unforced* pass does anything; this decides whether the control
     * should be on screen. They differ on one point deliberately: a table with its
     * automatic switch off is skipped by the clock but is exactly what the button is for,
     * so a shelf with tables offers the control even when none of them fire on their own.
     *
     * Everything else is a real dead end. A buyback inventory holds what the party sold
     * and has no level to return to, so restocking it is refused outright. A hand-stocked
     * shelf that is not set to restock has nothing to refill *to* and no source to draw
     * from -- pressing it can only ever report that it did nothing.
     */
    static canRestock(actor, inventory) {
        const config = this.getInventoryConfig(inventory);
        if (!config) return false;
        if (isPurchased(config.type)) return false;

        const source = config.source ?? DEFAULT_SOURCE;
        if (source === SOURCE.QUERY || source === SOURCE.BOTH) return true;
        if (source === SOURCE.TABLE && this.getInventoryTables(inventory).length) return true;
        // Manual, or a table shelf with no tables on it: the only thing left that a
        // restock could do is bring rows back up to their level, and that is only a
        // thing this shelf does if it is set to.
        return this.resolveStockPolicy(actor, config) === STOCK.RESTOCKING;
    }

    /**
     * Fold duplicate rows on an inventory into one.
     *
     * **Nothing creates these any more, and nothing else removes them.** A draw skips
     * anything the shelf already carries, so the current code cannot produce a second
     * Light Hammer -- but a restock only tops rows up to their level, so pairs made before
     * that rule existed, or by a merge that was refused for a reason since fixed, sit
     * there indefinitely. This is the only way to clear them.
     *
     * **Matched on name and type**, the dominant part of the identity a grant merges on.
     * Deliberately not that whole predicate: a second copy of it here is a second copy to
     * drift from the first, and the cost of being approximately right is that a GM might
     * merge two rows they had a reason to keep apart -- which is why this is a button
     * somebody presses rather than something that happens to them.
     *
     * The survivor keeps the **highest** par of the group. Par is what the shelf is kept
     * at, and rows that each restocked to their own level were between them keeping the
     * largest of them.
     */
    static async mergeInventoryDuplicates(actor, inventoryId) {
        if (!game.user.isGM) return 0;
        const inventory = actor?.items?.get(inventoryId);
        const config = this.getInventoryConfig(inventory);
        if (!config) return 0;
        const { maxPerItem } = this.getInventoryLimits(config);

        return this._withStockLock(actor, async () => {
            // Read inside the lock: a purchase settling right now changes these counts,
            // and folding rows together from a stale read invents or loses stock.
            const groups = new Map();
            for (const item of this.getInventoryContents(actor, inventory)) {
                const key = `${item.name}\u0000${item.type}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(item);
            }

            const updates = [];
            const deletes = [];
            for (const rows of groups.values()) {
                if (rows.length < 2) continue;
                // The first row survives, so the shelf keeps the order it had rather than
                // reshuffling around whichever copy happened to be the largest.
                const [keep, ...rest] = rows;
                const total = rows.reduce(
                    (sum, item) => sum + Math.max(0, Math.trunc(Number(item.system?.quantity ?? 0))), 0);
                const par = rows.reduce((highest, item) => {
                    const stored = Number(item.getFlag(MODULE.ID, PAR_FLAG));
                    return Number.isFinite(stored) ? Math.max(highest, stored) : highest;
                }, 0);

                // Clamped like every other write of these two numbers. Three rows of four
                // under a ceiling of ten is the case: the merged row cannot hold twelve,
                // and storing it anyway would leave a count the inventory's own limit says
                // is impossible.
                //
                // The level is the highest of the group and is *not* raised to the merged
                // total. What the shelf is kept at is a decision about the shop; adding
                // together three accidents of history is not that decision. A row sitting
                // above its level is the ordinary state of a shelf somebody just stocked
                // by hand -- a restock tops rows up and never trims them -- so the extra
                // sells through and the shelf settles back to what it keeps.
                const quantity = Math.min(total, maxPerItem);
                updates.push({
                    _id: keep.id,
                    'system.quantity': quantity,
                    [`flags.${MODULE.ID}.${PAR_FLAG}`]: Math.min(par, maxPerItem)
                });
                deletes.push(...rest.map((item) => item.id));
            }

            if (!deletes.length) return 0;
            try {
                // Update before delete. If the delete then fails the shelf is over-counted,
                // which is visible and fixable; the other order loses stock silently.
                await actor.updateEmbeddedDocuments('Item', updates);
                await actor.deleteEmbeddedDocuments('Item', deletes);
            } catch (error) {
                console.error(`${MODULE.TITLE} | Could not merge duplicates on ${inventory.name}:`, error);
                return 0;
            }
            this.broadcastActorRefresh(actor);
            return deletes.length;
        });
    }

    /**
     * Take everything off an inventory, leaving the inventory.
     *
     * Distinct from removing the inventory and from setting counts to zero, which are the
     * two things it sits between: zero says "sold out", deleting the container says
     * "this shop has no such inventory", and this says "clear it and let me start again".
     * A GM re-rolling a shop's stock wants the third and had to do it a row at a time.
     *
     * One `deleteEmbeddedDocuments` for the lot -- a delete per row is a write per row
     * to the same Actor, and doing it in a loop is what makes a fast clicker race the
     * re-render.
     */
    static async clearInventory(actor, inventoryId) {
        if (!game.user.isGM) return 0;
        const inventory = actor?.items?.get(inventoryId);
        if (!this.getInventoryConfig(inventory)) return 0;

        return this._withStockLock(actor, async () => {
            // Read inside the lock: a purchase settling right now changes this list.
            const ids = this.getInventoryContents(actor, inventory).map((item) => item.id);
            if (!ids.length) return 0;
            try {
                await actor.deleteEmbeddedDocuments('Item', ids);
            } catch (error) {
                console.error(`${MODULE.TITLE} | Could not clear ${inventory.name}:`, error);
                return 0;
            }
            this.broadcastActorRefresh(actor);
            return ids.length;
        });
    }

    /**
     * How many steps restocking this inventory will take, for sizing a progress bar.
     *
     * Counted the same way `restockInventory` spends them -- one for the refill, one per
     * roll, one for the delivery -- so the bar reaches its end exactly when the work
     * does. A total derived any other way drifts, and a bar that stops at 80% or hits
     * 100% early is worse than no bar, because it is a claim rather than a guess.
     */
    static restockWorkUnits(actor, inventoryId, { force = false } = {}) {
        const inventory = actor?.items?.get(inventoryId);
        if (!this.getInventoryConfig(inventory)) return 0;

        let units = 1;
        for (const entry of this.getInventoryTables(inventory)) {
            if (!entry.enabled) continue;
            if (!force && !entry.auto) continue;
            units += Math.max(0, Math.trunc(Number(entry.rolls) || 0));
        }
        return units + 1;
    }

    /**
     * Refill an inventory to its par levels.
     *
     * `force` is the GM pressing the button, which works on a finite inventory too -- a
     * shop restocked by hand is an ordinary thing, and a finite inventory still knows
     * what it holds.
     */
    static async restockInventory(actor, inventoryId, { force = false, onStep = null } = {}) {
        if (!game.user.isGM) return 0;
        const inventory = actor?.items?.get(inventoryId);
        const config = this.getInventoryConfig(inventory);
        if (!config) return 0;
        // A purchased inventory holds what the party sold and nothing else. There is
        // no level to return to, and refilling to one would conjure duplicates of
        // somebody's old sword. The window hides the control; this is what makes it
        // true, including for `restockAll` and the clock.
        if (isPurchased(config.type)) return 0;
        const step = typeof onStep === 'function' ? onStep : () => {};
        // A query shelf draws on the clock like a table-stocked one: it has no `auto`
        // flag to consult, because the shelf itself is the thing that says "keep me
        // stocked from the compendiums".
        const source = config.source ?? DEFAULT_SOURCE;
        // A query shelf draws on the clock because the shelf itself says so; a table
        // shelf draws when one of its tables is set to. "Both" qualifies on either.
        const draws = source === SOURCE.QUERY || source === SOURCE.BOTH
            || (source === SOURCE.TABLE
                && this.getInventoryTables(inventory).some((entry) => entry.auto));
        if (!force && this.resolveStockPolicy(actor, config) !== STOCK.RESTOCKING && !draws) return 0;

        const filled = await this._withStockLock(actor, async () => {
            const updates = [];
            for (const item of this.getInventoryContents(actor, inventory)) {
                const stock = this.getStock(actor, item, config);
                if (stock.unlimited || stock.available >= stock.par) continue;
                updates.push({ _id: item.id, 'system.quantity': stock.par });
            }
            if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
            return updates.length;
        });
        step(game.i18n.format('coffee-pub-merchant.progress.refilling', { inventory: inventory.name }));

        // Two mechanisms, deliberately both: par brings back what the inventory is known
        // to keep, and the draw brings in whatever it happens to have got hold of this
        // time. An inventory may use either or both.
        //
        // **Which draw is a property of the shelf, not of the caller.** A table is a
        // curated, weighted list somebody wrote; a query is a description of what this
        // shop deals in, answered against what is installed right now. They are the same
        // step with different sources, so everything downstream -- new products only, up
        // to the product target, depth by type/rarity/price -- is shared.
        // **Manual draws nothing, on purpose.** Its rows are still topped up to their
        // quantity above; what it never does is bring in something the GM did not put
        // there. That is a different statement from a table shelf that happens to have
        // no tables, and it is the one a curated shelf wants to make.
        // **Tables first, then the query.** Both feed the same slot count, so on a shelf
        // that is nearly full the order decides who gets the last few. Tables are the
        // deliberate half — somebody wrote that list — and the query is filler, so the
        // curated stock lands and the ordinary stock takes what is left. Nothing arrives
        // twice: `_withinLimits` matches rows by name and type, so the same longsword
        // from both sources is one row.
        let rolled = 0;
        if (source === SOURCE.TABLE || source === SOURCE.BOTH) {
            rolled += await this.rollInventoryTable(actor, inventoryId, { automatic: !force, onStep: step });
        }
        if (source === SOURCE.QUERY || source === SOURCE.BOTH) {
            rolled += await this.queryInventory(actor, inventoryId, { onStep: step });
        }

        await this.setInventoryConfig(actor, inventoryId, { lastRestock: game.time.worldTime });
        if (filled || rolled) this.broadcastActorRefresh(actor);
        return filled + rolled;
    }

    /**
     * Restock whatever the clock says is due.
     *
     * Elapsed time against an interval rather than counted boundaries, so advancing a
     * week restocks once. A shop does not accumulate seven days of stock while nobody
     * was looking; it is simply full again.
     */
    static async _applyRestocks(worldTime) {
        for (const actor of this.worldMerchants()) {
            for (const { item: inventory, config } of this.getInventories(actor, { includeHidden: true })) {
                // A table-stocked inventory restocks on the clock whatever its policy: it
                // is not refilling to a level, it is receiving a delivery.
                const rerolls = this.getInventoryTables(inventory).some((entry) => entry.auto);
                if (this.resolveStockPolicy(actor, config) !== STOCK.RESTOCKING && !rerolls) continue;

                const days = Number(config.restockDays);
                const interval = (Number.isFinite(days) && days > 0 ? days : DEFAULT_RESTOCK_DAYS)
                    * secondsPerDay();
                const last = Number(config.lastRestock);

                // No clock yet, or a GM has wound the world back past it. Start it
                // here rather than restocking on the spot: switching an inventory to
                // restocking should not empty and refill it the same instant.
                if (!Number.isFinite(last) || worldTime < last) {
                    await this.setInventoryConfig(actor, inventory.id, { lastRestock: worldTime });
                    continue;
                }
                if (worldTime - last < interval) continue;

                try {
                    await this.restockInventory(actor, inventory.id);
                } catch (error) {
                    console.error(`${MODULE.TITLE} | Could not restock ${actor.name}:`, error);
                }
            }
        }
    }

    // ==============================================================
    // ===== INTERACTION ============================================
    // ==============================================================

    /**
     * Claim left double-click on merchant tokens.
     *
     * The rules this has to obey — a synchronous, stable `matches`, and why
     * `bypassPermission` is needed at all — are Blacksmith's, and are in
     * `coffee-pub-blacksmith/documentation/api/api-tokens.md`. They were restated
     * here as comments until 2026-08-18; a doc copied into a call site drifts exactly
     * like code copied into one.
     *
     * What is ours: `openSafely`, because a throwing handler is a dead gesture once
     * permission has been relaxed and Blacksmith will not fall through to Foundry.
     */
    static _registerTokenInteraction() {
        const tokens = game.modules.get('coffee-pub-blacksmith')?.api?.tokens;
        if (typeof tokens?.registerInteraction !== 'function') {
            console.warn(`${MODULE.TITLE} | Blacksmith token interaction registry unavailable; shops cannot be opened by double-click.`);
            return;
        }

        try {
            this._interactionId = tokens.registerInteraction({
                id: 'merchant-shop',
                module: MODULE.ID,
                gesture: 'clickLeft2',
                priority: 2,
                matches: (tokenDocument) => this.isMerchantToken(tokenDocument),
                bypassPermission: true,
                handler: (token) => this.openSafely(token?.document),
                context: CONTEXT
            });
        } catch (error) {
            console.error(`${MODULE.TITLE} | Failed to claim token double-click:`, error);
        }
    }

    /** Never throws and never returns a rejected promise. */
    static openSafely(tokenDocument) {
        try {
            const opening = this.open(tokenDocument);
            if (typeof opening?.catch === 'function') {
                opening.catch((error) => this._reportOpenFailure(error));
            }
        } catch (error) {
            this._reportOpenFailure(error);
        }
    }

    static _reportOpenFailure(error) {
        console.error(`${MODULE.TITLE} | Failed to open the shop:`, error);
        notify.error(game.i18n.localize('coffee-pub-merchant.notify.cannotOpenShop'));
    }

    static open(tokenDocument) {
        if (!this.isMerchantToken(tokenDocument)) return null;
        // `openFor` rethrows a failed render, which is what `openSafely` is for: the
        // gesture must never surface a rejected promise, and a shop that will not
        // build should say so once rather than be retried into the same wall.
        return ShopWindow.openFor(tokenDocument);
    }

    // ==============================================================
    // ===== RECIPIENT POLICY =======================================
    // ==============================================================

    /**
     * Who the party is — Blacksmith's answer, not ours.
     *
     * **`acting()`, never `resting()`.** Their split is the one thing this had no way
     * of knowing it was missing: `resting()` is the party's *creatures* and includes
     * familiars, companions and hired hands, because those rest with the group;
     * `acting()` is its player characters, which is who can spend money. A familiar
     * rests with the party and cannot buy a sword, and picking the wrong one gives a
     * roster that looks right in testing and is wrong at a table with a druid in it.
     *
     * Kept as our own method names so the call sites did not have to move, and so the
     * fallback below has somewhere to live: a world running a Blacksmith older than
     * the pin still gets a usable shop rather than an empty Buying-as list.
     */
    static _party() {
        return game.modules.get('coffee-pub-blacksmith')?.api?.party ?? null;
    }

    static getPartyActor() {
        const party = this._party();
        if (party) return party.actor();
        return game.actors?.party?.type === 'group' ? game.actors.party : null;
    }

    /** Whether the roster is a curated party or the every-player-owned-actor fallback. */
    static hasPrimaryParty() {
        return this._party()?.hasPrimaryParty?.() ?? Boolean(this.getPartyActor());
    }

    static getPartyCharacters() {
        const party = this._party();
        if (party) return party.acting();

        const members = this.getPartyActor()?.system?.playerCharacters;
        if (Array.isArray(members) && members.length) return members.filter((a) => a?.type === 'character');
        return game.actors.filter((actor) => actor.type === 'character' && actor.hasPlayerOwner);
    }

    /**
     * Who this user may shop *as*.
     *
     * **The party is one of them.** Shopping on the party's behalf used to be a
     * destination you picked at the end — which made the shopper's coin pay for
     * somebody else's goods, a three-party transaction the exchange primitive cannot
     * express and which was refused. Being the party instead makes payer and
     * recipient the same actor again: the party's purse pays and the party's
     * inventory receives, which is what "buying it for the party" always meant.
     */
    static getEligibleRecipients() {
        const characters = game.user.isGM
            ? this.getPartyCharacters()
            : game.actors.filter((actor) => actor.type === 'character' && actor.isOwner);

        const party = this.getPartyActor();
        // Offered to anyone who has a stake in it: a GM, or a player with a character
        // in the party. Ownership of the Group Actor itself is not usually granted.
        return party && (game.user.isGM || characters.some((actor) => actor.hasPlayerOwner && actor.isOwner))
            ? [...characters, party]
            : characters;
    }

    /**
     * Whether this user may act as that Actor — spend its coin and fill its packs.
     *
     * One check for both halves of a transaction, because they are the same Actor
     * now. Mirrors `getEligibleRecipients` on the GM side, since a window offering a
     * choice is only the honest path.
     */
    static canActAs(actor, user) {
        if (!actor) return false;

        const party = this.getPartyActor();
        if (party && actor.uuid === party.uuid) {
            if (user.isGM) return true;
            return this.getPartyCharacters().some((member) => member.testUserPermission(user, 'OWNER'));
        }

        if (actor.type !== 'character') return false;
        if (user.isGM) return this.getPartyCharacters().some((member) => member.uuid === actor.uuid);
        return actor.testUserPermission(user, 'OWNER');
    }

    // ==============================================================
    // ===== GM HANDLER =============================================
    // ==============================================================

    /**
     * The op this module answers. One, because a visit is one settlement.
     *
     * Module-prefixed, as `api-gm-request.md` requires — the registry is world-wide and
     * a bare `settle` would be a landgrab.
     */
    static OP = `${MODULE.ID}.settle`;

    /**
     * Register the handler on **every** client, not only the GM's.
     *
     * Any client can become the answering GM, and one that registered nothing answers
     * `UNKNOWN_OP`. That is why this sits in `initialize()`, which runs for everyone,
     * and why nobody should later "optimise" it behind an `isGM` check.
     *
     * Unregistered first because `registerOp` **refuses** to replace an existing op
     * rather than overwriting it: a second `initialize()` in one session would
     * otherwise log a collision with ourselves and leave the first handler in place.
     */
    static _registerRequestOp() {
        const gmRequest = game.modules.get('coffee-pub-blacksmith')?.api?.gmRequest;
        if (typeof gmRequest?.registerOp !== 'function') {
            console.error(`${MODULE.TITLE} | Blacksmith's GM request API is unavailable; `
                + 'nothing can be bought or sold. This needs coffee-pub-blacksmith 13.19.2 or newer.');
            return;
        }
        gmRequest.unregisterOp?.(this.OP);
        gmRequest.registerOp({
            op: this.OP,
            module: MODULE.ID,
            handler: (payload, user) => this._process(payload, user)
        });
    }

    static async request(payload) {
        const gmRequest = game.modules.get('coffee-pub-blacksmith')?.api?.gmRequest;
        if (typeof gmRequest?.request !== 'function') return { ok: false, code: 'QUERY_UNAVAILABLE' };
        return gmRequest.request(this.OP, payload);
    }

    /**
     * Runs on the GM only. Nothing in payload is trusted without re-resolving it.
     *
     * **One operation.** Everything that changes hands in a shop is one settlement:
     * goods out, goods in, and coin in whichever direction the difference falls.
     * There were four — buy, acquire, checkout, sell — and each was a separate path
     * through the same money, which is a separate place for them to disagree.
     */
    static async _process(payload, user) {
        // **The caller is handed to us, verified.** It used to be read out of the
        // payload — a client-supplied claim dressed as an identity, and the one thing
        // in this module that could not be made sound from inside it. The envelope
        // resolves the User from the authenticated socket and passes it in, so the
        // ownership checks below are worth what they say. Never read an identity out
        // of a payload again; if one appears there, it is a hole.
        if (!user) return { ok: false, code: 'IDENTITY_UNVERIFIED' };

        const tokenDocument = payload?.tokenUuid ? await fromUuid(payload.tokenUuid) : null;
        const merchant = tokenDocument?.actor;
        if (!merchant) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        if (!this.isMerchant(merchant)) return { ok: false, code: 'NOT_A_MERCHANT' };
        if (!this.isOpen(merchant) && !user.isGM) return { ok: false, code: 'SHOP_CLOSED' };

        // Resolved from the **token's** scene, not the GM's view. Reputation is per
        // scene, and the GM answering a request may be looking at another map
        // entirely — the shop is priced where it stands.
        const result = await this._processSettle(merchant, payload, user, tokenDocument.parent);
        if (result?.ok) this._broadcastRefresh(tokenDocument.uuid);
        return result;
    }

    /**
     * The goods legs of an exchange: everything leaving the inventories.
     *
     * The stock policy is expressed entirely as two flags on the transfer, which is
     * what `copy` and `preserveEmptySource` were asked for and built for:
     *
     * - **infinite** — `copy`, so the merchant's row is a template and is not touched.
     *   The primitive deliberately does not treat a copied source's stack as a
     *   ceiling, so an inventory reading 1 sells three.
     * - **finite / restocking** — a real transfer with `preserveEmptySource`, so the
     *   count comes down and the row survives at zero. Availability is enforced by the
     *   primitive itself, which is why there is no stock check here any more.
     *
     * Both live inside the same `exchange` as the payment, so goods and coin commit
     * together or not at all. Before these flags existed this was a grant followed by
     * a separate currency exchange, which could and did hand the goods over and then
     * fail to take the money.
     */
    static _goodsTransfers(merchant, recipientUuid, lines) {
        // `items` is an array, so a whole cart from one inventory policy is one leg. A leg
        // per line would be the mistake `api-inventory.md` names for grantItems: the
        // plural form only batches when everything meets in the same call.
        //
        // Two legs at most, because the two policies cannot share one: `copy` and
        // `preserveEmptySource` are per transfer and answer different stock models.
        const groups = new Map();
        for (const line of lines) {
            const unlimited = this.resolveStockPolicy(merchant, line.inventoryConfig) === STOCK.INFINITE;
            const key = unlimited ? 'copy' : 'move';
            if (!groups.has(key)) {
                groups.set(key, {
                    from: merchant.uuid,
                    to: recipientUuid,
                    items: [],
                    ...(unlimited ? { copy: true } : { preserveEmptySource: true })
                });
            }
            groups.get(key).items.push({ itemId: line.item.id, quantity: line.quantity });
        }
        return [...groups.values()];
    }

    /**
     * Re-cut a purse into the coins a payment needs. Same money, different coins.
     *
     * Absolute, and through `setCurrency` so it takes the inventory lock -- a raw write
     * here would race the very settlement it is preparing for, which is the exact bug
     * that made `setCurrency` necessary in the first place.
     *
     * Without the primitive there is nothing safe to do, so the trade is refused rather
     * than attempted: an unlocked re-cut of somebody's purse is worse than a refusal.
     */
    static async _remint(actor, currency) {
        if (!hasSetCurrency()) {
            console.warn(
                `${MODULE.TITLE} | ${actor.name} needs coins broken to pay exactly, and this `
                + 'Blacksmith has no setCurrency to do it safely. Update Blacksmith.'
            );
            return false;
        }
        const result = await setCurrency({ targetActorUuid: actor.uuid, currency });
        if (!result?.ok) {
            console.error(`${MODULE.TITLE} | Could not break coins for ${actor.name}:`, result);
            return false;
        }
        return true;
    }

    /**
     * Give an unpriced item the price that was agreed for it.
     *
     * A haggled discount is not what a thing is worth — a longsword bought cheap is
     * still a longsword, and selling it on should fetch a longsword's price. So a
     * price is only ever written where there was none, which is the case a negotiate
     * inventory exists for: the odd, the unique, the thing with no entry in any book.
     * Agreeing a number for one of those *is* deciding what it is worth, and the
     * party should be able to sell it for that later.
     *
     * One update for the whole Actor. A write per item is a write per item to the
     * same Actor, which is the shape that trips dnd5e's encumbrance recompute.
     */
    static async _recordAgreedPrices(owner, items, { merchant = null } = {}) {
        if (!owner || !items?.length) return;

        const config = this.getConfig(merchant ?? owner);
        const updates = [];
        for (const item of items) {
            const worth = Number(item?.system?.price?.value);
            if (Number.isFinite(worth) && worth > 0) continue;

            const agreed = merchant
                ? resolvePurchasePrice(config, this.getInventoryConfig(this.getInventoryFor(merchant, item)), item)
                : resolvePrice(config, this.getInventoryConfig(this.getInventoryFor(owner, item)), item);
            if (agreed === null || agreed <= 0) continue;

            updates.push({
                _id: item.id,
                'system.price': { value: fromBase(agreed, 'gp'), denomination: 'gp' }
            });
        }

        if (!updates.length) return;
        try {
            await owner.updateEmbeddedDocuments('Item', updates);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not record the agreed price on ${owner.name}:`, error);
        }
    }

    /** Price the buy side. Every line re-resolved and re-priced on the GM. */
    static _priceBuying(merchant, requested, user, reputation = 1, market = 1) {
        const config = this.getConfig(merchant);
        const lines = [];
        let total = 0;

        for (const entry of requested) {
            const item = merchant.items?.get(entry?.itemId);
            if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
            if (!isPhysical(item.type)) return { ok: false, code: 'ITEM_NOT_TRANSFERABLE' };
            if (this.isInventory(item)) return { ok: false, code: 'NOT_FOR_SALE' };

            const inventory = this.getInventoryFor(merchant, item);
            if (!inventory) return { ok: false, code: 'NOT_FOR_SALE', itemName: item.name };
            const inventoryConfig = this.getInventoryConfig(inventory);
            // Hidden is a permission, not a display filter: a crafted request naming a
            // back-room item is refused here, not merely omitted from the window.
            if (inventoryConfig.visible === false && !user.isGM) {
                return { ok: false, code: 'NOT_FOR_SALE', itemName: item.name };
            }
            // No `BARTER_ONLY` refusal any more. A negotiate inventory has no list price,
            // so `resolvePrice` returns null until one is agreed — and refusing an
            // unpriced line is the same refusal either way.
            const unit = resolvePrice(config, inventoryConfig, item, { reputation, market });
            if (unit === null) return { ok: false, code: 'NOT_NEGOTIATED', itemName: item.name };

            const quantity = Math.max(1, Math.trunc(Number(entry.quantity) || 1));
            total += unit * quantity;
            lines.push({ item, quantity, inventoryConfig });
        }
        return { ok: true, lines, total };
    }

    /** Price the sell side, against the buyback inventory's rate. */
    static _priceSelling(merchant, seller, inventory, requested, reputation = 1, market = 1) {
        const config = this.getConfig(merchant);
        const lines = [];
        let total = 0;

        for (const entry of requested) {
            const item = seller.items?.get(entry?.itemId);
            if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
            if (!isPhysical(item.type)) return { ok: false, code: 'ITEM_NOT_TRANSFERABLE' };

            const quantity = Math.max(1, Math.trunc(Number(entry.quantity) || 1));
            const available = Number(item.system?.quantity ?? 1);
            if (Number.isFinite(available) && quantity > available) {
                return { ok: false, code: 'INSUFFICIENT_QUANTITY', available, itemName: item.name };
            }

            const unit = resolvePurchasePrice(config, inventory.config, item, { reputation, market });
            if (unit === null) return { ok: false, code: 'NOT_NEGOTIATED', itemName: item.name };

            total += unit * quantity;
            lines.push({ itemId: item.id, item, quantity });
        }
        return { ok: true, lines, total };
    }

    /**
     * Settle a whole visit: what is being bought, what is being sold, and the
     * difference, as one `exchange`.
     *
     * **This is what the primitive was built for.** A counter transaction is not two
     * transactions — you put the old sword down, pick the new one up, and money moves
     * once, in whichever direction the difference falls. Doing it as a purchase and a
     * sale means two lots of change, an order that matters, and a sale you cannot
     * afford to make until the purchase has already happened.
     *
     * Netting the *price* is not netting payment against change. The rule that change
     * cannot fund a payment still holds: the difference is worked out before anything
     * moves, and whoever owes it must actually hold it.
     *
     * Consequences worth knowing. A visit that buys more than it sells needs **no
     * coin in the till at all** — the shop receives. And a purchase becomes affordable
     * when funded by a trade-in, which as two transactions it was not.
     */
    static async _processSettle(merchant, payload, user, scene = null) {
        const buying = Array.isArray(payload.buy) ? payload.buy : [];
        const selling = Array.isArray(payload.sell) ? payload.sell : [];
        if (!buying.length && !selling.length) return { ok: false, code: 'NOTHING_TO_SETTLE' };

        // One Actor throughout: it pays, it is paid, it receives what is bought, and
        // it is where what is sold comes from.
        const check = this._validateShopper(payload.shopperUuid, user);
        if (!check.ok) return check;
        const shopper = check.actor;

        // Once, before anything is priced. The window shows a figure worked out from
        // the same band, but this is the one that decides what changes hands — a
        // client's arithmetic is an explanation, never the answer.
        const reputation = await resolveReputation(scene, this.getConfig(merchant)?.pricing?.reputation);
        // What goods are worth where this shop stands. Read from the same scene as
        // reputation and for the same reason: the shop is priced where it is, not
        // where whoever answers the request happens to be looking.
        const market = marketRate(scene);

        const bought = buying.length ? this._priceBuying(merchant, buying, user, reputation, market) : { ok: true, lines: [], total: 0 };
        if (!bought.ok) return bought;

        let inventory = null;
        let sold = { ok: true, lines: [], total: 0 };
        if (selling.length) {
            inventory = this.getInventories(merchant, { includeHidden: true })
                .find(({ config }) => isPurchased(config.type));
            if (!inventory) return { ok: false, code: 'NO_PURCHASED_INVENTORY' };
            sold = this._priceSelling(merchant, shopper, inventory, selling, reputation, market);
            if (!sold.ok) return sold;
        }

        const net = bought.total - sold.total;
        let coin = [];

        // **One leg, always exact, so there is no change to be unable to make.**
        //
        // Money used to move as a payment plus change back, which meant the *other*
        // side had to hold particular coins -- and nothing guarantees a shop sitting on
        // twenty thousand gold has six silver in the drawer. That refusal was the most
        // common way a perfectly ordinary purchase failed, and it was unfixable from the
        // player's side and baffling from the GM's.
        //
        // Now the payer's own purse is re-cut first when it has to be, so the exact
        // coins exist to hand over. Breaking a gold piece into ten silver is what a
        // person does at a counter without thinking about it, and it is value-neutral:
        // the same money in different coins. See `planSettlement`.
        if (net !== 0) {
            const payer = net > 0 ? shopper : merchant;
            const payee = net > 0 ? merchant : shopper;
            const owed = Math.abs(net);

            const plan = planSettlement(payer.system?.currency ?? {}, owed);
            if (!plan) {
                return net > 0
                    ? { ok: false, code: 'CANNOT_AFFORD', price: owed, held: purseValue(shopper) }
                    : { ok: false, code: 'MERCHANT_CANNOT_AFFORD', price: owed, held: purseValue(merchant) };
            }

            // Re-cut before anything moves. This is the payer's own money changing
            // shape, so a failure here or after it leaves them exactly as rich as they
            // were and nothing else has happened -- which is why it can sit outside the
            // atomic part without reintroducing the half-completed trade.
            if (plan.remint) {
                const recut = await this._remint(payer, plan.remint);
                if (!recut) return { ok: false, code: 'CANNOT_MAKE_CHANGE', price: owed };
            }

            // **The coin legs: money one way, change back.** The payer hands over
            // `plan.pay` and the payee hands back `plan.change`, so buying and selling
            // are the same call with the two swapped — which is the whole reason a
            // symmetric primitive was asked for.
            //
            // Never netted: the payer must actually hold what they hand over, which is
            // what happens at a counter, and every leg is validated against the balances
            // at the start of the call, so change arriving cannot fund the payment.
            coin = [{ from: payer.uuid, to: payee.uuid, currency: plan.pay }];
        }
        // net === 0 moves no coin at all, which is what an even trade is.

        if (!hasExchange()) return { ok: false, code: 'EXCHANGE_UNAVAILABLE' };

        // What was agreed becomes what the thing is worth, for anything that had no
        // worth of its own. Written before the goods move so the copy carries it —
        // and one batched update per Actor rather than a write per item, because a
        // second write to an Actor is what trips dnd5e's encumbrance recompute.
        await this._recordAgreedPrices(merchant, bought.lines.map((line) => line.item));
        await this._recordAgreedPrices(shopper, sold.lines.map((line) => line.item), { merchant });

        const goodsIn = sold.lines.length
            ? [{
                from: shopper.uuid,
                to: merchant.uuid,
                items: sold.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
                // Bought stock lands on the buyback inventory rather than loose on the NPC.
                container: inventory.item.id
            }]
            : [];

        const result = await exchange({
            transfers: [
                ...this._goodsTransfers(merchant, shopper.uuid, bought.lines),
                ...goodsIn,
                ...coin
            ],
            // `par` describes an inventory, not an item, and has no business travelling with
            // one. `registerTransientFlag` hides it from merge comparison but leaves it
            // in the payload, so without this it lands in a buyer's inventory and rides
            // back in if they sell it — see the buyback guard in `getStock`.
            omitFlags: [`${MODULE.ID}.${PAR_FLAG}`, `${MODULE.ID}.${FREE_FLAG}`],
            // **And the same path in `ignoreFlags`, for the migration.** Anything bought
            // before this landed carries `par` on the buyer's row, so an arrival without
            // it would compare as different and create a second stack rather than
            // merging. That is a silent, self-inflicted duplicate-row bug with a long
            // tail; the transient registry covers our own writes but not the rows that
            // already exist in somebody's world.
            ignoreFlags: [`${MODULE.ID}.${PAR_FLAG}`, `${MODULE.ID}.${FREE_FLAG}`]
        });

        // An agreement covers the trade it was made for. Left standing, a haggled
        // discount would quietly become the inventory price for everyone who came after,
        // and a settled negotiate line would keep a price the inventory exists not to
        // have. Cleared only on success, so a refused trade can be tried again on
        // the same terms.
        if (result?.ok) await this._clearAgreedPrices(merchant, bought.lines, sold.lines);

        return result?.ok
            ? { ...result, net, spent: bought.total, earned: sold.total }
            : result;
    }

    /** Drop the agreements a settled trade used up. One write, both sides. */
    static async _clearAgreedPrices(merchant, boughtLines, soldLines) {
        const pricing = { ...(this.getConfig(merchant)?.pricing ?? {}) };
        const overrides = { ...(pricing.overrides ?? {}) };
        const buyback = { ...(pricing.purchaseOverrides ?? {}) };

        let touched = false;
        for (const line of boughtLines ?? []) {
            if (line?.item?.id in overrides) { delete overrides[line.item.id]; touched = true; }
        }
        for (const line of soldLines ?? []) {
            if (line?.itemId in buyback) { delete buyback[line.itemId]; touched = true; }
        }
        if (!touched) return;

        pricing.overrides = overrides;
        pricing.purchaseOverrides = buyback;
        try {
            await this.setConfig(merchant, { pricing });
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not clear the agreed prices:`, error);
        }
    }

    /**
     * The Actor this transaction is for: it pays, and it receives.
     *
     * There was a payer and a recipient, and a rule that they had to match — which is
     * all that is left of the destination picker. Shopping for the party is being the
     * party now, so there is one Actor and one check.
     */
    static _validateShopper(uuid, user) {
        if (!uuid) return { ok: false, code: 'NO_RECIPIENT' };

        let actor = null;
        try {
            actor = fromUuidSync(uuid);
        } catch (_error) {
            return { ok: false, code: 'RECIPIENT_NOT_FOUND' };
        }
        if (!actor) return { ok: false, code: 'RECIPIENT_NOT_FOUND' };
        if (!this.canActAs(actor, user)) return { ok: false, code: 'RECIPIENT_NOT_ALLOWED' };
        return { ok: true, actor };
    }

    // Not only for the GM changing what is on offer: since stock became a count, a
    // settlement moves the number every other client is looking at.
    static _broadcastRefresh(tokenUuid) {
        emit(SOCKET_EVENT.REFRESH, { tokenUuid });
        ShopWindow.refreshForToken(tokenUuid);
    }

    /** Pending refreshes, keyed by Actor uuid. Per client and purely a scheduling aid. */
    static _refreshTimers = new Map();

    /**
     * Inventory changes are Actor-level, so they reach every token of that merchant.
     *
     * **Coalesced per Actor over one frame's worth of time.** One gesture is rarely one
     * write: dragging a stack between inventories fires `updateItem` per document, a
     * table roll grants several rows, and the migration touches every container a shop
     * has — each of which used to be its own socket emit and its own re-render on every
     * connected client.
     *
     * Coalescing belongs here rather than on the hooks. A throttle on `updateItem`
     * would drop whole events, so a burst touching two merchants could lose the second
     * one's refresh entirely; this merges by Actor and cannot lose one, because the key
     * is what is being merged.
     *
     * The delay is deliberately below the threshold at which a person reads a redraw as
     * late, so nothing needs to know this is happening.
     */
    static broadcastActorRefresh(actor) {
        if (!actor) return;
        const uuid = actor.uuid;
        if (this._refreshTimers.has(uuid)) return;

        this._refreshTimers.set(uuid, setTimeout(() => {
            this._refreshTimers.delete(uuid);
            emit(SOCKET_EVENT.REFRESH, { actorUuid: uuid });
            void ShopWindow.refreshForActor(uuid);
        }, 60));
    }

    /**
     * Follow edits made outside Merchant's own windows.
     *
     * A GM can rename an inventory, restock one, or delete one from the Actor sheet, the
     * container sheet, or a drag between containers — none of which route through this
     * module. Without this an open shop shows the old name and the old counts until
     * somebody presses Refresh, and "I renamed it and nothing happened" is the kind of
     * bug that gets reported as the rename not working.
     *
     * GM-only, because every client running it would broadcast the same refresh.
     */
    static _registerStockWatcher() {
        const react = (item) => {
            if (!game.user.isGM) return;
            const actor = item?.parent;
            if (!actor?.items || !this.isMerchant(actor)) return;
            // An inventory, or anything sitting on one. Everything else on a merchant is
            // the shopkeeper's own gear and changes nothing a shop window shows.
            const relevant = this.isInventory(item) || Boolean(this.getInventoryFor(actor, item));
            if (relevant) this.broadcastActorRefresh(actor);
        };

        this.hook('updateItem', 'Redraw shops when their stock is edited outside Merchant', (item, changes) => {
            // Quantity, name and our own flag are the three that change what a shop
            // window renders. Anything else is an edit to an item that happens to be
            // in a shop.
            const touches = changes?.name !== undefined
                || changes?.system?.quantity !== undefined
                || changes?.system?.container !== undefined
                || changes?.flags?.[MODULE.ID] !== undefined;
            if (touches) react(item);
        });
        // Braces, not a concise body: this returns nothing on purpose. The world-wide
        // veto Blacksmith closed was never a deliberate cancel, it was an ordinary
        // callback whose return value happened to be falsy.
        this.hook('createItem', 'Redraw shops when stock is added outside Merchant', (item) => { react(item); });
        // On delete the item is already off the Actor, so `getInventoryFor` cannot see
        // where it was. The container id is still on the document being removed.
        this.hook('deleteItem', 'Redraw shops when stock is removed outside Merchant', (item) => {
            if (!game.user.isGM) return;
            const actor = item?.parent;
            if (!actor?.items || !this.isMerchant(actor)) return;
            if (this.isInventory(item) || item?.system?.container) this.broadcastActorRefresh(actor);
        });
    }

    static _registerRefreshListener() {
        // A user who disconnects should not leave a face standing in the shop.
        this.hook('userConnected', 'Drop a departing user from every shop room', (user, connected) => {
            if (!connected) ShopWindow.dropUser(user.id);
        });

        // **Four names rather than one channel demultiplexed on `action`.** The switch
        // that used to live here is Blacksmith's now; see `utility-sockets.js` for why
        // the names are module-prefixed.

        // Slates travel peer to peer and are display only -- settling re-derives every
        // line and every price on the GM, so the worst a bad message can do is show
        // somebody a wrong list.
        on(SOCKET_EVENT.SLATE, (data) => ShopWindow.receiveSlate(data));

        on(SOCKET_EVENT.PRESENCE, (data) => ShopWindow.receivePresence(data));

        on(SOCKET_EVENT.SLATE_REQUEST, (data) => {
            // Still checked, though `emit` does not echo to the sender: a ping answered
            // by its own sender would publish a slate to nobody and redraw for no reason.
            if (data?.userId === game.user.id) return;
            ShopWindow.publishSlatesFor(data?.tokenUuid);
        });

        on(SOCKET_EVENT.REFRESH, (data) => {
            if (data?.actorUuid) void ShopWindow.refreshForActor(data.actorUuid);
            else ShopWindow.refreshForToken(data?.tokenUuid);
        });
    }
}
