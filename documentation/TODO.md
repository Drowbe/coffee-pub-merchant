# TODO

Shipped work lives in `CHANGELOG.md`. This file is for what is still open, what must not be repeated, and
what has been considered but not scheduled.

**Where things go:** `documentation/architecture/` describes implemented systems, `documentation/plans/`
records intent and reasoning, `documentation/testing/` holds verification checklists.

`architecture/architecture-merchant.md` is the map: what the system does and how the pieces fit. Read it
before changing anything, and change it in the same commit as the thing it describes. A map that lies is
worse than no map.

## Critical — rescanned 2026-08-19, after Blacksmith shipped three surfaces

Two halves. The first is **three APIs that landed the same day this was written**, each of which deletes
code here — those are the ones to act on. The second is four couplings found by reading Merchant against
`coffee-pub-blacksmith/documentation/api/`; none is a bug the table would see, and they are listed because
they share the shape every entry under *Inherited lessons* was written about after it had already cost time.

Dated because this file asks for that. Check each against the code before believing it.

### The three that landed — and none of them is committed yet

`api-gm-request.md`, `api-party.md` and the `openFor` registry in `api-window.md` all appeared on
2026-08-19. In Blacksmith's working tree `scripts/api-gm-request.js` and `scripts/api-party.js` are
**untracked**, and `scripts/window-tool-base.js` and `scripts/blacksmith.js` are **modified** — so all three
are live in this world and none is committed.

The rule this file already set for `setCurrency` applies unchanged: **plan against them, do not call them
until Drowbe has committed.** Re-check `git status` in `coffee-pub-blacksmith` rather than trusting this
paragraph, which was true at the hour it was written.

- **`blacksmith.gmRequest` — `gm-request.js` becomes a deletion, as promised.** This is the surface
  `architecture-merchant.md` §8 and §11 have been waiting for, and it arrived with the contract those
  sections predicted: `registerOp({ op, module, handler })`, `request(op, payload, { timeout })`, and a
  handler invoked as `(payload, user)` where **`user` is a verified `User` the caller could not have
  forged**.

  What changes here. `_process(op, payload, userId)` takes the User it is handed instead of resolving one
  from `game.users.get(userId)`; the `userId` field comes out of every request payload **in the same
  change**, because leaving it in is the hole rather than a redundancy; op routing stops being our
  `if (op !== 'settle')` and becomes their registration. The local-GM shortcut becomes theirs — a GM runs
  the handler locally, no round trip — so ours goes with the file.

  Four things to get right, all stated in `api-gm-request.md` and none of them guessable. Ops must be
  **module-prefixed** (`coffee-pub-merchant.settle`). Registration happens on **every** client, not only the
  GM's — one that registered nothing answers `UNKNOWN_OP`, and `MerchantManager.initialize()` already runs
  for everyone, so this is satisfied by not "optimising" it later. Re-registering an existing op is
  **refused rather than overwritten**, so any path that registers twice needs `unregisterOp`. And
  `IDENTITY_UNVERIFIED` is a refusal to **report, not to work around** — the envelope will not answer from a
  claimed identity, which is the whole point of it.

  `_explain` needs the three codes we cannot currently say: `UNKNOWN_OP`, `QUERY_UNAVAILABLE`,
  `IDENTITY_UNVERIFIED`. `NO_ACTIVE_GM`, `NO_QUERY_PERMISSION`, `TIMEOUT` and `HANDLER_ERROR` already match
  ours exactly — which is what writing `gm-request.js` against the eventual shape was for.

- **`blacksmith.party` — extraction (d) landed, and it names the distinction we never had to make.**
  `party.acting()` is ours: `system.playerCharacters`, with the no-primary-party fallback to player-owned
  actors that `getPartyCharacters` reinvents at `manager-merchant.js:1080`. `party.resting()` is Rest's
  `system.creatures`, which includes familiars and companions. A familiar rests with the party and cannot
  buy a sword, so **reaching for the wrong one gives a roster that looks right in testing** — take
  `acting()`, never `resting()`.

  `party.actor()` replaces `getPartyActor`. Two things stay ours, and their doc says so: it returns facts
  rather than decisions, so the ownership filtering in `getEligibleRecipients` and `canActAs` is not theirs
  to take. And `hasPrimaryParty()` is worth surfacing in Merchant Settings — *"no primary party set"*
  explains an odd Buying-as list far better than the list does.

