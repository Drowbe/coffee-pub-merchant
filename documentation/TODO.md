# TODO

Shipped work lives in `CHANGELOG.md`. This file is for what is still open, what must not be repeated, and
what has been considered but not scheduled. It is ordered by severity: the top of the file is what to do
next, and nothing below *Standing rules* is work.

**Where things go:** `documentation/architecture/` describes implemented systems, `documentation/plans/`
records intent and reasoning, `documentation/testing/` holds verification checklists.

`architecture/architecture-merchant.md` is the map: what the system does and how the pieces fit. Read it
before changing anything, and change it in the same commit as the thing it describes. A map that lies is
worse than no map.

**When something is finished, log it and then delete it from here.** Finished work lives in the architecture
document, the API documentation and `CHANGELOG.md` — those get updated in the same commit as the change. An
implemented plan is **deleted**, not marked done. A completed entry in this file is **deleted** once it is
logged where it belongs. This file is only what is still open; anything else in it is a second copy waiting
to go stale.

Two things to read before changing anything load-bearing:

- **`DECISIONS-TO-REVIEW.md`**, before touching the transaction model. Its first entry is out of date in one
  respect: `exchange` shipped with both `copy` and `preserveEmptySource`, so buying is one atomic call again
  and the grant-then-charge failure it describes cannot happen.
- **`testing/testing-merchant.md`** is the checklist, and it is current. Every feature here has been run in
  Foundry as it was built — the module is developed against a live world, and most of what is in `CHANGELOG`
  arrived as a correction to something seen on screen. What `tests/` adds is the half a table cannot check
  by looking: making change across 5,151 purse/price combinations, stock policy, the restock cadence, the
  lock, the trading-hours derivation, stock depth, and the search filter.

---

## At a glance

Nothing outstanding. Every item that was in this table has landed; the sections below are
reference rather than work.

*Standing rules*, *Ideas* and *Considered* below are not work and are not in this table.

---

## 1. Couplings and gaps

## 2. Nits and known gaps

- **Check for a finished window before building one.** Merchant shipped its own compendium search and
  deleted it the same day: Blacksmith already had one, better in every respect, and its result rows drag with
  the `{ type, uuid }` payload our shelf drop targets already read. The mistake was reading
  `api-compendiums.md`, finding `search()`, and treating a documented *primitive* as evidence that no
  *feature* existed on top of it. It does not follow. Before building any window, check
  `blacksmith.openWindow` for a registered id, `documentation/api/api-window.md` for the registry, and the
  Blacksmith toolbar and menubar for something that already opens what you are about to write. This is a
  different failure from forking a file — nothing was copied, a duplicate was simply invented — and the tell
  is the same: two things doing one job, one of which nobody else maintains.
- **Grepping a doc is not reading it, and this is the second time.** Merchant asked "is there a drop helper
  in `api-inventory`?", searched the file for *drop* and *drag*, found nothing, and moved on. The answer was
  correct and three unrelated rules in that same file were being broken: `registerTransientFlag` must be
  called by whoever writes a flag to items, arrival flags belong in the `grantItem` call rather than a
  follow-up `setFlag`, and `items` is an array so one leg per line batches nothing. None contain the word
  "drop".

  This is the compendium-search mistake in a different coat. There, `search()` was found and a *feature*
  built on top of it was missed. Here, the absence of one keyword was read as the absence of guidance. Both
  times the failure was treating a document as an index to query rather than a thing to read. **Read the
  whole page for any API you call more than once**, and re-read it when the API ships something new — the
  rules around `exchange` arrived in the same change as `exchange`.
- **Never fork a Blacksmith component.** A copy taken before a fix keeps the problem the hub has solved and
  can never pick up anything landing later. Curator carried two forks — `ui-context-menu.js` and
  `manager-hooks.js` — both with bugs already fixed upstream. To check: compare filenames against
  `coffee-pub-blacksmith/scripts/`; a shared name is the tell.
- **An integration is a relationship, not a file.** Somebody has to own the ask, take the answer, and delete
  our side of it when each lands. Four asks went out on 2026-08-19 and all four came back inside a day; if
  nobody owns that loop, workarounds quietly become the design.
- **Put an expiry on any claim about what has been verified.** An earlier version of this file said nothing
  since `beb8f41` had been run in Foundry. That was true when it was written, during two unattended
  sessions, and was never retired when it stopped being true — after which it was repeated as fact in a
  handoff review, against a page of evidence to the contrary. Check such a claim against the git log before
  believing it, and date your own.
- **Re-check documents after every await.** Anything writing to a Token, or to an Actor belonging to one,
  must confirm it still exists *after* each await — a guard at the top of an async function proves nothing
  ten awaits later. For a scheduled callback the check goes **inside** the timer, because the delay is
  exactly the window in which the document is deleted. An unlinked token's Actor is synthetic and dies with
  its token, so checking the Actor never catches it. Foundry reports this as
  `undefined id [...] does not exist in the EmbeddedCollection`.
- **A setting that hides a control must also refuse the request.** Hiding a button removes it from the
  honest path only; the GM-side check is what makes a policy real. Applies to *disabled* as much as hidden:
  out of stock is a refusal on the GM, not merely a greyed button.
- **A control that cannot act should say why, not disappear.** An absent button reads as "this shop does not
  do that"; a disabled one naming its reason reads as "not right now, and here is what would change it". It
  also keeps the layout still on the day the missing thing arrives.
- **`--blacksmith-tool-background` is a gradient.** Using it as a `color` silently drops the declaration and
  renders as an invisible label on a dark bar.
- **Embedded controls need `attach()` after their markup is in the document.** An unbound entity list or
  quantity split still renders and still reports a value, so the failure looks like success.

---

## Standing rules — inherited lessons

