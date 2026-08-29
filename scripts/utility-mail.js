// ==================================================================
// ===== MAIL ORDER =================================================
// ==================================================================
//
// **A catalogue shelf is a warehouse, and nothing on one is carried out of the shop.**
//
// Ordering takes the coin now and the goods come later, by a service the buyer chooses and
// pays for. That is what earns the delay and the fee, rather than bolting them onto a shop
// that could perfectly well have handed the thing over.
//
// ===== THE RECEIPT IS THE PARCEL ==================================
//
// One Item, twice. Ordering creates a **receipt** in the buyer's possession carrying the
// whole consignment; when the clock reaches the arrival time that same Item is **renamed
// and filled** — it becomes the parcel it was promising.
//
// It is created as a **container from the outset** rather than converted on delivery,
// because an Item's `type` is not a thing to change under a system that has opinions about
// subtypes. A receipt is simply an empty container, which is also what a receipt *is*.
//
// This is where a pending order lives, and it is a better answer than a queue in a flag
// somewhere: it is an object the players can see, it survives sessions and the merchant
// being deleted, and it can be lost, sold, stolen or found — which is the whole point of
// building mail order rather than a faster buy button.
//
// ===== WHAT IT CARRIES ============================================
//
// **Item source data, not uuids.** This is the decision the robustness of the feature turns
// on. A uuid dangles the day the merchant is deleted or the shelf is cleared, and a parcel
// whose contents evaporated because a shop closed down is the worst possible bug for a
// feature whose entire subject is things being in transit. The goods **left the warehouse**
// when the order was placed; the parcel carries them.

import {
    MODULE, RECEIPT_FLAG, PAR_FLAG, FREE_FLAG, DELIVERY_SERVICES, DEFAULT_DELIVERY_SERVICE, deliveryService,
    deliveryDaysKey, deliveryFeeKey, arrivalTime, daysUntil, deliveryPointFor, customDestinations,
    DELIVERY_POINT
} from './const.js';
import { toBase, formatBase } from './utility-pricing.js';

/** The image a receipt wears, and the one a parcel wears once it has been filled. */
const RECEIPT_IMG = 'icons/sundries/documents/document-sealed-brown-red.webp';
const PARCEL_IMG = 'icons/containers/boxes/crate-wooden-tied-brown.webp';

function setting(key, fallback) {
    try {
        const value = game.settings.get(MODULE.ID, key);
        return value === undefined || value === null ? fallback : value;
    } catch (_error) {
        return fallback;
    }
}

// ==================================================================
// ===== WHAT A SERVICE COSTS AND HOW LONG IT TAKES =================
// ==================================================================

/**
 * A service as this world has it configured.
 *
 * The table in `const.js` is the shipped answer; a GM's settings are the world's. Both
 * numbers are read here rather than at every call site, so a service is one object with a
 * name, a price and a duration wherever it is used.
 */
export function serviceFor(key) {
    const definition = deliveryService(key);
    return {
        ...definition,
        days: Math.max(0, Number(setting(deliveryDaysKey(definition.key), definition.days)) || 0),
        feeGp: Math.max(0, Number(setting(deliveryFeeKey(definition.key), definition.feeGp)) || 0)
    };
}

/** Every service, as configured. For the picker on the slate. */
export function services() {
    return DELIVERY_SERVICES.map((service) => serviceFor(service.key));
}

/** What a service charges, in base units, so it can be added to a total. */
export function feeBase(key) {
    return toBase(serviceFor(key).feeGp, 'gp');
}

/**
 * How a delivery reads on the slate and on the receipt.
 *
 * "Arrives tomorrow" rather than "arrives in 1 days", because the one place a reader meets
 * this is a sentence.
 */
export function arrivalLabel(arrivesAt, now = null) {
    const days = daysUntil(arrivesAt, now ?? (game.time?.worldTime ?? 0));
    if (days <= 0) return game.i18n.localize('coffee-pub-merchant.delivery.arrivesTomorrow');
    if (days === 1) return game.i18n.localize('coffee-pub-merchant.delivery.arrivesTomorrow');
    return game.i18n.format('coffee-pub-merchant.delivery.arrives', { days });
}

