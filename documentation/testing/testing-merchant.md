# Merchant Testing Checklist

Working checklist for the shop feature. Tick as you go; note failures inline.

`../architecture/architecture-merchant.md` describes what the system actually does, and is the thing to
read before changing any of it.

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

## 2b. Inventories

- [ ] Enabling a merchant with no inventories auto-creates a **Storefront**.
- [ ] Config window lists inventories with their item counts, and an **Add an inventory** row of five presets.
- [x] Adding an inventory creates a container on the Actor; opening it via the box icon shows dnd5e's own
      container sheet, and dragging items in stocks it.
- [ ] The trash icon removes an inventory via dnd5e's delete prompt — keeping the contents leaves them loose on
      the merchant, deleting them removes both.
- [ ] Cancelling that prompt leaves the inventory in place.
- [ ] Adding or removing an inventory updates an open shop without reopening it, including a shop opened from a
      different token of the same merchant.
- [ ] An inventory reports **unlimited capacity** and its contents add **no weight** to the merchant.
- [ ] Items on the merchant *outside* any inventory — the shopkeeper's worn armour, their own dagger — do
      **not** appear in the shop.
- [ ] Each visible inventory renders as its own section in the shop window, in preset order.
- [ ] A **Back Room** inventory is visible to the GM, marked hidden, and **absent entirely** for a player.
- [ ] A crafted request naming a back-room item is refused with "That is not for sale."
      *This is the one that matters: hidden must be a refusal, not just a missing section.*
- [ ] A **Barter** inventory lists its items with "Ask" instead of acquire controls.
- [ ] A GM sees a **Shown / Hidden** toggle on each inventory header; a player sees none.
- [ ] Toggling an inventory to Hidden while a player has the shop open makes that whole section vanish for them
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
- [ ] The **+** on an inventory header opens **Blacksmith's** Compendium Search window.
- [ ] Dragging a result from that window onto an inventory puts it on that inventory.
- [ ] **Drag an item onto an inventory** from a compendium or the sidebar → it lands on that inventory.
- [ ] Dragging onto an inventory highlights it while hovering.
- [ ] A player cannot drop onto an inventory.

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
- [ ] There is **no Always open button**.
- [ ] Drag the handles to cover the whole slider → an **Always open** label appears on the section heading,
      **mid-drag**, not on release, and with no box drawn around it.
- [ ] With that set, the shop is open at **every** hour, 11pm included. *That hour used to fall outside a
      "whole day" span, which is why the closing handle now reaches midnight rather than 11pm.*
- [ ] A shop that has never had hours set shows the handles across the whole day and reads as always open.
- [ ] The shop window shows **no hours** for an always-open shop.
- [ ] Move a handle off the full span → the label goes and the hours appear in the shop.
- [ ] Drag one handle **onto the other** → the band empties and the label reads **Always closed**, in red.
- [ ] With that set, the shop is **closed at every hour**, and the shop window shows no hours for it either.
- [ ] A GM can still open it by hand with the Open toggle; that reads as overriding the schedule, as usual.

## 2d-ii. Negotiating a price

- [ ] A **Negotiate** inventory (was Barter) shows *negotiate* in the price column and its tag reads **Negotiate**.
- [ ] Its rows have the ordinary **+** button, not an "Ask" label.
- [ ] Add one → it lands on the slate with the price showing **TBD**, in red italic.
- [ ] **Complete Transaction** with a TBD line refuses: *"You have unnegotiated items on your slate..."*
- [ ] As GM, **double-click the price** on a slate line → an input appears, prefilled with the price *each*.
- [ ] Type a number, press Enter → the line shows that price, the totals and the net update.
- [ ] Settle it → the item arrives in the character's inventory **carrying that price**.
- [ ] Buy something that already had a price, negotiated down → the item keeps its **own** price, not the
      discount. *A longsword bought cheap is still worth what a longsword is worth.*
- [ ] After settling, the inventory row is back to **negotiate** — the agreement did not become the list price.
- [ ] The same works on the **selling** side: an unpriced possession can go in the basket at TBD, the GM
      names what the merchant will pay, and settling moves it.
- [ ] A **player** sees the price but cannot double-click to change it.
- [ ] A negotiate inventory's price column reads **negotiate** and shows **no figure ever** — including after a
      price has been agreed for that item, and including on the next player's screen.
- [ ] As GM, hover that label → a tooltip gives the agreed price, or what it is worth on the books.
- [ ] As a **player**, hover it → **no tooltip at all**, and nothing readable in the markup.

## 2d-v. Item cards and opening items

- [ ] Hover an item's **picture** on an inventory row → the system's item card appears, same as hovering the name.
- [ ] The same on both sides of the slate — the buying side reads the merchant's item, the selling side
      reads the shopper's own.
- [ ] As **GM**, click a picture → that item's sheet opens. Works from an inventory row and from a slate line.
- [ ] As a **player**, the picture is not clickable and the cursor does not suggest it is.
- [ ] Clicking the picture does not also trigger the row underneath it.

## 2d-iii. How deep table-rolled stock stacks

- [ ] Roll a table onto an inventory → rows are **not all QTY 1**. Cheap consumables arrive several deep.
- [ ] A compendium item authored as a stack (a quiver of arrows, a pouch of caltrops) arrives at **its own
      quantity**, not at 1.
- [ ] Armour, weapons, tools and containers still arrive **one at a time** however cheap they are.
- [ ] Ammunition stacks, unlike other weapons.
- [ ] Restock the same inventory twice → the depths **differ**. The band is a ceiling, not a count.
- [ ] Lower an inventory's **each** limit below a band cap → rolled depth respects the inventory, not the band.
- [ ] An inventory at its **products** limit still refuses new rows, and says so in the console.

## 2d-iv. Clearing and restocking feedback

- [ ] Each inventory has a **broom** button, in the shop window and in Merchant Settings.
- [ ] It asks first, names the count, and says the inventory itself stays.
- [ ] Confirm → every row goes, the **inventory remains** with its stock policy, limits and tables intact.
- [ ] Clearing an already-empty inventory says so and asks nothing.
- [ ] **Restock Everything** shows a progress bar that names the inventory and table it is working on.
- [ ] The bar reaches 100% exactly as the work finishes — not early, not stuck short.
- [ ] An inventory whose table has been deleted still completes the bar rather than leaving it hanging.
- [ ] Restocking a single inventory, from either window, shows the same bar.
- [ ] Delete stock rows **as fast as you can click** → no `Item "..." does not exist!` in the console.

## 2d-vi. The par leak

- [ ] Set a restocking inventory to keep **6** of something. Buy one as a player.
- [ ] Sell it back to the merchant. It lands on the Buyback inventory.
- [ ] Press **Restock Everything** → that buyback row stays at **1**. It must not become 6.

## 2d-vii. Toasts and sounds

- [ ] Completing a transaction raises a **toast**, not a Foundry notification: what was paid as the
      headline, who and where underneath.
- [ ] That toast **stays until clicked**. Clicking anywhere on it dismisses it; so does the ×.
- [ ] A second purchase **replaces** the first receipt rather than stacking two.
- [ ] Every warning and error is a toast too — red for errors, amber for warnings.
- [ ] Restock progress is still a **Foundry progress bar**, not a toast. That one is deliberate.
- [ ] Settings show six sound options, all defaulting to **None**, all listing Blacksmith's sound library.
- [ ] Set each and confirm it fires: adding to the slate, changing a quantity or price, taking a line off,
      completing a transaction, finishing a restock, and anything that errors.
