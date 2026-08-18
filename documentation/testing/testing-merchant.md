# Merchant Testing Checklist

Working checklist for the shop feature. Tick as you go; note failures inline.

`../plans/plan-merchant.md` records intent; `../architecture/architecture-merchant.md` will describe what
the system actually does once behaviour is verified.

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
- [ ] Adding a shelf creates a container on the Actor; opening it via the box icon shows dnd5e's own
      container sheet, and dragging items in stocks it.
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
- [ ] **The merchant still has it.** Stock is infinite in v1 — this is the whole model, and it failing means
      `transferItem` semantics have crept in somewhere.
- [ ] Acquire the same item twice → the buyer's stack grows rather than gaining a second row.
- [ ] Two players acquire the same item simultaneously → both succeed, merchant unchanged.

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

- The merchant never runs out. Finite and restocking stock are phase 5.
- No prices are shown. Phase 2.
- Nothing costs money. Phase 3, and it needs Blacksmith's `exchange` primitive.
- A packed container cannot be acquired. `api.inventory` v1 refuses it in both directions.
