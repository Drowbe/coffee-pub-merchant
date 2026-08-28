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
                merchant: new fields.DocumentUUIDField({ type: 'Actor' }),

                // Off by default. A shop that opens every time somebody crosses the
                // threshold is right for a market stall and wrong for a corridor the party
                // walks up and down, and only the GM who drew the region knows which.
                once: new fields.BooleanField()
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
            // A region naming a merchant that has been deleted says so once, to the person
            // who walked into it, rather than failing silently in a place they cannot see.
            if (!MerchantManager.isMerchant(actor)) {
                if (game.user.isGM) {
                    console.warn(`${MODULE.TITLE} | A region names a merchant that no longer exists:`, this.merchant);
                }
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
