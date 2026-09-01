# Coffee Pub Merchant

![Foundry v13](https://img.shields.io/badge/foundry-v13-green)
![D&D 5e](https://img.shields.io/badge/system-dnd5e-red)
![MIT License](https://img.shields.io/badge/license-MIT-blue)

Mark an Actor as a merchant and their token becomes a shop. Your players double-click it, browse the
shelves, put what they are buying and selling on one slate, and settle the whole thing in a single
press.

![A shop open full screen: the merchant's catalogue as a wall of illustrated tiles with prices, and the
buyer's slate down the right with delivery service, destination and running
total](documentation/assets/merchant-catalogue-fullscreen.webp)

![The same shop as a list: shelves grouped by category, quantities and prices per row, and the slate
showing what is being bought and sold at once](documentation/assets/merchant-shop-list.webp)

## What it does

- **Shelves that behave like shelves.** Stock lives in containers on the merchant, so a shopkeeper's
  own armour is not for sale. A shelf can be unlimited, finite and running out, or refilling on a
  cadence measured in in-world days, and can be filled by dragging, by searching compendiums, or by
  rolling tables.
- **Trading hours.** Set when a shop is open. A closed shop can still be browsed -- you can look
  through the window -- but nothing changes hands.
- **Prices and haggling.** Markup per shop and per shelf, and a Negotiate shelf with no listed price at
  all: items go on the slate at TBD and the GM names a figure. A price agreed for one customer does not
  reprice the shelf for everybody else.
- **Buying and selling in one press.** The slate holds both directions at once and settles as a single
  atomic exchange: goods and coin commit together, or nothing does.
- **Four ways into a shop.** The token, a pin on the map, a Foundry region a party walks into, or a
  printed catalogue Item they carry -- all opening the same shop with the same slate.
- **Shops that outlive their shopkeeper.** Delete a merchant and its pin stays, opening on a shuttered
  card with whatever nobody carried away still lying in a barrel.
- **Mail order.** A catalogue shelf is a warehouse: nothing on it changes hands where you are standing.
  Orders are paid for now and delivered later by one of three services, in crates with a deposit, to a
  destination the buyer picks -- and the GM says whether the party are standing where the parcel is.

## Requirements

- [Coffee Pub Blacksmith](https://github.com/Drowbe/coffee-pub-blacksmith) **13.19.2 or newer**. It
  provides the inventory primitives, window components, dialogs, compendium queries and socket
  infrastructure Merchant is built on. Merchant does not function without it.
- **D&D 5e.** Stock and pricing read the system's own price, quantity and currency fields.
- **Foundry v13.**

## Install

In Foundry, go to **Configuration and Setup -> Add-on Modules -> Install Module** and paste:

```
https://github.com/Drowbe/coffee-pub-merchant/releases/latest/download/module.json
```

Do the same for Blacksmith, which Merchant does not run without:

```
https://github.com/Drowbe/coffee-pub-blacksmith/releases/latest/download/module.json
```

Then enable both in your world's module settings.

## Where to read more

Everything is on the [wiki](https://github.com/Drowbe/coffee-pub-merchant/wiki):

- **[Getting started](https://github.com/Drowbe/coffee-pub-merchant/wiki/userguide-getting-started)** --
  set up your first shop, and what a player sees when they walk into one.
- **[Architecture](https://github.com/Drowbe/coffee-pub-merchant/wiki/architecture-merchant)** -- how it
  is built and why, for anyone changing it.
- **[Known issues](https://github.com/Drowbe/coffee-pub-merchant/wiki/known-issues)** -- what does not
  work yet.

## The suite

| Module | What it does |
|---|---|
| [Blacksmith](https://github.com/Drowbe/coffee-pub-blacksmith) | Quality of life, gameplay frameworks, automation, and aesthetic improvements |
| [Squire](https://github.com/Drowbe/coffee-pub-squire) | A character tray: quick access to abilities, items and spells |
| [Crier](https://github.com/Drowbe/coffee-pub-crier) | Combat turn announcements with turn cards and round summaries |
| [Librarian](https://github.com/Drowbe/coffee-pub-librarian) | A campaign codex of people, places, factions and artifacts, and the quests running through them |
| [Scribe](https://github.com/Drowbe/coffee-pub-scribe) | Journal and chat card formatting for sharing narrative |
| [Bibliosoph](https://github.com/Drowbe/coffee-pub-bibliosoph) | In-game player messaging with journal-backed conversations |
| [Curator](https://github.com/Drowbe/coffee-pub-curator) | Image management: token, portrait and map image placement |
| [Minstrel](https://github.com/Drowbe/coffee-pub-minstrel) | A music, environment and one-shot manager |
| [Artificer](https://github.com/Drowbe/coffee-pub-artificer) | A crafting, recipe and blueprint system |
| [Cartographer](https://github.com/Drowbe/coffee-pub-cartographer) | Party strategic planning and sketching |
| [Herald](https://github.com/Drowbe/coffee-pub-herald) | A streaming and broadcast view with a designated cameraman user |
| [Monarch](https://github.com/Drowbe/coffee-pub-monarch) | Save and load sets of enabled modules |
| [Regent](https://github.com/Drowbe/coffee-pub-regent) | Optional AI tools and worksheets |
| [Vault](https://github.com/Drowbe/coffee-pub-vault) | Optional assets for the suite |

## A note on support

This is a personal project built for my own games. If you find it useful, take it -- but it is
developed for my table, and I make no guarantees about stability, compatibility or ongoing support.

<!-- global:ai-assistance -->
## AI Assistance and the Illusion of Good Code

I started writing Foundry modules for use at my own table back in 2020. There were already a ton of amazing modules out there, but they either didn't quite do what I wanted or didn't deliver the kind of user experience I was looking for.

I've been a design leader for more than 20 years, but I spent the first half of my career as a developer, so building my own modules seemed like a fun way to kill some time. I'm a pretty good designer. I'm a decent developer. But, over time, my hand-written code and hacks got a little messy (and memory-leaky, and a little buggy. Feels good to say it out loud.).

Today, the Coffee Pub suite of modules is developed with AI assistance, primarily Claude and Cursor, for documentation, refactoring, debugging, and other development work. Every change is reviewed and committed by me, and nothing reaches a release that I haven't crawled and run at my own table. I can't seem to give up my IDE. The UX design, architecture, and ideas still come from my own fever dreams and chronic lack of sleep.

Testing and verifying a change means running it in Foundry so I can watch the console, break things, fix them, and hone the experience. The repositories carry a set of tools for testing the things that are difficult to catch through review and manual testing alone. They help ensure styles don't conflict, shared coding and documentation standards stay consistent, and the suite of modules continues to work well as a system without silently breaking.

Those checks are there because AI-assisted development can move very quickly, and without oversight, engagement, and planning, it can also go confidently off the rails and deliver the illusion of good code. The AI helps me build faster. It doesn't decide what gets built, its architecture, or how it should work. You can blame this human for that.

If the idea of AI-assisted development keeps you up at night or just isn't your jam, no worries at all. I get it. You do you.
<!-- /global:ai-assistance -->

## License

MIT. See [LICENSE](LICENSE).
