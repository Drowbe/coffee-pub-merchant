// Menus: reading a line of a roll table as a dish.
//
// Only the parser is pure. Stocking and serving need Foundry, so what is checked here is
// the part a GM types into a table and gets wrong in small ways: the price is found by its
// shape rather than its place, a description is never eaten as a price, and a line with no
// price is a dish anyway rather than a hole in the menu.
//
// No dependencies: `const.js` imports nothing and touches no Foundry global at load.
import assert from 'node:assert';
import { parseMenuLine, menuImage, MENU_DEFAULT_PRICE, INVENTORY_TYPES, isMenu, STOCK } from '../scripts/const.js';

// --- a full line -----------------------------------------------------------
{
    const dish = parseMenuLine('Ale | 4 cp | A pint of the house brown');
    assert.strictEqual(dish.name, 'Ale');
    assert.deepStrictEqual(dish.price, { value: 4, denomination: 'cp' });
    assert.strictEqual(dish.description, 'A pint of the house brown');
}
console.log('ok  name, price and description are read in order');

// --- the price is recognised by shape, not by place ------------------------
{
    const dish = parseMenuLine('Stew | Thick, with barley | 2 sp');
    assert.deepStrictEqual(dish.price, { value: 2, denomination: 'sp' }, 'a price in the third place is still a price');
    assert.strictEqual(dish.description, 'Thick, with barley');

    const plain = parseMenuLine('Bread | Still warm');
    assert.deepStrictEqual(plain.price, MENU_DEFAULT_PRICE, 'a description is not swallowed as a price');
    assert.strictEqual(plain.description, 'Still warm');

    assert.deepStrictEqual(parseMenuLine('Wine | 1.5 gp').price, { value: 1.5, denomination: 'gp' });
    assert.deepStrictEqual(parseMenuLine('Wine | 3 GP').price, { value: 3, denomination: 'gp' }, 'case is not significant');
}
console.log('ok  a price is found by its shape');

// --- a bare name is a dish -------------------------------------------------
{
    const dish = parseMenuLine('Porridge');
    assert.strictEqual(dish.name, 'Porridge');
    assert.deepStrictEqual(dish.price, MENU_DEFAULT_PRICE);
    assert.strictEqual(dish.description, '');
    assert.notStrictEqual(dish.price, MENU_DEFAULT_PRICE, 'the default is copied, never shared');
}
console.log('ok  a line with only a name is a dish at the default price');

// --- nothing readable is no dish --------------------------------------------
{
    assert.strictEqual(parseMenuLine(''), null);
    assert.strictEqual(parseMenuLine(undefined), null);
    assert.strictEqual(parseMenuLine('   '), null);
    assert.strictEqual(parseMenuLine(' | 4 cp'), null, 'a price with no dish is not one');
}
console.log('ok  an empty or nameless line is null');

// --- a table's text may carry markup, which is not kept --------------------
{
    const dish = parseMenuLine('<p><strong>Mead</strong> | 5 cp | <em>Sweet</em></p>');
    assert.strictEqual(dish.name, 'Mead');
    assert.strictEqual(dish.description, 'Sweet');
}
console.log('ok  tags are stripped');

// --- the shelf type ----------------------------------------------------------
{
    const menu = INVENTORY_TYPES.menu;
    assert.ok(menu, 'the menu is a shelf type');
    assert.strictEqual(menu.defaults.stock, STOCK.INFINITE, 'a kitchen does not run out');
    assert.strictEqual(menu.defaults.source, 'table', 'a menu is always a table');
    assert.ok(isMenu('menu') && !isMenu('general'));
}
console.log('ok  the menu shelf is infinite and table-fed');

console.log('\nall menu checks passed');
