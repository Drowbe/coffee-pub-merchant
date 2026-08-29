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
| 1 | [What a catalogue is for](#1-what-a-catalogue-is-for) | Ways in | L | In conversation |

**All three of the previous list shipped in 13.3.0** — the token marker, the catalogue, and the shop full
screen. **Columns are closed too, by use**: the single column at 1180px was judged at a wide monitor on
2026-08-28 and reads well, so the stage two that entry held open is not wanted. What is left is the one
question the catalogue raised and did not answer.

**One open ask with Blacksmith**, recorded in `architecture/architecture-merchant.md` §16 with what to
delete when it lands. Two others closed on 2026-08-28 — the uncurated-compendium one by Merchant scanning
pack indexes itself, and the full-screen one because the hub already had it and the doc had been skimmed
rather than read:
- The pins API has **no placement picker**. Merchant arms its own crosshair, which is a dozen lines and
  works — but Squire and Curator will want the same the moment either drops a pin, and the fiddly half
  (cancel, escape, right-click, the canvas menu that must not open) is one implementation's worth of work.

[*Considered — not scheduled*](#considered--not-scheduled) below is a record of declines, not a backlog.

---

## 1. What a catalogue is for

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
  are moments, and that is what it is for.
