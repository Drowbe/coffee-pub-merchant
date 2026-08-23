// Every key that is asked for exists, and every key that exists is asked for.
//
// **The point of this file is that a localisation pass is otherwise unverifiable.**
// Nearly three hundred strings moved out of the code and into `lang/en.json`; a typo in
// a key is not a crash, it is a window that renders the key itself — "coffee-pub-
// merchant.shop.buy" sitting where the word "Buy" used to be. That is the kind of
// mistake that ships, because it looks like text and only reads wrong.
//
// Two directions, and both matter:
//
// - **Asked for but missing** is the broken window above.
// - **Present but never asked for** is dead weight that a translator will still
//   faithfully translate, and the next person to read `en.json` will believe is live.
//
// Scans source rather than running Foundry, so it catches the static cases only. A key
// built at runtime -- `\`shop.\${kind}\`` -- is invisible here and is exactly why the
// convention is to write keys as literals. There is one deliberate exception, declared
// in DYNAMIC below.

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const MODULE = 'coffee-pub-merchant';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const list = (dir, ext) => readdirSync(new URL(dir, root)).filter((f) => f.endsWith(ext)).map((f) => dir + f);

// Keys assembled at runtime, declared here with the prefix they are built from. A key
// in `en.json` under one of these prefixes counts as used.
const DYNAMIC = [];

const files = [...list('scripts/', '.js'), ...list('templates/', '.hbs')];

// ---------------------------------------------------------------- keys in use
const used = new Map();   // key -> [files]
const patterns = [
    // game.i18n.localize('key') / .format('key', {...})
    /\bi18n\s*\.\s*(?:localize|format)\s*\(\s*(['"])([^'"]+)\1/g,
    // {{localize "key"}} and {{#if (localize "key")}} alike
    /\{\{[^}]*?\blocalize\s+(['"])([^'"]+)\1/g
];

for (const file of files) {
    const source = read(file);
    for (const pattern of patterns) {
        for (const [, , key] of source.matchAll(pattern)) {
            if (!used.has(key)) used.set(key, []);
            used.get(key).push(file);
        }
    }
}

// ---------------------------------------------------------------- keys defined
const defined = new Set();
function walk(node, path) {
    for (const [name, value] of Object.entries(node)) {
        const next = path ? `${path}.${name}` : name;
        if (value && typeof value === 'object') walk(value, next);
        else defined.add(next);
    }
}
const lang = JSON.parse(read('lang/en.json'));
walk(lang, '');

// ---------------------------------------------------------------- 1. no missing keys
const missing = [...used.keys()].filter((key) => !defined.has(key));
assert.deepStrictEqual(missing, [],
    `these keys are asked for but not in lang/en.json:\n  ${missing.map((k) => `${k}  (${used.get(k).join(', ')})`).join('\n  ')}`);
console.log(`ok  ${used.size} keys asked for, all present`);

// ---------------------------------------------------------------- 2. no dead keys
const unused = [...defined].filter((key) => !used.has(key) && !DYNAMIC.some((p) => key.startsWith(p)));
assert.deepStrictEqual(unused, [],
    `these keys are in lang/en.json but nothing asks for them:\n  ${unused.join('\n  ')}`);
console.log(`ok  ${defined.size} keys defined, none dead`);

// ---------------------------------------------------------------- 3. one namespace
const stray = [...defined].filter((key) => !key.startsWith(`${MODULE}.`));
assert.deepStrictEqual(stray, [],
    `every key belongs under "${MODULE}." so two modules cannot collide:\n  ${stray.join('\n  ')}`);

// ---------------------------------------------------------------- 4. no empty values
const empty = [...defined].filter((key) => {
    const value = key.split('.').reduce((node, part) => node?.[part], lang);
    return typeof value !== 'string' || value.trim() === '';
});
assert.deepStrictEqual(empty, [], `these keys have no text:\n  ${empty.join('\n  ')}`);

// ---------------------------------------------------------------- 5. format params
// `{name}` in a string means the call has to be `format`, not `localize`. Getting this
// wrong renders the brace literally, which is the same class of failure as a missing
// key: visible, wrong, and not a crash.
const parameterised = [...defined].filter((key) => {
    const value = key.split('.').reduce((node, part) => node?.[part], lang);
    return /\{[A-Za-z_][\w]*\}/.test(value);
});
const wrongCall = [];
for (const key of parameterised) {
    for (const file of used.get(key) ?? []) {
        const source = read(file);
        const localizeOnly = new RegExp(`i18n\\s*\\.\\s*localize\\s*\\(\\s*['"]${key.replace(/\./g, '\\.')}['"]`);
        if (localizeOnly.test(source)) wrongCall.push(`${key} in ${file}`);
    }
}
assert.deepStrictEqual(wrongCall, [],
    `these take parameters and must be formatted, not localized:\n  ${wrongCall.join('\n  ')}`);
console.log('ok  parameterised keys are formatted, not localized');

console.log('\nall i18n checks passed');