- [ ] With Blacksmith's sound list unavailable at load, the dropdowns still populate once it arrives.
- [ ] A sound plays **only on the client that acted** — a second player hears nothing.

## 2d-viii. Making change

- [ ] Give a merchant **20,000 gp and no silver or copper**. Buy something costing an odd amount
      (5 gp 6 sp 3 cp). It **completes** — no "cannot make change".
- [ ] Check the till afterwards: the total is right, and it now holds silver it did not before.
- [ ] Sell something to a shop whose till is mostly gold → the same, in the other direction.
- [ ] A character holding **only platinum** can still buy a 1 cp candle.
- [ ] A character holding gold *and* platinum spends the **gold**; the platinum is untouched.
- [ ] Nobody is ever handed **electrum** they did not already have.
- [ ] A genuinely broke character is still refused, and the message is about money, not coins.

## 2d-ix. Shared slates

- [ ] As a **player**, put things on the slate. As the **GM**, open the same shop and switch "Buying as" to
      that character → you see **their** slate, not an empty one.
- [ ] The character picker **badges** characters who have lines on the slate.
- [ ] Add a line as the player → the GM's view updates without a refresh, and the other way round.
- [ ] As GM, **negotiate a price** on their slate line → the player sees the price appear.
- [ ] As GM, **complete the transaction** on their behalf → it settles against that character.
- [ ] Switch "Buying as" to a different character → the slate **changes** to that character's.
- [ ] Open the shop window *after* a player has filled a slate → you still see it (the ping on open).
- [ ] Two clients on the same character do not bounce the slate back and forth endlessly.
- [ ] Reload → slates are gone, which is intended. They are a half-formed intention, not a document.
- [ ] The "Buying as" bar shows a **face for every other character with lines on a slate** here.
- [ ] Clicking a face switches to that slate — no dialog.
- [ ] A character with an **empty** slate gets no face. Faces mean "mid-purchase", not "has been here".
- [ ] Your own character never appears in the row; they are already named beside it.
- [ ] The bar no longer shows a coin total — that lives on the slate as **FUNDS**.
- [ ] As a **player**, with another player in the same shop → you see **their** face. This is the case that
      was broken when faces came from slates.
- [ ] A player's face is a **portrait**, not a button — no pointer cursor, no hover border.
- [ ] The GM's view of that same face **is** clickable and switches to their slate.
- [ ] A character with something on the slate is marked; one merely browsing is not — but **both appear**.
- [ ] Open the shop and take nothing → the others still see your face.
- [ ] Two people shopping as the **same character** both get a face; neither is hidden by the other.
- [ ] A face's tooltip names the **person** and the character they are shopping as, when those differ.
- [ ] Switch "Buying as" → everyone else's view of your face updates to the new character.
- [ ] The slate title carries the shopper's **portrait and name**, and both change when you switch.
- [ ] With no character available, the slate title falls back to a scroll icon and the word Slate.
- [ ] Close the shop → your face leaves everyone else's bar.
- [ ] Disconnect a player → their face leaves too, rather than standing there forever.

## 2d-x. Selling from the pack

- [ ] **Buy / Sell** sit above the search as a pair, on **their own full-height row**, with the current side lit.
- [ ] The row does not collapse when the list below it is long.
- [ ] The search sits in the **same place** on both sides — it must not jump when you switch.
- [ ] Pressing the side you are already on does nothing — it is a choice, not a toggle.
- [ ] **Sell** shows your pack in the stock column, not a modal.
- [ ] Press `+` on a row → it lands on the slate **immediately**. This is the one that was broken.
- [ ] Switch back to Buy → the shop's search text and scroll position are as you left them.
- [ ] The pack looks **exactly like an inventory** — same card, same header, same spacing, same rows.
- [ ] It scrolls in the same region the inventories do, and its header scrolls with it as an inventory's does.
- [ ] The slate is **visible while you add**, and updates as you press `+`.
- [ ] Add several things without reopening anything.
- [ ] The pack has its **own search**; typing in it does not filter the shop's inventories, and vice versa.
- [ ] The sort button cycles **value → name → kind**, and says which it is on.
- [ ] Sorting by kind groups rows under headings.
- [ ] Something already wholly on the slate shows as unavailable rather than being addable twice.
- [ ] An item the merchant has no price for shows as **negotiate**, and can still be added at TBD.
- [ ] Dragging from your sheet into the slate still works — the panel is an addition, not a replacement.

## 2e. Prices, buying and selling

Buying and selling need `blacksmith.inventory.exchange`, which does not exist yet. Until it does, the Buy
and Sell controls are **present but disabled, naming their reason on hover** — that state is itself the first
check, and it reverses what this file said before 2026-08-18.

- [ ] With no `exchange` in Blacksmith, Buy and Sell are **disabled**, and hovering either says it is waiting
      on a Blacksmith update. The GM's free-take still works.
- [ ] Prices show on each row, formatted largest-coin-first ("1 gp 5 sp").
- [ ] An item with no price shows **no price** in red on a sale inventory, and nothing on a barter inventory.
- [ ] Markup 2 in config doubles every displayed price; the Premium inventory stays at its own 1.5.
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

- [ ] Buy from an **infinite** inventory → the merchant's row is untouched, same quantity as before.
- [ ] Buy 3 from an infinite inventory whose row reads 1 → all 3 arrive. The row is a template, not a count.
- [ ] Buy from a **finite** inventory → the count comes down by what you bought.
- [ ] Buy the last one → the row stays at 0 rather than disappearing.
- [ ] Restock that inventory → the row comes back to its par, which is why it had to survive.

Once `exchange` ships:

- [ ] Buy asks **how many**, then **who it is for**, then confirms with the price. Three prompts, that order.
- [ ] The confirm names the **shopper** as the payer, not the destination.
- [ ] Choosing anyone but yourself is refused, and the destination dialog said so **before** you chose.
      *The shopper pays while someone else receives is a three-party transaction and `exchange` is two-sided.*
- [ ] Buy an item you can afford → coin leaves, item arrives, and the change is right.
- [ ] Buy with only large coins → you pay the large coin and get change back.
- [ ] Buy with only small coins → you pay the small coins, no change.
- [ ] Buy something you cannot afford → refused with what it costs and what you hold, and **nothing moves**.
- [ ] Buy on a barter inventory → refused; barter is a conversation.
- [ ] Sell an item → it leaves your sheet, coin arrives, and it lands on the **Buyback** inventory.
- [ ] Sell when the merchant's till is empty → refused, and nothing moves.
- [ ] Sell an item belonging to a character you do not own → refused with `NOT_YOUR_ITEM`.
- [ ] Sell to a merchant with no Buyback inventory → the Sell control is absent.

### Stock

Three policies, set per inventory in Merchant Settings, `Same as the shop` inheriting the merchant's.

- [ ] An inventory set to **Never runs out** shows ∞ in the quantity column and never decreases.
- [ ] An inventory set to **Runs out** shows a number, and buying decreases it.
- [ ] **The row does not vanish at zero.** It stays, dimmed, marked out of stock.
      *This is the whole design. A vanished row loses the inventory layout and leaves nothing to restock.*
- [ ] At zero, Buy, add-to-cart and the GM's free-take are all disabled, all saying "Out of stock".
- [ ] A crafted request against a zero row is refused with `OUT_OF_STOCK` — **not** merely disabled.
- [ ] Asking for more than is there is refused with how many are left.
- [ ] The quantity dialog will not offer more than is in stock.
- [ ] With 1 left, the dialog does not appear at all — there is no choice to make.
- [ ] **Buyback is finite whatever the shop is set to**, including when the shop says Never runs out.
- [ ] Switching an inventory's policy updates an open shop for a player without either side reopening.

