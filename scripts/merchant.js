// ==================================================================
// ===== COFFEE PUB MERCHANT — ENTRY POINT ==========================
// ==================================================================

import { MODULE } from './const.js';
import { BlacksmithAPI } from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import { MerchantManager } from './manager-merchant.js';
import { MerchantConfigWindow } from './window-merchant-config.js';

/**
 * Add the way in to the Actor sheet header.
 *
 * `getHeaderControls{ClassName}` fires for every class in the sheet's inheritance
 * chain, so hooking the ApplicationV2 name catches any sheet without depending on
 * what dnd5e calls its own classes this version.
 *
 * Two entries by design: **Merchant Settings** is always present, because the way in
 * has to be reachable on an Actor that is not a merchant yet, and it costs one
 * unobtrusive menu row. **Open Shop** appears only once the Actor actually is one, so
 * nothing merchant-shaped clutters an ordinary NPC.
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

        if (MerchantManager.isMerchant(actor)) {
            controls.push({
                icon: 'fa-solid fa-cart-shopping',
                label: 'Open Shop',
                action: 'merchantOpenShop',
                onClick: () => {
                    // The shop window is token-shaped, since a shop is opened by
                    // interacting with a placed token. From the sheet, use the
                    // Actor's first token on the current scene.
                    const tokenDocument = actor.getActiveTokens(false, true)[0]
                        ?? canvas.scene?.tokens.find((t) => t.actorId === actor.id);
                    if (!tokenDocument) {
                        ui.notifications?.warn(`${actor.name} has no token on this scene.`);
                        return;
                    }
                    MerchantManager.openSafely(tokenDocument);
                }
            });
        }
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

    // Registered for every user, not just the GM: the interaction claim and the
    // request path both have to exist on a player's client.
    MerchantManager.initialize();
    registerSheetControls();

    // Exposed for the same reason Curator exposes its loot manager — the permission
    // bypass can only be verified from a non-GM client.
    const module = game.modules.get(MODULE.ID);
    if (module) module.api = { ...(module.api ?? {}), merchant: MerchantManager };

    console.log(`${MODULE.TITLE} | Ready.`);
});
