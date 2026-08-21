// Client-only tuning constants and environment-derived configuration.
//
// Nothing here belongs in shared/: these are presentation and input-feel
// numbers that only the client has an opinion about. Terrain maths constants
// (CHUNK_SIZE, BAND_HEIGHT, SEA_LEVEL, brush radius bounds…) live in
// @terrace/shared and are never re-declared here.

import { BAND_HEIGHT, CELL_WORLD_SIZE, MAX_HEIGHT } from '@terrace/shared';

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
 * World units per cell edge — re-exported from @terrace/shared, which owns it
 * so that plugins can reach the same number (see its comment there).
 *
 * It was fixed at 1 until 2026-08-21, so world-space X/Z coordinates WERE cell
 * coordinates and picking was a bare floor(). It is a quarter of that now
 * (WORLD_UNIT_CELLS = 4): scene coordinates are still world units — the camera
 * distances below, the water margin, the sun, every size in the render code —
 * and a cell is simply four times smaller than one, so cell↔world conversions
 * are a real multiply in both directions and picking divides before it floors.
 *
 * NOTHING IN THE SCENE CHANGES SIZE BECAUSE OF THIS. A 512-world-unit world is
 * 2048 cells across and still 512 units wide; what moved is only how many
 * samples the terrain is drawn from.
 */
export { CELL_WORLD_SIZE };

/**
 * How tall the world's full above-sea range stands, in WORLD UNITS. THE relief
 * fact: a MAX_HEIGHT mountain rises this far over the sea, so this alone
 * decides how mountainous the world looks.
 *
 * 16 is exactly the relief the world had before the 2026-08-20 re-terrace and
 * the 2026-08-21 re-sample, and is kept there deliberately through both: those
 * changes were about how finely the world steps and how finely it is sampled,
 * never about how high it stands.
 *
 * IN WORLD UNITS SINCE 2026-08-21, having been "in cells" while a cell WAS a
 * world unit. Left in cells it would have shrunk the world's relief to a
 * quarter the moment the cell did — the same trap the derivation note below
 * records on the vertical axis.
 *
 * THE DERIVATION USED TO RUN THE OTHER WAY (2026-08-20). BAND_WORLD_HEIGHT was
 * primary at one cell per band and this scale fell out of it, which made the
 * world's relief a function of BAND_HEIGHT — the render quantum. Re-terracing
 * 64 → 16 would then have quadrupled every mountain in the game. Relief is the
 * physical fact and the band is the quantum, so the band is what derives.
 */
export const MAX_RELIEF_WORLD_UNITS = 16;

/** Height units → world units. Derived; never write this ratio by hand. */
export const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

/**
 * World units a single terrace band rises — how tall one step LOOKS.
 *
 * Historically forced to equal CELL_WORLD_SIZE by the old vertex-per-cell grid
 * (whose steepest face was 45°); since the 2026-08-14 cliff renderer, risers
 * are true vertical walls (terrain/vertexGrid.ts emits duplicated per-face
 * vertices), so it was free of that constraint. It is DERIVED from the relief
 * above rather than chosen: a quarter of a world unit at BAND_HEIGHT 16, which
 * is the whole visible point of the re-terrace — the same hills, stepped four
 * times as finely.
 *
 * It is exactly one CELL tall again since the 2026-08-21 re-sample, and that
 * is a coincidence of two independent quarterings rather than a constraint
 * returning: a riser is still a true vertical wall and would keep this height
 * at any sampling density.
 */
export const BAND_WORLD_HEIGHT = BAND_HEIGHT * HEIGHT_WORLD_SCALE;

/**
 * Height units per WORLD UNIT — the conversion for anything whose size is a
 * world-space fact but which is computed in height units (the frontier fog's
 * bank profile, for one). Stating such a thing as a multiple of BAND_HEIGHT
 * instead is the bug this arc keeps finding: it silently rescales the moment
 * the world is re-terraced.
 *
 * PER WORLD UNIT, NOT PER CELL (2026-08-21). This was CELL_HEIGHT_UNITS while
 * a cell was a world unit; every caller wanted the world-space meaning, so
 * re-sampling the world would have shrunk each of them to a quarter.
 */
export const WORLD_UNIT_HEIGHT_UNITS = 1 / HEIGHT_WORLD_SCALE;

