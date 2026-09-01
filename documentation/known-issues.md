# Known Issues

**Audience:** anyone using Merchant who has hit something that does not work.

Defects and gaps that are live in the current release, each with a workaround where one exists. When an
item is fixed it moves to the CHANGELOG and leaves this list.

## A GM cannot hand something over for free from the shop window

There is no "give" action. Drag the item from the merchant's own sheet to the character instead.

A shop can price something at zero, which is a different thing and does work: type `0` into a shelf
price and the row reads **Free**. That is a price of nothing rather than a gift, so it still goes on the
slate and still settles.

## A shelf cannot draw from a compendium outside Blacksmith's curated set

A shelf stocked by compendium query lists such packs and marks them **Waiting**. Merchant reads pack
indexes itself for the manual list, so the packs are reachable; the curated path is the hub's and covers
the curated set only. Drag the items on by hand, or add the pack to Blacksmith's set.

## Placing a pin uses Merchant's own crosshair

The hub has no shared pin-placement picker, so Merchant arms one of its own. It works, and it behaves
differently from every other placement gesture in the suite because there is nothing yet to share.

## A receipt's description does not count down

The paragraph written onto a delivery receipt is the arrival date as it stood when the order was placed;
it does not tick down as the world clock advances. Consulting the receipt gives a live figure, which is
the number to trust.

## A parcel that arrives while nobody holds the receipt is lost

If the receipt Item has been deleted, or moved off an Actor, there is nobody for the courier to give the
parcel to. The GM is told what was in it. Nothing is refunded -- whether the party get their money back
is the GM's decision, not the module's.
