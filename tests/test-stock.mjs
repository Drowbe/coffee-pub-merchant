// Exercise the stock logic against a stubbed Foundry. Not a Foundry test — it
// cannot catch a wrong document path — but it does catch arithmetic, inheritance
// and lock ordering, which are the parts that are pure logic.
import assert from 'node:assert';

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