- **`BlacksmithToolWindowBaseV2.openFor` — extraction (c) landed; both windows drop their registries.**
  `static openFor(target, options)`, plus `isOpenFor`, `openWindowFor`, `openWindows`, `closeFor`, and a
  `static keyFor(target)` keyed on `uuid` by default. Windows deregister themselves on close.

  That deletes `ShopWindow._windows` with its `static open`, `closeForToken` and `_onClose` bookkeeping
  (`window-shop.js:116-227` and `:1899`) and the same again in `MerchantConfigWindow` (`:38-88`, `:885`).
  `refreshForToken` and `refreshForActor` become filters over `openWindows()` rather than map walks.
  **Registries are per subclass**, so a Shop and Curator's Loot opened against one token do not evict each
  other — the case a shared registry would have got wrong. Do this in the same sitting as the item below:
  it is the same file.

### Four couplings, unchanged since the first scan

- **Both windows deep-link a Blacksmith script file.** `window-shop.js:1` and `window-merchant-config.js:1`
  import `BlacksmithToolWindowBaseV2` from `/modules/coffee-pub-blacksmith/scripts/window-tool-base.js`.
  `api-window.md` is explicit that base classes come from `module.api` and that **file paths are not the
  stable contract** — and its own version history records the `window-base-v2.js` re-export shim already
  being removed, so this is a path that has moved once.

  This is not a fork and nothing drifts, which is why it has stayed invisible. The cost is all in one
  moment: the day that file is renamed, both imports throw at module evaluation and a failed ESM import
  takes the **whole module** down rather than one window. That file is under active edit right now — it is
  where `openFor` just arrived — which is the argument, live.

  `merchant.js:6` is a different case and stays: `/modules/coffee-pub-blacksmith/api/blacksmith-api.js` is
  the documented bridge, shown that way in `api-core.md` and `api-sockets.md` both.

- **Trading hours and restocking hand-roll what `api.worldClock` already does.** `_registerScheduleWatcher`,
  `_onWorldTimeChange` and `_applyRestocks` diff world time themselves. `api-worldclock.md` exists for
  exactly this and states the reason: `updateWorldTime` only says the number moved, and the edge cases *are*
  the job — a rest advancing eight hours, a GM winding the clock back, one jump crossing the same daily
  boundary several times. It hands over a `crossings` count rather than resolving it, which is the same
  judgement our restock cadence already makes in its own way.

  **Evaluate rather than adopt on sight.** Two things must survive it. `isOpen` stays *derived* — that was
  the fix in `7fd1267`, and a scheduler is precisely what tempts somebody back into storing the state it
  fires about; a schedule here triggers a refresh and a restock, never a write of open/closed. And `dailyAt`
  is per-shop, so each merchant wants its own registration keyed by uuid and re-registered whenever its
  hours change — which may well be worse than one watcher over every merchant. Answer that by reading their
  implementation, not by guessing here.

- **Three raw `Hooks.on` registrations, none of them disposable.** `_registerStockWatcher` binds
  `updateItem`, `createItem` and `deleteItem`; `_registerScheduleWatcher` binds `updateWorldTime`.
  `BlacksmithHookManager.registerHook` gives context-based cleanup — the same shape as
  `tokens.disposeByContext`, which `teardown()` already uses for the interaction claim, so half of teardown
  disposes cleanly today and half cannot be undone at all.

  The item watchers also want throttling, which is the practical half: a GM dragging a stack between shelves
  fires `updateItem` per document, and every one of those broadcasts a refresh to every connected client.
  `api-hookmanager.md` names two combinations that fail silently — `throttleMs` with `debounceMs` discards
  the debounce, and `once` with `debounceMs` never runs the callback at all.

- **Refreshes ride a raw `game.socket` channel.** `_broadcastRefresh`, `broadcastActorRefresh` and
  `_registerRefreshListener` emit and listen on `module.coffee-pub-merchant` directly, while `api.sockets`
  wraps SocketLib with a native fallback and a `waitForReady()`.

  Nothing authoritative rides on it — it tells open windows to redraw, and every mutation goes through the
  envelope — which is why it has been fine and why it is last. But once `gmRequest` lands, this is the
  **only** place left where Merchant talks to core directly on a surface Blacksmith owns, and "it is only a
  redraw" is how a second transport acquires a second consumer.

