# TODO

Shipped work lives in `CHANGELOG.md`. This file is for what is still open, what must not be repeated, and
what has been considered but not scheduled.

**Where things go:** `documentation/architecture/` describes implemented systems, `documentation/plans/`
records intent and reasoning, `documentation/testing/` holds verification checklists.

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
  honest path only; the GM-side check is what makes a policy real.
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

## Caller identity is not verified (must close before money)

A GM-authoritative handler cannot tell who actually asked. Core invokes a query handler as
`handler(queryData, { timeout })` with no caller id, and `game.socket.emit` delivers no sender either, so the
id travels in the payload and any client could assert a different one.

Harmless today: stock is infinite and free, so the worst outcome is a free item from a shop that gives items
away. **Not harmless once money exists** — `_validateRecipient` leans on `user.isGM`, which a spoofed id
satisfies.

Raised with Blacksmith, since their shared envelope will inherit the same limitation. Until it is solved,
validate what is being asked for rather than who claims to be asking.

## Open

- **Stocking from compendiums** (`plans/plan-merchant.md` phase 6). A GM-only search-and-add panel in the
  shop window, so *"do you have any special armour?"* is answered at the table. Blacksmith's
  `compendiums.search()` and `inventory.grantItem()` cover both halves already; the only missing piece is a
  `container` option on `grantItem` so an item can land on a shelf in one write rather than two.
  **Nothing blocks this** — it needs only the shelf model, so it can move ahead of the money work whenever it
  becomes the more annoying gap.
- Decisions A–E in `plans/plan-merchant.md` section 14 — settled 2026-08-09, recommendations accepted.
- Two Blacksmith asks, raised 2026-08-09: a GM request/response socket envelope, and a two-sided `exchange`
  primitive that gates the money phase.