#### Quantities and par

- [ ] A GM sees an editable number in the quantity column on any counting inventory; a player sees plain text.
- [ ] Typing a number and pressing Enter or clicking away commits it, and a player's open window updates.
- [ ] Setting the number by hand sets **both** the count and what it restocks to.
- [ ] Buying lowers the count and leaves the restock target alone — hover the quantity to read both back.
- [ ] Dragging a new item onto an inventory sets its restock target from the quantity that arrived.
- [ ] Dragging *more of an item already there* tops up the count and leaves the target where it was.

#### Inventory ceilings

- [ ] Type a quantity **above** an inventory's "each" limit → it clamps, and says where to raise the limit.
- [ ] Raise the limit, type it again → it takes.
- [ ] Lower an inventory's limit **below** an existing row's quantity → nothing is deleted, and the row's restock
      target reads the new, lower limit.

- [ ] A new inventory shows **25 products** and **20 each**.
- [ ] Fill an inventory to its product ceiling, then restock from a table → no new rows appear, and existing rows
      can still top up.
- [ ] Lower the ceiling below what is already there → nothing is deleted; it simply stops growing.
- [ ] A row at the per-item ceiling stops receiving from table rolls.
- [ ] Hover a row's quantity → its restock target never reads higher than the per-item ceiling.
- [ ] Both are per inventory: set the Back Room to 5 products and the Storefront stays at 25.

#### Removing stock

- [ ] A GM sees an **×** on each shop row; a player does not.
- [ ] It removes the row **immediately**, with no confirmation.
- [ ] Removing a **packed container** still asks — about its contents, which is a real question.
- [ ] Cancelling that prompt leaves the container alone.
- [ ] An **empty** container is removed without a prompt like anything else.
- [ ] Setting a quantity to 0 instead leaves the row in place, marked out of stock, and a restock brings it
      back. *These are two different statements and must stay so.*

#### Restock Everything

- [ ] Merchant Settings shows a green **Restock Everything** in the footer, right-justified.
- [ ] A merchant with **no inventories** does not show it at all.
- [ ] It asks first, naming the shop and how many inventories, and says rolled stock is added not replaced.
- [ ] Cancelling changes nothing.
- [ ] Confirming brings every inventory to its quantities **and** rolls every table on them, marked or not.
- [ ] It reports **one** total, not one message per inventory.
- [ ] Inventory ceilings still apply — it cannot push an inventory past its product or per-item limits.

#### Rerolling, and restocking from the shop

- [ ] A newly dropped table has **reroll off**.
- [ ] Press **Restock** — from Settings or from the inventory header in the shop — and **every** table rolls,
      marked or not.
- [ ] Advance the clock past the interval → **only** tables with reroll ticked deliver.
- [ ] An inventory whose tables are all unmarked, on a policy that is not "runs out, refills", is left alone by
      the clock entirely.
- [ ] Tick reroll, advance the clock, and it delivers; untick it and it stops.
- [ ] The inventory header's restock control is GM-only, and sits beside the search glass.
- [ ] The search control is a **magnifying glass**, and opens Blacksmith's compendium search.

#### Several tables on one inventory

- [ ] Drop a second table on an inventory → **both** are listed, each with its own roll count.
- [ ] Drop the same table twice → it says so and does not duplicate it.
- [ ] Each table's roll count is independent.
- [ ] Restock → every table rolls its own number of times, and the results arrive together.
- [ ] The same item rolled by two different tables lands as **one row** with a quantity of two.
- [ ] Remove one table → the other keeps working.
- [ ] Delete a table from the world → the inventory lists it as "Missing table" and the others still roll.
- [ ] An inventory configured before this change still rolls its original table.

#### Merchant Settings titlebar

- [ ] **Refresh** redraws the window and picks up an inventory edited on the Actor sheet.
- [ ] **Open Shop** opens the shop for a merchant with a token on the current scene.
- [ ] It also works when the merchant's only token is on **another** scene.
- [ ] With no token anywhere, it says so rather than failing silently.

#### Stocking from a roll table

- [ ] Drag a **RollTable** from the sidebar onto an inventory row in Merchant Settings → the row highlights and
      the table's name appears on it.
- [ ] Drag one from a **compendium** → same thing. A compendium table is the normal case.
- [ ] Drag something that is not a table → refused with a message, and the inventory is unchanged.
- [ ] Set the roll count; press **Restock** → that many rolls, and what comes up lands on that inventory.
- [ ] A table rolling the same item several times produces **one row** with a quantity, not several rows.
- [ ] Text-only results are skipped without erroring.
- [ ] Non-physical results — a journal, an actor — are skipped too.
- [ ] Rolling does **not** mark the table's results as drawn; restock twice and the second still rolls.
- [ ] Advance the clock past the inventory's interval → it rolls on its own.
- [ ] A table-stocked inventory restocks on the clock even when its policy is not "runs out, refills".
- [ ] The **×** clears the table and the inventory stops rolling.
- [ ] Delete the table from the world → the inventory shows no table rather than erroring.

#### Restocking

- [ ] An inventory set to **Runs out, refills** shows an "every _n_ days" field; the other policies do not.
- [ ] Sell the inventory down, advance the world clock by the interval → it refills to its targets.
- [ ] Advance by **a week** on a 1-day inventory → it refills **once**, to par. Not seven times, not seven copies.
- [ ] Advance by less than the interval → nothing changes.
- [ ] Wind the clock **backwards** → nothing breaks, and the inventory restocks normally afterwards rather than
      waiting for the world to catch up to a timestamp in the future.
- [ ] An inventory that has never restocked starts its clock rather than refilling on the spot.
- [ ] The refresh icon in Merchant Settings refills an inventory immediately, and says how many items it topped up.
- [ ] It appears on **finite** inventories too, and says "already full" when there is nothing to do.
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
- [ ] On an infinite inventory the cart changes nothing: the row still reads ∞.

#### Buyback resale price

- [ ] Merchant markup 2, Buyback rate 0.5, an item worth 10 gp: the shop offers **5 gp** for it.
- [ ] Sell it, then look at it on the Buyback inventory: it is priced at **20 gp**, the shop's ordinary markup —
      *not* 5 gp. Selling something and buying it straight back must not be free.

#### Two buyers, one item

**The race infinite stock did not have.** Finite stock means two clients can read the same count.

- [ ] Set an inventory to Runs out with exactly **1** of something.
- [ ] Two players click Buy on it at the same moment → **one succeeds, one is refused**, and the count is 0.
      *Both succeeding means the lock is not doing its job. Report it — this is the least visible bug here.*
- [ ] The same with the GM's free-take, and with one player buying while another checks out a cart.
- [ ] Neither player's window is left showing a stale count afterwards.

### Item tooltips

- [ ] Hover an item's **name** on an inventory → dnd5e's item card, the same one its sheet shows.
- [ ] Hover the quantity, the price or a button on that row → their own tooltips, **not** the item card.
- [ ] Hover a name in the slate's **Buying** section → the merchant's item.
- [ ] Hover one in **Selling** → your own item. *Different Actors; a mix-up here shows the wrong card.*
- [ ] A truncated name still tells you what it is.

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

### Position memory

- [ ] Move and resize the shop, close it, open it again → it comes back where and how you left it.
- [ ] Open a **different** merchant's shop → same place and size. One shop's position serves all of them.
- [ ] Same for Merchant Settings.
- [ ] Two shops open at once stack on each other. *Known and accepted: they share one saved position.*
- [ ] A window dragged partly off-screen still comes back reachable.

### Layout

