// Client-only tuning constants and environment-derived configuration.
//
// Nothing here belongs in shared/: these are presentation and input-feel
// numbers that only the client has an opinion about. Terrain maths constants
// (CHUNK_SIZE, BAND_HEIGHT, SEA_LEVEL, brush radius bounds…) live in
// @terrace/shared and are never re-declared here.

import { BAND_HEIGHT } from '@terrace/shared';

/** 2567 is the Colyseus convention and the server's `PORT` default (§8). */
export const DEFAULT_SERVER_PORT = 2567;

/**
 * Hostname the page itself was served from, with a fallback for non-browser
 * contexts (Vitest runs this module in a plain node environment).
 */
const pageHostname =
  typeof location === 'undefined' ? 'localhost' : location.hostname;

/**
 * Host (hostname *and* port, when the page has one) the page itself was
 * served from. Falls back to the dev default port when there is no
 * `location` (Vitest) — see DEFAULT_SERVER_URL below for why that fallback
 * specifically matches the Vite-dev branch rather than being port-less.
 */
const pageHost =
  typeof location === 'undefined' ? `${pageHostname}:${DEFAULT_SERVER_PORT}` : location.host;

/**
 * Default Colyseus endpoint — two different answers depending on how this
 * bundle got to the browser (issue #20: "one process = playable URL").
 *
 * `import.meta.env.DEV` is Vite's own compile-time constant: true only for
 * the `vite`/`pnpm --dir client dev` dev server, false in every BUILT bundle
 * (a `vite build` output, wherever it ends up being served from) — verified
 * against Vite's env docs and by inspecting a built bundle, where `DEV` comes
 * out as the literal `false`. It, not some runtime guess, is the right
 * switch:
 *
 *   - DEV (Vite's own server, port 5173 by default): the page and the game
 *     server are two different processes on two different ports, so the
 *     default must still name the server's own conventional port explicitly
 *     — this is the pre-#20 behaviour, unchanged, derived from the page's
 *     hostname so a LAN visitor to the Vite dev server dials the same
 *     machine's game server rather than themselves.
 *   - NOT DEV (a built bundle): a build only exists to be served BY
 *     something, and issue #20 adds exactly one thing that serves it same-
 *     origin — the game server handing out `client/dist` on its own port.
 *     `ws://<location.host>` (hostname AND port, whatever they are) is then
 *     always correct with zero configuration, on any port the self-hoster
 *     picked via `PORT`. `VITE_SERVER_URL`/`PUBLIC_WS_URL` still overrides
 *     this outright for the two-container Docker Compose path, where the
 *     client is served by nginx on a different port than the game server.
 *
 * Verified against @colyseus/sdk 0.17.43 `Client.ts`: the string form of the
 * constructor argument is parsed with `new URL(...)` and treats
 * `wss:`/`https:` as secure, so a `ws://` URL is an accepted endpoint form.
 */
export const DEFAULT_SERVER_URL = import.meta.env.DEV
  ? `ws://${pageHostname}:${DEFAULT_SERVER_PORT}`
  : `ws://${pageHost}`;

/**
 * Room name passed to `joinOrCreate`. Core has no lobby — one process is one
 * world (design doc §3.2) — so a single fixed name is all that is needed. It
 * must match the server's `gameServer.define(...)` name.
 */
export const DEFAULT_ROOM_NAME = 'world';

/** `VITE_SERVER_URL` overrides the endpoint; `VITE_ROOM_NAME` the room. */
export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? DEFAULT_SERVER_URL;
export const ROOM_NAME = import.meta.env.VITE_ROOM_NAME ?? DEFAULT_ROOM_NAME;

/**
 * World units per cell edge. Fixed at 1 so that world-space X/Z coordinates
 * ARE cell coordinates: pointer picking is then a floor(), with no scale
 * factor to get wrong in either direction. Camera distances below are
 * therefore expressed in cells.
 */
export const CELL_WORLD_SIZE = 1;

