# Plan — opening a shop from a Blacksmith pin

**Status:** agreed 2026-08-24, in build. Delete this file once it has been used at a table and the notes
below have nothing left to teach. TODO item 1.

---

## The decision

**A pin is a second door onto the same shop, and only a linked merchant may have one.**

That single restriction is what makes the rest simple. A pin is durable map furniture — it outlives
scenes being swapped, tokens being deleted, a session ending — so what it points at has to be durable
too. An unlinked token is a copy: three placements of Flipper are three shops that know nothing about
each other, and a pin naming "Flipper" would be naming a mould rather than a shop. So:

> **A dedicated shop on a map is durable, and therefore requires a durable Actor.**

A pin stores the **linked Actor's uuid**. Opening from the pin and double-clicking the linked token
reach the same Actor, and — see below — the same window and the same cart.

## Identity: the part that is not automatic

The shop window is keyed by **token** today. `openFor` registers by uuid, and the slate is
`` `${tokenUuid}|${shopperUuid}` ``. A pin opening by Actor uuid and a token opening by token uuid
would therefore be *two windows on one shop with two separate carts* — precisely what the decision
above says must not happen.

**So identity becomes: the Actor for a linked merchant, the token for an unlinked one.**

| merchant | keyed by | why |
|---|---|---|
| linked Actor, tokens anywhere | the **Actor** uuid | one shop, wherever you meet it — pin, token, or two tokens on one map |
| unlinked merchant token | the **token** uuid | each placement genuinely is its own shop, with its own ActorDelta |

This also fixes something latent: two placed linked tokens of one Actor already open two windows with
two carts for what is, by every other measure, one shop.

**The shape of the change.** A window is opened *for a subject*, and carries two things rather than one:

- `shopKey` — the identity string above. Used by `openFor`, the slate key, `refreshForToken`,
  `publishSlatesFor`, and the socket payloads.
- `sceneUuid` — **where you are standing**, which is not derivable from a linked Actor.

`_resolveToken()` becomes `_resolveSubject()`, returning `{ actor, token, scene }`. The token may be
null; the actor may not.

## Why the scene has to be carried separately

Two multipliers are scene-scoped and both read `token.parent` today:

- `marketRate(scene)` — the trade-route number on the Scene flag
- `resolveReputation(scene)` — the party's standing *here*

A linked Bob with a token in Phlan and a pin in the besieged city is one shop with one set of goods at
two prices. That is the trade-route design working as intended, and it is why the scene cannot simply
be read off the Actor.

**Edge case, decided:** one window, one scene at a time. Opening the same shop from a second scene
re-points the existing window rather than opening a second one — last open wins. The card already
states the market and reputation lines, so the price context is on screen rather than implied.

## A pin stands alone

A pin is the shop's presence on that map. **No token is required**, and a stall in a market square is
the case that makes it obvious. With no token:

- market and reputation come from the **pin's** scene (which is why the pin carries it),
- the keeper line falls back to the Actor's name — identical for a linked merchant, so nothing is lost,
- `broadcastActorRefresh` is already Actor-keyed and needs no change.

## A dead pin opens an abandoned shop

The merchant Actor is deleted; the pin remains. It is **not** silently removed — deleting a GM's map
furniture without being asked is the same failure as a roll table's dead row vanishing.

Clicking it opens the shop window in an **abandoned** state: shuttered, empty, no keeper. The window
already has a `missing` path (one line of "unavailable" text), and that is what becomes the abandoned
shop rather than an error toast. A shop that has closed down is a thing that happens in a world, and
reads better than a stack trace.

## Creation

- **A *Pin this shop* control in Merchant Settings**, mirrored in the shop window header. Places a pin
  on the current scene.
- **Dragging an Actor onto the canvas is unchanged** — it places a linked token, exactly as today.
- **Pins are an *and*, not an *or*.** A shop may have a token, a pin, both, or (for a linked merchant)
  only a pin.

Refused with the reason on an unlinked merchant: *an unlinked merchant is a copy, not a shop.*

## What Blacksmith gives us

- `pins.create(pinData, { sceneId })` — **`sceneId` goes in the options argument.** Putting it in
  `pinData` makes the pin count as placed but resolves the scene to `undefined`, which falls back to
  the *active* scene: the pin lands somewhere else, with no error. Their own doc carries the
  correction.
- `pins.on('click' | 'doubleClick', handler, { moduleId, signal })` — scoped to our pins, returns a
  disposer, takes an `AbortSignal`.
- `registerContextMenuItem` — a right-click entry on our pins only.
- `registerPinType` / `registerPinTaxonomy` in `ready`, so our pins name themselves in Blacksmith's UI.
- `config: { [key: string]: unknown }` on the stored pin — where the merchant Actor uuid lives.
- `isAvailable()` / `isReady()` / `whenReady()` — feature-detected, the way `hasQuery` already is.

**Three axes Blacksmith is emphatic about not conflating**, and how a shop pin uses them:

| field | controls | ours |
|---|---|---|
| `ownership.default` | can this user see the pin record at all | `OBSERVER` for a shop the party knows; `NONE` for one they have not found |
| `config.blacksmithVisibility` | is the marker drawn for others | GM's call — a *closed* shop is still a visible shop |
| our click handler | what opens | ours alone; Blacksmith owns none of it |

## The pin's look is a world setting

A shop pin should look like a shop pin in this world, and that is the GM's call rather than a constant
in `const.js`. Merchant registers world settings for the **shipped design** — shape, size, icon,
colours, text layout — under a *Pins* section in the settings tab, laid out the same way Stock Depth
is: the section explains, the controls are labelled.

Two layers, and they do not fight:

- **Merchant's world settings** are what a new shop pin is created with. One answer for the world.
- **Blacksmith's `getDefaultPinDesign(moduleId, type)`** is a *per-user client* default a GM saves from
  the Configure Pin window's "Default for [type]". Read it at create time and merge it over ours, so a
  GM who has taken the trouble to design a pin gets their design and everybody else gets the world's.

Neither touches an existing pin: a pin already on a map keeps the look it was made with, because it is
a thing on a map and not a view of a setting.

## Staging

1. **Identity.** `shopKey` / `sceneUuid` / `_resolveSubject`, and the slate, refresh and socket keys
   with it. Nothing user-visible except two linked tokens now sharing one window and one cart.
2. **The abandoned shop.** Turn the one-line `missing` path into a shuttered shop card.
3. **Pins.** Taxonomy and type registration, create, click, context menu, the two buttons, and the
   world settings for the pin's design.

Stage 1 is the risky one because it touches the slate, and it is worth landing and testing on its own.