- [ ] The cart is level with the **merchant card**, not with the first inventory — it runs the full height of the
      window beside everything.
- [ ] Only the footer spans both columns.
- [ ] The merchant card, buyer card and search stay put while the item list scrolls beneath them.
- [ ] A tall cart uses that whole height rather than being squeezed under the header.
- [ ] Narrow the window until the cart wraps → the header cards, search, items and cart stack in that order
      and scroll as one.

### Inventory grouping

- [ ] Inventories read as distinct groups; a long Storefront does not run into the inventory below it.
- [ ] Scroll a long inventory → its heading **sticks to the top of the list** and names what you are looking at.
- [ ] Scrolling into the next inventory swaps the heading for that one.
- [ ] Rows pass **behind** the heading and stay legible against it rather than merging into it.
- [ ] A hidden inventory's heading is tinted as well as carrying the Hidden pill.
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
- [ ] **Buying** and **Selling** headings are the same size and weight as an inventory heading.
- [ ] A small **Sell** button in the slate header opens the picker — **with items already on the slate**,
      not only when it is empty.
- [ ] That button is absent on a merchant with no Buyback inventory, and disabled with no character to sell as.

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

## 2g. Kind, description, and the inventory menu

- [ ] Merchant Settings shows **The Shop** with a kind dropdown and a description box.
- [ ] The kind dropdown is wide enough to read its longest option without an ellipsis.
- [ ] Pick a kind → the shop window's kicker changes from "General Store" to that, with its icon.
- [ ] Type a description, click away → it saves, and **the caret does not jump** while typing.
- [ ] The description appears under the shop name for a player, in italics.
- [ ] A description containing `@UUID[...]` renders as a working link rather than as raw text.
- [ ] Clearing the description removes the block rather than leaving an empty bordered strip.
- [ ] The **+** on the Inventories header opens a menu of the five presets, each with its artwork and hint.
- [ ] Picking one adds that inventory; the old row of five buttons is gone.
- [ ] Inventory artwork is the Foundry container icons — a crate, two chests, a basket, a sack.
- [ ] The trading-hours **opening** handle is green and the **closing** handle red, and the readout labels
      match. Drag either; the colours stay put.

## 2h. Editing an inventory outside Merchant

**The GM can reach these containers through Foundry's own UI, and nothing stops them.** Everything here is
about following that rather than fighting it.

- [ ] Rename an inventory container on the Actor sheet → the name changes in Merchant Settings **and** in an open
      shop window, without pressing Refresh.
- [ ] Rename it to something long → the row still lays out; the name does not shove the buttons off.
- [ ] Change an item's quantity on the container sheet → a shop window open on another client updates.
- [ ] Delete an inventory from the Actor sheet rather than the trash icon → it leaves an open shop window.
- [ ] Drag an item from one inventory to another on the Actor sheet → it moves sections in an open shop.
- [ ] **Drag one inventory inside another inventory** → the nested inventory still renders as its own section, and does
      **not** also appear as an item for sale on its parent.
- [ ] A crafted request to buy an inventory is refused with "That is not for sale."
- [ ] An ordinary container that is *not* an inventory — a backpack on the Storefront — still sells normally.

## 2f. Searching the shop

The filter itself is covered by `tests/test-search.mjs` against the real templates. What is left is whether
it is wired to the box and survives the things that redraw the window.

- [ ] Type into the search box — the list narrows as you type, with **no flicker and no lost caret**.
      *A re-render per keystroke would show as the cursor jumping to the end. That is the bug this design
      exists to avoid.*
- [ ] An inventory with nothing matching disappears, heading and all; so does an empty category heading.
- [ ] The count on each inventory header shows how many are showing, and goes back to the real total on clear.
- [ ] No matches at all → "Nothing here matches that."
- [ ] The **×** clears the search and puts focus back in the box; **Escape** does the same.
- [ ] Searching by kind works: "weapon" finds the weapons, "consumable" the consumables.
- [ ] With a search active, hit titlebar **Refresh** → the search survives and still applies.
- [ ] With a search active, have a GM add stock → the list updates and the search still applies to it.
- [ ] With a search active, buy something → the row updates and the search is still there.
- [ ] Search, then buy the only visible item on a finite inventory → it goes out of stock rather than vanishing.
- [ ] A GM searching still sees hidden inventories among the results, still marked hidden.
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

- [ ] A merchant **with** a Buyback inventory shows a **Selling** panel under the cart; one without shows none.
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
- [ ] Everything sold lands on the **Buyback** inventory and is immediately on sale there.
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

- [ ] Inventory sections list only physical items; features, spells and class items are absent.
- [ ] Within an inventory, stock is grouped under Weapons, Armor & Gear, Consumables, Tools, Containers, Goods.
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
- [ ] As GM, double-click an inventory row's **QTY** → same behaviour, and it sets the restock target too.
- [ ] A player double-clicking an inventory row's QTY does nothing; only a GM gets an editable stock cell.
- [ ] The stock cell is a **number with a QTY caption**, not a form field sitting in every row.
- [ ] Editing while a request is in flight is refused rather than racing it.

## 4b. Old quantity prompts (removed)

One dialog serves four actions, and it must name the one you pressed.

- [ ] Cart icon → title "Add {item} to the cart", confirm reads **Add to cart**.
- [ ] Buy → title "Buy {item}", confirm reads **Buy**.
- [ ] Sell → title "Sell {item}", confirm reads **Sell**.
- [ ] The GM's give → title "Give {item}", confirm reads **Give**.
- [ ] The word "Acquire" appears nowhere.
- [ ] The slider ends read "Yours" and "Left on the inventory", not "Take" and "Leave".
- [ ] **Dragging the slider updates the numbers.**
- [ ] Dialog buttons are `[ Cancel ]` left, the action right.
- [ ] The item arrives on the buying character.
- [ ] **On an infinite inventory the merchant still has it, at the same quantity.** If the count drops, or the
      row vanishes, `transferItem` semantics have crept in where `grantItem` belongs.
- [ ] Acquire the same item twice → the buyer's stack grows rather than gaining a second row.
- [ ] Two players acquire the same item simultaneously from an **infinite** inventory → both succeed, merchant
      unchanged. On a **finite** inventory with one left, exactly one succeeds — see *Two buyers, one item*.

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
- A sold-out row stays on its inventory, dimmed. That is deliberate, not a failure to clean up.
- A GM cannot temporarily lower a count without also lowering what it restocks to. Judged rare; say so if it
  turns out not to be.

## 20. Inventory types, stacking and reputation

New on 2026-08-19. The first two are the ones that touch data you already have.

### 20a. Migration — do this first, on a world with shops in it

1. Load as GM. The console reports `Migrated N inventories to the typed schema.`
2. Every existing inventory keeps its name, its contents, its visibility and its stock policy.
3. Each lands on a sensible type: the buyback one reads **Purchased**, a negotiate one reads **Unpriced**,
   a hidden one reads **Hidden**, one with a markup above 1 reads **Premium**, below 1 **Discounted**.
4. Reload. The console does **not** report a migration a second time.
5. On the container's flags (`Actor → item → flags`), `coffee-pub-merchant.inventory` exists and
   `coffee-pub-merchant.shelf` is gone. Not both.

### 20b. Naming and types

6. Merchant Settings shows a **name field** on every inventory, with the type beneath it. Rename one; the
   shop window and the container's own sheet both follow.
7. Clear the name entirely. It falls back to the type's name rather than becoming blank.
8. Add two inventories of the same type. Both work, and telling them apart is what the names are for.
9. A **Premium** inventory still has the eye toggle in the shop window, and hiding it works. The type sets
   the default; it does not remove the control.

