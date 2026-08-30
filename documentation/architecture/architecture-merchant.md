# Architecture

What the system does and how the pieces fit. `plans/` records why it was built this way and what was
rejected; this file is the map you need before reading either.

Read this first, then `CONTRIBUTING.md` for the conventions the code follows.

---

## 1. The one-paragraph version

An Actor carries a flag that makes it a merchant. Its stock lives in **container Items** on that Actor
called *inventories*. Double-clicking the token opens the shop window, where a player fills a **slate** — things
to buy, things to sell — and presses one button. That request goes to the **active GM**, who re-derives
every price from documents, and settles goods and coin in a **single `blacksmith.inventory.exchange` call**
that either commits entirely or does nothing. There is no client-authoritative path and no partial state.

---

## 2. Files

| file | what it owns |
|---|---|
| `scripts/const.js` | Every constant, flag key, preset and pure schedule/format helper. Depends on nothing. |
| `scripts/merchant.js` | Entry point. Hooks, sheet header buttons, socket listener. |
| `scripts/manager-merchant.js` | All state and the entire GM-side transaction. The heart of the module. |
| `scripts/window-shop.js` | The shop window. Slate state, rendering context, every player-facing gesture. |
| `scripts/window-merchant-config.js` | Merchant Settings. Inventories, hours, till, tables, presets. |
| `scripts/utility-pricing.js` | Pure arithmetic: denominations, prices, making change. No documents. |
| `scripts/utility-inventory.js` | Thin accessors over `blacksmith.inventory`. Deliberately thin. |
| `scripts/utility-feedback.js` | Everything the module says to a person: toasts and sounds. |
| `scripts/utility-progress.js` | The restock progress bar. Core's notification, not a toast. |
| `scripts/utility-reputation.js` | The party's standing here, as a multiplier. Thin over Blacksmith's scale. |
| `scripts/utility-market.js` | What goods are worth in a place. A number on the Scene. |
| `scripts/utility-compendium.js` | A shelf's compendium query: its shape, its defaults, and how it reads. |
| `scripts/utility-sockets.js` | Cross-client traffic, through `blacksmith.sockets` with a legacy fallback. |
| `scripts/utility-pins.js` | A shop's second door: what a pin names, what it remembers, how it looks — §10. |
| `scripts/region-shop.js` | A shop's third door: the Open Shop region behaviour. Registered at `init` — §11. |
| `scripts/utility-catalogue.js` | A shop's fourth door: the catalogue Item, and what consulting one does — §12. |
| `scripts/utility-mail.js` | Mail order: what a service costs, what a receipt carries, and when it lands — §12a. |
| `scripts/canvas-marker.js` | The badge on a merchant token. The category's own icon, in the pin's colours — §13. |
| `scripts/settings.js` | Every world setting, and the controls Foundry does not render for them. |

**Styles are one file per window, and `styles/default.css` imports and nothing else.** It is the only
stylesheet `module.json` names, so it is the door; `window-shop.css`, `window-merchant-config.css` and
`dialog.css` are the rooms, each named after what renders it. The same shape Curator and Squire use. When
two windows genuinely share a component it goes in a `common.css` imported first, so a window can override
it — there is nothing shared enough to warrant one yet.

`utility-pricing.js` and the schedule half of `const.js` are the only modules with no Foundry documents in
them, which is exactly why they are the parts `tests/` can cover.

---

## 3. Where state lives

**Everything is on the Actor. Nothing is on the Token.** A shop is a persistent entity; flagging the token
would make every placed instance a separate shop and lose the configuration when the token was deleted.
This is the sharpest divergence from Curator's corpse looting, where token-scoped state is correct, and it
is the one most likely to be got wrong out of habit.

### The merchant flag — `flags['coffee-pub-merchant'].merchant`

```js
{
    enabled: true,               // false or absent = not a merchant
    name: 'Potions and Stuff',   // the shop's name; the Actor's name is the shopkeeper's
    kind: 'general',             // SHOP_KINDS — drives the icon and category label
    description: '',             // GM-authored, enriched on display
    illustration: null,          // a picture of the PLACE — see §6
    sounds: { open, close } | {},// this merchant's own door; absent means the world's
    tint: null,                  // '#rrggbb' or null — a colour wash on the shop card
    schema: 1,                   // stamp for future migrations — see §17
    open: true,                  // only consulted when there is NO schedule
    hours: { open: 9, close: 18 } | null,
    override: { open, against } | null,   // see §5
    pricing: {
        markup: 1.0,             // the shop's BASELINE; inventories multiply against it
        reputation: false,       // opt in to the party's standing moving prices
        overrides: { [itemId]: baseUnits },        // agreed buy prices
        purchaseOverrides: { [itemId]: baseUnits } // agreed sell prices
    }
}
```

There is no shop-wide `stock` any more. Every inventory states its own policy — see below.

Read with `MerchantManager.getConfig(actor)`, written with `setConfig(actor, changes)`, which shallow-merges.

### The inventory flag — `flags['coffee-pub-merchant'].inventory` on a container Item

```js
{ type: 'general', order: 0, visible: true, markup: 1, stock: 'infinite',
  buyRate: 0.7,                                  // purchased only — what the shop PAYS
  restockDays: 7, lastRestock: <worldTime>,
  maxProducts: 50,                               // a TARGET a drawing shelf fills up to
  maxPerItem: 20,                                // a CEILING on any one row
  depth: 'normal',                               // scales the world's depth tables
  source: 'manual',                              // manual | query | table | both
  tables: [{ uuid, rolls, auto }],               // when the source draws from tables
  query: { subtypes, rarity, priceGp: { min, max } } }   // when it draws from compendiums
```

**The type is stored, and the settings follow from it.** Six of them, defined in `INVENTORY_TYPES`:

| type | visible | pricing control | restocks |
|---|---|---|---|
| `general` | shown | the shop baseline, nothing of its own | yes |
| `hidden` | **hidden** | own markup, starts at 1 | yes |
| `premium` | shown | own markup, starts at 1.5 | yes |
| `discounted` | shown | own markup, starts at 0.75 | yes |
| `unpriced` | shown | none — agreed on the slate | yes |
| `purchased` | shown | **two** rates: `buyRate` paid, `markup` charged | **no** |

These were five *presets over one schema* until 2026-08-19, and the schema stored nothing about which one
had been chosen — a Premium and a Storefront were the same object once created, so nothing downstream could
offer a control that only made sense for one of them. Storing the choice is what lets the settings window
show a Purchase Rate on the one type that has one and nothing at all on the type that has no prices.

**The type sets defaults; it does not take controls away.** Every type keeps the show/hide toggle in the
inventory header — that gesture exists so a GM can bring the good stuff out front mid-session, and a
premium inventory needs it as much as a hidden one. `hidden` is simply the type that starts hidden.

