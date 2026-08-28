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
    MODULE, STOCK_TYPE_CAPS, STOCK_RARITY_CAPS, typeCapKey, rarityCapKey, MAX_STOCK_CAP,
    DEFAULT_PIN_DESIGN, PIN_DESIGN_SETTINGS
} from './const.js';
import { MerchantManager } from './manager-merchant.js';
import { playSoundPath } from './utility-feedback.js';

/**
 * The sound settings, in the order they appear in the menu.
 *
 * **A shop has a voice out of the box.** These used to default to silence, on the argument
 * that a module making noises nobody asked for is a module people turn off -- true of a
 * module that decides *when* to speak, and this one only ever speaks because a person just
 * did something. Silence made the feature look broken instead: a GM who never opens the
 * settings tab never hears the counter at all, and one who does has forty file names to
 * audition before knowing what the module sounds like. Every default is a Blacksmith
 * sound, so nothing ships here, and `none` is one click away on any row.
 */
export const SOUND_SETTINGS = Object.freeze([
    {
        key: 'soundSlateAdd',
        nameKey: 'coffee-pub-merchant.settings.soundSlateAdd',
        hintKey: 'coffee-pub-merchant.settings.soundSlateAddHint',
        sound: 'sound-interface-button-08'
    },
    {
        key: 'soundSlateUpdate',
        nameKey: 'coffee-pub-merchant.settings.soundSlateUpdate',
        hintKey: 'coffee-pub-merchant.settings.soundSlateUpdateHint',
        sound: 'sound-interface-button-01'
    },
    {
        key: 'soundSlateClear',
        nameKey: 'coffee-pub-merchant.settings.soundSlateClear',
        hintKey: 'coffee-pub-merchant.settings.soundSlateClearHint',
        sound: 'sound-interface-notification-11'
    },
    {
        key: 'soundTransaction',
        nameKey: 'coffee-pub-merchant.settings.soundTransaction',
        hintKey: 'coffee-pub-merchant.settings.soundTransactionHint',
        sound: 'sound-general-clatter'
    },
    {
        key: 'soundRestock',
        nameKey: 'coffee-pub-merchant.settings.soundRestock',
        hintKey: 'coffee-pub-merchant.settings.soundRestockHint',
        sound: 'sound-interface-button-08'
    },
    {
        key: 'soundError',
        nameKey: 'coffee-pub-merchant.settings.soundError',
        hintKey: 'coffee-pub-merchant.settings.soundErrorHint',
        sound: 'sound-interface-error-05'
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

// **No per-setting hint, deliberately.** Thirteen rows each re-teaching the same model --
// "the most of one X a shop stocks at once, 0 means no limit" -- is harder to scan than
// thirteen labelled sliders, and it buries the one thing a reader has to be told: that
// `Common: 0` means *no limit from rarity*, not *no common items*. That rule is stated
// once, in the section heading above these, where it stays visible while the sliders are
// read. Explain the system at the section level; label the controls at the control level.

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
            scope: 'world',
            config: true,
            type: Number,
            range: CAP_RANGE,
            default: cap
        });
    }
}

/**
 * A play button beside each sound dropdown.
 *
 * **Choosing a sound you cannot hear is choosing blind.** Six dropdowns of file names is a
 * list of guesses otherwise -- and the alternative, saving and then triggering the thing
 * in play to find out, is a slow way to audition forty files.
 *
 * It plays **what the dropdown currently says**, not what is saved. A GM scrolling the list
 * wants to hear the one under the cursor; making them commit first would be the same slow
 * loop with an extra step. And it is disabled on `none`, because a button that silently
 * does nothing reads as broken.
 *
 * Injected on `renderSettingsConfig` because Foundry has no hook for "add a control to this
 * setting" -- a setting renders as a label, a hint and one field. Kept to appending a button
 * inside the field cell: rebuilding the row would mean reimplementing in CSS what Foundry
 * already renders, which is exactly the mistake `api-toast` records making.
 */
function bindSoundPreviews(root) {
    if (!root) return;
    for (const { key } of SOUND_SETTINGS) {
        const select = root.querySelector(`select[name="${MODULE.ID}.${key}"]`);
        if (!select || select.dataset.merchantPreview === 'true') continue;
        select.dataset.merchantPreview = 'true';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'merchant-settings-preview';
        button.innerHTML = '<i class="fa-solid fa-play"></i>';
        button.dataset.tooltip = game.i18n.localize('coffee-pub-merchant.settings.previewSound');
        button.disabled = !select.value || select.value === 'none';

        button.addEventListener('click', (event) => {
            // The settings window is a form; a bare button in one submits it.
            event.preventDefault();
            playSoundPath(select.value);
        });
        select.addEventListener('change', () => {
            button.disabled = !select.value || select.value === 'none';
        });

        select.after(button);
    }
}

// ==================================================================
// ===== PINS =======================================================
// ==================================================================
//
// **What a shop pin looks like is the GM's answer for their world, not a constant.** A
// map has a visual language and a module dropping its own house style onto it is a module
// somebody turns off. The icon is deliberately *not* here: it comes from the shop's kind,
// so an apothecary and a weaponsmith are told apart without anybody configuring anything.

function registerPinSettings() {
    registerHeader('Pins', 'H2',
        'coffee-pub-merchant.settings.headingPins',
        'coffee-pub-merchant.settings.headingPinsHint');

    // No per-setting hints: six of them under a section that already explains the model is
    // the noise the stock ceilings carried until it was taken out.
    for (const setting of PIN_DESIGN_SETTINGS) {
        const definition = {
            name: game.i18n.localize(setting.nameKey),
            scope: 'world',
            config: true,
            type: setting.range ? Number : String,
            default: DEFAULT_PIN_DESIGN[setting.key]
        };
        if (setting.range) definition.range = setting.range;
        if (setting.choices) {
            definition.choices = Object.fromEntries(setting.choices.map(({ value, labelKey }) => [
                value, game.i18n.localize(labelKey)
            ]));
        }
        game.settings.register(MODULE.ID, setting.key, definition);
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
    registerPinSettings();

    registerHeader('Sound', 'H2',
        'coffee-pub-merchant.settings.headingSound',
        'coffee-pub-merchant.settings.headingSoundHint');

    const choices = soundChoices();

    // **Keys in the table, text at registration.** The table is a module-scope `const`,
    // so anything resolved in it runs before `game` exists; `registerSettings` runs on
    // `init`, by which time it does.
    for (const { key, nameKey, hintKey, sound } of SOUND_SETTINGS) {
        game.settings.register(MODULE.ID, key, {
            name: game.i18n.localize(nameKey),
            hint: game.i18n.localize(hintKey),
            scope: 'world',
            config: true,
            type: String,
            choices,
            default: sound
        });
    }

    // The element arrives as the second argument under ApplicationV2 and as a jQuery
    // wrapper under the older one; both are handled rather than pinned, because this is
    // cosmetic and must never be the thing that breaks a settings window.
    MerchantManager.hook('renderSettingsConfig', 'Add a play button beside each sound', (_app, html) => {
        const root = html instanceof HTMLElement ? html : (html?.[0] ?? html?.element ?? null);
        try {
            bindSoundPreviews(root);
        } catch (error) {
            console.warn(`${MODULE.TITLE} | Could not add the sound preview buttons:`, error);
        }
    });

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