### 20c. Pricing — the stacking rule

10. Set Global Markup 1.0, a Premium inventory 1.5. A 50gp item lists at 75gp.
11. Set Global Markup 1.2. The same item now lists at **90gp**, not 75gp. This is the change: the inventory
    markup multiplies against the shop's baseline rather than replacing it.
12. A Discounted inventory at 0.75 in that 1.2 shop lists it at 45gp.
13. Type a markup of `0`, a negative, or letters. It reads as 1 and the price does not collapse.

### 20d. Purchased — two rates

14. A **Purchased** inventory shows **× purchase** and **× sell**, and no stock policy — it says items are
    removed and never restocked instead.
15. Sell something worth 50gp at a purchase rate of 0.5. The shop pays 25gp.
16. That item then lists on the purchased inventory at its **sell** rate — 50gp at 1.0, not 25gp. A shop
    buying at half price must not resell at half price.
17. Raise the purchase rate above 1.0. The shop pays over the odds, which is a scene a GM may want.

### 20e. Reputation

18. With the checkbox **off**, changing party reputation moves nothing. This is the default and the
    commonest state.
19. Turn it on. Merchant Settings names the band and what it is doing — *"The party is Distrusted on this
    scene, so prices here are 15% dearer."*
20. At **neutral** reputation with the modifier on, prices are **unchanged**. Check this one specifically.
21. Positive reputation: prices drop **and** the shop pays more when the party sells. Both directions.
22. An agreed price on the slate does not move with reputation. A haggled number is the number.
23. Change reputation while a shop window is open. It redraws by itself, on every client.
24. Two scenes with different reputation, one merchant with a token on each: each shop prices to **its own**
    scene. Open both and compare — a GM standing on one map must not reprice the other.
25. Settle a purchase with reputation on. What is actually charged matches what the slate showed.

### 20f. The ceilings

26. An inventory with **no** roll table shows no *products* limit — it could never have fired there.
27. Add a table; the *products* limit appears.
28. An inventory that never runs out shows no *each* limit either. One that counts its stock does.

### 20g. Artwork, sliders, and what Purchased does not have

29. Each inventory's artwork is **56px** and hovering it shows a pencil. Click it: Foundry's file picker
    opens at the current image. Choose another; it changes here, in the shop window, and on the container's
    own sheet.
30. Cancel the picker. Nothing changes.
31. Markup is a **slider**. Dragging it repaints the readout mid-drag — *"×1.35 · 35% dearer"* — and the
    document is written once, on release, not once per pixel.
32. Drag a Discounted inventory below 1. The readout says *cheaper*, not *dearer*.
33. A **Purchased** inventory shows two sliders, Purchase and Sell, and the Purchase readout says what it
    means: *"pays 50% of worth"*. Above 1.0 it says *over the odds*.
34. A **Purchased** inventory has **no** roll-table row, **no** drop target for tables, and **no** restock
    button. Dragging a roll table onto it does nothing.
35. Press **Restock Everything** on a shop with a Purchased inventory. Everything else refills; the
    purchased stock is untouched. Advance the clock a week: same.
36. The *products* limit is gone from every inventory. The only ceiling is **max N of each item**, and it
    appears wherever stock is counted.

### 20h. Trade routes and the gold machine

37. Two merchants, one at Global Markup ×1.00 and one at ×2.00 with a purchase rate of 0.6. A 100gp item
    costs 100 at the first and the second pays 120 for it. **That profit is the point** — it is the trade
    route, and it comes from the two merchants' markups, not from reputation.
38. The dear merchant also *charges* more: the same item lists at 200 there. A shop that pays well sells
    dear; the two move together.
39. **The loop that must never pay.** At one merchant, sell an item and immediately buy it back. You must
    always be out of pocket. Try it with a generous purchase rate (0.9 or higher) in a scene where the party
    has high reputation — that was the exact case that used to profit.
40. Reputation alone cannot make a route: a scene where the party is loved is cheaper to buy in *and* pays
    more, so there is no pair of scenes to run goods between on reputation alone.

### 20i. The local market

41. Open a Scene sheet as GM. Its header menu has **Local Market**. It opens a slider from ×0.25 to ×4.00
    with a readout saying what the number means — *"goods cost 100% more here"*.
42. Set a scene to ×2.00. Every merchant on that map now lists at double, and the shop window's card says
    **"Prices here run high"**. Set it to ×0.50: half, and *"Prices here run low"*.
43. At ×1.00 the shop card says **nothing** about the market, and the scene's flag is removed rather than
    storing a 1.
44. **The route.** Put one merchant on a ×0.50 scene and one on a ×3.00 scene. Buy a trade good cheaply from
    the first, carry it to the second, and sell it for a profit. This is the feature.
45. The dear scene also *charges* more — it is not a place to shop, it is a place to sell.
46. **The loop still loses.** On the ×3.00 scene, sell something to the merchant and immediately buy it
    back. You must be out of pocket, and by a lot.
47. Change a scene's market while a shop on it is open. It reprices without needing a refresh.
48. A merchant with a token on two scenes with different markets prices differently in each — open both.

## 21. The envelope, the party, and the schema — 2026-08-21

Built unattended. **Start here in the morning**, because 21a is the one that decides whether anything else
is testable: if the op did not register, nothing can be bought or sold at all.

### 21a. Buying and selling still work

1. As GM, buy something. It settles. This exercises the local-dispatch path — a GM runs the handler in its
   own client with no round trip.
2. As GM, sell something. It settles.
3. **With a player client connected**, have the player buy something. This is the path that actually goes
   over the wire to the GM, and it is the one that could not be tested without you.
4. The player sells something.
5. Watch the GM's console during 3 and 4. `UNKNOWN_OP` means the op did not register on that client;
   `IDENTITY_UNVERIFIED` means Blacksmith could not tell who asked and is theirs to fix, not ours.
6. With the GM **disconnected**, a player attempting to settle is told no GM is connected — not left hanging.

### 21b. The migration to schema 3

7. Load as GM in a world that has agreed sell prices on a merchant. Those prices survive: the stored key
   moved from `buybackOverrides` to `purchaseOverrides`.
8. On the merchant's flags, `pricing.purchaseOverrides` exists and `pricing.buybackOverrides` does **not**.
   Not both.
9. `flags.coffee-pub-merchant.merchant.schema` reads `3`.
10. Reload. The console reports no migration the second time.
11. **Before** the GM logs in, a player opening a shop still sees agreed sell prices — the old key is read
    as well as the new one for exactly that window.

### 21c. Party roster

12. The **Buying as** list is unchanged from yesterday for a normal party.
13. A world with a familiar or companion in the party: it is **not** offered as somebody to shop as.
14. A world with no primary party set still offers a usable list — every player-owned character.

### 21d. Quieter and tidier

15. Drag a stack of items between two inventories on a merchant sheet with the shop open. It redraws, once,
    promptly. Previously each item was its own broadcast.
16. Restock an inventory that rolls several tables. One redraw, not one per row.
17. Two merchants changed at once both redraw — coalescing merges per merchant and must not lose either.
18. Nothing in the shop or settings windows looks unstyled: thirty-four dead CSS rules were removed, and a
    mistake there would show as a control losing its box or its colour.

### 21e. Restock row, table switches, and the reputation sentence

19. The shop card reads as a sentence: *"Your reputation in this area is **Known**, so you get a **3%
    benefit** on pricing."*
20. Method, Frequency and Max stack sit on **one row**, and wrap rather than squeeze when the window is
    narrowed. Frequency is absent unless the method restocks.
