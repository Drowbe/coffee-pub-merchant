# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Module scaffold: manifest, constants, entry point, documentation structure.
- **Merchant marking** (`scripts/window-merchant-config.js`, `scripts/merchant.js`): a **Merchant Settings** entry on every Actor sheet header opens a configuration window with an "Is a merchant" toggle. It is always present because the way in has to be reachable on an Actor that is not a merchant yet; an **Open Shop** entry appears alongside it only once the Actor actually is one. Merchant state lives on the **Actor**, not the Token — a shop is a persistent entity, so flagging the token would make every placed instance a separate shop and lose the configuration when the token was deleted.
- **Shop window** (`scripts/window-shop.js`, `templates/window-shop.hbs`, `templates/partial-shop-row.hbs`): double-click a merchant token to browse its stock. Acquire an item to your own character, send it to another party member, or send it to the party inventory. Buying-as supports a player with more than one character and remembers the choice.
- **Token interaction claim** (`scripts/manager-merchant.js`): registered through Blacksmith's `api.tokens.registerInteraction` with `gesture: 'clickLeft2'`. Players have no LIMITED permission on a shopkeeper's Actor and Foundry's permission predicate runs before the handler, so the claim relaxes it for matching tokens only.
- **GM-authoritative request path** (`scripts/gm-request.js`): built on Foundry v13's query API — `CONFIG.queries` plus `game.users.activeGM.query()` — rather than a hand-rolled socket envelope. Request ids, the pending map, the timeout and response routing are all core's, and `game.users.activeGM` is core's own single-GM designation, so every module agrees on which GM acts. The envelope routes and elects; it does not authorize. Blacksmith intends to own this surface, at which point this file should be a deletion rather than a rewrite.

- **Shelves** (`scripts/const.js`, `scripts/manager-merchant.js`, `scripts/window-merchant-config.js`): stock now lives in flagged container Items on the merchant rather than being every physical item on the Actor — so a shopkeeper's worn armour and belt dagger are no longer on the shelf. Five presets ship: Storefront, Back Room, Premium, Barter, Buyback. They are one schema with three properties — visibility, markup, mode — rather than five types, so a sixth idea has somewhere to go. Each visible shelf renders as its own section in the shop window. A hidden shelf is enforced as a **permission** on the GM handler, not merely omitted from the window. Shelves are created from the config window with `weightlessContents` and no capacity, making them unlimited and weightless, and enabling a merchant auto-creates a Storefront so the zero-config path shows the shape.

- **Shop titlebar actions** (`scripts/window-shop.js`): **Refresh** for everyone, plus **Character Sheet** and **Prototype Token** for the GM. The sheet actions exist because the shop claims left double-click on the token, which is how a GM would otherwise reach the Actor. In micro-titlebar mode the window base folds all three into the context menu.

- **Shelf visibility toggle in the shop window** (`scripts/window-shop.js`, `scripts/manager-merchant.js`): a GM flips a shelf between shown and hidden from its section header, and every open shop refreshes. The config window is for setting a shop up; this is for running one. Considered and rejected: using the container's `equipped` state for this. It is inert on containers so it would have worked, but it is transient state the ecosystem clears on transfer, it can change without anyone deciding to — a GM tidying inventory would silently hide a shelf — and it would split the shelf schema across a system field and a flag.

