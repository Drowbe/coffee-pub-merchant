// ==================================================================
// ===== MERCHANT MANAGER ===========================================
// ==================================================================
//
// State, interaction claiming, recipient policy, and the GM-authoritative handler.

import {
    MODULE, MERCHANT_FLAG, STOCK, PAR_FLAG, DEFAULT_RESTOCK_DAYS, DEFAULT_SHOP_KIND,
    DEFAULT_MAX_PRODUCTS, DEFAULT_MAX_PER_ITEM,
    DEFAULT_TILL, SHELF_FLAG, SHELF_MODE, SHELF_PRESETS, isScheduledOpen, hourAt, secondsPerDay
} from './const.js';
import {
    grantItem, grantItems, grantCurrency, isPhysical, exchange, hasExchange, setCurrency, hasSetCurrency
} from './merchant-inventory.js';
import {
    resolvePrice, resolveBuybackPrice, planPayment, purseValue, formatBase, toBase, fromBase, stockDepth
} from './merchant-pricing.js';
import * as GMRequest from './gm-request.js';
import { ShopWindow } from './window-shop.js';
import { notify } from './merchant-feedback.js';

const CONTEXT = 'merchant-interaction';

export class MerchantManager {
    static _interactionId = null;

    static initialize() {
        this._registerTokenInteraction();
        GMRequest.registerHandler((op, payload, userId) => this._process(op, payload, userId));
        this._registerRefreshListener();
        this._registerScheduleWatcher();
        this._registerStockWatcher();
    }

