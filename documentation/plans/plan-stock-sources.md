# Plan — where a shop's stock comes from

**Status:** decided 2026-08-23. `compendiums.query` is built and on Blacksmith master; the Merchant
side is not written and is pinned to whatever release ships it. Delete this file when it lands.

---

## The decision

Three sources, and **roll tables stop being the one you reach for first**.

| Source | For | State |
|---|---|---|
| **Manual** | Specific, curated, characterful stock — a fence's shady goods, a signature blade | **Works today.** Drag it in, it takes a par, restock tops it up |
| **Query** | Broad coverage that maintains itself — a general store, a smith | **Blacksmith side built.** Merchant side waits for a tagged release |
| **Table** | Worlds that already have them, and genuinely weighted draws | **Works today.** Kept, not deprecated, not the default |

## Why tables stopped being the default

**A table stores references, so it is a snapshot, and snapshots rot.** Rename a pack, update a
content module, uninstall one, and rows point at nothing. A compendium query resolves against what
exists at the moment it runs and cannot dangle — and it picks up new content instead of freezing at
whatever somebody typed in last year.

That rot was also **invisible** until 2026-08-23. `fromUuid` returned null, `_withinLimits` dropped
the entry, and nothing counted it: a GM asked for twenty draws, got fourteen, and was told nothing.
The shop looked stocked and the restock reported success. Now a dead row is reported by name of the
table that still lists it — which is the fix for the symptom, not for the cause.

**The curation argument fell over on its own.** Tables were defended here on the grounds that no
filter expresses "shady". True, and irrelevant: a shady inventory is better hand-stocked, and manual
stocking already does everything a curated table did without the layer that rots. What survives is
weighting — a table can make torches common and a spyglass rare — and the type, rarity and price
ceilings already approximate that well enough that it is not load-bearing.

**So the change removes a mechanism rather than adding one.** That is the whole reason to prefer it.

## What the query source needs — **built, 2026-08-23**

```js
const rows = await blacksmith.compendiums.query({
    type: 'Item',
    subtypes: ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'],
    rarity: ['mundane', 'common', 'uncommon'],
    priceGp: { min: 1, max: 500 },
    includeUnpriced: false,
    sources: null,          // default: the GM's configured search set
    limit: 200
});
```

Rows are `search()`'s shape plus `rarity`, `price` and `priceGp`. `queryDetailed()` mirrors
`searchDetailed()`; `normalizeRarity()` and `toGp()` are exposed so consumers don't each write the
conversion.

### Three corrections to our proposal, all of which we needed

**1. `limit` caps the output; the scan is always complete.** Ours inherited `search()`'s *stop-scan*
limit, which would have drawn every shop's stock from the first configured pack and never opened
the sixth — producing a result set indistinguishable from a correct one. **The one we could not have
caught in testing.** `queryDetailed().scannedSources` covers the whole order.

**2. Rarity needs the `mundane` token.** `system.rarity` is *blank* on non-magical gear, not
`'common'` — `common` means a common *magic* item. Our example `['common', 'uncommon']` would have
returned magic items only, with every plain longsword, rope and torch silently absent behind a
plausible result.

> **This one was already live here.** `stockDepth` read `item.system.rarity || 'common'` and
> `STOCK_RARITY_CAPS` had no `mundane` row. Harmless while `common` was 0, and a trap the moment
> anybody set it: capping common magic items at two would have capped every torch at two as well.
> Fixed 2026-08-23, with the two rows asserted apart so the check cannot pass by their agreeing.

**3. Price is `priceGp`, not base units.** dnd5e stores a denomination and 50 sp is 5 gp, so a raw
compare is wrong for anything not priced in gold. Also: **unpriced and free share a stored value**
(`0`) and cannot be told apart at the index, so they are excluded from a range by default — which
is why `{ min: 0 }` does not flood the result. Merchant tells the two apart on an *item* it owns
(`FREE_FLAG`), but that flag does not exist in a compendium.

### One constraint

An entry whose type has no rarity or price field — a spell, a class — **fails** a filter on it rather
than passing unfiltered. A price range plus a non-physical type returns nothing, deliberately.

### On the index question

Index fields, not document loads, and cheaper than we thought — but **worse than we thought to leave
with consumers**: `getIndex({fields})` re-fetches a pack's *entire* index for every distinct field
set, so uncoordinated consumers don't conflict, they each add a full re-fetch. Fixed constant in the
hub: one extra index fetch per configured pack, once per session, on the first call needing economics.

### Adoption is pinned, not immediate

On master, **not in a tagged release**. `module.json` requires Blacksmith `13.19.0`; adoption waits
for the version this ships in and raises that minimum. Feature-detect regardless, the way
`hasExchange` and `hasSetCurrency` already do — a shop must not break because a hub is a version behind.

## Where it plugs in

The filters are **the same three axes the stocking rules already use** — type, rarity, price. Today
they cap how deep a row stacks (`stockDepth`); a query would use them to decide what the shelf
carries at all. That symmetry is the argument that this is one idea rather than two.

An inventory's stock source becomes table *or* query; `maxProducts` stays the target either way, and
`restockInventory` keeps refilling to par first and drawing new products second. **No change to what
a restock means.**

## Not doing

- **Deleting table support.** Existing worlds have tables and will for a long time.
- **A local filtered query as a bridge.** Considered, and the `gm-request.js` precedent says a
  clearly-labelled bridge is acceptable when it is marked for deletion from the day it is written.
  Rejected here because that one closed a seam nobody else could close, where this is a feature
  Blacksmith is actively building — a bridge would likely become a rewrite rather than a deletion.
