// hydro — the wire contract between the plugin's two halves.
//
// Imported by BOTH server/ and client/, so it stays side-effect-free and its
// only dependency is `@terrace/shared` — the source of truth for cell geometry
// (CLAUDE.md's hard rule), exactly as plugins/mudslides/protocol.ts depends on
// it. Nothing here reaches for three or for a node builtin. The hosts prefix
// `hydro:` on the wire in both directions, so every type here is the
// UN-namespaced form.
//
// ─────────────────────────────────────────────────────────────────────────────
// A PATCH IS SENT ONCE, NOT STREAMED.
//
// Poured water has one piece of state that only ever counts up: how long ago it
// landed. Everything else — how wet the ground under it is, how dark it draws,
// whether it has soaked long enough to bring a hillside down — is a pure
// function of that one number, derived by `hydroWetness` below on both sides of
// the wire. So the server sends a patch ONCE, with its age at the moment of
// sending, and the client's own clock advances it between messages. That is
// fire's design (plugins/fire/protocol.ts) applied to the opposite mechanic,
// and for its reason: re-transmitting a value the receiver can compute is the
// one cost worth designing out.
//
// THE ARITHMETIC at the shipped HYDRO_PATCH_CAP of 12. A patch on the wire is
// three integers — cell x, cell y, and one decisecond fixed-point age, all
// under 65536 and therefore <=3 B each under msgpack:
//
//   full snapshot   12 x ~9 B                  = ~108 B, at join and keepalive
//   pour delta      one patch per click        = ~9 B
//
// which is small enough that the wire is emphatically NOT what sizes the cap —
// see HYDRO_PATCH_CAP, where the binding budget is the ground shader's.
//
// FIXED POINT, NOT FLOATS. Ages ride as tenths (`HYDRO_FIXED_POINT_SCALE`),
// fire's rule and its arithmetic: msgpack encodes a float64 in 9 B and a small
// integer in 1-3, and a tenth of a second is finer than a frame boundary
// matters for something that lies on the ground for the better part of a minute.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE PUDDLE, ONE EDGE. `hydroWetness` says how wet the middle of a patch is
// and `hydroFalloff` says how that fades outwards, and BOTH halves use both.
// The server prices the douse and the landslide by them, the client darkens the
// ground and draws the sheen by them, and a client whose puddle visibly reaches
// a cell the server thinks is dry is the exact drift this file exists to
// prevent. `hydroFalloff` is deliberately the smoothstep the ground shader
// already runs (client/src/render/groundShade.ts's GROUND_SHADE_FRAGMENT_GLSL),
// so the shading is not an approximation of the wetness — it is the same curve.
// ─────────────────────────────────────────────────────────────────────────────

import { cellsAcross } from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const HYDRO_PLUGIN_NAME = 'hydro';

/**
 * Client → server, "pour water on this cell" (`hydro:pour`), payload `{x, y}`.
 *
 * A MESSAGE, NOT A SCULPT INTENT, for the reason fire's ignite is one: the
 * intent pipeline validates a brush, prices terrain and reconciles a client's
 * PREDICTED terrain, and pouring water predicts nothing — the client asks, the
 * server answers by broadcasting a patch or by staying silent. That a patch may
 * LATER bring a hillside down does not change it: the ground is moved by
 * mudslides, through mudslides' own guarded `WorldApi.sculpt` call, seconds
 * after the click and with no prediction anywhere.
 */
export const HYDRO_POUR_MESSAGE = 'pour';

/**
 * Server → client, every patch there is (`hydro:patches`). Sent to a joining
 * player and on the keepalive cadence. Replaces the receiver's whole set.
 */
export const HYDRO_PATCHES_MESSAGE = 'patches';

/**
 * Server → client, what changed (`hydro:changes`). Applied on top of whatever
 * the receiver already has.
 */
export const HYDRO_CHANGES_MESSAGE = 'changes';

