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

| Severity | Item | Where |
|---|---|---|
| **Bug** | A failed render strands a window in its own registry; that shop or settings window then refuses to open for the rest of the session | `window-shop.js:231`, `window-merchant-config.js:83` |
| **High** | Adopt `blacksmith.gmRequest` — deletes `gm-request.js` and closes the caller-identity hole | `gm-request.js`, `manager-merchant.js` |
| **High** | Adopt `BlacksmithToolWindowBaseV2.openFor` — deletes both hand-rolled registries, and the bug above with them | both windows |
| **High** | Adopt `blacksmith.party` — `acting()`, `actor()`, `hasPrimaryParty()` | `manager-merchant.js:1075` |
| **Medium** | Both windows deep-link a Blacksmith script file instead of `module.api` | both windows, line 1 |
| **Medium** | No localisation — roughly 200 hardcoded English strings | scripts and templates |
| **Medium** | Trading hours and restocking hand-roll what `api.worldClock` does | `manager-merchant.js` |
| **Medium** | Three raw `Hooks.on` registrations, none of them disposable | `manager-merchant.js` |
| **Low** | Refreshes ride a raw `game.socket` channel rather than `api.sockets` | `manager-merchant.js:1523` |
| **Low** | Duplicate `removeShelf` handler; a comment that lies about the stock model | config `:59`/`:65`, manager `:1521` |
| **Low** | Sell as the party is untried | — |
| **Low** | No way to hand something over for free | — |

*Standing rules*, *Ideas* and *Considered* below are not work and are not in this table.

---

## 1. Bugs

### A failed render strands a window in its own registry

**Seen in play 2026-08-19, not reproduced since.** A merchant was being set up; the settings window was
closed in a state it could not be reopened from. It opened normally the next day with nothing changed in
between.

Both windows register themselves **before** their first render:

```js
const win = new this(actor);
this._windows.set(actor.uuid, win);   // registered before it renders
await win.render(true);
```

If that render throws — a shelf flag, a roll table uuid that no longer resolves, a template field that is
not there — the map keeps the instance, `_onClose` never runs because the window never opened, and every
later `open()` takes the `if (existing) return existing.render(true)` branch and re-renders **the same
broken instance**, which throws again. The window is then unopenable for that actor for the rest of the
session, with nothing on screen to explain it.

`window-shop.js` has a second route to the same state: its `_onClose` calls `clearPresence()` *before*
deleting from the map, so a throw in presence-clearing strands the entry too.

**The discriminator, for next time.** The registry is a class static and dies with the page, so a reload
clears it. Position, title-bar mode and theme are in `localStorage` and survive one. So:

- reload fixes it → the registry, this entry;
- reload does not fix it → a saved position off-screen (there is no viewport clamp on restore, so a
  different monitor will do it) or Micro title bar switched on by a stray context-menu click. Both recover
  from the title-bar menu: **Reset Position**, **Use Full Title Bar**.

Before reloading, look for a thrown error in the console at the moment the window refuses to open. That one
observation separates them.

**The fix is two lines** — register only after a successful render, and delete from the map first in
`_onClose` — but §2 deletes both registries outright, and Blacksmith's deregisters on close. Doing that
removes the class rather than this instance of it, so prefer it if both are on the table.

---

## 2. Adopt what Blacksmith shipped

All three landed in **Blacksmith 13.19.0** (`a13e0984`, committed), and `module.json` already pins that
minimum. Each of these deletes code here.

### `blacksmith.gmRequest` — `gm-request.js` becomes a deletion

The surface `architecture-merchant.md` §8 and §11 have been waiting for, and it arrived with the contract
those sections predicted: `registerOp({ op, module, handler })`, `request(op, payload, { timeout })`, and a
handler invoked as `(payload, user)` where **`user` is a verified `User` the caller could not have forged**.

What changes here. `_process(op, payload, userId)` takes the User it is handed instead of resolving one from
`game.users.get(userId)`; the `userId` field comes out of every request payload **in the same change**,
because leaving it in is the hole rather than a redundancy; op routing stops being our `if (op !== 'settle')`
and becomes their registration. The local-GM shortcut becomes theirs — a GM runs the handler locally, no
round trip — so ours goes with the file.

