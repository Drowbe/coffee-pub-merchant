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
| `scripts/settings.js` | The six sound settings, and nothing else. |
| `scripts/gm-request.js` | The request envelope. **A bridge, not a design** — see §8. |

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
    schema: 2,                   // migration stamp — see §12
    open: true,                  // only consulted when there is NO schedule
    hours: { open: 9, close: 18 } | null,
    override: { open, against } | null,   // see §5
    pricing: {
        markup: 1.0,             // the shop's BASELINE; inventories multiply against it
        reputation: false,       // opt in to the party's standing moving prices
        overrides: { [itemId]: baseUnits },        // agreed buy prices
        buybackOverrides: { [itemId]: baseUnits }  // agreed sell prices
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

### Ceilings and restocking

**One ceiling is a control; the other is a backstop.** `maxPerItem` — *max N of each item* — is on screen
wherever stock is counted, because it clamps two different things: how deep a table roll stacks a row, and
what a GM may type into the quantity column in the shop window (which also sets the restock target).

`maxProducts` is **not** a control any more. It only ever trimmed a table roll, and the table's own roll
count is how a GM says how much arrives — two numbers for one idea, one of which did nothing on the many
inventories that have no table. It survives as a constant, enforced in `_withinLimits`, so an unattended
reroll cannot grow a shop past the point where its window is readable. If that limit is ever reached, the
answer is the roll count or the reroll flag, not a bigger number.

Both are enforced on write, and `setStockQuantity` returns `{ value, clamped, maxPerItem }` so the window
can say what happened rather than silently correcting a number a GM typed.

**Both are ceilings, not targets.** They only ever refuse. Nothing fills an inventory *to* them, and reading
either as "how many I want" is the single most natural wrong assumption about this screen — which is most of
why one of them is no longer offered.

How deep a table-rolled row goes is `stockDepth()` in `utility-pricing.js`, in three steps:

1. **The item's own `system.quantity`**, if it is more than one. A compendium entry authored as a quiver of
   twenty arrows is a quiver of twenty arrows.
2. **The price band** (`STOCK_DEPTH_BANDS`), for types a shop keeps a pile of — `consumable`, `loot`, and
   ammunition. The band caps it and a die fills it, so stocking the same inventory twice gives two shops.
3. **One**, for everything else.

`maxPerItem` clamps the result, so a ceiling a GM set by hand is never argued with by a die. The roll is a
plain integer, not a `Roll` — nothing here belongs in chat.

Restocking is driven by `updateWorldTime` — the same watcher that opens and closes shops, so there is no
second clock. An inventory restocks when `restockDays` in-world days have elapsed. **Advancing a week restocks
once, not seven times**; the watcher compares elapsed time against the interval rather than counting
boundaries. Table-stocked inventories may additionally re-roll on restock, which is opt-in per table (`auto`).

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

### The two levers, and what each is for

- **Reputation** is the *area's* disposition toward this party. Save a city and its shops treat you well;
  wreck one and they gouge you. It moves both directions in the party's favour at once.
- **Global Markup** is *one merchant's* choice against their competitors in the same place.

**Reputation cannot create a trade route, and that is correct.** Because it improves buying and selling
together, the best place to buy is also the best place to sell, and no pair of areas differing only in
reputation can turn a profit. What makes a route is a *merchant* who deals dear: buy from one pricing at the
going rate, sell to one at ×2.00, and the difference between their markups less the second one's spread is
the margin. Reputation then makes a good route better.

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

**Both classes import the base by path, and `module.api` is not an option.** `api-window.md` says the
classes are the contract, the paths are not, and to resolve a base class from `module.api` at module top
level. That cannot work for a class you `extends`: Foundry evaluates module scripts before `game` exists, so
the resolve throws — and ESM caches the failed evaluation, so it kills the module for the whole session
rather than being retried on the next call. Tried and reverted on 2026-08-19.

Curator imports the path in three files for the same reason. Squire takes the other route: resolve from
`module.api`, then **dynamically import** the window module at the point of use, by which time the API is
published. That one honours the contract and costs every static import of a window becoming a lazy one. The
coupling is therefore deliberate rather than overlooked, and it is in `TODO.md` with what it would take.

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

---

## 12. Migration

`SCHEMA_VERSION` in `manager-merchant.js` is the shape this build writes. **1** was untyped shelves under
`flags['coffee-pub-merchant'].shelf`; **2** is typed inventories under `.inventory`.

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
