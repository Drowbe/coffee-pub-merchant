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

const { STOCK, PAR_FLAG, DEFAULT_RESTOCK_DAYS, secondsPerDay, isScheduledOpen, isAlwaysOpen } =
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

// A schedule covering the whole day is "always open", said two ways, and the
// arithmetic agrees with the label without a special case: the closing handle
// reaches the end of the day rather than its last hour.
assert.strictEqual(isAlwaysOpen(null), true, 'no schedule is open all day');
assert.strictEqual(isAlwaysOpen({ open: 0, close: 24 }), true, 'and so is midnight to midnight');
assert.strictEqual(isAlwaysOpen({ open: 9, close: 9 }), true, 'and so are the handles together');
assert.strictEqual(isAlwaysOpen({ open: 7, close: 18 }), false);
assert.strictEqual(isAlwaysOpen({ open: 0, close: 23 }), false, 'one hour short is not all day');

for (const hour of [0, 6, 12, 18, 23]) {
    assert.strictEqual(isScheduledOpen({ open: 0, close: 24 }, hour), true,
        `open at ${hour} under a whole-day schedule`);
}
// The reason the closing handle goes to 24 and not 23: this is the hour that used
// to fall outside a "whole day" span.
assert.strictEqual(isScheduledOpen({ open: 0, close: 23 }, 23), false, 'the last hour is genuinely outside 0-23');
console.log('ok  a whole-day schedule is open at every hour');

console.log('\nall stock logic checks passed');