/**
 * World units a single terrace band rises. Historically forced to equal
 * CELL_WORLD_SIZE by the old vertex-per-cell grid (whose steepest face was
 * 45°); since the 2026-08-14 cliff renderer, risers are true vertical walls
 * (terrain/vertexGrid.ts emits duplicated per-face vertices), so this is now
 * a free feel constant: how tall one band step LOOKS relative to a cell.
 * Kept at 1 cell per band until feel-tuning says otherwise.
 */
export const BAND_WORLD_HEIGHT = CELL_WORLD_SIZE;

/** Height units → world units. Derived; never write this ratio by hand. */
export const HEIGHT_WORLD_SCALE = BAND_WORLD_HEIGHT / BAND_HEIGHT;

/**
 * How far above SEA_LEVEL the water surface is drawn, in world units.
 *
 * It cannot be zero. Terrace band 0 covers heights 0..BAND_HEIGHT-1 and every
 * one of them quantises to a vertex height of 0 — the same plane the sea would
 * sit on. That is not a rare case: it is a freshly generated world (all cells
 * at 0) and every shoreline flat thereafter, so a coplanar sea would z-fight
 * across the most-looked-at part of the map.
 *
 * A thirty-second of a band is the compromise: far above the depth-buffer
 * resolution at these camera distances, so the ordering is decided and stable,
 * yet a small enough step that a band-0 flat still reads as sitting AT the
 * waterline rather than floating above or sunk below it. Band 1 — one sculpt
 * click — clears the surface by a full world unit, which is what makes
 * "raising land out of water" read as buildable (MVP criterion 4).
 */
export const WATER_SURFACE_LIFT = BAND_WORLD_HEIGHT / 32;

/**
 * Milliseconds between repeated sculpt intents while the pointer is held down.
 *
 * Chosen at 120 ms — deliberately just above the server's 100 ms tick period
 * (TICK_HZ 10, design doc §3.2) — so a held brush can never queue more than
 * one intent per tick. That bounds both the wire rate and the size of the
 * per-tick diff the server has to broadcast, which is exactly the budget the
 * design doc's server performance target asks for.
 *
 * PROVISIONAL / feel-tuning: at one BAND_HEIGHT per intent this raises roughly
 * eight terrace bands per second held. Re-tune in Phase 2 against real input.
 */
export const SCULPT_REPEAT_INTERVAL_MS = 120;

/**
 * Milliseconds a one-finger touch stroke waits before its first sculpt
 * intent. The two fingers of an intended camera gesture never land in the
 * same instant — tens of milliseconds apart is typical — and without this
 * grace the first finger's immediate intent pokes the terrain once per
 * pinch/pan. 100 ms comfortably covers the inter-finger gap while staying
 * below what a deliberate tap reads as lag. Mouse strokes are unaffected:
 * a mouse cannot grow a second finger, so they still fire immediately.
 */
export const TOUCH_STROKE_GRACE_MS = 100;

// ---------------------------------------------------------------------------
// Wheel gestures (input/wheelCamera.ts)
// ---------------------------------------------------------------------------

/**
 * Zoom factor per unit of pinch delta: distance scales by
 * PINCH_ZOOM_BASE^deltaY. 1.01 ≈ a 3× zoom across a full ~110-unit pinch
 * stroke — matches what the same gesture does in the OS's own apps.
 */
export const PINCH_ZOOM_BASE = 1.01;

/**
 * Screen-heights of camera-distance-scaled travel per pixel of trackpad
 * scroll. 1.5/1000: a full-height two-finger swipe moves the view by 1.5
 * "screens" — brisk enough to cross a world, calm enough to aim.
 */
export const TRACKPAD_PAN_SPEED = 1.5 / 1000;

