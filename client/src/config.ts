// Client-only tuning constants and environment-derived configuration.
//
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

/** Same fallback as pageHostname, extended with the dev-default port. */
const pageHost =
  typeof location === 'undefined' ? `${pageHostname}:${DEFAULT_SERVER_PORT}` : location.host;

/**
 * Default Colyseus endpoint (issue #20: "one process = playable URL").
 *
 * `import.meta.env.DEV` is true only for Vite's own dev server, false in any
 * built bundle (verified against Vite docs and a built bundle's output).
 *
 *   - DEV: page and game server are separate processes/ports, so the default
 *     must name the server's port explicitly, derived from the page's
 *     hostname so a LAN visitor dials the same machine.
 *   - Built bundle: issue #20 has the game server serve `client/dist`
 *     same-origin, so `ws://<location.host>` is always correct with zero
 *     config. `VITE_SERVER_URL`/`PUBLIC_WS_URL` still overrides this for the
 *     two-container Docker Compose path.
 *
 * Verified against @colyseus/sdk 0.17.43: `ws://` is an accepted endpoint form.
 */
/**
 * The game server's port, when not the conventional one.
 *
 * SEPARATE FROM `VITE_SERVER_URL` (owner bug report 2026-09-06: LAN client
 * couldn't reach server) — a port-only override used to require hard-wiring
 * the host to `localhost`, which on a LAN visitor's machine is themselves.
 * A port override now overrides only the port; the hostname stays derived
 * from the page.
 */
const serverPort: string =
  import.meta.env.VITE_SERVER_PORT ?? String(DEFAULT_SERVER_PORT);

export const DEFAULT_SERVER_URL = import.meta.env.DEV
  ? `ws://${pageHostname}:${serverPort}`
  : `ws://${pageHost}`;

/** Core has no lobby — one process is one world (design doc) — so this must match the server's `gameServer.define(...)` name. */
export const DEFAULT_ROOM_NAME = 'world';

/** `VITE_SERVER_URL` overrides the endpoint; `VITE_ROOM_NAME` the room. */
export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? DEFAULT_SERVER_URL;
export const ROOM_NAME = import.meta.env.VITE_ROOM_NAME ?? DEFAULT_ROOM_NAME;

/**
 * Re-exported from @terrace/shared, which owns it so plugins can reach the
 * same number.
 *
 * Fixed at 1 until 2026-08-21 (a cell was a world unit); now a quarter of
 * that (WORLD_UNIT_CELLS = 4) — cell↔world conversions are a real multiply,
 * picking divides before flooring. World size is unchanged; only sample
 * density moved.
 */
export { CELL_WORLD_SIZE };

/**
 * How tall the world's above-sea range stands, in world units — the relief
 * fact deciding how mountainous the world looks.
 *
 * 16, unchanged through the 2026-08-20 re-terrace and 2026-08-21 re-sample
 * (those changed step/sample density, not height). Lives in @terrace/shared
 * so client and server plugins agree without each carrying its own copy of
 * the literal.
 */
export { MAX_RELIEF_WORLD_UNITS };

/** Height units → world units. Derived; never write this ratio by hand. */
export const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

/**
 * Depth (terrace bands) an unmodified genesis ocean floor reaches; past this
 * a depth is a dig or trench.
 *
 * MEASURED: live world frostwick-hollows, 2026-08-26, 235,663 water cells,
 * depth in bands: p25 10, p50 11, p75 12, p95 15, p99 21, max 62. This is
 * the p95. 83% of water sits in bands 10-14.
 *
 * One constant shared by every depth-to-appearance curve (bandColors.ts,
 * waterDepth.ts) so they can't drift: three curves independently spent their
 * range across the full 64-band column and made the ordinary sea look flat
 * (owner, 2026-08-26: "no difference between the shallows and the depths").
 * Not shared/: describes what the world tends to be, not what it must be.
 */
export const ORDINARY_SEA_DEPTH_BANDS = 15;

/** The same depth as a signed height. */
export const ORDINARY_SEA_FLOOR_HEIGHT = -ORDINARY_SEA_DEPTH_BANDS * BAND_HEIGHT;

/**
 * Where the ordinary ocean floor begins (bands) — the p25 of the same
 * measurement above (2026-08-27).
 *
 * The p95 alone only says where the ocean ends; a curve pinned to it still
 * spends two-thirds of its range on the shallow quarter and squeezes the
 * ordinary floor into the rest (measured: adjacent bands 10-14 differed by
 * 1-2/255 on screen). With both ends named, a curve can spend its range
 * where the water actually is — histogram equalisation, as waterDepth.ts's
 * shade ramp already does.
 */
