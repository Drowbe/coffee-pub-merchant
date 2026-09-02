// Shop profiles: a shop described as a recipe, and the arithmetic of applying one.
//
// **The property that matters is that applying is never destructive.** The manager does the
// applying and needs Foundry, but the decision it turns on -- which shelves a merchant does
// not already have -- is pure, and that is what is checked here. A bug in `missingShelves`
// is a shelf silently duplicated, or one silently skipped, and neither is visible until a
// GM looks at a shop they thought they had just set up.
//
// The profile data is checked too, because it is shipped content that has to be valid
// against the shapes the rest of the module reads: an unknown shelf type or a rarity token
// nothing recognises produces a shelf that draws nothing, and says nothing about why.
//
// No dependencies: `const.js` imports nothing and touches no Foundry global at load.
import assert from 'node:assert';
import {
    SHOP_PROFILES, shopProfile, missingShelves,
    INVENTORY_TYPES, SHOP_KINDS, SHOP_DOORS, STOCK, STOCK_DEPTH
} from '../scripts/const.js';
// The rarity vocabulary lives with the compendium query that uses it, not in `const.js`.
import { RARITIES } from '../scripts/utility-compendium.js';

// --- the shipped profile is one, and is findable -------------------------
{
    assert.ok(SHOP_PROFILES.length >= 1, 'at least one profile ships');
    assert.strictEqual(shopProfile('general')?.key, 'general');
    assert.strictEqual(shopProfile('nope'), null, 'an unknown key is null, not a throw');
    assert.strictEqual(shopProfile(undefined), null);
}
console.log('ok  a profile is found by key, and an unknown one is null');

// --- every profile is valid against the shapes the module reads ----------
//
// A shipped profile naming a shelf type that does not exist, or a rarity nothing matches,
// produces a shelf that quietly draws nothing. Cheap to assert, invisible otherwise.
{
    for (const profile of SHOP_PROFILES) {
        assert.ok(profile.key && profile.name && profile.hint, `${profile.key}: named and described`);

        const kind = profile.shop?.kind;
        assert.ok(SHOP_KINDS.some((k) => k.key === kind), `${profile.key}: kind "${kind}" exists`);

        for (const door of Object.keys(profile.shop?.fullscreen ?? {})) {
            assert.ok(SHOP_DOORS.some((d) => d.key === door), `${profile.key}: door "${door}" exists`);
        }

        for (const shelf of profile.shelves) {
            assert.ok(INVENTORY_TYPES[shelf.type], `${profile.key}/${shelf.name}: type "${shelf.type}" exists`);
            assert.ok(shelf.name?.trim(), `${profile.key}: every shelf is named`);

            const stock = shelf.config?.stock;
            assert.ok(Object.values(STOCK).includes(stock), `${shelf.name}: stock "${stock}" is a policy`);

            if (shelf.config.depth !== undefined) {
                assert.ok(Object.values(STOCK_DEPTH).includes(shelf.config.depth), `${shelf.name}: depth`);
            }

            for (const token of shelf.config.query?.rarity ?? []) {
                assert.ok(RARITIES.includes(token), `${shelf.name}: rarity "${token}" is known`);
            }

            const price = shelf.config.query?.priceGp;
            if (price) {
                assert.ok(price.min >= 0 && (price.max === null || price.max > price.min), `${shelf.name}: price band`);
            }
        }
    }
}
console.log('ok  every shipped profile is valid against the shapes it is read by');

// --- the shipped profile draws only on what the system installs ----------
//
// **The reason there is exactly one built-in.** A profile naming a third-party pack fails on
// a fresh world, and a feature whose first use produces an empty shop is worse than no
// feature. `dnd5e.items` and `dnd5e.tradegoods` ship with the system itself.
{
    const packs = new Set(
        shopProfile('general').shelves
            .flatMap((shelf) => shelf.config.query?.sources ?? [])
            .map((source) => source.id)
    );
    assert.deepStrictEqual([...packs].sort(), ['dnd5e.items', 'dnd5e.tradegoods']);
}
console.log('ok  the shipped profile draws only on packs the system installs');

// --- nothing already there is named again --------------------------------
{
    const profile = shopProfile('general');
    const all = profile.shelves.map((shelf) => shelf.name);

    assert.strictEqual(missingShelves(profile, []).length, all.length, 'a bare merchant gets them all');
    assert.strictEqual(missingShelves(profile, all).length, 0, 'a finished merchant gets none');
}
console.log('ok  a shelf that exists is never added twice');

// --- matched the way a person would match them ---------------------------
//
// Case and stray spaces are not a different shelf to anybody looking at a shop, and a
// profile applied twice must not leave "Buy Back" beside "buy back".
{
    const profile = shopProfile('general');
    const missing = missingShelves(profile, ['  GENERAL supplies ', 'catalogue']);
    assert.deepStrictEqual(missing.map((s) => s.name), ['Trade Goods', 'Buy Back']);
}
console.log('ok  shelf names match case-insensitively and ignore stray space');

// --- matched by name, not by type ----------------------------------------
//
// Two `general` shelves is an ordinary shop. Matching on type would tell a merchant with one
// unrelated general shelf that the whole profile was already applied.
{
    const profile = shopProfile('general');
    const missing = missingShelves(profile, ['Oddments']);
    assert.strictEqual(missing.length, profile.shelves.length, 'an unrelated shelf blocks nothing');
}
console.log('ok  an unrelated shelf of the same type blocks nothing');

// --- a profile carries recipes, never goods ------------------------------
//
// The load-bearing design rule. A profile that grew an item list would go stale against the
// compendiums, bloat every world that stored one, and make every shop from it identical.
{
    for (const profile of SHOP_PROFILES) {
        for (const shelf of profile.shelves) {
            assert.strictEqual(shelf.items, undefined, `${shelf.name}: no item list`);
            assert.strictEqual(shelf.config.contents, undefined, `${shelf.name}: no contents`);
        }
    }
}
console.log('ok  no profile carries items, only the rules for getting them');

// --- and nothing that identifies a shopkeeper ----------------------------
//
// Portrait, token art and the like belong to the person. Foundry already clones a person --
// put the Actor in a compendium -- and a profile exists for the case where you are dressing
// somebody the party already know.
{
    for (const profile of SHOP_PROFILES) {
        for (const field of ['img', 'portrait', 'token', 'prototypeToken', 'illustration']) {
            assert.strictEqual(profile.shop?.[field], undefined, `${profile.key}: no ${field}`);
        }
    }
}
console.log('ok  no profile carries a portrait, a token or an illustration');

console.log('\nall profile checks passed');
