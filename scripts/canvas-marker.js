// ==================================================================
// ===== MERCHANT MARKERS ON THE CANVAS =============================
// ==================================================================
//
// **A merchant token should be visibly a merchant, and visibly what kind.**
//
// Until this, the only way to learn a token was a shop was to double-click it, which is
// a poor way to learn that most tokens are not. A player crossing a market square can
// now tell the weaponsmith from the apothecary from the guard who is only standing
// there, without touching anything.
//
// **The category already carries an icon** (`SHOP_KINDS`), and a map pin already wears
// it. This is the third place the same glyph appears and it is deliberately the same
// glyph: the mark on a token, the pin on the map and the badge on the card are one
// vocabulary, so a party learns it once.
//
// ===== WHERE IT IS DRAWN ==========================================
//
// **A child of the Token placeable**, which is most of the work done for free. It moves
// with the token, scales with the scene, and disappears when the token does -- a
// GM-hidden token is `visible = false`, and PIXI does not render the children of an
// invisible container. A separate canvas layer would mean reimplementing visibility,
// elevation and hidden-token rules that already exist and are easy to get subtly wrong.
//
// `eventMode = 'none'` because the marker must not eat the gesture that opens the shop.
// A badge that swallowed double-clicks would break the thing it advertises.

import { MODULE, shopKind, TOKEN_MARKER_SETTINGS } from './const.js';
import { MerchantManager } from './manager-merchant.js';
import { pinPalette } from './utility-pins.js';

/**
 * Which marker belongs to which token.
 *
 * **A map rather than a search by name.** PIXI renamed `DisplayObject.name` to `label` at
 * v8, so a lookup that walks the children comparing names is a lookup that quietly finds
 * nothing the day Foundry updates its renderer -- and finding nothing here means every
 * redraw leaves the old marker behind and adds another. A `WeakMap` keyed on the placeable
 * asks no questions about the renderer and lets a destroyed token take its entry with it.
 *
 * The name is still set, because a labelled object in a scene graph inspector is worth the
 * one line when something on the canvas is in the wrong place.
 */
const _markers = new WeakMap();
const MARKER_NAME = 'coffee-pub-merchant-marker';

function setting(key) {
    try {
        return game.settings.get(MODULE.ID, key);
    } catch (_error) {
        return TOKEN_MARKER_SETTINGS.find((entry) => entry.key === key)?.default ?? null;
    }
}

// ==================================================================
// ===== THE GLYPH ==================================================
// ==================================================================

const _glyphs = new Map();

/**
 * The character and font behind a Font Awesome class, read from the stylesheet.
 *
 * **Asked rather than tabulated.** The obvious implementation is a table mapping
 * `fa-flask` to ``, seventeen entries of it -- and a table of codepoints is a
 * table somebody has to keep in step with Font Awesome, transcribed by hand, where one
 * wrong digit is a mortar and pestle that renders as a chess rook and nobody can see why
 * from the code. The browser already knows the answer: it is what it uses to draw the
 * same icon everywhere else in the module.
 *
 * A probe element has to be **in the document** for `getComputedStyle` to resolve the
 * `::before`, so it is appended, read and removed within the one synchronous call.
 *
 * Cached only on success. Before the font is loaded the computed content is `none`, and
 * caching that would mean a marker that stayed blank for the session because the first
 * token was drawn a frame too early.
 */
