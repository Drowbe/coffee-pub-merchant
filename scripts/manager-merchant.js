// ==================================================================
// ===== MERCHANT MANAGER ===========================================
// ==================================================================
//
// State, interaction claiming, recipient policy, and the GM-authoritative handler.

import { MODULE, MERCHANT_FLAG, STOCK, SHELF_FLAG, SHELF_PRESETS, isScheduledOpen, hourAt } from './const.js';
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
        if (!game.user.isGM) return null;
        const shelf = actor?.items?.get(shelfId);
        const config = this.getShelfConfig(shelf);
        if (!config) return null;
        await shelf.setFlag(MODULE.ID, SHELF_FLAG, { ...config, visible: Boolean(visible) });
        return shelf;
    }

    /**
     * Put an item on a shelf from a UUID — a compendium entry, a sidebar item, or
     * anything else Foundry hands over in a drop payload.
     *
     * Two writes, because `grantItem` has no way to say which container the new item
     * lands in. Worth asking Blacksmith for a `container` option; until then this is
     * grant-then-place.
     */
    static async addToShelf(actor, shelfId, itemUuid, quantity) {
        if (!game.user.isGM) return { ok: false, code: 'NOT_ALLOWED' };
        const shelf = actor?.items?.get(shelfId);
        if (!this.isShelf(shelf)) return { ok: false, code: 'NOT_A_SHELF' };

        // `container` is honoured by the accessor today and by grantItem itself once
        // the fix lands, at which point this stops being two writes.
        const result = await grantItem({
            targetActorUuid: actor.uuid,
            itemUuid,
            quantity,
            // A merge landed on an existing row, which may already sit on another
            // shelf; relocating it would move stock the GM never touched.
            container: shelfId
        });
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
    // ===== INTERACTION ============================================
    // ==============================================================

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
                // MUST stay synchronous and MUST return the same answer twice in a
                // row. Foundry's permission predicate is synchronous and a promise is
                // truthy, so an async matcher would grant every double-click
                // unconditionally. Keep it a plain flag read.
                matches: (tokenDocument) => this.isMerchantToken(tokenDocument),
                // Players do not have LIMITED permission on a shopkeeper's Actor, and
                // Foundry's predicate runs before the handler.
                bypassPermission: true,
                // A throwing handler is a dead gesture by design: Blacksmith will not
                // fall through to Foundry once permission has been relaxed.
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
        if (!['acquire', 'buy', 'sell'].includes(op)) return { ok: false, code: 'UNKNOWN_OPERATION' };

        const tokenDocument = payload?.tokenUuid ? await fromUuid(payload.tokenUuid) : null;
        const merchant = tokenDocument?.actor;
        if (!merchant) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        if (!this.isMerchant(merchant)) return { ok: false, code: 'NOT_A_MERCHANT' };

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
            ? await this._processBuy(merchant, item, shelf, check.actorUuid, payload)
            // grantItem, never transferItem: stock is infinite, so the merchant's
            // item is a template and is never consumed.
            : await grantItem({
                targetActorUuid: check.actorUuid,
                itemUuid: item.uuid,
                quantity: payload.quantity
            });

        if (result?.ok) this._broadcastRefresh(tokenDocument.uuid);
        return result;
    }

    /**
     * Buying: goods one way, coin the other, both or neither.
     *
     * Everything except the mutation is decided here — price, affordability, and
     * which coins change hands. The mutation itself is one `exchange` call, because
     * splitting it into a transfer plus a currency move would mean writing rollback
     * across two primitives holding separate locks.
     */
    static async _processBuy(merchant, item, shelf, buyerUuid, payload) {
        const shelfConfig = this.getShelfConfig(shelf);
        if (shelfConfig?.mode === 'barter') return { ok: false, code: 'BARTER_ONLY' };

        const quantity = Math.max(1, Math.trunc(Number(payload.quantity) || 1));
        const unit = resolvePrice(this.getConfig(merchant), shelfConfig, item);
        if (unit === null) return { ok: false, code: 'NOT_PRICED' };

        const buyer = fromUuidSync(buyerUuid);
        const total = unit * quantity;

        // Checked before anything moves, and re-checked here rather than trusting the
        // window: prices and purses both change between render and click.
        const plan = planPayment(buyer, total);
        if (!plan) {
            return { ok: false, code: 'CANNOT_AFFORD', price: total, held: purseValue(buyer) };
        }

        if (!hasExchange()) return { ok: false, code: 'EXCHANGE_UNAVAILABLE' };

        const result = await exchange({
            actorA: { uuid: merchant.uuid, items: [{ itemId: item.id, quantity }], currency: plan.change },
            actorB: { uuid: buyerUuid, items: [], currency: plan.pay }
        });

        return result?.ok ? { ...result, price: total, paid: plan.pay, change: plan.change } : result;
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

        const result = await exchange({
            actorA: { uuid: seller.uuid, items: [{ itemId: item.id, quantity }], currency: plan.change },
            actorB: { uuid: merchant.uuid, items: [], currency: plan.pay },
            // Bought stock lands on the buyback shelf rather than loose on the NPC.
            container: { uuid: merchant.uuid, itemId: shelf.item.id }
        });

        return result?.ok ? { ...result, price: total } : result;
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
