// The printed page: where every tile goes, and that nothing is left empty.
//
// **The promise being tested is geometric, not arithmetic.** The version this replaces
// counted cells — twelve to a page — and that is not the same thing as a page being full:
// twelve cells of goods can leave a two-by-two hole that no remaining tile fits, which is
// exactly how pages came to end ragged with the advertising bunched on the last one.
//
// So the layout places every tile itself and reports what is still free, and these checks
// render the result back into a grid and look at it. A page with a `.` in it is a bug.
//
// No dependencies: `const.js` imports nothing and touches no Foundry global at load.
import assert from 'node:assert';
import {
    paginateCards, layoutTiles, layoutWall, fillWithAds,
    CARD_SPANS, AD_SPANS, PAGE_COLUMNS, PAGE_ROWS, CATALOGUE_FILLERS
} from '../scripts/const.js';

const items = (n, size) => Array.from({ length: n }, (_, i) => ({ kind: 'item', size, id: `${size}${i}` }));

/** A page, drawn: `#` a thing for sale, `A` the shop's own copy, `.` a hole. */
function render(page, rows = PAGE_ROWS) {
    const grid = Array.from({ length: rows }, () => new Array(PAGE_COLUMNS).fill('.'));
    for (const tile of page) {
        for (let y = 0; y < tile.h; y++) {
            for (let x = 0; x < tile.w; x++) {
                const mark = tile.kind === 'filler' ? 'A' : '#';
                assert.strictEqual(grid[tile.row - 1 + y][tile.col - 1 + x], '.', 'tiles never overlap');
                grid[tile.row - 1 + y][tile.col - 1 + x] = mark;
            }
        }
    }
    return grid.map((row) => row.join('')).join('\n');
}

const holes = (page, rows) => render(page, rows).split('').filter((c) => c === '.').length;

// --- nothing prints nothing ---------------------------------------------
{
    assert.deepStrictEqual(paginateCards([]), []);
    assert.deepStrictEqual(layoutWall([]), []);
}
console.log('ok  an empty shelf prints nothing at all');

// --- no page ever has a hole in it --------------------------------------
//
// The whole point. Run every mixture that has ever looked wrong on screen and assert the
// same thing about all of them.
{
    const mixtures = [
        items(1, 'small'),
        items(12, 'small'),
        items(13, 'small'),
        items(3, 'large'),
        items(4, 'large'),
        items(6, 'medium'),
        [...items(5, 'small'), ...items(2, 'large'), ...items(4, 'small')],
        [...items(2, 'large'), ...items(1, 'medium'), ...items(7, 'small')],
        Array.from({ length: 30 }, (_, i) => ({ kind: 'item', id: `x${i}`, size: ['small', 'medium', 'large'][i % 3] }))
    ];

    for (const [n, goods] of mixtures.entries()) {
        for (const [p, page] of paginateCards(goods).entries()) {
            assert.strictEqual(holes(page), 0, `mixture ${n}, page ${p + 1} has a hole:\n${render(page)}`);
        }
    }
}
console.log('ok  every page of every mixture is completely full');

// --- and every page says something --------------------------------------
//
// A page that filled exactly hands its last tile to the next page rather than printing no
// advertisement at all: the shop's voice appears on every page or it is not a catalogue.
{
    for (const goods of [items(12, 'small'), items(3, 'large'), items(6, 'medium'), items(40, 'small')]) {
        for (const page of paginateCards(goods)) {
            assert.ok(page.some((entry) => entry.kind === 'filler'), 'every page carries a notice');
        }
    }
}
console.log('ok  every page carries at least one advertisement');

// --- nothing is dropped, and nothing is printed twice --------------------
{
    const source = items(9, 'medium');
    const dealt = paginateCards(source).flat().filter((entry) => entry.kind !== 'filler');
    assert.strictEqual(dealt.length, source.length);
    assert.strictEqual(new Set(dealt.map((entry) => entry.id)).size, source.length);
}
console.log('ok  every tile is printed exactly once');

