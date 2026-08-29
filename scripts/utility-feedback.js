// ==================================================================
// ===== TOASTS =====================================================
// ==================================================================
//
// Everything this module says to a person goes through here.
//
// Foundry's `ui.notifications` is a core-styled text queue: not themeable, no image
// slot, and nothing can be done with one except read it before it goes. Blacksmith's
// toast API is the suite's answer to that, so a Merchant message looks like a Coffee
// Pub message rather than like a Foundry one.
//
// **Thin on purpose**, the same way `utility-inventory.js` is thin. What lives here
// is Merchant's own defaults -- its icons, its palette, its module id, its channels --
// and the fallback for a world whose Blacksmith predates the API. No behaviour of
// Blacksmith's is reimplemented, and nothing here should grow into a second toast
// system.
//
// **Toasts are local.** `show()` renders on the client that calls it and there is no
// cross-client delivery in this API, so every call has to be made on the client that
// should see it. That is why the transaction receipt is raised in the shop window,
// where the player is, and never in the GM handler that did the work.

import { MODULE } from './const.js';

/**
 * Merchant's palette, as strict hex — the toast API validates and ignores anything else.
 *
 * **A toast is dark and the windows are parchment, so these are not the window colours.**
 * The first version of this file reused them — the same green as the Open sign, the same
 * red as Always closed — and they were nearly unreadable: `styles/toast.css` paints
 * `rgba(20, 20, 20, 0.9)` behind them, and a colour chosen to sit on parchment has
 * nowhere near the contrast to sit on that. One `color` drives the border, the icon and
 * the title together, so getting it wrong makes the whole toast hard to read rather than
 * just the trim.
 *
 * These are the same four hues lifted for a dark surface, and pitched to sit beside the
 * body text the stylesheet already uses (`#ac9f81`) rather than fight it.
 *
 * There is no built-in set to reach for instead: the toast API has no `type` or `theme`
 * concept, only a caller-supplied hex. Passing no colour at all is a real option and
 * gives the default look, but then an error and a receipt are indistinguishable, which
 * is worth more than the consistency.
 */
const COLOR = Object.freeze({
    info: '#c8b083',      // parchment gold, lifted off the dark
    success: '#7fbf6a',   // the Open sign's green, made legible
    warn: '#e0a34a',      // amber: you can fix this
    error: '#e06c5a'      // red, and still red at this weight
});

const ICON = Object.freeze({
    info: 'fa-solid fa-circle-info',
    success: 'fa-solid fa-handshake',
    warn: 'fa-solid fa-triangle-exclamation',
    error: 'fa-solid fa-circle-exclamation'
});

/**
 * Channels a GM can switch off for an excluded account.
 *
 * Named per *class of event somebody might plausibly want separated*, which is the
 * doc's rule. A stream or camera login has no reason to see a shop restocking, and
 * every reason to be spared it; whether it should see a purchase land is a judgement
 * that belongs to whoever set the table up, not to us.
 *
 * Errors are deliberately **unchannelled**, which means they never reach an excluded
 * user at all. Nobody is behind that screen to act on one.
 */
export const CHANNEL = Object.freeze({
    TRANSACTION: 'merchant-transaction',
    SHOP: 'merchant-shop'
});

function api() {
    return game.modules.get('coffee-pub-blacksmith')?.api?.toast ?? null;
}

/** Register once at ready, so each channel gets a labelled checkbox in settings. */
export function registerToastChannels() {
    const toast = api();
    if (typeof toast?.registerChannel !== 'function') return;

    toast.registerChannel(CHANNEL.TRANSACTION, {
        moduleId: MODULE.ID,
        label: 'Merchant Transactions',
        description: game.i18n.localize('coffee-pub-merchant.feedback.transaction')
    });
    toast.registerChannel(CHANNEL.SHOP, {
        moduleId: MODULE.ID,
        label: 'Merchant Management',
        description: game.i18n.localize('coffee-pub-merchant.feedback.gmActivity')
    });
}

/** A configured sound path for the toast API, or undefined to stay silent. */
function configuredSound(key) {
    try {
        const sound = game.settings.get(MODULE.ID, key);
        return !sound || sound === 'none' || sound === 'sound-none' ? undefined : sound;
    } catch (_error) {
        return undefined;
    }
}

/**
 * Show one toast, or fall back to a Foundry notification.
 *
 * The fallback is not politeness — Merchant requires Blacksmith, but it does not
 * require a Blacksmith *new enough* to have this API, and a world one version behind
 * should lose the styling rather than the message.
 */
function show(kind, title, { subtitle, duration, channel, onClick, stackKey, icon, image, sound } = {}) {
    const toast = api();
    if (typeof toast?.show !== 'function') {
        // `warn` is the closest core has to our amber; success is an info.
        const fallback = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info';
        ui.notifications?.[fallback]?.(subtitle ? `${title} — ${subtitle}` : title);
        return null;
    }

    return toast.show({
        title,
        subtitle,
        icon: icon ?? ICON[kind],
        image,
        color: COLOR[kind],
        // Errors linger, because the thing that caused one is usually still on screen
        // and worth reading twice. Everything else takes the API's default.
        duration: duration ?? (kind === 'error' ? 12 : 8),
        moduleId: MODULE.ID,
        channel,
        onClick,
        stackKey,
        sound
    });
}