- **Two small ones, while anyone is in these files.** `window-merchant-config.js` declares `removeShelf`
  twice in `ACTION_HANDLERS` (lines 59 and 65). They are identical so nothing misbehaves, but the second
  silently wins and an edit to the first would do nothing — a bad half-hour. And the comment above
  `_broadcastRefresh` (`manager-merchant.js:1521`) still reads *"Stock is infinite, so a refresh is only for
  the GM changing what is on offer"*, false since phase 5. A comment lying about the stock model, on the
  function that tells every client to redraw, is one a reader has every reason to trust.

## Inherited lessons

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

## Catalogue mode (idea, not scheduled)

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

## Canvas marker for merchant tokens (idea, not scheduled)

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

## Caller identity: waiting on the envelope, not on us

Foundry **does** know who called, and knows it in a way no client can forge — `#handleUserQuery` resolves the
querying User from the authenticated socket and throws if they do not exist. It then drops them without
passing them to the handler. So the identity exists and is trustworthy; what is missing is a forward.

Merchant currently asserts the caller id in its query payload, which is a **bridge, not a design** — it is
precisely the step that turns a verified identity into a client-supplied one. No consumer can recover the
real caller; only the envelope can reattach it.

**Do not build a mitigation for this.** An earlier note here proposed rewriting authorization to avoid
identity checks entirely; that answers a problem we do not have and would rule out ownership checks, which
are the natural way to authorize a purchase. `user.isGM` and `testUserPermission` are fine *provided the user
comes from the envelope*. When Blacksmith's surface lands, `userId` comes out of the payload in the same
change and handlers read the User they are handed.

## Open

Every phase in `plans/plan-merchant.md` is built, and `blacksmith.inventory.exchange` has shipped, so
nothing in the money path is blocked any more.

- **`testing/testing-merchant.md` is the checklist**, and it is current. Every feature here has been run in
  Foundry as it was built — the module is developed against a live world, and most of what is in `CHANGELOG`
  arrived as a correction to something seen on screen. What `tests/` adds is the half a table cannot check
  by looking: making change across 5,151 purse/price combinations, stock policy, the restock cadence, the
  lock, the trading-hours derivation, stock depth, and the search filter.

  **A note for whoever inherits this.** An earlier version of this file claimed nothing since `beb8f41` had
  been run in Foundry. That was written during two unattended sessions, when it was true, and never retired
  when it stopped being true. It then got repeated as fact in a handoff review, against a page of evidence
  to the contrary. If you find a claim here about what has or has not been verified, check its date against
  the git log before you believe it — and if you are the one writing such a claim, put an expiry on it.
- **Read `DECISIONS-TO-REVIEW.md`** before changing the transaction model. Its first entry is out of date in
  one respect: `exchange` shipped with both `copy` and `preserveEmptySource`, so buying is one atomic call
  again and the grant-then-charge failure it describes cannot happen.
- **Sell as the party is untried.** The path exists — the party Group Actor is in the "Buying as" list and
  the same code serves it — but a Group Actor's inventory and purse have never been exercised by it.
- **The GM has no way to hand something over for free.** Deliberate: the take-without-paying control was
  removed on the understanding that free goods return as part of a wider change. Until then, a GM drags from
  the merchant's sheet.
- **`setTillGold` writes currency directly**, outside `api.inventory`. The primitives move deltas between
  purses and refuse negatives, so "this shop now holds 40 when it holds 250" is not expressible. It is a GM
  editing an NPC's own purse rather than a transaction, so it may be correct to sit outside — but if that
  boundary should hold absolutely, the ask to Blacksmith is a `setCurrency` with no counterparty.
