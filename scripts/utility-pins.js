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

import { MODULE, PIN_TYPE, SHOP_KINDS, shopKind, DEFAULT_PIN_DESIGN, normalizeTint } from './const.js';

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
 * **The picture is ours whatever either says.** Which picture a pin wears is its own
 * setting -- the kind's icon, the shopkeeper's portrait, or the place itself, see
 * `pinImageFor` -- and letting a saved design carry it would make every shop in the world
 * wear the same face.
 *
 * Neither layer reaches a pin already on a map. A pin keeps the look it was made with,
 * because it is a thing on a map and not a view of a setting.
 */
export async function pinDesign(image) {
    const width = Math.trunc(Number(setting('pinSize'))) || DEFAULT_PIN_DESIGN.pinSize;
    const shape = setting('pinShape');
    const design = {
        image,
        shape,
        size: { w: width, h: await pinHeightFor(shape, image, width) },
        style: {
            fill: setting('pinFill'),
            stroke: setting('pinStroke'),
            strokeWidth: Math.trunc(Number(setting('pinStrokeWidth'))),
            iconColor: setting('pinIconColor')
        },
        dropShadow: Boolean(setting('pinDropShadow')),
        textLayout: setting('pinTextLayout'),
        textDisplay: setting('pinTextDisplay'),
        textColor: setting('pinTextColor'),
        textSize: Math.trunc(Number(setting('pinTextSize'))),
        textMaxLength: Math.trunc(Number(setting('pinTextMaxLength'))),
        textMaxWidth: Math.trunc(Number(setting('pinTextMaxWidth'))),
        textScaleWithPin: Boolean(setting('pinTextScale'))
    };

    const pins = _api();
    if (typeof pins?.getDefaultPinDesign !== 'function') return design;
    try {
        const saved = pins.getDefaultPinDesign(MODULE.ID, PIN_TYPE);
        return saved ? { ...design, ...saved, image } : design;
    } catch (_error) {
        return design;
    }
}

/**
 * How tall a pin is, by the same rule the Configure Pin window uses.
 *
 * **Copied deliberately, so the two agree.** A pin made by the button and a pin edited in
 * their window have to come out the same shape; two rules for one number is how a setting
 * ends up looking like it did not take. Theirs, verbatim:
 *
 *     let h = w;
 *     if ((shape === 'none' || shape === 'rectangle') && the picture is an image) {
 *         h = Math.max(8, Math.round(w * naturalHeight / naturalWidth));
 *     }
 *
 * So a circle and a square are square -- which Blacksmith forces anyway -- and the two
 * free-aspect shapes take the picture's own proportions. A Font Awesome icon has no
 * natural size, so it stays square whatever shape it is wearing.
 *
 * Loading the picture to measure it is what makes this async, and it is why nothing here
 * guesses: an unreachable image falls back to square rather than to a shape nobody chose.
 */
async function pinHeightFor(shape, image, width) {
    const freeAspect = shape === 'rectangle' || shape === 'none';
    const path = String(image ?? '');
    const isIcon = !path || path.startsWith('fa-') || path.startsWith('<i');
    if (!freeAspect || isIcon) return width;

    return new Promise((resolve) => {
        const probe = new Image();
        probe.addEventListener('load', () => {
            const { naturalWidth: w, naturalHeight: h } = probe;
            resolve(w > 0 && h > 0 ? Math.max(8, Math.round(width * h / w)) : width);
        });
        probe.addEventListener('error', () => resolve(width));
        probe.src = path;
    });
}

/**
 * The pin colours, for anything that wants to look like a shop pin.
 *
 * The abandoned shop uses these where the portrait goes: the shop is gone, so what is left
 * to show is the mark on the map that outlived it. Normalised, because these end up in an
 * inline `style` attribute and a setting is something a GM types into.
 */
export function pinPalette() {
    return {
        fill: normalizeTint(setting('pinFill')) ?? DEFAULT_PIN_DESIGN.pinFill,
        stroke: normalizeTint(setting('pinStroke')) ?? DEFAULT_PIN_DESIGN.pinStroke,
        icon: normalizeTint(setting('pinIconColor')) ?? DEFAULT_PIN_DESIGN.pinIconColor
    };
}

/** Where a pin keeps the merchant it names. */
export const PIN_ACTOR = 'merchantActorUuid';

/**
 * Where a pin keeps what the shop looked like.
 *
 * **A pin outlives the shop, so it has to remember it.** When the Actor is deleted the
 * config goes with it, and the window has nothing left to draw: the first version showed a
 * grey card with a name on it. This is the rest of the card -- what it was called, what
 * sort of shop it was, what the GM wrote about it, and how it was dressed.
 *
 * A **snapshot**, taken when the pin is made, not a live read. It could not be a live read
 * for the case it exists for; and for the case where the shop is still there it does not
 * need to be, because the shop answers for itself. A pin is a label on a map, and a label
 * says what was true when somebody wrote it.
 */
