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

/**
 * The most times one table is rolled in a single restock.
 *
 * Matches `DEFAULT_MAX_PRODUCTS`: the two are the same question from opposite ends --
 * how big a shop this is -- and a roll ceiling below the product target is a shelf that
 * cannot reach its own size.
 */
export const MAX_TABLE_ROLLS = 50;
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

/**
 * **Alphabetical, because seventeen is past the point where a reader scans a list.**
 * There is no natural order to shop kinds — no scale, no frequency anybody agrees on — so
 * any other arrangement is one somebody has to learn before they can find Jeweller.
 */
export const SHOP_KINDS = Object.freeze([
    { key: 'alchemist', label: 'Alchemist', icon: 'fa-solid fa-flask' },
    { key: 'alchemy', label: 'Apothecary', icon: 'fa-solid fa-mortar-pestle' },
    { key: 'magic', label: 'Arcanist', icon: 'fa-solid fa-wand-sparkles' },
    { key: 'armor', label: 'Armorer', icon: 'fa-solid fa-shield-halved' },
    { key: 'books', label: 'Bookseller', icon: 'fa-solid fa-book' },
    { key: 'bowyer', label: 'Bowyer & Fletcher', icon: 'fa-solid fa-bullseye' },
    { key: 'cartographer', label: 'Cartographer', icon: 'fa-solid fa-map' },
    { key: 'exotic', label: 'Curiosities', icon: 'fa-solid fa-hat-wizard' },
    { key: 'general', label: 'General Store', icon: 'fa-solid fa-shop' },
    { key: 'jewelry', label: 'Jeweller', icon: 'fa-solid fa-gem' },
    { key: 'outfitter', label: 'Outfitter', icon: 'fa-solid fa-shirt' },
    { key: 'provisions', label: 'Provisioner', icon: 'fa-solid fa-wheat-awn' },
    { key: 'scribe', label: 'Scribe & Messenger', icon: 'fa-solid fa-feather-pointed' },
    { key: 'tools', label: 'Smith & Tools', icon: 'fa-solid fa-screwdriver-wrench' },
    { key: 'stable', label: 'Stables', icon: 'fa-solid fa-horse' },
    { key: 'tavern', label: 'Tavern', icon: 'fa-solid fa-beer-mug-empty' },
    { key: 'weapons', label: 'Weaponsmith', icon: 'fa-solid fa-gavel' }
]);

export const DEFAULT_SHOP_KIND = 'general';

/**
 * What Blacksmith calls our pins.
 *
 * Coarse and technical, as their guidance asks: one category for every shop pin, with the
 * shop *kind* carried as a tag. "Show me the taverns" is a tag question; "show me
 * Merchant's pins" is a category one.
 */
export const PIN_TYPE = 'shop';

/**
 * What a *new* shop looks like in this world.
 *
 * **A default, not a rule.** It is copied onto a shop the moment it becomes one, and from
 * then on the shop owns it: changing this never reaches back into a shop that already
 * exists, because the GM may have set that one deliberately and a setting that rewrites
 * work is a setting nobody dares touch.
 *
 * Blank is the honest default for both. A world tint would make every shop the same
 * colour, which is the opposite of what a tint is for, and an illustration nobody chose
 * would be a picture of somebody else's tavern behind every counter.
 */
export const SHOP_LOOK_SETTINGS = Object.freeze([
    { key: 'shopTint', nameKey: 'coffee-pub-merchant.settings.shopTint', colour: true },
    { key: 'shopIllustration', nameKey: 'coffee-pub-merchant.settings.shopIllustration', image: true }
]);

/**
 * What is still lying about in an abandoned shop.
 *
 * **Nobody strips a place completely.** Whoever left took the stock and the till and left
 * the things not worth carrying, and a shuttered shop with literally nothing in it is a
 * locked door rather than a place. These are the leavings: cheap, heavy, or too ordinary
 * to bother with.
 *
 * Resolved **by name** against the world's compendiums rather than stored as uuids, for
 * the same reason a query shelf is: a uuid written down here would dangle the day somebody
 * renames a pack, and these names are SRD content every dnd5e world has.
 *
 * The list is deliberately short and dull. It is set dressing a party rifles through, not
 * a reward for finding a dead shop -- anything worth having would make deleting a merchant
 * the profitable move.
 *
 * **This is the default, not the answer.** What a dead shop leaves is the GM's to say --
 * a scavenged world leaves less, a wealthy one leaves a broken lantern and half a cask --
 * so it is a world setting, and this is what it starts as.
 */
export const DEFAULT_ABANDONED_STOCK = Object.freeze([
    'Rations',
    'Torch',
    'Candle',
    'Rope, Hempen (50 feet)',
    'Tinderbox',
    'Bedroll',
    'Pot, Iron',
    'Shovel'
]);

/** The container the leavings sit in: an old barrel nobody emptied. */
export const ABANDONED_IMG = 'icons/containers/barrels/barrel-oak-banded-tan.webp';

/**
 * What this world's dead shops leave behind.
 *
 * Names separated by **semicolons**, resolved against the compendiums when a shop is
 * opened. Semicolons and not commas because dnd5e writes `Rope, Hempen (50 feet)` and
 * `Pot, Iron`: a comma-separated list turns each of those into two names that resolve to
 * nothing, and the failure is silent -- the row simply is not there.
 *
 * Read through a try like the other settings readers here, and falling back to the shipped
 * list rather than to nothing: a world that has not registered yet still furnishes its
 * abandoned shops.
 *
 * **Blank means blank.** A GM who empties the field is saying dead shops are stripped bare,
 * which is a real answer about a world and not a mistake to correct back to the default.
 */
