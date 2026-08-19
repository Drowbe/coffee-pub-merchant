# Phase 1b — Compare and extract

**Done 2026-08-18.** The plan says: diff what Merchant wrote against Curator's loot equivalent, and whatever
came out verbatim is the extraction list — pieces to move to Blacksmith with two real consumers proving the
shape.

Two consumers is the bar this exercise exists to meet. A helper with one consumer is a guess about what is
general; a helper with two that agree line-for-line is evidence.

## Method

Normalised both codebases to non-blank, non-comment lines and looked for common runs of four or more, then
diffed each candidate directly rather than trusting the run length. Structural braces and bare `return;`
lines are noise and are ignored below.

Compared: `window-shop.js` / `manager-merchant.js` / `merchant-inventory.js` / `merchant-pricing.js` /
`gm-request.js` against `window-loot.js` / `manager-loot.js` / `loot-inventory.js` / `loot-utilities.js` /
`document-liveness.js`.

## Findings

### 1. `_askQuantity` — 87% identical over 38 lines. **Extract.**

> **Re-measured 2026-08-18, after `dialog.wait()` gained `controls`.** Blacksmith asked whether the attach
> workaround was most of what these helpers were. It was not. Both shrank — 49 lines to 38 — and both got
> *more* identical, not less, because what came out was the part that differed slightly between them. What
> is left is the shared shape.

`window-shop.js:249` and `window-loot.js:381`. A dialog wrapping `blacksmith.quantitySplit` with
`blacksmith.dialog.wait`, plus the bind-or-read-the-form fallback and integer clamping.

Everything that differs is a label: the input name, the dialog title, the confirm text, and whether the
slider starts at 1 or at the maximum. Nothing structural differs at all — including the fallback that reads
the form when the control failed to bind, which is the subtle part and which both modules got to
independently.

**Shape:** `blacksmith.dialog.quantity({ max, value, title, label, confirmLabel, confirmIcon })` returning a
clamped integer or `null`. It belongs beside `dialog.confirm` and `dialog.choose`, which already exist.

### 2. `_pickActor` — 83% identical over 35 lines. **Extract.**

`window-shop.js:186` and `window-loot.js:349`. An entity-list picker: build a Blacksmith entity list of
actors, put it in a dialog, read the selection back.

Differences: the dialog title, and Merchant parameterised the confirm button where Curator hardcoded it.
That is the *only* divergence, and it is Merchant generalising a thing Curator had already written — which
is exactly the signal this exercise looks for.

**Shape:** `blacksmith.dialog.pickActor({ title, actors, confirmLabel, confirmIcon })` returning a uuid or
`null`.

### 3. `_attachWhenRendered` — **fixed upstream 2026-08-18. Both copies deleted.**

`window-shop.js:22` and `window-loot.js:22`. Poll animation frames until an embedded control's input is in
the document, then `attach()` it.

This was not a helper both modules happened to need. It was a **workaround for the same gap**, and the
conclusion held: `dialog.wait()`, `prompt()` and `choose()` now take `controls` and bind anything exposing
`attach(root)` after every render. Both copies were deleted rather than moved.

The cause turned out to be worse than a missing feature. Blacksmith's documentation said passing an
`HTMLElement` as `content` preserved its identity and listeners. It does not: DialogV2 reads
`options.content.innerHTML`, keeps only the string, and builds the dialog by assigning `innerHTML` to a fresh
form — so the node handed over is never inserted and any control attached to it is bound to an orphan. Two
modules wrote the same workaround against a documented claim neither of them checked.

There was also an `onRender(element, dialog)` hook on `wait()` the whole time, simply undocumented. Both are
documented now.

**The lesson is not "check the docs".** It is that a silent failure and a confident doc together will produce
the same wrong workaround in every consumer, and the tell was two modules writing it independently — which is
the same signal this whole exercise looks for, pointing at a defect rather than at a missing helper.

### 4. Window construction boilerplate — 80% identical over ~36 lines. **Extract into the base class.**

`window-shop.js:78` and `window-loot.js:79`. The constructor's `mergeObject` dance over `DEFAULT_OPTIONS
.position` and `.window`, the `static _windows` map keyed by token uuid, and the `open()` that returns an
existing window rather than building a second.

Differences: the class name and the id prefix. That is all.

This one belongs in `BlacksmithToolWindowBaseV2` itself rather than in a helper — every consumer of the base
class rewrites it, and a base class that needs thirty lines of identical setup in each subclass is
under-specified. `static openFor(target, options)` with the registry behind it would cover both.

### 5. Party resolution — 10 lines. **Extract, low priority.**

`manager-merchant.js:556` and `manager-loot.js:344`. Read `game.actors.party.system.playerCharacters`, fall
back to every player-owned character when there is no primary party.

Small, but it is a *policy* — "who counts as the party" — and two modules answering it separately will
eventually answer it differently. Better as `blacksmith.entityList.partyCharacters()` or similar.

## Considered and rejected

- **`inventoryApi()` accessors** (`merchant-inventory.js:12`, `loot-inventory.js:15`). Five lines each, and
  they are *supposed* to be thin — the anti-fork rule is about logic, and there is none here.
- **`_validateRecipient`** — 62% similar, and the difference is the point. Loot gates on two settings that
  Merchant does not have; Merchant accepts a party Group Actor that Loot does not. Parallel evolution of
  genuinely different rules, not duplication.
- **`registerInteraction` blocks** — 19 identical lines including comments, but they are a *call site*, not
  a helper: the same API used the same correct way twice. The comments were the interesting part, and the
  answer came back that both warnings **were already in `api-tokens.md`** — the synchronous-and-stable rule
  under "matches", the predicate-runs-first reasoning under "bypassPermission". So this was not a
  documentation gap but a discoverability one: two modules wrote out by hand what the doc already said.
  Both call sites now point at the doc and keep only what is theirs. **Deleted 2026-08-18.**
- **`const.js` MODULE scaffold** — every Coffee Pub module has it, and it is the one file that must not
  depend on anything else.

## What this does not cover

`gm-request.js` has no Curator counterpart to compare against — Curator predates the query API. It is
already marked in `TODO.md` as a file that should be a deletion rather than a rewrite once Blacksmith owns
the envelope, which is the same conclusion by a different route.