/**
 * Everywhere a parcel can be sent by this service.
 *
 * **The world's shops plus the GM's own list.** A merchant carrying the matching flag is
 * offering to take parcels, and `worldMerchants` already enumerates every linked merchant
 * in the world — there is no separate register to keep, and one would only drift from the
 * Actors it was describing. Alongside them, a free-text list per merchant, because not
 * every place a parcel can go is a shop somebody has built: a safehouse, a poste restante,
 * a name a party made up.
 *
 * A beast returns nothing, and that is not an empty list — it is the answer. It goes
 * looking for whoever is holding the receipt, which is what its price buys.
 */
export function destinationsFor(service, merchantConfig) {
    const point = deliveryPointFor(service);
    if (!point) return null;

    const places = new Set();

    // Late import: this reaches the manager, which reaches this file back. Inside a
    // function, so the binding resolves at call time rather than at load.
    const manager = globalThis.game?.modules?.get(MODULE.ID)?.api?.merchant;
    for (const actor of manager?.worldMerchants?.() ?? []) {
        const config = manager.getConfig(actor);
        if (config?.[point] === true) places.add(config.name || actor.name);
    }

    const custom = point === DELIVERY_POINT.PORTAL
        ? merchantConfig?.portalLocations
        : merchantConfig?.physicalLocations;
    for (const place of customDestinations(custom)) places.add(place);

    return [...places].sort((a, b) => a.localeCompare(b));
}

/** What to say when a service asks for nowhere, or when nowhere is on offer. */
export function destinationNote(service, list) {
    if (list === null) return game.i18n.localize('coffee-pub-merchant.delivery.beastNote');
    if (list.length) return '';
    return deliveryPointFor(service) === DELIVERY_POINT.PORTAL
        ? game.i18n.localize('coffee-pub-merchant.delivery.noPortal')
        : game.i18n.localize('coffee-pub-merchant.delivery.noPhysical');
}

// ==================================================================
// ===== THE CONSIGNMENT ============================================
// ==================================================================

/** What a receipt is carrying, or null if this Item is not one. */
export function consignmentOf(item) {
    const record = item?.getFlag?.(MODULE.ID, RECEIPT_FLAG);
    return record && typeof record === 'object' && Array.isArray(record.items) ? record : null;
}

/** Whether this consignment has already been handed over. */
export function isDelivered(record) {
    return record?.delivered === true;
}

/**
 * The order, written out as a sentence a player can read on the Item.
 *
 * A receipt is an Item somebody will open, and *what is coming and when* has to be legible
 * there rather than only in a notification they may have missed. Plain text in the
 * description, not a rendered template: this is written once at order time and read on a
 * sheet Merchant does not own.
 */
export function manifestHtml(record) {
    const service = serviceFor(record.service);
    const goods = record.items
        .map((line) => `${foundry.utils.escapeHTML(line.name)} &times;${line.quantity}`)
        .join(', ');

    return [
        `<p>${game.i18n.format('coffee-pub-merchant.delivery.manifest', {
            shop: foundry.utils.escapeHTML(record.shopName ?? ''),
            service: foundry.utils.escapeHTML(service.name)
        })}</p>`,
        `<p>${game.i18n.format('coffee-pub-merchant.delivery.manifestGoods', { goods })}</p>`,
        `<p>${game.i18n.format('coffee-pub-merchant.delivery.manifestFee', {
            fee: formatBase(record.feeBase ?? 0)
        })}</p>`,
        record.destination
            ? `<p>${game.i18n.format('coffee-pub-merchant.delivery.manifestWhere', {
                where: foundry.utils.escapeHTML(record.destination)
            })}</p>`
            : '',
        record.instructions
            ? `<p>${game.i18n.format('coffee-pub-merchant.delivery.manifestInstructions', {
                note: foundry.utils.escapeHTML(record.instructions)
            })}</p>`
            : '',
        `<p><em>${arrivalLabel(record.arrivesAt)}</em></p>`
    ].join('');
}

