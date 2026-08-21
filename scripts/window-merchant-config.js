import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import {
    MODULE, INVENTORY_TYPES, inventoryType, DEFAULT_BUY_RATE, hoursPerDay, formatHour, STOCK,
    DEFAULT_RESTOCK_DAYS, SHOP_KINDS, DEFAULT_SHOP_KIND, isAlwaysOpen, isAlwaysClosed, REPUTATION_MARKUP
} from './const.js';
import { MerchantManager } from './manager-merchant.js';
import { purseValue, formatBase, denominations } from './utility-pricing.js';
import { startProgress } from './utility-progress.js';
import { notify, playFeedback, SOUND } from './utility-feedback.js';


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

const METHOD_LABELS = {
    [METHOD.INFINITE]: 'Never runs out',
    [METHOD.FINITE]: 'Runs out permanently',
    [METHOD.SAME]: 'Restocks the same items',
    [METHOD.NEW]: 'Restocks with new items'
};

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
    if (rate === 1) return 'List price';
    const percent = Math.round(Math.abs(1 - rate) * 100);
    return `${percent}% ${rate > 1 ? 'markup' : 'discount'}`;
}

/** What the shop pays, which is a share of an item's value rather than a markup. */
function buyRateLabel(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return '—';
    return `Pays ${Math.round(rate * 100)}% of value`;
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
    if (percent === 0) return 'list';
    return `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`;
}

function buyRateBound(value) {
    return `${Math.round(Number(value) * 100)}%`;
}

function rateReadout(kind, value) {
    return kind === 'buy' ? buyRateLabel(value) : markupLabel(value);
}