- **Trading hours** (`scripts/const.js`, `scripts/manager-merchant.js`, `scripts/window-merchant-config.js`): a two-ended slider sets when a shop opens and closes, and the world clock opens and closes it. The schedule proposes and the toggle disposes — a GM can override at any time and the override stands until the next opening or closing hour. The override is derived rather than stored: it is the state disagreeing with the schedule, so the next crossing clears it by doing the ordinary thing. Overnight schedules work, hours come from `game.time.calendar` rather than assuming a 24-hour day, and the watcher compares the schedule before and after a jump so advancing eight hours at once still lands correctly.
- **Open for business** (`scripts/manager-merchant.js`, `scripts/window-shop.js`): a GM opens or closes the shop from the merchant card. A closed shop still opens for a player — they can look through the window — but no acquire controls appear and a crafted request is refused with `SHOP_CLOSED`. The GM is exempt, so stocking and testing outside hours still work.
- **Stock grouped by category** (`scripts/const.js`): within each shelf, items sit under Weapons, Armor & Gear, Consumables, Tools, Containers and Goods. A storefront with forty rows is otherwise a wall of text.
- **Stocking a shelf from compendiums**: a **+** on each shelf header opens **Blacksmith's** Compendium Search through the window registry, and dragging a result onto a shelf puts it there. Merchant briefly had its own search window; it was deleted the same day in favour of Blacksmith's, which is better in every respect and whose result rows already drag with the `{ type, uuid }` payload the shelf drop targets read.
- **Shelves can be removed** (`scripts/manager-merchant.js`, `scripts/window-merchant-config.js`): a trash icon on each shelf row, going through dnd5e's own delete prompt so the system owns the "delete contents too?" question and the recursion. Adding or removing a shelf now refreshes every open shop for that merchant, across every token it has, since shelf changes are Actor-level rather than token-level.
- **Shelves are drop targets** (`scripts/window-shop.js`): a GM can drag an item from a compendium, the sidebar, or another sheet onto the shelf it belongs on.
- **Merchant Settings reachable from the shop titlebar**, so a GM never has to go via the Actor sheet to adjust a shop they are looking at.

### Changed
- **The Actor sheet header carries Merchant Settings only.** The Open Shop entry is gone — opening a shop is the token's job, and the sheet is for setting one up.

- **Prices** (`scripts/merchant-pricing.js`): each row shows what it costs, resolved from a per-item override, then the shelf or merchant markup applied to the item's own `system.price`. Denominations, labels and conversions all come from `CONFIG.DND5E.currencies` rather than a hardcoded table, and everything is counted internally in the smallest denomination so the arithmetic stays in integers. Markup is editable in the config window.
- **Cart and checkout** (`scripts/window-shop.js`, `scripts/manager-merchant.js`): add items to a cart and pay for the lot at once. Checkout is a single `exchange` — one payment and one lot of change — rather than a purchase per line, which would be more writes and would round each line's change separately. Every line is re-priced on the GM at checkout rather than trusting what the cart was built against, and stock removed while a cart sat open drops out of it quietly.
- **Rows read as columns**: item, quantity available, price, actions. Price is its own column rather than a note in the subtitle. Quantity shows ∞ while stock is infinite, so finite stock later fills the same column without moving anything.
- **One Buy control instead of three destinations**: Buy asks who the goods are for — the acting character, another party member, or the party — rather than encoding three places in three icons a player has to learn apart. **The shopper always pays**, wherever the goods land: buying for the party or for another character is a gift, and a gift comes out of the giver’s purse.
- **Paid delivery to anyone but the shopper is refused for now** (`THIRD_PARTY_DELIVERY`). The shopper paying while someone else receives is a **three-party** transaction — merchant, payer, recipient — and `exchange` is two-sided, so it cannot express it. Refused explicitly rather than silently charging the wrong purse, and the destination dialog says so before the choice is made rather than after. Raised with Blacksmith while `exchange` is still being designed.
- **Buying and selling** (`scripts/manager-merchant.js`, `scripts/window-shop.js`): a Buy control priced per row, and a Sell control that offers whatever the buyback shelf would take. Payment is an `exchange` so coin and change commit together. **Delivery is separate**, because `exchange` *moves* what it is given and a shop's stock is a count: handing it the merchant's item would sell the template itself and empty the shelf on the first purchase. Goods go first, so a payment that fails leaves the player holding the item and the shop out of pocket rather than the reverse. An `exchange` side that could say *copy* would collapse this back into one atomic call, and that has been raised. **`blacksmith.inventory.exchange` does not exist yet**, so both controls are **disabled and say why on hover** rather than being absent. This reverses the earlier rule. An absent button reads as “this shop does not do that”; a disabled one naming its reason reads as “not right now, and here is what would change it” — and the row does not reflow on the day the primitive lands.
- **Stock policy** (`scripts/const.js`, `scripts/manager-merchant.js`, `scripts/window-shop.js`, `scripts/window-merchant-config.js`): a shelf either never runs out, runs out, or runs out and refills. The setting is **per shelf** and falls back to the shop's, the same inheritance `markup` already uses — so a Storefront that restocks nightly and a Back Room holding three unique things are one merchant. Buyback is always finite: restocking it would conjure duplicates of somebody's old sword.
- **Stock is a count, not a document.** Every policy grants the buyer a *copy* and adjusts `system.quantity` on the merchant's own item; nothing is ever moved off a shelf by a sale. That is what lets a sold-out row stay put marked out of stock, which finite stock prefers and restocking stock requires — a deleted row is not a row anything can restock. The count lives in `system.quantity` rather than a flag of ours so the Actor sheet, the shop window and every other module read the same number.
- **Quantities are editable in the shop window** (`scripts/window-shop.js`): a GM types a number straight into the quantity column on any shelf that counts its stock, and that sets **both** what is there and what a restocking shelf refills to. A purchase lowers the count and leaves the target alone. No second par editor to keep in sync.
- **Restocking runs on the world clock** (`scripts/manager-merchant.js`): a restocking shelf refills every *n* in-world days, riding the same `updateWorldTime` watcher that already opens and closes shops rather than registering a second one. Elapsed time against an interval rather than counted boundaries, so advancing a week restocks once — a shop is full again, it does not accumulate seven days of stock. A GM can also refill a shelf on the spot from Merchant Settings. Winding the clock backwards resets the shelf's timer rather than stranding it in the future.
- **The concurrency loot needed is back** (`scripts/manager-merchant.js`): infinite stock had no races at all, because the merchant was never mutated. Finite stock means two players can read the same count, so every read-then-write goes through a per-merchant promise chain. Sound because exactly one client runs it: `activeGM` is core's own deterministic designation, so there is no second process to coordinate with.
- **Making change** (`scripts/merchant-pricing.js`): `api.inventory` never converts denominations, so Merchant works out which coins change hands. Payment spends smallest coins first and returns the overpayment as change — what a person does at a counter, rather than what an optimal coin-counter would do. Affordability is judged on the whole purse, checked in the window before the GM is asked and again on the GM before anything moves.