/**
 * Build the consignment a receipt will carry.
 *
 * Pure but for the clock: everything that decides *what* is in the parcel and *when* it
 * lands is here, and the document writing is elsewhere. `sources` are `item.toObject()`
 * results taken from the merchant's own rows at order time.
 */
export function buildConsignment({
    merchantUuid, shopName, buyerUuid, service, lines, feeBase: fee, goodsBase, now,
    destination = null, instructions = '', outbound = false
}) {
    const chosen = serviceFor(service);
    const dispatchedAt = Number.isFinite(Number(now)) ? Number(now) : 0;

    return {
        merchantUuid: merchantUuid ?? null,
        shopName: shopName ?? null,
        buyerUuid: buyerUuid ?? null,
        service: chosen.key,
        feeBase: fee ?? 0,
        goodsBase: goodsBase ?? 0,
        dispatchedAt,
        arrivesAt: arrivalTime(dispatchedAt, chosen.days),
        // Where it is going, and anything the party asked for on the way. Both are read by
        // a person rather than acted on by the module, which is the point of them.
        destination: destination || null,
        instructions: String(instructions ?? '').slice(0, 500),
        // Which way it is going. Buying is the ordinary case; an outbound consignment is the
        // party posting goods to the merchant, already paid for on dispatch.
        outbound: outbound === true,
        delivered: false,
        items: lines.map((line) => ({
            name: line.name,
            img: line.img,
            quantity: line.quantity,
            // The goods themselves, not a pointer at them. See the note at the top.
            source: line.source
        }))
    };
}

// ==================================================================
// ===== THE CLOCK ==================================================
// ==================================================================

/** Every receipt in the world that has not been delivered yet, with the Actor holding it. */
export function pendingConsignments() {
    const pending = [];
    for (const actor of game.actors ?? []) {
        for (const item of actor.items ?? []) {
            const record = consignmentOf(item);
            if (record && !isDelivered(record)) pending.push({ actor, item, record });
        }
    }
    return pending;
}

function scheduleId(item) {
    return `${MODULE.ID}.delivery.${item.id}`;
}

/**
 * Tell the world clock when each pending parcel lands.
 *
 * **`api.worldClock` is exactly the right tool, and this is the case its decline
 * anticipated.** It was evaluated and declined on 2026-08-21 for trading hours and
 * restocking, correctly: neither is a moment. The note left behind said to revisit *"if a
 * genuine wall-clock event appears"* — and a delivery arriving is one.
 *
 * Three things from their page this obeys:
 *
 * - **Schedules are not persisted**, so this runs on `ready` and walks the receipts. The
 *   receipts *are* the queue; the clock is a notification surface and says so.
 * - **`gmOnly: true`**, because delivering writes to the world. Without it, five connected
 *   players would deliver the same parcel five times.
 * - **Nothing fires retroactively.** A parcel whose moment passed while the world was
 *   closed would never land, so anything already due is delivered on the spot instead of
 *   being scheduled into the past.
 */
export function registerDeliveries(deliver) {
    const clock = game.modules.get('coffee-pub-blacksmith')?.api?.worldClock;
    if (typeof clock?.schedule !== 'function') {
        console.warn(`${MODULE.TITLE} | Blacksmith has no world clock; parcels will not arrive on their own.`);
        return;
    }
    if (!game.user.isGM) return;

    const now = game.time?.worldTime ?? 0;
    for (const pending of pendingConsignments()) {
        if (pending.record.arrivesAt <= now) {
            // Already due. Registering a moment in the past fires nothing, so a parcel that
            // came while the world was shut would otherwise sit there for ever.
            void deliver(pending);
            continue;
        }
        try {
            clock.schedule({
                id: scheduleId(pending.item),
                at: pending.record.arrivesAt,
                description: `Merchant delivery: ${pending.record.shopName ?? 'a shop'}`,
                gmOnly: true,
                callback: () => void deliver(pending)
            });
        } catch (error) {
            console.warn(`${MODULE.TITLE} | Could not schedule a delivery:`, error);
        }
    }
}

