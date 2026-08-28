import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import {
    MODULE, ITEM_CATEGORIES, formatHour, shopKind, isAlwaysOpen, isAlwaysClosed, isUnpriced, isPurchased,
    normalizeTint, itemRarity, rarityLabel, ABANDONED_IMG
} from './const.js';
import { hasPins, canPin, pinPalette, pinTaken, leavingQuantity } from './utility-pins.js';
import { abandonedLeavings } from './utility-compendium.js';
import { startProgress } from './utility-progress.js';
import {
    resolvePrice, resolvePurchasePrice, formatBase, purseValue, planSettlement, toBase, fromBase,
    negotiatedPrice, listPriceBase
} from './utility-pricing.js';
import { isPhysical } from './utility-inventory.js';
import { emit, SOCKET_EVENT } from './utility-sockets.js';
import { resolveReputation, reputationLabel } from './utility-reputation.js';
import { marketRate, marketShortLabel } from './utility-market.js';
import { MerchantConfigWindow } from './window-merchant-config.js';
// Circular with manager-merchant.js by design: that module imports this one to open
// the window. Safe because every use below is inside a method, so the binding
// resolves at call time rather than at module evaluation.
import { MerchantManager } from './manager-merchant.js';
import { notify, playFeedback, SOUND } from './utility-feedback.js';

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
 * row is a heading over nothing; an inventory with no visible category is a section over
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

    for (const inventory of root.querySelectorAll('.merchant-shop-inventory')) {
        let inventoryVisible = 0;

        for (const category of inventory.querySelectorAll('.merchant-shop-category')) {
            let categoryVisible = 0;
            for (const row of category.querySelectorAll('.merchant-shop-item')) {
                const hit = !needle || (row.dataset.search ?? '').includes(needle);
                row.hidden = !hit;
                if (hit) categoryVisible++;
            }
            category.hidden = categoryVisible === 0;
            inventoryVisible += categoryVisible;
        }

        // An empty inventory keeps its "nothing on this inventory" line when nobody is
        // searching, and gets out of the way when somebody is.
        const empty = inventory.querySelector('.merchant-shop-empty');
        if (empty) empty.hidden = Boolean(needle);

        // A folded shelf with a match opens for as long as the search lasts. The fold
        // itself is untouched: clearing the box puts it straight back, because somebody
        // chose it and a search is not a decision about layout.
        inventory.classList.toggle('is-search-open', Boolean(needle) && inventoryVisible > 0);

        inventory.hidden = Boolean(needle) && inventoryVisible === 0;
        visibleTotal += inventoryVisible;

        // The badge counts what is in front of you, and remembers the real total so
        // clearing the search puts it back.
        const count = inventory.querySelector('.merchant-shop-count');
        if (count) {
            count.dataset.total ??= count.textContent.trim();
            count.textContent = needle ? String(inventoryVisible) : count.dataset.total;
        }
    }

    const none = root.querySelector('[data-shop-no-matches]');
    if (none) none.hidden = !needle || visibleTotal > 0;

    return visibleTotal;
}

/**
 * Which inventories are folded shut, per shop.
 *
 * Module level rather than per window: the shop is one window reopened, and a section a
 * GM folded away should still be folded when they come back to the same counter. Keyed
 * by token, so two shops do not share one answer.
 */
const _collapsed = new Map();

/**
 * A stored image path, as a URL a stylesheet can actually fetch.
 *
 * **A relative `url()` in CSS resolves against the stylesheet, not the document.** The
 * path travels into `--merchant-shop-illustration` and is substituted into a rule living
 * in `styles/window-shop.css`, so `modules/x/y.webp` was requested as
 * `modules/coffee-pub-merchant/styles/modules/x/y.webp` — a 404 with nothing in it to
 * suggest the cause, since the path a GM typed was correct and the file was there.
 *
 * `getRoute` rather than a bare leading slash: a Foundry served under a route prefix
 * needs that prefix, and hard-coding `/` breaks exactly the installs least able to debug
 * it. An absolute URL or an already-rooted path is left alone — a GM may reasonably
 * point at either.
 */
