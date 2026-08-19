# Merchant Testing Checklist

Working checklist for the shop feature. Tick as you go; note failures inline.

`../plans/plan-merchant.md` records intent; `../architecture/architecture-merchant.md` will describe what
the system actually does once behaviour is verified.

**Run the logic checks first** — see `tests/README.md`. They cover making change, stock policy, the restock
cadence, the lock, and the search filter against the real templates. Everything below needs a table; those do
not.

---

## Setup

- [ ] Blacksmith on a build with `api.tokens` and `api.inventory`.
- [ ] A primary party is set for the world (`game.actors.party`), or Send-to-Party is expected to be off.
- [ ] A non-GM player login available, owning **two** characters if possible.
- [ ] An NPC with several physical items in its inventory, placed on the canvas.

Console checks:

```js
const b = game.modules.get('coffee-pub-blacksmith').api;
[!!b.tokens?.registerInteraction, !!b.inventory?.grantItem, !!game.actors.party]

// Merchant's manager, exposed to every user
game.modules.get('coffee-pub-merchant').api.merchant
```

---

## 1. Marking a merchant

- [ ] Open any NPC sheet as GM → a **Merchant Settings** entry appears in the header menu.
- [ ] It opens a window showing the actor's portrait, name, and an **Is a merchant** toggle, unticked.
- [ ] Tick it → the sheet gains an **Open Shop** header entry.
- [ ] Untick it → **Open Shop** disappears.
- [ ] A player opening the same sheet sees **neither** entry.
- [ ] Re-tick after unticking → previous settings survive rather than resetting.

---

## 2. Opening a shop

- [ ] Double-click the merchant token as GM → the shop window opens.
- [ ] Double-click as a **player with no permission on the merchant Actor** → the shop opens and the Actor
      sheet does **not**.
- [ ] Double-click an ordinary NPC the player lacks permission on → **nothing happens, no sheet.**
      *A sheet opening here is a security regression — stop and report to Blacksmith.*
- [ ] Double-click the player's own character → sheet opens normally.
- [ ] **Open Shop** from the sheet header opens the same window.
- [ ] Open Shop on a merchant with no token on the scene → warns rather than failing silently.
- [ ] Un-mark the merchant while a player has the shop open → their next action is refused.

---

## 2b. Shelves

- [ ] Enabling a merchant with no shelves auto-creates a **Storefront**.
- [ ] Config window lists shelves with their item counts, and an **Add a shelf** row of five presets.
- [x] Adding a shelf creates a container on the Actor; opening it via the box icon shows dnd5e's own
      container sheet, and dragging items in stocks it.
- [ ] The trash icon removes a shelf via dnd5e's delete prompt — keeping the contents leaves them loose on
      the merchant, deleting them removes both.
- [ ] Cancelling that prompt leaves the shelf in place.
- [ ] Adding or removing a shelf updates an open shop without reopening it, including a shop opened from a
      different token of the same merchant.
- [ ] A shelf reports **unlimited capacity** and its contents add **no weight** to the merchant.
- [ ] Items on the merchant *outside* any shelf — the shopkeeper's worn armour, their own dagger — do
      **not** appear in the shop.
- [ ] Each visible shelf renders as its own section in the shop window, in preset order.
- [ ] A **Back Room** shelf is visible to the GM, marked hidden, and **absent entirely** for a player.
- [ ] A crafted request naming a back-room item is refused with "That is not for sale."
      *This is the one that matters: hidden must be a refusal, not just a missing section.*
- [ ] A **Barter** shelf lists its items with "Ask" instead of acquire controls.
- [ ] A GM sees a **Shown / Hidden** toggle on each shelf header; a player sees none.
- [ ] Toggling a shelf to Hidden while a player has the shop open makes that whole section vanish for them
      without either side reopening the window.
- [ ] Toggling it back brings it out front for them again.

## 2c. Open, closed, and stocking

- [ ] The merchant card shows an **Open / Closed** toggle for the GM; a player sees none.
- [x] Close the shop → a player sees a "you can look through the window" notice and **no acquire controls**.
- [ ] Closed shop: **all three** row controls are disabled — Acquire, Send, and Party. Send was ungated until
      2026-08-09 and is the one to re-check.
