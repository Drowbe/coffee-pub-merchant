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

### 1. `_askQuantity` — 82% identical over 49 lines. **Extract.**

`window-shop.js:249` and `window-loot.js:381`. A dialog wrapping `blacksmith.quantitySplit` with
`blacksmith.dialog.wait`, plus the bind-or-read-the-form fallback and integer clamping.

Everything that differs is a label: the input name, the dialog title, the confirm text, and whether the
slider starts at 1 or at the maximum. Nothing structural differs at all — including the fallback that reads
the form when the control failed to bind, which is the subtle part and which both modules got to
independently.

**Shape:** `blacksmith.dialog.quantity({ max, value, title, label, confirmLabel, confirmIcon })` returning a
clamped integer or `null`. It belongs beside `dialog.confirm` and `dialog.choose`, which already exist.

### 2. `_pickActor` — 87% identical over 30 lines. **Extract.**

`window-shop.js:186` and `window-loot.js:349`. An entity-list picker: build a Blacksmith entity list of
actors, put it in a dialog, read the selection back.

Differences: the dialog title, and Merchant parameterised the confirm button where Curator hardcoded it.
That is the *only* divergence, and it is Merchant generalising a thing Curator had already written — which
is exactly the signal this exercise looks for.

**Shape:** `blacksmith.dialog.pickActor({ title, actors, confirmLabel, confirmIcon })` returning a uuid or
`null`.

### 3. `_attachWhenRendered` — same ~10 lines of logic, differently commented. **Fix upstream, do not extract.**

`window-shop.js:22` and `window-loot.js:22`. Poll animation frames until an embedded control's input is in
the document, then `attach()` it.

This is not a helper both modules happened to need. It is a **workaround for the same gap**: `dialog.wait()`
takes markup and exposes no render hook, so a control handed to it is never attached, and the failure is
silent — the inputs still render and still report a value, so an unbound entity list hands back its initial
selection rather than the user's.

Extracting the workaround would bless it. The fix is for `dialog.wait()` to attach controls it was given, at
which point both copies delete rather than move. **Raised with Blacksmith.**

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
- **`registerInteraction` blocks** — 19 identical lines including comments, but they are a *call site*, not a
  helper: the same API used the same correct way twice. Worth noting that the identical comments are both
  warnings (the matcher must be synchronous and stable; `bypassPermission` is required because Foundry's
  predicate runs first), which suggests the warnings belong in `api-tokens.md` rather than in each caller.
- **`const.js` MODULE scaffold** — every Coffee Pub module has it, and it is the one file that must not
  depend on anything else.

## What this does not cover

`gm-request.js` has no Curator counterpart to compare against — Curator predates the query API. It is
already marked in `TODO.md` as a file that should be a deletion rather than a rewrite once Blacksmith owns
the envelope, which is the same conclusion by a different route.
