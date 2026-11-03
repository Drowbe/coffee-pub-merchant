// ==================================================================
// ===== WALK IN AND THE SHOP OPENS =================================
// ==================================================================
//
// A third door onto a shop: a **Region behaviour**, so a GM draws a shape on the map and
// walking a token into it opens the counter.
//
// **Foundry's own extension point, not a patch.** `CONFIG.RegionBehavior.dataModels`
// takes a namespaced sub-type from any module, and `module.json` declares that the
// sub-type exists — that pair is the whole mechanism. Nothing in core is overwritten,
// nothing is wrapped, and a Foundry that stops offering this stops offering it loudly
// rather than by breaking a monkey-patch three versions later.
//
// The behaviour is the *door*, not the shop. Which merchant, whether it is open, who may
// see what — all of that is answered exactly where a token double-click answers it, so a
// region and a pin and a token cannot disagree about the same shop.

import { MODULE } from './const.js';
import { MerchantManager } from './manager-merchant.js';
import { canPin } from './utility-pins.js';
import { notify } from './utility-feedback.js';

/**
 * Refuse a merchant a region cannot open, while the GM is still looking at the field.
 *
 * **Only a linked merchant.** The same rule a pin follows, for the same reason: a region is
 * a place, and an unlinked Actor is the mould three placements were cast from rather than a
 * shop with stock on it. Naming one is naming nothing in particular.
 *
 * `fromUuidSync` because a validator cannot await, which also means a compendium uuid
 * cannot be resolved here — those throw, and are let through to be answered on the way in.
 * Anything unresolvable is let through for the same reason: a validator that rejects what
 * it merely cannot see is a validator that blocks a GM from saving a correct region.
 */
function validateLinkedMerchant(value) {
    if (!value) return undefined;
    let actor = null;
    try {
        actor = fromUuidSync(value);
    } catch (_error) {
        return undefined;
    }
    if (!actor || actor.documentName !== 'Actor') return undefined;
    if (canPin(actor)) return undefined;
    return game.i18n.format('coffee-pub-merchant.region.notLinked', { name: actor.name });
}

/**
 * Open the shop for whoever walked in. `this` is the behaviour.
 *
 * **Only on that person's own client** -- which is Blacksmith's default for a region
 * handler (`run: 'mover'`), so there is no `isSelf` check here. A region event fires for
 * every client, and opening a window for the whole table because one player stepped
 * through a door is the sort of thing that gets a module turned off.
 *
 * The GM is deliberately included: a GM moving a token into a shop is a GM visiting
 * a shop, and a door that ignores them is a door with a rule nobody asked for.
 */
async function onTokenMoveIn(_event) {
    let actor = null;
    try {
        actor = this.merchant ? await fromUuid(this.merchant) : null;
    } catch (_error) {
        actor = null;
    }
    // **Every refusal says so, to the person standing in the region.** A door that
    // does nothing is indistinguishable from a door that is not there, and the
    // person who finds out is the one who cannot fix it -- so the GM is told what
    // is wrong with the region and everybody else is told the shop is not open.
    if (!MerchantManager.isMerchant(actor)) {
        notify.warn(game.i18n.localize(game.user.isGM
            ? 'coffee-pub-merchant.region.noMerchant'
            : 'coffee-pub-merchant.region.nothingHere'));
        return;
    }
    // Belt and braces: the field refuses an unlinked merchant on save, and this
    // catches a region configured before that check existed, or an Actor unlinked
    // after the fact. An unlinked Actor is the mould, not a shop -- there is
    // nothing on it to sell.
    if (!canPin(actor)) {
        notify.warn(game.i18n.format(game.user.isGM
            ? 'coffee-pub-merchant.region.notLinked'
            : 'coffee-pub-merchant.region.nothingHere', { name: actor.name }));
        return;
    }

    // The region's own scene, which is where the token that entered is standing --
    // and what the market rate and the party's standing are read from.
    // **The one door that means you are standing in the place**, which is what makes
    // it the one a merchant can single out for full screen. See `opensFullScreen`.
    MerchantManager.openForActor(actor, { scene: this.parent?.parent?.parent ?? null, door: 'region' });
}

/**
 * Switch the region off after the first walk-in, when "Once only" is set.
 *
 * **A separate handler, run on the active GM's client.** A region event reaches every
 * client and the mover's handler runs only on the mover's, so a write behind `isActiveGM`
 * inside it only ever ran when the GM was the one who walked in: Once never switched off
 * for a player. A write is the GM's, so it gets its own handler (`run: 'activeGM'`).
 *
 * **It cannot see whether the mover's shop opened**, so it asks the same question the
 * opener asks, from the behaviour's own field: a walk-in that would be refused (no
 * merchant, not linked) must not spend the region's one use.
 */
