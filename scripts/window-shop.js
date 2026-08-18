import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import { MODULE, ITEM_CATEGORIES, formatHour } from './const.js';
import { resolvePrice, resolveBuybackPrice, formatBase, purseValue, planPayment } from './merchant-pricing.js';
import { hasExchange, isPhysical } from './merchant-inventory.js';
import { MerchantConfigWindow } from './window-merchant-config.js';
// Circular with manager-merchant.js by design: that module imports this one to open
// the window. Safe because every use below is inside a method, so the binding
// resolves at call time rather than at module evaluation.
import { MerchantManager } from './manager-merchant.js';

const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-shop.hbs';
const ROW_PARTIAL = 'modules/coffee-pub-merchant/templates/partial-shop-row.hbs';
let _partialsReady = null;

// Remembered across windows so a player with two characters is not asked twice.
let _lastRecipientUuid = null;

function _blacksmith() {
    return game.modules.get('coffee-pub-blacksmith')?.api ?? null;
}

/**
 * Attach an embedded Blacksmith control once its markup is in the document.
 *
 * Attaching to a detached wrapper does not work, and the failure is silent: the
 * inputs still render and still report a value, so an unbound entity list hands back
 * its initial selection rather than what the user picked. dialog.wait() exposes no
 * render hook, so poll a few frames for the input instead.
 */
async function _attachWhenRendered(control, inputName, frames = 20) {
    for (let i = 0; i < frames; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const live = document.querySelector(`[name="${inputName}"]`);
        if (!live) continue;
        control.attach(live.closest('.application') ?? document.body);
        return true;
    }
    console.warn(`${MODULE.TITLE} | Control "${inputName}" never rendered; falling back to form values.`);
    return false;
}

export class ShopWindow extends BlacksmithToolWindowBaseV2 {
    static _windows = new Map();

