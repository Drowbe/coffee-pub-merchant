import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import { MODULE, ITEM_CATEGORIES, formatHour, shopKind } from './const.js';
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
 * Run a GM-written description through Foundry's enricher.
 *
 * So `@UUID[...]` links, inline rolls and the rest work in a shop description the
 * same way they do anywhere else — a shopkeeper's blurb linking the price list is
 * an obvious thing to want.
 *
 * Only ever GM-authored: it is written in a GM-only window and stored on the Actor.
 * Falling back to the raw string on failure would be an injection path, so a failed
 * enrich yields nothing rather than unescaped input.
 */
async function _enrich(text) {
    const value = String(text ?? '').trim();
    if (!value) return '';
    const ns = globalThis.foundry?.applications?.ux?.TextEditor;
    const TextEditorImpl = ns?.implementation ?? ns ?? globalThis.TextEditor;
    if (typeof TextEditorImpl?.enrichHTML !== 'function') return '';
    try {
        return String(await TextEditorImpl.enrichHTML(value, { async: true }));
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not enrich the shop description:`, error);
        return '';
    }
}

/**
 * Hide what does not match, and everything left holding nothing.
 *
 * Three levels, bottom up: a row matches or it does not; a category with no visible
 * row is a heading over nothing; a shelf with no visible category is a section over
 * nothing. Collapsing all three is what stops a search returning one potion under
 * five empty headings.
 *
 * Exported rather than kept as a method because it reads nothing but the markup and
 * the query — which is what makes it the one piece of the window that can be run
 * outside Foundry, and it is the piece most likely to be quietly wrong.
 *
 * @param {HTMLElement} root
 * @param {string} query
 * @returns {number} how many rows are visible
 */
export function filterShopList(root, query) {
    if (!root) return 0;
    const needle = (query ?? '').trim().toLowerCase();

    const clear = root.querySelector('[data-shop-search-clear]');
    if (clear) clear.hidden = !needle;

    let visibleTotal = 0;

    for (const shelf of root.querySelectorAll('.merchant-shop-shelf')) {
        let shelfVisible = 0;

        for (const category of shelf.querySelectorAll('.merchant-shop-category')) {
            let categoryVisible = 0;
            for (const row of category.querySelectorAll('.merchant-shop-item')) {
                const hit = !needle || (row.dataset.search ?? '').includes(needle);
                row.hidden = !hit;
                if (hit) categoryVisible++;
            }
            category.hidden = categoryVisible === 0;
            shelfVisible += categoryVisible;
        }

        // An empty shelf keeps its "nothing on this shelf" line when nobody is
        // searching, and gets out of the way when somebody is.
        const empty = shelf.querySelector('.merchant-shop-empty');
        if (empty) empty.hidden = Boolean(needle);

        shelf.hidden = Boolean(needle) && shelfVisible === 0;
        visibleTotal += shelfVisible;

        // The badge counts what is in front of you, and remembers the real total so
        // clearing the search puts it back.
        const count = shelf.querySelector('.merchant-shop-count');
        if (count) {
            count.dataset.total ??= count.textContent.trim();
            count.textContent = needle ? String(shelfVisible) : count.dataset.total;
        }
    }

    const none = root.querySelector('[data-shop-no-matches]');
    if (none) none.hidden = !needle || visibleTotal > 0;

    return visibleTotal;
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
        // Per window and not persisted: a search is a thing you are doing right now,
        // and reopening a shop to find yesterday's filter still hiding most of the
        // stock would be a puzzle.
        this._search = '';
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

        const list = blacksmith.entityList.create({
            entities: actors.map((actor) => ({ id: actor.uuid, uuid: actor.uuid, name: actor.name, img: actor.img })),
            mode: 'single',
            inputName: 'merchant-actor',
            selected: selectedUuid ?? actors[0].uuid
        });

        let chosen = null;
        const outcome = await blacksmith.dialog.wait({
            title,
            content: `<div class="blacksmith-field">${list.html}</div>`,
            classes: ['merchant-dialog'],
            // Bound after render by the dialog itself. Controls are not destroyed on
            // close, so the callback can still read the selection out of one.
            controls: list,
            // Secondary action left, primary right.
            buttons: [
                { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
                {
                    action: 'select',
                    label: confirmLabel,
                    icon: confirmIcon,
                    default: true,
                    callback: () => { chosen = list.getSelectedIds()?.[0] ?? null; }
                }
            ],
            closeValue: null,
            cancelValue: null
        });
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

        const control = blacksmith.quantitySplit.create({
            max,
            value: 1,
            inputName: 'merchant-quantity',
            giveLabel: 'Take',
            keepLabel: 'Leave',
            amountLabel: `How many ${label}?`
        });

        let chosen = null;
        const outcome = await blacksmith.dialog.wait({
            title: `Acquire ${label}`,
            content: `<div class="blacksmith-field">${control.html}</div>`,
            classes: ['merchant-dialog'],
            controls: control,
            buttons: [
                { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
                {
                    action: 'take',
                    label: 'Acquire',
                    icon: 'fa-solid fa-hand',
                    default: true,
                    // getValue() is integer-clamped and DOM-independent.
                    callback: () => { chosen = control.getValue(); }
                }
            ],
            closeValue: null,
            cancelValue: null
        });
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
     * The most anyone is asked to take at once when stock does not say otherwise.
     * Arbitrary, and there only to keep the slider usable.
     */
    static MAX_PER_ACQUISITION = 20;

    /**
     * How many of this a buyer may ask for.
     *
     * On an infinite shelf that is the slider cap; on a finite one it is what is
     * actually there, so the dialog cannot offer a quantity the GM will refuse.
     */
    _maxFor(merchant, item) {
        const stock = MerchantManager.getStock(merchant, item);
        if (stock.unlimited) return ShopWindow.MAX_PER_ACQUISITION;
        return Math.min(ShopWindow.MAX_PER_ACQUISITION, stock.available);
    }

    get cart() {
        if (!ShopWindow._carts.has(this.tokenUuid)) ShopWindow._carts.set(this.tokenUuid, new Map());
        return ShopWindow._carts.get(this.tokenUuid);
    }

    async addToCart(itemId) {
        const context = await this._itemContext(itemId);
        if (!context) return;

        // What is already in the cart is spoken for, so the dialog offers what is
        // left rather than the whole shelf twice over.
        const inCart = this.cart.get(itemId) ?? 0;
        const max = this._maxFor(context.token?.actor, context.item) - inCart;
        if (max < 1) {
            ui.notifications?.warn(inCart
                ? `Your cart already holds every ${context.item.name} in stock.`
                : `${context.item.name} is out of stock.`);
            return;
        }

        const amount = await this._askQuantity(context.item.name, max);
        if (!amount) return;
        this.cart.set(itemId, inCart + amount);
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

        const destination = await this._askDestination('Checkout', { paid: true });
        if (!destination) return;

        const total = lines.reduce((sum, line) => sum + line.total, 0);
        const payer = this.recipient;
        if (!payer) {
            ui.notifications?.warn('You have no character able to pay.');
            return;
        }
        const plan = planPayment(payer, total);
        if (!plan) {
            ui.notifications?.warn(
                'That comes to ' + formatBase(total) + ' and ' + payer.name
                + ' holds ' + formatBase(purseValue(payer)) + '.'
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
                    + '<p>' + payer.name + ' pays <strong>' + formatBase(total) + '</strong>'
                    + (destination.uuid === payer.uuid ? '' : ', delivered to ' + (destination.label ?? 'them'))
                    + '.</p>',
                confirmLabel: 'Pay',
                confirmIcon: 'fa-solid fa-coins'
            });
            if (!confirmed) return;
        }

        const result = await this._send(
            {
                items: lines.map((line) => ({ itemId: line.id, quantity: line.quantity })),
                recipientUuid: destination.uuid,
                payerUuid: payer.uuid
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

            // Stock sold out from under a standing cart trims the line rather than
            // failing the whole checkout. A line trimmed to nothing drops out.
            const stock = MerchantManager.getStock(merchant, item, MerchantManager.getShelfConfig(shelf));
            const held = stock.unlimited ? quantity : Math.min(quantity, stock.available);
            if (held < 1) {
                this.cart.delete(itemId);
                continue;
            }
            if (held !== quantity) this.cart.set(itemId, held);

            lines.push({
                id: itemId,
                name: item.name,
                img: item.img,
                quantity: held,
                trimmed: held !== quantity,
                unit,
                total: unit * held
            });
        }
        return lines;
    }

    /**
     * Who the goods are for: the acting character, another party member, or the
     * party itself. Asked once here rather than encoded in three icons per row.
     */
    async _askDestination(title, { paid = false } = {}) {
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
            content: '<p>Who is this for?</p>'
                // Paid delivery elsewhere is three-party \u2014 the shopper's coin, someone
                // else's goods \u2014 and `exchange` is two-sided. Said here rather than
                // discovered at the refusal.
                + (paid && (recipient || party)
                    ? '<p class="merchant-shop-hint">' + (recipient?.name ?? 'You') + ' pays either way.'
                        + ' Buying for someone else is waiting on a Blacksmith update.</p>'
                    : ''),
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
     * The shopper pays. Where the goods land is a separate question, asked once in
     * a dialog rather than encoded in three buttons, and buying for the party or
     * for another character is therefore a gift out of the shopper's own purse.
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

        const max = this._maxFor(merchant, context.item);
        if (max < 1) {
            ui.notifications?.warn(`${context.item.name} is out of stock.`);
            return;
        }
        const amount = await this._askQuantity(context.item.name, max);
        if (!amount) return;

        // Where the goods go is asked here rather than encoded in three icons.
        const destination = await this._askDestination('Buy ' + context.item.name, { paid: true });
        if (!destination) return;

        const total = unit * amount;
        // The shopper always pays, wherever the goods go. Buying for the party or for
        // another character is a gift, and a gift comes out of the giver's purse.
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
                content: '<p>' + recipient.name + ' pays <strong>' + formatBase(total) + '</strong> for '
                    + (amount > 1 ? amount + ' ' : '')
                    + '<strong>' + context.item.name + '</strong>'
                    + (destination.uuid === recipient.uuid ? '' : ', for ' + (destination.label ?? 'them'))
                    + '.</p>',
                confirmLabel: 'Buy',
                confirmIcon: 'fa-solid fa-coins'
            });
            if (!confirmed) return;
        }

        this._report(
            await this._send(
                {
                    itemId,
                    quantity: amount,
                    recipientUuid: destination.uuid,
                    payerUuid: recipient.uuid
                },
                { row: itemId, label: 'Buying ' + context.item.name },
                'buy'
            ),
            recipient.name + ' bought ' + (amount > 1 ? amount + ' ' : '')
            + context.item.name + ' for ' + formatBase(total)
            + (destination.uuid === recipient.uuid ? '' : ', for ' + (destination.label ?? 'them')) + '.'
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
        const max = this._maxFor(context.token?.actor, context.item);
        if (max < 1) {
            ui.notifications?.warn(`${context.item.name} is out of stock.`);
            return;
        }
        const amount = await this._askQuantity(context.item.name, max);
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
        // Goods first, coin second — so a payment that fails leaves the player
        // holding the item. Saying so is the difference between a puzzle and a
        // thing they can tell their GM about.
        const suffix = result?.delivered
            ? ' The goods were already handed over — tell your GM.'
            : '';
        ui.notifications?.error(this._explain(result?.code, result) + suffix);
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
            case 'OUT_OF_STOCK': return result?.itemName
                ? `${result.itemName} is out of stock.`
                : 'That is out of stock.';
            case 'INSUFFICIENT_STOCK': return `Only ${result?.available ?? 0} left${result?.itemName ? ` of ${result.itemName}` : ''}.`;
            case 'CONTAINER_NOT_FOUND': return 'That shelf no longer exists.';
            case 'CONTAINER_MAX_DEPTH': return 'That container is nested too deeply.';
            case 'THIRD_PARTY_DELIVERY': return 'Buying on behalf of someone else is waiting on a Blacksmith update.';
            case 'BARTER_ONLY': return 'That one is a conversation, not a purchase.';
            case 'NO_BUYBACK_SHELF': return 'This merchant does not buy anything.';
            case 'NOT_YOUR_ITEM': return 'You can only sell your own possessions.';
            case 'NO_PAYER': return 'Nobody was named to pay for that.';
            case 'NOT_YOUR_COIN': return 'You can only spend your own character\u2019s coin.';
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
                    const stock = MerchantManager.getStock(merchant, item, config);
                    const out = !stock.unlimited && stock.available < 1;
                    // Selling from an empty shelf is refused on the GM too; this is
                    // the honest path, not the guard.
                    const inStock = !out;

                    return {
                        id: item.id,
                        type: item.type,
                        name: item.name,
                        img: item.img,
                        typeLabel: item.type?.charAt(0).toUpperCase() + item.type?.slice(1),
                        // Name and kind both, so "potion" finds a Potion of Healing
                        // and "consumable" finds the whole category.
                        searchKey: `${item.name ?? ''} ${item.type ?? ''}`.toLowerCase(),
                        busy: item.id === busyRow,
                        price,
                        priceLabel: price === null ? null : formatBase(price),
                        // Unlimited reads as a symbol; anything else is a number in
                        // the same column, so the layout does not move between
                        // policies.
                        qtyLabel: stock.unlimited ? '\u221e' : String(stock.available),
                        qtyTooltip: stock.unlimited
                            ? 'Unlimited stock'
                            : (out ? 'Out of stock' : `${stock.available} in stock, restocks to ${stock.par}`),
                        outOfStock: out,
                        // A GM sets the count by hand here, and that also sets what a
                        // restocking shelf refills to.
                        canEditStock: isGM && !stock.unlimited,
                        stockValue: stock.unlimited ? null : stock.available,
                        // A disabled button with no reason on it is the thing
                        // players ask about, so the tooltip carries the reason.
                        buyTooltip: !buying ? 'Buying is waiting on a Blacksmith update'
                            : out ? 'Out of stock'
                            : !trading ? 'The shop is closed'
                            : !recipient ? 'You have no character able to buy'
                            : price === null ? 'This has no price set'
                            : 'Buy now',
                        cartTooltip: out ? 'Out of stock' : 'Add to cart',
                        canBuy: trading && Boolean(recipient) && !isBarter && price !== null && buying && inStock,
                        canCart: trading && Boolean(recipient) && !isBarter && price !== null && inStock,
                        // Stocking and testing should not require a purse.
                        canTakeFree: isGM && !isBarter,
                        takeFreeTooltip: out ? 'Out of stock' : 'Take without paying (GM)',
                        canTakeFreeNow: isGM && !isBarter && inStock,
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

        const descriptionHtml = missing ? '' : await _enrich(config?.description);
        const cartLines = missing ? [] : await this._cartLines();
        const cartTotal = cartLines.reduce((sum, line) => sum + line.total, 0);

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            missing,
            shopName: config?.name || token?.name || 'Shop',
            // The kind replaces the word "Merchant" above the name, which was telling
            // the player something they could already see.
            kindLabel: shopKind(config?.kind).label,
            kindIcon: shopKind(config?.kind).icon,
            description: descriptionHtml,
            hasDescription: Boolean(descriptionHtml),
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
            canSell: !missing && Boolean(recipient),
            sellTooltip: !hasExchange()
                ? 'Selling is waiting on a Blacksmith update'
                : 'Sell something to this merchant',
            sellEnabled: !missing && hasExchange() && Boolean(recipient)
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

        this._bindSearch();
        // Re-applied after every render, because a refresh, a GM stocking a shelf, or
        // another player's purchase all rebuild the list underneath a standing search.
        this._applyFilter();

        if (!game.user.isGM) return;

        // A number input rather than a data-action: the value is what matters, and
        // an action handler only knows that something was clicked.
        for (const input of this.element?.querySelectorAll('[data-stock-item]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';
            input.addEventListener('change', () => {
                void this._commitStock(input.getAttribute('data-stock-item'), input.value);
            });
            // Enter should commit and leave the field, not submit anything.
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.blur();
                }
            });
        }

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

    /**
     * A GM setting a count by hand.
     *
     * Written directly rather than through the request handler: this is the GM
     * curating their own shop, the same as showing or hiding a shelf. It also sets
     * what a restocking shelf refills to — see `setStockQuantity`.
     */
    async _commitStock(itemId, value) {
        const token = await this._resolveToken();
        const merchant = token?.actor;
        if (!merchant || !itemId) return;

        try {
            await MerchantManager.setStockQuantity(merchant, itemId, value);
            MerchantManager.broadcastActorRefresh(merchant);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set that quantity:`, error);
            ui.notifications?.error('Could not set that quantity.');
            await this.render(false);
        }
    }

    // ==============================================================
    // ===== SEARCH =================================================
    // ==============================================================
    //
    // Filtered in the DOM rather than in the context, and deliberately.
    //
    // Filtering in `getData` would mean a render per keystroke — which is async,
    // rebuilds the markup, and takes the caret out of the box the user is typing in.
    // So the query lives on the window, the filter is one pass over rendered rows, and
    // `_onRender` re-applies it. Typing never re-renders; a render never loses the
    // search.

    /** Bound once per element. Re-render replaces the node, hence the guard. */
    _bindSearch() {
        const input = this.element?.querySelector('[data-shop-search]');
        if (input && input.dataset.merchantBound !== 'true') {
            input.dataset.merchantBound = 'true';
            input.value = this._search ?? '';
            input.addEventListener('input', () => {
                this._search = input.value;
                this._applyFilter();
            });
            // A search box that cannot be escaped is a small trap.
            input.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                this._clearSearch();
            });
        }

        const clear = this.element?.querySelector('[data-shop-search-clear]');
        if (clear && clear.dataset.merchantBound !== 'true') {
            clear.dataset.merchantBound = 'true';
            clear.addEventListener('click', () => this._clearSearch());
        }
    }

    _clearSearch() {
        this._search = '';
        const input = this.element?.querySelector('[data-shop-search]');
        if (input) input.value = '';
        this._applyFilter();
        input?.focus();
    }

    /** One pass over the rendered list. See `filterShopList`. */
    _applyFilter() {
        if (this.element) filterShopList(this.element, this._search);
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
