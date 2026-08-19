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

- [ ] The slider is flanked by the first and last hour of the day.
- [ ] The readout reads as one phrase — "Open 7:00 AM to 6:00 PM" — with the opening hour green and the
      closing hour red, matching their handles.
- [ ] Dragging either end updates the labels and the filled band live.
- [ ] Releasing writes once — a drag across twelve hours is one update, not twelve.
- [ ] Setting hours applies immediately: set 9–6 during the day and the shop opens without touching the clock.
- [ ] The shop's merchant box shows the hours beside the stock count.
- [ ] Advance the world clock past the closing hour → the shop closes on its own, for players too.
- [ ] **Set** the clock rather than advancing it — drag a scrubber, type a time — and it still closes.
      *This is what was broken: a clock that reports no delta left the shop open with an override notice.*
- [ ] Nudge the clock repeatedly inside the closed window → it stays closed, and does not fight a GM who
      reopens it.
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
- [ ] **One** action per row: **Add**. No Buy button and no GM wand — the cart is the only way to buy.
- [ ] Every disabled control names *why* on hover, and the reason is the true one: closed shop, no character,
      no price, out of stock, or waiting on Blacksmith. A disabled button with a generic tooltip is a bug.

`exchange` shipped on 2026-08-18, so everything below is live.

#### Nothing half-happens

- [ ] Buy something the merchant has **no change for** — a 10 gp item paid with a platinum piece, till empty.
      Refused, naming the change owed, and **the item does not arrive**.
      *This was the bug: the goods went across and the payment failed. If you end up holding it, stop and
      report — that is the defect returning.*
- [ ] Top the till up, buy it again → goods, payment and change all land together.
- [ ] Buy the last one of a finite item twice in a row: the second is refused and **nothing moves**.
- [ ] Checkout a cart where one line has gone out of stock → the **whole** cart is refused, and none of the
      other lines arrive.
- [ ] No error message anywhere reads "That could not be completed" — every refusal names its reason.

#### Stock policy through a purchase

- [ ] Buy from an **infinite** shelf → the merchant's row is untouched, same quantity as before.
- [ ] Buy 3 from an infinite shelf whose row reads 1 → all 3 arrive. The row is a template, not a count.
- [ ] Buy from a **finite** shelf → the count comes down by what you bought.
- [ ] Buy the last one → the row stays at 0 rather than disappearing.
- [ ] Restock that shelf → the row comes back to its par, which is why it had to survive.

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

#### Shelf ceilings

- [ ] Type a quantity **above** a shelf's "each" limit → it clamps, and says where to raise the limit.
- [ ] Raise the limit, type it again → it takes.
- [ ] Lower a shelf's limit **below** an existing row's quantity → nothing is deleted, and the row's restock
      target reads the new, lower limit.

- [ ] A new shelf shows **25 products** and **20 each**.
- [ ] Fill a shelf to its product ceiling, then restock from a table → no new rows appear, and existing rows
      can still top up.
- [ ] Lower the ceiling below what is already there → nothing is deleted; it simply stops growing.
- [ ] A row at the per-item ceiling stops receiving from table rolls.
- [ ] Hover a row's quantity → its restock target never reads higher than the per-item ceiling.
- [ ] Both are per shelf: set the Back Room to 5 products and the Storefront stays at 25.

#### Removing stock

- [ ] A GM sees an **×** on each shop row; a player does not.
- [ ] It opens dnd5e's delete prompt and removes the row entirely.
- [ ] Removing a **container** asks about its contents.
- [ ] Cancelling the prompt leaves the row alone.
- [ ] Setting a quantity to 0 instead leaves the row in place, marked out of stock, and a restock brings it
      back. *These are two different statements and must stay so.*

#### Rerolling, and restocking from the shop

- [ ] A newly dropped table has **reroll off**.
- [ ] Press **Restock** — from Settings or from the shelf header in the shop — and **every** table rolls,
      marked or not.
- [ ] Advance the clock past the interval → **only** tables with reroll ticked deliver.
- [ ] A shelf whose tables are all unmarked, on a policy that is not "runs out, refills", is left alone by
      the clock entirely.
- [ ] Tick reroll, advance the clock, and it delivers; untick it and it stops.
- [ ] The shelf header's restock control is GM-only, and sits beside the search glass.
- [ ] The search control is a **magnifying glass**, and opens Blacksmith's compendium search.

#### Several tables on one shelf