- [ ] A crafted acquisition against a closed shop is refused with `SHOP_CLOSED`.
- [ ] The **GM is exempt** — they can still acquire from a closed shop, for stocking and testing.
- [ ] Toggling open/closed updates a player's open window without either side reopening it.
- [ ] Shop titlebar has **Merchant Settings**; the character sheet header has it too, but **no Open Shop**.
- [ ] The **+** on a shelf header opens **Blacksmith's** Compendium Search window.
- [ ] Dragging a result from that window onto a shelf puts it on that shelf.
- [ ] **Drag an item onto a shelf** from a compendium or the sidebar → it lands on that shelf.
- [ ] Dragging onto a shelf highlights it while hovering.
- [ ] A player cannot drop onto a shelf.

## 2d. Trading hours

- [ ] Config shows a two-ended slider; dragging either end updates the labels and the filled band live.
- [ ] Releasing writes once — a drag across twelve hours is one update, not twelve.
- [ ] Setting hours applies immediately: set 9–6 during the day and the shop opens without touching the clock.
- [ ] The shop's merchant box shows the hours beside the stock count.
- [ ] Advance the world clock past the closing hour → the shop closes on its own, for players too.
- [ ] Advance past the opening hour → it opens again.
- [ ] Jump **eight hours at once** across a boundary → it still lands on the right state.
- [ ] Manually open a shop the schedule says is closed → both windows say it is overriding the schedule.
- [ ] That override survives clock ticks **between** boundaries, and is cleared by the next crossing.
- [ ] Toggling back to the scheduled state clears the override notice without waiting.
- [ ] The green band marks the **open** hours, and green means the same thing here as on the Open toggle.
- [ ] An overnight schedule (open 20, close 04) is open at midnight and closed at noon.
- [ ] That overnight schedule shades **both ends** of the slider, not the middle.
- [ ] **Always open** removes the schedule and leaves the toggle purely manual.

## 2e. Prices, buying and selling

Buying and selling need `blacksmith.inventory.exchange`, which does not exist yet. Until it does, the Buy
and Sell controls are **present but disabled, naming their reason on hover** — that state is itself the first
check, and it reverses what this file said before 2026-08-18.

- [ ] With no `exchange` in Blacksmith, Buy and Sell are **disabled**, and hovering either says it is waiting
      on a Blacksmith update. The GM's free-take still works.
- [ ] Prices show on each row, formatted largest-coin-first ("1 gp 5 sp").
- [ ] An item with no price shows **no price** in red on a sale shelf, and nothing on a barter shelf.
- [ ] Markup 2 in config doubles every displayed price; the Premium shelf stays at its own 1.5.
- [ ] The buyer's purse shows beside "Buying as" and matches their sheet.

- [ ] Each row reads as columns: item, quantity, price, actions.
- [ ] Two actions per row for a player — add to cart, and Buy. A GM also gets a free-take.
- [ ] Every disabled control names *why* on hover, and the reason is the true one: closed shop, no character,
      no price, out of stock, or waiting on Blacksmith. A disabled button with a generic tooltip is a bug.

Once `exchange` ships:

- [ ] Buy asks **how many**, then **who it is for**, then confirms with the price. Three prompts, that order.
- [ ] The confirm names the **shopper** as the payer, not the destination.
- [ ] Choosing anyone but yourself is refused, and the destination dialog said so **before** you chose.
      *The shopper pays while someone else receives is a three-party transaction and `exchange` is two-sided.*
- [ ] Buy an item you can afford → coin leaves, item arrives, and the change is right.
- [ ] Buy with only large coins → you pay the large coin and get change back.
- [ ] Buy with only small coins → you pay the small coins, no change.
- [ ] Buy something you cannot afford → refused with what it costs and what you hold, and **nothing moves**.
- [ ] Buy on a barter shelf → refused; barter is a conversation.
- [ ] Sell an item → it leaves your sheet, coin arrives, and it lands on the **Buyback** shelf.
- [ ] Sell when the merchant's till is empty → refused, and nothing moves.
- [ ] Sell an item belonging to a character you do not own → refused with `NOT_YOUR_ITEM`.
- [ ] Sell to a merchant with no Buyback shelf → the Sell control is absent.

