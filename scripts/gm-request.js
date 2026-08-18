// ==================================================================
// ===== GM REQUEST — routes a mutation to the authoritative GM ======
// ==================================================================
//
// A player cannot write to a merchant's Actor or to another character, so every
// mutation runs on one GM.
//
// **This is transport. It routes and elects; it does not authorize.** Whatever a
// request is allowed to do belongs in the handler, which must re-resolve and
// revalidate everything it is given. Nothing in a payload is trusted here.
//
// Built on Foundry v13's own query API rather than a hand-rolled socket envelope:
// `CONFIG.queries[name]` plus `user.query(name, data, {timeout})` is promise-based
// request/response to a designated user, so request ids, the pending map, the
// timeout and response routing are all core's. `game.users.activeGM` is core's own
// single-GM designation — using it means every module agrees on which GM acts,
// rather than each re-deriving it with its own sort.
//
// Blacksmith intends to own this surface. When it lands, this file should be a
// deletion rather than a rewrite: the local-GM shortcut and the {ok, code} result
// shape below are the parts they have said they will keep.

import { MODULE } from './const.js';

const QUERY = `${MODULE.ID}.request`;
const TIMEOUT_MS = 20000;

let _handler = null;

/**
 * @param {(op: string, payload: object, userId: string) => Promise<object>} handler
 *   Runs on the GM only. Must re-resolve and revalidate everything it is given.
 */
export function registerHandler(handler) {
    _handler = handler;

    CONFIG.queries[QUERY] = async ({ op, payload }, { userId }) => {
        try {
            return await _handler(op, payload, userId);
        } catch (error) {
            console.error(`${MODULE.TITLE} | Request "${op}" failed:`, error);
            return { ok: false, code: 'HANDLER_ERROR' };
        }
    };
}

/** Route an operation to the authoritative GM and wait for its answer. */
export async function request(op, payload) {
    // A GM already has permission, so there is nobody to ask. This shortcut must
    // survive any future migration — without it a solo GM would round-trip to
    // themselves, and a GM with no other GM present would fail outright.
    if (game.user.isGM) {
        if (!_handler) return { ok: false, code: 'NO_HANDLER' };
        return _handler(op, payload, game.user.id);
    }

    const gm = game.users.activeGM;
    if (!gm) return { ok: false, code: 'NO_ACTIVE_GM' };

    try {
        return await gm.query(QUERY, { op, payload }, { timeout: TIMEOUT_MS });
    } catch (error) {
        // A timeout, a disconnect mid-flight, or a missing QUERY_USER permission all
        // land here. None is worth a stack trace at the call site.
        console.warn(`${MODULE.TITLE} | Request "${op}" did not complete:`, error);
        return { ok: false, code: 'TIMEOUT' };
    }
}
