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

console.log('\nall action checks passed');
