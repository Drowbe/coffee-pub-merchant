# Logic checks

```
node tests/test-pricing.mjs
node tests/test-stock.mjs

npm install --no-save jsdom handlebars   # once, for the third
node tests/test-search.mjs
```

No test runner and no build step — plain Node and `node:assert`. The first two have no dependencies at all;
they stub the handful of Foundry globals the modules under test actually touch
(`CONFIG.DND5E.currencies`, `game.time.calendar`) and run the real code. The third needs jsdom and
handlebars, and **skips with a message rather than failing** when they are absent, so it is safe to run the
lot without setting anything up. Neither is a module dependency; `--no-save` keeps them out of the manifest
and `node_modules/` is already ignored.

## What these are for

**Not** a substitute for opening Foundry. These cannot catch a wrong document path, a template field that
does not exist, a hook that never fires, or a permission check on the wrong user — which is most of what
can go wrong in a Foundry module, and all of which needs a table.

What they cover is the part that is pure arithmetic and pure control flow, where reading the code is a bad
way to find a bug and where a wrong answer is silent:

- **`test-pricing.mjs`** — denominations, purse value, formatting, and making change. The exhaustive sweep
  runs every combination of a small purse against seven prices and asserts that coins paid minus change
  returned equals the price exactly, and that no plan ever spends a coin the buyer does not hold. Making
  change is Merchant's permanently — `api.inventory` does not convert denominations — so nobody else is
  going to catch this being wrong.
- **`test-search.mjs`** — the shop search, run against **the real templates**. It compiles
  `window-shop.hbs` and `partial-shop-row.hbs`, renders a shop with three shelves, and calls the actual
  `filterShopList`. That makes it the only check here that would catch a selector no longer matching the
  markup — which is the way this particular feature breaks, and which reads as a search that quietly returns
  too little rather than as an error.
- **`test-cards.mjs`** — the printed page, and the promise that there is never a hole in one. The
  checks render a page back into a three-by-four grid of characters and assert there is no `.` in it,
  which is the only way to state a geometric property: the arithmetic version of this test passed
  happily while pages were ending ragged, because twelve cells of goods and a full page are not the
  same claim. Also that the goods stay in the order they were printed in, that nothing is dropped or
  printed twice, and that the spans the layout reasons about are the spans the stylesheet draws.
- **`test-profiles.mjs`** — the shipped shop profiles, and the arithmetic of applying one. Two kinds of
  check: that `missingShelves` matches the way a person would (case-insensitively, by name rather than by
  type, so applying twice cannot leave "Buy Back" beside "buy back"), and that the shipped profile is
  valid against the shapes the rest of the module reads — an unknown shelf type or a rarity token nothing
  recognises produces a shelf that draws nothing and says nothing about why. It also asserts the two
  design rules in code: no profile carries items, and none carries a portrait.
- **`test-mail.mjs`** — how many crates an order needs, which is arithmetic the party are charged for.
  `packCrates` runs three times on the same goods — pricing the slate, taking the money, filling the
  boxes — so the property that matters is that it is deterministic and loses nothing: a stack split
  across crates still adds up, and a statue heavier than a crate travels rather than vanishing.
- **`test-morph.mjs`** — the shop window patching its rendered page instead of replacing it. Most of the
  assertions are on **node identity**, not on markup: that the same `<img>` object is still in the tree
  after a render, that a row leaving does not rebuild the rows under it, that a bound node keeps the flag
  saying a listener is on it. A morph producing correct HTML proves nothing — `replaceWith` produces correct
  HTML too, and that is the thing being replaced. The last case asserts the boring half as well: whatever the
  render says is what is standing afterwards.
- **`test-stock.mjs`** — calendar arithmetic, policy inheritance, the restock cadence, par resolution, and
  the lock. The lock cases are the point: two buyers racing for the last item, a queue surviving a callback
  that throws, and the key being released rather than leaking. Finite stock reintroduced a race that
  infinite stock did not have, and a broken lock looks exactly like a working one until two people click at
  once.

## Keeping them honest

`test-stock.mjs` re-implements policy resolution and the restock cadence rather than importing them, because
they are methods on a class that needs a live Foundry to construct. **That is a copy, and copies drift.** If
either changes in `manager-merchant.js`, change it here too — or better, if these grow, move the pure
functions out of the class so the test can import the real ones.

`test-pricing.mjs` has no such problem: it imports `utility-pricing.js` directly and runs the real code.

`test-actions.mjs` needs nothing at all and catches the quietest bug class here: a
button whose `data-action` no handler answers. That fails by doing nothing — no throw,
no log, no syntax error — so it is invisible to every other check and to `node --check`.

## A trap worth knowing about

`test-search.mjs` needs `jsdom` and `handlebars` because it renders the real templates. When they are
absent it prints `skipped` and **exits 0**. That is deliberate — the other two suites should not be blocked
by an optional dependency — but it means a fresh clone reports success while checking nothing.

    npm install --no-save jsdom handlebars

The release workflow installs them for the same reason: a skipped test counted as a pass is the one outcome
worth twenty seconds to avoid.

**`test-imports.mjs`** — the one mistake a module can make that looks like nothing until it runs: calling a
function that was never imported. It cost a shop that would not open — `_refreshReputation` called
`reputationLabel`, which existed, was exported, and was simply not named in the import at the top of
`window-shop.js`. Every file parsed and every other test passed; the window threw a `ReferenceError` on its
first render, which `openSafely` turned into "Could not open that shop" — a message that says nothing about
the cause. It reports unused imports too, since a name left behind in an import is a rename half-finished.

A heuristic, not a type checker: it looks at bare `name(` calls only, nothing dotted and nothing dynamic. It
under-reports on purpose, because a checker that cries wolf gets switched off.
