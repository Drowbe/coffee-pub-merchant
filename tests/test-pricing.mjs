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

const P = await import('../scripts/utility-pricing.js');
// The shipped tables, so a check on the defaults follows them rather than restating them.
const { INVENTORY_TYPES, REPUTATION_MARKUP, STOCK_RARITY_CAPS } = await import('../scripts/const.js');

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
// inventory that exists not to have prices has none until one is agreed.
const item = (id, gp) => ({ id, system: gp === null ? {} : { price: { value: gp, denomination: 'gp' } } });
const NEGOTIATE = { type: 'unpriced' };
const SALE = { type: 'general', markup: 1 };

assert.strictEqual(P.resolvePrice({}, NEGOTIATE, item('a', 50)), null,
    'a negotiate inventory has no price even for a listed item');
assert.strictEqual(P.resolvePrice({}, SALE, item('a', 50)), 5000, 'and an ordinary inventory still does');
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

const BUYBACK = { type: 'purchased', markup: 1, buyRate: 0.5 };
assert.strictEqual(P.resolvePurchasePrice({}, BUYBACK, item('a', 50)), 2500, 'half the list, as configured');
assert.strictEqual(P.resolvePurchasePrice({}, BUYBACK, item('a', null)), null, 'and nothing for the unpriced');
assert.strictEqual(
    P.resolvePurchasePrice({ pricing: { purchaseOverrides: { a: 900 } } }, BUYBACK, item('a', null)), 900,
    'until the GM says what the merchant will pay');
assert.strictEqual(
    P.resolvePurchasePrice({ pricing: { overrides: { a: 9999 } } }, BUYBACK, item('a', 50)), 2500,
    'a buy-side agreement does not decide what the shop pays');
console.log('ok  agreed prices, both directions');

// --- stacking ------------------------------------------------------------
// The rule the whole pricing model turns on: the shop's Global Markup is a
// baseline (an expensive quarter, or the middle of nowhere) and an inventory's own
// markup is an adjustment *within* that shop. They multiply. Replacing one with the
// other -- which is what this used to do -- priced a premium inventory in an
// expensive shop as though the shop were ordinary.
const DEAR = { pricing: { markup: 1.2 } };
const PREMIUM = { type: 'premium', markup: 1.5 };
const DISCOUNTED = { type: 'discounted', markup: 0.75 };

assert.strictEqual(P.resolvePrice(DEAR, SALE, item('a', 50)), 6000, 'the shop baseline applies on its own');
assert.strictEqual(P.resolvePrice({}, PREMIUM, item('a', 50)), 7500, 'so does an inventory markup on its own');
assert.strictEqual(P.resolvePrice(DEAR, PREMIUM, item('a', 50)), 9000, '1.2 x 1.5 = 1.8, not 1.5');
assert.strictEqual(P.resolvePrice(DEAR, DISCOUNTED, item('a', 50)), 4500, 'and a discount cuts the baseline, not the book');

// A rate of zero, a negative, or a typo is "no adjustment" rather than a free item.
for (const bad of [0, -1, null, undefined, 'x', NaN]) {
    assert.strictEqual(P.resolvePrice({ pricing: { markup: bad } }, { type: 'general', markup: bad }, item('a', 50)),
        5000, `a markup of ${String(bad)} changes nothing`);
}
console.log('ok  markups stack, and rubbish rates change nothing');

// --- reputation ----------------------------------------------------------
// Applied on top of both markups when buying, and **inverted** when selling: the
// standing that buys you a discount should get you more for your goods, or a
// beloved party is rewarded in one direction and ignored in the other.
assert.strictEqual(P.resolvePrice({}, SALE, item('a', 50), { reputation: 0.85 }), 4250, 'liked is cheaper');
assert.strictEqual(P.resolvePrice({}, SALE, item('a', 50), { reputation: 1.15 }), 5750, 'disliked is dearer');
assert.strictEqual(P.resolvePrice(DEAR, PREMIUM, item('a', 50), { reputation: 0.85 }), 7650,
    'and it multiplies against both markups');