export const ORDINARY_SEA_SHELF_BANDS = 10;

/** The same depth as a signed height. */
export const ORDINARY_SEA_SHELF_HEIGHT = -ORDINARY_SEA_SHELF_BANDS * BAND_HEIGHT;

/**
 * Bands the sea's depth cues (shade/alpha ramps, seabed palette) span evenly
 * in luminance before going flat. Owner, 2026-08-28: spread luminance evenly
 * across the first 48 bands — three quarters of the 64-band column, so a
 * sculpted trench keeps darkening well past the natural floor. Shared here so
 * water and seabed can't be tuned to different spans.
 */
export const SEA_DEPTH_CUE_SPAN_BANDS = 48;

/** The same depth as a signed height. */
export const SEA_DEPTH_CUE_FLOOR_HEIGHT = -SEA_DEPTH_CUE_SPAN_BANDS * BAND_HEIGHT;

/**
 * World units a single terrace band rises.
 *
 * Historically forced to equal CELL_WORLD_SIZE by the old 45°-riser grid;
 * free of that since the 2026-08-14 cliff renderer's true vertical walls.
 * Derived from MAX_RELIEF_WORLD_UNITS: a quarter of a world unit at
 * BAND_HEIGHT 16. Equal to one cell again since the 2026-08-21 re-sample —
 * coincidence of two independent quarterings, not a returned constraint.
 */
export const BAND_WORLD_HEIGHT = BAND_HEIGHT * HEIGHT_WORLD_SCALE;

/**
 * Height units per world unit, for anything sized in world space but
 * computed in height units (e.g. the frontier fog's bank profile) — stating
 * such a size as a multiple of BAND_HEIGHT instead silently rescales on
 * re-terrace.
 *
 * Per world unit, not per cell (2026-08-21): was CELL_HEIGHT_UNITS while a
 * cell was a world unit; re-sampling would have shrunk every caller to a
 * quarter otherwise.
 */
export const WORLD_UNIT_HEIGHT_UNITS = 1 / HEIGHT_WORLD_SCALE;

/**
 * How far above SEA_LEVEL the water surface draws, in world units.
 *
 * Cannot be zero: band 0 (heights 0..BAND_HEIGHT-1) quantises to vertex
 * height 0, the same plane the sea would sit on — a freshly generated world
 * and every shoreline flat, so a coplanar sea would z-fight there.
 *
 * 1/32 world unit: far above depth-buffer resolution at these camera
 * distances (stable ordering), small enough that a band-0 flat still reads
 * as at the waterline. Measured against the world unit, not the band
 * (2026-08-20, restated 2026-08-21): written as a band fraction it would
 * have shrunk to a quarter at the re-terrace.
 */
export const WATER_SURFACE_LIFT = 1 / 32;

/**
 * World Y of the drawn sea surface — the plane render/water.ts writes into
 * its vertex buffer, and the only Y anything "floating on the sea" may use.
 *
 * Not `SEA_LEVEL * HEIGHT_WORLD_SCALE` (=0): lifted by WATER_SURFACE_LIFT.
 * plugins/structures' skiff has 0.0113 world units of freeboard, so floating
 * it at 0 would sit 0.031 under the drawn sea. Owned here with its two
 * inputs so water.ts and anything floating can't drift apart.
 */
export const SEA_SURFACE_WORLD_Y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;

/**
 * Floor of the hold-repeat ramp — shortest interval between repeated sculpt
 * intents (see SCULPT_REPEAT_DELAY_MS, SCULPT_REPEAT_RAMP_FACTOR;
 * input/sculptInput.ts owns the schedule).
 *
 * 120 ms: just above the server's 100 ms tick (TICK_HZ 10), so a held brush
 * can never queue more than one intent per tick — keeping
 * terrain/prediction.ts's in-flight cap a true upper bound.
 *
 * Provisional: ~8 bands/second at full ramp. Re-tune in Phase 2.
 */
export const SCULPT_REPEAT_INTERVAL_MS = 120;

/**
 * Fastest display refresh this client sizes against, hertz — turns a
 * duration into a frame count, and so a count of coalesced pointer events
 * (see DRAG_INTENTS_PER_TICK).
 *
 * A ceiling, not a floor (2026-08-30): frames/tick is what the bound
 * measures, so a faster display emits MORE intents, not fewer. The prior
 * 60 Hz floor let a 144 Hz drag put ~17 intents against a budget of 8,
 * evicting the live stroke's own prediction (camera snap-back mid-drag).
 * 144 Hz is this project's fastest benchmarked panel; a faster display can
 * still reach the cap and evict — pre-existing behaviour, not a new failure.
 */
