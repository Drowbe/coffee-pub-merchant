# Coffee Pub Merchant — Plan

**Status:** Phase 0 and Phase 1 built, untested. Decisions A–E in section 14 are settled — recommendations
accepted on 2026-08-09.
**Target:** Shops and merchants, filling the gap left when Curator retired its Item Piles dependency.
**Architecture record:** `../architecture/architecture-merchant.md`, written from the code as behaviour lands.
Do not copy this plan into it.

## 1. Objective

A token marked as a merchant opens a shop window. Players browse its stock and acquire items from it.

Money, selling, and scarcity come later. The first version is deliberately a transfer surface, because that
is the part the loot work already proved and the part everything else stands on.

## 2. The rule that governs this module

**Migrate the best version. Do not replicate.**

Curator's loot feature is 2,281 lines across manager, window, templates and styles. Copying it would create
a fork on the same day two forks were deleted from Curator for exactly this reason —
`ui-context-menu.js` and `manager-hooks.js`, both carrying bugs the hub had already fixed, neither able to
pick up anything landing later.

The v1 described in section 1 is not 2,281 lines. Strip the corpse-specific work — death detection,
generation, revival, bury, the empty-state lifecycle, the ledger, presence, proximity, combat gating,
container nesting, multi-pass Loot All — and what remains is roughly 300.

**Write it fresh and small. Resist reaching for loot's polish.** What is genuinely re-needed will announce
itself, and that becomes the extraction list — validated by two real consumers rather than guessed at from
one. Pre-extracting to Blacksmith now would be the opposite error: designing an abstraction against one real
implementation and one imagined one.

Phase 1b exists to do that comparison deliberately rather than by drift.

## 3. Scope

### Included, eventually

- Mark an Actor as a merchant and configure it.
- Open a shop window by interacting with a merchant token.
- Display stock with prices.
- Acquire an item, to the opener or to another character or the party.
- Buying with coin.
- Selling to the merchant.
- Stock policy: infinite, finite, or restocking.

### Explicitly excluded

- Corpse looting. That is Curator's and stays there.
- Crafting, commissions, or item upgrades.
- Haggling, reputation-based pricing, or persuasion checks against price.
- Multi-currency economies beyond D&D 5e's five denominations.
- A system-agnostic economy framework. The first implementation targets D&D 5e.

## 4. Ownership boundary

### Merchant owns

- Merchant state and configuration.
- Stock policy and pricing policy.
- Who may shop, and what they may do.
- The shop window and every user-facing message.

### Blacksmith owns

- Every document mutation (`api.inventory`).
- Token interaction claiming (`api.tokens`).
- Window base, entity list, quantity split, dialogs, toasts, context menu.
- Socket transport.

### Merchant must not own

- Item or currency mutation code. Not even temporarily, and not "just for the first draft".
- A second copy of anything Blacksmith already ships.

## 5. What must not be inherited from loot

The loot feature made decisions that were right for corpses and would be wrong here. Each is a live risk
because the same author is writing both.

| Loot does this | Merchant must not, because |
|---|---|
| State on the **Token** | A corpse is one event. A merchant is a persistent entity — see section 6. |
| `transferItem` moves stock | Infinite stock means `grantItem`, which never touches the source — section 7. |
| Flags automatically on death | Nothing marks a merchant but a deliberate GM action — section 9. |
| A `generationId` guards staleness | There is no generation. A shop is not an event with a lifetime. |
| An `empty` terminal state | An infinite shop is never empty; a finite one that sells out is still a shop. |
| A "Looted by" ledger | Purchase history is a different shape and is not needed in v1 at all. |
| Proximity and combat gating | Plausibly wanted, but inherit nothing without deciding — section 14. |

## 6. State model

**Merchant state lives on the Actor, not the Token.** This is the sharpest divergence from loot and the one
most likely to be got wrong by habit.

Loot state is per-token because each corpse is a distinct event with its own generation. A merchant is a
persistent entity: flag the token and every placed instance becomes a separate shop, deleting the token
loses the configuration, and the same merchant on two scenes is two unrelated merchants.

```js
flags['coffee-pub-merchant'].merchant = {
    enabled: true,
    name: null,                 // display override; falls back to the Actor's name
    stock: 'infinite',          // 'infinite' | 'finite' | 'restocking' — only 'infinite' in v1
    pricing: {
        markup: 1.0,            // multiplier applied to the item's own price
        overrides: {}           // itemId -> { value, denomination }
    }
}
```

