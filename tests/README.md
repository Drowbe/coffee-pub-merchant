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

**Not** a substitute for `../documentation/testing/testing-merchant.md`. These cannot catch a wrong document
path, a template field that does not exist, a hook that never fires, or a permission check on the wrong user
— which is most of what can go wrong in a Foundry module, and all of which needs a table.

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

`test-pricing.mjs` has no such problem: it imports `merchant-pricing.js` directly and runs the real code.

## A trap worth knowing about

`test-search.mjs` needs `jsdom` and `handlebars` because it renders the real templates. When they are
absent it prints `skipped` and **exits 0**. That is deliberate — the other two suites should not be blocked
by an optional dependency — but it means a fresh clone reports success while checking nothing.

    npm install --no-save jsdom handlebars

The release workflow installs them for the same reason: a skipped test counted as a pass is the one outcome
worth twenty seconds to avoid.
