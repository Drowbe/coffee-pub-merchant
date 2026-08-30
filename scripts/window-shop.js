import {
    BlacksmithToolWindowBaseV2, BlacksmithFullscreenWindowBaseV2, BLACKSMITH_FULLSCREEN_LAYOUTS,
    BLACKSMITH_FULLSCREEN_FITS
} from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import {
    MODULE, ITEM_CATEGORIES, formatHour, shopKind, isAlwaysOpen, isAlwaysClosed, isUnpriced, isPurchased,
    normalizeTint, itemRarity, rarityLabel, ABANDONED_IMG,
    opensFullScreen,
    DEFAULT_DELIVERY_SERVICE, arrivalTime,
    isCatalogue,
    cardSize, cardBlurb,
    paginateCards, adsIntoList, layoutWall
} from './const.js';
import { hasPins, canPin, pinPalette, pinTaken, leavingQuantity } from './utility-pins.js';
import { abandonedLeavings } from './utility-compendium.js';
import { canPrint } from './utility-catalogue.js';
import {
    services, feeBase, arrivalLabel, destinationsFor, destinationNote, crateCount, crateDepositBase,
    serviceFor, PARCEL_IMG
} from './utility-mail.js';
import { startProgress } from './utility-progress.js';
import {
    resolvePrice, resolvePurchasePrice, formatBase, purseValue, planSettlement, toBase, fromBase,
    negotiatedPrice, listPriceBase, baseDenomination
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
 * **How this person likes to read a shop, remembered on their own machine.**
 *
 * Three preferences, and they are all the same kind of thing: which way the shelves are
 * drawn, how the stock is ordered, how the pack is ordered. None is a fact about the shop —
 * two players at the same counter can want different answers, and neither answer is the
 * GM's to give.
 *
 * Which is why this is `localStorage` and not a setting. A world setting would make one
 * player's sort order everybody's; a per-user setting would be a document write every time
 * somebody pressed a sort button, broadcast to every client, to record something no other
 * client will ever read. The Blacksmith window base keeps its titlebar mode in exactly this
 * place for exactly this reason.
 *
 * **This is not the full-screen toggle**, which is deliberately *not* remembered: how a shop
 * opens is the GM's decision, per door, and a client that quietly reopened in the other mode
 * would be overruling them. A sort order overrules nobody.
 *
 * Everything is wrapped, because `localStorage` throws rather than returning null in a
 * browser that has it switched off, and a shop that will not open because somebody hardened
 * their browser would be a bad trade for remembering a sort order.
 */
const PREFS_KEY = `${MODULE.ID}-shop-view`;

function readPrefs() {
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
    } catch (_error) {
        return {};
    }
}

function writePref(key, value) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), [key]: value }));
    } catch (_error) {
        // A browser with storage switched off simply does not remember. Nothing else breaks.
    }
}


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
 * **Slate state lives at module scope, not on a class.**
 *
 * A shop is presented by two classes now -- the ordinary tool window and the fullscreen
 * surface -- and expanding is a *transition between them mid-shop*. A static declared in
 * the mixin below would be initialised once per subclass, so the half-filled cart a player
 * was looking at would vanish the instant they pressed Expand and reappear when they came
 * back. One map, two doors.
 */
const _sharedBaskets = new Map();
const _sharedCarts = new Map();
const _sharedPublished = new Map();
const _sharedPresence = new Map();

/**
 * Every shop window open on this client, of either kind.
 *
 * The tool base keeps a per-subclass registry keyed by uuid, and it is the right one for
 * "is this shop already open" -- but it cannot see the fullscreen surface, which is not a
 * tool window at all. Anything that refreshes *all* shops has to walk this instead, or a
 * player standing in an expanded shop stops being told about price changes.
 */
const _liveWindows = new Set();

/** True while a shop is moving between its two shells, so the door stays quiet. */
let _swapping = false;

/**
 * **The base classes come from the bridge, which is the supported path.**
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
// ==============================================================
// ===== PATCHING THE PAGE INSTEAD OF REPRINTING IT =============
// ==============================================================
//
// **Every gesture in this window ends in a full re-render, and that is fine. What is not
// fine is throwing the page away to show it.**
//
// Handlebars gives Foundry a freshly built element for the part and Foundry calls
// `replaceWith` on the old one. Correct, and violent: every node in the shop is destroyed
// and rebuilt, which means every `<img>` is a new element that has to fetch and decode its
// picture again. In a 740-pixel window of 32-pixel icons nobody notices. On a full-screen
// catalogue -- a wall of large images, one of which the user has just clicked "add" on --
// the whole wall blinks, and a layout built from the new nodes settles a frame later, so
// the panel jumps as well. Adding a thing to a slate should not repaint the shop.
//
// So instead of swapping the tree, we walk it: the same tag in the same place keeps its
// node and takes the new element's attributes, and only what genuinely differs is created
// or removed. An `<img>` whose `src` did not change is never touched, so it never reloads;
// scroll positions, focus and the caret survive because the elements holding them survive.
//
// Three things are deliberately preserved against the incoming markup:
//
// - **`data-merchant-bound`.** It is the guard that says "a listener is already on this
//   node". The node survives and so does its listener, so dropping the flag because the new
//   markup does not carry it would bind a second one on every render.
// - **A text field with no `value` attribute.** The search box renders empty every time and
//   is filled from `this._search`; taking the new element at its word would clear what
//   somebody is typing. A field the template *does* give a value is synced from it.
// - **Anything focused.** Never write to the element the caret is in.

/** Attributes that identify a node across renders, so a list can be matched by identity. */
const MORPH_KEYS = ['data-item-id', 'data-inventory-id', 'data-service', 'data-actor-uuid', 'id'];

/** What this node *is*, if it says. Null means "match me by position". */
function morphKey(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    for (const attribute of MORPH_KEYS) {
        const value = node.getAttribute(attribute);
        if (value) return `${node.nodeName}:${attribute}=${value}`;
    }
    return null;
}

/** Bring one element's attributes into line, keeping the binding flag. */
function morphAttributes(from, to) {
    for (const attribute of Array.from(from.attributes)) {
        // The listener is still attached to this node, so the flag is still true.
        if (attribute.name === 'data-merchant-bound') continue;
        if (!to.hasAttribute(attribute.name)) from.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(to.attributes)) {
        if (from.getAttribute(attribute.name) !== attribute.value) {
            from.setAttribute(attribute.name, attribute.value);
        }
    }
}

