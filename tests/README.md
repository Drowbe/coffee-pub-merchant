# Logic checks

```
node tests/test-pricing.mjs
node tests/test-stock.mjs
```

No dependencies, no test runner, no build step — plain Node and `node:assert`. They stub the handful of
Foundry globals the modules under test actually touch (`CONFIG.DND5E.currencies`, `game.time.calendar`) and
run the real code.

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