**Nothing inherits any more.** `markup` is a real multiplier on every inventory (1 means "the baseline and
nothing more") and `stock` is stated per inventory. The old `null`-means-inherit was not wrong so much as
invisible: two places set one thing, one of them silently.

`mode` is gone. It carried what the transaction branched on — sale, barter, buyback — and `type` carries it
now, through `isUnpriced()` and `isPurchased()`. One word per concept, in the interface and in the code.

**The inventory's name is the container's name.** The flag carries no copy of it, so a GM renaming the
container — in Merchant Settings or in dnd5e's own sheet — renames the inventory. A shop may hold several
inventories of one type, which is why naming them matters.

### The market flag — `flags['coffee-pub-merchant'].market` on a **Scene**

```js
{ rate: 2.0 }     // 0.25 .. 4.00; absent means the going rate
```

The only state this module keeps outside an Actor, and it is on a Scene because that is what it is about:
every merchant standing on that map prices against it. Setting it back to 1.00 **unsets the flag** rather
than storing a no-op, so a scene either has a market or does not.

Set from the Scene sheet's header menu — the same pattern as Merchant Settings on an Actor, for the same
reason: always reachable, one unobtrusive row, and it opens the control rather than being one.

A city spread over three maps means setting it three times. Named regions spanning scenes would fix that and
are a larger feature than this one; they wait until the repetition annoys somebody.

### The par flag — `flags['coffee-pub-merchant'].par` on a stock Item

What a restocking inventory refills *to*. There is no separate par editor: a GM setting a quantity by hand in
the shop window sets both the count and the par, so the rule is *"what I keep six of, I restock to six"*.
A purchase lowers the count and leaves par alone.

Because Merchant writes flags to Items that `blacksmith.inventory` moves, both `par` and `inventory` are
registered with `registerTransientFlag` at startup. **If you add a flag that lives on an item, register it.**

**Registering is not stripping.** `registerTransientFlag` makes a path invisible to *merge comparison*; the
flag still rides along in the payload. So `par` leaves with every item bought from a counted inventory and comes
back if the buyer sells it — which is why `getStock` refuses to read a par on a purchased inventory. Blacksmith's
`omitFlags` will stop it arriving at all; the guard stays regardless, for items already out there.

---

## 4. Stock is a count, not a document

Nothing is ever moved off an inventory by a sale in the ordinary sense. Every policy grants the buyer a copy or
decrements a number; the row itself survives:

| policy | on purchase | transfer flags |
|---|---|---|
| `infinite` | count untouched | `copy: true` |
| `finite` | count down by one, row stays at zero marked out of stock | `preserveEmptySource: true` |
| `restocking` | as finite, and the count returns to par on a cadence | `preserveEmptySource: true` |

The count is `system.quantity`, **not** a flag. A flag would be a parallel truth: the moment a GM edits
quantity on the Actor sheet — which they will, because that is where quantity has always lived — the two
disagree and one of them is silently wrong. Using `system.quantity` means the Actor sheet, the shop window
and every other module are looking at the same number.

The whole policy is expressed as two flags on the exchange transfer. There is no stock check in
`_goodsTransfers`, because the primitive enforces availability itself.

### Restocking is topping up to a level

**Par is the level, and only a person sets it.** Restock walks every row and brings it back
to its par; a row at zero is restocked, because zero is sold out, and a row that was deleted is
not, because deleting is how a shop stops carrying something. Selling never touches par —
`_goodsTransfers` passes `preserveEmptySource: true` so the row survives at zero rather than
being removed.

Par is written on **every change that is not a sale**: a quantity a GM types, a drop, a table
delivery. It was previously written only by the typed quantity, and `getStock` fell back to *the
current quantity* for everything else — which reads as maintained and is not. The target
followed the stock downward, so selling three of four flutes silently set the target to one and
selling the last set it to zero. "Restocks the same items" could never put anything back, and
the failure was invisible: the shop looked stocked and the restock reported success.

A row that has never had a par read falls back to what it currently holds — a shop sitting in a
world nobody is shopping in is a shop at rest. That is a *fallback in `getStock`*, not a
migration pass: there are no migrations (§17), and a row acquires a real par the first time
anything that is not a sale touches it.

### A roll brings new products, never more of what is already carried

The second, optional half of a restock. Top everything off first, then draw from the tables for
things the shop has newly got hold of.

**A drawn result already on the shelf is skipped entirely.** Topping up is the refill's job and
it refills to the level the GM set; a table adding to the same row would push it past that level
and make the number they typed mean nothing. It was also where duplicate rows came from — two
Torch lines, two Flutes, growing by one set per restock.

`maxProducts` is therefore a **target**, not a clip: a shelf that carries twenty and holds
fifteen rolls for five more, and once it is back to twenty there is nothing left to ask for.

### Where the stock comes from

Four sources, stated per inventory as `source`. They are not four mechanisms — they are which
half of one restock runs, and everything downstream (new products only, up to the target, depth
by type/rarity/price) is shared.

| `source` | Draws from | For |
|---|---|---|
| `manual` | nothing | Curated stock. A fence's shady goods, a smith's one good blade |
| `table` | the inventory's roll tables | A list somebody wrote, weighted the way they wrote it |
| `query` | the installed compendiums | Broad stock that maintains itself |
| `both` | tables **then** the query | A shop whose character is a written list, with ordinary stock as filler |
| `bothQuery` | the query **then** tables | A shop that is mostly ordinary, with a few chosen things |

**Manual draws nothing on purpose.** Its rows are still topped up to their par — what it never
does is bring in something the GM did not put there. That is a different statement from a table
shelf that happens to have no tables on it, and it is the one a curated shelf wants to make. It
is also the default: a new inventory takes what it is given until somebody says otherwise.

**A query is a description of what this shop deals in** — which kinds, which rarities, what price
window — answered by `blacksmith.compendiums.query` against what is installed *at the moment it
runs*. A roll table stores references, so it goes stale when a pack is renamed and dangles when a
module is uninstalled; a query cannot, and picks up new content on its own. The three dnd5e facts
that make this hard are Blacksmith's to own, and each is a silent wrong answer rather than an
error: mundane gear has a **blank** rarity rather than `common`, prices carry a denomination so
50 sp is 5 gp, and unpriced and free share a stored 0.

**Which compendiums: curated, or this shelf's own list — never both.** The curated set is the Item packs
the GM put in Blacksmith's slots, and it is the world's answer to "what content do we use": every Coffee Pub
module matches items, scans journals and fills inventories against it. A shop reaching outside it is saying
something *different*, not something extra — a fence drawing on a pack of cursed junk is not asking for that
pack to become part of the world's item matching — and a union of the two would be exactly that with a
longer route.

Stored on the shelf's query as `sources`, in three states that must not be conflated:

| stored | means |
|---|---|
| `null` | the curated set |
| `[{ id, enabled }, …]` | this shelf's own list |
| `[]` | a custom list nobody has filled yet — **draws nothing**, and says so |

Entries carry a switch, like the roll tables beside them: **off keeps the pack and its place and simply
stops it contributing.** A bare string reads as an enabled entry, because that is what a list written
before the switch existed meant. A list whose every pack is off draws nothing, and is reported the same
way an empty one is.

The empty case is the one worth writing down: falling back to the curated set there would restock a shady
fence from the world's ordinary content the moment its last pack came off the list. Emptying a list is not
the same gesture as abandoning it.

Packs are **dragged on**, like the roll tables beside them — a compendium from the sidebar, or any document
out of one, because finding the pack you want by finding a thing in it is how anybody browses. Dropping the
first pack is what switches the shelf off the curated set: a GM dragging a pack has already said which packs
they mean, and a switch to throw first is a step that exists only to be forgotten.

**The filters are the shelf's, not the query's.** Kinds, rarities and the price window describe what
this shelf carries, so they apply to a roll-table draw as well — `matchesFilter` asks of a resolved
document what Blacksmith asks of the index. They were query-only, which made a shelf's own description
depend on which source happened to fetch a row. A table entry that fails is reported apart from a dead
one: the table is fine, the shelf simply does not carry that.

The two halves differ on one point, and it is forced: **unpriced passes a price filter that is not
filtering on price**. With the range wide open, dropping a GM's unpriced trinket would be a refusal
nobody asked for; once a range is stated, a thing with no price is outside it. The index cannot make that
call at all — unpriced and free share a stored 0 — so the query excludes unpriced outright.

Candidates are **over-fetched and shuffled** (Fisher-Yates — not a comparator returning random
signs, which is not a shuffle). The query answers in scan order, so taking the first N would give
every shop in the world the same opening stock from the same pack.

**On a two-source shelf, the order is the GM's.** Both halves feed one product target, so on a
nearly full shelf whichever runs first gets the last slots — which is the whole difference between a
shop stocked from a list somebody wrote and one stocked from whatever is installed. That was fixed at
tables-first with the reasoning in a comment; a fence and a general store want opposite answers, so it
is two menu entries. Nothing arrives twice either way — `_withinLimits` matches by name and type, so
the same longsword from both sources is one row.

Feature-detected, never version-pinned: on a hub without `compendiums.query` the card says so and
the shelf falls back to its tables rather than going quietly empty.

### The order of the shop

An inventory's `order` is its place in the shop — what is on the counter and what is in the back
room — and it was whatever order the containers happened to be created in. `moveInventory` renumbers
**every** inventory on each move rather than swapping the pair: presets all set `order: 0`, so a swap
of two zeroes moves nothing, and writing a whole sequence makes the stored order say what the screen
says. It is self-repairing for the same reason, and it includes hidden inventories — they are still
part of the layout, and skipping them would make a move jump two places whenever one sat between.

One `updateEmbeddedDocuments` for the shop, like every other multi-row write here.

### Which shelves can restock, and which are asked

`canRestock` is what the shop window's control asks, and it is deliberately **not** the clock's
test. The clock skips a table whose `auto` switch is off; the button is exactly what that table is
for. What it refuses is the dead ends — a **purchased** inventory, which holds what the party sold
and has no level to return to, and a **manual** shelf that is not set to restock, which has nothing
to refill *to* and no source to draw from. Both could only ever report "nothing to restock", and a
control that never does anything reads as broken rather than as absent.

The manager refuses those too (`restockInventory` returns 0 for a purchased inventory whatever
else is set on it). Hiding a control is not a rule; the GM-side refusal is what makes it one.

### Duplicate rows, and folding them together

**Nothing creates them any more.** A draw skips whatever the shelf already carries, and
`_withinLimits` coalesces repeats inside one draw, so the current code cannot produce a second
Light Hammer. Nothing *removed* them either — a restock tops rows up to their level and never
merges — so pairs made before that rule existed, or by a hub-side merge that was refused for a
reason since fixed, sit there indefinitely.

`mergeInventoryDuplicates` is the only way to clear them: rows grouped by **name and type**,
quantities added up, the first row surviving so the shelf keeps its order, the **highest** par of
the group kept, and the result clamped to `maxPerItem` like every other write of those two
numbers. Par is *not* raised to the merged total: what a shelf is kept at is a decision about the
shop, not the sum of three accidents, so the surplus sells through like any other over-stocked row.

Name and type is the dominant part of the identity a grant merges on, and deliberately not that
whole predicate — a second copy of it here is a second copy to drift from the first. The cost of
being approximately right is that a GM might merge two rows they had a reason to keep apart, which
is why this is a button somebody presses rather than something that happens to them.

### How deep a row arrives

Three ceilings and the smallest wins. There is no order to remember and no arithmetic across
them, which is what makes three rules cheaper to hold than one compound one.

```
depth = min(type, rarity, price, the shelf's own ceiling)
```

- **Type** is first because it is closest to how anybody pictures a shop: ten torches, one
  breastplate. Armour is `equipment` in dnd5e, which is why that entry reads lower than a
  consumable.
- **Rarity** is the lever price cannot pull. Two blades at one price are not the same question if
  only one of them is the only one anybody has heard of. Keys are dnd5e's own; an item with no
  rarity — most `loot` — reads as common.
- **Price** bands it, coarsely, as before.
- **Zero means a lever has no opinion**, which is what `common` wants. A rule that never fires
  should not pretend to be one that does.

**The die wobbles under the ceiling; it does not start from one.** A uniform roll made 1 exactly
as likely as the cap, so a shelf of twenty-five products landed about five of them single — a shop
with one dagger and one dart, which is what every other rule here exists to prevent. The floor is
half the ceiling, so the cap means *what this shop keeps* rather than *the luckiest thing that
could happen*. A ceiling of one is still exactly one, which is what keeps a legendary blade alone
on the shelf.

| Ceiling | Delivered |
|---|---|
| 10 | 5–10 |
| 5 | 3–5 |
| 3 | 2–3 |
| 1 | 1 |

A quantity the **author** stated wins over all three: a table row reading "Arrows (20)" is a
delivery of twenty. The bands exist to invent a number when nobody stated one, so applying them
to a stated one would overrule the only person who knew. The shelf's own ceiling still holds,
because that is a number this GM typed about this shelf.

**The tables are world settings**, in Merchant's module settings, because how much rope exists
and how freely plate moves are the same answers in every shop on the map. What a shop gets is one
dial — Sparse, Normal, Deep — scaling them. Twelve controls per inventory would restate the same
world in every shop in it; the card shows the summary and says where it is set.

The dial scales the *world's* ceiling, never the shelf's: `maxPerItem` is a number a GM typed on
this card, and a dial arguing with it would mean the figure on screen was not the figure in
force.

**A drop runs the same chain.** A compendium entry reads 1 because that is what one crowbar *is*,
not because a shop keeps one; taking it literally is what made every dragged row land single.

---

### Ceilings, and the clock

`maxPerItem` — *max stack* — and `maxProducts` — *products* — are both on the card, under **Stocking**,
and they are **not the same kind of number**. `maxProducts` is a **target**: a drawing shelf fills up to it
and stops, so it says how big a shop *is*. It was a ceiling against runaway growth until a draw started
bringing in new products only, which removed the runaway. `maxPerItem` is still a **ceiling**, and still
guards its own: without it a shelf restocking rations builds toward thousands of them. Both are enforced on write, and `setStockQuantity` returns `{ value, clamped, maxPerItem }`
so the window can say what happened rather than silently correcting a number a GM typed.

Restocking is driven by `updateWorldTime` — the same watcher that opens and closes shops, so there is
no second clock. An inventory restocks when `restockDays` in-world days have elapsed. **Advancing a
week restocks once, not seven times**; the watcher compares elapsed time against the interval rather
than counting boundaries.

### A shop is what stands in the world, not what sits in the sidebar

`worldMerchants()` is the set the clock walks, and it is not `game.actors`.

| | Is it a shop? |
|---|---|
| **Linked** merchant Actor | **Yes.** A linked token *is* its Actor — Bob keeps a shop in Phlan, and what the party does to his till is still true next season and in whatever city he turns up in. He is a shop whether or not a token of him is placed. |
| **Unlinked** merchant token on a scene | **Yes, each one.** Flipper the travelling salesman placed three times is three shops that know nothing about each other. Each has its own ActorDelta. |
| **Unlinked** merchant Actor in the sidebar | **No.** It is the mould Flipper is cast from. |

The third row is the one that was wrong, and it was wrong in the worst direction: the template was the
**only** thing the clock reached. And because an unlinked token inherits anything its delta has not
overridden, the template's new stock was then *delivered* into every copy cast from it. That is not a shop
restocking, it is a leak with a schedule.

`prototypeToken.actorLink` is the whole test. Every scene is walked, not the viewed one — a shop does not
stop keeping stock because nobody is looking at the map it stands on — with two cheap reads before
`token.actor`, which resolves a synthetic Actor and runs on every world-time tick.


---

## 5. Open and closed is derived, never stored

`MerchantManager.isOpen(actor)` computes the answer at the moment you ask:

1. No schedule → `config.open`, a plain manual toggle.
2. A schedule → `isScheduledOpen(hours, currentHour)`.
3. Unless a GM override stands. An override is `{ open, against }` — what the GM chose, **and what the
   schedule said when they chose it**. It stands only while `against` still matches what the schedule says
   now. The moment the schedule changes its mind — the next boundary, or a GM editing the hours — the
   exception is spent.

This was a stored flag kept in step by a `updateWorldTime` handler, and a shop whose handler missed a
crossing stayed open past closing wearing an override notice it had never been given. Every version of that
bug is a version of *"the thing that syncs the state did not run"*, so the state stopped being something to
sync. **Do not reintroduce a stored open flag.**

The hours slider says two things with one gesture: the band across the whole day is **Always open**, the
band shut to nothing is **Always closed**. `isAlwaysOpen` and `isAlwaysClosed` in `const.js` are for saying
so on screen only — `isScheduledOpen` already answers the question that matters.

---

## 6. Prices

All arithmetic is in **base units** (copper, in dnd5e) and converted only at the edges. `utility-pricing.js`
holds it and touches no documents, which is why 5,151 purse/price combinations can be checked in `tests/`.
`api.inventory` will never convert denominations, so this arithmetic is ours permanently and nobody else was
going to catch it being wrong.

`resolvePrice(merchantConfig, inventoryConfig, item, { reputation, market, shopper })` in order:

1. An **agreed price with this shopper** for this item wins outright — that is what makes it agreed. Nothing
   is applied on top of it, in either direction: a haggled number is the number, not the start of an
   arithmetic.
2. An **unpriced inventory** returns `null`. It has no list price by definition.
3. Otherwise:

```
system.price  ×  global markup  ×  inventory markup  ×  reputation
```

**Everything multiplies, and that is the model.** The shop's Global Markup is a *baseline* — an expensive
quarter, or the middle of nowhere — and an inventory's markup is an adjustment *within* that shop. Premium
stock is dearer than this shop's ordinary stock; a discounted rack is cheaper than it. Applying one instead
of the other, which is what this did until 2026-08-19, priced a premium inventory in an expensive shop as
though the shop were ordinary. Reputation stacks for a related reason: it is a fact about the town rather
than about the inventory.

Any rate that is zero, negative or unparseable is read as 1. A price of nothing is never what a typo meant.

#### An agreement is with somebody

Agreements are stored **nested under the shopper** — `pricing.overrides[shopperKey][itemId]`, and
`purchaseOverrides` the same on the selling side. The key is the shopper's uuid **with its dots taken out**,
which is not cosmetic: Foundry expands a dotted key at every depth of an update, so `Actor.qk3` as a key
writes the two-level path `overrides.Actor.qk3` while every reader asks for the one-level key it believes it
wrote. The agreement is stored and then unfindable, which in play reads as the edit being refused.

Both maps are written through `_writeAgreements`, which drops them with `-=` before rewriting. `setFlag`
merges, and a merge cannot express a deletion: rewriting a map without a key puts the old key straight back,
so clearing an agreed price did nothing and settling never released one. Keyed by item alone, which is what this was until
2026-08-28, a shopkeeper knocking something off for the paladin who saved the town put the row on sale: the
rogue standing beside her saw the cut price, and so did the shelf. That is not what haggling is.

So a price is only ever resolved *for somebody*, and **the shelf is nobody**. Shelf rows are resolved with no
shopper: what is written on a shelf is what the shop asks, and an agreement is a thing two people reach at
the counter. Slate lines, the sell offer and the GM's negotiate hint all carry the shopper. Pricing the shelf
for whoever was selected put one customer's discount on the row for the room to read, and masked the list
price besides — an agreement wins outright, so a shelf price edited on something already haggled looked like
it had been refused. The GM handler prices each
trade against the shopper it has already verified, so the number a client is shown and the number it is
charged come out of the same agreement rather than two lookups that can disagree. Editing a price with
nobody shopping is refused rather than written to the room.

Settling clears **only that shopper's** agreements. A purchase used to wipe the row for everyone, including
somebody still standing at the counter mid-haggle.

Agreements in the pre-2026-08-28 flat shape are **ignored, not migrated**. Migrating means guessing whose
they were, and the only guess available — everybody's — is the bug. It costs a re-haggle at worst, since
agreements are cleared the moment a trade settles and almost none are stored at any one time.

`resolveBuybackPrice` is the mirror. It reads a share of what the item is **worth** — no per-item overrides
and no *inventory* markup, since what a Premium shelf charges says nothing about what the shop pays for your
sword — but the **merchant's own markup applies to both sides**. That markup is one dealer's pricing against
their competitors, so a shop that charges above the going rate is a shop dealing in dearer goods; one that
marks everything up and then pays the going rate is not a dealer, it is a one-way valve.

Reputation is applied **inverted**: the standing that buys you a discount gets you more for your goods, or a
beloved party is rewarded in one direction and ignored in the other.

### The three levers, and what each is for

| lever | scope | stored on | inverts when selling? |
|---|---|---|---|
| **Market** | the place | Scene flag `market` | **no** |
| **Reputation** | the place | Blacksmith, per scene | **yes** |
| **Global Markup** | one merchant | the merchant flag | no |

- **Market** is what goods are worth here, whoever is asking. Grain is cheap in the valley and dear in the
  besieged city.
- **Reputation** is what this town makes of *this party*. Save a city and its shops treat you well; wreck
  one and they gouge you.
- **Global Markup** is one merchant's pricing against their competitors on the same street.

**Whether a lever inverts on the sell side is the whole design, and it decides which one can make a trade
route.** Reputation is a *favour*, so it moves both directions in the party's favour: being liked means
buying cheaper **and** selling dearer. That makes the best place to buy also the best place to sell, so no
two areas differing only in reputation can be arbitraged — which is correct for what reputation is, and is
why it was never going to be the trade mechanic however it was tuned.

A market rate is not a favour. It is what the thing is worth, so it moves both sides the *same* way: where
goods are dear you pay more and are paid more. Bad to buy in, good to sell in — and that asymmetry is a
trade route. Buy at ×0.50 for 50, carry it to ×3.00 and a merchant dealing dear pays 270.

Merchant markup makes routes too, on a smaller scale and between shops rather than places.

### Nothing opens the loop

The clamp holds against all three, because at one counter every place-and-shop multiplier appears on both
sides and cancels. `tests/test-pricing.mjs` sweeps markets, reputations, markups and purchase rates and
asserts the shop always charges more than it pays; at the extreme worked above, selling and buying back in
the same city loses 405 per turn.

### A shop never pays more than it charges

`MAX_BUYBACK_RATIO` (0.95) clamps every offer to a fraction of what that same inventory would resell the
item for. **This is the guard against a gold machine and it has to be in code.**

Sell an item and buy it back and the merchant's markup cancels, leaving `buyRate / rep²` — reputation twice,
because it makes buying cheaper *and* selling dearer. A beloved party at a generous merchant pushes that
above 1, and the round trip profits, and repeats. Capping `buyRate` cannot fix it: the safe ceiling moves
with reputation, so a fixed limit is either too tight for a neutral town or too loose for a beloved one.
`tests/test-pricing.mjs` sweeps 300 combinations of the three rates and asserts the shop always charges more
than it pays.

The purchased type carries both halves of that: `buyRate` is what it pays, `markup` is what it then charges.
They used to be one number, and `resolvePrice` had to refuse to read it or a shop buying at half price would
have resold at half price forever.

### Reputation

Off unless a shop opts in. Blacksmith scores the party −100..+100 **per scene** and sorts that into eleven
named bands; `REPUTATION_MARKUP` in `const.js` maps band → multiplier, and **is meant to be tuned**.

The boundary is worth stating: they own *how liked the party is*, we own *what a shop does about it*. Their
scale briefly carried an `effects.merchantModifier` and they removed it rather than fill it, which was the
right call — the same scale drives NPC attitude and what people will tell you, and a table wanting gentler
prices should not have to edit that.

Two constraints shape the implementation, both in `utility-reputation.js`:

- **The band lookup is async**, so it is resolved **once per render** and the multiplier passed down. Per
  row it would be a promise per price and a list resolving in a different order than it drew.
- **Reputation is per scene**, so a shop reads the scene its *token* stands on — never `canvas.scene` on
  the GM's client. A GM answering a request from another map must not price the shop differently from the
  players standing in it.

### The list price, and where a GM sets it

`listPriceBase(item)` is the item's own worth in base units — before market, markup or standing — and it is
the single reading of `system.price` in the module. `resolvePrice` multiplies it; the shelf's price editor
writes it back. One reading, so the editor cannot open showing a figure the shelf would price differently.

A GM **double-clicks the price on a stock row** to set it, the same gesture as the quantity beside it, and
`MerchantManager.setListPrice` writes `system.price` in gp. Not an agreement: an agreement is one price for
one trade and is cleared when that trade settles, where this is what the thing costs and outlives whoever is
standing at the counter. It shows on the item sheet, and a copy dragged out of the shop carries it.

**An unpriced row is why the editor is on the cell rather than the figure.** A row with no price cannot go on
the slate — `canCart` requires one — so the slate's own price control could never be reached, and an item
that arrived without a price was stuck with no way at all to give it one. The cell carries the editor so
there is something to double-click when there is no figure to double-click.

Not offered on an **unpriced inventory**: having no list price is what that inventory is for, `resolvePrice`
returns `null` there whatever `system.price` says, and the figure would be written and then ignored.

### Free, and the difference between free and unpriced

**Free is a decision; no price is an absence.** They cannot share a storage slot, because dnd5e
leaves `system.price.value` at 0 on everything nobody has valued — so a bare 0 means "unvalued" far
more often than it means "free", and reading it as free would put a shop's entire unpriced stock on
the house.

`FREE_FLAG` says the difference out loud. Value 0 **with** the flag is free; value 0 **without** it
is a row nobody has priced. Three states, and the shelf editor writes all three: type a number to
price it, type **0** to give it away, clear the box to unprice it.

| State | Shelf reads | Can be bought? |
|---|---|---|
| Priced | the figure | yes |
| Free | **Free** | yes, for nothing |
| Unpriced | **no price** | no — nothing to charge |

Zero then has to survive the arithmetic. `resolvePrice` and `resolvePurchasePrice` both floor at one
base unit, so that rounding cannot make a cheap thing free by accident — a thing free *on purpose*
is not an accident, so 0 returns before the floor. No markup, market rate or standing can put a
price back on a giveaway, and a shop pays nothing to buy one back rather than a penny apiece.

The flag is **transient and omitted on exchange**, exactly like `par`: it describes what this shop
does with the row, not what the thing is. A cloak given away is still a cloak, and must not arrive
in the buyer's pack claiming to be free.

A **negotiated** price of 0 already worked and still does — that is one trade rather than a
standing offer, and it clears when the trade settles.

### Two pictures and a colour, answering three questions

**The name on the card is the token's, not the Actor's.** The Actor is the mould an unlinked merchant is
cast from — *General Merchant* — and the name given when the token was dropped is the person standing
behind this counter. Three placements of one travelling salesman are three people, and reading the Actor
would call all of them by the template's name. A linked token carries its Actor's name anyway, so it is the
same answer there. The keeper line is suppressed entirely when the shop is named after them.

**The portrait is who is behind the counter; the illustration is what the place looks like.** They are
different questions and neither substitutes for the other, so they are stored separately: the portrait is
the Actor's own `img`, the illustration is `illustration` on the merchant flag beside the name and the
description — the same kind of thing, something a GM wrote about this shop for players to see.

**Changing the portrait changes the prototype token with it.** A shopkeeper whose sheet and whose token
disagree is two characters as far as anybody at the table is concerned, and the token is the one players
actually see. **Placed tokens are left alone**: they are already on a map, and changing art under a player
mid-scene is a different act from setting up a merchant.

The illustration is a **backdrop, not a replacement**. It is the subject card's own
`background-image` — layers on one element, not a `::before` — and the card is read as a dark
card rather than as a faded picture: the whole illustration at full size under a light veil, with
the text switched to a warm off-white carrying a dark halo. Hierarchy on it is size and weight, not
faded colour, which is a light-card habit that reads as *harder* rather than quieter over a
photograph. **No `min-height`**: the card sizes to its content inside a column with no spare room,
and a floor on it pushes the rows below straight out of the card.

A stored path is turned into a URL by `illustrationUrl`, not used raw. **A relative `url()` in CSS
resolves against the stylesheet**, so `modules/x/y.webp` was fetched as
`modules/coffee-pub-merchant/styles/modules/x/y.webp` — a 404 with nothing in it to suggest the
cause. `foundry.utils.getRoute` rather than a bare leading slash, because a Foundry served under a
route prefix needs that prefix.

**The tint is the GM's colour for this shop**, washed over the same card: a smithy red, an
apothecary green, whatever this table has agreed the colours mean. Deliberately set rather than
derived from `kind` — a tint taken from the kind would say what Merchant thinks the shop is, where
a GM colour-coding by district or by faction is doing something a fixed palette cannot.

It is **additive**, so a shop with no tint renders exactly the card it always did, and it layers in
a fixed order: picture, then the veil that seats light text on it, then the colour — lighter over an
illustration, which carries its own. Mixed against `transparent` rather than into the surface:
`color-mix` with an `rgba` adds the two alphas, so a tint would have quietly darkened the card as
well as colouring it and every colour picked would have made the veil heavier.

`normalizeTint` validates on the way in **and** again at render, because the value is substituted
into an inline `style` attribute and a flag is something a GM can hand-edit and a macro can write.
`#c33` and `#cc3333` become one lowercase six-digit form; a colour name, a typo, or a colour with
more CSS after it become no tint at all.

A shop with neither renders exactly the markup it always did, which is what makes both safe to add
to a window full of working controls.

The field takes a **typed path as well as a browsed one**. Typing matters twice over: a path pasted from
somewhere else is a real way to set one, and clearing the box is the only way to say *none* — which a
browse-only control cannot express at all.

### Negotiation

A GM double-clicks the price on any slate line and names it. The figure is written to the **merchant
document**, never carried in the settle request: a price is the one number in a transaction a player must
not be able to name, and a slate is client state.

- An unpriced line shows **TBD** and settling refuses while any line is still TBD.
- On settle, an item that had **no price of its own** is stamped with what was agreed, so a curio
  negotiated at 200 gp can be sold on for 200 gp. An item that **had** a price keeps it — a longsword
  bought cheap is still worth what a longsword is worth.
- Agreements are **cleared once the trade they were made for settles**, so a discount does not quietly
  become the inventory price for the next party.

Stamping happens *before* the goods move, in one batched `updateEmbeddedDocuments` per Actor. A second
separate write to the same Actor is the shape that trips dnd5e's encumbrance recompute.

---

## 6a. Where a shelf's stock comes from

A compendium shelf draws down one of two paths, chosen by **what was asked for** rather than by what is
available.

**No source list** means the curated set, and that is Blacksmith's question to answer. `compendiums.query`
knows the world's search order, ranks by relevance, and handles world items; none of that is worth
rewriting.

**A source list** means *these packs*, and Merchant reads their indexes itself. It has to: the hub filters a
requested source against the curated set, so handing it a pack the world has installed but Blacksmith is
not searching gets that pack silently dropped. For a custom list that is exactly backwards — the reason to
name packs by hand is to reach the ones the world deliberately does not search, so that a shady fence can
stock cursed junk without that junk becoming part of the world's item matching.

The scan reads **indexes, not documents**. Every field a shelf filters on — type, rarity, price — is on the
index, and loading each document to ask its price would be thousands of loads to answer a question already
in memory. Only the handful actually drawn are resolved.

**Everything matching is collected before anything is cut.** Stopping at the limit inside the loop would
fill a shelf out of whichever pack happens to be first in the list, every time — a nine-pack merchant
stocked entirely from Vol 1. The pool is shuffled across all of them and then sliced.

**Unpriced items are excluded**, matching `includeUnpriced: false` on the hub path and for its reason: a
shelf sells things, and a thing with no price cannot be sold. It is the one deliberate difference from
`matchesFilter`, which lets an unpriced item through when no price bound is set — that rule is for a GM
dropping a trinket on a shelf by hand, where refusing it would be a refusal nobody asked for.

One dead end is left, and it is the one a GM can act on: a list with nothing switched on. That is refused
by name rather than reported as "found nothing matching", which would be true and useless.

---

## 7. The transaction

There is exactly one GM-side operation: `op: 'settle'` → `_processSettle`. Buy and sell are two halves of
one request, so a player who is trading in an old sword towards a new one presses one button and either both
happen or neither does.

```
window-shop.js  settle()
    │  client-side sanity: nothing on the slate, no character, any TBD line,
    │  can the purse cover the net — all so the player learns it from the slate
    │  rather than from a refusal. None of it is trusted.
    ▼
gm-request.js   send('settle', payload)      → game.users.activeGM.query()
    ▼
manager-merchant.js  _process()
    │  merchant exists · is a merchant · is open (GM exempt)
    ▼
_processSettle()  under _withStockLock(merchant)
    │  1. _validateShopper   — one Actor pays AND receives
    │  2. _priceBuying       — every line re-resolved from documents
    │  3. _priceSelling      — ditto, against the buyback inventory
    │  4. planPayment        — coins chosen smallest-first, change computed
    │  5. _recordAgreedPrices— stamp negotiated prices onto unpriced items
    │  6. exchange({ transfers: [...goods out, ...goods in, ...coin] })
    │  7. _clearAgreedPrices — on success only
    ▼
_broadcastRefresh(tokenUuid)  → every open shop window re-renders
```

**Every price is re-derived on the GM.** The request carries item ids and quantities and nothing else — no
prices, no totals. Anything the client computed is for display.

**One `exchange` call.** Goods and coin commit together or not at all. This was briefly a grant followed by
a charge, and it produced the worst possible failure — *"That could not be completed. The goods were already
handed over."* Do not split it again.

**One lock.** `_withStockLock` serialises anything that reads a count and then writes it. Sound because
exactly one GM client handles requests. This is the most likely place for a bug that only a real table
finds — two players racing for the last unit.

### Three parties dissolved

There was a payer, a recipient, and a rule that they had to match. Shopping for the party is *being* the
party now: the party Group Actor appears in the "Buying as" list and the same code serves it. One Actor,
one check. The three-party ask to Blacksmith was withdrawn because of this.

---

## 8. The request envelope

**`blacksmith.gmRequest` is the envelope.** Merchant carried its own — `gm-request.js`, built on Foundry's
query API — from the first commit until 2026-08-21, always described as a bridge rather than a design. It
was deleted rather than rewritten, which is what it was written to be.

One op, registered on **every** client:

```js
MerchantManager.OP === 'coffee-pub-merchant.settle'
```

Every client, because any of them can become the answering GM and one that registered nothing answers
`UNKNOWN_OP`. The op is module-prefixed because the registry is world-wide. A GM calling `request()` runs the
handler **locally** — no socket, no election — which is what makes a shop work in a world with nobody else
connected.

**The envelope routes and elects; it does not authorize.** Every uuid in a payload is still re-resolved and
every rule re-checked against the documents that come back, because the payload is a client's.

### The caller is verified now, and this is the part that changed

`_process(payload, user)` is handed a `User` the envelope resolved from the authenticated socket. Merchant
used to assert the caller's id **in its own payload** — the step that turns a verified identity into a
client-supplied claim — because Foundry knows who called and does not pass it to query handlers. That was
the module's one unsound seam, it was known, and building a mitigation for it was explicitly refused on the
grounds that only the envelope could close it. It has.

**Never read an identity out of a payload.** If one appears there, it is either redundant or a hole. The
ownership checks in `canActAs` and `_validateShopper` are worth exactly what the identity behind them is
worth.

`IDENTITY_UNVERIFIED` is a refusal, not a fallback: when the answering client cannot establish who asked, it
declines rather than answering from a claim. Report it; do not work around it.

---

## 9. The shop window

### What a shop window is opened *for*

**A linked merchant is keyed by its Actor; an unlinked one by its token.** The base class keys its
registry on the uuid it is handed, so which document `openFor` receives *is* the identity decision —
`subjectFor(token)` makes it in one place and returns the argument pair, so a caller cannot get the key
and the scene out of step.

| merchant | keyed by | why |
|---|---|---|
| linked Actor | the **Actor** uuid | one shop wherever you meet it — a pin, a token, or a second token of the same Actor |
| unlinked token | the **token** uuid | each placement is its own shop, with its own ActorDelta |

That is what makes a pin and a token one window with one cart. It also fixed something latent: two
placed linked tokens of one Actor used to open two windows with two carts for what is, by every other
measure, one shop.

**The scene is carried beside the key, because it cannot be derived from an Actor.** Two things that set
the final price are scene-scoped — the market rate on the Scene flag, and the party's standing here — so
one linked Bob with a token in Phlan and a pin in the besieged city is one shop with one set of goods at
two prices. `_resolveSubject()` returns `{ actor, token, scene }`; **the token may be null and the Actor
may not**, because a shop opened from a pin has no token at all.

**A client-claimed scene is verified before it prices anything.** A token subject never needs this — the
GM reads the token's scene itself. An Actor subject sends a `sceneUuid`, and `verifiedScene` honours it
only where a token of that merchant actually stands. The market rate moves prices in both directions, so
an unchecked claim is the same shape of hole as reading an identity out of a payload, which §8 closed.



`window-shop.js` extends `BlacksmithToolWindowBaseV2`, which supplies the titlebar, footer, position memory
and micro-titlebar folding. **One window per token, and the registry behind it, are the base class's** —
`openFor` / `openWindowFor` / `openWindows` / `closeFor`, keyed by uuid and per subclass, so double-clicking
twice focuses rather than duplicates and a Shop and a Loot window on one token do not evict each other.

Merchant kept its own map until 2026-08-19, and the difference is not cosmetic: ours entered the map before
the first render and left it only in `_onClose`, so a window whose first render threw was registered, never
opened, and never removed — after which every later open re-rendered that same broken instance. The window
became unopenable for that actor until the page was reloaded, which is the shape of a bug seen in play and
not reproducible afterwards, because a reload clears a static map. The base class deletes the entry when a
render throws. Anything this window does in `_onClose` therefore runs inside a `try`: a throw before
`super._onClose` would strand the entry again.

**Both classes import the base from the bridge, and that is now the supported contract.**
`api/blacksmith-api.js` re-exports `BlacksmithWindowBaseV2` and `BlacksmithToolWindowBaseV2` — along with
`BLACKSMITH_WINDOW_STYLES`, `BLACKSMITH_TOOL_TITLEBARS` and `BLACKSMITH_TOOL_THEMES`, which are the same
objects as `api.windowStyles`, `api.toolTitlebars` and `api.toolThemes`. It is a real ES module, so it
resolves at evaluation time.

`module.api` remains correct for anything resolved after `init`, and `scripts/` paths are still not a
contract. But `module.api` cannot serve a class you `extends`: Foundry evaluates module scripts before
`game` exists, so the resolve throws — and ESM caches the failed evaluation, so it kills the module for the
whole session rather than being retried. `api-window.md` recommended exactly that; **Merchant followed it
and broke a live world on 2026-08-19.** Blacksmith corrected the doc and added the re-exports, and three
consumers each dropped a private workaround. Kept here because the failure mode — a cached throw disabling a
module for a session — is invisible from the stack trace and worth recognising on sight.

**The slate** is two `Map`s of `itemId → quantity` — `cart` (buying) and `basket` (selling) — keyed by
`tokenUuid|shopperUuid` and **mirrored to every client that can act as that character**, never persisted.

Keyed by the *character*, not the client: switching "Buying as" switches slate, and a GM switching to a
player's character sees the slate that player is looking at. That is what makes negotiation work at all,
since prices are agreed on slate lines. Mirrored peer to peer and display-only — settling re-derives
everything on the GM — with a `ping` on open so a late window sees the room. Published from `_onRender`
rather than from the sixteen mutation sites, and snapshot-compared so it cannot echo.

Permissions fall out for free: the only characters you can switch to are the ones you can act as. `_cartLines()` and `_basketLines()` turn them into render context, and
that is where stock trimming, TBD lines and totals happen. Both re-resolve from documents on every render,
so an inventory emptied out from under a standing slate trims the line instead of failing the checkout.

Notable behaviours worth knowing before you touch it:

- **Search** is a pure function, `filterShopList()`, exported so `tests/test-search.mjs` can cover it.
  A search **opens any folded inventory holding a result** — a folded shelf that hid a match would
  make the search lie, which is worse than finding nothing because an empty result reads as an
  answer. It is a second class laid over the fold, never a rewrite of it: clearing the box puts
  every fold straight back.
- **Folding an inventory, and the stock sort, are view preferences and are never written to a
  document.** Per client and per token, held in module-level maps: two people at one counter can
  have different sections shut, and a GM tidying their own view must not reach into what a player
  sees. That is also why neither needs a permission check — there is nothing here anyone could do
  to anyone else.
- **Stock sorts within each category, never across it.** The category is the coarse answer and the
  sort is the fine one; sorting a whole inventory would throw away the kinds that make forty rows
  readable. Two orders, not the sell side's three — a category *is* the grouping, so "by kind"
  would answer a question the layout already has. An unpriced row sorts last either way: "no price"
  is not a number, and at either end of one it would read as free or as priceless.
- **Rows show rarity beside the kind**, on both sides of the counter, and a **blank rarity shows
  nothing rather than "Mundane"** — dnd5e leaves `system.rarity` empty on everything non-magical,
  which is most of a shop. `itemRarity` and `rarityLabel` (`const.js`) are the one place either is
  derived; the query filter's chips had their own copy and were an edit from disagreeing.
- **Quantity and price edits** are in-place double-click, matching Curator's loot window: Enter or clicking
  away commits, Escape abandons, `0` removes the line. Price edits are GM-only and write to the document.
- **Item tooltips** come from dnd5e's own `richTooltip()` — the same thing Squire uses. Free, and correct.
- `_keepScroll()` preserves scroll position across the re-render that follows every gesture.
- **A render patches the page; it does not reprint it.** `_replaceHTML` is overridden to walk the old tree
  against the new one rather than let Foundry `replaceWith` the part. Foundry's own behaviour is correct and
  destroys every node, which means every `<img>` refetches and redecodes — invisible at 740 pixels of
  32-pixel icons, and a wall of large pictures blinking on every click in a full-screen catalogue. Rows are
  matched by `data-item-id`, so one leaving does not rewrite the rows below it. Three things are held against
  the incoming markup: `data-merchant-bound` (the node survived, so its listener did), a text field the
  template gives no `value` (the search box is filled from window state), and anything focused. See
  `morphNode` in `window-shop.js`, and `tests/test-morph.mjs`, which asserts on node identity rather than on
  markup — correct HTML is what the thing being replaced also produced.
- A control that cannot act is **disabled with a reason on hover**, never absent. An absent button reads as
  "this shop does not do that"; a disabled one naming its reason reads as "not right now, and here is what
  would change it".

---

## 10. Pins, and the shop that outlives its merchant

A pin is a **second door onto the same shop**, and only a **linked** merchant may have one.

That restriction is what makes the rest simple. A pin is durable map furniture — it outlives tokens being
deleted, scenes being swapped, a session ending — so what it points at has to be durable too. An unlinked
token is a copy: three placements of one pedlar are three shops that know nothing about each other, and a
pin naming that pedlar would name the mould rather than a shop. **A dedicated shop on a map is durable, and
therefore requires a durable Actor.**

The pin stores the Actor's uuid in `config`, and opening from it reaches the same window and the same cart
a token would — see §9 for why that is not automatic.

### What a pin remembers

| in `config` | why |
|---|---|
| `merchantActorUuid` | which shop this is |
| `shop` | a **snapshot** of the look — name, kind, blurb, tint, illustration, portrait |
| `taken` | the uuids already carried out of it |

The snapshot is taken when the pin is made, and is deliberately not a live read: it **could not** be one for
the case it exists for — the Actor is gone — and where the shop still exists it answers for itself. A pin is
a label on a map, and a label says what was true when somebody wrote it.

### A dead pin opens an abandoned shop

The Actor is deleted; the pin remains, because deleting a GM's map furniture unasked is the same failure as
a roll table's dead row vanishing. Clicking it opens the shop window **shuttered**: the same card, the same
*Buying as* row, the category icon in the pin's own colours where the portrait goes, and the snapshot's name,
kind, blurb, tint and illustration. Replacing the window with a line of apology said the *module* had failed;
a boarded-up shop says the *place* has, which is a thing that happens in a world.

There is no slate — a slate is a reckoning to settle and there is nobody to settle with — so the footer
carries **Remove Shop Pin** for a GM instead, and removal stays a decision rather than something that
happened when the Actor was deleted.

### What is left behind, and taking it

Nobody strips a place completely. A world setting lists what a dead shop leaves — names, semicolon-separated,
resolved against the compendiums when the shop is opened, for the same reason a query shelf resolves rather
than storing uuids. Semicolons because dnd5e writes `Rope, Hempen (50 feet)`.

**How many of each is derived, not stored.** One to five, hashed from the pin id and the item uuid: two dead
shops are stocked differently, the same shop shows the same numbers forever, and the GM handing an item over —
another client, another process — reaches the same answer the player was shown without anything being written
down or kept in step. `Torch x5` in the list overrides it.

**Taking is a grant, not a settlement.** It rides the same GM-verified envelope a purchase does, because a
player cannot create an item on their own sheet and should not be able to; but there is no `exchange`,
nothing is paid, and no stock lock is taken, because the leavings are a setting rather than an inventory.

Three checks stand between a click and an item:

1. **Who is asking** — `_validateShopper`, as for any purchase.
2. **What is being taken** — the uuid is matched against the resolved list. This is the one place in the
   module where a client names an item and something is created from it; without the check, *Take* would
   grant any uuid in the world to anybody who could open a dead shop.
3. **Whether it is still there** — a dead shop empties, and the pin records it.

The write-off happens **before** the hand-over and is undone if the grant fails. The other order can hand the
goods over and then fail to write it down, which is the same hole as granting before charging — and here it
leaves an item that can be taken again. A take with no pin is refused outright: the pin is the only place the
emptying can be recorded, and a take that cannot be recorded is an infinite barrel.

### What the pin looks like

World settings under *Shop Aesthetics → The Map Pin*: shape, size, colours, border, drop shadow, and every
text option Blacksmith's own Configure Pin window offers. Two rules worth knowing:

- **The height of a free-aspect pin is Blacksmith's rule, copied verbatim.** A circle and a square are square;
  a rectangle or an icon-only pin takes the picture's natural proportions against the chosen width, and a
  Font Awesome icon has no natural size so it stays square. A pin made by our button and a pin edited in
  their window have to come out the same shape — two rules for one number is how a setting ends up looking
  like it did not take.
- **The picture is ours whatever a saved design says.** *Pin picture* chooses between the category icon, the
  portrait and the illustration, with fallbacks; Blacksmith's per-user *Default for [type]* design wins on
  everything else, because somebody took the trouble.

**Placement is ours too.** Blacksmith has no picker, and its `dropCanvasData` path reads only text, image,
size, style, config and ownership — not tags, text layout or drop shadow — so a dropped pin would silently be
plainer than a placed one. Pressing the button arms a crosshair with a ghost; the click converts through
`canvas.stage.worldTransform.applyInverse`, which is Foundry's own conversion and survives panning and zoom.

---

## 11. Regions: walk in and the shop opens

A third door. A GM draws a region, adds an **Open Shop** behaviour and names the merchant; a token moving
into the region opens the counter for whoever moved it.

**Foundry's own extension point, not a patch.** A namespaced sub-type in
`CONFIG.RegionBehavior.dataModels` plus a `documentTypes` declaration in `module.json` is the whole
mechanism — nothing in core is wrapped, and the config sheet renders our schema unaided:
`region-behavior-config.mjs` walks any third-party model and emits every field whose
`constructor.hasFormSupport` is true, which `DocumentUUIDField` is.

Four things about it are not obvious, and each cost something to find out.

### It must be registered at `init`, and Merchant starts at `ready`

Everything else here waits for `ready` because it needs Blacksmith. This must not: Foundry constructs a
scene's `RegionBehavior` documents well before `ready`, and one whose sub-type it does not yet know gets a
`system` that is not the model. The first thing to ask that object for `_getTerrainEffects` is Foundry's
own movement planner — so **every token drag on that scene throws** until the world is reloaded. Registering
late is not late, it is broken. It has its own `init` hook and needs no `game`.

### Field labels are named, not inherited

`LOCALIZATION_PREFIXES` is resolved by `Localization.#localizeDataModels`, which walks
`CONFIG[...].dataModels` and *then* fires `i18nInit` — and `i18nInit` runs **before** `init`. A model a
module registers has already missed that pass, so its prefixes are never applied and every field renders
with no label at all. Core's own behaviours can rely on the prefixes; a module's cannot. Each field names
its key directly, which works whatever the order.

**`typeLabels` is load-bearing for the same reason it is easy to skip:** the sheet uses it as the legend of
the fieldset it builds for our schema, so leaving it unset gives the GM a nameless box.

### `tokenMoveIn`, not `tokenEnter`

`tokenEnter` also fires for a token *created* inside the region and for one teleported in — a shop opening
because the GM placed a token. The trigger is fixed rather than offered as a choice; if a GM ever needs the
choice, `_createEventsField({events: [...]})` restricts what can be picked.

### It opens on one client, and refuses out loud

A region event fires for **every** client. Opening a window for the whole table because one player crossed a
threshold is the sort of thing that gets a module turned off, so the handler returns immediately unless
`event.user.isSelf`. The GM is deliberately not excluded: a GM moving a token into a shop is visiting a shop.

Only a **linked** merchant may be named, the same rule a pin follows and for the same reason — an unlinked
Actor is the mould its tokens are cast from, with no stock of its own. That is refused twice: a `validate`
on the field, so a GM finds out while looking at the region rather than a session later, and again on the
way in, for a region configured before the check existed or an Actor unlinked afterwards. Every refusal
says so to the person standing in the region — the GM gets the reason, everybody else gets *there is nothing
open here*, because the person who finds out should not be the one who cannot fix it.

---

## 12. The catalogue: a shop as an object

A token, a pin and a region are all *places*. You reach the shop by being somewhere. The catalogue is the
fourth door and the only one that is not a place: an **Item** in somebody's pack that opens the shop from
wherever they are reading it.

**It is an Item because the fiction already has one.** A party who bought a catalogue can lose it, sell it,
lend it to the rogue, or leave it in an inn — and every one of those is something an Item does for free, in
front of the players, with no rule of ours attached. A journal, a macro or a chat button would be the same
feature with a worse story and more machinery.

It is a dnd5e **consumable**, which is not a comment on the fiction: consumable is the item type the system
gives activities to and does not otherwise interfere with. Nothing is consumed — the activity configures no
consumption — so consulting one a hundred times leaves the same one catalogue.

**What it stores** is the merchant's uuid and a snapshot taken when it was printed: name, category, blurb,
tint, illustration, portrait. The same `shopSnapshot` a pin takes, and for the same reason — a deleted Actor
takes its configuration with it, and a catalogue for a shop that has closed down opens on the abandoned card
under the name it was printed with rather than failing.

**Only a linked merchant may be catalogued.** The same rule as a pin, asked through the same function: a
catalogue outlives tokens and scenes, so what it names has to.

**Two ways in, and both are needed.** Using it is the one players find: dnd5e fires `dnd5e.preUseActivity`,
and returning `false` there cancels the roll — no chat card, no consumption, just the shop opening. That is
Merchant's only `pre*` hook and the only one registered with `canCancel: true`; only an explicit `false`
cancels, which is what keeps it from vetoing operations world-wide. The sheet header button is the one that
always works: an activity can be deleted, a system can rename its hook, and a GM inspecting a catalogue in
the sidebar has no character to use it as.

**A catalogue is placeless, deliberately.** A shop you stand in front of is priced against the scene it
stands on — the local market rate, and the party's standing here. A catalogue is explicitly about *not* being
there, so it names no scene and prices at the default market. Handing it the reader's own scene would price a
shop in another town against the market where the reader happens to be standing, and the GM side would refuse
that claim anyway: `verifiedScene` honours only a scene the merchant actually has a token on. A window
showing one figure while the settlement charges another is worse than a plain answer.

It resolves to `openForActor`, exactly as a pin does. One shop, one window, one cart, whichever door.

---

## 12a. Mail order

A **catalogue shelf** is a warehouse rather than a counter: nothing on one changes hands where you are
standing. Ordering from one takes the coin now, and the goods come later by a service the buyer chooses and
pays for. That is what earns the delay and the fee, rather than bolting them onto a shop that could
perfectly well have handed the thing over.

The catalogue shipped in 13.3.0 as *the shop reached from elsewhere*, which is the wrong thing: a party
carrying six of them never travels to a market again. **The abuse is the point** — once a party can have a
crate sent to a place of their choosing they will use it to move things that are not shopping, and that is
the reason to build this rather than a faster buy button.

### A shelf type, not a flag on an item

`catalogue` sits in `INVENTORY_TYPES` beside General, Back Room, Premium, Negotiate and Buyback, so
stocking, restocking, markup and visibility all come with it and are not written again. "Fewer items" falls
out of somebody choosing what goes on the shelf.

A per-item flag was the obvious alternative and is worse for a reason that would not have shown up until
late: a flag on a stock row counts towards **merge identity**, so it would have needed
`registerTransientFlag`, and until that write landed two identical potions would stop stacking. That
surfaces as a shelf growing three of something with nothing in the code saying why.

`getInventories(actor, { catalogue })` is the whole separation: `true` for the catalogue view, `null` for
Merchant Settings, and — in the shop window — `null` for a GM but `false` for everybody else.

**A warehouse is invisible to a customer and visible to the shopkeeper**, and that asymmetry is not a
compromise. Stocking happens in the shop window: the drop zones, the compendium search, the restock button
and the tidy button are all there and none of them are in Settings. A warehouse a GM could configure but
never fill would be a shelf that only worked by accident. So the GM sees it, marked *By order*, with no Add
button on its rows.

**The refusal does not rest on the button being hidden.** `_processSettle` turns down any line that came off
a catalogue shelf, because the one client that can now see a warehouse row at the counter is the one that
owns the shop. `_processOrder` makes the same check in reverse: every line must have come off a catalogue
shelf, since a client names the rows and is not trusted about which kind they sit on.

### The receipt is the parcel

**One Item, twice.** Ordering creates a **receipt** in the buyer's possession carrying the whole
consignment; when the clock reaches the arrival time that same Item is renamed and filled — it becomes the
parcel it was promising.

It is created as a **container from the outset**, empty, rather than converted on delivery: an Item's `type`
is not a thing to change under a system with opinions about subtypes, and an empty container is what a
receipt is.

This is where a pending order lives, and it is a better answer than a queue in a flag somewhere: it is an
object the players can see, it survives sessions and the merchant being deleted, and it can be lost, sold,
stolen or found.

**It carries item source data, not uuids.** This is the decision the robustness of the feature turns on. A
uuid dangles the day the merchant is deleted or the shelf is cleared, and a parcel whose contents
evaporated because a shop closed down is the worst possible bug for a feature whose entire subject is
things being in transit. The goods **left the warehouse** when the order was placed.

### Ordering is its own operation

`_processOrder`, not a flag on `_processSettle`, because **nothing is exchanged**. A settlement is goods one
way and coin the other in one atomic `exchange`, precisely so both legs commit together; an order has one
leg. Squeezing it through the same path would mean a settlement that sometimes moves no goods, a condition
every line of that function would then have to carry.

What it shares, because these are not negotiable: the caller is the **verified** `User` the envelope handed
over; the goods are priced **on the GM** from the merchant's own rows; and the fee is read from the world
setting rather than taken on trust. It also checks that **every line came off a catalogue shelf** — the
client names the rows and is not trusted about what kind of shelf they sit on, or an ordinary row could be
ordered by post and quietly leave the shop without anybody carrying it out.

### Arrival, and `api.worldClock`

`schedule({ at, gmOnly: true })` — and this is the case that API's decline anticipated. It was evaluated and
declined on 2026-08-21 for trading hours and restocking, correctly, because neither is a moment. The note
left behind said to revisit *"if a genuine wall-clock event appears"*. A delivery arriving is one.

Three things from their page this obeys:

- **Schedules are not persisted**, so pending deliveries are re-registered on `ready` by walking the
  receipts, which *are* the queue. The clock is a notification surface and says so.
- **`gmOnly: true`**, because delivering writes to the world; without it five connected players deliver the
  same parcel five times.
- **Nothing fires retroactively**, so anything already due when the world opens is delivered on the spot
  rather than scheduled into the past.

Also worth knowing: **rewinding time re-arms a one-shot**, so a GM correcting the clock backwards past a
delivery will see it arrive again.

**A receipt is `loot`; a parcel is a `container`.** The receipt was originally created as an
empty container, on the theory that an Item's type is not a thing to change under a system with
opinions about subtypes. That reasoning was about the code and ignored the sheet: dnd5e files
containers in their own section, so a promise of a delivery sat among the party's backpacks
looking like a bag you could put things in, days before there was anything in it. The type is
changed on arrival instead, with **`==system`** in the update: Foundry refuses to change a type
while merging system data, and rightly — the incoming half-object would be merged into a schema
that no longer applies, leaving a container carrying a loot item's fields. The `==` prefix
force-replaces that one branch, which is exactly the claim being made. If a system ever refuses, the
fallback rebuilds it under **the same id**, which is what the schedule and the courier both hold.

**`grantItem` cannot build the parcel.** It refuses a packed container — the `CONTAINER_HAS_CONTENTS`
refusal Merchant already reports quietly on restocks, because a copy would have to invent the contents or
drop them. A parcel is a packed container by definition, so the contents are created as documents with
`system.container` pointing at the receipt, which is how dnd5e nests an item anyway.

### Where a parcel can go

**Two questions, answered in two different places, and keeping them apart is the whole of it.**

- *Is this shop somewhere a parcel can arrive?* Two flags on the merchant — `deliveryPhysical` (it will
  hold a Ground parcel for collection) and `deliveryPortal` (there is a ring in the back room). Both are
  offers a shopkeeper is making, so both live on the shop, and both are off until a GM says otherwise: a
  pedlar on a road is neither.
- *Where else can a parcel go?* Two **world settings**, `deliveryPlacesPhysical` and `deliveryPlacesPortal`,
  free text one place per line. An inn, a guard post, a name the party made up — none of which is a
  document, and requiring one would be requiring a GM to build a shop for a hole in a wall.

The picker is the world's flagged shops plus the world's list, and the GM side verifies against exactly the
same set. These began as two text boxes on **each merchant**, which was wrong on inspection: it made a GM
retype the same coaching inns into every shop that sold by post and left five copies free to drift apart.
Where a parcel can arrive has nothing to do with who posted it.

A **courier beast** asks for nowhere at all, and that is an answer rather than an empty list: it goes
looking for whoever is holding the receipt, which is what its price buys.

**Opening it empties it.** *Open Parcel* on the sheet header clears `system.container` on each of
the contents and then deletes the box — contents first, because dnd5e takes a container's contents
with it when it is deleted. The header rather than an activity: a container has none, and dnd5e
gives activities to consumables and weapons rather than to boxes. The same click on a *receipt*
answers where the parcel is instead, which is what the object means at that moment.

### The crate, and collecting it

**Arriving and being handed over are two different events, and only the beast collapses them.**
A parcel sent to a *place* reaches the place and waits on a shelf behind a counter; the owner is
told it has landed, and consulting the receipt asks the GM whether the party are standing there.
Only the GM can answer: a scene is not a location, and a party can be on a world map or in a
conversation with no map at all. Everything else — the item exists, it is a consignment, it has
not been collected, its moment has passed — is checked on the GM side as always. The GM is
answering a question about geography, not vouching for the request.

**A crate is a real object**: 5 lb empty, 50 lb of capacity, 2 cubic feet, 5 gp. Before this it was
weightless, priceless and unlimited, which quietly made mail order the best bag of holding in the
game. There is no weight reduction and nothing extradimensional, so a heavy order needs several
crates — `packCrates` is a pure first-fit packer that splits a heavy stack rather than bumping it
whole, and sends a single item heavier than a crate alone rather than refusing the order.

**The packing is recomputed, never stored.** It runs on the client to price the slate, on the GM to
take the money, and at delivery to fill the boxes. Storing the grouping would be a second copy of
the manifest, free to disagree with the first; a pure function on frozen goods gives the same
answer all three times, which `tests/test-mail.mjs` asserts.

**The deposit is one-sided on purpose.** The party pay for the boxes with the goods and are refunded
when they send them back. Nothing is credited to a merchant, no till is checked, and a shop that has
been deleted changes nothing — modelling the shop's half would mean a refund that can fail because a
business closed. Keeping a crate strips the consignment flag: it stops being a parcel and becomes an
ordinary crate with no action of ours on it.

### What goes through the inventory API, and what does not

Audited on 2026-08-30, after the mail-order path was found doing three things by hand that the hub
does better.

**Through the API, always:**

- **The goods in a parcel** — one `grantItems` for the whole delivery, each entry naming its own crate
  via the per-entry `container`. The first cut built the documents directly on the grounds that
  `grantItem` refuses a packed container; that refusal is about *copying* a container that has
  contents and says nothing about granting **into** one. Doing it by hand meant hand-stripping shelf
  flags (`omitFlags` does it), writing the containment (the API writes it) and losing merge identity —
  three behaviours reimplemented worse to dodge a refusal that was never in the way.
- **The crate deposit coming back** — `grantCurrency`. A raw `actor.update()` is a total computed from
  a read taken outside the lock; land it between another operation's read and its write and it is
  silently discarded, which for a settlement in flight means the refund is simply gone.

**Directly, with a reason:**

- **The receipt becoming a crate** — a type change on an existing document. There is no primitive for
  it and there should not be.
- **The extra crates** — created directly because their ids are needed before the contents can name
  them, and an empty container has no merge behaviour worth the round trip.
- **Emptying a crate** — `system.container` cleared on each row. The API moves things *between actors*;
  moving between containers on one actor is not something it offers, so this is a direct update rather
  than a primitive avoided.
- **Setting a till when Blacksmith has no `setCurrency`** — a documented fallback that predates this
  audit. The race is real and rare, and refusing to set a till at all would be worse.

### Lost packages

**A receipt nobody is holding is a lost package.** The courier looks for whoever has the receipt; if the
Item has gone — deleted, or moved off an Actor — there is nobody to give it to. The GM is told what was in
it, because a lost parcel is a plot rather than an error.

**Nothing is refunded.** Whether the party get their money back is the GM's to decide, and a system that
quietly handed it back would take the decision away from them.

### What phase 1 does not do

Depot pins and selling by post. Where a parcel physically sits is described rather than placed: the three services differ in **days** and **fee**, and
everything else about them is fiction the GM narrates. See `../TODO.md` §1.

---

## 13. The token marker

A merchant token is visibly a merchant, and visibly *what kind*, without anyone double-clicking to find out.
The glyph is the category's own icon and the colours are the pin's — the mark on a token, the pin on the map
and the badge on the card are one vocabulary, learned once.

**Drawn as a child of the Token placeable**, which is most of the work done for free: it moves with the
token, scales with the scene, and vanishes when the token does, because PIXI does not render the children of
an invisible container and Foundry already sets `visible = false` on a token you cannot see. A separate
canvas layer would mean reimplementing visibility, elevation and hidden-token rules that already exist and
are easy to get subtly wrong. `eventMode = 'none'`, so the badge cannot eat the double-click that opens the
shop it advertises.

**The glyph is asked for, not tabulated.** The obvious implementation is a table mapping `fa-flask` to a
codepoint, seventeen entries of it — a table somebody has to keep in step with Font Awesome, transcribed by
hand, where one wrong digit is an icon that renders as something else entirely and nothing in the code says
why. Instead a hidden probe element carrying the class is appended, its `::before` computed style read for
the character and the font, and the probe removed. The browser already knows the answer; it is what it uses
to draw the same icon everywhere else in the module. Cached on success only — before the font loads the
computed content is `none`, and caching that would blank the markers for the session.

**A zoom threshold, not a constant.** A badge legible on one token is noise on twenty: zoomed out to a whole
market square it is a wall of glyphs over the map the GM drew. So there is a floor, it is a setting, and zero
means always.

Markers are refreshed at registration as well as on `canvasReady`, because Merchant starts at `ready` — after
the first canvas draw — and without it the markers would appear on the second scene a GM visited, which reads
as them not working.

---

## 14. The shop full screen

A per-client, per-shop toggle that presents the shop as a viewport-covering surface with its own
illustration as the room.

**It is Blacksmith's `BlacksmithFullscreenWindowBaseV2`**, with the `centered` layout and the shop's
illustration handed over as `fullscreenBackdrop` — `cover` fit, at half opacity under a heavy black wash. The covering, the blocking, the stacking, the fade and the
backdrop layer are the hub's; Request a Roll's cinematic is the same class. Merchant owns what stands on the
surface and nothing else.

**The first version of this was wrong, and the way it was wrong is worth keeping.** It measured the free
rectangle between the sidebar, the scene controls and the hotbar, resized the ordinary tool window into it,
and imitated a takeover in CSS. That is *maximise* — something anybody can already do by dragging a corner —
and it looked it: a parchment panel with a title bar, the map still showing around it, and the shop's
furniture marooned in a field of empty background. Two hundred lines of stylesheet reimplementing, worse, a
component that already shipped.

**One class body, two bases.** `ShopBehaviour` is a mixin, and the two shells are
`ShopBehaviour(BlacksmithToolWindowBaseV2)` and `ShopBehaviour(BlacksmithFullscreenWindowBaseV2)`. Everything
a shop does — the slate, the drop zones, the price editors, the search, the presence mirror, twenty-five
action handlers — is written once. What differs comes to a few dozen lines: the layout, the backdrop, and
mapping the tool footer's zone names onto the action bar's.

The consequences of there being two classes, each of which had to be answered:

- **Slate state moved to module scope.** A static in the mixin is initialised once *per subclass*, so a
  half-filled cart would vanish the instant somebody pressed the toggle. One map, two doors.
- **A registry that spans both shells.** The tool base's is per-subclass and cannot see the surface, so
  anything refreshing *all* shops walks `_liveWindows` instead — otherwise a player standing in an expanded
  shop stops being told about price changes.
- **The route is decided once.** `ShopWindow.openFor` checks whether this client left that shop full screen
  and hands off. A token, a pin, a region and a catalogue all go through it, so none of them has to know.
- **The door stays quiet during a swap.** Closing one shell and opening the other would play the closing
  sound and then the opening one every time the button was pressed — the shop announcing a change of window
  rather than a change of room.

### Which shell a shop opens in

**The merchant's answer, against the door you came through, and nothing else.**

*How you arrived* is part of how a shop should be presented, and the four doors are genuinely different
experiences: walking into a region is being in the place; clicking a token is a shopkeeper on a map you are
still using; a pin is a mark on that same map; a catalogue is a book in your pack, opened without going
anywhere. A merchant answers **each of them separately** — four switches in Merchant Settings, named after
the doors. None ticked is a window, which is what a shop is unless it has earned the screen.

Two versions of this were wrong before it settled, and both are worth recording.

**A single dropdown of *never* / *regions only* / *always*** treated the useful answers as an ordered scale.
They are not: a GM who wants the region **and** the catalogue full screen but not the token has no entry on
that scale, and the middle option had to be given a name — "when walked into" — that describes a mechanism
rather than a door. Four switches named after four doors need no explaining.

**A per-client memory of what each person last left a shop as**, which beat the merchant. That is the wrong
model of what the toggle means: pressing Leave Full Screen is *"not right now"*, not *"never show me this
shop that way again"*. A GM who dresses a shop and points a region at it would have found half the table
never seeing it, for a reason none of them could see. **The setting is the setting.** The toggle still
changes the shell you are in, for as long as you are in it; the next time the shop opens, the merchant
decides again. `utility-expand.js` and its client setting are deleted.

Every door names itself (`door: 'region' | 'token' | 'pin' | 'catalogue' | 'sheet'`) and none of them knows
the rule. Merchant Settings' own *Open Merchant* button counts as the token door: it is the GM opening the
shop directly, which is what clicking the token is. `opensFullScreen(doors, door)` is pure, so the rule is
stated once and checked in `tests/` — including that anything which is not an explicit `true` for that exact
door is a window, a stored shape from an older version included.

**The `centered` layout, not `full`.** `full` hands you the whole surface with no chrome, and the shop
painted straight onto a lit scene is unreadable — rows floating over a picture. `centered` is the shape this
wants: the art edge to edge behind, and the shop on a ground of its own in the middle of it. The panel takes
`--blacksmith-fullscreen-max-width` at 1180px and no padding, since the shop brings its own.

**The palette has to be declared, and this is the trap worth remembering.** The shop's stylesheet reads ten
`--blacksmith-tool-*` tokens. The tool shell declares them under `.application.blacksmith-window-tool`, and a
**frameless application never receives the `application` class** — which is why the hub's own fullscreen rules
are written as a bare `.blacksmith-window-fullscreen`. Putting the tool class on this window therefore did
nothing: the shop rendered with no surfaces, no dividers and no text colour, over a panel whose background
token was equally undefined. They are declared for the surface in `window-shop.css`, in Blacksmith's own
**dark**-tool values: a parchment card is right in a window on a grey canvas and wrong in front of a lit
scene, where it competes with the room instead of sitting in it.

**The ✕ and Escape leave the surface; they do not close the shop.** `onDismiss(reason)` is the documented hook
for exactly this — the *viewer asked for this to go away* path, deliberately separate from `close()`, which is
every other route: a socket, a timer, the manager closing a shop whose merchant was deleted. The first version
turned both controls off to protect a half-built slate, which is the worse answer: turning off the way out of
a takeover is not safety.

**Action-bar content is the hub's contract, not a convention here.** `blacksmith-window-btn-secondary` (also
`-primary`, `-critical`) with a `data-action` naming an `ACTION_HANDLERS` entry, in the `actionBarLeft` and
`actionBarRight` zones. The tool shell's footer states the same buttons once in `getData`; the surface maps
the zone names rather than the shop knowing which shell it is in.

