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
// adjusts a number on the merchant's own item; nothing is ever moved off an inventory by
// a sale. That is what lets a sold-out row stay on the inventory marked out of stock
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
 * What a restocking inventory refills *to*.
 *
 * Not a separate editor. A GM setting a quantity by hand in the shop window sets
 * both the count and the par, so the rule is "what I keep six of, I restock to six".
 * A purchase lowers the count and leaves par alone.
 */
export const PAR_FLAG = 'par';

/**
 * On a stock Item: this is given away.
 *
 * **Free is a decision; no price is an absence.** They cannot share a storage slot,
 * because dnd5e leaves `system.price.value` at 0 on everything nobody has valued —
 * so a bare 0 means "unvalued" far more often than it means "free", and reading it as
 * free would put a shop's entire unpriced stock on the house.
 *
 * A flag says the difference out loud: value 0 **with** the flag is free, value 0
 * **without** it is a row nobody has priced yet. The two look different on the shelf
 * and behave differently — an unpriced row cannot be bought at all, a free one can.
 *
 * Transient, and omitted on exchange, for the same reason as `par`: it describes what
 * this shop does with the row, not what the thing is. A cloak given away is still a
 * cloak, and must not arrive in the buyer's pack claiming to be free.
 */
export const FREE_FLAG = 'free';

/**
 * What a shop starts with in the till when it is first marked as a merchant.
 *
 * A merchant with no coin cannot buy anything, and "the merchant cannot cover that"
 * is a confusing first experience for a GM who has just set a shop up and does not
 * yet know a till is a thing. Seeded once, on enabling, and only when the Actor has
 * no coin at all — so it never quietly tops up a shop a GM has deliberately emptied.
 *
 * **Enough to buy things with.** The till is also the buyback ceiling -- a shop cannot
 * take what it cannot pay for -- so a small seed does not read as a modest shopkeeper,
 * it reads as a shop that refuses every sale the party actually wants to make. Three
 * thousand covers ordinary gear and most of the middling magic items a party turns up
 * with, and still says no to the sort of thing that should need a specialist.
 *
 * Editable per shop in Merchant Settings afterwards.
 */
export const DEFAULT_TILL = Object.freeze({ gp: 3000 });

/** Days between restocks when an inventory does not say otherwise. */
export const DEFAULT_RESTOCK_DAYS = 1;

/**
 * How much an inventory holds, unless it says otherwise.
 *
 * **The two are no longer the same kind of number, and that matters.**
 *
 * `PRODUCTS` counts distinct rows and is a **target**: a drawing shelf fills up to it
 * and stops, so it says how big a shop this is rather than how big it is allowed to
 * get. It used to be a ceiling against a runaway — a shelf rolling a table every week
 * growing an endless list of one-offs — and that danger went away when a draw started
 * bringing in new products only. Fifty because twenty-five reads as a stall: a party
 * after rope, a lantern, chalk and a crowbar can exhaust twenty-five in one visit, and
 * a shop should still have something the third time somebody walks in.
 *
 * `PER_ITEM` is still a **ceiling**, and still guards a runaway: without it a shelf that
 * keeps restocking rations builds toward thousands of them.
 *
 * Fifty rows totalling three hundred items is a fine shop. Fifty rows totalling twenty
 * thousand is a warehouse, and one row of twenty thousand is a bug that took a
 * fortnight of game time to show itself.
 *
 * Neither costs anything on a shelf stocked by hand: nothing draws, so nothing fills.
 */
export const DEFAULT_MAX_PRODUCTS = 50;

/**
 * How many times a table is drawn when it is first dropped on a shelf.
 *
 * **One was a table that did nothing worth seeing until it was configured.** A shelf
 * carries fifty products and a draw brings in new ones only, so a single roll is a
 * single row — usually one a GM does not notice arriving. Ten is a visible delivery on
 * the first restock without being the whole shelf, and a GM who dropped a table on a
 * shelf has already said what they want from it.
 */
