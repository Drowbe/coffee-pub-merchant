// How many crates an order needs, which is what an order costs in boxes.
//
// **This arithmetic is charged for.** `packCrates` runs twice on the same goods — once on
// the client to price the slate, once on the GM to take the money — and again at delivery
// to decide what goes in which box. All three have to agree, which is why it is pure and
// why the packing is *not* stored: a second copy of the answer is a second answer.
//
// No dependencies: `const.js` imports nothing and touches no Foundry global at load.
import assert from 'node:assert';
import { packCrates, CRATE } from '../scripts/const.js';

/** A consignment line, in the shape the record stores. */
const line = (name, weight, quantity = 1) => ({
    name, quantity, source: { system: { weight: { value: weight } } }
});

/** "axe x1 + rope x2 | anvil x1" — the packing, readable. */
const show = (crates) => crates
    .map((crate) => crate.map((l) => `${l.name} x${l.quantity}`).join(' + '))
    .join(' | ');

/** Everything that went in, regardless of which box it went in. */
const totalOf = (crates) => crates.flat().reduce((sum, l) => sum + l.quantity, 0);

// --- the ordinary case --------------------------------------------------
{
    const crates = packCrates([line('rope', 10), line('lantern', 2), line('rations', 2, 5)]);
    assert.strictEqual(crates.length, 1, 'twenty-two pounds is one crate');
    assert.strictEqual(totalOf(crates), 7);
}
console.log('ok  a light order travels in one crate');

// --- the limit bites ----------------------------------------------------
{
    const crates = packCrates([line('anvil', 30), line('anvil', 30)]);
    assert.strictEqual(crates.length, 2, 'sixty pounds does not fit in fifty');
}
console.log('ok  a heavy order needs a second crate');

// --- exactly full is still one crate ------------------------------------
//
// The boundary that decides whether a party pay for one box or two, so it is worth being
// explicit that fifty pounds fits in a fifty-pound crate.
{
    assert.strictEqual(packCrates([line('bar', 25, 2)]).length, 1, '50 lb fits in 50 lb');
    assert.strictEqual(packCrates([line('bar', 25, 2), line('pin', 1)]).length, 2, 'one ounce over');
}
console.log('ok  a crate filled to the brim is one crate; a pound more is two');

// --- a stack is split rather than bumped --------------------------------
//
// Twelve ten-pound bars are not an indivisible object. Moving the whole stack to the next
// crate to keep it together would waste most of this one, and a party would pay for the
// waste.
{
    const crates = packCrates([line('bar', 10, 12)]);
    assert.strictEqual(crates.length, 3);
    assert.strictEqual(show(crates), 'bar x5 | bar x5 | bar x2');
    assert.strictEqual(totalOf(crates), 12, 'nothing is lost in the splitting');
}
console.log('ok  a heavy stack is split across crates');

// --- weightless things ride free ----------------------------------------
{
    const crates = packCrates([line('pen', 0, 99)]);
    assert.strictEqual(crates.length, 1, 'nothing that weighs nothing fills a crate');
    assert.strictEqual(totalOf(crates), 99);
}
console.log('ok  weightless goods never need a second crate');

// --- one thing heavier than a crate -------------------------------------
//
// It travels alone, over the stated capacity. Refusing the order at the counter because a
// statue is heavy would be a worse answer than a delivery arriving in an over-full box —
// and the alternative, silently dropping it, is not an answer at all.
{
    const crates = packCrates([line('statue', 400), line('pen', 0)]);
    assert.strictEqual(crates.length, 2);
    assert.strictEqual(crates[0].length, 1, 'the statue has the first crate to itself');
    assert.strictEqual(totalOf(crates), 2, 'and nothing is dropped');
}
console.log('ok  a single item heavier than a crate travels alone');

// --- nothing in, nothing out --------------------------------------------
{
    assert.deepStrictEqual(packCrates([]), []);
}
console.log('ok  an empty order needs no crates');

// --- the same goods always pack the same way ----------------------------
//
// **The load-bearing property.** The slate, the charge and the delivery each run this
// separately; if it were not deterministic a party could be charged for two crates and
// receive three.
{
    const goods = [line('rope', 10, 3), line('anvil', 30), line('rations', 2, 9)];
    assert.strictEqual(show(packCrates(goods)), show(packCrates(goods)));
}
console.log('ok  the same goods pack the same way every time');

// --- the capacity is a parameter, and the default is the crate ----------
{
    assert.strictEqual(packCrates([line('bar', 10, 6)], 20).length, 3);
    assert.strictEqual(CRATE.capacityLb, 50);
    assert.strictEqual(CRATE.weightLb, 5, 'an empty crate is carried, not free');
}
console.log('ok  capacity is a parameter, defaulting to the crate itself');

console.log('\nall mail checks passed');