Token documents carry nothing. A merchant's shop is the same shop wherever it is placed.

## 7. Stock model

**Stock is a count, not a document.** The merchant's item is a template; a sale grants the buyer a *copy* and
adjusts a number. Nothing is ever moved off a shelf by a sale, under any policy.

`blacksmith.inventory.grantItem({ targetActorUuid, itemUuid, quantity })` resolves an `itemUuid` pointing at
an actor-embedded item and grants a copy to the target. **The source is never touched.** Confirmed against
`api-inventory.js` `_prepareGrant`.

That is why `transferItem` is wrong here even once stock is finite: a transfer deletes the source row on the
last unit, which loses the shelf layout and leaves a restocking shelf with nothing to restock. A sold-out row
staying put, marked out of stock, is what finite stock prefers and what restocking stock requires.

Three policies, set **per shelf** with `null` inheriting the merchant's — the same inheritance `markup`
already uses, so this is a case added to an existing pattern rather than a second one:

| policy | on purchase |
|---|---|
| `infinite` | grant a copy, count untouched |
| `finite` | grant a copy, count down; at zero the row stays, marked out of stock |
| `restocking` | as finite, and the count returns to par on a cadence |

The count is `system.quantity` rather than a flag of ours. A flag would be a parallel truth: the moment a GM
edits quantity on the Actor sheet — which they will, because that is where quantity has always lived — the
two disagree and one of them is silently wrong.

### What finite stock costs

Infinite stock had no concurrency at all, because the merchant was never mutated:

- No source mutation, so no rollback of a source side that half-failed.
- No lock contention on the merchant Actor.
- **No race at all** between two players buying the same item — a thing loot needed a GM election, per-Actor
  locks, and a re-validation pass to survive.

Finite stock brings the race back, and only the race: delivery is still a copy, so there is still no source
rollback to write. Two players can read the same count, so every read-then-write goes through a per-merchant
promise chain (`_withStockLock`). That is sound because exactly one client runs it — `activeGM` is core's own
deterministic designation, so there is no second process to coordinate with.

### Par levels

Restocking needs a target, and the target cannot be recovered from a shelf that has been sold down. Rather
than a separate par editor — another number in another place to keep in sync — the quantity column in the
shop window is editable by a GM, and setting it sets both:

- a purchase lowers the count, par untouched
- **a GM setting a quantity by hand sets what it restocks to**
- a restock returns the count to par

Which is what a shopkeeper means by "I keep six of these". The gap: a GM who wants to *temporarily* drop
stock without changing par cannot say so in the window.

## 7b. Shelves — what counts as stock

**A shelf is a container Item on the merchant carrying a `shelf` flag. Its contents are the stock.**
Anything on the Actor outside a shelf is the shopkeeper's own gear and is never for sale. Without this, a
shopkeeper's worn armour and belt dagger were on the shelf, and everything downstream would have inherited
that.

**One schema, several presets — not several types.** Every use case raised differs only in three properties:

```js
flags['coffee-pub-merchant'].shelf = {
    label: 'Back Room',   // section heading in the shop window
    order: 1,
    visible: false,       // players are never sent this shelf
    mode: 'sale',         // 'sale' | 'barter' | 'buyback'
    markup: null          // null inherits the merchant's markup
}
```

| Preset | visible | mode | markup |
|---|---|---|---|
| Storefront | yes | sale | inherit |
| Back Room | **no** | sale | inherit |
| Premium | yes | sale | 1.5 |
| Barter | yes | barter | — |
| Buyback | yes | buyback | 0.5 |

Hard-coding five kinds would leave the sixth idea — seasonal stock, faction-only, consignment — with nowhere
to go. As presets they are data.

A GM flips a shelf between shown and hidden from the **shop window's shelf header**, not only from the config
window: that is where you are standing when you decide to bring the good stuff out. The config window is for
setting a shop up; the shop is for running one. Moving a single item between shelves — dnd5e's own container
drag — is the fine-grained version and needs nothing from us.

Visibility is deliberately a flag rather than the container's `equipped` state. Equipped is inert on
containers so it would have worked, and it was considered. Rejected because it is transient state the rest of
the ecosystem clears on transfer, it can change without anyone deciding to change it — a GM tidying their
inventory would silently hide a shelf, with nothing to lead them back to the cause — and it would put one of
the three shelf properties somewhere the other two are not.

