// ==================================================================
// ===== SOCKETS ====================================================
// ==================================================================
//
// What Merchant says to other clients, and how it says it.
//
// **Through `blacksmith.sockets`, which wraps SocketLib with a native fallback.** This
// was the last place Merchant talked to core directly on a surface Blacksmith owns —
// `gmRequest` closed the other one. SocketLib gives targeting and delivery guarantees a
// raw `game.socket` channel does not, and a world that has it should not be running one
// module's traffic outside it.
//
// **The semantics did not change, which is the part that mattered.** Their `emit()` with
// no options maps to `executeForOthers`, so it does **not** echo to the sender — the same
// rule `game.socket.emit` follows, and the one every handler here assumes. A swap that
// quietly started delivering our own slate back to us would have shown a player their own
// list arriving as somebody else's.
//
// **Four names, not one channel with an `action` field.** The old shape was a single
// channel demultiplexed on `data.action`; Blacksmith keys handlers by event name, so the
// switch is theirs now. Names are module-prefixed because `_externalEventHandlers` is a
// flat Map across every consumer — an unprefixed `slate` would silently overwrite
// somebody else's, with no error and no way to tell.
//
// **The fallback is for a Blacksmith too old to publish `sockets`.** It keeps the exact
// wire shape the raw channel used, so nothing has to be re-tested to know it still works.
// It goes when the minimum Blacksmith version passes the one that added the API.

import { MODULE } from './const.js';

/** Event names, module-prefixed. See the note above about the flat handler map. */
export const SOCKET_EVENT = Object.freeze({
    SLATE: `${MODULE.ID}.slate`,
    PRESENCE: `${MODULE.ID}.presence`,
    SLATE_REQUEST: `${MODULE.ID}.slateRequest`,
    REFRESH: `${MODULE.ID}.refresh`,
    DELIVERED: `${MODULE.ID}.delivered`,
    // Collection, which is a conversation rather than an announcement: the player asks,
    // the GM answers yes or no, and the answer comes back as one of the other two.
    COLLECT: `${MODULE.ID}.collect`,
    WAITING: `${MODULE.ID}.waiting`,
    NOT_THERE: `${MODULE.ID}.notThere`
});

/** The legacy channel, and the `action` values it carried. Fallback only. */
const CHANNEL = `module.${MODULE.ID}`;
const LEGACY_ACTION = Object.freeze({
    [SOCKET_EVENT.SLATE]: 'slate',
    [SOCKET_EVENT.PRESENCE]: 'shopPresence',
    [SOCKET_EVENT.SLATE_REQUEST]: 'slateRequest',
    [SOCKET_EVENT.REFRESH]: 'shopRefresh',
    [SOCKET_EVENT.DELIVERED]: 'parcelDelivered',
    [SOCKET_EVENT.COLLECT]: 'parcelCollect',
    [SOCKET_EVENT.WAITING]: 'parcelWaiting',
    [SOCKET_EVENT.NOT_THERE]: 'parcelNotThere'
});

function _sockets() {
    return game.modules.get('coffee-pub-blacksmith')?.api?.sockets ?? null;
}

/** Whether the hub's socket layer is available. False means the fallback is in use. */
export function hasSockets() {
    const api = _sockets();
    return typeof api?.emit === 'function' && typeof api?.register === 'function';
}

/**
 * Tell the other clients something.
 *
 * **Never the sender.** Every caller here is announcing a change it has already applied
 * locally, so an echo would be a second application or a redundant redraw.
 *
 * Fire and forget: `emit` resolves once the socket is ready, and nothing here has an
 * answer worth waiting for. A failure is logged rather than surfaced — a missed refresh
 * is a stale window that the next one fixes, not a lost transaction.
 */
export function emit(event, data) {
    const api = _sockets();
    if (hasSockets()) {
        return api.emit(event, data).catch((error) => {
            console.warn(`${MODULE.TITLE} | Could not emit ${event}:`, error);
        });
    }
    game.socket.emit(CHANNEL, { action: LEGACY_ACTION[event], ...data });
    return Promise.resolve();
}

/**
 * Listen for one event.
 *
 * `register` waits for the socket internally, so this needs no `waitForReady` of its own
 * and `initialize()` stays synchronous. Messages arriving before registration completes
 * are lost, which is the same window the raw channel had and is a stale window rather
 * than a lost write — the slate is display-only and settling re-derives every line.
 *
 * @param {string} event One of `SOCKET_EVENT`.
 * @param {(data: object, userId: string) => void} handler
 */
export function on(event, handler) {
    const api = _sockets();
    if (hasSockets()) {
        api.register(event, handler).catch((error) => {
            console.error(`${MODULE.TITLE} | Could not register ${event}:`, error);
        });
        return;
    }
    _legacyHandlers.set(LEGACY_ACTION[event], handler);
    _bindLegacy();
}

// --- fallback demultiplexer ------------------------------------------------
// One `game.socket.on` for the module, routing on `action` exactly as before. Bound
// once: `game.socket.on` stacks listeners rather than replacing them, so registering
// four events would otherwise mean four listeners each seeing every message.
const _legacyHandlers = new Map();
let _legacyBound = false;

function _bindLegacy() {
    if (_legacyBound) return;
    _legacyBound = true;
    game.socket.on(CHANNEL, (data) => {
        const handler = _legacyHandlers.get(data?.action);
        if (handler) handler(data, data?.userId);
    });
}