### Stock

Three policies, set per shelf in Merchant Settings, `Same as the shop` inheriting the merchant's.

- [ ] A shelf set to **Never runs out** shows ∞ in the quantity column and never decreases.
- [ ] A shelf set to **Runs out** shows a number, and buying decreases it.
- [ ] **The row does not vanish at zero.** It stays, dimmed, marked out of stock.
      *This is the whole design. A vanished row loses the shelf layout and leaves nothing to restock.*
- [ ] At zero, Buy, add-to-cart and the GM's free-take are all disabled, all saying "Out of stock".
- [ ] A crafted request against a zero row is refused with `OUT_OF_STOCK` — **not** merely disabled.
- [ ] Asking for more than is there is refused with how many are left.
- [ ] The quantity dialog will not offer more than is in stock.
- [ ] With 1 left, the dialog does not appear at all — there is no choice to make.
- [ ] **Buyback is finite whatever the shop is set to**, including when the shop says Never runs out.
- [ ] Switching a shelf's policy updates an open shop for a player without either side reopening.

#### Quantities and par

- [ ] A GM sees an editable number in the quantity column on any counting shelf; a player sees plain text.
- [ ] Typing a number and pressing Enter or clicking away commits it, and a player's open window updates.
- [ ] Setting the number by hand sets **both** the count and what it restocks to.
- [ ] Buying lowers the count and leaves the restock target alone — hover the quantity to read both back.
- [ ] Dragging a new item onto a shelf sets its restock target from the quantity that arrived.
- [ ] Dragging *more of an item already there* tops up the count and leaves the target where it was.

#### Restocking

- [ ] A shelf set to **Runs out, refills** shows an "every _n_ days" field; the other policies do not.
- [ ] Sell the shelf down, advance the world clock by the interval → it refills to its targets.
- [ ] Advance by **a week** on a 1-day shelf → it refills **once**, to par. Not seven times, not seven copies.
- [ ] Advance by less than the interval → nothing changes.
- [ ] Wind the clock **backwards** → nothing breaks, and the shelf restocks normally afterwards rather than
      waiting for the world to catch up to a timestamp in the future.
- [ ] A shelf that has never restocked starts its clock rather than refilling on the spot.
- [ ] The refresh icon in Merchant Settings refills a shelf immediately, and says how many items it topped up.
- [ ] It appears on **finite** shelves too, and says "already full" when there is nothing to do.
- [ ] An item already at or above its target is left alone rather than being trimmed down to it.

#### The cart reserves stock

- [ ] A finite row showing 5, add 2 to the cart → the row shows **3**.
- [ ] Hover the quantity → it reads "5 in stock, 2 in your cart".
- [ ] Add-to-cart again offers at most 3, not 5.
- [ ] Buy now on that row offers at most 3.
- [ ] Put all 5 in the cart → the row reads 0 and says **"Every one of these is already in your cart"**,
      *not* "Out of stock". The row is tinted rather than greyed.
- [ ] Remove the line from the cart → the row goes back to 5 and the controls come back.
- [ ] Checkout, then look at the row → it now genuinely reads 0 and says "Out of stock".
- [ ] On an infinite shelf the cart changes nothing: the row still reads ∞.

#### Buyback resale price

- [ ] Merchant markup 2, Buyback rate 0.5, an item worth 10 gp: the shop offers **5 gp** for it.
- [ ] Sell it, then look at it on the Buyback shelf: it is priced at **20 gp**, the shop's ordinary markup —
      *not* 5 gp. Selling something and buying it straight back must not be free.

#### Two buyers, one item

**The race infinite stock did not have.** Finite stock means two clients can read the same count.

- [ ] Set a shelf to Runs out with exactly **1** of something.
- [ ] Two players click Buy on it at the same moment → **one succeeds, one is refused**, and the count is 0.
      *Both succeeding means the lock is not doing its job. Report it — this is the least visible bug here.*
- [ ] The same with the GM's free-take, and with one player buying while another checks out a cart.
- [ ] Neither player's window is left showing a stale count afterwards.

### Cart

The cart is a column to the right of the stock, sticky, and always present.

