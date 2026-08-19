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
assert.strictEqual(P.formatBase(0), '0 gp', 'zero is an amount of money, not an absence of one');
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

// --- negotiation ---------------------------------------------------------
// The rule the whole feature turns on: an agreed price beats everything, and a
// shelf that exists not to have prices has none until one is agreed.
const item = (id, gp) => ({ id, system: gp === null ? {} : { price: { value: gp, denomination: 'gp' } } });
const NEGOTIATE = { mode: 'barter' };
const SALE = { mode: 'sale', markup: null };

assert.strictEqual(P.resolvePrice({}, NEGOTIATE, item('a', 50)), null,
    'a negotiate shelf has no price even for a listed item');
assert.strictEqual(P.resolvePrice({}, SALE, item('a', 50)), 5000, 'and an ordinary shelf still does');
assert.strictEqual(P.resolvePrice({}, SALE, item('a', null)), null, 'nothing to go on is still nothing');

const AGREED = { pricing: { overrides: { a: 1200 } } };
assert.strictEqual(P.resolvePrice(AGREED, NEGOTIATE, item('a', null)), 1200, 'an agreed price is the price');
assert.strictEqual(P.resolvePrice(AGREED, SALE, item('a', 50)), 1200, 'and it beats the list price too');
assert.strictEqual(P.resolvePrice(AGREED, SALE, item('b', 50)), 5000, 'without leaking onto anything else');
assert.strictEqual(P.negotiatedPrice(AGREED, 'a'), 1200);
assert.strictEqual(P.negotiatedPrice(AGREED, 'b'), null);
assert.strictEqual(P.negotiatedPrice({}, 'a'), null);

// Free is a price a merchant can offer, so zero has to survive the round trip
// rather than reading as "no agreement yet".
assert.strictEqual(P.negotiatedPrice({ pricing: { overrides: { a: 0 } } }, 'a'), 0, 'nothing is a price');

// The older `{ value, denomination }` override shape still reads, so a shop
// configured before any of this existed keeps its prices.
assert.strictEqual(P.negotiatedPrice({ pricing: { overrides: { a: { value: 7, denomination: 'gp' } } } }, 'a'), 700);

const BUYBACK = { mode: 'buyback', markup: 0.5 };
assert.strictEqual(P.resolveBuybackPrice({}, BUYBACK, item('a', 50)), 2500, 'half the list, as configured');
assert.strictEqual(P.resolveBuybackPrice({}, BUYBACK, item('a', null)), null, 'and nothing for the unpriced');
assert.strictEqual(
    P.resolveBuybackPrice({ pricing: { buybackOverrides: { a: 900 } } }, BUYBACK, item('a', null)), 900,
    'until the GM says what the merchant will pay');
assert.strictEqual(
    P.resolveBuybackPrice({ pricing: { overrides: { a: 9999 } } }, BUYBACK, item('a', 50)), 2500,
    'a buy-side agreement does not decide what the shop pays');
console.log('ok  agreed prices, both directions');

// --- fromBase round-trips ------------------------------------------------
// The price control types gold and stores base units; both directions have to
// agree or a price drifts every time it is opened and closed.
for (const [gp, base] of [[1, 100], [7.5, 750], [0, 0], [200, 20000]]) {
    assert.strictEqual(P.toBase(gp, 'gp'), base);
    assert.strictEqual(P.fromBase(base, 'gp'), gp, `${base}cp reads back as ${gp}gp`);
}
console.log('ok  gold and base units round-trip');

// --- stock depth ---------------------------------------------------------
// Why every table-rolled row used to read QTY 1: a roll delivered one of whatever
// it drew, so twenty rolls made twenty rows of one. The "each" limit was a ceiling
// and never a target, and par fell back to "as many as are there", which was one.
const goods = (type, gp, qty, sub) => ({
    type,
    system: {
        quantity: qty,
        price: gp === null ? undefined : { value: gp, denomination: 'gp' },
        ...(sub ? { type: { value: sub } } : {})
    }
});
// A die that always rolls its maximum, so the cap is what gets asserted.
const maxRoll = () => 0.999999;
const minRoll = () => 0;

