import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import { MODULE, ITEM_CATEGORIES, formatHour, shopKind, isAlwaysOpen } from './const.js';
import { resolvePrice, resolveBuybackPrice, formatBase, purseValue, planPayment } from './merchant-pricing.js';
import { hasExchange, isPhysical } from './merchant-inventory.js';
import { MerchantConfigWindow } from './window-merchant-config.js';
// Circular with manager-merchant.js by design: that module imports this one to open
// the window. Safe because every use below is inside a method, so the binding
// resolves at call time rather than at module evaluation.
import { MerchantManager } from './manager-merchant.js';

const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-shop.hbs';
const ROW_PARTIAL = 'modules/coffee-pub-merchant/templates/partial-shop-row.hbs';
const LINE_PARTIAL = 'modules/coffee-pub-merchant/templates/partial-slate-line.hbs';
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

    // tokenUuid -> Map(itemId -> quantity), for things being sold TO the merchant.
    // Same shape and same reasoning as the buying side; kept apart because this holds
    // the seller's own possessions and that holds the shop's.
    //
    // The two together are what the window calls the **slate**. Internally they stay
    // `cart` and `basket`: renaming fields to match a label is churn with no reader,
    // and "cart" is still the clearest word for what the code is doing.
    static _baskets = new Map();

    // tokenUuid -> Map(itemId -> quantity). Per client, so naturally per user.
    // Kept in memory rather than on a document: a cart is a half-formed intention,
    // and persisting one would mean deciding when somebody else's abandoned cart
    // expires. It survives closing the window within a session and no longer.
    static _carts = new Map();

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-shop-window'],
            // Wide enough for the stock and the slate side by side: 300 + 300 for the
            // two flex bases, plus the gap and the content padding. Narrower than this
            // and the slate wraps underneath, which is correct but is not the layout
            // the shop should open in.
            position: { width: 740, height: 600 },
            window: { title: 'Shop', resizable: true, minimizable: true },
            windowSizeConstraints: { minWidth: 380, minHeight: 320, maxWidth: 1040, maxHeight: 'calc(100vh - 40px)' },
            toolTitlebar: 'full',
            rememberPosition: false,
            windowPositionKey: 'merchant-shop'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        changeRecipient: (_event, _target, win) => win.changeRecipient(),

        toggleShelf: (_event, target, win) => void win.toggleShelf(target.dataset.shelfId),
        toggleOpen: (_event, _target, win) => void win.toggleOpen(),
        sell: (_event, _target, win) => win.run(() => win.sell()),
        addToCart: (_event, target, win) => void win.addToCart(target.dataset.itemId),
        removeFromCart: (_event, target, win) => void win.removeFromCart(target.dataset.itemId),
        clearAll: (_event, _target, win) => void win.clearAll(),
        settle: (_event, _target, win) => win.run(() => win.settle()),
        removeFromBasket: (_event, target, win) => void win.removeFromBasket(target.dataset.itemId),
        addToShelf: (_event, _target, win) => void win.openCompendiumSearch(),
        restockShelf: (_event, target, win) => void win.restockShelf(target.dataset.shelfId),
        removeStock: (_event, target, win) => void win.removeStock(target.dataset.itemId)
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

    async _send(payload, busy = {}, op = 'settle') {
        this._busy = { row: busy.row ?? null, label: busy.label ?? 'Working' };
        await this.render(false);
        try {
            return await MerchantManager.request(op, { tokenUuid: this.tokenUuid, ...payload });
        } finally {
            this._busy = null;
        }
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
     * On an infinite shelf that is the slider cap; on a finite one it is what is left
     * **after what the cart already holds**, so no dialog offers a quantity that would
     * make the eventual checkout fail.
     *
     * A soft reservation, and only yours: another player's cart is not visible here
     * and is not blocked. The GM re-checks every line at checkout, which is where a
     * genuine race is settled — this only stops you outbidding yourself.
     */
    _maxFor(merchant, item) {
        const stock = MerchantManager.getStock(merchant, item);
        if (stock.unlimited) return ShopWindow.MAX_PER_ACQUISITION;
        return Math.min(ShopWindow.MAX_PER_ACQUISITION, stock.available - (this.cart.get(item.id) ?? 0));
    }

    get cart() {
        if (!ShopWindow._carts.has(this.tokenUuid)) ShopWindow._carts.set(this.tokenUuid, new Map());
        return ShopWindow._carts.get(this.tokenUuid);
    }

    get basket() {
        if (!ShopWindow._baskets.has(this.tokenUuid)) ShopWindow._baskets.set(this.tokenUuid, new Map());
        return ShopWindow._baskets.get(this.tokenUuid);
    }

    /**
     * Add one, and let the slate line be edited from there.
     *
     * No quantity dialog. Curator's loot window settled this: the amount is a number
     * on the row you double-click, not a modal you answer before the thing exists.
     * Adding six of something is one click and one edit rather than a dialog every
     * time, and adding one — which is most of the time — is a single click with
     * nothing to dismiss.
     */
    async addToCart(itemId) {
        const context = await this._itemContext(itemId);
        if (!context) return;

        const inCart = this.cart.get(itemId) ?? 0;
        if (this._maxFor(context.token?.actor, context.item) < 1) {
            ui.notifications?.warn(inCart
                ? `Your slate already holds every ${context.item.name} in stock.`
                : `${context.item.name} is out of stock.`);
            return;
        }

        this.cart.set(itemId, inCart + 1);
        await this.render(false);
    }

    async removeFromCart(itemId) {
        this.cart.delete(itemId);
        await this.render(false);
    }

    /** One slate, so one thing wipes it. */
    async clearAll() {
        this.cart.clear();
        this.basket.clear();
        await this.render(false);
    }

    /**
     * Settle the visit: buy the cart, sell the basket, and move the difference.
     *
     * One press, because a counter transaction is one transaction. Trading a sword
     * towards a suit of armour is not a sale followed by a purchase — it is a swap
     * and a difference, and doing it as two means two lots of change, an order that
     * matters, and a purchase you cannot make until the sale has landed.
     *
     * **No destination is asked for.** Whoever you are shopping as pays and receives,
     * and the party is one of the things you can shop as — which is what "buy it for
     * the party" means, and removes the three-party transaction the primitive cannot
     * express along with the dialog that used to offer it.
     *
     * **And no confirmation.** The slate is the confirmation: every line, both
     * subtotals and the difference are on screen when the button is pressed, so a
     * dialog restating them is asking somebody to agree to what they are already
     * looking at. The affordability check below still runs first, because that is a
     * refusal rather than a question.
     */
    async settle() {
        const [cart, basket] = await Promise.all([this._cartLines(), this._basketLines()]);
        if (!cart.length && !basket.length) {
            ui.notifications?.info('There is nothing on the slate yet.');
            return;
        }

        const shopper = this.recipient;
        if (!shopper) {
            ui.notifications?.warn('You have no character able to trade.');
            return;
        }

        const spent = cart.reduce((sum, line) => sum + line.total, 0);
        const earned = basket.reduce((sum, line) => sum + line.total, 0);
        const net = spent - earned;

        // Checked here so a player learns they cannot cover it from the confirm rather
        // than from a refusal. The GM re-checks regardless.
        if (net > 0 && !planPayment(shopper, net)) {
            ui.notifications?.warn(
                `${shopper.name} cannot cover that \u2014 ${formatBase(net)} needed, `
                + `${purseValue(shopper) ? formatBase(purseValue(shopper)) : 'nothing'} held.`
            );
            return;
        }

        const result = await this._send(
            {
                buy: cart.map((line) => ({ itemId: line.id, quantity: line.quantity })),
                sell: basket.map((line) => ({ itemId: line.id, quantity: line.quantity })),
                shopperUuid: shopper.uuid
            },
            { label: 'Settling up' },
            'settle'
        );

        if (result?.ok) {
            this.cart.clear();
            this.basket.clear();
        }
        this._report(result, net > 0
            ? `${shopper.name} paid ${formatBase(net)}.`
            : net < 0
                ? `${shopper.name} received ${formatBase(-net)}.`
                : 'Traded evenly.');
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
     * The buyback shelf, or null when this merchant does not buy anything.
     *
     * That shelf existing *is* "this shop buys things"; there is no separate setting.
     */
    _buyback(merchant) {
        return MerchantManager.getShelves(merchant, { includeHidden: true })
            .find(({ config }) => config.mode === 'buyback') ?? null;
    }

    /** What the merchant would pay for this, or null if it would not take it. */
    _offerFor(merchant, buyback, item) {
        if (!item || !isPhysical(item.type)) return null;
        return resolveBuybackPrice(MerchantManager.getConfig(merchant), buyback.config, item);
    }

    /**
     * Pick something to sell from a list.
     *
     * The no-drag path to the same basket. Dragging between two windows is fiddly and
     * some people simply will not, so the button has to reach everything the drop zone
     * does rather than being a lesser version of it.
     */
    async sell() {
        const seller = this.recipient;
        if (!seller) {
            ui.notifications?.warn('You have no character able to sell.');
            return;
        }
        const token = await this._resolveToken();
        const merchant = token?.actor;
        const buyback = this._buyback(merchant);
        if (!buyback) {
            ui.notifications?.warn('This merchant does not buy anything.');
            return;
        }

        // What is already in the basket is spoken for, so an item wholly promised does
        // not appear again as though it were still on the shelf.
        const sellable = seller.items.filter((item) => {
            if (this._offerFor(merchant, buyback, item) === null) return null;
            const available = Number(item.system?.quantity ?? 1);
            const held = this.basket.get(item.id) ?? 0;
            return (Number.isFinite(available) ? available : 1) - held > 0;
        });
        if (!sellable.length) {
            ui.notifications?.warn(this.basket.size
                ? `Everything ${seller.name} can sell here is already in the basket.`
                : `${seller.name} has nothing this merchant would buy.`);
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.entityList?.create !== 'function' || typeof blacksmith?.dialog?.wait !== 'function') {
            ui.notifications?.warn('The Blacksmith entity list is unavailable.');
            return;
        }

        // A list rather than a grid of buttons. `dialog.choose` renders one button per
        // choice, which is fine for three destinations and unusable for a full
        // inventory — a hundred rows of wrapped text with no images and no scroll.
        //
        // Multi-select, because this fills a basket: picking a haul one item at a time
        // is one dialog per item, which is the thing the basket exists to avoid.
        const list = blacksmith.entityList.create({
            entities: sellable.map((item) => ({
                id: item.id,
                name: item.name,
                img: item.img,
                type: item.type?.charAt(0).toUpperCase() + item.type?.slice(1),
                badges: [{ label: formatBase(this._offerFor(merchant, buyback, item)) }]
            })),
            mode: 'multi',
            inputName: 'merchant-sell',
            listClass: 'merchant-sell-list'
        });

        let chosen = [];
        const outcome = await blacksmith.dialog.wait({
            title: `What is ${seller.name} selling?`,
            content: `<div class="blacksmith-field">${list.html}</div>`,
            classes: ['merchant-dialog', 'merchant-sell-dialog'],
            controls: list,
            buttons: [
                { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
                {
                    action: 'add',
                    label: 'Add to basket',
                    icon: 'fa-solid fa-hand-holding-dollar',
                    default: true,
                    callback: () => { chosen = list.getSelectedIds() ?? []; }
                }
            ],
            closeValue: null,
            cancelValue: null
        });
        list.destroy();
        if (outcome?.value !== 'add' || !chosen.length) return;

        // A stack asks how many; a single item does not, so picking twenty ordinary
        // things costs no prompts at all.
        for (const itemId of chosen) {
            await this.addToBasket(seller.items.get(itemId), { silent: true });
        }
        await this.render(false);
    }

    /**
     * Put something in the sell basket, asking how many.
     *
     * Shared by the picker and the drop zone, so a dragged item and a chosen one land
     * the same way and are refused for the same reasons.
     */
    async addToBasket(item, { silent = false } = {}) {
        const seller = this.recipient;
        const token = await this._resolveToken();
        const merchant = token?.actor;
        const buyback = merchant ? this._buyback(merchant) : null;
        if (!item || !seller || !buyback) return;

        if (item.parent?.uuid !== seller.uuid) {
            ui.notifications?.warn(`You are selling as ${seller.name}. That belongs to somebody else.`);
            return;
        }
        if (this._offerFor(merchant, buyback, item) === null) {
            ui.notifications?.warn(`This merchant would not take ${item.name}.`);
            return;
        }
        // Refused in front of the quantity dialog rather than after it: dnd5e keeps
        // containment on the child, so a packed container cannot change hands, and
        // `exchange` would refuse it anyway with a worse message.
        const packed = item.type === 'container'
            && (item.parent?.items?.filter((child) => child.system?.container === item.id).length ?? 0) > 0;
        if (packed) {
            ui.notifications?.warn(`Unpack ${item.name} first \u2014 a full container cannot change hands.`);
            return;
        }

        const held = this.basket.get(item.id) ?? 0;
        const available = Number(item.system?.quantity ?? 1);
        if ((Number.isFinite(available) ? available : 1) - held < 1) {
            ui.notifications?.warn(`Every ${item.name} you have is already on the slate.`);
            return;
        }

        this.basket.set(item.id, held + 1);
        // The picker adds several and renders once at the end; a drop adds one and
        // renders here.
        if (!silent) await this.render(false);
    }

    async removeFromBasket(itemId) {
        this.basket.delete(itemId);
        await this.render(false);
    }

    /** Basket lines resolved against what the seller still has, and current offers. */
    async _basketLines() {
        const seller = this.recipient;
        const token = await this._resolveToken();
        const merchant = token?.actor;
        const buyback = merchant ? this._buyback(merchant) : null;
        if (!seller || !buyback) return [];

        const lines = [];
        for (const [itemId, quantity] of this.basket) {
            const item = seller.items.get(itemId);
            // Sold, dropped, or belonging to a character you have since switched away
            // from: it simply leaves the basket.
            if (!item) {
                this.basket.delete(itemId);
                continue;
            }
            const unit = this._offerFor(merchant, buyback, item);
            if (unit === null) {
                this.basket.delete(itemId);
                continue;
            }

            const available = Number(item.system?.quantity ?? 1);
            const held = Math.min(quantity, Number.isFinite(available) ? available : 1);
            if (held < 1) {
                this.basket.delete(itemId);
                continue;
            }
            if (held !== quantity) this.basket.set(itemId, held);

            lines.push({ id: itemId, name: item.name, img: item.img, quantity: held, unit, total: unit * held });
        }
        return lines;
    }

    /** `ok: true, merged: false` is success — the item arrived as its own row. */
    _report(result, successMessage) {
        if (result?.ok) {
            if (successMessage) ui.notifications?.info(successMessage);
            return;
        }
        // No suffix about goods already handed over: a purchase is one `exchange`
        // now, so a failed payment moves nothing at all.
        const message = this._explain(result?.code, result);
        // LOCK_TIMEOUT is the only retryable code; every other one describes a state
        // that will not change by trying again, so only it says "try again".
        if (result?.code === 'SOURCE_UPDATE_FAILED' || result?.code === 'ROLLBACK_FAILED') {
            console.error(`${MODULE.TITLE} | ${result.code}:`, result);
        }
        ui.notifications?.error(message);
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
            case 'NOT_FOR_SALE': return result?.itemName
                ? `${result.itemName} is not for sale.`
                : 'That is not for sale.';
            case 'SHOP_CLOSED': return 'The shop is closed. You can look, but nothing is changing hands.';
            case 'EXCHANGE_UNAVAILABLE': return 'Buying and selling are waiting on a Blacksmith update.';
            case 'CANNOT_AFFORD': return `You cannot afford that \u2014 ${formatBase(result?.price)} needed, ${result?.held ? formatBase(result.held) : 'nothing'} held.`;
            // `formatBase` renders nothing as an em dash, which is right in a price
            // column and reads as a missing word in a sentence.
            case 'MERCHANT_CANNOT_AFFORD': return `The merchant cannot cover that \u2014 ${formatBase(result?.price)} needed, ${result?.held ? formatBase(result.held) : 'nothing'} in the till.`;
            case 'NOT_PRICED': return result?.itemName
                ? `${result.itemName} has no price set.`
                : 'That has no price set.';
            case 'NOTHING_TO_SETTLE': return 'There is nothing to settle.';
            case 'OUT_OF_STOCK': return result?.itemName
                ? `${result.itemName} is out of stock.`
                : 'That is out of stock.';
            case 'INSUFFICIENT_STOCK': return `Only ${result?.available ?? 0} left${result?.itemName ? ` of ${result.itemName}` : ''}.`;
            case 'INSUFFICIENT_QUANTITY': return `There are not that many left${result?.itemName ? ` of ${result.itemName}` : ''}.`;
            // Not the player's fault and not something they can work around: the
            // coins they hand over are chosen for them, smallest first. Say whose
            // problem it is.
            case 'NO_CHANGE': return `The merchant has not got the change for that — they owe ${formatBase(result?.changeBase)} back and the till cannot cover it.`;
            case 'INSUFFICIENT_CURRENCY': return 'Somebody is short of the coins that were meant to change hands, and nothing moved.';
            case 'INVALID_CURRENCY': return 'That payment did not add up. Nothing moved.';
            case 'SOURCE_ACTOR_NOT_FOUND':
            case 'TARGET_ACTOR_NOT_FOUND': return 'One side of that trade could not be found.';
            case 'SOURCE_ITEM_NOT_FOUND': return 'That is no longer where it was.';
            case 'SAME_ACTOR': return 'That would be trading with yourself.';
            case 'DUPLICATE_ITEM': return 'That item is on the slate twice. Wipe it and try again.';
            case 'EXCHANGE_EMPTY': return 'There was nothing to settle.';
            // The doc asks for these to be surfaced rather than swallowed: whether
            // the row was created or grown, and by how much, is what a GM needs to
            // repair the state by hand.
            case 'SOURCE_UPDATE_FAILED': return 'The stock could not be reduced, so the goods were put back.';
            case 'ROLLBACK_FAILED': return 'Something went wrong part-way and could not be undone. Tell your GM before doing anything else.';
            case 'CONTAINER_NOT_FOUND': return 'That shelf no longer exists.';
            case 'CONTAINER_MAX_DEPTH': return 'That container is nested too deeply.';
            case 'BARTER_ONLY': return result?.itemName
                ? `${result.itemName} is a conversation, not a purchase.`
                : 'That one is a conversation, not a purchase.';
            case 'NO_BUYBACK_SHELF': return 'This merchant does not buy anything.';
            case 'NOT_YOUR_ITEM': return 'You can only sell your own possessions.';
            case 'NO_QUERY_PERMISSION': return 'You do not have permission to send requests to the GM.';
            case 'CONTAINER_HAS_CONTENTS': return Number.isFinite(result?.contentCount)
                ? `That container holds ${result.contentCount} item${result.contentCount === 1 ? '' : 's'} and cannot be sold as one.`
                : 'That container cannot be sold while it holds anything.';
            case 'RECIPIENT_NOT_ALLOWED': return 'You cannot shop as that character.';
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
        _partialsReady ??= foundry.applications.handlebars.loadTemplates([ROW_PARTIAL, LINE_PARTIAL]);
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
        if (!missing) {
            const busyRow = this._busy?.row ?? null;
            const isGM = game.user.isGM;
            const cart = this.cart;

            // A closed shop is browsable but nothing changes hands. The GM is
            // exempt, so they can stock and test outside opening hours.
            const trading = MerchantManager.isOpen(merchant) || isGM;
            const config0 = MerchantManager.getConfig(merchant);

            shelves = MerchantManager.getShelves(merchant, { includeHidden: isGM }).map(({ item: shelf, config }) => {
                const isBarter = config.mode === 'barter';
                const contents = MerchantManager.getShelfContents(merchant, shelf).map((item) => {
                    const price = resolvePrice(config0, config, item);
                    const stock = MerchantManager.getStock(merchant, item, config);
                    // What the cart holds is spoken for, so the shelf shows what is
                    // still available to take rather than what is physically there.
                    const held = cart.get(item.id) ?? 0;
                    const left = stock.unlimited ? Infinity : Math.max(0, stock.available - held);
                    const out = left < 1;
                    // "None left" and "you have taken them all" are different sentences
                    // and a player needs to be able to tell them apart.
                    const allInCart = out && held > 0;
                    // Refused on the GM too; this is the honest path, not the guard.
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
                        qtyLabel: stock.unlimited ? '\u221e' : String(left),
                        qtyTooltip: stock.unlimited
                            ? 'Unlimited stock'
                            : (held
                                ? `${stock.available} in stock, ${held} on your slate`
                                : (out ? 'Out of stock' : `${stock.available} in stock, restocks to ${stock.par}`)),
                        outOfStock: out && !allInCart,
                        reserved: allInCart,
                        // A GM sets the count by hand here, and that also sets what a
                        // restocking shelf refills to.
                        canEditStock: isGM && !stock.unlimited,
                        // A disabled button with no reason on it is the thing
                        // players ask about, so the tooltip carries the reason.
                        // A disabled button with no reason on it is the thing
                        // players ask about, so the tooltip carries the reason.
                        cartTooltip: allInCart ? 'Every one of these is already on your slate'
                            : out ? 'Out of stock'
                            : !trading ? 'The shop is closed'
                            : !recipient ? 'You have no character able to buy'
                            : price === null ? 'This has no price set'
                            : 'Add to the slate',
                        canCart: trading && Boolean(recipient) && !isBarter && price !== null && inStock,
                        // Setting a quantity to zero says "sold out"; this says "we do
                        // not carry that". Different statements, so different controls.
                        canRemove: isGM,
                        isBarter
                    };
                });

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
                    label: shelf.name,
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
        const basketLines = missing ? [] : await this._basketLines();
        const basketTotal = basketLines.reduce((sum, line) => sum + line.total, 0);

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            missing,
            shopName: config?.name || token?.name || 'Shop',
            // The shopkeeper is only worth naming when the shop is not named after
            // them. "Bob" over a shop called Bob is a line of nothing.
            keeperName: token?.actor?.name ?? token?.name ?? '',
            hasKeeper: Boolean(config?.name)
                && String(config.name).trim() !== String(token?.actor?.name ?? '').trim(),
            // The kind replaces the word "Merchant" above the name, which was telling
            // the player something they could already see.
            kindLabel: shopKind(config?.kind).label,
            kindIcon: shopKind(config?.kind).icon,
            description: descriptionHtml,
            hasDescription: Boolean(descriptionHtml),
            portraitImg: merchant?.img ?? 'icons/svg/mystery-man.svg',
            shelves,
            hasShelves: shelves.length > 0,
            isGM: game.user.isGM,
            isOpen: missing ? false : MerchantManager.isOpen(merchant),
            // A shop open every hour has no hours worth printing; "midnight to
            // midnight" is a fact about the clock rather than about the shop.
            hoursLabel: hours && !isAlwaysOpen(hours)
                ? `${formatHour(hours.open)} \u2013 ${formatHour(hours.close)}`
                : null,
            purseLabel: recipient ? formatBase(purseValue(recipient)) : null,
            cart: cartLines.map((line) => ({
                ...line,
                totalLabel: formatBase(line.total),
                side: 'cart',
                removeAction: 'removeFromCart'
            })),
            cartCount: cartLines.length,
            hasCart: cartLines.length > 0,
            cartTotalLabel: formatBase(cartTotal),
            hasAnything: cartLines.length > 0 || basketLines.length > 0,
            // The running total, in the direction it actually runs. "You pay" and
            // "You receive" are different sentences and a shopper should not have to
            // work out which one a bare number is.
            // A total you are owed is written with a sign rather than a colour, so
            // the direction survives every theme and does not depend on seeing one.
            netTotalLabel: (cartTotal - basketTotal < 0 ? '+' : '')
                + formatBase(Math.abs(cartTotal - basketTotal)),
            basket: basketLines.map((line) => ({
                ...line,
                totalLabel: formatBase(line.total),
                side: 'basket',
                removeAction: 'removeFromBasket'
            })),
            basketCount: basketLines.length,
            hasBasket: basketLines.length > 0,
            basketTotalLabel: formatBase(basketTotal),
            // The buyback shelf existing is what "this shop buys things" means.
            canSell: !missing && Boolean(this._buyback(merchant)),
            sellTooltip: !recipient
                ? 'You have no character able to sell'
                : 'Choose something to sell',
            sellEnabled: !missing && Boolean(recipient)
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

        // The label follows the state: a cart outlives the moment it was filled, so
        // somebody returning to sell one thing must see "Trade" before they press it
        // rather than discovering it in the confirm.
        const hasAnything = cartLines.length > 0 || basketLines.length > 0;
        const net = cartTotal - basketTotal;
        const settleTooltip = !hasAnything ? 'Nothing on the slate yet'
            : net > 0 ? `You pay ${formatBase(net)}`
                : net < 0 ? `You receive ${formatBase(-net)}`
                    : 'An even trade';

        return {
            appId: this.id,
            bodyContent,
            showToolFooter: true,
            // "Cancel", not "Done": nothing has happened until the cart is settled, so
            // leaving is abandoning rather than finishing.
            toolFooterLeft: `
                <button type="button" class="blacksmith-window-btn-secondary" data-action="close">
                    <i class="fa-solid fa-xmark"></i> Cancel
                </button>`,
            // The main action, right-justified, with the thing that undoes it beside
            // it. Always present: a button that vanishes when the cart is empty makes
            // the empty state a puzzle, so it stays and says why instead.
            toolFooterRight: `
                <button type="button" class="blacksmith-window-btn-secondary merchant-shop-clear"
                        data-action="clearAll" ${hasAnything ? '' : 'disabled'}
                        data-tooltip="Take everything off the slate">
                    <i class="fa-solid fa-trash"></i> Clear Slate
                </button>
                <button type="button" class="blacksmith-window-btn-primary merchant-shop-settle"
                        data-action="settle" data-tooltip="${settleTooltip}">
                    <i class="fa-solid fa-scale-balanced"></i> Complete Transaction
                </button>`
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

        this._keepScroll();
        this._bindQuantityEdits();
        this._bindSearch();
        this._bindSellDrop();
        // Re-applied after every render, because a refresh, a GM stocking a shelf, or
        // another player's purchase all rebuild the list underneath a standing search.
        this._applyFilter();

        // Below here is GM-only. Quantity editing is bound for everyone, because a
        // slate line belongs to whoever is shopping; only the shop's own stock cells
        // carry `data-edit-stock`, and only a GM is given those.
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

    /**
     * Put each scrolling region back where it was.
     *
     * Adding something to the cart re-renders, which replaces the markup and takes
     * the scroll position with it — so a player who scrolled to the bottom of a long
     * shelf and pressed Add was thrown back to the top and had to find their place
     * again for every single item.
     *
     * Recorded on scroll rather than captured before each render, because a render
     * can be triggered from anywhere: a socket refresh, a GM restocking, another
     * player buying. There is no single place to hook a "before" on.
     */
    _keepScroll() {
        this._scroll ??= {};
        for (const [key, selector] of [['stock', '.merchant-shop-shelves'], ['cart', '.merchant-shop-cart-body']]) {
            const region = this.element?.querySelector(selector);
            if (!region) continue;

            const saved = this._scroll[key];
            // Clamped by the browser, so a list that shrank simply lands at its end.
            if (saved) region.scrollTop = saved;

            if (region.dataset.merchantBound === 'true') continue;
            region.dataset.merchantBound = 'true';
            region.addEventListener('scroll', () => { this._scroll[key] = region.scrollTop; }, { passive: true });
        }
    }

    /**
     * Double-click a quantity to change it in place.
     *
     * Curator's loot window, verbatim in behaviour: Enter or clicking away commits,
     * Escape abandons, and on a slate line 0 takes it off. Three cells use it — a
     * shop's stock, a line being bought, a line being sold — and they differ only in
     * what the committed number is written to.
     */
    _bindQuantityEdits() {
        for (const cell of this.element?.querySelectorAll('[data-edit-stock], [data-edit-line]') ?? []) {
            if (cell.dataset.merchantBound === 'true') continue;
            cell.dataset.merchantBound = 'true';
            cell.addEventListener('dblclick', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._beginQuantityEdit(cell);
            });
        }
    }

    _beginQuantityEdit(cell) {
        if (this.busy || cell.querySelector('input')) return;
        const value = cell.querySelector('strong');
        if (!value) return;

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.value = value.textContent.trim().replace(/[^0-9]/g, '') || '0';
        input.className = 'merchant-shop-qty-input';

        value.replaceWith(input);
        input.focus();
        input.select();

        let settled = false;
        const finish = async (commit) => {
            if (settled) return;
            settled = true;
            const next = Math.trunc(Number(input.value));
            input.replaceWith(value);
            if (commit && Number.isFinite(next) && next >= 0) await this._commitQuantity(cell, next);
            await this.render(false);
        };

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
            else if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
        });
        // Clicking away commits, matching the rest of the suite.
        input.addEventListener('blur', () => void finish(true));
    }

    async _commitQuantity(cell, next) {
        const lineId = cell.getAttribute('data-edit-line');
        if (lineId) {
            const map = cell.getAttribute('data-line-side') === 'basket' ? this.basket : this.cart;
            // Zero is how a line is removed, which is the same rule the loot window
            // uses and means the bin is a shortcut rather than the only way.
            if (next < 1) map.delete(lineId);
            else map.set(lineId, next);
            return;
        }

        const stockId = cell.getAttribute('data-edit-stock');
        if (!stockId) return;
        const token = await this._resolveToken();
        const merchant = token?.actor;
        if (!merchant) return;
        try {
            const result = await MerchantManager.setStockQuantity(merchant, stockId, next);
            // Silently correcting a number a GM typed is how you get somebody
            // re-typing it, so say what happened and where the limit lives.
            if (result?.clamped) {
                ui.notifications?.info(
                    `This shelf holds at most ${result.maxPerItem} of any one thing, so that is ${result.value}. `
                    + 'Raise the shelf’s "each" limit in Merchant Settings to keep more.'
                );
            }
            MerchantManager.broadcastActorRefresh(merchant);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set that quantity:`, error);
            ui.notifications?.error('Could not set that quantity.');
        }
    }

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

    /**
     * The whole cart accepts items dragged off a character sheet.
     *
     * The whole panel, not a sell sub-panel: an item a character is carrying can only
     * be sold, so the cart already knows which way a drop goes. Asking the user to aim
     * at the right half was asking them to state something the panel could work out.
     *
     * Not GM-only, unlike the shelf drop zones: selling is the one thing in this
     * window a player does with their own possessions. Foundry's drag payload carries
     * a uuid, so the item is resolved rather than reconstructed from the sheet it came
     * from — `fromUuid` already knows how to read `Actor.x.Item.y`.
     */
    _bindSellDrop() {
        const zone = this.element?.querySelector('[data-drop-sell]');
        if (!zone || zone.dataset.merchantBound === 'true') return;
        zone.dataset.merchantBound = 'true';

        zone.addEventListener('dragover', (event) => {
            event.preventDefault();
            zone.classList.add('is-dropping');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('is-dropping'));
        zone.addEventListener('drop', (event) => {
            event.preventDefault();
            zone.classList.remove('is-dropping');
            void this._onDropToSell(event);
        });
    }

    async _onDropToSell(event) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}');
        } catch (_error) {
            return;
        }
        if (data?.type !== 'Item' || !data.uuid) return;

        const item = await fromUuid(data.uuid);
        // A compendium or sidebar item has no owner to take it from. Only something
        // actually on a character can be sold.
        if (!item?.parent?.uuid) {
            ui.notifications?.warn('Only something a character is carrying can be sold.');
            return;
        }
        await this.addToBasket(item);
    }

    /**
     * Restock a shelf from the shop itself.
     *
     * The same act as the button in Merchant Settings, put where a GM already is when
     * they notice a shelf is bare. A press is deliberate, so every table on the shelf
     * rolls — the reroll flag governs the clock, not the button.
     */
    /**
     * Take something off a shelf for good.
     *
     * Not the same as setting it to zero: zero is a shop that has sold out of
     * something it carries, and a restocking shelf brings it back. This is the shelf
     * no longer carrying it.
     *
     * **No confirmation.** Putting something back on a shelf is a drag, so a prompt
     * here charges every removal for a mistake that costs seconds to undo — and a
     * dialog that always says yes is one people stop reading.
     *
     * A packed container is the exception, and it goes through dnd5e's own delete
     * prompt: that one asks whether the contents go too, which is a real question
     * with a wrong answer that orphans everything inside.
     */
    async removeStock(itemId) {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        const item = token?.actor?.items?.get(itemId);
        if (!item) return;

        const packed = item.type === 'container'
            && (token.actor.items.filter((child) => child.system?.container === item.id).length > 0);

        try {
            if (packed) await item.deleteDialog();
            else await item.delete();
            MerchantManager.broadcastActorRefresh(token.actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not remove ${item.name}:`, error);
        }
    }

    async restockShelf(shelfId) {
        const token = await this._resolveToken();
        const merchant = token?.actor;
        if (!merchant) return;
        try {
            const filled = await MerchantManager.restockShelf(merchant, shelfId, { force: true });
            ui.notifications?.info(filled
                ? `Restocked ${filled} item${filled === 1 ? '' : 's'}.`
                : 'Nothing to restock on that shelf.');
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not restock that shelf:`, error);
            ui.notifications?.error('Could not restock that shelf.');
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