- **The Blacksmith asks were sent and answered, 2026-08-19.** Where each stands:
  - **Grant quantity ceiling — DONE and reverted here.** `_resolveQuantity` takes `drawsDown`.
    `_withinLimits` is back to one entry per row. A leftover `INSUFFICIENT_QUANTITY` now diagnoses itself as
    an out-of-date Blacksmith, because the symptom otherwise looks like a Merchant bug.
  - **Caller identity — open, and agreed as a known hole.** Nothing to build. `gm-request.js` is a deletion
    when it lands. **Do not build a mitigation.**
  - **`setCurrency` — DONE, adopted 2026-08-19.** `setTillGold` goes through it, keeping our own GM gate.

    ```js
    await blacksmith.inventory.setCurrency({ targetActorUuid, currency: { gp: 250 } });
    // { ok: true, currency: { gp: 250 }, previous: { gp: 40 } }
    ```

    Three things differ from what was asked for, each worth knowing before writing against it:
    - **It is not GM-gated, and must not be.** `api.inventory` owns no permission checks anywhere — that is
      the rule the whole surface rests on. **We gate it.** `setTillGold` already checks `game.user.isGM`,
      so the call site needs no change on that account.
    - **Only the denominations named are written.** `{ gp: 250 }` leaves silver alone rather than zeroing
      it. Do not assume the omitted ones are cleared.
    - **It returns `previous`.** A GM setting a till by hand is exactly the operation somebody wants to
      undo, and that value is otherwise gone. Worth surfacing rather than discarding.

    Until it ships, `setTillGold` is a **known race**, not a preference: the raw write bypasses the
    inventory mutex, so a GM editing the till while a purchase settles can have their edit silently
    overwritten by `exchange` writing `current + delta` from a read taken before it.
  - **`omitFlags` — DONE, adopted 2026-08-19**, with `ignoreFlags` alongside it for the migration.

    ```js
    await blacksmith.inventory.exchange({ transfers: [...], omitFlags: ['coffee-pub-merchant.par'] });
    ```

    Call-level on `grantItem`, `grantItems`, `transferItem`, `transferItems` and `exchange`. Named paths
    are deleted from the arrival payload before our own `flags` are merged, so declaring a path in both is
    coherent.

    **Why we need it.** `registerTransientFlag` hides a flag from *merge comparison*; it does not strip it
    from the payload. So `par` travels out on every item bought from a counted shelf, sits in the buyer's
    inventory, and travels back if they sell it. See the buyback guard in `getStock` for what that caused.

    When it lands: pass `omitFlags: ['coffee-pub-merchant.par']` on the goods legs in `_goodsTransfers`.
    **Pass the same path in `ignoreFlags` too, for a while.** Items bought *before* this lands carry `par`
    on the buyer's rows, so an arrival without it will not merge with them — a silent, self-inflicted
    duplicate-row bug with a long tail. Blacksmith flagged this; it is the kind of migration cost that is
    invisible until somebody reports "it made a second stack".

    The `getStock` buyback guard **stays** after this ships. It is correct on its own terms and it covers
    every item already in a world with the flag on it.

  - **Extractions — (c) and (d) agreed, (a) resolved in our favour, see `plans/plan-extraction.md`.**

  **This is a relationship, not a file.** Somebody has to own the reply, take the answer, and delete our
  side of it when each lands. If nobody owns it, workarounds quietly become the design.
- **Four extractions to Blacksmith**, each with two consumers proving the shape — `plans/plan-extraction.md`.
  Re-measured after `dialog.wait()` gained `controls`: the helpers shrank but got *more* alike, so they still
  qualify. Nothing is blocked on them.
- **The query envelope still does not forward the caller.** See *Caller identity* above. One deletion on our
  side when it lands.
- Decisions A–E in `plans/plan-merchant.md` section 14 — settled 2026-08-09, recommendations accepted.

## Localisation — not done, and it should be

**Every string in this module is hardcoded English.** `lang/en.json` is a 34-byte stub and there is not a
single `game.i18n` call in `scripts/`. This was not a decision; it is an omission that ran the whole length
of the build without being noticed, and it is recorded here rather than quietly fixed later because the cost
of retrofitting it grows with every string added.

Scope, so nobody has to survey it twice:

- Roughly 200 strings across `scripts/window-shop.js`, `scripts/window-merchant-config.js`,
  `scripts/manager-merchant.js` (the refusal messages), and the two window templates.
- The refusal messages are the awkward part. They are written as prose with a voice — *"That would be
  trading with yourself"*, *"Somebody is short of the coins that were meant to change hands, and nothing
  moved"* — and a key table tends to flatten that into labels. Whoever does this should treat keeping the
  voice as part of the job, not as a nice-to-have.
- Tooltips carry meaning that the control does not, so they are not optional strings.
- `SHELF_PRESETS` names and hints, `SHOP_KINDS` labels, and `ITEM_CATEGORIES` labels are data in
  `const.js` and want keys rather than literals.

Do this **before** the next feature that adds user-facing text, not after.

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
