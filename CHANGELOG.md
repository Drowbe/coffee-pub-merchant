# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [13.0.0]

### Added
- Module scaffold: manifest, constants, entry point, documentation structure.
- **Merchant marking** (`scripts/window-merchant-config.js`, `scripts/merchant.js`): a **Merchant Settings** entry on every Actor sheet header opens a configuration window with an "Is a merchant" toggle. It is always present because the way in has to be reachable on an Actor that is not a merchant yet; an **Open Shop** entry appears alongside it only once the Actor actually is one. Merchant state lives on the **Actor**, not the Token — a shop is a persistent entity, so flagging the token would make every placed instance a separate shop and lose the configuration when the token was deleted.
- **Shop window** (`scripts/window-shop.js`, `templates/window-shop.hbs`, `templates/partial-shop-row.hbs`): double-click a merchant token to browse its stock. Acquire an item to your own character, send it to another party member, or send it to the party inventory. Buying-as supports a player with more than one character and remembers the choice.
- **Token interaction claim** (`scripts/manager-merchant.js`): registered through Blacksmith's `api.tokens.registerInteraction` with `gesture: 'clickLeft2'`. Players have no LIMITED permission on a shopkeeper's Actor and Foundry's permission predicate runs before the handler, so the claim relaxes it for matching tokens only.
- **GM-authoritative request path** (`scripts/gm-request.js`): built on Foundry v13's query API — `CONFIG.queries` plus `game.users.activeGM.query()` — rather than a hand-rolled socket envelope. Request ids, the pending map, the timeout and response routing are all core's, and `game.users.activeGM` is core's own single-GM designation, so every module agrees on which GM acts. The envelope routes and elects; it does not authorize. Blacksmith intends to own this surface, at which point this file should be a deletion rather than a rewrite.

- **Shelves** (`scripts/const.js`, `scripts/manager-merchant.js`, `scripts/window-merchant-config.js`): stock now lives in flagged container Items on the merchant rather than being every physical item on the Actor — so a shopkeeper's worn armour and belt dagger are no longer on the shelf. Five presets ship: Storefront, Back Room, Premium, Barter, Buyback. They are one schema with three properties — visibility, markup, mode — rather than five types, so a sixth idea has somewhere to go. Each visible shelf renders as its own section in the shop window. A hidden shelf is enforced as a **permission** on the GM handler, not merely omitted from the window. Shelves are created from the config window with `weightlessContents` and no capacity, making them unlimited and weightless, and enabling a merchant auto-creates a Storefront so the zero-config path shows the shape.

- **The pack is a shelf.** It rendered as its own kind of panel with its own layout, its own scroll container and its own search rules, and looked visibly worse than the shelves beside it for no reason anybody could have named. It now renders as a `.merchant-shop-shelf` inside the same container the shelves use, so the card, the spacing, the scrolling and the row layout are all already answered. Three near-copies of those rules are deleted, along with the extra scroll region the window was remembering. One list shows at a time, so one container holds it.

- **Fixed: the Buy/Sell row collapsed to a sliver.** The stock column is a flex column whose list takes the remaining height, so anything else in it has to declare `flex: 0 0 auto` or get squeezed to nothing. The search says so; the toggle did not, and rendered three pixels tall. Two goes at the *font* metrics, and the real cause was the row never claiming its own height.

- **The pack's search moved into the same slot as the shop's**, above the list rather than inside the panel. Still two boxes, because they filter two different piles and one doing both would mean typing "rope" to find yours and hiding half the shop as a side effect — but one *position*, because there is only one place a search belongs, and having it move depending on which side you were on was the sort of thing you notice without being able to say why.

- **Fixed: `+` on a sell row still did nothing.** The handler was never registered. The edit that would have added it sat in a shell chain whose earlier step failed, so it silently never ran — leaving a method that existed, a template that pointed at it, and a handler map that had never heard of it. A `data-action` with no handler is the quietest failure in this codebase: the delegated listener finds the element, looks the name up, gets `undefined`, and returns. Nothing throws, nothing logs, and `node --check` is perfectly happy.

  `tests/test-actions.mjs` now asserts that every `data-action` in every template has a handler, following Handlebars expressions like `{{addAction}}` through to the strings the context assigns them. It is dependency-free — a handler map is a literal and a template is a string. Verified by removing the handler and confirming the test fails naming it.

- **Who is shopping moved into the shop's own card**, as a row under the description with a rule above it rather than a bordered box of its own. It is a fact about this visit rather than a section in its own right, and the window is short of vertical space that the stock and the slate both want more than a second border does.

- **Buy and Sell are a pair of buttons above the search**, not a Sell button inside the slate. The old one put a control that changes what the *stock* column shows into the panel that shows the result, and left no way back except pressing it again and knowing it had toggled. Two buttons with one lit says where you are as well as what you can do. Switching hides rather than unrenders, so the search keeps its text and the shelves keep their scroll position.