assert.strictEqual(P.resolvePrice({}, SALE, item('a', 50), { reputation: 1 }), 5000, 'neutral moves nothing');

assert.strictEqual(P.resolvePurchasePrice({}, BUYBACK, item('a', 50), { reputation: 0.85 }), 2941,
    'a liked party is paid more, not less');
assert.strictEqual(P.resolvePurchasePrice({}, BUYBACK, item('a', 50), { reputation: 1.15 }), 2174,
    'and a disliked one is paid less');

// An agreed price is the price. Nothing is applied on top of a number two people
// settled on, in either direction.
assert.strictEqual(P.resolvePrice(AGREED, SALE, item('a', 50), { reputation: 0.5 }), 1200,
    'reputation does not re-cut an agreed price');
assert.strictEqual(
    P.resolvePurchasePrice({ pricing: { purchaseOverrides: { a: 900 } } }, BUYBACK, item('a', 50), { reputation: 0.5 }),
    900, 'nor an agreed buyback');

console.log('ok  reputation, both directions');

// --- two levers, two scopes ----------------------------------------------
// **Reputation is the area's disposition; markup is one merchant's choice.** Both
// apply to buying and to selling, or a merchant becomes a one-way valve: marking
// everything up while paying the going rate.
assert.strictEqual(P.resolvePurchasePrice(DEAR, BUYBACK, item('a', 50)), 3000,
    'a merchant who charges 1.2x also pays 1.2x');
assert.strictEqual(P.resolvePrice(DEAR, SALE, item('a', 50)), 6000, 'and still charges it');

// **A shop never pays more than it charges, and that is what stops a gold machine.**
// The real loop is: sell a sword to a merchant, then buy it back off the inventory it
// landed on. The merchant's markup cancels, leaving `buyRate / rep²` — reputation
// twice, because it makes buying cheaper *and* selling dearer — which a generous
// merchant in a beloved town can push above 1. Held by a clamp rather than by
// tuning, so no combination of the three rates can open it.
for (const markup of [0.5, 1, 1.2, 2, 3]) {
    for (const invMarkup of [0.5, 1, 1.5]) {
        for (const rep of [0.85, 0.9, 1, 1.15, 1.3]) {
            for (const buyRate of [0.1, 0.5, 0.9, 1.5]) {
                const shop = { pricing: { markup } };
                const inv = { type: 'purchased', markup: invMarkup, buyRate };
                const paidToYou = P.resolvePurchasePrice(shop, inv, item('a', 50), { reputation: rep });
                const chargedBack = P.resolvePrice(shop, inv, item('a', 50), { reputation: rep });
                assert.ok(paidToYou < chargedBack,
                    `pays ${paidToYou} but charges ${chargedBack} `
                    + `(shop ${markup}, inv ${invMarkup}, rep ${rep}, rate ${buyRate})`);
            }
        }
    }
}
console.log('ok  no round trip at one merchant can turn a profit');

// --- the local market ----------------------------------------------------
// **The lever trade actually runs on.** Market is what goods are worth in a place,
// whoever is asking, so it multiplies both sides in the *same* direction — unlike
// reputation, which inverts. That asymmetry is what makes a route: a place where
// goods are dear is bad to buy in and good to sell in.
const DEAR_TOWN = { market: 4 };
const CHEAP_TOWN = { market: 0.25 };

assert.strictEqual(P.resolvePrice({}, SALE, item('a', 100), DEAR_TOWN), 40000, 'goods cost more where they are scarce');
assert.strictEqual(P.resolvePrice({}, SALE, item('a', 100), CHEAP_TOWN), 2500, 'and less at the source');
assert.ok(
    P.resolvePurchasePrice({}, BUYBACK, item('a', 100), DEAR_TOWN)
    > P.resolvePurchasePrice({}, BUYBACK, item('a', 100), CHEAP_TOWN),
    'and a dear town also pays more — which reputation, being a favour, never does');

