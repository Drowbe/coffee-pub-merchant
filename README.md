# Coffee Pub Merchant

![Foundry v13](https://img.shields.io/badge/foundry-v13-green)
![MIT License](https://img.shields.io/badge/license-MIT-blue)

## Disclaimer

This is a personal project created for my FoundryVTT games. If you stumble upon this repository and find it useful, feel free to try it out — but it is developed for personal use, and I make no guarantees regarding stability, compatibility, or ongoing support.

**Use at your own risk.**

## Overview

**Coffee Pub Merchant** turns an Actor into a shop. Mark a merchant, double-click their token, and players can browse and acquire from their stock.

Not yet functional — see `documentation/plans/plan-merchant.md` for what is being built and why.

## Requirements

- [Coffee Pub Blacksmith](https://github.com/Drowbe/coffee-pub-blacksmith): provides the inventory primitives, token interaction, window components, dialogs, and socket infrastructure. Merchant does not function without it.
- **D&D 5e.** Stock and pricing read `system.price`, `system.quantity`, and `CONFIG.DND5E.currencies`.

## Documentation

- `documentation/architecture/` — how the implemented systems work
- `documentation/plans/` — intent and the reasoning behind decisions
- `documentation/testing/` — verification checklists
- `documentation/TODO.md` — open items and patterns to avoid

## License

This work is licensed under the included LICENSE file.

## Credits

Part of the Coffee Pub module collection.