- [ ] The shop opens with the cart to the **right** of the stock, not above it.
- [ ] Empty, it says so rather than being absent — and adding the first item does **not** shift the stock
      list sideways.
- [ ] Scroll a long stock list → the cart **stays in view**, parked just under the header rather than
      sliding behind it.
- [ ] That still holds with a shop description set, which makes the header taller.
- [ ] Toggle the shop closed as GM while a player scrolls → the browsing notice changes the header height and
      the cart re-parks correctly rather than overlapping.
- [ ] Drag the window narrow → the cart **wraps underneath** and fills the width, rather than staying a
      narrow strip on the left.
- [ ] Drag it wide → the stock takes most of the new room, not the cart.
- [ ] Cart rows read on two lines in the narrow column: name and bin above, quantity and price below.
- [ ] Clear and remove still work in the new layout, and Checkout is reachable without scrolling the cart.

- [ ] Add to cart asks a quantity, and the cart appears under the buyer with a running total.
- [ ] Adding the same item twice adds to the existing line rather than making a second one.
- [ ] Removing a line and clearing the cart both work.
- [ ] Checkout asks who it is for, then confirms with the itemised list and total.
- [ ] Checkout is **one** payment and one lot of change, not one per line.
- [ ] A cart you cannot afford is refused before anything moves, naming the total and what you hold.
- [ ] A GM removing stock while a cart is open silently drops that line rather than failing checkout.
- [ ] A GM *lowering* a count below what the cart holds trims the line to what is left rather than failing.
- [ ] A line trimmed to nothing drops out of the cart entirely.
- [ ] Adding to the cart offers only what is left after what the cart already holds.
- [ ] A cart holding every one in stock refuses to add more, and says so.
- [ ] Checkout is refused **whole** if any line is short, rather than delivering part of it.
- [ ] Prices are re-checked at checkout: change a markup with a cart open and the new price applies.
- [ ] The cart survives closing and reopening the window, and is per-player.

## 2g. Kind, description, and the shelf menu

- [ ] Merchant Settings shows **The Shop** with a kind dropdown and a description box.
- [ ] The kind dropdown is wide enough to read its longest option without an ellipsis.
- [ ] Pick a kind → the shop window's kicker changes from "General Store" to that, with its icon.
- [ ] Type a description, click away → it saves, and **the caret does not jump** while typing.
- [ ] The description appears under the shop name for a player, in italics.
- [ ] A description containing `@UUID[...]` renders as a working link rather than as raw text.
- [ ] Clearing the description removes the block rather than leaving an empty bordered strip.
- [ ] The **+** on the Shelves header opens a menu of the five presets, each with its artwork and hint.
- [ ] Picking one adds that shelf; the old row of five buttons is gone.
- [ ] Shelf artwork is the Foundry container icons — a crate, two chests, a basket, a sack.
- [ ] The trading-hours **opening** handle is green and the **closing** handle red, and the readout labels
      match. Drag either; the colours stay put.

## 2h. Editing a shelf outside Merchant

**The GM can reach these containers through Foundry's own UI, and nothing stops them.** Everything here is
about following that rather than fighting it.

- [ ] Rename a shelf container on the Actor sheet → the name changes in Merchant Settings **and** in an open
      shop window, without pressing Refresh.
- [ ] Rename it to something long → the row still lays out; the name does not shove the buttons off.
- [ ] Change an item's quantity on the container sheet → a shop window open on another client updates.
- [ ] Delete a shelf from the Actor sheet rather than the trash icon → it leaves an open shop window.
- [ ] Drag an item from one shelf to another on the Actor sheet → it moves sections in an open shop.
- [ ] **Drag one shelf inside another shelf** → the nested shelf still renders as its own section, and does
      **not** also appear as an item for sale on its parent.
- [ ] A crafted request to buy a shelf is refused with "That is not for sale."
- [ ] An ordinary container that is *not* a shelf — a backpack on the Storefront — still sells normally.

## 2f. Searching the shop

The filter itself is covered by `tests/test-search.mjs` against the real templates. What is left is whether
it is wired to the box and survives the things that redraw the window.

- [ ] Type into the search box — the list narrows as you type, with **no flicker and no lost caret**.
      *A re-render per keystroke would show as the cursor jumping to the end. That is the bug this design
      exists to avoid.*