// 1. What the item says it is wins outright.
assert.strictEqual(P.stockDepth(goods('consumable', 1, 20), { maxPerItem: 99, random: minRoll }), 20,
    'a quiver authored as twenty arrives as twenty');
assert.strictEqual(P.stockDepth(goods('equipment', 1500, 6), { maxPerItem: 99, random: minRoll }), 6,
    'and it wins even for something that would not otherwise stack');
assert.strictEqual(P.stockDepth(goods('consumable', 1, 20), { maxPerItem: 5, random: minRoll }), 5,
    'but the shelf ceiling still clamps it');

// 2. Then the price band, for things a shop keeps a pile of.
assert.strictEqual(P.stockDepth(goods('consumable', 0.5, 1), { maxPerItem: 99, random: maxRoll }), 10,
    'under a gold piece caps at ten');
assert.strictEqual(P.stockDepth(goods('consumable', 10, 1), { maxPerItem: 99, random: maxRoll }), 5,
    'ordinary consumables cap at five');
assert.strictEqual(P.stockDepth(goods('consumable', 50, 1), { maxPerItem: 99, random: maxRoll }), 3,
    'the better potions cap at three');
assert.strictEqual(P.stockDepth(goods('consumable', 500, 1), { maxPerItem: 99, random: maxRoll }), 1,
    'anything dear is a single item');
assert.strictEqual(P.stockDepth(goods('consumable', 0.5, 1), { maxPerItem: 99, random: minRoll }), 1,
    'and the die can always come up one');
assert.strictEqual(P.stockDepth(goods('consumable', 0.5, 1), { maxPerItem: 4, random: maxRoll }), 4,
    'the shelf ceiling beats the band');

// 3. Price decides it, not type. The whitelist that used to sit here excluded
// daggers, vials, clothes, chests and tools -- which is to say a general store's
// entire shelf -- so the feature changed nothing anybody could see.
for (const type of ['equipment', 'weapon', 'tool', 'container', 'consumable', 'loot']) {
    assert.strictEqual(P.stockDepth(goods(type, 0.1, 1), { maxPerItem: 99, random: maxRoll }), 10,
        `a cheap ${type} comes in a pile like anything else cheap`);
    assert.strictEqual(P.stockDepth(goods(type, 900, 1), { maxPerItem: 99, random: maxRoll }), 1,
        `and a dear ${type} comes alone`);
}
console.log('ok  depth follows price, not type');

// An item with no price at all must not become a pile by default.
assert.strictEqual(P.stockDepth(goods('consumable', null, 1), { maxPerItem: 99, random: maxRoll }), 10,
    'an unpriced consumable falls in the cheapest band, which is the honest reading');

// Never zero, never negative, whatever it is handed.
for (const bad of [null, undefined, {}, goods('consumable', 1, 0), goods('consumable', 1, -3)]) {
    const d = P.stockDepth(bad, { maxPerItem: 5, random: minRoll });
    assert.ok(Number.isInteger(d) && d >= 1, `depth stays a positive integer for ${JSON.stringify(bad)}`);
}
// Stackability is read off the document, never assumed -- the same rule the
// inventory API states for itself. No `system.quantity` means no stack to deepen.
assert.strictEqual(P.stockDepth({ type: 'loot', system: { price: { value: 0.1, denomination: 'gp' } } },
    { maxPerItem: 99, random: maxRoll }), 1, 'an item with no quantity field does not stack');
assert.strictEqual(P.stockDepth({ type: 'loot', system: { quantity: '3' } },
    { maxPerItem: 99, random: maxRoll }), 1, 'and a quantity that is a string is not a quantity');
console.log('ok  how deep a rolled row stacks');