21. **Max stack now appears on a "Never runs out" inventory that has a roll table** — it was hidden there,
    while still quietly capping every roll. On an unlimited inventory with no table it stays hidden, because
    then it genuinely cannot act.
22. Its explanation is a tooltip rather than a line of text, and says something different on an unlimited
    inventory than on a counted one.
23. Click into a **Draw** box: the current value is selected, so typing replaces it.
24. Type `0` into Draw and tab away. It becomes `1` — a table that draws nothing is not a table, and the
    clamp has always been there; this only makes it reachable by typing.
25. **Uncheck a roll table.** It stays on the inventory, its name and controls quieten but the checkbox stays crisp, it keeps its Draw count,
    and contributes nothing to a restock. Check it again and it works as before.
26. Restock an inventory with one table switched off: the progress bar counts only the tables that will
    actually roll.

### 21f. Setting a price from the shelf, and selling with a card

27. Put an item with **no price** on a general inventory (a rolled table result often is one; `system.price`
    at 0 is the case). The row reads **no price** and its `+` is disabled — this is the state that used to
    have no way out, because the row cannot reach the slate to be priced there.
28. **Double-click that cell** as a GM. An empty box opens with a `gp` placeholder. Type `25`, press Enter.
    The row prices, the `+` enables, and the item sheet shows 25 gp — it is the item's own price, not an
    agreement, so it does not vanish when the trade settles.
29. Double-click a **priced** row. The box opens showing the item's **own** price, not the marked-up figure
    on the shelf. Press Enter without changing it and the shelf price is unchanged — pressing Enter must not
    quietly bake the shop's markup into the item.
30. Set a price on a row in an inventory with a markup, and confirm the shelf figure is your number times
    that markup, times the shop's Global Markup, times the market and standing.
31. Escape abandons; clearing the box and pressing Enter puts the row back to **no price**.
32. As a **player**, the same cell does nothing and its tooltip says only that there is no price set — no
    editing affordance, no cursor change.
33. On an **unpriced (negotiate) inventory** the cell still reads *negotiate* and is not editable for anyone.
    A list price there would be written and then ignored.
34. Prices set this way reach other clients: a second browser sees the row price without a reload.
35. **Switch to selling.** Hover an item's **name or image** in your own pack — dnd5e's item card appears,
    exactly as it does on the buying side. It did not before.
36. As a GM in sell mode, **click the image** of a pack row. The shopper's item sheet opens — not the
    merchant's, and not nothing.
37. The price column lines up identically for a GM and for a player. The editable cell must not shift the
    figure in from the row's edge.

### 21g. Restocking to a level, and rolling for new products

**Restart Foundry first** — `const.js` and `settings.js` both changed, and the new world settings
only register on a fresh load. The schema-4 migration runs once at startup and stamps a restock
level onto every existing row; it logs how many.

38. Open Merchant's module settings. Twelve new numbers appear: six **Stock depth: <type>** and six
    **Stock depth: <rarity>**. Defaults are Consumable/Loot 10, everything else 5; Common 0,
    Uncommon 3, Rare 2, Very rare/Legendary/Artifact 1.
39. On any inventory card there is now a **Stocking** section above Restock, holding **Depth**,
    **Products** and **Max stack**, with a two-line summary of those world numbers and a note that
    they are world settings. Restock keeps only Method and Frequency.
40. **The one that was broken.** Take a general inventory with rolled stock. Note a row — say
    Flute at 4. Buy or set it down to 1. Restock the shop. **It comes back to 4.** Before this it
    stayed at 1 forever, and the restock reported success while doing nothing.
41. Sell out a row completely so it reads 0. It stays on the shelf as a 0 row, and a restock brings
    it back to its level. Delete a row with the `×` and a restock does **not** bring it back.
42. Type a new quantity into a row — say 12. That is now the level: sell some, restock, and it
    returns to 12 rather than to whatever it was before you typed.
43. **Restock twice in a row.** No duplicate lines. Before this every restock added a fresh set —
    two Torches, two Flutes, growing each time.
44. A roll table that draws something already on the shelf changes nothing about that row: it
    keeps its quantity and its level. Only genuinely new products land.
45. Set **Products** to two above the current line count and restock. At most two new lines
    arrive, and a further restock adds none — it is a target, not a ceiling.
46. Set **Depth** to Deep on one inventory, clear it, and restock. Rows arrive roughly twice as
    deep as the same tables give a Normal shelf. Sparse gives about half, and never zero.
47. **Max stack still wins over the dial.** Set Max stack to 3 and Depth to Deep: nothing arrives
    above 3. The number on the card is the number in force.
48. Drag an item from a compendium onto an inventory. A cheap consumable arrives as a small
    stack rather than as 1. Armour still arrives as 1 — that is rarity and price agreeing.
49. Drag a **second** copy of something already on the shelf. It merges into that row, and the
    row's level rises to the new total rather than dropping to what the drop carried.
50. Set a rarity cap to 0 in world settings and restock: that rarity is then governed by type and
    price alone. It must not read as a cap of nothing.
51. **Nothing arrives as a single item unless it has to.** Clear a general inventory and restock.
    No cheap common row lands at 1 — a dagger or a dart comes in at 3–5, torches at 5–10. Before
    this the roll was uniform from 1 and about a fifth of the shelf landed single.
52. Plate armour and anything legendary still arrive alone: their ceiling is 1, and the floor must
    not raise it.

### 21h. Which merchants the clock reaches

53. Make an **unlinked** merchant in the sidebar, drag two copies onto a map, and set both to
    *Restocks the same items / Daily*. Buy something from each, then advance the world clock a day.
    **Both restock, independently.** Before this neither ever did.
54. The **sidebar template** does not restock. Check its inventory before and after advancing the
    clock — unchanged. It is a mould, not a shop.
55. Nothing leaks from the template into a placed copy any more, because nothing happens to the
    template on the clock. Restocking it **by hand** still does reach placed copies for rows they
    have not touched — that is Foundry's ActorDelta, not ours, and it is why you edit the tokens
    rather than the mould.
56. Make a **linked** merchant and place it. It restocks on the clock. Delete the token from the
    canvas and advance the clock again: it still restocks, because a linked merchant is a shop
    whether or not it is standing anywhere.
57. Put an unlinked merchant on a scene you are **not** viewing and advance the clock. It restocks.
58. Two unlinked copies with different trading hours open and close independently — the schedule
    redraw is keyed per token, not per Actor.
59. Advance the clock in a world with a few hundred tokens and no lag: the scene walk skips
    linked tokens and tokens with no actor before resolving anything.
60. **Standing helps when selling, at every band.** Sell the same item to the same purchased
    inventory with the party's reputation set low and then high. The offer rises with standing and
    never falls. Before this it peaked around Known and dropped away above it.
61. **The shop cannot be farmed.** Buy something off the general shelf and immediately sell it back.
    You get less than you paid, at every reputation band. If that ever reverses, the purchased
    inventory's Purchase rate has been set above its Sell markup times the square of the reputation
    multiplier — roughly 72% at a 5% markup.

### 21i. Giving things away

62. Double-click a shelf price and type **0**. The row reads **Free**, and its `+` is enabled.
63. Put it on the slate. The line reads **Free**, the total does not move, and Complete transaction
    hands the goods over with no coin changing hands.
64. **Free is not the same as no price.** Clear the same row's price box instead: it goes back to
    **no price** and its `+` is disabled. Typing 0 and clearing must not land in the same state.
65. A free row stays free through every multiplier. Set a Global Markup, an inventory markup, a
    market rate and a reputation, and it still reads Free.
