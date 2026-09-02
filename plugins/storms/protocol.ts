// storms — the wire contract between the plugin's two halves, and the
// vocabulary its per-world settings are written in.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared, exactly as weather/protocol.ts and volcanoes/protocol.ts are
// for their plugins.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FICTION (issue #213, owner 2026-08-26).
//
// TWO ROTATING STORMS, ONE MECHANIC. A tornado is small, fast, land-only and
// over in a minute; it drops out of a weather storm cell, so it cannot exist
// where the sky is clear. A CYCLONE is large, slow, born over open water and
// dying over land; it is called a hurricane, a typhoon or a cyclone depending
// on which quarter of the world it was born in, which is flavour and nothing
// else — the sim does not branch on the name.
//
// Both are one `Storm` with different constants, and that is the design rather
// than an economy: they differ in size, speed, lifetime, where they are born
// and what kills them, and every one of those is a number. A second sim would
// have duplicated the movement, the damage footprint, the wire shape and the
// fog-of-war fan-out to express four numbers.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRAVELS. The storms themselves — a handful of discs with a centre, a
// radius, an intensity and a velocity — and nothing else. No debris, no cloud,
// no funnel geometry: every one of those is invented on the client out of these
// few numbers plus the frame clock, the same split weather's systems already
// live under. A storm is ~110 B on the wire and there are at most
// MAX_ACTIVE_STORMS of them.
//
// UNLIKE weather, THIS BROADCAST IS FOG-OF-WAR FILTERED (WorldApi.
// broadcastVisible). Weather can broadcast unfiltered because a front's
// position is a function of RNG and the shared wind alone and so leaks nothing
// about locked terrain; a storm's position is NOT — a cyclone is born over open
// water and a tornado only ever walks on land, so "there is a cyclone at
// (x, y)" is a statement about the terrain at (x, y).

// The one import this file allows itself, and for volcanoes/protocol.ts's
// reason: every measurement below is a fact about the WORLD, and @terrace/shared
// owns the world's own scale.
import { BAND_HEIGHT, MAX_HEIGHT, cellsAcross } from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const STORMS_PLUGIN_NAME = 'storms';

/**
 * Un-namespaced type of the server → client push (`storms:all`).
 *
 * ONE MESSAGE TYPE CARRYING FULL STATE, the choice weather, wildlife and
 * monsters all made, for the same self-healing reasons: a dropped message costs
 * one broadcast interval of staleness and there is no delta stream to
 * desynchronise. It is nearly free here — the list holds at most
 * MAX_ACTIVE_STORMS entries.
 *
 * AN EMPTY LIST IS MEANINGFUL and is sent just as faithfully as a populated
 * one: it is how a client learns the storm it was watching has died, or has
 * walked out of the territory it can see. That is why the server sends this
 * with `skipEmpty: false`.
 */
export const STORMS_ALL_MESSAGE = 'all';

/**
 * Un-namespaced type of the wind-damage WORLD EVENT (`storms:damage`) — a
 * server-side fan-out to sibling plugins, NEVER a client message.
 *
 * See StormDamageEvent below for the payload and who is expected to read it.
 */
export const STORMS_DAMAGE_EVENT = 'damage';

/**
 * Un-namespaced type of the landfall WORLD EVENT (`storms:landfall`) — emitted
 * once, when a cyclone's eye first crosses from water onto land.
 *
 * SEPARATE FROM `damage` because it is an INSTANT and damage is a rate: a
 * chronicle wants to record "the typhoon came ashore" once, not to summarise
 * six hundred per-second damage events into that sentence.
 */
export const STORMS_LANDFALL_EVENT = 'landfall';

// ─────────────────────────────────────────────────────────────────────────────
// THE PER-WORLD SETTINGS.

/** Key of the frequency setting (WorldApi.setting). */
export const STORMS_FREQUENCY_SETTING_KEY = 'storm-frequency';

/**
 * How often storms arrive, as the operator chooses it.
 *
 * A CLOSED SET, because that is what PluginSettingDeclaration is for: core
 * validates the value off the wire and renders a control for it without knowing
 * what any of these mean. `off` is a real value and not the absence of a row —
 * a self-hoster who wants a world with weather but no tornadoes says so.
 */
