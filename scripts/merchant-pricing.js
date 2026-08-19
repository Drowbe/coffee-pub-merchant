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

import { MODULE, SHELF_MODE, STOCK_DEPTH_BANDS } from './const.js';

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

/**
 * How many of this thing a table roll should put on the shelf.
 *
 * Two rules, in order:
 *
 * 1. **What the item says it is.** A compendium entry authored as a quiver of twenty
 *    arrows is a quiver of twenty arrows. We used to hardcode one and stock a single
 *    arrow, which threw away the only statement anybody had actually made.
 * 2. **What it costs.** Cheap things come in piles and dear things come singly, which
 *    is what a shop looks like. The band sets a ceiling and the die fills it, so
 *    stocking the same shelf twice does not produce the same shop twice.
 *
 * There was a third rule between them -- a whitelist of *types* that stack -- and it
 * made the whole feature invisible. A general store's shelf is daggers, vials,
 * clothes, chests and tools, and the whitelist excluded every one of them. Price was
 * always what the intuition meant. See `STOCK_DEPTH_BANDS`.
 *
 * The shelf's own "each" limit clamps the result, so a ceiling a GM set by hand is
 * never argued with by a die.
 *
 * `random` is injected so this is testable; it is an ordinary integer roll rather
 * than a `Roll`, because nothing here belongs in chat and a dice animation for
 * restocking a shelf is not a thing anybody asked for.
 */
export function stockDepth(item, { maxPerItem = Infinity, random = Math.random } = {}) {
    const ceiling = Math.max(1, Math.trunc(Number(maxPerItem)) || 1);
    if (!item) return 1;

    // Whether a thing stacks is **read off the document, never assumed** -- the same
    // rule `api-inventory` states for itself, and the reason there is no type list
    // here any more. An item with no `system.quantity` at all has no stack to deepen,
    // and asking for two of it is not a shop with two of them, it is a wrong number.
    if (typeof item?.system?.quantity !== 'number') return 1;

    // 1. The author already answered.
    const authored = Math.trunc(Number(item.system.quantity));
    if (Number.isFinite(authored) && authored > 1) return Math.min(authored, ceiling);

    // 2. The band caps it; the die fills it.
    const price = item?.system?.price;
    const base = Number.isFinite(Number(price?.value))
        ? toBase(Number(price.value), price.denomination ?? 'gp')
        : 0;
    const band = STOCK_DEPTH_BANDS.find((entry) => base < entry.under) ?? { cap: 1 };
    const cap = Math.min(band.cap, ceiling);
    return cap <= 1 ? 1 : 1 + Math.floor(random() * cap);
}


/** Base units back out to an amount of one denomination. The inverse of `toBase`. */
export function fromBase(base, denomination) {
    const amount = Math.max(0, Math.round(Number(base) || 0));
    const to = denominations().find((d) => d.key === denomination);
    const baseUnit = baseDenomination();
    if (!to || !baseUnit.conversion) return amount;
    return (amount / baseUnit.conversion) * to.conversion;
}

/**
 * The coins a shop and its customers actually settle in.
 *
 * Platinum and electrum are left out on purpose. Electrum is vestigial and nobody
 * wants their gold turned into it; platinum is a *store of value* somebody chose to
 * hold, and quietly breaking it to buy a candle would be a worse surprise than the
 * refusal this whole mechanism exists to remove. They are only drawn on when the
 * working coin genuinely cannot cover the price.
 */
const SETTLEMENT_DENOMINATIONS = ['gp', 'sp', 'cp'];

/** The tidiest set of coins worth exactly `base`, largest denomination first. */
export function coinsFor(base, { keys = SETTLEMENT_DENOMINATIONS } = {}) {
    let left = Math.max(0, Math.round(Number(base) || 0));
    const baseUnit = baseDenomination();
    const coins = {};
    for (const d of denominations()) {
        if (!keys.includes(d.key)) continue;
        const perCoin = Math.round(baseUnit.conversion / d.conversion);
        if (perCoin <= 0) continue;
        const count = Math.floor(left / perCoin);
        if (count > 0) {
            coins[d.key] = count;
            left -= count * perCoin;
        }
    }
    return coins;
}

