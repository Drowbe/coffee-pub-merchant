// ==================================================================
// ===== EVERYTHING IN THE POST =====================================
// ==================================================================
//
// **The one place that says what the world owes.**
//
// Mail order scattered its state deliberately: a consignment lives on the receipt, and the
// receipts are the queue. That is the right storage — it survives a session, a deleted
// merchant and a rewound clock — and it is a terrible *view*. A GM who wants to know what
// is in the post has to open every character sheet in the party and look for a piece of
// paper, which means the answer to "did that order ever land?" is a search rather than a
// glance.
//
// So this reads the same durable state the courier does — `pendingConsignments()`, one walk
// over every Actor's items — and lays it out. Nothing is stored here and nothing is cached:
// the window is a lens, and closing it loses nothing.
//
// ===== WHY SO FEW BUTTONS =========================================
//
// **Cancel, and hand it over.** Everything else a GM might want to do to a parcel in
// transit is already something they can do to an Item: a receipt can be deleted, moved,
// renamed, handed to another character. Rebuilding those as controls here would be a second
// way to do them, free to disagree with the first.
//
// The two that are *not* reachable by dragging an Item around are the two that live here:
// striking an order off, and deciding that the party have collected it. The second is the
// same operation the GM's collection dialog performs, which is why it calls the same
// method rather than a copy of it.

import { MODULE } from './const.js';
import { BlacksmithToolWindowBaseV2 } from '/modules/coffee-pub-blacksmith/api/blacksmith-api.js';
import {
    pendingConsignments, serviceFor, arrivalLabel, hasLanded, needsCollection, unscheduleDelivery,
    consignmentOf
} from './utility-mail.js';
import { formatBase, coinsFor } from './utility-pricing.js';
import { grantCurrency } from './utility-inventory.js';
import { notify } from './utility-feedback.js';

const TEMPLATE = 'modules/coffee-pub-merchant/templates/window-deliveries.hbs';