export const DEFAULT_TABLE_ROLLS = 10;
export const DEFAULT_MAX_PER_ITEM = 20;

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
// and a weaponsmith with an inventory of potions is a perfectly good shop. It replaces
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
// ===== INVENTORIES ================================================
// ==================================================================
//
// An inventory is a container Item on the merchant carrying this flag. Its contents
// are the stock; anything on the Actor outside an inventory is the shopkeeper's own
// gear and is never for sale.
//
// **The type is what the GM meant, and the settings follow from it.** These used to
// be five presets over one schema, which stored nothing about the choice — a Premium
// and a Storefront were indistinguishable once created, so nothing downstream could
// offer a control that only made sense for one of them. The type is stored, and each
// type brings only the settings it can act on.
//
// A shop may hold several inventories of the same type, each with its own name.

export const INVENTORY_FLAG = 'inventory';

export const INVENTORY_TYPE = Object.freeze({
    GENERAL: 'general',
    HIDDEN: 'hidden',
    PREMIUM: 'premium',
    DISCOUNTED: 'discounted',
    UNPRICED: 'unpriced',
    PURCHASED: 'purchased'
});

/**
 * What each type is, and what it is allowed to configure.
 *
 * Created with `weightlessContents` and no capacity, so an inventory is unlimited and
 * weighs nothing however much is on it. Both are real dnd5e behaviours rather than
 * workarounds: `computeCapacity` starts at Infinity unless a capacity is set, and
 * `weightlessContents` makes a container report only its own weight.
 *
 * Artwork is Foundry's own container icons rather than the monochrome `icons/svg`
 * set: an inventory is a physical thing in the shop and reads better as one, and
 * these ship with core so there is nothing to install.
 *
 * **`name` is the inventory's name and the flag carries no copy of it.** The type
 * names the container at creation and nothing owns the name after that: a GM renaming
 * the container — in Merchant Settings or in dnd5e's own sheet — renames the
 * inventory, because there is only one name to rename.
 *
 * `pricing` says which control the settings window offers:
 *   `baseline` — nothing of its own; the shop's Global Markup is the whole story.
 *   `markup`   — its own multiplier, applied on top of the baseline.
 *   `none`     — no price until one is agreed on the slate.
 *   `trade`    — two rates: what the shop pays, and what it resells at.
 */
export const INVENTORY_TYPES = Object.freeze({
    general: {
        key: INVENTORY_TYPE.GENERAL,
        name: 'General',
        img: 'icons/containers/boxes/crate-wooden-beige.webp',
        hint: 'Ordinary stock, on display to everyone.',
        pricing: 'baseline',
        restocks: true,
        defaults: { order: 0, visible: true, markup: 1, stock: STOCK.INFINITE }
    },
    hidden: {
        key: INVENTORY_TYPE.HIDDEN,
        name: 'Hidden',
        img: 'icons/containers/chest/chest-reinforced-box-brown.webp',
        hint: 'Out of sight until you bring it out front.',
        pricing: 'markup',
        restocks: true,
        // A back room is where the good stuff is kept, not a different price list, so
        // it starts at the baseline and has a field for a GM who disagrees.
        defaults: { order: 10, visible: false, markup: 1, stock: STOCK.INFINITE }
    },
    premium: {
        key: INVENTORY_TYPE.PREMIUM,
        name: 'Premium',
        img: 'icons/containers/chest/chest-steel-purple.webp',
        hint: 'On display, priced above the going rate.',
        pricing: 'markup',
        restocks: true,
        defaults: { order: 20, visible: true, markup: 1.5, stock: STOCK.INFINITE }
    },
    discounted: {
        key: INVENTORY_TYPE.DISCOUNTED,
        name: 'Discounted',
        img: 'icons/containers/barrels/barrel-reinforced-cherry-brown.webp',
        hint: 'On display, priced below the going rate.',
        pricing: 'markup',
        restocks: true,
        defaults: { order: 30, visible: true, markup: 0.75, stock: STOCK.INFINITE }
    },
    unpriced: {
        key: INVENTORY_TYPE.UNPRICED,
        name: 'Unpriced',
        img: 'icons/containers/boxes/box-gift-white.webp',
        hint: 'No price until you agree one. The GM sets it on the slate.',
        pricing: 'none',
        restocks: true,
        defaults: { order: 40, visible: true, markup: 1, stock: STOCK.INFINITE }
    },
    purchased: {
        key: INVENTORY_TYPE.PURCHASED,
        name: 'Purchased',
        img: 'icons/containers/bags/sack-cloth-tan.webp',
        hint: 'Where things bought from the party end up.',
        pricing: 'trade',
        // Never. Its stock is whatever the party sold, so there is no level to
        // return to and a refill would conjure duplicates of somebody's old sword.
        restocks: false,
        // A pawnbroker's spread rather than a fence's, but **under the line where a
        // shop can be farmed**. The loop opens whenever `buyRate > markup x reputation^2`
        // -- buy from the general shelf at `worth x reputation`, sell straight back at
        // `worth x buyRate / reputation` -- which at a 5% markup puts the ceiling at 72%.
        //
        // This was 95%, and above the line: `MAX_BUYBACK_RATIO` then governed instead of
        // the slider, and because the cap falls as reputation improves while the offer
        // rises, **a party the town loved was paid less than a neutral one**. 70% leaves
        // room, so the number on the slider is the number in force and standing helps
        // monotonically: 54% hated, 70% neutral, 82% legendary.
        //
        // Trade routes are unaffected. That is the market rate, which does not invert --
        // see `MARKET_FLAG`.
        defaults: { order: 50, visible: true, markup: 1.05, buyRate: 0.7, stock: STOCK.FINITE }
    }
});

