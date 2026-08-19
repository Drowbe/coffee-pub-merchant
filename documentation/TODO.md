# TODO

Shipped work lives in `CHANGELOG.md`. This file is for what is still open, what must not be repeated, and
what has been considered but not scheduled.

**Where things go:** `documentation/architecture/` describes implemented systems, `documentation/plans/`
records intent and reasoning, `documentation/testing/` holds verification checklists.

`architecture/` is deliberately empty. It describes what the system *does*, and nothing since `beb8f41` has
been run in Foundry — writing it now would be recording what the code says rather than what it does.

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

Every phase in `plans/plan-merchant.md` is now built. What is left is verification and two things that are
not ours to finish.

- **Nothing from `beb8f41` onward has been run in Foundry.** The pure-arithmetic parts *are* verified —
  `tests/` runs making change across 5151 purse/price combinations, plus stock policy, the restock cadence
  and the lock — but that is the small half. That is prices, cart, checkout, the payer rule,
  and the whole of stock policy. `documentation/testing/testing-merchant.md` is current and is the list.
  **This is the only thing standing between the module and being real**, and it needs a table rather than
  more code.
- **Read `DECISIONS-TO-REVIEW.md`.** Seven calls taken unattended on 2026-08-18, ordered by how much they
  want a second opinion. The first one changes the transaction model.
- **Waiting on Blacksmith — `inventory.exchange` does not exist.** Buy, Sell and Checkout are complete and
  end at `EXCHANGE_UNAVAILABLE`. Two shapes were raised while it is still being designed:
  - **Three parties.** The shopper pays, but the goods may go to another character or to the party.
    `{ actorA, actorB }` cannot express it; Merchant refuses it as `THIRD_PARTY_DELIVERY` rather than
    charging the wrong purse.
  - **Copy rather than move on a transfer.** A shop's stock is a count, so the goods half of a purchase is a
    grant. Merchant uses `exchange` for the coin only and delivers separately, which loses the atomicity the
    primitive exists to provide. **Blacksmith has asked which of two primitives we want and is blocked on the
    answer** — `copy: true` (source untouched) or `preserveEmptySource` (a real transfer that leaves the row
    behind at zero). Our answer is *both, and `copy` first*: the count lives in `system.quantity`, so
    `preserveEmptySource` gives finite shelves the better implementation, but only `copy` covers infinite
    shelves — which are the default.
- **Waiting on Blacksmith — the query envelope does not forward the caller.** See *Caller identity* above.
  The payload assertion is a bridge, and the fix is one deletion on our side once it lands.
- **Four extractions to Blacksmith, with two consumers each proving the shape** — `plans/plan-extraction.md`,
  the phase 1b comparison against Curator's loot. Nothing is blocked on them; they are duplication that will
  drift if left. The fifth finding is a workaround written twice and wants an upstream fix instead.
- Decisions A–E in `plans/plan-merchant.md` section 14 — settled 2026-08-09, recommendations accepted.

## Considered, not scheduled

- **Temporarily lowering a count without moving the restock target.** A GM editing a quantity in the shop
  window sets both, deliberately — one number, one meaning. If "the cart was raided but I still keep six"
  turns out to be a thing GMs say, it needs either a second field or a modifier on the edit.
- **Stock that builds up over time.** Restocking refills *to* par however long has passed, so a shop left
  alone for a month is full rather than overflowing. Growing stock would be a different feature, and would
  need a ceiling before it was one.
