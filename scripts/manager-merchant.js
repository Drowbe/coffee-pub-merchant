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
import { resolvePrice, resolveBuybackPrice, planPayment, purseValue, formatBase } from './merchant-pricing.js';
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
            .sort((a, b) => (a.config.order ?? 0) - (b.config.order ?? 0)
                || String(a.config.label ?? a.item.name).localeCompare(String(b.config.label ?? b.item.name)));
    }

    static getShelfContents(actor, shelfItem) {
        return actor.items.filter((item) => item.system?.container === shelfItem.id && isPhysical(item.type));
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
     * Infinite stock had no concurrency at all -- the merchant was never mutated, so
     * two players buying the same thing could not interact. Finite stock brings the
     * problem back: without this, both could read "1 left" and both succeed.
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

    /** Take stock off a shelf. Always called inside the lock, never outside it. */
    static async _consumeStock(item, quantity, stock) {
        if (stock.unlimited) return { ok: true };
        if (quantity > stock.available) {
            return { ok: false, code: 'INSUFFICIENT_STOCK', available: stock.available };
        }
        await item.update({ 'system.quantity': stock.available - quantity });
        return { ok: true };
    }

    /**
     * Re-read an item inside the lock.
     *
     * The document was resolved before the queue was joined, and a GM may have
     * deleted it while this request waited its turn.
     */
    static _reread(merchant, itemId) {
        return merchant?.items?.get(itemId) ?? null;
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

    /** Runs on the GM only. Nothing in payload is trusted without re-resolving it. */
    static async _process(op, payload, userId) {
        const user = game.users.get(userId);
        if (!user) return { ok: false, code: 'UNKNOWN_USER' };
        if (!['acquire', 'buy', 'sell', 'checkout'].includes(op)) return { ok: false, code: 'UNKNOWN_OPERATION' };

        const tokenDocument = payload?.tokenUuid ? await fromUuid(payload.tokenUuid) : null;
        const merchant = tokenDocument?.actor;
        if (!merchant) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        if (!this.isMerchant(merchant)) return { ok: false, code: 'NOT_A_MERCHANT' };

        if (op === 'checkout') {
            if (!this.isOpen(merchant) && !user.isGM) return { ok: false, code: 'SHOP_CLOSED' };
            const bought = await this._processCheckout(merchant, payload, user);
            if (bought?.ok) this._broadcastRefresh(tokenDocument.uuid);
            return bought;
        }

        if (op === 'sell') {
            if (!this.isOpen(merchant) && !user.isGM) return { ok: false, code: 'SHOP_CLOSED' };
            const sold = await this._processSell(merchant, payload, user);
            if (sold?.ok) this._broadcastRefresh(tokenDocument.uuid);
            return sold;
        }

        const item = merchant.items?.get(payload.itemId);
        if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
        if (!isPhysical(item.type)) return { ok: false, code: 'ITEM_NOT_TRANSFERABLE' };

        // Only what is on a shelf is for sale. The shopkeeper's own gear is not.
        const shelf = this.getShelfFor(merchant, item);
        if (!shelf) return { ok: false, code: 'NOT_FOR_SALE' };

        // Hidden is a permission, not a display filter: a crafted request naming a
        // back-room item has to be refused here, not merely hidden in the window.
        const shelfConfig = this.getShelfConfig(shelf);
        if (shelfConfig.visible === false && !user.isGM) return { ok: false, code: 'NOT_FOR_SALE' };

        if (!this.isOpen(merchant) && !user.isGM) return { ok: false, code: 'SHOP_CLOSED' };

        const check = this._validateRecipient(payload.recipientUuid, user);
        if (!check.ok) return check;

        const result = op === 'buy'
            ? await this._processBuy(merchant, item, shelf, check.actorUuid, payload, user)
            : await this._processAcquire(merchant, item, shelf, check.actorUuid, payload);

        if (result?.ok) this._broadcastRefresh(tokenDocument.uuid);
        return result;
    }

    /**
     * Hand goods over and take them off the shelf.
     *
     * **Always `grantItem`, never `transferItem`, whatever the stock policy.** The
     * merchant's item is a template carrying a count: a sale copies it and adjusts
     * the number. A transfer would delete the row on the last unit, which loses the
     * shelf layout and leaves a restocking shelf with nothing to restock.
     *
     * Must be called inside `_withStockLock`, and re-reads the item because the
     * document was resolved before this request joined the queue.
     */
    static async _deliver(merchant, itemId, shelfConfig, recipientUuid, quantity) {
        const item = this._reread(merchant, itemId);
        if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };

        const stock = this.getStock(merchant, item, shelfConfig);
        if (!stock.unlimited && stock.available < quantity) {
            return {
                ok: false,
                code: stock.available === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
                available: stock.available
            };
        }

        const granted = await grantItem({
            targetActorUuid: recipientUuid,
            itemUuid: item.uuid,
            quantity
        });
        if (!granted?.ok) return granted;

        const consumed = await this._consumeStock(item, quantity, stock);
        if (!consumed.ok) {
            // The goods are already delivered, and grantItem may have merged them
            // into a stack the recipient already had -- so there is no copy left to
            // take back, only a stack that would be wrong to delete. The shop's
            // count is out by this much until a GM notices, which is the cheaper of
            // the two errors.
            console.error(
                `${MODULE.TITLE} | Delivered ${quantity} x ${item.name} but could not adjust the count on ${merchant.name}.`,
                consumed
            );
        }
        return granted;
    }

    /**
     * Take without paying.
     *
     * The GM's stocking-and-testing path, and -- while there is no `exchange` -- the
     * only path that completes at all.
     */
    static async _processAcquire(merchant, item, shelf, recipientUuid, payload) {
        const quantity = Math.max(1, Math.trunc(Number(payload.quantity) || 1));
        const shelfConfig = this.getShelfConfig(shelf);
        return this._withStockLock(merchant, () =>
            this._deliver(merchant, item.id, shelfConfig, recipientUuid, quantity));
    }

    /**
     * Buying: goods out, coin in.
     *
     * Everything except the mutation is decided here — price, affordability, and
     * which coins change hands.
     *
     * **The goods and the coin are two writes, for now.** A single `exchange` carrying
     * both would be atomic, which is better, but `exchange` *moves* what it is given
     * and a shop's stock is a count rather than a document — so it would sell the
     * template itself and empty the shelf on the first purchase. Until a transfer can
     * say *copy*, delivery is a grant and payment is a currency-only exchange.
     *
     * The order is deliberate too: goods first, so a failed payment leaves the player
     * holding the item and the shop out of pocket. The reverse leaves a player who
     * paid for nothing. In a game the shop should eat it.
     *
     * Payment and change are **two transfers, never netted**. Netting would let a
     * payer hand over coin they do not have, and `exchange` validates every transfer
     * against the state at the start of the call — so change arriving cannot fund the
     * payment. That is the counter model rather than a limitation: you put money down
     * and money comes back.
     */
    static async _processBuy(merchant, item, shelf, buyerUuid, payload, user) {
        const shelfConfig = this.getShelfConfig(shelf);
        if (shelfConfig?.mode === 'barter') return { ok: false, code: 'BARTER_ONLY' };

        const quantity = Math.max(1, Math.trunc(Number(payload.quantity) || 1));
        const unit = resolvePrice(this.getConfig(merchant), shelfConfig, item);
        if (unit === null) return { ok: false, code: 'NOT_PRICED' };

        const payerCheck = this._validatePayer(payload.payerUuid ?? buyerUuid, buyerUuid, user);
        if (!payerCheck.ok) return payerCheck;

        const total = unit * quantity;

        // Re-checked here rather than trusting the window: prices and purses both
        // change between render and click.
        const plan = planPayment(payerCheck.actor, total);
        if (!plan) {
            return { ok: false, code: 'CANNOT_AFFORD', price: total, held: purseValue(payerCheck.actor) };
        }

        // Checked before the queue is joined so a shop with no exchange refuses
        // immediately rather than after taking a lock it cannot use.
        if (!hasExchange()) return { ok: false, code: 'EXCHANGE_UNAVAILABLE' };

        return this._withStockLock(merchant, async () => {
            const delivered = await this._deliver(merchant, item.id, shelfConfig, buyerUuid, quantity);
            if (!delivered?.ok) return delivered;

            const paid = await exchange({
                transfers: [
                    { from: payerCheck.actor.uuid, to: merchant.uuid, currency: plan.pay },
                    { from: merchant.uuid, to: payerCheck.actor.uuid, currency: plan.change }
                ]
            });
            if (!paid?.ok) {
                return { ...paid, delivered: true, price: total };
            }
            return { ...paid, price: total, paid: plan.pay, change: plan.change };
        });
    }

    /**
     * Buy a whole cart at once.
     *
     * **One payment and one lot of change, however many lines.** That is the point of
     * a cart: six separate purchases would be six payments each rounding its own
     * change, which is both more writes and worse arithmetic for the player.
     *
     * Delivery is still per line, because stock is a count and each line grants a
     * copy — see `_deliver`. Every line's stock is checked before any of it moves, so
     * a cart that cannot be filled fails whole rather than half.
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

            const shelf = this.getShelfFor(merchant, item);
            if (!shelf) return { ok: false, code: 'NOT_FOR_SALE' };
            const shelfConfig = this.getShelfConfig(shelf);
            if (shelfConfig.visible === false && !user.isGM) return { ok: false, code: 'NOT_FOR_SALE' };
            if (shelfConfig.mode === 'barter') return { ok: false, code: 'BARTER_ONLY' };

            const unit = resolvePrice(config, shelfConfig, item);
            if (unit === null) return { ok: false, code: 'NOT_PRICED' };

            const quantity = Math.max(1, Math.trunc(Number(entry.quantity) || 1));
            total += unit * quantity;
            lines.push({ itemId: item.id, quantity, shelfConfig, name: item.name });
        }

        const payerCheck = this._validatePayer(payload.payerUuid ?? check.actorUuid, check.actorUuid, user);
        if (!payerCheck.ok) return payerCheck;

        const plan = planPayment(payerCheck.actor, total);
        if (!plan) return { ok: false, code: 'CANNOT_AFFORD', price: total, held: purseValue(payerCheck.actor) };

        if (!hasExchange()) return { ok: false, code: 'EXCHANGE_UNAVAILABLE' };

        return this._withStockLock(merchant, async () => {
            // Every line is checked for stock before any of it is delivered, so a
            // cart that cannot be filled fails whole rather than half.
            for (const line of lines) {
                const item = this._reread(merchant, line.itemId);
                if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
                const stock = this.getStock(merchant, item, line.shelfConfig);
                if (!stock.unlimited && stock.available < line.quantity) {
                    return {
                        ok: false,
                        code: stock.available === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
                        available: stock.available,
                        itemName: line.name
                    };
                }
            }

            const delivered = [];
            for (const line of lines) {
                const result = await this._deliver(
                    merchant, line.itemId, line.shelfConfig, check.actorUuid, line.quantity
                );
                // Checked above, so this is a genuine failure rather than a race.
                // Whatever already went across stays: it may have merged into stacks
                // the buyer already had, so there is nothing safe to take back.
                if (!result?.ok) {
                    return { ...result, partial: delivered.length > 0, delivered: delivered.length };
                }
                delivered.push(line);
            }

            const paid = await exchange({
                transfers: [
                    { from: payerCheck.actor.uuid, to: merchant.uuid, currency: plan.pay },
                    { from: merchant.uuid, to: payerCheck.actor.uuid, currency: plan.change }
                ]
            });
            if (!paid?.ok) return { ...paid, delivered: true, price: total };
            return { ...paid, price: total };
        });
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
                { from: merchant.uuid, to: seller.uuid, currency: plan.pay },
                { from: seller.uuid, to: merchant.uuid, currency: plan.change }
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

    static _registerRefreshListener() {
        game.socket.on(`module.${MODULE.ID}`, (data) => {
            if (data?.action !== 'shopRefresh') return;
            if (data.actorUuid) void ShopWindow.refreshForActor(data.actorUuid);
            else ShopWindow.refreshForToken(data.tokenUuid);
        });
    }
}
