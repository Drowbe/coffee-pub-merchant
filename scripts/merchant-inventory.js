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
 */
export async function grantItem(request) {
    const api = inventoryApi();
    if (typeof api?.grantItem !== 'function') {
        console.error(`${MODULE.TITLE} | api.inventory is unavailable; grantItem refused.`);
        return { ok: false, code: 'INVENTORY_UNAVAILABLE' };
    }

    const result = await api.grantItem(request);
    // Never on a merge: the target row already existed and may sit on another shelf,
    // so normalising it would relocate stock nobody touched.
    if (result?.ok && !result.merged) {
        await _normaliseContainer(result.targetItemId, request.targetActorUuid, request.container);
    }
    return result;
}

/**
 * TEMPORARY — remove when `grantItem` clears `container` on arrival.
 *
 * `RESET_PATHS` covers `equipped`, `attuned` and `prepared` but not
 * `system.container`, and the payload is built from `toObject()` verbatim. Stock on
 * a merchant shelf carries a container id, so a granted copy arrives on the buyer
 * still pointing at a shelf that is not on their sheet — and container membership is
 * part of merge identity, so it cannot stack with what they already carry either.
 *
 * Blacksmith has this as a defect with a fix attached; the same change adds a
 * `container` option, at which point this whole function goes away and the caller's
 * `container` is honoured by the primitive instead.
 */
async function _normaliseContainer(itemId, targetActorUuid, container = null) {
    if (!itemId) return;
    try {
        const actor = await fromUuid(targetActorUuid);
        const item = actor?.items?.get(itemId);
        const current = item?.system?.container ?? null;
        if (!item || current === (container ?? null)) return;
        await item.update({ 'system.container': container ?? null });
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not normalise container membership:`, error);
    }
}

/**
 * A two-sided exchange: goods one way, coin the other, both committing or neither.
 *
 * **Not built yet.** Blacksmith has accepted it in principle and will build it on
 * their existing internal cores when this phase is real. Orchestrating it here would
 * mean writing rollback across two primitives holding separate locks, which is
 * exactly what api.inventory exists to prevent — so Merchant asks for it and refuses
 * cleanly until it exists, rather than approximating it.
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
