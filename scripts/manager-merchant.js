// ==================================================================
// ===== MERCHANT MANAGER ===========================================
// ==================================================================
//
// State, interaction claiming, recipient policy, and the GM-authoritative handler.

import { MODULE, MERCHANT_FLAG, STOCK, SHELF_FLAG, SHELF_PRESETS } from './const.js';
import { grantItem, isPhysical } from './merchant-inventory.js';
import * as GMRequest from './gm-request.js';
import { ShopWindow } from './window-shop.js';

const CONTEXT = 'merchant-interaction';

export class MerchantManager {
    static _interactionId = null;

    static initialize() {
        this._registerTokenInteraction();
        GMRequest.registerHandler((op, payload, userId) => this._process(op, payload, userId));
        this._registerRefreshListener();
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
            pricing: { markup: 1.0, overrides: {} }
        };
    }

    static async setConfig(actor, changes) {
        const current = this.getConfig(actor) ?? this.defaultConfig();
        return actor.setFlag(MODULE.ID, MERCHANT_FLAG, { ...current, ...changes });
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
        if (op !== 'acquire') return { ok: false, code: 'UNKNOWN_OPERATION' };

        const tokenDocument = payload?.tokenUuid ? await fromUuid(payload.tokenUuid) : null;
        const merchant = tokenDocument?.actor;
        if (!merchant) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        if (!this.isMerchant(merchant)) return { ok: false, code: 'NOT_A_MERCHANT' };

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

        const check = this._validateRecipient(payload.recipientUuid, user);
        if (!check.ok) return check;

        // grantItem, never transferItem: stock is infinite in v1, so the merchant's
        // item is a template and is never consumed.
        const result = await grantItem({
            targetActorUuid: check.actorUuid,
            itemUuid: item.uuid,
            quantity: payload.quantity
        });

        if (result?.ok) this._broadcastRefresh(tokenDocument.uuid);
        return result;
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

    static _registerRefreshListener() {
        game.socket.on(`module.${MODULE.ID}`, (data) => {
            if (data?.action === 'shopRefresh') ShopWindow.refreshForToken(data.tokenUuid);
        });
    }
}