- **Logic checks** (`tests/`): two dependency-free Node scripts covering the parts that are pure arithmetic
  and pure control flow — making change across every combination of a small purse against seven prices, and
  the stock policy, restock cadence and lock behaviour. They cannot catch a wrong document path or a missing
  template field, which is most of what goes wrong in a Foundry module; they catch the half where reading the
  code is a bad way to find a bug and a wrong answer is silent.

- **Two workarounds deleted** (`scripts/window-shop.js`, `scripts/merchant-inventory.js`): the frame-polling
  control attach is gone, because `blacksmith.dialog.wait()` now takes `controls` and binds them after every
  render; and the post-grant container correction is gone, because `grantItem` takes a `container` and always
  writes `system.container` rather than inheriting the source's. Container membership is part of merge
  identity, so a merge can only land on a row already on that shelf — which was the case the workaround was
  carefully skipping.
- **`exchange` is a list of directed transfers, not two sides** (`scripts/manager-merchant.js`): the shape is
  decided — `{ transfers: [{ from, to, items, currency, container }, ...] }` — and Merchant is written
  against it. A shop transaction is not reliably two-party, and a list of what each party *gives* does not
  say where any of it goes once there are three of them; two-sidedness was silently carrying the routing.
  Selling is one transfer of goods and two of coin, payment and change never netted, because netting would
  let a payer hand over coin they do not have.

- **Search** (`scripts/window-shop.js`, `templates/window-shop.hbs`): a box in the pinned header filters the
  stock by name or kind, so "potion" finds a Potion of Healing and "consumable" finds the category. A shelf
  or a category with nothing matching collapses entirely rather than leaving a heading over nothing, and each
  shelf's count shows what is in front of you until the search is cleared.

  **Filtered in the DOM rather than in the context, deliberately.** Filtering in `getData` would mean an
  async render per keystroke, which rebuilds the markup and takes the caret out of the box being typed in.
  Instead the query lives on the window and `_onRender` re-applies it — so typing never re-renders, and a
  refresh, a GM stocking a shelf, or another player's purchase never drops a standing search. The filter is
  an exported pure function of markup and query, which is what lets `tests/test-search.mjs` run it against
  the real compiled templates.