- **Fixed: `+` on a sell row did nothing, silently.** The panel called `addToBasket` with `silent: true` — a flag that existed for the modal picker, which added several things and rendered once at the end. The basket updated and nothing redrew. The flag is gone with the picker it belonged to rather than being set correctly at the one remaining call site.

- **Selling moved out of a modal and into the shop window.** The SELL button now opens your pack as a panel in the stock column, using the same row layout as a shelf: picture, name, price, `+`. A thing you are selling and a thing you are buying are both those four things, and giving them two layouts was inventing a difference that is not there — the row partial is shared, with `addAction` the only thing that changes. It brings its own **search** and a **sort** that cycles most-valuable-first, by name, and by kind-then-name, the last of which groups under headings. The modal could do none of that, added one item per opening, and covered the slate you were filling. 107 lines of dialog deleted rather than left beside it.

- **The shop shows who else is in it, and you can click them.** The "Buying as" bar now carries a row of faces — everyone with something on a slate in this shop — in the same shape Curator puts looters in, because a shop with three people in it and a body being picked over by three people are the same situation wearing different clothes. Clicking a face switches to that slate, which is what makes the shared slates reachable rather than merely present: a GM sees who is mid-purchase and goes straight to them, instead of cycling the character picker looking for one. The faces come from the slates themselves rather than from a separate presence protocol — a slate with something on it *is* somebody shopping, and it is the thing the click has to land on. Curator tracks presence separately only because looting has no slate to stand in for it.

- **The purse left the "Buying as" bar.** It is on the slate as FUNDS, directly above the total that acts on it, which is where somebody checking whether they can afford something is already looking. Two places showing the same number is one too many.

- **A slate belongs to the character, and everyone who can act as that character sees it** (`scripts/window-shop.js`, `scripts/manager-merchant.js`). It was per-client and per-token, so a GM had no way to see what a player had on their slate — which made the whole negotiate workflow unusable, because prices are agreed *on slate lines* and the GM could only ever see their own. Switching "Buying as" now switches slate, and switching to a player's character shows the slate that player is looking at, live, with every line and price editable.

  The slate carries the shopper's **portrait and name** in its title. Clicking a face on the bar swaps the whole panel underneath you, and a slate belongs to a character rather than to whoever is looking at it — so the panel says whose it now is rather than leaving you to remember.

  A face means **anyone shopping**, not anyone with something on the slate — someone who has the shop open and has taken nothing is still a person standing in the shop, and the row would be empty for most of a visit if browsing did not count. The mark on a face says whether that character has lines on the slate; the face itself says they are here.

  The faces on that bar come from a **presence** broadcast, not from the slates. Drawing them from slates read well and was wrong for the person it mattered most to: slates are mirrored only to clients that can act as that character, so a player saw an empty room however busy the shop was. Presence is about the *room*, so it goes to everyone; only what you can *do* with a face is gated. Everybody sees who is here, a face carries a mark when that character has something on the slate, and a face you could act as — in practice the GM's view of a player — is a button that takes the slate over. Anyone else's is a portrait, and does not invite a click it would not honour.

  Mirrored peer to peer rather than brokered by the GM, and **display only** — settling re-derives every line and every price on the GM regardless, so the worst a bad message can do is show somebody a wrong list. This is Curator's loot presence in a different coat, including the `ping` on open so a window arriving late sees the room rather than an empty one; the shapes are close enough that a shared mechanism is worth measuring once both have settled.

  Still not persisted. A slate is a half-formed intention, and a session-scoped mirror expires by itself rather than needing a rule about when somebody's abandoned cart goes stale. Permissions need no special handling either: the only characters you can switch to are the ones you can act as, so a player sees their own slates and a GM sees everyone's, for free.

  The character picker badges anyone with lines on the slate, because a GM has to know somebody is mid-purchase before it occurs to them to look — a shared slate nobody can find is not shared.

- **Fixed: picking things to sell did nothing.** `dialog.wait` hands a button callback **the dialog's form**, and runs it *after* the dialog has closed — not `(event, button, dialog)`, which is DialogV2's own shape that `wait` wraps rather than passes through. Reaching for `dialog.element` got `undefined`, so the selection read came back empty and the whole gesture silently did nothing. Both pickers in this module were affected. The signature is stated plainly in `api-dialog.md`; it was inferred from Blacksmith's internal wiring instead of read, which is the exact failure `CONTRIBUTING.md` §3 exists to prevent.

