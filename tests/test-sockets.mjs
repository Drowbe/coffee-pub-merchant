// The transport, both ways round.
//
// Merchant's cross-client traffic — slates, presence, refreshes — moved from a raw
// `game.socket` channel onto `blacksmith.sockets`. Two things had to stay true through
// that, and neither is visible without two clients, which is exactly why they are
// pinned here instead:
//
// - **Event names are module-prefixed.** Blacksmith keys external handlers in a flat Map
//   shared by every consumer, so an unprefixed `slate` silently overwrites somebody
//   else's `slate` — no error, no warning, and the other module simply stops hearing.
// - **The fallback keeps the old wire shape**, so a Blacksmith too old to publish
//   `sockets` behaves exactly as before rather than nearly as before.

import assert from 'node:assert';

const MODULE = 'coffee-pub-merchant';

function withBlacksmith() {
    const emitted = [];
    const registered = new Map();
    globalThis.game = {
        modules: {
            get: (id) => (id === 'coffee-pub-blacksmith'
                ? { api: { sockets: {
                    emit: async (event, data) => { emitted.push([event, data]); return true; },
                    register: async (event, handler) => { registered.set(event, handler); return true; }
                } } }
                : null)
        },
        socket: { emit: () => { throw new Error('fell back to game.socket with the API present'); }, on: () => {} }
    };
    return { emitted, registered };
}

function withoutBlacksmith() {
    const sent = [];
    let listener = null;
    let binds = 0;
    globalThis.game = {
        modules: { get: () => ({ api: {} }) },
        socket: { emit: (channel, data) => sent.push([channel, data]), on: (channel, handler) => { binds += 1; listener = handler; } }
    };
    return { sent, hear: (data) => listener?.(data), binds: () => binds };
}

// Fresh module per scenario: the fallback keeps a bound flag and a handler map, and a
// second import would reuse the first scenario's globals.
const load = () => import(`../scripts/utility-sockets.js?${Math.random()}`);

// ---------------------------------------------------------------- with the hub
{
    const hub = withBlacksmith();
    const S = await load();

    assert.ok(S.hasSockets(), 'the API is detected when it is there');

    for (const event of Object.values(S.SOCKET_EVENT)) {
        assert.ok(event.startsWith(`${MODULE}.`),
            `every event name must be module-prefixed — "${event}" would collide in a shared handler map`);
        S.on(event, () => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual([...hub.registered.keys()].sort(), Object.values(S.SOCKET_EVENT).sort(),
        'every event registers under its own name');

    await S.emit(S.SOCKET_EVENT.REFRESH, { tokenUuid: 'T' });
    assert.deepStrictEqual(hub.emitted, [[`${MODULE}.refresh`, { tokenUuid: 'T' }]],
        'the payload goes out as given, with no `action` field bolted on');
    console.log('ok  events are module-prefixed and go through the hub');
}

// ---------------------------------------------------------------- without it
{
    const raw = withoutBlacksmith();
    const S = await load();

    assert.ok(!S.hasSockets(), 'a Blacksmith with no sockets API is detected as such');

    const seen = [];
    S.on(S.SOCKET_EVENT.SLATE, (data) => seen.push(['slate', data.tokenUuid]));
    S.on(S.SOCKET_EVENT.PRESENCE, (data) => seen.push(['presence', data.state]));
    S.on(S.SOCKET_EVENT.REFRESH, (data) => seen.push(['refresh', data.tokenUuid]));

    // `game.socket.on` stacks listeners rather than replacing them, so binding per event
    // would mean four listeners each seeing every message and four handler calls per one.
    assert.strictEqual(raw.binds(), 1, 'the fallback binds one listener however many events register');

    await S.emit(S.SOCKET_EVENT.REFRESH, { tokenUuid: 'T' });
    assert.deepStrictEqual(raw.sent, [[`module.${MODULE}`, { action: 'shopRefresh', tokenUuid: 'T' }]],
        'the fallback emits the exact shape the raw channel used, so nothing needs re-testing to trust it');

    raw.hear({ action: 'shopRefresh', tokenUuid: 'T2' });
    raw.hear({ action: 'shopPresence', state: 'open' });
    raw.hear({ action: 'nonsense' });
    raw.hear(null);
    assert.deepStrictEqual(seen, [['refresh', 'T2'], ['presence', 'open']],
        'routes on `action`, ignores what it does not know, and survives a malformed message');
    console.log('ok  the fallback keeps the old wire shape and one listener');
}

console.log('\nall socket checks passed');