/** What a subset of a purse is worth, in base units. */
export function poolValue(currency, keys = SETTLEMENT_DENOMINATIONS) {
    const baseUnit = baseDenomination();
    return denominations().reduce((total, d) => {
        if (!keys.includes(d.key)) return total;
        const held = Math.trunc(Number(currency?.[d.key]) || 0);
        if (held <= 0) return total;
        return total + held * Math.round(baseUnit.conversion / d.conversion);
    }, 0);
}

/**
 * Coins that come to exactly `base`, taken from what is actually held, or null.
 *
 * Greedy from the largest coin down, which is exact for a system where each
 * denomination divides the next -- gold, silver, copper. It is not a general
 * coin-change solver and does not need to be: when it cannot hit the number, the
 * caller re-mints and asks again.
 */
export function exactPayment(currency, base, { keys = SETTLEMENT_DENOMINATIONS } = {}) {
    let left = Math.max(0, Math.round(Number(base) || 0));
    if (!left) return {};

    const baseUnit = baseDenomination();
    const pay = {};
    for (const d of denominations()) {
        if (!keys.includes(d.key)) continue;
        const perCoin = Math.round(baseUnit.conversion / d.conversion);
        if (perCoin <= 0) continue;
        const held = Math.trunc(Number(currency?.[d.key]) || 0);
        if (held <= 0) continue;
        const spend = Math.min(held, Math.floor(left / perCoin));
        if (spend > 0) {
            pay[d.key] = spend;
            left -= spend * perCoin;
        }
    }
    return left === 0 ? pay : null;
}

/**
 * A purse re-expressed so that exactly `base` can be handed over.
 *
 * **This is what "shops break coins" means, and it is value-neutral.** Nothing is
 * created or destroyed: the same money is re-cut into the coins needed to pay `base`
 * exactly, plus the tidiest form of whatever is left. A purse of one gold piece
 * becomes ten silver when six silver is owed, which is what a person does at a
 * counter without thinking about it.
 *
 * Doing it this way -- rather than letting the payer overshoot and the payee hand
 * change back -- is what removes the whole class of "cannot make change" refusals. A
 * change leg needs the *other* side to hold particular coins, and nothing guarantees
 * a shop holding twenty thousand gold has six silver in the drawer.
 *
 * Returns null when the pool cannot cover it even after re-cutting.
 */
export function remintFor(currency, base, { keys = SETTLEMENT_DENOMINATIONS } = {}) {
    const owed = Math.max(0, Math.round(Number(base) || 0));
    const pool = poolValue(currency, keys);
    if (pool < owed) return null;

    const minted = coinsFor(owed, { keys });
    for (const [denomination, count] of Object.entries(coinsFor(pool - owed, { keys }))) {
        minted[denomination] = (minted[denomination] ?? 0) + count;
    }
    // Denominations outside the pool are somebody's savings and are handed back
    // untouched -- this returns a whole purse, so leaving them out would spend them.
    for (const d of denominations()) {
        if (keys.includes(d.key)) continue;
        const held = Math.trunc(Number(currency?.[d.key]) || 0);
        if (held > 0) minted[d.key] = held;
    }
    return minted;
}

/**
 * Everything needed to settle `base` out of this purse, breaking coins if it must.
 *
 * `remint` is null when the coins already held will do, which is the common case and
 * costs nothing. When it is set, the payer's purse is rewritten to it first and the
 * payment then comes out exactly.
 */
export function planSettlement(currency, base) {
    const owed = Math.max(0, Math.round(Number(base) || 0));
    if (!owed) return { pay: {}, remint: null };

    // Working coin first, so platinum stays where its owner put it; platinum only when
    // the working coin genuinely will not cover the price. Electrum is in neither list:
    // handing somebody electrum they did not have is a worse surprise than the refusal.
    for (const keys of [SETTLEMENT_DENOMINATIONS, ['pp', ...SETTLEMENT_DENOMINATIONS]]) {
        const held = exactPayment(currency, owed, { keys });
        if (held) return { pay: held, remint: null };

        const minted = remintFor(currency, owed, { keys });
        if (minted) return { pay: coinsFor(owed, { keys }), remint: minted };
    }
    return null;
}

