// ==================================================================
// ===== INVENTORY — accessor for Blacksmith's api.inventory ========
// ==================================================================
//
// Merchant owns no item or currency mutation code. Nothing here may grow logic; if
// a call needs wrapping, that belongs in manager-merchant.js.

import { MODULE } from './const.js';

const FALLBACK_PHYSICAL_TYPES = ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'];

export function inventoryApi() {
    return game.modules.get('coffee-pub-blacksmith')?.api?.inventory ?? null;
}

export function isInventoryReady() {
    return typeof inventoryApi()?.grantItem === 'function';
}

/** Blacksmith publishes the whitelist so there is no second copy to drift. */
export function physicalTypes() {
    const types = inventoryApi()?.PHYSICAL_TYPES ?? FALLBACK_PHYSICAL_TYPES;
    return Array.isArray(types) ? types : [...types];
}

export function isPhysical(type) {
    return physicalTypes().includes(type);
}

/**
 * Copy an item onto an Actor, leaving the source untouched.
 *
 * **This is the delivery path for every stock policy, not just the infinite one.** A
 * merchant's item is a template carrying a count: a sale grants a copy and the
 * manager adjusts the number. `transferItem` would move the document and delete it
 * on the last unit, which loses the shelf layout and leaves a restocking shelf with
 * nothing to restock.
 *
 * What finite stock does reintroduce is the race — two buyers reading the same count
 * — which `MerchantManager._withStockLock` answers rather than this file.
 *
 * `container` names the shelf the copy lands on. Honoured by the primitive itself
 * since 2026-08-18: it always writes `system.container` rather than inheriting the
 * source's, and container membership is part of merge identity, so a merge can only
 * land on a row already on that shelf. Merchant carried a post-write correction for
 * this until then; it is gone.
 */
export async function grantItem(request) {
    const api = inventoryApi();
    if (typeof api?.grantItem !== 'function') {
        console.error(`${MODULE.TITLE} | api.inventory is unavailable; grantItem refused.`);
        return { ok: false, code: 'INVENTORY_UNAVAILABLE' };
    }
    return api.grantItem(request);
}

/**
 * A list of directed transfers, all committing or none.
 *
 * `{ transfers: [{ from, to, items, currency, container }, ...] }`. Directed rather
 * than two-sided because a shop transaction is not reliably two-party: the shopper
 * pays, but the goods may go to another character or to the party, and a list of what
 * each party *gives* does not say where any of it goes once there are three of them.
 * Two-sidedness was silently carrying the routing.
 *
 * **Not built yet** — designed and planned, not shipped. Orchestrating it here would
 * mean writing rollback across two primitives holding separate locks, which is exactly
 * what api.inventory exists to prevent, so Merchant asks for it and refuses cleanly
 * until it exists rather than approximating it.
 *
 * Three rules of the planned primitive that this module is written against:
 * `from === to` is refused per transfer, though an Actor may appear in several;
 * payment and change between the same pair are never netted, since netting would let a
 * payer hand over coin they do not have; and every transfer validates against the
 * state at the start of the call, so change arriving cannot fund the payment.
 */
export async function exchange(request) {
    const api = inventoryApi();
    if (typeof api?.exchange !== 'function') return { ok: false, code: 'EXCHANGE_UNAVAILABLE' };
    return api.exchange(request);
}

// Two things Merchant needs that a two-sided, move-only exchange cannot express, both
// raised with Blacksmith while the primitive is still being designed:
//
// 1. **Three parties.** The shopper pays, but the goods may go to another character
//    or to the party. Merchant refuses this as THIRD_PARTY_DELIVERY rather than
//    charging the wrong purse.
// 2. **Copy rather than move.** A shop's stock is a count, so the goods side of a
//    purchase is a grant, not a transfer. Merchant therefore uses `exchange` for the
//    coin only and delivers separately — losing atomicity, which is the whole point
//    of the primitive.


export function hasExchange() {
    return typeof inventoryApi()?.exchange === 'function';
}