**`visible: false` is a permission, not a display filter.** The GM handler refuses a grant from a hidden
shelf, so a crafted request naming a back-room item fails rather than merely being hidden in the window. It
is an affordance rather than secrecy: Foundry syncs Actor documents to every client, so a player with a
console can read a hidden shelf. If genuine secrecy is ever needed, the items must live on an Actor the
player's client does not have.

**Barter resolves what an unpriced item means.** On a `sale` shelf, no price is a configuration gap. On a
`barter` shelf it is deliberate — the row lists so the party knows the thing exists, and nothing changes
hands through the window.

Shelves are created from the config window rather than shipped in a compendium: a pack is a thing to
maintain and its items can be edited into something malformed, whereas the button cannot produce a shelf with
the wrong flags. Each is created with `weightlessContents` and no capacity, so it is unlimited and weighs
nothing — both real dnd5e behaviours, verified: `computeCapacity` starts at `Infinity` unless a capacity is
set, and `weightlessContents` makes a container report only its own weight.

Enabling a merchant with no shelves auto-creates a Storefront, so the zero-config path shows the shape rather
than an empty window and a puzzle.

## 7c. Trading hours

**The schedule proposes and the toggle disposes.** Crossing an opening or closing hour sets the shop to
match its schedule; a GM may override that at any time and the override stands until the next crossing.

**The override needs no stored flag.** It is simply the state disagreeing with the schedule. The next
crossing sets the state to match, which clears the override as a side effect of doing the ordinary thing,
and a GM toggling back to the scheduled state clears it because there is then nothing to disagree with.
Anything stored would be a second source of truth for a fact already derivable.

`hours: { open, close } | null`. Equal bounds read as always open, which is what setting both to the same
hour is asking for and avoids a zero-width window nobody can shop in. Overnight schedules work — open 20,
close 04 — because the check wraps rather than assuming `open < close`.

Hours are read from `game.time.calendar`, not assumed: `hoursPerDay` is calendar-configurable, so the
control's range and the time formatting both derive from it rather than hardcoding 24.

The watcher runs on `updateWorldTime`, **GM-only** — every client running it would race the same write. It
compares the schedule *before and after* the jump rather than watching for an exact hour, so advancing eight
hours at once still lands on the right state and nothing is missed by skipping over a boundary.

Setting hours applies them immediately rather than waiting for the clock to move, because a GM who sets 9 to
6 at noon expects an open shop. A GM whose shop disagrees with its schedule is told so in both windows —
deliberate is fine, mysterious is not.

**This was argued against and the argument was wrong.** The objection was that hours would be inert in worlds
that never advance the clock. That is not this table, core ships a world clock, and the point that settled it
is forward-looking: catalogue mode cannot depend on a GM remembering to unlock a door.

## 8. Pricing model

Three sources, resolved in order.

1. **Per-item override** — `pricing.overrides[itemId]`. Absolute, wins outright.
2. **Markup** — `pricing.markup` multiplied by the item's own `system.price.value`.
3. **The item's own price** — dnd5e already stores `system.price` with a denomination.

An item with no price is displayed as unpriced rather than as free. A merchant is not obliged to sell
everything it carries, and an unpriced item is a configuration gap, not a gift.

Denominations come from `CONFIG.DND5E.currencies` conversion values. Never hard-code a conversion table:
the list, the labels and the conversions are all read from the system, so a world that adds a denomination
gets it for free.

Everything is counted internally in the smallest denomination and formatted back out for display, which
keeps the arithmetic in integers and avoids a rounding argument about fractional silver.

### Making change

**This is Merchant's, permanently.** `api.inventory` never converts denominations, by standing decision:
exchanging coin to satisfy a payment is a table's house rule, not a mechanic. A player holding 20 sp cannot
pay 2 gp as far as the primitive is concerned, so the plan of which coins move is worked out here.

`planPayment` spends **smallest coins first**, then returns whatever was overpaid as change. That is not
optimal in the coin-counting sense and deliberately so: it is what a person does at a counter, and it avoids
breaking a purse into change for no reason. A buyer with only platinum pays platinum and takes change back;
a buyer with a bag of silver pays silver.

Affordability is decided on the buyer's **whole purse**, not on any one denomination — the point of making
change — and is checked in the window before anything is asked of the GM, then again on the GM before
anything moves. The first is the explanation; the second is the guard.

## 9. Marking and configuration

Nothing marks a merchant automatically. This is new surface with no loot equivalent, and it has a
chicken-and-egg problem: the way *in* must be reachable on an Actor that is not yet a merchant.