- **A shop has a kind and a description** (`scripts/const.js`, `scripts/window-merchant-config.js`): twelve
  kinds — General Store, Weaponsmith, Apothecary, and so on — replacing the word "Merchant" above the name,
  which was telling the player something they could already see. Flavour only; nothing is restricted by it,
  and a weaponsmith with a shelf of potions is a perfectly good shop. The description is optional free text
  shown under the name, run through Foundry's enricher so journal links and inline rolls work. It is
  GM-written by construction and a failed enrich yields nothing rather than the raw string, so there is no
  path where unescaped input reaches a player's window.
- **Adding a shelf is a menu, not a row of buttons** (`scripts/window-merchant-config.js`): a **+** on the
  Shelves header opens Blacksmith's context menu with the five presets. Adding a shelf happens about once per
  shop, and a permanent row of five buttons was paying for that in window height every time the window was
  open for anything else. Falls back to a picker dialog where the menu API is unavailable.
- **Shelf artwork is Foundry's container icons** rather than the monochrome `icons/svg` set: a crate, a
  reinforced chest, a steel chest, a woven basket and a cloth sack. A shelf is a physical thing in the shop
  and reads better as one, and these ship with core.
- **The trading-hours handles are coloured** (`styles/default.css`): the opening handle green, the closing
  handle red, and the readout labels to match. The band between them says the same thing, but four pixels of
  dark green over a sunken track is nearly invisible on the light themes — so the colour that has to read is
  on the thing you grab. The band is thicker and lighter for the same reason.

- **A shelf's name is the container's name** (`scripts/const.js`, `scripts/manager-merchant.js`): the shelf
  flag used to carry its own `label`, so renaming the container in dnd5e's sheet renamed it everywhere in
  Foundry and nowhere in Merchant — the shop went on calling it Barter. Nothing stops a GM renaming a
  container, so the fix is to follow the rename rather than to fight it. There is now one name and the flag
  carries no copy of it. Old flags keep a vestigial `label` that is ignored.
- **A shelf nested inside another shelf is not stock** (`scripts/manager-merchant.js`): a container is
  ordinary stock — a backpack for sale is a backpack for sale — but a GM can drag one shelf into another on
  the Actor sheet, and a nested shelf would then appear twice, once as its own section and once as an item
  for sale on its parent. Excluded from the listing and refused by the GM handler, since hiding a control is
  only ever the honest path.
- **Edits made outside Merchant's windows now reach open shops** (`scripts/manager-merchant.js`): renaming a
  shelf, changing a quantity, dragging an item between containers, or deleting a shelf from the Actor sheet
  none of them routed through this module, so an open shop showed stale names and counts until somebody
  pressed Refresh. "I renamed it and nothing happened" is the kind of bug that gets reported as the rename
  not working.

- **The cart sits beside the stock** (`templates/window-shop.hbs`, `styles/default.css`): two columns under
  the header rather than a panel stacked into it, which is where a shopper looks for a cart. It is sticky, so
  it stays in view while the list scrolls, and it renders empty rather than hidden so adding the first item
  does not reflow the stock beside it.

  Laid out with `flex-wrap` rather than a media query, because this is a resizable window — how wide the
  *window* is, is the question, and a media query asks about the viewport. The cart grows a quarter as fast
  as the stock, so a wide window spends its room on the thing being browsed; narrow it past the two flex
  bases and the cart wraps onto its own row and fills the width. The sticky offset is the header's measured
  height rather than a constant: the header grows and shrinks with the shop description, the browsing notice
  and the override line, all of which can appear on a socket refresh with no re-render.

- **A buyback shelf resells at the shop's own rate** (`scripts/merchant-pricing.js`): its `markup` is what
  the shop *pays* the party, and it was being read as what the shop charges as well — so a sword bought at
  half price went back on sale at half price. No profit, and a permanent half-price second-hand rack you
  could sell into and buy straight back out of. Second-hand stock now carries the merchant's ordinary markup;
  the shelf's rate stays what it always meant, the fraction paid.
