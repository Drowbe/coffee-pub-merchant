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

export const STOCK = Object.freeze({
    INFINITE: 'infinite',
    FINITE: 'finite',
    RESTOCKING: 'restocking'
});

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
 */
export const SHELF_PRESETS = Object.freeze({
    storefront: {
        key: 'storefront',
        name: 'Storefront',
        img: 'icons/svg/chest.svg',
        hint: 'Ordinary stock, on display to everyone.',
        shelf: { label: 'Storefront', order: 0, visible: true, mode: SHELF_MODE.SALE, markup: null }
    },
    backroom: {
        key: 'backroom',
        name: 'Back Room',
        img: 'icons/svg/padlock.svg',
        hint: 'Hidden from players until you move it out front.',
        shelf: { label: 'Back Room', order: 10, visible: false, mode: SHELF_MODE.SALE, markup: null }
    },
    premium: {
        key: 'premium',
        name: 'Premium',
        img: 'icons/svg/coins.svg',
        hint: 'On display, priced above the going rate.',
        shelf: { label: 'Premium', order: 20, visible: true, mode: SHELF_MODE.SALE, markup: 1.5 }
    },
    barter: {
        key: 'barter',
        name: 'Barter',
        img: 'icons/svg/card-hand.svg',
        hint: 'No fixed price. Settle it at the table.',
        shelf: { label: 'Barter', order: 30, visible: true, mode: SHELF_MODE.BARTER, markup: null }
    },
    buyback: {
        key: 'buyback',
        name: 'Buyback',
        img: 'icons/svg/item-bag.svg',
        hint: 'Where things bought from the party end up.',
        shelf: { label: 'Buyback', order: 40, visible: true, mode: SHELF_MODE.BUYBACK, markup: 0.5 }
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