/** The shape `partial-rate.hbs` renders. One builder, so the three rates agree. */
function rateRow({ label, kind, value, inventoryId = null, field = null, hint = null }) {
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
        readout: rateReadout(kind, value),
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
            position: { width: 420, height: 'auto' },
            window: { title: 'Merchant Settings', resizable: true, minimizable: true },
            windowSizeConstraints: { minWidth: 360, minHeight: 260, maxWidth: 720, maxHeight: 'calc(100vh - 80px)' },
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
        openInventory: (_event, target, win) => void win.openInventory(target.dataset.inventoryId),
        removeInventory: (_event, target, win) => void win.removeInventory(target.dataset.inventoryId),
        restockInventory: (_event, target, win) => void win.restockInventory(target.dataset.inventoryId),
        clearInventory: (_event, target, win) => void win.clearInventory(target.dataset.inventoryId),
        restockAll: (_event, _target, win) => void win.restockAll(),
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

    async _resolveActor() {
        return fromUuid(this.actorUuid);
    }

    /**
     * The window base delegates click only, and a checkbox reports its value on
     * change, so the toggle is wired here rather than through ACTION_HANDLERS.
     */
    _onRender(context, options) {
        super._onRender?.(context, options);
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

        const kind = this.element?.querySelector('[data-merchant-kind]');
        if (kind && kind.dataset.merchantBound !== 'true') {
            kind.dataset.merchantBound = 'true';
            kind.addEventListener('change', (event) => void this._setField({ kind: event.target.value }));
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
            input.addEventListener('change', (event) => {
                void this._setTableRolls(
                    input.getAttribute('data-inventory-table-rolls'),
                    input.getAttribute('data-table-uuid'),
                    event.target.value
                );
            });
        }

        // Only one ceiling is on screen now. `maxProducts` is still enforced when a
        // table rolls, as a backstop against an unattended reroll filling a shop, but
        // it is a constant rather than a control — the roll count is what a GM uses to
        // say how much arrives, and two numbers for one idea was the confusion.
        for (const [attribute, field, ceiling] of [
            ['data-inventory-max-per-item', 'maxPerItem', 999]
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

        for (const input of this.element?.querySelectorAll('[data-inventory-restock-days]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';
            input.addEventListener('change', (event) => {
                const days = Math.max(1, Math.trunc(Number(event.target.value) || DEFAULT_RESTOCK_DAYS));
                void this._commitInventoryStock(input.getAttribute('data-inventory-restock-days'), {
                    restockDays: days
                });
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
            notify.error('Could not update this merchant.');
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
            notify.error('Could not set the till.');
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
        if (data?.type !== 'RollTable' || !data.uuid) {
            if (data?.type) notify.warn('Drop a roll table here, not a ' + String(data.type).toLowerCase() + '.');
            return;
        }

        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            const added = await MerchantManager.addInventoryTable(actor, inventoryId, data.uuid);
            if (!added) notify.info('That table is already on this inventory.');
            else MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that table:`, error);
            notify.error('Could not add that table.');
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
            notify.error('Could not change that.');
        }
        await this.render(false);
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

        // v13 namespaced it; the bare global is deprecated.
        const Picker = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
        if (!Picker) {
            notify.warn('The file picker is unavailable.');
            return;
        }

        try {
            await new Picker({
                type: 'image',
                current: item.img,
                callback: async (path) => {
                    if (!path || path === item.img) return;
                    await item.update({ img: path });
                    MerchantManager.broadcastActorRefresh(actor);
                    this.flashSaved();
                    await this.render(false);
                }
            }).browse();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not open the file picker:`, error);
            notify.error('Could not open the file picker.');
        }
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
            notify.error('Could not rename that inventory.');
        }
        await this.render(false);
    }

    async _setMarkup(value) {
        const actor = await this._resolveActor();
        if (!actor) return;
        const markup = Number(value);
        if (!Number.isFinite(markup) || markup < 0) {
            notify.warn('Markup must be a number.');
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

            const readout = input.closest('[data-rate-row]')?.querySelector('[data-rate-readout]');
            const paint = () => {
                if (readout) readout.textContent = rateReadout(input.getAttribute('data-rate-kind'), input.value);
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
                badge.textContent = shut ? 'Always closed' : (always ? 'Always open' : '');
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
            notify.error('Could not set trading hours.');
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
            notify.error('Could not update this merchant.');
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
            description: preset.hint,
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
            title: 'Add an inventory',
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
            notify.error('Could not add that inventory.');
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
            notify.error('Could not remove that inventory.');
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

        const inventories = MerchantManager.getInventories(actor, { includeHidden: true });
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
        const bar = startProgress(total, `Restocking ${actor.name}`);

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
                : 'Every inventory was already full.');
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
            bar.finish('Could not restock that inventory.');
            notify.error('Could not restock that inventory.');
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
            notify.error('Could not clear that inventory.');
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
            notify.error('Could not update that inventory.');
        }
        await this.render(false);
    }

    /** Stock policy and restock cadence, both per inventory. */
    async _commitInventoryStock(inventoryId, changes) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setInventoryConfig(actor, inventoryId, changes);
            MerchantManager.broadcastActorRefresh(actor);
            this.flashSaved();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not update that inventory:`, error);
            notify.error('Could not update that inventory.');
        }
        await this.render(false);
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

        // Hidden inventories included: this window is GM-only, and an inventory you cannot see
        // in your own configuration is worse than useless.
        const inventories = enabled
            ? MerchantManager.getInventories(actor, { includeHidden: true }).map(({ item, config }) => {
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
                    typeLabel: definition.name,
                    typeHint: definition.hint,
                    hidden: config.visible === false,
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
                                hint: 'What the shop pays the party for their goods.'
                            }),
                            rateRow({
                                label: 'Sell',
                                kind: 'markup',
                                field: 'markup',
                                inventoryId: item.id,
                                value: Number.isFinite(Number(config.markup)) ? Number(config.markup) : 1,
                                hint: 'What it then charges for them, on top of the Global Markup.'
                            })
                        ]
                        : definition.pricing === 'markup'
                            ? [rateRow({
                                label: 'Markup',
                                kind: 'markup',
                                field: 'markup',
                                inventoryId: item.id,
                                value: Number.isFinite(Number(config.markup)) ? Number(config.markup) : 1,
                                hint: 'Multiplied against the shop\'s Global Markup.'
                            })]
                            : [],

                    // Rolling stocks an inventory from a table. A purchased one is
                    // stocked by the party selling to it and by nothing else, so it
                    // has no tables, no drop target and no restock.
                    canRoll: definition.restocks,

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
                            label: METHOD_LABELS[value],
                            selected: value === methodFromStorage(policy, tables)
                        })),
                    stockLabel: METHOD_LABELS[methodFromStorage(policy, tables)] ?? policy,
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
                    maxPerItem: limits.maxPerItem,

                    tables: tables.map((entry) => ({
                        uuid: entry.uuid,
                        // A uuid that no longer resolves is named as missing rather
                        // than left blank, so a GM can see which one to remove.
                        name: this._tableName(entry.uuid) ?? 'Missing table',
                        rolls: entry.rolls,
                        auto: entry.auto,
                        // On the control rather than under it. Five tables meant five
                        // near-identical sentences filling the card.
                        drawTooltip: `How many items to take from this table. `
                            + (entry.auto
                                ? 'Drawn again every time this inventory restocks.'
                                : 'Drawn only when you press Restock.')
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
            enabled,
            // A shop that has never had hours set is open all day, which is the same
            // thing the slider says when it covers the whole span — so there is one
            // state on screen rather than a schedule and a not-a-schedule.
            alwaysOpen: isAlwaysOpen(hours),
            alwaysClosed: isAlwaysClosed(hours),
            hoursBadge: isAlwaysOpen(hours) ? 'Always open' : (isAlwaysClosed(hours) ? 'Always closed' : null),
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
                        data-tooltip="Bring every inventory back to its quantities and roll all of its tables">
                    <i class="fa-solid fa-arrows-rotate"></i> Restock Everything
                </button>`
                : '',
            // Settings save as they are made, so this closes rather than commits. It
            // says so: "I'm Done" claims nothing about writing, where "Save" would
            // imply the window had been holding changes back.
            toolFooterRight: `
                <span class="merchant-config-saved" data-saved-pip>
                    <i class="fa-solid fa-check"></i> Saved
                </span>
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
            {
                id: 'merchant-config-shop',
                icon: 'fa-solid fa-shop',
                label: 'Open Shop',
                onClick: () => void this.openShop()
            }
        ];
    }

    /**
     * Open this merchant's shop from its settings.
     *
     * A shop belongs to a token, so this needs one: the active scene first, since
     * that is where the GM is looking, then anywhere else the merchant stands.
     */
    async openShop() {
        const actor = await this._resolveActor();
        if (!actor) return;

        const here = canvas?.scene?.tokens?.find((token) => token.actor?.uuid === actor.uuid);
        const anywhere = here ?? game.scenes
            ?.map((scene) => scene.tokens.find((token) => token.actor?.uuid === actor.uuid))
            ?.find(Boolean);

        if (!anywhere) {
            notify.warn(`${actor.name} has no token on any scene, so there is no shop to open.`);
            return;
        }
        MerchantManager.openSafely(anywhere);
    }
}
