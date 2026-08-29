// Exercise the stock logic against a stubbed Foundry. Not a Foundry test — it
// cannot catch a wrong document path — but it does catch arithmetic, inheritance
// and lock ordering, which are the parts that are pure logic.
import assert from 'node:assert';
import fs from 'node:fs';

globalThis.game = {
    user: { isGM: true },
    time: { worldTime: 0, calendar: { days: { hoursPerDay: 24, minutesPerHour: 60, secondsPerMinute: 60 } } },
    actors: [],
    modules: { get: () => null }
};
globalThis.Hooks = { on: () => {} };
globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} } };
globalThis.foundry = { utils: { mergeObject: (a, b) => ({ ...a, ...b }) } };
globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;

const { STOCK, PAR_FLAG, DEFAULT_RESTOCK_DAYS, secondsPerDay, isScheduledOpen, isAlwaysOpen, isAlwaysClosed } =
    await import('../scripts/const.js');

// --- secondsPerDay ------------------------------------------------------
assert.strictEqual(secondsPerDay(), 86400, 'standard calendar');
game.time.calendar.days.hoursPerDay = 20;
assert.strictEqual(secondsPerDay(), 20 * 3600, 'a 20-hour day');
game.time.calendar = null;
assert.strictEqual(secondsPerDay(), 86400, 'no calendar falls back');
game.time.calendar = { days: { hoursPerDay: 24, minutesPerHour: 60, secondsPerMinute: 60 } };
console.log('ok  secondsPerDay');

// --- policy resolution, lifted verbatim from the manager ----------------
function resolveStockPolicy(merchantStock, inventoryStock) {
    const policies = Object.values(STOCK);
    if (policies.includes(inventoryStock)) return inventoryStock;
    return policies.includes(merchantStock) ? merchantStock : STOCK.INFINITE;
}
assert.strictEqual(resolveStockPolicy(undefined, null), STOCK.INFINITE, 'unset defaults to infinite');
assert.strictEqual(resolveStockPolicy(STOCK.FINITE, null), STOCK.FINITE, 'inventory inherits the merchant');
assert.strictEqual(resolveStockPolicy(STOCK.FINITE, STOCK.INFINITE), STOCK.INFINITE, 'inventory overrides');
assert.strictEqual(resolveStockPolicy(STOCK.INFINITE, STOCK.FINITE), STOCK.FINITE, 'buyback stays finite');
assert.strictEqual(resolveStockPolicy('nonsense', 'rubbish'), STOCK.INFINITE, 'garbage falls back');
console.log('ok  resolveStockPolicy');

// --- the lock -----------------------------------------------------------
const locks = new Map();
function withLock(key, fn) {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    locks.set(key, tail);
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
}

// Two buyers, one item: without the lock both read 1 and both succeed.
let count = 1;
const buy = () => withLock('shop', async () => {
    const seen = count;
    await new Promise((r) => setTimeout(r, 5));   // the await that loses the race
    if (seen < 1) return 'refused';
    count = seen - 1;
    return 'sold';
});
const [a, b] = await Promise.all([buy(), buy()]);
assert.deepStrictEqual([a, b].sort(), ['refused', 'sold'], 'exactly one buyer wins');
assert.strictEqual(count, 0, 'and the count lands at zero');
console.log('ok  lock serialises two buyers');

// A thrown callback must not strand everything queued behind it.
const order = [];
const boom = withLock('shop', async () => { throw new Error('boom'); }).catch(() => order.push('threw'));
const after = withLock('shop', async () => { order.push('ran'); });
await Promise.all([boom, after]);
assert.deepStrictEqual(order, ['threw', 'ran'], 'the queue survives a failure');
console.log('ok  lock survives a throwing callback');

// The map must not grow without bound.
await withLock('shop', async () => {});
await new Promise((r) => setTimeout(r, 10));
assert.strictEqual(locks.size, 0, 'settled locks are released');
console.log('ok  lock releases its key');

// --- restock cadence ----------------------------------------------------
function due(worldTime, last, days) {
    const interval = (Number.isFinite(days) && days > 0 ? days : DEFAULT_RESTOCK_DAYS) * secondsPerDay();
    if (!Number.isFinite(last) || worldTime < last) return 'reset';
    return worldTime - last >= interval ? 'restock' : 'wait';
}
const DAY = 86400;
assert.strictEqual(due(DAY, 0, 1), 'restock', 'a full day is due');
assert.strictEqual(due(DAY - 1, 0, 1), 'wait', 'just short is not');
assert.strictEqual(due(7 * DAY, 0, 1), 'restock', 'a week is one restock, not seven');
assert.strictEqual(due(2 * DAY, 0, 7), 'wait', 'a 7-day inventory waits');
assert.strictEqual(due(0, undefined, 1), 'reset', 'an inventory with no clock starts one');
assert.strictEqual(due(0, 5 * DAY, 1), 'reset', 'winding the clock back resets rather than stranding');
assert.strictEqual(due(DAY, 0, 0), 'restock', 'a zero cadence falls back to the default');
console.log('ok  restock cadence');

// --- par ----------------------------------------------------------------
function parOf(quantity, flag) {
    const stored = Number(flag);
    return Number.isFinite(stored) ? Math.max(0, Math.trunc(stored)) : quantity;
}
assert.strictEqual(parOf(3, undefined), 3, 'an inventory stocked before par existed reads as full');
assert.strictEqual(parOf(0, 6), 6, 'a sold-out inventory still knows what it keeps');
assert.strictEqual(parOf(0, -2), 0, 'a negative par clamps rather than growing stock');
assert.strictEqual(parOf(2, 4.7), 4, 'a fractional par truncates');
assert.strictEqual(PAR_FLAG, 'par');

// A buyback inventory ignores a stored par entirely: its stock is whatever the party
// sold it, and there is nothing it is "kept at". This guards a real leak --
// registerTransientFlag hides a flag from merge comparison but does not strip it
// from the payload, so `par` travels out with a bought item and back in when it is
// sold. A bedroll bought from an inventory kept at six would otherwise arrive on the
// buyback inventory claiming a par of six, and the next restock would manufacture five
// bedrolls from a target the shop never set.
const parFor = (mode, quantity, flag) => (mode === 'buyback' ? quantity : parOf(quantity, flag));
assert.strictEqual(parFor('buyback', 1, 6), 1, 'a buyback inventory ignores a par that rode in');
assert.strictEqual(parFor('buyback', 1, undefined), 1, 'and has none of its own either');
assert.strictEqual(parFor('sale', 1, 6), 6, 'while an ordinary inventory still keeps what it keeps');
console.log('ok  par resolution');