It is deliberately **not** called `maximize`: ApplicationV2 has that method already and it means
"un-minimise".

---

## 15. Blacksmith is not optional

Merchant does not function without it, and this is deliberate — the alternative is forking components, which
has cost this suite real time twice. What is used:

| API | for |
|---|---|
| `inventory.exchange` | the entire transaction |
| `inventory.registerTransientFlag` | `par` and `inventory` surviving transfers |
| `tokens.registerInteraction` | double-click to open, with the permission bypass |
| `BlacksmithToolWindowBaseV2` | both windows, including `openFor` and its per-subclass registry |
| `dialog.confirm / choose / wait` + `controls` | every prompt |
| `entityList`, `quantitySplit`, `uiContextMenu` | embedded controls |
| compendium search window | stocking an inventory by hand |
| `compendiums.query` | a shelf that stocks itself from what is installed — feature-detected, §4 |

**`limit` caps the output; the scan is always complete.** Worth knowing because the obvious reading
is the wrong one, and being wrong about it is undetectable: `search()` takes a *stop-scan* limit, and
a query built on that assumption would draw every shop's stock from the first configured pack and
never open the sixth — producing a result set indistinguishable from a correct one. Blacksmith
corrected our proposal on this before any of it was written. `queryDetailed().scannedSources` reports
the whole order when the question is which packs actually answered.

