import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import { MODULE, SHELF_PRESETS, hoursPerDay, formatHour } from './const.js';
import { MerchantManager } from './manager-merchant.js';

const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-merchant-config.hbs';

/**
 * Marking and configuring a merchant.
 *
 * A window rather than a confirmation dialog on purpose: stock policy, markup, and
 * per-item price overrides all land here in later phases, and they need somewhere to
 * go that is not a growing pile of prompts.
 */
export class MerchantConfigWindow extends BlacksmithToolWindowBaseV2 {
    static _windows = new Map();

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-config-window'],
            position: { width: 420, height: 'auto' },
            window: { title: 'Merchant Settings', resizable: false, minimizable: true },
            windowSizeConstraints: { minWidth: 360, maxWidth: 560, maxHeight: 'calc(100vh - 80px)' },
            toolTitlebar: 'full',
            rememberPosition: false,
            windowPositionKey: 'merchant-config'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        addShelf: (_event, target, win) => void win.addShelf(target.dataset.preset),
        openShelf: (_event, target, win) => void win.openShelf(target.dataset.shelfId),
        removeShelf: (_event, target, win) => void win.removeShelf(target.dataset.shelfId),
        clearHours: (_event, _target, win) => void win.clearHours()
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
            // An overnight window wraps, so the band is drawn from the lower value
            // and simply reads as the span between the handles.
            const lo = Math.min(open, close) / (max + 1);
            const hi = Math.max(open, close) / (max + 1);
            fill.style.left = `${lo * 100}%`;
            fill.style.width = `${(hi - lo) * 100}%`;
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

    async clearHours() {
        const actor = await this._resolveActor();
        if (!actor) return;
        try {
            await MerchantManager.setHours(actor, null);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not clear trading hours:`, error);
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
                return {
                    id: item.id,
                    img: item.img,
                    label: config.label || item.name,
                    hidden: config.visible === false,
                    count,
                    one: count === 1
                };
            })
            : [];

        const hours = enabled ? MerchantManager.getHours(actor) : null;
        const max = hoursPerDay() - 1;

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            actorName: actor?.name ?? 'Unknown',
            portraitImg: actor?.img ?? 'icons/svg/mystery-man.svg',
            enabled,
            hasHours: Boolean(hours),
            // Sensible defaults for a shop that has never had a schedule, so the
            // handles start somewhere a GM would recognise rather than at midnight.
            openHour: hours?.open ?? Math.min(9, max),
            closeHour: hours?.close ?? Math.min(18, max),
            openLabel: formatHour(hours?.open ?? Math.min(9, max)),
            closeLabel: formatHour(hours?.close ?? Math.min(18, max)),
            maxHour: max,
            overridden: enabled && MerchantManager.isOverridden(actor),
            shelves,
            shelfCount: shelves.length,
            hasShelves: shelves.length > 0,
            presets: Object.values(SHELF_PRESETS)
        });

        return {
            appId: this.id,
            bodyContent,
            showToolFooter: true,
            toolFooterLeft: `
                <button type="button" class="blacksmith-window-btn-secondary" data-action="close">
                    <i class="fa-solid fa-check"></i> Done
                </button>`,
            toolFooterRight: ''
        };
    }

    _onClose(options) {
        this.constructor._windows.delete(this.actorUuid);
        super._onClose?.(options);
    }
}