/**
 * How far above SEA_LEVEL the water surface is drawn, in world units.
 *
 * It cannot be zero. Terrace band 0 covers heights 0..BAND_HEIGHT-1 and every
 * one of them quantises to a vertex height of 0 — the same plane the sea would
 * sit on. That is not a rare case: it is a freshly generated world (all cells
 * at 0) and every shoreline flat thereafter, so a coplanar sea would z-fight
 * across the most-looked-at part of the map.
 *
 * A thirty-second of a WORLD UNIT is the compromise: far above the depth-buffer
 * resolution at these camera distances, so the ordering is decided and stable,
 * yet a small enough step that a band-0 flat still reads as sitting AT the
 * waterline rather than floating above or sunk below it.
 *
 * MEASURED AGAINST THE WORLD UNIT, NOT THE BAND (2026-08-20, restated in world
 * units 2026-08-21 when the cell stopped being one). Depth-buffer
 * resolution is a fact about world space and the camera, and nothing about
 * re-terracing the world changed either — written as a fraction of a band it
 * would have quietly shrunk to a quarter of the separation it was tuned for.
 * The band-relative consequence noted here before has moved with it: clearing
 * the water now takes four clicks rather than one, because a click is a band
 * and a band is four times finer, which is the re-terrace working as intended
 * and still leaves "raising land out of water" legible (MVP criterion 4).
 */
export const WATER_SURFACE_LIFT = 1 / 32;

/**
 * THE FLOOR of the hold-repeat ramp: the shortest interval between repeated
 * sculpt intents, reached only after a hold has been sustained (see
 * SCULPT_REPEAT_DELAY_MS and SCULPT_REPEAT_RAMP_FACTOR — input/sculptInput.ts
 * owns the schedule).
 *
 * Chosen at 120 ms — deliberately just above the server's 100 ms tick period
 * (TICK_HZ 10, design doc §3.2) — so a held brush can never queue more than
 * one intent per tick. That bounds both the wire rate and the size of the
 * per-tick diff the server has to broadcast, which is exactly the budget the
 * design doc's server performance target asks for. Because it is the FLOOR,
 * no ramped interval is ever shorter than it, so that bound holds for the
 * whole ramp — which is also what keeps terrain/prediction.ts's in-flight cap
 * (derived from this constant) a true upper bound rather than an estimate.
 *
 * PROVISIONAL / feel-tuning: at one BAND_HEIGHT per intent a fully ramped hold
 * raises roughly eight terrace bands per second. Re-tune in Phase 2.
 */
export const SCULPT_REPEAT_INTERVAL_MS = 120;

/**
 * Milliseconds from a stroke's FIRST intent to its second — the top of the
 * hold-repeat ramp.
 *
 * Owner report, 2026-08-19: "a single click is raising land too fast; it
 * should start slow and progressively speed up." The old schedule was a flat
 * setInterval at SCULPT_REPEAT_INTERVAL_MS, so a press held for the ~150 ms a
 * deliberate click actually lasts landed TWO bands, not one — the brush had
 * no notion of a click being different from a hold.
 *
 * 400 ms is sized against human click duration, not picked for feel: a
 * deliberate mouse click is press-to-release in roughly 80–150 ms, and a slow
 * or heavy-handed one still lands under 300 ms. At 400 ms every click that is
 * meant as a click ends before the second intent is due, so ONE click is ONE
 * band by construction. It is also comfortably under the ~500 ms an OS
 * keyboard typematic delay uses, which is the closest thing to a learned
 * expectation a player brings to "press and hold".
 */
export const SCULPT_REPEAT_DELAY_MS = 400;

/**
 * Multiplier applied to the repeat interval after each repeat, until it
 * reaches SCULPT_REPEAT_INTERVAL_MS and stays there. This is the "and
 * progressively speed up" half of the owner's report.
 *
 * 0.75 gives the ramp 400 → 300 → 225 → 169 → 127 → 120 ms: five accelerating
 * repeats over the first ~1.2 s of a hold, then the flat floor. That shape is
 * the point — the early repeats are far enough apart to be counted (a player
 * can stop at exactly three bands), and a sustained hold still reaches full
 * sculpting speed inside the time it takes to decide you want a mountain.
 *
 * Rejected alternatives: a linear step-down needs two numbers (a step size AND
 * a floor) that must be kept consistent with the delay, and a step-per-repeat
 * count makes the ramp's DURATION depend on the floor. One multiplier makes
 * "how fast does it speed up" a single dial, and the geometric shape means the
 * big changes happen early, which is where the player is still deciding.
 */
export const SCULPT_REPEAT_RAMP_FACTOR = 0.75;

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

/** Camera framing. Every distance below is in WORLD UNITS — see CELL_WORLD_SIZE. */
export const CAMERA_FOV_DEGREES = 55;
export const CAMERA_NEAR = 0.1;
/**
 * Far plane must clear the diagonal of the largest supported world — 512 WORLD
 * UNITS on a side, which the 2026-08-21 re-sample left exactly where it was
 * (DEFAULT_WORLD_SPAN); only the cell count under it moved.
 */
export const CAMERA_FAR = 4000;
/**
 * Initial orbit distance and the zoom bounds, in world units. The maximum lets
 * a full 512-unit world fit on screen; the minimum is derived just below.
 */