An entry whose type has no rarity or price field — a spell, a class — **fails** a filter on it rather
than passing unfiltered, so a price range plus a non-physical type returns nothing, deliberately.
| `dialog.pickActor` | choosing who is shopping |
| `sockets` | slate mirroring and refreshes, module-prefixed — `utility-sockets.js` |
| `pins` | a shop's second door: create, click, taxonomy, and the record of what has been taken — §10 |
| `compendiums.resolveMany` | the leavings of an abandoned shop, by name |
| `toast` | every message the module shows |
| `utils.playSound` + `arrSoundChoices` | the sound settings |

**Nothing calls `ui.notifications` directly.** Two exceptions, both deliberate: the fallback inside
`utility-feedback.js`, for a Blacksmith too old to have the toast API — a world one version behind should
lose the styling, not the message — and the restock progress bar, because a toast has no progress shape and
core's does. Everything else goes through `notify`.

### Sounds

Six world settings, played **locally**. World-scoped because a shop's voice is set dressing and belongs to
whoever built the scene; played locally because broadcasting would mean the whole table hearing somebody
else drop a rope into their own slate. All default to silent — a module that starts making noises nobody
asked for is a module people switch off.

`notify.error()` plays the error sound itself rather than leaving it to twenty-odd call sites, one of which
would eventually forget. The transaction sound rides on the receipt toast rather than being played beside
it, so the sound and the thing it announces cannot come apart.

