// ==================================================================
// ===== THE LOCAL MARKET ===========================================
// ==================================================================
//
// What goods are worth in a place, regardless of who is asking.
//
// Stored as a flag on the Scene, read synchronously — unlike reputation, there is no
// scale to fetch and no band to resolve, so this needs no cache and no hook. It is a
// number on a document.
//
// **Thin on purpose**, like the other `utility-` files. The reasoning for what a
// market rate *is*, and why it is the only lever that can make a trade route, lives
// in `const.js` beside `MARKET_FLAG`.

import { MODULE, MARKET_FLAG, DEFAULT_MARKET_RATE, MARKET_LIMITS } from './const.js';

/** Clamped, and never zero or negative: a market cannot make goods worthless. */
export function clampMarket(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return DEFAULT_MARKET_RATE;
    return Math.min(MARKET_LIMITS.max, Math.max(MARKET_LIMITS.min, rate));
}

/**
 * The market rate for a scene.
 *
 * @param {Scene|null} scene The merchant's own scene — the one its *token* stands on,
 *   never the viewer's current view, or a GM on another map would price the shop
 *   differently from the players standing in it.
 */
export function marketRate(scene) {
    if (!scene) return DEFAULT_MARKET_RATE;
    return clampMarket(scene.getFlag(MODULE.ID, MARKET_FLAG)?.rate ?? DEFAULT_MARKET_RATE);
}

/** Whether a scene has been given a market of its own. */
export function hasMarket(scene) {
    return marketRate(scene) !== DEFAULT_MARKET_RATE;
}

/** GM-only. Setting it back to 1 clears the flag rather than storing a no-op. */
export async function setMarketRate(scene, rate) {
    if (!game.user.isGM || !scene) return null;
    const value = clampMarket(rate);
    if (value === DEFAULT_MARKET_RATE) {
        await scene.unsetFlag(MODULE.ID, MARKET_FLAG);
        return value;
    }
    await scene.setFlag(MODULE.ID, MARKET_FLAG, { rate: value });
    return value;
}

/**
 * What a market rate means, in words.
 *
 * The same shape as the pricing readouts: the number, and what it does. "Goods here
 * cost double" is what a GM is deciding; "×2.00" is only how it is stored.
 */
export function marketLabel(rate) {
    const value = clampMarket(rate);
    if (value === DEFAULT_MARKET_RATE) return game.i18n.localize('coffee-pub-merchant.market.goingRate');
    const percent = Math.round(Math.abs(1 - value) * 100);
    return value > 1
        ? game.i18n.format('coffee-pub-merchant.market.dearer', { rate: value.toFixed(2), percent })
        : game.i18n.format('coffee-pub-merchant.market.cheaper', { rate: value.toFixed(2), percent });
}

/** A short form for the shop window, where there is no room to explain. */
export function marketShortLabel(rate) {
    const value = clampMarket(rate);
    if (value === DEFAULT_MARKET_RATE) return null;
    return value > 1 ? game.i18n.localize('coffee-pub-merchant.market.runsHigh') : game.i18n.localize('coffee-pub-merchant.market.runsLow');
}