/**
 * Play one of the configured sounds, on this client only.
 *
 * Local by design. Broadcasting would mean the whole table hearing somebody else put
 * a rope in their own slate, and these fire often enough that it would be the first
 * thing anybody turned off.
 *
 * Silent unless a GM has chosen a sound. `playSound` already treats `'none'` as
 * nothing, so the guard here is only to avoid the call.
 */
export function playFeedback(key, override = null) {
    let sound = override ?? null;
    if (!sound) {
        try {
            sound = game.settings.get(MODULE.ID, key);
        } catch (_error) {
            // Settings not registered yet, or a key that no longer exists. Neither is
            // worth a console line for something whose entire job is set dressing.
            return;
        }
    }
    if (!sound || sound === 'none' || sound === 'sound-none') return;

    _play(sound, key);
}

/**
 * Hand a sound to Blacksmith, and never let a failed one reach the console as an error.
 *
 * **Both halves of the failure, because they arrive differently.** A synchronous throw is
 * caught here; anything that goes wrong *inside* Foundry's audio pipeline surfaces as a
 * rejected promise, which the `try` never sees. One was reported and it is Foundry's own,
 * not ours: `AudioBufferCache.getBuffer` throwing `Cannot set properties of undefined
 * (setting 'previous')` while shifting its cache. Nothing here can prevent it.
 *
 * What we can decide is what it costs. This is set dressing -- a door creaking as a window
 * opens -- and it must never be the thing that puts a red stack trace in a GM's console or
 * stops the window it was decorating from rendering. A warning names the sound and the
 * rest of the module carries on.
 */
function _play(sound, key) {
    const utils = game.modules.get('coffee-pub-blacksmith')?.api?.utils;
    if (typeof utils?.playSound !== 'function') return;
    try {
        const played = utils.playSound(sound, 0.7, false, false);
        if (typeof played?.catch === 'function') {
            played.catch((error) => console.warn(`${MODULE.TITLE} | Could not play ${key}:`, error));
        }
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not play ${key}:`, error);
    }
}

/**
 * Play a sound by path, without going through a setting.
 *
 * For auditioning one in the settings window: what a GM wants to hear is the sound in the
 * **dropdown in front of them**, not the one currently saved, so this takes the path the
 * caller is looking at rather than a key it would have to write first.
 */
export function playSoundPath(path) {
    if (!path || path === 'none' || path === 'sound-none') return;
    // Through the same guard, so an audition cannot throw where a door creak would not.
    _play(path, path);
}

/** The setting keys, so call sites name a sound rather than a string. */
export const SOUND = Object.freeze({
    WINDOW_OPEN: 'soundWindowOpen',
    WINDOW_CLOSE: 'soundWindowClose',
    SLATE_ADD: 'soundSlateAdd',
    SLATE_UPDATE: 'soundSlateUpdate',
    SLATE_CLEAR: 'soundSlateClear',
    TRANSACTION: 'soundTransaction',
    RESTOCK: 'soundRestock',
    ERROR: 'soundError'
});

export const notify = {
    /** Something happened and you may want to know. */
    info: (title, options) => show('info', title, { channel: CHANNEL.SHOP, ...options }),

    /** It worked. */
    success: (title, options) => show('success', title, { channel: CHANNEL.SHOP, ...options }),

    /** You asked for something that cannot happen yet, and could make it happen. */
    warn: (title, options) => show('warn', title, options),

    /**
     * It went wrong. Unchannelled: an excluded account cannot act on one.
     *
     * The error sound is played from here rather than from each call site, because
     * there are twenty-odd of them and one that forgot would be a failure that made
     * no sound for no reason anybody could see.
     */
    error: (title, options) => {
        playFeedback(SOUND.ERROR);
        return show('error', title, options);
    },

    /**
     * A completed transaction, which is the one message worth interrupting for.
     *
     * **Persistent, dismissed by a click.** Money changing hands is the single moment
     * in this module a player will want to check twice — what they paid, what they
     * got, whether the total was what they expected — and a receipt that clears itself
     * after eight seconds is a receipt they read half of. Clicking the body dismisses
     * it, as does the close button.
     *
     * Persistent toasts sit outside the stack cap and are never evicted, so this must
     * stay a *rare* shape. It is used here and nowhere else.
     *
     * If this proves too insistent in play, the one-line change is a `duration` of ten
     * or so: the toast stays clickable and simply stops waiting to be acknowledged.
     */
    receipt: (title, subtitle) => show('success', title, {
        subtitle,
        duration: 0,
        // Carried on the toast rather than played separately, so the sound and the
        // thing it announces cannot come apart.
        sound: configuredSound(SOUND.TRANSACTION),
        channel: CHANNEL.TRANSACTION,
        // A no-op body handler is what makes the whole toast a dismiss target rather
        // than only its close button. The API removes it for us afterwards.
        onClick: () => {},
        // A second purchase replaces the first rather than stacking two receipts, which
        // is right for a shopper working through a list.
        stackKey: `${MODULE.ID}-receipt`
    })
};
