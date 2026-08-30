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
    deliveryPlacesKey,
    DELIVERY_POINT, CRATE, CRATE_DEPOSIT_SETTING, packCrates
} from './const.js';
import { toBase, fromBase, formatBase } from './utility-pricing.js';
import { notify } from './utility-feedback.js';
import { emit, SOCKET_EVENT } from './utility-sockets.js';

/** The image a receipt wears, and the one a parcel wears once it has been filled. */
const RECEIPT_IMG = 'icons/sundries/documents/document-sealed-brown-red.webp';
const PARCEL_IMG = 'icons/containers/boxes/crate-wooden-brown.webp';

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
 * What one crate costs, in base units.
 *
 * **A deposit, not a sale.** The party pay for the box with the goods and get it back if
 * they send the box back; keeping it is buying it. The merchant's side of that is not
 * modelled at all -- nothing is credited to a shop, no shop is checked for a refund, and a
 * merchant that no longer exists changes nothing. It is a fact about the *party's* purse
 * and a piece of fiction everywhere else, which is the right amount of economy for a box.
 */
export function crateDepositBase() {
    const gp = game.settings?.get?.(MODULE.ID, CRATE_DEPOSIT_SETTING);
    return toBase(Number.isFinite(Number(gp)) ? Number(gp) : CRATE.depositGp, 'gp');
}

/** How many crates an order needs, which is what fixes its deposit. See `packCrates`. */
export function crateCount(lines) {
    return Math.max(1, packCrates(lines).length);
}

/**
 * Whether this parcel has to be collected rather than handed over.
 *
 * A service with a **delivery point** takes the goods to a place; somebody has to go there.
 * The courier beast asks for nowhere and finds the receipt, which is the whole of its
 * premium -- so a beast delivery lands in the pack the moment it is due.
 */
