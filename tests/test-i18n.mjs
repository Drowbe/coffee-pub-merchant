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
const DYNAMIC = [
    // `inventoryTypeName` / `inventoryTypeHint` in const.js. Assembled rather than
    // written out because the table of types is the thing that decides which exist, and
    // a second hand-maintained list of six keys would be a second place to forget one.
    'coffee-pub-merchant.inventoryType.',
    // `depthLabel` / `depthHint`, same reasoning against STOCK_DEPTH_OPTIONS.
    'coffee-pub-merchant.depth.',
    // `methodLabel` in window-merchant-config.js. The four restock methods are a closed
    // set defined by `METHOD`, so the mapping lives next to it rather than being a
    // second list to keep in step.
    'coffee-pub-merchant.method.'
];

const files = [...list('scripts/', '.js'), ...list('templates/', '.hbs')];

// ---------------------------------------------------------------- keys in use
const used = new Map();   // key -> [files]
const patterns = [
    // game.i18n.localize('key') / .format('key', {...})
    /\bi18n\s*\.\s*(?:localize|format)\s*\(\s*(['"])([^'"]+)\1/g,
    // {{localize "key"}} and {{#if (localize "key")}} alike
    /\{\{[^}]*?\blocalize\s+(['"])([^'"]+)\1/g,
    // A bare literal that *is* a fully-qualified key — `nameKey: '…'`, `labelKey: '…'`.
    // Tables that would once have held translated text now hold the key instead, because
    // resolving it where the table is declared runs before `game` exists (see check 6).
    // The key is genuinely in use; it is simply read one step later.
    new RegExp(`(['"])(${MODULE}\\.[A-Za-z0-9_.]+)\\1`, 'g')
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

// ---------------------------------------------------------------- 6. never at load
// **`game` does not exist while Foundry is evaluating a module script.** A `game.i18n`
// call that runs at evaluation throws `Cannot read properties of undefined`, and ESM
// caches a failed evaluation — so the throw does not retry, it kills the module for the
// whole session. This module has now been taken down that way twice: once resolving a
// base class from `module.api`, and once by a `const METHOD_LABELS = { ... }` holding
// already-translated strings.
//
// The rule is simple and this check enforces it: **anything that reads `game` lives
// inside a function.** A table holds keys; the text is resolved when it is shown.
//
// Walks a real scope stack rather than matching indentation, because the two cases that
// bit were a top-level object literal and a `static` class field — both of which look
// like ordinary indented code.
function stripLiterals(source) {
    // Replace string, template and comment bodies with spaces so their braces and
    // parentheses cannot move the scope stack. Length is preserved so line numbers hold.
    let out = '';
    let i = 0;
    const blank = (n) => ' '.repeat(n);
    while (i < source.length) {
        const two = source.slice(i, i + 2);
        if (two === '//') {
            const end = source.indexOf('\n', i);
            const stop = end === -1 ? source.length : end;
            out += blank(stop - i);
            i = stop;
        } else if (two === '/*') {
            const end = source.indexOf('*/', i + 2);
            const stop = end === -1 ? source.length : end + 2;
            out += source.slice(i, stop).replace(/[^\n]/g, ' ');
            i = stop;
        } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
            const quote = source[i];
            let j = i + 1;
            while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
            out += quote + source.slice(i + 1, j).replace(/[^\n]/g, ' ') + (source[j] ?? '');
            i = j + 1;
        } else {
            out += source[i];
            i += 1;
        }
    }
    return out;
}

const atLoad = [];
for (const file of files.filter((f) => f.endsWith('.js'))) {
    const source = read(file);
    const code = stripLiterals(source);
    const stack = [];   // true for a function body, false for anything else
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') {
            // A function body is a `{` whose nearest non-space predecessor closes a
            // parameter list or an arrow. Everything else — object literals, class
            // bodies, static fields — is evaluated when the module is.
            const before = code.slice(0, i).replace(/\s+$/, '');
            stack.push(before.endsWith(')') || before.endsWith('=>'));
        } else if (ch === '}') {
            stack.pop();
        } else if (code.startsWith('game.', i) && !stack.some(Boolean)) {
            const line = source.slice(0, i).split('\n').length;
            atLoad.push(`${file}:${line}  ${source.split('\n')[line - 1].trim().slice(0, 70)}`);
            i += 4;
        }
    }
}
assert.deepStrictEqual(atLoad, [],
    'these read `game` while the module is being evaluated, before it exists:\n  ' + atLoad.join('\n  '));
console.log('ok  nothing reads `game` at module evaluation');

console.log('\nall i18n checks passed');
