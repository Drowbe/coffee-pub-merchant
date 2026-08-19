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

---

## Blacksmith's reply, 2026-08-19

**(c) window construction — agreed and theirs.** `static openFor(target, options)` on
`BlacksmithToolWindowBaseV2` with the registry behind it. They called a base class needing thirty identical
lines per subclass their defect rather than our duplication, which it is.

**(d) party resolution — agreed, and it is two policies, not one.** Rest uses `party.system.creatures`;
Merchant uses `playerCharacters` with a fallback. Familiars and mounts rest and cannot shop. Both will be
named, and the no-primary-party fallback exposed too, since that is the part every consumer reinvents
slightly differently. This is the outcome the entry hoped for: the policy question got asked once, out
loud, instead of two modules drifting apart quietly.

**(b) `_pickActor`** — no objection raised.

**(a) `_askQuantity` — one question back, and it may move the number.**

> Is the bind-or-read-the-form fallback still doing anything? It existed because binding was unreliable,
> and `controls` made binding reliable. If it is vestigial in both modules, `_askQuantity` loses the part
> you called the subtle bit, and what is left is a label-parameterised dialog. That might be the difference
> between a helper and a documented recipe.

They asked for this to be tested rather than reasoned about. **Reading says it is narrow but not dead**, and
reading is not the test they asked for:

- `attachControls` runs synchronously inside DialogV2's `render` callback, before `onRender` and before
  focusing (`api-dialog.js:270-277`). Nothing is interactive before render, so by the time a button can be
  pressed, `attach()` has run. That kills the case the fallback was originally written for.
- **But `attachControls` swallows what `attach()` throws** — `try { control.attach(root) } catch { log }`
  (`api-dialog.js:203`). A control can fail to bind, be logged, and leave the dialog fully interactive with
  an unbound input. That path is real, and it is the one the fallback still covers.

So the honest reading is that the fallback survives on error paths only. That probably *does* put
`_askQuantity` under the bar — four lines of error handling is not a shared abstraction.

**The better answer, and worth raising back:** if the fallback is only reachable when `attach()` failed,
then every consumer is compensating for a failure the hub already caught and swallowed. That belongs in
Blacksmith rather than in each consumer — either `attach()` reports failure to the caller, or the controls
expose a `readFrom(root)` that works whether or not binding succeeded. Then the fallback leaves both modules
and does not need a home.

**Resolved, 2026-08-19 — and the defect was theirs.**

> `attach()` returns the controller and silently no-ops when it cannot find its input. quantity-split does
> `if (!input) return controller;` and entity-list does `if (!root) return controller;`. Neither tells the
> caller anything. So a consumer writing a fallback is compensating for a failure the hub detected and threw
> away — the same defect class as the doc that said listeners survive.

Of the two shapes proposed, **`readFrom(root)` is the one that deletes our code**, and their reasoning is
better than ours was: reading at submit time should not depend on binding at all. `getValue()` returns state
maintained by a listener, so an unbound control reports its *initial* value — quietly wrong — whereas
reading the input out of the DOM is correct either way. Binding stays for what it is actually for: live
captions and `onChange`. `attach()` reporting failure is worth having too, but it only lets a consumer write
a *better* fallback rather than stop writing one.

They also let us off the empirical check, and were right to: a silently no-op `attach()` is a defect on its
own terms, so the fix stands whether or not our fallback is currently reachable.

**We were exposed, via a getter their note did not name.** Their audit checked `getValue()` and
`getSelection()`; Merchant uses **`getSelectedIds()`**, which routes through the same `readSelection()` and
the same `if (!root) return [...initial]`. Two call sites, and the severity differed sharply:

- `_pickActor` passes `selected: <current character>`, so a failed bind returns **the character the player
  was already on** — they pick somebody else and are silently handed back the original. A wrong answer.
- `sell` passes no initial selection, so a failed bind returns `[]` — picking six things and having nothing
  happen. Confusing rather than wrong.

Both now read the checked inputs from the dialog directly, pending `readIdsFrom`. Worth reporting back: the
exposure survey should cover every getter that calls `readSelection()`, not the two that were named.

**The remeasure is moot: `_askQuantity` has only one consumer now.** Merchant deleted its copy in
`a02058e` — *"Quantity is edited in place, as the loot window does it"* — when the slate replaced per-item
quantity dialogs. Merchant has no `quantitySplit` call anywhere today; the `window-shop.js:249` reference at
the top of this entry is stale.

So (a) fails the bar on its own terms, before any argument about the fallback. **Two consumers is the bar**,
and there is one. Recommend dropping it, and revisiting only if a second consumer appears — at which point
the fallback question will have been settled by `readFrom` anyway.

Worth noting how it went: three separate remeasures were queued for this entry, and what actually decided it
was a consumer disappearing. The measurement was never going to answer the question. What is
left is a label-parameterised dialog, which may well be a documented recipe rather than a helper — and that
is a fine place for this to land. An extraction that dissolves because the underlying defect was fixed is a
better outcome than the helper.