/**
 * How many patches may be wet at once.
 *
 * TWELVE, and unlike fire's 2000 the binding budget is neither the wire nor the
 * draw call — it is the GROUND SHADER'S PER-FRAGMENT LOOP.
 *
 *   * SHADE — the client publishes one shade disc per patch
 *     (client/index.ts's `groundShadeBudget`), and every published disc is one
 *     iteration of the loop in client/src/render/groundShade.ts, run for every
 *     fragment of terrain and water on screen (that loop is bounded by
 *     `uShadeCount`, the LIVE disc count, so this is a cost the world pays
 *     while water is on the ground and not otherwise). The whole shipped sky
 *     publishes 11 — rain 7, snow 2, cyclone 2 (each plugin's own
 *     `groundShadeBudget`). Twelve is therefore at most a doubling of that
 *     loop, which is the most a new publisher may ask of a ~7 ms frame.
 *   * WIRE — 12 x ~9 B = ~108 B for the whole snapshot (see the header). Three
 *     orders of magnitude inside the join budget; it constrains nothing.
 *   * DRAW — every patch is one instance of ONE InstancedMesh
 *     (client/puddles.ts), so the draw-call count does not move with the cap at
 *     all.
 *   * PLAY — a patch is HYDRO_PATCH_RADIUS_CELLS across, so twelve of them lay
 *     a wet band roughly a chunk long: a firebreak a player can actually put
 *     in front of an advancing fire, and not enough water to flood a valley.
 *
 * When the cap binds, the DRIEST patch is evicted (server/patches.ts) rather
 * than the pour being refused — the water a player has just poured is the water
 * they are watching, and the oldest puddle is the one nearest to drying anyway.
 */
export const HYDRO_PATCH_CAP = 12;

/**
 * Fixed-point scale for the seconds on the wire: tenths. See the header — this
 * is a bandwidth decision, and a tenth of a second is below the resolution at
 * which a minute-long puddle can be perceived.
 */
export const HYDRO_FIXED_POINT_SCALE = 10;

/** Cell → integer key, and back. Fire's `fireKey`, in shape and in stride. */
export const HYDRO_CELL_KEY_STRIDE = 65536;

export function hydroKey(x: number, y: number): number {
  return y * HYDRO_CELL_KEY_STRIDE + x;
}

export function hydroCellOf(key: number): { x: number; y: number } {
  return { x: key % HYDRO_CELL_KEY_STRIDE, y: Math.floor(key / HYDRO_CELL_KEY_STRIDE) };
}

/**
 * How far one pour spreads, in world units.
 *
 * ONE AND A HALF — the same reach mudslides gives its own head scour
 * (MUDSLIDE_BRUSH_RADIUS_WORLD_UNITS), and the same reason applies here: it is
 * the scale at which a single act reads as happening to a PIECE OF HILLSIDE
 * rather than to a cell. Smaller and a pour is a dot the player cannot see
 * against a burning meadow; larger and one click wets more ground than the
 * biggest brush a player owns can move.
 */
export const HYDRO_PATCH_RADIUS_WORLD_UNITS = 1.5;

/**
 * The same reach in cells — the unit every position on this wire is in.
 *
 * DERIVED through shared's own conversion rather than written down, so it
 * re-samples itself the next time WORLD_UNIT_CELLS moves (it has moved twice).
 */
export const HYDRO_PATCH_RADIUS_CELLS = cellsAcross(HYDRO_PATCH_RADIUS_WORLD_UNITS);

/**
 * How much of a patch's radius stays at FULL wetness before the edge begins to
 * fade, as a fraction of that radius.
 *
 * 0.45, so rather more than half the puddle's width is falloff: water spreading
 * over ground does not end at a line, and a hard-edged disc reads as a decal
 * somebody stuck on the terrain rather than as something that was poured.
 *
 * IT IS ALSO THE `inner` OF THE SHADE DISC the client publishes, which is what
 * makes the darkened ground and the douse radius the same shape rather than two
 * shapes that happen to be similar — see this file's header.
 */
export const HYDRO_PATCH_CORE_FRACTION = 0.45;

