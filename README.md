# Coffee Pub Merchant

![Foundry v13](https://img.shields.io/badge/foundry-v13-green)
![D&D 5e](https://img.shields.io/badge/system-dnd5e-red)
![MIT License](https://img.shields.io/badge/license-MIT-blue)

## Disclaimer

This is a personal project created for my FoundryVTT games. If you stumble upon this repository and find it useful, feel free to try it out — but it is developed for personal use, and I make no guarantees regarding stability, compatibility, or ongoing support.

**Use at your own risk.**

## Overview

**Coffee Pub Merchant** turns an Actor into a shop. Mark a merchant, double-click their token, and your players can browse the stock, fill a slate with what they are buying and selling, and settle the whole thing in one press.

The money comes from the player who is shopping. There is no separate payer and recipient to keep straight — shopping for the party means *being* the party, and the party Group Actor is in the "Buying as" list alongside every character.

## What it does

**Shelves.** Stock lives in container Items on the merchant, so a shopkeeper's worn armour and belt dagger are not for sale. Five presets ship — Storefront, Back Room, Premium, Negotiate, Buyback — but they are one schema with three properties (visibility, markup, mode), not five hard-coded kinds. A hidden shelf is enforced as a permission, not merely left out of the window.

**Stock that behaves like stock.** Per shelf: unlimited, runs out, or refills on a cadence measured in in-world days. Shelves can be filled by dragging items on, by searching the compendiums, or by rolling roll tables — several tables per shelf, each with its own roll count, and optionally re-rolled on every restock. Ceilings on both how many distinct things a shelf carries and how many of any one thing, so a shop left running for a month of game time does not quietly accumulate two thousand rations.

**Trading hours.** A slider from midnight to midnight; the band across the whole day means always open, the band closed to nothing means never. A closed shop can still be browsed — you can look through the window — but nothing changes hands. A GM can overrule the schedule, and that exception lapses at the next boundary rather than sticking forever.

**Prices and haggling.** Per-shop markup, overridable per shelf. A **Negotiate** shelf has no listed price at all: items go on the slate at *TBD*, the GM names a figure by double-clicking it, and the transaction will not settle until every line has one. Something agreed for an item that had no price of its own keeps that price when it changes hands — so a curio bought at 200gp can be sold on at 200gp — while a haggled discount on an ordinary item does not follow it, because a longsword bought cheap is still worth what a longsword is worth.

**Buying and selling in one press.** The slate holds both directions at once, shows the running total in the direction it actually runs, and settles as a single atomic exchange. Goods and coin commit together or nothing does.

## Requirements

- [Coffee Pub Blacksmith](https://github.com/Drowbe/coffee-pub-blacksmith): provides the inventory primitives, token interaction, window components, dialogs, and socket infrastructure. Merchant does not function without it.
- **D&D 5e.** Stock and pricing read `system.price`, `system.quantity`, and `CONFIG.DND5E.currencies`.
- **Foundry v13.**

## Getting started

1. Open any Actor's sheet and use the **Merchant Settings** header button.
2. Toggle **Is a merchant**. A Storefront shelf is created for you.
3. Drag items onto the shelf, search the compendiums for them, or drop a roll table on it and press restock.
4. Put a token on the scene. Players double-click it to shop.

## Known gaps

- **No localisation.** Every string is hardcoded English. See `documentation/TODO.md`.
- **The GM cannot hand something over for free** from the shop window; drag it from the merchant's sheet instead.
- Two seams wait on Blacksmith — the request envelope does not yet forward the verified caller, and a shop's till is written directly rather than through the inventory API. Both are documented in `documentation/architecture/architecture-merchant.md` § *Known seams*.

## Documentation

- `documentation/architecture/` — how the implemented systems work. **Start here.**
- `CONTRIBUTING.md` — the conventions this codebase follows, and why
- `documentation/plans/` — intent and the reasoning behind decisions
- `documentation/testing/` — verification checklists
- `documentation/TODO.md` — open items and patterns to avoid
- `CHANGELOG.md` — what shipped, and the reasoning behind it

## License

MIT
