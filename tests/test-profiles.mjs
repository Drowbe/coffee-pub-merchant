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
    SHOP_PROFILES, shopProfile, missingShelves, allProfiles, profileFromShop,
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

// --- a world's own profiles join the shipped one -------------------------
{
    const custom = [{ key: 'fence', name: 'A Fence', shelves: [] }];
    assert.strictEqual(allProfiles(custom).length, SHOP_PROFILES.length + 1);
    assert.strictEqual(shopProfile('fence', custom)?.name, 'A Fence');
    assert.strictEqual(shopProfile('fence'), null, 'without the saved list it is not there');

    // A saved profile keyed like a shipped one replaces it: a GM who named theirs `general`
    // has said which they meant, and offering both is a picker with two identical rows.
    const override = [{ key: 'general', name: 'My General Store', shelves: [] }];
    assert.strictEqual(allProfiles(override).length, SHOP_PROFILES.length);
    assert.strictEqual(shopProfile('general', override).name, 'My General Store');

    // Rubbish in the setting is ignored rather than thrown over: this is a world setting a
    // GM could edit by hand, and a shop that will not open is a poor way to learn that.
    assert.strictEqual(allProfiles(null).length, SHOP_PROFILES.length);
    assert.strictEqual(allProfiles([{ nonsense: true }, null]).length, SHOP_PROFILES.length);
}
console.log("ok  a world's saved profiles join the shipped one, and rubbish is ignored");

// --- saving a shop drops everything that identifies it -------------------
//
// The load-bearing half of "compendium actors clone, profiles configure". If this leaks a
// name or a picture, applying a profile starts overwriting the person.
{
    const saved = profileFromShop('Corner Shop', {
        name: "Phil's Shop-O-Stuff",
        enabled: true,
        img: 'portrait.webp',
        illustration: 'shop.webp',
        override: { open: true },
        profile: { key: 'general' },
        kind: 'general',
        pricing: { markup: 1.2 }
    }, [
        { name: 'Front', config: { type: 'general', order: 40, par: 7, markup: 1, stock: 'infinite' } }
    ]);

    assert.strictEqual(saved.name, 'Corner Shop', 'the profile is named by the GM');
    for (const field of ['name', 'enabled', 'img', 'illustration', 'override', 'profile']) {
        assert.strictEqual(saved.shop[field], undefined, `${field} is not saved`);
    }
    assert.deepStrictEqual(saved.shop.pricing, { markup: 1.2 }, 'how it works is saved');

    // `order` is rewritten against the shop it lands on, and `par` is what is on a shelf
    // today rather than a rule about it.
    assert.strictEqual(saved.shelves[0].config.order, undefined);
    assert.strictEqual(saved.shelves[0].config.par, undefined);
    assert.strictEqual(saved.shelves[0].config.stock, 'infinite');
}
console.log('ok  saving a shop keeps how it works and drops who it is');

// --- a saved profile is a profile ----------------------------------------
//
// It goes straight back into the same picker and the same apply path, so it has to satisfy
// what those read: a key, a name, and shelves carrying a type.
{
    const saved = profileFromShop('  ', {}, [{ name: 'Odds', config: {} }]);
    assert.ok(saved.key, 'always keyed');
    assert.strictEqual(saved.name, 'Saved profile', 'an empty name still yields one');
    assert.strictEqual(saved.shelves[0].type, 'general', 'a shelf with no type is a general one');
    assert.strictEqual(missingShelves(saved, ['odds']).length, 0, 'and it matches like any other');
}
console.log('ok  a saved profile is usable by the same picker that made it');

// --- a shop has one catalogue and one buyback shelf ----------------------
//
// **These two are matched on their type, not their name.** The catalogue view draws every
// catalogue shelf as one book and selling looks for *the* buyback shelf, so a second is not
// a second of anything -- it is one shelf's contents in two places with no way to tell which
// is which. Name matching alone would have added one to any shop that had called theirs
// something else, which is most of them.
{
    const profile = shopProfile('general');

    const differently = [
        { name: 'Pawn', type: 'purchased' },
        { name: 'The Ledger', type: 'catalogue' }
    ];
    const missing = missingShelves(profile, differently).map((shelf) => shelf.name);
    assert.deepStrictEqual(missing, ['General Supplies', 'Trade Goods'], 'neither singleton is added again');

    // And the ordinary types still match by name, so an unrelated general shelf blocks
    // nothing -- including the general shelves the profile names.
    const unrelated = missingShelves(profile, [{ name: 'Oddments', type: 'general' }]);
    assert.strictEqual(unrelated.length, profile.shelves.length);
}
console.log('ok  a shop gets one catalogue and one buyback shelf, whatever they are called');

// --- the singleton types say so themselves -------------------------------
//
// In the type table rather than a list somewhere else, so a seventh type declares its own
// rule where its name, icon and defaults already live.
{
    assert.strictEqual(INVENTORY_TYPES.catalogue.single, true);
    assert.strictEqual(INVENTORY_TYPES.purchased.single, true);
    assert.strictEqual(INVENTORY_TYPES.general.single, undefined, 'a shop may have several');
}
console.log('ok  the singleton types are declared in the type table');

// --- a bare list of names still works ------------------------------------
//
// The signature widened from names to `{ name, type }`; taking a string as a name keeps
// every existing caller and every check above honest.
{
    const profile = shopProfile('general');
    assert.strictEqual(missingShelves(profile, ['General Supplies']).length, profile.shelves.length - 1);
}
console.log('ok  a plain list of names is still understood');

// --- a shop may repeat a shelf name as often as it likes -----------------
//
// **Only the singletons are constrained.** Two shelves called General beside two called Odds
// and Ends is an ordinary shop -- nothing in the module looks a shelf up by name, every
// lookup is by id -- so the matcher has to cope with repeats in what it is handed rather
// than treat them as a state that cannot happen.
{
    const profile = shopProfile('general');
    const shop = [
        { name: 'General', type: 'general' },
        { name: 'General', type: 'general' },
        { name: 'Good Stuff', type: 'general' },
        { name: 'More Stuff', type: 'general' },
        { name: 'Catalogue', type: 'catalogue' },
        { name: 'Purchased', type: 'purchased' }
    ];

    const missing = missingShelves(profile, shop).map((shelf) => shelf.name);
    assert.deepStrictEqual(missing, ['General Supplies', 'Trade Goods'],
        'the two general shelves are added; the two singletons are not');
}
console.log('ok  repeated shelf names are ordinary, and only the singletons are constrained');

console.log('\nall profile checks passed');