export const DISPLAY_HZ_CEILING = 144;

/**
 * Most intents one drag can put in flight per repeat tick — sizes
 * MAX_PENDING_PREDICTIONS (terrain/prediction.ts).
 *
 * Supersedes a per-emission cell budget (2026-08-24): a drag now sends one
 * absolute region per cursor cell-change instead of one per cell crossed.
 * Derived: a cursor changes cell at most once per (refresh-coalesced)
 * pointermove, so the ceiling is frames-per-tick at DISPLAY_HZ_CEILING.
 */
export const DRAG_INTENTS_PER_TICK = Math.ceil(
  (SCULPT_REPEAT_INTERVAL_MS * DISPLAY_HZ_CEILING) / 1000,
);

/**
 * Milliseconds from a stroke's first intent to its second — top of the
 * hold-repeat ramp.
 *
 * Owner, 2026-08-19: a single click was raising land too fast; wanted
 * start-slow-then-ramp. A deliberate click is 80-150 ms press-to-release,
 * rarely over 300 ms; 400 ms means every such click ends before a second
 * intent is due, so one click is one band by construction — also under the
 * ~500 ms typical OS keyboard typematic delay.
 */
export const SCULPT_REPEAT_DELAY_MS = 400;

/**
 * Multiplier applied to the repeat interval after each repeat, down to the
 * floor SCULPT_REPEAT_INTERVAL_MS.
 *
 * 0.75 ramps 400→300→225→169→127→120 ms over ~1.2 s. Rejected: a linear
 * step-down needs a step size AND a floor kept consistent; a step-count ramp
 * makes duration depend on the floor. One multiplier and a geometric shape
 * puts the big changes early, while the player is still deciding.
 */
export const SCULPT_REPEAT_RAMP_FACTOR = 0.75;

/**
 * Milliseconds a one-finger touch stroke waits before its first sculpt
 * intent, so the two fingers of an intended camera gesture (tens of ms
 * apart) don't poke the terrain once per pinch/pan. Mouse strokes fire
 * immediately.
 */
export const TOUCH_STROKE_GRACE_MS = 100;

// ---------------------------------------------------------------------------
// Wheel gestures (input/wheelCamera.ts)
// ---------------------------------------------------------------------------

/**
 * Zoom factor per unit of pinch delta: distance scales by
 * PINCH_ZOOM_BASE^deltaY. 1.01 ≈ 3x zoom across a full ~110-unit pinch,
 * matching the OS's own apps.
 */
export const PINCH_ZOOM_BASE = 1.01;

/** Screen-heights of camera-distance-scaled travel per pixel of trackpad scroll. A full-height swipe moves 1.5 "screens". */
export const TRACKPAD_PAN_SPEED = 1.5 / 1000;

/**
 * Two-finger separations below this (CSS px) are treated as one merged
 * contact, not a pinch pair (input/cameraBindings.ts touch-dolly guard). iOS
 * coalesces adjacent touches and momentarily reports near-zero separation;
 * OrbitControls divides by it, so without a floor one frame can dolly by
 * hundreds of times (reproduced 2026-08-19: a two-finger tap slammed orbit
 * distance to its clamp). 24 px is under half a fingertip.
 */
export const TOUCH_DOLLY_MIN_SEPARATION_PX = 24;

/**
 * Largest growth/shrink of two-finger separation OrbitControls may see in one
 * pointermove. Real fingers change a few percent per event; a stalled main
 * thread can batch tens of percent. 1.5x sits above both, well below the
 * 30-200x coalescing artifacts from the 2026-08-19 reproduction. A swallowed
 * step isn't lost motion — the guard's baseline holds for the next event.
 */
export const TOUCH_DOLLY_MAX_STEP_RATIO = 1.5;

/**
 * Wheel-delta pixels one edge-to-edge trackpad swipe reports — an
 * approximation (OS acceleration curves vary by platform/setting). 500 is a
 * slow deliberate full swipe on a MacBook trackpad; unverified on Windows
 * precision trackpads (smaller deltas there just orbit slower).
 */
const TRACKPAD_FULL_SWIPE_DELTA_PIXELS = 500;

/** Radians of orbit azimuth per pixel of Alt+scroll deltaX — half a turn per full swipe. */
export const TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL =
  Math.PI / TRACKPAD_FULL_SWIPE_DELTA_PIXELS;

/**
 * Radians of orbit polar angle per pixel of Alt+scroll deltaY. Equal to the
 * azimuth rate to match OrbitControls' own isotropic drag-orbit, so a
 * diagonal swipe rotates along the diagonal instead of skewing.
 */