These cost Curator real time. They apply here identically and there is no reason to relearn them.

- **Nothing may read `game` at module scope.** Foundry evaluates module scripts before `game` exists, and
  **ESM caches a failed evaluation** — so the throw does not retry on the next call, it disables the module
  for the rest of the session. The symptom is one `Cannot read properties of undefined` and then a module
  that simply is not there, which reads like a load-order problem and is not.

  Three incidents so far: resolving a base class from `module.api`, a `const METHOD_LABELS = { ... }` of
  translated strings, and a `static SELL_SORTS = [ ... ]` class field. **None of them looked like top-level
  code** — which is why the check that enforces this walks a real scope stack rather than indentation.
  The rule: **a table holds keys, a function resolves them.** Check 6 in `tests/test-i18n.mjs`.

- **Check for a finished window before building one.** Merchant shipped its own compendium search and
  deleted it the same day: Blacksmith already had one, better in every respect, and its result rows drag with
  the `{ type, uuid }` payload our shelf drop targets already read. The mistake was reading
  `api-compendiums.md`, finding `search()`, and treating a documented *primitive* as evidence that no
  *feature* existed on top of it. It does not follow. Before building any window, check
  `blacksmith.openWindow` for a registered id, `documentation/api/api-window.md` for the registry, and the
  Blacksmith toolbar and menubar for something that already opens what you are about to write. This is a
  different failure from forking a file — nothing was copied, a duplicate was simply invented — and the tell
  is the same: two things doing one job, one of which nobody else maintains.
- **Grepping a doc is not reading it, and this is the second time.** Merchant asked "is there a drop helper
  in `api-inventory`?", searched the file for *drop* and *drag*, found nothing, and moved on. The answer was
  correct and three unrelated rules in that same file were being broken: `registerTransientFlag` must be
  called by whoever writes a flag to items, arrival flags belong in the `grantItem` call rather than a
  follow-up `setFlag`, and `items` is an array so one leg per line batches nothing. None contain the word
  "drop".

  This is the compendium-search mistake in a different coat. There, `search()` was found and a *feature*
  built on top of it was missed. Here, the absence of one keyword was read as the absence of guidance. Both
  times the failure was treating a document as an index to query rather than a thing to read. **Read the
  whole page for any API you call more than once**, and re-read it when the API ships something new — the
  rules around `exchange` arrived in the same change as `exchange`.
- **Never fork a Blacksmith component.** A copy taken before a fix keeps the problem the hub has solved and
  can never pick up anything landing later. Curator carried two forks — `ui-context-menu.js` and
  `manager-hooks.js` — both with bugs already fixed upstream. To check: compare filenames against
  `coffee-pub-blacksmith/scripts/`; a shared name is the tell.
- **An integration is a relationship, not a file.** Somebody has to own the ask, take the answer, and delete
  our side of it when each lands. Four asks went out on 2026-08-19 and all four came back inside a day; if
  nobody owns that loop, workarounds quietly become the design.
- **Put an expiry on any claim about what has been verified.** An earlier version of this file said nothing
  since `beb8f41` had been run in Foundry. That was true when it was written, during two unattended
  sessions, and was never retired when it stopped being true — after which it was repeated as fact in a
  handoff review, against a page of evidence to the contrary. Check such a claim against the git log before
  believing it, and date your own.
- **Re-check documents after every await.** Anything writing to a Token, or to an Actor belonging to one,
  must confirm it still exists *after* each await — a guard at the top of an async function proves nothing
  ten awaits later. For a scheduled callback the check goes **inside** the timer, because the delay is
  exactly the window in which the document is deleted. An unlinked token's Actor is synthetic and dies with
  its token, so checking the Actor never catches it. Foundry reports this as
  `undefined id [...] does not exist in the EmbeddedCollection`.
- **A setting that hides a control must also refuse the request.** Hiding a button removes it from the
  honest path only; the GM-side check is what makes a policy real. Applies to *disabled* as much as hidden:
  out of stock is a refusal on the GM, not merely a greyed button.
- **A control that cannot act should say why, not disappear.** An absent button reads as "this shop does not
  do that"; a disabled one naming its reason reads as "not right now, and here is what would change it". It
  also keeps the layout still on the day the missing thing arrives.
- **`--blacksmith-tool-background` is a gradient.** Using it as a `color` silently drops the declaration and
  renders as an invisible label on a dark bar.
- **Embedded controls need `attach()` after their markup is in the document.** An unbound entity list or
  quantity split still renders and still reports a value, so the failure looks like success.

---

## Ideas, not scheduled

### Catalogue mode

Shopping remotely — the party browses a merchant's stock without a token on the scene, and orders are
fulfilled later or at a distance. A standing shop they can reach from anywhere rather than a place they walk
to.

Worth recording now because it pulls against two things the current design assumes:

- **Interaction is token-shaped.** A shop opens by double-clicking a placed token. A catalogue has no token,
  so it needs another way in — a journal link, a chat command, a menubar entry, or a scene-independent
  browser listing every merchant flagged as catalogue-available.
- **Proximity is currently a non-issue** because a shopkeeper is someone you are standing in front of. A
  catalogue makes distance the point, which reopens the gating question that was deliberately closed.

It also raises delivery: does an ordered item arrive immediately, at the next rest, or when the party reaches
the shop? That is a fiction question before it is a mechanical one, and it should be answered before any of
it is built.

### Canvas marker for merchant tokens

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

---

## Considered, not scheduled

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

- **`api.worldClock` was evaluated and declined, 2026-08-21.** Their scheduler answers "tell me when the
  world reaches a moment" — `dailyAt` for an hour of the day, `at` for an absolute time, with a `crossings`
  count so a week-long rest fires once rather than seven times. It is well built and it is not what either of
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