**Never fork a Blacksmith component.** A copy taken before a fix keeps the problem the hub has solved and
can never pick up anything landing later. To check: compare filenames against `coffee-pub-blacksmith/scripts/`;
a shared name is the tell.

**Read the whole page for any API you call more than once.** Grepping a doc for a keyword and concluding
there is no guidance has produced two separate defects in this module — see `CONTRIBUTING.md` §3, which
is the shortest document here and the one most worth reading before writing anything.

---

## 16. Known seams

- ~~**No expand affordance on Blacksmith's standard window base**~~ — **closed 2026-08-28: there was one,
  and it was read wrong.** `BlacksmithFullscreenWindowBaseV2` was written off here as a blocking takeover
  for handouts, which is what its *default* layout is for. `fullscreenLayout: 'full'` is documented in the
  same table as "edge to edge, no panel chrome, you own the whole surface", and `fullscreenBackdrop` takes
  an image, a fit and a scrim. That is the whole feature, already shipped. Merchant reimplemented it,
  worse, in two hundred lines of stylesheet before reading the page properly. §14.

  **The lesson is why this entry is kept.** The API doc was pointed at explicitly and then skimmed for a
  class name rather than read for its options. A base class is not one thing; its layouts are.
- **Blacksmith has no pin placement picker.** Merchant arms its own crosshair and converts the click itself,
  which is a dozen lines and works — but Squire and Curator will want the same the moment either drops a pin,
  and a `pins.pickLocation()` in the hub would be one implementation of the fiddly half (cancel, escape,
  right-click, the canvas menu that must not open). Worth offering rather than asking for.
