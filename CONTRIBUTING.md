# Contributing

The conventions this codebase actually follows. They are not stylistic preferences — each one is here
because breaking it has cost real time, in this module or in Curator next door.

Read `documentation/architecture/architecture-merchant.md` first for what the system does.
Read `documentation/TODO.md` § *Inherited lessons* before writing anything. It is the shortest document
here and the highest-value one.

---

## 1. Comments say **why**, and name what was rejected

This is the single most distinctive thing about this codebase and the easiest to lose.

A comment that says what the code does is noise — the code already says that, and says it more reliably.
A comment earns its place by carrying something the code cannot: the alternative that was tried, the bug
that made this shape necessary, the reason the obvious version is wrong.

```js
// Handles together is a window with no hours in it, and a shop with no hours in it
// is shut. The other reading -- treating it as "always" -- gave two gestures for
// open and none for closed, which is exactly the ambiguity the whole-span rule was
// meant to remove.
if (open === close) return false;
```

Not:

```js
// Return false if open equals close
if (open === close) return false;
```

The test: **would a competent developer, six months from now, be tempted to "fix" this line?** If yes, the
comment exists to stop them, and it must say what would go wrong. If no, it probably does not need a
comment at all.

Three habits that follow from this:

- **Record the rejected option.** "Considered and rejected: using the container's `equipped` state for
  this" is worth more than any description of what was chosen.
- **Name the failure, not the feature.** `_withStockLock` is not commented "serialises stock access"; it is
  commented with the race it exists to prevent and why one GM client makes it sound.
- **When a bug drove the design, say which bug.** The derived-open-state comment names the symptom a GM
  would have seen. That is what makes it un-revertable by accident.

Comment density should match the surrounding file. Pricing arithmetic is dense with them because it is
subtle and untestable by eye; a template loop is not.

---

## 2. Never fork a Blacksmith component

A copy taken before a fix keeps the problem the hub has solved and can never pick up anything landing
later. Curator carried two forks — `ui-context-menu.js` and `manager-hooks.js` — both with bugs already
fixed upstream.

**To check:** compare your filenames against `coffee-pub-blacksmith/scripts/`. A shared name is the tell.

Related, and separately expensive: **before building any window, check whether one already exists.**
Merchant shipped its own compendium search and deleted it the same day, because Blacksmith already had a
better one whose result rows drag the exact payload our shelf drop targets read. The mistake was finding a
documented *primitive* (`search()`) and concluding no *feature* was built on it. That does not follow.
Check `blacksmith.openWindow` for a registered id, `documentation/api/api-window.md` for the registry, and
the Blacksmith toolbar and menubar.

---

## 3. Read the whole API page, not a keyword

This has produced two separate defects here, and it is the failure most likely to happen again.

Merchant asked "is there a drop helper in `api-inventory`?", searched that file for *drop* and *drag*,
found nothing, and moved on. The answer was correct — and three unrelated rules on that same page were
being broken: `registerTransientFlag` must be called by whoever writes a flag to items, arrival flags
belong in the `grantItem` call rather than a follow-up `setFlag`, and `items` is an array so one leg per
line batches nothing. **None of them contain the word "drop".**

**Read the whole page for any API you call more than once**, and re-read it when that API ships something
new — the rules around `exchange` arrived in the same release as `exchange`.

When an API misbehaves, read its **source** before working around it. The `INSUFFICIENT_QUANTITY` defect
in `grantItems` was diagnosed in about four minutes by opening `api-inventory.js` and reading
`_resolveQuantity`. A workaround built without that would have been a guess.

---

## 4. Re-check documents after every `await`

Anything writing to a Token, or to an Actor belonging to one, must confirm it still exists **after** each
await. A guard at the top of an async function proves nothing ten awaits later. For a scheduled callback
the check goes *inside* the timer, because the delay is exactly the window in which the document is
deleted.

An unlinked token's Actor is synthetic and dies with its token, so checking the Actor never catches it.
Foundry reports this as `undefined id [...] does not exist in the EmbeddedCollection`.

The same reasoning covers user input arriving faster than a re-render: claim the id before the first
await, release it in `finally`, and re-read the document afterwards rather than trusting a reference
captured before. See `removeStock` in `window-shop.js`.

---

## 5. Hiding a control is not a rule; refusing the request is

A setting that hides a button removes it from the honest path only. The GM-side check is what makes a
policy real, and it applies to *disabled* as much as to hidden: out of stock is a refusal in
`_processSettle`, not merely a greyed button.

Corollary, and it is a design rule rather than a security one: **a control that cannot act should say why,
not disappear.** An absent button reads as "this shop does not do that"; a disabled one naming its reason
reads as "not right now, and here is what would change it". It also keeps the layout still on the day the
missing thing arrives.

Where the two meet — GM-only affordances — prefer **not binding** the behaviour over refusing inside the
handler, so the cursor changes only where the click works. The affordance and the permission become the
same fact. See `_bindItemSheets`.

---

## 6. State shape

- **Merchant state is on the Actor, never the Token.** See the architecture doc §3. This is the sharpest
  divergence from Curator and the one most likely to be got wrong out of habit.
- **Derive rather than store, where the derivation is cheap.** `isOpen` was a stored flag kept in step by a
  hook, and every bug it had was a version of "the thing that syncs the state did not run". If a value can
  be computed at the moment it is asked for, compute it.
- **`null` in a shelf config means inherit**, matching `markup`. Do not invent a second sentinel.
- **If you add a flag that lives on an item, register it** with `registerTransientFlag`, or it will not
  survive a transfer.
- **One write per Actor.** Batch creates, updates and deletes. dnd5e recomputes encumbrance on every item
  write against one fixed effect id with no lock, so N writes to one Actor are N racing recomputes. This is
  why `_recordAgreedPrices` builds an array and writes once.

---

## 7. Tests

`tests/` is dependency-free Node — `node tests/test-pricing.mjs` and so on, no runner, no config.

It covers the half a table cannot check by looking: currency arithmetic, stock policy, the restock cadence,
the lock, the trading-hours derivation, stock depth, the search filter. **If you write a pure function,
test it** — that is what makes it worth having extracted.

Be honest about what this does and does not prove. `node --check` will happily pass a variable referenced
out of scope; only opening the window catches that. Tests here are a floor, not a ceiling, and
`documentation/testing/testing-merchant.md` is the rest of it.

---

## 8. Commits and docs

- Commit messages say **why**, in prose, same as comments. The subject is what changed; the body is what
  was wrong before and what would go wrong if it were reverted.
- `CHANGELOG.md` entries name the files, and explain the reasoning — they are the durable record. Whole
  paragraphs are fine and normal here.
- Update `documentation/architecture/architecture-merchant.md` in the **same commit** as a change to how
  the system works.
- `documentation/TODO.md` holds what is open, what must not be repeated, and what was considered and not
  scheduled. Put a date on anything that will expire.

---

## 9. Blacksmith is a relationship, not a dependency

Four helpers are queued for extraction to Blacksmith, each with two consumers agreeing line-for-line
(`documentation/plans/plan-extraction.md`). **Two consumers is the bar** — one is a guess about what is
general, two that agree is evidence.

When something in Blacksmith is wrong, say so with the file, the line, and the reasoning, and propose the
smallest change. Do not fork it and do not build a mitigation that becomes permanent. Two open asks are
recorded in the architecture doc §11; both resolve to *deletions* on our side when they land.