/** Arm one delivery, for an order placed while the world is running. */
export function scheduleDelivery(pending, deliver) {
    const clock = game.modules.get('coffee-pub-blacksmith')?.api?.worldClock;
    if (typeof clock?.schedule !== 'function' || !game.user.isGM) return;
    try {
        clock.schedule({
            id: scheduleId(pending.item),
            at: pending.record.arrivesAt,
            description: `Merchant delivery: ${pending.record.shopName ?? 'a shop'}`,
            gmOnly: true,
            callback: () => void deliver(pending)
        });
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not schedule that delivery:`, error);
    }
}

/** Stop waiting for one, once it has landed or gone astray. */
export function unscheduleDelivery(item) {
    const clock = game.modules.get('coffee-pub-blacksmith')?.api?.worldClock;
    if (typeof clock?.unschedule !== 'function') return;
    try {
        clock.unschedule(scheduleId(item));
    } catch (_error) {
        // Nothing registered under that id. Which is the state we wanted.
    }
}

// ==================================================================
// ===== ARRIVAL ====================================================
// ==================================================================

/**
 * Turn a receipt into the parcel it was promising.
 *
 * **Built from documents rather than through `grantItem`**, which refuses a packed
 * container: the `CONTAINER_HAS_CONTENTS` refusal Merchant already reports quietly on
 * restocks, because a copy would have to invent the contents or drop them. A parcel is a
 * packed container by definition, so this creates the contents on the Actor with
 * `system.container` pointing at the receipt, which is how dnd5e nests an item anyway.
 *
 * The same Item throughout: renamed, re-pictured, and filled. Nothing is created and
 * nothing is destroyed, so a receipt somebody has carried across three sessions is the
 * parcel they open.
 */
export async function deliverParcel(actor, item, record) {
    const contents = record.items.map((line) => {
        const source = foundry.utils.deepClone(line.source ?? {});

        // **Merchant's own shelf flags do not travel.** `par` describes an inventory rather
        // than an item, and `free` says a merchant was giving something away -- neither is a
        // fact about the thing once it is in somebody's parcel. A settlement strips them
        // through `exchange`'s `omitFlags`; this path builds documents directly, so it has
        // to do the same by hand or a delivered row arrives carrying a restock target and
        // rides back in if the party ever sells it.
        const flags = { ...(source.flags ?? {}) };
        if (flags[MODULE.ID]) {
            flags[MODULE.ID] = { ...flags[MODULE.ID] };
            delete flags[MODULE.ID][PAR_FLAG];
            delete flags[MODULE.ID][FREE_FLAG];
            if (!Object.keys(flags[MODULE.ID]).length) delete flags[MODULE.ID];
        }

        return {
            ...source,
            _id: undefined,
            flags,
            system: {
                ...(source.system ?? {}),
                quantity: line.quantity,
                container: item.id
            }
        };
    });

    await actor.createEmbeddedDocuments('Item', contents, { keepId: false });
    await item.update({
        name: game.i18n.format('coffee-pub-merchant.delivery.parcelName', { shop: record.shopName ?? '' }),
        img: PARCEL_IMG,
        [`flags.${MODULE.ID}.${RECEIPT_FLAG}.delivered`]: true
    });
    return item;
}

/** What a receipt is called and looks like when it is made. */
export function receiptData(record) {
    return {
        name: game.i18n.format('coffee-pub-merchant.delivery.receiptName', { shop: record.shopName ?? '' }),
        // **A container from the outset**, empty. An Item's type is not a thing to change
        // under a system with opinions about subtypes, and an empty container is what a
        // receipt is: a promise with a shape.
        type: 'container',
        img: RECEIPT_IMG,
        system: {
            description: { value: manifestHtml(record) },
            quantity: 1,
            weight: { value: 0, units: 'lb' },
            price: { value: 0, denomination: 'gp' }
        },
        flags: { [MODULE.ID]: { [RECEIPT_FLAG]: record } }
    };
}

export { RECEIPT_IMG, PARCEL_IMG, DEFAULT_DELIVERY_SERVICE };