export function needsCollection(record) {
    return deliveryPointFor(record?.service) !== null;
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
 * **The world's shops plus the world's own list.** A merchant carrying the matching flag
 * is offering to take parcels, and `worldMerchants` already enumerates every linked
 * merchant in the world — there is no separate register to keep, and one would only drift
 * from the Actors it was describing. Alongside them, the GM's free-text list from Settings,
 * because not every place a parcel can go is a shop somebody has built: a safehouse, a
 * poste restante, a name a party made up.
 *
 * **The list is the world's, not the sending shop's.** Where a parcel can arrive has
 * nothing to do with who posted it — the same coaching inn takes a crate from any merchant
 * in the world — so a list per merchant was a list to be retyped for every shop that sold
 * by post, with five copies free to drift apart.
 *
 * A beast returns nothing, and that is not an empty list — it is the answer. It goes
 * looking for whoever is holding the receipt, which is what its price buys.
 */
export function destinationsFor(service) {
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

    const custom = game.settings.get(MODULE.ID, deliveryPlacesKey(point));
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
        record.depositBase
            ? `<p>${game.i18n.format('coffee-pub-merchant.delivery.manifestDeposit', {
                deposit: formatBase(record.depositBase), crates: record.crates ?? 1
            })}</p>`
            : '',
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
    // **The packing is not stored, the count is.** `packCrates` is pure and the goods are
    // frozen into the record at dispatch, so running it again at delivery gives the same
    // crates it gave at the counter -- which is what makes the boxes the party paid for
    // and the boxes that turn up the same boxes. Storing the grouping as well would be a
    // second copy of the manifest, free to disagree with the first.
    const crates = crateCount(lines);

    return {
        merchantUuid: merchantUuid ?? null,
        shopName: shopName ?? null,
        buyerUuid: buyerUuid ?? null,
        service: chosen.key,
        feeBase: fee ?? 0,
        goodsBase: goodsBase ?? 0,
        // What the boxes cost, and what each one is worth back. Stored per crate as well
        // as in total, so a refund years later pays what was actually paid rather than
        // what a setting happens to say by then.
        crates,
        crateDepositBase: crateDepositBase(),
        depositBase: crates * crateDepositBase(),
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
 * **The box, as an object with weight and limits.**
 *
 * A crate that weighed nothing and held anything made mail order the best bag of holding
 * in the game: order any amount of anything and it arrives in free carrying capacity. So
 * it is five pounds empty, holds fifty, and is priced at what the party put down for it.
 *
 * `capacity.weight` is what dnd5e enforces; the volume is there because a crate has a size
 * and a reader should see one. No `weightReduction` and nothing extradimensional: what is
 * in it weighs what it weighs, which is the reason a big order needs several.
 */
function crateSystem(description, record) {
    return {
        description,
        weight: { value: CRATE.weightLb, units: 'lb' },
        price: {
            value: fromBase(record?.crateDepositBase ?? 0, 'gp') || CRATE.depositGp,
            denomination: 'gp'
        },
        capacity: {
            volume: { value: CRATE.volumeCubicFeet, units: 'cubicFoot' },
            weight: { value: CRATE.capacityLb, units: 'lb' }
        }
    };
}

/** "Parcel: The Anvil", or "Parcel: The Anvil (2 of 3)" when it took more than one box. */
function parcelName(record, index) {
    const base = game.i18n.format('coffee-pub-merchant.delivery.parcelName', {
        shop: record.shopName ?? ''
    });
    const crates = Math.max(1, Number(record.crates) || 1);
    if (crates <= 1) return base;
    return `${base} ${game.i18n.format('coffee-pub-merchant.delivery.crateOf', {
        index, of: crates
    })}`;
}

/**
 * **A note becomes a crate**: `loot` in, `container` out.
 *
 * Foundry allows a Document's subtype to change on update, and a receipt is the ideal case
 * for it -- a name, a picture and a description, with no system data worth preserving. If a
 * system ever refuses, the fallback rebuilds it under **the same id**, which is what every
 * other part of this keeps hold of: the schedule is keyed by it, and so is the courier
 * looking for whoever holds the receipt.
 *
 * Either way it is the same object to the people at the table. A receipt carried across
 * three sessions is the parcel they open.
 */
async function becomeParcel(actor, item, record) {
    const dressing = {
        name: parcelName(record, 1),
        img: PARCEL_IMG,
        [`flags.${MODULE.ID}.${RECEIPT_FLAG}.delivered`]: true,
        [`flags.${MODULE.ID}.${RECEIPT_FLAG}.crate`]: 1
    };

    try {
        // **`==system` is what makes the type change legal.** Foundry refuses to change a
        // Document's type while merging its system data, and it is right to: the incoming
        // half-object would be merged into a schema that no longer applies, leaving a
        // container carrying a loot item's fields. The `==` prefix force-replaces that one
        // branch, which is exactly the claim being made -- this is a crate now, and none of
        // what it held as a note survives except the words on it.
        await item.update({
            type: 'container',
            ...dressing,
            '==system': crateSystem(item.system?.description ?? {}, record)
        });
        if (item.type === 'container') return item;
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not turn the receipt into a container in place:`, error);
    }

    // Same id, built fresh. The system data is written rather than carried over: a loot
    // item's fields are not a container's, and the parcel needs none of them anyway.
    const source = item.toObject();
    await item.delete();
    const [rebuilt] = await actor.createEmbeddedDocuments('Item', [{
        _id: source._id,
        type: 'container',
        name: dressing.name,
        img: PARCEL_IMG,
        system: crateSystem(source.system?.description ?? {}, record),
        flags: foundry.utils.mergeObject(
            source.flags ?? {},
            { [MODULE.ID]: { [RECEIPT_FLAG]: { ...record, delivered: true, crate: 1 } } },
            { inplace: false }
        )
    }], { keepId: true });
    return rebuilt ?? null;
}

/**
 * Turn a receipt into the parcel it was promising.
 *
 * **Built from documents rather than through `grantItem`**, which refuses a packed
 * container: the `CONTAINER_HAS_CONTENTS` refusal Merchant already reports quietly on
 * restocks, because a copy would have to invent the contents or drop them. A parcel is a
 * packed container by definition, so this creates the contents on the Actor with
 * `system.container` pointing at it, which is how dnd5e nests an item anyway.
 *
 * **The crate first, then what is in it.** dnd5e reads `system.container` as a reference to
 * a container, so contents built against an item that is still a receipt have nowhere to
 * live -- they would land loose in the pack, which is a delivery that arrived with the box
 * missing rather than an error anybody would see.
 */
export async function deliverParcel(actor, item, record) {
    // The same packing the party paid for: `packCrates` is pure and the goods were frozen
    // into the record at dispatch, so this is the grouping the deposit was charged on.
    const crates = packCrates(record.items);

    const parcel = await becomeParcel(actor, item, record);
    if (!parcel) {
        console.error(`${MODULE.TITLE} | The parcel for ${actor?.name} could not be opened:`, record);
        return null;
    }
    const boxes = [parcel];

    // **The receipt becomes the first crate; the rest are boxes beside it.** Each carries
    // the whole consignment record so each can be opened, kept or sent back on its own --
    // a party who want to keep one crate and return two should be able to.
    for (let index = 1; index < crates.length; index++) {
        const [extra] = await actor.createEmbeddedDocuments('Item', [{
            name: parcelName(record, index + 1),
            type: 'container',
            img: PARCEL_IMG,
            system: crateSystem({ value: manifestHtml(record) }, record),
            flags: {
                [MODULE.ID]: { [RECEIPT_FLAG]: { ...record, delivered: true, crate: index + 1 } }
            }
        }]);
        if (extra) boxes.push(extra);
    }

    const contents = [];
    crates.forEach((crate, index) => {
        // A box that could not be created is not a reason to drop its goods on the floor:
        // they go in the last box that exists, over its stated capacity, which a person can
        // see and sort out. Losing them would be silent.
        const box = boxes[index] ?? boxes[boxes.length - 1];
        for (const line of crate) contents.push(contentData(line, box.id));
    });

    await actor.createEmbeddedDocuments('Item', contents, { keepId: false });
    return parcel;
}

/**
 * One line of a consignment, as a document inside a crate.
 *
 * **Merchant's own shelf flags do not travel.** `par` describes an inventory rather than an
 * item, and `free` says a merchant was giving something away -- neither is a fact about the
 * thing once it is in somebody's parcel. A settlement strips them through `exchange`'s
 * `omitFlags`; this path builds documents directly, so it has to do the same by hand or a
 * delivered row arrives carrying a restock target and rides back in if the party sell it.
 */
function contentData(line, containerId) {
    const source = foundry.utils.deepClone(line.source ?? {});

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
            container: containerId
        }
    };
}

/**
 * Put a receipt in somebody's pack, with the one thing you can do to it.
 *
 * The activity is what dnd5e's sheet clicks: without one the item merely expands its
 * description, and *when does it get here* would be a paragraph to go and read rather than
 * an answer. Created after the Item because `createActivity` is the system's own path --
 * hand-writing the activity's data into the creation is guessing at somebody's schema.
 *
 * Optional-chained for the same reason the catalogue's is: a system without activities
 * still leaves a perfectly good receipt, since the manifest is on the item either way.
 */
export async function createReceipt(actor, record) {
    const [item] = await actor.createEmbeddedDocuments('Item', [receiptData(record)]);
    if (!item) return null;

    if (typeof item.createActivity === 'function') {
        try {
            await item.createActivity('utility', {
                name: game.i18n.localize('coffee-pub-merchant.delivery.checkActivity')
            }, { renderSheet: false });
        } catch (error) {
            console.warn(`${MODULE.TITLE} | Could not give the receipt its activity:`, error);
        }
    }
    return item;
}

/** What a receipt is called and looks like when it is made. */
export function receiptData(record) {
    return {
        name: game.i18n.format('coffee-pub-merchant.delivery.receiptName', { shop: record.shopName ?? '' }),
        // **A receipt is a piece of paper, so it is an ordinary item.**
        //
        // It was a container from the outset -- empty, on the theory that an Item's type is
        // not a thing to change under a system with opinions about subtypes. That reasoning
        // was about the code and ignored the sheet: dnd5e files containers in their own
        // section, so a promise of a delivery sat among the party's backpacks looking like a
        // bag you could put things in, days before there was anything in it. The parcel is
        // the container; the receipt is the note that says one is coming.
        //
        // `consumable`/`trinket` for the catalogue's reason: it is the type dnd5e gives
        // activities to and does not otherwise interfere with, and an activity is what makes
        // the thing clickable. Nothing is consumed -- checking a receipt a hundred times
        // leaves the same one receipt.
        type: 'consumable',
        img: RECEIPT_IMG,
        system: {
            type: { value: 'trinket' },
            description: { value: manifestHtml(record) },
            quantity: 1,
            weight: { value: 0, units: 'lb' },
            price: { value: 0, denomination: 'gp' }
        },
        flags: { [MODULE.ID]: { [RECEIPT_FLAG]: record } }
    };
}

// ==================================================================
// ===== ASKING A RECEIPT WHERE THE PARCEL IS =======================
// ==================================================================

/**
 * **A receipt answers out loud, and answers *now*.**
 *
 * The manifest written into the description is fixed at the moment of ordering -- "arrives
 * in 7 days" and it says that on day six as well, which is worse than saying nothing. This
 * is computed against the world clock at the moment somebody asks, so the number counts
 * down as the party travels.
 *
 * A toast rather than a chat card, because it is a question one person asked about a thing
 * in their own pack. A card would put the party's shopping in front of the whole table --
 * including a delivery address and a note to a courier that somebody may well have chosen
 * carefully -- and post it again every time they checked.
 */
export function receiptToast(item) {
    const record = consignmentOf(item);
    if (!record) return null;

    const goods = record.items.map((line) => `${line.name} x${line.quantity}`).join(', ');
    const service = serviceFor(record.service);

    if (isDelivered(record)) {
        return notify.info(game.i18n.localize('coffee-pub-merchant.delivery.alreadyHere'), {
            subtitle: goods,
            image: item.img
        });
    }

    // **It has landed, and it landed somewhere.** A parcel sent to a place is not a parcel
    // in your pack: somebody has to be standing at that place to take it, and only the GM
    // knows where the party are. So consulting the receipt asks them.
    if (hasLanded(record) && needsCollection(record)) return askToCollect(item, record);

    // The address and the note are the buyer's own words about their own parcel: shown
    // where they asked, and nowhere else. Both are plain text on a toast, so there is
    // nothing here to escape and nothing that could be made to run.
    const detail = [
        game.i18n.format('coffee-pub-merchant.delivery.viaService', { service: service.name }),
        record.destination
            ? game.i18n.format('coffee-pub-merchant.delivery.manifestWhere', { where: record.destination })
            : game.i18n.localize('coffee-pub-merchant.delivery.beastNote'),
        goods,
        record.instructions
            ? game.i18n.format('coffee-pub-merchant.delivery.manifestInstructions', { note: record.instructions })
            : ''
    ].filter(Boolean).join(' • ');

    return notify.info(arrivalLabel(record.arrivesAt), {
        subtitle: detail,
        image: item.img,
        // Longer than an ordinary toast: this one is read rather than noticed, and there
        // are four facts in it. Clicking it away is still the fastest route out.
        duration: 14,
        onClick: () => {},
        // One receipt's answer replaces another's. Checking three parcels in a row should
        // not build a wall of toasts.
        stackKey: `${MODULE.ID}-parcel`
    });
}

/**
 * **Open the crate: everything in it comes out, and the packaging goes.**
 *
 * A delivered parcel is a container, so its contents are already on the Actor -- nested
 * inside it rather than loose in the pack. Opening moves them out by clearing
 * `system.container`, which is the same thing dragging each one out of the container would
 * do, and then deletes the box.
 *
 * **Contents first, box second, and never the other way round.** dnd5e takes a container's
 * contents with it when it is deleted; a delete that ran first would destroy the delivery
 * in the act of unwrapping it.
 *
 * The crate is not kept. It is packaging with a shop's name on it, and a party who order
 * regularly would otherwise accumulate one empty box per delivery for ever. Anybody who
 * wants a crate can be given a crate.
 */
export async function openParcel(item) {
    const record = consignmentOf(item);
    const actor = item?.parent;
    if (!record || !actor || !isDelivered(record)) return null;

    const deposit = Number(record.crateDepositBase) || 0;
    const keep = await askAboutTheBox(record, deposit);
    if (keep === null) return null;

    const inside = actor.items.filter((held) => held.system?.container === item.id);
    const names = inside.map((held) => `${held.name} x${held.system?.quantity ?? 1}`).join(', ');

    try {
        // **Contents out before the box goes anywhere.** dnd5e takes a container's contents
        // with it when it is deleted, so a delete that ran first would destroy the delivery
        // in the act of unwrapping it.
        if (inside.length) {
            await actor.updateEmbeddedDocuments('Item', inside.map((held) => ({
                _id: held.id,
                'system.container': null
            })));
        }

        if (keep) {
            // **It stops being ours.** The consignment flag is what puts *Open Parcel* on
            // the sheet and what the courier looks for; a crate somebody has bought is a
            // crate, and leaving the flag on it would leave an action that opens an already
            // open box. `-=` because a merge cannot express a deletion.
            await item.update({
                [`flags.${MODULE.ID}.-=${RECEIPT_FLAG}`]: null,
                name: game.i18n.localize('coffee-pub-merchant.delivery.crateName')
            });
        } else {
            await item.delete();
            await refundDeposit(actor, deposit);
        }
    } catch (error) {
        console.error(`${MODULE.TITLE} | Could not open a parcel:`, error);
        notify.error(game.i18n.localize('coffee-pub-merchant.delivery.openFailed'));
        return null;
    }

    notify.success(game.i18n.format(
        keep ? 'coffee-pub-merchant.delivery.openedKept' : 'coffee-pub-merchant.delivery.openedReturned',
        { shop: record.shopName ?? '', deposit: formatBase(deposit) }
    ), { subtitle: names });
    return inside;
}

/**
 * Keep the box or send it back.
 *
 * Three buttons rather than two, because **cancel has to be a real answer**: this is the
 * only gesture in the module that destroys an item, and somebody who clicked the wrong row
 * needs a way out that is not "open it and hope".
 *
 * @returns {Promise<boolean|null>} true to keep it, false to send it back, null for neither.
 */
async function askAboutTheBox(record, deposit) {
    const blacksmith = game.modules.get('coffee-pub-blacksmith')?.api;
    // No dialog available is not a reason to be unable to open a parcel: the goods come
    // out and the box goes back, which is the choice that costs nothing and can be undone
    // by buying a crate.
    if (typeof blacksmith?.dialog?.wait !== 'function') return false;

    const answer = await blacksmith.dialog.wait({
        title: game.i18n.localize('coffee-pub-merchant.delivery.openTitle'),
        classes: ['merchant-dialog'],
        content: `<p>${game.i18n.format('coffee-pub-merchant.delivery.openPrompt', {
            shop: foundry.utils.escapeHTML(record.shopName ?? '')
        })}</p><p>${game.i18n.format('coffee-pub-merchant.delivery.openDeposit', {
            deposit: formatBase(deposit)
        })}</p>`,
        buttons: [
            { action: 'cancel', label: game.i18n.localize('coffee-pub-merchant.common.cancel'), icon: 'fa-solid fa-xmark' },
            { action: 'keep', label: game.i18n.localize('coffee-pub-merchant.delivery.keepBox'), icon: 'fa-solid fa-box' },
            {
                action: 'return',
                label: game.i18n.localize('coffee-pub-merchant.delivery.returnBox'),
                icon: 'fa-solid fa-rotate-left',
                default: true
            }
        ],
        closeValue: 'cancel'
    });

    if (answer === 'keep') return true;
    if (answer === 'return') return false;
    return null;
}

/**
 * Put the deposit back in the party's purse.
 *
 * **Nobody is debited for it**, and that is deliberate: the shop's side of a crate deposit
 * is fiction, and modelling it would mean finding a merchant that may have been deleted,
 * checking its till, and failing a refund because a shop went out of business. What the
 * party paid, the party get back.
 */
async function refundDeposit(actor, deposit) {
    const gp = Math.round(fromBase(deposit, 'gp'));
    if (!gp) return;
    const held = Math.trunc(Number(actor.system?.currency?.gp) || 0);
    await actor.update({ 'system.currency.gp': held + gp });
}

/** Whether the moment has passed, which is a question about the clock and nothing else. */
export function hasLanded(record) {
    return daysUntil(record?.arrivesAt, game.time?.worldTime ?? 0) <= 0;
}

/**
 * Ask the GM whether the party are standing where the parcel is.
 *
 * **Only the GM knows where anybody is.** A scene is not a location -- a party can be on
 * the world map, in a theatre-of-the-mind conversation, or standing in a shop that has no
 * token for the coaching inn three towns away. Nothing on the client could work this out,
 * and guessing would either hand over a parcel a hundred miles away or refuse one being
 * collected from the counter.
 *
 * The toast first, so the player sees that their click did something before the GM has
 * finished reading the dialog.
 */
function askToCollect(item, record) {
    notify.info(game.i18n.format('coffee-pub-merchant.delivery.verifying', {
        where: record.destination ?? ''
    }), { image: item.img });

    emit(SOCKET_EVENT.COLLECT, {
        actorUuid: item.parent?.uuid ?? null,
        itemId: item.id,
        who: item.parent?.name ?? '',
        where: record.destination ?? ''
    });
    return null;
}

/**
 * Consulting a receipt says where the parcel is, and does not post a card.
 *
 * The catalogue's shape exactly, and for its reasons: `dnd5e.preUseActivity` fires on the
 * click, returning `false` cancels the roll, and the sheet header carries the same thing
 * for a GM inspecting one in the sidebar with no character to use it as.
 */
export function registerReceipts(hook) {
    hook('dnd5e.preUseActivity', 'Answer a receipt, or open a parcel', (activity) => {
        const item = activity?.item;
        const record = consignmentOf(item);
        if (!record) return;
        // The same click means two things at two moments, which is what the object itself
        // means at those moments: before it arrives it is a note to be read, and after it
        // arrives it is a box to be opened. A delivered parcel only reaches this if it kept
        // its activity -- a container has none -- which is the fallback path where the type
        // change was refused, and it should still open rather than merely report itself.
        if (isDelivered(record)) void openParcel(item);
        else receiptToast(item);
        return false;
    }, { canCancel: true });

    hook('getHeaderControlsApplicationV2', 'Check a delivery, or open the parcel', (app, controls) => {
        const item = app?.document;
        if (item?.documentName !== 'Item') return;
        const record = consignmentOf(item);
        if (!record) return;

        // **The parcel's only action lives here**, because a container has no activities to
        // click: dnd5e gives them to consumables and weapons, not to boxes. The sheet header
        // is the one surface a container does have, and it is where a GM reaches for
        // everything else about a document anyway.
        if (isDelivered(record)) {
            controls.push({
                icon: 'fa-solid fa-box-open',
                label: game.i18n.localize('coffee-pub-merchant.delivery.open'),
                action: 'merchantOpenParcel',
                onClick: () => void openParcel(item)
            });
            return;
        }

        controls.push({
            icon: 'fa-solid fa-truck-fast',
            label: game.i18n.localize('coffee-pub-merchant.delivery.check'),
            action: 'merchantParcel',
            onClick: () => receiptToast(item)
        });
    });
}

export { RECEIPT_IMG, PARCEL_IMG, DEFAULT_DELIVERY_SERVICE };