/**
 * A type's display name and hint, translated.
 *
 * **Separate from `INVENTORY_TYPES` because this file is evaluated before `game.i18n`
 * exists.** The literals in the table above are the fallback and the source text; these
 * read the translation at the moment of display. A world with no translation for a type
 * gets the English rather than the key, which is the failure mode worth having.
 */
export function inventoryTypeName(key) {
    const definition = inventoryType(key);
    return game.i18n?.localize(`coffee-pub-merchant.inventoryType.${definition.key}.name`) || definition.name;
}

export function inventoryTypeHint(key) {
    const definition = inventoryType(key);
    return game.i18n?.localize(`coffee-pub-merchant.inventoryType.${definition.key}.hint`) || definition.hint;
}

/** The same, for the per-inventory depth dial. */
export function depthLabel(key) {
    const option = STOCK_DEPTH_OPTIONS.find((entry) => entry.value === key) ?? STOCK_DEPTH_OPTIONS[1];
    return game.i18n?.localize(`coffee-pub-merchant.depth.${option.value}.label`) || option.label;
}

export function depthHint(key) {
    const option = STOCK_DEPTH_OPTIONS.find((entry) => entry.value === key) ?? STOCK_DEPTH_OPTIONS[1];
    return game.i18n?.localize(`coffee-pub-merchant.depth.${option.value}.hint`) || option.hint;
}

/** The type's definition, falling back to general rather than to nothing. */
export function inventoryType(key) {
    return INVENTORY_TYPES[key] ?? INVENTORY_TYPES[INVENTORY_TYPE.GENERAL];
}

/** No list price until one is agreed. */
export function isUnpriced(type) {
    return type === INVENTORY_TYPE.UNPRICED;
}

/** Where the party's own goods land, and the only type the shop buys into. */
export function isPurchased(type) {
    return type === INVENTORY_TYPE.PURCHASED;
}

/** What the shop pays for a thing, before anything else is applied. */
export const DEFAULT_BUY_RATE = 0.5;

// ==================================================================
// ===== THE LOCAL MARKET ===========================================
// ==================================================================
//
// What goods are worth *here*, regardless of who is asking.
//
// **This is the lever that makes trade possible, and it is not reputation.**
// Reputation is an area's disposition toward the party: being liked makes buying
// cheaper *and* selling dearer, both in your favour, so the best place to buy is
// also the best place to sell and no two areas differing only in reputation can be
// arbitraged. That is correct for what reputation is.
//
// A market rate is the opposite shape. It multiplies both sides in the *same*
// direction: where goods are dear, you pay more and you are paid more. That
// asymmetry — bad to buy in, good to sell in — is exactly what a trade route is.
// Buy grain in the farming valley, sell it in the besieged city.
//
// It lives on the **Scene**, which is the same scope Blacksmith gives reputation and
// the scope a shop already reads. A city spread over three maps means setting it
// three times; named regions spanning scenes would fix that and are a bigger feature
// than this one, so they wait until the repetition is actually annoying somebody.

/**
 * A picture of the shop itself, as opposed to a picture of the shopkeeper.
 *
 * **Two different images answering two different questions.** The portrait is who is
 * behind the counter; the illustration is what the place looks like when you walk in.
 * A shop with no illustration is the ordinary case and reads exactly as it did before —
 * this only ever adds a backdrop, never replaces the card.
 *
 * Stored on the merchant flag beside the name and the description, because it is the
 * same kind of thing: something the GM wrote about this shop for players to see.
 */
