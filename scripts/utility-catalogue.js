// ==================================================================
// ===== THE CATALOGUE ==============================================
// ==================================================================
//
// **A shop you can reach from anywhere, because somebody handed you the list.**
//
// A token, a pin and a region are all *places*: you open the shop by being somewhere. A
// catalogue is the shop as an **object** — a bound list of goods, a trade circular, a
// merchant's card — that sits in a character's pack and opens the same window from
// wherever they are reading it.
//
// It is the fourth door, and deliberately not a fourth way of resolving a shop: it names
// an Actor and hands it to `openForActor`, exactly as a pin does. One shop, one window,
// one cart, whichever door you came through.
//
// ===== WHY AN ITEM ================================================
//
// Because the fiction already has one. A party who bought a catalogue can lose it, sell
// it, lend it to the rogue, or leave it behind — and every one of those is a thing an
// Item does for free, in front of the players, with no rule of ours attached. Anything
// else (a journal, a macro, a chat button) would be the same feature with a worse story
// and more machinery.
//
// It is a **consumable**, which is not a comment on the fiction: consumable is the item
// type dnd5e gives activities to and does not otherwise interfere with. Nothing is
// consumed — the activity configures no consumption — so consulting it a hundred times
// leaves the same one catalogue.
//
// ===== WHAT IT REMEMBERS ==========================================
//
// The merchant's uuid, and a snapshot of the shop taken when it was printed. The snapshot
// is for the same case the pin's is: an Actor that has been deleted takes its
// configuration with it, and a catalogue for a shop that has closed down should open on
// the abandoned card under the name it was printed with rather than fail.

import { MODULE, MERCHANT_FLAG, shopSnapshot, shopKind } from './const.js';
import { canPin } from './utility-pins.js';
import { notify } from './utility-feedback.js';

/** Where a catalogue keeps the shop it names. */
export const CATALOGUE_FLAG = 'catalogue';

/**
 * Whether an Actor can have a catalogue printed of it.
 *
 * **The same rule as a pin, asked once.** A catalogue outlives tokens and scenes, so what
 * it names has to outlive them too — and an unlinked token is a copy, whose stock is its
 * own. Printing a catalogue of one would name a mould rather than a shop.
 */
export function canPrint(actor) {
    return canPin(actor);
}

/** What a catalogue names, or null if this item is not one. */
export function catalogueOf(item) {
    const record = item?.getFlag?.(MODULE.ID, CATALOGUE_FLAG);
    return record && typeof record === 'object' && record.actorUuid ? record : null;
}

/**
 * Print a catalogue of this shop into the world's Items directory.
 *
 * **Into the directory, not onto somebody.** Who gets it is a decision about the fiction —
 * bought, found, given by a contact — and the GM makes it by dragging, which is the
 * gesture they already use for every other item that changes hands. Asking "which
 * character?" here would be a question with no good default, in the middle of a different
 * task.
 *
 * The activity is what makes it usable: without one, dnd5e's sheet has nothing to click
 * and the item merely expands its description. It is created after the Item because
 * `createActivity` is dnd5e's own path and gets the shape right; hand-writing the
 * activity's data into the creation would be us guessing at a system's schema.
 */
export async function printCatalogue(actor) {
    if (!game.user.isGM || !actor) return null;

    const config = actor.getFlag(MODULE.ID, MERCHANT_FLAG) ?? null;
    const snapshot = shopSnapshot(actor, config);
    const kind = shopKind(snapshot.kind);
    const name = game.i18n.format('coffee-pub-merchant.catalogue.itemName', {
        shop: snapshot.name ?? actor.name
    });

    try {
        // `getDocumentClass` rather than the global `Item`, which Foundry has been
        // deprecating: this manifest allows v14, where the globals are gone.
        const ItemClass = foundry.utils.getDocumentClass?.('Item') ?? globalThis.getDocumentClass?.('Item') ?? globalThis.Item;
        const item = await ItemClass.create({
            name,
            type: 'consumable',
            // A trinket, because it is a thing you carry that does nothing on its own. The
            // subtype has to be one dnd5e knows or the sheet shows a blank type row.
            img: snapshot.illustration || snapshot.portrait || 'icons/sundries/documents/document-official-capital.webp',
            system: {
                type: { value: 'trinket' },
                description: { value: catalogueDescription(snapshot, kind) },
                quantity: 1,
                weight: { value: 0.1, units: 'lb' },
                price: { value: 0, denomination: 'gp' }
            },
            flags: {
                [MODULE.ID]: {
                    [CATALOGUE_FLAG]: {
                        actorUuid: actor.uuid,
                        shopName: snapshot.name ?? actor.name,
                        remembered: snapshot
                    }
                }
            }
        });
        if (!item) return null;

        // Optional-chained: a system without activities still leaves a usable catalogue,
        // because the sheet header button opens it too. This is the good path, not the
        // only one.
        if (typeof item.createActivity === 'function') {
            await item.createActivity('utility', {
                name: game.i18n.localize('coffee-pub-merchant.catalogue.activity')
            }, { renderSheet: false });
        }

        notify.info(game.i18n.format('coffee-pub-merchant.catalogue.printed', { name: item.name }));
        return item;
    } catch (error) {
        console.error(`${MODULE.TITLE} | Could not print a catalogue for ${actor.name}:`, error);
        notify.error(game.i18n.localize('coffee-pub-merchant.notify.cataloguePrintFailed'));
        return null;
    }
}