- [ ] Drop a second table on a shelf → **both** are listed, each with its own roll count.
- [ ] Drop the same table twice → it says so and does not duplicate it.
- [ ] Each table's roll count is independent.
- [ ] Restock → every table rolls its own number of times, and the results arrive together.
- [ ] The same item rolled by two different tables lands as **one row** with a quantity of two.
- [ ] Remove one table → the other keeps working.
- [ ] Delete a table from the world → the shelf lists it as "Missing table" and the others still roll.
- [ ] A shelf configured before this change still rolls its original table.

#### Merchant Settings titlebar

- [ ] **Refresh** redraws the window and picks up a shelf edited on the Actor sheet.
- [ ] **Open Shop** opens the shop for a merchant with a token on the current scene.
- [ ] It also works when the merchant's only token is on **another** scene.
- [ ] With no token anywhere, it says so rather than failing silently.

#### Stocking from a roll table

- [ ] Drag a **RollTable** from the sidebar onto a shelf row in Merchant Settings → the row highlights and
      the table's name appears on it.
- [ ] Drag one from a **compendium** → same thing. A compendium table is the normal case.
- [ ] Drag something that is not a table → refused with a message, and the shelf is unchanged.
- [ ] Set the roll count; press **Restock** → that many rolls, and what comes up lands on that shelf.
- [ ] A table rolling the same item several times produces **one row** with a quantity, not several rows.
- [ ] Text-only results are skipped without erroring.
- [ ] Non-physical results — a journal, an actor — are skipped too.
- [ ] Rolling does **not** mark the table's results as drawn; restock twice and the second still rolls.
- [ ] Advance the clock past the shelf's interval → it rolls on its own.
- [ ] A table-stocked shelf restocks on the clock even when its policy is not "runs out, refills".
- [ ] The **×** clears the table and the shelf stops rolling.
- [ ] Delete the table from the world → the shelf shows no table rather than erroring.

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

### The cart panel

- [ ] The head reads: **Cart** and the total on one line, then **Buying** and **Selling** beneath, right
      aligned under it.
- [ ] Total equals Buying minus Selling, and the three agree at all times.
- [ ] The segment headings carry **no** subtotal — that number is in the head.
- [ ] The footer reads `[ Cancel ]` left, `[ Clear ] [ Checkout/Sell/Trade ]` right.
- [ ] The action button is present with an **empty** cart, and pressing it says there is nothing in it yet.
- [ ] **Clear** is disabled on an empty cart and empties both segments otherwise.
- [ ] No amount on the action button; it is in the cart head.

- [ ] Cart and Selling are **one panel** with two segments, not two panels.
- [ ] The total sits at the **top** and stays there while the list scrolls.
- [ ] It reads "You pay", "You receive" or "Even trade" and matches the direction of the difference.
- [ ] Each segment shows its own subtotal.
- [ ] **Drop an item anywhere on the panel** — over the Buying segment, over the total, over empty space —
      and it lands in Selling. There is no wrong half to aim at.
- [ ] The whole panel highlights while dragging over it.
- [ ] The single clear button empties **both** segments.
- [ ] Empty, the panel says so and offers *Or choose from your pack*.

### Layout

- [ ] The cart is level with the **merchant card**, not with the first shelf — it runs the full height of the
      window beside everything.
- [ ] Only the footer spans both columns.
- [ ] The merchant card, buyer card and search stay put while the item list scrolls beneath them.
- [ ] A tall cart uses that whole height rather than being squeezed under the header.
- [ ] Narrow the window until the cart wraps → the header cards, search, items and cart stack in that order
      and scroll as one.

### Shelf grouping

- [ ] Shelves read as distinct groups; a long Storefront does not run into the shelf below it.
- [ ] Scroll a long shelf → its heading **sticks to the top of the list** and names what you are looking at.
- [ ] Scrolling into the next shelf swaps the heading for that one.
- [ ] Rows pass **behind** the heading and stay legible against it rather than merging into it.
- [ ] A hidden shelf's heading is tinted as well as carrying the Hidden pill.
- [ ] The search box does not scroll with the headings; it stays above them.

### Scrollbars

- [ ] The stock scrollbar starts **below** the search box, not beside it.
- [ ] The cart scrollbar starts **below** the total, not beside it.
- [ ] Neither bar runs up behind a box that does not move.
- [ ] A row's right edge is never underneath its scrollbar.
- [ ] Adding the item that first makes a list long enough to scroll does **not** shift the rows sideways.

### Search