- **Money moves as one exact payment, and "cannot make change" is gone** (`scripts/merchant-pricing.js`, `scripts/manager-merchant.js`): a settlement used to be a payment plus change handed back, which meant the *other* side had to be holding particular coins — and nothing guarantees a shop sitting on twenty thousand gold has six silver in the drawer. That refusal was the most common way an ordinary purchase failed, unfixable from the player's side and baffling from the GM's.

  The payer now re-cuts their own purse first when it has to be re-cut, so the exact coins exist to hand over and there is no change leg at all. Breaking a gold piece into ten silver is what a person does at a counter without thinking about it, and it is **value-neutral** — the same money in different coins — which is why it can sit outside the atomic part without reintroducing a half-completed trade: a failure at any point leaves the payer exactly as rich as they were. It goes through `setCurrency`, so it takes the inventory lock rather than racing the settlement it is preparing for.

  Platinum is left where its owner put it unless the working coin genuinely cannot cover the price, because it is a store of value somebody chose to hold rather than small change. Electrum is never handed to anybody who did not already have it. A refusal now means only what it should: not enough money. Covered by 249 exhaustive settlements asserting that every payment is exact, that re-cutting never changes a total, and that nothing is ever paid in coins the purse does not hold.

- **Fixed: toasts were nearly unreadable.** The palette was taken from the windows — the same green as the Open sign, the same red as Always closed — and `styles/toast.css` paints `rgba(20, 20, 20, 0.9)` behind a toast. Colours chosen to sit on parchment have nowhere near the contrast to sit on that, and one `color` drives border, icon and title together, so the whole toast suffered rather than just its trim. Same four hues, lifted for a dark surface and pitched to sit beside the body text the stylesheet already uses.

- **Fixed: "the till cannot cover it" was said of a till holding 20,000 gold, and sometimes to the wrong party.** The refusal fires in both directions — the merchant owing change, and the shopper owing it back when the merchant overpays — and said the same thing either way. It now names the side that is actually short and *which coins*, because a till with twenty thousand gold and no silver is not short of money, it is short of change, and those have different fixes.

- **The till is written under the inventory lock** (`scripts/manager-merchant.js`): `setTillGold` goes through `inventory.setCurrency` rather than a raw `actor.update()`. The raw write took no lock, so since `exchange` shipped a GM adjusting a till mid-session could have their edit silently discarded — the settlement reads the balance under the lock, the unlocked write lands, and the settlement writes `stale + delta` over the top. The boundary that decides this is not whether an operation has a counterparty but **whether the Actor takes part in locked operations**, and a shop does. Only `gp` is named, so the rest of the purse is left alone rather than zeroed.

- **`par` no longer rides out on sold goods** (`scripts/manager-merchant.js`): the settlement passes `omitFlags`, so a shelf's restock target is stripped from an item before it reaches a buyer. The same path goes in `ignoreFlags` too, and will stay there for a while: anything bought *before* this landed carries `par` on the buyer's row, so an arrival without it would compare as different and create a second stack rather than merging — a silent, self-inflicted duplicate-row bug with a long tail. The buyback guard in `getStock` stays regardless, because it covers items already sitting in worlds.

- **Everything the module says now goes through Blacksmith's toast API** (`scripts/merchant-feedback.js`): 51 call sites converted from `ui.notifications`, which is a core-styled text queue — not themeable, no image slot, and nothing to be done with one except read it before it goes. A completed transaction is now a **receipt**: what was paid as the headline, who and where underneath, persistent until clicked, because money changing hands is the one moment somebody wants to check twice and an eight-second toast is one they read half of. A second purchase replaces the first rather than stacking. Two things deliberately stay on core notifications: the fallback for a Blacksmith too old to have the API — a world one version behind should lose the styling, not the message — and the restock progress bar, because a toast has no progress shape and core's does.

- **Six sound settings** (`scripts/settings.js`): adding to the slate, changing a quantity or price, taking a line off, completing a transaction, finishing a restock, and anything that errors. Choices come from Blacksmith's `arrSoundChoices`, so Merchant offers the same library as the rest of the suite and ships no audio of its own; the list rebinds on `blacksmithUpdated` for worlds that load it late. **World-scoped but played locally** — a shop's voice is set dressing and belongs to whoever built the scene, while broadcasting would mean the whole table hearing somebody else drop a rope into their own slate. All default to silent. `notify.error()` plays its sound itself rather than trusting twenty-odd call sites to remember, and the transaction sound rides on the receipt toast so the two cannot come apart.

- **Fixed: the character picker could return a character you did not pick.** `entityList.getSelectedIds()` shares `getSelection()`'s fallback — when `attach` did not find its input it hands back *the selection the caller passed in*. In the "Buying as" dialog the caller passes the current character, so a player switching to somebody else would have been handed back the one they were already on, silently and with no way to tell. The sell picker had the milder version: an empty initial selection meant picking six things and having nothing happen. Both now read the checked inputs out of the dialog, which is correct either way because only *binding* can fail. Interim: Blacksmith is shipping `entityList.readIdsFrom(root)`, which is this with the input name it already knows.

