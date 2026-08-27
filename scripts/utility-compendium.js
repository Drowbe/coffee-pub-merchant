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
    priceGp: { min: 0, max: 500 },
    // null means the curated set; an array means this shelf's own list. See `normalizeQuery`.
    sources: null
});

function _api() {
    return game.modules.get('coffee-pub-blacksmith')?.api?.compendiums ?? null;
}

/**
 * The curated set: the Item compendiums the GM put in Blacksmith's slots.
 *
 * **This is the world's answer to "what content do we actually use".** Every Coffee Pub
 * module matches items, scans journals and fills inventories against it, which is exactly
 * why a shop should be able to step outside it without changing it: a shady fence drawing
 * on a pack of cursed junk must not make that pack part of the world's item matching.
 */
export function curatedSources() {
    const api = _api();
    if (typeof api?.getSearchOrder !== 'function') return [];
    try {
        return api.getSearchOrder('Item') ?? [];
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not read the curated compendiums:`, error);
        return [];
    }
}

/**
 * Every Item compendium installed, whether or not it is curated.
 *
 * `getAllPacks` rather than `getChoices`: the whole point of a custom list is reaching
 * the packs Blacksmith is deliberately not searching.
 */
export function allItemPacks() {
    const api = _api();
    if (typeof api?.getAllPacks !== 'function') return [];
    try {
        return api.getAllPacks('Item') ?? [];
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not list the item compendiums:`, error);
        return [];
    }
}

/**
 * What a source id is called on screen, and whether it still exists.
 *
 * A pack that has been uninstalled keeps its id on the shelf and is **reported** rather
 * than dropped, the same as a roll table's dead row: a shelf quietly drawing from six
 * packs when the GM listed seven is the failure this whole source was chosen to avoid.
 */
export function describeSource(id) {
    if (id === 'world') {
        return { id, label: game.i18n.localize('coffee-pub-merchant.config.worldItems'), package: '', missing: false };
    }
    const pack = allItemPacks().find((entry) => entry.id === id);
    if (pack) return { id, label: pack.label, package: pack.package ?? '', missing: false };
    return { id, label: id, package: '', missing: true };
}

/** The ids a stored list actually draws from: the ones switched on. */
export function enabledSources(sources) {
    return (sources ?? []).filter((entry) => entry.enabled).map((entry) => entry.id);
}

/**
 * Whether a pack id names a compendium of Items.
 *
 * **A compendium of roll tables is a compendium.** Dropping one on the item list was
 * accepted and then displayed as *Gone* -- the row said the pack had been uninstalled,
 * when it was installed and simply held the wrong kind of thing. Two different wrong
 * answers from one missing check.
 */
export function isItemPack(id) {
    if (id === 'world') return true;
    return allItemPacks().some((entry) => entry.id === id);
}

/**
 * A pack id out of anything Foundry puts on a drop.
 *
 * Two payloads, because both mean the same thing to a person: a compendium dragged from
 * the sidebar (`{ type: 'Compendium', collection }`), and any document dragged out of one
 * (a uuid of `Compendium.<pack>.<Doc>.<id>`). The second is kept because finding the pack
 * you want by finding a thing in it is how anybody actually browses -- but it is
 * **deliberately not advertised on the drop zone**: "or anything from one" reads as an
 * offer to add the *thing*, where what it adds is the pack around it. A convenience that
 * works when you try it is worth having; a label that promises the wrong result is not.
 */
export function packIdFromDrop(data) {
    if (data?.type === 'Compendium' && data.collection) return String(data.collection);
    const uuid = String(data?.uuid ?? '');
    const match = /^Compendium\.([^.]+\.[^.]+)\./.exec(uuid);
    return match ? match[1] : null;
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
    // **null is the curated set; an array is this shelf's own list, and `[]` is a list
    // with nothing on it.** Those are three states, not two: a GM who has switched to a
    // custom list and not yet dropped a pack on it has a shelf that draws nothing, and
    // silently falling back to the curated set there would stock a shady fence from the
    // world's ordinary content -- the one thing they were trying to avoid.
    //
    // Entries are `{ id, enabled }`, matching the roll tables beside them: **off keeps the
    // pack and its place and simply stops it contributing**, which is what a GM wants for
    // a seasonal or a maybe-later pack. A bare string reads as an enabled entry, because
    // that is what a list written before the switch existed meant.
    const seen = new Set();
    const sources = Array.isArray(stored.sources)
        ? stored.sources
            .map((entry) => (typeof entry === 'string' ? { id: entry, enabled: true } : entry))
            .filter((entry) => typeof entry?.id === 'string' && entry.id)
            .filter((entry) => !seen.has(entry.id) && seen.add(entry.id))
            .map((entry) => ({ id: entry.id, enabled: entry.enabled !== false }))
        : null;
    const min = Number(stored.priceGp?.min);
    const max = Number(stored.priceGp?.max);
    return {
        subtypes,
        sources,
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
    // A custom list with nothing switched on draws nothing, and says so here rather than
    // reaching the hub -- `sources: []` there is "no sources configured for type", which
    // is a warning about Blacksmith's settings for a state that is ours.
    const chosen = filter.sources && enabledSources(filter.sources);
    if (chosen && !chosen.length) return [];
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
            // null asks for the curated set, which is the hub's own default.
            sources: chosen,
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