export const STORM_FREQUENCIES = ['off', 'rare', 'common'] as const;
export type StormFrequency = (typeof STORM_FREQUENCIES)[number];

/**
 * In force where the world file has no row.
 *
 * `rare`, not `common`, and not `off`: a storm rewrites nothing permanent, so
 * shipping it on is safe, but a world that grows a tornado every couple of
 * minutes is a world about tornadoes. Rare is the setting that makes one an
 * event.
 */
export const DEFAULT_STORM_FREQUENCY: StormFrequency = 'rare';

/** Key of the storm-surge setting (WorldApi.setting). */
export const STORMS_SURGE_SETTING_KEY = 'storm-surge';

export const STORM_SURGE_MODES = ['off', 'on'] as const;
export type StormSurgeMode = (typeof STORM_SURGE_MODES)[number];

/**
 * Surge ships ON (owner, issue #230, 2026-09-01; it shipped off before that).
 *
 * It is still the one thing this plugin does that is permanent — a `sculpt`, and
 * a sculpt is terrain a player did not ask for. What made defaulting it on
 * acceptable is the guard that came with the decision: a surge scours only a
 * shoreline whose whole brush footprint is REVEALED (server/surge.ts,
 * `footprintUnlocked`), so a coast nobody has seen is never quietly rewritten.
 * A self-hoster who wants an unchanging shoreline sets `off`.
 */
export const DEFAULT_STORM_SURGE_MODE: StormSurgeMode = 'on';

/**
 * Parses a setting value the host handed back, falling back to the default for
 * an absent or unrecognised one.
 *
 * `undefined` means "this world has no opinion" (WorldApi.setting), and an
 * unrecognised STRING should be impossible — core validates against the
 * declared `values` before persisting a row — so the fallback is belt and
 * suspenders against a hand-edited world file rather than an expected path.
 */
export function parseFrequency(value: string | undefined): StormFrequency {
  return STORM_FREQUENCIES.includes(value as StormFrequency)
    ? (value as StormFrequency)
    : DEFAULT_STORM_FREQUENCY;
}

