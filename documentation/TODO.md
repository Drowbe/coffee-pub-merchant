# TODO

**What is open, ranked.** Nothing else belongs here.

| Looking for | It lives in |
|---|---|
| What shipped, and why | `CHANGELOG.md` |
| How the system works | `architecture/architecture-merchant.md` |
| The conventions this codebase follows | `../CONTRIBUTING.md` |
| What to verify at a table | `testing/testing-merchant.md` |
| Decisions taken unattended, and their review | `DECISIONS-TO-REVIEW.md` |

A plan lives in `plans/` only while it is being built; the directory is empty between plans, and that is
the correct state for it. **When something is finished, log it where it belongs and delete it from here** —
an entry left behind is a second copy waiting to disagree with the first. **Put a date on anything that
will expire.**

---

## Rollup

| # | Item | Category | Size | State |
|---|---|---|---|---|
| 1 | [Mail order](#1-mail-order) | Ways in | L | **Phase 1 played end to end 2026-08-30** |
| 2 | Selling by post | Ways in | M | **Phase 2** — designed, not built |
| 3 | [Advertising](#advertising-as-its-own-system) | Systems | L | **Phase 2** — sketched |

**All three of the previous list shipped in 13.3.0** — the token marker, the catalogue, and the shop full
screen. **Columns are closed too, by use**: the single column at 1180px was judged at a wide monitor on
2026-08-28 and reads well, so the stage two that entry held open is not wanted.

What is left is the catalogue, which shipped as *the shop reached from elsewhere* and is becoming something
larger: **mail order** — a catalogue shelf type whose stock is a warehouse rather than a counter, three
delivery services, a receipt that becomes the parcel it was promising, and a party who will find uses for
all of it that nobody planned. Phase 1 designed on 2026-08-29 and written up below.

**One open ask with Blacksmith**, recorded in `architecture/architecture-merchant.md` §16 with what to
delete when it lands. Two others closed on 2026-08-28 — the uncurated-compendium one by Merchant scanning
pack indexes itself, and the full-screen one because the hub already had it and the doc had been skimmed
rather than read:
- The pins API has **no placement picker**. Merchant arms its own crosshair, which is a dozen lines and
  works — but Squire and Curator will want the same the moment either drops a pin, and the fiddly half
  (cancel, escape, right-click, the canvas menu that must not open) is one implementation's worth of work.

[*Considered — not scheduled*](#considered--not-scheduled) below is a record of declines, not a backlog.

---

## 1. Mail order

**Category:** Ways in · **Size:** L · **Phase 1 built 2026-08-29, played end to end 2026-08-30.** Order,
carriage, crate deposit, a parcel that waits at its destination, a GM who says whether the party are there,
collection, unpacking and the crate going back — all of it exercised. Phase 2 is deferred; what is left is
selling by post and the advertising system, both below.

The build is in `plans/plan-mail-order.md` while it is being reviewed, and the durable half is in
`architecture/architecture-merchant.md` §12a. Testing checks 253–265.

The catalogue shipped as *the shop, reachable from anywhere*, which is the wrong thing: a party carrying six
of them never travels to a market again. What it should be is **mail order** — its own rules, its own costs,
and its own opportunities for mischief.

**The abuse is the point.** Once a party can have a crate sent to a place of their choosing, they will use it
to move things that are not shopping — contraband to a fence, a message inside a barrel, something heavy
somewhere it should not be. That is a *feature*, and it is the reason to build this rather than a faster buy
button. It is also why what arrives is an **object at a place** and not a grant into somebody's backpack.

### The shape

- **A `catalogue` shelf type**, beside General, Back Room, Premium, Negotiate and Buyback. A GM stocks it by
  dragging, by compendium query or off a roll table; it restocks on its own cadence and carries its own
  markup. "Fewer items" falls out of somebody choosing what goes on it.
- **Nothing on a catalogue shelf changes hands at the counter.** It is a warehouse somewhere else — which is
  exactly why ordering takes days and costs a fee, and why *"we can get that in for you"* is a sentence a
  shopkeeper says. Delivery is intrinsic to the type, not a switch on it.
- **Catalogue shelves appear only in the catalogue view**, and ordinary shelves do not appear there. The two
  views show two different kinds of stock, which is what stops this being the shop by post.
- **What arrives is a parcel**: a container Item, holding the goods, that turns up as a real object. Opening
  it is dnd5e's own container sheet, so there is no new UI for taking things out of it.
- **The slate carries the order**, not just a total: the goods, the delivery type, the destination, and the
  fee. Settling it is placing the order.
- **No quantity column in the catalogue view.** A warehouse's stock level is not a fact the reader needs;
  what matters is what it costs and when it comes.

### Delivery types

Three, and each answers "where does it go" differently — which is the neat part, because the destination
control changes with the choice rather than being one field that means three things.

| Type | Cost | Speed | Where it goes |
|---|---|---|---|
| **Ground** | cheapest | slowest | A **depot** — they collect it. A pin they click to get their package. |
| **Courier Beast** | middling | middling | **To them.** The beast finds whoever is holding the catalogue, so no address is asked for. |
| **Parcel Portal** | very expensive | very fast | **A shop on the portal network.** Both ends have to be on it. |

Arrival is **elapsed world time** since dispatch — a stored timestamp and a comparison, the shape
`restockDays` already has, not a scheduler. Each type is a number of days.

### The rest, settled

- **Orders are automatic. The GM is notified**, and can interfere with what they then know about. No
  approval step in the way of a party spending money.
- **Selling by post pays on dispatch.** The party sends goods and the coin arrives; the merchant takes
  delivery later.
- **Where it is delivered is the party's choice**, and paying more moves that choice closer to them.

### Phase 1 — theatre of the mind

**Settled 2026-08-29.** Everything below is deliberately narrative: no pins, no portal network, no map. What
is built is the *transaction and the waiting*, which is the part with rules; where a parcel physically sits
is described rather than placed.

- **A receipt, then a parcel, and they are the same Item.** Ordering creates a **receipt** in the party's
  possession carrying what is coming, from whom, by which service and when. On delivery that same Item
  **becomes the parcel** — a container holding the goods. The receipt is the tracking number and then it is
  the box.

  This answers where a pending order lives, and answers it better than a flag somewhere would: it is an
  object the players can *see*, it survives sessions, it survives the merchant being deleted, and it can be
  lost, sold, stolen or found — which is the point of the whole feature.
- **Arrival is a notification**, not a place. *Your delivery is ready.* What happens next is the fiction:
  - **Ground** and **Parcel Portal** — collect it at the location, whenever they get there.
  - **Courier Beast** — the GM hands it over.
- **Lost and stolen parcels are wanted.** A parcel that is an Item somebody is holding can go astray, and a
  receipt whose parcel never came is a plot. Worth a GM affordance rather than being purely narrative.

### Phase 2, also — on the map — DEFERRED

**Deferred on 2026-08-30**: the receipt approach turned out to be the better one. Collection through the
receipt needs no pin, works in a theatre-of-the-mind session, and travels with the party rather than with
the map. Depot pins would be a second way to do what the receipt already does.

- Depot **pins** to collect a Ground delivery from, and whatever says which pins are depots.
- The **portal network flag** on a merchant, and a Parcel Portal destination picker listing the shops that
  carry it. The fiction says the *sending* shop needs it too.

### Notes for whoever builds it

- **`api.worldClock` is the right tool here, and this is the case its decline anticipated.** It was
  evaluated and declined on 2026-08-21 for trading hours and restocking, correctly: neither is a moment.
  The note left behind said to revisit *"if a genuine wall-clock event appears — a shop that opens on market
  day, an auction at dusk. Those are moments, and that is what it is for."* **A delivery arriving is a
  moment**, and `schedule({ at })` is exactly it.

  Three things from their page that this has to obey: schedules are **not persisted**, so pending deliveries
  are re-registered on `ready` from the receipts, which is the queue — the API is a notification surface and
  not a queue, and the receipts already are one. **`gmOnly: true`**, since delivering writes to the world
  and five connected players would otherwise do it five times. And rewinding time re-arms a one-shot, so a
  GM correcting the clock backwards past a delivery will see it arrive again — which for a delivery is
  arguably right, but should be a decision rather than a surprise.
- ~~**`grantItem` refuses a packed container**, so a parcel has to be built as documents directly.~~
  **Wrong, and it cost a day.** That refusal is about *copying* a container that already has contents; it
  says nothing about granting things **into** one, which is what the `container` option is for. Building the
  contents by hand meant hand-stripping shelf flags, writing the containment, and losing merge identity —
  three behaviours reimplemented worse. The delivery is one `grantItems` with a per-entry `container`.
- The paged catalogue view — a spread of item images rather than a scrolling list, which is what a catalogue
  *is* — is a presentation of the catalogue shell, and the full-screen surface is where it will look best.
- Delivery types, their costs and their speeds want to be a table in `const.js` like `INVENTORY_TYPES`, so a
  fourth one is a row rather than a branch.

### Waiting on Blacksmith: geography

**When the hub knows where a scene *is*, most of the collection dialog goes away.** Right now the module
cannot answer "are the party at the coaching inn?" — a scene is not a location, so it asks the GM every
time. If Blacksmith grows geo-aware scenes (a scene knowing the place it depicts, and places knowing which
other places they are near), then:

- A parcel whose destination resolves to where the party actually are is **handed over without asking**.
  The toast does the telling and nobody is interrupted.
- The GM is asked **only when the location is unknown or ambiguous** — a theatre-of-the-mind session, a
  destination that is a name somebody made up, a party split across two places.

The flow is already shaped for this: `collect()` is one branch on one question, and everything else it does
is verification that stays. Replacing the question with a lookup and falling back to the dialog is a small
change to one method, which is the point of having put the question in one place.

### Phase 2 — selling by post

**Scheduled as phase 2 on 2026-08-30**, now that phase 1 has been played end to end. The mirror of mail
order: the party post goods *to* a merchant, are paid on dispatch, and the shopkeeper physically receives
them days later. `buildConsignment` already stores an `outbound` flag, and the clock, the receipt, the crate
arithmetic and the collection dialog are all direction-agnostic — what is missing is the shelf, the entry
point on the sell side, and what the party hold while it is in transit (a receipt, presumably, the same as
buying).

Settled in conversation:

- A **"Pending Delivery"** section on the merchant, which is **never shoppable**. Goods posted to a shop are
  between two shelves for a few days and that is what the section says.
- Two actions on it: **cancel delivery**, and **deliver now** — the latter being the same flow as a party
  who have verified the parcel is ready and asked for it, so it calls `handOver` rather than a copy.
- The roll-up of everything in transit is the more useful GM view, and that is `window-deliveries.js`.

### Advertising, as its own system

**Scheduled as phase 2 on 2026-08-30.** The catalogue's filler copy is eight canned lines in `const.js`
today. What it wants to be:

- **"Purchase Ad Space" as a thing on the shelf.** A merchant sells it the way they sell a lantern: it
  appears in their stock, it is priced, and buying it is an ordinary transaction through the ordinary
  path. What the buyer receives is not an object but a *placement* — their copy, appearing in that
  merchant's catalogue and shop for as long as they have paid for.
- **Deliberately corruptible**, in the same way the courier's instructions box is. An advertisement is a
  message in public that only its intended reader understands: a party who buy space to run six words at a
  fence three towns away have invented a dead drop, and nothing in the module had to know. That is the
  point of it, and it is why the copy is free text.
- **An Ad Manager**, GM-side: who has bought what, where it runs, when it lapses, and the copy itself —
  which a GM will want to read, since some of it is a plot. The same shape as **Orders in Transit**, and
  for the same reason: the state lives on documents and the roll-up is the view nobody can assemble by
  hand.
- **The newspaper**, later, is where the same objects are read for their own sake rather than between
  goods — the placement becomes a column rather than a tile, and everything above already describes what
  a column is made of.

Things worth deciding before it is built:

- **Who sees an advertisement.** Every catalogue in the world, one shop's, one scene's? The fiction says a
  shop sells its own space, so a placement probably names a merchant.
- **What lapses look like.** A run has a length, and when it ends the copy stops appearing. The world
  clock already does this for parcels; a placement is the same shape of scheduled fact.
- **How it is priced.** Per tile, per page, per day? Whatever it is, the *size* of the tile is already a
  lever the layout understands — a two-by-two costs more than a single cell.

Until then they are canned copy dealt into gaps, and the two shapes — a tile in a wall, a classified in a
list — are already built and are what a bought placement will render as.

### Still open

1. **Where do posted goods land?** Selling by post pays on dispatch, so the party has its coin — but the
   merchant takes delivery later, and the Buyback shelf is where party goods already end up. A crate in the
   post is then a thing between two shelves for a few days.
2. **What the courier does if nobody holds the catalogue any more.** It finds the holder, and the holder may
   have sold it, lost it, or died. Probably: it becomes a parcel the GM hands out, which is the Beast case
   anyway.
3. ~~**What a receipt looks like on a sheet.**~~ Done: consulting one raises a toast computed against the
   clock at the moment of asking, so the countdown counts down. The description on the Item is still the
   figure at ordering — see the gap in `plans/plan-mail-order.md`.

---

## Considered — not scheduled

Declines, kept so they are not re-proposed from scratch. Not a backlog.

- **Columns in a full-screen shop, declined by use 2026-08-28.** Stage two of the full-screen shop: three
  inventories abreast, on the reasoning that width buys columns rather than longer rows. Judged at a wide
  monitor and the single column capped at 1180px reads well, so the argument for it was theoretical. It
  would also have had to answer two things that already work: the folds (collapsing one column leaves a hole
  or reflows the others, and a layout that reflows while you are clicking through it loses your place) and
  the search (`filterShopList` hides rows, then categories, then inventories — in one column that reads as a
  list getting shorter, in three as columns emptying unevenly). Revisit only if a shop with a dozen shelves
  turns up and the column reads long.
- **Handing a catalogue straight to a character.** *Print a Catalogue* puts the Item in the world directory
  and the GM drags it to whoever should have it. A picker would be a question with no good default in the
  middle of a different task, and dragging is the gesture they already use for every other item that changes
  hands. If a GM ends up printing one per party member, revisit.
- **A marker that says whether the shop is open.** The marker says *this is a weaponsmith*, and a shuttered
  shop is still visibly a shop. Making it say two things would need it to redraw on every world-time
  crossing, and would make the map flicker at closing time for information the window already gives.
- **Temporarily lowering a count without moving the restock target.** A GM editing a quantity in the shop
  window sets both, deliberately — one number, one meaning. If "the cart was raided but I still keep six"
  turns out to be a thing GMs say, it needs either a second field or a modifier on the edit.
- **Stock that builds up over time.** Restocking refills *to* par however long has passed, so a shop left
  alone for a month is full rather than overflowing. Growing stock would be a different feature, and would
  need a ceiling before it was one. Note this now cuts differently for a table-stocked shelf: that one adds
  on every restock, so a shop left alone does not accumulate deliveries but a shop visited weekly does.
- **A roll count that is a formula.** A shelf rolls its table a fixed number of times. `1d4+1` would be more
  in keeping with the rest of the system, and is a parse plus a `Roll` away — but a fixed count is
  predictable, and a GM who wants variety can put it in the table.
- **Per-segment clears on the slate.** One control empties both segments. Dumping what you are selling while
  keeping what you are buying is per-line only.
- **`api.worldClock`, evaluated and declined 2026-08-21.** Their scheduler answers "tell me when the world
  reaches a moment" — `dailyAt` for an hour of the day, `at` for an absolute time, with a `crossings` count
  so a week-long rest fires once rather than seven times. It is well built and it is not what either of
  Merchant's two clock needs actually is.

  **Trading hours need no scheduler at all.** `isOpen` is derived — it reads the schedule every time it is
  asked — so the watcher exists only to redraw a window whose answer may have changed. A missed event is a
  stale window that the next refresh fixes, never a wrong shop. Registering two `dailyAt` moments per
  merchant and re-registering them whenever a GM edits the hours would be more machinery, more state, and
  more ways to be wrong than a before-and-after comparison.

  **Restocking is not a moment.** It is *elapsed time since a stored timestamp* — `restockDays` since this
  inventory's `lastRestock` — which `dailyAt` cannot express. `at` could, re-registered after every restock,
  except schedules are not persisted, so every registration would have to be rebuilt at `ready` from the
  same `lastRestock` the current check reads directly.

  Revisit if a genuine wall-clock event appears — a shop that opens on market day, an auction at dusk. Those
  are moments, and that is what it is for. **Revisited 2026-08-29 and it was right**: a mail-order delivery
  arriving is a moment, and item 1 uses `schedule({ at })` for exactly that.
