import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import {
    MODULE, SHELF_PRESETS, hoursPerDay, formatHour, STOCK, DEFAULT_RESTOCK_DAYS, SHOP_KINDS, DEFAULT_SHOP_KIND, isAlwaysOpen, isAlwaysClosed
} from './const.js';
import { MerchantManager } from './manager-merchant.js';
import { purseValue, formatBase } from './merchant-pricing.js';
import { startProgress } from './merchant-progress.js';

const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-merchant-config.hbs';

function _blacksmith() {
    return game.modules.get('coffee-pub-blacksmith')?.api ?? null;
}

const STOCK_LABELS = {
    [STOCK.INFINITE]: 'Never runs out',
    [STOCK.FINITE]: 'Runs out',
    [STOCK.RESTOCKING]: 'Runs out, refills'
};

/** `''` is "use the merchant's", which is how `markup: null` already behaves. */
const STOCK_OPTIONS = [
    { value: '', label: 'Same as the shop' },
    { value: STOCK.INFINITE, label: STOCK_LABELS[STOCK.INFINITE] },
    { value: STOCK.FINITE, label: STOCK_LABELS[STOCK.FINITE] },
    { value: STOCK.RESTOCKING, label: STOCK_LABELS[STOCK.RESTOCKING] }
];

/**
 * Marking and configuring a merchant.
 *
 * A window rather than a confirmation dialog on purpose: stock policy, markup,
 * trading hours and per-shelf settings all land here, and they need somewhere to go
 * that is not a growing pile of prompts.
 */
export class MerchantConfigWindow extends BlacksmithToolWindowBaseV2 {
    static _windows = new Map();

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
        addShelf: (event, target, win) => void win.openShelfMenu(event, target),
        openShelf: (_event, target, win) => void win.openShelf(target.dataset.shelfId),
        removeShelf: (_event, target, win) => void win.removeShelf(target.dataset.shelfId),
        restockShelf: (_event, target, win) => void win.restockShelf(target.dataset.shelfId),
        clearShelf: (_event, target, win) => void win.clearShelf(target.dataset.shelfId),
        restockAll: (_event, _target, win) => void win.restockAll(),
        removeShelfTable: (_event, target, win) =>
            void win.removeShelfTable(target.dataset.shelfId, target.dataset.tableUuid),
        removeShelf: (_event, target, win) => void win.removeShelf(target.dataset.shelfId)
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

