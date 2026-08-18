# Decisions taken unattended — 2026-08-18

Built while you were away, on "build the remainder of the project unattended, log decisions I need to
review." Everything here is a call I made without you. Each says what I chose, what I rejected, and how
much it would cost to reverse. **None of it has been run in Foundry.**

Ordered by how much I want you to look at it.

---

## 1. Buying no longer moves the merchant's item — it grants a copy and decrements a count

**Status: this one changes the transaction model. Read it first.**

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

`config.stock` existed on the merchant from the scaffold and was never read. I made it a **shelf** property
that falls back to the merchant's, exactly as `markup: null` already does.

The argument is that a Storefront restocking nightly and a Back Room holding three unique things is an
ordinary shop, and a single merchant-wide policy cannot describe it. The argument against is one more
inherited field to reason about — but the inheritance pattern is already there for markup, so this adds a
case rather than a concept.

**Reversing:** read `config.stock` in `resolveStockPolicy` and ignore the shelf. One line.

---

## 3. The count lives in `system.quantity`, not in a flag

The alternative was a flag map on the shelf. I rejected it because it is a parallel truth: the moment a GM
edits quantity on the Actor sheet — which they will, because that is where quantity has always been — the
flag and the sheet disagree and one of them is silently wrong.

Using `system.quantity` means the Actor sheet, the shop window, and every other module that reads quantity
are all looking at the same number. It also means a GM can stock a shop entirely from the sheet without
learning anything new.

**Reversing:** expensive. It is threaded through display, purchase, restock, and par.

---

## 4. Par level is "whatever the GM last set by hand"

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

Your call, taken from the two options offered. Recorded here only because it reverses a rule stated in three
places (`plan-merchant.md` phase 3, `CHANGELOG.md`, `testing-merchant.md`), all of which now say the new
thing. The rule it replaces was *"absent rather than present-and-broken"*; the rule now is that a control
which cannot act says why on hover.

---

## 7. Out of stock is a refusal, not just a greyed button

Zero stock is checked on the GM as well as in the window. This follows the standing rule — *a setting that
hides a control must also refuse the request* — and it is what makes two players racing for the last unit
resolve rather than both succeeding.

That race is real again for the first time. Infinite stock had no concurrency at all; finite stock brings
back the problem loot needed locks to survive. There is now a per-merchant mutex in the manager
(`_withStockLock`), which is sound because exactly one GM client handles requests. **This is the single most
likely place for a bug I cannot see without a table**, and the test doc has a specific check for it.

---

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

## Still open, and not mine to close

- **`exchange` does not exist.** Buy, Sell and Checkout are complete and end at `EXCHANGE_UNAVAILABLE`.
- **The three-party gap** — the shopper pays while someone else receives. Raised with Blacksmith.
- **Copy-vs-move on an exchange side** — decision 1 above. Also raised.
- **Everything from `beb8f41` forward is untested in Foundry.** Six commits. The arithmetic half is verified
  by `tests/`; the half that touches documents, templates, hooks and permissions is not, and cannot be
  without a table. `documentation/testing/testing-merchant.md` is current and is the list.
