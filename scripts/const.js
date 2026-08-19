// ==================================================================
// ===== MERCHANT CONSTANTS =========================================
// ==================================================================

const moduleData = {
    id: "coffee-pub-merchant",
    title: "Coffee Pub Merchant",
    version: "13.0.0",
    authors: [{ name: "COFFEE PUB" }]
};

export const MODULE = {
    ID: moduleData.id,
    NAME: "MERCHANT",
    TITLE: moduleData.title,
    VERSION: moduleData.version,
    AUTHOR: moduleData.authors[0]?.name || "COFFEE PUB",
    APIVERSION: "13.0.0"
};

// Merchant state lives on the **Actor**, never the Token. A shop is a persistent
// entity: flagging the token would make every placed instance a separate shop and
// lose the configuration when the token is deleted. See plans/plan-merchant.md
// section 6 — this is the sharpest divergence from Curator's corpse looting and the
// one most likely to be got wrong out of habit.
export const MERCHANT_FLAG = 'merchant';

// ==================================================================
// ===== STOCK POLICY ===============================================
// ==================================================================
//
// **Stock is a count, not a document.** Every policy grants the buyer a *copy* and
// adjusts a number on the merchant's own item; nothing is ever moved off a shelf by
// a sale. That is what lets a sold-out row stay on the shelf marked out of stock
// instead of vanishing -- which finite stock merely prefers and restocking stock
// requires, since a row that has been deleted is not a row anything can restock.
//
// The count is `system.quantity` rather than a flag of ours. A flag would be a
// parallel truth: the moment a GM edits quantity on the Actor sheet -- which they
// will, because that is where quantity has always lived -- the two disagree and one
// of them is silently wrong.

export const STOCK = Object.freeze({
    INFINITE: 'infinite',
    FINITE: 'finite',
    RESTOCKING: 'restocking'
});

/**
 * What a restocking shelf refills *to*.
 *
 * Not a separate editor. A GM setting a quantity by hand in the shop window sets
 * both the count and the par, so the rule is "what I keep six of, I restock to six".
 * A purchase lowers the count and leaves par alone.
 */
export const PAR_FLAG = 'par';

/** Days between restocks when a shelf does not say otherwise. */
export const DEFAULT_RESTOCK_DAYS = 1;

/**
 * Seconds in an in-world day, from the calendar rather than assumed.
 *
 * Foundry calendars may define something other than 24/60/60, and a shop on a
 * calendar with 20-hour days should restock on *its* days.
 */
