// cyclone — the wire contract between the plugin's two halves, and the
// vocabulary its per-world settings are written in.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FICTION (issue #213, owner 2026-08-26).
//
// A CYCLONE IS LARGE, SLOW, BORN OVER OPEN WATER AND DYING OVER LAND. It is
// called a hurricane, a typhoon or a cyclone depending on which quarter of the
// world it was born in, which is flavour and nothing else — the sim does not
// branch on the name. It lives about eight minutes, covers a quarter of the map,
// dims the daylight under it, and with surge on it is the one thing in this
// repo besides a player that changes the shape of the ground.
//
// ITS SIBLING, THE TORNADO, IS A SEPARATE PLUGIN since the 2026-09-02
// decomposition (#283). The two were one plugin over one parametric sim, and the
// sim survives — it is now core's plugin kit (server/src/plugins/kit/
// rotatingStorms.ts), which this plugin holds one instance of. What was a `kind`
// field in a shared table is now the identity of the folder.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRAVELS. The storms themselves — a centre, a radius, an intensity, a
// velocity and a name — and nothing else. No cloud geometry, no rain: every one
// of those is invented on the client out of these few numbers plus the frame
// clock. A cyclone is ~110 B on the wire and there is at most MAX_ACTIVE of
// them.
//
// THIS BROADCAST IS FOG-OF-WAR FILTERED (WorldApi.broadcastVisible), where the
// sky plugins' unfiltered system lists are not, and the difference is
// information: a front's position is a function of RNG and the shared wind
// alone, so it says nothing about locked terrain; a cyclone is born over open
// water, so "there is a cyclone at (x, y)" IS a statement about the terrain
// there.

import { cellsAcross } from '@terrace/shared';

/** Plugin name on both sides. Also the message namespace. */
export const CYCLONE_PLUGIN_NAME = 'cyclone';

/**
 * Un-namespaced type of the server → client push (`cyclone:all`).
 *
 * ONE MESSAGE TYPE CARRYING FULL STATE, for the self-healing reason every
 * position-bearing plugin here gives: a dropped message costs one broadcast
 * interval of staleness and there is no delta stream to desynchronise.
 *
 * AN EMPTY LIST IS MEANINGFUL and is sent just as faithfully as a populated one:
 * it is how a client learns the storm it was watching has died, or has walked
 * out of the territory it can see. That is why the server sends this with
 * `skipEmpty: false`.
 */
export const CYCLONE_ALL_MESSAGE = 'all';

/**
 * Un-namespaced type of the wind-damage WORLD EVENT (`cyclone:damage`) — a
 * server-side fan-out to sibling plugins, NEVER a client message.
 *
 * WHO IS EXPECTED TO READ IT (issue #213): structures (roofs off, then walls),
 * flora (trees down), boats (driven ashore or sunk), wildlife (scattered) and
 * fire (fanned by the wind, or blown out by the rain). NONE OF THEM CONSUME IT
 * TODAY — this is the seam those follow-ups attach to, and emitting it costs one
 * fan-out per storm per second. The payload is the kit engine's own damage
 * record (RotatingStormDamage): where the eye is, what the disc covers, the calm
 * middle it does not, and a bounded SAMPLE of struck cells for a consumer with
 * no spatial index — a cyclone's disc is ~11 000 cells and enumerating it every
 * second would put a five-figure array through every plugin's onWorldEvent.
 */
export const CYCLONE_DAMAGE_EVENT = 'damage';

/**
 * Un-namespaced type of the landfall WORLD EVENT (`cyclone:landfall`) — emitted
 * once, when the eye first crosses from water onto land.
 *
 * SEPARATE FROM `damage` because it is an INSTANT and damage is a rate: a
 * chronicle wants to record "the typhoon came ashore" once, not to summarise six
 * hundred per-second damage events into that sentence.
 */
export const CYCLONE_LANDFALL_EVENT = 'landfall';

// ─────────────────────────────────────────────────────────────────────────────
// THE PER-WORLD SETTINGS.

/** Key of the frequency setting (WorldApi.setting). */
export const CYCLONE_FREQUENCY_SETTING_KEY = 'cyclone-frequency';

/**
 * How often cyclones arrive, as the operator chooses it.
 *
 * A CLOSED SET, because that is what PluginSettingDeclaration is for: core
 * validates the value off the wire and renders a control for it without knowing
 * what any of these mean. `off` is a real value and not the absence of a row — a
 * self-hoster who wants a world with weather but no hurricanes says so.
 */
export const CYCLONE_FREQUENCIES = ['off', 'rare', 'common'] as const;
export type CycloneFrequency = (typeof CYCLONE_FREQUENCIES)[number];