export const DEFAULT_ILLUSTRATION = null;

/**
 * A colour wash on the shop card, so a smithy and an apothecary are not two identical
 * grey cards.
 *
 * **Decoration that carries meaning, which is why it is the GM's to set and not
 * derived.** A tint could have come from the shop kind automatically -- and would then
 * say what Merchant thinks the shop is rather than what this table has agreed it is. A
 * GM colour-coding by district, by faction or by who owes them money is doing something
 * a fixed palette cannot.
 *
 * Null is the ordinary case and renders exactly the card it always did: the wash is an
 * extra layer over the existing ground, never a replacement for it.
 */
export const DEFAULT_TINT = null;

/**
 * A stored tint as a hex colour, or null.
 *
 * **Validated because it is substituted into an inline `style` attribute.** A flag is
 * a value a GM can hand-edit and a macro can write, so anything reaching that attribute
 * has to be a colour and nothing else -- `#c33` and `#cc3333` in, one lowercase
 * six-digit form out, and everything else null. A typo painting no tint is the right
 * failure; a typo painting arbitrary CSS into the card is not.
 */
export function normalizeTint(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const hex = raw.startsWith('#') ? raw.slice(1) : raw;
    // Three-digit shorthand expanded rather than passed through: one stored form means
    // the swatch, the text box and the stylesheet never disagree about the same colour.
    if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map((c) => c + c).join('')}`.toLowerCase();
    if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`.toLowerCase();
    return null;
}

/** What the swatch opens on when a shop has no tint: the card's own leather. */
export const HOUSE_TINT = '#8a5a2b';

export const MARKET_FLAG = 'market';

export const DEFAULT_MARKET_RATE = 1.0;

/**
 * How far a market can swing.
 *
 * Four times up and four times down, so two scenes can differ by sixteen — ample for
 * any trade route, and short of the point where one number makes an economy
 * meaningless. A GM who wants the legendary run from the mine to the capital has it
 * inside this range.
 */
export const MARKET_LIMITS = Object.freeze({ min: 0.25, max: 4 });

/**
 * The most a shop will ever pay, as a share of what it would charge for the same item.
 *
 * **This is the guard against a gold machine, and it has to live in code.** Sell an
 * item and buy it back and the merchant's markup cancels, leaving `buyRate / rep²` —
 * reputation twice, because it makes buying cheaper *and* selling dearer. A beloved
 * party at a generous merchant can push that above 1, at which point the round trip
 * turns a profit and repeats forever.
 *
 * Capping `buyRate` instead would not do it: the safe ceiling moves with reputation,
 * so any fixed limit is either too tight for a neutral town or too loose for a
 * beloved one. A shop that never pays more than it charges is the same rule stated
 * where it cannot be tuned out — and it is true of every dealer that has ever
 * existed, so it needs no explaining to a GM who meets it.
 */
export const MAX_BUYBACK_RATIO = 0.95;

// ==================================================================
// ===== REPUTATION =================================================
// ==================================================================
//
// What the party's standing does to a price.
//
// **The curve is Merchant's, and deliberately so.** Blacksmith's scale carried an
// `effects.merchantModifier` slot, and the obvious move was to read it. They removed
// it instead, and the reasoning is right: they own *how liked the party is*, we own
// *what a shop does about it*. A shop's economy is not the hub's to set, and a table
// that wants gentler prices should not have to edit a scale that also drives NPC
// attitude and what information people will share.
//
// Keyed on their band, not on our own thresholds, so the boundaries stay theirs and
// only the consequence is ours. **This table is meant to be tuned.**

export const REPUTATION_MARKUP = Object.freeze({
    hated: 1.30,
    reviled: 1.25,
    despised: 1.20,
    distrusted: 1.15,
    unwelcome: 1.08,
    neutral: 1.00,
    known: 0.97,
    respected: 0.94,
    admired: 0.90,
    revered: 0.87,
    legendary: 0.85
});

/**
 * What to do when the band cannot be resolved at all.
 *
 * A scale a world has customised may name bands we have never heard of, so the sign
 * of the score is the part that is always true: disliked is dearer, liked is cheaper.
 */
export const REPUTATION_FALLBACK = Object.freeze({ disliked: 1.15, neutral: 1.00, liked: 0.85 });