/**
 * Fields keep their *live* value, which attributes do not describe.
 *
 * A rendered `value="3"` is the field's default, and once a user has typed in a box the
 * browser stops keeping the two in step -- so a field has to be assigned to, not marked up.
 */
function morphFieldState(from, to) {
    if (from === document.activeElement) return;

    if (from instanceof HTMLInputElement) {
        if (from.type === 'checkbox' || from.type === 'radio') from.checked = to.checked;
        // No `value` in the markup means the template does not own this box: the search
        // field is rendered empty and filled from window state, and clearing it here would
        // wipe a query mid-keystroke on somebody else's purchase.
        else if (to.hasAttribute('value')) from.value = to.getAttribute('value');
    } else if (from instanceof HTMLTextAreaElement) {
        from.value = to.textContent ?? '';
    }
}

/** One node, in place. Recursive, through `morphChildren`. */
function morphNode(from, to) {
    if (from.nodeType !== Node.ELEMENT_NODE) {
        if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
        return;
    }

    morphAttributes(from, to);
    morphFieldState(from, to);

    // A textarea's value is its children; having just set it, walking them would undo it.
    if (from.nodeName === 'TEXTAREA') return;

    morphChildren(from, to);

    // After the options exist, and by assignment for the same reason fields are.
    if (from instanceof HTMLSelectElement && from !== document.activeElement) from.value = to.value;
}

/**
 * Line the children up, by identity where there is one and by position where there is not.
 *
 * Keyed matching is what makes a *changed list* cheap rather than merely a changed node:
 * when a row is bought and disappears everything below it shifts up, and matching by
 * position alone would rewrite every row after the gap -- including every image. With keys,
 * one row is removed and nothing else is touched.
 */
function morphChildren(from, to) {
    const pool = new Map();
    for (const child of from.childNodes) {
        const key = morphKey(child);
        if (key && !pool.has(key)) pool.set(key, child);
    }

    let cursor = from.firstChild;
    for (const next of Array.from(to.childNodes)) {
        const key = morphKey(next);
        const matched = key ? pool.get(key) : null;

        if (matched) {
            pool.delete(key);
            if (matched === cursor) cursor = cursor.nextSibling;
            else from.insertBefore(matched, cursor);
            morphNode(matched, next);
            continue;
        }

        // Unkeyed: the node in this position will do, as long as it is the same kind of
        // thing and is not itself somebody's keyed row waiting to be claimed.
        if (cursor && cursor.nodeType === next.nodeType && cursor.nodeName === next.nodeName
            && !morphKey(cursor)) {
            const here = cursor;
            cursor = cursor.nextSibling;
            morphNode(here, next);
            continue;
        }

        from.insertBefore(next, cursor);
    }

    // Whatever the new markup never reached is gone from the shop.
    while (cursor) {
        const spent = cursor;
        cursor = cursor.nextSibling;
        spent.remove();
    }
}

/**
 * A placed tile's coordinates, as the one inline style this window writes.
 *
 * Inline because it is *data*, not styling: where this tile sits is the output of the
 * layout and belongs to the tile, in the way a row's item id does. A stylesheet cannot
 * express it -- there is no rule that says "this one is at row three" -- and a class per
 * coordinate would be twelve classes saying what four numbers say.
 */
function gridStyle(entry) {
    if (!entry?.col || !entry?.row) return '';
    return `grid-column:${entry.col}/span ${entry.w};grid-row:${entry.row}/span ${entry.h}`;
}

