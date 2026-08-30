// Patching the rendered page instead of replacing it.
//
// **The thing being tested is what is NOT rebuilt.** A morph that produces the right HTML
// is not enough -- a `replaceWith` produces the right HTML too, and that is the bug. What
// makes this worth doing is node identity: the same `<img>` object still being in the tree
// afterwards is the difference between a wall of pictures that sits still and a wall that
// blinks on every click. So most of these assertions are `assert.strictEqual` on element
// references, not on markup.
//
// The functions are read out of the module source rather than imported, because importing
// `window-shop.js` means importing Foundry.
//
// Requires jsdom, dev-only:  npm install --no-save jsdom
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let JSDOM;
try {
    ({ JSDOM } = require('jsdom'));
} catch (_error) {
    console.log('skipped — needs jsdom:  npm install --no-save jsdom');
    process.exit(0);
}

// --- lift the morph out of the module ----------------------------------
const source = fs.readFileSync(path.join(root, 'scripts/window-shop.js'), 'utf8');
const start = source.indexOf('/** Attributes that identify a node across renders');
const end = source.indexOf('const ShopBehaviour = (Base) =>');
assert.ok(start > 0 && end > start, 'the morph helpers should still be at module scope');

const dom = new JSDOM('<body></body>');
const { window } = dom;
global.Node = window.Node;
global.document = window.document;
global.HTMLInputElement = window.HTMLInputElement;
global.HTMLTextAreaElement = window.HTMLTextAreaElement;
global.HTMLSelectElement = window.HTMLSelectElement;

const { morphNode } = await import(
    `data:text/javascript,${encodeURIComponent(`${source.slice(start, end)}\nexport { morphNode, morphChildren, morphKey };`)}`
);

/** Morph `html` onto a tree built from `before`, and hand back the live root. */
function morph(before, after) {
    const from = window.document.createElement('div');
    from.innerHTML = before;
    const to = window.document.createElement('div');
    to.innerHTML = after;
    morphNode(from, to);
    return from;
}

// --- an unchanged picture is never touched -----------------------------
{
    const from = window.document.createElement('div');
    from.innerHTML = '<div data-item-id="axe"><img src="axe.webp"><span>Axe</span></div>';
    const image = from.querySelector('img');

    const to = window.document.createElement('div');
    to.innerHTML = '<div data-item-id="axe"><img src="axe.webp"><span>Axe (2)</span></div>';
    morphNode(from, to);

    assert.strictEqual(from.querySelector('img'), image, 'the same image element survives');
    assert.strictEqual(from.querySelector('span').textContent, 'Axe (2)', 'the text follows the render');
}
console.log('ok  an unchanged image is the same element afterwards');

// --- a removed row costs only that row ---------------------------------
{
    const from = window.document.createElement('div');
    from.innerHTML = '<p data-item-id="a">A</p><p data-item-id="b">B</p><p data-item-id="c">C</p>';
    const [a, , c] = Array.from(from.children);

    const to = window.document.createElement('div');
    to.innerHTML = '<p data-item-id="a">A</p><p data-item-id="c">C</p>';
    morphNode(from, to);

    assert.deepStrictEqual(Array.from(from.children), [a, c], 'the survivors are the very same nodes');
}
console.log('ok  a row leaving does not rebuild the rows under it');

// --- reordering moves nodes rather than remaking them ------------------
{
    const from = window.document.createElement('div');
    from.innerHTML = '<p data-item-id="a">A</p><p data-item-id="b">B</p>';
    const [a, b] = Array.from(from.children);

    const to = window.document.createElement('div');
    to.innerHTML = '<p data-item-id="b">B</p><p data-item-id="a">A</p>';
    morphNode(from, to);

    assert.deepStrictEqual(Array.from(from.children), [b, a], 'sorted, not rebuilt');
}
console.log('ok  a re-sort moves the rows it already has');

// --- new rows arrive ----------------------------------------------------
{
    const root_ = morph('<p data-item-id="a">A</p>', '<p data-item-id="a">A</p><p data-item-id="b">B</p>');
    assert.strictEqual(root_.children.length, 2);
    assert.strictEqual(root_.children[1].textContent, 'B');
}
console.log('ok  a row arriving is added');

