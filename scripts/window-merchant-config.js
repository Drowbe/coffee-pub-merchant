import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import {
    MODULE, INVENTORY_TYPES, inventoryType, DEFAULT_BUY_RATE, hoursPerDay, formatHour, STOCK,
    DEFAULT_RESTOCK_DAYS, SHOP_KINDS, DEFAULT_SHOP_KIND, isAlwaysOpen, isAlwaysClosed, REPUTATION_MARKUP,
    STOCK_DEPTH_OPTIONS, DEFAULT_STOCK_DEPTH, typeCaps, rarityCaps, SOURCE, DEFAULT_SOURCE,
    PRICE_STOPS, priceStopIndex, priceStopLabel,
    inventoryTypeName, inventoryTypeHint, depthLabel, depthHint,
    MAX_BUYBACK_RATIO, normalizeTint, HOUSE_TINT, rarityLabel, drawsFromQuery, drawsFromTables,
    SHOP_SOUND_KEYS,
    SHOP_DOORS,
    DELIVERY_POINT,
    shopProfile, missingShelves
} from './const.js';
import { hasPins, canPin } from './utility-pins.js';
import { canPrint } from './utility-catalogue.js';
import { MerchantManager } from './manager-merchant.js';
import { purseValue, formatBase, denominations, safeBuyRate } from './utility-pricing.js';
import {
    hasQuery, RARITIES, normalizeQuery, describeQuery,
    curatedSources, describeSource, allItemPacks, packIdFromDrop, isItemPack
} from './utility-compendium.js';
import { physicalTypes } from './utility-inventory.js';
import { startProgress } from './utility-progress.js';
import { notify, playFeedback, SOUND } from './utility-feedback.js';
import { soundLibrary } from './settings.js';


const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-merchant-config.hbs';
const RATE_PARTIAL = 'modules/coffee-pub-merchant/templates/partial-rate.hbs';
let _partialsReady = null;

function _blacksmith() {
    return game.modules.get('coffee-pub-blacksmith')?.api ?? null;
}

/**
 * What happens to this inventory when something is bought.
 *
 * **Four answers in one control, where there used to be a policy *and* a checkbox on
 * every roll table.** "Restocking, and also tick reroll on each table" is one decision
 * a GM makes, and splitting it across two places meant an inventory could be set to
 * restock while every table it owned quietly declined to — a state nobody wants and
 * nothing warned about.
 *
 * The last two differ only in what the restock does, so they map onto the same stored
 * policy plus the tables' `auto` flag. Nothing new is stored; the control simply
 * writes both halves of the decision at once.
 */
const METHOD = Object.freeze({
    INFINITE: STOCK.INFINITE,
    FINITE: STOCK.FINITE,
    SAME: 'same',
    NEW: 'new'
});

/**
 * A method's label, resolved when it is shown.
 *
 * **Not a table of already-translated strings.** A `const` at module scope is evaluated
 * when Foundry loads the script, and `game` does not exist yet -- the same failure that
 * took the module down over the base class, and it fails the same way: ESM caches the
 * throw, so the module is dead for the session rather than retried. Anything that reads
 * `game` has to be a function.
 */
function methodLabel(method) {
    const key = {
        [METHOD.INFINITE]: 'infinite',
        [METHOD.FINITE]: 'finite',
        [METHOD.SAME]: 'same',
        [METHOD.NEW]: 'new'
    }[method];
    return key ? game.i18n.localize(`coffee-pub-merchant.method.${key}`) : String(method);
}

/** The stored policy and table flags a chosen method implies. */
function methodToStorage(method) {
    if (method === METHOD.NEW) return { stock: STOCK.RESTOCKING, auto: true };
    if (method === METHOD.SAME) return { stock: STOCK.RESTOCKING, auto: false };
    return { stock: method, auto: false };
}

/** Which method an inventory is currently in, read back from what is stored. */
function methodFromStorage(policy, tables) {
    if (policy !== STOCK.RESTOCKING) return policy;
    return tables.some((entry) => entry.auto) ? METHOD.NEW : METHOD.SAME;
}

/**
 * A rate, said as a number and as what it means.
 *
 * **"markup" and "discount", never "dearer".** Those are the words already printed on
 * the section that holds them, and they are what a shopkeeper says. A comparative
 * adjective makes the reader work out what it is being compared to.
 */
function markupLabel(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return '—';
    if (rate === 1) return game.i18n.localize('coffee-pub-merchant.rate.listPrice');
    const percent = Math.round(Math.abs(1 - rate) * 100);
    return rate > 1
        ? game.i18n.format('coffee-pub-merchant.rate.markup', { percent })
        : game.i18n.format('coffee-pub-merchant.rate.discount', { percent });
}

/**
 * What the shop pays, which is a share of an item's value rather than a markup.
 *
 * **Above the safe line the badge says what actually happens, not what was typed.** A
 * shop can be farmed when it pays more for a thing than it charges for one, so
 * `MAX_BUYBACK_RATIO` caps the offer against this inventory's own resale price. Past
 * that point the cap governs and the slider does not — and because the cap *falls* as
 * the party's standing improves while the offer *rises*, the shop ends up paying a
 * well-liked party **less** than a neutral one. That is a genuinely surprising outcome
 * to arrive at by dragging a slider rightwards, and the badge used to keep cheerfully
 * reporting the typed figure while it happened.
 */
function buyRateLabel(value, { safe = null, worstCase = null } = {}) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return '—';
    const typed = game.i18n.format('coffee-pub-merchant.rate.pays', { percent: Math.round(rate * 100) });
    if (safe === null || rate <= safe) return typed;
    return game.i18n.format('coffee-pub-merchant.rate.paysCapped', { typed, capped: Math.round(worstCase * 100) });
}

/**
 * A slider bound, as a percentage.
 *
 * **Nobody reads ×1.20 as "a fifth dearer".** The multiplier is how it is stored and
 * how the arithmetic works; a percentage is what a shopkeeper is deciding. Signed, so
 * the two ends of a markup slider say which way they go without a legend.
 */
function markupBound(value) {
    const percent = Math.round((Number(value) - 1) * 100);
    if (percent === 0) return game.i18n.localize('coffee-pub-merchant.rate.listShort');
    return `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`;
}

function buyRateBound(value) {
    return `${Math.round(Number(value) * 100)}%`;
}

/**
 * Where the buyback clamp starts governing, and what it governs at.
 *
 * Measured at the **best** standing a party can reach, because that is where the line
 * is tightest and where the inversion is worst — a rate safe there is safe everywhere.
 * `worstCase` is what the shop would actually pay at that standing, which is the
 * number a GM is surprised by and therefore the number worth printing.
 */
function buybackLimits(sellMarkup) {
    const best = Math.min(...Object.values(REPUTATION_MARKUP));
    const safe = safeBuyRate(sellMarkup, best);
    return { safe, worstCase: sellMarkup * best * MAX_BUYBACK_RATIO };
}

function rateReadout(kind, value, limits) {
    return kind === 'buy' ? buyRateLabel(value, limits) : markupLabel(value);
}

/** The shape `partial-rate.hbs` renders. One builder, so the three rates agree. */
function rateRow({ label, kind, value, inventoryId = null, field = null, hint = null, limits = null }) {
    const buy = kind === 'buy';
    const min = buy ? 0.05 : 0.1;
    const max = buy ? 1.5 : 3;
    return {
        label,
        kind,
        field,
        inventoryId,
        value,
        min,
        max,
        step: 0.05,
        minLabel: buy ? buyRateBound(min) : markupBound(min),
        maxLabel: buy ? buyRateBound(max) : markupBound(max),
        // Where list price sits on this track, as a percentage of its width, so the
        // channel can be red below it and green above without the template doing
        // arithmetic. Both sliders cross 1.0, but at different points.
        neutralPercent: `${(((1 - min) / (max - min)) * 100).toFixed(2)}%`,
        readout: rateReadout(kind, value, limits),
        // **The line goes into the markup, so dragging can respond to it.** The readout
        // repaints on every `input` event and the commit only lands on release, so a
        // warning computed here alone would appear after the decision instead of during
        // it — which is the one moment it is worth anything.
        safe: limits?.safe ?? null,
        worstCase: limits?.worstCase ?? null,
        // Rendered whenever there is a line to cross, and hidden until it is crossed.
        // Present-but-hidden rather than absent, so the slider handler has something to
        // reveal without building DOM mid-drag.
        warning: limits
            ? game.i18n.format('coffee-pub-merchant.rate.farmWarning', { safe: Math.round(limits.safe * 100) })
            : null,
        warned: Boolean(limits) && Number(value) > limits.safe,
        hint
    };
}

/**
 * How often a restocking inventory refills.
 *
 * A named cadence rather than a number of days in a sentence. "Every [7] days" made
 * the reader assemble the setting out of a phrase; a list of the answers people
 * actually want is one glance, and the custom case is still expressible by a GM who
 * edits the flag.
 */
const FREQUENCY_OPTIONS = [
    { value: 1, label: 'Daily' },
    { value: 3, label: 'Every 3 days' },
    { value: 7, label: 'Weekly' },
    { value: 14, label: 'Fortnightly' },
    { value: 30, label: 'Monthly' }
];

/**
 * Marking and configuring a merchant.
 *
 * A window rather than a confirmation dialog on purpose: stock policy, markup,
 * trading hours and per-inventory settings all land here, and they need somewhere to go
 * that is not a growing pile of prompts.
 */