**Decision required — see section 14, decision A.** The recommendation is a two-part answer: an always-present
entry point on the Actor sheet header menu that opens a Merchant Settings window carrying the "Is merchant"
toggle, plus a prominent shortcut that appears **only** once the Actor is a merchant.

The settings window is also where stock policy, markup, and per-item overrides live as they arrive, so it
should be built as a window with room to grow rather than a confirmation dialog.

## 10. Interaction

Double-click a merchant token through `blacksmith.tokens.registerInteraction`, `gesture: 'clickLeft2'`,
exactly as Curator claims corpses. The contract rules are the same and are not optional:

- `matches` must be **synchronous**. Foundry's permission predicate is synchronous and a promise is truthy,
  so an async matcher grants every double-click unconditionally.
- `matches` must return the same answer twice in a row. Blacksmith checks permission and dispatch
  separately.
- The handler must never throw or return a rejected promise. Blacksmith does not fall through to Foundry
  once permission is relaxed, so a throwing handler is a dead gesture rather than a fallback.

`bypassPermission: true` is required for the same reason as loot: players do not have LIMITED permission on
a merchant NPC's Actor, and Foundry's predicate runs before the handler.

`matches` reads the Actor flag, which stays a plain flag read — no UUID resolution, no compendium lookups.

## 11. Authorization

Every player-initiated mutation runs on the authoritative GM. A player cannot write to a merchant's Actor or
to another character, so this is not optional and not a formality.

The GM re-resolves every UUID and revalidates before mutating:

- The Actor still carries an enabled merchant flag.
- The requested item is still on the merchant and is a physical type.
- The recipient is one the requester may name.
- Any policy gate that exists at the time (section 14, decision D).

**Hiding a control is never the guard.** Client-side checks exist so a refusal arrives as a message rather
than a window that fails on every action; the GM check is what makes it true.

The socket envelope — request id, pending map, timeout, single-answering-GM election, response routing — is
mechanically identical to Curator's and is the security boundary. **Do not write a second one by hand.** See
section 12.

## 12. Blacksmith dependencies

| Need | Status |
|---|---|
| `api.inventory.grantItem` | Ships today. Covers all of v1. |
| `api.tokens.registerInteraction` | Ships today. |
| Window base, entity list, quantity split, dialog, toast | Ship today. |
| **A GM request/response envelope** | Blacksmith will own it. Interim version uses core's query API. |
| **A two-sided `exchange` primitive** | Accepted in principle, not built. Tell them when the phase is real. |

**GM request envelope.** Blacksmith will own this, built on Foundry's **query API** rather than on sockets —
`CONFIG.queries[name]` plus `game.users.activeGM.query(name, data, {timeout})`. Four of the five things a
hand-rolled envelope provides are already core's in v13: request id, pending map, timeout, response routing.
`game.users.activeGM` is core's own single-GM designation, so every module agrees on which GM acts rather
than each re-deriving it with its own sort.

`gm-request.js` is written against that core API now, so migrating to Blacksmith's surface should be a
deletion rather than a rewrite. Two things must survive it: the **local-GM shortcut**, so a GM never
round-trips to itself, and the `{ok, code}` result shape carrying `NO_ACTIVE_GM` / `TIMEOUT` /
`HANDLER_ERROR` to match what `api.inventory` returns.

**The envelope routes and elects. It does not authorize.** Nothing in a payload is trusted; re-resolution and
validation stay with the handler. This is the rule most easily lost once an envelope becomes infrastructure.

**The caller's identity is verified by core, but not forwarded.** `#handleUserQuery` resolves the querying User from the
authenticated socket and throws if they do not exist — then invokes the handler as
`handler(queryData, { timeout })` and drops them. The identity is trustworthy and simply not passed on.

Merchant asserts the id in the payload as a **bridge**, which is the step that turns a verified identity into
a client-supplied one. No consumer can recover the real caller; only the envelope can reattach it, so the
payload id comes out when Blacksmith's surface lands. Until then, treat it as unverified — but do **not**
rewrite authorization around it. Ownership checks are the natural way to authorize a purchase, and
`user.isGM` is correct provided the user comes from the envelope.

**Two-sided `exchange`.** Accepted in principle, symmetric shape confirmed, build starts when the phase is
real. Three things Blacksmith flagged for that point: the result shape is the actual design work, since four
legs means reporting per side what committed; it will be built on their existing internal cores rather than
as a parallel implementation; and write count per Actor is the open question, because currency is an
`actor.update()` while items are embedded writes.

