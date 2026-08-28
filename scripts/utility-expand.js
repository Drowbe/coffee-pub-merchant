// ==================================================================
// ===== WHICH SHOPS THIS CLIENT LIKES FULL SCREEN ==================
// ==================================================================
//
// **This file is only the memory.** The surface itself is Blacksmith's:
// `ShopFullscreenWindow` in `window-shop.js` extends `BlacksmithFullscreenWindowBaseV2`
// with the `full` layout and hands it the shop's illustration as `fullscreenBackdrop`.
// The covering, the blocking, the stacking, the fade and the backdrop layer are all the
// hub's, and Request a Roll's cinematic is the same class.
//
// **The first version of this was wrong in a way worth recording.** It measured the free
// rectangle between the sidebar, the scene controls and the hotbar, resized the ordinary
// tool window into it, and imitated a takeover in CSS. That is *maximise* -- something
// anybody can already do by dragging a corner -- and it looked it: a parchment panel with
// a title bar, the map still showing around it, and the shop's furniture marooned in a
// field of empty background. Two hundred lines of stylesheet reimplementing, worse, a
// component the hub already ships.
//
// **A view preference, not a property of the shop.** A GM on an ultrawide ticking a box
// and a player's laptop getting a shop that swallows the screen is the bad version. It is
// per client, remembered per shop, and a player with a big monitor gets it too. That is
// all this file holds: which shops this client last left full screen.

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
