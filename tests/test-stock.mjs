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

const { STOCK, PAR_FLAG, DEFAULT_RESTOCK_DAYS, secondsPerDay, isScheduledOpen } =
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
function resolveStockPolicy(merchantStock, shelfStock) {
    const policies = Object.values(STOCK);
    if (policies.includes(shelfStock)) return shelfStock;
    return policies.includes(merchantStock) ? merchantStock : STOCK.INFINITE;
}
assert.strictEqual(resolveStockPolicy(undefined, null), STOCK.INFINITE, 'unset defaults to infinite');
assert.strictEqual(resolveStockPolicy(STOCK.FINITE, null), STOCK.FINITE, 'shelf inherits the merchant');
assert.strictEqual(resolveStockPolicy(STOCK.FINITE, STOCK.INFINITE), STOCK.INFINITE, 'shelf overrides');
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
assert.strictEqual(due(2 * DAY, 0, 7), 'wait', 'a 7-day shelf waits');
assert.strictEqual(due(0, undefined, 1), 'reset', 'a shelf with no clock starts one');
assert.strictEqual(due(0, 5 * DAY, 1), 'reset', 'winding the clock back resets rather than stranding');
assert.strictEqual(due(DAY, 0, 0), 'restock', 'a zero cadence falls back to the default');
console.log('ok  restock cadence');

// --- par ----------------------------------------------------------------
function parOf(quantity, flag) {
    const stored = Number(flag);
    return Number.isFinite(stored) ? Math.max(0, Math.trunc(stored)) : quantity;
}
assert.strictEqual(parOf(3, undefined), 3, 'a shelf stocked before par existed reads as full');
assert.strictEqual(parOf(0, 6), 6, 'a sold-out shelf still knows what it keeps');
assert.strictEqual(parOf(0, -2), 0, 'a negative par clamps rather than growing stock');
assert.strictEqual(parOf(2, 4.7), 4, 'a fractional par truncates');
assert.strictEqual(PAR_FLAG, 'par');
console.log('ok  par resolution');

// --- trading hours: a crossing is remembered, not measured ---------------
// The bug this replaces: the watcher compared the hour before a jump with the hour
// after it, taken from the hook's `dt`. Setting the clock rather than advancing it
// can report no delta, so before and after came out identical, no crossing was ever
// seen, and a shop stayed open past its closing hour with an override notice on it.
const HOURS = { open: 7, close: 18 };

// The reconciliation, as the manager does it: act when the schedule's answer differs
// from the answer recorded last time.
function tick(state, hour) {
    const scheduled = isScheduledOpen(HOURS, hour);
    if (scheduled === null || scheduled === state.scheduleState) return state;
    return { open: scheduled, scheduleState: scheduled };
}

let shop = { open: true, scheduleState: null };
shop = tick(shop, 19);
assert.strictEqual(shop.open, false, 'past closing, the shop closes');

// A GM reopens it. `scheduleState` is untouched, which is what makes it an override.
shop = { ...shop, open: true };
shop = tick(shop, 20);
assert.strictEqual(shop.open, true, 'the override stands between boundaries');
shop = tick(shop, 23);
assert.strictEqual(shop.open, true, 'and keeps standing however far the clock moves');

shop = tick(shop, 8);
assert.strictEqual(shop.open, true, 'opening hour reclaims it');
assert.strictEqual(shop.scheduleState, true);

shop = tick(shop, 19);
assert.strictEqual(shop.open, false, 'and the next closing hour closes it again');

// The case the old logic could not see: no movement reported at all.
let still = { open: true, scheduleState: null };
still = tick(still, 19);
assert.strictEqual(still.open, false, 'a shop reconciles even when the clock reports no delta');

// Overnight schedules reconcile the same way.
const NIGHT = { open: 20, close: 4 };
const nightTick = (state, hour) => {
    const scheduled = isScheduledOpen(NIGHT, hour);
    return scheduled === state.scheduleState ? state : { open: scheduled, scheduleState: scheduled };
};
let tavern = { open: false, scheduleState: null };
tavern = nightTick(tavern, 23);
assert.strictEqual(tavern.open, true, 'open at midnight');
tavern = nightTick(tavern, 12);
assert.strictEqual(tavern.open, false, 'shut at noon');
console.log('ok  trading hours reconcile on a remembered crossing');

console.log('\nall stock logic checks passed');