// The route itself: buy at the source, carry it to where it is scarce.
const atSource = P.resolvePrice({}, SALE, item('a', 100), CHEAP_TOWN);
const atMarket = P.resolvePurchasePrice({}, BUYBACK, item('a', 100), DEAR_TOWN);
assert.ok(atMarket > atSource * 3, `carrying goods pays: ${atSource} -> ${atMarket}`);
console.log('ok  a market makes a trade route, and pays both ways');

// And it cannot be turned into a machine either: the same clamp holds, because both
// sides move together and cancel.
for (const market of [0.25, 1, 2, 4]) {
    for (const rep of [0.85, 1, 1.3]) {
        for (const buyRate of [0.5, 0.9, 1.5]) {
            const inv = { type: 'purchased', markup: 1, buyRate };
            const paidToYou = P.resolvePurchasePrice({}, inv, item('a', 50), { reputation: rep, market });
            const chargedBack = P.resolvePrice({}, inv, item('a', 50), { reputation: rep, market });
            assert.ok(paidToYou < chargedBack,
                `market ${market}, rep ${rep}, rate ${buyRate}: pays ${paidToYou} charges ${chargedBack}`);
        }
    }
}
console.log('ok  a market cannot open the loop either');

// **Trade between merchants is possible, which is the point.** Buy from a merchant
// pricing at the going rate, sell to one who deals dear — the profit is the
// difference between their two markups, less the second one's spread.
const iowa = { pricing: { markup: 1 } };
const california = { pricing: { markup: 2 } };
const generous = { type: 'purchased', markup: 2, buyRate: 0.6 };
const boughtFor = P.resolvePrice(iowa, SALE, item('a', 100));
const soldFor = P.resolvePurchasePrice(california, generous, item('a', 100));
assert.strictEqual(boughtFor, 10000, 'bought at the going rate');
assert.strictEqual(soldFor, 12000, 'sold where goods are dear');
assert.ok(soldFor > boughtFor, 'a trade route exists');
console.log('ok  buying cheap and selling dear turns a profit');

// The purchased type's two rates are independent, which is the whole reason there
// are two: what the shop hands over is not what it asks for the thing afterwards.
const TRADE = { type: 'purchased', markup: 1.25, buyRate: 0.4 };
assert.strictEqual(P.resolvePurchasePrice({}, TRADE, item('a', 50)), 2000, 'pays 40% of worth');
assert.strictEqual(P.resolvePrice({}, TRADE, item('a', 50)), 6250, 'and resells at 125%');
console.log('ok  purchase and sell rates are independent');

// --- fromBase round-trips ------------------------------------------------
// The price control types gold and stores base units; both directions have to
// agree or a price drifts every time it is opened and closed.
for (const [gp, base] of [[1, 100], [7.5, 750], [0, 0], [200, 20000]]) {
    assert.strictEqual(P.toBase(gp, 'gp'), base);
    assert.strictEqual(P.fromBase(base, 'gp'), gp, `${base}cp reads back as ${gp}gp`);
}
console.log('ok  gold and base units round-trip');

// --- free is a decision; no price is an absence --------------------------
// dnd5e leaves `system.price.value` at 0 on everything nobody has valued, so a bare 0
// means "unvalued" far more often than it means "free". Reading it as free would put a
// shop's whole unpriced stock on the house, which is why the flag exists.
const MID = 'coffee-pub-merchant';
const priced = (gp) => ({ type: 'loot', system: { quantity: 1, price: { value: gp, denomination: 'gp' } } });
const freeItem = () => ({ ...priced(0), flags: { [MID]: { free: true } } });

assert.strictEqual(P.listPriceBase(priced(0)), null, 'a bare zero is a row nobody has priced');
assert.strictEqual(P.listPriceBase(freeItem()), 0, 'and zero with the flag is a giveaway');
assert.strictEqual(P.listPriceBase(priced(5)), 500, 'while a real price is still a real price');
// The flag wins over whatever figure happens to be sitting in the field, so a GM who
// gives away something that used to cost money does not have to clear the price too.
const wasPriced = { ...priced(12), flags: { [MID]: { free: true } } };
assert.strictEqual(P.listPriceBase(wasPriced), 0, 'the flag beats a stale figure underneath it');