export function parseSurgeMode(value: string | undefined): StormSurgeMode {
  return STORM_SURGE_MODES.includes(value as StormSurgeMode)
    ? (value as StormSurgeMode)
    : DEFAULT_STORM_SURGE_MODE;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO KINDS, AND THE FLAVOUR NAMES.

/**
 * The kinds of storm that exist. Ordered, and this order is the deterministic
 * order the spawner considers them in.
 */
export const STORM_KINDS = ['tornado', 'cyclone'] as const;
export type StormKind = (typeof STORM_KINDS)[number];

/**
 * What a cyclone is CALLED, by the quarter of the world it was born in.
 *
 * PURE FLAVOUR — the sim never branches on it and the client only prints it.
 * Real basins name the same storm three ways (Atlantic hurricane, north-west
 * Pacific typhoon, Indian/South Pacific cyclone), so a Terrace world does the
 * same with the only geography it has: which half of the map, north/south and
 * east/west, the eye formed over.
 */
export const CYCLONE_BASIN_NAMES = ['hurricane', 'typhoon', 'cyclone'] as const;
export type CycloneBasinName = (typeof CYCLONE_BASIN_NAMES)[number];

/**
 * Names a cyclone from where its eye formed, deterministically.
 *
 * The world's +Y is SOUTH (cell row 0 is the north edge, matching the way the
 * heightmap and every renderer index rows), so the northern half is `y <
 * worldSize / 2`. North-west is the Atlantic analogue and gets `hurricane`;
 * north-east is the Pacific analogue and gets `typhoon`; the whole southern
 * half — where both the Indian and South Pacific basins say the same word —
 * gets `cyclone`.
 *
 * Deterministic and total: any finite (x, y) names something, including one
 * outside the world, because a storm may legitimately be born just off the map
 * edge.
 */
export function basinNameFor(x: number, y: number, worldSize: number): CycloneBasinName {
  const half = worldSize / 2;
  if (y >= half) return 'cyclone';
  return x < half ? 'hurricane' : 'typhoon';
}

/**
 * The roster a named storm's proper name is drawn from, in order.
 *
 * A FIXED LIST WALKED IN ORDER, exactly as real basins do it (this year's
 * storms are named alphabetically off a published list), which is also why it
 * needs no RNG: the Nth cyclone of a world is the Nth name, and a world
 * restored from a snapshot resumes where it left off because the counter is in
 * the persistence slice. Twenty-one names is the real convention (no Q, U, X,
 * Y, Z); past the end it wraps, which is what real basins now do too.
 */
export const CYCLONE_GIVEN_NAMES: readonly string[] = [
  'Ada',
  'Bramble',
  'Cinder',
  'Dagon',
  'Elgar',
  'Fenwick',
  'Grist',
  'Halloway',
  'Ivory',
  'Juniper',
  'Kestrel',
  'Lorne',
  'Marrow',
  'Nettle',
  'Osprey',
  'Pell',
  'Rowan',
  'Sable',
  'Thorne',
  'Vesper',
  'Wren',
];

/** The Nth cyclone's given name. Wraps, so any non-negative integer names one. */
export function givenNameFor(index: number): string {
  const names = CYCLONE_GIVEN_NAMES;
  return names[((index % names.length) + names.length) % names.length]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF A STORM, IN THE UNITS BOTH HALVES MEASURE IN.
//
// These live here rather than beside the sim because BOTH HALVES HAVE A STAKE
// IN THEM: the server moves and damages a disc of this radius, and the client
// draws a funnel or a spiral sized against that same disc. Two copies of "how
// big is a hurricane" would drift, and the way they would drift is silent — a
// spiral that no longer covers the ground the wind is flattening still renders,
// it just lies.

/**
 * World units one terrace band rises.
 *
 * RESTATED, NOT IMPORTED, and the same restatement plugins/weather/client/
 * sky.ts makes with the same reasoning: the client derives its vertical scale
 * in client/src/config.ts (MAX_RELIEF_WORLD_UNITS / the range in bands), and a
 * plugin cannot import that file without dragging `import.meta.env` into its
 * node test run. Restated as the DERIVATION rather than as 0.25, so the two
 * agree by construction and not by coincidence.
 *
 * RESIDUAL, NAMED: if client/src/config.ts's MAX_RELIEF_WORLD_UNITS changes and
 * this does not, every vertical measurement in this plugin's client half is
 * wrong by that ratio and nothing fails loudly. It is the same residual weather
 * and volcanoes both carry.
 */
const MAX_RELIEF_WORLD_UNITS = 16;
export const WORLD_UNITS_PER_BAND = MAX_RELIEF_WORLD_UNITS / (MAX_HEIGHT / BAND_HEIGHT);

/**
 * A tornado's radius, in cells — how much ground the funnel's damage covers.
 *
 * ONE AND A HALF WORLD UNITS, so the vortex is three across: a thing that fits
 * between two buildings, which is what makes a tornado read as a tornado rather
 * than as a small hurricane. Written through `cellsAcross` because it is a
 * length of GROUND and not a count of samples — the 2026-08-21 re-sample is on
 * record for what happens to distances written as raw cell counts.
 */
export const TORNADO_RADIUS_CELLS = cellsAcross(1.5);

/**
 * How tall a funnel stands, in world units.
 *
 * SIX, against a world whose entire relief is 16 — so a funnel reaches from the
 * ground to well above the highest land, which is where the cloud it hangs from
 * has to be for the picture to make sense. It is deliberately NOT derived from
 * the world's relief: a funnel's height is set by where the cloud base is, and
 * the cloud base does not move when somebody flattens a mountain.
 */
export const TORNADO_HEIGHT_WORLD_UNITS = 6;

/**
 * A cyclone's radius, in cells, before the world-size clamp below.
 *
 * THIRTY WORLD UNITS — 60 across, against a default world 128 world units wide.
 * A cyclone is supposed to be a thing you cannot see the edges of from inside
 * it and can see whole from the map view, and this is that: a quarter of the
 * default world's width, in the same range weather's own large fronts occupy
 * (weather's SYSTEM_MAX_RADIUS_CELLS is 56 world units).
 */
export const CYCLONE_RADIUS_CELLS = cellsAcross(30);

/**
 * The fraction of the WORLD a cyclone's radius may not exceed.
 *
 * 0.3, and it exists for weather's SYSTEM_MAX_RADIUS_WORLD_FRACTION's reason: a
 * self-hoster may run a world far smaller than the default, and a storm wider
 * than the world it is in can never be anywhere in particular — it covers
 * everything, always, and the mechanic stops being an event. Thirty per cent of
 * the edge means the eye can be somewhere the far coast is not.
 */
export const CYCLONE_MAX_RADIUS_WORLD_FRACTION = 0.3;

/** A cyclone's radius in a world of `worldSize` cells, clamped as above. */
export function cycloneRadiusFor(worldSize: number): number {
  return Math.min(CYCLONE_RADIUS_CELLS, worldSize * CYCLONE_MAX_RADIUS_WORLD_FRACTION);
}

/**
 * The radius of a cyclone's EYE, as a fraction of the storm's own radius.
 *
 * An eighth: the calm hole the arms wrap around. It is a fraction rather than a
 * length because it is a fact about the SHAPE of a cyclone, and a shape scales
 * with the thing it is the shape of — an eye written in world units would be a
 * pinprick in a big storm and the whole storm in a small one.
 *
 * BOTH HALVES USE IT: the client leaves the arms out of it, and the server
 * spares it from wind damage. A player who works out that the middle is calm
 * has worked out something true.
 */
export const CYCLONE_EYE_RADIUS_FRACTION = 0.125;

/**
 * How high a cyclone's cloud deck sits, in world units.
 *
 * TEN — above the tallest land the world can have (16 units of relief, and land
 * that high is a peak, not a plateau) so the spiral reads as overcast rather
 * than as fog on a hillside, and low enough that a player looking up sees it
 * fill the sky rather than a distant lid.
 */
export const CYCLONE_DECK_HEIGHT_WORLD_UNITS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRE.

// Broadcast coordinate precision lives in @terrace/shared (shared/src/wire.ts);
// five plugins each carried a byte-identical copy of this rounding before issue
// #180 moved it. Re-exported here so this file stays the one wire contract this
// plugin's halves both import.
//
// The UNBOUNDED form only: a storm is born and dies outside the map by design
// (a cyclone drifts in off the sea), exactly like weather's fronts, so there is
// no cell for shared's `roundBroadcastCell` to keep it inside of.
export { BROADCAST_POSITION_DECIMALS, roundBroadcastPosition } from '@terrace/shared';

/**
 * Decimal places kept on broadcast intensity, which is a fraction in [0, 1]
 * rather than a distance. Three, matching weather's own
 * WEATHER_INTENSITY_DECIMALS and for its reason: a thousandth of full strength
 * is well under one step of 8-bit alpha, so a fade reads as continuous.
 */
export const STORM_INTENSITY_DECIMALS = 3;

const INTENSITY_QUANTUM = 10 ** STORM_INTENSITY_DECIMALS;

/** Rounds an intensity for the wire and clamps it into [0, 1]. */
export function roundBroadcastIntensity(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * INTENSITY_QUANTUM) / INTENSITY_QUANTUM;
}

/** One storm, as it appears on the wire. */
export interface StormState {
  /** Stable for the storm's whole life; the client keys its renderers by it. */
  readonly id: number;
  readonly kind: StormKind;
  /**
   * Cell-space centre (fractional). It may legitimately sit OUTSIDE the world —
   * a cyclone is born over the sea beyond the coast and drifts in.
   */
  readonly x: number;
  readonly y: number;
  /** Cell-space radius. Constant for a storm's whole life. */
  readonly radius: number;
  /**
   * Strength in [0, 1]. It ramps up as the storm spins up and back down as it
   * dies — over land for a cyclone, at the end of its short life for a tornado
   * — so a storm is never seen appearing or vanishing, and the client needs no
   * fade envelope of its own.
   */
  readonly intensity: number;
  /** Cells per second, as a velocity — the client interpolates between pushes. */
  readonly vx: number;
  readonly vy: number;
  /**
   * `Hurricane Ada`, for a cyclone; absent for a tornado, which nobody names.
   *
   * BUILT SERVER-SIDE AND SENT WHOLE rather than sent as a basin + an index for
   * the client to join: it is a label, it is written once per storm, and the
   * alternative is two fields and a formatting rule duplicated on both sides.
   */
  readonly name?: string;
}

/** The `storms:all` payload. */
export interface StormsAllPayload {
  readonly storms: readonly StormState[];
}

/**
 * The `storms:damage` world-event payload — WIND DAMAGE, ONE TICK'S WORTH, FOR
 * SIBLING SERVER PLUGINS.
 *
 * WHO IS EXPECTED TO READ IT (issue #213): structures (roofs off, then walls),
 * flora (trees down), boats (driven ashore or sunk), wildlife (scattered) and
 * fire (fanned by the wind, or blown out by the rain). NONE OF THEM CONSUME IT
 * TODAY — this is the seam those follow-ups attach to, and emitting it costs
 * one fan-out per storm per DAMAGE_INTERVAL_SECONDS.
 *
 * A SAMPLE OF STRUCK CELLS, NOT THE WHOLE FOOTPRINT, and that is the load-
 * bearing decision in this shape. A cyclone's disc is ~11 000 cells at the
 * default radius; listing them every second would put a five-figure array
 * through every installed plugin's onWorldEvent ten times a minute for the
 * eight minutes the storm lives. So the storm reports WHERE IT IS and WHAT IT
 * COVERS (a consumer that owns a spatial index can answer "is my thing in
 * that disc?" far more cheaply than this plugin can enumerate it), plus a
 * bounded sample of individual cells the wind actually hit this interval, for
 * a consumer that has no index and just wants somewhere to knock a tree down.
 *
 * `severity` is in [0, 1]: the storm's own intensity, scaled down towards the
 * rim of the disc and to zero inside a cyclone's eye. A consumer decides for
 * itself what a 0.4 means to a stone wall.
 */
export interface StormDamageEvent {
  readonly stormId: number;
  readonly kind: StormKind;
  /** The eye, in cells. */
  readonly x: number;
  readonly y: number;
  /** The disc the wind covers, in cells. */
  readonly radius: number;
  /** For a cyclone, the calm middle the wind does NOT cover. 0 for a tornado. */
  readonly eyeRadius: number;
  /** The storm's own strength in [0, 1] — the ceiling on any cell's severity. */
  readonly intensity: number;
  /** Seconds of storm this event accounts for, so a rate can be recovered. */
  readonly durationSeconds: number;
  /** A bounded sample of cells the wind struck. See the note above. */
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly severity: number;
  }>;
}