export class MerchantConfigWindow extends BlacksmithToolWindowBaseV2 {
    // The one-window-per-actor registry is the base class's. See `window-shop.js`.

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-config-window'],
            position: { width: 520, height: 620 },
            window: { title: 'Merchant Settings', resizable: true, minimizable: true },
            // **A floor, not a ceiling.** `maxWidth` was doing the work here: 720 capped a
            // window a GM might reasonably want wider — three cards of pills, a slider and
            // two rate tracks all read better with room — while the floor was low enough
            // to let it be dragged down to a size nothing fits in. The cap is gone and the
            // floor is where the content actually stops working: below 475 the rate
            // sliders and the chip rows start wrapping into each other, and below 550
            // there is not enough height to see a card and its controls at once.
            //
            // `height` is a number rather than 'auto' for the same reason. Auto grows to
            // the content, so a merchant with six inventories opened at the full height of
            // the screen and could not be made smaller than its own contents.
            windowSizeConstraints: { minWidth: 475, minHeight: 550, maxHeight: 'calc(100vh - 80px)' },
            toolTitlebar: 'full',
            // One saved position for every merchant's settings, for the reason the
            // shop shares one: it is the same window about a different shop.
            rememberPosition: true,
            windowPositionKey: 'merchant-config'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        addInventory: (event, target, win) => void win.openInventoryMenu(event, target),
        applyProfile: (_event, _target, win) => void win.applyProfile(),
        toggleProfiles: (_event, _target, win) => win.toggleProfiles(),
        saveProfile: (_event, _target, win) => void win.saveProfile(),
        deleteProfile: (_event, _target, win) => void win.deleteProfile(),
        openInventory: (_event, target, win) => void win.openInventory(target.dataset.inventoryId),
        toggleInventoryVisible: (_event, target, win) => void win.toggleInventoryVisible(target.dataset.inventoryId),
        removeInventory: (_event, target, win) => void win.removeInventory(target.dataset.inventoryId),
        restockInventory: (_event, target, win) => void win.restockInventory(target.dataset.inventoryId),
        clearInventory: (_event, target, win) => void win.clearInventory(target.dataset.inventoryId),
        restockAll: (_event, _target, win) => void win.restockAll(),
        useCuratedSources: (_event, target, win) =>
            void win._setSources(target.dataset.inventoryId, null),
        useCustomSources: (_event, target, win) =>
            void win._setSources(target.dataset.inventoryId, []),
        moveInventoryUp: (_event, target, win) => void win._moveInventory(target.dataset.inventoryId, -1),
        moveInventoryDown: (_event, target, win) => void win._moveInventory(target.dataset.inventoryId, 1),
        removeInventorySource: (_event, target, win) =>
            void win._removeSource(target.dataset.inventoryId, target.dataset.packId),
        removeInventoryTable: (_event, target, win) =>
            void win.removeInventoryTable(target.dataset.inventoryId, target.dataset.tableUuid)
    };

    constructor(actor, options = {}) {
        const opts = foundry.utils.mergeObject({}, options);
        opts.id ||= `merchant-config-${actor.id}`;
        opts.position = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, MerchantConfigWindow.DEFAULT_OPTIONS.position ?? {}),
            opts.position || {}
        );
        opts.window = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, MerchantConfigWindow.DEFAULT_OPTIONS.window ?? {}),
            opts.window || {}
        );
        super(opts);
        this.actorUuid = actor.uuid;
    }

    /**
     * The door, and the only thing it adds to `openFor` is the GM gate.
     *
     * Kept as a named entry point rather than pushing `openFor` out to the call
     * sites: this window configures a shop, so who may open it is a rule of ours,
     * and the base class deliberately holds no permission opinions.
     */
    static async open(actor) {
        if (!game.user.isGM) return null;
        return this.openFor(actor);
    }

    /**
     * The same door the shop window uses, because it is the same merchant.
     *
     * `fromUuidSync` rather than the async resolver: a lifecycle hook cannot await, and an
     * Actor this window was opened for is in memory by definition.
     */
    _door(which) {
        let actor = null;
        try {
            actor = fromUuidSync(this.actorUuid);
        } catch (_error) {
            actor = null;
        }
        playFeedback(which, actor ? MerchantManager.soundFor(actor, which === SOUND.WINDOW_OPEN ? 'open' : 'close') : null);
    }

    _onFirstRender(context, options) {
        super._onFirstRender?.(context, options);
        this._door(SOUND.WINDOW_OPEN);
    }

    _onClose(options) {
        // A tick the GM can already see on the pill is a decision they have made. It is
        // written now rather than dropped because a debounce timer had not fired.
        this._flushQueryWrites();
        this._door(SOUND.WINDOW_CLOSE);
        super._onClose?.(options);
    }

    async _resolveActor() {
        return fromUuid(this.actorUuid);
    }

    /**
     * The window base delegates click only, and a checkbox reports its value on
     * change, so the toggle is wired here rather than through ACTION_HANDLERS.
     */
    _onRender(context, options) {
        super._onRender?.(context, options);
        this._flushQueryWrites();
        const toggle = this.element?.querySelector('[data-merchant-enabled]');
        if (toggle && toggle.dataset.merchantBound !== 'true') {
            toggle.dataset.merchantBound = 'true';
            toggle.addEventListener('change', (event) => void this._setEnabled(event.target.checked));
        }
        this._bindHoursSlider();

        this._bindRateSliders();

        const shopName = this.element?.querySelector('[data-merchant-name]');
        if (shopName && shopName.dataset.merchantBound !== 'true') {
            shopName.dataset.merchantBound = 'true';
            shopName.addEventListener('change', (event) => {
                // Blank means "call it after the shopkeeper", so it is stored as null
                // rather than as an empty string that would read as a name of nothing.
                const value = String(event.target.value ?? '').trim();
                void this._setField({ name: value || null }, { redraw: false });
            });
        }

        // A merchant's own door, or blank for the world's. Written as null rather than an
        // empty string so the flag says "no opinion" rather than "a sound called nothing".
        for (const select of this.element?.querySelectorAll('[data-merchant-sound]') ?? []) {
            if (select.dataset.merchantBound === 'true') continue;
            select.dataset.merchantBound = 'true';
            select.addEventListener('change', (event) => {
                const which = select.getAttribute('data-merchant-sound');
                const sounds = { ...(MerchantManager.getConfig(fromUuidSync(this.actorUuid)) ?? {}).sounds };
                sounds[which] = event.target.value || null;
                void this._setField({ sounds }, { redraw: false });
            });
        }

        const kind = this.element?.querySelector('[data-merchant-kind]');
        if (kind && kind.dataset.merchantBound !== 'true') {
            kind.dataset.merchantBound = 'true';
            kind.addEventListener('change', (event) => void this._setField({ kind: event.target.value }));
        }

        const fullscreen = this.element?.querySelector('[data-merchant-fullscreen]');
        if (fullscreen && fullscreen.dataset.merchantBound !== 'true') {
            fullscreen.dataset.merchantBound = 'true';
            fullscreen.addEventListener('change', (event) => {
                // The pill answers the click rather than the round trip, as the query chips do.
                event.target.closest('.merchant-config-chip')?.classList.toggle('is-on', event.target.checked);
                // **Every door, stated, on every tick -- including the ones that are off.**
                // `setConfig` merges, and a merge cannot express an absence: a door left out
                // of the write keeps whatever it had. Collecting only the ticked boxes made
                // unticking one do nothing at all -- it wrote `{region: true}` over
                // `{region: true, catalogue: true}` and the catalogue survived the merge.
                // Writing `false` says it, which is the only thing a merge hears.
                const doors = {};
                for (const box of fullscreen.querySelectorAll('input[type="checkbox"]')) {
                    doors[box.value] = box.checked;
                }
                void this._setField({ fullscreen: doors }, { redraw: false });
            });
        }

        // The two delivery flags: is this shop somewhere a parcel can arrive. Where *else*
        // a parcel can go is a list of places in the world rather than a fact about this
        // shop, so it is a world setting -- see `registerDeliveryPlaces`. The chip answers
        // the click itself, for the reason the door chips above do.
        for (const [attribute, field] of [
            ['data-merchant-delivery-physical', DELIVERY_POINT.PHYSICAL],
            ['data-merchant-delivery-portal', DELIVERY_POINT.PORTAL]
        ]) {
            const box = this.element?.querySelector(`[${attribute}]`);
            if (!box || box.dataset.merchantBound === 'true') continue;
            box.dataset.merchantBound = 'true';
            box.addEventListener('change', (event) => {
                event.target.closest('.merchant-config-enable')?.classList
                    .toggle('is-on', event.target.checked);
                void this._setField({ [field]: event.target.checked }, { redraw: false });
            });
        }

        const profile = this.element?.querySelector('[data-merchant-profile]');
        if (profile && profile.dataset.merchantBound !== 'true') {
            profile.dataset.merchantBound = 'true';
            // Re-rendered rather than merely stored, so the hint under the picker describes
            // the profile now selected. Nothing is written to the shop until Apply.
            profile.addEventListener('change', (event) => {
                this._profile = event.target.value;
                void this.render(false);
            });
        }

        const description = this.element?.querySelector('[data-merchant-description]');
        if (description && description.dataset.merchantBound !== 'true') {
            description.dataset.merchantBound = 'true';
            // On blur rather than input: a description is a paragraph, and writing to
            // a flag per keystroke would be a write per keystroke to every client.
            description.addEventListener('change', (event) => {
                void this._setField({ description: event.target.value ?? '' }, { redraw: false });
            });
        }

        // One box per denomination, each writing only its own coin.
        for (const input of this.element?.querySelectorAll('[data-merchant-coin]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';
            input.addEventListener('change', (event) => {
                void this._setTillCoin(input.getAttribute('data-merchant-coin'), event.target.value);
            });
        }

        // **Two range inputs behaving as one range**, the same control the trading hours
        // use. Dragging repaints the label and the band; the write lands on release, so a
        // drag across nine stops is one document update rather than nine.
        for (const root of this.element?.querySelectorAll('[data-price-slider]') ?? []) {
            if (root.dataset.merchantBound === 'true') continue;
            root.dataset.merchantBound = 'true';

            const inventoryId = root.getAttribute('data-price-slider');
            const minInput = root.querySelector('[data-price-min]');
            const maxInput = root.querySelector('[data-price-max]');
            const fill = root.querySelector('[data-price-fill]');
            const label = root.closest('.merchant-config-inv-group')?.querySelector('[data-price-label]');
            if (!minInput || !maxInput) continue;

            const stopsFor = () => {
                // The handles cannot cross: whichever is being dragged pushes the other
                // rather than passing it, so the range never reads back to front.
                const low = Math.min(Number(minInput.value), Number(maxInput.value));
                const high = Math.max(Number(minInput.value), Number(maxInput.value));
                return { low, high };
            };

            const paint = () => {
                const { low, high } = stopsFor();
                const span = PRICE_STOPS.length - 1;
                if (fill) {
                    const from = (low / span) * 100;
                    const to = (high / span) * 100;
                    fill.style.background =
                        `linear-gradient(90deg, transparent 0 ${from}%, var(--merchant-open-bar) ${from}% ${to}%, transparent ${to}% 100%)`;
                }
                if (label) {
                    label.textContent = game.i18n.format('coffee-pub-merchant.query.priceRange', {
                        min: priceStopLabel(low),
                        max: priceStopLabel(high)
                    });
                }
            };

            const commit = () => {
                const { low, high } = stopsFor();
                const current = this._queryOf(inventoryId);
                const max = PRICE_STOPS[high];
                void this._commitInventoryStock(inventoryId, {
                    query: {
                        ...current,
                        // Null rather than Infinity: a stored query is a document flag and
                        // JSON turns Infinity into null anyway — storing null on purpose
                        // makes the round trip mean what it said.
                        priceGp: { min: PRICE_STOPS[low], max: Number.isFinite(max) ? max : null }
                    }
                });
            };

            for (const input of [minInput, maxInput]) {
                input.addEventListener('input', paint);
                input.addEventListener('change', commit);
            }
            paint();
        }

        const portrait = this.element?.querySelector('[data-merchant-portrait]');
        if (portrait && portrait.dataset.merchantBound !== 'true') {
            portrait.dataset.merchantBound = 'true';
            portrait.addEventListener('click', () => void this._pickPortrait());
        }

        const illustration = this.element?.querySelector('[data-merchant-illustration-browse]');
        if (illustration && illustration.dataset.merchantBound !== 'true') {
            illustration.dataset.merchantBound = 'true';
            illustration.addEventListener('click', () => void this._pickIllustration());
        }

        // Three controls, one value. The text box is the one that can say "none", the
        // swatch is the one that can browse a colour, and the cross is the fast way back
        // to none -- a GM who has just seen a tint they dislike should not have to select
        // six characters to be rid of it.
        const tintField = this.element?.querySelector('[data-merchant-tint]');
        if (tintField && tintField.dataset.merchantBound !== 'true') {
            tintField.dataset.merchantBound = 'true';
            tintField.addEventListener('change', (event) => {
                // Rubbish is cleared rather than kept: the field would otherwise sit
                // there reading `ochre` while the card showed no tint at all.
                void this._setField({ tint: normalizeTint(event.target.value) });
            });
        }

        const tintSwatch = this.element?.querySelector('[data-merchant-tint-swatch]');
        if (tintSwatch && tintSwatch.dataset.merchantBound !== 'true') {
            tintSwatch.dataset.merchantBound = 'true';
            // `change` rather than `input`: a native colour picker fires continuously
            // while the cursor moves around the wheel, and each one would be a document
            // write broadcast to every client.
            tintSwatch.addEventListener('change', (event) => {
                void this._setField({ tint: normalizeTint(event.target.value) });
            });
        }

        const tintClear = this.element?.querySelector('[data-merchant-tint-clear]');
        if (tintClear && tintClear.dataset.merchantBound !== 'true') {
            tintClear.dataset.merchantBound = 'true';
            tintClear.addEventListener('click', () => void this._setField({ tint: null }));
        }

        const illustrationField = this.element?.querySelector('[data-merchant-illustration]');
        if (illustrationField && illustrationField.dataset.merchantBound !== 'true') {
            illustrationField.dataset.merchantBound = 'true';
            // Typed as well as browsed: a path pasted from elsewhere is a real way to
            // set one, and blank is how it is cleared.
            illustrationField.addEventListener('change', (event) => {
                const value = String(event.target.value ?? '').trim();
                void this._setField({ illustration: value || null });
            });
        }

        for (const select of this.element?.querySelectorAll('[data-inventory-source]') ?? []) {
            if (select.dataset.merchantBound === 'true') continue;
            select.dataset.merchantBound = 'true';
            select.addEventListener('change', (event) => {
                void this._commitInventoryStock(select.getAttribute('data-inventory-source'), {
                    source: event.target.value
                });
            });
        }

        // **The whole set is written on every tick, never a delta.** A stored list of
        // kinds is what the shelf carries; reading one checkbox would leave the other
        // six unstated and the next render would disagree with the box just clicked.
        for (const [attribute, field] of [
            ['data-inventory-query-kinds', 'subtypes'],
            ['data-inventory-query-rarity', 'rarity']
        ]) {
            for (const group of this.element?.querySelectorAll(`[${attribute}]`) ?? []) {
                if (group.dataset.merchantBound === 'true') continue;
                group.dataset.merchantBound = 'true';
                group.addEventListener('change', (event) => {
                    // **The pill answers the click, not the round trip.** The label is
                    // the control now, so its state has to change on the click rather
                    // than when a document write and a re-render come back.
                    const box = event.target;
                    box.closest('.merchant-config-chip')?.classList.toggle('is-on', box.checked);

                    const inventoryId = group.getAttribute(attribute);
                    // **Coalesced.** Setting up a shelf is half a dozen clicks in a row,
                    // and each one is two document writes plus a broadcast to every
                    // client. Batched, that burst is one write; the pills are already
                    // showing the answer, so nothing is waiting on it.
                    const write = () => {
                        const chosen = [...group.querySelectorAll('input[type="checkbox"]')]
                            .filter((input) => input.checked)
                            .map((input) => input.value);
                        // Every kind ticked is stored as "no filter" rather than a list of
                        // all of them: a shelf that meant "anything" would otherwise
                        // silently narrow the day dnd5e adds a physical type.
                        const value = field === 'subtypes' && chosen.length === physicalTypes().length
                            ? null
                            : chosen;
                        void this._commitInventoryStock(
                            inventoryId,
                            { query: { ...this._queryOf(inventoryId), [field]: value } },
                            { redraw: false }
                        );
                    };

                    clearTimeout(this._queryWrites.get(group)?.timer);
                    this._queryWrites.set(group, {
                        run: write,
                        timer: setTimeout(() => { this._queryWrites.delete(group); write(); }, 300)
                    });
                });
            }
        }


        for (const select of this.element?.querySelectorAll('[data-inventory-depth]') ?? []) {
            if (select.dataset.merchantBound === 'true') continue;
            select.dataset.merchantBound = 'true';
            select.addEventListener('change', (event) => {
                void this._commitInventoryStock(select.getAttribute('data-inventory-depth'), {
                    depth: event.target.value
                });
            });
        }

        for (const select of this.element?.querySelectorAll('[data-inventory-frequency]') ?? []) {
            if (select.dataset.merchantBound === 'true') continue;
            select.dataset.merchantBound = 'true';
            select.addEventListener('change', (event) => {
                void this._commitInventoryStock(select.getAttribute('data-inventory-frequency'), {
                    restockDays: Math.max(1, Math.trunc(Number(event.target.value) || DEFAULT_RESTOCK_DAYS))
                });
            });
        }

        const reputation = this.element?.querySelector('[data-merchant-reputation]');
        if (reputation && reputation.dataset.merchantBound !== 'true') {
            reputation.dataset.merchantBound = 'true';
            reputation.addEventListener('change', (event) => void this._setReputation(event.target.checked));
        }

        // An inventory's name is the container's name. Written on change rather than
        // per keystroke, and without a redraw, because the field already shows what
        // was typed and a re-render would take the caret with it.
        for (const input of this.element?.querySelectorAll('[data-inventory-name]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';
            input.addEventListener('change', (event) => {
                void this._setInventoryName(input.getAttribute('data-inventory-name'), event.target.value);
            });
        }

        // The artwork opens a file picker. Foundry namespaced FilePicker in v13, so
        // it is reached through `foundry.applications.apps` rather than the global.
        for (const button of this.element?.querySelectorAll('[data-inventory-image]') ?? []) {
            if (button.dataset.merchantBound === 'true') continue;
            button.dataset.merchantBound = 'true';
            button.addEventListener('click', (event) => {
                event.preventDefault();
                void this._pickInventoryImage(button.getAttribute('data-inventory-image'));
            });
        }

        // Per-inventory policy and cadence. Both write through the same helper, since
        // both are one field of an inventory's configuration.
        for (const select of this.element?.querySelectorAll('[data-inventory-stock]') ?? []) {
            if (select.dataset.merchantBound === 'true') continue;
            select.dataset.merchantBound = 'true';
            select.addEventListener('change', (event) => {
                void this._setMethod(select.getAttribute('data-inventory-stock'), event.target.value);
            });
        }

        for (const input of this.element?.querySelectorAll('[data-inventory-table-rolls]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';
            // Select on focus, because these are two-character values that are always
            // replaced rather than edited: clicking in and typing should give you the
            // number you typed, not the one you typed appended to the old one.
            input.addEventListener('focus', () => input.select());
            input.addEventListener('change', (event) => {
                void this._setTableRolls(
                    input.getAttribute('data-inventory-table-rolls'),
                    input.getAttribute('data-table-uuid'),
                    event.target.value
                );
            });
        }

        for (const box of this.element?.querySelectorAll('[data-inventory-source-enabled]') ?? []) {
            if (box.dataset.merchantBound === 'true') continue;
            box.dataset.merchantBound = 'true';
            box.addEventListener('change', (event) => {
                void this._setSourceEnabled(
                    box.getAttribute('data-inventory-source-enabled'),
                    box.getAttribute('data-pack-id'),
                    event.target.checked
                );
            });
        }

        for (const box of this.element?.querySelectorAll('[data-inventory-table-enabled]') ?? []) {
            if (box.dataset.merchantBound === 'true') continue;
            box.dataset.merchantBound = 'true';
            box.addEventListener('change', (event) => {
                void this._setTableEnabled(
                    box.getAttribute('data-inventory-table-enabled'),
                    box.getAttribute('data-table-uuid'),
                    event.target.checked
                );
            });
        }

        // **Both ceilings are on screen, because they answer different questions.**
        // Products is how many *lines* this shelf carries, and it is the target a roll
        // fills back up to; Max stack is how deep any one line goes. The first was a
        // constant while a roll clipped against it and the roll count was the only real
        // dial -- now that a roll adds new lines only, the line count is the number a
        // GM actually reaches for.
        //
        // Superseded note, kept because the reasoning was right at the time:
        // Only one ceiling is on screen now. `maxProducts` is still enforced when a
        // table rolls, as a backstop against an unattended reroll filling a shop, but
        // it is a constant rather than a control — the roll count is what a GM uses to
        // say how much arrives, and two numbers for one idea was the confusion.
        for (const [attribute, field, ceiling] of [
            ['data-inventory-max-per-item', 'maxPerItem', 999],
            ['data-inventory-max-products', 'maxProducts', 999]
        ]) {
            for (const input of this.element?.querySelectorAll(`[${attribute}]`) ?? []) {
                if (input.dataset.merchantBound === 'true') continue;
                input.dataset.merchantBound = 'true';
                input.addEventListener('change', (event) => {
                    const value = Math.min(ceiling, Math.max(1, Math.trunc(Number(event.target.value) || 1)));
                    void this._commitInventoryStock(input.getAttribute(attribute), { [field]: value });
                });
            }
        }


        // Dragged, like the tables beside it: a pack dragged out of the sidebar is how
        // somebody says which pack they mean, and a dropdown of forty compendium names
        // is a worse way to answer the same question.
        for (const zone of this.element?.querySelectorAll('[data-drop-source]') ?? []) {
            if (zone.dataset.merchantBoundDrop === 'true') continue;
            zone.dataset.merchantBoundDrop = 'true';
            const inventoryId = zone.getAttribute('data-drop-source');

            zone.addEventListener('dragover', (event) => {
                event.preventDefault();
                zone.classList.add('is-dropping');
            });
            zone.addEventListener('dragleave', () => zone.classList.remove('is-dropping'));
            zone.addEventListener('drop', (event) => {
                event.preventDefault();
                zone.classList.remove('is-dropping');
                void this._onDropCompendium(event, inventoryId);
            });
        }

        for (const zone of this.element?.querySelectorAll('[data-drop-table]') ?? []) {
            if (zone.dataset.merchantBoundDrop === 'true') continue;
            zone.dataset.merchantBoundDrop = 'true';
            const inventoryId = zone.getAttribute('data-drop-table');

            zone.addEventListener('dragover', (event) => {
                event.preventDefault();
                zone.classList.add('is-dropping');
            });
            zone.addEventListener('dragleave', () => zone.classList.remove('is-dropping'));
            zone.addEventListener('drop', (event) => {
                event.preventDefault();
                zone.classList.remove('is-dropping');
                void this._onDropTable(event, inventoryId);
            });
        }
    }

    /**
     * Write one or more config fields.
     *
     * `redraw: false` for anything the user is still typing in — re-rendering under a
     * textarea would take the caret with it, and the field already shows what was
     * saved.
     */
    async _setField(changes, { redraw = true } = {}) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setConfig(actor, changes);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not update this merchant:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.merchantFailed'));
        }
        if (redraw) await this.render(false);
    }

    /** What the shop can pay out. A merchant with an empty till cannot buy anything. */
    async _setTillCoin(denomination, value) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setTillCoin(actor, denomination, value);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set the till:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.tillFailed'));
        }
        await this.render(false);
    }

    /**
     * Say that a write landed.
     *
     * Settings save as they are changed, which is right — a form you can lose by
     * closing is worse — but live saving with no acknowledgement reads as nothing
     * happening. A pip in the title row, shown for a moment after each successful
     * write, is the smallest honest answer: it appears *because* something was
     * written, so it cannot claim a save that did not happen.
     */
    flashSaved() {
        const pip = this.element?.querySelector('[data-saved-pip]');
        if (!pip) return;
        pip.classList.add('is-visible');
        clearTimeout(this._savedTimer);
        this._savedTimer = setTimeout(() => pip.classList.remove('is-visible'), 1400);
    }

    /** Move an inventory up or down the shop. */
    async _moveInventory(inventoryId, delta) {
        const actor = await this._resolveActor();
        if (!actor || !inventoryId) return;
        try {
            if (await MerchantManager.moveInventory(actor, inventoryId, delta)) this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not reorder the inventories:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.reorderFailed'));
        }
        await this.render(false);
    }

    /** Switch a shelf between the curated set and its own list. */
    async _setSources(inventoryId, sources) {
        const actor = await this._resolveActor();
        if (!actor || !inventoryId) return;
        try {
            await MerchantManager.setInventorySources(actor, inventoryId, sources);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not change the compendium list:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.compendiumAddFailed'));
        }
        await this.render(false);
    }

    /** Switch one compendium on or off without taking it off the list. */
    async _setSourceEnabled(inventoryId, packId, enabled) {
        const actor = await this._resolveActor();
        if (!actor || !inventoryId || !packId) return;
        try {
            await MerchantManager.setInventorySourceEnabled(actor, inventoryId, packId, enabled);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not change that compendium:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.compendiumAddFailed'));
        }
        await this.render(false);
    }

    /** Take one compendium off a shelf's list. */
    async _removeSource(inventoryId, packId) {
        const actor = await this._resolveActor();
        if (!actor || !inventoryId || !packId) return;
        try {
            await MerchantManager.removeInventorySource(actor, inventoryId, packId);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not remove that compendium:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.compendiumAddFailed'));
        }
        await this.render(false);
    }

    /**
     * Add a compendium to a shelf's own list by dropping it.
     *
     * Takes a pack dragged from the sidebar **or** any document dragged out of one --
     * both name a pack, and finding the pack you want by finding a thing in it is how
     * anybody actually browses. Anything else says what it was rather than failing
     * silently, because a drop that does nothing reads as a broken target.
     */
    async _onDropCompendium(event, inventoryId) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}');
        } catch (_error) {
            return;
        }

        // The mirror of the near miss on the table zone: a roll table wants the list above,
        // not this one, and saying so beats refusing it as "not an item pack" -- which is
        // true of the table and not the point.
        if (data?.type === 'RollTable') {
            notify.info(game.i18n.localize('coffee-pub-merchant.notify.dropTableOnTables'));
            return;
        }

        // **A compendium of roll tables is a compendium**, and this list holds item packs.
        // Without this the pack was added and then displayed as *Gone* -- a row claiming
        // the compendium had been uninstalled when it was installed and simply held the
        // wrong kind of thing.
        const packId = packIdFromDrop(data);
        if (packId && !isItemPack(packId)) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.notAnItemPack'));
            return;
        }

        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            const added = await MerchantManager.addInventorySourceFromDrop(actor, inventoryId, data);
            if (added) MerchantManager.broadcastActorRefresh(actor);
            else notify.info(game.i18n.localize('coffee-pub-merchant.notify.compendiumNotAdded'));
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that compendium:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.compendiumAddFailed'));
        }
        await this.render(false);
    }

    /**
     * Add a roll table to an inventory by dropping one on it.
     *
     * Adds rather than replaces: a shop is rarely one table, and dropping a second
     * should extend the inventory's sources rather than silently discard the first.
     *
     * Dragged rather than picked from a list, matching how stock itself gets onto a
     * inventory — and a table in a compendium drags the same as one in the world, which a
     * picker of world tables would have missed.
     */
    async _onDropTable(event, inventoryId) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}');
        } catch (_error) {
            return;
        }
        // **A pack, not a document out of one.** `packIdFromDrop` answers for both, which
        // is what the compendium list wants -- and is exactly wrong here, because a roll
        // table dragged out of a compendium carries a pack id too. Checking the payload
        // type instead is the difference between "you dropped a compendium" and "you
        // dropped a table that happens to live in one".
        //
        // A compendium landing here is a near miss rather than a mistake: say which target
        // it wants, or that the shelf is not set to take one. "That is not a roll table" is
        // true and answers a question nobody asked.
        if (data?.type === 'Compendium') {
            const actor = await this._resolveActor();
            const inventory = actor?.items?.get(inventoryId);
            const custom = MerchantManager.getInventorySources(inventory) !== null;
            notify.info(game.i18n.localize(custom
                ? 'coffee-pub-merchant.notify.dropCompendiumHere'
                : 'coffee-pub-merchant.notify.compendiumNeedsManual'));
            return;
        }
        if (data?.type !== 'RollTable' || !data.uuid) {
            if (data?.type) notify.warn(game.i18n.format('coffee-pub-merchant.notify.notARollTable', { what: String(data.type).toLowerCase() }));
            return;
        }

        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            const added = await MerchantManager.addInventoryTable(actor, inventoryId, data.uuid);
            if (!added) notify.info(game.i18n.localize('coffee-pub-merchant.notify.tableAlreadyOn'));
            else MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that table:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.tableAddFailed'));
        }
        await this.render(false);
    }

    /**
     * Whether the party's standing here moves this shop's prices.
     *
     * Opt-in per shop rather than world-wide: a table using reputation for NPC
     * attitude has not thereby asked for it to reprice every merchant they meet.
     */
    async _setReputation(enabled) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            const config = MerchantManager.getConfig(actor) ?? {};
            await MerchantManager.setConfig(actor, {
                pricing: { ...(config.pricing ?? {}), reputation: Boolean(enabled) }
            });
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set the reputation modifier:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.changeFailed'));
        }
        await this.render(false);
    }

    /**
     * Browse for an image, and do something with the one that comes back.
     *
     * Three callers now — an inventory's icon, the shopkeeper's portrait, the shop's
     * illustration — so the picker itself is here once and each caller says only what to
     * do with the answer.
     */
    async _pickImage({ current, onPick }) {
        // v13 namespaced it; the bare global is deprecated.
        const Picker = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
        if (!Picker) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.filePickerUnavailable'));
            return;
        }
        try {
            await new Picker({
                type: 'image',
                current: current || '',
                callback: async (path) => {
                    if (!path || path === current) return;
                    await onPick(path);
                }
            }).browse();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not open the file picker:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.filePickerFailed'));
        }
    }

    /**
     * Choose different artwork for an inventory.
     *
     * The container's own `img`, so it changes everywhere at once — this window, the
     * inventory header in the shop, and dnd5e's own sheet. Foundry's picker already
     * knows about the user's permissions and the world's directories, so there is
     * nothing here but opening it at the current file.
     */
    async _pickInventoryImage(inventoryId) {
        const actor = await this._resolveActor();
        const item = actor?.items?.get(inventoryId);
        if (!item) return;
        await this._pickImage({
            current: item.img,
            onPick: async (path) => {
                await item.update({ img: path });
                MerchantManager.broadcastActorRefresh(actor);
                this.flashSaved();
                await this.render(false);
            }
        });
    }

    /**
     * Change who is behind the counter.
     *
     * **The prototype token follows the portrait.** A shopkeeper whose sheet and whose
     * token disagree is two characters as far as anybody at the table is concerned, and
     * the token is the one players actually see. Placed tokens are left alone: they are
     * already on a map, and changing art under a player mid-scene is a different act
     * from setting up a merchant.
     */
    async _pickPortrait() {
        const actor = await this._resolveActor();
        if (!actor) return;
        await this._pickImage({
            current: actor.img,
            onPick: async (path) => {
                await actor.update({ img: path, 'prototypeToken.texture.src': path });
                MerchantManager.broadcastActorRefresh(actor);
                this.flashSaved();
                await this.render(false);
            }
        });
    }

    /** The picture of the shop itself. Stored on the merchant flag, like its description. */
    async _pickIllustration() {
        const actor = await this._resolveActor();
        if (!actor) return;
        await this._pickImage({
            current: MerchantManager.getConfig(actor)?.illustration ?? '',
            onPick: async (path) => this._setField({ illustration: path })
        });
    }

    /**
     * Rename an inventory.
     *
     * Writes the container's own name, because that *is* the inventory's name — there
     * is no copy in the flag to keep in step. Blank falls back to the type's name
     * rather than leaving a container called nothing.
     */
    async _setInventoryName(inventoryId, value) {
        const actor = await this._resolveActor();
        const item = actor?.items?.get(inventoryId);
        if (!item) return;

        const config = MerchantManager.getInventoryConfig(item);
        const name = String(value ?? '').trim() || inventoryType(config?.type).name;
        if (name === item.name) return;

        try {
            await item.update({ name });
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not rename that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.renameFailed'));
        }
        await this.render(false);
    }

    async _setMarkup(value) {
        const actor = await this._resolveActor();
        if (!actor) return;
        const markup = Number(value);
        if (!Number.isFinite(markup) || markup < 0) {
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.markupNotANumber'));
            return this.render(false);
        }
        try {
            const config = MerchantManager.getConfig(actor) ?? {};
            await MerchantManager.setConfig(actor, { pricing: { ...(config.pricing ?? {}), markup } });
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set markup:`, error);
        }
        await this.render(false);
    }

    /**
     * Every rate slider, wherever it is.
     *
     * One loop, because the shop's Global Markup and an inventory's own rates are the
     * same control about different things — they render through one partial and they
     * should be bound by one piece of code, or they will drift.
     *
     * The readout repaints on `input`, so it keeps up with the drag; the document is
     * written on `change`, so a drag across the track is one update rather than forty.
     * Which attribute the input carries is what decides where the number goes.
     */
    _bindRateSliders() {
        for (const input of this.element?.querySelectorAll('[data-rate-row] input[type="range"]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';

            const row = input.closest('[data-rate-row]');
            const readout = row?.querySelector('[data-rate-readout]');
            const warning = row?.querySelector('[data-rate-warning]');
            // Read off the row rather than recomputed: the safe line depends on the Sell
            // markup in the row below, and a drag has no business resolving an Actor.
            const safe = Number(row?.getAttribute('data-rate-safe'));
            const worstCase = Number(row?.getAttribute('data-rate-worst'));
            const limits = Number.isFinite(safe) && safe > 0 ? { safe, worstCase } : null;

            const paint = () => {
                const value = Number(input.value);
                if (readout) {
                    readout.textContent = rateReadout(input.getAttribute('data-rate-kind'), input.value, limits);
                }
                // Toggled live, so the sentence explaining the cap arrives while the
                // handle is still under the cursor rather than after it is let go.
                if (warning) warning.hidden = !limits || !(value > limits.safe);
            };

            input.addEventListener('input', paint);
            input.addEventListener('change', () => {
                const value = Number(input.value);
                if (!Number.isFinite(value) || value <= 0) return void this.render(false);

                const inventoryMarkup = input.getAttribute('data-inventory-markup');
                const inventoryBuyRate = input.getAttribute('data-inventory-buy-rate');
                if (inventoryMarkup) void this._commitInventoryStock(inventoryMarkup, { markup: value });
                else if (inventoryBuyRate) void this._commitInventoryStock(inventoryBuyRate, { buyRate: value });
                else void this._setMarkup(value);
            });
            paint();
        }
    }

    /**
     * Two range inputs behaving as one two-ended control.
     *
     * Dragging updates the labels and the filled band live; the write happens on
     * release, so a drag across twelve hours is one document update rather than
     * twelve.
     */
    _bindHoursSlider() {
        const root = this.element?.querySelector('[data-hours-slider]');
        if (!root || root.dataset.merchantBound === 'true') return;
        root.dataset.merchantBound = 'true';

        const openInput = root.querySelector('[data-hours-open]');
        const closeInput = root.querySelector('[data-hours-close]');
        const fill = root.querySelector('[data-hours-fill]');
        if (!openInput || !closeInput) return;

        const paint = () => {
            const max = Number(openInput.max) || 23;
            const open = Number(openInput.value);
            const close = Number(closeInput.value);
            this.element.querySelector('[data-hours-open-label]')?.replaceChildren(formatHour(open));
            this.element.querySelector('[data-hours-close-label]')?.replaceChildren(formatHour(close));
            if (!fill) return;

            // The band marks the hours the shop is *open*, so an overnight schedule
            // has to draw two segments rather than one. Drawing a single band between
            // the handles would shade 04:00-20:00 for a shop open 20:00-04:00 —
            // exactly backwards. A gradient with hard stops covers both cases without
            // a second element.
            const span = max + 1;
            const openPct = (open / span) * 100;
            const closePct = (close / span) * 100;
            const bar = 'var(--merchant-open-bar)';

            // Handles together is a window with no hours in it: nothing to shade.
            if (open === close) fill.style.background = 'transparent';
            else if (open < close) {
                fill.style.background = `linear-gradient(90deg, transparent 0 ${openPct}%, ${bar} ${openPct}% ${closePct}%, transparent ${closePct}% 100%)`;
            } else {
                fill.style.background = `linear-gradient(90deg, ${bar} 0 ${closePct}%, transparent ${closePct}% ${openPct}%, ${bar} ${openPct}% 100%)`;
            }

            // The two ends of the same gesture: band drawn across the whole day, or
            // band shut to nothing. Said here rather than only on release, so the
            // label and the handles never disagree while the drag is in progress.
            const badge = this.element.querySelector('[data-hours-badge]');
            if (badge) {
                const shut = open === close;
                const always = open === 0 && close === span;
                badge.textContent = shut ? game.i18n.localize('coffee-pub-merchant.hours.alwaysClosed') : (always ? game.i18n.localize('coffee-pub-merchant.hours.alwaysOpen') : '');
                badge.classList.toggle('is-closed', shut);
                badge.hidden = !shut && !always;
            }
        };

        for (const input of [openInput, closeInput]) {
            input.addEventListener('input', paint);
            input.addEventListener('change', () => void this._commitHours(Number(openInput.value), Number(closeInput.value)));
        }
        paint();
    }

    async _commitHours(open, close) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setHours(actor, { open, close });
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set trading hours:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.hoursFailed'));
        }
        await this.render(false);
    }

    async _setEnabled(enabled) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setEnabled(actor, enabled);
            // The sheet header button appears or disappears with this, so redraw it.
            actor.sheet?.render(false);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not update merchant state:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.merchantFailed'));
        }
        await this.render(false);
    }

    /**
     * Which kind of inventory, asked on click.
     *
     * A menu rather than the row of five buttons this replaced: adding an inventory happens
     * roughly once per shop, and a permanent row of presets was paying for that in
     * window height every time the window was open for anything else.
     */
    openInventoryMenu(event, target) {
        const blacksmith = _blacksmith();
        const presets = Object.values(INVENTORY_TYPES);

        const items = presets.map((preset) => ({
            name: preset.name,
            description: inventoryTypeHint(preset.key),
            // Raw HTML is an injection path, so it is only ever safe for strings we
            // own. These are module constants; nothing here comes from a document.
            icon: `<img src="${preset.img}" alt="">`,
            callback: () => this.addInventory(preset.key)
        }));

        if (typeof blacksmith?.uiContextMenu?.show !== 'function') {
            // No menu API: fall back to the picker rather than losing the ability to
            // add an inventory at all.
            void this._pickInventoryType(presets);
            return;
        }

        const rect = target?.getBoundingClientRect();
        blacksmith.uiContextMenu.show({
            id: `merchant-add-inventory-${this.actorUuid}`,
            // Anchored under the button rather than at the pointer, so a keyboard
            // activation with no coordinates still lands somewhere sensible.
            x: rect ? rect.left : (event?.clientX ?? 0),
            y: rect ? rect.bottom + 4 : (event?.clientY ?? 0),
            root: this.element ?? document.body,
            className: 'merchant-inventory-menu',
            zones: items
        });
    }

    async _pickInventoryType(presets) {
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.choose !== 'function') return;
        const picked = await blacksmith.dialog.choose({
            title: game.i18n.localize('coffee-pub-merchant.config.addInventory'),
            classes: ['merchant-dialog'],
            content: '<p>What kind of inventory?</p>',
            choices: presets.map((preset) => ({ id: preset.key, label: preset.name }))
        });
        if (picked?.action === 'submit' && picked.value) await this.addInventory(picked.value);
    }

    async addInventory(presetKey) {
        const actor = await this._resolveActor();
        if (!actor || !presetKey) return;
        try {
            await MerchantManager.addInventory(actor, presetKey);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.inventoryAddFailed'));
        }
        await this.render(false);
    }

    async removeInventory(inventoryId) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            const removed = await MerchantManager.removeInventory(actor, inventoryId);
            if (removed) MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not remove that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.inventoryRemoveFailed'));
        }
        await this.render(false);
    }

    /**
     * Restock every inventory at once.
     *
     * A press, so every table rolls whether or not it is marked to reroll — the same
     * rule the per-inventory button follows. Setting a shop up means filling all of it,
     * and doing that an inventory at a time is the sort of chore a GM does once and then
     * stops using the feature.
     *
     * Reports the total rather than per inventory: five notifications for five inventories is
     * a worse answer than one.
     *
     * **Confirmed, unlike the per-inventory button.** This one touches the whole shop at
     * once, rolls every table on it, and cannot be undone by dragging one thing back
     * — the scale is what makes it worth a question.
     */
    async restockAll() {
        const actor = await this._resolveActor();
        if (!actor) return;

        // `catalogue: null` — both kinds. A GM configuring a shop is looking at all of its
        // shelves at once; the split into counter and warehouse is a fact about the two
        // *views*, not about the shop.
        const inventories = MerchantManager.getInventories(actor, { includeHidden: true, catalogue: null });
        if (!inventories.length) return;

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const confirmed = await blacksmith.dialog.confirm({
                title: 'Restock Everything',
                classes: ['merchant-dialog'],
                content: `<p>Bring all ${inventories.length} inventory${inventories.length === 1 ? '' : 'ves'} on `
                    + `<strong>${actor.name}</strong> back to their quantities, and roll every table on them.</p>`
                    + '<p>Rolled stock is added, not replaced.</p>',
                confirmLabel: 'Restock Everything',
                confirmIcon: 'fa-solid fa-arrows-rotate'
            });
            if (!confirmed) return;
        }

        // Sized before anything starts, from the same arithmetic the work itself
        // spends, so the bar ends where the work does. Restocking a shop is dozens of
        // table rolls and a compendium lookup for each result -- seconds of apparently
        // nothing, which reads as nothing having happened, which is how a GM comes to
        // press the button twice.
        const total = inventories.reduce(
            (sum, { item }) => sum + MerchantManager.restockWorkUnits(actor, item.id, { force: true }),
            0
        );
        const bar = startProgress(total, game.i18n.format('coffee-pub-merchant.progress.restockingShop', { shop: actor.name }));

        let stocked = 0;
        try {
            for (const { item } of inventories) {
                try {
                    stocked += await MerchantManager.restockInventory(actor, item.id, {
                        force: true,
                        onStep: (message) => bar.step(message)
                    });
                } catch (error) {
                    console.error(`${MODULE.TITLE} | Could not restock ${item.name}:`, error);
                }
            }
        } finally {
            if (stocked) playFeedback(SOUND.RESTOCK);
            bar.finish(stocked
                ? `Restocked ${stocked} item${stocked === 1 ? '' : 's'} across ${inventories.length} inventory${inventories.length === 1 ? '' : 'ves'}.`
                : game.i18n.localize('coffee-pub-merchant.notify.everythingFull'));
        }
        await this.render(false);
    }

    /**
     * Refill an inventory to its par levels now.
     *
     * Offered on finite inventories as well as restocking ones — "the party cleared me
     * out last night" is an ordinary thing to say about either, and a finite inventory
     * still knows what it holds.
     */
    async restockInventory(inventoryId) {
        const actor = await this._resolveActor();
        if (!actor) return;

        const inventoryName = actor.items.get(inventoryId)?.name ?? 'the inventory';
        const bar = startProgress(
            MerchantManager.restockWorkUnits(actor, inventoryId, { force: true }),
            `Restocking ${inventoryName}`
        );
        try {
            const filled = await MerchantManager.restockInventory(actor, inventoryId, {
                force: true,
                onStep: (message) => bar.step(message)
            });
            if (filled) playFeedback(SOUND.RESTOCK);
            bar.finish(filled
                ? `Restocked ${filled} item${filled === 1 ? '' : 's'} on ${inventoryName}.`
                : `${inventoryName} was already full.`);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not restock that inventory:`, error);
            bar.finish(game.i18n.localize('coffee-pub-merchant.notify.restockFailed'));
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.restockFailed'));
        }
        await this.render(false);
    }

    /** Take everything off an inventory, leaving the inventory. Confirmed -- see the shop window. */
    async clearInventory(inventoryId) {
        const actor = await this._resolveActor();
        const inventory = actor?.items?.get(inventoryId);
        if (!inventory) return;

        const count = MerchantManager.getInventoryContents(actor, inventory).length;
        if (!count) {
            notify.info(`${inventory.name} is already empty.`);
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const confirmed = await blacksmith.dialog.confirm({
                title: 'Clear Inventory',
                classes: ['merchant-dialog'],
                content: `<p>Take all ${count} item${count === 1 ? '' : 's'} off `
                    + `<strong>${inventory.name}</strong>.</p>`
                    + '<p>The inventory itself stays, with everything it is set to. This cannot be undone.</p>',
                confirmLabel: 'Clear Inventory',
                confirmIcon: 'fa-solid fa-broom'
            });
            if (!confirmed) return;
        }

        try {
            const cleared = await MerchantManager.clearInventory(actor, inventoryId);
            notify.info(`Cleared ${cleared} item${cleared === 1 ? '' : 's'} off ${inventory.name}.`);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not clear that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.clearFailed'));
        }
        await this.render(false);
    }

    /** A table's name for display, or null if it no longer resolves. */
    _tableName(uuid) {
        if (!uuid) return null;
        try {
            return fromUuidSync(uuid)?.name ?? null;
        } catch (_error) {
            return null;
        }
    }

    /**
     * Switch a table on or off without removing it.
     *
     * A table a shop uses in autumn and not in spring should not have to be deleted
     * and dragged back, losing its roll count on the way.
     */
    async _setTableEnabled(inventoryId, uuid, enabled) {
        const actor = await this._resolveActor();
        if (!actor || !uuid) return;
        try {
            await MerchantManager.setInventoryTableEnabled(actor, inventoryId, uuid, enabled);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not switch that table:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.tableSwitchFailed'));
        }
        await this.render(false);
    }

    async _setTableRolls(inventoryId, uuid, value) {
        const actor = await this._resolveActor();
        if (!actor || !uuid) return;
        try {
            await MerchantManager.setInventoryTableRolls(actor, inventoryId, uuid, value);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set that roll count:`, error);
        }
        await this.render(false);
    }


    async removeInventoryTable(inventoryId, uuid) {
        const actor = await this._resolveActor();
        if (!actor || !uuid) return;
        try {
            await MerchantManager.removeInventoryTable(actor, inventoryId, uuid);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not remove that table:`, error);
        }
        await this.render(false);
    }

    /**
     * Set what happens when something is bought.
     *
     * One control, two things written: the inventory's policy, and whether its tables
     * draw again on a restock. They were a dropdown and a checkbox-per-table, which
     * let an inventory be set to restock while every table on it declined to — a
     * contradiction with no warning and no way to see it.
     */
    async _setMethod(inventoryId, method) {
        const actor = await this._resolveActor();
        if (!actor) return;

        const { stock, auto } = methodToStorage(method);
        const inventory = actor.items.get(inventoryId);
        const tables = MerchantManager.getInventoryTables(inventory);

        try {
            await MerchantManager.setInventoryConfig(actor, inventoryId, {
                stock,
                // Every table on it, so the setting is true of the inventory rather
                // than of whichever table happened to be edited last.
                tables: tables.map((entry) => ({ ...entry, auto })),
                table: null,
                tableRolls: null
            });
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set the restock method:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.inventoryUpdateFailed'));
        }
        // **Always redraws, and must.** The method decides which *other* controls exist:
        // Frequency belongs to a restocking shelf and Max stack to a counted one, so the
        // card is a different shape after this than before it.
        await this.render(false);
    }

    /** Pending chip writes, keyed by the group they belong to. See the binding. */
    _queryWrites = new Map();

    /**
     * Run any pending chip write now rather than waiting out its timer.
     *
     * Called before the window closes and before it re-renders. **Run, not cancel:** a
     * tick is a decision the GM has already made and can already see on the pill, so
     * dropping it because a timer had not fired would lose an edit that looked saved.
     * Re-rendering matters too — the groups are rebuilt, and a timer holding the old
     * DOM would read checkboxes that are no longer on screen.
     */
    _flushQueryWrites() {
        for (const [group, pending] of this._queryWrites) {
            clearTimeout(pending.timer);
            this._queryWrites.delete(group);
            try {
                pending.run();
            } catch (error) {
                console.error(`${MODULE.TITLE} | Could not save that filter:`, error);
            }
        }
    }

    /**
     * The stored query for one inventory, filled in.
     *
     * Read fresh rather than closed over: a checkbox handler bound at render would
     * otherwise write a query from the state the card had when it was drawn, undoing
     * whatever the *previous* click just committed.
     */
    _queryOf(inventoryId) {
        const actor = fromUuidSync(this.actorUuid);
        const inventory = actor?.items?.get(inventoryId);
        return normalizeQuery(MerchantManager.getInventoryConfig(inventory)?.query);
    }

    async _commitInventoryStock(inventoryId, changes, { redraw = true } = {}) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setInventoryConfig(actor, inventoryId, changes);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not update that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.inventoryUpdateFailed'));
        }
        // **A control that already shows its own new state does not need the window
        // rebuilt underneath it.** A filter pill costs a full redraw of every shelf
        // otherwise, which is what made toggling feel slow — the write is small, the
        // redraw is not. Everything that changes the *shape* of the card still redraws.
        if (redraw) await this.render(false);
    }

    /**
     * Put a shelf away, or bring it out front.
     *
     * **The same one control the shop window carries**, and refusals stay with the
     * manager for the reason the pin button gives: two buttons with two sets of rules is
     * how they come apart. Every client with the shop open gains or loses a whole
     * section, so the broadcast is not optional.
     */
    async toggleInventoryVisible(inventoryId) {
        const actor = await this._resolveActor();
        const config = MerchantManager.getInventoryConfig(actor?.items?.get(inventoryId));
        if (!config) return;
        try {
            await MerchantManager.setInventoryVisible(actor, inventoryId, config.visible === false);
            MerchantManager.broadcastActorRefresh(actor);
            await this.render(false);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not change that inventory:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.notify.inventoryChangeFailed'));
        }
    }

    /** Opening the inventory is how a GM stocks it — dnd5e's own container sheet. */
    async openInventory(inventoryId) {
        const actor = await this._resolveActor();
        const inventory = actor?.items?.get(inventoryId);
        if (!inventory) return;
        inventory.sheet?.render(true);
    }

    async getData() {
        const actor = await this._resolveActor();
        const enabled = MerchantManager.isMerchant(actor);
        const merchantConfig = MerchantManager.getConfig(actor) ?? {};

        // Hidden inventories included: this window is GM-only, and an inventory you cannot see
        // in your own configuration is worse than useless.
        const inventories = enabled
            ? MerchantManager.getInventories(actor, { includeHidden: true, catalogue: null }).map(({ item, config }, index, all) => {
                const count = MerchantManager.getInventoryContents(actor, item).length;
                const policy = MerchantManager.resolveStockPolicy(actor, config);
                const days = Number(config.restockDays);
                const limits = MerchantManager.getInventoryLimits(config);
                const definition = inventoryType(config.type);
                const tables = MerchantManager.getInventoryTables(item);
                return {
                    id: item.id,
                    img: item.img,
                    // The container's name, which is the only name an inventory has.
                    // Editable here as well as on the container's own sheet: several
                    // inventories of one type is ordinary, and they need telling apart.
                    label: item.name,
                    typeKey: definition.key,
                    typeLabel: inventoryTypeName(definition.key),
                    typeHint: inventoryTypeHint(definition.key),
                    hidden: config.visible === false,
                    // Which end of the shop this is, so the move buttons can be disabled
                    // rather than absent -- a control that cannot act keeps its place.
                    isFirst: index === 0,
                    isLast: index === all.length - 1,
                    count,
                    one: count === 1,

                    // Which pricing control this type gets. One flag per shape rather
                    // than a string the template has to compare against, because
                    // Handlebars cannot and should not do that comparison.
                    hasRates: definition.pricing === 'markup' || definition.pricing === 'trade',

                    pricingNone: definition.pricing === 'none',
                    markup: Number.isFinite(Number(config.markup)) ? Number(config.markup) : 1,
                    buyRate: Number.isFinite(Number(config.buyRate)) ? Number(config.buyRate) : DEFAULT_BUY_RATE,
                    // One list, so a type with two rates and a type with one render
                    // through the same partial and cannot drift apart.
                    rates: definition.pricing === 'trade'
                        ? [
                            rateRow({
                                label: 'Purchase',
                                kind: 'buy',
                                field: 'buy-rate',
                                inventoryId: item.id,
                                value: Number.isFinite(Number(config.buyRate)) ? Number(config.buyRate) : DEFAULT_BUY_RATE,
                                hint: game.i18n.localize('coffee-pub-merchant.rate.purchaseHint'),
                                // Where the clamp takes over from the slider, and what
                                // it takes over at. Both depend on the Sell markup in
                                // the row below, which is why this is computed here
                                // rather than being a constant.
                                limits: buybackLimits(
                                    Number.isFinite(Number(config.markup)) ? Number(config.markup) : 1
                                )
                            }),
                            rateRow({
                                label: 'Sell',
                                kind: 'markup',
                                field: 'markup',
                                inventoryId: item.id,
                                value: Number.isFinite(Number(config.markup)) ? Number(config.markup) : 1,
                                hint: game.i18n.localize('coffee-pub-merchant.rate.sellHint')
                            })
                        ]
                        : definition.pricing === 'markup'
                            ? [rateRow({
                                label: 'Markup',
                                kind: 'markup',
                                field: 'markup',
                                inventoryId: item.id,
                                value: Number.isFinite(Number(config.markup)) ? Number(config.markup) : 1,
                                hint: game.i18n.localize('coffee-pub-merchant.rate.markupHint')
                            })]
                            : [],

                    // Rolling stocks an inventory from a table. A purchased one is
                    // stocked by the party selling to it and by nothing else, so it
                    // has no tables, no drop target and no restock.
                    canRoll: definition.restocks,

                    // Where new products come from. One or the other: a shelf drawing
                    // from a table *and* a query would fill twice over from two rules
                    // nobody is holding in their head at once.
                    // Each section shows when its source contributes, so "both" shows
                    // the table list *and* the filter rather than a third arrangement.
                    isQuery: drawsFromQuery(config.source ?? DEFAULT_SOURCE),
                    // Anything that draws at all has filters to state; only manual does not.
                    canDraw: drawsFromQuery(config.source ?? DEFAULT_SOURCE)
                        || drawsFromTables(config.source ?? DEFAULT_SOURCE),
                    isTable: drawsFromTables(config.source ?? DEFAULT_SOURCE),
                    isManual: (config.source ?? DEFAULT_SOURCE) === SOURCE.MANUAL,
                    queryAvailable: hasQuery(),
                    // Listed narrowest first: nothing, one source, the other, then the
                    // two orderings of both. A GM reads down until the sentence is true.
                    sourceOptions: [
                        { value: SOURCE.MANUAL, label: game.i18n.localize('coffee-pub-merchant.source.manual') },
                        { value: SOURCE.QUERY, label: game.i18n.localize('coffee-pub-merchant.source.query') },
                        { value: SOURCE.TABLE, label: game.i18n.localize('coffee-pub-merchant.source.table') },
                        { value: SOURCE.BOTH, label: game.i18n.localize('coffee-pub-merchant.source.both') },
                        { value: SOURCE.BOTH_QUERY, label: game.i18n.localize('coffee-pub-merchant.source.bothQuery') }
                    ].map((option) => ({ ...option, selected: option.value === (config.source ?? DEFAULT_SOURCE) })),
                    // **Curated or custom, never both.** `null` is the curated set --
                    // the Item packs the GM put in Blacksmith's slots, which is the
                    // world's answer to "what content do we use". An array is this
                    // shelf's own list, and an empty one is a list nobody has filled yet.
                    isCustomSources: normalizeQuery(config.query).sources !== null,
                    sourceList: (normalizeQuery(config.query).sources ?? []).map((entry) => {
                        const described = describeSource(entry.id);
                        return {
                            ...described,
                            enabled: entry.enabled
                        };
                    }),
                    curatedCount: curatedSources().length,
                    // Named rather than described. "The compendiums configured in
                    // Blacksmith" is a place to go and look; the list is the answer, and
                    // it is the only way to see from here whether this shelf is drawing
                    // from three packs or from none.
                    curatedHint: curatedSources().length
                        ? game.i18n.format('coffee-pub-merchant.config.curatedHint', {
                            list: curatedSources().map((id) => describeSource(id).label).join(', ')
                        })
                        : game.i18n.localize('coffee-pub-merchant.config.curatedHintNone'),
                    hasPacks: allItemPacks().length > 0,
                    priceMinIndex: priceStopIndex(normalizeQuery(config.query).priceGp.min),
                    // A null ceiling is "no ceiling" and sits on the last stop, which
                    // reads as Any. `priceStopIndex` answers that for a non-finite value,
                    // so null and Infinity land in the same place by construction.
                    priceTopIndex: priceStopIndex(normalizeQuery(config.query).priceGp.max ?? Infinity),
                    priceMaxIndex: PRICE_STOPS.length - 1,
                    priceFloorLabel: priceStopLabel(0),
                    priceCeilingLabel: priceStopLabel(PRICE_STOPS.length - 1),
                    priceLabel: describeQuery(config.query),
                    // An empty stored list means "every physical kind", so every chip
                    // reads as on rather than the shelf looking like it carries nothing.
                    queryKinds: physicalTypes().map((type) => ({
                        value: type,
                        label: `${type.charAt(0).toUpperCase()}${type.slice(1)}`,
                        on: !normalizeQuery(config.query).subtypes
                            || normalizeQuery(config.query).subtypes.includes(type)
                    })),
                    queryRarities: RARITIES.map((token) => ({
                        value: token,
                        label: rarityLabel(token),
                        on: normalizeQuery(config.query).rarity.includes(token)
                    })),

                    // Restock is stated per inventory now, never inherited, and every
                    // type has it except the one that cannot mean it.
                    restocks: definition.restocks,
                    // "Restocks with new items" only where there is a table to draw
                    // them from — otherwise it is a choice that would behave exactly
                    // like the one above it.
                    stockOptions: [METHOD.INFINITE, METHOD.FINITE, METHOD.SAME, METHOD.NEW]
                        .filter((value) => value !== METHOD.NEW || tables.length > 0)
                        .map((value) => ({
                            value,
                            label: methodLabel(value),
                            selected: value === methodFromStorage(policy, tables)
                        })),
                    stockLabel: methodLabel(methodFromStorage(policy, tables)) ?? policy,
                    restocking: policy === STOCK.RESTOCKING,
                    // Frequency only exists for the one method that has a cadence, so
                    // the two controls cannot contradict each other: a shelf that never
                    // restocks is never asked how often it does.
                    frequencyOptions: FREQUENCY_OPTIONS.map((option) => ({
                        ...option,
                        selected: option.value === (Number.isFinite(days) && days > 0 ? days : DEFAULT_RESTOCK_DAYS)
                    })),

                    // One ceiling on screen, not two. `maxPerItem` earns its place
                    // because it clamps a table roll *and* a quantity a GM types in
                    // the shop window; `maxProducts` only ever trimmed a table roll,
                    // which the roll count already bounds, so it is a constant now.
                    countable: policy !== STOCK.INFINITE,
                    // **Shown wherever it can act, which is not only where stock is
                    // counted.** `maxPerItem` clamps three things: the restock target,
                    // a quantity a GM types in the shop window, and how deep a table
                    // roll stacks a row — and that last one applies whatever the
                    // method, including "never runs out". Keying the control off
                    // `countable` alone hid a limit that was still quietly capping
                    // every roll on an unlimited inventory.
                    // **Stocking answers "how many", Restock answers "when".** They
                    // were one group and read as one decision, which is why the
                    // ceilings kept being mistaken for restock settings.
                    depthOptions: STOCK_DEPTH_OPTIONS.map((option) => ({
                        value: option.value,
                        label: depthLabel(option.value),
                        hint: depthHint(option.value),
                        selected: option.value === (config.depth ?? DEFAULT_STOCK_DEPTH)
                    })),
                    depthHint: STOCK_DEPTH_OPTIONS
                        .find((option) => option.value === (config.depth ?? DEFAULT_STOCK_DEPTH))?.value
                        ? depthHint(config.depth ?? DEFAULT_STOCK_DEPTH) : '',
                    maxProducts: limits.maxProducts,
                    showMaxStack: policy !== STOCK.INFINITE || tables.length > 0,
                    maxStackTooltip: policy === STOCK.INFINITE
                        ? game.i18n.localize('coffee-pub-merchant.config.maxStackTooltipInfinite')
                        : game.i18n.localize('coffee-pub-merchant.config.maxStackTooltipFinite'),
                    maxPerItem: limits.maxPerItem,

                    tables: tables.map((entry) => ({
                        uuid: entry.uuid,
                        // A uuid that no longer resolves is named as missing rather
                        // than left blank, so a GM can see which one to remove.
                        name: this._tableName(entry.uuid) ?? game.i18n.localize('coffee-pub-merchant.config.missingTable'),
                        rolls: entry.rolls,
                        auto: entry.auto,
                        // **This mapping is the whole context the template sees**, so a
                        // field left out of it does not read as absent — it reads as
                        // false. Omitting `enabled` rendered every table unchecked and
                        // struck through however many times you clicked it: the write
                        // landed, the re-render threw the answer away, and the symptom
                        // was a control that appeared dead.
                        enabled: entry.enabled,
                        // On the control rather than under it. Five tables meant five
                        // near-identical sentences filling the card.
                        drawTooltip: game.i18n.format('coffee-pub-merchant.config.drawTooltip', {
                            when: entry.auto
                                ? game.i18n.localize('coffee-pub-merchant.config.tableAuto')
                                : game.i18n.localize('coffee-pub-merchant.config.tableManual')
                        })
                    })),
                    hasTables: tables.length > 0
                };
            })
            : [];

        const hours = enabled ? MerchantManager.getHours(actor) : null;
        const max = hoursPerDay() - 1;
        const dayEnd = hoursPerDay();

        // What the party's standing is doing here, said in words and in a number.
        // Resolved from the scene the GM is looking at: this window is not attached to
        // a token, so there is no better answer, and it is a report rather than the
        // figure anything is charged by.
        const reputationOn = Boolean(MerchantManager.getConfig(actor)?.pricing?.reputation);

        // The two ends of the curve, read from the curve rather than restated, so
        // tuning `REPUTATION_MARKUP` moves what this promises.
        const rates = Object.values(REPUTATION_MARKUP);
        const worst = Math.max(...rates);
        const best = Math.min(...rates);
        const repPenalty = `${Math.round((worst - 1) * 100)}%`;
        const repBenefit = `${Math.round((1 - best) * 100)}%`;

        // The rate partial is shared by the shop's Global Markup and every inventory
        // rate, so it is registered once rather than inlined three times.
        _partialsReady ??= foundry.applications.handlebars.loadTemplates([RATE_PARTIAL]);
        await _partialsReady;

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            actorName: actor?.name ?? 'Unknown',
            portraitImg: actor?.img ?? 'icons/svg/mystery-man.svg',
            illustration: merchantConfig.illustration ?? '',
            tint: normalizeTint(merchantConfig.tint) ?? '',
            // **Blank is "whatever the world says", and it is the first option.** A merchant
            // with no opinion follows the world's door, so changing that setting moves every
            // shop that never spoke up -- which is what makes it a default rather than a
            // copy taken at creation.
            soundOptions: SHOP_SOUND_KEYS.map((entry) => ({
                key: entry.key,
                label: game.i18n.localize(entry.nameKey),
                choices: [
                    { value: '', label: game.i18n.localize('coffee-pub-merchant.config.soundDefault'), selected: !merchantConfig.sounds?.[entry.key] },
                    ...Object.entries(soundLibrary()).map(([value, label]) => ({
                        value, label, selected: merchantConfig.sounds?.[entry.key] === value
                    }))
                ]
            })),
            // `<input type="color">` has no empty state -- it is black or it is a colour
            // -- so an untinted shop opens the picker on the card's own leather rather
            // than on a black nobody chose.
            tintSwatch: normalizeTint(merchantConfig.tint) ?? HOUSE_TINT,
            enabled,
            // A shop that has never had hours set is open all day, which is the same
            // thing the slider says when it covers the whole span — so there is one
            // state on screen rather than a schedule and a not-a-schedule.
            alwaysOpen: isAlwaysOpen(hours),
            alwaysClosed: isAlwaysClosed(hours),
            hoursBadge: isAlwaysOpen(hours) ? game.i18n.localize('coffee-pub-merchant.hours.alwaysOpen') : (isAlwaysClosed(hours) ? game.i18n.localize('coffee-pub-merchant.hours.alwaysClosed') : null),
            globalMarkup: rateRow({
                label: 'Global Markup',
                kind: 'markup',
                value: Number(MerchantManager.getConfig(actor)?.pricing?.markup) || 1
            }),
            // Every denomination the system defines, pre-filled with what the shop
            // actually holds. Read from CONFIG rather than listed here, so a world that
            // adds a coin gets a box for it.
            till: denominations().map((d) => ({
                key: d.key,
                label: d.abbreviation,
                value: Math.trunc(Number(actor?.system?.currency?.[d.key]) || 0)
            })),
            description: MerchantManager.getConfig(actor)?.description ?? '',
            shopName: MerchantManager.getConfig(actor)?.name ?? '',
            tillLabel: enabled ? formatBase(purseValue(actor)) : null,
            tillEmpty: enabled && purseValue(actor) === 0,
            // **Only the list and which one is picked.** What a profile would do is worked
            // out when it is applied, against the shop as it stands then -- computing it
            // here would be a promise made at render time and kept at click time, with a
            // shelf possibly created in between.
            profiles: MerchantManager.profiles().map((profile) => ({
                key: profile.key,
                name: profile.name,
                selected: profile.key === this._profile
            })),
            // **Nothing is chosen for them.** A picker that opens on the first profile reads
            // as a shop that is already that kind, and Apply becomes a button whose effect
            // depends on a choice nobody made.
            profileChosen: Boolean(this._profile),
            // **Shut unless asked for, every time this window opens.** Setting a shop up
            // from a profile is a thing you do once; a section standing open for the rest
            // of that shop's life is a permanent offer to do it again, at the top of the
            // window, above everything a GM actually came here to change.
            profilesOpen: this._profilesOpen === true,
            // **Only a profile this world saved can be deleted.** The shipped one is not
            // ours to remove and a disabled button that never enables is a control that
            // teaches nothing, so the button is simply not there for it.
            profileCustom: MerchantManager.savedProfiles().some((entry) => entry.key === this._profile),
            profileHint: this._profile
                ? (shopProfile(this._profile, MerchantManager.savedProfiles())?.hint ?? '')
                : game.i18n.localize('coffee-pub-merchant.config.profilePick'),
            deliveryPhysical: merchantConfig[DELIVERY_POINT.PHYSICAL] === true,
            deliveryPortal: merchantConfig[DELIVERY_POINT.PORTAL] === true,
            fullscreenDoors: SHOP_DOORS.map((door) => ({
                value: door.key,
                label: game.i18n.localize(door.labelKey),
                on: merchantConfig.fullscreen?.[door.key] === true
            })),
            kindOptions: SHOP_KINDS.map((option) => ({
                value: option.key,
                label: option.label,
                selected: option.key === (MerchantManager.getConfig(actor)?.kind ?? DEFAULT_SHOP_KIND)
            })),
            // Reputation is opt-in per shop, and says what it is currently doing when
            // it is on: "15% dearer" with no reason given reads as a bug, and
            // "Distrusted here" reads as the game working.
            reputationOn: Boolean(MerchantManager.getConfig(actor)?.pricing?.reputation),
            reputationPenalty: repPenalty,
            reputationBenefit: repBenefit,
            // Sensible defaults for a shop that has never had a schedule, so the
            // handles start somewhere a GM would recognise rather than at midnight.
            // No schedule shows as the whole day rather than as an invented 9 to 6:
            // the handles should say what the shop is doing, and it is open.
            openHour: hours?.open ?? 0,
            closeHour: hours?.close ?? dayEnd,
            openLabel: formatHour(hours?.open ?? 0),
            closeLabel: formatHour(hours?.close ?? dayEnd),
            // The opening handle picks an hour; the closing one picks an edge, one
            // past the last hour, so a shop can be open through it.
            maxHour: max,
            dayEnd,
            dayStartLabel: formatHour(0),
            dayEndLabel: formatHour(dayEnd),
            overridden: enabled && MerchantManager.isOverridden(actor),
            inventories,
            inventoryCount: inventories.length,
            // **The world's stocking rules, as a table, once.** These used to render as
            // two prose rows inside the note -- and rendered as nothing at all after that
            // note moved above the shelves, because the values are built per inventory and
            // the note is not inside one. Read-only on purpose: they are world settings,
            // and a copy of the control here would be a second place to set one thing.
            depthTypeRows: Object.entries(typeCaps()).map(([type, cap]) => ({
                label: `${type.charAt(0).toUpperCase()}${type.slice(1)}`,
                cap: cap || game.i18n.localize('coffee-pub-merchant.config.noLimit')
            })),
            depthRarityRows: Object.entries(rarityCaps()).map(([rarity, cap]) => ({
                label: rarityLabel(rarity),
                cap: cap || game.i18n.localize('coffee-pub-merchant.config.noLimit')
            })),
            hasInventories: inventories.length > 0
        });

        const hasInventories = inventories.length > 0;

        return {
            appId: this.id,
            bodyContent,
            showToolFooter: true,
            // **Restock is not the primary action.** It was, by default, because it was
            // the only button on the right — which made the loudest control on a
            // settings window the one that rolls dice and changes stock. Setting a shop
            // up and restocking it are different errands.
            toolFooterLeft: hasInventories
                ? `
                <button type="button" class="blacksmith-window-btn-secondary merchant-config-restock-all"
                        data-action="restockAll"
                        data-tooltip="${game.i18n.localize('coffee-pub-merchant.config.restockEverythingTooltip')}">
                    <i class="fa-solid fa-arrows-rotate"></i> Restock Everything
                </button>`
                : '',
            // Settings save as they are made, so this closes rather than commits. It
            // says so: "I'm Done" claims nothing about writing, where "Save" would
            // imply the window had been holding changes back.
            // **Saving the shop as a profile is a footer action**, not a control in the
            // profiles section. That section is where you *pick* a starting point; saving
            // is something you do to the whole shop once it is finished, which is what the
            // footer is for and what the button beside it does.
            toolFooterRight: `
                <span class="merchant-config-saved" data-saved-pip>
                    <i class="fa-solid fa-check"></i> Saved
                </span>
                ${enabled ? `<button type="button" class="blacksmith-window-btn-secondary" data-action="saveProfile"
                        data-tooltip="${game.i18n.localize('coffee-pub-merchant.config.saveProfileTooltip')}">
                    <i class="fa-solid fa-floppy-disk"></i> ${game.i18n.localize('coffee-pub-merchant.config.saveProfile')}
                </button>` : ''}
                <button type="button" class="blacksmith-window-btn-primary" data-action="close">
                    <i class="fa-solid fa-shop"></i> I'm Done
                </button>`
        };
    }

    /**
     * Titlebar actions.
     *
     * **Refresh**, because this window shows things it does not own — an inventory's item
     * count, a roll table's name — and nothing pushes a change here when a GM edits
     * the Actor sheet beside it.
     *
     * **Open Shop**, because setting a shop up and looking at it are the same sitting.
     * The shop is normally reached by double-clicking a token, which is no use when
     * the token is on another scene or not placed at all.
     */
    getToolHeaderActions() {
        return [
            {
                id: 'merchant-config-refresh',
                icon: 'fa-solid fa-rotate',
                label: 'Refresh',
                onClick: () => void this.render(false)
            },
            ...(this.canBePinned ? [{
                id: 'merchant-config-pin',
                icon: 'fa-solid fa-map-pin',
                label: 'Pin This Merchant',
                onClick: () => void this.pinShop()
            }] : []),
            ...(this.canBePrinted ? [{
                id: 'merchant-config-catalogue',
                icon: 'fa-solid fa-scroll',
                label: 'Print a Catalogue',
                onClick: () => void this.printCatalogue()
            }] : []),
            {
                id: 'merchant-config-shop',
                icon: 'fa-solid fa-shop',
                label: 'Open Merchant',
                onClick: () => void this.openShop()
            }
        ];
    }

    /**
     * Whether a catalogue could be printed of this merchant.
     *
     * The linked test without the pins one: a catalogue is an Item in this world and
     * needs nothing of Blacksmith to exist.
     */
    get canBePrinted() {
        if (!game.user.isGM) return false;
        let actor = null;
        try {
            actor = fromUuidSync(this.actorUuid);
        } catch (_error) {
            return false;
        }
        return MerchantManager.isMerchant(actor) && canPrint(actor);
    }

    /**
     * Whether this merchant could take a pin, answered synchronously.
     *
     * Absent rather than disabled: an unlinked merchant will not become pinnable while the
     * window is open, and a button that can never work is furniture. The manager still
     * refuses -- hiding a control is not a rule.
     */
    get canBePinned() {
        if (!game.user.isGM || !hasPins()) return false;
        let actor = null;
        try {
            actor = fromUuidSync(this.actorUuid);
        } catch (_error) {
            return false;
        }
        return MerchantManager.isMerchant(actor) && canPin(actor);
    }

    /**
     * Dress this shop as a kind of shop.
     *
     * **Confirmed, and the dialog says what happens to what is already there**, because
     * "apply" is a word that sounds like it might replace things. It cannot -- shelves that
     * exist are left alone -- so the honest sentence names the shelves being added and says
     * the rest is untouched.
     *
     * **One button, one effect.** An earlier cut offered "apply and rename" beside "apply",
     * which put two decisions in one press and made the middle button a thing to work out
     * rather than read. A profile never touches the shop's name now; the field for it is
     * eight lines further down this same window.
     */
    async applyProfile() {
        if (!game.user.isGM) return;
        const actor = await this._resolveActor();
        const profile = shopProfile(this._profile, MerchantManager.savedProfiles());
        if (!actor || !profile) return;

        const existing = actor.items
            .filter((item) => MerchantManager.isInventory(item))
            .map((item) => ({ name: item.name, type: MerchantManager.getInventoryConfig(item)?.type }));
        const adding = missingShelves(profile, existing);

        const blacksmith = _blacksmith();

        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const shelves = adding.length
                ? adding.map((shelf) => shelf.name).join(', ')
                : game.i18n.localize('coffee-pub-merchant.config.profileNoShelves');

            const sure = await blacksmith.dialog.confirm({
                title: game.i18n.format('coffee-pub-merchant.config.profileTitle', { profile: profile.name }),
                classes: ['merchant-dialog'],
                content: `<p>${game.i18n.format('coffee-pub-merchant.config.profileAsk', {
                    profile: foundry.utils.escapeHTML(profile.name),
                    actor: foundry.utils.escapeHTML(actor.name)
                })}</p><p>${game.i18n.format('coffee-pub-merchant.config.profileShelves', {
                    shelves: foundry.utils.escapeHTML(shelves)
                })}</p><p>${game.i18n.localize('coffee-pub-merchant.config.profileKeeps')}</p>`,
                confirmLabel: game.i18n.localize('coffee-pub-merchant.config.applyProfile'),
                confirmIcon: 'fa-solid fa-wand-magic-sparkles'
            });
            if (!sure) return;
        }

        try {
            const result = await MerchantManager.applyProfile(actor, profile.key);
            if (!result) return;
            // **Back to "Select a profile".** This is a one-time getting-started gesture
            // rather than a field bound to the shop: leaving the picker on what was just
            // applied reads as a setting in force, and the shop already says what it was set
            // up from a few pixels above.
            this._profile = null;

            // **Say what moved and what did not, in that order.** The second half is the
            // one a GM is most likely to be uneasy about -- a button called Apply on a
            // window of settings sounds like it might have overwritten the lot -- and it
            // costs one clause to answer.
            const said = [
                result.created.length
                    ? game.i18n.format('coffee-pub-merchant.config.profileAddedShelves', {
                        shelves: result.created.join(', ')
                    })
                    : game.i18n.localize('coffee-pub-merchant.config.profileAddedNone'),
                game.i18n.localize('coffee-pub-merchant.config.profileWroteSettings'),
                result.kept
                    ? game.i18n.format('coffee-pub-merchant.config.profileKeptShelves', { kept: result.kept })
                    : '',
                game.i18n.localize('coffee-pub-merchant.config.profileUntouched')
            ].filter(Boolean);

            notify.success(game.i18n.format('coffee-pub-merchant.config.profileApplied', {
                profile: profile.name
            }), {
                subtitle: said.join(' - '),
                // Longer than an ordinary toast and dismissed by a click: this is a summary
                // of a change to a shop, read rather than noticed.
                duration: 14,
                onClick: () => {}
            });
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not apply that profile:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.config.profileFailed'));
        }
        void this.render(false);
    }

    /** Open or shut the profiles section. Per window, and never remembered: see `profilesOpen`. */
    toggleProfiles() {
        this._profilesOpen = !this._profilesOpen;
        void this.render(false);
    }

    /**
     * Forget a profile this world saved.
     *
     * **Only a saved one, and the shipped profile is not offered.** Confirmed, because a
     * profile may have taken a while to tune and nothing else in the world holds a copy --
     * shops set up from it keep their shelves, but the recipe is gone.
     */
    async deleteProfile() {
        if (!game.user.isGM || !this._profile) return;
        const profile = shopProfile(this._profile, MerchantManager.savedProfiles());
        if (!profile) return;

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const sure = await blacksmith.dialog.confirm({
                title: game.i18n.localize('coffee-pub-merchant.config.deleteProfileTitle'),
                classes: ['merchant-dialog'],
                content: `<p>${game.i18n.format('coffee-pub-merchant.config.deleteProfileAsk', {
                    profile: foundry.utils.escapeHTML(profile.name)
                })}</p><p>${game.i18n.localize('coffee-pub-merchant.config.deleteProfileNote')}</p>`,
                confirmLabel: game.i18n.localize('coffee-pub-merchant.config.deleteProfile'),
                confirmIcon: 'fa-solid fa-trash'
            });
            if (!sure) return;
        }

        try {
            await MerchantManager.deleteProfile(profile.key);
            this._profile = null;
            notify.info(game.i18n.format('coffee-pub-merchant.config.profileDeleted', { profile: profile.name }));
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not delete that profile:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.config.deleteProfileFailed'));
        }
        void this.render(false);
    }

    /**
     * Save this shop as a profile.
     *
     * **Read from the shop as it stands**, not from whatever profile built it: a shop that
     * started from a profile and was then tuned by hand is precisely the one worth saving,
     * and reading its origin would save the version before the tuning.
     *
     * The name is asked for because a profile needs one of its own -- it is a *kind* of
     * shop rather than this shop, and "Phil's Shop-O-Stuff" in a picker of shop kinds tells
     * the next reader nothing.
     */
    async saveProfile() {
        if (!game.user.isGM) return;
        const actor = await this._resolveActor();
        if (!actor) return;

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.prompt !== 'function') {
            notify.warn(game.i18n.localize('coffee-pub-merchant.notify.dialogUnavailable'));
            return;
        }

        const suggestion = MerchantManager.getConfig(actor)?.name || actor.name;

        // `content` as a function so a rejected name comes back with what was typed still in
        // the box: the helper reopens the dialog rather than showing an error in place, and
        // an empty field on the second attempt reads as the dialog having thrown the name
        // away. See `api-dialog.md`.
        const outcome = await blacksmith.dialog.prompt({
            title: game.i18n.localize('coffee-pub-merchant.config.saveProfileTitle'),
            classes: ['merchant-dialog'],
            content: ({ value }) => `
                <p>${game.i18n.localize('coffee-pub-merchant.config.saveProfileAsk')}</p>
                <div class="blacksmith-field">
                    <span class="blacksmith-field-label">${
                        game.i18n.localize('coffee-pub-merchant.config.saveProfileLabel')}</span>
                    <input type="text" name="profile" class="blacksmith-input"
                           value="${foundry.utils.escapeHTML(value ?? suggestion)}">
                </div>`,
            submitLabel: game.i18n.localize('coffee-pub-merchant.config.saveProfile'),
            submitIcon: 'fa-solid fa-floppy-disk',
            focusSelector: '[name="profile"]',
            getValue: (root) => root.elements.profile.value.trim(),
            validate: (value) => (value ? null : game.i18n.localize('coffee-pub-merchant.config.saveProfileNeedsName')),
            cancelValue: '',
            closeValue: ''
        });

        const name = outcome?.value;
        if (!name) return;

        try {
            const saved = await MerchantManager.saveProfile(actor, name);
            if (!saved) return;
            notify.success(game.i18n.format('coffee-pub-merchant.config.profileSaved', {
                profile: saved.name
            }), { subtitle: saved.shelves.map((shelf) => shelf.name).join(', ') });
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not save that profile:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.config.saveProfileFailed'));
        }
        void this.render(false);
    }

    /**
     * Pin this shop to the scene being looked at.
     *
     * The manager owns every refusal -- unlinked, no scene, already pinned, no pins API --
     * because the shop window's copy of this button has to give the same answers, and two
     * buttons with two sets of rules is how they come apart.
     */
    async pinShop() {
        const actor = await this._resolveActor();
        if (actor) await MerchantManager.pinShop(actor);
    }

    /** Print a catalogue of this merchant, refusals and all owned by the manager. */
    async printCatalogue() {
        const actor = await this._resolveActor();
        if (actor) await MerchantManager.printCatalogue(actor);
    }

    /**
     * Open this merchant's shop from its settings.
     *
     * A linked merchant needs no token: it is a shop in its own right, priced against the
     * scene being looked at. An unlinked one is found on the active scene first, since that
     * is where the GM is looking, then anywhere else it stands.
     */
    async openShop() {
        const actor = await this._resolveActor();
        if (!actor) return;

        // A linked merchant opens with no token placed at all -- it is a shop in its own
        // right, and the scene it is priced against is the one being looked at. An
        // unlinked one still needs its token, because there the token *is* the shop.
        if (!MerchantManager.openForActor(actor, { door: 'sheet' })) {
            notify.warn(game.i18n.format('coffee-pub-merchant.notify.noShopToOpen', { name: actor.name }));
        }
    }
}