export function abandonedStockNames() {
    let stored = null;
    try {
        stored = game.settings.get(MODULE.ID, 'abandonedStock');
    } catch (_error) {
        stored = null;
    }
    const list = typeof stored === 'string' ? stored : DEFAULT_ABANDONED_STOCK.join('; ');
    return list
        .split(/[\n;]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(parseAbandonedEntry);
}

/**
 * One entry of the leavings list: a name, and how many of it are lying there.
 *
 * **A name on its own is a handful of that thing**, between one and five — rolled per shop
 * and stable for it, so two dead shops are not stocked identically and neither changes
 * while somebody is looking at it. See `leavingQuantity`.
 *
 * **`Torch x5` is for when a GM means five.** The suffix is only taken when it is
 * unambiguously one: a trailing `x` and digits. An item genuinely called something ending
 * in `x3` is not a thing dnd5e ships, and a GM who hits that can put the count on the other
 * side of a rename.
 */
function parseAbandonedEntry(entry) {
    const match = /^(.*?)\s*[x*]\s*(\d+)$/i.exec(entry);
    if (!match || !match[1]) return { name: entry, quantity: null };
    return { name: match[1].trim(), quantity: Math.max(1, Math.trunc(Number(match[2])) || 1) };
}

/** How many of a thing are lying about when the list does not say. */
export const ABANDONED_QUANTITY = Object.freeze({ min: 1, max: 5 });

/**
 * A merchant's own door, if it wants one.
 *
 * **The world setting is the default, not the rule.** Most merchants sound like every
 * other; a tavern that creaks and a vault that clangs are worth the two fields, and a GM
 * who has set the world's door once should not have to set it again per shop.
 *
 * `null` on either means "whatever the world says", which is what makes this a default
 * rather than a copy: change the world's sound and every merchant that never spoke up
 * follows it.
 */
export const SHOP_SOUND_KEYS = Object.freeze([
    { key: 'open', setting: 'soundWindowOpen', nameKey: 'coffee-pub-merchant.config.soundOpen' },
    { key: 'close', setting: 'soundWindowClose', nameKey: 'coffee-pub-merchant.config.soundClose' }
]);

export const DEFAULT_SHOP_LOOK = Object.freeze({
    shopTint: '',
    shopIllustration: ''
});

/**
 * What a new shop's card looks like, before the GM opens it.
 *
 * Read here rather than in `settings.js` for the same reason `typeCaps` is: `settings.js`
 * imports the manager, and the manager wants this -- reading it there would be a cycle for
 * two strings. Through a try, because it is asked for during a render and a world that has
 * not registered yet must fall back rather than take the window down.
 */
export function shopLook() {
    const read = (key) => {
        try {
            const stored = game.settings.get(MODULE.ID, key);
            return typeof stored === 'string' && stored.trim() ? stored.trim() : null;
        } catch (_error) {
            return null;
        }
    };
    return { tint: read('shopTint'), illustration: read('shopIllustration') };
}

/**
 * The pin design a GM can set, as one table.
 *
 * **Defined here because two files need it and neither owns it.** `settings.js` registers
 * these; `utility-pins.js` reads them when it makes a pin. A key written out twice is a
 * key that will disagree with itself eventually.
 *
 * Keys are spelled out rather than built from the name, so `tests/test-i18n.mjs` can see
 * them: a missing string is not a crash, it renders as the key, and the checker is the
 * only thing that catches one.
 */
export const PIN_DESIGN_SETTINGS = Object.freeze([
    {
        key: 'pinShape',
        nameKey: 'coffee-pub-merchant.settings.pinShape',
        choices: [
            { value: 'circle', labelKey: 'coffee-pub-merchant.settings.pinCircle' },
            { value: 'square', labelKey: 'coffee-pub-merchant.settings.pinSquare' },
            { value: 'rectangle', labelKey: 'coffee-pub-merchant.settings.pinRectangle' },
            { value: 'none', labelKey: 'coffee-pub-merchant.settings.pinIconOnly' }
        ]
    },
    { key: 'pinSize', nameKey: 'coffee-pub-merchant.settings.pinSize', range: { min: 16, max: 300, step: 2 } },
    { key: 'pinFill', nameKey: 'coffee-pub-merchant.settings.pinFill', colour: true },
    { key: 'pinStroke', nameKey: 'coffee-pub-merchant.settings.pinStroke', colour: true },
    { key: 'pinStrokeWidth', nameKey: 'coffee-pub-merchant.settings.pinStrokeWidth', range: { min: 0, max: 12, step: 1 } },
    { key: 'pinIconColor', nameKey: 'coffee-pub-merchant.settings.pinIconColor', colour: true },
    { key: 'pinDropShadow', nameKey: 'coffee-pub-merchant.settings.pinDropShadow', boolean: true },

    /**
     * **What a pin shows: the place, the person, or the trade.**
     *
     * Each is a different claim about what a shop is on a map. The **category icon** says *what
     * this shop sells* — an apothecary and a weaponsmith are told apart at a glance, and
     * every shop of a kind looks alike. A portrait says *who keeps it*, which is what a
     * party remembers. An illustration says *what the place looks like*, which is the most
     * evocative and the worst behaved: it is a wide scene, and a circular pin crops it to
     * whatever happens to be in the middle.
     *
     * The orders are fallbacks, not preferences: a shop with no illustration under
     * *Illustration first* gets the next thing that exists rather than a blank pin. The
     * icon is last in every one because it is the only one that always exists.
     */
    {
        key: 'pinImage',
        nameKey: 'coffee-pub-merchant.settings.pinImage',
        choices: [
            { value: 'icon', labelKey: 'coffee-pub-merchant.settings.pinImageIcon' },
            { value: 'illustration', labelKey: 'coffee-pub-merchant.settings.pinImageIllustration' },
            { value: 'portrait', labelKey: 'coffee-pub-merchant.settings.pinImagePortrait' },
            { value: 'illustration-portrait', labelKey: 'coffee-pub-merchant.settings.pinImageIllustrationFirst' },
            { value: 'portrait-illustration', labelKey: 'coffee-pub-merchant.settings.pinImagePortraitFirst' }
        ]
    },

    // --- the name under it ---
    {
        key: 'pinTextLayout',
        nameKey: 'coffee-pub-merchant.settings.pinTextLayout',
        choices: [
            { value: 'under', labelKey: 'coffee-pub-merchant.settings.pinTextUnder' },
            { value: 'over', labelKey: 'coffee-pub-merchant.settings.pinTextOver' },
            { value: 'above', labelKey: 'coffee-pub-merchant.settings.pinTextAbove' },
            { value: 'right', labelKey: 'coffee-pub-merchant.settings.pinTextRight' },
            { value: 'left', labelKey: 'coffee-pub-merchant.settings.pinTextLeft' },
            { value: 'arc-above', labelKey: 'coffee-pub-merchant.settings.pinTextArcAbove' },
            { value: 'arc-below', labelKey: 'coffee-pub-merchant.settings.pinTextArcBelow' }
        ]
    },
    {
        key: 'pinTextDisplay',
        nameKey: 'coffee-pub-merchant.settings.pinTextDisplay',
        choices: [
            { value: 'always', labelKey: 'coffee-pub-merchant.settings.pinAlways' },
            { value: 'hover', labelKey: 'coffee-pub-merchant.settings.pinOnHover' },
            { value: 'gm', labelKey: 'coffee-pub-merchant.settings.pinGmOnly' },
            { value: 'never', labelKey: 'coffee-pub-merchant.settings.pinNever' }
        ]
    },
    { key: 'pinTextColor', nameKey: 'coffee-pub-merchant.settings.pinTextColor', colour: true },
    { key: 'pinTextSize', nameKey: 'coffee-pub-merchant.settings.pinTextSize', range: { min: 8, max: 48, step: 1 } },
    // 0 means no limit in both, which is Blacksmith's own reading of them.
    { key: 'pinTextMaxLength', nameKey: 'coffee-pub-merchant.settings.pinTextMaxLength', range: { min: 0, max: 60, step: 1 } },
    { key: 'pinTextMaxWidth', nameKey: 'coffee-pub-merchant.settings.pinTextMaxWidth', range: { min: 0, max: 60, step: 1 } },
    { key: 'pinTextScale', nameKey: 'coffee-pub-merchant.settings.pinTextScale', boolean: true }
]);

/**
 * What a shop pin looks like before a GM says otherwise.
 *
 * A world setting rather than a constant a module decides for everyone -- see
 * `settings.js` -- but the shipped answer lives here with the rest of the vocabulary. The
 * icon is not among these: it comes from the shop's *kind*, so an apothecary and a
 * weaponsmith are told apart on the map without anybody configuring anything.
 */
export const DEFAULT_PIN_DESIGN = Object.freeze({
    pinShape: 'circle',
    pinSize: 40,
    pinFill: '#2f241a',
    pinStroke: '#c8a678',
    pinStrokeWidth: 2,
    pinIconColor: '#ecd7b2',
    pinDropShadow: true,
    // The kind's icon: every shop of a kind alike, and the only source that always exists.
    pinImage: 'icon',
    pinTextLayout: 'under',
    pinTextDisplay: 'hover',
    pinTextColor: '#ecd7b2',
    pinTextSize: 12,
    pinTextMaxLength: 0,
    pinTextMaxWidth: 0,
    pinTextScale: true
});

/**
 * **What a merchant token wears on the canvas.**
 *
 * A mark saying *this is a shop, and this is what it sells*, so a party crossing a market
 * square can tell the weaponsmith from the apothecary from the guard who is only standing
 * there. The glyph is the category's own icon -- the same one the map pin wears and the
 * same one the shop card shows -- so the vocabulary is learned once.
 *
 * **No colour settings of its own.** It takes the pin palette, because a pin and a marker
 * naming the same shop in two different liveries is two shops as far as a reader is
 * concerned. One question, one answer, in `Shop Aesthetics`.
 */
export const TOKEN_MARKER_SETTINGS = Object.freeze([
    {
        key: 'markerShow',
        nameKey: 'coffee-pub-merchant.settings.markerShow',
        default: 'everyone',
        choices: [
            { value: 'everyone', labelKey: 'coffee-pub-merchant.settings.markerEveryone' },
            { value: 'gm', labelKey: 'coffee-pub-merchant.settings.markerGm' },
            { value: 'off', labelKey: 'coffee-pub-merchant.settings.markerOff' }
        ]
    },
    {
        key: 'markerCorner',
        nameKey: 'coffee-pub-merchant.settings.markerCorner',
        default: 'topRight',
        choices: [
            { value: 'topRight', labelKey: 'coffee-pub-merchant.settings.markerTopRight' },
            { value: 'topLeft', labelKey: 'coffee-pub-merchant.settings.markerTopLeft' },
            { value: 'bottomRight', labelKey: 'coffee-pub-merchant.settings.markerBottomRight' },
            { value: 'bottomLeft', labelKey: 'coffee-pub-merchant.settings.markerBottomLeft' }
        ]
    },
    {
        key: 'markerSize',
        nameKey: 'coffee-pub-merchant.settings.markerSize',
        default: 30,
        range: { min: 10, max: 64, step: 2 }
    },
    {
        // **Zero is "always", and it is not the default.** A marker per stallholder is the
        // useful thing at conversation range and a wall of glyphs over the GM's map when
        // the whole district is on screen.
        key: 'markerZoom',
        nameKey: 'coffee-pub-merchant.settings.markerZoom',
        default: 0.35,
        range: { min: 0, max: 1.5, step: 0.05 }
    }
]);

/**
 * What a door remembers about the shop it opens onto.
 *
 * **A door outlives the room.** A pin stays on a map and a catalogue stays in a pack after
 * the Actor is deleted, and when that happens the shop's configuration goes with it --
 * everything the GM wrote about the place. Without a copy, an abandoned shop is a grey
 * card with a name on it.
 *
 * A **copy taken when the door was made**, deliberately, not a live read. It could not be
 * live for the case it exists for, and where the shop is still there it answers for
 * itself and would rather. A label says what was true when somebody wrote it.
 */
export function shopSnapshot(actor, config) {
    return {
        name: config?.name || actor?.name || null,
        kind: config?.kind ?? null,
        description: config?.description ?? '',
        tint: config?.tint ?? null,
        illustration: config?.illustration ?? null,
        portrait: actor?.img ?? null
    };
}

/**
 * **The four ways into a shop, each of which a merchant answers separately.**
 *
 * *How you arrived* is part of how a shop should be presented, and the four doors are
 * genuinely different experiences rather than points on a scale:
 *
 * - **Region** — you walked into the place. The obvious one to fill the screen.
 * - **Token** — you clicked a shopkeeper standing on a map you are still using.
 * - **Pin** — you clicked a mark on that same map.
 * - **Catalogue** — you opened a book in your pack, without going anywhere.
 *
 * A first version made this one dropdown of never / regions-only / always, on the reasoning
 * that the useful answers were an ordered scale. They are not: a GM who wants the region
 * *and* the catalogue full screen but not the token has no entry on that scale, and the
 * middle option had to be given a name -- "when walked into" -- that describes a mechanism
 * rather than a door. Four switches, named after the four doors, need no explaining at all.
 *
 * Merchant Settings has a fifth way in, its own *Open Merchant* button. That counts as the
 * token door: it is the GM opening the shop directly, which is what clicking the token is.
 */
export const SHOP_DOORS = Object.freeze([
    { key: 'region', labelKey: 'coffee-pub-merchant.config.doorRegion' },
    { key: 'token', labelKey: 'coffee-pub-merchant.config.doorToken' },
    { key: 'pin', labelKey: 'coffee-pub-merchant.config.doorPin' },
    { key: 'catalogue', labelKey: 'coffee-pub-merchant.config.doorCatalogue' }
]);

/** No door, until a GM says otherwise. A shop is a window unless it has earned the screen. */
export const DEFAULT_FULLSCREEN_DOORS = Object.freeze({});

/**
 * Should this shop open full screen, coming through this door?
 *
 * Pure, so the rule is stated once and can be checked without a Foundry. Anything that is
 * not an explicit `true` for that exact door is a window -- including a stored value from
 * an older shape, which reads as no doors rather than as a guess.
 */
export function opensFullScreen(doors, door) {
    if (!doors || typeof doors !== 'object') return false;
    return doors[door] === true;
}

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
    PURCHASED: 'purchased',
    CATALOGUE: 'catalogue'
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
    catalogue: {
        key: INVENTORY_TYPE.CATALOGUE,
        name: 'Catalogue',
        img: 'icons/containers/boxes/crates-wooden-stacked.webp',
        hint: 'A warehouse elsewhere. Ordered by post, never carried out.',
        pricing: 'markup',
        restocks: true,
        // **Infinite by default, and the catalogue view shows no quantities at all.** A
        // warehouse is the one shelf where "we have as many as you like" is the ordinary
        // answer, and a stock level is not a fact a reader of a catalogue needs.
        defaults: { order: 50, visible: true, markup: 1, stock: STOCK.INFINITE }
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

/** A warehouse rather than a counter: nothing on it changes hands where you are standing. */
export function isCatalogue(type) {
    return type === INVENTORY_TYPE.CATALOGUE;
}

// ==================================================================
// ===== MAIL ORDER =================================================
// ==================================================================
//
// **A catalogue shelf is a warehouse, and that is the rule the whole feature turns on.**
// Nothing on one is picked up and carried out; ordering takes coin now and the goods come
// later, by a service the buyer chooses and pays for. That is what earns the delay and the
// fee, rather than bolting them onto a shop that could have handed the thing over.

/**
 * How a parcel gets there.
 *
 * A table rather than three branches, so a fourth service is a row. The shape is
 * `INVENTORY_TYPES`': what it is called, what it costs, how long it takes, and one line
 * saying what it means -- because the difference between these is mostly fiction, and the
 * fiction is what a GM is choosing between.
 *
 * **Phase 1 is theatre of the mind.** There are no depot pins and no portal network yet, so
 * *where it goes* is description; what differs mechanically is `days` and `fee`. Both are
 * world settings with these as their defaults, since what a courier charges is a fact about
 * a world rather than about this module.
 *
 * **The fee is flat per order.** Per item invites a party to split one order into six, and
 * by weight is a second arithmetic for a number nobody is checking.
 */
export const DELIVERY_SERVICES = Object.freeze([
    {
        key: 'ground',
        name: 'Ground',
        icon: 'fa-solid fa-wagon-covered',
        days: 7,
        feeGp: 5,
        hintKey: 'coffee-pub-merchant.delivery.groundHint'
    },
    {
        key: 'beast',
        name: 'Courier Beast',
        icon: 'fa-solid fa-crow',
        days: 3,
        feeGp: 25,
        hintKey: 'coffee-pub-merchant.delivery.beastHint'
    },
    {
        key: 'portal',
        name: 'Parcel Portal',
        icon: 'fa-solid fa-ring',
        days: 1,
        feeGp: 150,
        hintKey: 'coffee-pub-merchant.delivery.portalHint'
    }
]);

export const DEFAULT_DELIVERY_SERVICE = 'ground';

/** One service, falling back to the default rather than to nothing. */
export function deliveryService(key) {
    return DELIVERY_SERVICES.find((service) => service.key === key)
        ?? DELIVERY_SERVICES.find((service) => service.key === DEFAULT_DELIVERY_SERVICE);
}

/** The world setting keys a service's two numbers live under. */
export function deliveryDaysKey(key) {
    return `deliveryDays${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

export function deliveryFeeKey(key) {
    return `deliveryFee${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/**
 * When a parcel dispatched now arrives, in world seconds.
 *
 * Pure, and separated from everything that reads a clock, because "the arithmetic that
 * decides when a thing happens" is the half most likely to be quietly wrong and the half a
 * test can reach. A day is `secondsPerDay()`, which is Foundry's own figure rather than
 * 86400 -- a world on a different day length still delivers on the right morning.
 *
 * A service with no days arrives immediately, which is not a state any shipped service is
 * in but is what a GM setting the days to zero is asking for.
 */
export function arrivalTime(dispatchedAt, days) {
    const start = Number.isFinite(Number(dispatchedAt)) ? Number(dispatchedAt) : 0;
    const span = Math.max(0, Number(days) || 0);
    return start + Math.round(span * secondsPerDay());
}

/** Whole days left before a parcel lands, rounded up. Never negative. */
export function daysUntil(arrivesAt, now) {
    const left = Number(arrivesAt) - Number(now);
    if (!Number.isFinite(left) || left <= 0) return 0;
    return Math.ceil(left / secondsPerDay());
}

/**
 * **Which merchants are delivery points, and it is not all of them.**
 *
 * A shop that will hold a parcel for collection is making an offer, and a shop with a
 * portal ring in the back room has paid a guild for it. Neither is true of a pedlar on a
 * road, so both are flags a GM sets deliberately rather than something inferred from being
 * a merchant at all.
 *
 * Two rather than one because they are two different arrangements: a depot takes carts, a
 * ring takes rings, and a shop may well have one and not the other.
 */
export const DELIVERY_POINT = Object.freeze({
    PHYSICAL: 'deliveryPhysical',
    PORTAL: 'deliveryPortal'
});

/**
 * Which delivery point a service arrives at, or `null` for one that comes to you.
 *
 * The beast asks nowhere: it goes looking for whoever is holding the receipt, which is the
 * whole of its premium and the reason it costs what it does.
 */
export function deliveryPointFor(service) {
    if (service === 'ground') return DELIVERY_POINT.PHYSICAL;
    if (service === 'portal') return DELIVERY_POINT.PORTAL;
    return null;
}

/**
 * Where the world keeps its own list of places, per delivery point.
 *
 * **A world setting, not a merchant one.** The first cut put the list on each shop, which
 * made a GM retype the same coaching inns into every merchant that sold by post and left
 * five copies to disagree with each other. A place a parcel can reach is a fact about the
 * world; whether a *shop* is one of them is a fact about the shop, and that stays on the
 * shop as a flag.
 */
export function deliveryPlacesKey(point) {
    return point === DELIVERY_POINT.PORTAL ? 'deliveryPlacesPortal' : 'deliveryPlacesPhysical';
}

/**
 * A GM's own list of places, one per line, as a list.
 *
 * **Free text rather than a picker, and deliberately.** Not every place a parcel can go is
 * a merchant somebody has built: a safehouse, a poste restante, a name a party made up.
 * The merchants carrying the flag are offered alongside these, so the list is what the
 * world has plus what the GM has said.
 */
export function customDestinations(raw) {
    return String(raw ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * How much room an item is given on a card wall, as a size token.
 *
 * **Masonry needs something to pack.** A wall of identical cards is two plain columns
 * wearing a fancier name; what makes the layout read is that the stones are different
 * sizes. Foundry item art is square, so there is no natural aspect to vary by — the size
 * has to be *decided*, and if it is being decided it may as well mean something.
 *
 * So it is worth: a Dancing Sword takes a big card and a torch takes a small one, which is
 * how a real catalogue is laid out. Rarity first because it is the sharper signal and most
 * of a shop has none, then price for the ordinary things, which is what tells a lamp from
 * a suit of plate.
 *
 * Thresholds in gold, and deliberately wide apart: a scale with many steps would make
 * almost every card the same middle size and put the packing back where it started.
 */
export function cardSize(rarityToken, priceGp) {
    if (rarityToken && rarityToken !== 'mundane' && rarityToken !== 'common') {
        return rarityToken === 'rare' || rarityToken === 'veryRare' || rarityToken === 'legendary'
            || rarityToken === 'artifact'
            ? 'large'
            : 'medium';
    }
    const gp = Number(priceGp);
    if (!Number.isFinite(gp)) return 'small';
    if (gp >= 250) return 'large';
    if (gp >= 25) return 'medium';
    return 'small';
}

/**
 * An item's own description, as plain text a card can hold.
 *
 * **Stripped rather than enriched.** A shop description is GM-authored and goes through
 * Foundry's enricher; an item's comes out of a compendium somebody else wrote, arrives as
 * arbitrary HTML, and is being dropped into a grid cell forty characters wide. Tags out,
 * entities folded, whitespace collapsed, and cut at a length that still reads as a
 * sentence.
 *
 * Cut on a word boundary where there is one nearby, because a hard slice mid-word reads as
 * a bug rather than as an abridgement.
 */
export function cardBlurb(html, limit = 160) {
    const text = String(html ?? '')
        // **Foundry's own enricher syntax first, before the tags.** An item description out
        // of a compendium is full of `@UUID[Compendium.dnd5e...]{Battleaxe}` and inline
        // rolls, and none of it is HTML -- so stripping tags left the raw reference sitting
        // in the card, which is exactly what a reader must never see. A labelled reference
        // keeps its label, because that is the word the sentence was built around.
        .replace(/@[A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
        .replace(/@[A-Za-z]+\[[^\]]*\]/g, '')
        .replace(/&[A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
        .replace(/&[A-Za-z]+\[[^\]]*\]/g, '')
        .replace(/\[\[[^\]]*\]\]/g, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const space = cut.lastIndexOf(' ');
    return `${(space > limit - 24 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

/**
 * **The shape of a tile, in columns by rows.**
 *
 * These are the spans the grid draws, and now also the spans the *layout* reasons about:
 * the packing below places every tile itself rather than handing the problem to CSS, so
 * these numbers have to mean the same thing in both places or the page a reader sees is not
 * the page that was planned.
 */
export const CARD_SPANS = Object.freeze({
    small: Object.freeze({ w: 1, h: 1 }),
    medium: Object.freeze({ w: 1, h: 2 }),
    large: Object.freeze({ w: 2, h: 2 })
});

/** Columns across a page. The tiles span one or two of them. */
export const PAGE_COLUMNS = 3;

/** Rows down a page. Columns by rows is what a page holds. */
export const PAGE_ROWS = 4;

/**
 * **The shapes an advertisement can take, biggest first.**
 *
 * A notice exists to fill what the goods left over, so it needs more than one shape: a page
 * ending in a two-by-two hole and a page ending in one cell are different holes, and a
 * single small notice can only fill the second. Biggest first because the filler takes the
 * largest shape each hole allows, which is what stops a page ending in a scatter of
 * identical little boxes.
 */
export const AD_SPANS = Object.freeze([
    Object.freeze({ size: 'large', w: 2, h: 2 }),
    Object.freeze({ size: 'wide', w: 2, h: 1 }),
    Object.freeze({ size: 'tall', w: 1, h: 2 }),
    Object.freeze({ size: 'small', w: 1, h: 1 })
]);

/**
 * **The copy that fills an awkward gap at the end of a page.**
 *
 * A real catalogue does this — the last third of a page is never goods, it is the shop
 * telling you what you have forgotten. It is the thing that makes a ragged page read as
 * deliberate rather than as a layout that ran out, and it is free characterisation: a shop
 * that nags you about rations is a shop with a voice.
 *
 * **Each carries a picture**, and it is doing the same job the picture on a tile does:
 * telling you what the notice is about before you have read it. Without one an
 * advertisement in a wall of goods is the only tile that is purely words, which reads as a
 * hole rather than as copy — the thing the notice was cut to fill.
 *
 * Deliberately generic, so any merchant can say any of them. A weaponsmith reminding you
 * about arrows is in character; a weaponsmith reminding you about *its own* stock would
 * need copy per shop, which is a content problem rather than a layout one.
 */
export const CATALOGUE_FILLERS = Object.freeze([
    {
        img: 'icons/consumables/food/bowl-stew-brown.webp',
        title: 'Pack enough rations?',
        body: 'Do not go hungry on your next adventure. Order plenty.'
    },
    {
        img: 'icons/weapons/ammunition/arrows-barbed-white.webp',
        title: 'Have enough pointy things?',
        body: 'Do not spend your next adventure dead. Stock up.'
    },
    {
        img: 'icons/sundries/lights/lantern-iron-lit-yellow.webp',
        title: 'Best deals are in person',
        body: 'Some things never make the catalogue. Visit us.'
    },
    {
        img: 'icons/sundries/survival/rope-wrapped-brown.webp',
        title: 'Rope. Always rope.',
        body: 'Fifty feet can solve more problems than a sword.'
    },
    {
        img: 'icons/containers/chest/chest-simple-box-brown.webp',
        title: 'A word on delivery',
        body: 'Beasts finds you for delivery. Otherwise, pick it up.'
    },
    {
        img: 'icons/sundries/lights/torch-brown-lit.webp',
        title: 'Torches by the dozen',
        body: 'The dark is free. Seeing in it is not.'
    },
    {
        img: 'icons/containers/barrels/barrel-walnut-steel-brown.webp',
        title: 'Ask about bulk',
        body: 'Parties who order together pay one delivery, not four.'
    },
    {
        img: 'icons/tools/nautical/diving-helmet.webp',
        title: 'Nothing here you want?',
        body: 'What is printed is what we ship. Maybe visit us.'
    }
]);

/**
 * Deal advertising into a list of goods, evenly, without touching the goods.
 *
 * **The tiled page fills holes; a list has no holes.** A wall packs and leaves gaps, which
 * is where a notice goes. A list is one column of rows with nothing left over, so an
 * advertisement has to *interrupt* it -- which is what a classified in a column of listings
 * does, and why it reads as one rather than as a broken row.
 *
 * Spaced rather than random. Random clusters: three in a row at the top of a shelf and none
 * below is what a reader notices, and what they notice is that something is wrong. This
 * puts one every `every` rows, which is regular enough to read as the layout and irregular
 * enough not to look like part of a row.
 *
 * Pure, and it copies: the caller's list is not touched.
 */
export function adsIntoList(rows, { every = 7, fillers = CATALOGUE_FILLERS, offset = 0 } = {}) {
    if (!rows?.length || !fillers.length || every < 1) return [...(rows ?? [])];

    const out = [];
    let taken = offset;
    for (let i = 0; i < rows.length; i++) {
        out.push(rows[i]);
        // Never after the last row: an advertisement at the bottom of a shelf is a footer,
        // and a footer is the one place a reader has already stopped looking.
        const last = i === rows.length - 1;
        if (!last && (i + 1) % every === 0) {
            out.push({ ...fillers[taken % fillers.length], isAd: true });
            taken++;
        }
    }
    return out;
}

/**
 * **Where every tile actually goes, worked out here rather than left to the browser.**
 *
 * CSS `grid-auto-flow: dense` does very nearly this: it walks the grid in reading order and
 * drops each item in the first place it fits. What it cannot do is *say what it did* — and
 * the holes were the whole problem, being exactly the cells the browser knew about and the
 * module did not. Counting cells was never enough: twelve cells of goods can still leave a
 * two-by-two hole and a tile that will not fit in it.
 *
 * So the placement is computed, the free cells come back with it, and the caller fills
 * them. The positions are written onto the tiles as explicit grid coordinates, so what the
 * browser draws is what was planned rather than a second opinion about it.
 *
 * @param {Array} entries Tiles carrying a `size` naming a `CARD_SPANS` shape.
 * @param {object} options `columns`, and `rows` as a hard limit (a page) or null (a wall).
 * @returns {{placed: Array, free: Array, rows: number, spilled: Array, grid: Array}}
 */
export function layoutTiles(entries, { columns = PAGE_COLUMNS, rows = null } = {}) {
    const grid = [];
    const placed = [];
    let spilled = [];

    const rowAt = (r) => {
        while (grid.length <= r) grid.push(new Array(columns).fill(false));
        return grid[r];
    };

    const fits = (r, c, w, h) => {
        if (c + w > columns) return false;
        if (rows !== null && r + h > rows) return false;
        for (let y = r; y < r + h; y++) {
            const line = rowAt(y);
            for (let x = c; x < c + w; x++) if (line[x]) return false;
        }
        return true;
    };

    const occupy = (r, c, w, h) => {
        for (let y = r; y < r + h; y++) {
            const line = rowAt(y);
            for (let x = c; x < c + w; x++) line[x] = true;
        }
    };

    /** The first place this shape fits, in reading order. `dense`, exactly. */
    const findSpot = (w, h) => {
        const limit = rows === null ? grid.length : rows - h;
        for (let r = 0; r <= limit; r++) {
            rowAt(r + h - 1);
            for (let c = 0; c <= columns - w; c++) if (fits(r, c, w, h)) return { r, c };
        }
        return null;
    };

    const list = entries ?? [];
    for (let i = 0; i < list.length; i++) {
        const span = CARD_SPANS[list[i]?.size] ?? CARD_SPANS.small;
        const spot = findSpot(span.w, span.h);
        if (!spot) {
            // Nothing left on this page will hold it, and everything after it goes too: a
            // catalogue is printed in order, and reaching past a large tile to fit a small
            // one would reorder the goods behind the reader's back.
            spilled = list.slice(i);
            break;
        }
        occupy(spot.r, spot.c, span.w, span.h);
        placed.push({ ...list[i], col: spot.c + 1, row: spot.r + 1, w: span.w, h: span.h });
    }

    const height = rows ?? grid.length;
    const free = [];
    for (let r = 0; r < height; r++) {
        const line = rowAt(r);
        for (let c = 0; c < columns; c++) if (!line[c]) free.push({ r, c });
    }

    return { placed, free, rows: height, spilled, grid };
}

/**
 * Fill every empty cell with advertising, taking the biggest shape each hole allows.
 *
 * **A page is never left with a hole in it**, which is the guarantee the whole layout
 * exists to make: the one-by-one shape fits any single free cell, so this always ends with
 * the grid full. Bigger shapes are tried first, so a large gap becomes one notice rather
 * than four, and the copy cycles so a shop does not print the same advertisement twice on
 * one page.
 */
export function fillWithAds(layout, { columns = PAGE_COLUMNS, fillers = CATALOGUE_FILLERS, from = 0 } = {}) {
    if (!fillers.length) return { ads: [], used: 0 };

    const grid = layout.grid;
    const rowAt = (r) => {
        while (grid.length <= r) grid.push(new Array(columns).fill(false));
        return grid[r];
    };
    const fits = (r, c, w, h) => {
        if (c + w > columns || r + h > layout.rows) return false;
        for (let y = r; y < r + h; y++) {
            const line = rowAt(y);
            for (let x = c; x < c + w; x++) if (line[x]) return false;
        }
        return true;
    };

    const ads = [];
    let used = 0;

    for (const cell of layout.free) {
        if (rowAt(cell.r)[cell.c]) continue;
        const span = AD_SPANS.find((shape) => fits(cell.r, cell.c, shape.w, shape.h)) ?? AD_SPANS.at(-1);

        for (let y = cell.r; y < cell.r + span.h; y++) {
            const line = rowAt(y);
            for (let x = cell.c; x < cell.c + span.w; x++) line[x] = true;
        }

        ads.push({
            kind: 'filler',
            ...fillers[(from + used) % fillers.length],
            size: span.size,
            col: cell.c + 1,
            row: cell.r + 1,
            w: span.w,
            h: span.h
        });
        used++;
    }

    return { ads, used };
}

/**
 * Deal the goods out into pages that are always full.
 *
 * **Every page carries at least one advertisement, and no page has a hole in it.** That is
 * one requirement rather than two: goods are placed until the next one will not fit, one
 * cell is kept back so a notice has somewhere to go, and whatever is still empty is filled
 * with notices cut to the holes. A page that came out exactly full gives its last tile back
 * to the next page to make the room.
 *
 * The version this replaces counted cells and hoped. Twelve cells of goods can still leave
 * a two-by-two hole that no tile fits, which is why pages ended ragged and why the
 * advertising only ever turned up at the end of the last one.
 *
 * Pure, and the arithmetic the printed page depends on: `tests/test-cards.mjs`.
 */
export function paginateCards(entries, {
    columns = PAGE_COLUMNS, rows = PAGE_ROWS, fillers = CATALOGUE_FILLERS
} = {}) {
    const pages = [];
    let remaining = [...(entries ?? [])];
    let advert = 0;

    while (remaining.length) {
        let layout = layoutTiles(remaining, { columns, rows });
        if (!layout.placed.length) break;   // A tile wider than the page: stop rather than loop.

        // Keep a cell back for the shop's own voice. A page that filled exactly hands its
        // last tile on rather than printing an advertisement nobody had room for.
        if (!layout.free.length && layout.placed.length > 1) {
            const keep = layout.placed.length - 1;
            layout = layoutTiles(remaining.slice(0, keep), { columns, rows });
            layout.spilled = remaining.slice(keep);
        }

        const { ads, used } = fillWithAds(layout, { columns, fillers, from: advert });
        advert += used;
        pages.push([...layout.placed, ...ads]);
        remaining = layout.spilled;
    }

    return pages;
}

/**
 * The same, for a wall with no pages: as many rows as it takes, and no holes.
 *
 * A shelf is not a printed object, and paginating one would hide stock behind a control in
 * the window whose whole job is showing what is in the shop. So the wall grows, and the
 * only thing left to fill is what the packing left over — on a wall, a ragged last row
 * rather than a page's worth of gaps.
 */
export function layoutWall(entries, { columns = PAGE_COLUMNS, fillers = CATALOGUE_FILLERS, from = 0 } = {}) {
    const layout = layoutTiles(entries, { columns, rows: null });
    const { ads } = fillWithAds(layout, { columns, fillers, from });
    return [...layout.placed, ...ads];
}

/**
 * **The crate a parcel travels in, as an object with weight and limits.**
 *
 * A parcel used to be a weightless, priceless box that appeared with the goods in it,
 * which quietly made mail order the best bag of holding in the game: order anything, any
 * amount, and it arrives in a container that costs nothing to carry. A crate a courier
 * straps to a cart is a real object -- it weighs something empty, it holds only so much,
 * and the shop wants it back or wants paying for it.
 *
 * **No extradimensional storage.** What is in it weighs what it weighs, on top of the box
 * itself; there is no weight reduction and no bigger-on-the-inside. That is the whole
 * reason the limit bites, and why a big order arrives as several crates.
 */
export const CRATE = Object.freeze({
    /** The empty box, carried. */
    weightLb: 5,
    /** What it will hold. Volume is descriptive; the weight is the one that is enforced. */
    capacityLb: 50,
    volumeCubicFeet: 2,
    /** What the shop charges for it, refunded if it goes back. */
    depositGp: 5
});

/** Where the crate deposit lives, so a GM can price their own world's boxes. */
export const CRATE_DEPOSIT_SETTING = 'deliveryCrateDeposit';

/**
 * Deal an order's lines into crates, by weight.
 *
 * **Greedy, first-fit, in the order the goods were ordered.** A better packing exists --
 * this is bin packing, and bin packing has a literature -- but every gain from a cleverer
 * one is a crate saved on an edge case, at the cost of a delivery whose contents are
 * shuffled into an order nobody chose. Reading a parcel's manifest and finding it in the
 * order you added things is worth more than a marginal crate.
 *
 * A **stack is split** rather than bumped whole: sixty torches are not an indivisible
 * object, and moving all sixty to the next crate to keep them together would waste most of
 * this one. A **single item heavier than an empty crate** travels alone rather than being
 * refused -- an order stopped at the counter because one thing is heavy is a worse answer
 * than an order that arrives in an over-full box.
 *
 * Pure, and the arithmetic that decides what a delivery costs: `tests/test-mail.mjs`.
 */
export function packCrates(lines, capacity = CRATE.capacityLb) {
    const limit = Math.max(1, Number(capacity) || CRATE.capacityLb);
    const crates = [];
    let crate = [];
    let load = 0;

    const close = () => {
        if (!crate.length) return;
        crates.push(crate);
        crate = [];
        load = 0;
    };

    for (const line of lines ?? []) {
        const each = Math.max(0, Number(line?.source?.system?.weight?.value) || 0);
        let left = Math.max(1, Math.trunc(Number(line?.quantity) || 1));

        while (left > 0) {
            // Weightless things never fill a crate, so they all go in this one.
            let fits = each > 0 ? Math.floor((limit - load) / each) : left;

            if (fits <= 0) {
                // Nothing more fits. Start a fresh crate -- unless this one is already
                // fresh, in which case a single item is heavier than a crate holds.
                if (crate.length) { close(); continue; }
                fits = 1;
            }

            const take = Math.min(fits, left);
            crate.push({ ...line, quantity: take });
            load += take * each;
            left -= take;
            if (load >= limit) close();
        }
    }
    close();

    return crates;
}

/** Where a receipt keeps its consignment. */
export const RECEIPT_FLAG = 'consignment';

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

/**
 * An item's rarity as one token, or null for the ordinary case.
 *
 * **Blank is not `common`, and the difference is the whole reason this exists.** dnd5e
 * leaves `system.rarity` empty on everything non-magical -- rope, torches, a plain
 * longsword -- while `common` means a common *magic* item. So null here means "an
 * ordinary object", which is what most of a shop is, and is why a row with no rarity
 * shows none rather than showing "Mundane" beside every torch.
 *
 * Spaces are tolerated on the way in because a hand-authored item may carry
 * `very rare` where the system writes `veryRare`, and a row that silently declined to
 * label the one legendary item in the shop is the kind of thing nobody reports.
 */
export function itemRarity(item) {
    const raw = String(item?.system?.rarity ?? '').trim();
    if (!raw) return null;
    const camel = raw.replace(/\s+(.)/g, (_match, next) => next.toUpperCase());
    return `${camel.charAt(0).toLowerCase()}${camel.slice(1)}`;
}

/**
 * A rarity token as words: `veryRare` reads "Very rare".
 *
 * Shared by the shop row and the query filter's chips, which derived it separately and
 * were one edit away from disagreeing about the same six words.
 */
export function rarityLabel(token) {
    const raw = String(token ?? '').trim();
    if (!raw) return null;
    const spaced = raw.replace(/([a-z])([A-Z])/g, '$1 $2');
    return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1).toLowerCase()}`;
}

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
 * The highest a stock ceiling can be set to.
 *
 * Not a rule about shops -- it is the top of the slider. Twenty is already more of one
 * thing than any shop here draws (a shelf's own `maxPerItem` defaults to that), so past
 * it a "ceiling" caps nothing, and a slider whose useful travel is its first tenth is a
 * number box with a worse hit area.
 */
export const MAX_STOCK_CAP = 20;

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
    // Both, and **which one gets the last slots**. They feed one product target, so on a
    // nearly full shelf the order is the whole difference between a shop stocked from a
    // list somebody wrote and one stocked from whatever is installed. That used to be
    // fixed at tables-first with the reasoning in a comment; it is a GM's decision, and
    // a fence and a general store want opposite answers.
    BOTH: 'both',
    BOTH_QUERY: 'bothQuery'
});

/** Whether a source draws from the compendiums at all. */
export function drawsFromQuery(source) {
    return source === SOURCE.QUERY || source === SOURCE.BOTH || source === SOURCE.BOTH_QUERY;
}

/** Whether a source draws from roll tables at all. */
export function drawsFromTables(source) {
    return source === SOURCE.TABLE || source === SOURCE.BOTH || source === SOURCE.BOTH_QUERY;
}

/**
 * **Manual, because a new shelf has nothing on it and no opinion about what should be.**
 *
 * A shelf created as a table shelf is a shelf waiting for a table that may never be
 * dropped on it, and one created as a query shelf starts pulling in whatever the world
 * happens to hold. Manual is the only default that does nothing until asked — which is
 * what a GM who has just pressed Add Inventory has actually said so far.
 *
 * Read through `?? DEFAULT_SOURCE` everywhere rather than stamped onto shelves: a shelf
 * with no source stored has never been told what to draw, which is exactly what manual
 * means, so the fallback and the default say the same thing by construction.
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