export function secondsPerDay() {
    const days = game.time?.calendar?.days;
    const hours = Number(days?.hoursPerDay);
    const minutes = Number(days?.minutesPerHour);
    const seconds = Number(days?.secondsPerMinute);
    const value = (Number.isFinite(hours) && hours > 0 ? hours : 24)
        * (Number.isFinite(minutes) && minutes > 0 ? minutes : 60)
        * (Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
    return value;
}

// ==================================================================
// ===== SHOP KIND ==================================================
// ==================================================================
//
// What sort of shop this is. Flavour rather than mechanism — nothing keys off it,
// and a weaponsmith with a shelf of potions is a perfectly good shop. It replaces
// the word "Merchant" above the name, which was telling the player something they
// could already see.
//
// Deliberately a short list. Anything longer becomes a taxonomy nobody agrees with,
// and the GM already has a free-text description for "and also a fence".

export const SHOP_KINDS = Object.freeze([
    { key: 'general', label: 'General Store', icon: 'fa-solid fa-shop' },
    { key: 'weapons', label: 'Weaponsmith', icon: 'fa-solid fa-gavel' },
    { key: 'armor', label: 'Armorer', icon: 'fa-solid fa-shield-halved' },
    { key: 'alchemy', label: 'Apothecary', icon: 'fa-solid fa-flask' },
    { key: 'magic', label: 'Arcanist', icon: 'fa-solid fa-wand-sparkles' },
    { key: 'provisions', label: 'Provisioner', icon: 'fa-solid fa-wheat-awn' },
    { key: 'tools', label: 'Smith & Tools', icon: 'fa-solid fa-screwdriver-wrench' },
    { key: 'jewelry', label: 'Jeweller', icon: 'fa-solid fa-gem' },
    { key: 'books', label: 'Bookseller', icon: 'fa-solid fa-book' },
    { key: 'tavern', label: 'Tavern', icon: 'fa-solid fa-beer-mug-empty' },
    { key: 'stable', label: 'Stables', icon: 'fa-solid fa-horse' },
    { key: 'exotic', label: 'Curiosities', icon: 'fa-solid fa-hat-wizard' }
]);

export const DEFAULT_SHOP_KIND = 'general';

/** The kind's label and icon, falling back to the default rather than to nothing. */
export function shopKind(key) {
    return SHOP_KINDS.find((kind) => kind.key === key)
        ?? SHOP_KINDS.find((kind) => kind.key === DEFAULT_SHOP_KIND);
}

// ==================================================================
// ===== SHELVES ====================================================
// ==================================================================
//
// A shelf is a container Item on the merchant carrying this flag. Its contents are
// the stock; anything on the Actor outside a shelf is the shopkeeper's own gear and
// is never for sale.
//
// **One schema, several presets — not several types.** Every use case raised so far
// differs only in visibility, markup, and mode: a back room is hidden, premium is a
// markup, barter is a mode, buyback is a mode with a rate. Hard-coding five kinds
// would leave the sixth idea — seasonal stock, faction-only, consignment — with
// nowhere to go, so the presets below are data rather than code paths.

export const SHELF_FLAG = 'shelf';

export const SHELF_MODE = Object.freeze({
    SALE: 'sale',
    BARTER: 'barter',
    BUYBACK: 'buyback'
});

/**
 * Created with `weightlessContents` and no capacity, so a shelf is unlimited and
 * weighs nothing however much is on it. Both are real dnd5e behaviours rather than
 * workarounds: `computeCapacity` starts at Infinity unless a capacity is set, and
 * `weightlessContents` makes a container report only its own weight.
 *
 * Artwork is Foundry's own container icons rather than the monochrome `icons/svg`
 * set: a shelf is a physical thing in the shop and reads better as one, and these
 * ship with core so there is nothing to install.
 */
export const SHELF_PRESETS = Object.freeze({
    storefront: {
        key: 'storefront',
        name: 'Storefront',
        img: 'icons/containers/boxes/crate-wooden-beige.webp',
        hint: 'Ordinary stock, on display to everyone.',
        shelf: { label: 'Storefront', order: 0, visible: true, mode: SHELF_MODE.SALE, markup: null, stock: null }
    },
    backroom: {
        key: 'backroom',
        name: 'Back Room',
        img: 'icons/containers/chest/chest-reinforced-box-brown.webp',
        hint: 'Hidden from players until you move it out front.',
        shelf: { label: 'Back Room', order: 10, visible: false, mode: SHELF_MODE.SALE, markup: null, stock: null }
    },
    premium: {
        key: 'premium',
        name: 'Premium',
        img: 'icons/containers/chest/chest-steel-purple.webp',
        hint: 'On display, priced above the going rate.',
        shelf: { label: 'Premium', order: 20, visible: true, mode: SHELF_MODE.SALE, markup: 1.5, stock: null }
    },
    barter: {
        key: 'barter',
        name: 'Barter',
        img: 'icons/containers/misc/basket-handle-woven-yellow.webp',
        hint: 'No fixed price. Settle it at the table.',
        shelf: { label: 'Barter', order: 30, visible: true, mode: SHELF_MODE.BARTER, markup: null, stock: null }
    },
    buyback: {
        key: 'buyback',
        name: 'Buyback',
        img: 'icons/containers/bags/sack-cloth-tan.webp',
        hint: 'Where things bought from the party end up.',
        shelf: { label: 'Buyback', order: 40, visible: true, mode: SHELF_MODE.BUYBACK, markup: 0.5, stock: STOCK.FINITE }
    }
});

/** Stock is grouped under these headings within each shelf, in this order. */
export const ITEM_CATEGORIES = Object.freeze([
    { type: 'weapon', label: 'Weapons', icon: 'fa-solid fa-gavel' },
    { type: 'equipment', label: 'Armor & Gear', icon: 'fa-solid fa-shield-halved' },
    { type: 'consumable', label: 'Consumables', icon: 'fa-solid fa-flask' },
    { type: 'tool', label: 'Tools', icon: 'fa-solid fa-screwdriver-wrench' },
    { type: 'container', label: 'Containers', icon: 'fa-solid fa-box' },
    { type: 'loot', label: 'Goods', icon: 'fa-solid fa-sack-xmark' }
]);

// ==================================================================
// ===== TRADING HOURS ==============================================
// ==================================================================
//
// The schedule proposes and the toggle disposes: crossing an opening or closing
// hour sets the shop to match the schedule, and a GM may override it at any time.
//
// **The override needs no stored flag.** It is simply the state disagreeing with the
// schedule, and the next boundary crossing sets the state to match — which clears
// the override as a side effect of doing the normal thing. A GM toggling back to the
// scheduled state also clears it, because there is then nothing to disagree with.

export const HOURS_FLAG = 'hours';

/** Hours in an in-world day. Calendars may define something other than 24. */
export function hoursPerDay() {
    const hours = Number(game.time?.calendar?.days?.hoursPerDay);
    return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

/** The in-world hour at a given world time, or now. */
export function hourAt(worldTime) {
    const calendar = game.time?.calendar;
    if (!calendar) return null;
    const components = worldTime === undefined
        ? game.time.components
        : calendar.timeToComponents(worldTime);
    const hour = Number(components?.hour);
    return Number.isFinite(hour) ? hour : null;
}

/**
 * Whether a schedule says open at this hour.
 *
 * @returns {boolean|null} null when there is no schedule to consult
 */
export function isScheduledOpen(hours, hour) {
    if (!hours || !Number.isFinite(hour)) return null;
    const open = Number(hours.open);
    const close = Number(hours.close);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
    // Equal bounds read as "always", which is what a GM setting both to the same
    // hour is asking for, and avoids a zero-width window nobody can shop in.
    if (open === close) return true;
    if (open < close) return hour >= open && hour < close;
    // Overnight: open 20:00, close 04:00.
    return hour >= open || hour < close;
}

/** "9:00 AM" on a 24-hour calendar, "9:00" on anything else. */
export function formatHour(hour) {
    const value = Number(hour);
    if (!Number.isFinite(value)) return '--';
    if (hoursPerDay() !== 24) return `${value}:00`;
    const suffix = value < 12 ? 'AM' : 'PM';
    const display = value % 12 === 0 ? 12 : value % 12;
    return `${display}:00 ${suffix}`;
}