    // tokenUuid -> Map(itemId -> quantity). Per client, so naturally per user.
    // Kept in memory rather than on a document: a cart is a half-formed intention,
    // and persisting one would mean deciding when somebody else's abandoned cart
    // expires. It survives closing the window within a session and no longer.
    static _carts = new Map();

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-shop-window'],
            position: { width: 520, height: 560 },
            window: { title: 'Shop', resizable: true, minimizable: true },
            windowSizeConstraints: { minWidth: 420, minHeight: 320, maxWidth: 900, maxHeight: 'calc(100vh - 40px)' },
            toolTitlebar: 'full',
            rememberPosition: false,
            windowPositionKey: 'merchant-shop'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        changeRecipient: (_event, _target, win) => win.changeRecipient(),
        acquire: (_event, target, win) => win.run(() => win.acquire(target.dataset.itemId)),
        toggleShelf: (_event, target, win) => void win.toggleShelf(target.dataset.shelfId),
        toggleOpen: (_event, _target, win) => void win.toggleOpen(),
        buy: (_event, target, win) => win.run(() => win.buy(target.dataset.itemId)),
        sell: (_event, _target, win) => win.run(() => win.sell()),
        addToCart: (_event, target, win) => void win.addToCart(target.dataset.itemId),
        removeFromCart: (_event, target, win) => void win.removeFromCart(target.dataset.itemId),
        clearCart: (_event, _target, win) => void win.clearCart(),
        checkout: (_event, _target, win) => win.run(() => win.checkout()),
        addToShelf: (_event, _target, win) => void win.openCompendiumSearch()
    };

    constructor(tokenDocument, options = {}) {
        const opts = foundry.utils.mergeObject({}, options);
        opts.id ||= `merchant-shop-${tokenDocument.id}-${foundry.utils.randomID()}`;
        opts.position = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, ShopWindow.DEFAULT_OPTIONS.position ?? {}),
            opts.position || {}
        );
        opts.window = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, ShopWindow.DEFAULT_OPTIONS.window ?? {}),
            opts.window || {}
        );
        super(opts);
        this.tokenUuid = tokenDocument.uuid;
        this.busy = false;
    }

    static async open(tokenDocument) {
        const existing = this._windows.get(tokenDocument.uuid);
        if (existing) return existing.render(true);
        const win = new this(tokenDocument);
        this._windows.set(tokenDocument.uuid, win);
        await win.render(true);
        return win;
    }

    static closeForToken(tokenUuid) {
        const win = this._windows.get(tokenUuid);
        if (win) void win.close();
    }

    static refreshForToken(tokenUuid) {
        const win = this._windows.get(tokenUuid);
        if (win) void win.render(false);
    }

    /**
     * Refresh every open shop for one merchant, wherever its tokens are.
     *
     * Shelf changes are Actor-level, and a merchant can have tokens on several
     * scenes, so keying the refresh on a single token would miss the others.
     */
    static async refreshForActor(actorUuid) {
        for (const [tokenUuid, win] of this._windows) {
            const token = await fromUuid(tokenUuid);
            if (token?.actor?.uuid === actorUuid) void win.render(false);
        }
    }

    async _resolveToken() {
        return fromUuid(this.tokenUuid);
    }

    // ==============================================================
    // ===== RECIPIENT ==============================================
    // ==============================================================

    get recipients() {
        return MerchantManager.getEligibleRecipients();
    }

    get recipient() {
        const options = this.recipients;
        if (!options.length) return null;
        return options.find((actor) => actor.uuid === (this._recipientUuid ?? _lastRecipientUuid)) ?? options[0];
    }

    setRecipient(uuid) {
        if (!uuid) return;
        this._recipientUuid = uuid;
        _lastRecipientUuid = uuid;
        void this.render(false);
    }

    /**
     * Pick an Actor through Blacksmith's entity list: portraits and names read far
     * better than a select when choosing a character.
     */
    async _pickActor({ title, actors, selectedUuid, confirmLabel = 'Select', confirmIcon = 'fa-solid fa-check' }) {
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.entityList?.create !== 'function' || typeof blacksmith?.dialog?.wait !== 'function') {
            ui.notifications?.warn('The Blacksmith entity list is unavailable.');
            return null;
        }
        if (!actors.length) return null;

        const inputName = 'merchant-actor';
        const list = blacksmith.entityList.create({
            entities: actors.map((actor) => ({ id: actor.uuid, uuid: actor.uuid, name: actor.name, img: actor.img })),
            mode: 'single',
            inputName,
            selected: selectedUuid ?? actors[0].uuid
        });

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `<div class="blacksmith-field">${list.html}</div>`;

        let chosen = null;
        let bound = false;
        const pending = blacksmith.dialog.wait({
            title,
            content: wrapper,
            classes: ['merchant-dialog'],
            // Secondary action left, primary right.
            buttons: [
                { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
                {
                    action: 'select',
                    label: confirmLabel,
                    icon: confirmIcon,
                    default: true,
                    callback: (form) => {
                        chosen = bound ? list.getSelectedIds()?.[0] ?? null : form?.elements?.[inputName]?.value ?? null;
                    }
                }
            ],
            closeValue: null,
            cancelValue: null
        });

        bound = await _attachWhenRendered(list, inputName);
        const outcome = await pending;
        list.destroy();

        return outcome?.value === 'select' ? chosen : null;
    }

    async changeRecipient() {
        const options = this.recipients;
        if (options.length < 2) return;
        const picked = await this._pickActor({
            title: 'Buying As',
            actors: options,
            selectedUuid: this.recipient?.uuid,
            confirmIcon: 'fa-solid fa-user-check'
        });
        if (picked) this.setRecipient(picked);
    }

    // ==============================================================
    // ===== ACTIONS ================================================
    // ==============================================================

    /** In-flight feedback only. The concurrency guarantee is the GM's. */
    async run(operation) {
        if (this.busy) return;
        this.busy = true;
        this.element?.classList.add('merchant-shop-busy');
        try {
            await operation();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Shop action failed:`, error);
            ui.notifications?.error('That could not be completed.');
        } finally {
            this.busy = false;
            this.element?.classList.remove('merchant-shop-busy');
            if (this.constructor._windows.get(this.tokenUuid) === this) await this.render(false);
        }
    }

    async _send(payload, busy = {}, op = 'acquire') {
        this._busy = { row: busy.row ?? null, label: busy.label ?? 'Working' };
        await this.render(false);
        try {
            return await MerchantManager.request(op, { tokenUuid: this.tokenUuid, ...payload });
        } finally {
            this._busy = null;
        }
    }

    /** Ask how many only when there is a choice to make. */
    async _askQuantity(label, max) {
        if (max <= 1) return max;
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.quantitySplit?.create !== 'function' || typeof blacksmith?.dialog?.wait !== 'function') {
            return max;
        }

        const inputName = 'merchant-quantity';
        const control = blacksmith.quantitySplit.create({
            max,
            value: 1,
            inputName,
            giveLabel: 'Take',
            keepLabel: 'Leave',
            amountLabel: `How many ${label}?`
        });

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `<div class="blacksmith-field">${control.html}</div>`;

        let chosen = null;
        let bound = false;
        const pending = blacksmith.dialog.wait({
            title: `Acquire ${label}`,
            content: wrapper,
            classes: ['merchant-dialog'],
            buttons: [
                { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
                {
                    action: 'take',
                    label: 'Acquire',
                    icon: 'fa-solid fa-hand',
                    default: true,
                    callback: (form) => {
                        chosen = bound ? control.getValue() : Number(form?.elements?.[inputName]?.value ?? 1);
                    }
                }
            ],
            closeValue: null,
            cancelValue: null
        });

        bound = await _attachWhenRendered(control, inputName);
        const outcome = await pending;
        control.destroy();

        if (outcome?.value !== 'take') return null;
        const amount = Math.trunc(Number(chosen));
        return Number.isFinite(amount) && amount >= 1 ? Math.min(amount, max) : null;
    }

    async _itemContext(itemId) {
        const token = await this._resolveToken();
        const item = token?.actor?.items?.get(itemId);
        if (!item) {
            ui.notifications?.warn('That is no longer in stock.');
            return null;
        }
        return { item, token };
    }

    /**
     * Stock is infinite, so quantity is what the buyer wants rather than what is
     * available. The cap is arbitrary and exists only to keep the slider usable.
     */
    static MAX_PER_ACQUISITION = 20;

    get cart() {
        if (!ShopWindow._carts.has(this.tokenUuid)) ShopWindow._carts.set(this.tokenUuid, new Map());
        return ShopWindow._carts.get(this.tokenUuid);
    }

    async addToCart(itemId) {
        const context = await this._itemContext(itemId);
        if (!context) return;
        const amount = await this._askQuantity(context.item.name, ShopWindow.MAX_PER_ACQUISITION);
        if (!amount) return;
        this.cart.set(itemId, (this.cart.get(itemId) ?? 0) + amount);
        await this.render(false);
    }

    async removeFromCart(itemId) {
        this.cart.delete(itemId);
        await this.render(false);
    }

    async clearCart() {
        this.cart.clear();
        await this.render(false);
    }

    /**
     * Buy everything in the cart in one go.
     *
     * The whole point of a cart: one exchange, one payment, one lot of change. Buying
     * six things separately is six payments and six lots of change, which is both
     * more writes and worse arithmetic for the player.
     */
    async checkout() {
        const lines = await this._cartLines();
        if (!lines.length) return;

        const destination = await this._askDestination('Checkout');
        if (!destination) return;

        const total = lines.reduce((sum, line) => sum + line.total, 0);
        const buyer = fromUuidSync(destination.uuid);
        const plan = planPayment(buyer, total);
        if (!plan) {
            ui.notifications?.warn(
                'That comes to ' + formatBase(total) + ' and ' + (buyer?.name ?? 'the buyer')
                + ' holds ' + formatBase(purseValue(buyer)) + '.'
            );
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const list = lines.map((line) => '<li>' + line.quantity + ' &times; ' + line.name
                + ' &mdash; ' + formatBase(line.total) + '</li>').join('');
            const confirmed = await blacksmith.dialog.confirm({
                title: 'Checkout',
                classes: ['merchant-dialog'],
                content: '<ul class="merchant-cart-confirm">' + list + '</ul>'
                    + '<p>Total <strong>' + formatBase(total) + '</strong> to '
                    + (destination.label ?? 'the buyer') + '.</p>',
                confirmLabel: 'Pay',
                confirmIcon: 'fa-solid fa-coins'
            });
            if (!confirmed) return;
        }

        const result = await this._send(
            {
                items: lines.map((line) => ({ itemId: line.id, quantity: line.quantity })),
                recipientUuid: destination.uuid
            },
            { label: 'Paying' },
            'checkout'
        );

        if (result?.ok) this.cart.clear();
        this._report(result, 'Bought ' + lines.length + ' line' + (lines.length === 1 ? '' : 's')
            + ' for ' + formatBase(total) + '.');
    }

    /** Cart lines resolved against current stock and prices. */
    async _cartLines() {
        const token = await this._resolveToken();
        const merchant = token?.actor;
        if (!merchant) return [];
        const config = MerchantManager.getConfig(merchant);

        const lines = [];
        for (const [itemId, quantity] of this.cart) {
            const item = merchant.items.get(itemId);
            // Stock the GM removed while a cart sat open simply drops out of it.
            if (!item) {
                this.cart.delete(itemId);
                continue;
            }
            const shelf = MerchantManager.getShelfFor(merchant, item);
            const unit = resolvePrice(config, MerchantManager.getShelfConfig(shelf), item);
            if (unit === null) continue;
            lines.push({ id: itemId, name: item.name, img: item.img, quantity, unit, total: unit * quantity });
        }
        return lines;
    }

    /**
     * Who the goods are for: the acting character, another party member, or the
     * party itself. Asked once here rather than encoded in three icons per row.
     */
    async _askDestination(title) {
        const recipient = this.recipient;
        const party = MerchantManager.getPartyActor();
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.choose !== 'function') {
            return recipient ? { uuid: recipient.uuid, label: recipient.name } : null;
        }

        const choices = [];
        if (recipient) choices.push({ id: 'self', label: recipient.name, icon: 'fa-solid fa-user' });
        choices.push({ id: 'other', label: 'Another party member', icon: 'fa-solid fa-hand-holding-heart' });
        if (party) choices.push({ id: 'party', label: party.name, icon: 'fa-solid fa-users' });
        if (!choices.length) return null;

        const picked = await blacksmith.dialog.choose({
            title,
            classes: ['merchant-dialog'],
            content: '<p>Who is this for?</p>',
            choices
        });
        if (picked?.action !== 'submit') return null;

        if (picked.value === 'self' && recipient) return { uuid: recipient.uuid, label: recipient.name };
        if (picked.value === 'party' && party) return { uuid: party.uuid, label: party.name };

        const token = await this._resolveToken();
        const others = MerchantManager.getGiftRecipients(token?.actor?.uuid);
        if (!others.length) {
            ui.notifications?.warn('There is nobody else in the party.');
            return null;
        }
        const chosen = await this._pickActor({
            title: 'Who receives it?',
            actors: others,
            confirmLabel: 'Choose',
            confirmIcon: 'fa-solid fa-hand-holding-heart'
        });
        if (!chosen) return null;
        return { uuid: chosen, label: others.find((a) => a.uuid === chosen)?.name };
    }

    /**
     * Buy an item with coin.
     *
     * The affordability check and the coin plan run before anything is asked of the
     * GM, so a player learns they cannot afford something from the confirm rather
     * than from a refusal. The GM re-checks both regardless: this is the
     * explanation, that is the guard.
     */
    async buy(itemId) {
        const recipient = this.recipient;
        if (!recipient) {
            ui.notifications?.warn('You have no character able to buy.');
            return;
        }
        const context = await this._itemContext(itemId);
        if (!context) return;

        const merchant = context.token?.actor;
        const shelf = MerchantManager.getShelfFor(merchant, context.item);
        const unit = resolvePrice(
            MerchantManager.getConfig(merchant),
            MerchantManager.getShelfConfig(shelf),
            context.item
        );
        if (unit === null) {
            ui.notifications?.warn(context.item.name + ' has no price.');
            return;
        }

        const amount = await this._askQuantity(context.item.name, ShopWindow.MAX_PER_ACQUISITION);
        if (!amount) return;

        const total = unit * amount;
        const plan = planPayment(recipient, total);
        if (!plan) {
            ui.notifications?.warn(
                recipient.name + ' cannot afford that \u2014 ' + formatBase(total)
                + ' needed, ' + formatBase(purseValue(recipient)) + ' held.'
            );
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const confirmed = await blacksmith.dialog.confirm({
                title: 'Buy ' + context.item.name,
                classes: ['merchant-dialog'],
                content: '<p>' + recipient.name + ' buys '
                    + (amount > 1 ? amount + ' ' : '')
                    + '<strong>' + context.item.name + '</strong> for <strong>'
                    + formatBase(total) + '</strong>.</p>',
                confirmLabel: 'Buy',
                confirmIcon: 'fa-solid fa-coins'
            });
            if (!confirmed) return;
        }

        this._report(
            await this._send(
                { itemId, quantity: amount, recipientUuid: recipient.uuid },
                { row: itemId, label: 'Buying ' + context.item.name },
                'buy'
            ),
            recipient.name + ' bought ' + (amount > 1 ? amount + ' ' : '')
            + context.item.name + ' for ' + formatBase(total) + '.'
        );
    }

    /**
     * Sell something to the merchant.
     *
     * The inverse of buying, and the inverse of every other permission here: the
     * item has to be the seller's own, and the merchant has to be able to pay.
     */
    async sell() {
        const seller = this.recipient;
        if (!seller) {
            ui.notifications?.warn('You have no character able to sell.');
            return;
        }
        const token = await this._resolveToken();
        const merchant = token?.actor;
        const buyback = MerchantManager.getShelves(merchant, { includeHidden: true })
            .find(({ config }) => config.mode === 'buyback');
        if (!buyback) {
            ui.notifications?.warn('This merchant does not buy anything.');
            return;
        }

        const config = MerchantManager.getConfig(merchant);
        const sellable = seller.items.filter((item) => isPhysical(item.type)
            && resolveBuybackPrice(config, buyback.config, item) !== null);
        if (!sellable.length) {
            ui.notifications?.warn(seller.name + ' has nothing this merchant would buy.');
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.choose !== 'function') {
            ui.notifications?.warn('The Blacksmith dialog API is unavailable.');
            return;
        }

        const picked = await blacksmith.dialog.choose({
            title: 'Sell to the merchant',
            content: '<p>What is ' + seller.name + ' selling?</p>',
            classes: ['merchant-dialog'],
            choices: sellable.map((item) => ({
                id: item.id,
                label: item.name + ' \u2014 ' + formatBase(resolveBuybackPrice(config, buyback.config, item)),
                icon: 'fa-solid fa-hand-holding-dollar'
            }))
        });
        if (picked?.action !== 'submit' || !picked.value) return;

        const item = seller.items.get(picked.value);
        const available = Number(item?.system?.quantity ?? 1);
        const amount = await this._askQuantity(item?.name ?? 'item', Number.isFinite(available) ? available : 1);
        if (!amount) return;

        this._report(
            await this._send(
                { itemId: picked.value, quantity: amount, sellerUuid: seller.uuid },
                { label: 'Selling ' + item?.name },
                'sell'
            ),
            seller.name + ' sold ' + (amount > 1 ? amount + ' ' : '') + item?.name + '.'
        );
    }

    async acquire(itemId) {
        const recipient = this.recipient;
        if (!recipient) {
            ui.notifications?.warn('You have no character able to receive this.');
            return;
        }
        const context = await this._itemContext(itemId);
        if (!context) return;
        const amount = await this._askQuantity(context.item.name, ShopWindow.MAX_PER_ACQUISITION);
        if (!amount) return;
        this._report(
            await this._send({ itemId, quantity: amount, recipientUuid: recipient.uuid },
                { row: itemId, label: `Acquiring ${context.item.name}` }),
            `${recipient.name} acquired ${amount > 1 ? `${amount} ` : ''}${context.item.name}.`);
    }

    /** `ok: true, merged: false` is success — the item arrived as its own row. */
    _report(result, successMessage) {
        if (result?.ok) {
            if (successMessage) ui.notifications?.info(successMessage);
            return;
        }
        ui.notifications?.error(this._explain(result?.code, result));
    }

    _explain(code, result) {
        switch (code) {
            case 'INVENTORY_UNAVAILABLE': return 'The Blacksmith inventory API is not available.';
            case 'NO_ACTIVE_GM': return 'No GM is connected, so nothing can change hands.';
            case 'TIMEOUT': return 'The GM did not respond. If this keeps happening, the world may need a restart.';
            case 'NOT_A_MERCHANT': return 'This is no longer a shop.';
            case 'MERCHANT_NOT_FOUND': return 'That shop is no longer on the scene.';
            case 'ITEM_NOT_FOUND': return 'That is no longer in stock.';
            case 'ITEM_NOT_TRANSFERABLE': return 'That is not something you can carry off.';
            case 'NOT_FOR_SALE': return 'That is not for sale.';
            case 'SHOP_CLOSED': return 'The shop is closed. You can look, but nothing is changing hands.';
            case 'EXCHANGE_UNAVAILABLE': return 'Buying and selling are waiting on a Blacksmith update.';
            case 'CANNOT_AFFORD': return `You cannot afford that \u2014 ${formatBase(result?.price)} needed, ${formatBase(result?.held)} held.`;
            case 'MERCHANT_CANNOT_AFFORD': return `The merchant cannot cover that \u2014 ${formatBase(result?.price)} needed, ${formatBase(result?.held)} in the till.`;
            case 'NOT_PRICED': return 'That has no price set.';
            case 'BARTER_ONLY': return 'That one is a conversation, not a purchase.';
            case 'NO_BUYBACK_SHELF': return 'This merchant does not buy anything.';
            case 'NOT_YOUR_ITEM': return 'You can only sell your own possessions.';
            case 'NO_QUERY_PERMISSION': return 'You do not have permission to send requests to the GM.';
            case 'CONTAINER_HAS_CONTENTS': return Number.isFinite(result?.contentCount)
                ? `That container holds ${result.contentCount} item${result.contentCount === 1 ? '' : 's'} and cannot be sold as one.`
                : 'That container cannot be sold while it holds anything.';
            case 'RECIPIENT_NOT_ALLOWED': return 'That character cannot receive this.';
            case 'RECIPIENT_NOT_FOUND': return 'That character could not be found.';
            case 'INVALID_QUANTITY': return 'That is not a valid amount.';
            case 'LOCK_TIMEOUT': return 'That character is busy. Try again.';
            case 'TARGET_CREATE_FAILED': return 'That could not be added to the recipient.';
            default: return 'That could not be completed.';
        }
    }

    // ==============================================================
    // ===== RENDER =================================================
    // ==============================================================

    async getData() {
        // Registered once; the row markup is shared by both call sites so it cannot
        // drift between them.
        _partialsReady ??= foundry.applications.handlebars.loadTemplates([ROW_PARTIAL]);
        await _partialsReady;

        const token = await this._resolveToken();
        const merchant = token?.actor;
        const missing = !token || !merchant;

        const party = MerchantManager.getPartyActor();
        const options = this.recipients;
        const recipient = this.recipient;
        const config = missing ? null : MerchantManager.getConfig(merchant);
        const hours = missing ? null : MerchantManager.getHours(merchant);

        // One section per shelf. A GM sees hidden shelves too, marked as such; a
        // player is never sent their contents at all.
        let shelves = [];
        let itemCount = 0;
        if (!missing) {
            const busyRow = this._busy?.row ?? null;
            const isGM = game.user.isGM;

            // A closed shop is browsable but nothing changes hands. The GM is
            // exempt, so they can stock and test outside opening hours.
            const trading = MerchantManager.isOpen(merchant) || isGM;
            const config0 = MerchantManager.getConfig(merchant);
            // Buying needs the two-sided primitive. Until it ships the control is
            // absent rather than present-and-broken.
            const buying = hasExchange();

            shelves = MerchantManager.getShelves(merchant, { includeHidden: isGM }).map(({ item: shelf, config }) => {
                const isBarter = config.mode === 'barter';
                const contents = MerchantManager.getShelfContents(merchant, shelf).map((item) => {
                    const price = resolvePrice(config0, config, item);
                    return {
                    id: item.id,
                    type: item.type,
                    name: item.name,
                    img: item.img,
                    typeLabel: item.type?.charAt(0).toUpperCase() + item.type?.slice(1),
                    busy: item.id === busyRow,
                    price,
                    priceLabel: price === null ? null : formatBase(price),
                    // Unpriced on a sale shelf is a gap the GM should see, not a gift.
                    unpriced: price === null && !isBarter,
                    canBuy: trading && Boolean(recipient) && !isBarter && price !== null && buying,
                    isBarter
                };
                });
                itemCount += contents.length;

                // Grouped by kind within the shelf. A storefront with forty rows is
                // a wall of text otherwise.
                const categories = ITEM_CATEGORIES
                    .map((category) => ({
                        ...category,
                        items: contents.filter((item) => item.type === category.type)
                    }))
                    .filter((category) => category.items.length > 0);

                const known = new Set(ITEM_CATEGORIES.map((c) => c.type));
                const other = contents.filter((item) => !known.has(item.type));
                if (other.length) categories.push({ type: 'other', label: 'Other', icon: 'fa-solid fa-question', items: other });

                return {
                    id: shelf.id,
                    label: config.label || shelf.name,
                    img: shelf.img,
                    hidden: config.visible === false,
                    canToggle: isGM,
                    canStock: isGM,
                    isBarter,
                    categories,
                    count: contents.length,
                    hasItems: contents.length > 0
                };
            });
        }

        const cartLines = missing ? [] : await this._cartLines();
        const cartTotal = cartLines.reduce((sum, line) => sum + line.total, 0);

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            missing,
            shopName: config?.name || token?.name || 'Shop',
            portraitImg: merchant?.img ?? 'icons/svg/mystery-man.svg',
            shelves,
            hasShelves: shelves.length > 0,
            itemCount,
            isGM: game.user.isGM,
            isOpen: missing ? false : MerchantManager.isOpen(merchant),
            hoursLabel: hours ? `${formatHour(hours.open)} \u2013 ${formatHour(hours.close)}` : null,
            purseLabel: recipient ? formatBase(purseValue(recipient)) : null,
            cart: cartLines.map((line) => ({ ...line, totalLabel: formatBase(line.total) })),
            cartCount: cartLines.length,
            hasCart: cartLines.length > 0,
            cartTotalLabel: formatBase(cartTotal),
            canSell: !missing && hasExchange() && Boolean(recipient)
                && (MerchantManager.isOpen(merchant) || game.user.isGM)
                && MerchantManager.getShelves(merchant, { includeHidden: true }).some(({ config }) => config.mode === 'buyback'),
            // Shown so a GM is never puzzled by a shop that disagrees with its own
            // schedule; the next boundary will set it straight.
            overridden: !missing && game.user.isGM && MerchantManager.isOverridden(merchant),
            // A player looking at a closed shop is browsing, and should be told so
            // rather than left wondering why nothing works.
            browsing: !missing && !MerchantManager.isOpen(merchant) && !game.user.isGM,
            busyLabel: this._busy?.label ?? null,
            recipientName: recipient?.name ?? null,
            recipientImg: recipient?.img ?? 'icons/svg/mystery-man.svg',
            hasRecipient: Boolean(recipient),
            hasRecipientChoice: options.length > 1
        });

        return {
            appId: this.id,
            bodyContent,
            showToolFooter: true,
            toolFooterLeft: `
                <button type="button" class="blacksmith-window-btn-secondary" data-action="close">
                    <i class="fa-solid fa-check"></i> Done
                </button>`,
            toolFooterRight: ''
        };
    }

    /**
     * The shop claims left double-click on the token, which is how a GM would
     * normally reach the Actor sheet. These give that back rather than leaving the
     * GM to hunt for the actor in the sidebar. In micro-titlebar mode the base folds
     * them into the window's context menu automatically.
     */
    getToolHeaderActions() {
        // Refresh is for everyone. Nothing watches the merchant's items, so a GM
        // restocking a shelf does not push anything to a player already looking at
        // the shop.
        const actions = [{
            id: 'merchant-refresh',
            icon: 'fa-solid fa-rotate',
            label: 'Refresh',
            onClick: () => void this.render(false)
        }];

        if (!game.user.isGM) return actions;
        return [
            ...actions,
            {
                id: 'merchant-config',
                icon: 'fa-solid fa-sliders',
                label: 'Merchant Settings',
                onClick: () => void this.openConfig()
            },
            {
                id: 'merchant-sheet',
                icon: 'fa-solid fa-user',
                label: 'Character Sheet',
                onClick: () => void this.openSheet()
            },
            {
                id: 'merchant-prototype',
                icon: 'fa-solid fa-chess-pawn',
                label: 'Prototype Token',
                onClick: () => void this.openPrototypeToken()
            }
        ];
    }

    /**
     * Bring a shelf out front, or put it away, from the shop itself — which is where
     * a GM is standing when they decide to. The config window is for setting a shop
     * up; this is for running one.
     */
    async toggleShelf(shelfId) {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        const merchant = token?.actor;
        const config = MerchantManager.getShelfConfig(merchant?.items?.get(shelfId));
        if (!config) return;
        try {
            await MerchantManager.setShelfVisible(merchant, shelfId, config.visible === false);
            // Players with the shop open gain or lose a whole section, so tell them.
            MerchantManager._broadcastRefresh(this.tokenUuid);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not change that shelf:`, error);
            ui.notifications?.error('Could not change that shelf.');
        }
    }

    /**
     * Each shelf is a drop target, so a GM can drag stock straight onto the shelf it
     * belongs on — from a compendium, the sidebar, or another sheet.
     */
    _onRender(context, options) {
        super._onRender?.(context, options);
        if (!game.user.isGM) return;

        for (const zone of this.element?.querySelectorAll('[data-drop-shelf]') ?? []) {
            if (zone.dataset.merchantBound === 'true') continue;
            zone.dataset.merchantBound = 'true';
            const shelfId = zone.getAttribute('data-drop-shelf');

            zone.addEventListener('dragover', (event) => {
                event.preventDefault();
                zone.classList.add('is-dropping');
            });
            zone.addEventListener('dragleave', () => zone.classList.remove('is-dropping'));
            zone.addEventListener('drop', (event) => {
                event.preventDefault();
                zone.classList.remove('is-dropping');
                void this._onDropToShelf(event, shelfId);
            });
        }
    }

    async _onDropToShelf(event, shelfId) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}');
        } catch (_error) {
            return;
        }
        // Only Items, and only ones carrying a UUID — grantItem resolves from that.
        if (data?.type !== 'Item' || !data.uuid) return;

        const token = await this._resolveToken();
        const merchant = token?.actor;
        if (!merchant) return;

        try {
            const result = await MerchantManager.addToShelf(merchant, shelfId, data.uuid);
            if (result?.ok) MerchantManager._broadcastRefresh(this.tokenUuid);
            else ui.notifications?.error(this._explain(result?.code, result));
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that to the shelf:`, error);
            ui.notifications?.error('Could not add that to the shelf.');
        }
        await this.render(false);
    }

    async openConfig() {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        if (token?.actor) await MerchantConfigWindow.open(token.actor);
    }

    /**
     * Blacksmith's own compendium search, opened through the window registry.
     *
     * Merchant had its own for a day. Theirs is better — type filter, results
     * grouped by source, timing and a "more available" count — and its result rows
     * are draggable with a `{ type, uuid }` payload, which is exactly what the shelf
     * drop targets already read. So the search is theirs and the targeting is the
     * drag, and there is no second search to keep working.
     */
    async openCompendiumSearch() {
        if (!game.user.isGM) return;
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.openWindow !== 'function') {
            ui.notifications?.warn('Blacksmith compendium search is unavailable.');
            return;
        }
        await blacksmith.openWindow('blacksmith-compendium-search');
    }

    /** Open or close for business. A closed shop still opens for browsing. */
    async toggleOpen() {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        const merchant = token?.actor;
        if (!merchant) return;
        try {
            await MerchantManager.setOpen(merchant, !MerchantManager.isOpen(merchant));
            MerchantManager._broadcastRefresh(this.tokenUuid);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not change the shop state:`, error);
            ui.notifications?.error('Could not change the shop state.');
        }
    }

    async openSheet() {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        token?.actor?.sheet?.render(true, { token });
    }

    async openPrototypeToken() {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        const prototype = token?.actor?.prototypeToken;
        const sheetClass = CONFIG.Token?.prototypeSheetClass;
        // PrototypeToken is a DataModel with no `sheet` getter, so `prototype.sheet`
        // optional-chains into silence. This is how core opens it.
        if (!prototype || !sheetClass) {
            ui.notifications?.warn('This merchant has no prototype token.');
            return;
        }
        new sheetClass({ prototype }).render(true);
    }

    _onClose(options) {
        this.constructor._windows.delete(this.tokenUuid);
        super._onClose?.(options);
    }
}