- **Fixed: a buyback shelf could manufacture stock it never had.** `registerTransientFlag` hides a flag from *merge comparison* but does not strip it from the payload, so `coffee-pub-merchant.par` travels out with every item bought from a counted shelf and travels back if the buyer sells it. A bedroll bought from a shelf kept at six arrived on the buyback shelf still claiming a par of six, and the next **Restock Everything** refilled that row to six — five bedrolls out of nothing, from a target the shop never set. A buyback shelf now ignores a stored par outright, which is correct on its own terms: its stock is whatever the party sold it, and there is nothing it is *kept at*. Blacksmith's forthcoming `omitFlags` will stop the flag arriving at all; this guard stays after it, because it covers every item already sitting in a world with the flag on it.

- **Reverted the INSUFFICIENT_QUANTITY workaround** (`scripts/manager-merchant.js`): Blacksmith took the fix within a day — `_resolveQuantity` now takes a `drawsDown` flag, false from the grant path and the `copy` leg, true from the three transfer paths — so a rolled row is one entry carrying its quantity again rather than N entries of one. What stays behind is the diagnosis: a refusal carrying `INSUFFICIENT_QUANTITY` can now only mean an out-of-date Blacksmith, and says so in the console and to the GM. Without that, the symptom is every row arriving at one or not at all, which looks exactly like a Merchant bug and cost a full debugging round the first time.

- **Fixed: rolled stock was refused as INSUFFICIENT_QUANTITY.** Asking `grantItems` for five crowbars from a compendium failed, because the grant paths run the same quantity validation a *transfer* runs — the source document's own `system.quantity` becomes a ceiling, and for a compendium template that is 1. A grant draws nothing down and has no source to be insufficient, so this is a defect rather than a rule; it is raised with Blacksmith. Until it lands, a depth of five is sent as five entries of one: duplicate entries in a batch are documented to coalesce into a single row holding the summed quantity, and both the merge and create paths do sum. Still one call, still two writes, and `itemUuid` is kept rather than switching to `itemData`, which would lose the compendium provenance. Stackability is also now read off the document — no `system.quantity`, no stack to deepen — which is the same rule the inventory API states for itself.

- **A negotiate shelf never shows a figure** (`scripts/window-shop.js`, `templates/partial-shop-row.hbs`): not even after a price has been agreed. The agreement is between the GM and whoever is standing at the counter; putting it in the price column publishes it to the next player who opens the shop, and turns a shelf that exists in order *not* to have prices into one that quietly accumulates them. The shelf is checked before any figure, so an agreed price can never leak into the column. In its place the GM — and only the GM — gets a tooltip carrying what they actually need: the agreed price if one has been named, otherwise what the thing is worth on the books as an anchor to haggle against. The context decides that, so a player inspecting the markup finds nothing to read either.

- **Item pictures are hot** (`scripts/window-shop.js`): the system's item card now hangs on the image as well as the name, on shelf rows and slate lines alike. The picture is the other half of what a person points at when they mean "that one", and reaching past a 32-pixel icon to a truncated name was a worse gesture than either. For a **GM**, clicking the picture opens the item — the way to fix a price, edit a description, or see what a rolled result actually is, without leaving the shop to find the shelf it is sitting in. GM-only and enforced by not binding it rather than by refusing inside the handler, so the cursor changes only where the click works: the affordance and the permission are the same fact.

- **Clear Shelf** (`scripts/manager-merchant.js`, both windows): takes everything off a shelf and leaves the shelf, with everything it is set to. It sits between the two controls that already existed and were both the wrong tool: setting a count to zero says *sold out*, deleting the container says *this shop has no such shelf*, and re-rolling a shop's stock needed neither. One `deleteEmbeddedDocuments` for the lot. Confirmed, unlike removing a single row — one item is easy to put back, nineteen and a table roll are not.

- **Restocking says what it is doing** (`scripts/merchant-progress.js`): a shop with two shelves and four tables at ten rolls each is forty `table.roll()` calls and forty compendium lookups before a single item lands, and nothing on screen admitted to it. That is seconds of apparent nothing, which reads as nothing having happened, which is how a GM comes to press Restock Everything twice. Now a progress bar names the shelf and the table it is on. It is **core's** progress notification (`ui.notifications.info(msg, { progress: true })`), not one of ours — Blacksmith has no progress primitive and inventing one would be a second thing doing a job core already does. The bar is sized from the same arithmetic the work spends, so it ends exactly where the work does.

- **Fixed: rolled stock ignored the price bands entirely.** The depth rule had a whitelist of stackable *types* in front of it — consumables and loot stack, gear does not — which excluded daggers, vials, clothes, chests and tools, which is to say a general store's entire shelf. Every row still arrived at QTY 1 and the feature was invisible. Price was always what the intuition meant: a 1 gp vial lands deep, a 1500 gp suit of plate lands alone. Nobody has eight suits of plate because plate is expensive, not because it is armour. The type gate is gone rather than kept as a modifier.