Four things to get right, all stated in `api-gm-request.md` and none of them guessable. Ops must be
**module-prefixed** (`coffee-pub-merchant.settle`). Registration happens on **every** client, not only the
GM's — one that registered nothing answers `UNKNOWN_OP`, and `MerchantManager.initialize()` already runs for
everyone, so this is satisfied by not "optimising" it later. Re-registering an existing op is **refused
rather than overwritten**, so any path that registers twice needs `unregisterOp`. And `IDENTITY_UNVERIFIED`
is a refusal to **report, not to work around** — the envelope will not answer from a claimed identity, which
is the whole point of it.

`_explain` needs the three codes we cannot currently say: `UNKNOWN_OP`, `QUERY_UNAVAILABLE`,
`IDENTITY_UNVERIFIED`. `NO_ACTIVE_GM`, `NO_QUERY_PERMISSION`, `TIMEOUT` and `HANDLER_ERROR` already match
ours exactly — which is what writing `gm-request.js` against the eventual shape was for.

**The standing rule survives the migration:** never read an identity out of a payload. If one is there, it
is either redundant or a hole.

### `BlacksmithToolWindowBaseV2.openFor` — both windows drop their registries

`static openFor(target, options)`, plus `isOpenFor`, `openWindowFor`, `openWindows`, `closeFor`, and a
`static keyFor(target)` keyed on `uuid` by default. Windows deregister themselves on close.

That deletes `ShopWindow._windows` with its `static open`, `closeForToken` and `_onClose` bookkeeping, and
the same again in `MerchantConfigWindow`. `refreshForToken` and `refreshForActor` become filters over
`openWindows()` rather than map walks. **Registries are per subclass**, so a Shop and Curator's Loot opened
against one token do not evict each other — the case a shared registry would have got wrong.

This is also the fix for §1. Do it in the same sitting as the deep-link item below: it is the same file.

### `blacksmith.party` — the roster, and the distinction we never had to make

`party.acting()` is ours: `system.playerCharacters`, with the no-primary-party fallback to player-owned
actors that `getPartyCharacters` reinvents at `manager-merchant.js:1080`. `party.resting()` is Rest's
`system.creatures`, which includes familiars and companions. A familiar rests with the party and cannot buy
a sword, so **reaching for the wrong one gives a roster that looks right in testing** — take `acting()`,
never `resting()`.

`party.actor()` replaces `getPartyActor`. Two things stay ours, and their doc says so: it returns facts
rather than decisions, so the ownership filtering in `getEligibleRecipients` and `canActAs` is not theirs to
take. And `hasPrimaryParty()` is worth surfacing in Merchant Settings — *"no primary party set"* explains an
odd Buying-as list far better than the list does.

`plans/plan-extraction.md` is the record of how these were argued; it goes when the last of them is adopted.

---

## 3. Couplings and gaps

### Both windows deep-link a Blacksmith script file

`window-shop.js:1` and `window-merchant-config.js:1` import `BlacksmithToolWindowBaseV2` from
`/modules/coffee-pub-blacksmith/scripts/window-tool-base.js`. `api-window.md` is explicit that base classes
come from `module.api` and that **file paths are not the stable contract** — and its own version history
records the `window-base-v2.js` re-export shim already being removed, so this is a path that has moved once.

This is not a fork and nothing drifts, which is why it has stayed invisible. The cost is all in one moment:
the day that file is renamed, both imports throw at module evaluation and a failed ESM import takes the
**whole module** down rather than one window. That file is under active development — it is where `openFor`
just arrived — which is the argument, live.

`merchant.js:6` is a different case and stays: `/modules/coffee-pub-blacksmith/api/blacksmith-api.js` is the
documented bridge, shown that way in `api-core.md` and `api-sockets.md` both.

### Localisation — not done, and it should be

**Every string in this module is hardcoded English.** `lang/en.json` is a stub and there is not a single
`game.i18n` call in `scripts/`. This was not a decision; it is an omission that ran the whole length of the
build without being noticed, and it is recorded here rather than quietly fixed later because the cost of
retrofitting it grows with every string added.

Scope, so nobody has to survey it twice:

- Roughly 200 strings across `scripts/window-shop.js`, `scripts/window-merchant-config.js`,
  `scripts/manager-merchant.js` (the refusal messages), and the two window templates.