// --- settling without change ---------------------------------------------
// The refusal this replaces: a merchant holding 20,001 gp and 1 sp could not pay
// 5 gp 6 sp 3 cp of change, because change had to come out of coins already held
// and nothing guarantees a shop sitting on gold has silver in the drawer. Now the
// payer re-cuts their own money first and hands over the exact coins.
const TILL = { gp: 20001, sp: 1, cp: 3 };

{
    const plan = P.planSettlement(TILL, 563);
    assert.ok(plan, 'a till full of gold can pay five gold six silver threepence');
    assert.deepStrictEqual(plan.pay, { gp: 5, sp: 6, cp: 3 }, 'and pays it exactly');
    assert.ok(plan.remint, 'having broken a coin to do it');
    // The whole point: re-cutting invents nothing.
    assert.strictEqual(P.poolValue(plan.remint), P.poolValue(TILL), 're-cutting is value-neutral');
}

// Coins already held are used untouched, which is the common case.
assert.deepStrictEqual(
    P.planSettlement({ gp: 6695, sp: 6, cp: 3 }, 563),
    { pay: { gp: 5, sp: 6, cp: 3 }, remint: null },
    'a purse that can already pay exactly is not re-cut');

// Platinum is a store of value, not small change: left alone unless it is needed.
{
    const plan = P.planSettlement({ pp: 10 }, 563);
    assert.ok(plan, 'platinum is drawn on when nothing else will cover it');
    assert.strictEqual(P.poolValue(plan.remint, ['pp', 'gp', 'sp', 'cp']), 10000, 'and still nets out');
    assert.ok(!('ep' in plan.pay), 'electrum is never handed to somebody who had none');
}
assert.strictEqual(
    P.planSettlement({ gp: 100, pp: 5 }, 1000).remint, null,
    'platinum stays put while the working coin can cover it');

// Refusals are about not having the money, and nothing else now.
assert.strictEqual(P.planSettlement({ cp: 5 }, 563), null, 'too poor is still too poor');
assert.deepStrictEqual(P.planSettlement({ gp: 1 }, 0), { pay: {}, remint: null }, 'nothing owed moves nothing');

// Exhaustive: every purse shape against every price must either refuse for want of
// money, or hand over coins worth exactly the price, having created none.
let settled = 0;
for (const gp of [0, 1, 3, 20, 500]) {
    for (const sp of [0, 1, 7]) {
        for (const cp of [0, 3, 9]) {
            const purse = { gp, sp, cp };
            const pool = P.poolValue(purse);
            for (const owed of [1, 3, 13, 63, 100, 563, 1999, 50000]) {
                const plan = P.planSettlement(purse, owed);
                if (pool < owed) {
                    assert.strictEqual(plan, null, `${JSON.stringify(purse)} should not afford ${owed}`);
                    continue;
                }
                assert.ok(plan, `${JSON.stringify(purse)} holds ${pool} and should afford ${owed}`);
                assert.strictEqual(P.poolValue(plan.pay), owed,
                    `${JSON.stringify(purse)} @ ${owed}: payment is not exact`);
                if (plan.remint) {
                    assert.strictEqual(P.poolValue(plan.remint), pool,
                        `${JSON.stringify(purse)} @ ${owed}: re-cutting changed the total`);
                    // Every coin handed over must exist in the re-cut purse.
                    for (const [d, n] of Object.entries(plan.pay)) {
                        assert.ok((plan.remint[d] ?? 0) >= n,
                            `${JSON.stringify(purse)} @ ${owed}: paying ${n} ${d} it does not hold`);
                    }
                } else {
                    for (const [d, n] of Object.entries(plan.pay)) {
                        assert.ok((purse[d] ?? 0) >= n,
                            `${JSON.stringify(purse)} @ ${owed}: paying ${n} ${d} it does not hold`);
                    }
                }
                settled++;
            }
        }
    }
}
console.log(`ok  ${settled} settlements pay exactly, and none invent money`);

console.log('\nall pricing checks passed');
