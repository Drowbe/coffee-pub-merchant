// ==================================================================
// ===== SHOP PINS ==================================================
// ==================================================================
//
// A pin is a second door onto a shop, and the only kind of shop that may have one is a
// **linked** merchant.
//
// That single restriction is what makes the rest of this simple. A pin is durable map
// furniture — it outlives tokens being deleted, scenes being swapped, a session ending —
// so what it points at has to be durable too. An unlinked token is a copy: three
// placements of one pedlar are three shops that know nothing about each other, and a pin
// naming that pedlar would be naming the mould rather than a shop.
//
// **A dedicated shop on a map is durable, and therefore requires a durable Actor.**
//
// So a pin stores the linked Actor's uuid, and opening from the pin reaches the same
// window, and the same cart, as double-clicking the merchant's token — see `subjectFor`
// in the manager for why that is not automatic.
//
// Thin on purpose: Blacksmith owns rendering, dragging, the config window, permissions
// and the layer. What is ours is which Actor a pin names and what happens when it is
// clicked.

import { MODULE, PIN_TYPE, SHOP_KINDS, shopKind, DEFAULT_PIN_DESIGN } from './const.js';

function _api() {
    return game.modules.get('coffee-pub-blacksmith')?.api?.pins ?? null;
}

/**
 * Whether this Blacksmith can carry pins.
 *
 * Feature-detected rather than version-pinned, the way `hasQuery` already is: a shop must
 * keep working on a hub that is a version behind, and a module that hides its own button
 * says less confusingly than one that throws when it is pressed.
 */
export function hasPins() {
    return typeof _api()?.isAvailable === 'function' && _api().isAvailable();
}

/** One setting, or its shipped answer if the world has not registered yet. */
function setting(key) {
    try {
        const stored = game.settings.get(MODULE.ID, key);
        return stored === undefined || stored === null || stored === '' ? DEFAULT_PIN_DESIGN[key] : stored;
    } catch (_error) {
        return DEFAULT_PIN_DESIGN[key];
    }
}

/**
 * The design a new shop pin is created with.
 *
 * **Two layers, and they do not fight.** The world's settings are what a shop pin looks
 * like here; Blacksmith's `getDefaultPinDesign` is a *per-user* design a GM saved from its
 * own Configure Pin window, and it wins where it exists, because somebody took the trouble.
 * Everybody else gets the world's answer.
 *
 * **The icon is ours whatever either says.** It is the shop's *kind* -- an apothecary and a
 * weaponsmith are told apart on the map without anybody configuring anything -- and letting
 * a saved design carry it would make every shop in the world the same shop.
 *
 * Neither layer reaches a pin already on a map. A pin keeps the look it was made with,
 * because it is a thing on a map and not a view of a setting.
 */
export function pinDesign(icon) {
    const width = Math.trunc(Number(setting('pinSize'))) || DEFAULT_PIN_DESIGN.pinSize;
    const design = {
        image: icon,
        shape: setting('pinShape'),
        size: { w: width, h: width },
        style: {
            fill: setting('pinFill'),
            stroke: setting('pinStroke'),
            iconColor: setting('pinIconColor')
        },
        textLayout: DEFAULT_PIN_DESIGN.textLayout,
        textDisplay: setting('pinTextDisplay')
    };

    const pins = _api();
    if (typeof pins?.getDefaultPinDesign !== 'function') return design;
    try {
        const saved = pins.getDefaultPinDesign(MODULE.ID, PIN_TYPE);
        return saved ? { ...design, ...saved, image: icon } : design;
    } catch (_error) {
        return design;
    }
}

/** Where a pin keeps the merchant it names. */
export const PIN_ACTOR = 'merchantActorUuid';

/**
 * Tell Blacksmith what our pins are called, once.
 *
 * Without this its context menus and Manage Pins window would show a raw type key. The
 * taxonomy is what populates the tag suggestions and the layer filters; the tags are the
 * shop kinds, because "show me the taverns" is the filter a GM actually wants.
 */