/**
 * What the catalogue says on the inside.
 *
 * The shop's own blurb where there is one, because a GM who has written about the place
 * has already written the catalogue's foreword. Then a plain line saying what to do with
 * it — a player who has never seen one of these needs to be told once that it opens.
 */
export function catalogueDescription(snapshot, kind) {
    const blurb = String(snapshot?.description ?? '').trim();
    const line = `<p><em>${game.i18n.localize('coffee-pub-merchant.catalogue.blurb')}</em></p>`;
    const heading = `<p><i class="${kind?.icon ?? 'fa-solid fa-shop'}"></i> <strong>${
        foundry.utils.escapeHTML(snapshot?.name ?? '')}</strong> &mdash; ${
        foundry.utils.escapeHTML(kind?.label ?? '')}</p>`;
    return `${heading}${blurb}${line}`;
}

/**
 * Open the shop a catalogue names.
 *
 * **Placeless, and that is the point.** A shop reached by standing in front of it is
 * priced against the scene it stands on — the local market rate, and the party's standing
 * here. A catalogue is explicitly about *not* being there, so it names no scene and is
 * priced at the default market. Handing it the reader's own scene would price a shop in
 * another town against the rate where the reader happens to be standing, and the GM's
 * side would refuse that claim anyway: `verifiedScene` only honours a scene the merchant
 * actually has a token on. A window showing one figure while the settlement charges
 * another is worse than a plain answer.
 */
export async function openCatalogue(item) {
    const record = catalogueOf(item);
    if (!record) return null;

    // Late import: this module is reached from the manager's own hooks, and importing the
    // manager at evaluation would close the circle at load rather than at call.
    const { MerchantManager } = await import('./manager-merchant.js');
    const { ShopWindow } = await import('./window-shop.js');

    let actor = null;
    try {
        actor = await fromUuid(record.actorUuid);
    } catch (_error) {
        actor = null;
    }

    if (actor && MerchantManager.isMerchant(actor)) {
        return MerchantManager.openForActor(actor, { placeless: true });
    }

    // The shop has closed down. The catalogue is a leaflet for somewhere that is not there
    // any more, which is a thing that happens to leaflets — so it opens on the abandoned
    // card under the name it was printed with, rather than refusing and looking broken.
    return ShopWindow.openFor(record.actorUuid, {
        sceneUuid: null,
        shopName: record.shopName ?? null,
        remembered: record.remembered ?? null
    });
}

// ==================================================================
// ===== THE WAY IN =================================================
// ==================================================================

/**
 * Two doors into one catalogue, and both are needed.
 *
 * **Using it** is the one players will find: dnd5e fires `dnd5e.preUseActivity` for the
 * click on an item's name, and returning `false` there cancels the roll — there is no
 * chat card, no consumption, nothing but the shop opening. That is the right shape: a
 * catalogue is not an attack and should not post one.
 *
 * **The sheet header** is the one that always works. An activity can be deleted, a system
 * can rename its hook, and a GM inspecting a catalogue in the sidebar has no character to
 * use it as. One line of menu costs nothing and means a catalogue is never a dead object.
 */
export function registerCatalogue(hook) {
    hook('dnd5e.preUseActivity', 'Open the shop when a catalogue is consulted', (activity) => {
        const item = activity?.item;
        if (!catalogueOf(item)) return;
        void openCatalogue(item);
        // Cancels the roll. Every other module's callback on this hook has already run or
        // will still run -- Foundry calls them all -- so this refuses one activity rather
        // than blocking the hook.
        return false;
    }, { canCancel: true });

    hook('getHeaderControlsApplicationV2', 'Open Merchant on a catalogue sheet', (app, controls) => {
        const item = app?.document;
        if (item?.documentName !== 'Item' || !catalogueOf(item)) return;

        controls.push({
            icon: 'fa-solid fa-shop',
            label: game.i18n.localize('coffee-pub-merchant.catalogue.open'),
            action: 'merchantCatalogue',
            onClick: () => void openCatalogue(item)
        });
    });
}
