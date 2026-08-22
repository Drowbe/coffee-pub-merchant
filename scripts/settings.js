// ==================================================================
// ===== SETTINGS ===================================================
// ==================================================================
//
// Two families: what a shop sounds like, and how deep it stacks things.
//
// **World-scoped, played locally.** The GM chooses the shop's voice for the table --
// it is set dressing, and set dressing belongs to whoever built the scene -- but the
// sound plays only on the client that did the thing. Broadcasting would mean every
// player at the table hearing somebody else drop a rope into their own slate, which
// is noise rather than feedback.
//
// Choices come from Blacksmith's `arrSoundChoices`, so Merchant offers the same
// library every other Coffee Pub module does and ships no audio of its own. That
// object may not exist yet when settings register -- a world can load modules in an
// order where it does not -- so the list is refreshed on `blacksmithUpdated`, exactly
// as Curator does it. The pattern is copied deliberately: two modules solving this
// differently is how the next person learns it twice.

import { MODULE, STOCK_TYPE_CAPS, STOCK_RARITY_CAPS, typeCapKey, rarityCapKey } from './const.js';
import { MerchantManager } from './manager-merchant.js';

/** The sound settings, in the order they appear in the menu. */
export const SOUND_SETTINGS = Object.freeze([
    {
        key: 'soundSlateAdd',
        name: 'Adding to the slate',
        hint: 'Played when something is put on the slate, to buy or to sell.'
    },
    {
        key: 'soundSlateUpdate',
        name: 'Changing a slate line',
        hint: 'Played when a quantity or a price on the slate is changed.'
    },
    {
        key: 'soundSlateClear',
        name: 'Clearing the slate',
        hint: 'Played when a line is taken off the slate, or the whole slate is wiped.'
    },
    {
        key: 'soundTransaction',
        name: 'Completing a transaction',
        hint: 'Played when goods and coin change hands.'
    },
    {
        key: 'soundRestock',
        name: 'Restocking',
        hint: 'Played to the GM when an inventory or a whole shop finishes restocking.'
    },
    {
        key: 'soundError',
        name: 'Something went wrong',
        hint: 'Played when an action is refused or fails.'
    }
]);

// ==================================================================
// ===== STOCKING ===================================================
// ==================================================================
//
// **How deep a shop stacks a thing is a fact about the world, not about the shop.**
// How much rope exists, how freely plate armour moves, how many people have ever seen
// an artifact -- those are the same answers in every shop on the map, so they are set
// once here rather than restated on twelve cards. What an individual shop gets is one
// dial saying whether it is well supplied, which is on the inventory itself.
//
// Registered as plain numbers rather than behind a menu. Twelve numbers is a menu's
// worth of work to build and a menu's worth of clicking to reach, and Foundry already
// renders numbers in the module tab perfectly well.
//
// **Zero means no ceiling.** It is the honest default for "common", where type and
// price are already the whole answer and a third rule would only pretend to fire.

/** Sentence-case a camelCase key for a settings label: veryRare -> Very rare. */
function _label(key) {
    const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function registerStockingSettings() {
    for (const [type, cap] of Object.entries(STOCK_TYPE_CAPS)) {
        game.settings.register(MODULE.ID, typeCapKey(type), {
            name: `Stock depth: ${_label(type)}`,
            hint: `The most of one ${type} a shop stocks at once, before price and rarity are considered. `
                + '0 means no limit from the type.',
            scope: 'world',
            config: true,
            type: Number,
            default: cap
        });
    }

    for (const [rarity, cap] of Object.entries(STOCK_RARITY_CAPS)) {
        game.settings.register(MODULE.ID, rarityCapKey(rarity), {
            name: `Stock depth: ${_label(rarity)}`,
            hint: `The most of one ${_label(rarity).toLowerCase()} item a shop stocks at once. `
                + '0 means no limit from the rarity.',
            scope: 'world',
            config: true,
            type: Number,
            default: cap
        });
    }
}

function soundChoices() {
    return window.BlacksmithConstants?.arrSoundChoices
        ?? game.modules.get('coffee-pub-blacksmith')?.api?.BLACKSMITH?.arrSoundChoices
        ?? { none: 'None' };
}

export function registerSettings() {
    registerStockingSettings();

    const choices = soundChoices();

    for (const { key, name, hint } of SOUND_SETTINGS) {
        game.settings.register(MODULE.ID, key, {
            name,
            hint,
            scope: 'world',
            config: true,
            type: String,
            choices,
            // Silent by default. A module that starts making noises nobody asked for is
            // a module people turn off, and every one of these fires often.
            default: 'none'
        });
    }

    // The choice list can arrive after we register. Rebinding it in place updates the
    // dropdowns without touching anything a GM has already chosen.
    MerchantManager.hook('blacksmithUpdated', 'Re-read sound choices when Blacksmith republishes them', (data) => {
        if (data?.type !== 'ready') return;
        const later = soundChoices();
        if (!later || Object.keys(later).length <= 1) return;
        for (const { key } of SOUND_SETTINGS) {
            const setting = game.settings.settings.get(`${MODULE.ID}.${key}`);
            if (setting) setting.choices = later;
        }
    });
}
