// ==================================================================
// ===== MERCHANT MANAGER ===========================================
// ==================================================================
//
// State, interaction claiming, recipient policy, and the GM-authoritative handler.

import {
    MODULE, MERCHANT_FLAG, STOCK, PAR_FLAG, DEFAULT_RESTOCK_DAYS, DEFAULT_SHOP_KIND,
    SHELF_FLAG, SHELF_PRESETS, isScheduledOpen, hourAt, secondsPerDay
} from './const.js';
import { grantItem, isPhysical, exchange, hasExchange } from './merchant-inventory.js';
import { resolvePrice, resolveBuybackPrice, planPayment, purseValue, formatBase, toBase } from './merchant-pricing.js';
import * as GMRequest from './gm-request.js';
import { ShopWindow } from './window-shop.js';

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
            open: true,
            hours: null,
            pricing: { markup: 1.0, overrides: {} }
        };
    }

    static async setConfig(actor, changes) {
        const current = this.getConfig(actor) ?? this.defaultConfig();
        return actor.setFlag(MODULE.ID, MERCHANT_FLAG, { ...current, ...changes });
    }

    /** Open for business. A closed shop is browsable but nothing can be acquired. */
    static isOpen(actor) {
        return this.getConfig(actor)?.open !== false;
    }

    static async setOpen(actor, open) {
        if (!game.user.isGM) return null;
        return this.setConfig(actor, { open: Boolean(open) });
    }

    static getHours(actor) {
        const hours = this.getConfig(actor)?.hours;
        return hours && Number.isFinite(Number(hours.open)) && Number.isFinite(Number(hours.close))
            ? { open: Number(hours.open), close: Number(hours.close) }
            : null;
    }

    static async setHours(actor, hours) {
        if (!game.user.isGM) return null;
        await this.setConfig(actor, { hours });
        // Applied at once, so setting hours does not sit inert until the clock next
        // moves. A GM who just set 9 to 6 at noon expects an open shop.
        return this.applySchedule(actor);
    }

    /**
     * Whether the shop currently disagrees with its own schedule — which is what an
     * override *is*. No stored flag: the next boundary crossing sets the state to
     * match, clearing the override by doing the ordinary thing, and a GM toggling
     * back to the scheduled state clears it because there is nothing left to
     * disagree with.
     */
    static isOverridden(actor) {
        const scheduled = isScheduledOpen(this.getHours(actor), hourAt());
        return scheduled !== null && scheduled !== this.isOpen(actor);
    }

    static async applySchedule(actor) {
        const scheduled = isScheduledOpen(this.getHours(actor), hourAt());
        if (scheduled === null || scheduled === this.isOpen(actor)) return false;
        await this.setConfig(actor, { open: scheduled });
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
        Hooks.on('updateWorldTime', (worldTime, dt) => {
            if (!game.user.isGM) return;
            void this._onWorldTimeChange(worldTime, dt);
        });
    }

    static async _onWorldTimeChange(worldTime, dt) {
        // Restocking rides the same watcher rather than registering a second one.
        // One clock, one hook, one thing to remember.
        await this._applyRestocks(worldTime);

        const previousHour = hourAt(worldTime - (Number(dt) || 0));
        const currentHour = hourAt(worldTime);
        if (previousHour === null || currentHour === null) return;

        for (const actor of game.actors.filter((a) => this.isMerchant(a))) {
            const hours = this.getHours(actor);
            if (!hours) continue;

            const before = isScheduledOpen(hours, previousHour);
            const after = isScheduledOpen(hours, currentHour);
            // Only a crossing acts. Between boundaries a GM override stands.
            if (before === after) continue;
            if (after === this.isOpen(actor)) continue;

            try {
                await this.setConfig(actor, { open: after });
                this.broadcastActorRefresh(actor);
            } catch (error) {
                console.error(`${MODULE.TITLE} | Could not apply the schedule for ${actor.name}:`, error);
            }
        }
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
     * One write. `grantItem` takes the container itself, so the item arrives on the
     * shelf rather than landing at the root and being moved.
     */
    static async addToShelf(actor, shelfId, itemUuid, quantity) {
        if (!game.user.isGM) return { ok: false, code: 'NOT_ALLOWED' };
        const shelf = actor?.items?.get(shelfId);
        if (!this.isShelf(shelf)) return { ok: false, code: 'NOT_A_SHELF' };

        const result = await grantItem({
            targetActorUuid: actor.uuid,
            itemUuid,
            quantity,
            // Container membership is part of merge identity, so a merge can only
            // land on a row already on this shelf — stock the GM put elsewhere is
            // never relocated by a restock.
            container: shelfId
        });

        // What a GM stocks is what the shelf keeps, so the arriving quantity becomes
        // the restock target. On a merge the row already had one and it stands: the
        // GM topping a shelf up by hand is not redefining what it holds.
        if (result?.ok && !result.merged && result.targetItemId) {
            const placed = actor.items.get(result.targetItemId);
            const arrived = Math.max(1, Math.trunc(Number(placed?.system?.quantity ?? quantity ?? 1)));
            if (placed) await placed.setFlag(MODULE.ID, PAR_FLAG, arrived);
        }
        return result;
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
        const stored = Number(item?.getFlag(MODULE.ID, PAR_FLAG));
        const par = Number.isFinite(stored) ? Math.max(0, Math.trunc(stored)) : available;
        return { policy, unlimited: false, available, par };
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
        const value = Math.max(0, Math.trunc(Number(quantity) || 0));
        await item.update({
            'system.quantity': value,
            [`flags.${MODULE.ID}.${PAR_FLAG}`]: value
        });
        return item;
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
     * Refill a shelf to its par levels.
     *
     * `force` is the GM pressing the button, which works on a finite shelf too -- a
     * shop restocked by hand is an ordinary thing, and a finite shelf still knows
     * what it holds.
     */
    static async restockShelf(actor, shelfId, { force = false } = {}) {
        if (!game.user.isGM) return 0;
        const shelf = actor?.items?.get(shelfId);
        const config = this.getShelfConfig(shelf);
        if (!config) return 0;
        if (!force && this.resolveStockPolicy(actor, config) !== STOCK.RESTOCKING) return 0;

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

        await this.setShelfConfig(actor, shelfId, { lastRestock: game.time.worldTime });
        if (filled) this.broadcastActorRefresh(actor);
        return filled;
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
                if (this.resolveStockPolicy(actor, config) !== STOCK.RESTOCKING) continue;

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
        ui.notifications?.error('Could not open that shop.');
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

    /** Who this user may acquire *as*. A GM may act as any party character. */
    static getEligibleRecipients() {
        if (game.user.isGM) return this.getPartyCharacters();
        return game.actors.filter((actor) => actor.type === 'character' && actor.isOwner);
    }

    /** Who this user may send an item *to*. */
    static getGiftRecipients(excludeUuid) {
        return this.getPartyCharacters().filter((actor) => actor.uuid !== excludeUuid);
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
     * Two operations, because everything a player buys goes through the cart. There
     * was a `buy` that purchased one row outright and an `acquire` that handed one
     * over free; both are gone. Buy-now was never fewer prompts than the cart — pick a
     * quantity, pick a destination, confirm, either way — so it was a second path
     * through the same money for no gain, and a second place for the two to disagree.
     */
    static async _process(op, payload, userId) {
        const user = game.users.get(userId);
        if (!user) return { ok: false, code: 'UNKNOWN_USER' };
        if (!['sell', 'checkout'].includes(op)) return { ok: false, code: 'UNKNOWN_OPERATION' };

        const tokenDocument = payload?.tokenUuid ? await fromUuid(payload.tokenUuid) : null;
        const merchant = tokenDocument?.actor;
        if (!merchant) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        if (!this.isMerchant(merchant)) return { ok: false, code: 'NOT_A_MERCHANT' };
        if (!this.isOpen(merchant) && !user.isGM) return { ok: false, code: 'SHOP_CLOSED' };

        const result = op === 'checkout'
            ? await this._processCheckout(merchant, payload, user)
            : await this._processSell(merchant, payload, user);

        if (result?.ok) this._broadcastRefresh(tokenDocument.uuid);
        return result;
    }

    /**
     * One leg of an exchange: goods leaving the shelf.
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
    static _goodsTransfer(merchant, item, shelfConfig, recipientUuid, quantity) {
        const unlimited = this.resolveStockPolicy(merchant, shelfConfig) === STOCK.INFINITE;
        return {
            from: merchant.uuid,
            to: recipientUuid,
            items: [{ itemId: item.id, quantity }],
            ...(unlimited ? { copy: true } : { preserveEmptySource: true })
        };
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

    static _canMakeChange(payee, plan) {
        const purse = payee?.system?.currency ?? {};
        return Object.entries(plan.change ?? {})
            .every(([denomination, amount]) => Number(purse[denomination] ?? 0) >= amount);
    }

    /**
     * Buy a whole cart at once.
     *
     * **One payment and one lot of change, however many lines.** That is the point of
     * a cart: six separate purchases would be six payments each rounding its own
     * change, which is both more writes and worse arithmetic for the player.
     *
     * Delivery is still per line, because stock is a count and each line grants a
     * copy — see `_goodsTransfer`. Every line and both coin legs are in one call, so
     * a cart that cannot be filled writes nothing rather than half of it.
     *
     * Every line is re-priced here rather than trusting what the cart was built
     * against: a GM may have changed a markup, removed stock, or closed the shop
     * while the cart sat open.
     */
    static async _processCheckout(merchant, payload, user) {
        const check = this._validateRecipient(payload.recipientUuid, user);
        if (!check.ok) return check;

        const requested = Array.isArray(payload.items) ? payload.items : [];
        if (!requested.length) return { ok: false, code: 'EMPTY_CART' };

        const config = this.getConfig(merchant);
        const lines = [];
        let total = 0;

        for (const entry of requested) {
            const item = merchant.items?.get(entry?.itemId);
            if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
            if (!isPhysical(item.type)) return { ok: false, code: 'ITEM_NOT_TRANSFERABLE' };
            if (this.isShelf(item)) return { ok: false, code: 'NOT_FOR_SALE' };

            const shelf = this.getShelfFor(merchant, item);
            if (!shelf) return { ok: false, code: 'NOT_FOR_SALE' };
            const shelfConfig = this.getShelfConfig(shelf);
            if (shelfConfig.visible === false && !user.isGM) return { ok: false, code: 'NOT_FOR_SALE' };
            if (shelfConfig.mode === 'barter') return { ok: false, code: 'BARTER_ONLY' };

            const unit = resolvePrice(config, shelfConfig, item);
            if (unit === null) return { ok: false, code: 'NOT_PRICED' };

            const quantity = Math.max(1, Math.trunc(Number(entry.quantity) || 1));
            total += unit * quantity;
            lines.push({ item, quantity, shelfConfig, name: item.name });
        }

        const payerCheck = this._validatePayer(payload.payerUuid ?? check.actorUuid, check.actorUuid, user);
        if (!payerCheck.ok) return payerCheck;

        const plan = planPayment(payerCheck.actor, total);
        if (!plan) return { ok: false, code: 'CANNOT_AFFORD', price: total, held: purseValue(payerCheck.actor) };

        if (!hasExchange()) return { ok: false, code: 'EXCHANGE_UNAVAILABLE' };
        if (!this._canMakeChange(merchant, plan)) {
            return { ok: false, code: 'NO_CHANGE', price: total, changeBase: this._changeBase(plan) };
        }

        // One call for the whole cart: every line and both coin legs commit together,
        // so a cart that cannot be filled writes nothing rather than half of it. The
        // per-line stock check that used to run first is the primitive's job now.
        return exchange({
            transfers: [
                ...lines.map((line) =>
                    this._goodsTransfer(merchant, line.item, line.shelfConfig, check.actorUuid, line.quantity)),
                ...this._coinTransfers(payerCheck.actor.uuid, merchant.uuid, plan)
            ]
        }).then((result) => (result?.ok ? { ...result, price: total } : result));
    }

    /**
     * Selling: the party's item to the merchant, coin the other way.
     *
     * The same operation with the sides swapped, which is why a symmetric primitive
     * was asked for rather than a buy-shaped one.
     *
     * **This inverts the trust model.** Every other handler validates that someone
     * may *receive*; here a player is handing something over, so the item must be
     * theirs and the merchant must be able to pay for it.
     */
    static async _processSell(merchant, payload, user) {
        const shelf = this.getShelves(merchant, { includeHidden: true })
            .find(({ config }) => config.mode === 'buyback');
        if (!shelf) return { ok: false, code: 'NO_BUYBACK_SHELF' };

        const seller = payload.sellerUuid ? fromUuidSync(payload.sellerUuid) : null;
        if (!seller || seller.type !== 'character') return { ok: false, code: 'RECIPIENT_NOT_FOUND' };
        // The seller must be the requester's own character. Giving away someone
        // else's possessions is not a thing a shop workflow should enable.
        if (!user.isGM && !seller.testUserPermission(user, 'OWNER')) return { ok: false, code: 'NOT_YOUR_ITEM' };

        const item = seller.items?.get(payload.itemId);
        if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
        if (!isPhysical(item.type)) return { ok: false, code: 'ITEM_NOT_TRANSFERABLE' };

        const quantity = Math.max(1, Math.trunc(Number(payload.quantity) || 1));
        const available = Number(item.system?.quantity ?? 1);
        if (Number.isFinite(available) && quantity > available) {
            return { ok: false, code: 'INSUFFICIENT_QUANTITY', available };
        }

        const unit = resolveBuybackPrice(this.getConfig(merchant), shelf.config, item);
        if (unit === null) return { ok: false, code: 'NOT_PRICED' };
        const total = unit * quantity;

        // A merchant with an empty till cannot buy, which is a fiction a GM may well
        // want. Refused rather than conjuring coin.
        const plan = planPayment(merchant, total);
        if (!plan) return { ok: false, code: 'MERCHANT_CANNOT_AFFORD', price: total, held: purseValue(merchant) };

        if (!hasExchange()) return { ok: false, code: 'EXCHANGE_UNAVAILABLE' };
        // The merchant is paying, so it is the seller who owes change back.
        if (!this._canMakeChange(seller, plan)) {
            return { ok: false, code: 'NO_CHANGE', price: total, changeBase: this._changeBase(plan) };
        }

        // Three arrows, not two sides. Selling genuinely does move the goods — the
        // party's sword becomes the merchant's — so this is a transfer rather than the
        // copy a purchase needs, and it is the one direction the primitive already
        // suits without a new option.
        const result = await exchange({
            transfers: [
                {
                    from: seller.uuid,
                    to: merchant.uuid,
                    items: [{ itemId: item.id, quantity }],
                    // Bought stock lands on the buyback shelf rather than loose on the
                    // NPC. `container` belongs to the transfer, so it is unambiguously
                    // about where these items arrive.
                    container: shelf.item.id
                },
                ...this._coinTransfers(merchant.uuid, seller.uuid, plan)
            ]
        });

        return result?.ok ? { ...result, price: total } : result;
    }

    /**
     * Who is paying, and may they.
     *
     * The payer is always the shopper, never the destination: buying for the party
     * or for another character is a gift, and a gift comes out of the giver's purse.
     * That makes a delivery elsewhere a **three-party** transaction — merchant,
     * payer, recipient — which the two-sided `exchange` shape cannot express. Refused
     * explicitly rather than silently charging the wrong purse.
     */
    static _validatePayer(payerUuid, recipientUuid, user) {
        if (!payerUuid) return { ok: false, code: 'NO_PAYER' };

        let payer = null;
        try {
            payer = fromUuidSync(payerUuid);
        } catch (_error) {
            return { ok: false, code: 'RECIPIENT_NOT_FOUND' };
        }
        if (!payer || payer.type !== 'character') return { ok: false, code: 'RECIPIENT_NOT_FOUND' };
        // Spending someone else's coin is not a thing a shop should enable.
        if (!user.isGM && !payer.testUserPermission(user, 'OWNER')) return { ok: false, code: 'NOT_YOUR_COIN' };

        if (recipientUuid && recipientUuid !== payerUuid) {
            return { ok: false, code: 'THIRD_PARTY_DELIVERY' };
        }
        return { ok: true, actor: payer };
    }

    /**
     * A recipient is valid when the requester owns it, it is a party character, or it
     * is the party Group Actor. Ownership alone is too narrow, because sending to
     * another player's character is a supported action.
     */
    static _validateRecipient(recipientUuid, user) {
        if (!recipientUuid) return { ok: false, code: 'NO_RECIPIENT' };

        const party = this.getPartyActor();
        if (party?.uuid === recipientUuid) return { ok: true, actorUuid: recipientUuid };

        let actor = null;
        try {
            actor = fromUuidSync(recipientUuid);
        } catch (_error) {
            return { ok: false, code: 'RECIPIENT_NOT_FOUND' };
        }
        if (!actor || actor.type !== 'character') return { ok: false, code: 'RECIPIENT_NOT_FOUND' };
        if (user.isGM) return { ok: true, actorUuid: recipientUuid };
        if (actor.testUserPermission(user, 'OWNER')) return { ok: true, actorUuid: recipientUuid };
        if (this.getPartyCharacters().some((member) => member.uuid === recipientUuid)) {
            return { ok: true, actorUuid: recipientUuid };
        }
        return { ok: false, code: 'RECIPIENT_NOT_ALLOWED' };
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
