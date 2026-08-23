// ==================================================================
// ===== COFFEE PUB MERCHANT — ENTRY POINT ==========================
// ==================================================================

import { MODULE, PAR_FLAG, INVENTORY_FLAG, MARKET_LIMITS, DEFAULT_MARKET_RATE, FREE_FLAG } from './const.js';
import { marketRate, setMarketRate, marketLabel } from './utility-market.js';
import { ShopWindow } from './window-shop.js';
import { BlacksmithAPI } from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import { MerchantManager } from './manager-merchant.js';
import { registerSettings } from './settings.js';

/** Kept beside the pin in `module.json`; both have to move together. */
const REQUIRED_BLACKSMITH = '13.19.0';
import { registerToastChannels, notify } from './utility-feedback.js';
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
    MerchantManager.hook('getHeaderControlsApplicationV2', 'Merchant Settings on an Actor sheet', (app, controls) => {
        const actor = app?.document;
        if (actor?.documentName !== 'Actor') return;
        if (!game.user.isGM) return;

        controls.push({
            icon: 'fa-solid fa-shop',
            label: game.i18n.localize('coffee-pub-merchant.config.title'),
            action: 'merchantSettings',
            onClick: () => void MerchantConfigWindow.open(actor)
        });

    });
}

/**
 * The way in to a scene's market.
 *
 * On the **Scene** sheet, because that is what a market belongs to — every merchant
 * standing on that map prices against it, and a rate set on one shop would be a fact
 * about the place hidden inside one of the things in it.
 *
 * The same header-menu pattern as Merchant Settings on an Actor: always present, one
 * unobtrusive row, and it opens the control rather than being one.
 */
function registerSceneControls() {
    MerchantManager.hook('getHeaderControlsApplicationV2', 'Local Market on a Scene sheet', (app, controls) => {
        const scene = app?.document;
        if (scene?.documentName !== 'Scene') return;
        if (!game.user.isGM) return;

        controls.push({
            icon: 'fa-solid fa-scale-balanced',
            label: game.i18n.localize('coffee-pub-merchant.market.menuLabel'),
            action: 'merchantMarket',
            onClick: () => void openMarketDialog(scene)
        });
    });
}

/**
 * Set what goods are worth on this scene.
 *
 * A slider, like every other rate in this module, with the readout saying what the
 * number means rather than only what it is. Written on confirm rather than on drag:
 * this is a scene-wide fact, and a document write per pixel would be broadcast to
 * every client.
 */
async function openMarketDialog(scene) {
    const blacksmith = game.modules.get('coffee-pub-blacksmith')?.api;
    const current = marketRate(scene);

    if (typeof blacksmith?.dialog?.wait !== 'function') {
        notify.warn(game.i18n.localize('coffee-pub-merchant.notify.dialogUnavailable'));
        return;
    }

    let chosen = current;
    const content = `
        <p class="merchant-market-blurb">
            ${game.i18n.format('coffee-pub-merchant.market.blurb', { scene: `<strong>${foundry.utils.escapeHTML(scene.name)}</strong>` })}
        </p>
        <div class="merchant-market-control">
            <span class="merchant-config-rate-bound">&times;${MARKET_LIMITS.min.toFixed(2)}</span>
            <input type="range" min="${MARKET_LIMITS.min}" max="${MARKET_LIMITS.max}" step="0.05"
                   value="${current}" data-market-rate aria-label="${game.i18n.localize('coffee-pub-merchant.market.sliderLabel')}">
            <span class="merchant-config-rate-bound">&times;${MARKET_LIMITS.max.toFixed(2)}</span>
        </div>
        <div class="merchant-market-readout" data-market-readout>${marketLabel(current)}</div>`;

    const outcome = await blacksmith.dialog.wait({
        title: game.i18n.localize('coffee-pub-merchant.market.dialogTitle'),
        content,
        classes: ['merchant-dialog', 'merchant-market-dialog'],
        onRender: (element) => {
            const input = element.querySelector('[data-market-rate]');
            const readout = element.querySelector('[data-market-readout]');
            if (!input) return;
            input.addEventListener('input', () => {
                chosen = Number(input.value);
                if (readout) readout.textContent = marketLabel(chosen);
            });
        },
        buttons: [
            { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
            {
                action: 'reset',
                label: game.i18n.localize('coffee-pub-merchant.market.reset'),
                icon: 'fa-solid fa-rotate-left',
                callback: () => { chosen = DEFAULT_MARKET_RATE; }
            },
            { action: 'set', label: 'Set Market', icon: 'fa-solid fa-check', default: true }
        ],
        closeValue: null,
        cancelValue: null
    });

    if (outcome?.value !== 'set' && outcome?.value !== 'reset') return;

    try {
        const value = await setMarketRate(scene, chosen);
        notify.info(`${scene.name}: ${marketLabel(value)}`);
        // Every open shop on that scene is now priced differently.
        for (const win of ShopWindow.openWindows()) void win.render(false);
    } catch (error) {
        console.error(`${MODULE.TITLE} | Could not set the market:`, error);
        notify.error(game.i18n.localize('coffee-pub-merchant.notify.marketFailed'));
    }
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
    blacksmith.inventory?.registerTransientFlag?.(`${MODULE.ID}.${FREE_FLAG}`);

    // Sounds are a world setting read on every client, and the toast channels give a
    // GM a checkbox per class of message. Both before anything can want them.
    registerSettings();
    registerToastChannels();

    // **Migrate before anything starts listening.** Every shop configured under the
    // old schema needs walking over, and `initialize()` below registers a watcher that
    // broadcasts a refresh whenever our flags change — which is exactly what each
    // migration write is. Run the other way round, a world with twenty merchants fired
    // a hundred socket emits at load, all of them announcing a change nobody could see
    // yet. Migrate the data, then start listening to it.
    //
    // GM-only and idempotent — it stamps a schema version per merchant — and awaited
    // rather than fired and forgotten, so nothing below reads a half-migrated world.
    try {
        await MerchantManager.migrateWorld();
    } catch (error) {
        console.error(`${MODULE.TITLE} | Inventory migration failed:`, error);
    }

    // Registered for every user, not just the GM: the interaction claim and the
    // request path both have to exist on a player's client.
    MerchantManager.initialize();
    registerSheetControls();
    registerSceneControls();

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