/**
 * How long a patch exists at all, in simulated seconds.
 *
 * FORTY. It has to outlast the thing it is for: fire's rain suppression rolls
 * at RAIN_SUPPRESSION_RATE_PER_SECOND (0.25/s) scaled by wetness, so a fire
 * under a full-strength patch is out within a few seconds and a fire that only
 * catches a patch's rim needs tens. Forty seconds also lets a player pour ahead
 * of a spreading front and have the water still be there when the front
 * arrives, which is the whole of the firebreak play. Much longer and a pour
 * stops reading as water and starts reading as terrain.
 */
export const HYDRO_PATCH_SECONDS = 40;

/**
 * The fraction of a patch's life spent drying — fading from full back to
 * nothing.
 *
 * 0.55, so a patch holds full strength for the first 18 s and then fades for
 * 22. ASYMMETRIC, deliberately and in the opposite direction from fire's
 * (FIRE_IGNITION_FRACTION ramps a flame UP): water is at its wettest the
 * instant it lands and has nothing to ramp up from, so the whole of the
 * asymmetry is in the tail. The long tail is what makes a drying puddle
 * readable — a player can see which of their firebreaks is about to fail.
 */
export const HYDRO_DRYING_FRACTION = 0.55;

/**
 * How wet the CENTRE of a patch of this age is, 0…1 — the one derived number
 * the whole feature is a function of (see the header).
 *
 * Outside the patch's life it is 0, before and after alike, so a caller that is
 * late reading a dried patch gets "not wet" rather than a negative or a wrapped
 * value.
 */
export function hydroWetness(ageSeconds: number): number {
  if (ageSeconds < 0 || ageSeconds >= HYDRO_PATCH_SECONDS) return 0;

  const progress = ageSeconds / HYDRO_PATCH_SECONDS;
  const dryingBegins = 1 - HYDRO_DRYING_FRACTION;
  if (progress <= dryingBegins) return 1;
  return (1 - progress) / HYDRO_DRYING_FRACTION;
}

/** True once a patch has dried out and is nobody's business any more. */
export function isDried(ageSeconds: number): boolean {
  return ageSeconds >= HYDRO_PATCH_SECONDS;
}

/**
 * GLSL's smoothstep, restated in TypeScript.
 *
 * Written twice — here and in the ground shader — for the reason
 * client/src/render/groundShade.ts states about its own copy: this project
 * ships no headless GL rig, so the TypeScript is the only form the projection
 * can be read and reasoned about in. The two are kept in step by `hydroFalloff`
 * below being the ONLY caller and by the shader being handed
 * HYDRO_PATCH_CORE_FRACTION rather than a number of its own.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of a patch's wetness reaches a point `distanceCells` from its
 * centre, in [0, 1] — 1 inside the core, 0 at the rim and beyond.
 *
 * THE ONE OPINION ABOUT WHERE A PUDDLE ENDS. The server multiplies it into
 * `wetnessAt` (so fire's suppression and mudslides' soak agree with it) and the
 * client hands the same curve to the ground shader and to the puddle's own
 * fragment shader. Nothing anywhere derives an edge of its own.
 */
export function hydroFalloff(distanceCells: number): number {
  if (distanceCells <= 0) return 1;
  const d = distanceCells / HYDRO_PATCH_RADIUS_CELLS;
  if (d >= 1) return 0;
  return 1 - smoothstep(HYDRO_PATCH_CORE_FRACTION, 1, d);
}

/**
 * One wet patch, as it travels and as both halves hold it.
 *
 * `ageSeconds` is what it was AT THE MOMENT OF SENDING; the receiver advances
 * it with its own clock. There is nothing else, on purpose — a radius would be
 * HYDRO_PATCH_RADIUS_CELLS restated per patch, and a wetness would be a second
 * representation of the age (plugins/fire/server/blaze.ts's rule).
 */
export interface HydroPatchState {
  readonly x: number;
  readonly y: number;
  readonly ageSeconds: number;
}

/**
 * Parses a `hydro:pour` request. Null for anything that is not two non-negative
 * integers — the client is untrusted here in a way the server halves of this
 * protocol are not. `parseIgnitePayload`'s rule, and its bounds.
 */