async function disableWhenOnce(_event) {
    if (!this.once) return;
    let actor = null;
    try {
        actor = this.merchant ? await fromUuid(this.merchant) : null;
    } catch (_error) {
        actor = null;
    }
    if (!MerchantManager.isMerchant(actor) || !canPin(actor)) return;
    void this.parent.update({ disabled: true });
}

/**
 * Teach Foundry what an Open Merchant region is, through Blacksmith's regions API.
 *
 * Blacksmith holds the sharp edges this file used to: it refuses a call after `init`,
 * builds the model class inside the call rather than at module scope, sets
 * `dataModels` / `typeIcons` / `typeLabels`, and runs a handler only on the mover's client.
 * What stays here is what the behaviour *is*: its fields and what walking in does.
 *
 * `module.json` still declares `documentTypes.RegionBehavior.openShop` -- Foundry reads
 * it before any script runs, so no API can do that part.
 *
 * **There is deliberately no fallback to registering it ourselves.** A second copy of that
 * logic is the thing the API exists to remove. The cost of its absence is real, though: a
 * scene that already carries an Open Merchant behaviour will throw on every token drag
 * until Blacksmith is updated. That is why this says so loudly rather than quietly.
 */
export function registerRegionBehavior() {
    const regions = game.modules.get('coffee-pub-blacksmith')?.api?.regions;
    if (typeof regions?.registerBehavior !== 'function') {
        console.error(`${MODULE.TITLE} | Blacksmith has no regions API (api.regions.registerBehavior), so the Open Merchant region behaviour is NOT registered. `
            + 'Update Coffee Pub Blacksmith: until then, a scene with an Open Merchant region will throw on every token move.');
        return;
    }

    regions.registerBehavior({
        moduleId: MODULE.ID,
        name: 'openShop',
        // Bare label: Blacksmith builds "CP Merchant: Open Merchant" for the Create Behavior
        // list and the fieldset legend.
        label: 'Open Merchant',
        icon: 'fa-solid fa-shop',
        // `LOCALIZATION_PREFIXES` default to `BEHAVIOR.TYPES.openShop` / `BEHAVIOR.TYPES.base`,
        // which is what `lang/en.json` already uses.
        fields: (fields) => ({
            // **An Actor, not a token.** A region is a place and outlives what stands
            // in it, so it names the merchant the way a pin does -- and for the same
            // reason only a linked merchant is worth naming: an unlinked one is a copy
            // per placement, and a region cannot say which copy it meant.
            //
            // **Labels are passed as keys, not inherited from the prefixes.** `init` fires
            // before translations load, and `i18nInit` (after it) is what resolves
            // `LOCALIZATION_PREFIXES` -- so a model registered at `init` should be covered by
            // that pass. A blank label was seen on an earlier version of this code and its
            // cause was never pinned down, so the keys are named directly, which works
            // whatever the order.
            merchant: new fields.DocumentUUIDField({
                type: 'Actor',
                label: 'BEHAVIOR.TYPES.openShop.FIELDS.merchant.label',
                hint: 'BEHAVIOR.TYPES.openShop.FIELDS.merchant.hint',
                // Refused at the point of saving rather than at the point of walking in.
                // A region that cannot work is worth knowing about while you are looking
                // at its settings, not a session later when somebody steps on it.
                validate: (value) => validateLinkedMerchant(value)
            }),

            // Off by default. A shop that opens every time somebody crosses the
            // threshold is right for a market stall and wrong for a corridor the party
            // walks up and down, and only the GM who drew the region knows which.
            once: new fields.BooleanField({
                label: 'BEHAVIOR.TYPES.openShop.FIELDS.once.label',
                hint: 'BEHAVIOR.TYPES.openShop.FIELDS.once.hint'
            })
        }),
        events: {
            // **Move in, not enter.** `tokenEnter` also fires for a token created inside the
            // region and for one dropped in by a teleport, which is a shop opening because
            // the GM placed a token rather than because anybody walked anywhere.
            tokenMoveIn: [
                onTokenMoveIn,                                       // opens the shop, on the mover's client
                { run: 'activeGM', handler: disableWhenOnce }        // the Once write, on the GM's
            ]
        }
    });
}