export const CAMERA_INITIAL_DISTANCE = 80;

/**
 * How much of the world the closest zoom frames, as frame HEIGHT in world
 * units. This is the design decision the minimum orbit distance encodes: at
 * the closest zoom a player is inspecting a handful of individual features —
 * a single structure's footprint, one terrace step, the lip of a river bank —
 * not a region. TEN is where the owner set it (2026-08-21, trying values;
 * four was the first attempt).
 *
 * IN WORLD UNITS, NOT CELLS, and the value is the owner's unchanged. The
 * framing was tuned the same day on a grid where a cell WAS a world unit, so
 * the two readings named the same camera and the choice between them was
 * invisible. It stopped being invisible at the re-sample: the derivation below
 * solves for a distance in whatever units the frame height is stated in, and
 * the camera lives in world space, so the number that was tuned was always a
 * world-unit frame height. Read literally as ten CELLS it would frame two and
 * a half terrace treads — four times closer than what was tuned.
 *
 * Raise it to pull the closest zoom back out, lower it to get closer still.
 */
export const CAMERA_CLOSEST_VIEW_WORLD_UNITS = 10;

/**
 * Closest orbit distance, in world units. DERIVED from the framing decision above
 * and the lens, never written by hand: a perspective camera of vertical field
 * CAMERA_FOV_DEGREES sees `2 * d * tan(fov / 2)` of world height at distance
 * d, so the distance that frames exactly CAMERA_CLOSEST_VIEW_WORLD_UNITS is
 * that solved for d. Change the FOV and the closest zoom keeps framing the
 * same amount of world.
 *
 * WAS 20, loosened 2026-08-21 on owner request ("zoom in further"). That value
 * was one hand-written number justified as clearing a maximum-height mountain
 * (MAX_RELIEF_WORLD_UNITS = 16) — but that clearance only ever held looking
 * straight down: orbit distance is measured to the target on the ground, so at
 * the steepest allowed orbit (CAMERA_MAX_POLAR_ANGLE_DEGREES = 85°) even the
 * old 20 put the camera 20·cos 85° ≈ 1.7 world units above its target, well
 * under a 16-unit peak. The guarantee was already not there to lose.
 *
 * RESIDUAL FAILURE MODE, unchanged in kind but easier to reach: with no
 * terrain-aware clamp on the camera anywhere in the client, orbiting to a
 * shallow angle next to tall terrain can put the near plane inside a
 * hillside, which renders as the world opening up in front of the camera. The
 * fix for that is a ground-clearance clamp that lifts the camera to stay above
 * the height field under it — it is not this constant's job, and it does not
 * exist yet.
 */
export const CAMERA_MIN_DISTANCE =
  CAMERA_CLOSEST_VIEW_WORLD_UNITS /
  (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
export const CAMERA_MAX_DISTANCE = 900;
/**
 * How far above the RENDERED terrain surface the camera is held, in cells
 * (render/cameraClearance.ts applies it every frame). This is the constant
 * that actually answers "how close can I get to the landscape" — unlike
 * CAMERA_MIN_DISTANCE, which is measured to the orbit target and so says
 * nothing about the ground (see its own note).
 *
 * TWO HARD LOWER BOUNDS, and the value sits clear of both:
 *   - CAMERA_NEAR (0.1 cells). Below it the cap under the camera crosses the
 *     near plane and the terrain opens up in front of the view.
 *   - BAND_WORLD_HEIGHT (a quarter cell). A sculpt raises the ground under
 *     the camera a band at a time; less than one band of headroom and a
 *     single raise-stroke could swallow the camera between two frames.
 * One cell — the terrain's own XZ quantum, four band steps — clears both with
 * room to spare, and keeps the cell under the camera fully in frame.
 */
export const CAMERA_GROUND_CLEARANCE_CELLS = 1;

/** Clamp the orbit above the horizon so the camera never goes under the sea. */
export const CAMERA_MAX_POLAR_ANGLE_DEGREES = 85;

/**
 * Length of one frame-rate sampling window, in milliseconds (render/
 * frameRate.ts averages over it; ui/VersionWatermark.tsx prints the result).
 *
 * 500 ms is the compromise between the two ways a frame counter goes wrong.
 * Shorter windows chase every hitch — at 100 ms a single dropped frame moves
 * the reading by 10 fps, so the number flickers and stops being readable —
 * while longer ones average away the very thing the meter exists to expose:
 * the chunk-rebuild spikes a held brush causes (render/terrainMeshes.ts's
 * CHUNK_BUILD_FRAME_BUDGET_MS) last a few hundred milliseconds, and a 2 s
 * window would smear them into an innocent-looking mean. Two updates a second
 * is also about as fast as a reading of this kind can be usefully read.
 */
export const FPS_SAMPLE_INTERVAL_MS = 500;