export function registerPinVocabulary() {
    const pins = _api();
    if (!hasPins()) return;
    try {
        pins.registerPinType(MODULE.ID, PIN_TYPE, game.i18n.localize('coffee-pub-merchant.pin.typeName'));
        pins.registerPinTaxonomy(MODULE.ID, {
            pinCategories: {
                [PIN_TYPE]: {
                    label: game.i18n.localize('coffee-pub-merchant.pin.typeName'),
                    tags: ['shop', ...shopKindTags()]
                }
            }
        });
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not register the pin vocabulary:`, error);
    }
}

/**
 * Shop kinds as tag tokens: `general-store`, `weaponsmith`, and so on.
 *
 * Derived from `SHOP_KINDS` rather than listed again here, so a kind added to `const.js`
 * becomes a filterable tag without anybody remembering to come back for it.
 */
function shopKindTags() {
    return [...new Set(SHOP_KINDS.map((kind) => kindTag(kind.label)))];
}

/** A kind's label as a tag: lowercase kebab-case, which is the form Blacksmith stores. */
function kindTag(label) {
    return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The merchant a pin names, or null. */
export function pinActorUuid(pin) {
    const uuid = pin?.config?.[PIN_ACTOR];
    return typeof uuid === 'string' && uuid ? uuid : null;
}

/**
 * Whether an Actor may be pinned at all.
 *
 * The check is `prototypeToken.actorLink`, which is the same test `worldMerchants` uses to
 * decide what is a shop in its own right — one rule, asked in two places, rather than two
 * rules that agree until they do not.
 */
export function canPin(actor) {
    return Boolean(actor?.prototypeToken?.actorLink);
}

/** The pins on a scene that name this merchant. */
export function pinsForActor(actorUuid, sceneId = null) {
    if (!hasPins() || !actorUuid) return [];
    try {
        return _api()
            .list({ moduleId: MODULE.ID, type: PIN_TYPE, ...(sceneId ? { sceneId } : {}) })
            .filter((pin) => pinActorUuid(pin) === actorUuid);
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not list the shop pins:`, error);
        return [];
    }
}

/**
 * Put a pin for this shop on a scene.
 *
 * **`sceneId` goes in the options argument, not in the pin data.** Blacksmith's own
 * documentation carries the correction: in `pinData` the pin counts as placed but resolves
 * its scene to `undefined`, which falls back to the *active* scene — so it lands somewhere
 * other than the scene named, with no error at all.
 *
 * Dropped at the middle of the view rather than the middle of the map, because the GM is
 * looking at where they want it and dragging it a little is easier than finding it.
 *
 * The shop's config is passed in rather than read here. This file knows what a pin is; the
 * manager knows what a shop is, and a utility reaching back into it is the shape of a cycle
 * -- as well as the thing that makes this module untestable outside Foundry.
 */
export async function createShopPin(actor, { config = null, scene = null, x = null, y = null } = {}) {
    if (!game.user.isGM || !hasPins() || !actor) return null;
    const pins = _api();
    const target = scene ?? canvas?.scene ?? null;
    if (!target) return null;

    const identity = shopPinIdentity(actor, config);
    const place = pinPlacement(x, y);

    try {
        return await pins.create({
            id: foundry.utils.randomID(16),
            moduleId: MODULE.ID,
            type: PIN_TYPE,
            tags: ['shop', identity.tag],
            text: identity.name,
            x: place.x,
            y: place.y,
            ...pinDesign(identity.icon),
            config: { [PIN_ACTOR]: actor.uuid }
        }, { sceneId: target.id });
    } catch (error) {
        console.error(`${MODULE.TITLE} | Could not pin ${actor.name}:`, error);
        return null;
    }
}

/**
 * The shop's own name, kind icon and kind tag, for the pin that names it.
 *
 * The name is a **copy taken at the moment of pinning**, not a live read. A pin is a label
 * on a map, and the label outliving the shop is the point -- it is what a pin whose Actor
 * has gone still has to show. Renaming the shop later does not chase the pin, which is
 * also true of every other label a GM writes on a map.
 */
function shopPinIdentity(actor, config) {
    const kind = shopKind(config?.kind);
    return {
        name: config?.name || actor?.name || game.i18n.localize('coffee-pub-merchant.pin.typeName'),
        icon: kind.icon,
        tag: kindTag(kind.label)
    };
}

/** Where the pin lands: what was asked for, or the middle of what the GM is looking at. */
function pinPlacement(x, y) {
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    const rect = canvas?.stage?.getBounds?.();
    const centre = canvas?.stage && rect
        ? canvas.stage.toLocal({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        : null;
    if (centre && Number.isFinite(centre.x)) return { x: Math.round(centre.x), y: Math.round(centre.y) };
    const dims = canvas?.dimensions ?? {};
    return { x: Math.round((dims.width ?? 2000) / 2), y: Math.round((dims.height ?? 2000) / 2) };
}