    static teardown() {
        const tokens = game.modules.get('coffee-pub-blacksmith')?.api?.tokens;
        if (this._interactionId && typeof tokens?.disposeByContext === 'function') {
            tokens.disposeByContext(CONTEXT);
        }
        this._interactionId = null;
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
            stock: STOCK.INFINITE,
            // Open for business. A closed shop still opens for browsing — you can
            // look through the window — but nothing changes hands.
            // Only consulted when there is no schedule. With one, the schedule
            // decides and `override` is the GM's exception to it — see `isOpen`.
            open: true,
            hours: null,
            // `{ open, against }` — what the GM chose, and what the schedule said at
            // the moment they chose it. Null when they have not overruled anything.
            override: null,
            pricing: { markup: 1.0, overrides: {} }
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
        Hooks.on('updateWorldTime', () => {
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
        // every few seconds is not a refresh every few seconds.
        for (const actor of game.actors.filter((a) => this.isMerchant(a))) {
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
    // Stock is what sits on a shelf. Everything else on the Actor is the
    // shopkeeper's own gear and is never for sale — which is the whole reason
    // shelves exist rather than treating every physical item as stock.

    static getShelfConfig(item) {
        return item?.getFlag(MODULE.ID, SHELF_FLAG) ?? null;
    }

    static isShelf(item) {
        return item?.type === 'container' && Boolean(this.getShelfConfig(item));
    }

    /** Shelves in display order. Hidden ones are omitted unless asked for. */
    static getShelves(actor, { includeHidden = false } = {}) {
        if (!actor) return [];
        return actor.items
            .filter((item) => this.isShelf(item))
            .filter((item) => includeHidden || this.getShelfConfig(item).visible !== false)
            .map((item) => ({ item, config: this.getShelfConfig(item) }))
            // Preset order first, then by name — which is the container's name,
            // because that is the only name a shelf has.
            .sort((a, b) => (a.config.order ?? 0) - (b.config.order ?? 0)
                || String(a.item.name).localeCompare(String(b.item.name)));
    }

    /**
     * What is on a shelf.
     *
     * Shelves are excluded, not merely containers. A container *is* physical and is
     * ordinary stock — a backpack for sale is a backpack for sale — but a GM can drag
     * one shelf into another on the Actor sheet, and nothing stops them. A nested
     * shelf would otherwise appear twice: once as its own section, and once as an item
     * for sale on its parent.
     */
    static getShelfContents(actor, shelfItem) {
        return actor.items.filter((item) => item.system?.container === shelfItem.id
            && isPhysical(item.type)
            && !this.isShelf(item));
    }

    /** The shelf an item sits on, or null if it is the shopkeeper's own gear. */
    static getShelfFor(actor, item) {
        const containerId = item?.system?.container;
        if (!containerId) return null;
        const container = actor.items.get(containerId);
        return this.isShelf(container) ? container : null;
    }

    /**
     * Create a shelf from a preset.
     *
     * `weightlessContents` and no capacity, so it is unlimited and weighs nothing.
     * Created here rather than shipped in a compendium: a pack is a thing to
     * maintain and its items can be edited into something malformed, whereas this
     * cannot produce a shelf with the wrong flags.
     */
    static async addShelf(actor, presetKey) {
        const preset = SHELF_PRESETS[presetKey];
        if (!actor || !preset) return null;

        const [created] = await actor.createEmbeddedDocuments('Item', [{
            name: preset.name,
            type: 'container',
            img: preset.img,
            system: {
                properties: ['weightlessContents'],
                description: { value: `<p>${preset.hint}</p>` }
            },
            flags: { [MODULE.ID]: { [SHELF_FLAG]: { ...preset.shelf } } }
        }]);
        return created ?? null;
    }

    /**
     * Show or hide a whole shelf. GM-only and written directly: this is the GM
     * curating their own shop, not a player action, so it does not route through the
     * request handler.
     *
     * Deliberately a flag rather than the container's `equipped` state. Equipped is
     * inert on containers so it would have worked, but it is transient state the rest
     * of the ecosystem clears on transfer, it can change without anyone deciding to
     * change it, and it would put one of the three shelf properties somewhere the
     * other two are not.
     */
    static async setShelfVisible(actor, shelfId, visible) {
        return this.setShelfConfig(actor, shelfId, { visible: Boolean(visible) });
    }

    /** Merge changes into a shelf's configuration. GM-only, written directly. */
    static async setShelfConfig(actor, shelfId, changes) {
        if (!game.user.isGM) return null;
        const shelf = actor?.items?.get(shelfId);
        const config = this.getShelfConfig(shelf);
        if (!config) return null;
        await shelf.setFlag(MODULE.ID, SHELF_FLAG, { ...config, ...changes });
        return shelf;
    }

    /**
     * Put an item on a shelf from a UUID — a compendium entry, a sidebar item, or
     * anything else Foundry hands over in a drop payload.
     *
     * **One write, and the restock target goes in it.** This used to grant and then
     * `setFlag` the par, which is two sequential writes to one Actor — the shape that
     * trips dnd5e's encumbrance recompute into creating `dnd5eencumbered0` twice and
     * having the server reject the second. `api-inventory.md` is explicit that arrival
     * flags belong in the write and that no amount of awaiting avoids it.
     *
     * `grantItem` takes the container too, so the item arrives on the shelf rather
     * than landing at the root and being moved there.
     */
    static async addToShelf(actor, shelfId, itemUuid, quantity) {
        if (!game.user.isGM) return { ok: false, code: 'NOT_ALLOWED' };
        const shelf = actor?.items?.get(shelfId);
        if (!this.isShelf(shelf)) return { ok: false, code: 'NOT_A_SHELF' };

        // The par has to be known before the write, so the arriving quantity is
        // resolved here rather than read back off the result. `quantity` omitted
        // means "the source's own", which is exactly what grantItem will use.
        let arriving = Math.trunc(Number(quantity));
        if (!Number.isFinite(arriving) || arriving < 1) {
            const source = await fromUuid(itemUuid);
            arriving = Math.max(1, Math.trunc(Number(source?.system?.quantity ?? 1)));
        }

        return grantItem({
            targetActorUuid: actor.uuid,
            itemUuid,
            quantity,
            // Container membership is part of merge identity, so a merge can only
            // land on a row already on this shelf — stock the GM put elsewhere is
            // never relocated by a restock.
            container: shelfId,
            // What a GM stocks is what the shelf keeps. On a merge only the flags
            // passed here are written, so topping up a shelf by hand does redefine
            // its target — which is the rule the shop window's editable quantity
            // already follows.
            flags: { [MODULE.ID]: { [PAR_FLAG]: arriving } }
        });
    }

    /**
     * Remove a shelf through dnd5e's own delete dialog, which asks whether the
     * contents go with it and handles the recursion. Curator learned this the same
     * way: reimplementing it would mean a second answer to a question the system
     * already asks, and the wrong answer orphans everything inside.
     */
    static async removeShelf(actor, shelfId) {
        if (!game.user.isGM) return false;
        const shelf = actor?.items?.get(shelfId);
        if (!this.isShelf(shelf)) return false;
        await shelf.deleteDialog();
        // deleteDialog resolves whether or not the GM went through with it, so check
        // rather than assume.
        return !actor.items.get(shelfId);
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

        // A merchant with no shelf is an empty window and a puzzle. Give the zero
        // config path something to look at.
        if (!this.getShelves(actor, { includeHidden: true }).length) {
            await this.addShelf(actor, 'storefront');
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
    // the number on the merchant's own item; nothing is moved off a shelf. That is
    // what lets a sold-out row stay put, marked out of stock -- which finite stock
    // prefers and restocking stock requires, since a deleted row is not a row
    // anything can restock. See documentation/DECISIONS-TO-REVIEW.md.

    /**
     * Which policy governs a shelf.
     *
     * The shelf's own setting wins, and `null` inherits the merchant's -- the same
     * inheritance `markup` already uses, so this is a case added to an existing
     * pattern rather than a second one.
     */
    static resolveStockPolicy(actor, shelfConfig) {
        const policies = Object.values(STOCK);
        if (policies.includes(shelfConfig?.stock)) return shelfConfig.stock;
        const merchant = this.getConfig(actor)?.stock;
        return policies.includes(merchant) ? merchant : STOCK.INFINITE;
    }

    /**
     * What is on the shelf, and what it refills to.
     *
     * `par` falls back to the current quantity so a shelf stocked before this
     * existed reads as full rather than as due for a restock to zero.
     */
    static getStock(actor, item, shelfConfig) {
        const config = shelfConfig ?? this.getShelfConfig(this.getShelfFor(actor, item));
        const policy = this.resolveStockPolicy(actor, config);
        if (policy === STOCK.INFINITE) {
            return { policy, unlimited: true, available: Infinity, par: null };
        }
        const available = Math.max(0, Math.trunc(Number(item?.system?.quantity ?? 0)));

        // **A buyback shelf has no restock target, and must not inherit one.** Its stock
        // is whatever the party sold; there is nothing it is "kept at".
        //
        // This is a guard against a real leak, not a tidiness rule. `registerTransientFlag`
        // makes a flag invisible to *merge comparison* -- it does not strip it from the
        // payload -- so `par` travels with a bought item into the buyer's inventory and
        // back again if they sell it. A bedroll bought from a shelf kept at six arrives
        // on the buyback shelf still claiming a par of six, and the next Restock
        // Everything manufactures five bedrolls the shop never had, from a target it
        // never set.
        //
        // Blacksmith's `omitFlags` will stop the flag arriving at all. This stays after
        // that lands: it is correct on its own terms, and it covers every item already in
        // a world with the flag on it.
        if (config?.mode === SHELF_MODE.BUYBACK) {
            return { policy, unlimited: false, available, par: available };
        }

        const stored = Number(item?.getFlag(MODULE.ID, PAR_FLAG));

        // No par flag means "as many as are there", which is right for something a GM
        // dropped on a shelf and never thought about again -- and is why a row that
        // only ever arrived by table roll creeps upward: each delivery raises the
        // quantity, which raises the target, which the next restock then protects.
        //
        // Read through the ceiling as well as written through it, because a shelf's
        // limit can be lowered after a target was set and the stored flag would then
        // be the higher of the two.
        const raw = Number.isFinite(stored) ? Math.max(0, Math.trunc(stored)) : available;
        const par = Math.min(raw, this.getShelfLimits(config).maxPerItem);
        return { policy, unlimited: false, available, par };
    }

    /**
     * What a shelf will hold: distinct rows, and how many of any one thing.
     *
     * Per shelf rather than per shop, because a storefront and a back room are
     * different sizes in every shop that has both.
     */
    static getShelfLimits(shelfConfig) {
        const products = Math.trunc(Number(shelfConfig?.maxProducts));
        const perItem = Math.trunc(Number(shelfConfig?.maxPerItem));
        return {
            maxProducts: Number.isFinite(products) && products > 0 ? products : DEFAULT_MAX_PRODUCTS,
            maxPerItem: Number.isFinite(perItem) && perItem > 0 ? perItem : DEFAULT_MAX_PER_ITEM
        };
    }

    /**
     * Set a count by hand, which also sets what the shelf restocks to.
     *
     * A GM saying "I keep six of these" is describing the shop, not making a sale, so
     * both numbers move. A purchase lowers the count and leaves the target alone.
     */
    static async setStockQuantity(actor, itemId, quantity) {
        if (!game.user.isGM) return null;
        const item = actor?.items?.get(itemId);
        if (!item) return null;

        const wanted = Math.max(0, Math.trunc(Number(quantity) || 0));
        // Clamped to the shelf's ceiling rather than accepted and quietly undone.
        // Storing 10 under a limit of 5 would leave the row reading 10 while its
        // restock target read 5 -- two numbers disagreeing with no way to see why.
        // One number governs, and the shelf's limit is where it is raised.
        const shelfConfig = this.getShelfConfig(this.getShelfFor(actor, item));
        const { maxPerItem } = this.getShelfLimits(shelfConfig);
        const value = Math.min(wanted, maxPerItem);

        await item.update({
            'system.quantity': value,
            [`flags.${MODULE.ID}.${PAR_FLAG}`]: value
        });
        return { item, value, clamped: value !== wanted, maxPerItem };
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
     * `null` clears it, and clearing a negotiate-shelf item puts it back to having no
     * price at all — which is the state that shelf exists to express.
     */
    static async setNegotiatedPrice(merchant, itemId, base, { side = 'buy' } = {}) {
        if (!game.user.isGM || !merchant || !itemId) return null;

        const key = side === 'sell' ? 'buybackOverrides' : 'overrides';
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
     * The tables a shelf restocks from, each with its own number of rolls.
     *
     * A shop is rarely one table. A general store might roll on *common goods* three
     * times, *potions* once, and *whatever fell off a cart* once — and expressing
     * that as one table means building a combined table for every shop.
     *
     * Uuids rather than ids, so a table in a compendium works the same as one in the
     * world — which is where a GM keeps this sort of table.
     *
     * Reads a single `table` from before this took a list, so a shelf configured
     * earlier keeps working without a migration pass.
     */
    static getShelfTables(shelf) {
        const config = this.getShelfConfig(shelf);
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
                    auto: entry.auto === true
                }));
        }
        return config.table
            ? [{ uuid: config.table, rolls: this._rollCount(config.tableRolls), auto: false }]
            : [];
    }

    /** One to twenty. A shelf rolling nothing is a shelf with no table on it. */
    static _rollCount(value) {
        return Math.min(20, Math.max(1, Math.trunc(Number(value) || 1)));
    }

    static async addShelfTable(actor, shelfId, uuid) {
        if (!uuid) return null;
        const shelf = actor?.items?.get(shelfId);
        const tables = this.getShelfTables(shelf);
        // Dropping the same table twice is a slip, not a request for double rolls;
        // the roll count is how you ask for that.
        if (tables.some((entry) => entry.uuid === uuid)) return null;
        return this.setShelfConfig(actor, shelfId, {
            tables: [...tables, { uuid, rolls: 1, auto: false }],
            // The single-table fields are what this list replaced.
            table: null,
            tableRolls: null
        });
    }

    static async removeShelfTable(actor, shelfId, uuid) {
        const shelf = actor?.items?.get(shelfId);
        const tables = this.getShelfTables(shelf).filter((entry) => entry.uuid !== uuid);
        return this.setShelfConfig(actor, shelfId, { tables, table: null, tableRolls: null });
    }

    static async setShelfTableRolls(actor, shelfId, uuid, rolls) {
        return this._updateShelfTable(actor, shelfId, uuid, { rolls: this._rollCount(rolls) });
    }

    /** Whether this table also fires when the clock brings a restock round. */
    static async setShelfTableAuto(actor, shelfId, uuid, auto) {
        return this._updateShelfTable(actor, shelfId, uuid, { auto: Boolean(auto) });
    }

    static async _updateShelfTable(actor, shelfId, uuid, changes) {
        const shelf = actor?.items?.get(shelfId);
        const tables = this.getShelfTables(shelf)
            .map((entry) => (entry.uuid === uuid ? { ...entry, ...changes } : entry));
        return this.setShelfConfig(actor, shelfId, { tables, table: null, tableRolls: null });
    }

    /**
     * Roll a shelf's tables and put what comes up on it.
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
     * there to furnish a shelf once; the ones that are not say so.
     */
    static async rollShelfTable(actor, shelfId, { automatic = false, onStep = null } = {}) {
        if (!game.user.isGM) return 0;
        const shelf = actor?.items?.get(shelfId);
        if (!this.getShelfConfig(shelf)) return 0;
        const step = typeof onStep === 'function' ? onStep : () => {};

        const drawn = [];
        for (const entry of this.getShelfTables(shelf)) {
            if (automatic && !entry.auto) continue;
            let table = null;
            try {
                table = await fromUuid(entry.uuid);
            } catch (_error) {
                table = null;
            }
            // A table deleted since it was assigned is skipped, not fatal: the other
            // tables on the shelf should still deliver.
            if (table?.documentName !== 'RollTable') {
                console.warn(`${MODULE.TITLE} | ${shelf.name} names a roll table that no longer resolves:`, entry.uuid);
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
                    for (let owed = i; owed < entry.rolls; owed++) step(`Rolling ${table.name}`);
                    break;
                }
                for (const result of results) {
                    if (result?.documentUuid) drawn.push(result.documentUuid);
                }
                step(`Rolling ${table.name} — ${i + 1} of ${entry.rolls}`);
            }
        }
        if (!drawn.length) { step(`Nothing rolled for ${shelf.name}`); return 0; }

        // Resolved once per distinct uuid: several tables rolling the same row should
        // cost one lookup, and only physical items can sit on a shelf.
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

        const items = this._withinLimits(actor, shelf, drawn, resolved);
        if (!items.length) { step(`${shelf.name} is full`); return 0; }
        step(`Stocking ${shelf.name}`);

        // One call for every table on the shelf, so the same potion rolled by two of
        // them lands as one row of two — see grantItems.
        const result = await grantItems({ targetActorUuid: actor.uuid, items, container: shelfId });

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
                + `${items.length === 1 ? '' : 's'} did not reach ${shelf.name}:`,
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
            // shelf asking for five of anything was refused wholesale. Fixed upstream;
            // an install still carrying the old primitive fails here and nowhere else,
            // and the symptom (every row arrives at one, or not at all) looks exactly
            // like a Merchant bug.
            if (failures.some(({ entry }) => entry?.code === 'INSUFFICIENT_QUANTITY')) {
                console.error(
                    `${MODULE.TITLE} | Those refusals mean Blacksmith is out of date. A grant takes nothing `
                    + 'from its source, so a compendium entry\'s own quantity is not a ceiling — update '
                    + 'Coffee Pub Blacksmith and restock again.'
                );
                notify.error(
                    'Stock could not be delivered because Coffee Pub Blacksmith is out of date. Update it and restock.'
                );
            }
        } else if (!result?.ok) {
            console.error(`${MODULE.TITLE} | Could not stock ${shelf.name} from its tables:`, result);
        }

        return items.length - failures.length;
    }

    /**
     * Trim a set of rolled results to what the shelf will actually hold.
     *
     * Two ceilings, checked against what is already there plus what this delivery has
     * allocated so far. Without them a shelf rolling weekly grows an ever longer list
     * of one-offs, and a shelf that keeps rolling rations builds toward thousands of
     * them — neither of which announces itself until a fortnight of game time has
     * passed.
     *
     * Rows are matched by name and type. That is the dominant part of the merge
     * identity `grantItems` uses, and a cap that is approximately right is worth far
     * more than one that reimplements the predicate and drifts from it.
     */
    static _withinLimits(actor, shelf, drawn, resolved) {
        const config = this.getShelfConfig(shelf);
        const { maxProducts, maxPerItem } = this.getShelfLimits(config);
        const key = (name, type) => `${name}\u0000${type}`;

        const held = new Map();
        for (const item of this.getShelfContents(actor, shelf)) {
            held.set(key(item.name, item.type), Math.max(0, Math.trunc(Number(item.system?.quantity ?? 1))));
        }
        let rows = held.size;

        const allowed = [];
        let clipped = 0;
        for (const uuid of drawn) {
            const item = resolved.get(uuid);
            if (!item) continue;

            // A roll is a delivery, not a unit. How deep it goes is the item's own
            // business first, then what it costs -- see `stockDepth`. Stocking one
            // arrow because a table rolled "Arrows (20)" was the old behaviour and it
            // was wrong about the only thing anybody had stated.
            const k = key(item.name, item.type);
            const room = maxPerItem - (held.get(k) ?? 0);
            if (room < 1) { clipped++; continue; }

            if (!held.has(k) && rows >= maxProducts) {
                // A new row costs one of the shelf's slots, and there may be none.
                clipped++;
                continue;
            }

            const depth = Math.min(stockDepth(item, { maxPerItem }), room);
            if (!held.has(k)) rows++;
            held.set(k, (held.get(k) ?? 0) + depth);

            allowed.push({ itemUuid: uuid, quantity: depth });
        }

        if (clipped) {
            console.debug(`${MODULE.TITLE} | ${shelf.name} is at its limit; ${clipped} rolled result${clipped === 1 ? '' : 's'} not stocked.`);
        }
        return allowed;
    }

    /**
     * Take everything off a shelf, leaving the shelf.
     *
     * Distinct from removing the shelf and from setting counts to zero, which are the
     * two things it sits between: zero says "sold out", deleting the container says
     * "this shop has no such shelf", and this says "clear it and let me start again".
     * A GM re-rolling a shop's stock wants the third and had to do it a row at a time.
     *
     * One `deleteEmbeddedDocuments` for the lot -- a delete per row is a write per row
     * to the same Actor, and doing it in a loop is what makes a fast clicker race the
     * re-render.
     */
    static async clearShelf(actor, shelfId) {
        if (!game.user.isGM) return 0;
        const shelf = actor?.items?.get(shelfId);
        if (!this.getShelfConfig(shelf)) return 0;

        return this._withStockLock(actor, async () => {
            // Read inside the lock: a purchase settling right now changes this list.
            const ids = this.getShelfContents(actor, shelf).map((item) => item.id);
            if (!ids.length) return 0;
            try {
                await actor.deleteEmbeddedDocuments('Item', ids);
            } catch (error) {
                console.error(`${MODULE.TITLE} | Could not clear ${shelf.name}:`, error);
                return 0;
            }
            this.broadcastActorRefresh(actor);
            return ids.length;
        });
    }

    /**
     * How many steps restocking this shelf will take, for sizing a progress bar.
     *
     * Counted the same way `restockShelf` spends them -- one for the refill, one per
     * roll, one for the delivery -- so the bar reaches its end exactly when the work
     * does. A total derived any other way drifts, and a bar that stops at 80% or hits
     * 100% early is worse than no bar, because it is a claim rather than a guess.
     */
    static restockWorkUnits(actor, shelfId, { force = false } = {}) {
        const shelf = actor?.items?.get(shelfId);
        if (!this.getShelfConfig(shelf)) return 0;

        let units = 1;
        for (const entry of this.getShelfTables(shelf)) {
            if (!force && !entry.auto) continue;
            units += Math.max(0, Math.trunc(Number(entry.rolls) || 0));
        }
        return units + 1;
    }

    /**
     * Refill a shelf to its par levels.
     *
     * `force` is the GM pressing the button, which works on a finite shelf too -- a
     * shop restocked by hand is an ordinary thing, and a finite shelf still knows
     * what it holds.
     */
    static async restockShelf(actor, shelfId, { force = false, onStep = null } = {}) {
        if (!game.user.isGM) return 0;
        const shelf = actor?.items?.get(shelfId);
        const config = this.getShelfConfig(shelf);
        if (!config) return 0;
        const step = typeof onStep === 'function' ? onStep : () => {};
        if (!force && this.resolveStockPolicy(actor, config) !== STOCK.RESTOCKING
            && !this.getShelfTables(shelf).some((entry) => entry.auto)) return 0;

        const filled = await this._withStockLock(actor, async () => {
            const updates = [];
            for (const item of this.getShelfContents(actor, shelf)) {
                const stock = this.getStock(actor, item, config);
                if (stock.unlimited || stock.available >= stock.par) continue;
                updates.push({ _id: item.id, 'system.quantity': stock.par });
            }
            if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
            return updates.length;
        });
        step(`Refilling ${shelf.name}`);

        // Two mechanisms, deliberately both: par brings back what the shelf is known
        // to keep, and the tables bring in whatever it happens to have got hold of
        // this time. A shelf may use either or both.
        const rolled = await this.rollShelfTable(actor, shelfId, { automatic: !force, onStep: step });

        await this.setShelfConfig(actor, shelfId, { lastRestock: game.time.worldTime });
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
        for (const actor of game.actors.filter((a) => this.isMerchant(a))) {
            for (const { item: shelf, config } of this.getShelves(actor, { includeHidden: true })) {
                // A table-stocked shelf restocks on the clock whatever its policy: it
                // is not refilling to a level, it is receiving a delivery.
                const rerolls = this.getShelfTables(shelf).some((entry) => entry.auto);
                if (this.resolveStockPolicy(actor, config) !== STOCK.RESTOCKING && !rerolls) continue;

                const days = Number(config.restockDays);
                const interval = (Number.isFinite(days) && days > 0 ? days : DEFAULT_RESTOCK_DAYS)
                    * secondsPerDay();
                const last = Number(config.lastRestock);

                // No clock yet, or a GM has wound the world back past it. Start it
                // here rather than restocking on the spot: switching a shelf to
                // restocking should not empty and refill it the same instant.
                if (!Number.isFinite(last) || worldTime < last) {
                    await this.setShelfConfig(actor, shelf.id, { lastRestock: worldTime });
                    continue;
                }
                if (worldTime - last < interval) continue;

                try {
                    await this.restockShelf(actor, shelf.id);
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
        notify.error('Could not open that shop.');
    }

    static open(tokenDocument) {
        if (!this.isMerchantToken(tokenDocument)) return null;
        return ShopWindow.open(tokenDocument);
    }

    // ==============================================================
    // ===== RECIPIENT POLICY =======================================
    // ==============================================================

    static getPartyActor() {
        const party = game.actors?.party ?? null;
        return party?.type === 'group' ? party : null;
    }

    static getPartyCharacters() {
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

    static async request(op, payload) {
        return GMRequest.request(op, payload);
    }

    /**
     * Runs on the GM only. Nothing in payload is trusted without re-resolving it.
     *
     * **One operation.** Everything that changes hands in a shop is one settlement:
     * goods out, goods in, and coin in whichever direction the difference falls.
     * There were four — buy, acquire, checkout, sell — and each was a separate path
     * through the same money, which is a separate place for them to disagree.
     */
    static async _process(op, payload, userId) {
        const user = game.users.get(userId);
        if (!user) return { ok: false, code: 'UNKNOWN_USER' };
        if (op !== 'settle') return { ok: false, code: 'UNKNOWN_OPERATION' };

        const tokenDocument = payload?.tokenUuid ? await fromUuid(payload.tokenUuid) : null;
        const merchant = tokenDocument?.actor;
        if (!merchant) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        if (!this.isMerchant(merchant)) return { ok: false, code: 'NOT_A_MERCHANT' };
        if (!this.isOpen(merchant) && !user.isGM) return { ok: false, code: 'SHOP_CLOSED' };

        const result = await this._processSettle(merchant, payload, user);
        if (result?.ok) this._broadcastRefresh(tokenDocument.uuid);
        return result;
    }

    /**
     * The goods legs of an exchange: everything leaving the shelves.
     *
     * The stock policy is expressed entirely as two flags on the transfer, which is
     * what `copy` and `preserveEmptySource` were asked for and built for:
     *
     * - **infinite** — `copy`, so the merchant's row is a template and is not touched.
     *   The primitive deliberately does not treat a copied source's stack as a
     *   ceiling, so a shelf reading 1 sells three.
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
        // `items` is an array, so a whole cart from one shelf policy is one leg. A leg
        // per line would be the mistake `api-inventory.md` names for grantItems: the
        // plural form only batches when everything meets in the same call.
        //
        // Two legs at most, because the two policies cannot share one: `copy` and
        // `preserveEmptySource` are per transfer and answer different stock models.
        const groups = new Map();
        for (const line of lines) {
            const unlimited = this.resolveStockPolicy(merchant, line.shelfConfig) === STOCK.INFINITE;
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
     * The coin legs of a transaction: money one way, change back.
     *
     * `payerUuid` hands over `plan.pay` and `payeeUuid` hands back `plan.change`, so
     * buying and selling are the same call with the two swapped — which is the whole
     * reason a symmetric primitive was asked for.
     *
     * Never netted: the payer must actually hold what they hand over, which is what
     * happens at a counter, and every leg is validated against the balances at the
     * start of the call so change arriving cannot fund the payment.
     *
     * An empty leg is a no-op rather than an error, so exact money adds nothing.
     */
    static _coinTransfers(payerUuid, payeeUuid, plan) {
        const legs = [];
        if (Object.keys(plan.pay ?? {}).length) {
            legs.push({ from: payerUuid, to: payeeUuid, currency: plan.pay });
        }
        if (Object.keys(plan.change ?? {}).length) {
            legs.push({ from: payeeUuid, to: payerUuid, currency: plan.change });
        }
        return legs;
    }

    /**
     * Whether the merchant actually holds the coins it owes in change.
     *
     * Whichever side owes change has to hold the coins for it. Checked here so the
     * refusal names the problem: the primitive would refuse it anyway and nothing
     * would move, but a bare `INSUFFICIENT_CURRENCY` reads as a mysterious failure of
     * the player's purchase when what it means is that somebody cannot break a large
     * coin.
     */
    /** The change owed, in base units, so a message can name it. */
    static _changeBase(plan) {
        return Object.entries(plan.change ?? {})
            .reduce((total, [denomination, amount]) => total + toBase(amount, denomination), 0);
    }

    /**
     * Which coins are missing, and how many, so a refusal can say something useful.
     *
     * "The till cannot cover it" is not actionable when the till holds twenty thousand
     * gold. What it actually lacks is *small change* -- six silver, say -- and that is
     * a different problem with a different fix.
     */
    static _changeShortfall(payee, plan) {
        const purse = payee?.system?.currency ?? {};
        const missing = {};
        for (const [denomination, amount] of Object.entries(plan?.change ?? {})) {
            const held = Number(purse[denomination] ?? 0);
            if (held < amount) missing[denomination] = amount - held;
        }
        return missing;
    }

    static _canMakeChange(payee, plan) {
        const purse = payee?.system?.currency ?? {};
        return Object.entries(plan.change ?? {})
            .every(([denomination, amount]) => Number(purse[denomination] ?? 0) >= amount);
    }

    /**
     * Give an unpriced item the price that was agreed for it.
     *
     * A haggled discount is not what a thing is worth — a longsword bought cheap is
     * still a longsword, and selling it on should fetch a longsword's price. So a
     * price is only ever written where there was none, which is the case a negotiate
     * shelf exists for: the odd, the unique, the thing with no entry in any book.
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
                ? resolveBuybackPrice(config, this.getShelfConfig(this.getShelfFor(merchant, item)), item)
                : resolvePrice(config, this.getShelfConfig(this.getShelfFor(owner, item)), item);
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
    static _priceBuying(merchant, requested, user) {
        const config = this.getConfig(merchant);
        const lines = [];
        let total = 0;

        for (const entry of requested) {
            const item = merchant.items?.get(entry?.itemId);
            if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
            if (!isPhysical(item.type)) return { ok: false, code: 'ITEM_NOT_TRANSFERABLE' };
            if (this.isShelf(item)) return { ok: false, code: 'NOT_FOR_SALE' };

            const shelf = this.getShelfFor(merchant, item);
            if (!shelf) return { ok: false, code: 'NOT_FOR_SALE', itemName: item.name };
            const shelfConfig = this.getShelfConfig(shelf);
            // Hidden is a permission, not a display filter: a crafted request naming a
            // back-room item is refused here, not merely omitted from the window.
            if (shelfConfig.visible === false && !user.isGM) {
                return { ok: false, code: 'NOT_FOR_SALE', itemName: item.name };
            }
            // No `BARTER_ONLY` refusal any more. A negotiate shelf has no list price,
            // so `resolvePrice` returns null until one is agreed — and refusing an
            // unpriced line is the same refusal either way.
            const unit = resolvePrice(config, shelfConfig, item);
            if (unit === null) return { ok: false, code: 'NOT_NEGOTIATED', itemName: item.name };

            const quantity = Math.max(1, Math.trunc(Number(entry.quantity) || 1));
            total += unit * quantity;
            lines.push({ item, quantity, shelfConfig });
        }
        return { ok: true, lines, total };
    }

    /** Price the sell side, against the buyback shelf's rate. */
    static _priceSelling(merchant, seller, shelf, requested) {
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

            const unit = resolveBuybackPrice(config, shelf.config, item);
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
    static async _processSettle(merchant, payload, user) {
        const buying = Array.isArray(payload.buy) ? payload.buy : [];
        const selling = Array.isArray(payload.sell) ? payload.sell : [];
        if (!buying.length && !selling.length) return { ok: false, code: 'NOTHING_TO_SETTLE' };

        // One Actor throughout: it pays, it is paid, it receives what is bought, and
        // it is where what is sold comes from.
        const check = this._validateShopper(payload.shopperUuid, user);
        if (!check.ok) return check;
        const shopper = check.actor;

        const bought = buying.length ? this._priceBuying(merchant, buying, user) : { ok: true, lines: [], total: 0 };
        if (!bought.ok) return bought;

        let shelf = null;
        let sold = { ok: true, lines: [], total: 0 };
        if (selling.length) {
            shelf = this.getShelves(merchant, { includeHidden: true })
                .find(({ config }) => config.mode === 'buyback');
            if (!shelf) return { ok: false, code: 'NO_BUYBACK_SHELF' };
            sold = this._priceSelling(merchant, shopper, shelf, selling);
            if (!sold.ok) return sold;
        }

        const net = bought.total - sold.total;
        let plan = { pay: {}, change: {} };
        let coin = [];

        if (net > 0) {
            plan = planPayment(shopper, net);
            if (!plan) return { ok: false, code: 'CANNOT_AFFORD', price: net, held: purseValue(shopper) };
            if (!this._canMakeChange(merchant, plan)) {
                return {
                    ok: false, code: 'NO_CHANGE', side: 'merchant', price: net,
                    changeBase: this._changeBase(plan), shortfall: this._changeShortfall(merchant, plan)
                };
            }
            coin = this._coinTransfers(shopper.uuid, merchant.uuid, plan);
        } else if (net < 0) {
            plan = planPayment(merchant, -net);
            if (!plan) {
                return { ok: false, code: 'MERCHANT_CANNOT_AFFORD', price: -net, held: purseValue(merchant) };
            }
            if (!this._canMakeChange(shopper, plan)) {
                return {
                    ok: false, code: 'NO_CHANGE', side: 'shopper', price: -net,
                    changeBase: this._changeBase(plan), shortfall: this._changeShortfall(shopper, plan)
                };
            }
            coin = this._coinTransfers(merchant.uuid, shopper.uuid, plan);
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
                // Bought stock lands on the buyback shelf rather than loose on the NPC.
                container: shelf.item.id
            }]
            : [];

        const result = await exchange({
            transfers: [
                ...this._goodsTransfers(merchant, shopper.uuid, bought.lines),
                ...goodsIn,
                ...coin
            ],
            // `par` describes a shelf, not an item, and has no business travelling with
            // one. `registerTransientFlag` hides it from merge comparison but leaves it
            // in the payload, so without this it lands in a buyer's inventory and rides
            // back in if they sell it — see the buyback guard in `getStock`.
            omitFlags: [`${MODULE.ID}.${PAR_FLAG}`],
            // **And the same path in `ignoreFlags`, for the migration.** Anything bought
            // before this landed carries `par` on the buyer's row, so an arrival without
            // it would compare as different and create a second stack rather than
            // merging. That is a silent, self-inflicted duplicate-row bug with a long
            // tail; the transient registry covers our own writes but not the rows that
            // already exist in somebody's world.
            ignoreFlags: [`${MODULE.ID}.${PAR_FLAG}`]
        });

        // An agreement covers the trade it was made for. Left standing, a haggled
        // discount would quietly become the shelf price for everyone who came after,
        // and a settled negotiate line would keep a price the shelf exists not to
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
        const buyback = { ...(pricing.buybackOverrides ?? {}) };

        let touched = false;
        for (const line of boughtLines ?? []) {
            if (line?.item?.id in overrides) { delete overrides[line.item.id]; touched = true; }
        }
        for (const line of soldLines ?? []) {
            if (line?.itemId in buyback) { delete buyback[line.itemId]; touched = true; }
        }
        if (!touched) return;

        pricing.overrides = overrides;
        pricing.buybackOverrides = buyback;
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

    // Stock is infinite, so a refresh is only for the GM changing what is on offer.
    static _broadcastRefresh(tokenUuid) {
        game.socket.emit(`module.${MODULE.ID}`, { action: 'shopRefresh', tokenUuid });
        ShopWindow.refreshForToken(tokenUuid);
    }

    /** Shelf changes are Actor-level, so they reach every token of that merchant. */
    static broadcastActorRefresh(actor) {
        if (!actor) return;
        game.socket.emit(`module.${MODULE.ID}`, { action: 'shopRefresh', actorUuid: actor.uuid });
        void ShopWindow.refreshForActor(actor.uuid);
    }

    /**
     * Follow edits made outside Merchant's own windows.
     *
     * A GM can rename a shelf, restock one, or delete one from the Actor sheet, the
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
            // A shelf, or anything sitting on one. Everything else on a merchant is
            // the shopkeeper's own gear and changes nothing a shop window shows.
            const relevant = this.isShelf(item) || Boolean(this.getShelfFor(actor, item));
            if (relevant) this.broadcastActorRefresh(actor);
        };

        Hooks.on('updateItem', (item, changes) => {
            // Quantity, name and our own flag are the three that change what a shop
            // window renders. Anything else is an edit to an item that happens to be
            // in a shop.
            const touches = changes?.name !== undefined
                || changes?.system?.quantity !== undefined
                || changes?.system?.container !== undefined
                || changes?.flags?.[MODULE.ID] !== undefined;
            if (touches) react(item);
        });
        Hooks.on('createItem', (item) => react(item));
        // On delete the item is already off the Actor, so `getShelfFor` cannot see
        // where it was. The container id is still on the document being removed.
        Hooks.on('deleteItem', (item) => {
            if (!game.user.isGM) return;
            const actor = item?.parent;
            if (!actor?.items || !this.isMerchant(actor)) return;
            if (this.isShelf(item) || item?.system?.container) this.broadcastActorRefresh(actor);
        });
    }

    static _registerRefreshListener() {
        game.socket.on(`module.${MODULE.ID}`, (data) => {
            if (data?.action !== 'shopRefresh') return;
            if (data.actorUuid) void ShopWindow.refreshForActor(data.actorUuid);
            else ShopWindow.refreshForToken(data.tokenUuid);
        });
    }
}
