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
| `scripts/settings.js` | The six sound settings, and nothing else. |

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
    schema: 3,                   // migration stamp — see §12
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
  buyRate: 0.5,                                  // purchased only — what the shop PAYS
  restockDays: 7, lastRestock: <worldTime>, maxProducts: 25, maxPerItem: 20,
  tables: [{ uuid, rolls, auto }] }
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

Schema 4 stamps a par onto every row that lacks one, from what it currently holds — a shop
sitting in a world nobody is shopping in is a shop at rest.

### A roll brings new products, never more of what is already carried

The second, optional half of a restock. Top everything off first, then draw from the tables for
things the shop has newly got hold of.

**A drawn result already on the shelf is skipped entirely.** Topping up is the refill's job and
it refills to the level the GM set; a table adding to the same row would push it past that level
and make the number they typed mean nothing. It was also where duplicate rows came from — two
Torch lines, two Flutes, growing by one set per restock.

`maxProducts` is therefore a **target**, not a clip: a shelf that carries twenty and holds
fifteen rolls for five more, and once it is back to twenty there is nothing left to ask for.

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

`maxPerItem` — *max stack* — and `maxProducts` — *products* — are both on the card now, under
**Stocking**. They answer different questions: how deep one line goes, and how many lines the shelf
carries. Both are enforced on write, and `setStockQuantity` returns `{ value, clamped, maxPerItem }`
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

`migrateWorld` deliberately walks a **wider** set: every merchant Actor *plus* every placed unlinked one. A
template is not a shop, but it holds the flags every token cast from it inherits, so leaving it unmigrated
means every future placement arrives stale.

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

`resolvePrice(merchantConfig, inventoryConfig, item, { reputation })` in order:

1. An **agreed price** for this item id wins outright — that is what makes it agreed. Nothing is applied on
   top of it, in either direction: a haggled number is the number, not the start of an arithmetic.
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
- **Quantity and price edits** are in-place double-click, matching Curator's loot window: Enter or clicking
  away commits, Escape abandons, `0` removes the line. Price edits are GM-only and write to the document.
- **Item tooltips** come from dnd5e's own `richTooltip()` — the same thing Squire uses. Free, and correct.
- `_keepScroll()` preserves scroll position across the re-render that follows every gesture.
- A control that cannot act is **disabled with a reason on hover**, never absent. An absent button reads as
  "this shop does not do that"; a disabled one naming its reason reads as "not right now, and here is what
  would change it".

---

## 10. Blacksmith is not optional

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
| compendium search window | stocking an inventory |
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
there is no guidance has produced two separate defects in this module — see `TODO.md` *Inherited lessons*,
which is the shortest document here and the one most worth reading before writing anything.

---

## 11. Known seams

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
- **One extraction left** — `plans/plan-extraction.md`. `openFor` and `party` both shipped in Blacksmith
  13.19.0 and are adopted here; a fourth candidate was dropped when one of its two consumers turned out to
  have been deleted. What remains is `_pickActor`, agreed and Blacksmith's to build. The plan is deleted the
  day it lands.
- ~~**`api.inventory` refused to merge stacks that should have merged**~~ — **closed upstream 2026-08-22.**
  The predicate compared the payload submitted against the row that already existed, but the row a payload
  *becomes* is not the payload: creation fills schema defaults, writes `system.identifier` from the name and
  normalises `properties`. Merchant saw it as duplicate rows on every restock. **Nothing here was written to
  work around it** — a roll adds new products only, which is a rule about what a restock means and stands on
  its own — but the drop path does merge, and it is now reliable.
- ~~**Scheduled restocking does not reach unlinked tokens**~~ — **closed 2026-08-22.** See
  `worldMerchants()` in §4.
- **No i18n.** Every string is hardcoded English and `lang/en.json` is a stub. See `TODO.md`.
- **`architecture/` was empty until 2026-08-19.** If you change how any of the above works, change this file
  in the same commit. A map that lies is worse than no map.

---

## 12. Migration

`SCHEMA_VERSION` in `manager-merchant.js` is the shape this build writes. **1** was untyped shelves under
`flags["coffee-pub-merchant"].shelf`; **2** is typed inventories under `.inventory`; **3** renames `pricing.buybackOverrides` to `purchaseOverrides`, the last stored word from the old vocabulary.

`MerchantManager.migrateWorld()` runs from the `ready` hook, **GM-only**, and is awaited before anything
reads a merchant. For each shop it has not already stamped, it rewrites every container's flag to the new
key, derives the `type` from what the old settings must have meant, drops `mode`, and deletes the old flag
**in the same update** — so there is never a moment when one container carries two answers.

The derivation is not a guess. Each branch was the only way that state could be expressed before types
existed:

| old state | becomes |
|---|---|
| `mode: 'buyback'` | `purchased` |
| `mode: 'barter'` | `unpriced` |
| `visible: false` | `hidden` |
| `markup > 1` | `premium` |
| `markup < 1` | `discounted` |
| anything else | `general` |

`getInventoryConfig` applies the same derivation on read, which is a belt for those braces: a world whose GM
has not logged in since the rename, a container copied in from elsewhere, or an inventory built by a macro
still reads as *something* rather than as a shop with no settings.

**Stamped even when nothing moved**, so a merchant with no inventories is not re-examined at every load for
the rest of its life. One batched write per Actor, because two writes to one Actor is the shape that trips
dnd5e's encumbrance recompute — and a migration touching every merchant in a world is exactly where that
would show up.