/**
 * In force where the world file has no row.
 *
 * `rare`, not `common`, and not `off`: with surge off a cyclone rewrites nothing
 * permanent, so shipping it on is safe, but a world under a hurricane most of
 * the time is a world about hurricanes. Rare is the setting that makes one an
 * event.
 */
export const DEFAULT_CYCLONE_FREQUENCY: CycloneFrequency = 'rare';

/**
 * What the operator's frequency setting does to the difficulty-derived mean
 * interval.
 *
 * A MULTIPLIER ON THE INTERVAL, not a replacement for it, so the two dials
 * COMPOSE: difficulty says what kind of world this is, and the setting says how
 * much of this particular mechanic the operator wants in it. `rare` (the
 * default) doubles the wait and `common` halves it — a four-fold spread either
 * side of the difficulty curve.
 *
 * `off` has no entry: it is handled before any rate arithmetic runs, because "an
 * infinitely long mean interval" is a thing this table cannot express and a `0`
 * here would read as "instantly".
 */
export const FREQUENCY_INTERVAL_MULTIPLIERS: Readonly<Record<'rare' | 'common', number>> = {
  rare: 2,
  common: 0.5,
};

/**
 * Key of the setting that decides whether a cyclone may PERMANENTLY REWRITE
 * TERRAIN in this world (WorldApi.setting).
 *
 * ONE SWITCH, TWO MECHANICS since issue #299: the storm surge at the shoreline
 * (server/surge.ts) and the wind scour on struck land (server/wind-scour.ts).
 * The question an operator is being asked is not "do you want surges" — it is
 * "may weather edit my map", which is the only part of a cyclone that is not
 * transient and the only part there is no undo for. Splitting it would offer a
 * world where the sea may take the coast but the wind may not take the hill
 * behind it, a distinction nobody has asked for, in exchange for a second row
 * in the world panel and a second thing to reason about in every discussion of
 * "is this world's terrain stable".
 *
 * THE KEY STILL SAYS `cyclone-surge`, and deliberately is not renamed. It is
 * persisted per world (WorldApi.setting's doc comment: changing a setting
 * writes the row and reopens the world), so renaming it would silently reset
 * every world that has ever turned it off — the exact worlds whose owners care
 * most about this answer — back to the shipped default of `on`. A historical
 * name is a smaller cost than that, and this comment is where it is paid.
 */
export const CYCLONE_SURGE_SETTING_KEY = 'cyclone-surge';

export const CYCLONE_SURGE_MODES = ['off', 'on'] as const;
export type CycloneSurgeMode = (typeof CYCLONE_SURGE_MODES)[number];

/**
 * Ground-changing ships ON (owner, issue #230, 2026-09-01; it shipped off
 * before that).
 *
 * It is still the only thing this plugin does that is permanent — a `sculpt`,
 * and a sculpt is terrain a player did not ask for. What made defaulting it on
 * acceptable is the guard that came with the decision: a surge scours only a
 * shoreline whose whole brush footprint is REVEALED (server/surge.ts,
 * `footprintUnlocked`), so a coast nobody has seen is never quietly rewritten. A
 * self-hoster who wants an unchanging shoreline sets `off`.
 *
 * THE WIND SCOUR ADDED BY #299 SHIPS UNDER THE SAME DEFAULT AND THE SAME GUARD
 * — it carries `footprintUnlocked` over the whole of its own (smaller) brush,
 * for the same reason and through the same shared helper. What extends the
 * owner's ruling to it is that the condition of that ruling is met, not that
 * the two mechanics are alike.
 */
export const DEFAULT_CYCLONE_SURGE_MODE: CycloneSurgeMode = 'on';

/**
 * Parses a setting value the host handed back, falling back to the default for
 * an absent or unrecognised one.
 *
 * `undefined` means "this world has no opinion" (WorldApi.setting), and an
 * unrecognised STRING should be impossible — core validates against the declared
 * `values` before persisting a row — so the fallback is belt and suspenders
 * against a hand-edited world file rather than an expected path.
 */
export function parseFrequency(value: string | undefined): CycloneFrequency {
  return CYCLONE_FREQUENCIES.includes(value as CycloneFrequency)
    ? (value as CycloneFrequency)
    : DEFAULT_CYCLONE_FREQUENCY;
}

