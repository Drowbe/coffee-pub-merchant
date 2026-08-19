// Making change is pure arithmetic with no Foundry documents in it, so it can be
// run for real rather than read. This is the part most likely to be subtly wrong
// and least likely to look wrong.
import assert from 'node:assert';

globalThis.CONFIG = {
    DND5E: {
        currencies: {
            pp: { label: 'Platinum', abbreviation: 'PP', conversion: 0.1 },
            gp: { label: 'Gold', abbreviation: 'GP', conversion: 1 },
            ep: { label: 'Electrum', abbreviation: 'EP', conversion: 2 },
            sp: { label: 'Silver', abbreviation: 'SP', conversion: 10 },
            cp: { label: 'Copper', abbreviation: 'CP', conversion: 100 }
        }
    }
};
globalThis.console.warn = () => {};

const P = await import('../scripts/merchant-pricing.js');

const purse = (c) => ({ system: { currency: c } });
const CP_PER = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const worth = (bag) => Object.entries(bag).reduce((t, [k, n]) => t + n * CP_PER[k], 0);

// --- units --------------------------------------------------------------
assert.strictEqual(P.baseDenomination().key, 'cp', 'copper is the base unit');
assert.strictEqual(P.toBase(1, 'gp'), 100);
assert.strictEqual(P.toBase(1, 'pp'), 1000);
assert.strictEqual(P.toBase(1, 'ep'), 50);
assert.strictEqual(P.purseValue(purse({ gp: 3, sp: 4, cp: 2 })), 342);
console.log('ok  denominations and purse value');

// --- formatting ---------------------------------------------------------
// Prices are quoted in gold, silver and copper only. Spelling them across the full
// set gives "102 pp 5 gp" for a healing potion: exact, unreadable, and not how
// anyone at a table says it. Payment is unaffected — planPayment still spends
// platinum and electrum, because that is what a purse holds.
assert.strictEqual(P.formatBase(342), '3 gp 4 sp 2 cp');
assert.strictEqual(P.formatBase(1000), '10 gp', 'platinum is written as gold');
assert.strictEqual(P.formatBase(50), '5 sp', 'electrum is written as silver');
assert.strictEqual(P.formatBase(102500), '1,025 gp', 'thousands are separated');
assert.strictEqual(P.formatBase(1250), '12 gp 5 sp', 'and no fractions of a coin');
assert.strictEqual(P.formatBase(0), '\u2014');
assert.strictEqual(P.formatBase(1), '1 cp');
console.log('ok  formatting');

// --- payment ------------------------------------------------------------
function check(name, currency, price, expectAfford = true) {
    const plan = P.planPayment(purse(currency), price);
    if (!expectAfford) { assert.strictEqual(plan, null, name + ': should be unaffordable'); return null; }
    assert.ok(plan, name + ': should be affordable');
    const paid = worth(plan.pay);
    const back = worth(plan.change);
    assert.strictEqual(paid - back, price, `${name}: net paid ${paid - back} should equal ${price}`);
    for (const [k, n] of Object.entries(plan.pay)) {
        assert.ok(n <= (currency[k] ?? 0), `${name}: spent ${n}${k} but holds ${currency[k] ?? 0}`);
        assert.ok(Number.isInteger(n) && n > 0, `${name}: ${k} count must be a positive integer`);
    }
    for (const n of Object.values(plan.change)) assert.ok(Number.isInteger(n) && n > 0);
    return plan;
}

// The two cases the doc comment promises.
const silver = check('20 sp for 2 gp', { sp: 20 }, 200);
assert.deepStrictEqual(silver.pay, { sp: 20 }, 'pays in silver');
assert.deepStrictEqual(silver.change, {}, 'and takes no change');

const plat = check('1 pp for 2 gp', { pp: 1 }, 200);
assert.deepStrictEqual(plat.pay, { pp: 1 }, 'pays platinum');
assert.deepStrictEqual(plat.change, { gp: 8 }, 'and takes 8 gp back');

// Smallest first, so a purse is not needlessly broken.
const mixed = check('mixed purse, 1 gp', { gp: 5, sp: 10, cp: 50 }, 100);
assert.strictEqual(mixed.pay.gp, undefined, 'does not break a gold piece it did not need');

check('exact copper', { cp: 7 }, 7);
check('free', { cp: 0 }, 0);
check('cannot afford', { cp: 5 }, 100, false);
check('one short', { gp: 1 }, 101, false);
check('electrum only', { ep: 3 }, 100);
check('awkward: 3 ep for 1 cp', { ep: 3 }, 1);
console.log('ok  payment and change');

// --- exhaustive sweep ---------------------------------------------------
// Every plan must net exactly the price and never spend a coin not held.
let checked = 0;
for (let pp = 0; pp <= 2; pp++)
for (let gp = 0; gp <= 3; gp++)
for (let ep = 0; ep <= 2; ep++)
for (let sp = 0; sp <= 4; sp++)
for (let cp = 0; cp <= 4; cp++) {
    const c = { pp, gp, ep, sp, cp };
    const total = worth(c);
    for (const price of [1, 7, 33, 100, 250, 999, 1500]) {
        const plan = P.planPayment(purse(c), price);
        if (total < price) { assert.strictEqual(plan, null, `${JSON.stringify(c)} @ ${price}`); continue; }
        assert.ok(plan, `${JSON.stringify(c)} @ ${price} should be affordable (holds ${total})`);
        assert.strictEqual(worth(plan.pay) - worth(plan.change), price,
            `${JSON.stringify(c)} @ ${price}: net mismatch`);
        for (const [k, n] of Object.entries(plan.pay)) assert.ok(n <= c[k], `overspend of ${k}`);
        checked++;
    }
}
console.log(`ok  ${checked} purse/price combinations net exactly`);

console.log('\nall pricing checks passed');
