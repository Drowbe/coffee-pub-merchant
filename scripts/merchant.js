// ==================================================================
// ===== COFFEE PUB MERCHANT — ENTRY POINT ==========================
// ==================================================================

import { MODULE, PAR_FLAG, INVENTORY_FLAG } from './const.js';
import { BlacksmithAPI } from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import { MerchantManager } from './manager-merchant.js';
import { registerSettings } from './settings.js';

/** Kept beside the pin in `module.json`; both have to move together. */
const REQUIRED_BLACKSMITH = '13.19.0';
import { registerToastChannels } from './merchant-feedback.js';
import { MerchantConfigWindow } from './window-merchant-config.js';

/**
 * Add the way in to the Actor sheet header.
 *
 * `getHeaderControls{ClassName}` fires for every class in the sheet's inheritance
 * chain, so hooking the ApplicationV2 name catches any sheet without depending on
 * what dnd5e calls its own classes this version.
 *
 * One entry: **Merchant Settings**, always present, because the way in has to be
 * reachable on an Actor that is not a merchant yet and it costs one unobtrusive menu
 * row. Opening the shop itself is the token's job — double-click it — so the sheet
 * carries setup and nothing else.
 */
function registerSheetControls() {
    Hooks.on('getHeaderControlsApplicationV2', (app, controls) => {
        const actor = app?.document;
        if (actor?.documentName !== 'Actor') return;
        if (!game.user.isGM) return;

        controls.push({
            icon: 'fa-solid fa-shop',
            label: 'Merchant Settings',
            action: 'merchantSettings',
            onClick: () => void MerchantConfigWindow.open(actor)
        });

    });
}

Hooks.once('ready', async function () {
    const blacksmith = game.modules.get('coffee-pub-blacksmith')?.api;
    if (!blacksmith) {
        console.warn(`${MODULE.TITLE} | Blacksmith not found; Merchant cannot start.`);
        return;
    }

    // module.api is assigned early; window globals wire up later. Wait so nothing
    // below calls a helper that is not there yet.
    if (typeof BlacksmithAPI.waitForReady === 'function') {
        await BlacksmithAPI.waitForReady();
    }

    try {
        if (window.BlacksmithModuleManager) {
            window.BlacksmithModuleManager.registerModule(MODULE.ID, {
                name: MODULE.TITLE,
                version: game.modules.get(MODULE.ID)?.version || MODULE.VERSION
            });
        }
    } catch (error) {
        console.error(`${MODULE.TITLE} | Failed to register with Blacksmith:`, error);
    }

    // **Declare every flag Merchant writes to an item.** Merge identity is
    // deep-equal flags, so an undeclared flag makes two otherwise identical stacks
    // refuse to merge — and worse, makes it depend on whether our write has landed
    // yet, which no other module can see coming. The obligation sits with whoever
    // writes the flag, and that is us.
    //
    // Both qualify: a restock target and an inventory's configuration describe where a
    // thing is kept, not what it is. Two identical potions are the same potion
    // whether the shop keeps six of them or three.
    //
    // Optional-chained because it lands with api.inventory, which may be newer than
    // the Blacksmith a given world has installed.
    blacksmith.inventory?.registerTransientFlag?.(`${MODULE.ID}.${PAR_FLAG}`);
    blacksmith.inventory?.registerTransientFlag?.(`${MODULE.ID}.${INVENTORY_FLAG}`);

    // Sounds are a world setting read on every client, and the toast channels give a
    // GM a checkbox per class of message. Both before anything can want them.
    registerSettings();
    registerToastChannels();

    // Registered for every user, not just the GM: the interaction claim and the
    // request path both have to exist on a player's client.
    MerchantManager.initialize();
    registerSheetControls();

    // Shelves became typed inventories and the stored flag moved with the word, so
    // every shop configured before that needs walking over. GM-only and idempotent —
    // it stamps a schema version per merchant — and awaited here rather than fired
    // and forgotten, so nothing reads a half-migrated world.
    try {
        await MerchantManager.migrateWorld();
    } catch (error) {
        console.error(`${MODULE.TITLE} | Inventory migration failed:`, error);
    }

    // Exposed for the same reason Curator exposes its loot manager — the permission
    // bypass can only be verified from a non-GM client.
    const module = game.modules.get(MODULE.ID);
    if (module) module.api = { ...(module.api ?? {}), merchant: MerchantManager };

    // A Blacksmith older than the APIs this module calls fails in ways that look like
    // Merchant bugs: `readIdsFrom` is absent, so picking a character throws a
    // TypeError from a click that should have opened a dialog. `module.json` pins the
    // minimum and Foundry enforces it on install -- this catches the world where
    // somebody downgraded Blacksmith afterwards, and says which of the two is wrong.
    const blacksmithVersion = game.modules.get('coffee-pub-blacksmith')?.version;
    if (blacksmithVersion && foundry.utils.isNewerVersion(REQUIRED_BLACKSMITH, blacksmithVersion)) {
        const message = `${MODULE.TITLE} needs Coffee Pub Blacksmith ${REQUIRED_BLACKSMITH} or newer; `
            + `this world has ${blacksmithVersion}. Shopping will fail until it is updated.`;
        console.error(`${MODULE.TITLE} | ${message}`);
        if (game.user.isGM) ui.notifications?.error(message, { permanent: true });
    }

    console.log(`${MODULE.TITLE} | Ready.`);
});
