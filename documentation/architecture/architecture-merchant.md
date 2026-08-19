# Architecture

What the system does and how the pieces fit. `plans/` records why it was built this way and what was
rejected; this file is the map you need before reading either.

Read this first, then `CONTRIBUTING.md` for the conventions the code follows.

---

## 1. The one-paragraph version

An Actor carries a flag that makes it a merchant. Its stock lives in **container Items** on that Actor
called *shelves*. Double-clicking the token opens the shop window, where a player fills a **slate** — things
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
| `scripts/window-merchant-config.js` | Merchant Settings. Shelves, hours, till, tables, presets. |
| `scripts/merchant-pricing.js` | Pure arithmetic: denominations, prices, making change. No documents. |
| `scripts/merchant-inventory.js` | Thin accessors over `blacksmith.inventory`. Deliberately thin. |
| `scripts/merchant-feedback.js` | Everything the module says to a person: toasts and sounds. |
| `scripts/merchant-progress.js` | The restock progress bar. Core's notification, not a toast. |
| `scripts/settings.js` | The six sound settings, and nothing else. |
| `scripts/gm-request.js` | The request envelope. **A bridge, not a design** — see §8. |

`merchant-pricing.js` and the schedule half of `const.js` are the only modules with no Foundry documents in
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
    stock: 'infinite',           // merchant-wide default; a shelf may override
    open: true,                  // only consulted when there is NO schedule
    hours: { open: 9, close: 18 } | null,
    override: { open, against } | null,   // see §5
    pricing: {
        markup: 1.0,
        overrides: { [itemId]: baseUnits },        // agreed buy prices
        buybackOverrides: { [itemId]: baseUnits }  // agreed sell prices
    }
}
```

Read with `MerchantManager.getConfig(actor)`, written with `setConfig(actor, changes)`, which shallow-merges.

### The shelf flag — `flags['coffee-pub-merchant'].shelf` on a container Item

```js
{ order: 0, visible: true, mode: 'sale', markup: null, stock: null,
  restockDays: 7, lastRestock: <worldTime>, maxItems: 25, maxPerItem: null,
  tables: [{ uuid, rolls, auto }] }
