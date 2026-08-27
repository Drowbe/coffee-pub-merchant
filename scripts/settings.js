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

import {
    MODULE, STOCK_TYPE_CAPS, STOCK_RARITY_CAPS, typeCapKey, rarityCapKey, MAX_STOCK_CAP
} from './const.js';
import { MerchantManager } from './manager-merchant.js';

/** The sound settings, in the order they appear in the menu. */
export const SOUND_SETTINGS = Object.freeze([
    {
        key: 'soundSlateAdd',
        nameKey: 'coffee-pub-merchant.settings.soundSlateAdd',
        hintKey: 'coffee-pub-merchant.settings.soundSlateAddHint'
    },
    {
        key: 'soundSlateUpdate',
        nameKey: 'coffee-pub-merchant.settings.soundSlateUpdate',
        hintKey: 'coffee-pub-merchant.settings.soundSlateUpdateHint'
    },
    {
        key: 'soundSlateClear',
        nameKey: 'coffee-pub-merchant.settings.soundSlateClear',
        hintKey: 'coffee-pub-merchant.settings.soundSlateClearHint'
    },
    {
        key: 'soundTransaction',
        nameKey: 'coffee-pub-merchant.settings.soundTransaction',
        hintKey: 'coffee-pub-merchant.settings.soundTransactionHint'
    },
    {
        key: 'soundRestock',
        nameKey: 'coffee-pub-merchant.settings.soundRestock',
        hintKey: 'coffee-pub-merchant.settings.soundRestockHint'
    },
    {
        key: 'soundError',
        nameKey: 'coffee-pub-merchant.settings.soundError',
        hintKey: 'coffee-pub-merchant.settings.soundErrorHint'
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

/**
 * A heading row in the module's settings tab.
 *
 * **The suite's convention, not a Merchant invention.** Blacksmith's `settings.css` styles
 * any setting whose key starts `headingH1`..`headingH4` in a `coffee-pub-*` module -- it
 * hides the (empty) control and renders the label and hint as a section header. Squire and
 * Blacksmith both use it; Merchant was the odd one out, registering eighteen flat rows with
 * no structure, which is why its settings tab looked like a different module's.
 *
 * The stored value is an empty string nobody reads. That is the whole trick: a setting is
 * the only thing Foundry will render in this list, so a header has to be one.
 */
function registerHeader(id, level, nameKey, hintKey) {
    game.settings.register(MODULE.ID, `heading${level}${id}`, {
        name: game.i18n.localize(nameKey),
        hint: game.i18n.localize(hintKey),
        scope: 'world',
        config: true,
        type: String,
        default: ''
    });
}

/** Sentence-case a camelCase key for a settings label: veryRare -> Very rare. */
function _label(key) {
    const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * **A range, not a number box.** Every one of these is a small integer with a floor, a
 * ceiling and no meaningful decimal -- which is what a slider is for, and what the rest of
 * the suite uses for the same shape of answer. A bare number field invites 250 into a
 * question whose largest sensible answer is a dozen, and reads as though it wanted one.
 *
 * The top is `MAX_STOCK_CAP`: past that a "ceiling" is not capping anything a shop would
 * ever draw, and a slider whose useful travel is its first tenth is a number box with a
 * worse hit area.
 */
const CAP_RANGE = Object.freeze({ min: 0, max: MAX_STOCK_CAP, step: 1 });

function registerStockingSettings() {
    registerHeader('StockDepth', 'H2',
        'coffee-pub-merchant.settings.headingStockDepth',
        'coffee-pub-merchant.settings.headingStockDepthHint');

    registerHeader('StockByType', 'H3',
        'coffee-pub-merchant.settings.headingStockByType',
        'coffee-pub-merchant.settings.headingStockByTypeHint');
    for (const [type, cap] of Object.entries(STOCK_TYPE_CAPS)) {
        game.settings.register(MODULE.ID, typeCapKey(type), {
            name: game.i18n.format('coffee-pub-merchant.settings.stockCapType', { what: _label(type) }),
            hint: game.i18n.format('coffee-pub-merchant.settings.stockCapTypeHint', { type }),
            scope: 'world',
            config: true,
            type: Number,
            range: CAP_RANGE,
            default: cap
        });
    }

    registerHeader('StockByRarity', 'H3',
        'coffee-pub-merchant.settings.headingStockByRarity',
        'coffee-pub-merchant.settings.headingStockByRarityHint');
    for (const [rarity, cap] of Object.entries(STOCK_RARITY_CAPS)) {
        game.settings.register(MODULE.ID, rarityCapKey(rarity), {
            name: game.i18n.format('coffee-pub-merchant.settings.stockCapRarity', { what: _label(rarity) }),
            hint: game.i18n.format('coffee-pub-merchant.settings.stockCapRarityHint', { rarity: _label(rarity).toLowerCase() }),
            scope: 'world',
            config: true,
            type: Number,
            range: CAP_RANGE,
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
    registerHeader('Merchant', 'H1',
        'coffee-pub-merchant.settings.headingMerchant',
        'coffee-pub-merchant.settings.headingMerchantHint');

    registerStockingSettings();

    registerHeader('Sound', 'H2',
        'coffee-pub-merchant.settings.headingSound',
        'coffee-pub-merchant.settings.headingSoundHint');

    const choices = soundChoices();

    // **Keys in the table, text at registration.** The table is a module-scope `const`,
    // so anything resolved in it runs before `game` exists; `registerSettings` runs on
    // `init`, by which time it does.
    for (const { key, nameKey, hintKey } of SOUND_SETTINGS) {
        game.settings.register(MODULE.ID, key, {
            name: game.i18n.localize(nameKey),
            hint: game.i18n.localize(hintKey),
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
