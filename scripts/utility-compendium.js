// ==================================================================
// ===== COMPENDIUM QUERY ===========================================
// ==================================================================
//
// Where a shelf's stock comes from when it is not a roll table.
//
// **A table stores references, so it is a snapshot, and snapshots rot.** Rename a pack,
// update a content module, uninstall one, and its rows point at nothing — silently, until
// 2026-08-23, when a dead row started being reported. A query has no such failure mode: it
// resolves against what is installed at the moment it runs, and it picks up new content
// instead of freezing at whatever somebody typed in last year.
//
// **Thin on purpose.** `blacksmith.compendiums.query` does the work and owns three dnd5e
// facts that are each a silent wrong answer rather than an error:
//
//   - **Mundane gear has a BLANK rarity, not `common`.** Asking for `['common']` returns
//     magic items only, with every plain longsword absent behind a plausible result.
//   - **Price has a denomination.** 50 sp is 5 gp; a raw compare on the stored number is
//     wrong for anything not priced in gold. Ranges here are gold, converted by them.
//   - **Unpriced and free share a stored 0** and cannot be told apart at the index. They
//     are excluded from a price range by default. Merchant tells them apart on an item it
//     owns, via `FREE_FLAG` — but that flag does not exist in a compendium, so a shelf
//     stocked this way gets priced goods and never accidental giveaways.
//
// Their `limit` caps the OUTPUT while the scan stays complete. Ours would have been a
// stop-scan, which draws every shop's stock from the first configured pack and never opens
// the sixth — a result set indistinguishable from a correct one.

import { MODULE } from './const.js';
import { physicalTypes } from './utility-inventory.js';

/** Rarity tokens, in the order a GM reads them. `mundane` is unmarked gear. */
export const RARITIES = Object.freeze(['mundane', 'common', 'uncommon', 'rare', 'veryRare', 'legendary', 'artifact']);

/**
 * What a shelf with no query of its own asks for.
 *
 * A general store: everything physical, nothing magical, nothing precious. Deliberately
 * narrow — a shelf that returned artifacts by default would be a surprise nobody asked for,
 * and widening it is one click where narrowing it after the fact is a cleanup.
 */
export const DEFAULT_QUERY = Object.freeze({
    subtypes: null,                          // null means "every physical type"
    rarity: ['mundane', 'common'],
    priceGp: { min: 0, max: 500 }
});

function _api() {
    return game.modules.get('coffee-pub-blacksmith')?.api?.compendiums ?? null;
}

/**
 * Whether this Blacksmith can answer a stock query.
 *
 * Feature-detected rather than version-pinned, the way `hasExchange` and `hasSetCurrency`
 * already are: a shop must keep working when the hub is a version behind, and a query
 * shelf that finds nothing is a shelf a GM can still stock by hand.
 */
export function hasQuery() {
    return typeof _api()?.query === 'function';
}

/** A stored query, filled in from the defaults and clamped to what a shelf may hold. */
export function normalizeQuery(query) {
    const stored = query ?? {};
    const subtypes = Array.isArray(stored.subtypes) && stored.subtypes.length
        // Never widen past the physical whitelist: a shelf cannot hold a spell, and asking
        // for one returns nothing anyway -- a price range plus a non-physical type is empty
        // by design, so an unfiltered subtype list would quietly make the shelf barren.
        ? stored.subtypes.filter((type) => physicalTypes().includes(type))
        : null;
    const rarity = Array.isArray(stored.rarity) && stored.rarity.length
        ? stored.rarity.filter((token) => RARITIES.includes(token))
        : [...DEFAULT_QUERY.rarity];
    const min = Number(stored.priceGp?.min);
    const max = Number(stored.priceGp?.max);
    return {
        subtypes,
        rarity: rarity.length ? rarity : [...DEFAULT_QUERY.rarity],
        // **`max: null` is "no ceiling", and it has to be null rather than Infinity.**
        // A stored query is a document flag, and `JSON.stringify(Infinity)` is `null`
        // — so writing Infinity would read back as null on the next load and mean
        // something different by accident. Storing null on purpose makes the round trip
        // say what it meant.
        priceGp: {
            min: Number.isFinite(min) && min >= 0 ? min : DEFAULT_QUERY.priceGp.min,
            max: stored.priceGp?.max === null ? null
                : (Number.isFinite(max) && max > 0 ? max : DEFAULT_QUERY.priceGp.max)
        }
    };
}

/**
 * Ask what a shelf like this could stock, right now.
 *
 * @param {object} query A stored inventory query.
 * @param {number} limit How many candidates to bring back. Caps the output, not the scan.
 * @returns {Promise<Array<object>>} Rows carrying `uuid`, `name`, `type`, `rarity`, `priceGp`.
 */
export async function queryStock(query, limit = 200) {
    if (!hasQuery()) return [];
    const filter = normalizeQuery(query);
    try {
        return await _api().query({
            type: 'Item',
            subtypes: filter.subtypes ?? physicalTypes(),
            rarity: filter.rarity,
            // A null ceiling is omitted rather than sent: the API reads a missing bound
            // as "no bound", where a null one is a value it would have to interpret.
            priceGp: filter.priceGp.max === null
                ? { min: filter.priceGp.min }
                : filter.priceGp,
            // A shelf sells things, and a thing with no price cannot be sold. Merchant's
            // own giveaways are a flag on an item it owns, not an absent price.
            includeUnpriced: false,
            sources: null,
            limit: Math.max(1, Math.trunc(Number(limit)) || 200)
        });
    } catch (error) {
        console.error(`${MODULE.TITLE} | Could not query the compendiums:`, error);
        return [];
    }
}

/** A one-line summary of what a query asks for, for the card that carries it. */
export function describeQuery(query) {
    const filter = normalizeQuery(query);
    const kinds = filter.subtypes?.length
        ? filter.subtypes.join(', ')
        : game.i18n.localize('coffee-pub-merchant.query.anyKind');
    return game.i18n.format('coffee-pub-merchant.query.summary', {
        kinds,
        rarity: filter.rarity.join(', '),
        min: filter.priceGp.min,
        max: filter.priceGp.max === null
            ? game.i18n.localize('coffee-pub-merchant.query.anyPrice')
            : filter.priceGp.max
    });
}