/**
 * No standing may take a price below a quarter or above four times.
 *
 * Not a position on how much a town can hate you — a guard, so a mis-typed entry in
 * the table above cannot turn a shop into a giveaway.
 */
export const REPUTATION_LIMITS = Object.freeze({ min: 0.25, max: 4 });

/** Stock is grouped under these headings within each inventory, in this order. */
export const ITEM_CATEGORIES = Object.freeze([
    { type: 'weapon', label: 'Weapons', icon: 'fa-solid fa-gavel' },
    { type: 'equipment', label: 'Armor & Gear', icon: 'fa-solid fa-shield-halved' },
    { type: 'consumable', label: 'Consumables', icon: 'fa-solid fa-flask' },
    { type: 'tool', label: 'Tools', icon: 'fa-solid fa-screwdriver-wrench' },
    { type: 'container', label: 'Containers', icon: 'fa-solid fa-box' },
    { type: 'loot', label: 'Goods', icon: 'fa-solid fa-sack-xmark' }
]);

/**
 * How deep a pile of one thing can get, by what it costs.
 *
 * **Price decides this, not type.** There was a whitelist of stackable *types* here
 * -- consumables and loot stack, gear does not -- and it was wrong about the
 * ordinary case. A general store's inventory is daggers, vials, clothes, chests and
 * tools, every one of which a shop plainly keeps several of, and every one of which
 * the whitelist excluded. The result was a depth feature that changed nothing
 * anybody could see.
 *
 * Cost is one of **three** ceilings, and it is not the first. Type is: a shop keeps
 * ten torches and one breastplate because of what they are, and only then because of
 * what they cost. Rarity is the third, and it is the one price cannot express --
 * a legendary blade and a masterwork one can carry the same number and mean entirely
 * different things about how many a shop could possibly have.
 *
 * Three rules rather than one *was* the objection, and the answer is that they do not
 * interact: each is a ceiling and the smallest wins. There is no order to remember and
 * no arithmetic to do, so "why is my shop like this" is answered by reading three
 * numbers and taking the lowest.
 *
 * These are **caps, not counts**. The depth is rolled within the band, so an inventory
 * stocked twice does not look stocked twice the same way. Thresholds are in base
 * units (copper) and are deliberately coarse: this is a shop's character, not a
 * simulation, and a GM who wants exact numbers sets them by hand.
 */
export const STOCK_DEPTH_BANDS = Object.freeze([
    { under: 100, cap: 10 },     // under 1 gp -- rations, torches, chalk
    { under: 2500, cap: 5 },     // 1-25 gp -- ordinary consumables
    { under: 10000, cap: 3 },    // 25-100 gp -- the better potions
    { under: Infinity, cap: 1 }  // anything dearer is a single item
]);

/**
 * How deep a shop stacks a thing because of **what it is**.
 *
 * The first lever, and the one closest to how anybody actually pictures a shop. Armour
 * is `equipment` in dnd5e, which is why that entry reads lower than a consumable: a
 * general store keeps a rack of rope and one or two breastplates.
 *
 * Only the physical types appear. Anything else cannot sit on an inventory at all.
 */
export const STOCK_TYPE_CAPS = Object.freeze({
    consumable: 10,
    loot: 10,
    tool: 5,
    weapon: 5,
    equipment: 5,
    container: 5
});

/**
 * How deep a shop stacks a thing because of **how rare it is**.
 *
 * The lever price cannot pull. Two blades at the same price are not the same question
 * if one of them is the only one anybody has heard of, and a shop with three artifacts
 * on the shelf is not a shop.
 *
 * **Zero means no ceiling**, which is what `common` wants: ordinary goods are governed
 * by their type and their price, and a third number saying "no more than 99" would be
 * a rule that never fires pretending to be one that does. Keys are dnd5e's own
 * (`CONFIG.DND5E.itemRarity`); an item with no rarity at all -- most `loot` -- reads
 * as common.
 */
