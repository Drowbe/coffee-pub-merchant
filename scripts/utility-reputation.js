// ==================================================================
// ===== REPUTATION =================================================
// ==================================================================
//
// What the party's standing does to a price.
//
// **The boundary is theirs, the consequence is ours.** Blacksmith scores the party
// -100..+100 per scene and sorts that into eleven named bands; Merchant decides what
// a shop charges a party in that band. Their scale briefly carried an
// `effects.merchantModifier` slot and they removed it rather than fill it, which is
// the right call: a shop's economy is not the hub's to set, and the same scale drives
// NPC attitude and what people will tell you.
//
// So this file reads a score, asks them which band it falls in, and looks the answer
// up in `REPUTATION_MARKUP` — a table in `const.js` that is meant to be tuned.
//
// **Thin on purpose**, like `utility-inventory.js` and `utility-feedback.js`. The
// caching and the band lookup live here; no pricing arithmetic does. That is
// `utility-pricing.js`, which takes a multiplier and knows nothing about towns.

import { MODULE, REPUTATION_MARKUP, REPUTATION_FALLBACK, REPUTATION_LIMITS } from './const.js';

/** sceneId -> { multiplier, label }. Per client, and only ever a cache of a derivation. */
const _cache = new Map();

function _blacksmith() {
    return game.modules.get('coffee-pub-blacksmith')?.api ?? null;
}

function clamp(multiplier) {
    const value = Number(multiplier);
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(REPUTATION_LIMITS.max, Math.max(REPUTATION_LIMITS.min, value));
}

/**
 * Resolve the standing for a scene, once, and remember it.
 *
 * Async because the band lookup fetches Blacksmith's scale the first time it is
 * asked. Call it **once per render** and pass the number down — never per row, which
 * would be a promise per price and a list resolving in a different order than it drew.
 *
 * @param {Scene|null} scene The merchant's own scene. Reputation is per scene, so a
 *   shop is priced where it stands rather than where the reader happens to be looking.
 */
async function _resolve(scene) {
    const blacksmith = _blacksmith();
    if (typeof blacksmith?.getPartyReputation !== 'function') return { multiplier: 1, label: null };

    try {
        const score = Number(blacksmith.getPartyReputation(scene ?? undefined)) || 0;
        const band = typeof blacksmith.getReputationScaleEntry === 'function'
            ? await blacksmith.getReputationScaleEntry(score)
            : null;

        // Their band when we recognise it. A world that has customised the scale may
        // name bands we have never heard of, so fall back on the sign of the score —
        // the part of it that is always true.
        const fromBand = band?.key ? REPUTATION_MARKUP[band.key] : undefined;
        const multiplier = fromBand ?? (score > 0
            ? REPUTATION_FALLBACK.liked
            : score < 0 ? REPUTATION_FALLBACK.disliked : REPUTATION_FALLBACK.neutral);

        return { multiplier: clamp(multiplier), label: band?.label ?? null };
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not read party reputation; prices are unmodified:`, error);
        return { multiplier: 1, label: null };
    }
}

async function _entry(scene, enabled) {
    if (!enabled) return { multiplier: 1, label: null };
    const sceneId = scene?.id ?? canvas?.scene?.id ?? null;
    if (!sceneId) return { multiplier: 1, label: null };
    if (!_cache.has(sceneId)) _cache.set(sceneId, await _resolve(scene));
    return _cache.get(sceneId);
}

/**
 * The multiplier a shop's prices are moved by, or 1.
 *
 * `enabled` is the shop's opt-in: a shop that has not asked for this is never quietly
 * priced by it.
 */
export async function resolveReputation(scene, enabled) {
    return (await _entry(scene, enabled)).multiplier;
}

/**
 * The band's name, for saying *why* a price moved.
 *
 * A shop that is 15% dearer for no stated reason reads as a bug. "Distrusted here"
 * reads as the game working.
 */
export async function reputationLabel(scene, enabled) {
    return (await _entry(scene, enabled)).label;
}

/**
 * Follow reputation changes.
 *
 * Blacksmith emits on **every** client whenever the value changes, however it was
 * changed — it rides Foundry's `updateSetting` rather than their setter — so this is
 * the whole of keeping up to date: drop the cache and let the caller redraw.
 */
export function watchReputation(onChange) {
    Hooks.on('blacksmith.partyReputationChanged', (data) => {
        if (data?.sceneId) _cache.delete(data.sceneId);
        else _cache.clear();
        onChange?.(data);
    });
}
