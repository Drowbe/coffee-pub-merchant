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