```

`null` means *inherit from the merchant*, the same way `markup: null` already did. One schema with three
properties — visibility, markup, mode — rather than five shelf types, so the sixth idea has somewhere to go.
The five presets in `SHELF_PRESETS` are **data**, not code paths.

**The shelf's name is the container's name.** The flag carries no copy of it, so a GM renaming the container
in dnd5e's own sheet renames the shelf. Old flags may carry a vestigial `label`; it is ignored.

### The par flag — `flags['coffee-pub-merchant'].par` on a stock Item

What a restocking shelf refills *to*. There is no separate par editor: a GM setting a quantity by hand in
the shop window sets both the count and the par, so the rule is *"what I keep six of, I restock to six"*.
A purchase lowers the count and leaves par alone.

Because Merchant writes flags to Items that `blacksmith.inventory` moves, both `par` and `shelf` are
registered with `registerTransientFlag` at startup. **If you add a flag that lives on an item, register it.**

**Registering is not stripping.** `registerTransientFlag` makes a path invisible to *merge comparison*; the
flag still rides along in the payload. So `par` leaves with every item bought from a counted shelf and comes
back if the buyer sells it — which is why `getStock` refuses to read a par on a buyback shelf. Blacksmith's
`omitFlags` will stop it arriving at all; the guard stays regardless, for items already out there.

---

## 4. Stock is a count, not a document

Nothing is ever moved off a shelf by a sale in the ordinary sense. Every policy grants the buyer a copy or
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

### Ceilings and restocking

A shelf has `maxItems` (how many distinct rows) and `maxPerItem` (how many of any one thing). Both are
enforced on write, and `setStockQuantity` returns `{ value, clamped, maxPerItem }` so the window can say
what happened rather than silently correcting a number a GM typed.

**Both are ceilings, not targets.** They only ever refuse. Nothing fills a shelf *to* them, and reading
either as "how many I want" is the single most natural wrong assumption about this screen.

How deep a table-rolled row goes is `stockDepth()` in `merchant-pricing.js`, in three steps:

1. **The item's own `system.quantity`**, if it is more than one. A compendium entry authored as a quiver of
   twenty arrows is a quiver of twenty arrows.
2. **The price band** (`STOCK_DEPTH_BANDS`), for types a shop keeps a pile of — `consumable`, `loot`, and
   ammunition. The band caps it and a die fills it, so stocking the same shelf twice gives two shops.
3. **One**, for everything else.

`maxPerItem` clamps the result, so a ceiling a GM set by hand is never argued with by a die. The roll is a
plain integer, not a `Roll` — nothing here belongs in chat.

Restocking is driven by `updateWorldTime` — the same watcher that opens and closes shops, so there is no
second clock. A shelf restocks when `restockDays` in-world days have elapsed. **Advancing a week restocks
once, not seven times**; the watcher compares elapsed time against the interval rather than counting
boundaries. Table-stocked shelves may additionally re-roll on restock, which is opt-in per table (`auto`).

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

All arithmetic is in **base units** (copper, in dnd5e) and converted only at the edges. `merchant-pricing.js`
holds it and touches no documents, which is why 5,151 purse/price combinations can be checked in `tests/`.
`api.inventory` will never convert denominations, so this arithmetic is ours permanently and nobody else was
going to catch it being wrong.

`resolvePrice(merchantConfig, shelfConfig, item)` in order:

1. An **agreed price** for this item id wins outright — that is what makes it agreed.
2. A **negotiate shelf** (`mode: 'barter'`) returns `null`. It has no list price by definition.
3. Otherwise `system.price` × the shelf's markup, falling back to the merchant's.

`resolveBuybackPrice` is the mirror, reading `buybackOverrides` and the buyback shelf's rate.

### Negotiation

A GM double-clicks the price on any slate line and names it. The figure is written to the **merchant
document**, never carried in the settle request: a price is the one number in a transaction a player must
not be able to name, and a slate is client state.

- An unpriced line shows **TBD** and settling refuses while any line is still TBD.
- On settle, an item that had **no price of its own** is stamped with what was agreed, so a curio
  negotiated at 200 gp can be sold on for 200 gp. An item that **had** a price keeps it — a longsword
  bought cheap is still worth what a longsword is worth.
- Agreements are **cleared once the trade they were made for settles**, so a discount does not quietly
  become the shelf price for the next party.

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
    │  3. _priceSelling      — ditto, against the buyback shelf
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

`gm-request.js` is built on Foundry v13's query API — `CONFIG.queries` plus `game.users.activeGM.query()`.
Request ids, the pending map, the timeout and response routing are all core's, and `game.users.activeGM` is
core's own single-GM designation, so every module agrees on which GM acts.

**The envelope routes and elects; it does not authorize.**

It has one defect, and it is not ours to fix. Foundry *does* know who called — `#handleUserQuery` resolves
the querying User from the authenticated socket — and then drops them without passing them to the handler.
So Merchant asserts the caller id in its own payload, which is precisely the step that turns a verified
identity into a client-supplied one. **Do not build a mitigation for this.** When Blacksmith's surface lands,
`userId` comes out of the payload in the same change and this file becomes a deletion rather than a rewrite.

---

## 9. The shop window

`window-shop.js` extends `BlacksmithToolWindowBaseV2`, which supplies the titlebar, footer, position memory
and micro-titlebar folding. One window per token, held in a static map, so double-clicking twice focuses
rather than duplicates.

**The slate** is two `Map`s of `itemId → quantity` — `cart` (buying) and `basket` (selling) — held on the
window instance, never persisted. `_cartLines()` and `_basketLines()` turn them into render context, and
that is where stock trimming, TBD lines and totals happen. Both re-resolve from documents on every render,
so a shelf emptied out from under a standing slate trims the line instead of failing the checkout.

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
| `inventory.registerTransientFlag` | `par` and `shelf` surviving transfers |
| `tokens.registerInteraction` | double-click to open, with the permission bypass |
| `BlacksmithToolWindowBaseV2` | both windows |
| `dialog.confirm / choose / wait` + `controls` | every prompt |
| `entityList`, `quantitySplit`, `uiContextMenu` | embedded controls |
| compendium search window | stocking a shelf |
| `toast` | every message the module shows |
| `utils.playSound` + `arrSoundChoices` | the sound settings |

**Nothing calls `ui.notifications` directly.** Two exceptions, both deliberate: the fallback inside
`merchant-feedback.js`, for a Blacksmith too old to have the toast API — a world one version behind should
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

- **`gm-request.js`** — a bridge. Deletion, not a rewrite, when Blacksmith forwards caller identity. §8.
  **The contract is settled**: the envelope hands handlers the resolved User, and consumers must never read
  an identity out of a payload. Our `userId` field comes out in the same change that adds it.
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
- **Three extractions to Blacksmith**, each with two consumers proving the shape — `plans/plan-extraction.md`.
  A fourth was dropped when one of its two consumers turned out to have been deleted. Nothing is blocked on
  any of them, and two of the three are Blacksmith's own to build.
- **No i18n.** Every string is hardcoded English and `lang/en.json` is a stub. See `TODO.md`.
- **`architecture/` was empty until 2026-08-19.** If you change how any of the above works, change this file
  in the same commit. A map that lies is worse than no map.
