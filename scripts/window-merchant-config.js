import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import { MODULE } from './const.js';
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
        close: (_event, _target, win) => win.close()
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
        if (!toggle || toggle.dataset.merchantBound === 'true') return;
        toggle.dataset.merchantBound = 'true';
        toggle.addEventListener('change', (event) => void this._setEnabled(event.target.checked));
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

    async getData() {
        const actor = await this._resolveActor();
        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            actorName: actor?.name ?? 'Unknown',
            portraitImg: actor?.img ?? 'icons/svg/mystery-man.svg',
            enabled: MerchantManager.isMerchant(actor)
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