/** The `storms:landfall` world-event payload. */
export interface StormLandfallEvent {
  readonly stormId: number;
  readonly kind: StormKind;
  readonly x: number;
  readonly y: number;
  readonly intensity: number;
  /** `Hurricane Ada`, when the storm has a name. */
  readonly name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSING, for the client half.
//
// Structural, total, and it drops a bad payload WHOLE rather than half-applying
// it — the rule every plugin in this repo follows. The previous state keeps
// rendering until the next good message, which is at most one broadcast away.

function isStormKind(value: unknown): value is StormKind {
  return typeof value === 'string' && STORM_KINDS.includes(value as StormKind);
}

function parseStorm(value: unknown): StormState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, kind, x, y, radius, intensity, vx, vy, name } = value as Record<string, unknown>;
  if (!Number.isInteger(id)) return null;
  if (!isStormKind(kind)) return null;
  for (const number of [x, y, radius, intensity, vx, vy]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  }
  if (name !== undefined && typeof name !== 'string') return null;
  return {
    id: id as number,
    kind,
    x: x as number,
    y: y as number,
    radius: radius as number,
    intensity: intensity as number,
    vx: vx as number,
    vy: vy as number,
    ...(typeof name === 'string' ? { name } : {}),
  };
}

export function parseAllPayload(payload: unknown): StormsAllPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { storms } = payload as Record<string, unknown>;
  if (!Array.isArray(storms)) return null;
  const parsed: StormState[] = [];
  for (const value of storms) {
    const storm = parseStorm(value);
    if (storm === null) return null;
    parsed.push(storm);
  }
  return { storms: parsed };
}
