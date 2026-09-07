// Terrain maths constants (CHUNK_SIZE, BAND_HEIGHT, SEA_LEVEL, brush radius
// bounds…) live in @terrace/shared and are never re-declared here.

import {
  BAND_HEIGHT,
  CELL_WORLD_SIZE,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  SEA_LEVEL,
} from '@terrace/shared';

/** Colyseus convention; the server's `PORT` default. */
export const DEFAULT_SERVER_PORT = 2567;

/** Fallback for non-browser contexts: Vitest runs this module in plain node. */
const pageHostname =
  typeof location === 'undefined' ? 'localhost' : location.hostname;

const pageHost =
  typeof location === 'undefined' ? `${pageHostname}:${DEFAULT_SERVER_PORT}` : location.host;

/**
 * Separate from `VITE_SERVER_URL` (owner, 2026-09-06: LAN client couldn't reach
 * server): a port-only override used to hard-wire the host to `localhost` —
 * a LAN visitor's own machine. It now overrides only the port.
 */
const serverPort: string =
  import.meta.env.VITE_SERVER_PORT ?? String(DEFAULT_SERVER_PORT);

/**
 * Issue #20, "one process = playable URL". `import.meta.env.DEV` is true only
 * for Vite's own dev server, where page and game server are separate ports.
 *
 * A built bundle is served same-origin by the game server, so `location.host`
 * needs no config; `VITE_SERVER_URL` still overrides for the two-container
 * Compose path. `ws://` verified against @colyseus/sdk 0.17.43.
 */
export const DEFAULT_SERVER_URL = import.meta.env.DEV
  ? `ws://${pageHostname}:${serverPort}`
  : `ws://${pageHost}`;

/** Core has no lobby — one process is one world — so this must match the server's `gameServer.define(...)` name. */
export const DEFAULT_ROOM_NAME = 'world';

export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? DEFAULT_SERVER_URL;
export const ROOM_NAME = import.meta.env.VITE_ROOM_NAME ?? DEFAULT_ROOM_NAME;

/**
 * Fixed at 1 until 2026-08-21 (a cell was a world unit); now a quarter of that
 * (WORLD_UNIT_CELLS = 4). World size is unchanged; only sample density moved.
 */
export { CELL_WORLD_SIZE };

/**
 * The relief fact deciding how mountainous the world looks.
 *
 * 16, unchanged through the 2026-08-20 re-terrace and 2026-08-21 re-sample —
 * those changed step and sample density, not height. Owned by @terrace/shared
 * so client and server plugins agree.
 */
export { MAX_RELIEF_WORLD_UNITS };

/** Height units → world units. Derived; never write this ratio by hand. */
export const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

/**
 * Past this depth a band is a dig or a trench, not genesis ocean floor.
 *
 * Measured 2026-08-26, world frostwick-hollows, 235,663 water cells: depth in
 * bands p25 10, p50 11, p75 12, p95 15, p99 21, max 62. This is the p95, and
 * 83% of water sits in bands 10-14.
 *
 * One constant for every depth-to-appearance curve (bandColors.ts,
 * waterDepth.ts): three curves independently spread their range across the full
 * 64-band column and made the sea look flat (owner, 2026-08-26).
 *
 * Not shared/: describes what the world tends to be, not what it must be.
 */
export const ORDINARY_SEA_DEPTH_BANDS = 15;

export const ORDINARY_SEA_FLOOR_HEIGHT = -ORDINARY_SEA_DEPTH_BANDS * BAND_HEIGHT;

/**
 * Where the ordinary ocean floor begins — the p25 of the same measurement
 * (2026-08-27).
 *
 * The p95 alone says only where the ocean ends; a curve pinned to it spends
 * two-thirds of its range on the shallow quarter (measured: adjacent bands
 * 10-14 differed by 1-2/255 on screen).
 *
 * With both ends named a curve can equalise across where the water actually is,
 * as waterDepth.ts's shade ramp does.
 */
export const ORDINARY_SEA_SHELF_BANDS = 10;

export const ORDINARY_SEA_SHELF_HEIGHT = -ORDINARY_SEA_SHELF_BANDS * BAND_HEIGHT;

/**
 * Bands the sea's depth cues span evenly in luminance before going flat.
 *
 * Owner, 2026-08-28: spread evenly across the first 48 bands — three quarters
 * of the column, so a sculpted trench keeps darkening past the natural floor.
 * Shared so water and seabed can't be tuned apart.
 */
export const SEA_DEPTH_CUE_SPAN_BANDS = 48;

export const SEA_DEPTH_CUE_FLOOR_HEIGHT = -SEA_DEPTH_CUE_SPAN_BANDS * BAND_HEIGHT;

/**
 * Historically forced to equal CELL_WORLD_SIZE by the old 45°-riser grid; free
 * of that since the 2026-08-14 cliff renderer's true vertical walls.
 *
 * Equal to one cell again since the 2026-08-21 re-sample — a coincidence of two
 * independent quarterings, not a returned constraint.
 */
export const BAND_WORLD_HEIGHT = BAND_HEIGHT * HEIGHT_WORLD_SCALE;

