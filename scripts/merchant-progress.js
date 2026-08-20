// ==================================================================
// ===== PROGRESS ===================================================
// ==================================================================
//
// Restocking a shop is slow in a way nothing on screen admitted to. Every roll is a
// `table.roll()`, every result is a `fromUuid` against a compendium, and a shop with
// two inventories and four tables at ten rolls each is forty of each before a single item
// lands. That is seconds of nothing happening, which reads as nothing *having*
// happened -- and the GM presses the button again.
//
// **This is core's progress notification, not ours.** `ui.notifications.info(msg,
// { progress: true })` returns a bar that takes `update({ pct, message })`, is themed
// with the rest of Foundry, and sits where a user already looks for what a click did.
// Blacksmith has no progress primitive -- `api-window.md` names progress bars only as
// an example of what a consumer might put in its Tools zone -- and inventing one here
// would be the compendium-search mistake again: a second thing doing a job core
// already does, which nobody but us would maintain.
//
// The wrapper exists for one reason: a progress bar that is never finished stays on
// screen forever, and every caller here has a `try`/`catch` that could leave it that
// way. `finish()` is safe to call twice, so the ordinary path and the failure path can
// both call it without either having to know whether the other did.

import { MODULE } from './const.js';

/**
 * Start a progress bar over `total` units of work.
 *
 * Returns `{ step, finish }` whatever happens, so a caller never has to guard against
 * the bar being unavailable -- an old core, a headless client, a notification system
 * that has not booted. A no-op object that satisfies the same shape is worth more than
 * an `if` at every call site.
 *
 * A `total` of zero is not an error: there was work to survey and there turned out to
 * be none of it. The bar is simply never shown.
 */
export function startProgress(total, message) {
    const units = Math.max(0, Math.trunc(Number(total) || 0));
    if (!units) return { step() {}, finish() {} };

    let bar = null;
    try {
        bar = ui.notifications?.info(message, { progress: true, console: false });
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not open a progress bar:`, error);
        bar = null;
    }
    if (typeof bar?.update !== 'function') return { step() {}, finish() {} };

    let done = 0;
    let closed = false;

    return {
        /**
         * One unit of work is finished. `text` says what just happened, so the bar
         * reports the shop being stocked rather than a percentage of nothing.
         */
        step(text) {
            if (closed) return;
            done = Math.min(units, done + 1);
            try {
                bar.update({ pct: done / units, message: text ?? message });
            } catch (_error) {
                closed = true;
            }
        },

        /**
         * Fill and dismiss. **Safe to call more than once**, which is the point: the
         * success path and the `catch` can both call it blind.
         */
        finish(text) {
            if (closed) return;
            closed = true;
            try {
                bar.update({ pct: 1, message: text ?? message });
            } catch (_error) {
                // A bar that has already gone is the state we wanted anyway.
            }
        }
    };
}
