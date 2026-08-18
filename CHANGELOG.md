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

### Notes
- **Stock is infinite in v1, and that makes it simpler than looting rather than harder.** Acquiring uses `blacksmith.inventory.grantItem`, which copies from the merchant's item as a template and never touches the source — so there is no source rollback, no lock contention on the shop, and no race at all between two players acquiring the same item.
- `"socket": true` from the first commit. Foundry reads manifests at world launch, so adding it later costs a world restart and silently drops every emit until then.