// Zero survives every multiplier. The floor of one exists so rounding cannot make a
// cheap thing free by accident; a thing free on purpose is not an accident.
const shop = { pricing: { markup: 3 } };
const shelf = { type: 'general', markup: 2 };
assert.strictEqual(P.resolvePrice(shop, shelf, freeItem(), { reputation: 1.3, market: 4 }), 0,
    'no markup, market or standing can put a price on a giveaway');
assert.strictEqual(P.resolvePrice(shop, shelf, priced(0)), null,
    'while an unpriced row stays unpriced rather than becoming free');
// One base unit is still the floor for anything that genuinely costs something.
assert.strictEqual(P.resolvePrice({ pricing: { markup: 0.0001 } }, null, priced(0.01)), 1,
    'a price rounded to nothing is a penny, not a gift');

// A shop pays nothing for what it gives away -- and the floor of one must not turn that
// into a penny apiece for however many the party carries back in.
assert.strictEqual(P.resolvePurchasePrice(shop, { type: 'purchased', buyRate: 0.7, markup: 1.05 }, freeItem()), 0,
    'a giveaway is bought back for nothing');
console.log('ok  free and unpriced are different states and stay different');

// --- where the buyback clamp takes over from the slider ------------------
// Above this rate `MAX_BUYBACK_RATIO` governs instead of the Purchase slider, and
// because the cap falls as standing improves while the offer rises, a party the town
// loves is paid LESS than a neutral one. The window prints the line; this pins it.
const BEST = 0.85;   // legendary, the tightest point on the curve
for (const markup of [1, 1.05, 1.25, 1.5]) {
    const safe = P.safeBuyRate(markup, BEST);
    const shelf = { type: 'purchased', buyRate: safe, markup };
    const at = (rate) => P.resolvePurchasePrice({ pricing: { markup: 1 } },
        { ...shelf, buyRate: rate }, priced(100), { reputation: BEST });

    // Exactly at the line the clamp is touching but not yet governing: nudging the
    // rate up must move what the shop pays, and it stops moving once the cap bites.
    const atLine = at(safe);
    const above = at(Math.min(1.5, safe + 0.2));
    assert.strictEqual(above, atLine,
        `at ${markup} markup, raising the rate past ${(safe * 100).toFixed(0)}% changes nothing — the cap governs`);
    const below = at(safe - 0.1);
    assert.ok(below < atLine,
        `while below the line the slider still moves the number (${markup} markup)`);
}
console.log('ok  above the safe rate the clamp governs and the slider stops meaning anything');

// The shipped default has to sit under its own line, or the window ships warning about
// its own defaults on every purchased inventory anybody creates.
const dflt = INVENTORY_TYPES.purchased.defaults;
assert.ok(dflt.buyRate <= P.safeBuyRate(dflt.markup, BEST),
    `the shipped purchased defaults (${dflt.buyRate} / ${dflt.markup}) must not trip their own warning`);

// And standing must help at every band, which is the symptom that started this.
let previous = 0;
for (const band of ['hated', 'distrusted', 'neutral', 'known', 'admired', 'legendary']) {
    const paid = P.resolvePurchasePrice({ pricing: { markup: 1 } },
        { type: 'purchased', ...dflt }, priced(100), { reputation: REPUTATION_MARKUP[band] });
    assert.ok(paid >= previous, `standing must never reduce what a shop pays — ${band} paid ${paid} after ${previous}`);
    previous = paid;
}
console.log('ok  with the shipped rates, better standing is always paid better');

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
// The world tables are arguments, so these checks say what they mean rather than
// tracking whatever a GM has since set. `open` is a table with no opinion at all,
// which is how a single lever gets tested on its own.
const open = {};
const noCaps = { typeCaps: open, rarityCaps: open };

