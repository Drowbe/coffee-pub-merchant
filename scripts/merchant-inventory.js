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
 * This is what makes infinite stock simple: the merchant's item is a template, so
 * buying never mutates the merchant. No source rollback, no lock contention on the
 * shop, and no race between two players acquiring the same item. Finite stock will
 * need `transferItem` and reintroduces all of it — see plan section 7.
 */
export async function grantItem(request) {
    const api = inventoryApi();
    if (typeof api?.grantItem !== 'function') {
        console.error(`${MODULE.TITLE} | api.inventory is unavailable; grantItem refused.`);
        return { ok: false, code: 'INVENTORY_UNAVAILABLE' };
    }
    return api.grantItem(request);
}