    static async open(actor) {
        if (!game.user.isGM) return null;
        const existing = this._windows.get(actor.uuid);
        if (existing) return existing.render(true);
        const win = new this(actor);
        this._windows.set(actor.uuid, win);
        await win.render(true);
        return win;
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

        const markup = this.element?.querySelector('[data-merchant-markup]');
        if (markup && markup.dataset.merchantBound !== 'true') {
            markup.dataset.merchantBound = 'true';
            // On change rather than input: typing "1.25" passes through 1, 1.2 and
            // 1.25, and only the last of those is what the GM meant.
            markup.addEventListener('change', (event) => void this._setMarkup(event.target.value));
        }

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

        const till = this.element?.querySelector('[data-merchant-till]');
        if (till && till.dataset.merchantBound !== 'true') {
            till.dataset.merchantBound = 'true';
            till.addEventListener('change', (event) => void this._setTill(event.target.value));
        }

        const stock = this.element?.querySelector('[data-merchant-stock]');
        if (stock && stock.dataset.merchantBound !== 'true') {
            stock.dataset.merchantBound = 'true';
            stock.addEventListener('change', (event) => void this._setStock(event.target.value));
        }

        // Per-shelf policy and cadence. Both write through the same helper, since
        // both are one field of a shelf's configuration.
        for (const select of this.element?.querySelectorAll('[data-shelf-stock]') ?? []) {
            if (select.dataset.merchantBound === 'true') continue;
            select.dataset.merchantBound = 'true';
            select.addEventListener('change', (event) => {
                // Empty means "same as the shop", stored as null so it reads as
                // absent rather than as a policy named "".
                void this._commitShelfStock(select.getAttribute('data-shelf-stock'), {
                    stock: event.target.value || null
                });
            });
        }

        for (const input of this.element?.querySelectorAll('[data-shelf-table-rolls]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';
            input.addEventListener('change', (event) => {
                void this._setTableRolls(
                    input.getAttribute('data-shelf-table-rolls'),
                    input.getAttribute('data-table-uuid'),
                    event.target.value
                );
            });
        }

        for (const [attribute, field, ceiling] of [
            ['data-shelf-max-products', 'maxProducts', 500],
            ['data-shelf-max-per-item', 'maxPerItem', 999]
        ]) {
            for (const input of this.element?.querySelectorAll(`[${attribute}]`) ?? []) {
                if (input.dataset.merchantBound === 'true') continue;
                input.dataset.merchantBound = 'true';
                input.addEventListener('change', (event) => {
                    const value = Math.min(ceiling, Math.max(1, Math.trunc(Number(event.target.value) || 1)));
                    void this._commitShelfStock(input.getAttribute(attribute), { [field]: value });
                });
            }
        }

        for (const box of this.element?.querySelectorAll('[data-shelf-table-auto]') ?? []) {
            if (box.dataset.merchantBound === 'true') continue;
            box.dataset.merchantBound = 'true';
            box.addEventListener('change', (event) => {
                void this._setTableAuto(
                    box.getAttribute('data-shelf-table-auto'),
                    box.getAttribute('data-table-uuid'),
                    event.target.checked
                );
            });
        }

        for (const zone of this.element?.querySelectorAll('[data-drop-table]') ?? []) {
            if (zone.dataset.merchantBoundDrop === 'true') continue;
            zone.dataset.merchantBoundDrop = 'true';
            const shelfId = zone.getAttribute('data-drop-table');

            zone.addEventListener('dragover', (event) => {
                event.preventDefault();
                zone.classList.add('is-dropping');
            });
            zone.addEventListener('dragleave', () => zone.classList.remove('is-dropping'));
            zone.addEventListener('drop', (event) => {
                event.preventDefault();
                zone.classList.remove('is-dropping');
                void this._onDropTable(event, shelfId);
            });
        }

        for (const input of this.element?.querySelectorAll('[data-shelf-restock-days]') ?? []) {
            if (input.dataset.merchantBound === 'true') continue;
            input.dataset.merchantBound = 'true';
            input.addEventListener('change', (event) => {
                const days = Math.max(1, Math.trunc(Number(event.target.value) || DEFAULT_RESTOCK_DAYS));
                void this._commitShelfStock(input.getAttribute('data-shelf-restock-days'), {
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
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not update this merchant:`, error);
            ui.notifications?.error('Could not update this merchant.');
        }
        if (redraw) await this.render(false);
    }

    /** What the shop can pay out. A merchant with an empty till cannot buy anything. */
    async _setTill(value) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setTillGold(actor, value);
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set the till:`, error);
            ui.notifications?.error('Could not set the till.');
        }
        await this.render(false);
    }

    /**
     * Add a roll table to a shelf by dropping one on it.
     *
     * Adds rather than replaces: a shop is rarely one table, and dropping a second
     * should extend the shelf's sources rather than silently discard the first.
     *
     * Dragged rather than picked from a list, matching how stock itself gets onto a
     * shelf — and a table in a compendium drags the same as one in the world, which a
     * picker of world tables would have missed.
     */
    async _onDropTable(event, shelfId) {
        let data = null;
        try {
            data = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}');
        } catch (_error) {
            return;
        }
        if (data?.type !== 'RollTable' || !data.uuid) {
            if (data?.type) ui.notifications?.warn('Drop a roll table here, not a ' + String(data.type).toLowerCase() + '.');
            return;
        }

        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            const added = await MerchantManager.addShelfTable(actor, shelfId, data.uuid);
            if (!added) ui.notifications?.info('That table is already on this shelf.');
            else MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that table:`, error);
            ui.notifications?.error('Could not add that table.');
        }
        await this.render(false);
    }

    /** The shop-wide default. A shelf may still say otherwise. */
    async _setStock(value) {
        const actor = await this._resolveActor();
        if (!actor) return;
        if (!Object.values(STOCK).includes(value)) return this.render(false);
        try {
            await MerchantManager.setConfig(actor, { stock: value });
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set the stock policy:`, error);
            ui.notifications?.error('Could not set the stock policy.');
        }
        await this.render(false);
    }

    async _setMarkup(value) {
        const actor = await this._resolveActor();
        if (!actor) return;
        const markup = Number(value);
        if (!Number.isFinite(markup) || markup < 0) {
            ui.notifications?.warn('Markup must be a number.');
            return this.render(false);
        }
        try {
            const config = MerchantManager.getConfig(actor) ?? {};
            await MerchantManager.setConfig(actor, { pricing: { ...(config.pricing ?? {}), markup } });
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set markup:`, error);
        }
        await this.render(false);
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
            ui.notifications?.error('Could not set trading hours.');
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
            ui.notifications?.error('Could not update this merchant.');
        }
        await this.render(false);
    }

    /**
     * Which kind of shelf, asked on click.
     *
     * A menu rather than the row of five buttons this replaced: adding a shelf happens
     * roughly once per shop, and a permanent row of presets was paying for that in
     * window height every time the window was open for anything else.
     */
    openShelfMenu(event, target) {
        const blacksmith = _blacksmith();
        const presets = Object.values(SHELF_PRESETS);

        const items = presets.map((preset) => ({
            name: preset.name,
            description: preset.hint,
            // Raw HTML is an injection path, so it is only ever safe for strings we
            // own. These are module constants; nothing here comes from a document.
            icon: `<img src="${preset.img}" alt="">`,
            callback: () => this.addShelf(preset.key)
        }));

        if (typeof blacksmith?.uiContextMenu?.show !== 'function') {
            // No menu API: fall back to the picker rather than losing the ability to
            // add a shelf at all.
            void this._pickShelfPreset(presets);
            return;
        }

        const rect = target?.getBoundingClientRect();
        blacksmith.uiContextMenu.show({
            id: `merchant-add-shelf-${this.actorUuid}`,
            // Anchored under the button rather than at the pointer, so a keyboard
            // activation with no coordinates still lands somewhere sensible.
            x: rect ? rect.left : (event?.clientX ?? 0),
            y: rect ? rect.bottom + 4 : (event?.clientY ?? 0),
            root: this.element ?? document.body,
            className: 'merchant-shelf-menu',
            zones: items
        });
    }

    async _pickShelfPreset(presets) {
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.choose !== 'function') return;
        const picked = await blacksmith.dialog.choose({
            title: 'Add a shelf',
            classes: ['merchant-dialog'],
            content: '<p>What kind of shelf?</p>',
            choices: presets.map((preset) => ({ id: preset.key, label: preset.name }))
        });
        if (picked?.action === 'submit' && picked.value) await this.addShelf(picked.value);
    }

    async addShelf(presetKey) {
        const actor = await this._resolveActor();
        if (!actor || !presetKey) return;
        try {
            await MerchantManager.addShelf(actor, presetKey);
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add that shelf:`, error);
            ui.notifications?.error('Could not add that shelf.');
        }
        await this.render(false);
    }

