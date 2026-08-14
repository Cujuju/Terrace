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
 * Default Colyseus endpoint. Derived from the page's own hostname rather than
 * hard-coded `localhost`, so a browser that loaded the client over the LAN
 * (http://192.168.x.x:5173) dials the game server on the machine that served
 * it — a literal `localhost` there would make every LAN visitor dial
 * THEMSELVES. On the dev machine nothing changes: the page host is localhost.
 *
 * Verified against @colyseus/sdk 0.17.43 `Client.ts`: the string form of the
 * constructor argument is parsed with `new URL(...)` and treats
 * `wss:`/`https:` as secure, so a `ws://` URL is an accepted endpoint form.
 */
export const DEFAULT_SERVER_URL = `ws://${pageHostname}:${DEFAULT_SERVER_PORT}`;

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
 * World units a single terrace band rises. Set equal to CELL_WORLD_SIZE so a
 * one-band riser spans exactly one cell horizontally and one cell vertically —
 * a 45° face. That is the steepest riser a vertex-per-cell grid can produce
 * (a vertical wall would need duplicated vertices; see terrain/vertexGrid.ts),
 * and it is what makes the quantised steps read as terraces rather than as a
 * gentle slope. PROVISIONAL: feel-tune alongside BAND_HEIGHT in Phase 2.
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