- ~~**An uncurated pack is listed but not yet drawn from**~~ — **closed 2026-08-28, by not asking.**
  `compendiums.query` filters a requested source against the curated set, so `sources` can only ever
  *narrow* it — which is backwards for the one thing a custom list is for. Rather than wait on the hub,
  Merchant reads the indexes of a named pack itself; see §6a. The curated path is still the hub's, because
  its relevance ordering and world-item handling are worth having and a custom list needs neither.

  **The ask is withdrawn rather than outstanding.** It was never quite the hub's question: "search what
  this world uses" and "read these specific packs" are two different jobs, and the second one is thirty
  lines of index scan that needs no shared vocabulary at all.
- ~~**`gm-request.js`** — a bridge, and the caller identity it could not verify~~ — **closed 2026-08-21.**
  The file is deleted and `blacksmith.gmRequest` hands the handler a `User` resolved from the authenticated
  socket. It was described as a deletion rather than a rewrite from the day it was written, and that is how
  it went. §8. The rule it leaves behind: **never read an identity out of a payload.**
- ~~**`setTillGold`** writes currency directly~~ — **closed.** It goes through `inventory.setCurrency`,
  which takes the lock. The historical reasoning is kept below because the boundary it establishes still
  governs: **the question is not whether an operation has a counterparty, it is whether the Actor takes
  part in locked operations.** A shop does.

  The raw write survives only as a fallback for a Blacksmith without the primitive. The race it used to run:
  `exchange` reads the balance under the lock, an unlocked write lands, `exchange` then writes
  `current + delta` from a read that is now stale — the GM's edit disappears or the shop's money is wrong,
  and neither leaves a trace.

  Only `gp` is named, so the rest of the purse is left alone rather than zeroed — the field is "gold to
  spend", not "the whole purse".
