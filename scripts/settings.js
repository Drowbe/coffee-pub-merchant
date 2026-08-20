// ==================================================================
// ===== SETTINGS ===================================================
// ==================================================================
//
// Merchant's only settings are sounds: what a shop sounds like.
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

import { MODULE } from './const.js';

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

function soundChoices() {
    return window.BlacksmithConstants?.arrSoundChoices
        ?? game.modules.get('coffee-pub-blacksmith')?.api?.BLACKSMITH?.arrSoundChoices
        ?? { none: 'None' };
}

export function registerSettings() {
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
    Hooks.on('blacksmithUpdated', (data) => {
        if (data?.type !== 'ready') return;
        const later = soundChoices();
        if (!later || Object.keys(later).length <= 1) return;
        for (const { key } of SOUND_SETTINGS) {
            const setting = game.settings.settings.get(`${MODULE.ID}.${key}`);
            if (setting) setting.choices = later;
        }
    });
}