**Sequencing is envelope first.** `api.inventory`'s mutex is per-client and in memory — it does not
coordinate two GM clients. A shared envelope is what makes `exchange`'s atomicity true in a two-GM world
rather than nearly true, so building the harder thing first would assume the smaller thing exists.

## 13. Phases

### Phase 0 — Scaffold

- `module.json` with `"socket": true` **from the first commit**. Foundry reads manifests at world launch, so
  adding it later costs a world restart and silently drops every emit until then. Curator learned this the
  slow way.
- Requires `coffee-pub-blacksmith`. No other dependencies.
- Documentation folders as here: `architecture/`, `plans/`, `testing/`, plus `TODO.md`.
- Send Blacksmith the two-sided-transfer heads-up.

### Phase 1 — Open and acquire

- Mark an Actor as a merchant, per decision A.
- Claim `clickLeft2` on merchant tokens.
- Shop window listing physical stock.
- Acquire to the opener, to another party character, or to the party Actor — via `grantItem`.
- GM-authoritative handler with re-validation.
- No money, no prices displayed, no polish.

### Phase 1b — Compare and extract

Diff what was written against Curator's loot equivalent. **Whatever came out verbatim is the extraction
list.** Move those pieces to Blacksmith with two real consumers proving the shape. Do this before phase 2
adds more surface to duplicate.

### Phase 2 — Prices

- Display resolved prices per section 8.
- Merchant Settings gains markup and per-item overrides.
- Still no transaction. Cheap, and it surfaces the pricing model in the UI before it is load-bearing.

### Phase 3 — Buying

- [x] Price resolution, affordability, and the coin plan.
- [x] Buy control, confirmation naming the price, GM-side re-validation.
- [ ] **Waiting on `blacksmith.inventory.exchange`.** Everything above this line is built; payment is one
      `exchange` call that returns `EXCHANGE_UNAVAILABLE` until the primitive ships.
- [x] **Delivery is not part of that exchange.** `exchange` moves what it is given and stock is a count, so
      handing it the merchant's item would sell the template and empty the shelf. Goods are a `grantItem`,
      coin is a currency-only `exchange`, and the goods go first so a failed payment leaves the player
      holding the item rather than paying for nothing. An exchange side that could say *copy* would collapse
      this back to one atomic call; raised with Blacksmith.
- [x] **The controls are disabled and say why, not absent.** Reverses the earlier rule. An absent button
      reads as "this shop does not do that"; a disabled one naming its reason reads as "not right now, and
      here is what would change it", and the row does not reflow on the day the primitive lands.

### Phase 4 — Selling

- [x] Sell control, buyback pricing, seller-owns-it and merchant-can-pay checks.
- [x] Sold stock lands on the Buyback shelf rather than loose on the NPC.
- [ ] Waiting on the same primitive.

**It inverted the trust model, as expected.** Every other handler validates that someone may *receive*.
Selling accepts an item *from* a player, so two new questions arise: the item must be the seller's own
(`testUserPermission(user, 'OWNER')`, GM exempt), and the merchant must be able to pay — a shop with an empty
till refuses rather than conjuring coin, which is a fiction a GM may well want.

### Phase 5 — Stock policy — **built**

- [x] Three policies per shelf, inheriting the merchant's when unset. Buyback is always finite.
- [x] The count is `system.quantity`; a sold-out row stays on the shelf.
- [x] A GM edits quantities in the shop window, which sets the restock target too.
- [x] Restocking on the world clock, per-shelf cadence in in-world days, plus a manual refill.
- [x] Per-merchant lock around every read-then-write.
- [x] Quantity dialogs, carts and the GM handler all bound by what is actually there.

It did **not** reintroduce source mutation, which the plan expected it to. Delivery stayed a copy for the
reason in section 7, so the only thing that came back was the race — and that is one lock rather than the
rollback-and-revalidate machinery loot needed.

### Phase 6 — Stocking from compendiums

A GM-only search-and-add panel inside the shop window, so *"do you have any special armour?"* is answered at
the table rather than by leaving the session to go rummaging.

**Nothing blocks this.** It needs only the shelf model, which exists. It is placed last because money is the
bigger feature, not because it depends on it — move it earlier the moment it becomes the more annoying gap.

**Built, and then thrown away in favour of Blacksmith's.** Merchant shipped its own search window for a day.
Blacksmith's is better — a type filter, results grouped by source with the pack name, timing, and a count of
what the scan did not show — and its result rows are draggable carrying `{ type, uuid }`, which is precisely
what Merchant's shelf drop targets already read.

