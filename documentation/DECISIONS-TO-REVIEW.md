# Decisions taken unattended — reviewed and closed 2026-08-19

Built during two unattended sessions, on "build the remainder of the project unattended, log decisions I
need to review." Each entry says what was chosen, what was rejected, and what reversing it would cost.

**Every decision in this file is now closed.** Nothing here is waiting on anybody. It is kept because the
reasoning is worth having when one of these comes up again, and because the rejected options are the part
no one can reconstruct from the code.

Two ways they closed. Some were **ratified in conversation** on 2026-08-19 — asked as options with a
recommendation, answered directly. The rest were **settled by use**: the feature was built on, corrected,
and extended in a live world over the following days, which is a stronger confirmation than an answer to a
question would have been. Each entry says which, and an entry settled by use names what confirmed it.

An earlier version of this header said none of it had been run in Foundry. That was true when written and
false within days; see `TODO.md` for why that mattered.

---

## 1. Buying no longer moves the merchant's item — it grants a copy and decrements a count

**Status: CLOSED — superseded by `exchange` shipping. Worth reading for what it was.**

> `exchange` shipped with **both** primitives this asked for — `copy` for a template row and
> `preserveEmptySource` for a counted one. Buying is a single atomic call again, so the grant-then-charge
> ordering below, and the failure it chooses between, no longer exist. The reasoning about *why* stock is a
> count rather than a document still stands and still governs the code.

`_processBuy` used to hand `exchange` the goods *and* the coin in one call, on the reasoning that a single
primitive holding both locks is the only way to avoid writing rollback. That reasoning still holds. It is
also, on inspection, wrong for this module in two separate ways:

- **With infinite stock it consumes the shop.** `exchange` moves what it is given. The merchant's item is a
  template under the v1 stock model — `grantItem` deliberately never touches the source — so handing that
  item to `exchange` would sell the template itself. The first purchase would empty the shelf. This was
  latent and unreachable (`exchange` does not exist), so nothing broke; it would have broken on the day it
  shipped.
- **With finite stock it deletes the row at zero.** A transfer that takes the last unit removes the source
  item. That loses the shelf layout, and for a restocking shelf it loses the very thing being restocked.

So stock is now **a count, not a document**. Every policy grants a copy to the buyer and adjusts a number:

| policy | on purchase |
|---|---|
| infinite | grant a copy, count untouched |
| finite | grant a copy, count down by one; at zero the row stays, marked out of stock |
| restocking | as finite, and the count returns to par on a cadence |

**The cost is atomicity, and I chose which way it fails.** Goods and coin are now two writes. The order is
grant-then-charge, so a failed payment leaves the player holding the item and the shop out of pocket. The
reverse order would leave a player who paid for nothing. In a game the shop eating it is the right failure —
a GM can fix a stray item in seconds, and nobody at the table feels robbed.

**What would collapse it back to atomic:** an `exchange` whose per-side items can say *copy* rather than
*move*. That is a smaller ask than the three-party one and it is in the Blacksmith note. If they take it,
this becomes one call again and the decision above stops mattering.

**Reversing:** contained in `_processBuy` and `_processCheckout`. Half a day.

---

## 2. Stock policy is per shelf, not per merchant

**Status: CLOSED — settled by use.** Shelf ceilings (`maxProducts`, `maxPerItem`) and per-shelf roll tables
were both built on top of this afterwards, and both would have had nowhere to live under a merchant-wide
policy. A shop in play now runs a Storefront that runs out beside a Back Room that does not.

`config.stock` existed on the merchant from the scaffold and was never read. I made it a **shelf** property
that falls back to the merchant's, exactly as `markup: null` already does.

The argument is that a Storefront restocking nightly and a Back Room holding three unique things is an
ordinary shop, and a single merchant-wide policy cannot describe it. The argument against is one more
inherited field to reason about — but the inheritance pattern is already there for markup, so this adds a
case rather than a concept.

