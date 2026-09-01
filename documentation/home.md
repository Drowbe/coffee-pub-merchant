# Coffee Pub Merchant

**Audience:** everyone -- GMs and players using Merchant at the table, and contributors changing it.

Shops for Foundry VTT: mark an Actor as a merchant and their token becomes a shop your players can walk
into. They browse the shelves, put what they are buying and selling on one slate, and settle the whole
thing in a single press. Merchant is part of the Coffee Pub suite and requires Coffee Pub Blacksmith.

![A shop open full screen: the merchant's catalogue as a wall of illustrated tiles with prices, and the
buyer's slate down the right with delivery service, destination and running
total](assets/merchant-catalogue-fullscreen.webp)

This page routes. Each section points at the document that answers the question rather than answering it
here.

## Using Merchant at the table

[Getting started](userguides/userguide-getting-started.md) covers what Merchant does, what it needs
installed, how to turn an Actor into a shop, and what a player sees when they walk into one -- the first
five minutes, for a GM and for a player.

## How it is built

[Architecture](architecture/architecture-merchant.md) is the map: how shelves, stock policy, pricing,
the slate and the settlement fit together, why buying grants a copy rather than moving the merchant's
item, and what was learned the hard way about Foundry and dnd5e along the way. Start there before
reading the code.

## What is still broken

[Known issues](known-issues.md) lists the defects we have not fixed, with a workaround where there is
one.

## The suite

Merchant is one of the Coffee Pub modules. [Blacksmith](https://github.com/Drowbe/coffee-pub-blacksmith)
is the hub every other one depends on; its wiki carries the shared APIs and the suite-wide standards.