So the search is theirs and the targeting is the drag: the `+` on a shelf header opens
`blacksmith.openWindow('blacksmith-compendium-search')`, and the GM drags a result onto the shelf it belongs
on. There is no second search to keep working, and the one thing Merchant's version had that theirs does not
— knowing which shelf you meant — is answered better by dropping on the shelf than by remembering it.

For reference, the search half Blacksmith provides:

```js
const results = await blacksmith.compendiums.search('plate', 'Item', { itemType: 'equipment', limit: 40 });
// [{ uuid, name, type, documentClass, img, source, sourceLabel, sourcePackage, matchType }, ...]
```

Group by `source`, render `name` and `img`, add via `uuid`. `searchDetailed()` additionally reports whether
the scan was truncated, which a picker should show rather than silently capping.

The add half is `grantItem({ targetActorUuid: merchantUuid, itemUuid })`, which accepts a compendium UUID
directly — the case `grantItem` exists for. Merchant's drop handler reads the payload and calls
`addToShelf`, which is that grant plus a write to `system.container`.

**One gap to raise with Blacksmith when this is built:** `grantItem` cannot say *which container* the new
item lands in, so stocking a shelf means granting and then a second write to set `system.container`. A
`container` option would make it one write and would help any consumer granting into a container. Small ask,
worth making at the time rather than speculatively now.

The flow:

1. GM opens the shop, picks a shelf, types into a search box.
2. Results grouped by source pack, with a count and a truncation notice.
3. Clicking a result grants it to the merchant and places it on that shelf.
4. The shop refreshes and the item is on sale immediately.

## 14. Decisions for the owner

Recorded as decisions rather than assumptions because the author of this plan also wrote the loot feature
and is biased toward reproducing it. Each has a recommendation; the final call is the owner's.

### A. How is an Actor marked as a merchant?

- **Sheet header menu entry, plus a conditional shortcut (recommended).** A "Merchant" row in the Actor
  sheet header menu — where Configure Sheet and Prototype Token live — is always present, which solves the
  chicken-and-egg problem, and costs one unobtrusive row on non-merchants. It opens a Merchant Settings
  window with the "Is merchant" toggle. Once enabled, a prominent button appears on the sheet for quick
  access. This satisfies "no merchant button on non-merchants" while keeping the way in discoverable.
- **Token HUD button only.** Cannot mark an Actor that is not yet a merchant. Good as a secondary shortcut,
  not as the way in.
- **A tab on the Actor sheet.** More room for later options, heavier to build, and awkward on a
  non-merchant.
- **Inventory tab integration.** Closest to where stock actually lives, but couples the module to a system
  sheet layout that dnd5e changes between versions.

### B. Who may open a shop?

- **Anyone who can see the token (recommended).** Matches loot, and a shop that refuses to open is a worse
  failure than one that opens and refuses to sell.
- Owners only. Effectively GM-only, which defeats the point.
- A per-merchant allow list. Real use case exists (a shop that only serves one faction) but not in v1.

### C. Where does an acquired item go by default?

- **The opener's character, with a picker for others (recommended).** Same shape as loot's "Looting as",
  which was right there and is right here.
- Always ask. An extra click on every acquisition.
- Party inventory by default. Wrong default for a purchase, which is usually personal.

### D. Do proximity and combat gating apply?

- **Neither in v1 (recommended).** Loot has both, and inheriting them without a reason is exactly the bias
  this section exists to catch. A shopkeeper is not a corpse: you are talking to them, and shopping during
  combat is unusual enough that a GM can say no out loud.
- Proximity only. Defensible — you should be near the shop — but the setting exists in Curator because
  corpses are scattered across a battlefield, which shops are not.
- Both, mirroring loot. Consistent, and consistency is not a reason on its own.

### E. Does the shop window show items the merchant cannot sell?

- **Hide non-physical items, show unpriced ones as unpriced (recommended).** A merchant's Actor carries
  features and spells that are not stock; those are noise. An unpriced physical item is a configuration gap
  the GM should be able to see.
- Show everything. Honest about the Actor, useless as a shop.
- Show only priced items. Hides the configuration gap, so the GM never learns what they forgot to price.

## 15. Documentation rule

`architecture/architecture-merchant.md` describes only behaviour verified against implemented code. This
plan records intent and unresolved choices. When they disagree, the architecture document is right and this
one is stale.
