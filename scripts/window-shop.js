import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/scripts/window-tool-base.js';
import { MODULE } from './const.js';
// Circular with manager-merchant.js by design: that module imports this one to open
// the window. Safe because every use below is inside a method, so the binding
// resolves at call time rather than at module evaluation.
import { MerchantManager } from './manager-merchant.js';

const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-shop.hbs';
const ROW_PARTIAL = 'modules/coffee-pub-merchant/templates/partial-shop-row.hbs';
let _partialsReady = null;

// Remembered across windows so a player with two characters is not asked twice.
let _lastRecipientUuid = null;

function _blacksmith() {
    return game.modules.get('coffee-pub-blacksmith')?.api ?? null;
}

/**
 * Attach an embedded Blacksmith control once its markup is in the document.
 *
 * Attaching to a detached wrapper does not work, and the failure is silent: the
 * inputs still render and still report a value, so an unbound entity list hands back
 * its initial selection rather than what the user picked. dialog.wait() exposes no
 * render hook, so poll a few frames for the input instead.
 */
async function _attachWhenRendered(control, inputName, frames = 20) {
    for (let i = 0; i < frames; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const live = document.querySelector(`[name="${inputName}"]`);
        if (!live) continue;
        control.attach(live.closest('.application') ?? document.body);
        return true;
    }
    console.warn(`${MODULE.TITLE} | Control "${inputName}" never rendered; falling back to form values.`);
    return false;
}