**Reversing:** read `config.stock` in `resolveStockPolicy` and ignore the shelf. One line.

---

## 3. The count lives in `system.quantity`, not in a flag

**Status: CLOSED — settled by use.** GMs edit quantities from the shop window, the Actor sheet, and by
clearing shelves, and all three agree because there is only one number. The predicted failure of the
rejected option — sheet and flag disagreeing — never had a chance to happen.

The alternative was a flag map on the shelf. I rejected it because it is a parallel truth: the moment a GM
edits quantity on the Actor sheet — which they will, because that is where quantity has always been — the
flag and the sheet disagree and one of them is silently wrong.

Using `system.quantity` means the Actor sheet, the shop window, and every other module that reads quantity
are all looking at the same number. It also means a GM can stock a shop entirely from the sheet without
learning anything new.

**Reversing:** expensive. It is threaded through display, purchase, restock, and par.

---

## 4. Par level is "whatever the GM last set by hand"

**Status: CLOSED — ratified in conversation, then amended.** You raised exactly the case this entry calls
its failure mode: *"If the max is 5 but I type 10 in the item row, does that become the new max for that
item, or on next restock does it become 5 again?"* The answer built from that is that a shelf ceiling
clamps par on both write and read, so a hand-set target can never exceed what the shelf will hold.

The remaining gap — temporarily dropping stock *without* moving par — is still not expressible, and is
recorded under *Considered, not scheduled* in `TODO.md` rather than here.

Restocking needs a target, and the target cannot be recovered from a shelf that has been sold down.

I rejected a separate par editor — another number in another place to keep in sync. Instead the quantity
column in the shop window is **editable by a GM on finite and restocking shelves**, and editing it sets both
the count and the par. So the rule is:

- a purchase lowers the count, par untouched
- **a GM setting a quantity by hand sets what it restocks to**
- a restock returns the count to par

Which I think reads as what a shopkeeper means by "I keep six of these."

The failure mode: a GM who wants to *temporarily* drop stock without changing par cannot express it in the
window. They would have to edit the item's flag. I judged that rare enough not to build a control for, but
it is a judgement, not a fact.

**Reversing:** the par flag is written in one place.

---

## 5. Restocking is driven by the world clock, on a per-shelf day count

