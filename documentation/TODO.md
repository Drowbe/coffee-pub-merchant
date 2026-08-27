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
| 1 | [Per-shop compendium picks](#1-per-shop-compendium-picks) | Stocking | S | Ready to build |
| 2 | [Open a shop from a Blacksmith pin](#2-open-a-shop-from-a-blacksmith-pin) | Ways in | S | Needs the pin API |
| 3 | [A canvas region as the shop](#3-a-canvas-region-as-the-shop) | Ways in | M | Design open |
| 4 | [A full-screen shop](#4-a-full-screen-shop) | Presentation | M | Blacksmith conversation first |
| 5 | [Canvas marker for merchant tokens](#5-canvas-marker-for-merchant-tokens) | Presentation | M | Blacksmith conversation first |
| 6 | [Catalogue mode](#6-catalogue-mode) | Ways in | L | Fiction decisions first |

**1–3 were asked for at the table** (play session, 2026-08-27) and are ranked by what they cost against what
they unblock. **4–6 are recorded ideas**, each parked on something that has to be settled before code:
two of them on a conversation with Blacksmith, one on a question about the fiction.

[*Considered — not scheduled*](#considered--not-scheduled) below is a record of declines, not a backlog.

---

## 1. Per-shop compendium picks

**Category:** Stocking · **Size:** S · **Ready to build**

A query shelf draws from the sources configured in Blacksmith, world-wide. A GM should be able to name
specific packs for *this* shop on top of that: Blacksmith's list stays the default, and a shop that needs a
narrower or an extra pack should not have to change the world's search set to get one.

`compendiums.query` already takes `sources` and already defaults it to the GM's configured set, so this is
a field on the inventory's query config and a picker for it — the drawing half needs no change.

## 2. Open a shop from a Blacksmith pin

**Category:** Ways in · **Size:** S · **Needs the pin API**

Drop a pin, open that merchant. The shop already opens for a token uuid, so the work is the binding rather
than the window: which merchant a pin names, and what happens when it names one that has been deleted.

## 3. A canvas region as the shop

**Category:** Ways in · **Size:** M · **Design open**

A region should be able to stand as the physical shop — a stall, a market square, a room — not only a
merchant token. **Opening the shop by being in that place is the point**, which is a different interaction
from double-clicking a person.

It reopens two things the current design closed deliberately: a shop is a token (§4 of the architecture doc
is explicit that a shop is what stands in the world), and proximity has never mattered because a shopkeeper
is somebody you are standing in front of. Settle both before building: what a region-shop *is* when nobody
is standing in it, and whether entering opens the window or only offers to.

## 4. A full-screen shop

**Category:** Presentation · **Size:** M · **Blacksmith conversation first**

Recorded 2026-08-24, discussed and deferred the same day. The shop fills the viewport, the illustration
becomes the ground rather than a backdrop behind one card, and a shop without an illustration falls through
to the glass it already uses — that half is nearly free, because the illustration is already an optional
attribute.

Four things settled in the discussion, so they do not have to be re-derived:

- **Not the browser's fullscreen API.** `requestFullscreen` puts one element on its own layer, and Foundry
  renders tooltips into a global `#tooltip` and dialogs as separate apps at body level — both would draw
  *behind* the shop, which is to say invisibly. Every hover card, the clear-inventory confirm and the actor
  picker would vanish. It has to mean **fills the Foundry viewport**: a positioned window without chrome.
- **A view preference, not a property of the shop.** Same argument as the folds: a GM on an ultrawide
  ticking a box, and a player's laptop getting a shop that swallows the screen, is the bad version. It wants
  to be a **header toggle, per client, remembered per shop**, so a player with a big monitor gets it too. If
  a config field is wanted as well it should mean the honestly different thing — *open this shop expanded
  by default* — and the per-client toggle still governs.
- **Full screen is not this layout stretched, and that is the actual work.** A 2560px window holding one
  column of shelves is worse than what is there now: forty-character rows with a metre of picture either
  side. Width buys **columns**, not longer rows, and three inventories abreast is genuinely better for a
  six-shelf shop — but it interacts with the folds and the search. So: stage one is the toggle with the
  existing single column capped at a sane width and centred, and stage two is columns *if* stage one reads
  silly. Stage one may well be enough.
- **The veil gets stronger, not lighter**, because there is more picture and fewer cards sitting on it. And
  a 512px illustration blown to 2560 will look rough: the fix is a blurred scaled copy as fill with the real
  image `contain`ed over it, which also handles portrait art on a widescreen.

**Blacksmith should own half of it.** The frame — the header button, saving and restoring the pre-expand
geometry, staying clear of the sidebar and hotbar, z-index, escape to restore, surviving a viewport resize
— is chrome, is identical for Squire and Minstrel, and is where the fiddly bugs live. Merchant owns what
happens inside: an `is-expanded` class is all it needs to do columns and a heavier veil. So the honest first
step is a conversation with Blacksmith, not a stylesheet.

One gotcha for whoever writes it: **do not call it `maximize`.** ApplicationV2 already has `maximize()` and
it means "un-minimize"; a subclass overriding it would break Foundry's own minimise. `expand`, or `theatre`
if the presentation connotation is wanted.

## 5. Canvas marker for merchant tokens

**Category:** Presentation · **Size:** M · **Blacksmith conversation first**

A merchant token should be visibly a merchant, and visibly *what kind* of merchant, without anyone having to
double-click it to find out. The shop kind already exists and already carries an icon
(`SHOP_KINDS` in `scripts/const.js`), so the data is there — what is missing is putting it on the canvas.

The value is that a player walking into a market square can tell the weaponsmith from the apothecary from the
NPC who is just standing there. Right now the only way to know a token is a shop at all is to try
double-clicking it, which is a poor way to learn that most tokens are not.

Things to settle before building it, none of them obvious:

- **Where the marker is drawn.** A child of the Token, a separate canvas layer, or a `Token` HUD element.
  A child sprite moves and hides with its token for free, which is most of the work; a separate layer means
  reimplementing visibility, elevation and hidden-token rules that already exist.
- **Whether players see it at all.** A GM's hidden shop, a closed shop, and a shop the party has not yet
  found are three different cases. "Closed" probably still shows the marker — a shuttered shop is still
  visibly a shop — but a token the GM has hidden must not, and that has to hold for the marker as much as
  for the token.
- **Scale and clutter.** Markers that are legible on a 100px token are noise on a 40px one, and a market
  square with twelve merchants must not become a wall of badges. Likely wants a zoom threshold, which is a
  design decision rather than a constant.
- **Whether this is Merchant's to own.** Blacksmith already draws on tokens, and Curator marks lootable
  corpses — which is the same problem with a different icon. **Two consumers is the bar**, and that is
  exactly the situation the extraction exercise said to hand over rather than write twice. Check what
  Blacksmith has before drawing anything.

That last point is the reason this is recorded rather than started: the honest first step is a conversation
with Blacksmith, not a sprite.

## 6. Catalogue mode

**Category:** Ways in · **Size:** L · **Fiction decisions first**

Shopping remotely — the party browses a merchant's stock without a token on the scene, and orders are
fulfilled later or at a distance. A standing shop they can reach from anywhere rather than a place they walk
to.

Worth recording now because it pulls against two things the current design assumes:

- **Interaction is token-shaped.** A shop opens by double-clicking a placed token. A catalogue has no token,
  so it needs another way in — a journal link, a chat command, a menubar entry, or a scene-independent
  browser listing every merchant flagged as catalogue-available. Overlaps [#2](#2-open-a-shop-from-a-blacksmith-pin)
  and [#3](#3-a-canvas-region-as-the-shop): all three are the same question about ways in, and whichever
  lands first should answer it for the others.
- **Proximity is currently a non-issue** because a shopkeeper is someone you are standing in front of. A
  catalogue makes distance the point, which reopens the gating question that was deliberately closed.

It also raises delivery: does an ordered item arrive immediately, at the next rest, or when the party reaches
the shop? That is a fiction question before it is a mechanical one, and it should be answered before any of
it is built.

---

## Considered — not scheduled

Declines, kept so they are not re-proposed from scratch. Not a backlog.

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