export const STOCK_RARITY_CAPS = Object.freeze({
    // **`mundane` is not `common`, and dnd5e does not say so.** `system.rarity` is
    // *blank* on non-magical gear — rope, torches, a plain longsword — while `common`
    // means a common *magic* item. Folding the two together was harmless while this row
    // read 0, and was a trap the moment anybody set it: capping common magic items at
    // two would silently have capped every torch in the world at two as well.
    //
    // Blacksmith names the blank case `mundane` (`normalizeRarity`), so the vocabulary
    // is theirs and one token means one thing across both modules.
    mundane: 0,
    common: 0,
    uncommon: 3,
    rare: 2,
    veryRare: 1,
    legendary: 1,
    artifact: 1
});

/**
 * The one dial an individual shop gets over all of that.
 *
 * The tables above are a fact about the **world** -- how much stuff exists, how freely
 * it moves -- so they are world settings, set once. What varies shop to shop is
 * whether this particular place is well supplied, and that is one choice rather than
 * twelve. A card carrying the full tables would be twelve numbers per inventory
 * restating the same world in every shop in it.
 */
export const STOCK_DEPTH = Object.freeze({ SPARSE: 'sparse', NORMAL: 'normal', DEEP: 'deep' });

export const STOCK_DEPTH_OPTIONS = Object.freeze([
    { value: STOCK_DEPTH.SPARSE, label: 'Sparse', scale: 0.5, hint: 'A thin shop. Half of what the world would keep.' },
    { value: STOCK_DEPTH.NORMAL, label: 'Normal', scale: 1, hint: 'Whatever the world settings say.' },
    { value: STOCK_DEPTH.DEEP, label: 'Deep', scale: 2, hint: 'A well-supplied shop. Twice what the world would keep.' }
]);

export const DEFAULT_STOCK_DEPTH = STOCK_DEPTH.NORMAL;