/** An actor's whole purse, in base units. */
export function purseValue(actor) {
    const currency = actor?.system?.currency ?? {};
    return denominations().reduce((total, d) => total + toBase(Math.trunc(Number(currency[d.key]) || 0), d.key), 0);
}

/**
 * Which denominations a *price* is written in.
 *
 * Not all of them. Spelling every price across the full set gives "102 pp 5 gp" for
 * a healing potion and "1 pp 2 gp 1 ep" for a crossbow — exact, and unreadable, and
 * not how anybody at a table says it. Prices are quoted in gold, silver and copper.
 *
 * Payment is unaffected: `planPayment` spends whatever coin a purse actually holds,
 * platinum and electrum included. This governs how a number is written down, not
 * which coins change hands.
 *
 * Falls back to every denomination on a system that has none of these, so a
 * non-dnd5e currency table still renders something.
 */
const PRICE_DENOMINATIONS = ['gp', 'sp', 'cp'];

function priceDenominations() {
    const all = denominations();
    const preferred = all.filter((d) => PRICE_DENOMINATIONS.includes(d.key));
    return preferred.length ? preferred : all;
}

/**
 * The denomination a price is quoted in when there is no price to spell out.
 *
 * Zero is an amount of money, not an absence of one, so it is written as money:
 * "0 gp", not a dash. The unit is the one with a conversion of 1 — gold in dnd5e —
 * because that is what a shop quotes in.
 */
function quoteDenomination() {
    const all = priceDenominations();
    return all.find((d) => Number(d.conversion) === 1) ?? all[0] ?? baseDenomination();
}

/** Base units rendered as "3 gp 4 sp", largest coin first, zeroes omitted. */
export function formatBase(base) {
    const amount = Math.max(0, Math.round(Number(base) || 0));
    if (!amount) return `0 ${quoteDenomination().abbreviation.toLowerCase()}`;
    const baseUnit = baseDenomination();
    const parts = [];
    let remaining = amount;
    for (const d of priceDenominations()) {
        const perCoin = Math.round(baseUnit.conversion / d.conversion);
        if (perCoin <= 0) continue;
        const count = Math.floor(remaining / perCoin);
        if (count > 0) {
            // Thousands separated, because "1025 gp" and "10250 gp" are a glance
            // apart and a price list is read at a glance.
            parts.push(`${count.toLocaleString()} ${d.abbreviation.toLowerCase()}`);
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
    // An agreed price wins outright, which is what makes it agreed.
    const negotiated = negotiatedPrice(merchantConfig, item?.id);
    if (negotiated !== null) return negotiated;

    // A negotiate shelf has no list price by definition: what a thing costs there is
    // whatever the two of you settle on, and until you have settled there is no
    // number. Anything else would be putting a price on the shelf that exists so as
    // not to have one.
    if (shelfConfig?.mode === SHELF_MODE.BARTER) return null;

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
 * A price the GM has agreed for one item, in base units, or null.
 *
 * Stored on the merchant rather than carried in the request, because the price is
 * the one number in a transaction a player must not be able to name. A slate is
 * client state; this is a document, and the GM handler reads the document.
 */
export function negotiatedPrice(merchantConfig, itemId) {
    const agreed = merchantConfig?.pricing?.overrides?.[itemId];
    if (agreed === null || agreed === undefined) return null;
    // A plain number is base units, which is what the negotiate control writes. The
    // `{ value, denomination }` shape is what a per-item override was before it, and
    // is still read so nothing configured earlier stops working.
    if (Number.isFinite(Number(agreed))) return Math.max(0, Math.round(Number(agreed)));
    if (Number.isFinite(Number(agreed.value))) return toBase(Number(agreed.value), agreed.denomination ?? 'gp');
    return null;
}

/** What the GM has agreed to pay for one thing the party is selling, or null. */
export function negotiatedBuyback(merchantConfig, itemId) {
    const agreed = merchantConfig?.pricing?.buybackOverrides?.[itemId];
    return Number.isFinite(Number(agreed)) ? Math.max(0, Math.round(Number(agreed))) : null;
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
    const agreed = negotiatedBuyback(merchantConfig, item?.id);
    if (agreed !== null) return agreed;

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