- [ ] The search box sits **above the stock list**, inside that column.
- [ ] Scroll the stock list → the search stays put.
- [ ] Scroll the cart → the search does not move either; they are separate scrollers.
- [ ] It does not sit in the window header any more, so a shop with a long description does not push it down.

### The slate header

- [ ] Labels line up down one edge and figures down the other; the block reads as a sum.
- [ ] The rule under the total runs unbroken across both columns.
- [ ] The totals sit on a tinted panel distinct from the lists below.
- [ ] **Buying** and **Selling** headings are the same size and weight as a shelf heading.
- [ ] A small **Sell** button in the slate header opens the picker — **with items already on the slate**,
      not only when it is empty.
- [ ] That button is absent on a merchant with no Buyback shelf, and disabled with no character to sell as.

### Shopping as the party

- [ ] The **Buying as** list includes the party alongside your characters.
- [ ] A player with no character in the party is **not** offered it.
- [ ] Shop as the party → the party's purse pays and the goods land in the party's inventory.
- [ ] Sell as the party → the party's things are what the picker lists, and the party is paid.
- [ ] **No destination is asked at any point.** One question fewer, and no refusal about third parties.
- [ ] A crafted request naming an Actor you cannot act as is refused with "You cannot shop as that character."
- [ ] With no party set for the world, the list is just your characters and nothing errors.

### Open and closed

- [ ] The merchant card reads: name and the Open/Closed chip at either end of line one, the keeper on line
      two, kind and hours on line three — each of those running the full width.
- [ ] A very long shop name ellipsises rather than pushing the chip off the card.

- [ ] The Open/Closed chip sits on the facts row with the kind and the hours, not in a column of its own.
- [ ] A GM clicking it toggles the shop; a player sees it as a plain chip and cannot click it.
- [ ] Closed shows red; open shows green.
- [ ] The merchant card reads in three lines: name, keeper, facts.

### Settling

One button in the footer settles the whole visit. Its label is part of the design, not decoration.

- [ ] The footer reads `[ Cancel ]` left, `[ Clear Slate ] [ Complete Transaction ]` right, always.
- [ ] Hovering **Complete Transaction** says what you pay or receive, and says so before you press it.
- [ ] Quantities on slate lines sit in the same place on every row, whatever the prices are.
- [ ] Neither panel has a button of its own any more; both are just lists with a total.
- [ ] **No confirmation dialog.** Pressing Complete Transaction completes it.
- [ ] Buy 100 gp of goods while selling 60 gp of goods → you pay **40 gp**, once. Not 100 out and 60 back.
- [ ] An even trade → the confirm says no coin changes hands, and none does.
- [ ] **Buy something you could not otherwise afford, funded by what you are selling** → it goes through.
      *This is the case that does not exist as two transactions.*
- [ ] Buy more than you sell from a merchant with an **empty till** → it works. The shop receives; it needs
      no coin.
- [ ] Sell more than you buy from a merchant with an empty till → refused, and nothing moves.
- [ ] Any refusal leaves **both** panels untouched — no half-settled visit.
- [ ] A successful settle empties both panels.

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

## 2g0. Shop name

- [ ] Merchant Settings has a **Shop name** field, blank by default, with the Actor's name as placeholder.
- [ ] Leave it blank → the shop window's title is the Actor's name, and no shopkeeper line appears.
- [ ] Set it to something else → the title is the shop name and the meta line names the shopkeeper.
- [ ] Set it to exactly the Actor's name → **no** shopkeeper line; the name is not printed twice.
- [ ] Clear it back to blank → the title reverts to the Actor's name.
- [ ] The caret does not jump while typing, and it saves when you click away.
- [ ] A player sees the shop name, not the Actor's, in the window title and the titlebar.

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

## 2h2. The till

- [ ] Mark a fresh NPC as a merchant → Settings shows a **Till** of 250 gp.
- [ ] Mark one that already has coin → its purse is **not** topped up.
- [ ] Empty the till to 0 → the section warns that nothing can be bought from the party.
- [ ] Set it to 40 → the header total and the field agree.
- [ ] Give the merchant 50 sp by hand, then set the gold field → **the silver survives**.
- [ ] Sell to a shop with an empty till → refused, and the message reads "nothing in the till", not "— in
      the till".
- [ ] Try to buy something you cannot afford → "nothing held" rather than "— held", when you have no coin.

## 2i. Selling

The basket mirrors the cart: it accumulates, and one **Sell** settles the lot.

