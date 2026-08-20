# Inventory types — plan

**Status:** written 2026-08-19, not built. Three decisions taken by the owner up front; the rest are in
section 9 and are the owner's to close before this is built.

**What it is:** shelves become **inventories with a type**. The type carries the intent — general, hidden,
premium, discounted, unpriced, purchased — and each type brings its own settings rather than every shelf
carrying every field whether it means anything or not.

---

## 1. Objective

A shelf today is one schema wearing five preset names, and the names are about *furniture* — Storefront,
Back Room — rather than about what the GM means. "Premium" and "Storefront" are also indistinguishable once
created: the preset key is never stored, only its resolved fields, so nothing downstream can tell them
apart or offer settings that only make sense for one of them.

The change is to store what the GM meant, and then let the settings follow from it.

## 2. The rename

| today | becomes | why |
|---|---|---|
| Storefront | **general** | It is the ordinary stock. "Storefront" describes where it sits. |
| Back Room | **hidden** | Says what it does rather than where it is. |
| Premium | **premium** | Unchanged. |
| Barter / Negotiate | **unpriced** | The defining fact is that there is no price yet. |
| Buyback | **purchased** | What it holds is what the shop bought. |
| — | **discounted** | New. The mirror of premium. |

The word **shelf** goes from the interface and becomes **inventory**. A shop has several inventories; each
has a type and a name; a shop may have more than one of any type.

**The stored flag key stays `shelf`.** Renaming `flags['coffee-pub-merchant'].shelf` would require a
migration pass over every world for no behavioural gain, and the flag is already declared as transient with
`registerTransientFlag`. The interface word and the storage key are allowed to differ; only one of them is
seen.

## 3. Naming an inventory

Each inventory gets a name field in Merchant Settings, writing the **container Item's own name**.

There is nothing new underneath this. The container's name has always been the shelf's name — the flag
deliberately carries no copy, so that a GM renaming the container in dnd5e's sheet renames the shelf. All
that is missing is the field in the window a GM is already looking at.

## 4. The type schema

One field added:

```js
flags['coffee-pub-merchant'].shelf = {
    type: 'general',    // NEW: general | hidden | premium | discounted | unpriced | purchased
    order: 0,
    visible: true,
    mode: 'sale',       // kept: sale | barter | buyback — see below
    markup: null,
    stock: null,
    restockDays: 1,
    maxProducts: 25,
    maxPerItem: 20,
    tables: []
}
```

**`mode` stays, and `type` does not replace it.** `mode` is what the transaction code branches on — an
unpriced row has no list price, a purchased row is priced by what the shop will pay — and three modes cover
six types. Collapsing them would mean rewriting `resolvePrice`, `_priceBuying` and `_priceSelling` around
six values where three carry all the meaning they need. `type` is what the GM chose; `mode` is what the
machinery does about it.

### Migration is a derivation, not a pass

Existing inventories have no `type`. Rather than writing a migration, derive it on read, once, in
`getShelfConfig`:

```
mode === 'buyback'  → purchased
mode === 'barter'   → unpriced
visible === false   → hidden
markup > 1          → premium
markup < 1          → discounted
otherwise           → general
```

Every existing shelf lands on the type its settings already describe. The same approach the `tables` list
already uses for shelves configured before it existed: read the old shape, never rewrite the world.

## 5. Per-type settings

**Decision taken: the type sets defaults; it does not take away controls.** Every inventory keeps the
show/hide toggle in the shop header, including a premium or discounted one — that toggle exists so a GM can
bring the good stuff out front mid-session, and losing it to gain a type would be a bad trade. "Hidden" is
the type whose default is `visible: false` and which is allowed its own markup.

| type | visible | mode | pricing control | restock | notes |
|---|---|---|---|---|---|
| general | shown | sale | inherits the global markup | yes | today's Storefront |
| hidden | **hidden** | sale | own markup, inherits when unset | yes | |
| premium | shown | sale | own markup, defaults 1.5 | yes | |
| discounted | shown | sale | own discount, defaults 0.75 | yes | new |
| unpriced | shown | barter | none — agreed on the slate | yes | today's Negotiate |
| purchased | shown | buyback | rate the shop pays, slider | **no** | today's Buyback |

**Premium and discounted are one field with two faces.** Both are `markup`; above 1 charges more, below 1
charges less. They are two types rather than one "adjusted" type because the point of this change is that
the GM states an intent, and "premium" and "clearance" are different intents even when the arithmetic is
identical. The window labels the field *Markup* on one and *Discount* on the other.

**Purchased is the one that reads backwards, so its control must not.** Its rate is what the shop **pays**,
not what it charges — a lower rate is a better margin for the merchant and a worse deal for the party. The
slider needs its ends named in those terms rather than as bare numbers. Note also the existing rule that
must survive: `resolvePrice` deliberately ignores a purchased inventory's rate when the shop *resells* that
stock, or a shop buying at half price would also resell at half price and keep a permanent half-price
second-hand rack.

## 6. Stock: the global section goes

**The merchant-wide "When something is bought" setting is removed.** Restock becomes part of each
inventory, always shown, never inherited.

This reverses `DECISIONS-TO-REVIEW.md` §2, which made stock a shelf property falling back to the merchant's.
The inheritance was not wrong, it was invisible: two places set the same thing, one of them silently, and a
GM reading an inventory could not tell whether "Same as the shop" meant anything without going to look. One
number, in one place, stated per inventory.

`resolveStockPolicy` stops consulting `config.stock` on the merchant. Existing merchant-level values are
read once by the type derivation above and then ignored.

**Purchased has no restock choice** and says so instead:

> Items bought from this inventory are removed and never restocked.

Which is already true — buyback stock is whatever the party sold, and restocking it would conjure
duplicates of somebody's old sword.

## 7. Pricing: global markup and reputation

**"Markup" is renamed "Global Markup"** and says plainly that it is the baseline every inventory starts
from, and that any inventory may override it.

**A checkbox enables a reputation modifier.** Off by default: a shop whose prices move for a reason the GM
has not opted into is a mystery, and reputation is scene-scoped state a table may not be using at all.

### Reading Blacksmith's scale

**Decision taken: read `effects.merchantModifier` from Blacksmith's band rather than keeping our own table.**
`resources/reputation.json` carries **11 bands** from *hated* (−100..−81) to *legendary* (81..100), each with
a `merchantModifier` slot. Every one is `null` except *neutral*, which is `0`. The hook was designed and
never filled.

Four things make this more than a lookup:

1. **The unit is unsettled, and guessing it is dangerous.** Neutral is `0`, not `1.0`, which says the field
   is a delta or a percentage rather than a multiplier. Read as a multiplier, a neutral party would get
   every item free. **Settle the unit with Blacksmith before reading the field**, and treat `0` as "no
   change" under any reading.
2. **`getScaleEntry()` is async** — it fetches and caches the JSON — while `resolvePrice()` is synchronous
   and runs once per row per render. So the band is resolved **once per render** and the resulting
   multiplier passed into pricing, never looked up per price. `blacksmith.partyReputationChanged` fires on
   every client and is the signal to re-render.
3. **Reputation is per scene.** A shop opened by double-clicking a token should read **that token's scene**,
   not `canvas.scene`, or a GM standing on another map prices the shop differently from the players standing
   in it. A shop opened from Merchant Settings has no token; it falls back to the current scene.
4. **A null band means no modifier**, not a broken shop. Until the JSON is filled, every band except neutral
   reads null, so the feature is inert — which is the correct behaviour and also why we should offer them
   values rather than wait.

### Values to propose to Blacksmith

Anchored on the owner's numbers — roughly 1.15 when disliked, 0.85 when liked — with the tails extended so
eleven bands are worth having:

| band | proposed | | band | proposed |
|---|---|---|---|---|
| hated | 1.30 | | known | 0.97 |
| reviled | 1.25 | | respected | 0.94 |
| despised | 1.20 | | admired | 0.90 |
| distrusted | 1.15 | | revered | 0.87 |
| unwelcome | 1.08 | | legendary | 0.85 |
| neutral | 1.00 | | | |

Expressed here as multipliers for legibility; convert once the unit is settled.

## 8. The ceilings — the owner's question answered

*"Do we need the 'runs out' and 'products / each' settings if we have the roll max in the roll?"*

They answer different questions, but **one of them is on screen in places it can never fire**:

- **Roll count** caps what arrives in *one* restock. The ceilings cap what accumulates over *many*. A shelf
  rolling three items a week with no row cap grows an unreadable list by the second month; that is the case
  they exist for and a per-roll limit cannot express it.
- **`maxProducts` is only ever enforced on table rolls.** `_withinLimits` is called from `rollShelfTable`
  and nowhere else — dragging an item onto an inventory does not consult it. So on an inventory with no
  table it is a control that does nothing at all. **Show it only when the inventory has at least one table.**
- **`maxPerItem` is enforced in two places**: table rolls, and a GM typing a quantity in the shop window,
  where it also sets the restock target. That second one is why it should stay generally available —
  **show it wherever the inventory counts its stock**, hide it where stock never runs out.

So: keep both, and stop showing either where it cannot act. That is most of the confusion, and it is a
display rule rather than a schema change.

## 9. Decisions for the owner

- **The `discounted` default.** 0.75 is proposed. It wants to be visibly a discount without being a
  giveaway.
- **The purchased slider's range and labelling.** Proposed 0.25 to 1.50, labelled by what it means to the
  shop rather than by number — *the shop profits* at the low end, *a good deal for the party* at the high
  end. A slider whose direction has to be worked out is worse than a number.
- **Does reputation affect selling as well as buying?** Recommended **yes, and inverted**: a party the town
  likes should be paid more, not merely charged less. It is the same modifier applied the other way round,
  and leaving it out would mean a beloved party gets a discount buying and no benefit selling, which reads
  as a bug rather than a rule.
- **Does the global markup stack with an inventory's own?** Today an inventory's markup **replaces** the
  merchant's. Recommended unchanged — stacking makes a 1.5 premium inside a 1.2 shop mean 1.8, which nobody
  predicts. Reputation, by contrast, **does** stack, because it is a fact about the town rather than about
  the shelf.
- **Whether `hidden` should default to its own markup** or inherit. Recommended inherit: it is a back room,
  not a different price list, and a GM who wants both can say so.

## 10. What this does not change

- The transaction. `exchange`, the settlement, making change and the GM handler are untouched.
- Stock being a count rather than a document, and a sold-out row staying on the shelf.
- The container-per-inventory model, `weightlessContents`, and dnd5e's own delete prompt.
- Visibility being a **permission** enforced on the GM handler, not a display filter.

## 11. Testing notes

Beyond the checklist in `testing/testing-merchant.md`, three things need looking at specifically:

- **A world configured before this.** Each existing shelf should land on the right type by derivation, with
  its markup, visibility and stock intact and nothing rewritten.
- **A neutral-reputation scene with the modifier enabled.** Prices must be unchanged. This is the case that
  catches a unit misread, and it is the one that would otherwise ship.
- **Two scenes with different reputation, one merchant with a token on each.** Each shop prices to its own
  scene.