- [ ] A shelf with nothing matching disappears, heading and all; so does an empty category heading.
- [ ] The count on each shelf header shows how many are showing, and goes back to the real total on clear.
- [ ] No matches at all → "Nothing here matches that."
- [ ] The **×** clears the search and puts focus back in the box; **Escape** does the same.
- [ ] Searching by kind works: "weapon" finds the weapons, "consumable" the consumables.
- [ ] With a search active, hit titlebar **Refresh** → the search survives and still applies.
- [ ] With a search active, have a GM add stock → the list updates and the search still applies to it.
- [ ] With a search active, buy something → the row updates and the search is still there.
- [ ] Search, then buy the only visible item on a finite shelf → it goes out of stock rather than vanishing.
- [ ] A GM searching still sees hidden shelves among the results, still marked hidden.
- [ ] Close and reopen the shop → the search is **empty**, not yesterday's filter.

## 3. The window

- [ ] Shelf sections list only physical items; features, spells and class items are absent.
- [ ] Within a shelf, stock is grouped under Weapons, Armor & Gear, Consumables, Tools, Containers, Goods.
- [ ] Merchant card is tinted blue, "Buying as" row green, both pinned while stock scrolls.
- [ ] Resize the window; the pinned header stays put.
- [ ] Footer reads `[ Done ]` on the left.
- [ ] Window stays draggable while a dialog is open.
- [ ] Titlebar **Refresh** picks up stock a GM added while the window was open.
- [ ] Refresh is available to a player; Character Sheet and Prototype Token are not.

---

## 4. Acquiring

- [ ] Acquire an item → a quantity prompt appears; **dragging the slider updates the numbers**.
- [ ] Dialog buttons read `[ Cancel ]` left, `[ Acquire ]` right.
- [ ] The item arrives on the buying character.
- [ ] **On an infinite shelf the merchant still has it, at the same quantity.** If the count drops, or the
      row vanishes, `transferItem` semantics have crept in where `grantItem` belongs.
- [ ] Acquire the same item twice → the buyer's stack grows rather than gaining a second row.
- [ ] Two players acquire the same item simultaneously from an **infinite** shelf → both succeed, merchant
      unchanged. On a **finite** shelf with one left, exactly one succeeds — see *Two buyers, one item*.

---

## 5. Buying as

- [ ] With two owned characters, the Change button appears.
- [ ] Pick the **second** character, confirm, acquire → it lands on **that** character, not the first.
- [ ] The choice is remembered when the window is reopened.
- [ ] With no owned character, the row says so and Acquire is disabled.

---

## 6. Sending elsewhere

- [ ] Send → picker lists party characters; the item lands on the chosen one.
- [ ] Party → the item lands in the party Group actor's inventory.
- [ ] With no primary party set, the Party control is disabled rather than erroring.
- [ ] A crafted request naming an Actor outside the party is refused with `RECIPIENT_NOT_ALLOWED`.

---

## 7. Failure paths

- [ ] Merchant carrying a **packed container** → acquiring it is refused with the content count named.
      `api.inventory` refuses a container with contents symmetrically, so this is expected, not a bug.
- [ ] Delete the merchant token while a player has the shop open → their next action is refused cleanly.
- [ ] No GM connected → a player's acquisition is refused with a clear message rather than hanging.
- [ ] Any code rendering as the generic *"That could not be completed"* is a message gap worth reporting.

---

## Known and expected

Not bugs; do not chase these.

- **Nothing costs money yet.** Buy, Sell and Checkout are complete and end at `EXCHANGE_UNAVAILABLE`,
  because `blacksmith.inventory.exchange` does not exist. The controls are disabled and say so.
- **Buying for another character or the party is refused** (`THIRD_PARTY_DELIVERY`). The shopper pays while
  someone else receives is a three-party transaction; `exchange` is two-sided. Raised with Blacksmith.
- A packed container cannot be acquired. `api.inventory` v1 refuses it in both directions.
- A sold-out row stays on its shelf, dimmed. That is deliberate, not a failure to clean up.
- A GM cannot temporarily lower a count without also lowering what it restocks to. Judged rare; say so if it
  turns out not to be.