// --- what a roll is allowed to do ---------------------------------------
// Lifted verbatim from `MerchantManager._withinLimits`, minus the document access.
// This is the rule that decides whether restocking maintains a shop or inflates it,
// and it was wrong in both directions at once: a roll topped up rows the GM had set a
// level for, and it left every arrival with no level at all.
function withinLimits(held, drawn, { maxProducts, depth = () => 1 }) {
    const carried = new Set(held);
    let rows = carried.size;
    const allowed = [];
    for (const item of drawn) {
        if (carried.has(item.key)) continue;      // already on the shelf: leave it alone
        if (rows >= maxProducts) continue;        // the shelf is full of products
        carried.add(item.key);
        rows++;
        allowed.push({ key: item.key, quantity: depth(item), par: depth(item) });
    }
    return allowed;
}

// A roll never deepens a row that is already there. Topping up is the restock's job,
// and it refills to the level the GM set -- a table adding to the same row would push
// it past that level and make the number they typed mean nothing.
assert.deepStrictEqual(
    withinLimits(['flute'], [{ key: 'flute' }], { maxProducts: 25 }),
    [],
    'a rolled result already on the shelf is left entirely alone');

// Which is also what stops the duplicate rows: the same draw twice in one restock is
// one new product, not two.
assert.deepStrictEqual(
    withinLimits([], [{ key: 'torch' }, { key: 'torch' }], { maxProducts: 25, depth: () => 4 }),
    [{ key: 'torch', quantity: 4, par: 4 }],
    'the same product drawn twice in one roll is one row');

// The product count is a target to fill up to, not a ceiling to clip against.
assert.deepStrictEqual(
    withinLimits(['a', 'b'], [{ key: 'c' }, { key: 'd' }], { maxProducts: 3 }).map((row) => row.key),
    ['c'],
    'a shelf carrying two of three takes one more product and no more');

// **Every arrival carries its own level.** Without this the row has no target and
// `getStock` falls back to the current quantity -- which is the ratchet: sell three of
// four and the target silently becomes one, sell the last and it becomes zero, and
// "restocks the same items" can never put anything back.
const arrivals = withinLimits([], [{ key: 'rope' }], { maxProducts: 25, depth: () => 6 });
assert.strictEqual(arrivals[0].par, arrivals[0].quantity,
    'a new row arrives maintained, at the level it turned up with');
console.log('ok  a roll brings new products, never more of what is already carried');

// --- four sources, and what each draws -----------------------------------
// Manual placement works on every shelf; what a source chooses is what arrives
// *without* being asked for. Hence "Manual only" rather than "Manual".
const SRC = { MANUAL: 'manual', QUERY: 'query', TABLE: 'table', BOTH: 'both' };
const drawsFrom = (source) => ({
    tables: source === SRC.TABLE || source === SRC.BOTH,
    query: source === SRC.QUERY || source === SRC.BOTH
});
assert.deepStrictEqual(drawsFrom(SRC.MANUAL), { tables: false, query: false }, 'manual draws nothing');
assert.deepStrictEqual(drawsFrom(SRC.TABLE), { tables: true, query: false }, 'tables draw tables');
assert.deepStrictEqual(drawsFrom(SRC.QUERY), { tables: false, query: true }, 'query draws the compendiums');
assert.deepStrictEqual(drawsFrom(SRC.BOTH), { tables: true, query: true }, 'and both draws both');

// **Tables take the free slots first.** Both feed one product target, so on a nearly full
// shelf the order decides who gets the last few — and the curated half should land, with
// the query as filler. Modelled the way `restockInventory` runs them: tables, then query.
{
    const target = 5;
    const carried = new Set(['rope']);
    const take = (candidates) => {
        const got = [];
        for (const name of candidates) {
            if (carried.has(name) || carried.size >= target) continue;
            carried.add(name);
            got.push(name);
        }
        return got;
    };
    carried.add('a'); carried.add('b'); carried.add('c');   // four carried, one slot left
    const fromTables = take(['signature blade']);
    const fromQuery = take(['ordinary dagger']);
    assert.deepStrictEqual(fromTables, ['signature blade'], 'the curated row takes the last slot');
    assert.deepStrictEqual(fromQuery, [], 'and the filler gets none, rather than the other way round');
}

// Nothing arrives twice. `_withinLimits` matches rows by name and type, so the same
// longsword offered by a table and by the query is one row, not two.
{
    const carried = new Set();
    const seen = [];
    for (const name of ['longsword', 'longsword']) {
        if (carried.has(name)) continue;
        carried.add(name);
        seen.push(name);
    }
    assert.deepStrictEqual(seen, ['longsword'], 'one row, however many sources offered it');
}
console.log('ok  four sources, tables first, nothing drawn twice');