    async removeShelf(shelfId) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            const removed = await MerchantManager.removeShelf(actor, shelfId);
            if (removed) MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not remove that shelf:`, error);
            ui.notifications?.error('Could not remove that shelf.');
        }
        await this.render(false);
    }

    /**
     * Restock every shelf at once.
     *
     * A press, so every table rolls whether or not it is marked to reroll — the same
     * rule the per-shelf button follows. Setting a shop up means filling all of it,
     * and doing that a shelf at a time is the sort of chore a GM does once and then
     * stops using the feature.
     *
     * Reports the total rather than per shelf: five notifications for five shelves is
     * a worse answer than one.
     *
     * **Confirmed, unlike the per-shelf button.** This one touches the whole shop at
     * once, rolls every table on it, and cannot be undone by dragging one thing back
     * — the scale is what makes it worth a question.
     */
    async restockAll() {
        const actor = await this._resolveActor();
        if (!actor) return;

        const shelves = MerchantManager.getShelves(actor, { includeHidden: true });
        if (!shelves.length) return;

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const confirmed = await blacksmith.dialog.confirm({
                title: 'Restock Everything',
                classes: ['merchant-dialog'],
                content: `<p>Bring all ${shelves.length} shelf${shelves.length === 1 ? '' : 'ves'} on `
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
        const total = shelves.reduce(
            (sum, { item }) => sum + MerchantManager.restockWorkUnits(actor, item.id, { force: true }),
            0
        );
        const bar = startProgress(total, `Restocking ${actor.name}`);

        let stocked = 0;
        try {
            for (const { item } of shelves) {
                try {
                    stocked += await MerchantManager.restockShelf(actor, item.id, {
                        force: true,
                        onStep: (message) => bar.step(message)
                    });
                } catch (error) {
                    console.error(`${MODULE.TITLE} | Could not restock ${item.name}:`, error);
                }
            }
        } finally {
            bar.finish(stocked
                ? `Restocked ${stocked} item${stocked === 1 ? '' : 's'} across ${shelves.length} shelf${shelves.length === 1 ? '' : 'ves'}.`
                : 'Every shelf was already full.');
        }
        await this.render(false);
    }

    /**
     * Refill a shelf to its par levels now.
     *
     * Offered on finite shelves as well as restocking ones — "the party cleared me
     * out last night" is an ordinary thing to say about either, and a finite shelf
     * still knows what it holds.
     */
    async restockShelf(shelfId) {
        const actor = await this._resolveActor();
        if (!actor) return;

        const shelfName = actor.items.get(shelfId)?.name ?? 'the shelf';
        const bar = startProgress(
            MerchantManager.restockWorkUnits(actor, shelfId, { force: true }),
            `Restocking ${shelfName}`
        );
        try {
            const filled = await MerchantManager.restockShelf(actor, shelfId, {
                force: true,
                onStep: (message) => bar.step(message)
            });
            bar.finish(filled
                ? `Restocked ${filled} item${filled === 1 ? '' : 's'} on ${shelfName}.`
                : `${shelfName} was already full.`);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not restock that shelf:`, error);
            bar.finish('Could not restock that shelf.');
            ui.notifications?.error('Could not restock that shelf.');
        }
        await this.render(false);
    }

    /** Take everything off a shelf, leaving the shelf. Confirmed -- see the shop window. */
    async clearShelf(shelfId) {
        const actor = await this._resolveActor();
        const shelf = actor?.items?.get(shelfId);
        if (!shelf) return;

        const count = MerchantManager.getShelfContents(actor, shelf).length;
        if (!count) {
            ui.notifications?.info(`${shelf.name} is already empty.`);
            return;
        }

        const blacksmith = _blacksmith();
        if (typeof blacksmith?.dialog?.confirm === 'function') {
            const confirmed = await blacksmith.dialog.confirm({
                title: 'Clear Shelf',
                classes: ['merchant-dialog'],
                content: `<p>Take all ${count} item${count === 1 ? '' : 's'} off `
                    + `<strong>${shelf.name}</strong>.</p>`
                    + '<p>The shelf itself stays, with everything it is set to. This cannot be undone.</p>',
                confirmLabel: 'Clear Shelf',
                confirmIcon: 'fa-solid fa-broom'
            });
            if (!confirmed) return;
        }

        try {
            const cleared = await MerchantManager.clearShelf(actor, shelfId);
            ui.notifications?.info(`Cleared ${cleared} item${cleared === 1 ? '' : 's'} off ${shelf.name}.`);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not clear that shelf:`, error);
            ui.notifications?.error('Could not clear that shelf.');
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

    async _setTableRolls(shelfId, uuid, value) {
        const actor = await this._resolveActor();
        if (!actor || !uuid) return;
        try {
            await MerchantManager.setShelfTableRolls(actor, shelfId, uuid, value);
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set that roll count:`, error);
        }
        await this.render(false);
    }

    async _setTableAuto(shelfId, uuid, auto) {
        const actor = await this._resolveActor();
        if (!actor || !uuid) return;
        try {
            await MerchantManager.setShelfTableAuto(actor, shelfId, uuid, auto);
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not set that table to reroll:`, error);
        }
        await this.render(false);
    }

    async removeShelfTable(shelfId, uuid) {
        const actor = await this._resolveActor();
        if (!actor || !uuid) return;
        try {
            await MerchantManager.removeShelfTable(actor, shelfId, uuid);
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not remove that table:`, error);
        }
        await this.render(false);
    }

    /** Stock policy and restock cadence, both per shelf. */
    async _commitShelfStock(shelfId, changes) {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setShelfConfig(actor, shelfId, changes);
            MerchantManager.broadcastActorRefresh(actor);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not update that shelf:`, error);
            ui.notifications?.error('Could not update that shelf.');
        }
        await this.render(false);
    }

    /** Opening the shelf is how a GM stocks it — dnd5e's own container sheet. */
    async openShelf(shelfId) {
        const actor = await this._resolveActor();
        const shelf = actor?.items?.get(shelfId);
        if (!shelf) return;
        shelf.sheet?.render(true);
    }

    async getData() {
        const actor = await this._resolveActor();
        const enabled = MerchantManager.isMerchant(actor);

        // Hidden shelves included: this window is GM-only, and a shelf you cannot see
        // in your own configuration is worse than useless.
        const shelves = enabled
            ? MerchantManager.getShelves(actor, { includeHidden: true }).map(({ item, config }) => {
                const count = MerchantManager.getShelfContents(actor, item).length;
                const policy = MerchantManager.resolveStockPolicy(actor, config);
                const days = Number(config.restockDays);
                const limits = MerchantManager.getShelfLimits(config);
                return {
                    id: item.id,
                    img: item.img,
                    // The container's name, which is the only name a shelf has.
                    label: item.name,
                    hidden: config.visible === false,
                    count,
                    one: count === 1,
                    // `null` on the shelf means "whatever the merchant says", which is
                    // the same inheritance markup already uses.
                    stockOptions: STOCK_OPTIONS.map((option) => ({
                        ...option,
                        selected: option.value === (config.stock ?? '')
                    })),
                    stockLabel: STOCK_LABELS[policy] ?? policy,
                    inherited: !config.stock,
                    restocking: policy === STOCK.RESTOCKING,
                    // Restocking is the only policy with a cadence, but every shelf
                    // that counts its stock can be refilled by hand.
                    countable: policy !== STOCK.INFINITE,
                    restockDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_RESTOCK_DAYS,
                    maxProducts: limits.maxProducts,
                    maxPerItem: limits.maxPerItem,
                    tables: MerchantManager.getShelfTables(item).map((entry) => ({
                        uuid: entry.uuid,
                        // A uuid that no longer resolves is named as missing rather
                        // than left blank, so a GM can see which one to remove.
                        name: this._tableName(entry.uuid) ?? 'Missing table',
                        rolls: entry.rolls,
                        auto: entry.auto
                    })),
                    hasTables: MerchantManager.getShelfTables(item).length > 0
                };
            })
            : [];

        const hours = enabled ? MerchantManager.getHours(actor) : null;
        const max = hoursPerDay() - 1;
        const dayEnd = hoursPerDay();

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
            markup: MerchantManager.getConfig(actor)?.pricing?.markup ?? 1,
            description: MerchantManager.getConfig(actor)?.description ?? '',
            shopName: MerchantManager.getConfig(actor)?.name ?? '',
            tillGold: Math.trunc(Number(actor?.system?.currency?.gp ?? 0)),
            tillLabel: enabled ? formatBase(purseValue(actor)) : null,
            tillEmpty: enabled && purseValue(actor) === 0,
            kindOptions: SHOP_KINDS.map((option) => ({
                value: option.key,
                label: option.label,
                selected: option.key === (MerchantManager.getConfig(actor)?.kind ?? DEFAULT_SHOP_KIND)
            })),
            // The shop-wide default has no "same as the shop" to inherit from.
            merchantStockOptions: STOCK_OPTIONS.filter((option) => option.value).map((option) => ({
                ...option,
                selected: option.value === (MerchantManager.getConfig(actor)?.stock ?? STOCK.INFINITE)
            })),
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
            shelves,
            shelfCount: shelves.length,
            hasShelves: shelves.length > 0
        });

        const hasShelves = shelves.length > 0;

        return {
            appId: this.id,
            bodyContent,
            showToolFooter: true,
            toolFooterLeft: `
                <button type="button" class="blacksmith-window-btn-secondary" data-action="close">
                    <i class="fa-solid fa-check"></i> Done
                </button>`,
            // The main action, right-justified, and only where there is something to
            // restock: on a shop with no shelves it would be a button that does
            // nothing but say so.
            toolFooterRight: hasShelves
                ? `
                <button type="button" class="blacksmith-window-btn-primary merchant-config-restock-all"
                        data-action="restockAll"
                        data-tooltip="Bring every shelf back to its quantities and roll all of its tables">
                    <i class="fa-solid fa-arrows-rotate"></i> Restock Everything
                </button>`
                : ''
        };
    }

    /**
     * Titlebar actions.
     *
     * **Refresh**, because this window shows things it does not own — a shelf's item
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
            ui.notifications?.warn(`${actor.name} has no token on any scene, so there is no shop to open.`);
            return;
        }
        MerchantManager.openSafely(anywhere);
    }

    _onClose(options) {
        this.constructor._windows.delete(this.actorUuid);
        super._onClose?.(options);
    }
}