/**
 * Two-finger separations below this, in CSS pixels, are treated as one merged
 * contact rather than a pinch pair (input/cameraBindings.ts touch-dolly
 * guard). iOS coalesces two adjacent touches into one and re-splits them,
 * momentarily reporting near-zero separation; OrbitControls divides by that
 * separation, so without a floor a single such frame dollies the camera by
 * hundreds of times in one event (reproduced 2026-08-19: a two-finger tap
 * slammed the orbit distance to its 900 clamp — the owner's "camera resets to
 * a default location"). 24 px is under half a fingertip: no intentional pinch
 * operates below it, and every merge artifact does.
 */
export const TOUCH_DOLLY_MIN_SEPARATION_PX = 24;

/**
 * Largest growth (or shrink, as its reciprocal) of the two-finger separation
 * OrbitControls may be shown in ONE pointermove event. Real fingers at ≥60 Hz
 * event delivery change separation by a few percent per event; a stalled
 * main thread batching moves can reach tens of percent. 1.5× sits far above
 * both and far below the coalescing artifacts this guards against (30–200×
 * in the 2026-08-19 reproduction). A swallowed step is not lost motion: the
 * guard's baseline holds, and the fingers' true separation passes on the
 * next in-bounds event.
 */
export const TOUCH_DOLLY_MAX_STEP_RATIO = 1.5;

/**
 * Wheel-delta pixels one edge-to-edge two-finger swipe across the trackpad
 * reports. The reference for the orbit rates below, and an APPROXIMATION: the
 * OS scales finger travel to wheel deltas with an acceleration curve that
 * differs per platform and per pointer-speed setting, so no exact figure
 * exists. 500 is the order of magnitude a slow, deliberate full-trackpad swipe
 * produces on a MacBook trackpad (unverified on Windows precision trackpads,
 * which report smaller deltas — orbiting there is correspondingly slower, not
 * broken). Named so the two rates below stay in step when it is re-tuned.
 */
const TRACKPAD_FULL_SWIPE_DELTA_PIXELS = 500;

/**
 * Radians of orbit azimuth per pixel of Alt+scroll deltaX. Half a turn per
 * full-trackpad swipe: enough to bring the far side of the map into view in
 * one gesture, while still leaving a heading reachable without a feather-touch.
 */
export const TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL =
  Math.PI / TRACKPAD_FULL_SWIPE_DELTA_PIXELS;

/**
 * Radians of orbit polar angle per pixel of Alt+scroll deltaY. Deliberately
 * EQUAL to the azimuth rate: OrbitControls' own drag-orbit uses one rate for
 * both axes (2π per element height), and matching that isotropy is what makes
 * a diagonal swipe rotate along the diagonal instead of skewing. The usable
 * polar range is only CAMERA_MAX_POLAR_ANGLE_DEGREES wide, so a swipe reaches
 * the clamp long before its end — that is the clamp doing its job, not a rate
 * that needs softening.
 */
export const TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL =
  TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL;

/**
 * World-rotation per degree of Safari trackpad-rotation gesture, in degrees.
 * 1 is fingers-to-world 1:1 — twisting the fingers 30° twists the map 30°,
 * which is the only rate that can be described without qualification and the
 * one every OS-level rotate gesture (Photos, Preview) uses. Change it only if
 * real use says the wrist runs out of travel before the map is where it
 * should be.
 */
export const SAFARI_GESTURE_ROTATE_SENSITIVITY = 1;

/** Camera framing, in cells. */
export const CAMERA_FOV_DEGREES = 55;
export const CAMERA_NEAR = 0.1;
/** Far plane must clear the diagonal of the largest supported world (512²). */
export const CAMERA_FAR = 4000;
/**
 * Initial orbit distance and the zoom bounds, in cells. The minimum keeps the
 * camera above a maximum-height mountain (16 bands ≈ 16 world units); the
 * maximum lets a 512² world fit on screen.
 */
export const CAMERA_INITIAL_DISTANCE = 80;
export const CAMERA_MIN_DISTANCE = 20;
export const CAMERA_MAX_DISTANCE = 900;
/** Clamp the orbit above the horizon so the camera never goes under the sea. */
export const CAMERA_MAX_POLAR_ANGLE_DEGREES = 85;