export function parseSurgeMode(value: string | undefined): CycloneSurgeMode {
  return CYCLONE_SURGE_MODES.includes(value as CycloneSurgeMode)
    ? (value as CycloneSurgeMode)
    : DEFAULT_CYCLONE_SURGE_MODE;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FLAVOUR NAMES.

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
 * north-east is the Pacific analogue and gets `typhoon`; the whole southern half
 * — where both the Indian and South Pacific basins say the same word — gets
 * `cyclone`.
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
 * A FIXED LIST WALKED IN ORDER, exactly as real basins do it (this year's storms
 * are named alphabetically off a published list), which is also why it needs no
 * RNG: the Nth cyclone of a world is the Nth name, and a world restored from a
 * snapshot resumes where it left off because the counter is in the persistence
 * slice. Twenty-one names is the real convention (no Q, U, X, Y, Z); past the
 * end it wraps, which is what real basins now do too.
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

/**
 * `Hurricane Ada` — the whole label, built server-side and sent whole.
 *
 * Capitalised the way a storm's name is written. Built in one place rather than
 * as a basin plus an index the client joins: it is a label, it is written once
 * per storm, and the alternative is two fields and a formatting rule duplicated
 * on both sides.
 */
export function cycloneNameFor(index: number, x: number, y: number, worldSize: number): string {
  const basin = basinNameFor(x, y, worldSize);
  return `${basin.charAt(0).toUpperCase()}${basin.slice(1)} ${givenNameFor(index)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF A CYCLONE, IN THE UNITS BOTH HALVES MEASURE IN.
//
// These live here rather than beside the sim because BOTH HALVES HAVE A STAKE IN
// THEM: the server moves and damages a disc of this radius, and the client draws
// a spiral sized against that same disc. Two copies of "how big is a hurricane"
// would drift, and the way they would drift is silent — a spiral that no longer
// covers the ground the wind is flattening still renders, it just lies.

/**
 * World units one terrace band rises.
 *
 * IMPORTED, NOT RESTATED — this plugin's vertical measurements are in the same
 * units the client's relief is, and @terrace/shared owns that scale (a plugin
 * can import it from either half, where client/src/config.ts is unreachable from
 * a server file). Re-exported here so nothing that reads it from this protocol
 * has to know where it came from.
 */
export { WORLD_UNITS_PER_BAND } from '@terrace/shared';

/**
 * A cyclone's radius, in cells, before the world-size clamp below.
 *
 * THIRTY WORLD UNITS — 60 across, against a default world 128 world units wide.
 * A cyclone is supposed to be a thing you cannot see the edges of from inside it
 * and can see whole from the map view, and this is that: a quarter of the
 * default world's width, in the same range the sky's own large fronts occupy
 * (their max radius is 56 world units).
 */
export const CYCLONE_RADIUS_CELLS = cellsAcross(30);

/**
 * The fraction of the WORLD a cyclone's radius may not exceed.
 *
 * 0.3, and it exists for the sky's own max-radius fraction's reason: a
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
 * spares it from wind damage. A player who works out that the middle is calm has
 * worked out something true.
 */
export const CYCLONE_EYE_RADIUS_FRACTION = 0.125;

/**
 * WHERE THE CLOUD DECK'S HEIGHT WENT (#299, 2026-09-03).
 *
 * `CYCLONE_DECK_HEIGHT_WORLD_UNITS = 10` stood here, and it was wrong on its
 * own terms: its doc claimed ten world units was "above the tallest land the
 * world can have (16 units of relief)", which it is not, so a maximum-height
 * peak poked through the storm. The deck now stands on the client kit's one
 * cloud base — client/src/plugins/kit/cumulusDeck.ts's DECK_BASE_WORLD_Y, taken
 * as an import by ./client/spiral.ts's CYCLONE_DECK_BASE_WORLD_Y — which is
 * also the height the kit's falling column births its drops at, so a cyclone's
 * rain falls out of a cloud that is actually there.
 *
 * IT IS NOT RESTATED IN THIS FILE because it cannot be: the kit is client code
 * that imports three, and this protocol is imported by the server. It never
 * belonged on the wire — no server file ever read it — and a number both halves
 * import is the only kind that belongs here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRE.
//
// The rotating-storm wire form lives in @terrace/shared (shared/src/
// rotatingStormWire.ts), where the disc-systems form went for the same reason:
// two plugins send the identical payload and neither may import the other's
// protocol. Re-exported here so this file stays the one wire contract this
// plugin's halves both import.
//
// The UNBOUNDED position form: a cyclone is born and dies outside the map by
// design, so there is no cell for shared's `roundBroadcastCell` to keep it
// inside of.
export {
  BROADCAST_POSITION_DECIMALS,
  parseRotatingStormsPayload as parseAllPayload,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState as CycloneState,
  type RotatingStormsPayload as CycloneAllPayload,
} from '@terrace/shared';
export { BROADCAST_INTENSITY_DECIMALS as CYCLONE_INTENSITY_DECIMALS } from '@terrace/shared';