// 1. What the item says it is wins outright.
assert.strictEqual(P.stockDepth(goods('consumable', 1, 20), { maxPerItem: 99, random: minRoll, ...noCaps }), 20,
    'a quiver authored as twenty arrives as twenty');
assert.strictEqual(P.stockDepth(goods('equipment', 1500, 6), { maxPerItem: 99, random: minRoll, ...noCaps }), 6,
    'and it wins even for something that would not otherwise stack');
assert.strictEqual(P.stockDepth(goods('consumable', 1, 20), { maxPerItem: 5, random: minRoll, ...noCaps }), 5,
    'but the inventory ceiling still clamps it');
// The world's tables do NOT clamp an authored quantity. They exist to invent a number
// when nobody stated one; applying them to a stated one overrules the only person who
// knew. Only the shelf's own ceiling, which this GM typed, still holds.
assert.strictEqual(P.stockDepth(goods('consumable', 1, 20),
    { maxPerItem: 99, random: minRoll, typeCaps: { consumable: 10 }, rarityCaps: { common: 2 } }), 20,
    'and neither world table argues with a quantity the author stated');

// 2. Then the price band, for things a shop keeps a pile of.
assert.strictEqual(P.stockDepth(goods('consumable', 0.5, 1), { maxPerItem: 99, random: maxRoll, ...noCaps }), 10,
    'under a gold piece caps at ten');
assert.strictEqual(P.stockDepth(goods('consumable', 10, 1), { maxPerItem: 99, random: maxRoll, ...noCaps }), 5,
    'ordinary consumables cap at five');
assert.strictEqual(P.stockDepth(goods('consumable', 50, 1), { maxPerItem: 99, random: maxRoll, ...noCaps }), 3,
    'the better potions cap at three');
assert.strictEqual(P.stockDepth(goods('consumable', 500, 1), { maxPerItem: 99, random: maxRoll, ...noCaps }), 1,
    'anything dear is a single item');
assert.strictEqual(P.stockDepth(goods('consumable', 0.5, 1), { maxPerItem: 99, random: minRoll, ...noCaps }), 5,
    'and the die wobbles under the ceiling rather than down to one');
assert.strictEqual(P.stockDepth(goods('consumable', 0.5, 1), { maxPerItem: 4, random: maxRoll, ...noCaps }), 4,
    'the inventory ceiling beats the band');
console.log('ok  price still bands the depth');

// 3. Type is the first lever, and the one closest to how a shop is pictured.
assert.strictEqual(P.stockDepth(goods('equipment', 0.1, 1),
    { maxPerItem: 99, random: maxRoll, typeCaps: { equipment: 5 }, rarityCaps: open }), 5,
    'cheap armour is held back by being armour');
assert.strictEqual(P.stockDepth(goods('consumable', 0.1, 1),
    { maxPerItem: 99, random: maxRoll, typeCaps: { consumable: 10 }, rarityCaps: open }), 10,
    'and a cheap consumable is not');
// Zero is a lever declining to have an opinion, not a ceiling of nothing. A shelf
// of items capped at zero would be the worst possible reading of a default.
assert.strictEqual(P.stockDepth(goods('consumable', 0.1, 1),
    { maxPerItem: 99, random: maxRoll, typeCaps: { consumable: 0 }, rarityCaps: open }), 10,
    'a cap of zero means the type says nothing, not that it says none');
assert.strictEqual(P.stockDepth(goods('loot', 0.1, 1),
    { maxPerItem: 99, random: maxRoll, typeCaps: { consumable: 3 }, rarityCaps: open }), 10,
    'an unlisted type is unconstrained by the table');

// 4. Rarity is the lever price cannot pull.
const rare = (rarity, gp) => {
    const item = goods('weapon', gp, 1);
    item.system.rarity = rarity;
    return item;
};
assert.strictEqual(P.stockDepth(rare('legendary', 0.1),
    { maxPerItem: 99, random: maxRoll, typeCaps: open, rarityCaps: { legendary: 1 } }), 1,
    'a legendary thing arrives alone however cheap it is');