export function parsePourPayload(payload: unknown): { x: number; y: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const request = payload as { x?: unknown; y?: unknown };
  const { x, y } = request;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= HYDRO_CELL_KEY_STRIDE || y >= HYDRO_CELL_KEY_STRIDE) return null;
  return { x, y };
}

// ────────────────────────────────────────────────────────────────────────────
// Packing
//
// Flat `[x, y, age, …]` rather than an array of objects, for flora's reason
// fire's protocol restates: msgpack re-sends every key string of every object,
// so three named fields cost ~18 B where three integers cost ~9.
// ────────────────────────────────────────────────────────────────────────────

function toFixed(value: number): number {
  return Math.max(0, Math.round(value * HYDRO_FIXED_POINT_SCALE));
}

function fromFixed(value: number): number {
  return value / HYDRO_FIXED_POINT_SCALE;
}

/** How many integers one patch occupies in the flat wire form. */
export const HYDRO_WIRE_STRIDE = 3;

export function packPatches(patches: Iterable<HydroPatchState>): number[] {
  const packed: number[] = [];
  for (const patch of patches) packed.push(patch.x, patch.y, toFixed(patch.ageSeconds));
  return packed;
}

function isWireInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < HYDRO_CELL_KEY_STRIDE
  );
}

/**
 * Defensive parse of the flat form, to fire's rule: a malformed entry is
 * dropped on its own, a payload that is not an array at all yields null so the
 * caller can ignore the message whole, and the count is capped at
 * HYDRO_PATCH_CAP so a broken or hostile payload cannot make the client
 * allocate past its own instance buffers.
 *
 * A patch that has already dried is dropped too: it is invisible by
 * `hydroWetness`'s own definition, and admitting it would put a permanently
 * blank entry in the client's set that nothing would ever remove.
 */
export function parsePatches(value: unknown): HydroPatchState[] | null {
  if (!Array.isArray(value)) return null;

  const patches: HydroPatchState[] = [];
  for (let i = 0; i + HYDRO_WIRE_STRIDE - 1 < value.length; i += HYDRO_WIRE_STRIDE) {
    if (patches.length >= HYDRO_PATCH_CAP) break;
    const [x, y, age] = value.slice(i, i + HYDRO_WIRE_STRIDE);
    if (!isWireInteger(x) || !isWireInteger(y) || !isWireInteger(age)) continue;
    const ageSeconds = fromFixed(age);
    if (isDried(ageSeconds)) continue;
    patches.push({ x, y, ageSeconds });
  }
  return patches;
}

/** Cells → the flat `[x0, y0, x1, y1, …]` form used for patches that dried. */
export function packCells(cells: Iterable<{ readonly x: number; readonly y: number }>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseCells(value: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(value)) return null;

  const cells: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= HYDRO_PATCH_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isWireInteger(x) || !isWireInteger(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

/** `hydro:patches` — the receiver's whole wet set. */
export interface HydroPatchesPayload {
  readonly patches: readonly number[];
}

/**
 * `hydro:changes` — water that landed (the full three-integer form) and cells
 * that dried out (two integers each).
 *
 * The two halves are shaped differently on purpose: a pour has to carry the
 * patch's whole life, and a dry-out carries nothing but "the water that was at
 * this cell is gone".
 */
export interface HydroChangesPayload {
  readonly poured: readonly number[];
  readonly dried: readonly number[];
}

export function parsePatchesPayload(payload: unknown): HydroPatchState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parsePatches((payload as { patches?: unknown }).patches);
}

export function parseChangesPayload(
  payload: unknown,
): { poured: HydroPatchState[]; dried: Array<{ x: number; y: number }> } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { poured?: unknown; dried?: unknown };
  // An absent half is an empty half, not a malformed message — fire's rule, and
  // it matters as much here: a delta that only dries is the ordinary message.
  const poured = parsePatches(message.poured ?? []);
  const dried = parseCells(message.dried ?? []);
  if (poured === null || dried === null) return null;
  return { poured, dried };
}