/** Setting key for a type's depth ceiling. */
export function typeCapKey(type) {
    return `stockCapType${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/** Setting key for a rarity's depth ceiling. */
export function rarityCapKey(rarity) {
    return `stockCapRarity${rarity.charAt(0).toUpperCase()}${rarity.slice(1)}`;
}

/** The type table as a GM has set it, falling back to the shipped defaults. */
export function typeCaps() {
    return _read(STOCK_TYPE_CAPS, typeCapKey);
}

/** The rarity table as a GM has set it, falling back to the shipped defaults. */
export function rarityCaps() {
    return _read(STOCK_RARITY_CAPS, rarityCapKey);
}

// Read through a try, because these are asked for during a render and a world that has
// not registered yet -- or a setting deleted out from under us -- must fall back rather
// than take the window down with it.
function _read(defaults, key) {
    const out = {};
    for (const [name, fallback] of Object.entries(defaults)) {
        let value = fallback;
        try {
            const stored = game.settings.get(MODULE.ID, key(name));
            if (Number.isFinite(Number(stored))) value = Math.max(0, Math.trunc(Number(stored)));
        } catch (_error) { /* not registered yet: the shipped default is the answer */ }
        out[name] = value;
    }
    return out;
}

/** The scale for a dial setting, falling back to Normal rather than to nothing. */
export function depthScale(key) {
    return STOCK_DEPTH_OPTIONS.find((entry) => entry.value === key)?.scale ?? 1;
}

/**
 * Where a shelf's new products come from.
 *
 * **A table is a list somebody wrote; a query is a description of what this shop deals
 * in.** The first is curated and weighted and rots — it stores references, so renaming a
 * pack or uninstalling a module leaves rows pointing at nothing. The second is answered
 * against what is installed at the moment it runs and cannot dangle.
 *
 * **Manual is the third, and it is not the absence of the other two.** A shelf a GM
 * stocked by hand — a fence's shady goods, a smith's one good blade — is curated, and
 * saying so is different from leaving a table shelf with no tables on it. Restock still
 * tops its rows up to their quantity; it simply never brings in anything new, so nothing
 * a GM did not choose ever appears on it.
 *
 * **And both, because a real shop is both.** A few things that make it *this* shop — the
 * fence's shady weapons, the smith's one good blade — and a lot of ordinary stock nobody
 * chose individually. Tables take the free slots first: they are the deliberate half, and
 * the query is filler. Nothing is drawn twice, because the draw already matches rows by
 * name and type.
 *
 * **Manual placement works on every one of these.** A GM can always drag something onto
 * any shelf; what these four choose is what arrives *without* being asked for. That is why
 * the first one is named "Manual only" rather than "Manual".
 */
export const SOURCE = Object.freeze({
    MANUAL: 'manual',
    QUERY: 'query',
    TABLE: 'table',
    BOTH: 'both'
});

/**
 * **Manual, because a new shelf has nothing on it and no opinion about what should be.**
 *
 * A shelf created as a table shelf is a shelf waiting for a table that may never be
 * dropped on it, and one created as a query shelf starts pulling in whatever the world
 * happens to hold. Manual is the only default that does nothing until asked — which is
 * what a GM who has just pressed Add Inventory has actually said so far.
 *
 * Existing shelves are not touched by this: schema 5 stamps an explicit source on every
 * one of them, so nothing silently changes what it draws because a default moved.
 */
export const DEFAULT_SOURCE = SOURCE.MANUAL;

/**
 * The gold-piece stops a price slider moves between.
 *
 * **Not a linear range.** Shop prices span four orders of magnitude — a torch is 0.01 gp
 * and plate is 1,500 — so a linear 0-to-anything slider spends nine tenths of its travel
 * in a band no shop cares about and cannot separate a torch from a lantern at all. These
 * stops are roughly logarithmic, so every drag distance is about as meaningful as the last.
 *
 * `Infinity` is the last stop and reads as **Any**: the honest end of a shop that deals
 * in whatever it can get, and the only way to say "no ceiling" without asking a GM to
 * guess a number bigger than the most expensive thing they have installed.
 */
export const PRICE_STOPS = Object.freeze([
    0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity
]);

/** The nearest stop at or below a value, as an index. */
export function priceStopIndex(gp) {
    // **Checked before conversion.** `Number(null)` is 0, not NaN, so a null ceiling —
    // which is how "no ceiling" is stored — would otherwise read as "0 gp" and put the
    // top handle at the bottom of the range.
    if (gp === null || gp === undefined) return PRICE_STOPS.length - 1;
    const value = Number(gp);
    if (!Number.isFinite(value)) return PRICE_STOPS.length - 1;
    const found = PRICE_STOPS.findIndex((stop) => stop >= value);
    return found < 0 ? PRICE_STOPS.length - 1 : found;
}

/** What a stop reads as. The top one is a word, because a number there would be a lie. */
export function priceStopLabel(index) {
    const stop = PRICE_STOPS[Math.max(0, Math.min(PRICE_STOPS.length - 1, Math.trunc(index)))];
    return Number.isFinite(stop) ? String(stop) : game.i18n.localize('coffee-pub-merchant.query.anyPrice');
}

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
    // Handles on the same hour is a window with no hours in it, and a shop with no
    // hours in it is shut. The other reading -- treating it as "always" -- gave two
    // gestures for open and none for closed, which is exactly the ambiguity the
    // whole-span rule was meant to remove.
    if (open === close) return false;
    if (open < close) return hour >= open && hour < close;
    // Overnight: open 20:00, close 04:00.
    return hour >= open || hour < close;
}

/** "9:00 AM" on a 24-hour calendar, "9:00" on anything else. */
export function formatHour(hour) {
    const value = Number(hour);
    if (!Number.isFinite(value)) return '--';
    // The closing handle reaches the *end* of the day, one past its last hour, so
    // that "all day" is a span rather than a special case. Both ends of the day are
    // midnight and neither is "12:00 PM".
    if (value === 0 || value === hoursPerDay()) return hoursPerDay() === 24 ? 'midnight' : `${value}:00`;
    if (hoursPerDay() !== 24) return `${value}:00`;
    const suffix = value < 12 ? 'AM' : 'PM';
    const display = value % 12 === 0 ? 12 : value % 12;
    return `${display}:00 ${suffix}`;
}

/**
 * Whether a schedule covers every hour there is: the band drawn across the whole
 * day, one midnight to the next. Only for saying so on screen — `isScheduledOpen`
 * already answers the question that matters.
 */
export function isAlwaysOpen(hours) {
    if (!hours) return true;
    const open = Number(hours.open);
    const close = Number(hours.close);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return true;
    return open === 0 && close === hoursPerDay();
}

/**
 * Whether a schedule has no hours in it at all: both handles on the same mark.
 *
 * The mirror of the above, and the reason the two ends of the slider mean opposite
 * things. Dragging the band shut is the only way to say "never open" with the same
 * control that says "always open", so it says it.
 */
export function isAlwaysClosed(hours) {
    if (!hours) return false;
    const open = Number(hours.open);
    const close = Number(hours.close);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
    return open === close;
}
