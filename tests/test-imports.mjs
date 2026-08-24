// Catch the one mistake a module can make that looks like nothing until the moment
// it runs: **calling a function that was never imported.**
//
// It cost a shop that would not open. `_refreshReputation` called `reputationLabel`,
// which lived in `utility-reputation.js` and was never named in the import at the top
// of `window-shop.js`. Every file parsed, every test passed, and the window threw a
// ReferenceError on its first render — which `openSafely` turned into "Could not open
// that shop", a message that says nothing about the cause.
//
// The same scan reports the reverse — imported and never used — because a name that
// no longer belongs in an import is a rename half-finished.
//
// **This is a heuristic, not a type checker.** It looks at bare `name(` calls only:
// nothing dotted, nothing dynamic. That is deliberate — it under-reports rather than
// crying wolf, and the class of bug it does catch is one nothing else here would.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPTS = 'scripts';

/** Anything the browser, Foundry, or the language itself provides. */
const AMBIENT = new Set([
    // Language
    'Array', 'Boolean', 'Date', 'Error', 'JSON', 'Map', 'Math', 'Number', 'Object',
    'Promise', 'Set', 'String', 'Symbol', 'WeakMap', 'BigInt', 'RegExp', 'Proxy',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'structuredClone', 'encodeURIComponent',
    'decodeURIComponent', 'queueMicrotask', 'require', 'fetch',
    // Browser
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
    'cancelAnimationFrame', 'CustomEvent', 'Event', 'Image', 'FormData', 'URL', 'Blob',
    'getComputedStyle', 'alert', 'confirm', 'prompt',
    // Foundry
    'game', 'ui', 'canvas', 'foundry', 'CONFIG', 'CONST', 'Hooks', 'Roll', 'Dialog',
    'Handlebars', 'fromUuid', 'fromUuidSync', 'renderTemplate', 'loadTemplates',
    'getProperty', 'setProperty', 'mergeObject', 'duplicate', 'randomID', 'console',
    'document', 'window', 'globalThis', 'localStorage', 'FilePicker', 'TextEditor',
    'Actor', 'Item', 'Scene', 'User', 'Token', 'ChatMessage', 'Folder', 'RollTable'
]);

/** Names a file brings in with `import { a, b } from '...'` or `import X from`. */
function importedNames(source) {
    const names = new Set();
    const re = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|([\w$]+)|\*\s+as\s+([\w$]+))\s+from/g;
    let m;
    while ((m = re.exec(source))) {
        for (const single of [m[1], m[3], m[4]]) if (single) names.add(single);
        if (m[2]) {
            for (const part of m[2].split(',')) {
                const name = part.trim().split(/\s+as\s+/).pop().trim();
                if (name) names.add(name);
            }
        }
    }
    return names;
}

/** Anything declared in the file itself, at any depth. */
function declaredNames(source) {
    const names = new Set();
    const patterns = [
        /\bfunction\s+([\w$]+)/g,
        /\bclass\s+([\w$]+)/g,
        /\b(?:const|let|var)\s+([\w$]+)\s*=/g,
        // Destructured bindings: `const { a, b } = ...`
        /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
        // Parameters are close enough to catch arrow/function args by name.
        /\(([^()]*)\)\s*=>/g,
        /\bfunction\s*[\w$]*\s*\(([^()]*)\)/g,
        // A method's own name, and separately its parameters — `run(operation) {`
        // declares both, and missing the second reported the parameter as undefined.
        /\b([\w$]+)\s*\([^()]*\)\s*\{/g,
        /\b[\w$]+\s*\(([^()]*)\)\s*\{/g,
        /\bcatch\s*\(\s*([\w$]+)\s*\)/g
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(source))) {
            for (const part of String(m[1] ?? '').split(',')) {
                const name = part.trim().split(/[:=]/)[0].replace(/^\.\.\./, '').trim();
                if (/^[\w$]+$/.test(name)) names.add(name);
            }
        }
    }
    return names;
}

/** Bare `name(` calls: not `.name(`, not `new name(`, not a declaration. */
function calledNames(source) {
    // Strings and comments removed first, or a call inside a comment counts.
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');

    const names = new Set();
    const re = /(^|[^\w$.?])([a-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(code))) names.add(m[2]);
    return names;
}

const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
    'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'case', 'super', 'import',
    'yield', 'instanceof', 'throw', 'with',
    // `async (payload) => {}` reads as a call to something named `async` unless it is
    // named here. Same for the accessor keywords before a method's parentheses.
    'async', 'get', 'set', 'static'
]);

const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.js')).sort();
assert.ok(files.length, 'there are scripts to check');

const undefinedCalls = [];
const unusedImports = [];

for (const file of files) {
    const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    const imported = importedNames(source);
    const declared = declaredNames(source);
    const called = calledNames(source);

    for (const name of called) {
        if (KEYWORDS.has(name) || AMBIENT.has(name)) continue;
        if (imported.has(name) || declared.has(name)) continue;
        undefinedCalls.push(`${file}: ${name}()`);
    }

    // Used at all, anywhere — not only as a call, since a class can be extended and a
    // constant merely read.
    const body = source.replace(/^import[\s\S]*?from\s*'[^']*';?$/gm, '');
    for (const name of imported) {
        if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(body)) {
            unusedImports.push(`${file}: ${name}`);
        }
    }
}

if (undefinedCalls.length) {
    console.error('\nCalled but never imported or declared:');
    for (const entry of undefinedCalls) console.error('  ' + entry);
}
assert.strictEqual(undefinedCalls.length, 0, 'every function called is imported or declared');
console.log(`ok  every call in ${files.length} scripts resolves to an import or a declaration`);

if (unusedImports.length) {
    console.error('\nImported but never used:');
    for (const entry of unusedImports) console.error('  ' + entry);
}
assert.strictEqual(unusedImports.length, 0, 'no imports are left behind by a rename');
console.log('ok  no unused imports');

// ---------------------------------------------------------------- orphaned docs
// **A doc comment must describe something.** Two of them in a row means an insertion
// landed between a comment and the thing it documented, so the first one now describes
// whatever happened to follow — and reads as an explanation of the wrong function.
//
// This is cheap to check and easy to cause: it happened six times across one afternoon
// of edits, and every instance was silently wrong prose rather than a broken build.
// Comments are most of how this codebase explains itself, so a comment attached to the
// wrong thing is worse than none — it is confidently misleading.
const orphaned = [];
for (const file of files) {
    const lines = fs.readFileSync(path.join(SCRIPTS, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
        if (!/\*\/\s*$/.test(line)) return;
        const next = (lines[index + 1] ?? '').trim();
        if (next.startsWith('/**') || next.startsWith('/*')) {
            orphaned.push(`${file}:${index + 2}  ${next.slice(0, 60)}`);
        }
    });
}
if (orphaned.length) {
    console.error('doc comments with another comment where their subject should be:');
    for (const entry of orphaned) console.error('  ' + entry);
}
assert.strictEqual(orphaned.length, 0, 'every doc comment describes the thing beneath it');
console.log(`ok  ${files.length} files, no doc comment left describing the wrong thing`);

console.log('\nall import checks passed');