export class ShopWindow extends BlacksmithToolWindowBaseV2 {
    static _windows = new Map();

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-shop-window'],
            position: { width: 520, height: 560 },
            window: { title: 'Shop', resizable: true, minimizable: true },
            windowSizeConstraints: { minWidth: 420, minHeight: 320, maxWidth: 900, maxHeight: 'calc(100vh - 40px)' },
            toolTitlebar: 'full',
            rememberPosition: false,
            windowPositionKey: 'merchant-shop'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        changeRecipient: (_event, _target, win) => win.changeRecipient(),
        acquire: (_event, target, win) => win.run(() => win.acquire(target.dataset.itemId)),
        give: (_event, target, win) => win.run(() => win.giveTo(target.dataset.itemId)),
        party: (_event, target, win) => win.run(() => win.sendToParty(target.dataset.itemId))
    };

    constructor(tokenDocument, options = {}) {
        const opts = foundry.utils.mergeObject({}, options);
        opts.id ||= `merchant-shop-${tokenDocument.id}-${foundry.utils.randomID()}`;
        opts.position = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, ShopWindow.DEFAULT_OPTIONS.position ?? {}),
            opts.position || {}
        );
        opts.window = foundry.utils.mergeObject(
            foundry.utils.mergeObject({}, ShopWindow.DEFAULT_OPTIONS.window ?? {}),
            opts.window || {}
        );
        super(opts);
        this.tokenUuid = tokenDocument.uuid;
        this.busy = false;
    }

    static async open(tokenDocument) {
        const existing = this._windows.get(tokenDocument.uuid);
        if (existing) return existing.render(true);
        const win = new this(tokenDocument);
        this._windows.set(tokenDocument.uuid, win);
        await win.render(true);
        return win;
    }

    static closeForToken(tokenUuid) {
        const win = this._windows.get(tokenUuid);
        if (win) void win.close();
    }

    static refreshForToken(tokenUuid) {
        const win = this._windows.get(tokenUuid);
        if (win) void win.render(false);
    }

    async _resolveToken() {
        return fromUuid(this.tokenUuid);
    }

    // ==============================================================
    // ===== RECIPIENT ==============================================
    // ==============================================================

    get recipients() {
        return MerchantManager.getEligibleRecipients();
    }

    get recipient() {
        const options = this.recipients;
        if (!options.length) return null;
        return options.find((actor) => actor.uuid === (this._recipientUuid ?? _lastRecipientUuid)) ?? options[0];
    }

    setRecipient(uuid) {
        if (!uuid) return;
        this._recipientUuid = uuid;
        _lastRecipientUuid = uuid;
        void this.render(false);
    }

    /**
     * Pick an Actor through Blacksmith's entity list: portraits and names read far
     * better than a select when choosing a character.
     */
    async _pickActor({ title, actors, selectedUuid, confirmLabel = 'Select', confirmIcon = 'fa-solid fa-check' }) {
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.entityList?.create !== 'function' || typeof blacksmith?.dialog?.wait !== 'function') {
            ui.notifications?.warn('The Blacksmith entity list is unavailable.');
            return null;
        }
        if (!actors.length) return null;

        const inputName = 'merchant-actor';
        const list = blacksmith.entityList.create({
            entities: actors.map((actor) => ({ id: actor.uuid, uuid: actor.uuid, name: actor.name, img: actor.img })),
            mode: 'single',
            inputName,
            selected: selectedUuid ?? actors[0].uuid
        });

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `<div class="blacksmith-field">${list.html}</div>`;

        let chosen = null;
        let bound = false;
        const pending = blacksmith.dialog.wait({
            title,
            content: wrapper,
            classes: ['merchant-dialog'],
            // Secondary action left, primary right.
            buttons: [
                { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
                {
                    action: 'select',
                    label: confirmLabel,
                    icon: confirmIcon,
                    default: true,
                    callback: (form) => {
                        chosen = bound ? list.getSelectedIds()?.[0] ?? null : form?.elements?.[inputName]?.value ?? null;
                    }
                }
            ],
            closeValue: null,
            cancelValue: null
        });

        bound = await _attachWhenRendered(list, inputName);
        const outcome = await pending;
        list.destroy();

        return outcome?.value === 'select' ? chosen : null;
    }

    async changeRecipient() {
        const options = this.recipients;
        if (options.length < 2) return;
        const picked = await this._pickActor({
            title: 'Buying As',
            actors: options,
            selectedUuid: this.recipient?.uuid,
            confirmIcon: 'fa-solid fa-user-check'
        });
        if (picked) this.setRecipient(picked);
    }

    // ==============================================================
    // ===== ACTIONS ================================================
    // ==============================================================

    /** In-flight feedback only. The concurrency guarantee is the GM's. */
    async run(operation) {
        if (this.busy) return;
        this.busy = true;
        this.element?.classList.add('merchant-shop-busy');
        try {
            await operation();
        } catch (error) {
            console.error(`${MODULE.TITLE} | Shop action failed:`, error);
            ui.notifications?.error('That could not be completed.');
        } finally {
            this.busy = false;
            this.element?.classList.remove('merchant-shop-busy');
            if (this.constructor._windows.get(this.tokenUuid) === this) await this.render(false);
        }
    }

    async _send(payload, busy = {}) {
        this._busy = { row: busy.row ?? null, label: busy.label ?? 'Working' };
        await this.render(false);
        try {
            return await MerchantManager.request('acquire', { tokenUuid: this.tokenUuid, ...payload });
        } finally {
            this._busy = null;
        }
    }

    /** Ask how many only when there is a choice to make. */
    async _askQuantity(label, max) {
        if (max <= 1) return max;
        const blacksmith = _blacksmith();
        if (typeof blacksmith?.quantitySplit?.create !== 'function' || typeof blacksmith?.dialog?.wait !== 'function') {
            return max;
        }

        const inputName = 'merchant-quantity';
        const control = blacksmith.quantitySplit.create({
            max,
            value: 1,
            inputName,
            giveLabel: 'Take',
            keepLabel: 'Leave',
            amountLabel: `How many ${label}?`
        });

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `<div class="blacksmith-field">${control.html}</div>`;

        let chosen = null;
        let bound = false;
        const pending = blacksmith.dialog.wait({
            title: `Acquire ${label}`,
            content: wrapper,
            classes: ['merchant-dialog'],
            buttons: [
                { action: 'cancel', label: 'Cancel', icon: 'fa-solid fa-xmark' },
                {
                    action: 'take',
                    label: 'Acquire',
                    icon: 'fa-solid fa-hand',
                    default: true,
                    callback: (form) => {
                        chosen = bound ? control.getValue() : Number(form?.elements?.[inputName]?.value ?? 1);
                    }
                }
            ],
            closeValue: null,
            cancelValue: null
        });

        bound = await _attachWhenRendered(control, inputName);
        const outcome = await pending;
        control.destroy();

        if (outcome?.value !== 'take') return null;
        const amount = Math.trunc(Number(chosen));
        return Number.isFinite(amount) && amount >= 1 ? Math.min(amount, max) : null;
    }

    async _itemContext(itemId) {
        const token = await this._resolveToken();
        const item = token?.actor?.items?.get(itemId);
        if (!item) {
            ui.notifications?.warn('That is no longer in stock.');
            return null;
        }
        return { item, token };
    }

    /**
     * Stock is infinite, so quantity is what the buyer wants rather than what is
     * available. The cap is arbitrary and exists only to keep the slider usable.
     */
    static MAX_PER_ACQUISITION = 20;

    async acquire(itemId) {
        const recipient = this.recipient;
        if (!recipient) {
            ui.notifications?.warn('You have no character able to receive this.');
            return;
        }
        const context = await this._itemContext(itemId);
        if (!context) return;
        const amount = await this._askQuantity(context.item.name, ShopWindow.MAX_PER_ACQUISITION);
        if (!amount) return;
        this._report(
            await this._send({ itemId, quantity: amount, recipientUuid: recipient.uuid },
                { row: itemId, label: `Acquiring ${context.item.name}` }),
            `${recipient.name} acquired ${amount > 1 ? `${amount} ` : ''}${context.item.name}.`);
    }

    async giveTo(itemId) {
        const token = await this._resolveToken();
        const choices = MerchantManager.getGiftRecipients(token?.actor?.uuid);
        if (!choices.length) {
            ui.notifications?.warn('There is nobody in the party to send this to.');
            return;
        }
        const context = await this._itemContext(itemId);
        if (!context) return;

        const recipientUuid = await this._pickActor({
            title: `Send ${context.item.name}`,
            actors: choices,
            confirmLabel: 'Send',
            confirmIcon: 'fa-solid fa-hand-holding-heart'
        });
        if (!recipientUuid) return;

        const amount = await this._askQuantity(context.item.name, ShopWindow.MAX_PER_ACQUISITION);
        if (!amount) return;

        const recipient = choices.find((actor) => actor.uuid === recipientUuid);
        this._report(
            await this._send({ itemId, quantity: amount, recipientUuid },
                { row: itemId, label: `Sending ${context.item.name}` }),
            `${context.item.name} sent to ${recipient?.name ?? 'the party'}.`);
    }

    async sendToParty(itemId) {
        const party = MerchantManager.getPartyActor();
        if (!party) {
            ui.notifications?.warn('No primary party is set for this world.');
            return;
        }
        const context = await this._itemContext(itemId);
        if (!context) return;
        const amount = await this._askQuantity(context.item.name, ShopWindow.MAX_PER_ACQUISITION);
        if (!amount) return;
        this._report(
            await this._send({ itemId, quantity: amount, recipientUuid: party.uuid },
                { row: itemId, label: `Sending ${context.item.name}` }),
            `${context.item.name} sent to ${party.name}.`);
    }

    /** `ok: true, merged: false` is success — the item arrived as its own row. */
    _report(result, successMessage) {
        if (result?.ok) {
            if (successMessage) ui.notifications?.info(successMessage);
            return;
        }
        ui.notifications?.error(this._explain(result?.code, result));
    }

    _explain(code, result) {
        switch (code) {
            case 'INVENTORY_UNAVAILABLE': return 'The Blacksmith inventory API is not available.';
            case 'NO_ACTIVE_GM': return 'No GM is connected, so nothing can change hands.';
            case 'TIMEOUT': return 'The GM did not respond. If this keeps happening, the world may need a restart.';
            case 'NOT_A_MERCHANT': return 'This is no longer a shop.';
            case 'MERCHANT_NOT_FOUND': return 'That shop is no longer on the scene.';
            case 'ITEM_NOT_FOUND': return 'That is no longer in stock.';
            case 'ITEM_NOT_TRANSFERABLE': return 'That is not something you can carry off.';
            case 'NOT_FOR_SALE': return 'That is not for sale.';
            case 'CONTAINER_HAS_CONTENTS': return Number.isFinite(result?.contentCount)
                ? `That container holds ${result.contentCount} item${result.contentCount === 1 ? '' : 's'} and cannot be sold as one.`
                : 'That container cannot be sold while it holds anything.';
            case 'RECIPIENT_NOT_ALLOWED': return 'That character cannot receive this.';
            case 'RECIPIENT_NOT_FOUND': return 'That character could not be found.';
            case 'INVALID_QUANTITY': return 'That is not a valid amount.';
            case 'LOCK_TIMEOUT': return 'That character is busy. Try again.';
            case 'TARGET_CREATE_FAILED': return 'That could not be added to the recipient.';
            default: return 'That could not be completed.';
        }
    }

    // ==============================================================
    // ===== RENDER =================================================
    // ==============================================================

    async getData() {
        // Registered once; the row markup is shared by both call sites so it cannot
        // drift between them.
        _partialsReady ??= foundry.applications.handlebars.loadTemplates([ROW_PARTIAL]);
        await _partialsReady;

        const token = await this._resolveToken();
        const merchant = token?.actor;
        const missing = !token || !merchant;

        const party = MerchantManager.getPartyActor();
        const options = this.recipients;
        const recipient = this.recipient;
        const config = missing ? null : MerchantManager.getConfig(merchant);

        // One section per shelf. A GM sees hidden shelves too, marked as such; a
        // player is never sent their contents at all.
        let shelves = [];
        let itemCount = 0;
        if (!missing) {
            const busyRow = this._busy?.row ?? null;
            const isGM = game.user.isGM;

            shelves = MerchantManager.getShelves(merchant, { includeHidden: isGM }).map(({ item: shelf, config }) => {
                const contents = MerchantManager.getShelfContents(merchant, shelf).map((item) => ({
                    id: item.id,
                    name: item.name,
                    img: item.img,
                    typeLabel: item.type?.charAt(0).toUpperCase() + item.type?.slice(1),
                    busy: item.id === busyRow,
                    // Barter is a conversation, not a transaction: the row is listed
                    // so the party knows it exists, but nothing changes hands here.
                    canAcquire: Boolean(recipient) && config.mode !== 'barter',
                    canParty: Boolean(party) && config.mode !== 'barter',
                    isBarter: config.mode === 'barter'
                }));
                itemCount += contents.length;
                return {
                    id: shelf.id,
                    label: config.label || shelf.name,
                    img: shelf.img,
                    hidden: config.visible === false,
                    isBarter: config.mode === 'barter',
                    items: contents,
                    count: contents.length,
                    hasItems: contents.length > 0
                };
            });
        }

        const bodyContent = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
            missing,
            shopName: config?.name || token?.name || 'Shop',
            portraitImg: merchant?.img ?? 'icons/svg/mystery-man.svg',
            shelves,
            hasShelves: shelves.length > 0,
            itemCount,
            busyLabel: this._busy?.label ?? null,
            recipientName: recipient?.name ?? null,
            recipientImg: recipient?.img ?? 'icons/svg/mystery-man.svg',
            hasRecipient: Boolean(recipient),
            hasRecipientChoice: options.length > 1
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

    /**
     * The shop claims left double-click on the token, which is how a GM would
     * normally reach the Actor sheet. These give that back rather than leaving the
     * GM to hunt for the actor in the sidebar. In micro-titlebar mode the base folds
     * them into the window's context menu automatically.
     */
    getToolHeaderActions() {
        if (!game.user.isGM) return [];
        return [
            {
                id: 'merchant-sheet',
                icon: 'fa-solid fa-user',
                label: 'Character Sheet',
                onClick: () => void this.openSheet()
            },
            {
                id: 'merchant-prototype',
                icon: 'fa-solid fa-chess-pawn',
                label: 'Prototype Token',
                onClick: () => void this.openPrototypeToken()
            }
        ];
    }

    async openSheet() {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        token?.actor?.sheet?.render(true, { token });
    }

    async openPrototypeToken() {
        if (!game.user.isGM) return;
        const token = await this._resolveToken();
        const prototype = token?.actor?.prototypeToken;
        const sheetClass = CONFIG.Token?.prototypeSheetClass;
        // PrototypeToken is a DataModel with no `sheet` getter, so `prototype.sheet`
        // optional-chains into silence. This is how core opens it.
        if (!prototype || !sheetClass) {
            ui.notifications?.warn('This merchant has no prototype token.');
            return;
        }
        new sheetClass({ prototype }).render(true);
    }

    _onClose(options) {
        this.constructor._windows.delete(this.tokenUuid);
        super._onClose?.(options);
    }
}