export class DeliveriesWindow extends BlacksmithToolWindowBaseV2 {
    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
        foundry.utils.mergeObject({}, super.DEFAULT_OPTIONS ?? {}),
        {
            classes: ['merchant-deliveries-window'],
            position: { width: 560, height: 520 },
            window: { title: 'Orders in Transit', resizable: true, minimizable: true },
            windowSizeConstraints: { minWidth: 420, minHeight: 300, maxHeight: 'calc(100vh - 80px)' },
            toolTitlebar: 'full',
            rememberPosition: true,
            windowPositionKey: 'merchant-deliveries'
        }
    );

    static ACTION_HANDLERS = {
        close: (_event, _target, win) => win.close(),
        cancelOrder: (_event, target, win) => void win.cancelOrder(target.dataset.actorUuid, target.dataset.itemId),
        deliverNow: (_event, target, win) => void win.deliverNow(target.dataset.actorUuid, target.dataset.itemId),
        openReceipt: (_event, target, win) => void win.openReceipt(target.dataset.actorUuid, target.dataset.itemId)
    };

    /**
     * One window, GM only.
     *
     * Not per anything: this is the world's post, not a shop's. A second copy would be the
     * same list twice, and the base's registry is keyed by a subject, so the key is the
     * module id.
     */
    static async open() {
        if (!game.user.isGM) return null;
        return this.openFor(MODULE.ID);
    }

    /**
     * Redraw every open copy.
     *
     * Called when a parcel lands or is struck off, because the list is a view of documents
     * nothing here owns: a delivery arriving on the clock while this window is open would
     * otherwise leave a row describing something that has already happened.
     */
    static refresh() {
        // `openWindows` is the tool base's own registry accessor. `allOpen` is a helper the
        // *shop* window declares for itself, and reaching for it here — optional-chained,
        // so it failed silently — meant this method did nothing at all.
        for (const window of this.openWindows?.() ?? []) void window.render(false);
    }

    /**
     * **`getData`, not `_prepareContext`.** The tool base overrides `_prepareContext` to do
     * its own zone work and calls `getData` from inside it, so a subclass overriding the
     * outer one leaves the base calling a method that is not there. The shop and the
     * settings window both answer `getData`; this file did not, because it was written from
     * the ApplicationV2 shape rather than from the base sitting beside it.
     */
    async getData() {
        const now = game.time?.worldTime ?? 0;
        const rows = pendingConsignments().map(({ actor, item, record }) => {
            const service = serviceFor(record.service);
            const landed = hasLanded(record);

            return {
                actorUuid: actor.uuid,
                itemId: item.id,
                who: actor.name,
                whoImg: actor.img,
                shop: record.shopName ?? '',
                service: service.name,
                serviceIcon: service.icon,
                where: record.destination ?? '',
                // **Three states, not two.** In transit; landed and waiting to be
                // collected; landed and coming to them, which is the beast still on its way
                // to a moving target. A GM chasing an order needs to know which of those a
                // row is before they know whether anything is stuck.
                landed,
                awaiting: landed && needsCollection(record),
                when: arrivalLabel(record.arrivesAt, now),
                goods: record.items.map((entry) => `${entry.name} ×${entry.quantity}`).join(', '),
                paid: formatBase((record.goodsBase ?? 0) + (record.feeBase ?? 0) + (record.depositBase ?? 0)),
                crates: record.crates ?? 1,
                instructions: record.instructions ?? ''
            };
        });

        // Nearest first: a list of parcels is read to find out what is about to happen.
        rows.sort((a, b) => Number(a.landed) - Number(b.landed) || 0);

        return {
            appId: this.id,
            bodyContent: await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
                rows,
                hasRows: rows.length > 0,
                count: rows.length
            }),
            showToolFooter: true,
            toolFooterLeft: `
                <button type="button" class="blacksmith-window-btn-secondary" data-action="close">
                    <i class="fa-solid fa-xmark"></i> Close
                </button>`
        };
    }

    getToolHeaderActions() {
        return [{
            id: 'merchant-deliveries-refresh',
            icon: 'fa-solid fa-rotate',
            label: 'Refresh',
            onClick: () => void this.render(false)
        }];
    }

    /** The receipt itself, for a GM who wants to read or edit the Item. */
    async openReceipt(actorUuid, itemId) {
        const actor = await fromUuid(actorUuid);
        actor?.items?.get(itemId)?.sheet?.render(true);
    }

    /**
     * Strike an order off, and decide about the money.
     *
     * **Three answers, because the refund is a separate decision from the cancellation.**
     * The module used to refuse the question outright — nothing was refunded, and the
     * dialog said so — on the grounds that whether a party get their coin back belongs to
     * the table. It does, which is an argument for *asking* the GM rather than for deciding
     * on their behalf: the reasons an order gets struck off are not alike. A shop that
     * cheated them should pay. A party who changed their mind mid-journey probably should
     * not. A GM correcting their own mistake wants the coin back and no fuss about it.
     *
     * So: **Refund** hands back everything the order took — goods, carriage and crate
     * deposit, which is what was actually paid rather than what the goods were worth.
     * **No refund** strikes it off and keeps the coin. **Cancel** does nothing at all,
     * which matters because this is a destructive control on a list where the rows move.
     *
     * Nothing is taken from the merchant. The shop's half of a mail order is fiction — a
     * refund that failed because a shop had been deleted would be a worse answer than a
     * refund that simply happens, and there is no till to reconcile against.
     */
    async cancelOrder(actorUuid, itemId) {
        if (!game.user.isGM) return;

        const actor = await fromUuid(actorUuid);
        const item = actor?.items?.get(itemId);
        const record = consignmentOf(item);
        if (!item || !record) return void this.render(false);

        const paid = (record.goodsBase ?? 0) + (record.feeBase ?? 0) + (record.depositBase ?? 0);
        const answer = await this._askAboutTheMoney(actor, record, paid);
        if (answer === null) return;

        try {
            unscheduleDelivery(item);
            await item.delete();

            if (answer === true && paid > 0) await this._refund(actor, paid);

            notify.info(game.i18n.format(
                answer ? 'coffee-pub-merchant.transit.cancelledRefund' : 'coffee-pub-merchant.transit.cancelled',
                { who: actor.name, amount: formatBase(paid) }
            ));
        } catch (error) {
            console.error(`${MODULE.TITLE} | Could not cancel that order:`, error);
            notify.error(game.i18n.localize('coffee-pub-merchant.transit.cancelFailed'));
        }
        DeliveriesWindow.refresh();
    }

    /**
     * Refund or not, or neither.
     *
     * @returns {Promise<boolean|null>} true to pay it back, false to keep it, null to stop.
     */
    async _askAboutTheMoney(actor, record, paid) {
        const blacksmith = game.modules.get('coffee-pub-blacksmith')?.api;
        // Without a dialog there is no way to ask, and striking an order off silently while
        // quietly moving money would be the worst of the three outcomes. The safe answer is
        // the one that changes least.
        if (typeof blacksmith?.dialog?.wait !== 'function') return false;

        const answer = await blacksmith.dialog.wait({
            title: game.i18n.localize('coffee-pub-merchant.transit.cancelTitle'),
            classes: ['merchant-dialog'],
            content: `<p>${game.i18n.format('coffee-pub-merchant.transit.cancelAsk', {
                who: foundry.utils.escapeHTML(actor.name),
                shop: foundry.utils.escapeHTML(record.shopName ?? '')
            })}</p><p>${game.i18n.format('coffee-pub-merchant.transit.cancelMoney', {
                amount: formatBase(paid)
            })}</p>`,
            buttons: [
                {
                    action: 'cancel',
                    label: game.i18n.localize('coffee-pub-merchant.common.cancel'),
                    icon: 'fa-solid fa-xmark'
                },
                {
                    action: 'keep',
                    label: game.i18n.localize('coffee-pub-merchant.transit.noRefund'),
                    icon: 'fa-solid fa-ban'
                },
                {
                    action: 'refund',
                    label: game.i18n.format('coffee-pub-merchant.transit.refund', { amount: formatBase(paid) }),
                    icon: 'fa-solid fa-coins',
                    default: true
                }
            ],
            closeValue: 'cancel'
        });

        // `.value`, because `dialog.wait` answers with an object. Comparing the result
        // itself to a string is always false, which is a bug this module has already
        // shipped once -- both buttons did nothing and the crate stayed shut.
        if (answer?.value === 'refund') return true;
        if (answer?.value === 'keep') return false;
        return null;
    }

    /**
     * Put the whole price back in the party's purse.
     *
     * `grantCurrency` rather than a write to `system.currency`: a raw update is a total
     * computed from a read taken outside the lock, so a refund landing during a settlement
     * is silently discarded. Coins are cut from the base amount the same way a payment is,
     * so a refund of 5 gp 3 cp comes back as 5 gp and 3 cp rather than as a heap of copper.
     */
    async _refund(actor, paid) {
        const currency = coinsFor(paid);
        if (!Object.keys(currency).length) return;

        const result = await grantCurrency({ targetActorUuid: actor.uuid, currency });
        if (!result?.ok) {
            console.error(`${MODULE.TITLE} | Could not refund ${actor.name}:`, result);
            notify.error(game.i18n.localize('coffee-pub-merchant.transit.refundFailed'));
        }
    }

    /**
     * Hand it over now, wherever the party are.
     *
     * The same operation the collection dialog performs when a GM answers *they are there*,
     * called through the manager rather than copied: a parcel handed over from this window
     * and one handed over at the counter should be the same event, including the toast the
     * player gets.
     *
     * It also covers the case the clock cannot: a GM who has decided the delivery happens
     * now, whatever the calendar says.
     */
    async deliverNow(actorUuid, itemId) {
        if (!game.user.isGM) return;
        const { MerchantManager } = await import('./manager-merchant.js');
        await MerchantManager.handOver(actorUuid, itemId);
        void this.render(false);
    }
}