// --- goods keep their order ----------------------------------------------
//
// A catalogue is printed in order, so a reader turning to page three expects what came
// after page two. Backfilling a hole with a *later* tile would be the one liberty that
// looks like a bug from the reader's side.
{
    const goods = [...items(2, 'large'), ...items(9, 'small')];
    const order = paginateCards(goods).flat().filter((e) => e.kind !== 'filler').map((e) => e.id);
    assert.deepStrictEqual(order, goods.map((e) => e.id));
}
console.log('ok  the goods stay in the order they were printed in');

// --- the advertising cycles ----------------------------------------------
{
    const printed = paginateCards(items(40, 'small'))
        .flatMap((page) => page.filter((e) => e.kind === 'filler'))
        .map((e) => e.title);
    assert.ok(printed.length > 1);
    assert.notStrictEqual(printed[0], printed[1], 'two gaps do not print the same copy');
    assert.ok(CATALOGUE_FILLERS.every((f) => f.title && f.body), 'every notice says something');
}
console.log('ok  advertising cycles rather than repeating');

// --- a notice takes the biggest shape its hole allows ---------------------
//
// Otherwise a two-by-two gap becomes four little boxes, which is what a wall of goods
// with a corner missing should never look like.
{
    // One large tile leaves the whole right-hand column and the bottom two rows.
    const page = paginateCards(items(1, 'large'))[0];
    const ad = page.find((e) => e.kind === 'filler');
    assert.ok(ad.w > 1 || ad.h > 1, `a big hole should take a big notice, got ${ad.w}x${ad.h}`);
    assert.strictEqual(holes(page), 0);
}
console.log('ok  a big hole takes a big notice');

// --- a wall has no pages, and no ragged last row --------------------------
{
    const wall = layoutWall([...items(4, 'small'), ...items(1, 'large')]);
    const rows = Math.max(...wall.map((t) => t.row + t.h - 1));
    assert.strictEqual(holes(wall, rows), 0, `a wall should end square:\n${render(wall, rows)}`);
    assert.strictEqual(wall.filter((e) => e.kind !== 'filler').length, 5, 'and lose nothing');
}
console.log('ok  a wall fills its last row rather than ending ragged');

// --- the layout is what the stylesheet draws ------------------------------
//
// The spans live in one place and are used twice — once to place a tile here, once to size
// it in CSS. If these drift, the page is planned as one shape and drawn as another.
{
    assert.deepStrictEqual(CARD_SPANS.small, { w: 1, h: 1 });
    assert.deepStrictEqual(CARD_SPANS.medium, { w: 1, h: 2 });
    assert.deepStrictEqual(CARD_SPANS.large, { w: 2, h: 2 });
    assert.strictEqual(AD_SPANS.at(-1).w, 1, 'the last resort fits any single cell');
    assert.strictEqual(AD_SPANS.at(-1).h, 1);
    assert.ok(AD_SPANS.every((s) => s.w <= PAGE_COLUMNS && s.h <= PAGE_ROWS), 'no notice is bigger than a page');
}
console.log('ok  the shapes the layout uses are the shapes the grid draws');

// --- a page too full to place anything does not loop for ever -------------
//
// It cannot happen with the shapes above, and a future shape wider than the grid would —
// looping for ever is the worst possible way to find that out.
{
    const oversized = [{ kind: 'item', size: 'enormous', id: 'x' }];
    const pages = paginateCards(oversized);
    assert.ok(Array.isArray(pages), 'an unknown size is treated as one cell rather than hanging');
    assert.strictEqual(pages.flat().filter((e) => e.kind !== 'filler').length, 1);
}
console.log('ok  an unknown tile size is placed rather than hung on');

// --- the free list and the fill agree ------------------------------------
{
    const layout = layoutTiles(items(5, 'small'), { rows: PAGE_ROWS });
    const before = layout.free.length;
    const { ads, used } = fillWithAds(layout);
    assert.ok(used > 0 && used <= before);
    assert.strictEqual(holes([...layout.placed, ...ads]), 0);
}
console.log('ok  what the layout reports free is exactly what gets filled');

console.log('\nall card layout checks passed');