/**
 * For anything sized in world space but computed in height units (the frontier
 * fog's bank profile) — stating such a size as a multiple of BAND_HEIGHT
 * silently rescales on re-terrace.
 *
 * Per world unit, not per cell (2026-08-21): was CELL_HEIGHT_UNITS while a cell
 * was a world unit; re-sampling would have quartered every caller.
 */
export const WORLD_UNIT_HEIGHT_UNITS = 1 / HEIGHT_WORLD_SCALE;

/**
 * Cannot be zero: band 0 quantises to vertex height 0, the plane the sea would
 * sit on — a fresh world is all shoreline flats, so a coplanar sea z-fights.
 *
 * 1/32 is far above depth-buffer resolution at these camera distances, small
 * enough that a band-0 flat still reads as at the waterline.
 *
 * In world units, not bands (2026-08-20, restated 2026-08-21): a band fraction
 * would have shrunk to a quarter at the re-terrace.
 */
export const WATER_SURFACE_LIFT = 1 / 32;

/**
 * The plane render/water.ts writes into its vertex buffer, and the only Y
 * anything "floating on the sea" may use.
 *
 * Not `SEA_LEVEL * HEIGHT_WORLD_SCALE` (=0): lifted by WATER_SURFACE_LIFT.
 * structures' skiff has 0.0113 world units of freeboard, so floating it at 0
 * would sit 0.031 under the drawn sea.
 */
export const SEA_SURFACE_WORLD_Y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;

/**
 * Floor of the hold-repeat ramp; input/sculptInput.ts owns the schedule.
 *
 * 120 ms sits just above the server's 100 ms tick (TICK_HZ 10), so a held brush
 * can never queue more than one intent per tick — keeping prediction.ts's
 * in-flight cap a true upper bound.
 *
 * Provisional: ~8 bands/second at full ramp. Re-tune in Phase 2.
 */
export const SCULPT_REPEAT_INTERVAL_MS = 120;

/**
 * Turns a duration into a frame count, and so a count of coalesced pointer
 * events (see DRAG_INTENTS_PER_TICK).
 *
 * A ceiling, not a floor (2026-08-30): frames/tick is what the bound measures,
 * so a faster display emits MORE intents. The prior 60 Hz floor let a 144 Hz
 * drag put ~17 intents against a budget of 8, evicting the stroke's own
 * prediction.
 *
 * 144 Hz is this project's fastest benchmarked panel; a faster display can still
 * reach the cap and evict — pre-existing, not a new failure.
 */
export const DISPLAY_HZ_CEILING = 144;

/**
 * Sizes MAX_PENDING_PREDICTIONS (terrain/prediction.ts).
 *
 * Supersedes a per-emission cell budget (2026-08-24): a drag now sends one
 * absolute region per cursor cell-change, not one per cell crossed. A cursor
 * changes cell at most once per coalesced pointermove, so the ceiling is
 * frames-per-tick at DISPLAY_HZ_CEILING.
 */
export const DRAG_INTENTS_PER_TICK = Math.ceil(
  (SCULPT_REPEAT_INTERVAL_MS * DISPLAY_HZ_CEILING) / 1000,
);

/**
 * A stroke's first intent to its second — the top of the hold-repeat ramp.
 *
 * Owner, 2026-08-19: a single click raised land too fast; wanted
 * start-slow-then-ramp. A deliberate click is 80-150 ms, rarely over 300; at
 * 400 ms one click is one band by construction, and under the ~500 ms typical
 * OS typematic delay.
 */
export const SCULPT_REPEAT_DELAY_MS = 400;

/**
 * Applied after each repeat, down to the floor SCULPT_REPEAT_INTERVAL_MS.
 *
 * 0.75 ramps 400→300→225→169→127→120 ms over ~1.2 s. Rejected: a linear
 * step-down needs a step size AND a floor kept consistent; a step-count ramp
 * makes duration depend on the floor.
 *
 * A geometric shape puts the big changes early, while the player is deciding.
 */
export const SCULPT_REPEAT_RAMP_FACTOR = 0.75;

/**
 * So the two fingers of an intended camera gesture (tens of ms apart) don't poke
 * the terrain once per pinch/pan. Mouse strokes fire immediately.
 */
export const TOUCH_STROKE_GRACE_MS = 100;

/**
 * Distance scales by PINCH_ZOOM_BASE^deltaY. 1.01 ≈ 3x zoom across a full
 * ~110-unit pinch, matching the OS's own apps.
 */
export const PINCH_ZOOM_BASE = 1.01;

/** Camera-distance-scaled travel per pixel of trackpad scroll: a full-height swipe moves 1.5 "screens". */
export const TRACKPAD_PAN_SPEED = 1.5 / 1000;

/**
 * Below this (CSS px) two fingers are one merged contact, not a pinch pair
 * (input/cameraBindings.ts touch-dolly guard).
 *
 * iOS coalesces adjacent touches and momentarily reports near-zero separation;
 * OrbitControls divides by it, so without a floor one frame can dolly hundreds
 * of times (reproduced 2026-08-19: a two-finger tap slammed orbit to its clamp).
 *
 * 24 px is under half a fingertip.
 */