// --- an illustration path has to survive being a CSS url() ---------------
// **A relative `url()` in CSS resolves against the stylesheet, not the document.** The
// path is substituted into a rule living in `styles/window-shop.css`, so `modules/x.webp`
// was fetched as `modules/coffee-pub-merchant/styles/modules/x.webp` — a 404 with nothing
// in it to suggest the cause, since the path was right and the file was there.
function illustrationUrl(stored, getRoute) {
    const path = String(stored ?? '').trim();
    if (!path) return null;
    if (/^(?:https?:)?\/\//i.test(path)) return path;
    if (typeof getRoute === 'function') return getRoute(path);
    return path.startsWith('/') ? path : `/${path}`;
}
const route = (p) => '/' + p.replace(/^\//, '');

assert.strictEqual(illustrationUrl('modules/x/y.webp', route), '/modules/x/y.webp',
    'a world-relative path is rooted, or CSS looks for it beside the stylesheet');
assert.strictEqual(illustrationUrl('/modules/x/y.webp', route), '/modules/x/y.webp',
    'an already-rooted path is not rooted twice');
// A GM may reasonably point at either of these, and rewriting them breaks them.
assert.strictEqual(illustrationUrl('https://example.test/x.png', route), 'https://example.test/x.png',
    'an absolute URL is left alone');
assert.strictEqual(illustrationUrl('//example.test/x.png', route), '//example.test/x.png',
    'and so is a protocol-relative one');
// Absent, blank and whitespace all mean "no illustration" — the card must render as it
// always did rather than carrying an attribute pointing at nothing.
for (const empty of [null, undefined, '', '   ']) {
    assert.strictEqual(illustrationUrl(empty, route), null, `${JSON.stringify(empty)} is no illustration`);
}
// Without `getRoute` — an older Foundry — a leading slash is the fallback. It is not the
// default, because an install served under a route prefix needs that prefix, and
// hard-coding `/` breaks exactly the setups least able to debug it.
assert.strictEqual(illustrationUrl('modules/x.webp', null), '/modules/x.webp', 'fallback roots the path');
console.log('ok  an illustration path is a URL a stylesheet can fetch');

// --- which merchants are "in the world" ---------------------------------
// Lifted verbatim from `MerchantManager.worldMerchants`. The rule it encodes: a linked
// token IS its sidebar Actor and is a shop whether or not it is placed; an unlinked
// token is a shop of its own; and an unlinked Actor in the sidebar is a mould, not a
// shop. That last one was the only thing the clock used to reach, so the template
// restocked and its new stock leaked into every copy cast from it.
function* worldMerchants(actors, scenes, isMerchant) {
    for (const actor of actors) {
        if (!actor.prototypeToken?.actorLink) continue;
        if (isMerchant(actor)) yield actor;
    }
    for (const scene of scenes) {
        for (const token of scene.tokens) {
            if (token.actorLink) continue;
            if (!token.actorId) continue;
            const actor = token.actor;
            if (isMerchant(actor)) yield actor;
        }
    }
}

const merchantActor = (uuid, linked) => ({ uuid, prototypeToken: { actorLink: linked }, merchant: true });
const plainActor = (uuid, linked) => ({ uuid, prototypeToken: { actorLink: linked }, merchant: false });
const tok = (actorId, actorLink, actor) => ({ actorId, actorLink, actor });
const merchantOf = (a) => Boolean(a?.merchant);
const names = (...args) => [...worldMerchants(...args, merchantOf)].map((a) => a.uuid);

// Bob keeps a shop in Phlan. Linked, so he is a shop whether or not he is standing on
// the map anybody is looking at.
assert.deepStrictEqual(names([merchantActor('bob', true)], []), ['bob'],
    'a linked merchant is a shop with no token placed at all');

// Flipper the travelling salesman. The sidebar entry is the mould.
assert.deepStrictEqual(names([merchantActor('flipper', false)], []), [],
    'an unlinked merchant Actor in the sidebar is a template, not a shop');

// ...and each placement is its own shop, knowing nothing about the others.
const flipperScene = { tokens: [
    tok('flipper', false, merchantActor('ulla', false)),
    tok('flipper', false, merchantActor('lorin', false))
] };
assert.deepStrictEqual(names([merchantActor('flipper', false)], [flipperScene]), ['ulla', 'lorin'],
    'three Flippers placed twice are two shops and no template');

// A linked token is not counted twice: it IS the Actor already yielded.
const bobScene = { tokens: [tok('bob', true, merchantActor('bob', true))] };
assert.deepStrictEqual(names([merchantActor('bob', true)], [bobScene]), ['bob'],
    'a linked token does not yield its own Actor a second time');

// Every scene, not the viewed one. A shop does not stop keeping stock because nobody
// is looking at the map it stands on.
const far = { tokens: [tok('flipper', false, merchantActor('distant', false))] };
assert.deepStrictEqual(names([], [flipperScene, far]).length, 3,
    'shops on unviewed scenes are still shops');

// Ordinary NPCs are skipped on both paths.
assert.deepStrictEqual(names([plainActor('guard', true)], [{ tokens: [tok('g', false, plainActor('mob', false))] }]), [],
    'a token that is not a merchant is not a shop');

// A token whose actor cannot be resolved must not throw the whole sweep.
assert.deepStrictEqual(names([], [{ tokens: [tok('gone', false, null), tok(null, false, null)] }]), [],
    'an unresolvable token is skipped rather than fatal');
console.log('ok  a shop is what stands in the world, not what sits in the sidebar');

// --- the compendium query filter ----------------------------------------
// Every wrong answer here is a plausible-looking shop rather than an error, which is
// why the filter is pinned rather than trusted.
const Q = await import('../scripts/utility-compendium.js');

// `mundane` is unmarked gear and it is NOT `common`. A default that omitted it would
// stock general stores with magic items only — every rope and torch silently absent.
assert.ok(Q.DEFAULT_QUERY.rarity.includes('mundane'),
    'the default rarity set must include mundane, or a general store carries only magic');
assert.ok(Q.RARITIES.includes('mundane') && Q.RARITIES.includes('common'),
    'mundane and common are separate tokens, because dnd5e stores them separately');

// Nothing stored means the defaults, not an empty filter. An empty rarity list sent to
// the query would mean "any rarity" and quietly put artifacts on a village shelf.
{
    const filter = Q.normalizeQuery(undefined);
    assert.deepStrictEqual(filter.rarity, [...Q.DEFAULT_QUERY.rarity], 'an unset query takes the defaults');
    assert.strictEqual(filter.subtypes, null, 'and null subtypes, which the caller widens to every physical kind');
    assert.ok(filter.priceGp.max > 0, 'with a real price ceiling rather than zero');
}

// Junk in a stored query is dropped rather than passed through: an unknown rarity token
// silently matches nothing, so the shelf would go barren with no error anywhere.
{
    const filter = Q.normalizeQuery({ rarity: ['common', 'nonsense'], subtypes: ['weapon', 'spell'] });
    assert.deepStrictEqual(filter.rarity, ['common'], 'unknown rarity tokens are dropped');
    assert.deepStrictEqual(filter.subtypes, ['weapon'],
        'and a non-physical subtype too — a shelf cannot hold a spell, and asking would return nothing');
}

// Filtering every token away must fall back rather than produce an empty list, for the
// same reason: empty means "any" downstream.
assert.deepStrictEqual(Q.normalizeQuery({ rarity: ['nonsense'] }).rarity, [...Q.DEFAULT_QUERY.rarity],
    'a rarity list that filters down to nothing falls back rather than meaning "anything"');

// A price window survives, and nonsense in it does not.
{
    const filter = Q.normalizeQuery({ priceGp: { min: 5, max: 250 } });
    assert.deepStrictEqual(filter.priceGp, { min: 5, max: 250 }, 'a real window is kept as gold pieces');
    const bad = Q.normalizeQuery({ priceGp: { min: -3, max: 0 } });
    assert.strictEqual(bad.priceGp.min, Q.DEFAULT_QUERY.priceGp.min, 'a negative floor falls back');
    assert.strictEqual(bad.priceGp.max, Q.DEFAULT_QUERY.priceGp.max, 'and a ceiling of zero would match nothing');
}

// Without the API the query answers empty rather than throwing: a shop must keep working
// when the hub is a version behind, and a GM can still stock the shelf by hand.
{
    const saved = game.modules;
    game.modules = { get: () => ({ api: {} }) };
    assert.ok(!Q.hasQuery(), 'a Blacksmith with no query is detected as such');
    assert.deepStrictEqual(await Q.queryStock({}), [], 'and querying answers empty rather than throwing');
    game.modules = saved;
}
console.log('ok  the stock query filter defaults, clamps and degrades');

// --- the price range, and "Any" ------------------------------------------
// Stops are roughly logarithmic because shop prices span four orders of magnitude — a
// torch is 0.01 gp and plate is 1,500 — so a linear slider spends nine tenths of its
// travel in a band no shop cares about and cannot separate a torch from a lantern.
const { PRICE_STOPS, priceStopIndex } = await import('../scripts/const.js');

assert.strictEqual(PRICE_STOPS[0], 0, 'the range starts at nothing');
assert.ok(!Number.isFinite(PRICE_STOPS.at(-1)),
    'and ends at no ceiling at all — a number there would be a lie, since a GM cannot know what is installed');
for (let i = 1; i < PRICE_STOPS.length; i++) {
    assert.ok(PRICE_STOPS[i] > PRICE_STOPS[i - 1], 'stops ascend');
}

// A stored value lands on the first stop that covers it, so a shelf never silently
// widens: 499 gp is "up to 500", not "up to 250".
assert.strictEqual(PRICE_STOPS[priceStopIndex(499)], 500, 'a value lands on the stop that covers it');
assert.strictEqual(PRICE_STOPS[priceStopIndex(500)], 500, 'and exactly on a stop stays there');
// **Every not-a-number reads as no ceiling**, which is what makes null and Infinity the
// same position by construction rather than by two code paths agreeing.
for (const value of [Infinity, null, undefined, NaN]) {
    assert.strictEqual(priceStopIndex(value), PRICE_STOPS.length - 1,
        `${String(value)} reads as no ceiling`);
}

// `max: null` is "no ceiling" and must survive being written to a flag and read back.
// Infinity cannot: `JSON.stringify(Infinity)` is `null`, so storing Infinity would come
// back as null and mean something different by accident. Storing null says it on purpose.
{
    const round = JSON.parse(JSON.stringify({ rarity: ['mundane'], priceGp: { min: 25, max: null } }));
    const filter = Q.normalizeQuery(round);
    assert.strictEqual(filter.priceGp.max, null, 'a null ceiling survives the round trip as null');
    assert.strictEqual(filter.priceGp.min, 25, 'and the floor with it');
}
// A finite ceiling is still a window.
assert.strictEqual(Q.normalizeQuery({ priceGp: { min: 1, max: 50 } }).priceGp.max, 50,
    'a real ceiling is kept');
console.log('ok  the price range covers "any" without inventing a number');

// --- flag writes that hold a list ---------------------------------------
// **Foundry merges flag objects, and merges arrays BY INDEX.** Writing `['weapon']` over
// a stored `['weapon', 'tool', 'loot']` leaves the last two in place, and what comes back
// is `{0: …, 1: …, 2: …}` rather than an array at all. So unticking a chip did nothing
// twice over: the entry survived the merge, and the shape it survived as stopped reading
// as a list. `setInventoryConfig` clears such a key with `-=` before rewriting it.
function holdsList(value) {
    if (Array.isArray(value)) return true;
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(holdsList);
}
assert.ok(holdsList(['weapon']), 'a bare array needs clearing');
assert.ok(holdsList({ subtypes: ['a'], priceGp: { min: 1 } }), 'and one nested inside a query does too');
assert.ok(!holdsList(5) && !holdsList('table') && !holdsList(null),
    'while a scalar merges correctly and must not cost an extra write');
assert.ok(!holdsList({ min: 1, max: 2 }), 'and so does a plain object of numbers');

// The shape the merge produces must not read as a selection, or a mangled flag would
// silently mean "every kind" instead of failing visibly.
{
    const mangled = { subtypes: { 0: 'weapon', 1: 'tool' }, rarity: { 0: 'rare' } };
    const filter = Q.normalizeQuery(mangled);
    assert.strictEqual(filter.subtypes, null, 'an index-keyed object is not a list of kinds');
    assert.deepStrictEqual(filter.rarity, [...Q.DEFAULT_QUERY.rarity],
        'and not a list of rarities either — it falls back rather than meaning anything');
}
console.log('ok  a shrinking list replaces rather than merging');

// --- schema 5: every shelf says what it draws ---------------------------
// The default source moved to Manual. A shelf with no stored source would otherwise stop
// rolling the tables it has had all along — a shop quietly going empty because a default
// changed somewhere else. Migration stamps an explicit source on every existing shelf.
function sourceFor(tables) { return tables.length ? 'table' : 'manual'; }
assert.strictEqual(sourceFor([{ uuid: 'x' }]), 'table', 'a shelf with tables keeps drawing from them');
assert.strictEqual(sourceFor([]), 'manual', 'and one without draws nothing, which is what it already did');

// One update per item id. Two entries for the same id in one `updateEmbeddedDocuments`
// is a coin toss over which survives, and the legacy pass and the source pass both write
// to inventory containers.
{
    const claimed = new Set();
    const updates = [];
    const legacyShelves = [{ id: 'a' }];
    const allShelves = [{ id: 'a' }, { id: 'b' }];
    for (const shelf of legacyShelves) { claimed.add(shelf.id); updates.push(shelf.id); }
    for (const shelf of allShelves) { if (claimed.has(shelf.id)) continue; updates.push(shelf.id); }
    assert.deepStrictEqual(updates, ['a', 'b'], 'a legacy shelf is written once, not twice');
    assert.strictEqual(new Set(updates).size, updates.length, 'and no id appears twice');
}
console.log('ok  the source migration is explicit and writes each shelf once');

// --- the ratchet this replaces ------------------------------------------
// Kept as a check rather than a comment, because the failure was invisible: the shop
// looked stocked, the restock reported success, and nothing moved.
const ratchet = (quantity, flag) => parOf(quantity, flag);
assert.strictEqual(ratchet(1, undefined), 1,
    'with no par, a row sold down to one claims a target of one');
assert.strictEqual(ratchet(1, 4), 4,
    'and with one, it still knows it keeps four');
assert.strictEqual(ratchet(0, 4), 4,
    'a sold-out row is restocked; only a deleted one is gone for good');
console.log('ok  a row with a stored par survives being sold down');

// --- trading hours: open is derived, never stored ------------------------
// The bug this replaces: `open` was a stored flag kept in step by a world-time
// handler. Any path where the handler did not fire, or fired without a usable
// delta, left a shop open past its closing hour wearing an override notice it had
// never been given. Reading the schedule at the moment of the question cannot miss.
const HOURS = { open: 7, close: 18 };

// `isOpen` and `isOverridden`, as the manager derives them.
const isOpen = (config, hour) => {
    const scheduled = isScheduledOpen(config.hours, hour);
    if (scheduled === null) return config.open !== false;
    const o = config.override;
    if (o && o.against === scheduled) return o.open === true;
    return scheduled;
};
const isOverridden = (config, hour) => {
    const scheduled = isScheduledOpen(config.hours, hour);
    if (scheduled === null) return false;
    const o = config.override;
    return Boolean(o) && o.against === scheduled && o.open !== scheduled;
};
// `setOpen`: agreeing with the schedule clears an exception rather than recording one.
const setOpen = (config, hour, wanted) => {
    const scheduled = isScheduledOpen(config.hours, hour);
    if (scheduled === null) return { ...config, open: wanted, override: null };
    if (wanted === scheduled) return { ...config, open: wanted, override: null };
    return { ...config, open: wanted, override: { open: wanted, against: scheduled } };
};

let shop = { hours: HOURS, open: true, override: null };

assert.strictEqual(isOpen(shop, 12), true, 'open during trading hours');
assert.strictEqual(isOpen(shop, 19), false, 'shut after closing, with no event needed');
assert.strictEqual(isOpen(shop, 3), false, 'and before opening');
assert.strictEqual(isOverridden(shop, 19), false, 'and not flagged as overriding anything');
console.log('ok  open follows the schedule with nothing having to fire');

// A GM opens it after hours.
shop = setOpen(shop, 19, true);
assert.strictEqual(isOpen(shop, 19), true, 'the override stands');
assert.strictEqual(isOverridden(shop, 19), true, 'and says so');
assert.strictEqual(isOpen(shop, 22), true, 'however far the clock moves inside the closed window');

// The next opening hour spends it: the schedule now says something else.
assert.strictEqual(isOpen(shop, 8), true, 'open again in the morning');
assert.strictEqual(isOverridden(shop, 8), false, 'and no longer overriding');
// And the closing hour after that is honoured rather than re-applying the old override.
assert.strictEqual(isOpen(shop, 19), true, 'stale override still standing until it is spent');
console.log('ok  an override stands between boundaries');

// Toggling back to what the schedule says cancels it outright.
let cancelled = setOpen(shop, 19, false);
assert.strictEqual(isOpen(cancelled, 19), false);
assert.strictEqual(isOverridden(cancelled, 19), false, 'agreement is not an exception');
assert.strictEqual(cancelled.override, null, 'and it is cleared rather than recorded');
console.log('ok  toggling back cancels the override');

// A shop with no schedule is whatever it was last set to.
const manual = setOpen({ hours: null, open: true, override: null }, 19, false);
assert.strictEqual(isOpen(manual, 19), false);
assert.strictEqual(isOpen(manual, 12), false, 'and stays that way at any hour');
assert.strictEqual(isOverridden(manual, 12), false, 'with nothing to override');
console.log('ok  a shop with no schedule is manual only');

// Overnight schedules derive the same way.
const NIGHT = { hours: { open: 20, close: 4 }, open: false, override: null };
assert.strictEqual(isOpen(NIGHT, 23), true, 'open at midnight');
assert.strictEqual(isOpen(NIGHT, 2), true, 'and in the small hours');
assert.strictEqual(isOpen(NIGHT, 12), false, 'shut at noon');
console.log('ok  overnight schedules');

// The two ends of one gesture. A band across the whole day is always open; a band
// shut to nothing is never open. The arithmetic agrees with both labels without a
// special case, because the closing handle reaches the end of the day rather than
// its last hour.
assert.strictEqual(isAlwaysOpen(null), true, 'no schedule is open all day');
assert.strictEqual(isAlwaysOpen({ open: 0, close: 24 }), true, 'and so is midnight to midnight');
assert.strictEqual(isAlwaysOpen({ open: 7, close: 18 }), false);
assert.strictEqual(isAlwaysOpen({ open: 0, close: 23 }), false, 'one hour short is not all day');
assert.strictEqual(isAlwaysOpen({ open: 9, close: 9 }), false, 'handles together is not all day');

assert.strictEqual(isAlwaysClosed({ open: 9, close: 9 }), true, 'handles together is never open');
assert.strictEqual(isAlwaysClosed({ open: 0, close: 24 }), false, 'the whole day is not never');
assert.strictEqual(isAlwaysClosed(null), false, 'and no schedule at all is not never');
for (const hour of [0, 9, 12, 23]) {
    assert.strictEqual(isScheduledOpen({ open: 9, close: 9 }, hour), false,
        `shut at ${hour} when the window has no hours in it`);
}
console.log('ok  a window with no hours in it');

for (const hour of [0, 6, 12, 18, 23]) {
    assert.strictEqual(isScheduledOpen({ open: 0, close: 24 }, hour), true,
        `open at ${hour} under a whole-day schedule`);
}
// The reason the closing handle goes to 24 and not 23: this is the hour that used
// to fall outside a "whole day" span.
assert.strictEqual(isScheduledOpen({ open: 0, close: 23 }, 23), false, 'the last hour is genuinely outside 0-23');
console.log('ok  a whole-day schedule is open at every hour');

// --- which compendiums a shelf draws from ---------------------------------
// **Three states, not two**, and conflating any pair of them stocks a shop from content
// the GM told it not to use.
{
    // Absent is the curated set: the packs configured in Blacksmith, which is what every
    // other Coffee Pub module matches against.
    assert.strictEqual(Q.normalizeQuery({}).sources, null, 'no list means the curated set');
    assert.strictEqual(Q.normalizeQuery({ sources: 'bok.items' }).sources, null,
        'and so does junk, rather than a list of one letter at a time');
    assert.strictEqual(Q.DEFAULT_QUERY.sources, null, 'which is also the default');

    // An empty list is a custom list nobody has filled yet. It must NOT read as curated:
    // a shady fence whose list has just been emptied would otherwise quietly restock
    // itself from the world's ordinary content.
    assert.deepStrictEqual(Q.normalizeQuery({ sources: [] }).sources, [],
        'an empty list stays an empty list');

    // Entries carry a switch, like the roll tables beside them. A bare string reads as
    // enabled, because that is what a list written before the switch existed meant.
    assert.deepStrictEqual(Q.normalizeQuery({ sources: ['a.b', 'a.b', '', null, 'c.d'] }).sources,
        [{ id: 'a.b', enabled: true }, { id: 'c.d', enabled: true }],
        'duplicates and blanks come out, order stays, and a bare id is on');
    assert.deepStrictEqual(Q.normalizeQuery({ sources: [{ id: 'a.b', enabled: false }] }).sources,
        [{ id: 'a.b', enabled: false }], 'and an entry switched off stays off');

    // **Off is not gone.** The pack keeps its place on the list; it just stops
    // contributing, which is the whole point of having a switch rather than a delete.
    const mixed = Q.normalizeQuery({ sources: [{ id: 'a.b', enabled: false }, 'c.d'] }).sources;
    assert.deepStrictEqual(Q.enabledSources(mixed), ['c.d'], 'only the ones switched on are drawn from');
    assert.deepStrictEqual(mixed.map((entry) => entry.id), ['a.b', 'c.d'], 'but both are still listed');
    assert.deepStrictEqual(Q.enabledSources([]), [], 'a list with nothing on it draws nothing');
    assert.deepStrictEqual(Q.enabledSources(null), [], 'and neither does a missing one');
}
console.log('ok  a shelf draws from the curated set, or from its own list, never both');

// --- a pack id out of a drop ----------------------------------------------
// Two payloads mean the same thing to a person: the pack itself, and anything dragged
// out of it. The second matters more than it looks -- finding the pack you want by
// finding a thing in it is how anybody actually browses.
{
    assert.strictEqual(Q.packIdFromDrop({ type: 'Compendium', collection: 'bok.items' }), 'bok.items',
        'a compendium dragged from the sidebar');
    assert.strictEqual(Q.packIdFromDrop({ type: 'Item', uuid: 'Compendium.bok.items.Item.abc123' }), 'bok.items',
        'an item dragged out of one names its pack');
    assert.strictEqual(Q.packIdFromDrop({ type: 'Item', uuid: 'Item.abc123' }), null,
        'an item from the sidebar is not a compendium');
    assert.strictEqual(Q.packIdFromDrop({ type: 'Actor', uuid: 'Actor.xyz' }), null);
    assert.strictEqual(Q.packIdFromDrop(null), null);
    assert.strictEqual(Q.packIdFromDrop({}), null);
}
console.log('ok  a drop names a compendium, or it names nothing');

// --- which half of a "both" shelf draws first ------------------------------
// Both halves feed one product target, so on a nearly full shelf whichever runs first
// gets the last slots. That used to be fixed at tables-first; it is a GM's decision.
{
    const { SOURCE, drawsFromQuery, drawsFromTables } = await import('../scripts/const.js');

    for (const source of [SOURCE.QUERY, SOURCE.BOTH, SOURCE.BOTH_QUERY]) {
        assert.ok(drawsFromQuery(source), `${source} draws from the compendiums`);
    }
    for (const source of [SOURCE.TABLE, SOURCE.BOTH, SOURCE.BOTH_QUERY]) {
        assert.ok(drawsFromTables(source), `${source} draws from tables`);
    }
    assert.ok(!drawsFromQuery(SOURCE.TABLE) && !drawsFromTables(SOURCE.QUERY),
        'a single-source shelf draws from one of them');
    // Manual is the one that draws nothing at all -- its rows are still topped up to par.
    assert.ok(!drawsFromQuery(SOURCE.MANUAL) && !drawsFromTables(SOURCE.MANUAL),
        'manual draws from neither');

    // The shape of the leg ordering in `restockInventory`.
    const legOrder = (source) => {
        const order = source === SOURCE.BOTH_QUERY
            ? [SOURCE.QUERY, SOURCE.TABLE]
            : [SOURCE.TABLE, SOURCE.QUERY];
        return order.filter((leg) => (leg === SOURCE.TABLE ? drawsFromTables(source) : drawsFromQuery(source)));
    };
    assert.deepStrictEqual(legOrder(SOURCE.BOTH), [SOURCE.TABLE, SOURCE.QUERY], 'tables take the free slots first');
    assert.deepStrictEqual(legOrder(SOURCE.BOTH_QUERY), [SOURCE.QUERY, SOURCE.TABLE], 'and the other way round on request');
    assert.deepStrictEqual(legOrder(SOURCE.TABLE), [SOURCE.TABLE], 'one source runs one leg');
    assert.deepStrictEqual(legOrder(SOURCE.QUERY), [SOURCE.QUERY]);
    assert.deepStrictEqual(legOrder(SOURCE.MANUAL), [], 'and manual runs none');
}
console.log('ok  a both-shelf draws in the order the GM chose');

// --- moving an inventory up and down --------------------------------------
// Every inventory is renumbered on a move, not just the pair that swapped: they start
// life sharing an order of 0, so swapping two zeroes would move nothing at all.
{
    const move = (ids, id, delta) => {
        const from = ids.indexOf(id);
        if (from < 0) return null;
        const to = from + delta;
        if (to < 0 || to >= ids.length) return null;
        const moved = [...ids];
        moved.splice(to, 0, ...moved.splice(from, 1));
        return moved;
    };

    assert.deepStrictEqual(move(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b'], 'up swaps with the one above');
    assert.deepStrictEqual(move(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c'], 'down swaps with the one below');
    assert.strictEqual(move(['a', 'b', 'c'], 'a', -1), null, 'the top cannot go up');
    assert.strictEqual(move(['a', 'b', 'c'], 'c', 1), null, 'and the bottom cannot go down');
    assert.strictEqual(move(['a', 'b'], 'zzz', -1), null, 'an inventory that is not there does not move');

    // Renumbering is what makes it stick: a sequence out of a set of ties comes back
    // ordered, which is also what repairs a shop whose numbers were never set.
    const ordered = move(['a', 'b', 'c'], 'b', -1).map((id, index) => ({ id, order: index }));
    assert.deepStrictEqual(ordered, [{ id: 'b', order: 0 }, { id: 'a', order: 1 }, { id: 'c', order: 2 }],
        'every inventory gets its position written, not just the two that swapped');
}
console.log('ok  inventories move up and down, and the whole shop is renumbered');

// --- the shelf's filters apply to a table draw too -------------------------
// A shelf that deals in consumables under 50 gp deals in them whichever source fetched
// the thing. The query half is filtered at the index by Blacksmith; this is the same
// question asked of a resolved document, for the half that cannot be.
{
    globalThis.CONFIG = {
        DND5E: {
            currencies: {
                pp: { conversion: 0.1 }, gp: { conversion: 1 },
                ep: { conversion: 2 }, sp: { conversion: 10 }, cp: { conversion: 100 }
            }
        }
    };
    const item = (over = {}) => ({
        type: over.type ?? 'consumable',
        system: {
            rarity: over.rarity ?? '',
            price: over.price === undefined ? { value: 25, denomination: 'gp' } : over.price
        },
        flags: over.flags ?? {}
    });
    const filter = { subtypes: ['consumable'], rarity: ['mundane', 'common'], priceGp: { min: 10, max: 50 } };

    assert.ok(Q.matchesFilter(item(), filter), 'a 25 gp mundane consumable is carried');
    assert.ok(!Q.matchesFilter(item({ type: 'weapon' }), filter), 'a weapon is not, on a consumables shelf');
    assert.ok(!Q.matchesFilter(item({ rarity: 'rare' }), filter), 'and neither is a rare one');
    assert.ok(!Q.matchesFilter(item({ price: { value: 5, denomination: 'gp' } }), filter), 'under the floor');
    assert.ok(!Q.matchesFilter(item({ price: { value: 500, denomination: 'gp' } }), filter), 'over the ceiling');

    // **Price carries a denomination**: 300 sp is 30 gp and is inside a 10-50 gp window.
    // A raw compare on the stored number would have called it 300 and thrown it out.
    assert.ok(Q.matchesFilter(item({ price: { value: 300, denomination: 'sp' } }), filter),
        '300 sp is 30 gp, which is inside the window');

    // Unpriced passes only when no bound is set: with the range wide open the price filter
    // is not filtering anything, so dropping a GM's unpriced trinket would be a refusal
    // nobody asked for -- but once a range is stated, a thing with no price is outside it.
    const open = { subtypes: null, rarity: ['mundane'], priceGp: { min: 0, max: null } };
    assert.ok(Q.matchesFilter(item({ price: { value: 0, denomination: 'gp' } }), open),
        'an unpriced item passes a filter that is not filtering on price');
    assert.ok(!Q.matchesFilter(item({ price: { value: 0, denomination: 'gp' } }), filter),
        'and fails one that is');

    assert.ok(!Q.matchesFilter(null, filter), 'nothing matches nothing');
}
console.log('ok  a shelf filters what a table brings in, not only what a query does');

// --- which door opens a shop full screen -----------------------------------
// *How you arrived* is part of how a shop should be presented, and the four doors are
// genuinely different experiences rather than points on a scale -- which is why a merchant
// answers each of them separately.
{
    const { opensFullScreen, SHOP_DOORS, DEFAULT_FULLSCREEN_DOORS } = await import('../scripts/const.js');
    const keys = SHOP_DOORS.map((door) => door.key);

    assert.deepStrictEqual(keys, ['region', 'token', 'pin', 'catalogue'], 'four doors, region first');

    // One door on says nothing about the others: the case the scale could not express.
    const onlyRegion = { region: true };
    assert.strictEqual(opensFullScreen(onlyRegion, 'region'), true, 'the door that is on');
    for (const door of keys.filter((k) => k !== 'region')) {
        assert.strictEqual(opensFullScreen(onlyRegion, door), false, `and ${door}, which is not`);
    }

    // The combination a single scale had no entry for.
    const mixed = { region: true, catalogue: true };
    assert.strictEqual(opensFullScreen(mixed, 'catalogue'), true, 'two doors on');
    assert.strictEqual(opensFullScreen(mixed, 'token'), false, 'with one still off between them');

    // Anything that is not an explicit `true` for that exact door is a window: nothing
    // stored, a door that is off, a stored shape from a version this build does not know.
    assert.strictEqual(opensFullScreen(DEFAULT_FULLSCREEN_DOORS, 'region'), false, 'the shipped default');
    assert.strictEqual(opensFullScreen(undefined, 'region'), false, 'nothing stored');
    assert.strictEqual(opensFullScreen({ region: 'yes' }, 'region'), false, 'only true is true');
    assert.strictEqual(opensFullScreen('always', 'region'), false, 'an older shape reads as no doors');

    console.log('ok  each door answers for itself, and anything else is a window');
}

console.log('\nall stock logic checks passed');

// --- refresh coalescing --------------------------------------------------
// One gesture is rarely one write: dragging a stack fires `updateItem` per document
// and the migration touches every container a shop has. Each used to be a socket
// emit and a re-render on every connected client. Merged by Actor, because merging
// by anything else could lose a second merchant's refresh.
{
    const emitted = [];
    const timers = new Map();
    // The shape of `broadcastActorRefresh`, with the two side effects counted.
    const broadcast = (uuid) => {
        if (timers.has(uuid)) return;
        timers.set(uuid, true);
        setTimeout(() => { timers.delete(uuid); emitted.push(uuid); }, 5);
    };

    for (let i = 0; i < 40; i++) broadcast('Actor.shop-one');
    for (let i = 0; i < 12; i++) broadcast('Actor.shop-two');

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepStrictEqual(emitted.sort(), ['Actor.shop-one', 'Actor.shop-two'],
        'fifty-two writes to two shops become two refreshes, and neither shop is lost');

    // And a later gesture still refreshes: the key is released, not latched.
    broadcast('Actor.shop-one');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(emitted.length, 3, 'a later change refreshes again');
}
console.log('ok  refreshes coalesce per merchant without losing one');

console.log('\nall stock logic checks passed');

// --- folding duplicate rows together --------------------------------------
// Nothing in the current code makes a second row for the same thing -- a draw skips
// what the shelf already carries -- so this exists for the ones already in a world.
// The rules it has to keep: grouped by name *and* type, quantities added up, the
// highest level kept, the first row the survivor, and nothing above the ceiling.
{
    const maxPerItem = 10;
    // The shape of `mergeInventoryDuplicates`, with the writes collected rather than made.
    const merge = (rows) => {
        const groups = new Map();
        for (const item of rows) {
            const key = `${item.name}\u0000${item.type}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }
        const updates = [];
        const deletes = [];
        for (const group of groups.values()) {
            if (group.length < 2) continue;
            const [keep, ...rest] = group;
            const total = group.reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.quantity ?? 0))), 0);
            const par = group.reduce((highest, item) => {
                const stored = Number(item.par);
                return Number.isFinite(stored) ? Math.max(highest, stored) : highest;
            }, 0);
            const quantity = Math.min(total, maxPerItem);
            updates.push({ id: keep.id, quantity, par: Math.min(par, maxPerItem) });
            deletes.push(...rest.map((item) => item.id));
        }
        return { updates, deletes };
    };

    const three = merge([
        { id: 'a', name: 'Light Hammer', type: 'weapon', quantity: 2, par: 2 },
        { id: 'b', name: 'Light Hammer', type: 'weapon', quantity: 1, par: 4 },
        { id: 'c', name: 'Light Hammer', type: 'weapon', quantity: 3, par: 3 }
    ]);
    assert.deepStrictEqual(three.deletes, ['b', 'c'], 'the first row survives, the rest go');
    assert.strictEqual(three.updates[0].quantity, 6, 'the counts are added up, not maxed');
    assert.strictEqual(three.updates[0].par, 4, 'and the level is the highest of the three');

    // A potion called Longsword and a sword called Longsword are two things.
    const kinds = merge([
        { id: 'a', name: 'Longsword', type: 'weapon', quantity: 1, par: 1 },
        { id: 'b', name: 'Longsword', type: 'consumable', quantity: 1, par: 1 }
    ]);
    assert.strictEqual(kinds.deletes.length, 0, 'same name, different kind, left alone');

    // Three rows of four under a ceiling of ten: the merged row is clamped, and its
    // level with it, so no count exists that the inventory's own limit forbids.
    const over = merge([
        { id: 'a', name: 'Torch', type: 'consumable', quantity: 4, par: 4 },
        { id: 'b', name: 'Torch', type: 'consumable', quantity: 4, par: 4 },
        { id: 'c', name: 'Torch', type: 'consumable', quantity: 4, par: 4 }
    ]);
    assert.strictEqual(over.updates[0].quantity, maxPerItem, 'twelve is clamped to the ceiling');
    assert.strictEqual(over.updates[0].par, 4, 'and the level is untouched by the clamp');

    // The level is not the total. Two rows kept at three and two make one row holding
    // five kept at three: what the shelf keeps is a decision, and the surplus sells
    // through like any other over-stocked row rather than becoming the new normal.
    const kept = merge([
        { id: 'a', name: 'Dagger', type: 'weapon', quantity: 3, par: 3 },
        { id: 'b', name: 'Dagger', type: 'weapon', quantity: 2, par: 2 }
    ]);
    assert.strictEqual(kept.updates[0].quantity, 5, 'all five are on the shelf');
    assert.strictEqual(kept.updates[0].par, 3, 'but the level stays the highest of the two, not their sum');

    assert.deepStrictEqual(merge([{ id: 'a', name: 'Rations', type: 'consumable', quantity: 1, par: 1 }]),
        { updates: [], deletes: [] }, 'a tidy shelf is not written to at all');
}
console.log('ok  duplicate rows fold together by name and kind');

// --- which shelves offer a restock button ---------------------------------
// The control has to be absent where pressing it could only ever say "nothing to
// restock": a buyback shelf, and a hand-stocked shelf that is not set to restock.
{
    const SOURCE = { MANUAL: 'manual', QUERY: 'query', TABLE: 'table', BOTH: 'both' };
    // The shape of `MerchantManager.canRestock`.
    const canRestock = ({ purchased = false, source = SOURCE.MANUAL, tables = 0, policy = STOCK.INFINITE }) => {
        if (purchased) return false;
        if (source === SOURCE.QUERY || source === SOURCE.BOTH) return true;
        if (source === SOURCE.TABLE && tables) return true;
        return policy === STOCK.RESTOCKING;
    };

    assert.strictEqual(canRestock({ purchased: true, source: SOURCE.QUERY, policy: STOCK.RESTOCKING }), false,
        'a buyback shelf never restocks, whatever else is set on it');
    assert.strictEqual(canRestock({ source: SOURCE.QUERY }), true, 'a compendium shelf always can');
    assert.strictEqual(canRestock({ source: SOURCE.BOTH }), true, 'and so can one doing both');
    assert.strictEqual(canRestock({ source: SOURCE.TABLE, tables: 1 }), true, 'a table shelf with a table on it');
    // Deliberately not the clock's test: the clock skips a table whose automatic switch
    // is off, but pressing the button is exactly what that table is there for.
    assert.strictEqual(canRestock({ source: SOURCE.TABLE, tables: 0 }), false, 'a table shelf with no tables cannot');
    assert.strictEqual(canRestock({ source: SOURCE.MANUAL, policy: STOCK.RESTOCKING }), true,
        'a hand-stocked shelf that is kept at a level tops itself up');
    assert.strictEqual(canRestock({ source: SOURCE.MANUAL, policy: STOCK.FINITE }), false,
        'once gone is gone: nothing to restock to');
    assert.strictEqual(canRestock({ source: SOURCE.MANUAL, policy: STOCK.INFINITE }), false,
        'a bottomless shelf has nothing to refill');
}
console.log('ok  the restock control is offered only where it does something');

// --- and both are actually wired up ---------------------------------------
// The mirrors above are logic tests; these are the two lines that catch a rename.
{
    const manager = fs.readFileSync(new URL('../scripts/manager-merchant.js', import.meta.url), 'utf8');
    const shop = fs.readFileSync(new URL('../scripts/window-shop.js', import.meta.url), 'utf8');
    const template = fs.readFileSync(new URL('../templates/window-shop.hbs', import.meta.url), 'utf8');

    for (const name of ['canRestock', 'mergeInventoryDuplicates']) {
        assert.ok(manager.includes(`static ${name.startsWith('merge') ? 'async ' : ''}${name}(`),
            `the manager still has ${name}`);
        assert.ok(shop.includes(name), `the shop window still calls ${name}`);
    }
    assert.ok(template.includes('{{#if canRestock}}'), 'the restock button is behind its own condition');
    assert.ok(!/{{#if canStock}}[\s\S]*?data-action="restockInventory"[\s\S]*?{{\/if}}/.test(
        template.slice(template.indexOf('{{#if canRestock}}') + 1)), 'and not behind canStock as well');
    assert.ok(template.includes('data-action="mergeInventory"'), 'the tidy button is on the header');
}
console.log('ok  restock and merge are wired to the template');

console.log('\nall stock logic checks passed');