**Status: CLOSED — settled by use**, and by your standing ruling on world time (*"we have an entire world
time tool. most gms do too. and it is built into core"*). Restock Everything was added later for the
by-hand case, which is the other half of the same need.

It reuses the `updateWorldTime` watcher that already opens and closes shops, so there is no second clock and
no second thing to forget to register. A shelf restocks when `restockDays` in-world days have passed since it
last restocked.

Consistent with your ruling on trading hours — *"we have an entire world time tool. most gms do too. and it
is built into core"* — so I did not add a real-time option or a per-session prompt.

A GM can also restock a shelf immediately from Merchant Settings, which is what "the party cleared me out
last night" needs.

**A consequence worth knowing:** advancing the clock by a week restocks once, not seven times. The watcher
compares elapsed time against the interval rather than counting boundaries. I think once is right — a shop
does not accumulate seven copies of its stock — but if you wanted stock to *build up* over time, this is the
line that says it does not.

---

## 6. Buy and Sell are now disabled-with-reason rather than absent

**Status: CLOSED — your call at the time.** Since promoted to a general rule in `CONTRIBUTING.md` §5: a
control that cannot act says why rather than disappearing.

Your call, taken from the two options offered. Recorded here only because it reverses a rule stated in three
places (`plan-merchant.md` phase 3, `CHANGELOG.md`, `testing-merchant.md`), all of which now say the new
thing. The rule it replaces was *"absent rather than present-and-broken"*; the rule now is that a control
which cannot act says why on hover.

---

## 7. Out of stock is a refusal, not just a greyed button

**Status: CLOSED as a decision.** Since promoted to a general rule in `CONTRIBUTING.md` §5.

**The concurrency risk it names is still open, and is a testing item rather than a decision.** Two players
racing for the last unit is the one thing here that a single-GM development world cannot exercise, and
`testing/testing-merchant.md` carries a specific check for it. The lock is sound in reasoning — exactly one
GM client handles requests — but reasoning is not the same as having seen it.

Zero stock is checked on the GM as well as in the window. This follows the standing rule — *a setting that
hides a control must also refuse the request* — and it is what makes two players racing for the last unit
resolve rather than both succeeding.

That race is real again for the first time. Infinite stock had no concurrency at all; finite stock brings
back the problem loot needed locks to survive. There is now a per-merchant mutex in the manager
(`_withStockLock`), which is sound because exactly one GM client handles requests. **This is the single most
likely place for a bug I cannot see without a table**, and the test doc has a specific check for it.

---

## What else got built, which needed no decisions

- **Phase 1b, the comparison against Curator's loot** — `plans/plan-extraction.md`. Four things to extract to
  Blacksmith, each with two consumers agreeing line-for-line: a quantity dialog (82% identical over 49
  lines), an actor picker (87% over 30), the window-base construction boilerplate (80% over 36), and party
  resolution. A fifth, `_attachWhenRendered`, is the same *workaround* written twice and wants an upstream
  fix rather than a home.
- **Logic checks** — `tests/`, two dependency-free Node scripts. Making change now runs against 5151
  purse/price combinations and nets exactly in all of them, which matters because `api.inventory` will never
  convert denominations, so that arithmetic is ours permanently and nobody else was going to catch it being
  wrong. The stock script covers the lock, including two buyers racing for the last item.

---

## What was open here, and how it closed

- **`exchange` does not exist.** — **Closed.** It shipped, with both `copy` and `preserveEmptySource`.
  Settling is one atomic call again.
- **The three-party gap** — the shopper pays while someone else receives. — **Closed, and withdrawn rather
  than answered.** The party Group Actor went into the "Buying as" list, so payer and recipient are always
  the same Actor and the three-party case stopped existing. The ask to Blacksmith was retracted.
- **Copy-vs-move on an exchange side** — **Closed.** Shipped as `copy`.
- **Untested in Foundry** — **Closed, and it was wrong.** See the header.

---

## Negotiated prices

### D-N1. What the price box edits: each, or the line total

The slate cell shows the **line total**. Double-clicking it opens a box holding the price
**each**, and the tooltip says so ("12 gp each — double-click to change it").

**Why not edit the total.** "The three potions for 40 gp" is how it gets said at a table, and
editing what you can see is the honest gesture. But the price is stored per item, so the total
has to be divided back down: 40 gp for three is 1333 cp each, which shows straight back as
39.99 gp. A number that changes the moment you type it is worse than one that needs a tooltip.

- **A. Edit each, show the total** — what is built. Exact. Needs the tooltip for quantities > 1.
- **B. Edit the total, divide down** — reads better, rounds visibly wrong.
- **C. Show `3 × 12 gp` on the line** — no ambiguity at all, but a fourth number in a narrow
  column that is already tight.

**Recommendation: A.** C is the fallback if you find the tooltip is not enough in play.

**CLOSED 2026-08-19 — A, ratified.** The tooltip reads *"12 gp each — double-click to change it"*.

### D-N2. Agreements are cleared when the trade settles

A negotiated figure lives on the merchant until the trade it was made for goes through, then it
is deleted.

**Why.** Left standing, a discount haggled by one player would quietly become the shelf price
for everyone who came after, and a settled negotiate line would keep a price on the shelf that
exists in order not to have one.

- **A. Clear on settle** — what is built. Each negotiation is its own conversation.
- **B. Keep it** — the shelf remembers. Good if you think of a negotiate shelf as "unpriced
  until first sold, then priced"; bad if two parties should get two different deals.
- **C. Clear buy-side, keep sell-side.**

**Recommendation: A**, but this is the one I would most expect you to overrule — B is a
defensible reading of "that IS the price".

**CLOSED 2026-08-19 — A, ratified.** Each negotiation is its own conversation. A discount one party
haggled does not become the shelf price for the next party, and a negotiate shelf stays a negotiate shelf.

Reinforced afterwards by a related change: a negotiate shelf now shows **no figure in the price column at
all**, agreed or not. Keeping the agreement would have made that column either a lie or a leak.

### D-N3. The price is stamped on the item only when it had none

An item that arrives with no price of its own is written with what was agreed. An item that
already had a price keeps it, however deep the discount.

This is your rule, restated to be sure I read it the way you meant: *a longsword bought cheap is
still worth what a longsword is worth, but a curio negotiated at 200 gp is worth 200 gp.*

**CLOSED 2026-08-19 — confirmed as read.** A discount does not follow the item. If that ever needs to
change it is one branch in `_recordAgreedPrices`.

### D-N4. Unpriced possessions can go in the sell basket

Previously the shop refused anything it had no price for: *"This merchant would not take X."*
That now applies only to things that are not goods at all (spells, features). Anything physical
can go in the basket at TBD for the GM to price, which is the sell-side half of the same
workflow.

**CLOSED 2026-08-19 — ratified.** A party can sell the strange orb they found; the GM names what the
merchant will pay for it.

---

## Decisions taken while fixing, 2026-08-19

Not from an unattended session — these were taken mid-conversation while chasing bugs, and are recorded
here because each replaced something that had already been decided once.

### D-F1. Stock depth follows price, not item type. **CLOSED — corrected in play.**

The first version gated depth behind a whitelist of stackable *types*: consumables and loot stack, gear
does not. It excluded daggers, vials, clothes, chests and tools — a general store's entire shelf — so
every row still arrived at QTY 1 and the feature was invisible.

Cost was always what the intuition meant. Nobody has eight suits of plate because plate is expensive, not
because it is armour. The type list is gone entirely rather than kept as a modifier: a rule firing on type
*and* price is two rules to hold in your head at the moment somebody is asking why their shop looks wrong.

What survives of the idea is narrower and correct — **stackability is read off the document**
(`typeof system.quantity === 'number'`), which is the same rule `api-inventory` states for itself.

**Reversing:** `STOCK_DEPTH_BANDS` in `const.js` is tunable data; `stockDepth` in `merchant-pricing.js` is
twenty lines and fully covered by tests.

### D-F2. Working around `INSUFFICIENT_QUANTITY` rather than waiting for the fix. **CLOSED — shipped.**

`grantItems` validates a requested quantity against the source document's own — for a compendium template
that is 1 — so asking for five crowbars was refused. It is a defect (a grant draws nothing down) and is
with Blacksmith.

Three options were available. **Chosen:** send N entries of quantity 1 and let documented batch coalescing
sum them. **Rejected:** switching to `itemData`, which dodges the check but loses the
`_stats.compendiumSource` provenance the uuid path preserves; and waiting, which leaves restocking broken.

The coalescing behaviour was verified in Blacksmith's source before being relied on, not taken from the doc
alone. Cost is one entry per unit on a batch that can reach a few hundred.

**Reversing:** one marked loop in `_withinLimits`, back to a single entry, the day the fix lands.

### D-F3. Restocking progress uses core's notification, not a Blacksmith or Merchant component. **CLOSED.**

`ui.notifications.info(msg, { progress: true })` gives a bar and an updating message. Blacksmith has no
progress primitive — `api-window.md` names progress bars only as an example of what a consumer might put
in a Tools zone — and building one here would have been a second thing doing a job core already does.

If Blacksmith ever ships a themed progress component, `merchant-progress.js` is the only file that changes,
which is why the wrapper exists at all.