export const PIN_SHOP = 'shop';

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

/** What the shop looked like when the pin was made, or null. */
export function pinShopSnapshot(pin) {
    const shop = pin?.config?.[PIN_SHOP];
    return shop && typeof shop === 'object' ? shop : null;
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
            ...(await pinDesign(identity.image)),
            config: {
                [PIN_ACTOR]: actor.uuid,
                [PIN_SHOP]: {
                    name: identity.name,
                    kind: config?.kind ?? null,
                    description: config?.description ?? '',
                    tint: config?.tint ?? null,
                    illustration: config?.illustration ?? null,
                    portrait: actor.img ?? null
                }
            }
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
        image: pinImageFor({
            illustration: config?.illustration ?? null,
            portrait: actor?.img ?? null,
            icon: kind.icon
        }),
        tag: kindTag(kind.label)
    };
}

/**
 * Which picture a pin wears: the place, the person, or the trade.
 *
 * Each is a different claim about what a shop is on a map. The **kind's icon** says what
 * this shop sells, so an apothecary and a weaponsmith are told apart at a glance and every
 * shop of a kind looks alike. A **portrait** says who keeps it, which is what a party
 * actually remembers. An **illustration** says what the place looks like, which is the most
 * evocative and the worst behaved -- it is a wide scene, and a circular pin crops it to
 * whatever happens to be in the middle.
 *
 * The orders are **fallbacks, not preferences**: a shop with no illustration under
 * *Illustration first* gets the next thing that exists rather than a blank pin, and the
 * icon is last in every one because it is the only source that always exists.
 */
function pinImageFor({ illustration, portrait, icon }) {
    const available = { illustration: illustration || null, portrait: portrait || null };
    const order = {
        icon: [],
        illustration: ['illustration'],
        portrait: ['portrait'],
        'illustration-portrait': ['illustration', 'portrait'],
        'portrait-illustration': ['portrait', 'illustration']
    }[setting('pinImage')] ?? [];

    for (const source of order) {
        if (available[source]) return available[source];
    }
    return icon;
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

/**
 * Ask the GM where the pin goes, and show them what they are placing.
 *
 * **Blacksmith has no picker, and its drop path would not carry this pin.** Its
 * `dropCanvasData` handler reads `text`, `image`, `size`, `style`, `config` and
 * `ownership` — not the tags, the text layout, the drop shadow or anything else the
 * design settings answer — so a pin created by dropping would silently be a plainer pin
 * than one created by the button. Placing it ourselves and calling `create` keeps one
 * pin-building path, which is the only way the two can agree.
 *
 * **Screen to scene through `worldTransform`**, rather than a PIXI event listener. The
 * board is a DOM element whatever PIXI does with its own event modes, and inverting the
 * stage transform is the conversion Foundry itself uses — it survives panning, zooming and
 * a canvas that is not the whole window.
 *
 * Resolves to a point, or to null if the GM changed their mind. Right-click and Escape both
 * cancel, because both are what people already press to mean it.
 */
export function pickPinLocation({ label, image } = {}) {
    const board = document.getElementById('board');
    if (!board || !canvas?.stage) return Promise.resolve(null);

    return new Promise((resolve) => {
        const ghost = document.createElement('div');
        ghost.className = 'merchant-pin-ghost';
        ghost.innerHTML = `${image?.startsWith('fa-') || image?.startsWith('<i')
            ? `<i class="${image.replace(/^<i class="|"><\/i>$/g, '')}"></i>`
            : `<img src="${image}" alt="">`}<span></span>`;
        ghost.querySelector('span').textContent = label ?? '';
        document.body.append(ghost);
        document.body.classList.add('merchant-placing-pin');

        const move = (event) => {
            ghost.style.left = `${event.clientX}px`;
            ghost.style.top = `${event.clientY}px`;
        };
        const finish = (point) => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerdown', down, true);
            document.removeEventListener('keydown', key, true);
            document.removeEventListener('contextmenu', swallow, true);
            document.body.classList.remove('merchant-placing-pin');
            ghost.remove();
            resolve(point);
        };
        const down = (event) => {
            // Captured, so the click places a pin rather than also selecting whatever is
            // under it. Anything but the left button is a change of mind.
            event.preventDefault();
            event.stopPropagation();
            if (event.button !== 0) return finish(null);
            const point = canvas.stage.worldTransform.applyInverse({ x: event.clientX, y: event.clientY });
            finish({ x: Math.round(point.x), y: Math.round(point.y) });
        };
        const key = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            finish(null);
        };
        // The right-click that cancels must not also open the canvas menu.
        const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerdown', down, true);
        document.addEventListener('keydown', key, true);
        document.addEventListener('contextmenu', swallow, true);
    });
}