function illustrationUrl(stored) {
    const path = String(stored ?? '').trim();
    if (!path) return null;
    if (/^(?:https?:)?\/\//i.test(path)) return path;
    if (typeof foundry?.utils?.getRoute === 'function') return foundry.utils.getRoute(path);
    return path.startsWith('/') ? path : `/${path}`;
}

/**
 * **The base class comes from the bridge, which is the supported path.**
 *
 * `api/blacksmith-api.js` re-exports both window bases precisely so a subclass can
 * `extends` one at module scope. It is a real ESM module, so it resolves at
 * evaluation, when `game` does not yet exist.
 *
 * The obvious-looking alternative does not work and is worth knowing about: resolving
 * the class from `module.api` at module top level throws, because module scripts are
 * evaluated before `game` — and ESM caches a failed evaluation, so the throw kills
 * the module for the whole session rather than being retried. `api-window.md` used to
 * recommend exactly that; Merchant broke a live world on it, Blacksmith fixed the doc
 * and added the re-exports on 2026-08-19, and this is the result.
 */
export class ShopWindow extends BlacksmithToolWindowBaseV2 {
    // One window per token, and the registry behind that, are the base class's:
    // `openFor`, `openWindowFor`, `openWindows`, `closeFor`, keyed by uuid. Ours
    // deleted its map entry only in `_onClose`, so a window whose first render threw
    // was never entered and never left — and every later open re-rendered the same
    // broken instance, which is a shop that cannot be reopened until the page is
    // reloaded. Theirs deletes the entry when a render throws.

    // shopKey -> Map(itemId -> quantity), for things being sold TO the merchant.
    // Same shape and same reasoning as the buying side; kept apart because this holds
    // the seller's own possessions and that holds the shop's.
    //
    // The two together are what the window calls the **slate**. Internally they stay
    // `cart` and `basket`: renaming fields to match a label is churn with no reader,
    // and "cart" is still the clearest word for what the code is doing.
    static _baskets = new Map();

    // `shopKey|shopperUuid` -> Map(itemId -> quantity).
    //
    // **Keyed by the character, not by the client**, and mirrored to every client that
    // can act as that character. A slate belongs to whoever is shopping: switching
    // "Buying as" switches slate, and a GM switching to a player's character sees the
    // slate that player is actually looking at, live, with everything on it editable.
    //
    // That is not a nicety. Prices are negotiated *on slate lines* by the GM, and
    // before this the GM could not see a player's slate at all -- so the entire
    // negotiate workflow only worked if the GM did the shopping, which is not what it
    // is for.
    //
    // Still **in memory, still not persisted**. A slate is a half-formed intention and
    // persisting one means deciding when an abandoned one expires; a session-scoped
    // mirror expires by itself. Permission needs no special handling either: the only
    // characters you can switch to are the ones you can act as, so a player sees their
    // own slates and a GM sees everyone's, for free.
    static _carts = new Map();

    // `shopKey|shopperUuid` -> the last snapshot this client sent or received.
    // Set on both, which is what stops two clients bouncing the same slate back and
    // forth: a slate that arrives is already "published" as far as we are concerned.
    static _published = new Map();

    // shopKey -> Map(userId -> { actorUuid, name, img }). Who is standing in this
    // shop, as seen by everybody.
    //
    // **Separate from the slates, and it has to be.** A slate is keyed by character and
    // mirrored only to clients that can act as that character — which is right for the
    // slate and useless for this: a player would see an empty room, because the only
    // characters they can act as are their own. Presence is about the *room*, so it
    // goes to everyone, and only what you may do with a face is gated.
    //
    // Peer to peer, for Curator's reason: nothing authoritative hangs off it, and
    // routing it through the GM would make an absent GM look like an empty shop.
    static _presence = new Map();

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-shop-window'],
            // Wide enough for the stock and the slate side by side: 300 + 300 for the
            // two flex bases, plus the gap and the content padding. Narrower than this
            // and the slate wraps underneath, which is correct but is not the layout
            // the shop should open in.
            position: { width: 740, height: 600 },
            window: { title: 'Merchant', resizable: true, minimizable: true },
            windowSizeConstraints: { minWidth: 380, minHeight: 320, maxWidth: 1040, maxHeight: 'calc(100vh - 40px)' },
            toolTitlebar: 'full',
            // On, with a key shared by every shop. A shop is a shop wherever it is
            // opened, so where you last dragged one is where the next should appear,
            // at the size you last gave it.
            //
            // `api-window.md` recommends `false` for multi-instance tools because
            // siblings sharing a key overwrite each other's position — which is the
            // documented cost here, and the right trade: two shops open at once is
            // rare and one drag apart, while every shop resetting is every time.
            rememberPosition: true,
            windowPositionKey: 'merchant-shop'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        changeRecipient: (_event, _target, win) => win.changeRecipient(),

        toggleInventory: (_event, target, win) => void win.toggleInventory(target.dataset.inventoryId),
        collapseInventory: (_event, target, win) => win.collapseInventory(target.dataset.inventoryId),
        toggleOpen: (_event, _target, win) => void win.toggleOpen(),
        showBuy: (_event, _target, win) => win.showSide(false),
        showSell: (_event, _target, win) => win.showSide(true),
        sortSell: (_event, _target, win) => win.cycleSellSort(),
        sortStock: (_event, _target, win) => win.cycleStockSort(),
        addToCart: (_event, target, win) => void win.addToCart(target.dataset.itemId),
        addToBasketRow: (_event, target, win) => void win.addToBasketRow(target.dataset.itemId),
        removeFromCart: (_event, target, win) => void win.removeFromCart(target.dataset.itemId),
        clearAll: (_event, _target, win) => void win.clearAll(),
        removePin: (_event, _target, win) => void win.removePin(),
        steal: (_event, target, win) => void win.steal(target.dataset.itemUuid),
        settle: (_event, _target, win) => win.run(() => win.settle()),
        removeFromBasket: (_event, target, win) => void win.removeFromBasket(target.dataset.itemId),
        addToInventory: (_event, _target, win) => void win.openCompendiumSearch(),
        switchTo: (_event, target, win) => win.setRecipient(target.dataset.actorUuid),
        restockInventory: (_event, target, win) => void win.restockInventory(target.dataset.inventoryId),
        clearInventory: (_event, target, win) => void win.clearInventory(target.dataset.inventoryId),
        mergeInventory: (_event, target, win) => void win.mergeInventory(target.dataset.inventoryId),
        removeStock: (_event, target, win) => void win.removeStock(target.dataset.itemId)
    };

    /**
     * **A shop is opened for a *subject*, and a subject is not always a token.**
     *
     * A linked merchant is keyed by its **Actor**; an unlinked one by its **token**. The
     * base class keys the registry on `target.uuid`, so passing one or the other is the
     * whole mechanism -- and it is what makes a pin, a linked token, and a second linked
     * token of the same Actor one window with one cart rather than three of each.
     *
     * The scene is carried separately because it cannot be derived from an Actor, and two
     * things that set the final price are scene-scoped: the market rate on the Scene flag
     * and the party's standing here. A token knows its own scene; a pin passes one.
     */
    constructor(subject, options = {}) {
        const opts = foundry.utils.mergeObject({}, options);
        opts.id ||= `merchant-shop-${subject.id}-${foundry.utils.randomID()}`;
        opts.position = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, ShopWindow.DEFAULT_OPTIONS.position ?? {}),
            opts.position || {}
        );
        opts.window = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, ShopWindow.DEFAULT_OPTIONS.window ?? {}),
            opts.window || {}
        );
        super(opts);
        this.shopKey = subject.uuid;
        // A TokenDocument's parent is its Scene. An Actor's is not, so a subject that is
        // an Actor is told where it is standing instead.
        this.sceneUuid = subject.parent?.documentName === 'Scene'
            ? subject.parent.uuid
            : (options.sceneUuid ?? null);
        // **What to call a shop whose Actor has gone.** A pin outlives the merchant it
        // names, and it knows what the place was called; the window has nothing else left
        // to read a name from. Absent, the abandoned card says so in general terms.
        this.shopName = options.shopName ?? null;
        // The pin this was opened from, when it was. Only an abandoned shop uses it: it is
        // the one window with nothing else to act on, and the pin is the only thing left.
        this.pinId = options.pinId ?? null;
        // What the shop looked like, as the pin remembers it. Only an abandoned shop reads
        // this: a shop that still exists answers for itself, and would rather.
        this.remembered = options.remembered ?? null;
        this.busy = false;
        // Per window and not persisted: a search is a thing you are doing right now,
        // and reopening a shop to find yesterday's filter still hiding most of the
        // stock would be a puzzle.
        this._search = '';
    }

    static refreshForToken(shopKey) {
        // `keyFor` takes a plain string as readily as a document, which is what lets
        // a socket message carrying only a uuid find its window.
        void this.openWindowFor(shopKey)?.render(false);
    }

    /**
     * Refresh every open shop for one merchant, wherever its tokens are.
     *
     * Inventory changes are Actor-level, and a merchant can have tokens on several
     * scenes, so keying the refresh on a single token would miss the others.
     */
    static async refreshForActor(actorUuid) {
        for (const win of this.openWindows()) {
            // A linked shop is keyed by the Actor already; an unlinked one has to be
            // resolved to find out whose it is.
            if (win.shopKey === actorUuid) { void win.render(false); continue; }
            const { actor } = await win._resolveSubject();
            if (actor?.uuid === actorUuid) void win.render(false);
        }
    }

    /**
     * Who this window is a shop for: the Actor, the token if there is one, and the scene.
     *
     * **The token may be null and the Actor may not.** A shop opened from a pin has no
     * token at all -- a stall in a market square is nobody's token -- so everything that
     * used to read `token.actor` reads `actor`, and everything that used to read
     * `token.parent` reads `scene`.
     *
     * The scene falls back to the one being looked at. That is only reached by a subject
     * with no stored scene, and answering "the market you are standing in" beats answering
     * "no market" for a shop that is plainly on a map.
     */
    async _resolveSubject() {
        const subject = await fromUuid(this.shopKey);
        const token = subject?.documentName === 'Token' ? subject : null;
        const actor = token ? token.actor : (subject?.documentName === 'Actor' ? subject : null);
        const scene = token?.parent
            ?? (this.sceneUuid ? await fromUuid(this.sceneUuid) : null)
            ?? canvas?.scene
            ?? null;
        return { actor, token, scene };
    }

    /**
     * The party's standing here, as a multiplier, resolved **once per render**.
     *
     * The band comes from an async fetch and a price list is a hundred rows, so
     * looking it up per price would be a promise per row and a list that resolved in
     * a different order than it drew. Held on the window and read synchronously by
     * everything that prices anything.
     *
     * The token's scene, not the viewer's: reputation is per scene, and a GM looking
     * at another map must not see different prices from the players standing in the
     * shop.
     */
    async _refreshReputation() {
        const { actor, scene } = await this._resolveSubject();
        const config = MerchantManager.getConfig(actor);
        this._reputation = await resolveReputation(scene, config?.pricing?.reputation);
        // Synchronous — a market is a number on the Scene, with no scale to fetch —
        // but resolved here so both place-multipliers are settled in one step and
        // every price in the render sees the same pair.
        this._market = marketRate(scene);

        // Said in the shop, in the party's own terms: the band they stand in, and what
        // it is doing to the bill. A neutral standing says nothing rather than "0%",
        // which would be a line that never changes and never matters.
        const enabled = Boolean(config?.pricing?.reputation);
        const band = enabled ? await reputationLabel(scene, true) : null;
        if (!enabled || this._reputation === 1) {
            this._reputationLine = null;
            this._reputationTooltip = null;
            this._reputationBand = null;
            this._reputationEffect = null;
        } else {
            const percent = Math.round(Math.abs(1 - this._reputation) * 100);
            const effect = this._reputation < 1 ? `${percent}% benefit` : `${percent}% penalty`;
            // Written as a sentence rather than a label and a value. It is a fact
            // about this party in this place, and a fact reads as prose; "Known ·
            // 3% benefit" is a row in a table about something else.
            this._reputationBand = band;
            this._reputationEffect = effect;
            this._reputationLine = band ? `${band} · ${effect}` : effect;
            this._reputationTooltip = this._reputation < 1
                ? game.i18n.localize('coffee-pub-merchant.reputation.good')
                : game.i18n.localize('coffee-pub-merchant.reputation.bad');
        }
        return this._reputation;
    }

    /** The last resolved multiplier. 1 until the first render says otherwise. */
    get reputation() {
        return this._reputation ?? 1;
    }

    /** What goods are worth where this shop stands. */
    get market() {
        return this._market ?? 1;
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

    setRecipient(picked) {
        const uuid = (typeof picked === 'string' ? picked : (picked?.uuid ?? picked?.id)) || null;
        if (!uuid) return;
        this._recipientUuid = uuid;
        _lastRecipientUuid = uuid;
        // The room is looking at a face that has just changed. Without this everybody
        // else keeps seeing whoever you were shopping as a moment ago.
        this.publishPresence();
        void this.render(false);
    }

    /**
     * Switch which character is shopping.
     *
     * **`blacksmith.dialog.pickActor`, not our own.** Merchant and Curator had written
     * the same thirty-five lines -- an entity list in a dialog, read back on confirm --
     * and it is the hub's now. The search field, the avatars and the keyboard behaviour
     * are the ones every other Blacksmith list has, and improvements there arrive here
     * without a change.
     *
     * `null` covers every non-answer: cancelled, dismissed, or nothing to choose from.
     * Branching on it rather than on a thrown error is their stated contract.
     *
     * **Two things went missing in the move**, both asked for upstream and neither
     * fatal. The picker used to open with the *current* character selected rather than
     * the first in the list, and it used to badge anyone with lines already on a slate
     * -- which is how a GM learns somebody is mid-purchase before it occurs to them to
     * switch and look. `entityList` still supports badges; `pickActor` does not forward
     * them yet. If they land, this passes `selected` and `badges` and nothing else changes.
     */
    async changeRecipient() {
        const options = this.recipients;
        if (!options.length) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.shop.noShopper'));
            return;
        }
        if (options.length < 2) {
            notify.info(game.i18n.format('coffee-pub-merchant.shop.onlyShopper', { name: options[0].name }));
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.pickActor !== 'function') {
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.pickerUnavailable'));
            return;
        }

        const picked = await blacksmith.dialog.pickActor({
            title: 'Buying As',
            actors: options,
            confirmLabel: 'Select',
            confirmIcon: 'fa-solid fa-user-check',
            emptyMessage: game.i18n.localize('coffee-pub-merchant.shop.noShopper')
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
            notify.error(game.i18n.localize('coffee-pub-merchant.refuse.notCompleted'));
        } finally {
            this.busy = false;
            this.element?.classList.remove('merchant-shop-busy');
            if (this.constructor.openWindowFor(this.shopKey) === this) await this.render(false);
        }
    }

    /**
     * Ask the GM to settle. There is one operation, so there is no `op` to pass.
     *
     * **No caller id in the payload.** The envelope resolves the User from the
     * authenticated socket and hands it to the handler; anything we put here about who
     * is asking would be a claim, not an identity.
     */
    async _send(payload, busy = {}) {
        this._busy = { row: busy.row ?? null, label: busy.label ?? 'Working' };
        await this.render(false);
        try {
            return await MerchantManager.request({
                shopKey: this.shopKey,
                // **A claim the GM verifies, not a fact.** The market rate is a Scene flag
                // and it moves prices, so a client naming its own scene could name a
                // profitable one. A token subject needs none of this -- its scene is
                // whichever one it stands on -- and for an Actor subject the handler
                // accepts this only if the merchant is actually there.
                sceneUuid: this.sceneUuid,
                ...payload
            });
        } finally {
            this._busy = null;
        }
    }

    async _itemContext(itemId) {
        const { actor } = await this._resolveSubject();
        const item = actor?.items?.get(itemId);
        if (!item) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.refuse.outOfStockNow'));
            return null;
        }
        return { item, actor };
    }

    /**
     * The most anyone is asked to take at once when stock does not say otherwise.
     * Arbitrary, and there only to keep the slider usable.
     */
    static MAX_PER_ACQUISITION = 20;

    /**
     * How many of this a buyer may ask for.
     *
     * On an infinite inventory that is the slider cap; on a finite one it is what is left
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

    /**
     * How the shop's own stock is ordered, **within each category**.
     *
     * Two, not the sell side's three: a category *is* the grouping, so a "by kind" order
     * would be a second answer to a question the layout has already given. Name first,
     * because that is how somebody looks for a thing they came in for; price second, for
     * the other question anybody asks a shopkeeper.
     */
    static STOCK_SORTS = [
        {
            key: 'name', icon: 'fa-solid fa-arrow-down-a-z',
            labelKey: 'coffee-pub-merchant.sort.name'
        },
        {
            key: 'price', icon: 'fa-solid fa-arrow-down-9-1',
            labelKey: 'coffee-pub-merchant.sort.value'
        }
    ];

    get stockSort() {
        return ShopWindow.STOCK_SORTS.find((s) => s.key === this._stockSort) ?? ShopWindow.STOCK_SORTS[0];
    }

    cycleStockSort() {
        const order = ShopWindow.STOCK_SORTS;
        const at = order.findIndex((s) => s.key === this.stockSort.key);
        this._stockSort = order[(at + 1) % order.length].key;
        void this.render(false);
    }

    /**
     * How the pack is ordered, and what the button says it will do next.
     *
     * Three orders because three questions get asked of an inventory: what is worth
     * most, where is the thing I can name, and what have I got of a kind. A cycle
     * rather than a dropdown -- three options do not earn a menu, and the icon can
     * carry the current state on its own.
     */
    static SELL_SORTS = [
        {
            key: 'price', icon: 'fa-solid fa-arrow-down-9-1',
            labelKey: 'coffee-pub-merchant.sort.value', grouped: false
        },
        {
            key: 'name', icon: 'fa-solid fa-arrow-down-a-z',
            labelKey: 'coffee-pub-merchant.sort.name', grouped: false
        },
        {
            key: 'category', icon: 'fa-solid fa-layer-group',
            labelKey: 'coffee-pub-merchant.sort.category', grouped: true
        }
    ];

    get sellSort() {
        return ShopWindow.SELL_SORTS.find((s) => s.key === this._sellSort) ?? ShopWindow.SELL_SORTS[0];
    }

    /**
     * Show the shop's stock, or your own pack. One column, two sides of a counter.
     *
     * Set rather than toggled: the buttons say which side you are on, so pressing the
     * one already lit should do nothing rather than flip you to the other.
     */
    showSide(selling) {
        if (this._selling === selling) return;
        this._selling = selling;
        void this.render(false);
    }

    cycleSellSort() {
        const order = ShopWindow.SELL_SORTS;
        const at = order.findIndex((s) => s.key === this.sellSort.key);
        this._sellSort = order[(at + 1) % order.length].key;
        void this.render(false);
    }

    /**
     * The seller's own goods, as shop rows.
     *
     * Deliberately the *same* row partial the inventories use: a thing you are selling and
     * a thing you are buying are both a picture, a name, a price and a way to put it on
     * the slate, and giving them two layouts would be inventing a difference that is
     * not there. `addAction` is the only thing that changes.
     */
    _sellContext(merchant) {
        const seller = this.recipient;
        const buyback = merchant ? this._purchasedInventory(merchant) : null;
        const sort = this.sellSort;

        if (!this._selling) return { open: false };
        if (!seller || !buyback) {
            return {
                open: true,
                title: seller ? game.i18n.format('coffee-pub-merchant.sell.packOf', { name: seller.name }) : game.i18n.localize('coffee-pub-merchant.sell.yourPack'),
                count: 0,
                hasItems: false,
                search: this._sellSearch ?? '',
                sortIcon: sort.icon,
                sortTooltip: game.i18n.format('coffee-pub-merchant.sort.tooltip', { how: game.i18n.localize(sort.labelKey) }),
                emptyMessage: buyback ? game.i18n.localize('coffee-pub-merchant.sell.noSeller') : game.i18n.localize('coffee-pub-merchant.sell.merchantBuysNothing')
            };
        }

        const query = (this._sellSearch ?? '').trim().toLowerCase();
        const rows = seller.items
            .filter((item) => this._wouldTake(item))
            .map((item) => {
                const offer = this._offerFor(merchant, buyback, item);
                const held = Math.max(0, Math.trunc(Number(item.system?.quantity ?? 1)));
                const promised = this.basket.get(item.id) ?? 0;
                const left = held - promised;
                return {
                    id: item.id,
                    type: item.type,
                    name: item.name,
                    img: item.img,
                    typeLabel: item.type?.charAt(0).toUpperCase() + item.type?.slice(1),
                    rarity: rarityLabel(itemRarity(item)),
                    rarityKey: itemRarity(item),
                    searchKey: `${item.name ?? ''} ${item.type ?? ''} ${itemRarity(item) ?? ''}`.toLowerCase(),
                    offer: offer ?? -1,
                    // A negotiate-inventory price is not published, and neither is an offer
                    // for something nobody has priced yet. TBD says the same thing here.
                    // A shop that pays nothing says so in words. "0 gp" reads as a
                    // rounding failure; "Nothing" reads as an answer.
                    priceLabel: offer === null ? null : (offer === 0 ? 'Nothing' : formatBase(offer)),
                    isUnpricedInventory: offer === null,
                    negotiateTooltip: null,
                    // Whose item this is. Two Actors put rows through the same partial
                    // and nothing else in the markup tells them apart, so the hover
                    // card and the GM's click-to-open both looked the wrong one up.
                    owner: 'shopper',
                    // What the shop offers is arithmetic on what the thing is worth,
                    // not a figure anyone types. Setting it here would be editing the
                    // shopper's own item on the shop's screen.
                    canPrice: false,
                    qtyLabel: String(left),
                    qtyTooltip: promised
                        ? game.i18n.format('coffee-pub-merchant.sell.carriedPromised', { held, promised })
                        : `${held} carried`,
                    outOfStock: left < 1,
                    reserved: left < 1 && promised > 0,
                    canCart: left > 0,
                    canEditStock: false,
                    canRemove: false,
                    addAction: 'addToBasketRow',
                    cartTooltip: left > 0
                        ? game.i18n.localize('coffee-pub-merchant.sell.addTooltip')
                        : game.i18n.localize('coffee-pub-merchant.sell.allOnSlate')
                };
            })
            .filter((row) => !query || row.searchKey.includes(query));

        rows.sort((a, b) => {
            if (sort.key === 'price') return b.offer - a.offer || a.name.localeCompare(b.name);
            if (sort.key === 'category') {
                return (a.typeLabel ?? '').localeCompare(b.typeLabel ?? '') || a.name.localeCompare(b.name);
            }
            return a.name.localeCompare(b.name);
        });

        // Grouped or not, the template walks groups — one unlabelled group is a flat
        // list, which keeps a single shape rather than two.
        const groups = [];
        if (sort.grouped) {
            for (const row of rows) {
                const category = ITEM_CATEGORIES.find((c) => c.type === row.type);
                const label = category?.label ?? row.typeLabel ?? 'Other';
                let group = groups.find((g) => g.label === label);
                if (!group) {
                    group = { label, icon: category?.icon ?? 'fa-solid fa-box', items: [] };
                    groups.push(group);
                }
                group.items.push(row);
            }
        } else if (rows.length) {
            groups.push({ label: null, icon: null, items: rows });
        }

        return {
            open: true,
            title: game.i18n.format('coffee-pub-merchant.sell.packOf', { name: seller.name }),
            count: rows.length,
            hasItems: rows.length > 0,
            groups,
            search: this._sellSearch ?? '',
            sortIcon: sort.icon,
            sortTooltip: game.i18n.format('coffee-pub-merchant.sort.tooltip', { how: game.i18n.localize(sort.labelKey) }),
            emptyMessage: query
                ? game.i18n.localize('coffee-pub-merchant.sell.noMatches')
                : game.i18n.format('coffee-pub-merchant.sell.nothingWanted', { name: seller.name })
        };
    }

    /** Add one from the pack. The row already knows it is the selling side. */
    async addToBasketRow(itemId) {
        const item = this.recipient?.items?.get(itemId);
        if (item) await this.addToBasket(item);
    }

    /**
     * Everyone else standing in this shop, for the faces on the bar.
     *
     * **From presence, not from the slates.** Drawing them from slates looked right and
     * was wrong for the person it mattered most to: slates are mirrored only to clients
     * that can act as that character, so a player saw an empty room however busy the
     * shop was. A shop with three people in it should look like one to all three.
     *
     * Everyone *sees* every face. Only a face you could act as is a button — in
     * practice the GM's, which is the point: they see who is mid-purchase and take the
     * slate over. For everybody else it is a portrait saying who else is here.
     */
    _otherShoppers() {
        const room = ShopWindow._presence.get(this.shopKey);
        if (!room?.size) return [];

        const faces = [];
        for (const [userId, entry] of room) {
            // Only yourself is left out. Somebody shopping as the character you happen
            // to be viewing as still gets a face -- they are a *person in the shop*,
            // and they are the one a GM most wants to see. The portrait beside
            // "Buying as" is your own view of that character, not a claim about who
            // else is standing there.
            if (userId === game.user.id) continue;

            const lines = entry.actorUuid ? this._slateSizeFor(entry.actorUuid) : 0;
            const actor = entry.actorUuid ? this.recipients.find((a) => a.uuid === entry.actorUuid) : null;
            faces.push({
                uuid: entry.actorUuid,
                name: entry.name,
                img: entry.img || 'icons/svg/mystery-man.svg',
                lines,
                // Switchable only if this client could act as them anyway. The check is
                // the same one the "Buying as" list is built from, so a face can never
                // offer something the picker would refuse.
                canSwitch: Boolean(actor),
                tooltip: [
                    entry.userName && entry.userName !== entry.name
                        ? `${entry.userName}, as ${entry.name}`
                        : entry.name,
                    lines ? game.i18n.format('coffee-pub-merchant.slate.linesBadge', { count: lines }) : 'browsing',
                    actor ? game.i18n.localize('coffee-pub-merchant.slate.takeOver') : null
                ].filter(Boolean).join(' — ')
            });
        }
        return faces;
    }

    /** How many lines that character has on the slate in *this* shop, mine or theirs. */
    _slateSizeFor(shopperUuid) {
        const key = `${this.shopKey}|${shopperUuid}`;
        return (ShopWindow._carts.get(key)?.size ?? 0) + (ShopWindow._baskets.get(key)?.size ?? 0);
    }

    /** One shop, one character. Switching who you are shopping as switches slate. */
    get slateKey() {
        return `${this.shopKey}|${this.recipient?.uuid ?? 'nobody'}`;
    }

    get cart() {
        const key = this.slateKey;
        if (!ShopWindow._carts.has(key)) ShopWindow._carts.set(key, new Map());
        return ShopWindow._carts.get(key);
    }

    get basket() {
        const key = this.slateKey;
        if (!ShopWindow._baskets.has(key)) ShopWindow._baskets.set(key, new Map());
        return ShopWindow._baskets.get(key);
    }

    /**
     * Publish this slate if it has changed since the last thing sent or received.
     *
     * Called from `_onRender`, which is the one place every slate change passes
     * through -- there are sixteen mutation sites and a rule that says "remember to
     * broadcast" at each of them is a rule that gets forgotten once. Comparing
     * snapshots also makes it idempotent, so rendering for an unrelated reason costs
     * nothing.
     */
    _syncSlate() {
        const key = this.slateKey;
        const snapshot = JSON.stringify([[...this.cart], [...this.basket]]);
        if (ShopWindow._published.get(key) === snapshot) return;
        ShopWindow._published.set(key, snapshot);
        this._publishSlate();
    }

    /**
     * Tell every other client what this slate now holds.
     *
     * Sent after the change rather than as a request to make one: the slate is not
     * authoritative over anything -- settling re-derives every line and every price on
     * the GM -- so the worst a bad message can do is show somebody a wrong list.
     *
     * Last write wins. Two people driving one character's slate at the same moment is a
     * conversation to have at the table, not a conflict to resolve in code.
     */
    _publishSlate() {
        const [shopKey, shopperUuid] = this.slateKey.split('|');
        emit(SOCKET_EVENT.SLATE, {
            shopKey,
            shopperUuid,
            cart: [...this.cart],
            basket: [...this.basket]
        });
    }

    /** What this client is showing, for the room to see. */
    _selfPresence() {
        const actor = this.recipient;
        return {
            actorUuid: actor?.uuid ?? null,
            // Both, because a face answers two questions: who is here, and who are
            // they shopping as. Two people can be on the same character, and the
            // character name alone would make them one face saying nothing.
            userName: game.user.name,
            name: actor?.name ?? game.user.name,
            img: actor?.img ?? game.user.avatar ?? 'icons/svg/mystery-man.svg'
        };
    }

    /** Say who we are and who we are shopping as. Sent again whenever either changes. */
    publishPresence() {
        const self = this._selfPresence();
        ShopWindow._setPresence(this.shopKey, game.user.id, self);
        emit(SOCKET_EVENT.PRESENCE, {
            state: 'open', shopKey: this.shopKey, userId: game.user.id, ...self
        });
    }

    /**
     * Announce, and ask anyone already here to announce back.
     *
     * The ping is only for arriving: a window opening late otherwise shows an empty
     * shop until somebody else happens to do something. Switching character republishes
     * without pinging, or one person changing who they are shopping as would make
     * everybody in the room shout.
     */
    announcePresence() {
        this.publishPresence();
        emit(SOCKET_EVENT.PRESENCE, {
            state: 'ping', shopKey: this.shopKey, userId: game.user.id
        });
    }

    clearPresence() {
        ShopWindow._presence.get(this.shopKey)?.delete(game.user.id);
        emit(SOCKET_EVENT.PRESENCE, {
            state: 'close', shopKey: this.shopKey, userId: game.user.id
        });
    }

    static _setPresence(shopKey, userId, entry) {
        if (!ShopWindow._presence.has(shopKey)) ShopWindow._presence.set(shopKey, new Map());
        ShopWindow._presence.get(shopKey).set(userId, entry);
    }

    /** Apply a presence message and redraw anyone looking at that shop. */
    static receivePresence({ state, shopKey, userId, actorUuid, userName, name, img } = {}) {
        if (!shopKey || !userId || userId === game.user.id) return;

        if (state === 'close') {
            ShopWindow._presence.get(shopKey)?.delete(userId);
        } else if (state === 'ping') {
            // Somebody just arrived and cannot see the room. Say we are here.
            for (const window of ShopWindow.openWindows()) {
                if (window.shopKey === shopKey) {
                    const self = window._selfPresence();
                    emit(SOCKET_EVENT.PRESENCE, {
                        state: 'open', shopKey, userId: game.user.id, ...self
                    });
                }
            }
            return;
        } else {
            ShopWindow._setPresence(shopKey, userId, { actorUuid, userName, name, img });
        }

        for (const window of ShopWindow.openWindows()) {
            if (window.shopKey === shopKey) void window.render(false);
        }
    }

    /** Drop a departing user's face rather than leaving a ghost in the room. */
    static dropUser(userId) {
        for (const [shopKey, room] of ShopWindow._presence) {
            if (!room.delete(userId)) continue;
            for (const window of ShopWindow.openWindows()) {
                if (window.shopKey === shopKey) void window.render(false);
            }
        }
    }

    /**
     * Ask everyone already in this shop to say what is on their slate.
     *
     * A window opening late otherwise sees an empty room until somebody happens to add
     * something. Curator's loot presence does the same thing for the same reason, and
     * for the same reason it is peer to peer rather than GM-brokered: nothing
     * authoritative hangs off a slate, and routing it through the GM would make an
     * absent GM look like nobody is shopping.
     */
    _requestSlates() {
        emit(SOCKET_EVENT.SLATE_REQUEST, {
            shopKey: this.shopKey,
            userId: game.user.id
        });
    }

    /** Answer a `slateRequest` with every slate this client is actually driving. */
    static publishSlatesFor(shopKey) {
        for (const window of ShopWindow.openWindows()) {
            if (window.shopKey === shopKey) window._publishSlate();
        }
    }

    /** Apply a slate published elsewhere, and redraw anyone looking at it. */
    static receiveSlate({ shopKey, shopperUuid, cart = [], basket = [] } = {}) {
        if (!shopKey || !shopperUuid) return;
        const key = `${shopKey}|${shopperUuid}`;
        ShopWindow._carts.set(key, new Map(cart));
        ShopWindow._baskets.set(key, new Map(basket));
        // Recorded as published, so receiving a slate never bounces it back.
        ShopWindow._published.set(key, JSON.stringify([cart, basket]));

        for (const window of ShopWindow.openWindows()) {
            if (window.slateKey === key) void window.render(false);
        }
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
        playFeedback(SOUND.SLATE_ADD);
        const context = await this._itemContext(itemId);
        if (!context) return;

        const inCart = this.cart.get(itemId) ?? 0;
        if (this._maxFor(context.actor, context.item) < 1) {
            notify.warn(inCart
                ? game.i18n.format('coffee-pub-merchant.cart.allInStock', { item: context.item.name })
                : game.i18n.format('coffee-pub-merchant.cart.itemOutOfStock', { item: context.item.name }));
            return;
        }

        this.cart.set(itemId, inCart + 1);
        await this.render(false);
    }

    async removeFromCart(itemId) {
        playFeedback(SOUND.SLATE_CLEAR);
        this.cart.delete(itemId);
        await this.render(false);
    }

    /** One slate, so one thing wipes it. */
    async clearAll() {
        playFeedback(SOUND.SLATE_CLEAR);
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
        // The slate was priced at the last render, and reputation can have moved
        // since. Cheap — the band is cached — and it keeps the affordability check
        // below arguing about the same numbers the GM is about to.
        await this._refreshReputation();
        const [cart, basket] = await Promise.all([this._cartLines(), this._basketLines()]);
        if (!cart.length && !basket.length) {
            notify.info(game.i18n.localize('coffee-pub-merchant.slate.empty'));
            return;
        }

        const shopper = this.recipient;
        if (!shopper) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.refuse.noTrader'));
            return;
        }

        const unagreed = [...cart, ...basket].filter((line) => line.total === null);
        if (unagreed.length) {
            notify.warn(
                game.i18n.localize('coffee-pub-merchant.refuse.unnegotiated')
            );
            return;
        }

        const spent = cart.reduce((sum, line) => sum + line.total, 0);
        const earned = basket.reduce((sum, line) => sum + line.total, 0);
        const net = spent - earned;

        // Checked here so a player learns they cannot cover it from the confirm rather
        // than from a refusal. The GM re-checks regardless.
        if (net > 0 && !planSettlement(shopper.system?.currency ?? {}, net)) {
            notify.warn(
                game.i18n.format('coffee-pub-merchant.refuse.shopperCannotCover', {
                    name: shopper.name,
                    needed: formatBase(net),
                    held: purseValue(shopper)
                        ? formatBase(purseValue(shopper))
                        : game.i18n.localize('coffee-pub-merchant.common.nothing')
                })
            );
            return;
        }

        const result = await this._send(
            {
                buy: cart.map((line) => ({ itemId: line.id, quantity: line.quantity })),
                sell: basket.map((line) => ({ itemId: line.id, quantity: line.quantity })),
                shopperUuid: shopper.uuid
            },
            { label: game.i18n.localize('coffee-pub-merchant.progress.settlingUp') }
        );

        if (result?.ok) {
            this.cart.clear();
            this.basket.clear();

            // A receipt rather than a notice. What was paid is the headline, because it
            // is the number somebody wants to check; what moved is the detail under it.
            //
            // The shop is re-resolved rather than captured: `settle` never held one, and
            // reaching for a name is not a reason to start assuming it did.
            const { actor: shop } = await this._resolveSubject();
            const shopName = MerchantManager.getConfig(shop)?.name || shop?.name || 'the shop';
            const moved = [
                cart.length ? `${cart.length} bought` : null,
                basket.length ? `${basket.length} sold` : null
            ].filter(Boolean).join(', ');

            notify.receipt(
                net > 0 ? `Paid ${formatBase(net)}`
                    : net < 0 ? `Received ${formatBase(-net)}`
                        : game.i18n.localize('coffee-pub-merchant.receipt.evenTrade'),
                `${shopper.name} at ${shopName}`
                + (moved ? ` — ${moved}` : '')
            );
            return;
        }
        this._report(result, null);
    }

    /** Cart lines resolved against current stock and prices. */
    async _cartLines() {
        const { actor: merchant } = await this._resolveSubject();
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
            const inventory = MerchantManager.getInventoryFor(merchant, item);
            // An unpriced line stays, showing as not yet agreed. Dropping it would
            // make adding something from a negotiate inventory look like nothing
            // happened, which is the opposite of asking about it.
            const unit = resolvePrice(config, MerchantManager.getInventoryConfig(inventory), item,
                { reputation: this.reputation, market: this.market, shopper: this.recipient?.uuid });

            // Stock sold out from under a standing cart trims the line rather than
            // failing the whole checkout. A line trimmed to nothing drops out.
            const stock = MerchantManager.getStock(merchant, item, MerchantManager.getInventoryConfig(inventory));
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
                total: unit === null ? null : unit * held
            });
        }
        return lines;
    }

    /**
     * The buyback inventory, or null when this merchant does not buy anything.
     *
     * That inventory existing *is* "this shop buys things"; there is no separate setting.
     */
    _purchasedInventory(merchant) {
        return MerchantManager.getInventories(merchant, { includeHidden: true })
            .find(({ config }) => isPurchased(config.type)) ?? null;
    }

    /**
     * What a GM needs to know when the price column says only "negotiate".
     *
     * Two different facts, and which is missing changes what the GM should do. An
     * agreed price is a decision already taken and worth repeating back. A book price
     * is an anchor to haggle against. Neither is a thing to show a player: the whole
     * point of the inventory is that the number is not published.
     */
    _negotiateHint(merchantConfig, item, agreedPrice) {
        // The agreement with **whoever is shopping right now**, which is the only one this
        // row is about: switching character switches the hint with it.
        const agreed = negotiatedPrice(merchantConfig, item?.id, this.recipient?.uuid);
        if (agreed !== null) return game.i18n.format('coffee-pub-merchant.price.agreedGm', { price: formatBase(agreed) });

        const price = item?.system?.price;
        const listed = Number.isFinite(Number(price?.value))
            ? toBase(Number(price.value), price.denomination ?? 'gp')
            : null;
        if (listed) return game.i18n.format('coffee-pub-merchant.price.worthGm', { price: formatBase(listed) });
        return game.i18n.localize('coffee-pub-merchant.price.noneAgreedGm');
    }

    /** What the merchant would pay for this, or null if no price has been agreed. */
    _offerFor(merchant, buyback, item) {
        if (!this._wouldTake(item)) return null;
        return resolvePurchasePrice(MerchantManager.getConfig(merchant), buyback.config, item,
            { reputation: this.reputation, market: this.market, shopper: this.recipient?.uuid });
    }

    /**
     * Whether this is the sort of thing that can change hands at all.
     *
     * Separate from what it fetches, because those are different refusals. A spell is
     * not goods and never will be; a curio with no price in any book is goods whose
     * price has not been named yet, and naming it is what the slate is for.
     */
    _wouldTake(item) {
        return Boolean(item) && isPhysical(item.type);
    }

    /**
     * Put something in the sell basket, asking how many.
     *
     * Shared by the picker and the drop zone, so a dragged item and a chosen one land
     * the same way and are refused for the same reasons.
     */
    async addToBasket(item) {
        playFeedback(SOUND.SLATE_ADD);
        const seller = this.recipient;
        const { actor: merchant } = await this._resolveSubject();
        const buyback = merchant ? this._purchasedInventory(merchant) : null;
        if (!item || !seller || !buyback) return;

        if (item.parent?.uuid !== seller.uuid) {
            notify.warn(game.i18n.format('coffee-pub-merchant.refuse.notYours', { name: seller.name }));
            return;
        }
        if (!this._wouldTake(item)) {
            notify.warn(game.i18n.format('coffee-pub-merchant.refuse.wouldNotTake', { item: item.name }));
            return;
        }
        // Refused in front of the quantity dialog rather than after it: dnd5e keeps
        // containment on the child, so a packed container cannot change hands, and
        // `exchange` would refuse it anyway with a worse message.
        const packed = item.type === 'container'
            && (item.parent?.items?.filter((child) => child.system?.container === item.id).length ?? 0) > 0;
        if (packed) {
            notify.warn(game.i18n.format('coffee-pub-merchant.refuse.unpackFirst', { item: item.name }));
            return;
        }

        const held = this.basket.get(item.id) ?? 0;
        const available = Number(item.system?.quantity ?? 1);
        if ((Number.isFinite(available) ? available : 1) - held < 1) {
            notify.warn(game.i18n.format('coffee-pub-merchant.refuse.everyOneOnSlate', { item: item.name }));
            return;
        }

        this.basket.set(item.id, held + 1);
        await this.render(false);
    }

    async removeFromBasket(itemId) {
        playFeedback(SOUND.SLATE_CLEAR);
        this.basket.delete(itemId);
        await this.render(false);
    }

    /** Basket lines resolved against what the seller still has, and current offers. */
    async _basketLines() {
        const seller = this.recipient;
        const { actor: merchant } = await this._resolveSubject();
        const buyback = merchant ? this._purchasedInventory(merchant) : null;
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

            const available = Number(item.system?.quantity ?? 1);
            const held = Math.min(quantity, Number.isFinite(available) ? available : 1);
            if (held < 1) {
                this.basket.delete(itemId);
                continue;
            }
            if (held !== quantity) this.basket.set(itemId, held);

            lines.push({
                id: itemId,
                name: item.name,
                img: item.img,
                quantity: held,
                unit,
                total: unit === null ? null : unit * held
            });
        }
        return lines;
    }

    /** `ok: true, merged: false` is success — the item arrived as its own row. */
    _report(result, successMessage) {
        if (result?.ok) {
            if (successMessage) notify.info(successMessage);
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
        notify.error(message);
    }

    _explain(code, result) {
        switch (code) {
            case 'INVENTORY_UNAVAILABLE': return game.i18n.localize('coffee-pub-merchant.refuse.inventoryUnavailable');
            case 'NO_ACTIVE_GM': return game.i18n.localize('coffee-pub-merchant.refuse.noGm');
            case 'TIMEOUT': return game.i18n.localize('coffee-pub-merchant.refuse.gmSilent');
            case 'NOT_A_MERCHANT': return game.i18n.localize('coffee-pub-merchant.refuse.notAShop');
            case 'MERCHANT_NOT_FOUND': return game.i18n.localize('coffee-pub-merchant.refuse.shopGone');
            case 'ITEM_NOT_FOUND': return game.i18n.localize('coffee-pub-merchant.refuse.outOfStockNow');
            case 'ITEM_NOT_TRANSFERABLE': return game.i18n.localize('coffee-pub-merchant.refuse.notCarryable');
            case 'NOT_FOR_SALE': return result?.itemName
                ? game.i18n.format('coffee-pub-merchant.refuse.itemNotForSale', { item: result.itemName })
                : game.i18n.localize('coffee-pub-merchant.refuse.notForSale');
            case 'SHOP_CLOSED': return game.i18n.localize('coffee-pub-merchant.refuse.closed');
            case 'EXCHANGE_UNAVAILABLE': return game.i18n.localize('coffee-pub-merchant.refuse.needsBlacksmith');
            case 'CANNOT_AFFORD': return game.i18n.format('coffee-pub-merchant.refuse.cannotAfford', {
                needed: formatBase(result?.price),
                held: result?.held ? formatBase(result.held) : game.i18n.localize('coffee-pub-merchant.common.nothing')
            });
            // `formatBase` renders nothing as an em dash, which is right in a price
            // column and reads as a missing word in a sentence.
            case 'MERCHANT_CANNOT_AFFORD': return game.i18n.format('coffee-pub-merchant.refuse.merchantCannotCover', {
                needed: formatBase(result?.price),
                held: result?.held ? formatBase(result.held) : game.i18n.localize('coffee-pub-merchant.common.nothing')
            });
            case 'NOT_PRICED': return result?.itemName
                ? game.i18n.format('coffee-pub-merchant.refuse.itemNoPrice', { item: result.itemName })
                : game.i18n.localize('coffee-pub-merchant.refuse.noPriceSet');
            case 'NOT_THERE': return game.i18n.localize('coffee-pub-merchant.refuse.notThere');
            case 'GRANT_FAILED': return game.i18n.localize('coffee-pub-merchant.refuse.grantFailed');
            case 'NOTHING_TO_SETTLE': return game.i18n.localize('coffee-pub-merchant.refuse.nothingToSettle');
            case 'OUT_OF_STOCK': return result?.itemName
                ? game.i18n.format('coffee-pub-merchant.refuse.itemOutOfStock', { item: result.itemName })
                : game.i18n.localize('coffee-pub-merchant.refuse.outOfStock');
            case 'INSUFFICIENT_STOCK': return `Only ${result?.available ?? 0} left${result?.itemName ? ` of ${result.itemName}` : ''}.`;
            case 'INSUFFICIENT_QUANTITY': return result?.itemName
                ? game.i18n.format('coffee-pub-merchant.refuse.notThatManyOf', { item: result.itemName })
                : game.i18n.localize('coffee-pub-merchant.refuse.notThatMany');
            // Not the player's fault and not something they can work around: the
            // coins they hand over are chosen for them, smallest first. Say whose
            // problem it is.
            // `NO_CHANGE` is gone: money now moves as one exact leg, with the payer
            // re-cutting their own coins if they must, so there is no change for
            // anybody to be unable to make.
            case 'CANNOT_MAKE_CHANGE': return game.i18n.localize('coffee-pub-merchant.refuse.coinsUncountable');
            case 'INSUFFICIENT_CURRENCY': return game.i18n.localize('coffee-pub-merchant.refuse.shortOfCoins');
            case 'INVALID_CURRENCY': return game.i18n.localize('coffee-pub-merchant.refuse.paymentMismatch');
            case 'SOURCE_ACTOR_NOT_FOUND':
            case 'TARGET_ACTOR_NOT_FOUND': return game.i18n.localize('coffee-pub-merchant.refuse.sideMissing');
            case 'SOURCE_ITEM_NOT_FOUND': return game.i18n.localize('coffee-pub-merchant.refuse.moved');
            case 'SAME_ACTOR': return game.i18n.localize('coffee-pub-merchant.refuse.selfTrade');
            case 'DUPLICATE_ITEM': return game.i18n.localize('coffee-pub-merchant.refuse.duplicateLine');
            case 'EXCHANGE_EMPTY': return game.i18n.localize('coffee-pub-merchant.refuse.nothingWasThere');
            // The doc asks for these to be surfaced rather than swallowed: whether
            // the row was created or grown, and by how much, is what a GM needs to
            // repair the state by hand.
            case 'SOURCE_UPDATE_FAILED': return game.i18n.localize('coffee-pub-merchant.refuse.stockNotReduced');
            case 'ROLLBACK_FAILED': return game.i18n.localize('coffee-pub-merchant.refuse.partial');
            case 'CONTAINER_NOT_FOUND': return game.i18n.localize('coffee-pub-merchant.refuse.inventoryGone');
            case 'CONTAINER_MAX_DEPTH': return game.i18n.localize('coffee-pub-merchant.refuse.nestedTooDeep');
            case 'NOT_NEGOTIATED': return result?.itemName
                ? game.i18n.format('coffee-pub-merchant.refuse.noPriceAgreedFor', { item: result.itemName })
                : game.i18n.localize('coffee-pub-merchant.refuse.noPriceAgreedOne');
            case 'NO_PURCHASED_INVENTORY': return game.i18n.localize('coffee-pub-merchant.sell.merchantBuysNothing');
            case 'NOT_YOUR_ITEM': return game.i18n.localize('coffee-pub-merchant.refuse.ownPossessions');
            case 'NO_QUERY_PERMISSION': return game.i18n.localize('coffee-pub-merchant.refuse.noPermission');
            // The envelope's own codes. `IDENTITY_UNVERIFIED` is a refusal to report
            // rather than work around: it means the GM's client could not establish who
            // asked, and answering from a claimed identity would be worse than not
            // answering. It is a Blacksmith problem, and saying so is the whole job.
            case 'UNKNOWN_OP': return game.i18n.localize('coffee-pub-merchant.refuse.gmNotAnswering');
            case 'QUERY_UNAVAILABLE': return game.i18n.localize('coffee-pub-merchant.refuse.requestsUnavailable');
            case 'IDENTITY_UNVERIFIED': return game.i18n.localize('coffee-pub-merchant.refuse.identityUnverified');
            case 'CONTAINER_HAS_CONTENTS': return Number.isFinite(result?.contentCount)
                ? game.i18n.format('coffee-pub-merchant.refuse.containerHolds', { count: result.contentCount })
                : game.i18n.localize('coffee-pub-merchant.refuse.packedContainer');
            case 'RECIPIENT_NOT_ALLOWED': return game.i18n.localize('coffee-pub-merchant.refuse.notThatCharacter');
            case 'RECIPIENT_NOT_FOUND': return game.i18n.localize('coffee-pub-merchant.refuse.characterGone');
            case 'INVALID_QUANTITY': return game.i18n.localize('coffee-pub-merchant.refuse.badAmount');
            case 'LOCK_TIMEOUT': return game.i18n.localize('coffee-pub-merchant.refuse.characterBusy');
            case 'TARGET_CREATE_FAILED': return game.i18n.localize('coffee-pub-merchant.refuse.recipientFailed');
            default: return game.i18n.localize('coffee-pub-merchant.refuse.notCompleted');
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

        // Before anything is priced, and before the slate lines are built from it.
        await this._refreshReputation();

        const { actor: merchant, token } = await this._resolveSubject();
        // **A shop with no token is not a missing shop.** One opened from a pin never has
        // one; what would make it missing is having no Actor to be a shop of.
        const missing = !merchant;

        const party = MerchantManager.getPartyActor();
        const options = this.recipients;
        const recipient = this.recipient;
        const shoppers = this._otherShoppers();
        const config = missing ? null : MerchantManager.getConfig(merchant);
        const hours = missing ? null : MerchantManager.getHours(merchant);

        // One section per inventory. A GM sees hidden inventories too, marked as such; a
        // player is never sent their contents at all.
        let inventories = [];
        if (!missing) {
            const busyRow = this._busy?.row ?? null;
            const isGM = game.user.isGM;
            const cart = this.cart;

            // A closed shop is browsable but nothing changes hands. The GM is
            // exempt, so they can stock and test outside opening hours.
            const trading = MerchantManager.isOpen(merchant) || isGM;
            const config0 = MerchantManager.getConfig(merchant);

            inventories = MerchantManager.getInventories(merchant, { includeHidden: isGM }).map(({ item: inventory, config }) => {
                const isUnpricedInventory = isUnpriced(config.type);
                const contents = MerchantManager.getInventoryContents(merchant, inventory).map((item) => {
                    const price = resolvePrice(config0, config, item,
                        { reputation: this.reputation, market: this.market, shopper: this.recipient?.uuid });
                    const stock = MerchantManager.getStock(merchant, item, config);
                    // What the cart holds is spoken for, so the inventory shows what is
                    // still available to take rather than what is physically there.
                    const held = cart.get(item.id) ?? 0;
                    const left = stock.unlimited ? Infinity : Math.max(0, stock.available - held);
                    const out = left < 1;
                    // "None left" and "you have taken them all" are different sentences
                    // and a player needs to be able to tell them apart.
                    const allInCart = out && held > 0;
                    // Refused on the GM too; this is the honest path, not the guard.
                    const inStock = !out;
                    // What the item itself says it is worth, which is what the price
                    // editor writes and reads. `price` above is that number after
                    // market, markup and standing have been applied.
                    const listPrice = listPriceBase(item);

                    return {
                        id: item.id,
                        type: item.type,
                        name: item.name,
                        img: item.img,
                        typeLabel: item.type?.charAt(0).toUpperCase() + item.type?.slice(1),
                        // Null on anything non-magical, which is most of a shop -- see
                        // `itemRarity`. The row shows nothing rather than "Mundane".
                        rarity: rarityLabel(itemRarity(item)),
                        rarityKey: itemRarity(item),
                        owner: 'merchant',
                        // Name, kind and rarity, so "potion" finds a Potion of Healing,
                        // "consumable" finds the whole category, and "rare" finds the
                        // things worth asking about.
                        searchKey: `${item.name ?? ''} ${item.type ?? ''} ${itemRarity(item) ?? ''}`.toLowerCase(),
                        busy: item.id === busyRow,
                        price,
                        // **A negotiate inventory never shows a figure**, not even once a
                        // price has been agreed. The agreement is between the GM and
                        // whoever is standing there; putting it in the price column
                        // publishes it to the next player who opens the shop, and turns
                        // an inventory that exists in order not to have prices into one that
                        // quietly accumulates them.
                        priceLabel: isUnpricedInventory || price === null
                            ? null
                            : (price === 0 ? 'Free' : formatBase(price)),
                        // The GM needs an anchor to haggle against, and it is the one
                        // thing they cannot see once the column is blank. Players get
                        // nothing here at all -- a tooltip saying what it is worth is
                        // exactly the number a negotiate inventory is withholding.
                        negotiateTooltip: isGM && isUnpricedInventory
                            ? this._negotiateHint(config0, item, price)
                            : null,
                        // Unlimited reads as a symbol; anything else is a number in
                        // the same column, so the layout does not move between
                        // policies.
                        qtyLabel: stock.unlimited ? '\u221e' : String(left),
                        qtyTooltip: stock.unlimited
                            ? game.i18n.localize('coffee-pub-merchant.stock.unlimited')
                            : (held
                                ? game.i18n.format('coffee-pub-merchant.stock.inStockOnSlate', { available: stock.available, held })
                                : (out ? game.i18n.localize('coffee-pub-merchant.stock.outOfStock') : game.i18n.format('coffee-pub-merchant.stock.inStockRestocks', { available: stock.available, par: stock.par }))),
                        outOfStock: out && !allInCart,
                        reserved: allInCart,
                        // A GM sets the count by hand here, and that also sets what a
                        // restocking inventory refills to.
                        canEditStock: isGM && !stock.unlimited,
                        // **A GM names the list price here.** Not on an unpriced
                        // inventory: having no list price is what that inventory is
                        // for, and the figure would be written and then ignored.
                        canPrice: isGM && !isUnpricedInventory,
                        // The item's **own** price, not the marked-up one on the row.
                        // Prefilling the shelf price would mean opening the editor and
                        // pressing Enter quietly baked this shop's markup into the item.
                        priceEach: listPrice === null ? '' : fromBase(listPrice, 'gp'),
                        listPriceTooltip: price === null
                            ? game.i18n.localize('coffee-pub-merchant.price.noPriceSetHint')
                            : price === 0
                                ? game.i18n.localize('coffee-pub-merchant.price.freeHint')
                                : game.i18n.localize('coffee-pub-merchant.price.setHint'),
                        // A disabled button with no reason on it is the thing
                        // players ask about, so the tooltip carries the reason.
                        // A disabled button with no reason on it is the thing
                        // players ask about, so the tooltip carries the reason.
                        cartTooltip: allInCart ? game.i18n.localize('coffee-pub-merchant.cart.allOnSlate')
                            : out ? game.i18n.localize('coffee-pub-merchant.stock.outOfStock')
                            : !trading ? game.i18n.localize('coffee-pub-merchant.cart.shopClosed')
                            : !recipient ? game.i18n.localize('coffee-pub-merchant.cart.noBuyer')
                            : (price === null && isUnpricedInventory) ? game.i18n.localize('coffee-pub-merchant.cart.agreeAPrice')
                            : price === null ? (isGM
                                ? game.i18n.localize('coffee-pub-merchant.cart.noPriceGm')
                                : game.i18n.localize('coffee-pub-merchant.cart.noPrice'))
                            : game.i18n.localize('coffee-pub-merchant.cart.add'),
                        // A negotiate row has no price *yet*, which is not the same
                        // as having none. It goes on the slate at TBD and settling
                        // is what waits for the number.
                        canCart: trading && Boolean(recipient) && inStock && (isUnpricedInventory || price !== null),
                        // Setting a quantity to zero says "sold out"; this says "we do
                        // not carry that". Different statements, so different controls.
                        canRemove: isGM,
                        isUnpricedInventory
                    };
                });

                // Grouped by kind within the inventory. A storefront with forty rows is
                // a wall of text otherwise.
                // **Within the category, never across it.** The grouping is the coarse
                // answer and this is the fine one; sorting the whole inventory would
                // throw away the kinds that make forty rows readable at all.
                //
                // An unpriced row sorts last whichever way round, because "no price" is
                // not a number and putting it at either end of one is a lie. It keeps
                // its place among the other unpriced rows by name.
                const order = this.stockSort.key;
                const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
                const sortRows = (rows) => [...rows].sort((a, b) => {
                    if (order !== 'price') return byName(a, b);
                    const left = a.price ?? null;
                    const right = b.price ?? null;
                    if (left === null && right === null) return byName(a, b);
                    if (left === null) return 1;
                    if (right === null) return -1;
                    return right - left || byName(a, b);
                });

                const categories = ITEM_CATEGORIES
                    .map((category) => ({
                        ...category,
                        items: sortRows(contents.filter((item) => item.type === category.type))
                    }))
                    .filter((category) => category.items.length > 0);

                const known = new Set(ITEM_CATEGORIES.map((c) => c.type));
                const other = contents.filter((item) => !known.has(item.type));
                if (other.length) categories.push({ type: 'other', label: 'Other', icon: 'fa-solid fa-question', items: sortRows(other) });

                return {
                    id: inventory.id,
                    label: inventory.name,
                    img: inventory.img,
                    hidden: config.visible === false,
                    canToggle: isGM,
                    collapsed: (_collapsed.get(this.shopKey) ?? new Set()).has(inventory.id),
                    canStock: isGM,
                    canRestock: isGM && MerchantManager.canRestock(merchant, inventory),
                    isUnpricedInventory,
                    categories,
                    count: contents.length,
                    hasItems: contents.length > 0
                };
            });
        }

        // What is still lying about. Only an abandoned shop has any: a working shop's
        // stock is its inventories, and these are what nobody bothered to carry away.
        // What is left of what was left: a dead shop empties, and the pin remembers what
        // has already been carried out of it.
        const gone = missing ? await this._takenHere() : [];
        const leavings = (missing ? await abandonedLeavings() : [])
            .filter((entry) => !gone.includes(entry.uuid))
            // How many of each is the pin's answer, not this render's: see `leavingQuantity`.
            .map((entry) => ({ ...entry, quantity: leavingQuantity(this.pinId, entry.uuid, entry.quantity) }));
        // The blurb survives too, and is enriched the same way: it was GM-written when the
        // shop existed, which is the only thing that made the triple-stache safe.
        const descriptionHtml = missing
            ? await _enrich(this.remembered?.description)
            : await _enrich(config?.description);
        const cartLines = missing ? [] : await this._cartLines();
        const cartTotal = cartLines.reduce((sum, line) => sum + (line.total ?? 0), 0);
        const basketLines = missing ? [] : await this._basketLines();
        const basketTotal = basketLines.reduce((sum, line) => sum + (line.total ?? 0), 0);

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            missing,
            shopName: config?.name || token?.name || this.shopName
                || game.i18n.localize('coffee-pub-merchant.shop.abandonedName'),
            stockSortIcon: this.stockSort.icon,
            stockSortTooltip: game.i18n.format('coffee-pub-merchant.shop.sortTooltip', {
                how: game.i18n.localize(this.stockSort.labelKey)
            }),
            // **The picture of the place, if there is one.** Absent is the ordinary case
            // and the card reads exactly as it always did; present, it sits behind the
            // card as a backdrop rather than replacing anything on it.
            illustration: illustrationUrl(missing ? this.remembered?.illustration : config?.illustration),
            // Normalised again here rather than trusted from the flag: this is the value
            // that ends up inside a `style` attribute, and the setter is not the only
            // way a flag gets written.
            tint: normalizeTint(missing ? this.remembered?.tint : config?.tint),
            leavings,
            hasLeavings: leavings.length > 0,
            abandonedImg: ABANDONED_IMG,
            // Nothing can be taken without somebody to take it, and the row says so rather
            // than failing on the press.
            canSteal: Boolean(this.recipient),
            // **The token's name, not the Actor's.** The Actor is the mould -- "General
            // Merchant" -- and the name given when the token was dropped is the person
            // standing behind this counter. An unlinked merchant placed three times is
            // Aldren Voss, Mira Feld and somebody else, and the card that called all
            // three "General Merchant" was naming the template at the player.
            //
            // A linked token carries its Actor's name anyway, so this is the same answer
            // there and the right one where they differ.
            keeperName: missing
                ? game.i18n.localize('coffee-pub-merchant.shop.abandonedKeeper')
                : (token?.name || token?.actor?.name || ''),
            // Only worth naming when the shop is not named after them: "Bob" over a shop
            // called Bob is a line of nothing.
            // An abandoned shop always says it: "nobody behind the counter" is the whole
            // point of the line there, where on a working shop it is only worth saying
            // when the shop is not named after them.
            hasKeeper: missing || (Boolean(config?.name)
                && String(config.name).trim() !== String(token?.name || token?.actor?.name || '').trim()),
            // The kind replaces the word "Merchant" above the name, which was telling
            // the player something they could already see.
            kindLabel: shopKind(missing ? this.remembered?.kind : config?.kind).label,
            kindIcon: shopKind(missing ? this.remembered?.kind : config?.kind).icon,
            description: descriptionHtml,
            hasDescription: Boolean(descriptionHtml),
            portraitImg: merchant?.img ?? this.remembered?.portrait ?? 'icons/svg/mystery-man.svg',
            // **What is left of a shop is the mark on the map that outlived it.** So the
            // abandoned card wears the category icon in the pin's own colours where the
            // portrait would be, rather than a generic crossed-out shop: it is still a
            // weaponsmith, and it still looks like the pin the party is standing on.
            palette: missing ? pinPalette() : null,
            inventories,
            hasInventories: inventories.length > 0,
            isGM: game.user.isGM,
            isOpen: missing ? false : MerchantManager.isOpen(merchant),
            // A shop open every hour has no hours worth printing; "midnight to
            // midnight" is a fact about the clock rather than about the shop. Nor has
            // one that never opens: "3:00 PM to 3:00 PM" is not a span, and the sign
            // above it already says the shop is shut.
            hoursLabel: hours && !isAlwaysOpen(hours) && !isAlwaysClosed(hours)
                ? `${formatHour(hours.open)} \u2013 ${formatHour(hours.close)}`
                : null,
            // Only when there is something to say. A shop at the going rate says
            // nothing, and "prices here are normal" is noise on every other shop in
            // the world \u2014 but a player looking at a bill twice what they expected
            // deserves to know it is the town rather than the shopkeeper.
            marketLabel: marketShortLabel(this.market),
            // The party's standing here, said where the shopping happens rather than
            // in the settings window. Absent when the shop has not opted in, or when
            // the standing is neutral and there is nothing to report.
            reputationLine: this._reputationLine,
            // Built here rather than assembled in the template, so a translator gets
            // one sentence with two placeholders instead of three clauses they cannot
            // reorder. Values are escaped before the emphasis goes on, because the band
            // name comes from Blacksmith and the effect is our own formatting -- neither
            // is ours to trust into a triple-stache unexamined.
            reputationSentence: this._reputationBand
                ? game.i18n.format('coffee-pub-merchant.shop.reputationSentence', {
                    band: `<strong>${foundry.utils.escapeHTML(String(this._reputationBand))}</strong>`,
                    effect: `<strong>${foundry.utils.escapeHTML(String(this._reputationEffect ?? ''))}</strong>`
                })
                : null,
            reputationBand: this._reputationBand,
            reputationEffect: this._reputationEffect,
            reputationTooltip: this._reputationTooltip,
            // Anyone *else* with lines on a slate here. Excludes the current character,
            // who is already named beside them, and anyone with nothing on the go --
            // a face that means "this person once opened the shop" is noise.
            shoppers,
            hasShoppers: shoppers.length > 0,
            sell: this._sellContext(merchant),
            cart: cartLines.map((line) => ({
                ...line,
                totalLabel: line.total === null ? 'TBD' : (line.total === 0 ? 'Free' : formatBase(line.total)),
                agreed: line.total !== null,
                canPrice: game.user.isGM,
                priceEach: line.unit === null ? '' : fromBase(line.unit, 'gp'),
                priceTooltip: line.unit === null
                    ? game.i18n.localize('coffee-pub-merchant.slate.tbdPrompt')
                    : (line.unit === 0
                        ? game.i18n.localize('coffee-pub-merchant.slate.freePrompt')
                        : game.i18n.format('coffee-pub-merchant.slate.eachChange', { price: formatBase(line.unit) })),
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
            netTotalLabel: (cartTotal - basketTotal < 0 ? '+' : '\u2212')
                + formatBase(Math.abs(cartTotal - basketTotal)),
            // Paying out and taking in are different events, and the colour says
            // which before the figure is read.
            netDirection: cartTotal - basketTotal > 0 ? 'pay'
                : cartTotal - basketTotal < 0 ? 'receive'
                    : 'even',
            // The shopper's purse as it stands, which is what the total is a change
            // to. A number that big is meaningless without the number it acts on.
            fundsLabel: recipient ? formatBase(purseValue(recipient)) : formatBase(0),
            basket: basketLines.map((line) => ({
                ...line,
                totalLabel: line.total === null ? 'TBD' : formatBase(line.total),
                agreed: line.total !== null,
                canPrice: game.user.isGM,
                priceEach: line.unit === null ? '' : fromBase(line.unit, 'gp'),
                priceTooltip: line.unit === null
                    ? game.i18n.localize('coffee-pub-merchant.slate.agreePrompt')
                    : game.i18n.format('coffee-pub-merchant.slate.eachChange', { price: formatBase(line.unit) }),
                side: 'basket',
                removeAction: 'removeFromBasket'
            })),
            basketCount: basketLines.length,
            hasBasket: basketLines.length > 0,
            basketTotalLabel: formatBase(basketTotal),
            // The buyback inventory existing is what "this shop buys things" means.
            canSell: !missing && Boolean(this._purchasedInventory(merchant)),
            sellTooltip: !recipient
                ? game.i18n.localize('coffee-pub-merchant.sell.noSellCharacter')
                : game.i18n.localize('coffee-pub-merchant.sell.chooseSomething'),
            sellEnabled: !missing && Boolean(recipient)
                && (MerchantManager.isOpen(merchant) || game.user.isGM)
                && MerchantManager.getInventories(merchant, { includeHidden: true }).some(({ config }) => isPurchased(config.type)),
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
        const settleTooltip = !hasAnything ? game.i18n.localize('coffee-pub-merchant.slate.nothingYet')
            : net > 0 ? game.i18n.format('coffee-pub-merchant.slate.youPay', { amount: formatBase(net) })
                : net < 0 ? game.i18n.format('coffee-pub-merchant.slate.youReceive', { amount: formatBase(-net) })
                    : game.i18n.localize('coffee-pub-merchant.slate.evenTrade');

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
            // **An abandoned shop has no slate to clear and nothing to settle.** What a GM
            // may want is to take the pin off the map, which is the only thing left that
            // still points at a shop -- and it stays their decision, which is why it is a
            // button here rather than something that happened when the Actor was deleted.
            toolFooterRight: missing
                ? (game.user.isGM && this.pinId
                    ? `
                <button type="button" class="blacksmith-window-btn-secondary"
                        data-action="removePin"
                        data-tooltip="${game.i18n.localize('coffee-pub-merchant.pin.removeTooltip')}">
                    <i class="fa-solid fa-trash"></i> ${game.i18n.localize('coffee-pub-merchant.pin.remove')}
                </button>`
                    : '')
                : `
                <button type="button" class="blacksmith-window-btn-secondary merchant-shop-clear"
                        data-action="clearAll" ${hasAnything ? '' : 'disabled'}
                        data-tooltip="${game.i18n.localize('coffee-pub-merchant.slate.clearTooltip')}">
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
        // restocking an inventory does not push anything to a player already looking at
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
            ...(this.canBePinned ? [{
                // Mirrored in Merchant Settings. A GM standing in the shop is the one who
                // knows it wants a pin, and sending them to another window to say so is a
                // trip to answer a question they have already answered.
                id: 'merchant-pin',
                icon: 'fa-solid fa-map-pin',
                label: 'Pin This Merchant',
                onClick: () => void this.pinShop()
            }] : []),
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
     * Fold an inventory shut, or open it again.
     *
     * **A view preference, not a fact about the shop.** It is per client and per shop and
     * is never written to a document: two people looking at the same counter can have
     * different sections folded, and a GM tidying their own view must not reach into what
     * a player sees. That is also why it needs no permission check — there is nothing here
     * anyone could do to anyone else.
     *
     * Kept in a module-level map keyed by token, so closing the shop and opening it again
     * finds it as you left it — the same promise the search box and the scroll positions
     * already make.
     */
    collapseInventory(inventoryId) {
        if (!inventoryId) return;
        const folded = _collapsed.get(this.shopKey) ?? new Set();
        if (folded.has(inventoryId)) folded.delete(inventoryId);
        else folded.add(inventoryId);
        _collapsed.set(this.shopKey, folded);
        void this.render(false);
    }

    /**
     * Bring an inventory out front, or put it away, from the shop itself — which is where
     * a GM is standing when they decide to. The config window is for setting a shop
     * up; this is for running one.
     */
    async toggleInventory(inventoryId) {
        if (!game.user.isGM) return;
        const { actor: merchant } = await this._resolveSubject();
        const config = MerchantManager.getInventoryConfig(merchant?.items?.get(inventoryId));
        if (!config) return;
        try {
            await MerchantManager.setInventoryVisible(merchant, inventoryId, config.visible === false);
            // Players with the shop open gain or lose a whole section, so tell them.
            MerchantManager._broadcastRefresh(this.shopKey);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not change that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.inventoryChangeFailed'));
        }
    }

    /**
     * The door, once.
     *
     * `_onFirstRender` rather than `_onRender`: every gesture in this window ends in a
     * re-render, so the second would make the counter creak on every click.
     */
    _onFirstRender(context, options) {
        super._onFirstRender?.(context, options);
        void this._playDoor(SOUND.WINDOW_OPEN);
    }

    /**
     * The door, in this merchant's own voice if it has one.
     *
     * Resolving the subject is async and a lifecycle hook is not, so this is deliberately
     * not awaited: a sound that arrives a frame late is a sound, and one that held up a
     * render would be a bug.
     */
    async _playDoor(which) {
        const { actor } = await this._resolveSubject();
        playFeedback(which, actor ? MerchantManager.soundFor(actor, which === SOUND.WINDOW_OPEN ? 'open' : 'close') : null);
    }

    /**
     * Each inventory is a drop target, so a GM can drag stock straight onto the inventory it
     * belongs on — from a compendium, the sidebar, or another sheet.
     */
    _onRender(context, options) {
        super._onRender?.(context, options);

        this._keepScroll();
        // Every slate change ends in a render, so this is the one place that has to
        // remember to broadcast. Asking one shop for its slates is likewise done once,
        // on the first render, which is when a window can first be looked at.
        this._syncSlate();
        if (!this._askedForSlates) {
            this._askedForSlates = true;
            this._requestSlates();
            this.announcePresence();
        }

        void this._applyItemTooltips();
        this._bindQuantityEdits();
        this._bindSearch();
        this._bindSellSearch();
        this._bindSellDrop();
        // Re-applied after every render, because a refresh, a GM stocking an inventory, or
        // another player's purchase all rebuild the list underneath a standing search.
        this._applyFilter();

        // Below here is GM-only. Quantity editing is bound for everyone, because a
        // slate line belongs to whoever is shopping; only the shop's own stock cells
        // carry `data-edit-stock` and `data-edit-list-price`, and only a GM is given
        // those -- and `setStockQuantity` and `setListPrice` refuse anyone else besides.
        if (!game.user.isGM) return;

        this._bindItemSheets();

        for (const zone of this.element?.querySelectorAll('[data-drop-inventory]') ?? []) {
            if (zone.dataset.merchantBound === 'true') continue;
            zone.dataset.merchantBound = 'true';
            const inventoryId = zone.getAttribute('data-drop-inventory');

            zone.addEventListener('dragover', (event) => {
                event.preventDefault();
                zone.classList.add('is-dropping');
            });
            zone.addEventListener('dragleave', () => zone.classList.remove('is-dropping'));
            zone.addEventListener('drop', (event) => {
                event.preventDefault();
                zone.classList.remove('is-dropping');
                void this._onDropToInventory(event, inventoryId);
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
     * Hang dnd5e's own item card on every row that names an item.
     *
     * The system already renders one, and renders it right: `richTooltip()` knows
     * what belongs on a weapon and what belongs on a potion, and keeps knowing when
     * dnd5e changes its mind. Three dataset attributes are the whole integration —
     * the tooltip manager finds the `.loading[data-uuid]` placeholder, resolves it
     * and swaps the card in. Squire does this the same way, for the same reason.
     *
     * On the **name and the image**, not the row. A row also carries a quantity cell
     * that says how to edit it and buttons that say what they do, and a row-wide card
     * would cover every one of them. The picture is the other half of what a person
     * points at when they mean "that one", so it gets the same card -- reaching past a
     * 32-pixel icon to a truncated name is a worse gesture than either.
     *
     * Three families, from two different Actors: the inventories and the buying side of
     * the slate are the merchant's items; the selling side is the shopper's own.
     */
    async _applyItemTooltips() {
        const root = this.element;
        if (!root) return;

        const { actor: merchant } = await this._resolveSubject();
        const shopper = this.recipient;

        const decorate = (targets, item, fallback) => {
            for (const target of [targets].flat()) decorateOne(target, item, fallback);
        };

        const decorateOne = (target, item, fallback) => {
            if (!target) return;
            // No richTooltip means a system that is not dnd5e. Fall back to the name,
            // which a truncated row needs whatever else is missing.
            if (typeof item?.richTooltip !== 'function') {
                if (fallback && !target.dataset.tooltip) target.dataset.tooltip = fallback;
                return;
            }
            target.dataset.tooltip =
                `<section class="loading" data-uuid="${item.uuid}"><i class="fas fa-spinner fa-spin-pulse"></i></section>`;
            target.dataset.tooltipClass = 'dnd5e2 dnd5e-tooltip item-tooltip themed theme-light';
        };

        for (const row of root.querySelectorAll('.merchant-shop-item[data-item-id]')) {
            // **The row says whose it is.** Selling puts the shopper's own pack through
            // this same markup, and looking every row up on the merchant meant a pack
            // row resolved to nothing and got no card at all.
            const owner = row.dataset.owner === 'shopper' ? shopper : merchant;
            const name = row.querySelector('.merchant-shop-item-copy strong');
            decorate([name, row.querySelector('img')], owner?.items?.get(row.dataset.itemId),
                name?.textContent?.trim());
        }

        for (const line of root.querySelectorAll('.merchant-shop-cart-line[data-item-id]')) {
            const name = line.querySelector('.merchant-shop-cart-name');
            const side = line.querySelector('[data-line-side]')?.getAttribute('data-line-side');
            const owner = side === 'basket' ? shopper : merchant;
            decorate([name, line.querySelector('img')], owner?.items?.get(line.dataset.itemId),
                name?.textContent?.trim());
        }
    }

    /**
     * A GM clicking an item's picture opens that item.
     *
     * The picture is already the thing carrying the item's card on hover, so it is
     * already the part of the row that means "this item" rather than "this row" --
     * which makes it the honest place to put the way in. A GM who wants to fix a
     * price, edit a description or check what a rolled result actually is otherwise
     * has to leave the shop, open the Actor, and find the inventory it is sitting in.
     *
     * **GM only, and enforced by not binding it** rather than by refusing inside the
     * handler: a player has no permission on a shopkeeper's items, so the sheet would
     * open empty or not at all, and a control that does nothing is worse than one that
     * is not there. The cursor changes only where the click works, so the affordance
     * and the permission are the same fact.
     *
     * Both families, from both Actors: the inventories and the buying side are the
     * merchant's, the selling side is the shopper's.
     */
    _bindItemSheets() {
        const root = this.element;
        if (!root) return;

        const open = async (itemId, fromBasket) => {
            const { actor } = await this._resolveSubject();
            // Re-read after the await. A row can be sold, cleared or restocked out from
            // under a click, and a stale reference would open the wrong sheet or throw.
            const owner = fromBasket ? this.recipient : actor;
            owner?.items?.get(itemId)?.sheet?.render(true);
        };

        for (const row of root.querySelectorAll('.merchant-shop-item[data-item-id], .merchant-shop-cart-line[data-item-id]')) {
            const img = row.querySelector('img');
            if (!img || img.dataset.merchantBound === 'true') continue;
            img.dataset.merchantBound = 'true';
            img.classList.add('merchant-shop-openable');

            // A slate line says which side it is on; a stock row says whose it is.
            // Both mean the same thing here: is this the shopper's or the shop's.
            const fromBasket = row.dataset.owner === 'shopper'
                || row.querySelector('[data-line-side]')?.getAttribute('data-line-side') === 'basket';
            img.addEventListener('click', (event) => {
                // The row underneath is a drop target and the slate line is not a
                // button, but neither should hear this.
                event.preventDefault();
                event.stopPropagation();
                void open(row.dataset.itemId, fromBasket);
            });
        }
    }

    /**
     * Put each scrolling region back where it was.
     *
     * Adding something to the cart re-renders, which replaces the markup and takes
     * the scroll position with it — so a player who scrolled to the bottom of a long
     * inventory and pressed Add was thrown back to the top and had to find their place
     * again for every single item.
     *
     * Recorded on scroll rather than captured before each render, because a render
     * can be triggered from anywhere: a socket refresh, a GM restocking, another
     * player buying. There is no single place to hook a "before" on.
     */
    _keepScroll() {
        this._scroll ??= {};
        for (const [key, selector] of [
            ['stock', '.merchant-shop-inventories'],
            ['cart', '.merchant-shop-cart-body']
        ]) {
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
        const cells = this.element?.querySelectorAll(
            '[data-edit-stock], [data-edit-line], [data-edit-price], [data-edit-list-price]'
        ) ?? [];
        for (const cell of cells) {
            if (cell.dataset.merchantBound === 'true') continue;
            cell.dataset.merchantBound = 'true';
            const price = cell.hasAttribute('data-edit-price') || cell.hasAttribute('data-edit-list-price');
            cell.addEventListener('dblclick', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (price) this._beginPriceEdit(cell);
                else this._beginQuantityEdit(cell);
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

    /**
     * Double-click a slate price to name it. GM only.
     *
     * The same gesture as the quantity beside it, and deliberately so — but a price
     * is gold rather than a count, so it takes decimals, and an empty box clears the
     * agreement rather than meaning zero. Clearing matters: on a negotiate line it
     * puts the row back to TBD, which is the state that says the haggling is still
     * live. Zero, meanwhile, is a real price. Free is a thing a merchant can offer.
     *
     * What is typed is the price *each*. The cell shows the line total, so for a
     * single item they are the same number and for several the tooltip says which
     * is which. Editing the total instead would divide by the quantity and leave 40
     * gp for three showing as 39.99.
     */
    _beginPriceEdit(cell) {
        if (this.busy || cell.querySelector('input')) return;
        // `em` as well as `strong`: an unpriced row reads "no price" in em, and it is
        // the one row where this gesture matters most.
        const value = cell.querySelector('strong, em');
        if (!value) return;

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = 'any';
        input.value = cell.getAttribute('data-price-each') ?? '';
        input.placeholder = 'gp';
        input.className = 'merchant-shop-qty-input';

        value.replaceWith(input);
        input.focus();
        input.select();

        let settled = false;
        const finish = async (commit) => {
            if (settled) return;
            settled = true;
            const raw = input.value.trim();
            input.replaceWith(value);
            if (commit) {
                const gold = raw === '' ? null : Number(raw);
                if (raw === '' || (Number.isFinite(gold) && gold >= 0)) await this._commitPrice(cell, gold);
            }
            await this.render(false);
        };

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
            else if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
        });
        input.addEventListener('blur', () => void finish(true));
    }

    async _commitPrice(cell, gold) {
        const listId = cell.getAttribute('data-edit-list-price');
        const itemId = listId ?? cell.getAttribute('data-edit-price');
        if (!itemId) return;
        const { actor: merchant } = await this._resolveSubject();
        if (!merchant) return;

        // **Two different questions, told apart by which cell was double-clicked.** On
        // a shelf it is what the thing costs, which stays on the item. On a slate line
        // it is what these two have agreed for this trade, which is cleared when the
        // trade settles.
        if (listId) {
            try {
                await MerchantManager.setListPrice(merchant, listId, gold === null ? null : toBase(gold, 'gp'));
                playFeedback(SOUND.SLATE_UPDATE);
                MerchantManager.broadcastActorRefresh(merchant);
            } catch (error) {
                console.error(`${MODULE.TITLE} | Could not set that price:`, error);
                notify.error(game.i18n.localize('coffee-pub-merchant.notify.priceSetFailed'));
            }
            return;
        }

        // Which way the money runs decides which agreement this is. What the shop
        // charges for its own goods and what it will pay for one of yours are two
        // different numbers about two different things.
        const side = cell.getAttribute('data-line-side') === 'basket' ? 'sell' : 'buy';
        try {
            // **An agreement is with somebody.** Without a shopper there is nobody to agree
            // with, and writing one would be a discount for the room.
            const shopper = this.recipient?.uuid;
            if (!shopper) {
                notify.warn(game.i18n.localize('coffee-pub-merchant.refuse.noOneToAgreeWith'));
                return;
            }
            await MerchantManager.setNegotiatedPrice(
                merchant, itemId, gold === null ? null : toBase(gold, 'gp'), { side, shopper }
            );
            playFeedback(SOUND.SLATE_UPDATE);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not agree that price:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.priceAgreeFailed'));
        }
    }

    async _commitQuantity(cell, next) {
        const lineId = cell.getAttribute('data-edit-line');
        if (lineId) {
            const map = cell.getAttribute('data-line-side') === 'basket' ? this.basket : this.cart;
            // Zero is how a line is removed, which is the same rule the loot window
            // uses and means the bin is a shortcut rather than the only way.
            if (next < 1) {
                map.delete(lineId);
                playFeedback(SOUND.SLATE_CLEAR);
            } else {
                map.set(lineId, next);
                playFeedback(SOUND.SLATE_UPDATE);
            }
            return;
        }

        const stockId = cell.getAttribute('data-edit-stock');
        if (!stockId) return;
        const { actor: merchant } = await this._resolveSubject();
        if (!merchant) return;
        try {
            const result = await MerchantManager.setStockQuantity(merchant, stockId, next);
            // Silently correcting a number a GM typed is how you get somebody
            // re-typing it, so say what happened and where the limit lives.
            if (result?.clamped) {
                notify.info(
                    game.i18n.format('coffee-pub-merchant.notify.clampedToMaxStack', {
                        max: result.maxPerItem,
                        value: result.value
                    })
                );
            }
            playFeedback(SOUND.SLATE_UPDATE);
            MerchantManager.broadcastActorRefresh(merchant);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set that quantity:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.quantityFailed'));
        }
    }

    /**
     * The pack's own search, kept apart from the shop's.
     *
     * Two boxes because they filter two different piles, and one box filtering both
     * would mean typing "rope" to find yours and hiding half the shop as a side
     * effect. Debounced through a re-render rather than filtered in the DOM: the pack
     * is tens of rows, not hundreds, and re-rendering keeps the sort honest.
     */
    _bindSellSearch() {
        const input = this.element?.querySelector('[data-sell-search]');
        if (!input || input.dataset.merchantBound === 'true') return;
        input.dataset.merchantBound = 'true';
        input.addEventListener('input', () => {
            this._sellSearch = input.value;
            clearTimeout(this._sellSearchTimer);
            // Long enough that typing does not re-render per keystroke, short enough
            // that it never feels like waiting.
            this._sellSearchTimer = setTimeout(() => {
                void this.render(false).then(() => {
                    const again = this.element?.querySelector('[data-sell-search]');
                    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
                });
            }, 200);
        });
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
     * Not GM-only, unlike the inventory drop zones: selling is the one thing in this
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
            notify.warn(game.i18n.localize('coffee-pub-merchant.sell.onlyCarried'));
            return;
        }
        await this.addToBasket(item);
    }

    /**
     * Take something off an inventory for good.
     *
     * Not the same as setting it to zero: zero is a shop that has sold out of
     * something it carries, and a restocking inventory brings it back. This is the inventory
     * no longer carrying it.
     *
     * **No confirmation.** Putting something back on an inventory is a drag, so a prompt
     * here charges every removal for a mistake that costs seconds to undo — and a
     * dialog that always says yes is one people stop reading.
     *
     * A packed container is the exception, and it goes through dnd5e's own delete
     * prompt: that one asks whether the contents go too, which is a real question
     * with a wrong answer that orphans everything inside.
     */
    async removeStock(itemId) {
        if (!game.user.isGM) return;

        // Clicking down an inventory faster than it re-renders sends the same id twice: the
        // row is still on screen because the render that would have removed it has not
        // landed yet. The second delete then reaches a document the first one already
        // took, and Foundry answers `Item "..." does not exist!` -- a server round trip
        // reported as an error for something the GM did correctly.
        //
        // Claimed before the first await, released in `finally`, because the whole
        // window in which this goes wrong is between the click and the resolve.
        this._removing ??= new Set();
        if (this._removing.has(itemId)) return;
        this._removing.add(itemId);

        try {
            const { actor } = await this._resolveSubject();
            // Re-read after the await rather than trusting anything captured before it.
            // The document may have gone in the meantime -- by another click, another
            // GM, or the sheet -- and gone is the outcome we wanted anyway.
            const item = actor?.items?.get(itemId);
            if (!item) return;

            const packed = item.type === 'container'
                && (actor.items.filter((child) => child.system?.container === item.id).length > 0);

            try {
                if (packed) await item.deleteDialog();
                else await item.delete();
                MerchantManager.broadcastActorRefresh(token.actor);
            } catch (error) {
                // Someone else got there first. That is the state we were asking for,
                // so it is not worth a red line in anybody's console.
                if (token.actor.items.get(itemId)) {
                    console.error(`${MODULE.TITLE} | Could not remove ${item.name}:`, error);
                }
            }
        } finally {
            this._removing.delete(itemId);
        }
    }

    /**
     * Restock an inventory from the shop itself.
     *
     * The same act as the button in Merchant Settings, put where a GM already is when
     * they notice an inventory is bare. A press is deliberate, so every table on the inventory
     * rolls — the reroll flag governs the clock, not the button.
     */
    async restockInventory(inventoryId) {
        const { actor: merchant } = await this._resolveSubject();
        if (!merchant) return;

        const inventoryName = merchant.items.get(inventoryId)?.name ?? 'the inventory';
        const bar = startProgress(
            MerchantManager.restockWorkUnits(merchant, inventoryId, { force: true }),
            `Restocking ${inventoryName}`
        );
        try {
            const filled = await MerchantManager.restockInventory(merchant, inventoryId, {
                force: true,
                onStep: (message) => bar.step(message)
            });
            if (filled) playFeedback(SOUND.RESTOCK);
            bar.finish(filled
                ? `Restocked ${filled} item${filled === 1 ? '' : 's'} on ${inventoryName}.`
                : game.i18n.format('coffee-pub-merchant.notify.nothingToRestock', { inventory: inventoryName }));
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not restock that inventory:`, error);
            bar.finish(game.i18n.localize('coffee-pub-merchant.notify.restockFailed'));
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.restockFailed'));
        }
    }

    /**
     * Fold this inventory's duplicate rows into one.
     *
     * Says what it did, including when it did nothing -- a tidy button that produces no
     * visible change is otherwise indistinguishable from a broken one.
     */
    async mergeInventory(inventoryId) {
        if (!game.user.isGM) return;
        const { actor: merchant } = await this._resolveSubject();
        if (!merchant || !inventoryId) return;

        try {
            const merged = await MerchantManager.mergeInventoryDuplicates(merchant, inventoryId);
            notify.info(merged
                ? game.i18n.format('coffee-pub-merchant.notify.merged', { count: merged })
                : game.i18n.localize('coffee-pub-merchant.notify.nothingToMerge'));
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not merge duplicate rows:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.mergeFailed'));
        }
    }

    /**
     * Take everything off an inventory.
     *
     * **Confirmed, unlike removing one row.** A single item is easy to put back, which
     * is why that one has no prompt; an inventory is nineteen of them and a table roll to
     * get them, so the scale is what earns the question.
     */
    async clearInventory(inventoryId) {
        if (!game.user.isGM) return;
        const { actor: merchant } = await this._resolveSubject();
        const inventory = merchant?.items?.get(inventoryId);
        if (!inventory) return;

        const count = MerchantManager.getInventoryContents(merchant, inventory).length;
        if (!count) {
            notify.info(game.i18n.format('coffee-pub-merchant.notify.alreadyEmpty', { inventory: inventory.name }));
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const confirmed = await blacksmith.dialog.confirm({
                title: 'Clear Inventory',
                classes: ['merchant-dialog'],
                content: `<p>Take all ${count} item${count === 1 ? '' : 's'} off `
                    + `<strong>${inventory.name}</strong>.</p>`
                    + '<p>The inventory itself stays, with everything it is set to. This cannot be undone.</p>',
                confirmLabel: 'Clear Inventory',
                confirmIcon: 'fa-solid fa-broom'
            });
            if (!confirmed) return;
        }

        try {
            const cleared = await MerchantManager.clearInventory(merchant, inventoryId);
            notify.info(`Cleared ${cleared} item${cleared === 1 ? '' : 's'} off ${inventory.name}.`);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not clear that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.clearFailed'));
        }
    }

    async _onDropToInventory(event, inventoryId) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}');
        } catch (_error) {
            return;
        }
        // Only Items, and only ones carrying a UUID — grantItem resolves from that.
        if (data?.type !== 'Item' || !data.uuid) return;

        const { actor: merchant } = await this._resolveSubject();
        if (!merchant) return;

        try {
            const result = await MerchantManager.addToInventory(merchant, inventoryId, data.uuid);
            if (result?.ok) MerchantManager._broadcastRefresh(this.shopKey);
            else notify.error(this._explain(result?.code, result));
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that to the inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.addToInventoryFailed'));
        }
        await this.render(false);
    }

    /**
     * Take one thing out of an abandoned shop.
     *
     * **Straight to the character, with no slate.** A slate is a reckoning to settle, and
     * there is nobody to settle with -- putting a free thing from a dead shop through a
     * cart would be a ceremony around a decision already made.
     *
     * It goes through the same GM-verified envelope every purchase does, because a player
     * cannot create an item on their own sheet and should not be able to: the GM checks
     * what is being taken against the list of what is there.
     */
    async steal(itemUuid) {
        const recipient = this.recipient;
        if (!itemUuid || !recipient) return;

        const result = await this._send(
            { steal: true, itemUuid, recipientUuid: recipient.uuid, pinId: this.pinId },
            { row: itemUuid, label: game.i18n.localize('coffee-pub-merchant.shop.stealing') }
        );
        if (result?.ok) {
            playFeedback(SOUND.TRANSACTION);
            notify.info(game.i18n.format('coffee-pub-merchant.shop.stolen', {
                name: result.name, who: recipient.name, count: result.quantity ?? 1
            }));
        } else {
            notify.error(this._explain(result?.code, result));
        }
        await this.render(false);
    }

    /** What has already been taken out of this shop, as its pin remembers it. */
    async _takenHere() {
        if (!this.pinId || !hasPins()) return [];
        try {
            return pinTaken(await game.modules.get('coffee-pub-blacksmith')?.api?.pins?.get(this.pinId));
        } catch (_error) {
            return [];
        }
    }

    /**
     * Take the pin off the map, from inside the shop it no longer opens.
     *
     * The window closes with it: what it was a window onto is gone, and leaving it up
     * would leave a shop nobody can reach a second way of not reaching.
     */
    async removePin() {
        if (!game.user.isGM || !this.pinId) return;
        if (await MerchantManager.unpinShop(this.pinId)) await this.close();
    }

    /**
     * Whether this shop could take a pin, answered synchronously.
     *
     * **Absent rather than disabled, and this is the exception to the rule.** A control
     * that cannot act normally says why -- but "you cannot pin an unlinked merchant" is a
     * fact about a whole class of shop that will never change while you are looking at it,
     * not a state that might clear. A permanently disabled button is furniture.
     *
     * `fromUuidSync` because header actions are built during a render and cannot await.
     * It reads what is already in memory, which a shop's own subject always is.
     */
    get canBePinned() {
        if (!game.user.isGM || !hasPins()) return false;
        let subject = null;
        try {
            subject = fromUuidSync(this.shopKey);
        } catch (_error) {
            return false;
        }
        // The shop key is the Actor for a linked merchant and the token for an unlinked
        // one, so this is the same question `canPin` asks, already answered by identity.
        return subject?.documentName === 'Actor' && canPin(subject);
    }

    /** Put a pin for this shop on the scene being looked at. */
    async pinShop() {
        if (!game.user.isGM) return;
        const { actor } = await this._resolveSubject();
        if (actor) await MerchantManager.pinShop(actor);
    }

    async openConfig() {
        if (!game.user.isGM) return;
        const { actor } = await this._resolveSubject();
        if (actor) await MerchantConfigWindow.open(actor);
    }

    /**
     * Blacksmith's own compendium search, opened through the window registry.
     *
     * Merchant had its own for a day. Theirs is better — type filter, results
     * grouped by source, timing and a "more available" count — and its result rows
     * are draggable with a `{ type, uuid }` payload, which is exactly what the inventory
     * drop targets already read. So the search is theirs and the targeting is the
     * drag, and there is no second search to keep working.
     */
    async openCompendiumSearch() {
        if (!game.user.isGM) return;
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.openWindow !== 'function') {
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.compendiumUnavailable'));
            return;
        }
        await blacksmith.openWindow('blacksmith-compendium-search');
    }

    /** Open or close for business. A closed shop still opens for browsing. */
    async toggleOpen() {
        if (!game.user.isGM) return;
        const { actor: merchant } = await this._resolveSubject();
        if (!merchant) return;
        try {
            await MerchantManager.setOpen(merchant, !MerchantManager.isOpen(merchant));
            MerchantManager._broadcastRefresh(this.shopKey);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not change the shop state:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.shopStateFailed'));
        }
    }

    async openSheet() {
        if (!game.user.isGM) return;
        // The token is passed when there is one so the sheet opens in that token's
        // context; a shop with no token opens the Actor's own sheet, which is the only
        // sheet a linked merchant has anyway.
        const { actor, token } = await this._resolveSubject();
        actor?.sheet?.render(true, token ? { token } : {});
    }

    async openPrototypeToken() {
        if (!game.user.isGM) return;
        const { actor } = await this._resolveSubject();
        const prototype = actor?.prototypeToken;
        const sheetClass = CONFIG.Token?.prototypeSheetClass;
        // PrototypeToken is a DataModel with no `sheet` getter, so `prototype.sheet`
        // optional-chains into silence. This is how core opens it.
        if (!prototype || !sheetClass) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.noPrototypeToken'));
            return;
        }
        new sheetClass({ prototype }).render(true);
    }

    /**
     * Deregistration is the base class's now, and it happens in `super._onClose`.
     *
     * Which is why ours runs in a `try`: leaving the room is a socket emit and a map
     * write, and if either threw, the `super` call below would never run and the
     * window would stay registered — the exact state that made a shop unopenable for
     * the rest of the session. A face left behind is a cosmetic bug; a stranded
     * registry entry is not.
     */
    _onClose(options) {
        try {
            // Leave the room first, or the face stays behind.
            this.clearPresence();
            clearTimeout(this._sellSearchTimer);
            void this._playDoor(SOUND.WINDOW_CLOSE);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not clean up on close:`, error);
        }
        return super._onClose?.(options);
    }
}