- ~~**One extraction left**~~ — **closed 2026-08-22.** `dialog.pickActor` shipped and `changeRecipient`
  calls it; the private copy and `plans/plan-extraction.md` are both deleted. Every candidate the exercise
  raised has now either landed or been withdrawn.

  Two behaviours went missing in the move and are asked for upstream: the picker opens on the **first**
  actor rather than the current one, and it no longer badges anyone with lines already on a slate — which is
  how a GM learned somebody was mid-purchase before it occurred to them to switch and look.
  `entityList` still supports badges; `pickActor` does not forward them. Neither is fatal and both are one
  option away.
- **Synthetic actor uuids are a documented target** for `api.inventory`, confirmed 2026-08-22. The lock keys
  on the **resolved actor**, not the string passed, so two unlinked tokens sharing a base Actor take separate
  locks — two copies of one travelling salesman are two shops and two players can trade with them at once.
  Merchant depends on this: `worldMerchants()` hands synthetic actors to every restock.
- ~~**`api.inventory` refused to merge stacks that should have merged**~~ — **closed upstream 2026-08-22.**
  The predicate compared the payload submitted against the row that already existed, but the row a payload
  *becomes* is not the payload: creation fills schema defaults, writes `system.identifier` from the name and
  normalises `properties`. Merchant saw it as duplicate rows on every restock. **Nothing here was written to
  work around it** — a roll adds new products only, which is a rule about what a restock means and stands on
  its own — but the drop path does merge, and it is now reliable.