- **The cart reserves stock** (`scripts/window-shop.js`): a shelf shows what is still available to take, so
  two of five in your cart leaves three on the row. Quantity dialogs, Buy and the GM's free-take all respect
  it, which is what stops you being offered a quantity that would make your own checkout fail. A row whose
  whole stock is in your cart says so rather than saying "out of stock" — different sentences, and a player
  needs to tell them apart. The reservation is soft and local: another player's cart is neither visible nor
  blocked, and the GM re-checks every line at checkout, which is where a genuine race is settled.

- **`blacksmith.inventory.exchange` shipped, and buying is now one atomic call**
  (`scripts/manager-merchant.js`): goods out, coin in and change back settle together or not at all. Both
  primitives asked for arrived with it — `copy` for an infinite shelf, whose row is a template the sale must
  not touch, and `preserveEmptySource` for a finite one, which brings the count down and leaves the row at
  zero. The stock policy is now two flags on a transfer and nothing else.

  **This fixes a real defect rather than tidying one.** While delivery was a separate grant, a purchase whose
  payment failed left the player holding goods the merchant had not been paid for — reported from a table as
  *"That could not be completed. The goods were already handed over."* There is no order to get right any
  more, so that failure cannot happen.

  It also deletes the per-line stock checks in checkout and the merchant-side lock around every transaction:
  `exchange` takes its own locks over every Actor named and validates each leg against the state at the start
  of the call, so two players racing for the last item are settled inside it. Our lock now guards only
  restocking, which is genuinely our own read-modify-write.
- **A shop that cannot make change says so** (`scripts/manager-merchant.js`, `scripts/window-shop.js`): the
  side owing change has to hold the coins for it, and an empty till could not. That surfaced as a generic
  *"That could not be completed"* because `INSUFFICIENT_CURRENCY` had no message. Checked before anything is
  attempted now, and named: the merchant has not got the change, and it says how much they owe. Every code
  `exchange` can return is mapped, so nothing else falls through to the generic line.

- **Quantity prompts name the action you pressed** (`scripts/window-shop.js`): one dialog serves adding to a
  cart, buying, selling and the GM's give, and it said "Acquire" for all four. A player clicking a cart icon
  is adding to a cart, and the confirm button should agree with the button they pressed. The slider's ends
  read "Yours" and "Left on the shelf" rather than "Take" and "Leave", which was looting vocabulary in a
  shop.

- **The cart is the only way to buy** (`scripts/window-shop.js`, `scripts/manager-merchant.js`,
  `templates/partial-shop-row.hbs`): the Buy control that purchased a row outright is gone, and so is the
  GM-only take-without-paying. One action per row — **Add** — and one checkout.

  Buy-now was never fewer prompts than the cart: pick a quantity, pick a destination, confirm, either way. It
  was a second path through the same money for no gain, and a second place for the two to disagree — the
  cart reserves stock, so the paths had already begun to interact. The free take was the only thing that
  completed anything before `exchange` existed; that reason went with the primitive shipping, and a GM can
  drag an item from the merchant's sheet. Free goods will come back as part of a wider change rather than as
  a wand on every row.

  The GM handler is down to two operations, `checkout` and `sell`, and the single-item resolution path in
  front of them is gone with them.

- **Selling is a basket, and the basket is a drop target** (`scripts/window-shop.js`,
  `scripts/manager-merchant.js`): a **Selling** panel under the cart. Drag something off a character sheet
  onto it, or press *Or choose from your pack* for the same thing without dragging — both go through one
  place, so a dragged item and a chosen one are refused for the same reasons. One **Sell** settles the lot as
  a single exchange: one payment, one lot of change, however many lines. Selling a dungeon haul piecemeal was
  a payment and a lot of change per item, each rounding on its own.

  It mirrors the cart deliberately, down to the line layout. Buying became cart-only for the reason that a
  second path through the same money is a second place for the two to disagree; leaving selling as a one-shot
  would have left that inconsistency in the other half of the window.

  The Sell button on the buyer card is gone — the basket carries its own. Drops resolve through `fromUuid`
  rather than parsing the sheet's payload, refuse anything belonging to a character you are not shopping as,
  refuse what the merchant would not take, and refuse a packed container **in front of** the quantity dialog
  rather than after it.