// --- classes and attributes follow the render ---------------------------
{
    const root_ = morph(
        '<p data-item-id="a" class="row is-out" title="gone">A</p>',
        '<p data-item-id="a" class="row">A</p>'
    );
    assert.strictEqual(root_.children[0].className, 'row', 'a dropped class is dropped');
    assert.strictEqual(root_.children[0].hasAttribute('title'), false, 'a dropped attribute is dropped');
}
console.log('ok  attributes the render dropped are dropped');

// --- the binding flag is the exception ----------------------------------
//
// The node survived, so its listener did too. Taking the flag off because the new markup
// has no flag would bind a second listener on the next render, and a third on the one
// after that -- which is a click that fires four times and no clue why.
{
    const root_ = morph(
        '<div data-drop-inventory="a" data-merchant-bound="true">x</div>',
        '<div data-drop-inventory="a">x</div>'
    );
    assert.strictEqual(root_.children[0].dataset.merchantBound, 'true', 'the bound flag survives');
}
console.log('ok  a bound node stays marked as bound');

// --- a search box keeps what is being typed into it ---------------------
{
    const from = window.document.createElement('div');
    from.innerHTML = '<input type="search" data-shop-search>';
    from.querySelector('input').value = 'pot';

    const to = window.document.createElement('div');
    to.innerHTML = '<input type="search" data-shop-search>';
    morphNode(from, to);

    assert.strictEqual(from.querySelector('input').value, 'pot', 'a query is not a render artefact');
}
console.log('ok  an unowned text field keeps its live value');

// --- a field the template does own is synced ----------------------------
{
    const from = window.document.createElement('div');
    from.innerHTML = '<input type="text" value="1">';
    from.querySelector('input').value = '9';

    const to = window.document.createElement('div');
    to.innerHTML = '<input type="text" value="3">';
    morphNode(from, to);

    assert.strictEqual(from.querySelector('input').value, '3', 'a rendered value wins');
}
console.log('ok  a field the render owns takes the rendered value');

// --- the delivery note is a textarea, and its value is its children -----
{
    const from = window.document.createElement('div');
    from.innerHTML = '<textarea data-delivery-instructions>leave it</textarea>';
    const to = window.document.createElement('div');
    to.innerHTML = '<textarea data-delivery-instructions>leave it by the well</textarea>';
    morphNode(from, to);

    assert.strictEqual(from.querySelector('textarea').value, 'leave it by the well');
}
console.log('ok  a textarea takes its value, not just its markup');

// --- a select lands on the rendered option ------------------------------
{
    const from = window.document.createElement('div');
    from.innerHTML = '<select><option value="ground">Ground</option><option value="beast" selected>Beast</option></select>';
    const to = window.document.createElement('div');
    to.innerHTML = '<select><option value="ground" selected>Ground</option><option value="beast">Beast</option></select>';
    morphNode(from, to);

    assert.strictEqual(from.querySelector('select').value, 'ground');
}
console.log('ok  a select follows the render');

// --- structure, not just leaves -----------------------------------------
{
    const root_ = morph(
        '<section><h3>Shelf</h3><div class="body"><p data-item-id="a">A</p></div></section>',
        '<section><h3>Catalogue</h3><div class="body"><p data-item-id="a">A</p><p data-item-id="b">B</p></div></section>'
    );
    assert.strictEqual(root_.querySelector('h3').textContent, 'Catalogue');
    assert.strictEqual(root_.querySelectorAll('.body > p').length, 2);
}
console.log('ok  the morph goes all the way down');

// --- and the result is simply the new markup ----------------------------
//
// The point of the whole exercise is that a reader never has to wonder whether a patched
// page is the page: whatever the render says, that is what is standing afterwards.
{
    const before = '<div class="a"><img src="1.webp"><p data-item-id="x">x</p></div><span>tail</span>';
    const after = '<div class="b"><img src="2.webp"><p data-item-id="y">y</p></div>';
    const root_ = morph(before, after);
    assert.strictEqual(root_.innerHTML, after, 'a morphed tree is indistinguishable from a rendered one');
}
console.log('ok  a patched page equals the page it was patched to');

console.log('\nall morph checks passed');