- ~~**Scheduled restocking does not reach unlinked tokens**~~ — **closed 2026-08-22.** See
  `worldMerchants()` in §4.
- ~~**Refreshes ride a raw `game.socket` channel**~~ — **closed 2026-08-23.** `utility-sockets.js` puts
  slates, presence and refreshes through `blacksmith.sockets`, which wraps SocketLib with a native
  fallback. This was the last place Merchant talked to core directly on a surface Blacksmith owns.

  **The semantics did not change, which is the part that mattered.** Their `emit()` with no options maps to
  `executeForOthers`, so it does not echo to the sender — the rule `game.socket.emit` follows and the one
  every handler assumes. A swap that quietly delivered our own slate back would have shown a player their
  own list arriving as somebody else's.

  **Four event names rather than one channel demultiplexed on `action`**, and every one module-prefixed:
  Blacksmith keys external handlers in a flat Map shared by all consumers, so an unprefixed `slate` would
  silently overwrite another module's, with no error and no way to tell. The fallback for a Blacksmith too
  old to publish `sockets` keeps the exact wire shape the raw channel used. Both paths are pinned in
  `tests/test-sockets.mjs`, because neither is visible without two clients.
- ~~**No i18n**~~ — **closed 2026-08-23.** 309 keys in `lang/en.json`, and `tests/test-i18n.mjs` holds the
  line: every key asked for exists, every key defined is asked for, one namespace, no empty values, and
  anything containing `{placeholder}` is reached through `format` rather than `localize`.

  **What is deliberately still English.** Hook descriptions passed to `BlacksmithHookManager`, and every
  `console.warn`/`console.error`. Those are read by whoever is debugging, not by whoever is playing, and
  translating them makes a stack trace harder to search rather than easier to read.

  **`const.js` is localised at the point of display, not at definition.** It is evaluated before `game.i18n`
  exists, so a `localize` call in `INVENTORY_TYPES` would resolve to the key or throw. The literals in the
  table are the source text *and* the fallback; `inventoryTypeName`, `inventoryTypeHint`, `depthLabel` and
  `depthHint` read the translation when the string is shown. A world with no translation for a type reads
  English rather than a key, which is the failure mode worth having.

  **Sentences are one key, never a concatenation.** The reputation line was three text fragments around two
  `<strong>` interpolations; a translator got three clauses with no way to reorder them, and a language that
  puts the effect first could not express it at all. It is now one key with `{band}` and `{effect}`, built in
  `window-shop.js` with both values escaped before the emphasis goes on. The same rule retired four other
  concatenations, and is why "markup" and "discount" are two keys rather than one with a switch inside it.
- **`architecture/` was empty until 2026-08-19.** If you change how any of the above works, change this file
  in the same commit. A map that lies is worse than no map.

---

## 17. Migration — there isn't any

**Nothing migrates, because nothing has shipped.** No world holds a shape this build cannot read.

There was a great deal of it, and it went on 2026-08-24: `LEGACY_INVENTORY_FLAG`, `deriveInventoryType`,
`migrateWorld`, `_migrateConfig` and three passes carrying a `shelf`→`inventory` rename, a
`buybackOverrides` rename, a par backfill and a stock-source stamp. All of it for worlds that cannot exist.

**Two of that week's bugs were in migration code that would never have run** — a doc comment describing the
wrong function, and an id collision between two passes writing the same item. That is the argument against
writing migrations early: they are untestable by definition, and their bugs are found by reading rather than
by running.

`SCHEMA_VERSION` stays, at **1**. It costs one line, and the first release makes it real: from then on a
stored shape that changes needs moving rather than reading around, and the version is what says which world
is which. **Bump it and write the pass in the same commit** — the pass is what the number is for, and a
number without one is a promise nobody kept.