export const TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL =
  TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL;

/** World-rotation per degree of Safari trackpad-rotation gesture. 1 = fingers-to-world 1:1, matching every OS-level rotate gesture. */
export const SAFARI_GESTURE_ROTATE_SENSITIVITY = 1;

/** Camera framing. Every distance below is in world units — see CELL_WORLD_SIZE. */
export const CAMERA_FOV_DEGREES = 55;
export const CAMERA_NEAR = 0.1;
/** Must clear the diagonal of the largest supported world: 512 world units/side (DEFAULT_WORLD_SPAN). */
export const CAMERA_FAR = 4000;
/** Initial orbit distance; the max lets a full 512-unit world fit on screen. */
export const CAMERA_INITIAL_DISTANCE = 80;

/**
 * How much of the world the closest zoom frames, as frame height in world
 * units. At the closest zoom a player inspects a handful of features, not a
 * region. Owner-tuned, 2026-08-21 (tried 4 first, settled on 10).
 *
 * In world units, not cells: tuned when a cell was a world unit, so the
 * distinction was invisible until the re-sample. Read as 10 cells it would
 * frame four times closer than intended.
 */
export const CAMERA_CLOSEST_VIEW_WORLD_UNITS = 10;

/**
 * Closest orbit distance, world units. Derived from the framing above and
 * the lens: a perspective camera of vertical field CAMERA_FOV_DEGREES sees
 * `2 * d * tan(fov / 2)` of world height at distance d; solved for d.
 *
 * Was 20 (loosened 2026-08-21, owner: "zoom in further"); that value assumed
 * clearance over a max-height mountain, but orbit distance is measured to
 * the ground target, so even the old value only cleared ~1.7 units above
 * target at the steepest orbit angle — the guarantee was never really there.
 *
 * Residual: with no terrain-aware camera clamp, orbiting shallow next to
 * tall terrain can put the near plane inside a hillside. Needs a
 * ground-clearance clamp; doesn't exist yet.
 */
export const CAMERA_MIN_DISTANCE =
  CAMERA_CLOSEST_VIEW_WORLD_UNITS /
  (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
export const CAMERA_MAX_DISTANCE = 900;
/**
 * How far above the rendered terrain the camera is held, world units
 * (render/cameraClearance.ts applies it every frame) — the constant that
 * actually bounds ground closeness, unlike CAMERA_MIN_DISTANCE which is
 * measured to the orbit target.
 *
 * Two lower bounds to clear: CAMERA_NEAR (0.1, below it terrain crosses the
 * near plane), and BAND_WORLD_HEIGHT (a sculpt stroke raises ground a band
 * at a time; less headroom and a raise could swallow the camera). One world
 * unit (one tread, four bands) clears both with room to spare.
 *
 * In world units, not cells (2026-08-21 correction): as one cell it would be
 * a quarter unit — exactly one band — letting a single raise consume all
 * clearance in one frame.
 */
export const CAMERA_GROUND_CLEARANCE_WORLD_UNITS = 1;

/** Clamp the orbit above the horizon so the camera never goes under the sea. */
export const CAMERA_MAX_POLAR_ANGLE_DEGREES = 85;

/**
 * Frame-rate sampling window length, ms (render/frameRate.ts averages over
 * it; ui/VersionWatermark.tsx prints the result).
 *
 * 500 ms balances two failure modes: shorter windows flicker (100 ms: one
 * dropped frame moves the reading 10 fps), longer ones average away the
 * chunk-splice spikes (terrainMeshes.ts's CHUNK_SPLICE_FRAME_BUDGET_MS) the
 * meter exists to expose.
 */
export const FPS_SAMPLE_INTERVAL_MS = 500;

/**
 * Frame-statistics window length, ms (render/frameStats.ts summarises over
 * it; ui/VersionWatermark.tsx prints the result).
 *
 * 10x FPS_SAMPLE_INTERVAL_MS deliberately: these are percentiles, and a p99
 * needs more than the ~30 samples a 500 ms window gives at 60 fps. Five
 * seconds gives 300-1750 samples, enough to resolve the decay measured in
 * ms per ten minutes (docs/plans/frame-rate-decay-2026-09-05.md §7d).
 */
export const FRAME_STATS_WINDOW_MS = 5000;

/**
 * Most frames one window keeps readings for. 2048 covers a full 5 s window
 * up to 409 fps — past this a window keeps its most recent 2048 and still
 * reports the true frame count, so overflow is visible, not silent. Three
 * Float32Arrays of this length is 32 KB, allocated once.
 */
export const FRAME_STATS_CAPACITY = 2048;
