// Every `data-action` a template names must have a handler registered for it.
//
// This exists because of a bug that shipped twice in one session and both times
// looked like nothing at all: a button whose action has no handler does nothing, logs
// nothing, and throws nothing. The delegated listener finds the element, looks the
// name up, gets `undefined`, and returns. `node --check` cannot see it, the other
// suites cannot see it, and opening the window shows a button that simply ignores you.
//
// The first time, the action was registered under a name the template did not use.
// The second, a shell chain failed at an earlier step and the edit that would have
// registered it never ran -- so the method existed, the template pointed at it, and
// the map had never heard of it.
//
// Dependency-free on purpose: it reads the files as text. A handler map is a literal
// and a template is a string, so nothing here needs Foundry, a DOM, or a renderer.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const templates = fs.readdirSync(path.join(root, 'templates'))
    .filter((name) => name.endsWith('.hbs'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(root, 'templates', name), 'utf8') }));

const scripts = fs.readdirSync(path.join(root, 'scripts'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(root, 'scripts', name), 'utf8'))
    .join('\n');

// `foo: (event, target, win) => ...` — the shape every entry in a handler map has.
const declared = new Set([...scripts.matchAll(/^\s{4,}([A-Za-z][\w]*)\s*:\s*(?:async\s*)?\(/gm)].map((m) => m[1]));

// A literal name, or a Handlebars expression. An expression is only as safe as the
// context that fills it, so its *possible* values are checked instead: every string
// assigned to that context key anywhere in the scripts.
let checked = 0;
const missing = [];

for (const { name, text } of templates) {
    for (const [, value] of text.matchAll(/data-action="([^"]+)"/g)) {
        const expression = value.match(/\{\{\s*#?if\s+([\w]+)\s*\}\}|\{\{\s*([\w]+)\s*\}\}/);

        if (!expression) {
            checked++;
            if (!declared.has(value)) missing.push(`${name}: "${value}"`);
            continue;
        }

        // e.g. `{{removeAction}}` -> find `removeAction: 'removeFromBasket'` and check
        // each. A key nothing ever assigns is its own kind of dead, so that fails too.
        const key = expression[1] ?? expression[2];
        const assigned = [...scripts.matchAll(new RegExp(`${key}\\s*:\\s*'([\\w]+)'`, 'g'))].map((m) => m[1]);
        assert.ok(assigned.length, `${name}: nothing ever assigns \`${key}\`, so its buttons can do nothing`);
        for (const candidate of assigned) {
            checked++;
            if (!declared.has(candidate)) missing.push(`${name}: ${key} -> "${candidate}"`);
        }
    }
}

assert.deepStrictEqual(missing, [], `data-action values with no handler:\n  ${missing.join('\n  ')}`);
// A floor rather than a count: it guards against the scan silently matching nothing,
// without failing every time a button is added or removed.
assert.ok(checked >= 15, `only ${checked} actions checked — the scan is probably not finding them`);
console.log(`ok  ${checked} data-action bindings all have handlers`);

// --- whoever is shopping ------------------------------------------------
// `blacksmith.dialog.pickActor` documents `Promise<string|null>` and returns the entity
// descriptor instead — its `getValue` calls `readFrom`, which yields objects, where
// `readIdsFrom` yields ids. Handed an object, the uuid lookup matched nothing and the
// window fell back to the first eligible character: choosing somebody silently kept
// whoever you already were, with no error anywhere.
function toUuid(picked) {
    return (typeof picked === 'string' ? picked : (picked?.uuid ?? picked?.id)) || null;
}
assert.strictEqual(toUuid('Actor.abc'), 'Actor.abc', 'a plain uuid is the documented shape');
assert.strictEqual(toUuid({ id: 'Actor.abc', name: 'Nik' }), 'Actor.abc', 'an entity descriptor carries it as `id`');
assert.strictEqual(toUuid({ uuid: 'Actor.abc' }), 'Actor.abc', 'and an Actor-shaped object as `uuid`');
// `uuid` wins: an Actor document has both, and its `id` is the bare id rather than a uuid.
assert.strictEqual(toUuid({ uuid: 'Actor.abc', id: 'abc' }), 'Actor.abc',
    'uuid is preferred, since an Actor\u2019s own `id` is not one');
for (const nothing of [null, undefined, '', {}, 0]) {
    assert.strictEqual(toUuid(nothing), null, `${JSON.stringify(nothing)} is nobody`);
}
console.log('ok  a chosen shopper is resolved however the picker hands them over');

// --- ordering stock inside a category ------------------------------------
// Lifted from the shop's context builder. **Within the category, never across it:** the
// grouping is the coarse answer and this is the fine one, and sorting a whole inventory
// would throw away the kinds that make forty rows readable at all.
function sortRows(rows, order) {
    const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
    return [...rows].sort((a, b) => {
        if (order !== 'price') return byName(a, b);
        const left = a.price ?? null;
        const right = b.price ?? null;
        if (left === null && right === null) return byName(a, b);
        if (left === null) return 1;
        if (right === null) return -1;
        return right - left || byName(a, b);
    });
}
const names = (rows) => rows.map((r) => r.name);
const stock = [
    { name: 'Musket', price: 48500 },
    { name: 'Club', price: 10 },
    { name: 'Javelin', price: 49 },
    { name: 'Amulet', price: null },      // an unpriced row
    { name: 'Whip', price: 194 }
];

assert.deepStrictEqual(names(sortRows(stock, 'name')),
    ['Amulet', 'Club', 'Javelin', 'Musket', 'Whip'],
    'by name is alphabetical, and an unpriced row is just another name');

assert.deepStrictEqual(names(sortRows(stock, 'price')),
    ['Musket', 'Whip', 'Javelin', 'Club', 'Amulet'],
    'by price is dearest first, and the unpriced row goes last');

// **"No price" is not a number**, so it cannot sit at either end of one — it would read
// as free at the bottom or priceless at the top, and it is neither.
const unpriced = [{ name: 'Zither', price: null }, { name: 'Anvil', price: null }, { name: 'Rope', price: 1 }];
assert.deepStrictEqual(names(sortRows(unpriced, 'price')), ['Rope', 'Anvil', 'Zither'],
    'unpriced rows fall to the end and hold their own order by name');

// Ties break by name rather than by whatever order the shelf happened to be in, so two
// restocks of the same shop do not present the same goods differently.
const tied = [{ name: 'Sling', price: 10 }, { name: 'Club', price: 10 }];
assert.deepStrictEqual(names(sortRows(tied, 'price')), ['Club', 'Sling'], 'equal prices break by name');

// The input is never reordered in place: the caller holds the inventory's own list.
const original = [{ name: 'B', price: 2 }, { name: 'A', price: 1 }];
sortRows(original, 'name');
assert.deepStrictEqual(names(original), ['B', 'A'], 'sorting copies rather than mutating');
console.log('ok  stock sorts by name or price, within each category');

// --- a shop tint is a colour, or it is nothing -----------------------------
// Not a cosmetic check. The value is substituted into an inline `style` attribute, and a
// flag is something a GM can hand-edit and a macro can write -- so anything that is not
// a hex colour has to come back as no tint at all.
{
    const { normalizeTint, HOUSE_TINT } = await import('../scripts/const.js');

    assert.strictEqual(normalizeTint('#C33'), '#cc3333', 'shorthand is expanded, and one case is stored');
    assert.strictEqual(normalizeTint('CC3333'), '#cc3333', 'a hash is optional on the way in');
    assert.strictEqual(normalizeTint('  #cc3333  '), '#cc3333', 'and the field is trimmed');
    assert.strictEqual(normalizeTint(HOUSE_TINT), HOUSE_TINT, 'the swatch default survives a round trip');

    for (const rubbish of ['', '   ', null, undefined, 'ochre', '#12', '#1234567', 'rgb(1,2,3)',
        '#cc33zz', {}, []]) {
        assert.strictEqual(normalizeTint(rubbish), null, `${JSON.stringify(rubbish)} is not a tint`);
    }
    // The one that matters: nothing that could close the declaration and open another
    // gets through, so the attribute can only ever hold a colour.
    assert.strictEqual(normalizeTint('#cc3333; background-image: url(evil.png)'), null,
        'a colour with CSS after it is not a colour');
}
console.log('ok  a shop tint is a hex colour or nothing at all');

// --- rarity on a row -------------------------------------------------------
// The one that matters is the empty string. dnd5e leaves `system.rarity` blank on
// everything non-magical, and reading that as `common` would put "Common" beside every
// torch in the shop -- and, worse, is the same conflation that once capped mundane gear
// at the common-magic-item ceiling.
{
    const { itemRarity, rarityLabel } = await import('../scripts/const.js');

    assert.strictEqual(itemRarity({ system: { rarity: '' } }), null, 'blank is an ordinary object');
    assert.strictEqual(itemRarity({ system: { rarity: '   ' } }), null, 'and so is whitespace');
    assert.strictEqual(itemRarity({}), null, 'and so is an item with no system data at all');
    assert.strictEqual(itemRarity({ system: { rarity: 'common' } }), 'common',
        'common is a magic item and is not the blank case');
    assert.strictEqual(itemRarity({ system: { rarity: 'veryRare' } }), 'veryRare');
    // A hand-authored item may carry the words rather than the token.
    assert.strictEqual(itemRarity({ system: { rarity: 'very rare' } }), 'veryRare', 'spaces are tolerated');
    assert.strictEqual(itemRarity({ system: { rarity: 'Legendary' } }), 'legendary', 'and so is a capital');

    assert.strictEqual(rarityLabel('veryRare'), 'Very rare', 'the token reads as words');
    assert.strictEqual(rarityLabel('rare'), 'Rare');
    assert.strictEqual(rarityLabel(null), null, 'nothing to say about an ordinary object');
    assert.strictEqual(rarityLabel(''), null);
}
console.log('ok  rarity reads off an item, and blank is not common');

// --- one shop, one window, one cart ---------------------------------------
// **Identity is the Actor for a linked merchant and the token for an unlinked one.** The
// window registry keys on the uuid it is handed, so this choice is the whole mechanism: a
// pin, a linked token, and a second linked token of the same Actor have to arrive at one
// window with one cart, while three placements of an unlinked pedlar must stay three shops.
{
    // The shape of `MerchantManager.subjectFor`.
    const subjectFor = (token) => (token.actorLink && token.actor
        ? [token.actor, { sceneUuid: token.parent?.uuid ?? null }]
        : [token, {}]);

    const actor = { uuid: 'Actor.bob' };
    const sceneA = { uuid: 'Scene.phlan' };
    const sceneB = { uuid: 'Scene.city' };
    const linkedA = { uuid: 'Scene.phlan.Token.1', actorLink: true, actor, parent: sceneA };
    const linkedB = { uuid: 'Scene.city.Token.2', actorLink: true, actor, parent: sceneB };
    const unlinked1 = { uuid: 'Scene.phlan.Token.3', actorLink: false, actor: { uuid: 'Actor.delta1' }, parent: sceneA };
    const unlinked2 = { uuid: 'Scene.phlan.Token.4', actorLink: false, actor: { uuid: 'Actor.delta2' }, parent: sceneA };

    assert.strictEqual(subjectFor(linkedA)[0].uuid, subjectFor(linkedB)[0].uuid,
        'two linked tokens of one Actor are one shop');
    assert.strictEqual(subjectFor(linkedA)[0].uuid, 'Actor.bob', 'and that shop is the Actor');
    assert.notStrictEqual(subjectFor(unlinked1)[0].uuid, subjectFor(unlinked2)[0].uuid,
        'two unlinked placements are two shops');
    assert.strictEqual(subjectFor(unlinked1)[0].uuid, 'Scene.phlan.Token.3', 'each being its own token');

    // **The scene rides along, and differs between the two doors.** It cannot come off the
    // Actor, and it is what the trade-route market rate is read from.
    assert.strictEqual(subjectFor(linkedA)[1].sceneUuid, 'Scene.phlan');
    assert.strictEqual(subjectFor(linkedB)[1].sceneUuid, 'Scene.city',
        'the same shop, priced where you met it');

    // The slate is keyed by the shop key, so one shop is one cart however it was opened.
    const slateKey = (subject, shopper) => `${subject[0].uuid}|${shopper}`;
    assert.strictEqual(slateKey(subjectFor(linkedA), 'Actor.pc'), slateKey(subjectFor(linkedB), 'Actor.pc'),
        'one cart, whichever door you came in by');
}
console.log('ok  a linked merchant is one shop; an unlinked placement is its own');

// --- a claimed scene is checked, not believed ------------------------------
// The market rate is a Scene flag and it moves prices both ways, so a client naming its
// own scene could name a profitable one. A token subject never reaches this -- the GM
// reads its scene for itself -- and an Actor subject is honoured only where the merchant
// actually is. Same shape of hole as reading an identity out of a payload.
{
    const scene = (uuid, actorIds) => ({ documentName: 'Scene', uuid, tokens: actorIds.map((id) => ({ actorId: id })) });
    // The shape of `MerchantManager.verifiedScene`.
    const verified = (actor, claimed) => {
        if (!actor || !claimed) return null;
        if (claimed.documentName !== 'Scene') return null;
        return claimed.tokens.some((token) => token.actorId === actor.id) ? claimed : null;
    };

    const bob = { id: 'bob' };
    assert.ok(verified(bob, scene('Scene.market', ['bob', 'guard'])), 'a scene the merchant stands on is honoured');
    assert.strictEqual(verified(bob, scene('Scene.elsewhere', ['guard'])), null,
        'a scene the merchant is not on is refused, whatever the client says');
    assert.strictEqual(verified(bob, null), null, 'and no claim is no scene');
    assert.strictEqual(verified(null, scene('Scene.market', ['bob'])), null, 'and no merchant is no scene');
    assert.strictEqual(verified(bob, { documentName: 'Actor', uuid: 'Actor.bob' }), null,
        'a uuid that is not a scene at all is refused');
}
console.log('ok  a client-claimed scene is verified before it prices anything');

// --- a pin names a merchant -----------------------------------------------
// A pin outlives the shop it names -- that is what makes it a pin and not a token -- so
// what it carries has to be readable when the Actor behind it is gone.
{
    const P = await import('../scripts/utility-pins.js');

    assert.strictEqual(P.pinActorUuid({ config: { merchantActorUuid: 'Actor.bob' } }), 'Actor.bob');
    assert.strictEqual(P.pinActorUuid({ config: {} }), null, 'a pin of somebody else is not ours');
    assert.strictEqual(P.pinActorUuid({}), null);
    assert.strictEqual(P.pinActorUuid(null), null);
    assert.strictEqual(P.pinActorUuid({ config: { merchantActorUuid: '' } }), null, 'and blank is not a uuid');

    // **Only a linked merchant may be pinned**, and the test is the same one
    // `worldMerchants` uses to decide what is a shop in its own right.
    assert.ok(P.canPin({ prototypeToken: { actorLink: true } }), 'a linked merchant can be pinned');
    assert.ok(!P.canPin({ prototypeToken: { actorLink: false } }), 'an unlinked one is a copy, not a shop');
    assert.ok(!P.canPin({}), 'and an Actor with no prototype token answers the same way');
    assert.ok(!P.canPin(null));
}
console.log('ok  a pin names a linked merchant, and only a linked one');

// --- taking from an abandoned shop ----------------------------------------
// **The uuid is checked against the list, never trusted.** This is the one place a client
// names an item and something is created from it, so without the check "steal" would grant
// any uuid in the world to anybody who could open a dead shop.
{
    const leavings = [
        { uuid: 'Compendium.dnd5e.items.Item.rations', name: 'Rations' },
        { uuid: 'Compendium.dnd5e.items.Item.torch', name: 'Torch' }
    ];
    // The shape of the check in `_processSteal`.
    const taking = (claimed) => leavings.find((entry) => entry.uuid === claimed) ?? null;

    assert.ok(taking('Compendium.dnd5e.items.Item.torch'), 'something on the floor can be taken');
    assert.strictEqual(taking('Compendium.dnd5e.items.Item.holy-avenger'), null,
        'and a uuid nobody left behind cannot, however it is asked for');
    assert.strictEqual(taking(undefined), null);
    assert.strictEqual(taking(''), null);
}
console.log('ok  an abandoned shop hands over only what is lying in it');

// --- what a dead shop leaves is the GM's to say ---------------------------
// A list of names rather than uuids, for the reason a query shelf is: a stored uuid
// dangles the day a pack is renamed, and a name does not.
{
    // The shape of `abandonedStockNames`, minus the settings read.
    const entry = (text) => {
        const match = /^(.*?)\s*[x*]\s*(\d+)$/i.exec(text);
        if (!match || !match[1]) return { name: text, quantity: null };
        return { name: match[1].trim(), quantity: Math.max(1, Math.trunc(Number(match[2])) || 1) };
    };
    const parse = (stored) => (typeof stored !== 'string' ? null
        : stored.split(/[\n;]/).map((text) => text.trim()).filter(Boolean).map(entry));
    const named = (stored) => parse(stored).map((row) => row.name);

    assert.deepStrictEqual(named('Rations; Torch'), ['Rations', 'Torch']);
    assert.deepStrictEqual(named('Rations;Torch;  Sack '), ['Rations', 'Torch', 'Sack'], 'spacing is forgiven');
    assert.deepStrictEqual(named('Rations\nTorch'), ['Rations', 'Torch'], 'a line break separates too');

    // **Semicolons, because dnd5e names contain commas.** "Rope, Hempen (50 feet)" and
    // "Pot, Iron" are real SRD names, and a comma-separated list would turn each into two
    // names that resolve to nothing -- silently, since a name that resolves to nothing is
    // simply not a row.
    assert.deepStrictEqual(named('Rope, Hempen (50 feet); Pot, Iron'),
        ['Rope, Hempen (50 feet)', 'Pot, Iron'], 'a name may contain commas');

    // **A count comes after an x**, and defaults to one so a plain list stays a plain list.
    assert.deepStrictEqual(parse('Torch x5'), [{ name: 'Torch', quantity: 5 }]);
    assert.deepStrictEqual(parse('Torch'), [{ name: 'Torch', quantity: null }],
        'no count is left for the shop to roll');
    assert.deepStrictEqual(parse('Rope, Hempen (50 feet) x2'),
        [{ name: 'Rope, Hempen (50 feet)', quantity: 2 }], 'a name with commas still takes a count');
    assert.deepStrictEqual(parse('Torch x0'), [{ name: 'Torch', quantity: 1 }],
        'nought of a thing is not a leaving');

    // **Rolled, but not random.** A number drawn afresh on every render would change while
    // somebody was looking at it, and the GM handing it over -- another client, another
    // process -- has to reach the same answer the player was shown. So it is derived.
    const rolled = (pinId, uuid, listed = null) => {
        if (Number.isFinite(listed) && listed > 0) return Math.trunc(listed);
        let hash = 0x811c9dc5;
        for (const character of `${pinId}|${uuid}`) {
            hash ^= character.charCodeAt(0);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return 1 + (hash % 5);
    };

    assert.strictEqual(rolled('pin-a', 'Item.torch'), rolled('pin-a', 'Item.torch'),
        'the same shop shows the same number, every render and on every client');
    assert.notStrictEqual(
        ['pin-a', 'pin-b', 'pin-c', 'pin-d'].map((pin) => rolled(pin, 'Item.torch')).join(''),
        '5555', 'and two dead shops are not stocked identically');
    for (const pin of ['pin-a', 'pin-b', 'pin-c', 'pin-d', 'pin-e', 'pin-f']) {
        const count = rolled(pin, 'Item.rations');
        assert.ok(count >= 1 && count <= 5, pin + ': a handful is one to five, never nought');
    }
    assert.strictEqual(rolled('pin-a', 'Item.torch', 5), 5, 'a count the GM wrote wins outright');

    // **Blank means blank.** A GM emptying the field is saying dead shops are stripped
    // bare, which is an answer about a world rather than a mistake to correct.
    assert.deepStrictEqual(parse(''), [], 'empty is empty, not the default');
    assert.deepStrictEqual(parse('   '), []);
    assert.strictEqual(parse(undefined), null, 'and an unregistered setting falls back instead');
}
console.log('ok  a world says what its dead shops leave behind');

console.log('\nall action checks passed');// --- which picture a pin wears --------------------------------------------
// The orders are fallbacks, not preferences: a shop with no illustration under
// "illustration first" gets the next thing that exists rather than a blank pin, and the
// icon is last in every one because it is the only source that always exists.
{
    const pick = (mode, have) => {
        const order = {
            icon: [],
            illustration: ['illustration'],
            portrait: ['portrait'],
            'illustration-portrait': ['illustration', 'portrait'],
            'portrait-illustration': ['portrait', 'illustration']
        }[mode] ?? [];
        for (const source of order) if (have[source]) return have[source];
        return have.icon;
    };

    const dressed = { illustration: 'scene.webp', portrait: 'face.webp', icon: 'fa-shop' };
    const noPicture = { illustration: null, portrait: null, icon: 'fa-shop' };
    const portraitOnly = { illustration: null, portrait: 'face.webp', icon: 'fa-shop' };

    assert.strictEqual(pick('icon', dressed), 'fa-shop', 'the kind, whatever else the shop has');
    assert.strictEqual(pick('illustration-portrait', dressed), 'scene.webp');
    assert.strictEqual(pick('portrait-illustration', dressed), 'face.webp');
    assert.strictEqual(pick('illustration', dressed), 'scene.webp');
    assert.strictEqual(pick('portrait', dressed), 'face.webp');

    // The fallbacks, which are the whole reason the orders are orders.
    assert.strictEqual(pick('illustration-portrait', portraitOnly), 'face.webp',
        'no illustration falls to the portrait, not to nothing');
    assert.strictEqual(pick('illustration', portraitOnly), 'fa-shop',
        'and with no portrait in the order it falls straight to the icon');
    for (const mode of ['icon', 'illustration', 'portrait', 'illustration-portrait', 'portrait-illustration']) {
        assert.strictEqual(pick(mode, noPicture), 'fa-shop', mode + ': an undressed shop still gets a pin');
    }
    assert.strictEqual(pick('nonsense', dressed), 'fa-shop', 'and a mode nobody registered falls back too');
}
console.log('ok  a pin wears the place, the person, or the trade');


