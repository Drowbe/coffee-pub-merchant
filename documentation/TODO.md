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
| 1 | [Columns in an expanded shop](#1-columns-in-an-expanded-shop) | Presentation | M | Built on 13.3.0, judged by use |
| 2 | [Hand the expand frame to Blacksmith](#2-hand-the-expand-frame-to-blacksmith) | Suite | S | Conversation, then a deletion |
| 3 | [Deliver what a catalogue orders](#3-deliver-what-a-catalogue-orders) | Ways in | M | Fiction decision first |

**All three of the previous list shipped in 13.3.0** — the token marker, the catalogue, and the expanded
shop. What is left of each is written below: one stage-two that should not be built until stage one has
been lived with, one seam to hand to the hub, and the one question the catalogue raised and did not answer.

**Three open asks with Blacksmith**, all from shipped work and all recorded in
`architecture/architecture-merchant.md` §16 with what to delete when they land:

- No **expand affordance on the standard window base**. `BlacksmithFullscreenWindowBaseV2` exists and
  answers a different question — a blocking, frameless takeover for handouts. See item 2.
- `compendiums.query` filters a requested source against the curated set, so a shelf naming an uncurated
  pack has it silently dropped. Merchant marks those rows *Waiting* and refuses the draw rather than
  reporting an empty query.
- The pins API has **no placement picker**. Merchant arms its own crosshair, which is a dozen lines and
  works — but Squire and Curator will want the same the moment either drops a pin, and the fiddly half
  (cancel, escape, right-click, the canvas menu that must not open) is one implementation's worth of work.

[*Considered — not scheduled*](#considered--not-scheduled) below is a record of declines, not a backlog.

---

## 1. Columns in an expanded shop

**Category:** Presentation · **Size:** M · **Built on 13.3.0, judged by use**

Stage two of the expanded shop, and deliberately not built with stage one.

The reasoning, which has not changed: a 2560px window holding one column of shelves is worse than the
window it replaces — forty-character rows with a metre of picture either side, and an eye that travels the
width of a monitor from an item's name to its price. **Width buys columns, not longer rows**, and three
inventories abreast is genuinely better for a six-shelf shop.

What stopped it being stage one is that columns interact with two things that already work:

- **The folds.** An inventory can be collapsed. In a column layout, collapsing one either leaves a hole or
  reflows the other two, and a layout that reflows while you are clicking through it is a layout that loses
  your place.
- **The search.** `filterShopList` hides rows, then categories, then whole inventories. In one column that
  reads as a list getting shorter. In three it reads as columns emptying unevenly, which is the same
  information presented as a mess.

**Judge it by use before building it.** Stage one may well be enough — the honest test is a six-shelf shop
opened expanded on a wide monitor for a session. If the answer is "this is fine", delete this entry.

If it is built: `container-type: inline-size` is already on `.merchant-shop-content`, so the breakpoint is
a container query rather than a media query and asks about the window rather than the screen — which is
what it should ask about, since the window is resizable independently of expanding.

## 2. Hand the expand frame to Blacksmith

**Category:** Suite · **Size:** S · **Conversation, then a deletion**

`utility-expand.js` is 130 lines, and roughly none of it is about shops. Measuring the free viewport around
the sidebar and hotbar, remembering geometry to restore, lifting the size caps the base class writes inline,
suppressing position persistence for the duration — that is *chrome*, it is identical for Squire and
Minstrel, and it is where the fiddly bugs live.

Two of those four are only necessary because they fight the base class, which is the clearest possible
argument for the base class owning them:

- `_applyWindowSizeConstraints` writes `--blacksmith-window-max-width` as an **inline** property on every
  render, so a stylesheet cannot lift it and a subclass has to override the method.
- `setPosition` persists geometry 250ms later under a shared key, so expanding has to switch
  `rememberPosition` off or one expanded shop sets the opening size of every shop.

**What Merchant should keep** is what happens *inside* an expanded shop: the `is-expanded` class is all it
needs to cap the column, centre it, and strengthen the veil. That division is already how the code is
written, so the handover is a deletion rather than a rewrite.

The ask is an `expand()` / `restore()` pair on `BlacksmithWindowBaseV2` and `BlacksmithToolWindowBaseV2`,
with the class applied to the frame. **Not** on the fullscreen base, which is a different thing: blocking,
frameless, one at a time, for handouts and reveals.

One gotcha for whoever writes it: **do not call it `maximize`.** ApplicationV2 has that method and it means
"un-minimise"; overriding it breaks Foundry's own minimise button.

## 3. Deliver what a catalogue orders

**Category:** Ways in · **Size:** M · **Fiction decision first**

The catalogue shipped and it works: the shop opens, the slate fills, the settlement runs. What it does not
answer is the question it raised — **when does an ordered item actually arrive?**

Right now it arrives immediately, because that is what settling a trade does and a catalogue reuses the
transaction unchanged. That is the right first answer (it is the one that needed no new machinery, and a
party ordering rope from three towns away getting rope is not absurd in a world with sending stones) and it
is not obviously the right final one.

The options, and what each would cost:

- **Immediately.** What it does now. Nothing to build.
- **At the next long rest.** Needs a queue on the merchant or the buyer, a hook on the rest, and an answer
  for what happens if the party never rests.
- **When the party next reaches the shop.** Needs the queue plus a proximity test — which is the same
  question §11's regions answer in the opposite direction, and it should be answered once for both.

**This is a fiction question before it is a mechanical one**, and it should be answered before any of it is
built. The queue is the same shape in two of the three, so the cost is in choosing, not in coding.

Note what it is no longer pulling against: interaction stopped being token-shaped when pins shipped, so a
catalogue needed no fourth way of resolving a shop — it names an Actor, like a pin does. That half of the
old entry is closed.

---

## Considered — not scheduled

Declines, kept so they are not re-proposed from scratch. Not a backlog.

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
  are moments, and that is what it is for.