- **Fixed: stocking failures were reported as a shrug.** `grantItems` returns results index-aligned with what was sent and entries fail independently, so the top-level flag alone said only "something went wrong somewhere" — the console read `{ ok: false, results: Array(20) }`, which names neither the row nor the reason. Failures are now listed individually with the item name and the reason, and the count a restock reports no longer includes rows that never arrived.

- **Fixed: deleting stock faster than the window re-renders.** The row is still on screen because the render that would have removed it has not landed, so a second click sent the same id and Foundry answered `Item "..." does not exist!` — a server round trip reported as an error for something the GM did correctly. The id is claimed before the first await and released in `finally`, the document is re-read after the await rather than trusted from before it, and losing the race to somebody else is no longer worth a red line.

- **Table-rolled stock arrives in believable amounts** (`scripts/merchant-pricing.js`, `scripts/const.js`, `scripts/manager-merchant.js`): a roll used to deliver exactly one of whatever it drew, so twenty rolls produced twenty rows of QTY 1 and there was no setting anywhere that changed it — "each" was a ceiling that only ever refused, and par fell back to "as many as are there", which was one. Depth is now decided in three steps: **what the item says it is** (a compendium entry authored as a quiver of twenty arrives as twenty — we were throwing away the only statement anybody had actually made), then **what it costs** for anything a shop keeps a pile of (cheap things come in piles, dear things come singly; the band sets a ceiling and the depth is rolled inside it, so stocking the same shelf twice does not produce the same shop twice), then **one** for everything else, because nobody has eight suits of plate. Ammunition is the exception among weapons and stacks. The shelf's own "each" limit clamps the result, so a number a GM set by hand is never argued with by a die.

- **Negotiated prices** (`scripts/merchant-pricing.js`, `scripts/manager-merchant.js`, `scripts/window-shop.js`): a GM double-clicks the price on any slate line and names it, for buying and for selling both. The Barter shelf is now **Negotiate** (label only — the stored mode is still `barter`, so existing shelves keep working) and its rows add to the slate like any other, at **TBD**, rather than showing an "Ask" label that named the thing to do and then left you to do it elsewhere. Settling refuses while any line is still TBD. The agreed figure is written to the **merchant document**, never carried in the settle request: a price is the one number in a transaction a player must not be able to name, and a slate is client state. An item that arrives with no price of its own is stamped with what was agreed, so a curio negotiated at 200gp can be sold on for 200gp; an item that already had a price keeps it, because a haggled discount is not what a thing is worth. Agreements are cleared once the trade they were made for settles.

- **A shop can be shut for good** (`scripts/const.js`, `scripts/window-merchant-config.js`): dragging the two trading-hours handles onto each other used to read as *always open*, which meant the slider had two gestures for open and none for closed. It now reads as **Always closed**, the mirror of the band drawn across the whole day, and both labels repaint mid-drag rather than on release. The label lost its border: it is a statement about the slider, not a button to press, and the box made it look like one.

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

- **The cart runs the full height of the window** (`templates/window-shop.hbs`, `styles/default.css`): the
  merchant card, the buyer card and the search were in a full-width band *above* the two columns, so the cart
  started level with the item list and wasted the height beside the header. They are the top of the left
  column now, and the cart sits beside all of it. The only thing spanning both columns is the action bar in
  the footer, which is the one thing that acts on both.

- **Shelves are containers again, and the column is not** (`styles/default.css`): flattening put the frame on
  the column and took it off the shelves, which is backwards — a shelf is the thing that wants a boundary.
  One level of frame either way, and now it is on the right level. The heading is the card's own top edge, so
  it keeps the sticky behaviour that made a long list navigable while the card does the grouping.
- **Three fixes to go with it**: the content had lost its top padding when the pinned band was retired and
  nothing replaced it; the cart's full-bleed head was squaring off the panel's top corners because its
  background did not follow the radius; and rows had no room between them and the frame, or between them and
  the scrollbar the gutter reserves but does not pad away from.

- **The cart is a slate** (`scripts/window-shop.js`, `templates/window-shop.hbs`): a slate is a running
  reckoning you settle and then wipe, which is exactly what this is — and "put it on the slate" is the phrase
  a shopkeeper would actually use. **Clear** is **Wipe**. Considered and rejected: *ledger*, which is a
  record of transactions already made rather than a list of ones being considered, and *tally*, which fits
  but reads colder. Internally the fields stay `cart` and `basket`; renaming code to match a label is churn
  with no reader.