export const TOUCH_DOLLY_MIN_SEPARATION_PX = 24;

/**
 * Largest growth/shrink of two-finger separation OrbitControls may see in one
 * pointermove. Real fingers change a few percent per event; a stalled main
 * thread can batch tens of percent.
 *
 * 1.5x sits above both, well below the 30-200x coalescing artifacts of the
 * 2026-08-19 reproduction. A swallowed step isn't lost motion — the guard's
 * baseline holds for the next event.
 */
export const TOUCH_DOLLY_MAX_STEP_RATIO = 1.5;

/**
 * An approximation — OS acceleration curves vary by platform and setting.
 *
 * 500 is a slow deliberate full swipe on a MacBook trackpad; unverified on
 * Windows precision trackpads, where smaller deltas just orbit slower.
 */
const TRACKPAD_FULL_SWIPE_DELTA_PIXELS = 500;

/** Half a turn per full swipe. */
export const TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL =
  Math.PI / TRACKPAD_FULL_SWIPE_DELTA_PIXELS;

/**
 * Equal to the azimuth rate to match OrbitControls' own isotropic drag-orbit, so
 * a diagonal swipe rotates along the diagonal instead of skewing.
 */
export const TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL =
  TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL;

/** 1 = fingers-to-world 1:1, matching every OS-level rotate gesture. */
export const SAFARI_GESTURE_ROTATE_SENSITIVITY = 1;

/** Every camera distance below is in world units — see CELL_WORLD_SIZE. */
export const CAMERA_FOV_DEGREES = 55;
export const CAMERA_NEAR = 0.1;
/** Must clear the diagonal of the largest supported world: 512 world units/side (DEFAULT_WORLD_SPAN). */
export const CAMERA_FAR = 4000;
export const CAMERA_INITIAL_DISTANCE = 80;

/**
 * Frame height at the closest zoom: a player inspects a handful of features, not
 * a region. Owner-tuned 2026-08-21 (tried 4 first, settled on 10).
 *
 * In world units, not cells: tuned when a cell was a world unit, so read as 10
 * cells it would frame four times closer than intended.
 */
export const CAMERA_CLOSEST_VIEW_WORLD_UNITS = 10;

/**
 * Derived from the framing above and the lens: a perspective camera of vertical
 * field CAMERA_FOV_DEGREES sees `2 * d * tan(fov / 2)` of world height at
 * distance d; solved for d.
 *
 * Was 20 (loosened 2026-08-21, owner: "zoom in further"); that value assumed
 * clearance over a max-height mountain, but orbit distance is measured to the
 * ground target, so it only ever cleared ~1.7 units at the steepest angle.
 *
 * Residual: with no terrain-aware camera clamp, orbiting shallow next to tall
 * terrain can put the near plane inside a hillside. Needs a ground-clearance
 * clamp; doesn't exist yet.
 */
export const CAMERA_MIN_DISTANCE =
  CAMERA_CLOSEST_VIEW_WORLD_UNITS /
  (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
/** Lets a full 512-unit world fit on screen. */
export const CAMERA_MAX_DISTANCE = 900;
/**
 * How far above the rendered terrain the camera is held
 * (render/cameraClearance.ts applies it every frame) — the constant that
 * actually bounds ground closeness, unlike CAMERA_MIN_DISTANCE.
 *
 * Two lower bounds to clear: CAMERA_NEAR (0.1, below it terrain crosses the near
 * plane), and BAND_WORLD_HEIGHT (a sculpt raise could otherwise swallow the
 * camera). One world unit clears both with room to spare.
 *
 * In world units, not cells (2026-08-21 correction): as one cell it would be a
 * quarter unit — one band — letting a single raise consume all clearance.
 */
export const CAMERA_GROUND_CLEARANCE_WORLD_UNITS = 1;

/** Clamp the orbit above the horizon so the camera never goes under the sea. */
export const CAMERA_MAX_POLAR_ANGLE_DEGREES = 85;

/**
 * render/frameRate.ts averages over it; ui/VersionWatermark.tsx prints it.
 *
 * 500 ms balances two failure modes: shorter windows flicker (at 100 ms one
 * dropped frame moves the reading 10 fps), longer ones average away the
 * chunk-splice spikes the meter exists to expose.
 */
export const FPS_SAMPLE_INTERVAL_MS = 500;

/**
 * render/frameStats.ts summarises over it.
 *
 * 10x FPS_SAMPLE_INTERVAL_MS deliberately: these are percentiles, and a p99
 * needs more than the ~30 samples a 500 ms window gives at 60 fps. Five seconds
 * gives 300-1750 samples — enough to resolve the decay in
 * docs/plans/frame-rate-decay-2026-09-05.md §7d.
 */
export const FRAME_STATS_WINDOW_MS = 5000;

/**
 * 2048 covers a full 5 s window up to 409 fps. Past this a window keeps its most
 * recent 2048 and still reports the true frame count, so overflow is visible.
 *
 * Three Float32Arrays of this length is 32 KB, allocated once.
 */
export const FRAME_STATS_CAPACITY = 2048;
