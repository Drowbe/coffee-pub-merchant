# Plan — where a shop's stock comes from

**Status:** decided 2026-08-23, partly built. Delete this file when the query source lands.

---

## The decision

Three sources, and **roll tables stop being the one you reach for first**.

| Source | For | State |
|---|---|---|
| **Manual** | Specific, curated, characterful stock — a fence's shady goods, a signature blade | **Works today.** Drag it in, it takes a par, restock tops it up |
| **Query** | Broad coverage that maintains itself — a general store, a smith | **Not built.** Waiting on a filtered compendium query |
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

## What the query source needs

Asked of Blacksmith on 2026-08-23; they are building it.

```js
blacksmith.compendiums.query({
    type: 'item',
    subtypes: ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'],
    rarity: ['common', 'uncommon'],
    price: { min: 0, max: 10000 },   // base units
    sources: null,                    // default: the GM's configured search set
    limit: 200
})
```

**Why theirs and not ours.** `CompendiumsAPI` already owns which packs are searched and in what
order — `getChoices()`, the world-first/world-last ordering, the GM's source mapping. Filtering packs
here would mean either reimplementing that mapping or ignoring it and searching packs the GM
deliberately excluded.

**The part that decides the cost.** `pack.getIndex()` returns `name`, `type`, `img`, `uuid`
(`manager-compendiums.js:674`). **Neither `system.rarity` nor `system.price` is in a default index.**
`getIndex({ fields: [...] })` extends it and stays cheap — one cached pass per pack. Loading
documents instead is slow enough across an SRD-sized pack that a GM notices. The index-field set is a
per-pack cache, which is another reason it belongs in the hub: two consumers asking for different
field sets is cheap when one thing owns it.

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