66. **Buy a free item, then sell it back.** The shop offers **Nothing** for it, not 1 cp.
67. Check the item on the buyer's sheet: it is an ordinary item with an ordinary price. The
    giveaway was the shop's decision, not a property of the thing, and must not travel with it.
68. A **negotiated** 0 on a slate line still works and still clears when the trade settles — that is
    one trade, where the shelf price is a standing offer.

### 21j. The shared actor picker

69. With two or more characters able to shop, click the **Buying as** button. Blacksmith's picker opens
    with a search field and avatars. Choose someone: the shop reprices and the slate switches to theirs.
70. Cancel it and nothing changes — the character you started on is still the one shopping.
71. **Known regressions, both upstream.** The picker highlights the *first* character rather than the one
    currently shopping, and nobody is badged with how many lines they already have on a slate. Neither is a
    Merchant fault; both are one `pickActor` option away.

### 21k. Localisation

72. Open both windows and read them. No string renders as a dotted key —
    `coffee-pub-merchant.shop.buy` where the word "Buy" belongs is what a missing key looks like, and it
    looks like text.
73. Every tooltip still says something. Hover the quantity, the price, the restock and compendium buttons,
    and each roll table's Draw box.
74. The reputation line reads as one sentence with **the band and the effect in bold** — not as three
    fragments, and not with a literal `{band}` in it.
75. Module settings: the six sound choices and the twelve stock-depth numbers all have names and hints.
76. Refuse something on purpose — try to buy with an empty purse, or settle a slate with a TBD line. The
    message is a sentence, with the amounts filled in.
77. Restock and watch the progress bar: each step names the table or the inventory it is working on.

### 21l. Sockets — needs two clients

78. **Restart Foundry** (not a reload): `module.json` gained `scripts/utility-sockets.js`, and the
    manifest is read at server start.
79. GM and player both open the same shop. Each sees the other's face in the room.
80. The player adds something to their slate. The GM, switched to that character, sees the line appear.
81. The GM adds stock to an inventory. The player's open window redraws without being touched.
82. The player closes the shop: their face leaves the GM's room. Have them disconnect entirely — same.
83. A window opened **late** shows who is already there and what is on their slates, rather than an empty
    room until somebody moves.
84. **Nobody sees their own slate arrive as somebody else's.** This is the one a wrong transport would
    break: `emit` must not echo to the sender.
85. Console shows no `Could not register` or `Could not emit` warnings on load.

86. **Mundane is not common.** In module settings set *Stock depth: Common* to 2 and leave *Mundane*
    at 0, then restock a general inventory. Rope, torches and plain weapons still arrive in normal
    depth; only common **magic** items are held to two. Before this they were capped together.

### 21m. Stocking from the compendiums

87. On a general inventory, set **Source** to *Configured Compendiums*. The roll-table list is replaced by a
    filter: kinds, rarities and a gold range. Set it to *Weapon* only, *mundane*, 1–50 gp.
88. Clear the inventory and restock. It fills with mundane weapons in that price band, and **nothing
    magical and nothing dear**.
89. **Restock again.** No duplicate rows — the same rule as tables: a draw brings new products only,
    and existing rows are topped up to their quantity first.
90. **Two shops with the same filter are different shops.** Set up a second inventory identically,
    stock both, and compare — the candidates are shuffled, so they should not open with the same list
    in the same order.
91. Set the range to something nothing matches — 900,000 gp and up. The restock says nothing matched
    and names the inventory, rather than failing silently.
92. Untick every rarity. It falls back to the default set rather than meaning "anything", so an
    artifact never lands on a village shelf by accident.
93. **Mundane and Common are separate chips.** Tick *Common* only and restock: you get common **magic**
    items and no rope. That is dnd5e's own distinction, not ours.
94. Switch Source back to *Roll tables*. The filter is replaced by the table list, and the tables that
    were configured are still there.
95. On a Blacksmith without `compendiums.query`, a query shelf shows a warning on its card and draws
    from its tables instead of going empty.

96. **The stocking summary appears once**, above the shelves, not repeated on each card.
97. Drag the **Price** slider's right handle to the far right: it reads **Any**, and the shelf then
    stocks the dearest thing installed. Drag it back and a number returns. Reopen the window — the
    handle is still at Any rather than snapped to the left.
98. **Kinds and Rarity are separate labelled rows.** Ticking *Uncommon* does not change which kinds
    are carried, and vice versa.

99. **Untick a filter pill and it stays unticked.** Turn off two Kinds, close the window, reopen it —
    both are still off. Turn them back on and restock: the shelf carries them again. Foundry merges
    flag arrays by index, so a shrinking list is the case that used to silently do nothing.
100. Clicking pills does not disturb the rest of the card: the shelves below stay where they were and
    the window does not resize.
101. The price range reads as a **badge** beside the track, like the Global Markup readout, and updates
    while the handle is dragged rather than only on release.

102. **Pills respond instantly.** Click six in a row — each changes the moment it is clicked, with no
    pause and no flicker of the shelves below. Reopen the window: all six stuck.
103. Tick a pill and **close the window straight away**. Reopen it — the tick is there. The write is
    debounced, so this is the case where a cancelled timer would have silently lost it.
104. The **Kinds** and **Rarity** labels sit above their rows, not beside them.

105. **Merchant Settings resizes both ways.** Drag it narrow: it stops at 475, with the sliders and pill
    rows still intact rather than wrapping into each other. Drag it wide: it keeps going past 720, which
    used to be a hard cap.
106. Drag it short: it stops at 550. A merchant with several inventories no longer opens at the full
    height of the screen.

107. **Change the restock Method and the card reshapes immediately.** Pick *Restocks the same items*:
    Frequency and Max stack appear straight away, without needing another edit to force it.
108. **Source: *Nothing — stocked by hand*.** Put two items on the shelf by hand, sell one, and restock:
    the sold row comes back to its quantity and **nothing new arrives**. No roll tables, no query filter.
109. The Inventories header shows a labelled **Add Inventory** button rather than a bare +.
110. Hovering **How many of each** explains what it does, not just what the chosen option means.

111. **Restart, then check an existing shop's shelves.** Every one shows an explicit Source: *Roll
    tables* where it has tables, *Manual — Stock by Hand* where it does not. Restock: the table shelves
    still draw exactly as before. This is the migration; if a shelf that used to roll now says Manual,
    it did not run.
112. **Add Inventory** on a merchant. The new shelf defaults to *Manual — Stock by Hand* and draws
    nothing until you choose otherwise.

113. **Four sources in the dropdown**, in order: Manual Only, Configured Compendiums, Roll Tables, and
    *Roll Tables, then Configured Compendiums*.
114. Pick the fourth. The card shows **both** the roll-table list and the compendium filter.
115. Give it one table drawing a handful of distinctive items and a broad filter. Clear the shelf and
    restock: both arrive, and the shelf stops at its product target.
116. **Tables take the last slots.** Set Products to just above the current row count, restock, and the
    table's items land rather than the query's filler.
117. Point a table at something the filter would also return. It appears **once**, not twice.
118. Nothing anywhere refers to migration any more; a fresh world sets up with no migration step at load.

### 21n. Portraits and illustrations

119. **Click the portrait** in Merchant Settings. The file picker opens at the current image; choose
    another. The card updates, and the merchant's **prototype token** art changes with it.
120. Place a token first, then change the portrait. The **placed** token keeps its old art — only the
    prototype changes.
121. Set **Shop illustration** with the browse button. Open the shop: the picture sits behind the shop
    card, dimmed, with the name, hours badge and reputation line all still legible over it.
