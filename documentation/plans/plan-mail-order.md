# Plan — Mail order, phase 1

**Written 2026-08-29. Delete this file once the work is reviewed and its durable half has moved into
`architecture/architecture-merchant.md`.** A plan lives in `plans/` only while it is being built.

The design is in `../TODO.md` §1 and is not repeated here. This is the build order, the decisions taken
while building, and what each piece has to obey.

---

## The shape in one paragraph

A **catalogue shelf** is a warehouse, not a counter: nothing on it changes hands where you are standing.
Ordering from one takes coin now and creates a **receipt** — an Item in the buyer's possession carrying the
whole consignment. When the world clock reaches the arrival time, that same Item **becomes a parcel**: a
container holding the goods. If nobody is holding the receipt when it lands, the package is **lost**.

---

## 1. The `catalogue` shelf type

`INVENTORY_TYPES` gains a row. Everything else about shelves — stocking by drag, by compendium query or off
a roll table, restock cadence, markup, visibility — comes with it and is not written again.

- `pricing: 'markup'`, so a catalogue shelf's markup is the **mail-order premium**: what goods cost through
  this channel, which is a different number from what moving them costs.
- `restocks: true`. A warehouse restocks like anything else.
- `stock: STOCK.INFINITE` by default. A warehouse is the one shelf where "we have as many as you want" is
  the ordinary case, and the catalogue view does not show quantities at all.

**Two filters, and they are the whole separation:**

- The **shop window** shows every shelf *except* catalogue ones.
- The **catalogue view** shows *only* catalogue ones.

That is what stops mail order being the shop by post, and it is one predicate in two places rather than a
rule anybody has to remember.

## 2. Delivery services

A frozen table in `const.js`, shaped like `INVENTORY_TYPES`, so a fourth service is a row rather than a
branch. Three to start:

| key | name | days | fee | where it goes |
|---|---|---|---|---|
| `ground` | Ground | slow | cheap | a depot; they collect it |
| `beast` | Courier Beast | middling | middling | to them — it finds whoever holds the receipt |
| `portal` | Parcel Portal | fast | dear | a shop on the portal network |

Phase 1 is **theatre of the mind**: there are no depot pins and no portal-network flag, so *where it goes*
is description rather than mechanism. What differs mechanically is **days** and **fee**. Both are world
settings with the table's values as defaults, because what a courier costs is a fact about a world.

The fee is **flat per order**, not per item and not by weight. Simple was asked for, and a per-item fee
makes a party split one order into six to game it.

## 3. The order

**Slate → order.** The catalogue view's slate carries what a shop slate does, plus the service. Settling it
is placing the order, and the button says so.

GM-side, a new op alongside settle. It must:

1. Re-resolve everything from the payload. **Never read an identity out of a payload** — the envelope hands
   over a verified `User`, exactly as `_processSettle` does.
2. Price the goods GM-side, the same way a purchase is priced. A client's arithmetic is an explanation.
3. Add the **delivery fee** to the total. The fee is read from the world setting, not from the payload.
4. Take the coin. Nothing is exchanged: no goods move today, which is what makes this a different operation
   rather than a flag on the existing one.
5. Decrement stock exactly as a purchase does, so a finite warehouse runs down.
6. Create the **receipt** in the buyer's possession.

**What the receipt carries** is the whole consignment, as **item source data rather than uuids**. This is
the decision the robustness of the feature turns on: a uuid dangles the day the merchant is deleted or the
shelf is cleared, and a parcel whose contents evaporated because a shop closed is the worst possible bug for
a feature whose whole point is that things are in transit. The goods **left the warehouse** when the order
was placed; the parcel carries them.

Also on it: who it is from, the service, the fee paid, the world time it was ordered and the world time it
arrives.

## 4. Arrival

`api.worldClock.schedule({ at, gmOnly: true })`, which is exactly what that API is for and exactly the case
its 2026-08-21 decline anticipated — trading hours and restocking are not moments, and a delivery is.

Three things from their page this has to obey:

- **Schedules are not persisted.** Pending deliveries are re-registered on `ready` by walking the receipts,
  which *are* the queue. The API is a notification surface; the receipts are the durable record.
- **`gmOnly: true`.** Delivering writes to the world. Without it, five connected players deliver it five
  times.
- **Rewinding time re-arms a one-shot.** A GM correcting the clock backwards past a delivery will see it
  arrive again. For a delivery that is arguably right, and it is written down so it is a decision rather
  than a surprise.

On arrival the receipt **becomes the parcel**: the same Item, turned into a container, with the consignment
created inside it.

**`grantItem` cannot do this.** It refuses a packed container — the `CONTAINER_HAS_CONTENTS` refusal
Merchant already reports quietly on restocks, because a copy would have to invent the contents or drop them.
The parcel is a packed container by definition, so it is built from documents directly.

## 5. Lost packages

**If nobody holds the receipt when it lands, the package is lost.** Resolved at delivery time: a receipt
whose Item is gone, or which is no longer on an Actor, cannot be delivered to anybody.

The GM is told, with the merchant, the service and what was in it, because a lost parcel is a plot rather
than an error. Nothing is refunded — that is the GM's to decide, and a system that quietly gave the money
back would take the decision away.

## 6. Selling by post

The same consignment machinery in the other direction, and **paid on dispatch**: the party sends goods, the
coin arrives, the merchant takes delivery later. The goods leave the party's sheet at dispatch and are
created on the merchant's **Buyback** shelf when the timer fires, which is where goods from the party
already end up.

---

## What was built, 2026-08-29

All of phase 1 except selling by post, which is listed below rather than half-done.

| # | Piece | Where |
|---|---|---|
| 1 | The `catalogue` shelf type, delivery table, arrival arithmetic | `const.js` |
| 2 | Days and fee per service | `settings.js` |
| 3 | The two view filters | `getInventories({ catalogue })` |
| 4 | The order, GM-side | `_processOrder` |
| 5 | The receipt, and what it carries | `utility-mail.js` |
| 6 | The clock, arrival, and the parcel | `utility-mail.js`, `merchant.js` |
| 7 | Lost packages | `deliver` |
| 8 | The catalogue view: its shelves, no quantity, the service picker, Place Order | `window-shop.js` |

**Tested where it can be**: the arrival arithmetic, the service table's ordering, the setting-key
derivation and the shelf type's predicates are in `tests/test-stock.mjs`. Everything that touches a document
is not, and wants a table.

**Not built: selling by post.** It is the same consignment machinery in the other direction — paid on
dispatch, goods created on the merchant's Buyback shelf when the timer fires — and it is a second flow
through an order path that has not been run once yet. Better after phase 1 has been played.

## Known gaps in what was built

- A receipt shows what is coming in its description, written once at order time. **The days remaining do not
  tick down** as the clock advances; it says what it said when it was printed. Re-writing the description on
  every world-time change is a write per receipt per crossing, which is worse than a slightly stale sentence.
  Mostly covered now: *consulting* a receipt computes the remaining days against the clock at that moment,
  so the number a player is told is always current — only the paragraph on the sheet is stale.
- **The GM has no view of what is in transit.** Everything is discoverable — the receipts are Items on
  sheets — but there is no one place that lists the world's outstanding orders.

## Out of scope for phase 1

Depot pins. The portal-network flag and its destination picker. The paged catalogue spread — the grid is
worth doing, the page-turn is not until the rest is played with.
