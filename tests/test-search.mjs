// The shop search filter, run against the real template output.
//
// This is the one part of the window that can be tested outside Foundry: it reads
// nothing but the rendered markup and a query. Everything it does is decide what to
// hide, and hiding the wrong thing is the sort of bug that looks like a working
// search returning fewer results than it should.
//
// Requires jsdom and handlebars. Both are dev-only and neither is a module
// dependency:  npm install --no-save jsdom handlebars
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let JSDOM, Handlebars;
try {
    ({ JSDOM } = require('jsdom'));
    Handlebars = require('handlebars');
    // Foundry supplies `localize`; this harness is not Foundry. Returning the key
    // keeps the markup structurally identical, which is all a search test reads.
    Handlebars.registerHelper('localize', (key) => String(key));
} catch (_error) {
    console.log('skipped — needs jsdom and handlebars:  npm install --no-save jsdom handlebars');
    process.exit(0);
}

// --- render the real templates -----------------------------------------
const rowSrc = fs.readFileSync(path.join(root, 'templates/partial-shop-row.hbs'), 'utf8');
const shopSrc = fs.readFileSync(path.join(root, 'templates/window-shop.hbs'), 'utf8');
Handlebars.registerPartial('modules/coffee-pub-merchant/templates/partial-shop-row.hbs', rowSrc);

const row = (name, type) => ({
    id: `${name}-id`, name, type,
    typeLabel: type[0].toUpperCase() + type.slice(1),
    img: '', qtyLabel: '∞', priceLabel: '1 gp',
    searchKey: `${name} ${type}`.toLowerCase()
});

const inventory = (id, label, cats) => ({
    id, label, img: '', hidden: false, canToggle: false, canStock: false, isBarter: false,
    hasItems: cats.some((c) => c.items.length),
    count: cats.reduce((n, c) => n + c.items.length, 0),
    categories: cats
});

const html = Handlebars.compile(shopSrc)({
    hasInventories: true, hasRecipient: true, recipientName: 'Tess', recipientImg: '',
    shopName: 'The Shop', portraitImg: '', isGM: false, isOpen: true,
    inventories: [
        inventory('a', 'Storefront', [
            { label: 'Weapons', icon: '', items: [row('Longsword', 'weapon'), row('Dagger', 'weapon')] },
            { label: 'Consumables', icon: '', items: [row('Potion of Healing', 'consumable')] }
        ]),
        inventory('b', 'Premium', [
            { label: 'Armor & Gear', icon: '', items: [row('Plate Armor', 'equipment')] }
        ]),
        inventory('c', 'Back Room', [])
    ]
});

const dom = new JSDOM(`<div class="merchant-shop-window">${html}</div>`);
global.document = dom.window.document;
const el = dom.window.document.querySelector('.merchant-shop-window');

const { filterShopList } = await import('../scripts/window-shop.js')
    .catch(async () => {
        // window-shop.js imports the Blacksmith base class by absolute path, which does
        // not resolve outside Foundry. Read the function out of the file instead — it
        // is self-contained by construction, which is the point of exporting it.
        const src = fs.readFileSync(path.join(root, 'scripts/window-shop.js'), 'utf8');
        const start = src.indexOf('export function filterShopList');
        const end = src.indexOf('\n}\n', start) + 3;
        const mod = await import('data:text/javascript,' + encodeURIComponent(src.slice(start, end)));
        return mod;
    });

const visible = (sel) => [...el.querySelectorAll(sel)].filter((n) => !n.hidden);
const inventories = () => visible('.merchant-shop-inventory')
    .map((s) => s.querySelector('.merchant-shop-inventory-name').textContent.trim());
const rows = () => visible('.merchant-shop-item').map((r) => r.querySelector('strong').textContent.trim());
const cats = () => visible('.merchant-shop-category').length;
const noMatches = () => !el.querySelector('[data-shop-no-matches]').hidden;

// --- no query: everything shows ----------------------------------------
assert.strictEqual(filterShopList(el, ''), 4, 'four rows in total');
assert.strictEqual(rows().length, 4);
assert.strictEqual(visible('.merchant-shop-inventory').length, 3, 'the empty inventory still shows');
assert.ok(!noMatches());
console.log('ok  empty query shows everything, including an empty inventory');