- [ ] A merchant **with** a Buyback shelf shows a **Selling** panel under the cart; one without shows none.
- [ ] Empty, it reads "Drag something here to sell it" and offers *Or choose from your pack*.
- [ ] The button lists what the merchant would take, each with its offer.
- [ ] Picking one asks a quantity, then it appears in the basket — it does **not** sell immediately.
- [ ] **Drag an item from your character sheet onto the panel** → the panel highlights, and it asks a
      quantity the same way.
- [ ] Squire's inventory panel drags the same way and lands the same way.
- [ ] Drag something from a **compendium** or the sidebar → refused: only what a character carries can be sold.
- [ ] Drag something off a character you are **not** shopping as → refused, naming who you are selling as.
- [ ] Drag a **packed container** → refused with "unpack it first", **before** any quantity prompt.
- [ ] Drag something the merchant would not buy → refused, naming it.
- [ ] Add the same item twice → the line grows rather than doubling, and it will not offer more than you have.
- [ ] Basket full of everything you own → the picker says so rather than listing them again.
- [ ] **Sell** confirms with the itemised list and the total, then pays **once**.
- [ ] Everything sold lands on the **Buyback** shelf and is immediately on sale there.
- [ ] Sell to a merchant whose till cannot cover it → refused, and **nothing** leaves your sheet.
- [ ] Switch "Buying as" to another character → the basket empties of the first character's things rather
      than trying to sell them.
- [ ] Sell an item you are holding in the cart's shop at the same time — cart and basket do not interfere.

## 2j. Reading prices, and the sell picker

- [ ] A 2,050 gp potion offers **1,025 gp**, not "102 pp 5 gp".
- [ ] A 25 gp crossbow offers **12 gp 5 sp**, not "1 pp 2 gp 1 ep".
- [ ] Nothing anywhere shows a price in **pp** or **ep**.
- [ ] A character holding only platinum can still buy things — display changed, payment did not.
- [ ] *Or choose from your pack* on a full inventory shows a **scrolling list** with artwork, kind and
      offer — not a wall of buttons.
- [ ] Tick several rows and confirm → all of them land in the basket in one pass.
- [ ] Items you hold exactly one of add **without** a quantity prompt; stacks ask.
- [ ] Cancel adds nothing.

## 2k. Scrolling

- [ ] Wide window: the stock list scrolls **on its own**, and the cart stays put beside it.
- [ ] The cart scrolls on its own too — fill it past the window height and the stock list does not move.
- [ ] Neither scrollbar belongs to the whole window; the merchant card, buyer and search never scroll away.
- [ ] Drag the window narrow until the cart wraps underneath → the two scroll **together** as one region.
- [ ] Drag it wide again → they separate again, at the same width the layout changes at.
- [ ] Resize the window shorter → both panes shrink and keep their own scrollbars; nothing is cut off.
- [ ] A shop description or the closed-for-browsing notice makes the header taller → the panes shorten to
      match rather than overflowing the window.
- [ ] Checkout sits **below** the cart total, full width. Same for Sell under the basket total.

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

## 4. Quantity, edited in place

Curator's loot window settled this pattern; the shop uses the same one.

- [ ] **No quantity dialog anywhere.** Adding to the slate adds one, immediately.
- [ ] Double-click a slate line's quantity → it becomes an input, focused and selected.
- [ ] Enter commits; clicking away commits; **Escape** abandons.
- [ ] Setting a slate line to **0 removes it**.
- [ ] Setting one above what is in stock is clamped rather than accepted.
- [ ] As GM, double-click a shelf row's **QTY** → same behaviour, and it sets the restock target too.
- [ ] A player double-clicking a shelf row's QTY does nothing; only a GM gets an editable stock cell.
- [ ] The stock cell is a **number with a QTY caption**, not a form field sitting in every row.
- [ ] Editing while a request is in flight is refused rather than racing it.

## 4b. Old quantity prompts (removed)

One dialog serves four actions, and it must name the one you pressed.

- [ ] Cart icon → title "Add {item} to the cart", confirm reads **Add to cart**.
- [ ] Buy → title "Buy {item}", confirm reads **Buy**.
- [ ] Sell → title "Sell {item}", confirm reads **Sell**.
- [ ] The GM's give → title "Give {item}", confirm reads **Give**.
- [ ] The word "Acquire" appears nowhere.
- [ ] The slider ends read "Yours" and "Left on the shelf", not "Take" and "Leave".
- [ ] **Dragging the slider updates the numbers.**
- [ ] Dialog buttons are `[ Cancel ]` left, the action right.
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