- **The row button is a plain plus** rather than a cart-plus, since there is no cart to add to any more.
- **The merchant card puts identity across the top and prose beneath** (`templates/window-shop.hbs`): the
  description used to share the portrait's column, so a sentence wrapped in a narrow gutter beside a face. It
  spans the card now, where a paragraph can be one.

- **The slate's totals are label-and-value chips** (`templates/window-shop.hbs`, `styles/default.css`): they
  were three right-aligned label-and-value pairs, so every label began at a different x and the block read as
  three unrelated notes rather than a sum. The label column now sizes to the longest label and every chip
  inherits that width, so labels align down one edge and figures start at the same x.

  Three identical rows; nothing distinguishes the total except sitting first and being called **Total**. An
  earlier pass gave it a larger size, a coloured chip, a rule beneath it and uppercase bold labels, which
  turned a plain pattern into a decorated one. A total you are owed is written `+20 gp` — the sign carries
  the direction, which survives every theme and does not depend on seeing a colour.

  The fills are the theme's own text colour mixed into **transparency** rather than into a surface, so the
  pair composites over whatever is behind it: opaque light, opaque dark, or glass.
- **Buying and Selling are headed like shelves are**: they do the same job — telling you which list you are
  looking at — and were set several sizes smaller than the headings they sit opposite.
- **Sell is reachable from the slate header**: the picker was only offered in the empty state, so putting one
  thing on the slate hid the only way to add a second without dragging.

- **Zero is written as money**: `formatBase(0)` was an em dash, so a slate with nothing on it read "—"
  rather than "0 gp". Zero is an amount of money, not an absence of one. The unit is the one with a
  conversion of 1 — gold, in dnd5e — because that is what a shop quotes in.
- **The empty slate no longer repeats the Sell button**: it is in the slate header now, reachable whether the
  slate is empty or not, so the empty state offering a second one was two buttons for one thing.

- **Quantity is edited in place, the way the loot window does it** (`scripts/window-shop.js`,
  `templates/`): double-click a number, Enter or click away to commit, Escape to abandon, and **0 removes a
  slate line**. Three cells share one editor — a shop's stock, a line being bought, a line being sold — and
  they differ only in where the committed number is written.

  **The quantity dialog is gone entirely.** Adding is one click that adds one, and the amount is changed on
  the slate afterwards. That is fewer prompts in both directions: adding one thing — which is most of the
  time — no longer opens a modal to confirm the obvious, and adding six is a click and an edit rather than a
  dialog every time. It also removes the always-visible number input the GM's stock cell used to be, which
  put a form field in every row of the shop.

- **A slate line is one line** (`templates/partial-slate-line.hbs`): icon, name, quantity with its delete
  beside it, price. It was two rows, which left a void under the icon and made each entry read as two things.
  A different layout from a shelf row is right — they are different lists — but it has to be a *simpler* one,
  and two rows in a narrow column was not. The name takes what is left and ellipsises, with the full text on
  hover, because "Cordial of Holiday Insight" will not fit in that column whatever else is done.

  The markup was duplicated for buying and selling, so it is a partial now. Which side a line is on and what
  removes it ride on the line itself, the same way the shop row's flags do.

- **A shop has its own name** (`scripts/window-merchant-config.js`, `templates/`): the config carried a
  `name` field from the scaffold and the shop window already read it, but nothing ever set it — so every shop
  was called after whoever stood behind the counter. Bob can now run *Potions and Stuff*. Left blank, the
  shop is still named after the Actor, and the field's placeholder says so.

  The shopkeeper's own name appears on the meta line **only when the two differ**: "Bob" written over a shop
  called Bob is a line of nothing.

- **The party is somebody you shop as** (`scripts/manager-merchant.js`, `scripts/window-shop.js`): the party
  Group Actor is in the **Buying as** list, and the destination question is gone entirely. Whoever you are
  shopping as pays and receives.

  That dissolves the three-party problem rather than working around it. Buying for the party used to be a
  destination picked at checkout, which made the shopper's coin pay for the party's goods — merchant, payer,
  recipient, which `exchange` cannot express and which was refused as `THIRD_PARTY_DELIVERY`. Being the party
  makes payer and recipient the same Actor again, which is what "buying it for the party" always meant. The
  refusal, the payer/recipient split, and the picker that offered the impossible choice are all gone.
- **Open or closed is a fact, not a column** (`templates/window-shop.hbs`): the toggle reserved a fixed
  column down the side of the merchant card, which squeezed the copy beside it onto four lines. It is a chip
  on the facts row now — a switch for a GM, the sign in the window for everyone else — and the card reads in
  three.

- **Complete Transaction completes the transaction** (`scripts/window-shop.js`): the confirmation dialog is
  gone. The slate *is* the confirmation — every line, both subtotals and the difference are on screen when the
  button is pressed, so a dialog restating them asked somebody to agree to what they were already looking at.
  The affordability check still runs first, because that is a refusal rather than a question.
