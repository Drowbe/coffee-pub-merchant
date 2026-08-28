// ==================================================================
// ===== THE EXPANDED SHOP ==========================================
// ==================================================================
//
// **A shop that fills the screen, for the shops that are worth looking at.**
//
// Four things were settled before any of this was written, and they are the reasons it
// looks the way it does rather than the obvious way.
//
// **Not the browser's fullscreen API.** `requestFullscreen` puts one element on its own
// layer, and Foundry renders tooltips into a global `#tooltip` and dialogs as separate
// applications at body level. Both would draw *behind* the shop, which is to say
// invisibly: every hover card, the clear-inventory confirm and the character picker would
// vanish. So it means **fills the Foundry viewport** -- a positioned window, still a
// window, still with its own frame.
//
// **A view preference, not a property of the shop.** A GM on an ultrawide ticking a box
// and a player's laptop getting a shop that swallows the screen is the bad version. It is
// per client, remembered per shop, and a player with a big monitor gets it too.
//
// **It is not this layout stretched.** A 2560px window holding one column of shelves is
// worse than the window it replaced: forty-character rows with a metre of picture either
// side. Width buys *columns*, not longer rows -- but columns interact with the folds and
// the search, so this is stage one: the toggle, with the existing column capped at a
// readable width and centred, and a heavier veil under a picture that finally has room.
// Stage one may well be enough; stage two is recorded rather than guessed at.
//
// **Do not call it `maximize`.** ApplicationV2 already has `maximize()` and it means
// "un-minimise". A subclass overriding it would break Foundry's own minimise button.

import { MODULE } from './const.js';

/** Where each client remembers which shops it likes expanded. */
export const EXPANDED_SETTING = 'expandedShops';

/**
 * A client setting rather than a flag: this is a fact about a screen, not about a shop.
 *
 * `config: false` because it is not a question anybody answers in a settings tab -- it is
 * answered by pressing the button, and asking it twice in two places is how the two come
 * apart.
 */
export function registerExpandSetting() {
    game.settings.register(MODULE.ID, EXPANDED_SETTING, {
        scope: 'client',
        config: false,
        type: Object,
        default: {}
    });
}

function _remembered() {
    try {
        const stored = game.settings.get(MODULE.ID, EXPANDED_SETTING);
        return stored && typeof stored === 'object' ? stored : {};
    } catch (_error) {
        return {};
    }
}

/** Whether this client last left this shop expanded. */
export function wasExpanded(shopKey) {
    return shopKey ? _remembered()[shopKey] === true : false;
}

/**
 * Remember the choice, and forget it rather than storing a `false`.
 *
 * A map of every shop anybody has ever collapsed is a map that only grows, and "not in
 * the map" already means the same thing.
 */
export async function rememberExpanded(shopKey, expanded) {
    if (!shopKey) return;
    const next = { ..._remembered() };
    if (expanded) next[shopKey] = true;
    else delete next[shopKey];
    try {
        await game.settings.set(MODULE.ID, EXPANDED_SETTING, next);
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not remember the expanded shop:`, error);
    }
}

/**
 * The free rectangle of the Foundry viewport, clear of the furniture.
 *
 * **Measured, not assumed.** Sidebar widths change when it collapses, the hotbar can be
 * hidden, scene navigation grows a second row with enough scenes, and modules move all
 * three. Reading the elements that are actually there answers for every one of those; a
 * table of constants answers for the author's own screen on the day they wrote it.
 *
 * Each measurement is applied only if it is plausible -- a sidebar taking two thirds of
 * the width is not a sidebar, it is a selector that matched something else, and honouring
 * it would open the shop as a sliver. Anything implausible is ignored and the viewport
 * edge is used instead, which is wrong by a margin rather than wrong by a window.
 */
export function viewportGeometry() {
    const pad = 8;
    const doc = document.documentElement;
    const maxW = doc.clientWidth;
    const maxH = doc.clientHeight;

    let left = pad;
    let top = pad;
    let right = maxW - pad;
    let bottom = maxH - pad;

    const rect = (selector) => {
        const found = document.querySelector(selector);
        const box = found?.getBoundingClientRect?.();
        return box && box.width > 0 && box.height > 0 ? box : null;
    };

    const controls = rect('#ui-left');
    if (controls && controls.width < maxW / 3) left = Math.max(left, controls.right + pad);

    const sidebar = rect('#sidebar');
    if (sidebar && sidebar.width < maxW / 2) right = Math.min(right, sidebar.left - pad);

    const nav = rect('#navigation');
    if (nav && nav.height < maxH / 3) top = Math.max(top, nav.bottom + pad);

    const hotbar = rect('#hotbar');
    if (hotbar && hotbar.height < maxH / 3) bottom = Math.min(bottom, hotbar.top - pad);

    return {
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(Math.max(480, right - left)),
        height: Math.round(Math.max(360, bottom - top))
    };
}