- **A shop starts with money** (`scripts/const.js`, `scripts/manager-merchant.js`,
  `scripts/window-merchant-config.js`): marking an Actor as a merchant seeds 250 gp when its purse is
  completely empty, and Merchant Settings gained a **Till** section showing what the shop holds and letting a
  GM set the gold. An empty till says so, because a merchant that cannot buy anything only reveals it when
  the party tries to sell — *"the merchant cannot cover that"* is a poor way to learn a till exists.

  Seeded only on an empty purse, so a shop a GM has deliberately cleaned out stays that way. The setter
  writes gold alone, so a shop holding silver does not lose it to a round number typed into a box.

  **`setTillGold` is the one place Merchant touches currency without `api.inventory`.** The primitives move
  deltas between purses and refuse negative amounts, so "this shop now holds 40 gp when it holds 250" is not
  expressible — and this is not a transaction, it is a GM editing an NPC's own purse the way dnd5e's sheet
  does. Nothing leaves or arrives anywhere. The seeding *is* a grant and goes through `grantCurrency`.
- **Two messages said "—" where they meant "nothing"** (`scripts/window-shop.js`): `formatBase` renders zero
  as an em dash, which is right in a price column and reads as a missing word in a sentence.

- **The sell picker is a list, and takes several at once** (`scripts/window-shop.js`): it was
  `dialog.choose`, which renders one button per choice — fine for three destinations, unusable for a full
  inventory, where it became a wall of a hundred wrapped labels with no images and no scroll. It is now
  Blacksmith's `entityList` in **multi** mode: rows with artwork, kind and offer, scrolling inside the
  dialog. Pick a haul in one pass. A stack asks how many; a single item does not, so selecting twenty
  ordinary things costs no prompts at all.
- **Prices are quoted in gold, silver and copper** (`scripts/merchant-pricing.js`): writing them across
  every denomination gave *"102 pp 5 gp"* for a healing potion and *"1 pp 2 gp 1 ep"* for a crossbow —
  exact, unreadable, and not how anybody at a table says it. Thousands are separated, because a price list
  is read at a glance. **Payment is unaffected**: `planPayment` still spends whatever a purse actually
  holds, platinum and electrum included. This governs how a number is written down, not which coins change
  hands, and the exhaustive payment sweep in `tests/` proves the two stayed independent.

- **Each pane scrolls, not the whole window** (`styles/default.css`, `scripts/window-shop.js`): the stock
  list and the cart now scroll independently, so a long shelf list no longer carries the cart off the bottom
  of the window and a full cart no longer lengthens the page. Narrow enough that the cart has wrapped
  underneath, the two scroll together again — two half-height scrollers stacked would be worse than one.

  The breakpoint is a **container query** on the window's own width, not a media query: this is a window the
  user can drag to any size, and the viewport says nothing useful about it. It is set to the two flex bases
  plus the gap, so the layout and the scrolling change at the same moment rather than a few pixels apart.

  This deleted the sticky machinery. The cart was `position: sticky` offset by the header's measured height,
  with a `ResizeObserver` republishing it whenever the description or the browsing notice changed the header.
  A header that is simply the first item of a column whose second item scrolls is what all of that was
  imitating.
- **Checkout and Sell sit below their total** rather than beside it, so the button reads as the conclusion of
  the sum instead of its neighbour.

- **One press settles the visit** (`scripts/manager-merchant.js`, `scripts/window-shop.js`): buying and
  selling are a single transaction, and the button that does it sits in the footer, right-justified, the way
  the rest of the suite does one main action.

  A counter transaction *is* one transaction. Trading a sword towards a suit of armour is a swap and a
  difference, not a sale followed by a purchase — and as two it costs two lots of change, has an order that
  matters, and cannot fund the purchase with the sale. `exchange` was built for exactly this and we were
  making two round trips through it.

  Three things follow. **"I can afford this if I sell that" works.** A visit that buys more than it sells
  needs **no coin in the till at all**, because the shop receives. And there is one ordering, one atomicity
  story and one refusal path instead of two of each.

  Netting the price is not netting payment against change: the difference is worked out before anything
  moves and whoever owes it must hold it, which is the counter model the primitive already enforces.

  The label follows the state — **Checkout**, **Sell** or **Trade** — and carries the running net. A cart
  outlives the moment it was filled, so somebody returning to sell one thing has to see "Trade" *before*
  pressing rather than discovering it in the confirm. Both panels are pure lists now, since an action
  settling both belongs to neither.

  The GM handler is down to one operation. It was four this morning.