- **The merchant card's first line has two ends** (`templates/window-shop.hbs`): shop name at one, open or
  closed at the other, with the keeper and the facts running the full width beneath both. The chip had been
  moved into the facts row to stop it reserving a column, which fixed the squeeze but buried a piece of state
  worth seeing first.

- **Trading hours: a crossing is remembered, not measured** (`scripts/manager-merchant.js`): the watcher
  compared the hour before a jump with the hour after it, derived from the `updateWorldTime` hook's delta.
  That works when time is *advanced* and fails silently when it is *set* — a clock writing an absolute world
  time can report no delta, so before and after came out identical, no crossing was ever detected, and a shop
  left open past its closing hour stayed open with an override notice on it. Reported from the table as *"the
  store never closes, it just gives me the red message."*

  The schedule's own answer is now compared against the answer recorded the last time the shop acted on it
  (`scheduleState`). A difference **is** a boundary having been passed — however the clock got there, in
  whichever direction, across any span, with no delta to be wrong about. A GM override still stands between
  boundaries, because toggling by hand does not move that record.

  Restocking also came off the same `try` as the schedule: a restock that threw used to take the opening
  hours down with it.

- **A shelf can be stocked by rolling a table** (`scripts/manager-merchant.js`,
  `scripts/window-merchant-config.js`): drag a RollTable onto a shelf in Merchant Settings, say how many
  times to roll it, and every restock — the button or the clock — rolls and puts what comes up on that shelf.
  A uuid rather than an id, so a table in a compendium works exactly like one in the world, which is where a
  GM keeps this sort of table.

  **`roll()`, not `draw()`.** Drawing marks results as drawn, so a shop restocking from a table would exhaust
  it and then quietly stock nothing. A shop's table describes what it tends to carry; it is not a bag things
  are taken out of.

  Rolls go through `grantItems` in **one** call, so a table that rolls the same potion three times produces
  one row of three rather than three rows of one. Non-item results are skipped rather than refused — a table
  with a "nothing this week" row is a reasonable table. A table-stocked shelf restocks on the clock whatever
  its stock policy, because it is not refilling to a level, it is receiving a delivery.

- **A shelf can name several roll tables** (`scripts/manager-merchant.js`): a shop is rarely one table. A
  general store might roll on *common goods* three times, *potions* once and *oddments* once, and expressing
  that as a single table means building a combined one for every shop. Each table carries its own roll count,
  dropping a second adds rather than replaces, and all of a shelf's tables settle in one `grantItems` call so
  the same potion rolled by two of them lands as one row of two. A shelf configured before this reads its old
  single table without a migration.
- **Merchant Settings has a titlebar** (`scripts/window-merchant-config.js`): **Refresh**, because the window
  shows things it does not own — a shelf's item count, a table's name — and nothing pushes a change when a GM
  edits the Actor sheet beside it. And **Open Shop**, because setting a shop up and looking at it are the
  same sitting; it finds a token on the active scene first, then anywhere else the merchant stands.

- **A table rolls on the clock only if it is told to** (`scripts/manager-merchant.js`): each table on a
  shelf carries a **reroll** switch, off by default. A GM pressing Restock has asked for it, so every table
  rolls; the clock coming round rolls only the ones marked.

  That is the difference between stocking a shop and running one — and without it, every table added stock on
  every cycle and a shop left alone filled up for ever. Most tables are there to furnish a shelf once; the
  ones that are not now say so.
- **Restock from the shop, not only from Settings** (`templates/window-shop.hbs`): a GM gets a restock
  control on each shelf header, where they already are when they notice a shelf is bare. It brings the shelf
  back to its quantities and rolls all its tables.
- **The compendium search is a magnifying glass** rather than a plus, which is what it does.

- **A shelf has two ceilings** (`scripts/const.js`, `scripts/manager-merchant.js`): **products**, the number
  of distinct things it will carry (25 by default), and **each**, the most of any one of them (20). Per shelf,
  because a storefront and a back room are different sizes in every shop that has both.

  They answer two different runaways. Without the first, a shelf rolling a table weekly grows an ever longer
  list of one-offs until the window is unreadable. Without the second, a shelf that keeps restocking rations
  builds toward thousands of them. Neither announces itself until a fortnight of game time has passed.

  Rolled results are matched to existing rows by name and type — the dominant part of the merge identity
  `grantItems` uses. A cap that is approximately right is worth more than one that reimplements the predicate
  and drifts from it.
- **The per-item ceiling also bounds a restock target.** An item with no par flag restocks to whatever
  quantity it currently has, which is right for something dropped on a shelf and forgotten — but means a row
  that only ever arrived by table roll creeps upward, each delivery raising the target the next restock then
  protects. `par` is now read through the ceiling.