// --- a name match -------------------------------------------------------
assert.strictEqual(filterShopList(el, 'dagger'), 1);
assert.deepStrictEqual(rows(), ['Dagger']);
assert.strictEqual(cats(), 1, 'the Consumables heading is not left over nothing');
assert.deepStrictEqual(inventories(), ['Storefront'], 'Premium and the empty inventory collapse');
console.log('ok  a name match collapses empty categories and inventories');

// --- case and partials --------------------------------------------------
assert.strictEqual(filterShopList(el, 'DAGGER'), 1, 'case insensitive');
assert.strictEqual(filterShopList(el, 'potion of'), 1, 'matches across a space');
assert.strictEqual(filterShopList(el, '  dagger  '), 1, 'surrounding space is trimmed');
console.log('ok  case, partials and whitespace');

// --- a type match -------------------------------------------------------
assert.strictEqual(filterShopList(el, 'weapon'), 2, 'kind matches as well as name');
assert.deepStrictEqual(rows().sort(), ['Dagger', 'Longsword']);
console.log('ok  searching by kind');

// --- across inventories -----------------------------------------------------
assert.strictEqual(filterShopList(el, 'a'), 4, 'a common letter spans both inventories');
assert.strictEqual(inventories().length, 2);
console.log('ok  matches span inventories');

// --- no match -----------------------------------------------------------
assert.strictEqual(filterShopList(el, 'zzz'), 0);
assert.strictEqual(rows().length, 0);
assert.strictEqual(inventories().length, 0, 'every inventory collapses');
assert.ok(noMatches(), 'and the "nothing matches" line appears');
console.log('ok  no match hides everything and says so');

// --- the badge counts what is in front of you ---------------------------
const badge = () => el.querySelector('.merchant-shop-inventory .merchant-shop-count').textContent.trim();
filterShopList(el, '');
assert.strictEqual(badge(), '3', 'Storefront holds three');
filterShopList(el, 'dagger');
assert.strictEqual(badge(), '1', 'and one of them is a dagger');
filterShopList(el, '');
assert.strictEqual(badge(), '3', 'clearing the search puts the real total back');
console.log('ok  the count badge tracks the filter and restores');

// --- clearing restores completely ---------------------------------------
filterShopList(el, 'zzz');
assert.strictEqual(filterShopList(el, ''), 4);
assert.strictEqual(rows().length, 4);
assert.strictEqual(visible('.merchant-shop-inventory').length, 3);
assert.ok(!noMatches());
console.log('ok  clearing after a dead end restores everything');

console.log('\nall search checks passed');

// --- a folded inventory opens for a search, and closes again --------------
// **A folded shelf that hid a match would make the search lie**, which is worse than
// finding nothing: an empty result reads as an answer. But the fold is a decision
// somebody made, so the search overrides it for as long as it lasts and never rewrites
// it — clearing the box has to give it straight back.
const all = () => [...el.querySelectorAll('.merchant-shop-inventory')];
const holdingPlate = all().find((inv) => [...inv.querySelectorAll('.merchant-shop-item')]
    .some((row) => (row.dataset.search ?? '').includes('plate')));
assert.ok(holdingPlate, 'the fixture has an inventory holding Plate Armor');
holdingPlate.classList.add('is-collapsed');

filterShopList(el, 'plate');
assert.ok(holdingPlate.classList.contains('is-search-open'),
    'a folded inventory holding a match opens for the search');
assert.ok(holdingPlate.classList.contains('is-collapsed'),
    'and stays folded underneath — the search overrides, it does not decide');

// An inventory with no match is hidden outright, so it has no reason to open.
for (const inventory of all().filter((inv) => inv !== holdingPlate)) {
    assert.ok(!inventory.classList.contains('is-search-open'),
        'an inventory with no match is not opened');
}

filterShopList(el, '');
assert.ok(!holdingPlate.classList.contains('is-search-open'), 'clearing the search closes it again');
assert.ok(holdingPlate.classList.contains('is-collapsed'), 'and the fold that was there is still there');

holdingPlate.classList.remove('is-collapsed');
console.log('ok  a search opens what it needs to and puts it back');
