// ==================================================================
// ===== PRICING AND COIN ===========================================
// ==================================================================
//
// Prices, wealth, and making change.
//
// **Making change is Merchant's, permanently.** `api.inventory` never converts
// denominations — a standing decision, and the right one: exchanging coin to satisfy
// a payment is a table's house rule, not a mechanic. A player holding 20 sp cannot
// pay 2 gp as far as the primitive is concerned. Every transaction hits that, so it
// is a designed feature here rather than an edge case discovered in play.

import { MODULE, SHELF_MODE } from './const.js';

/** Denominations, largest first. Conversions come from the system, never hardcoded. */
export function denominations() {
    const currencies = CONFIG.DND5E?.currencies ?? {};
    return Object.entries(currencies)
        .map(([key, config]) => ({
            key,
            label: config.label ?? key.toUpperCase(),
            abbreviation: config.abbreviation ?? key.toUpperCase(),
            // dnd5e stores "how many of this coin per gp", so a bigger conversion is
            // a smaller coin.
            conversion: Number(config.conversion) || 1
        }))
        .sort((a, b) => a.conversion - b.conversion);
}

/** The smallest denomination, which everything is counted in internally. */
export function baseDenomination() {
    const all = denominations();
    return all[all.length - 1] ?? { key: 'cp', conversion: 100, abbreviation: 'CP' };
}

/** Convert an amount of one denomination into base units. */
export function toBase(value, denomination) {
    const amount = Number(value) || 0;
    const from = denominations().find((d) => d.key === denomination);
    const base = baseDenomination();
    if (!from) return Math.round(amount * base.conversion);
    return Math.round((amount / from.conversion) * base.conversion);
}

/** An actor's whole purse, in base units. */
export function purseValue(actor) {
    const currency = actor?.system?.currency ?? {};
    return denominations().reduce((total, d) => total + toBase(Math.trunc(Number(currency[d.key]) || 0), d.key), 0);
}

/** Base units rendered as "3 gp 4 sp", largest coin first, zeroes omitted. */
export function formatBase(base) {
    const amount = Math.max(0, Math.round(Number(base) || 0));
    if (!amount) return '—';
    const baseUnit = baseDenomination();
    const parts = [];
    let remaining = amount;
    for (const d of denominations()) {
        const perCoin = Math.round(baseUnit.conversion / d.conversion);
        if (perCoin <= 0) continue;
        const count = Math.floor(remaining / perCoin);
        if (count > 0) {
            parts.push(`${count} ${d.abbreviation.toLowerCase()}`);
            remaining -= count * perCoin;
        }
    }
    return parts.length ? parts.join(' ') : `${amount} ${baseUnit.abbreviation.toLowerCase()}`;
}

/**
 * What a merchant charges for an item, in base units.
 *
 * Three sources, resolved in order:
 *   1. A per-item override on the merchant. Absolute, wins outright.
 *   2. The shelf's markup, or the merchant's, applied to the item's own price.
 *   3. The item's own `system.price`.
 *
 * @returns {number|null} null when the item has no price at all — which is a
 *   configuration gap on a sale shelf and deliberate on a barter one.
 */
export function resolvePrice(merchantConfig, shelfConfig, item) {
    const override = merchantConfig?.pricing?.overrides?.[item?.id];
    if (override && Number.isFinite(Number(override.value))) {
        return toBase(Number(override.value), override.denomination ?? 'gp');
    }

    const price = item?.system?.price;
    const value = Number(price?.value);
    if (!Number.isFinite(value) || value <= 0) return null;

    // A buyback shelf's `markup` is what the shop *pays*, not what it charges — see
    // resolveBuybackPrice. Reading it here too would have the shop buy a sword at half
    // price and resell it at half price: no profit, and a permanent half-price
    // second-hand rack. Second-hand stock is sold at the shop's ordinary rate.
    const shelfMarkup = shelfConfig?.mode === SHELF_MODE.BUYBACK ? null : shelfConfig?.markup;
    const markup = Number.isFinite(Number(shelfMarkup))
        ? Number(shelfMarkup)
        : Number(merchantConfig?.pricing?.markup);

    const multiplier = Number.isFinite(markup) && markup > 0 ? markup : 1;
    return Math.max(1, Math.round(toBase(value, price?.denomination ?? 'gp') * multiplier));
}

/**
 * What a merchant pays for an item the party sells, in base units.
 *
 * A fraction of what the thing is worth, not a fraction of the shop's asking price —
 * hence the blanked overrides and the `null` shelf. A shop marking everything up 2x
 * should not therefore pay double.
 *
 * The buyback shelf's `markup` is that fraction. It is the only place that reads it
 * as a rate paid rather than a rate charged.
 */
export function resolveBuybackPrice(merchantConfig, shelfConfig, item) {
    const price = resolvePrice({ ...merchantConfig, pricing: { ...merchantConfig?.pricing, overrides: {} } }, null, item);
    if (price === null) return null;
    const rate = Number.isFinite(Number(shelfConfig?.markup)) ? Number(shelfConfig.markup) : 0.5;
    return Math.max(1, Math.round(price * (rate > 0 ? rate : 0.5)));
}

/**
 * Work out which coins change hands.
 *
 * This is the "making change" step the primitive refuses to do. A buyer who owes
 * 2 gp and holds 20 sp pays with silver; a buyer who owes 2 gp and holds a platinum
 * piece pays platinum and takes change. Both are ordinary at a table and neither is
 * expressible as a straight currency delta.
 *
 * Spends smallest coins first, so a purse is not needlessly broken into change, then
 * returns whatever was overpaid. Not optimal in the coin-counting sense, and
 * deliberately so — it matches what a person does at a counter.
 *
 * @returns {{pay: object, change: object, total: number}|null} null when the buyer
 *   simply cannot afford it.
 */
export function planPayment(actor, priceBase) {
    const owed = Math.max(0, Math.round(Number(priceBase) || 0));
    if (!owed) return { pay: {}, change: {}, total: 0 };
    if (purseValue(actor) < owed) return null;

    const currency = actor?.system?.currency ?? {};
    const baseUnit = baseDenomination();
    const smallestFirst = [...denominations()].reverse();

    const pay = {};
    let paid = 0;
    for (const d of smallestFirst) {
        if (paid >= owed) break;
        const perCoin = Math.round(baseUnit.conversion / d.conversion);
        if (perCoin <= 0) continue;
        const held = Math.trunc(Number(currency[d.key]) || 0);
        if (held <= 0) continue;
        const wanted = Math.ceil((owed - paid) / perCoin);
        const spend = Math.min(held, wanted);
        if (spend <= 0) continue;
        pay[d.key] = spend;
        paid += spend * perCoin;
    }

    // The purse was enough in total but not in the coins tried, which only happens
    // if the loop above is wrong. Guarding rather than returning a short payment.
    if (paid < owed) {
        console.warn(`${MODULE.TITLE} | Could not assemble a payment of ${owed} despite a sufficient purse.`);
        return null;
    }

    const change = {};
    let owedBack = paid - owed;
    for (const d of denominations()) {
        if (owedBack <= 0) break;
        const perCoin = Math.round(baseUnit.conversion / d.conversion);
        if (perCoin <= 0) continue;
        const count = Math.floor(owedBack / perCoin);
        if (count > 0) {
            change[d.key] = count;
            owedBack -= count * perCoin;
        }
    }

    return { pay, change, total: owed };
}
