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

/** The sub-type key, namespaced as Foundry requires of a module. */
export const REGION_BEHAVIOR_TYPE = `${MODULE.ID}.openShop`;

/**
 * Teach Foundry what an Open Shop region is.
 *
 * **The class is defined here rather than at module scope on purpose.** It extends a
 * Foundry class reached through the `foundry` global, and a module script is evaluated
 * before that global is guaranteed — and ESM caches a failed evaluation, so a throw here
 * would kill the module for the session rather than being retried. Same reasoning as the
 * window base class, which cost this module a live world once. See `CONTRIBUTING.md` §9.
 */
export function registerRegionBehavior() {
    const base = foundry?.data?.regionBehaviors?.RegionBehaviorType;
    const fields = foundry?.data?.fields;
    const events = CONST?.REGION_EVENTS;
    if (!base || !fields || !events) {
        console.warn(`${MODULE.TITLE} | This Foundry has no region behaviours; shops open by token and pin only.`);
        return;
    }

    class OpenShopRegionBehavior extends base {
        /** Field labels and hints come from `BEHAVIOR.TYPES.openShop` in `lang/en.json`. */
        static LOCALIZATION_PREFIXES = ['BEHAVIOR.TYPES.openShop', 'BEHAVIOR.TYPES.base'];

        static defineSchema() {
            return {
                // **An Actor, not a token.** A region is a place and outlives what stands
                // in it, so it names the merchant the way a pin does -- and for the same
                // reason only a linked merchant is worth naming: an unlinked one is a copy
                // per placement, and a region cannot say which copy it meant.
                //
                // **Labels are passed as keys, not inherited from the prefixes.**
                // `LOCALIZATION_PREFIXES` is applied by `Localization.#localizeDataModels`,
                // which walks `CONFIG[...].dataModels` and then fires `i18nInit` -- and
                // `i18nInit` runs *before* `init`. A model registered at `init` has already
                // missed that pass, so its prefixes are never resolved and every field
                // renders with no label: a nameless checkbox in a fieldset. Naming the keys
                // here works whatever the order, which is why core's own behaviours can
                // rely on the prefixes and a module's cannot.
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
            };
        }

        /**
         * Open the shop for whoever walked in.
         *
         * **Only on that person's own client.** A region event fires for every client, and
         * opening a window for the whole table because one player stepped through a door is
         * the sort of thing that gets a module turned off.
         *
         * The GM is deliberately included: a GM moving a token into a shop is a GM visiting
         * a shop, and a door that ignores them is a door with a rule nobody asked for.
         */
        static async #onTokenMoveIn(event) {
            if (!event?.user?.isSelf) return;

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
            MerchantManager.openForActor(actor, { scene: this.parent?.parent?.parent ?? null });

            // Disabling is a write, and a write is the GM's. Everybody else has already
            // opened their shop by this point.
            if (this.once && game.user.isActiveGM) void this.parent.update({ disabled: true });
        }

        static events = {
            // **Move in, not enter.** `tokenEnter` also fires for a token created inside the
            // region and for one dropped in by a teleport, which is a shop opening because
            // the GM placed a token rather than because anybody walked anywhere.
            [events.TOKEN_MOVE_IN]: OpenShopRegionBehavior.#onTokenMoveIn
        };
    }

    CONFIG.RegionBehavior.dataModels[REGION_BEHAVIOR_TYPE] = OpenShopRegionBehavior;
    CONFIG.RegionBehavior.typeIcons[REGION_BEHAVIOR_TYPE] = 'fa-solid fa-shop';

    // **`typeLabels` is not decoration.** Foundry's own behaviour sheet uses it as the
    // legend of the fieldset it builds for a third-party schema —
    // `{legend: CONFIG.RegionBehavior.typeLabels[doc.type]}` in `region-behavior-config.mjs`
    // — so leaving it unset gives the GM a nameless box around our fields. A localization
    // key rather than a string: Foundry localizes it, and the same key names the type in
    // the Create Behavior dropdown.
    CONFIG.RegionBehavior.typeLabels[REGION_BEHAVIOR_TYPE] = `TYPES.RegionBehavior.${REGION_BEHAVIOR_TYPE}`;
}