122. **Type** a path into the field instead of browsing. It takes. Clear the field: the backdrop goes.
123. A shop with no illustration looks exactly as it did before — no faint panel, no shifted text.

124. Drop a roll table on a shelf. Its **Draw** reads **10**, and one restock brings in a visible
    delivery rather than a single row.
125. On a shelf set to *Roll Tables, then Configured Compendiums*, the **Roll Tables** group is above the
    compendium filter — the same order the draw runs in.

126. **The illustration actually appears.** Set one and open the shop: the picture is behind the card,
    with the name, hours badge and reputation line legible over it. The console shows no 404 — a
    relative path here is resolved against the site root, not against the stylesheet.

127. **A shop with an illustration reads as a dark card.** The whole picture is visible at full size —
    not faded out on one side — with light text over it. Check the quiet lines especially: the blurb, the
    kind and hours row, the Buying-as name and the reputation line.
128. With only one eligible character, the **Buying as** button says so rather than doing nothing.
129. **A hidden inventory is framed, not frameless.** Beside a visible one it reads as a dashed,
    warning-tinted card rather than as a card that failed to draw.
130. **The visibility toggle survives being used.** Click **Shown** on an inventory: it becomes **Hidden**,
    the card dashes, and the button is still there reading Hidden. Click it again to bring it back.
131. **Buying as actually switches.** Open the picker, choose a different character, confirm: the card
    names them, prices reprice against their standing, and the slate shown is theirs.
132. **Fold a shelf away.** Click its name: the rows collapse, the chevron turns, and the heading keeps
    its count and its buttons — restock still works on a folded shelf. Click again to open it.
133. Fold two, close the shop, reopen it: the same two are still folded. Open a *different* merchant and
    its shelves are untouched — the state is per shop, not global.
134. A player folding a shelf changes nothing for anyone else.
135. **Search reaches into folded shelves.** Fold one that holds a match, then search for it: the shelf
    opens and shows the row. Clear the search — it folds itself back up. Shelves with no match stay
    hidden rather than opening empty.
136. **Sort the stock.** The icon right of the search toggles name ⇄ price. Rows reorder inside each
    category and the categories themselves stay put. Unpriced rows sit at the end of a price sort.
137. **Fold duplicate rows together.** On a shelf carrying the same item twice (drag a second copy of
    something already on it), press the stack icon on the header. The rows become one, its count is the
    two added up, and the level is the higher of the two rather than the sum. Press it on a tidy shelf:
    it says nothing is duplicated rather than appearing to do nothing.
138. Two rows of the same *name* but different **kinds** — a Longsword weapon and a Longsword potion —
    are left alone.
139. Folding rows on a shelf whose ceiling is lower than the total clamps the merged count to the
    ceiling. Nothing on the shelf reads higher than its own limit afterwards.
140. **The restock button is absent where it would do nothing.** A Purchased/buyback shelf has no
    restock icon at all. A Manual shelf set to *finite* or *infinite* has none either; set it to
    *restocking* and it appears. Compendium and table shelves keep theirs.
141. **Tint a shop.** In Merchant Settings, use the swatch at the right of the **Shop Illustration** row: the shop card washes to
    it — border, background and the rules inside the card — and the name stays readable. Type a hex into
    the box instead and it takes; type rubbish and it clears rather than sitting there disagreeing with
    the card.
142. The cross clears the tint and the card goes back to exactly the leather card it was. It is greyed
    out on a shop with no tint.
143. **Tint a shop that has an illustration.** The picture is still fully visible with the colour over
    it, and every line of text over it is still readable — check the blurb and the Buying-as row.
144. Two shops with different tints, open side by side, are told apart at a glance from across the room.
145. **The trading-hours readout is a badge at the end of the track**, matching the markup sliders and
    the price range. Drag either handle: it updates as you drag, and it still says the same hours after
    the window is reopened.
146. **Rows show rarity beside the kind.** A Potion of Healing reads *Consumable · Common*; a plain
    longsword reads *Weapon* and nothing else. Check both sides — the shop's stock and the sell list.
147. Searching *rare* finds the rare things and not the rope.
148. The rarity colours are legible in Light, Dark and Glass — check a legendary and an uncommon in each.
149. **A renamed token names the shop card.** Drop an unlinked merchant, rename the token, open the shop:
    the keeper line under the shop name is the *token's* name, not the Actor's. Place a second one with a
    different name — the two cards name two different people.
150. **A shelf draws from its own compendiums.** On a query shelf, switch **Which Compendiums** to
    *This Shelf’s Own List* and drag a compendium from the sidebar onto the drop target. It is listed by
    name with its module beneath. Restock: the stock comes from that pack.
151. Drag an *item* out of a compendium onto the same target — it adds that item’s pack, not the item.
152. Drop something that is not a compendium: it says so rather than doing nothing.
153. **A pack outside Blacksmith’s curated set is marked *Waiting*** with an explanation on hover. A list
    whose every pack is uncurated refuses the restock and names the reason, rather than reporting that the
    query found nothing.
154. Remove the last pack from a custom list: the shelf still says *This Shelf’s Own List* and draws
    **nothing**. It must not quietly go back to the curated set.
155. Switch back to *Curated Set* and restock: the ordinary content returns. Switch to the custom list
    again — the packs you had listed are still there.
156. Uninstall (or disable) a module whose pack is on a list: the row reads **Gone** rather than vanishing.
157. **The inventory card reads top to bottom in order:** Item Source, Item Filters, Inventory
    Configuration, Inventory Restocking. Item Filters only appears on a shelf drawing from
    compendiums.
158. **Both orderings draw in the order named.** On a nearly full shelf with a table *and* a
    compendium filter, set *Roll Tables First* and restock: the table's items land and the query
    fills what is left. Switch to *Item Compendiums First* and the other way round.
159. **Move an inventory up and down** with the chevrons on its card. The order sticks after closing
    and reopening Merchant Settings, and the shop window shows the same order. The top card's up
    chevron and the bottom card's down chevron are greyed rather than missing.
160. Move an inventory past a **hidden** one: it moves one place, not two.
161. **The shelves sit beside the Inventories card**, not inside it — one column of cards, evenly
    spaced, no nested border. The Inventories card still carries Add Inventory, the count and the
    stocking-rules summary; a shop with no inventories still shows the empty note there.
162. **Only the two labelled zones take a drop.** Drag a roll table over the card: nothing highlights
    except the *Drop a roll table* zone, and dropping it elsewhere on the card does nothing. Same for a
    compendium and its own zone. Each zone highlights only while something is over it.
163. **A roll table from a compendium drops on the roll-table zone.** Open a compendium of tables, drag
    one onto the zone: it is added. It must not be mistaken for the compendium itself.
    Each zone names the other when it gets the wrong thing: a compendium on the table zone says to use
    the Compendiums list (or, on a curated shelf, to switch to a manual list first), and a roll table on
    the compendium list says to use the Roll tables list.
164. **A compendium of roll tables is refused** by the item compendium list, with the reason — it must
    not be added and then shown as *Gone*.
165. **A curated shelf names its packs** under the mode buttons, comma-separated. With no item
    compendiums configured in Blacksmith it says so instead.
166. **Hover reads as orange** in Light, Dark and Glass — the drop zones, the chips, the header icon
    buttons, the shop's fold headings and the search controls. It should never be the same colour as a
    section heading.
167. **A compendium can be switched off without being removed.** Untick one on a shelf's list: the row
    dims, the pack stays listed, and a restock draws from the others only. Tick it again and it
    contributes. Switch *every* pack off and the restock says the shelf has nothing to draw from,
    exactly as an empty list does.

