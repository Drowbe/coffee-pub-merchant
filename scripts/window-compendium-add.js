import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import { MODULE } from './const.js';
import { MerchantManager } from './manager-merchant.js';
import { physicalTypes } from './merchant-inventory.js';

const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-compendium-add.hbs';

/**
 * Search compendiums and put the result straight on a shelf.
 *
 * This exists because "do you have any special armour?" arrives mid-session, and
 * the alternative is leaving the table to go rummaging. Blacksmith's
 * `compendiums.search()` does the whole search half — text in, candidates out, with
 * a source label per result — so this window is a text box, a list, and a click.
 */
export class CompendiumAddWindow extends BlacksmithToolWindowBaseV2 {
    static _windows = new Map();

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-add-window'],
            position: { width: 480, height: 560 },
            window: { title: 'Add to Shelf', resizable: true, minimizable: true },
            windowSizeConstraints: { minWidth: 380, minHeight: 320, maxWidth: 760, maxHeight: 'calc(100vh - 40px)' },
            toolTitlebar: 'full',
            rememberPosition: false,
            windowPositionKey: 'merchant-add'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        addResult: (_event, target, win) => void win.addResult(target.dataset.uuid, target.dataset.name)
    };

    constructor(actor, shelfId, options = {}) {
        const opts = foundry.utils.mergeObject({}, options);
        opts.id ||= `merchant-add-${actor.id}-${shelfId}`;
        opts.position = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, CompendiumAddWindow.DEFAULT_OPTIONS.position ?? {}),
            opts.position || {}
        );
        opts.window = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, CompendiumAddWindow.DEFAULT_OPTIONS.window ?? {}),
            opts.window || {}
        );
        super(opts);
        this.actorUuid = actor.uuid;
        this.shelfId = shelfId;
        this.query = '';
        this.results = [];
        this.truncated = false;
        this.searching = false;
    }

    static async open(actor, shelfId) {
        if (!game.user.isGM) return null;
        const key = `${actor.uuid}:${shelfId}`;
        const existing = this._windows.get(key);
        if (existing) return existing.render(true);
        const win = new this(actor, shelfId);
        this._windows.set(key, win);
        await win.render(true);
        return win;
    }

    get _key() {
        return `${this.actorUuid}:${this.shelfId}`;
    }

    async _resolveActor() {
        return fromUuid(this.actorUuid);
    }

    /** Bind the search box; the window base delegates click only. */
    _onRender(context, options) {
        super._onRender?.(context, options);
        const input = this.element?.querySelector('[data-merchant-search]');
        if (!input || input.dataset.merchantBound === 'true') return;
        input.dataset.merchantBound = 'true';

        let timer = null;
        input.addEventListener('input', (event) => {
            const value = event.target.value;
            // Debounced: a scan across every mapped pack is not free, and firing one
            // per keystroke would queue them faster than they finish.
            clearTimeout(timer);
            timer = setTimeout(() => void this.search(value), 250);
        });
        input.focus();
    }

    async search(query) {
        const compendiums = game.modules.get('coffee-pub-blacksmith')?.api?.compendiums;
        this.query = query ?? '';

        if (typeof compendiums?.searchDetailed !== 'function' || this.query.trim().length < 2) {
            this.results = [];
            this.truncated = false;
            return this.render(false);
        }

        this.searching = true;
        await this.render(false);
        try {
            const found = await compendiums.searchDetailed(this.query, 'Item', {
                itemType: physicalTypes(),
                limit: 60
            });
            this.results = found?.results ?? [];
            // Reported rather than silently capped: a GM who cannot find a thing
            // should know whether the scan stopped early.
            this.truncated = Boolean(found?.truncated);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Compendium search failed:`, error);
            this.results = [];
            this.truncated = false;
        } finally {
            this.searching = false;
            await this.render(false);
        }
    }

    async addResult(uuid, name) {
        const actor = await this._resolveActor();
        if (!actor || !uuid) return;
        try {
            const result = await MerchantManager.addToShelf(actor, this.shelfId, uuid);
            if (result?.ok) ui.notifications?.info(`${name ?? 'Item'} added to the shelf.`);
            else ui.notifications?.error(`Could not add ${name ?? 'that item'}.`);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not add ${name}:`, error);
            ui.notifications?.error(`Could not add ${name ?? 'that item'}.`);
        }
    }

    async getData() {
        const actor = await this._resolveActor();
        const shelf = actor?.items?.get(this.shelfId);
        const shelfConfig = MerchantManager.getShelfConfig(shelf);

        // Grouped by source pack, which is how a GM thinks about where a thing came
        // from — and the field Blacksmith returns for exactly this.
        const groups = new Map();
        for (const result of this.results) {
            const key = result.source ?? 'unknown';
            if (!groups.has(key)) {
                groups.set(key, { source: key, label: result.sourceLabel ?? key, package: result.sourcePackage ?? '', items: [] });
            }
            groups.get(key).items.push({
                uuid: result.uuid,
                name: result.name,
                img: result.img,
                type: result.type
            });
        }

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            shelfLabel: shelfConfig?.label || shelf?.name || 'Shelf',
            query: this.query,
            searching: this.searching,
            groups: [...groups.values()],
            hasResults: this.results.length > 0,
            resultCount: this.results.length,
            truncated: this.truncated,
            tooShort: this.query.trim().length > 0 && this.query.trim().length < 2
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
        this.constructor._windows.delete(this._key);
        super._onClose?.(options);
    }
}