- **One cart, two segments, total pinned to the top** (`templates/window-shop.hbs`,
  `styles/default.css`): the cart and the sell basket are one panel with **Buying** and **Selling** segments
  and one running net, pinned at the top so it is on screen however long the list gets. A total you have to
  scroll to find is a total you stop trusting, and a cart list is exactly what gets long enough to hide one.
  The net reads "You pay", "You receive" or "Even trade" and is coloured accordingly, because a bare number
  makes the shopper work out which direction it runs.

  Segments rather than buckets follows from settlement being one press: two panels with two totals described
  a transaction that no longer exists. **It also makes the whole panel the drop target.** An item a character
  is carrying can only be sold, so the cart already knows which way a drop goes — aiming at the right half
  was asking the user to state something the panel could work out.
- **The search is pinned to the stock list** (`styles/default.css`): it filters that list, so it travels with
  that column and sticks to the top of it rather than sitting in the window header several rows away from
  what it acts on.

- **Scrollbars start below the fixed heads** (`templates/window-shop.hbs`, `styles/default.css`): the search
  box and the cart total were sticky *inside* their scrollers, so each scrollbar ran the full height of the
  pane and up behind a box that never moves. They are fixed heads now with the scrolling region as a sibling
  beneath, which is what the sticky was standing in for. `scrollbar-gutter: stable` holds the space, so a row's
  right edge never sits under the bar and the layout does not shift the moment a list grows long enough to
  need one.

- **The cart head shows its working** (`templates/window-shop.hbs`): the total on the title line, and the
  two figures it is made of right-aligned beneath it — Buying, Selling — so the eye reads down a column of
  numbers rather than across three labels. The subtotals that used to sit on the segment headings are gone;
  they were the same numbers said twice.
- **The action button is always there** (`scripts/window-shop.js`): it used to vanish when the cart was
  empty, which makes the empty state a puzzle. It stays, and pressing it says there is nothing in the cart
  yet. **Clear** sits beside it, next to the action it undoes, and the amount has come off the button — it is
  already stated three ways at the top of the cart.
- **"Done" is now "Cancel"**: nothing has happened until the cart is settled, so leaving is abandoning rather
  than finishing.

- **Adding to the cart no longer throws you back to the top of the shelf** (`scripts/window-shop.js`): a
  re-render replaces the markup and takes the scroll position with it, so a player at the bottom of a long
  shelf lost their place on every single Add. Both scrolling regions now remember where they were. Recorded
  on scroll rather than captured before each render, because a render comes from anywhere — a socket refresh,
  a GM restocking, another player buying — and there is no one place to hook a "before" on.
- **Two panels instead of boxes inside boxes** (`styles/default.css`): the window had four levels of frame —
  a panel around the column, a bordered card per shelf, a card per row, and the same again on the cart side.
  Each was legible on its own; together they read as packaging rather than content. One box per column now,
  with headings and rules doing the separating and a row being a tint rather than a card. The cart lines were
  inset by the panel's padding *and* carried their own card, which read as a gutter down both sides; one
  inset now.
- **The row button is an icon**: the word "Add" beside a cart-plus glyph was saying the same thing twice.

- **Shelf headings do the grouping** (`styles/default.css`): flattening the cards took the group boundaries
  with them, and seven items on the Storefront ran straight into one in the Back Room. The heading is a
  filled band now rather than a line of text, and **sticky inside the list**, so the shelf you are looking at
  names itself while you scroll through it. That is a stronger boundary than the frame was, and it answers a
  question the frame never did: which shelf is this, forty rows down. Hidden shelves tint the band rather
  than relying on the pill alone, now that the dashed border is gone.

### Notes
- **Every stock policy delivers with `grantItem`, never `transferItem`.** The merchant's item is a template carrying a count, so a sale copies it and adjusts a number. That kept infinite stock free of races entirely, and it is what lets finite stock keep a sold-out row on the shelf. What finite stock does reintroduce is the read-then-write race, which the per-merchant lock answers.
- `"socket": true` from the first commit. Foundry reads manifests at world launch, so adding it later costs a world restart and silently drops every emit until then.