- The refusal messages are the awkward part. They are written as prose with a voice — *"That would be
  trading with yourself"*, *"Somebody is short of the coins that were meant to change hands, and nothing
  moved"* — and a key table tends to flatten that into labels. Whoever does this should treat keeping the
  voice as part of the job, not as a nice-to-have.
- Tooltips carry meaning that the control does not, so they are not optional strings.
- `SHELF_PRESETS` names and hints, `SHOP_KINDS` labels, and `ITEM_CATEGORIES` labels are data in `const.js`
  and want keys rather than literals.

Do this **before** the next feature that adds user-facing text, not after.

### Trading hours and restocking hand-roll what `api.worldClock` does

`_registerScheduleWatcher`, `_onWorldTimeChange` and `_applyRestocks` diff world time themselves.
`api-worldclock.md` exists for exactly this and states the reason: `updateWorldTime` only says the number
moved, and the edge cases *are* the job — a rest advancing eight hours, a GM winding the clock back, one
jump crossing the same daily boundary several times. It hands over a `crossings` count rather than resolving
it, which is the same judgement our restock cadence already makes in its own way.

**Evaluate rather than adopt on sight.** Two things must survive it. `isOpen` stays *derived* — that was the
fix in `7fd1267`, and a scheduler is precisely what tempts somebody back into storing the state it fires
about; a schedule here triggers a refresh and a restock, never a write of open/closed. And `dailyAt` is
per-shop, so each merchant wants its own registration keyed by uuid and re-registered whenever its hours
change — which may well be worse than one watcher over every merchant. Answer that by reading their
implementation, not by guessing here.

### Three raw `Hooks.on` registrations, none of them disposable

`_registerStockWatcher` binds `updateItem`, `createItem` and `deleteItem`; `_registerScheduleWatcher` binds
`updateWorldTime`. `BlacksmithHookManager.registerHook` gives context-based cleanup — the same shape as
`tokens.disposeByContext`, which `teardown()` already uses for the interaction claim, so half of teardown
disposes cleanly today and half cannot be undone at all.

The item watchers also want throttling, which is the practical half: a GM dragging a stack between shelves
fires `updateItem` per document, and every one of those broadcasts a refresh to every connected client.
`api-hookmanager.md` names two combinations that fail silently — `throttleMs` with `debounceMs` discards the
debounce, and `once` with `debounceMs` never runs the callback at all.

---

## 4. Nits and known gaps

- **Refreshes ride a raw `game.socket` channel.** `_broadcastRefresh`, `broadcastActorRefresh` and
  `_registerRefreshListener` emit and listen on `module.coffee-pub-merchant` directly, while `api.sockets`
  wraps SocketLib with a native fallback and a `waitForReady()`. Nothing authoritative rides on it — it
  tells open windows to redraw, and every mutation goes through the envelope — which is why it has been
  fine. But once `gmRequest` is adopted this is the **only** place left where Merchant talks to core
  directly on a surface Blacksmith owns, and "it is only a redraw" is how a second transport acquires a
  second consumer.
- **Two small ones, while anyone is in these files.** `window-merchant-config.js` declares `removeShelf`
  twice in `ACTION_HANDLERS` (lines 59 and 65). They are identical so nothing misbehaves, but the second
  silently wins and an edit to the first would do nothing — a bad half-hour. And the comment above
  `_broadcastRefresh` (`manager-merchant.js:1521`) still reads *"Stock is infinite, so a refresh is only for
  the GM changing what is on offer"*, false since phase 5. A comment lying about the stock model, on the
  function that tells every client to redraw, is one a reader has every reason to trust.
- **Sell as the party is untried.** The path exists — the party Group Actor is in the "Buying as" list and
  the same code serves it — but a Group Actor's inventory and purse have never been exercised by it.
- **The GM has no way to hand something over for free.** Deliberate: the take-without-paying control was
  removed on the understanding that free goods return as part of a wider change. Until then, a GM drags from
  the merchant's sheet.

---

## Standing rules — inherited lessons

These cost Curator real time. They apply here identically and there is no reason to relearn them.

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
  exactly the situation `plans/plan-extraction.md` says to hand over rather than write twice. Check what
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