assert.strictEqual(P.stockDepth(rare('uncommon', 0.1),
    { maxPerItem: 99, random: maxRoll, typeCaps: open, rarityCaps: { uncommon: 3 } }), 3,
    'an uncommon one is held to a few');
assert.strictEqual(P.stockDepth(rare('common', 0.1),
    { maxPerItem: 99, random: maxRoll, typeCaps: open, rarityCaps: { common: 0 } }), 10,
    'and common declines to have an opinion');
// **A blank rarity is `mundane`, and mundane is not common.** dnd5e leaves
// `system.rarity` empty on non-magical gear while `common` means a common *magic* item.
// Reading blank as common was harmless only while both rows were 0; the moment a GM
// capped common magic items, every rope and torch would have been capped with them —
// which is a wrong shop with no error in it. Asserted with the two rows set apart, so
// the check cannot pass by their happening to agree.
const split = { mundane: 0, common: 2, legendary: 1 };
assert.strictEqual(P.stockDepth(goods('loot', 0.1, 1),
    { maxPerItem: 99, random: maxRoll, typeCaps: open, rarityCaps: split }), 10,
    'unmarked gear is mundane and takes the mundane row');
assert.strictEqual(P.stockDepth(rare('common', 0.1),
    { maxPerItem: 99, random: maxRoll, typeCaps: open, rarityCaps: split }), 2,
    'while a common *magic* item takes the common row');
assert.strictEqual(STOCK_RARITY_CAPS.mundane, 0,
    'and the shipped table has a mundane row, or unmarked gear falls through to nothing');

// 5. The smallest ceiling wins, whichever lever it came from.
assert.strictEqual(P.stockDepth(rare('rare', 0.1),
    { maxPerItem: 99, random: maxRoll, typeCaps: { weapon: 5 }, rarityCaps: { rare: 2 } }), 2,
    'rarity beats type when rarity is tighter');
assert.strictEqual(P.stockDepth(rare('common', 0.1),
    { maxPerItem: 99, random: maxRoll, typeCaps: { weapon: 2 }, rarityCaps: { common: 0 } }), 2,
    'and type beats rarity when type is');
assert.strictEqual(P.stockDepth(rare('common', 900),
    { maxPerItem: 99, random: maxRoll, typeCaps: { weapon: 5 }, rarityCaps: { common: 0 } }), 1,
    'and price beats both when price is');
console.log('ok  type, rarity and price each set a ceiling and the lowest wins');

// 6. The shop's own dial scales the ceiling, never below one.
assert.strictEqual(P.stockDepth(goods('consumable', 0.1, 1),
    { maxPerItem: 99, random: maxRoll, scale: 2, ...noCaps }), 20,
    'a deep shop keeps twice as many');
assert.strictEqual(P.stockDepth(goods('consumable', 0.1, 1),
    { maxPerItem: 99, random: maxRoll, scale: 0.5, ...noCaps }), 5,
    'a sparse one keeps half');
assert.strictEqual(P.stockDepth(goods('consumable', 900, 1),
    { maxPerItem: 99, random: maxRoll, scale: 0.5, ...noCaps }), 1,
    'and a sparse shop still stocks one of a dear thing rather than none');
// The shelf's own ceiling is not scalable: it is a number a GM typed, and a dial
// arguing with it would mean the figure on the card was not the figure in force.
assert.strictEqual(P.stockDepth(goods('consumable', 0.1, 1),
    { maxPerItem: 6, random: maxRoll, scale: 2, ...noCaps }), 6,
    'the shelf ceiling is never scaled past');
console.log('ok  the depth dial scales the world, not the shelf');