const ShopBehaviour = (Base) => class extends Base {
    // One window per token, and the registry behind that, are the base class's:
    // `openFor`, `closeFor` and the registry behind them, keyed by uuid. Ours
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
    static _baskets = _sharedBaskets;

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
    static _carts = _sharedCarts;

    // `shopKey|shopperUuid` -> the last snapshot this client sent or received.
    // Set on both, which is what stops two clients bouncing the same slate back and
    // forth: a slate that arrives is already "published" as far as we are concerned.
    static _published = _sharedPublished;

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
    static _presence = _sharedPresence;

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
            // **A floor, not a ceiling.** A minimum is a real statement -- below 380 the
            // slate wraps under the stock and the window stops being usable -- but a
            // maximum was a number somebody picked, and it made a shop on a wide monitor
            // stop resizing for no reason the person dragging it could see. The height
            // bound is not a cap on stretching: it keeps the window on the screen.
            windowSizeConstraints: { minWidth: 380, minHeight: 320, maxHeight: 'calc(100vh - 40px)' },
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
        toggleExpand: (_event, _target, win) => void win.toggleExpand(),
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
        order: (_event, _target, win) => win.run(() => win.placeOrder()),
        chooseService: (_event, target, win) => win.setService(target.dataset.service),
        turnPage: (_event, target, win) => win.turnPage(Number(target.dataset.page)),
        toggleView: (_event, _target, win) => win.toggleView(),
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
        // **A subject may be a uuid rather than a document**, and that is not an edge case:
        // it is how a door onto a shop whose Actor has been deleted is opened at all. The
        // base class already accepts a string in `keyFor`; this used to read `.uuid` and
        // `.id` off it regardless, so an abandoned shop opened with no key of its own --
        // registered under the string, addressed as `undefined` by everything after.
        const key = typeof subject === 'string' ? subject : (subject?.uuid ?? null);
        opts.id ||= `merchant-shop-${(typeof subject === 'string' ? subject : subject?.id) ?? 'gone'}-${foundry.utils.randomID()}`;
        // **`new.target`, not `ShopWindow`.** Naming one shell here means the *other* one is
        // constructed with the tool window's frame, title and 740x600 as **instance**
        // options -- which beat its own `DEFAULT_OPTIONS` outright, so the fullscreen
        // surface rendered as a framed, titled, positioned window with the room painted
        // inside it. `new.target` is the class actually being built, which is the only
        // thing either shell should be reading its own defaults from.
        const defaults = new.target?.DEFAULT_OPTIONS ?? {};
        opts.position = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, defaults.position ?? {}),
            opts.position || {}
        );
        opts.window = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, defaults.window ?? {}),
            opts.window || {}
        );
        super(opts);
        // **Kept so the shop can be handed to the other shell.** Expanding is not a resize,
        // it is closing this window and opening the same shop as a fullscreen surface --
        // which needs the subject and the options it was built from, and a uuid string is
        // as valid a subject as a document.
        this._subject = subject;
        this._openOptions = options;
        this.shopKey = key;
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
        // **Which of the two shops this window is.** A catalogue view shows only catalogue
        // shelves and a shop window shows only the others, which is what stops mail order
        // being the shop by post. Carried on the window rather than derived, because it is a
        // fact about how the door was opened.
        this.catalogueMode = options.catalogue === true;
        this.service = DEFAULT_DELIVERY_SERVICE;
        // Where it goes and anything asked for on the way. Per window, not persisted: an
        // order is a thing you are filling in, and a half-written note is not worth keeping.
        this.destination = null;
        this.instructions = '';
        // Which spread is open. Per window and not persisted: a page is where you are in a
        // book you are holding, not a fact about the book.
        this._page = 0;
        // **List or tiles, and the two sort orders, as this person last left them.** A
        // catalogue is always tiles -- that is what a catalogue is -- so the stored view
        // says nothing about one.
        const prefs = readPrefs();
        this._tiles = prefs.tiles === true;
        // Not validated here: both getters resolve a key against their own list and fall
        // back to the first entry, so a stored sort from a build that had another one is
        // simply not found rather than being an error to handle.
        this._stockSort = prefs.stockSort;
        this._sellSort = prefs.sellSort;
        this.busy = false;
        // Per window and not persisted: a search is a thing you are doing right now,
        // and reopening a shop to find yesterday's filter still hiding most of the
        // stock would be a puzzle.
        this._search = '';
    }

    /**
     * Every shop window open on this client, of either shell.
     *
     * The tool base's own registry cannot see the fullscreen surface -- it is not a tool
     * window -- so anything that refreshes *all* shops has to walk this instead. Using the
     * tool registry here is how a player standing in an expanded shop stops being told
     * about a price change.
     */
    static allOpen() {
        return [..._liveWindows];
    }

    /** The open window for a shop, whichever shell it is wearing. */
    static liveWindowFor(shopKey) {
        return [..._liveWindows].find((win) => win.shopKey === shopKey) ?? null;
    }

    static refreshForToken(shopKey) {
        // `keyFor` takes a plain string as readily as a document, which is what lets
        // a socket message carrying only a uuid find its window.
        void this.liveWindowFor(shopKey)?.render(false);
    }

    /**
     * Refresh every open shop for one merchant, wherever its tokens are.
     *
     * Inventory changes are Actor-level, and a merchant can have tokens on several
     * scenes, so keying the refresh on a single token would miss the others.
     */
    static async refreshForActor(actorUuid) {
        for (const win of this.allOpen()) {
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
            // Still the window for this shop, and not one closed or swapped for the other
            // shell while the action was running.
            if (_liveWindows.has(this)) await this.render(false);
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
        writePref('stockSort', this._stockSort);
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
        writePref('sellSort', this._sellSort);
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
            for (const window of ShopWindow.allOpen()) {
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

        for (const window of ShopWindow.allOpen()) {
            if (window.shopKey === shopKey) void window.render(false);
        }
    }

    /** Drop a departing user's face rather than leaving a ghost in the room. */
    static dropUser(userId) {
        for (const [shopKey, room] of ShopWindow._presence) {
            if (!room.delete(userId)) continue;
            for (const window of ShopWindow.allOpen()) {
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
        for (const window of ShopWindow.allOpen()) {
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

        for (const window of ShopWindow.allOpen()) {
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
                total: unit === null ? null : unit * held,
                // Carried on the line because the crate arithmetic needs it and the row
                // has the item in hand; looking it up again in the context would mean
                // resolving every item a second time to ask one number.
                weight: Number(item.system?.weight?.value) || 0
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
            case 'NOT_A_CATALOGUE_ITEM': return game.i18n.localize('coffee-pub-merchant.refuse.notOrderable');
            case 'CATALOGUE_BY_ORDER_ONLY': return game.i18n.localize('coffee-pub-merchant.refuse.byOrderOnly');
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

            // **A warehouse is invisible to a customer and visible to the shopkeeper.** The
            // catalogue view shows only catalogue shelves and a player at the counter sees
            // none of them -- but the *GM* has to reach one to stock it, and the shop window
            // is where stocking happens: the drop zones, the compendium search, the restock
            // button and the tidy button are all here and none of them are in Settings. A
            // warehouse the GM could configure but never fill would be a shelf that only
            // worked by accident.
            const shelves = this.catalogueMode ? true : (isGM ? null : false);

            // Where the advertising has got to across every shelf of this shop, so the
            // second section starts where the first left off rather than printing the same
            // notice again.
            let adOffset = 0;

            inventories = MerchantManager
                .getInventories(merchant, { includeHidden: isGM, catalogue: shelves })
                .map(({ item: inventory, config }) => {
                const isUnpricedInventory = isUnpriced(config.type);
                // Shown to the GM at the counter, but not *sold* from there. See `canCart`.
                const isWarehouse = isCatalogue(config.type);
                const contents = MerchantManager.getInventoryContents(merchant, inventory).map((item) => {
                    // **No shopper: this is the shelf.** What is written on a shelf is what
                    // the shop asks, and an agreement is a thing two people reach at the
                    // counter -- it belongs on the slate, and the slate is where it shows.
                    // Pricing the shelf for whoever happens to be selected put one
                    // customer's discount back on the row for the room to read, and worse,
                    // masked the list price: an agreement wins outright, so a GM editing
                    // the shelf price of something already haggled watched the number
                    // refuse to change.
                    const price = resolvePrice(config0, config, item,
                        { reputation: this.reputation, market: this.market });
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
                        // The partial drops the whole column in a catalogue; this keeps a
                        // GM from being offered an editor for a figure that is not shown.
                        catalogue: this.catalogueMode,
                        // **Everything a card wall shows, and only when one is being drawn.**
                        // A counter row shows a name, a price and a count; a card shows what
                        // a page in a catalogue shows -- a picture, what the thing is, what
                        // it says about itself, what it costs and what it weighs. Built here
                        // rather than in the partial because reading a description off a
                        // document is not a thing a template should be doing.
                        ...(this.isTiled ? this._cardFields(item, price) : {}),
                        canEditStock: isGM && !stock.unlimited && !this.catalogueMode,
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
                        // **Never from the counter.** A warehouse row is on screen for the
                        // GM to stock, not to sell: nothing on a catalogue shelf changes
                        // hands where you are standing, and that rule does not have an
                        // exception for the person who owns the shop. In the catalogue view
                        // the same row carries the order button instead.
                        canCart: trading && Boolean(recipient) && inStock
                            && (isUnpricedInventory || price !== null)
                            && !(isWarehouse && !this.catalogueMode),
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
                    // Marked rather than merely absent from the slate: a GM looking at a
                    // shelf whose rows have no Add button needs to be told why, once, on the
                    // shelf rather than on every row.
                    warehouse: isWarehouse && !this.catalogueMode,
                    img: inventory.img,
                    hidden: config.visible === false,
                    canToggle: isGM,
                    collapsed: (_collapsed.get(this.shopKey) ?? new Set()).has(inventory.id),
                    canStock: isGM,
                    canRestock: isGM && MerchantManager.canRestock(merchant, inventory),
                    isUnpricedInventory,
                    categories,
                    // **Printed, in a catalogue.** The same rows, dealt out into spreads with
                    // the ragged end of each filled with the shop's own advertising -- which
                    // is what a real catalogue does with the last third of a page, and what
                    // makes a short page read as deliberate rather than as a layout that ran
                    // out. See `paginateCards`.
                    ...(this.catalogueMode ? { spread: this._spreadsFor(categories) } : {}),
                    // **Advertising in both shapes.** A wall packs and leaves gaps, so a
                    // notice fills one; a list has no gaps, so a notice interrupts it the
                    // way a classified interrupts a column of listings. Dealt per section
                    // and offset by where the last one ended, so a shop with four shelves
                    // does not print the same two adverts on every one of them.
                    // **Two shapes, two ways of filling them.** A wall is placed and its
                    // holes are cut to shape; a list has no holes, so a notice interrupts
                    // it every so many rows the way a classified interrupts a column of
                    // listings. Both walk the shop's copy from where the last shelf left
                    // off, so four shelves do not print the same two adverts on each.
                    ...(this.catalogueMode ? {} : {
                        categories: categories.map((category) => {
                            if (this._tiles) {
                                const wall = layoutWall(
                                    category.items.map((row) => ({ ...row, size: row.cardSize ?? 'small' })),
                                    { from: adOffset }
                                );
                                adOffset += wall.length - category.items.length;
                                return {
                                    ...category,
                                    items: wall.map((entry) => ({
                                        ...entry,
                                        isAd: entry.kind === 'filler',
                                        gridStyle: gridStyle(entry)
                                    }))
                                };
                            }

                            const rows = adsIntoList(category.items, { every: 7, offset: adOffset });
                            adOffset += rows.length - category.items.length;
                            return { ...category, items: rows };
                        })
                    }),
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
        // **The fee is part of what you pay, so it is part of the total.** It was shown as
        // its own line and then left out of the sum under it -- a ledger reading "-3 cp,
        // -5 gp, total -3 cp", which is the one thing a ledger may not do.
        //
        // No goods, no fee: nothing is being sent, and a delivery charge against an empty
        // slate is a number with nothing behind it.
        const deliveryFee = this.catalogueMode && cartLines.length ? feeBase(this.service) : 0;
        // **What the boxes cost, before the order rather than after it.** How many crates an
        // order needs is arithmetic on the weight of the goods -- the same arithmetic the
        // GM side charges on -- so a slate that has just grown an anvil says so with a
        // second box on this line rather than with a surprise at the counter.
        const crates = this.catalogueMode && cartLines.length
            ? crateCount(cartLines.map((line) => ({
                quantity: line.quantity,
                source: { system: { weight: { value: line.weight } } }
            })))
            : 0;
        const deposit = crates * crateDepositBase();
        const net = cartTotal + deliveryFee + deposit - basketTotal;

        // **Resolved once, used twice.** The card sets it as a CSS custom property and the
        // fullscreen shell hands the same path to Blacksmith as its backdrop. Working it
        // out separately in each place is two answers to "which picture is this shop
        // wearing", which is one more than the question has.
        const illustration = illustrationUrl(missing ? this.remembered?.illustration : config?.illustration);
        this._illustration = illustration || null;

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
            illustration,
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
            // **Which of the two shops this is**, and everything the catalogue view needs
            // that the counter does not: the fee for the service chosen, and the three
            // services to choose between.
            catalogue: this.catalogueMode,
            // The wall, and the control that asks for it. A catalogue is always a wall and
            // never offers the choice: a printed catalogue that could be shown as a list
            // would not be a catalogue.
            tiled: this.isTiled,
            viewIcon: this._tiles ? 'fa-solid fa-list' : 'fa-solid fa-grip',
            viewTooltip: game.i18n.localize(this._tiles
                ? 'coffee-pub-merchant.shop.viewList'
                : 'coffee-pub-merchant.shop.viewTiles'),
            feeLabel: formatBase(deliveryFee + deposit),
            crates,
            // **What the delivery is made of, as lines rather than as a subtotal.** The
            // ledger above says what leaves the purse; this says what it buys. Two things
            // are being paid for and they are not the same kind of thing -- a courier's
            // time and a physical box the party will be holding afterwards -- and a single
            // "Delivery" figure covering both is where a crate deposit goes unnoticed
            // until it turns up as a crate.
            //
            // Not slate lines: nothing here can be re-priced, re-counted or removed. The
            // way to change this row is to choose a different service or buy less.
            deliveryLines: this.catalogueMode && cartLines.length
                ? [
                    {
                        icon: serviceFor(this.service).icon,
                        name: serviceFor(this.service).name,
                        note: arrivalLabel(arrivalTime(game.time?.worldTime ?? 0, serviceFor(this.service).days)),
                        totalLabel: formatBase(deliveryFee)
                    },
                    {
                        img: PARCEL_IMG,
                        name: game.i18n.localize('coffee-pub-merchant.delivery.crateName'),
                        quantity: crates,
                        note: game.i18n.localize('coffee-pub-merchant.delivery.crateNote'),
                        totalLabel: formatBase(deposit)
                    }
                ]
                : [],
            destinations: this.catalogueMode ? this._destinationOptions() : null,
            destinationNote: this.catalogueMode
                ? destinationNote(this.service, destinationsFor(this.service))
                : '',
            instructions: this.instructions,
            deliveryServices: this.catalogueMode
                ? services().map((service) => ({
                    key: service.key,
                    name: service.name,
                    icon: service.icon,
                    // **The terms are not on the button.** The fee shows on the ledger the
                    // moment a service is chosen, which is where every other number in this
                    // window is read, and a button carrying its own price competes with the
                    // total rather than adding to it. The tooltip still says what it is.
                    hint: `${game.i18n.localize(service.hintKey)} — ${formatBase(toBase(service.feeGp, 'gp'))}, ${service.days}d`,
                    on: service.key === this.service
                }))
                : [],
            cartTotalLabel: formatBase(cartTotal),
            hasAnything: cartLines.length > 0 || basketLines.length > 0,
            // The running total, in the direction it actually runs. "You pay" and
            // "You receive" are different sentences and a shopper should not have to
            // work out which one a bare number is.
            // A total you are owed is written with a sign rather than a colour, so
            // the direction survives every theme and does not depend on seeing one.
            netTotalLabel: (net < 0 ? '+' : '\u2212')
                + formatBase(Math.abs(net)),
            // Paying out and taking in are different events, and the colour says
            // which before the figure is read.
            netDirection: net > 0 ? 'pay' : net < 0 ? 'receive' : 'even',
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
            // **A catalogue never sells.** It is a book of what a shop will send you, and
            // there is no counter to hand something across — so the Buy/Sell pair goes with
            // the tab it was switching between.
            canSell: !this.catalogueMode && !missing && Boolean(this._purchasedInventory(merchant)),
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
        // `net` is the one computed with the ledger above -- delivery included, which is
        // what the button is about to take. A second `cartTotal - basketTotal` here quoted
        // a figure the ledger three inches away disagreed with.
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
                ${this.catalogueMode
                    ? `<button type="button" class="blacksmith-window-btn-primary merchant-shop-settle"
                            data-action="order"
                            data-tooltip="${game.i18n.localize('coffee-pub-merchant.delivery.orderTooltip')}">
                        <i class="fa-solid fa-box-open"></i> ${game.i18n.localize('coffee-pub-merchant.delivery.order')}
                    </button>`
                    : `<button type="button" class="blacksmith-window-btn-primary merchant-shop-settle"
                            data-action="settle" data-tooltip="${settleTooltip}">
                        <i class="fa-solid fa-scale-balanced"></i> Complete Transaction
                    </button>`}`
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
        // **Everyone, not just the GM.** The whole reason this is a per-client toggle
        // rather than a shop setting is that a player with a big monitor should get it
        // too, and a GM ticking a box on their ultrawide should not decide it for them.
        const actions = [{
            id: 'merchant-expand',
            icon: this.isExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand',
            label: this.isExpanded ? 'Leave Full Screen' : 'Full Screen',
            onClick: () => void this.toggleExpand()
        }, {
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
            ...(this.canBePrinted ? [{
                // The same *linked* gate as the pin, and for the same reason: a catalogue
                // outlives tokens and scenes, so what it names has to. Not the same
                // availability gate -- printing needs no pins API, only an Actor.
                id: 'merchant-catalogue',
                icon: 'fa-solid fa-scroll',
                label: 'Print a Catalogue',
                onClick: () => void this.printCatalogue()
            }] : []),
            {
                // **The GM's own way into the catalogue.** Until now the only door was an
                // Item in a player's pack, so a GM stocking a catalogue shelf could not see
                // what they were stocking without borrowing a character. Toggles in place
                // rather than opening a second window: it is the same shop, and one window
                // per shop is the rule everywhere else.
                id: 'merchant-view-catalogue',
                icon: this.catalogueMode ? 'fa-solid fa-shop' : 'fa-solid fa-book-open',
                label: this.catalogueMode ? 'View the Counter' : 'View the Catalogue',
                onClick: () => void this.toggleCatalogueView()
            },
            {
                id: 'merchant-transit',
                icon: 'fa-solid fa-wagon-covered',
                label: 'Orders in Transit',
                onClick: () => void MerchantManager.openDeliveries()
            },
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
        _liveWindows.add(this);
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
        if (_swapping) return;
        const { actor } = await this._resolveSubject();
        playFeedback(which, actor ? MerchantManager.soundFor(actor, which === SOUND.WINDOW_OPEN ? 'open' : 'close') : null);
    }

    /**
     * Patch the rendered part into the page rather than replacing it. See `morphNode`.
     *
     * Only for a re-render: the first one has nothing to patch into, and a shape this does
     * not recognise -- a part that renders as the content element itself, which neither base
     * uses today -- is handed straight back to Foundry rather than guessed at.
     */
    _replaceHTML(result, content, options) {
        const pairs = [];
        for (const [partId, next] of Object.entries(result)) {
            const prior = content.querySelector(`[data-application-part="${partId}"]`);
            if (!prior) return super._replaceHTML(result, content, options);
            pairs.push([partId, prior, next]);
        }

        for (const [partId, prior, next] of pairs) {
            morphNode(prior, next);
            // The prior element is the live one, so listeners belong on it. Foundry's own
            // record of which element is the part is private and still holds the element
            // from the first render -- which is this one, and still the right answer.
            this._attachPartListeners(partId, prior, options);
        }
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
        // The destination and the note, bound where every other field in this window is.
        const where = this.element?.querySelector('[data-delivery-where]');
        if (where && where.dataset.merchantBound !== 'true') {
            where.dataset.merchantBound = 'true';
            where.addEventListener('change', (event) => { this.destination = event.target.value; });
        }

        const note = this.element?.querySelector('[data-delivery-instructions]');
        if (note && note.dataset.merchantBound !== 'true') {
            note.dataset.merchantBound = 'true';
            // On input rather than change: this is not written to a document, so there is
            // nothing to batch, and a note lost because somebody pressed Place Order without
            // blurring first would be the worst possible way to find that out.
            note.addEventListener('input', (event) => { this.instructions = event.target.value ?? ''; });
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
     * Whether a catalogue could be printed of this shop.
     *
     * The linked test, without the pins one. A catalogue is an Item in this world and
     * needs nothing of Blacksmith to exist, so a world with no pins API still gets the
     * door that does not need a map.
     */
    get canBePrinted() {
        if (!game.user.isGM) return false;
        let subject = null;
        try {
            subject = fromUuidSync(this.shopKey);
        } catch (_error) {
            return false;
        }
        return subject?.documentName === 'Actor' && canPrint(subject);
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

    /** Whether this shell is the fullscreen one. Set by the concrete class, not asked. */
    get isExpanded() {
        return this.constructor.IS_EXPANDED === true;
    }

    /**
     * Move this shop between its two shells.
     *
     * **Not a resize.** The ordinary window and the fullscreen surface are two Application
     * classes with two different frames, so expanding closes one and opens the other on the
     * same subject. Everything that makes it feel like one shop rather than two survives it
     * for free: the slate, the basket and the presence maps live at module scope precisely
     * so a half-filled cart is still there on the other side.
     *
     * **Nothing is written down.** This changes the shell you are in, not how the shop
     * opens: that is the merchant's answer, per door, and the next time you open this shop
     * it opens the way the GM said it does. Pressing Leave Full Screen is "not right now",
     * which is a different sentence from "never show me this shop that way again".
     */
    async toggleExpand() {
        const next = !this.isExpanded;
        const subject = this._subject;
        const options = this._openOptions;

        // **No door slam on the way through.** Closing one shell and opening the other
        // would play the closing sound and then the opening one, every time somebody
        // pressed the button -- which is the shop announcing a change of window rather
        // than a change of room. The flag spans both instances because they are two
        // objects, and it is cleared in a `finally` so a failed render cannot leave the
        // module silent.
        _swapping = true;
        try {
            await this.close();
            // **`openWindowed`, not `openFor`.** `ShopWindow.openFor` is the router, and the
            // door this shop was opened through has not changed -- so leaving full screen
            // asked the router the same question it had already answered and was sent
            // straight back. The toggle is the one caller that has decided which shell it
            // wants, and it is the one that must not be routed.
            await (next
                ? ShopFullscreenWindow.openFor(subject, options)
                : ShopWindow.openWindowed(subject, options));
        } finally {
            _swapping = false;
        }
    }

    /**
     * The extra a card carries over a row.
     *
     * **A presentation, not a catalogue feature.** Nothing here knows what a catalogue is:
     * it is the fields a card wall needs, and the wall is switched on for the catalogue
     * today because that is the view that wanted one. A shelf setting could turn it on for
     * any section later without touching this.
     *
     * `size` is what gives masonry something to pack. See `cardSize`.
     */
    _cardFields(item, price) {
        const rarityKey = itemRarity(item);
        const listed = listPriceBase(item);
        const weight = Number(item?.system?.weight?.value);

        return {
            card: true,
            cardSize: cardSize(rarityKey, (price ?? listed ?? 0) / (baseDenomination().conversion || 1)),
            blurb: cardBlurb(item?.system?.description?.value),
            // A weightless thing says nothing rather than "0 lb", which is a fact about the
            // data rather than about the object.
            weightLabel: Number.isFinite(weight) && weight > 0
                ? `${weight} ${item?.system?.weight?.units ?? 'lb'}`
                : ''
        };
    }

    /**
     * Show the shelves as a wall of tiles, or as a list.
     *
     * **The same shelves either way.** Nothing is filtered, nothing is paged, and the
     * sections keep their headings and their counts -- what changes is the shape of a row.
     * A list is for finding a named thing among sixty; a wall is for browsing what a shop
     * has, which is a different question and was previously only answerable by printing a
     * catalogue of it.
     *
     * No pages here, unlike the catalogue. A catalogue is a printed object and a page is
     * what it is made of; a shelf is a shelf, and paginating one would mean hiding stock
     * behind a control in a window whose whole job is showing what is in the shop.
     */
    toggleView() {
        this._tiles = !this._tiles;
        writePref('tiles', this._tiles);
        void this.render(false);
    }

    /** Whether the shelves are drawn as tiles: a catalogue always is, a shop when asked. */
    get isTiled() {
        return this.catalogueMode || this._tiles;
    }

    /** Turn to a spread. Clamped, so a stale button on a shortened catalogue lands somewhere. */
    turnPage(page) {
        this._page = Math.max(0, Number(page) || 0);
        void this.render(false);
    }

    /**
     * Deal a shelf's categories out into printed spreads.
     *
     * **Flattened first.** On a counter, categories are containers: a heading with its rows
     * beneath it, and the next heading starts wherever the last list ended. On a page they
     * are simply things that appear in order, and a heading is an entry costing room like
     * anything else -- otherwise a category boundary would force a page break and a
     * catalogue of eight categories would be eight pages of three items.
     *
     * The page is clamped rather than reset when the catalogue shortens under it: somebody
     * on page four of a shelf a GM has just cleared should land on the last page, not be
     * thrown to the front.
     */
    _spreadsFor(categories) {
        // **No category headings on a page.** A tiled page has no column for one to sit
        // above -- a heading spanning three columns would eat a whole row and break the
        // packing under it -- and a printed catalogue does not have them either: the goods
        // are laid out to be looked at, and the sorting is what the order of the pages is
        // for. Categories still group the counter list, which is where they earn their keep.
        const stream = [];
        for (const category of categories) {
            for (const item of category.items) {
                stream.push({ kind: 'item', size: item.cardSize ?? 'small', item });
            }
        }

        const pages = paginateCards(stream);
        const page = Math.min(this._page, Math.max(0, pages.length - 1));
        this._page = page;

        return {
            // **Flags rather than a `kind` string compared in the template.** Handlebars has
            // no comparison of its own and Merchant registers no helpers, so a branch on a
            // string would depend on whatever Foundry happens to ship -- which is a thing to
            // find out from a blank page in a shop rather than from a test.
            entries: (pages[page] ?? []).map((entry) => ({
                ...entry,
                isFiller: entry.kind === 'filler',
                // **The position, written onto the tile.** The layout decided where every
                // tile goes and filled what was left; letting the browser place them again
                // from spans alone would be a second opinion, and the holes the fillers
                // were cut for would move out from under them.
                //
                // On the *item*, because that is what the row partial is handed -- the
                // entry around it is this function's bookkeeping and never reaches a
                // template.
                gridStyle: gridStyle(entry),
                item: entry.item ? { ...entry.item, gridStyle: gridStyle(entry) } : entry.item
            })),
            page: page + 1,
            pageCount: pages.length,
            prevPage: page - 1,
            nextPage: page + 1,
            hasPrev: page > 0,
            hasNext: page < pages.length - 1,
            paged: pages.length > 1
        };
    }

    /** Which service this order goes by. Per window: it is a choice about this order. */
    setService(key) {
        if (!key) return;
        this.service = key;
        // **The destination does not survive the service.** A depot is not a portal ring, so
        // a place chosen for one is not a place the other goes; keeping it would leave a
        // Portal order addressed to a coaching inn.
        this.destination = null;
        void this.render(false);
    }

    /**
     * Everywhere this order could go, with one of them chosen.
     *
     * `null` for a service that asks nowhere -- the beast triangulates on the receipt -- so
     * the template can tell "no destination is needed" from "no destination exists", which
     * are different sentences and want different words.
     */
    _destinationOptions() {
        const places = destinationsFor(this.service);
        if (places === null) return null;
        // The first is the default rather than a blank row: an order with nowhere to go is
        // not a state worth being able to reach through the picker.
        if (!this.destination && places.length) this.destination = places[0];
        return places.map((place) => ({
            value: place,
            label: place,
            selected: place === this.destination
        }));
    }

    /**
     * Place the order: pay now, and the goods come later.
     *
     * The client says what it wants and which service; **the GM prices it, adds the fee from
     * the world setting, and decides**. Nothing here is trusted on the other side, which is
     * the same rule every other thing that moves money in this module follows.
     */
    async placeOrder() {
        const merchant = (await this._resolveSubject()).actor;
        const shopper = this.recipient;
        if (!merchant || !shopper) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.cart.noBuyer'));
            return;
        }
        const lines = [...this.cart].map(([itemId, quantity]) => ({ itemId, quantity }));
        if (!lines.length) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.refuse.catalogueEmpty'));
            return;
        }

        const result = await MerchantManager.request({
            order: true,
            shopKey: this.shopKey,
            sceneUuid: this.sceneUuid,
            shopperUuid: shopper.uuid,
            service: this.service,
            destination: this.destination,
            instructions: this.instructions,
            buy: lines
        });

        if (!result?.ok) {
            notify.error(this._explain(result?.code, result));
            return;
        }

        // **The same shape as a purchase receipt**, because it is one: money has moved and
        // this is the only record of what for until the parcel lands. Persistent, with the
        // shop's own face on it and the whole order underneath -- what was bought, how it is
        // coming, where to, and when. The plain one-line toast this replaced said the shop
        // and the day and left the rest to be remembered.
        const ordered = [...this.cart].map(([itemId, quantity]) => {
            const row = merchant.items.get(itemId);
            return row ? `${row.name} x${quantity}` : null;
        }).filter(Boolean).join(', ');

        this.cart.clear();
        this.instructions = '';
        notify.receipt(
            game.i18n.format('coffee-pub-merchant.delivery.ordered', {
                shop: result.shop ?? merchant.name,
                arrival: arrivalLabel(result.arrivesAt)
            }),
            [ordered, result.service, this.destination || null, formatBase(result.total)]
                .filter(Boolean).join(' • '),
            this._illustration || merchant.img
        );
        await this.render(false);
    }

    /**
     * Show this shop's catalogue, or its counter.
     *
     * **The same window, in the other view.** A catalogue is not a different shop: it is
     * the warehouse shelves instead of the counter shelves, priced the same way and slated
     * the same way. Opening a second window for it would mean two slates for one shop,
     * which is the bug the one-window-per-subject rule exists to prevent.
     *
     * The slate is cleared on the way through, and that is not tidiness: an order refuses
     * any line that did not come off a catalogue shelf and a settlement refuses any line
     * that did, so a slate carrying both is a slate that can only fail. Better to lose two
     * clicks than to hand somebody a checkout that cannot work and no reason why.
     */
    toggleCatalogueView() {
        if (!game.user.isGM) return;
        this.catalogueMode = !this.catalogueMode;
        this._page = 0;
        if (this.cart.size) {
            this.cart.clear();
            notify.info(game.i18n.localize('coffee-pub-merchant.shop.slateClearedForView'));
        }
        void this.render(false);
    }

    /** Put a pin for this shop on the scene being looked at. */
    async pinShop() {
        if (!game.user.isGM) return;
        const { actor } = await this._resolveSubject();
        if (actor) await MerchantManager.pinShop(actor);
    }

    /** Print a catalogue of this shop into the world Items directory. */
    async printCatalogue() {
        if (!game.user.isGM) return;
        const { actor } = await this._resolveSubject();
        if (actor) await MerchantManager.printCatalogue(actor);
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
            _liveWindows.delete(this);
            this.clearPresence();
            clearTimeout(this._sellSearchTimer);
            void this._playDoor(SOUND.WINDOW_CLOSE);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not clean up on close:`, error);
        }
        return super._onClose?.(options);
    }
};

/**
 * The shop as an ordinary window: framed, movable, minimisable, one per shop.
 *
 * The default, and what a token, a pin, a region or a catalogue opens -- unless this client
 * left that shop full screen, which `openFor` honours below.
 */
export class ShopWindow extends ShopBehaviour(BlacksmithToolWindowBaseV2) {
    static IS_EXPANDED = false;

    /**
     * Open the ordinary window, whatever the merchant says.
     *
     * The escape hatch out of the router above, and the only caller is the toggle: somebody
     * pressing Leave Full Screen has already decided which shell they want, and asking the
     * merchant again would return them to the one they just left.
     *
     * `super.openFor` is the tool base's, which is the registry and nothing else.
     */
    static async openWindowed(subject, options = {}) {
        return super.openFor(subject, options);
    }

    /**
     * Open a shop in the shell the merchant says it opens in.
     *
     * **The GM's setting is the setting, every time.** *How you arrived* is part of how a
     * shop should be presented, and the four doors are genuinely different: walking into a
     * region is being in the place; clicking a token is a shopkeeper on a map you are still
     * using; a pin is a mark on that same map; a catalogue is a book in your pack. A
     * merchant answers each separately, and that answer decides.
     *
     * **Nothing is remembered per client, and that is deliberate.** An earlier version
     * stored what each person last left a shop as, and let it beat the merchant. It was the
     * wrong model: pressing Leave Full Screen is *"not right now"*, not *"never show me
     * this shop that way again"* — and a GM who dresses a shop and points a region at it
     * would find half the table never seeing it, for a reason none of them could see. The
     * toggle stays: it changes the shell you are in, for as long as you are in it.
     *
     * **The routing lives here rather than at five call sites.** A token, a pin, a region, a
     * catalogue and Merchant Settings all open a shop through this, and none of them has to
     * know the rule — they only have to say which door they are.
     */
    static async openFor(subject, options = {}) {
        const key = this.keyFor(subject);

        // `fromUuidSync` because this decides which class to construct and cannot await on a
        // document that is already in memory by the time any door is opened.
        let config = null;
        try {
            const resolved = key ? fromUuidSync(key) : null;
            const actor = resolved?.documentName === 'Token' ? resolved.actor : resolved;
            config = MerchantManager.getConfig(actor);
        } catch (_error) {
            config = null;
        }

        if (opensFullScreen(config?.fullscreen, options.door ?? 'token')) {
            return ShopFullscreenWindow.openFor(subject, options);
        }
        return super.openFor(subject, options);
    }
}

/**
 * The shop as a surface: edge to edge, no frame, the illustration as the room.
 *
 * **Blacksmith's fullscreen base, not a big window of ours.** The first version of Expand
 * measured the free rectangle between the sidebar and the hotbar and resized the tool
 * window into it, then imitated a takeover in CSS -- which is *maximise*, something anybody
 * can already do by dragging a corner, and it looked it. The hub already owns this
 * presentation: the covering, the blocking, the stacking, escape-to-dismiss, the fade, and
 * a backdrop layer built for exactly this. Request a Roll's cinematic is the same class.
 *
 * `full` of the four layouts, because a shop is not a panel on a surface -- it *is* the
 * surface. The header is off: the shop card says whose shop this is, better than a title
 * bar would, and the way back out is the toggle in the action bar.
 *
 * **One class body, two bases.** Everything a shop does -- the slate, the drop zones, the
 * price editors, the search, the presence mirror, twenty-five action handlers -- is in the
 * mixin above and is not written twice. What differs between the two is here, and it comes
 * to a few dozen lines.
 */
export class ShopFullscreenWindow extends ShopBehaviour(BlacksmithFullscreenWindowBaseV2) {
    static IS_EXPANDED = true;

    /**
     * The tool base's registry is a tool base thing, so this shell brings its own.
     *
     * Thinner than theirs on purpose: the hub already guarantees one fullscreen surface at
     * a time across every module, so "is one of ours already open" is the only question
     * left and `_liveWindows` answers it.
     */
    static keyFor(target) {
        return typeof target === 'string' ? (target || null) : (target?.uuid ?? null);
    }

    static async openFor(subject, options = {}) {
        const key = this.keyFor(subject);
        if (!key) return null;

        const existing = [..._liveWindows].find((win) => win.isExpanded && win.shopKey === key);
        if (existing) {
            await existing.render(true);
            return existing;
        }

        // Named rather than `new this(...)`: the same thing, and it does not read as a
        // call to `this` to anything scanning this file.
        const Shell = this;
        const created = new Shell(subject, options);
        await created.render(true);
        return created;
    }

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, BlacksmithFullscreenWindowBaseV2.DEFAULT_OPTIONS ?? {}),
        {
            // **`blacksmith-window-fullscreen` stays.** `mergeObject` overwrites arrays
            // rather than concatenating, so listing only ours would drop the class that
            // makes the surface cover and block at all -- the shop would render as an
            // unstyled block in the corner of the screen.
            // **Three classes; a fourth was tried and cannot work.** `blacksmith-window-fullscreen`
            // is what makes the surface cover and block; the other two are ours.
            //
            // `blacksmith-window-tool` was added here to borrow its `--blacksmith-tool-*`
            // palette, which the shop's stylesheet reads ten of. It does nothing: the tool
            // shell declares those under `.application.blacksmith-window-tool`, and a
            // **frameless** application never gets the `application` class -- which is why
            // the hub's own fullscreen rules are written as a bare `.blacksmith-window-fullscreen`.
            // The palette is declared for this surface in `window-shop.css` instead.
            classes: ['blacksmith-window-fullscreen', 'merchant-shop-window', 'merchant-shop-fullscreen'],
            // **A panel on the picture, not the shop painted straight onto it.** `full`
            // hands you the whole surface with no chrome, which read as shop rows floating
            // unreadably over a scene. `centered` is the shape this actually wants: the art
            // edge to edge behind, and the shop on a ground of its own in the middle of it.
            fullscreenLayout: BLACKSMITH_FULLSCREEN_LAYOUTS.CENTERED,
            showCloseButton: true,
            dismissOnEscape: true,
            // A stray click on the art either side of the panel is not a decision to leave.
            dismissOnBackdrop: false
        }
    );

    /**
     * The room, handed to the hub rather than drawn by us.
     *
     * **A getter, not a write to `options`.** The obvious move is to set
     * `this.options.fullscreenBackdrop` once the illustration is known, and it throws:
     * ApplicationV2 freezes `options`. The base reads the backdrop through this getter on
     * every render, which is exactly the hook for a value that arrives late.
     *
     * `cover` fills the screen -- the image is cropped rather than letterboxed, which is
     * what a room should do. The colour is a heavy black wash under the picture, so the
     * shop's own furniture stays legible over any illustration a GM points at, and `blur`
     * softens the little of the table that still shows through. Note that `blur` is a
     * *backdrop* filter on the surface and does not touch the picture; softening the
     * illustration itself would be `imageBlur`, a separate knob deliberately not used.
     *
     * A shop with no illustration returns nothing and keeps the hub's default scrim, which
     * is the glass the window already uses. The undressed case is not special-cased; it
     * simply has no picture.
     */
    get fullscreenBackdrop() {
        if (!this._illustration) return {};
        return {
            image: this._illustration,
            fit: BLACKSMITH_FULLSCREEN_FITS.COVER,
            color: 'rgba(0, 0, 0, 0.8)',
            opacity: 0.5,
            blur: 5
        };
    }

    /**
     * **The ✕ and Escape leave the surface; they do not close the shop.**
     *
     * `onDismiss` exists for exactly this and is documented for exactly this reason: it is
     * the *viewer asked for this to go away* path, distinct from `close()`, which is every
     * other route -- a socket, a timer, the manager closing a shop whose merchant was
     * deleted. Hooking `close()` instead would catch all of those too.
     *
     * A player who came in through a token expects to still be in the shop after pressing
     * Escape, so both controls do what the button in the action bar does. Losing a
     * half-built slate to a keypress would be the worst possible reading of them, which is
     * why the first version turned both off -- and turning off the way out of a takeover is
     * a worse answer than pointing it somewhere sensible.
     *
     * @param {'escape'|'close-button'|'backdrop'} _reason
     */
    async onDismiss(_reason) {
        await this.toggleExpand();
    }

    async _prepareContext(options = {}) {
        const context = await super._prepareContext(options);

        // The footer the tool window draws in its own bar is the action bar here. Same
        // buttons, same handlers, different zone names -- so `getData` states it once and
        // this maps it rather than the shop knowing which shell it is in.
        context.showActionBar = true;
        context.actionBarRight = context.toolFooterRight ?? '';
        context.showHeader = false;

        // **The way out, spelled out.** The ✕ and Escape do the same thing, but a control
        // that says what it does beats one a viewer has to guess at -- and this one has to
        // be distinguishable from Cancel beside it, which leaves the shop entirely.
        //
        // The button classes and `data-action` routing are the hub's documented contract for
        // action-bar content, not a convention of ours: `blacksmith-window-btn-secondary`
        // with a `data-action` that names an entry in `ACTION_HANDLERS`.
        context.actionBarLeft = `
            <button type="button" class="blacksmith-window-btn-secondary" data-action="toggleExpand">
                <i class="fa-solid fa-compress"></i> ${game.i18n.localize('coffee-pub-merchant.shop.leaveFullScreen')}
            </button>${context.toolFooterLeft ?? ''}`;
        return context;
    }
}