- **A GM can take something off a shelf** (`templates/partial-shop-row.hbs`): an **×** on each row. Setting a
  quantity to zero says *sold out*, and a restocking shelf brings it back; this says the shelf no longer
  carries it.

  No confirmation: putting something back is a drag, so a prompt would charge every removal for a mistake
  that costs seconds to undo — and a dialog that always gets a yes is one people stop reading. A **packed
  container** is the exception and keeps dnd5e's own prompt, because that one asks whether the contents go
  too, which is a real question with a wrong answer that orphans everything inside.

- **A typed quantity is clamped to the shelf's ceiling, and says so** (`scripts/manager-merchant.js`,
  `scripts/window-shop.js`): typing 10 into a row on a shelf that holds 5 of anything used to store 10 while
  the restock target read 5 — two numbers disagreeing with nothing to explain why. It clamps now and tells
  you where the limit is raised. One number governs.
- **The trading-hours slider reads against the day** (`templates/window-merchant-config.hbs`): the day's ends
  flank the track, because a band means nothing without the span it sits in. The chosen hours read as one
  phrase above it rather than two labels facing each other, with the opening figure green and the closing one
  red to match their handles. Deeper channel, larger handles.

- **"Always open" is a label, not a button** (`scripts/const.js`, `templates/window-merchant-config.hbs`):
  it was a control that cleared the schedule, which meant two ways to say one thing and a way for the two to
  disagree — a shop could be scheduleless *and* have hours that covered the day, and those looked different
  while meaning the same. Covering the whole slider is what makes a shop always open, and the label says so.

  **The closing handle now reaches the end of the day rather than its last hour.** That is what makes it
  arithmetic rather than a special case: `0–24` is genuinely every hour, where `0–23` left 11pm outside. A
  shop with no schedule at all shows the handles across the whole day, because that is what it is doing.

  The shop window stops printing hours for a shop open all of them — "midnight to midnight" is a fact about
  the clock rather than about the shop.

- **Restock Everything** (`scripts/window-merchant-config.js`): the main action in Merchant Settings,
  right-justified like the shop's. Brings every shelf back to its quantities and rolls all of their tables —
  a press, so every table rolls whether or not it is marked to reroll, the same rule the per-shelf button
  follows. Setting a shop up means filling all of it, and doing that a shelf at a time is the sort of chore a
  GM does once and then stops using the feature.

  **Confirmed, unlike the per-shelf button and unlike removing a row.** It touches the whole shop at once,
  rolls every table on it, and cannot be undone by dragging one thing back — the scale is what makes it worth
  a question, and the dialog says that rolled stock is added rather than replaced. It reports one total
  rather than one notification per shelf.

- **Hovering an item shows dnd5e's own card** (`scripts/window-shop.js`): on the shelves and on both sides of
  the slate. The system already renders one and renders it right — `richTooltip()` knows what belongs on a
  weapon and what belongs on a potion, and keeps knowing when dnd5e changes its mind. Three dataset
  attributes are the whole integration; Squire does it the same way for the same reason.

  On the **name**, not the row: a row also carries a quantity cell saying how to edit it and buttons saying
  what they do, and a row-wide card would cover every one of them. The two sides of the slate resolve against
  different Actors — what you are buying is the merchant's, what you are selling is yours. Falls back to the
  plain name where `richTooltip` is absent, which a truncated row needs whatever else is missing.

- **Both windows remember where you put them** (`scripts/window-shop.js`,
  `scripts/window-merchant-config.js`): they were opting out of the window base's position memory, so a shop
  dragged and resized reset on the next open.

  `api-window.md` recommends opting out for multi-instance tools, because siblings sharing a position key
  overwrite each other's. We had taken the recommendation without the reasoning behind it: both windows
  already declare a **shared** key deliberately — a shop is a shop wherever it is opened. Two shops open at
  once now stack, which is rare and one drag apart; every shop resetting was every time.

- **Switching character has its own icon**: it was a circular arrow, which is what Refresh and Restock are.
  It is a person now, because it is about who rather than about repeating.
- **The slate's sums show the purse and which way each moves it** (`templates/window-shop.hbs`): a **Funds**
  row above the rest, carrying what the shopper holds — a total is a change to something, and it means little
  without the number it acts on. **Buying** is signed −, **Selling** +, because that is the direction each
  moves that purse. The **Total** is bold, red when the purse goes down and green when it goes up.

### Notes
- **Every stock policy delivers with `grantItem`, never `transferItem`.** The merchant's item is a template carrying a count, so a sale copies it and adjusts a number. That kept infinite stock free of races entirely, and it is what lets finite stock keep a sold-out row on the shelf. What finite stock does reintroduce is the read-then-write race, which the per-merchant lock answers.
- `"socket": true` from the first commit. Foundry reads manifests at world launch, so adding it later costs a world restart and silently drops every emit until then.