// 7. The die wobbles under the ceiling; it never starts from one.
// A uniform roll made 1 as likely as the cap, so a shelf of twenty-five products landed
// about five of them single -- one dagger, one dart -- which is the thing every other
// rule here exists to prevent.
const spread = (cap) => {
    const item = goods('consumable', 0.1, 1);
    return [
        P.stockDepth(item, { maxPerItem: cap, random: minRoll, ...noCaps }),
        P.stockDepth(item, { maxPerItem: cap, random: maxRoll, ...noCaps })
    ];
};
assert.deepStrictEqual(spread(10), [5, 10], 'a ceiling of ten delivers five to ten');
assert.deepStrictEqual(spread(5), [3, 5], 'a ceiling of five delivers three to five');
assert.deepStrictEqual(spread(3), [2, 3], 'a ceiling of three delivers two to three');
assert.deepStrictEqual(spread(2), [1, 2], 'a ceiling of two delivers one to two');
// The case the floor must not break: a ceiling of one is exactly one, which is what
// keeps a legendary blade alone on the shelf.
assert.deepStrictEqual(spread(1), [1, 1], 'a ceiling of one is still exactly one');

// Across the whole range, and with a real die rather than the two extremes. The
// effective ceiling is the *lowest* of the levers, so a shelf limit above the price
// band never binds -- a 0.1 gp consumable tops out at ten however high `maxPerItem` is.
for (const cap of [1, 2, 3, 5, 10, 20]) {
    const effective = Math.min(cap, 10);
    const floor = Math.max(1, Math.ceil(effective / 2));
    for (let i = 0; i < 200; i++) {
        const d = P.stockDepth(goods('consumable', 0.1, 1), { maxPerItem: cap, ...noCaps });
        assert.ok(d >= floor && d <= effective,
            `a shelf limit of ${cap} delivered ${d}, outside ${floor}-${effective}`);
    }
}
console.log('ok  a delivery is never a single item unless the ceiling says so');

// An item with no price at all must not become a pile by default.
assert.strictEqual(P.stockDepth(goods('consumable', null, 1), { maxPerItem: 99, random: maxRoll, ...noCaps }), 10,
    'an unpriced consumable falls in the cheapest band, which is the honest reading');

// Never zero, never negative, whatever it is handed.
for (const bad of [null, undefined, {}, goods('consumable', 1, 0), goods('consumable', 1, -3)]) {
    const d = P.stockDepth(bad, { maxPerItem: 5, random: minRoll, ...noCaps });
    assert.ok(Number.isInteger(d) && d >= 1, `depth stays a positive integer for ${JSON.stringify(bad)}`);
}
// Stackability is read off the document, never assumed -- the same rule the
// inventory API states for itself. No `system.quantity` means no stack to deepen.
assert.strictEqual(P.stockDepth({ type: 'loot', system: { price: { value: 0.1, denomination: 'gp' } } },
    { maxPerItem: 99, random: maxRoll, ...noCaps }), 1, 'an item with no quantity field does not stack');
assert.strictEqual(P.stockDepth({ type: 'loot', system: { quantity: '3' } },
    { maxPerItem: 99, random: maxRoll, ...noCaps }), 1, 'and a quantity that is a string is not a quantity');
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

// --- the renamed key -----------------------------------------------------
// `buybackOverrides` became `purchaseOverrides` when *buyback* left the vocabulary.
// A stored key is the expensive half of a rename, so the old one is still read: a
// player who opens a shop before the GM has logged in to run the migration should
// not watch an agreed price disappear and come back.
assert.strictEqual(
    P.negotiatedPurchase({ pricing: { purchaseOverrides: { a: 900 } } }, 'a'), 900,
    'the current key');
assert.strictEqual(
    P.negotiatedPurchase({ pricing: { buybackOverrides: { a: 700 } } }, 'a'), 700,
    'and the one a world may still be holding');
assert.strictEqual(
    P.negotiatedPurchase({ pricing: { purchaseOverrides: { a: 900 }, buybackOverrides: { a: 700 } } }, 'a'),
    900, 'the migrated key wins when a world somehow has both');
assert.strictEqual(P.negotiatedPurchase({ pricing: {} }, 'a'), null, 'and nothing means nothing');
console.log('ok  the renamed sell-side key reads old and new');