function glyphFor(iconClass) {
    if (_glyphs.has(iconClass)) return _glyphs.get(iconClass);

    let probe = null;
    try {
        probe = document.createElement('i');
        probe.className = iconClass;
        probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden';
        document.body.appendChild(probe);

        const style = getComputedStyle(probe, '::before');
        const raw = style?.content ?? '';
        const char = raw && raw !== 'none' ? raw.replace(/^["']|["']$/g, '') : '';
        if (!char) return null;

        const glyph = {
            char,
            family: style.fontFamily || '"Font Awesome 6 Free"',
            weight: style.fontWeight || '900'
        };
        _glyphs.set(iconClass, glyph);
        return glyph;
    } catch (error) {
        console.warn(`${MODULE.TITLE} | Could not read the icon for ${iconClass}:`, error);
        return null;
    } finally {
        probe?.remove();
    }
}

// ==================================================================
// ===== DRAWING ====================================================
// ==================================================================

function _colour(hex, fallback) {
    try {
        return foundry.utils.Color.from(hex).valueOf();
    } catch (_error) {
        return fallback;
    }
}

/** Whether this client should be seeing markers at all. */
function _shown() {
    const mode = setting('markerShow');
    if (mode === 'off') return false;
    if (mode === 'gm') return game.user.isGM;
    return true;
}

/**
 * Below this zoom the markers come off.
 *
 * **A badge legible on one token is noise on twenty.** Zoomed out to look at a whole
 * market square, a marker per stallholder is a wall of glyphs over the map the GM drew;
 * zoomed in to where a token is a face rather than a dot, it is the useful thing. So it
 * is a threshold rather than a constant, and a GM who disagrees can set it to zero.
 */
function _withinZoom() {
    const floor = Number(setting('markerZoom')) || 0;
    if (floor <= 0) return true;
    return (canvas?.stage?.scale?.x ?? 1) >= floor;
}

function _existing(token) {
    if (!token) return null;
    const marker = _markers.get(token);
    // A token that has been redrawn destroyed its children; the entry outlives the object.
    if (!marker || marker.destroyed) {
        _markers.delete(token);
        return null;
    }
    return marker;
}

/** Take the marker off, whether or not there is one. */
export function clearMarker(token) {
    const marker = _existing(token);
    if (!marker) return;
    _markers.delete(token);
    try {
        token.removeChild(marker);
        marker.destroy({ children: true });
    } catch (_error) {
        // A token mid-teardown has already dropped its children. Nothing to undo.
    }
}

/**
 * Put the marker on a token, or take it off if this one should not carry it.
 *
 * Rebuilt rather than mutated. A marker is a circle and a glyph; the arithmetic to work
 * out which of size, colour, corner and category changed is longer than the drawing, and
 * it is the arithmetic that would be wrong.
 */
export function drawMarker(token) {
    clearMarker(token);

    const actor = token?.document?.actor;
    if (!token || !actor || !_shown()) return;
    if (!MerchantManager.isMerchant(actor)) return;

    const kind = shopKind(MerchantManager.getConfig(actor)?.kind);
    const glyph = glyphFor(kind?.icon ?? 'fa-solid fa-shop');
    if (!glyph) return;

    const palette = pinPalette();
    const size = Math.max(8, Number(setting('markerSize')) || 22);
    const radius = size / 2;

    const marker = new PIXI.Container();
    marker.name = MARKER_NAME;
    // The gesture that opens the shop belongs to the token underneath.
    marker.eventMode = 'none';
    marker.interactiveChildren = false;
    // Above the token's own art and border, for whoever is sorting. Foundry's own children
    // set no zIndex, so this only matters if something else turns sorting on -- and if it
    // does, a marker drawn under the mesh is a marker nobody sees on an opaque token.
    marker.zIndex = 1000;

    const disc = new PIXI.Graphics();
    disc.beginFill(_colour(palette.fill, 0x2f241a), 0.92);
    disc.lineStyle(Math.max(1, Math.round(size / 12)), _colour(palette.stroke, 0xc8a678), 1);
    disc.drawCircle(0, 0, radius);
    disc.endFill();
    marker.addChild(disc);

    const label = new PIXI.Text(glyph.char, {
        fontFamily: glyph.family,
        fontWeight: glyph.weight,
        fontSize: Math.round(size * 0.58),
        fill: _colour(palette.icon, 0xecd7b2),
        align: 'center'
    });
    label.anchor.set(0.5);
    // Drawn at twice the size it is shown at, because a glyph rasterised at 13px and then
    // scaled by the canvas is a smudge at any zoom the marker is worth showing at.
    label.resolution = 2;
    marker.addChild(label);

    // Appended last, which is drawn last, which is on top -- and `zIndex` covers the case
    // where something else has turned sorting on for this container. **Sorting is not
    // turned on here**: flipping `sortableChildren` reorders every one of Foundry's own
    // children by a property none of them sets, to fix a problem appending already solves.
    token.addChild(marker);
    _markers.set(token, marker);
    positionMarker(token);
}

/**
 * Put the marker in its corner of whatever size the token currently is.
 *
 * Separate from drawing because `refreshToken` fires for every nudge, drag and scale, and
 * rebuilding a text object sixty times a second while a token is dragged is how a canvas
 * starts stuttering.
 */
export function positionMarker(token) {
    const marker = _existing(token);
    if (!marker) return;

    const size = Math.max(8, Number(setting('markerSize')) || 22);
    const inset = size / 2;
    const corner = setting('markerCorner') ?? 'topRight';
    const right = corner === 'topRight' || corner === 'bottomRight';
    const bottom = corner === 'bottomLeft' || corner === 'bottomRight';

    marker.x = right ? (token.w - inset) : inset;
    marker.y = bottom ? (token.h - inset) : inset;
    marker.visible = _withinZoom();
}

/** Redraw every marker on the scene. For settings changes, which alter all of them. */
export function refreshMarkers() {
    for (const token of canvas?.tokens?.placeables ?? []) drawMarker(token);
}

/** Redraw only the tokens of one Actor. For a merchant whose category or state changed. */
export function refreshMarkersFor(actorId) {
    for (const token of canvas?.tokens?.placeables ?? []) {
        if (token?.document?.actorId === actorId) drawMarker(token);
    }
}

// ==================================================================
// ===== WIRING =====================================================
// ==================================================================

/**
 * Watch the four things that can change what a marker should look like.
 *
 * `drawToken` is the only one that builds; the rest reposition or rebuild what is there.
 * `canvasPan` fires on every wheel notch, so it does the cheapest possible thing --
 * setting `visible` on a container that already exists.
 */
export function registerMerchantMarkers() {
    MerchantManager.hook('drawToken', 'Mark merchant tokens as they are drawn', (token) => drawMarker(token));
    MerchantManager.hook('refreshToken', 'Keep a merchant marker in its corner', (token) => positionMarker(token));

    // A merchant switching category, or ceasing to be one, is an Actor flag write.
    MerchantManager.hook('updateActor', 'Redraw markers when a merchant changes', (actor, changes) => {
        if (!foundry.utils.hasProperty(changes, `flags.${MODULE.ID}`)) return;
        refreshMarkersFor(actor.id);
    });

    MerchantManager.hook('canvasPan', 'Take the markers off below the zoom threshold', () => {
        for (const token of canvas?.tokens?.placeables ?? []) positionMarker(token);
    });

    MerchantManager.hook('canvasReady', 'Mark the merchants on a scene that has just drawn', () => refreshMarkers());

    // **And the scene that is already drawn.** Merchant starts at `ready`, which is after
    // the first canvas draw, so every token on the scene a world opens on was drawn before
    // this hook existed. Without this the markers appear on the second scene a GM visits,
    // which reads as them not working.
    if (canvas?.ready) refreshMarkers();

    // Every marker setting changes every marker, so there is nothing finer to do here.
    MerchantManager.hook('updateSetting', 'Redraw the markers when their settings change', (change) => {
        const key = change?.key ?? '';
        if (!key.startsWith(`${MODULE.ID}.marker`) && !key.startsWith(`${MODULE.ID}.pin`)) return;
        refreshMarkers();
    });
}
