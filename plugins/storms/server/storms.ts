// THE SIM — where a storm is born, how it moves, what kills it, and what the
// wind hits on the way.
//
// ONE STORM TYPE, TWO SETS OF CONSTANTS (see ../protocol.ts's header for why).
// Everything in this file that differs between a tornado and a cyclone is a
// number in the KIND TABLE below, and every rule — spin-up, the terrain that
// weakens it, the life countdown, the fade, the damage footprint — is written
// once against that table.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LIFE OF A STORM, in the four fields that describe it.
//
//   envelope   0 → 1 → 0. Spins up at birth, falls as the storm dies. Intensity
//              on the wire is peakIntensity × envelope, so a storm is never
//              seen appearing or vanishing.
//   retiring   Set once, when the life countdown runs out. It never un-sets:
//              a dying storm does not come back, which is what makes "envelope
//              reached zero" a safe removal condition.
//   lifeSeconds  Drawn ONCE from an exponential (./rng.ts) and counted down, so
//              it survives a snapshot. A per-tick death roll would re-draw the
//              whole remaining life on every boot.
//   killedByTerrain  A cyclone over land, or a tornado over water, decays on
//              top of everything else. This is the mechanic issue #213 asks
//              for and it is a RATE, not a switch: a cyclone that clips a
//              headland is weakened, one that parks over a continent dies.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT READS AND WHAT IT WRITES.
//
// It reads `heightAt` (is this water?) and `worldSize`, and it writes the world
// in exactly ONE place — the storm surge (./surge.ts), which is behind a
// setting that ships OFF. Everything else a storm does to the world it does by
// EMITTING (../protocol.ts's StormDamageEvent) and letting the plugins that own
// trees, walls, boats and fire decide what a gale means to them.
//
// LOCKED TERRAIN IS READ FREELY HERE, unlike weather's snow siting, and the
// difference is the broadcast: weather's system list goes out UNFILTERED, so it
// must not encode anything about ground a player has not unlocked. This
// plugin's storm list goes out through `broadcastVisible`, so a storm over
// locked water is a storm nobody is told about.

import { SEA_LEVEL, cellsAcross } from '@terrace/shared';
import {
  CYCLONE_EYE_RADIUS_FRACTION,
  TORNADO_RADIUS_CELLS,
  basinNameFor,
  cycloneRadiusFor,
  givenNameFor,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type StormDamageEvent,
  type StormKind,
  type StormLandfallEvent,
  type StormState,
} from '../protocol.ts';
import {
  createStormRng,
  exponentialWaitSeconds,
  randomInRange,
  rollEvent,
  STORM_RNG_DEFAULT_SEED,
  type StormRng,
} from './rng.ts';
import { stormCells } from './weather-bridge.ts';

/**
 * The narrow world this sim needs — `worldSize` and `heightAt`, named exactly
 * as WorldApi names them so a WorldApi can be handed straight in with no
 * adapter object built per call (the same structural-typing trick weather's
 * WeatherWorld and shared's TerrainSampler rely on).
 *
 * NARROW ON PURPOSE: it is the list of things a storm is allowed to know about
 * the world, and it does not include `sculpt`. The one thing here that writes
 * terrain (./surge.ts) takes a WorldApi explicitly, so a reader of this file
 * can see at the type level that nothing in it can move the ground.
 */
export interface StormWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW OFTEN STORMS ARRIVE — the difficulty and settings mapping.

/**
 * Mean seconds between TORNADO arrivals at the two ends of WorldApi.difficulty,
 * before the frequency setting scales them.
 *
 * TWO ANCHORS AND A LERP, which is WorldApi.difficulty's own instruction ("a
 * consumer should treat the ends as the only fixed points and interpolate
 * between them") and the shape the mana plugin established. Ten minutes on the
 * gentlest world and ninety seconds on the harshest: at difficulty 1 a tornado
 * is something a player might see once a session, and at 100 it is a hazard
 * they have to build around.
 */
export const TORNADO_MEAN_INTERVAL_AT_EASIEST_SECONDS = 600;
export const TORNADO_MEAN_INTERVAL_AT_HARDEST_SECONDS = 90;

/**
 * The same two anchors for CYCLONES, four times longer at both ends.
 *
 * A cyclone covers a quarter of the map and lives eight minutes; if one arrived
 * as often as a tornado the world would be under a hurricane most of the time,
 * and a permanent hurricane is weather, not an event. Forty minutes on the
 * gentlest world, six on the harshest.
 */
export const CYCLONE_MEAN_INTERVAL_AT_EASIEST_SECONDS = 2400;
export const CYCLONE_MEAN_INTERVAL_AT_HARDEST_SECONDS = 360;

/**
 * What the operator's frequency setting does to those means.
 *
 * A MULTIPLIER ON THE INTERVAL, not a replacement for it, so the two dials
 * COMPOSE: difficulty says what kind of world this is, and the setting says how
 * much of this particular mechanic the operator wants in it. `rare` (the
 * default) doubles the wait and `common` halves it, which is a four-fold spread
 * either side of the difficulty curve — wide enough to be worth choosing,
 * narrow enough that difficulty still means something at both ends.
 *
 * `off` has no entry: it is handled before any rate arithmetic runs, because
 * "an infinitely long mean interval" is a thing this table cannot express and
 * a `0` here would read as "instantly".
 */
export const FREQUENCY_INTERVAL_MULTIPLIERS: Readonly<Record<'rare' | 'common', number>> = {
  rare: 2,
  common: 0.5,
};

/**
 * The lowest and highest values WorldApi.difficulty takes. Restated from that
 * member's own doc comment ("an integer in [1, 100]") because the lerp needs
 * both ends and a hard-coded 1 and 100 in the arithmetic would be two magic
 * numbers describing a documented contract.
 */
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 100;

/**
 * Mean seconds between arrivals of `kind` on a world of this difficulty, before
 * the frequency multiplier.
 *
 * Clamped at both ends rather than trusted, because a hand-set WORLD_DIFFICULTY
 * outside the documented range would otherwise extrapolate the lerp past its
 * anchors — and past the hard end that means a negative interval, which is a
 * rate of minus infinity and a storm every tick.
 */
export function meanSpawnIntervalSeconds(kind: StormKind, difficulty: number): number {
  const clamped = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
  const t = (clamped - MIN_DIFFICULTY) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
  const easiest =
    kind === 'tornado'
      ? TORNADO_MEAN_INTERVAL_AT_EASIEST_SECONDS
      : CYCLONE_MEAN_INTERVAL_AT_EASIEST_SECONDS;
  const hardest =
    kind === 'tornado'
      ? TORNADO_MEAN_INTERVAL_AT_HARDEST_SECONDS
      : CYCLONE_MEAN_INTERVAL_AT_HARDEST_SECONDS;
  return easiest + (hardest - easiest) * t;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE KIND TABLE — everything that differs between a funnel and a cyclone.

interface KindProfile {
  /** Cells per second the eye travels. */
  readonly speedCellsPerSecond: number;
  /** Radians per second the track curves. A storm that goes straight is a dart. */
  readonly veerRadiansPerSecond: number;
  /** Mean seconds a storm of this kind lives, before terrain kills it. */
  readonly meanLifetimeSeconds: number;
  /** Seconds the envelope takes to climb from 0 to 1 at birth. */
  readonly spinUpSeconds: number;
  /** Seconds the envelope takes to fall from 1 to 0 once retiring. */
  readonly fadeSeconds: number;
  /**
   * Extra envelope lost per second at FULL exposure to the terrain that kills
   * this kind — land for a cyclone, water for a tornado. Scaled by how much of
   * the disc is over it, so a graze costs a little and a parking costs
   * everything.
   */
  readonly hostileTerrainDecayPerSecond: number;
  /** Weakest and strongest a storm of this kind gets, at full envelope. */
  readonly minPeakIntensity: number;
  readonly maxPeakIntensity: number;
  /** How many of this kind may exist at once. */
  readonly maxActive: number;
}

/**
 * A tornado: small, fast, and over in about a minute.
 *
 * SPEED — 2.5 world units a second, so it crosses a default 128-unit world in
 * under a minute if it lives that long. Faster than weather's own wind ceiling
 * (2 world units/s) on purpose: a funnel outruns the front that made it, which
 * is why it eventually walks out from under the cloud and dies.
 *
 * VEER — 0.05 rad/s, five times weather's front veer. A tornado's track wanders
 * visibly over its short life; a front's does not over its long one.
 *
 * WATER KILLS IT IN ABOUT FOUR SECONDS at full exposure (decay 0.25/s), which
 * is issue #213's "land-only" made continuous rather than a teleport-to-death:
 * a funnel that crosses a river is shaken, one that walks out to sea is gone.
 */
const TORNADO_PROFILE: KindProfile = {
  speedCellsPerSecond: cellsAcross(2.5),
  veerRadiansPerSecond: 0.05,
  meanLifetimeSeconds: 60,
  spinUpSeconds: 4,
  fadeSeconds: 6,
  hostileTerrainDecayPerSecond: 0.25,
  minPeakIntensity: 0.5,
  maxPeakIntensity: 1,
  maxActive: 2,
};

/**
 * A cyclone: large, slow, and eight minutes long.
 *
 * SPEED — a quarter of a world unit a second, an eighth of weather's wind
 * ceiling.
 *
 * MEASURED AGAINST THE LIFETIME, not chosen for feel. At half a unit a second a
 * cyclone crosses the whole default world in four minutes, so a storm given
 * eight minutes to live spent most of them off the map — verified in a live
 * world, where a forced cyclone had left the map before its own spin-up curve
 * was interesting. At a quarter it crosses in eight, which is what makes the
 * lifetime the thing that ends a cyclone and the map edge the exception.
 *
 * VEER — 0.008 rad/s, slower than weather's own front veer. Real tracks curve
 * gently and over hours; a hurricane that turned like a tornado would read as
 * being steered.
 *
 * LAND KILLS IT IN ABOUT A MINUTE at full exposure (decay 0.018/s): long enough
 * that a landfall is an event a settlement lives through, short enough that a
 * cyclone cannot cross a continent. That asymmetry against the tornado's four
 * seconds is the whole difference between "land-only" and "weakens over land".
 */
const CYCLONE_PROFILE: KindProfile = {
  speedCellsPerSecond: cellsAcross(0.25),
  veerRadiansPerSecond: 0.008,
  meanLifetimeSeconds: 480,
  spinUpSeconds: 45,
  fadeSeconds: 60,
  hostileTerrainDecayPerSecond: 0.018,
  minPeakIntensity: 0.6,
  maxPeakIntensity: 1,
  maxActive: 1,
};

export function profileFor(kind: StormKind): KindProfile {
  return kind === 'tornado' ? TORNADO_PROFILE : CYCLONE_PROFILE;
}

/**
 * Hard ceiling on storms of every kind at once — the number the wire budget in
 * ../protocol.ts's header multiplies by.
 *
 * It is the sum of the per-kind caps rather than an independent number, so the
 * two can never disagree about what the worst case is.
 */
export const MAX_ACTIVE_STORMS = TORNADO_PROFILE.maxActive + CYCLONE_PROFILE.maxActive;

// ─────────────────────────────────────────────────────────────────────────────
// SITING.

/**
 * Attempts made to find a spawn site before giving up on this roll.
 *
 * SIX, and a failed roll is simply a roll that produced nothing — not a retry
 * next tick and not a relaxed test. Weather's snow siting works the same way
 * and for the same reason: a world with no open water should grow no cyclones,
 * and the honest way to express that is a siting test that keeps failing, not a
 * fallback that puts one somewhere unsuitable.
 */
export const SITING_ATTEMPTS = 6;

/**
 * Sample offsets, in units of the disc's own radius, used to ask "how much of
 * this disc is over water?".
 *
 * THIRTEEN SAMPLES — the centre plus two rings of six — rather than every cell
 * under the storm, which at a cyclone's radius is eleven thousand `heightAt`
 * calls per tick. A disc this size is either at sea or it is not; thirteen
 * samples resolve that, and the number it produces is used as a RATE
 * multiplier, where being one sample out changes a decay by 8% for one tick.
 *
 * Two rings at 0.55 and 1.0 of the radius, offset 30° from each other so the
 * pattern has no axis: a single ring would report a strait as open ocean if the
 * strait happened to run between two spokes.
 */
export const DISC_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const offsets: Array<readonly [number, number]> = [[0, 0]];
  const rings: readonly (readonly [number, number])[] = [
    [0.55, 0],
    [1, Math.PI / 6],
  ];
  /** Samples per ring. Six is the fewest that gives an even, isotropic ring. */
  const SPOKES_PER_RING = 6;
  for (const [scale, phase] of rings) {
    for (let i = 0; i < SPOKES_PER_RING; i++) {
      const angle = phase + (i * 2 * Math.PI) / SPOKES_PER_RING;
      offsets.push([Math.cos(angle) * scale, Math.sin(angle) * scale]);
    }
  }
  return offsets;
})();

/**
 * How much of a cyclone's disc must be water for it to form there.
 *
 * 0.85 — issue #213's "large water bodies" made checkable. Not 1.0: a sample
 * ring at the full radius will clip an island in almost any world worth
 * playing, and demanding a perfectly empty ocean would mean no cyclones at all
 * on an archipelago map. Not lower: at 0.7 a storm can form in a wide bay,
 * which is a storm that is already ashore.
 */
export const CYCLONE_MIN_OPEN_WATER_FRACTION = 0.85;

/** Is this cell under the sea? The one terrain question this sim asks. */
function isWaterAt(world: StormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

/**
 * The fraction of a disc that is over water, in [0, 1], from
 * DISC_SAMPLE_OFFSETS.
 *
 * A sample OUTSIDE the world counts as water. That is not a shortcut: the world
 * is an island in an unbounded sea (every renderer draws it that way), so
 * beyond the edge is ocean, and treating it as land would make a cyclone born
 * off the coast decay as if it had come ashore.
 */
export function waterFractionUnder(
  world: StormWorld,
  x: number,
  y: number,
  radius: number,
): number {
  let water = 0;
  for (const [dx, dy] of DISC_SAMPLE_OFFSETS) {
    const sx = Math.round(x + dx * radius);
    const sy = Math.round(y + dy * radius);
    const outside = sx < 0 || sy < 0 || sx >= world.worldSize || sy >= world.worldSize;
    if (outside || isWaterAt(world, sx, sy)) water++;
  }
  return water / DISC_SAMPLE_OFFSETS.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE.

/** One live storm. Mutable; the tick loop writes it in place. */
export interface Storm {
  readonly id: number;
  readonly kind: StormKind;
  /** Cell-space centre. May be outside the world — a cyclone drifts in. */
  x: number;
  y: number;
  /** Cell-space radius. Fixed for the storm's whole life. */
  readonly radius: number;
  /** Radians; the eye moves toward (cos heading, sin heading) in cell space. */
  heading: number;
  /** Strength at full spin-up, in [minPeakIntensity, maxPeakIntensity]. */
  readonly peakIntensity: number;
  /** Spin-up/decay envelope in [0, 1]. Multiplied by peakIntensity. */
  envelope: number;
  /** True once the life countdown has run out; it never un-sets. */
  retiring: boolean;
  /** Seconds of life left before `retiring` is set. */
  lifeSeconds: number;
  /** `Hurricane Ada`, for a cyclone. Undefined for a tornado. */
  readonly name?: string;
  /** True once the eye has been over land. Makes landfall a once-only event. */
  landfallReported: boolean;
  /** Seconds of storm not yet accounted for by a damage event. */
  damageDebtSeconds: number;
  /**
   * Seconds of cyclone banked toward its next surge. On the record, not in a
   * side table, so it survives a restart or a settings reopen — a world reopened
   * more often than SURGE_INTERVAL_SECONDS otherwise never surged at all
   * (review 2026-08-28). Always 0 for a tornado.
   */
  surgeDebtSeconds: number;
}

const storms: Storm[] = [];
let nextStormId = 1;
/** How many cyclones this world has named — the index into the name roster. */
let namedCycloneCount = 0;
let rng: StormRng = createStormRng(STORM_RNG_DEFAULT_SEED);

/** Live storms, in spawn order. */
export function livingStorms(): readonly Storm[] {
  return storms;
}

/**
 * Drops every live storm, keeping the generator and the name counter where they
 * are — the dev force-spawn's seam (./dev.ts), and nothing on the tick path
 * calls it.
 *
 * SEPARATE FROM `resetStorms`, which also rewinds the RNG and the roster. A
 * developer forcing a storm wants THIS world's sky cleared, not this world's
 * random sequence restarted underneath them.
 */
/**
 * THE DEV FREEZE — storms stop moving, ageing and weakening (./dev.ts).
 *
 * WHY IT HAD TO EXIST, and it is not a convenience. A tornado travels ten cells
 * a second and lives about a minute; the real client renders this world at one
 * to four frames a second under software GL, so a screenshot takes minutes. A
 * forced funnel was therefore always dead — and usually out at sea, since water
 * kills one in four seconds — before a single frame of it reached the file.
 * Freezing is the only thing that makes a tornado photographable at all here.
 *
 * WHAT IT DOES NOT STOP: the damage events. A frozen storm still emits, so the
 * seam every consumer plugin will attach to is exercised exactly as it would be
 * in a live world, and a frozen fixture is not a different code path pretending
 * to be this one.
 *
 * Set ONLY by the dev force-spawn, which itself only runs when STORMS_DEV_FORCE
 * is set. Every real deployment leaves it false.
 */
let devFrozen = false;

export function setDevFrozen(frozen: boolean): void {
  devFrozen = frozen;
}

export function clearStorms(): void {
  storms.length = 0;
}

export function stormCount(kind: StormKind): number {
  let count = 0;
  for (const storm of storms) if (storm.kind === kind) count++;
  return count;
}

/**
 * Drops all storm state so a suite (or a boot) starts from zero: no storms, a
 * fresh generator, and both counters rewound.
 *
 * The generator is re-seeded from the FIXED seed rather than left where it was,
 * so a process that creates two worlds does not hand the second one the first
 * one's tail (PersistenceSlice's re-runnable rule — a load followed by a
 * worldCreate must REPLACE state, never continue it).
 */
export function resetStorms(): void {
  storms.length = 0;
  nextStormId = 1;
  namedCycloneCount = 0;
  rng = createStormRng(STORM_RNG_DEFAULT_SEED);
}

// ─────────────────────────────────────────────────────────────────────────────
// BIRTH.

function birth(
  kind: StormKind,
  x: number,
  y: number,
  radius: number,
  heading: number,
  name?: string,
): Storm {
  const profile = profileFor(kind);
  const storm: Storm = {
    id: nextStormId++,
    kind,
    x,
    y,
    radius,
    heading,
    peakIntensity: randomInRange(rng, profile.minPeakIntensity, profile.maxPeakIntensity),
    envelope: 0,
    retiring: false,
    lifeSeconds: exponentialWaitSeconds(rng, profile.meanLifetimeSeconds),
    ...(name === undefined ? {} : { name }),
    landfallReported: false,
    damageDebtSeconds: 0,
    surgeDebtSeconds: 0,
  };
  storms.push(storm);
  return storm;
}

/**
 * A TORNADO, dropped out of one of weather's storm cells onto land.
 *
 * TWO GATES, and both are issue #213's: it must come from a `storm`-kind
 * weather system (../server/weather-bridge.ts — no cell, no funnel, and a world
 * with no weather plugin gets none at all), and it must touch down on LAND. The
 * site is drawn inside the parent cell's own disc, so the funnel is under the
 * cloud that made it at the moment it forms.
 *
 * The heading is drawn freely rather than taken from the parent front's drift.
 * Weather publishes one shared wind and this bridge deliberately does not ask
 * for it (see the bridge's header): a funnel that always ran exactly downwind
 * would make every tornado in a session travel the same way, and the veer in
 * ./advanceStorms would then be the only thing distinguishing them.
 *
 * Returns null when there is no cell, or when SITING_ATTEMPTS draws inside one
 * found only water.
 *
 * NOT REPRODUCIBLE FROM SEED ALONE — see ./rng.ts's header. `cells` comes from
 * weather's unseeded rng, so replaying this needs the same seed AND the same
 * weather-cell history, not just the seed.
 */
export function trySpawnTornado(world: StormWorld): Storm | null {
  const cells = stormCells();
  if (cells.length === 0) return null;

  const cell = cells[Math.floor(rng.next() * cells.length)]!;
  for (let attempt = 0; attempt < SITING_ATTEMPTS; attempt++) {
    // Uniform over the disc's AREA, not its radius: `sqrt` is what stops every
    // draw bunching at the centre of the cloud.
    const angle = rng.next() * Math.PI * 2;
    const distance = Math.sqrt(rng.next()) * cell.radius;
    const x = cell.x + Math.cos(angle) * distance;
    const y = cell.y + Math.sin(angle) * distance;

    const cx = Math.round(x);
    const cy = Math.round(y);
    if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) continue;
    if (isWaterAt(world, cx, cy)) continue;

    return birth('tornado', x, y, TORNADO_RADIUS_CELLS, rng.next() * Math.PI * 2);
  }
  return null;
}

/**
 * BIRTHS A STORM AT AN EXACT CELL, SKIPPING EVERY SITING TEST — the seam the
 * dev force-spawn (./dev.ts) needs and the ONLY way into `birth` from outside
 * this file.
 *
 * DELIBERATELY NOT THE ORDINARY PATH. `trySpawnTornado` and `trySpawnCyclone`
 * are the ordinary paths, and they exist to enforce the two rules issue #213
 * cares about — a funnel comes out of a weather cell and touches down on land;
 * a cyclone forms over open water. This bypasses both, which is exactly what a
 * developer photographing a storm wants and exactly what a world must never do
 * on its own. Nothing on the tick path calls it.
 *
 * The radius and the name still come from the same functions the real spawner
 * uses, so a forced storm is identical to a natural one in every respect except
 * where it was put.
 */
export function spawnStormAt(
  world: StormWorld,
  kind: StormKind,
  x: number,
  y: number,
): Storm {
  if (kind === 'tornado') {
    return birth('tornado', x, y, TORNADO_RADIUS_CELLS, rng.next() * Math.PI * 2);
  }
  const basin = basinNameFor(x, y, world.worldSize);
  const given = givenNameFor(namedCycloneCount++);
  const label = `${basin.charAt(0).toUpperCase()}${basin.slice(1)} ${given}`;
  return birth(
    'cyclone',
    x,
    y,
    cycloneRadiusFor(world.worldSize),
    rng.next() * Math.PI * 2,
    label,
  );
}

/**
 * A CYCLONE, formed over open water and named for the quarter of the world it
 * formed in.
 *
 * The site is drawn anywhere in the world and tested with
 * `waterFractionUnder` — deliberately NOT restricted to the map edge. A world's
 * open water may be an inland sea, and a storm that could only ever be born
 * beyond the coast would mean an archipelago never gets one; the water test is
 * the rule, and where the water is, is the world's business.
 *
 * Returns null when SITING_ATTEMPTS found nowhere with enough open water — the
 * correct outcome for a world that is all land.
 */
export function trySpawnCyclone(world: StormWorld): Storm | null {
  const radius = cycloneRadiusFor(world.worldSize);
  for (let attempt = 0; attempt < SITING_ATTEMPTS; attempt++) {
    const x = rng.next() * world.worldSize;
    const y = rng.next() * world.worldSize;
    if (waterFractionUnder(world, x, y, radius) < CYCLONE_MIN_OPEN_WATER_FRACTION) continue;

    const basin = basinNameFor(x, y, world.worldSize);
    const given = givenNameFor(namedCycloneCount++);
    // `Hurricane Ada` — capitalised the way a storm's name is written, and
    // built here rather than on the client so the label travels whole.
    const label = `${basin.charAt(0).toUpperCase()}${basin.slice(1)} ${given}`;
    return birth('cyclone', x, y, radius, rng.next() * Math.PI * 2, label);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TICK.

/**
 * How far past the world edge a storm may drift before it is forgotten, in
 * multiples of its own radius.
 *
 * 1.5 — weather's SYSTEM_DESPAWN_MARGIN_RADII, and for its reason: at 1.0 the
 * disc's near edge is exactly on the map boundary when it is removed, which a
 * player standing on the coast can watch happen. Half a radius further out and
 * the last of it is already gone.
 */
export const DESPAWN_MARGIN_RADII = 1.5;

function hasLeftWorld(storm: Storm, worldSize: number): boolean {
  const margin = storm.radius * DESPAWN_MARGIN_RADII;
  return (
    storm.x < -margin ||
    storm.y < -margin ||
    storm.x > worldSize + margin ||
    storm.y > worldSize + margin
  );
}

/**
 * How exposed a storm is to the terrain that kills its kind, in [0, 1].
 *
 * ONE FUNCTION FOR BOTH KINDS, because it is one rule read two ways: a cyclone
 * is killed by the land fraction and a tornado by the water fraction, and those
 * are complements of each other.
 */
function hostileTerrainFraction(storm: Storm, world: StormWorld): number {
  const water = waterFractionUnder(world, storm.x, storm.y, storm.radius);
  return storm.kind === 'cyclone' ? 1 - water : water;
}

/** What one tick of the sim produced, for ./index.ts to publish. */
export interface StormTickResult {
  /** True when any storm moved, was born or died — i.e. clients are stale. */
  readonly changed: boolean;
  /** Damage events due this tick, at most one per storm. */
  readonly damage: readonly StormDamageEvent[];
  /** Cyclone eyes that crossed onto land this tick. At most one per storm. */
  readonly landfalls: readonly StormLandfallEvent[];
}

/**
 * Seconds of storm one damage event accounts for.
 *
 * ONE SECOND, not one tick. A tick is 100 ms at the shipped TICK_HZ, and a
 * fan-out through every installed plugin's `onWorldEvent` ten times a second
 * per storm is a cost no consumer asked for — a tree does not need to be told
 * about the wind at 10 Hz to fall down. One second is also a round number for
 * `durationSeconds`, which is what lets a consumer turn a severity into a rate
 * without knowing this server's tick rate.
 */
export const DAMAGE_INTERVAL_SECONDS = 1;

/**
 * Cells named individually in one damage event.
 *
 * TWELVE, and the count is the same for a tornado and a cyclone even though
 * their footprints differ by three orders of magnitude — because this is a
 * SAMPLE for consumers with no spatial index, not an enumeration (see
 * StormDamageEvent's doc comment). A consumer that owns an index reads
 * `x`/`y`/`radius` and answers the question exactly; one that does not gets
 * twelve places a tree could fall, which at 1 Hz for eight minutes is nearly
 * six thousand chances across a cyclone's life.
 */
export const DAMAGE_SAMPLE_CELLS = 12;

/**
 * How hard the wind blows at `distance` from the eye, as a fraction of the
 * storm's intensity.
 *
 * TWO SHAPES, and the difference is the eye. A tornado is strongest in the
 * middle and falls off quadratically — the quadratic rather than a linear
 * ramp because a funnel's damage is famously abrupt at its edge, and `1 - r²`
 * holds near 1 for the inner half of the radius. A cyclone is CALM in the
 * middle: nothing inside the eye, peak at the eyewall, falling to nothing at
 * the rim. A player who notices that the middle of a hurricane is quiet has
 * noticed something true.
 */
export function windFalloff(kind: StormKind, distance: number, radius: number): number {
  if (radius <= 0) return 0;
  const r = distance / radius;
  if (r >= 1) return 0;
  if (kind === 'tornado') return 1 - r * r;

  const eye = CYCLONE_EYE_RADIUS_FRACTION;
  if (r <= eye) return 0;
  // Linear up the eyewall and linear back down to the rim, which is a triangle
  // peaking at `eye`. It is deliberately not smooth: the eyewall is the one
  // place in a hurricane where the wind really does change over a short
  // distance, and rounding it off would hide the only structure this shape has.
  return (1 - r) / (1 - eye);
}

/** Draws `DAMAGE_SAMPLE_CELLS` struck cells inside a storm's disc. */
function sampleStruckCells(
  storm: Storm,
  world: StormWorld,
  intensity: number,
): StormDamageEvent['cells'] {
  const cells: Array<{ x: number; y: number; severity: number }> = [];
  for (let i = 0; i < DAMAGE_SAMPLE_CELLS; i++) {
    const angle = rng.next() * Math.PI * 2;
    // Uniform over AREA again — without the sqrt every sample would bunch at
    // the eye, which for a cyclone is the one place the wind is not blowing.
    const distance = Math.sqrt(rng.next()) * storm.radius;
    const x = Math.round(storm.x + Math.cos(angle) * distance);
    const y = Math.round(storm.y + Math.sin(angle) * distance);
    if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
    const severity = intensity * windFalloff(storm.kind, distance, storm.radius);
    // A cell in the eye scores zero; reporting it would be reporting no damage
    // at a cell, which is a consumer's time spent on nothing.
    if (severity <= 0) continue;
    cells.push({ x, y, severity });
  }
  return cells;
}

/**
 * ONE SIM STEP: moves every storm, ages it, kills what the terrain kills, and
 * collects the events this tick owes.
 *
 * SPAWNING IS NOT HERE — it is ./index.ts's, because whether a storm may be
 * born depends on the operator's setting and this file is the physics. Keeping
 * the two apart is what lets `off` be a single early return up there rather
 * than a flag threaded through everything below.
 */
export function advanceStorms(world: StormWorld, dt: number): StormTickResult {
  const damage: StormDamageEvent[] = [];
  const landfalls: StormLandfallEvent[] = [];
  let changed = false;

  for (let index = storms.length - 1; index >= 0; index--) {
    const storm = storms[index]!;
    const profile = profileFor(storm.kind);
    changed = true;

    // THE THREE THINGS THE DEV FREEZE SKIPS — movement, ageing and weakening.
    // Everything below them (landfall, damage, the wire) runs either way; see
    // setDevFrozen for why this exists at all.
    let hostile = 0;
    if (!devFrozen) {
      // TRACK. The heading wanders on a bounded random walk, exactly as
      // weather's wind does, so a storm curves instead of ruling a line across
      // the map.
      storm.heading += (rng.next() * 2 - 1) * profile.veerRadiansPerSecond * dt;
      storm.x += Math.cos(storm.heading) * profile.speedCellsPerSecond * dt;
      storm.y += Math.sin(storm.heading) * profile.speedCellsPerSecond * dt;

      // LIFE. Counted down rather than re-rolled, so it survives a snapshot.
      if (!storm.retiring) {
        storm.lifeSeconds -= dt;
        if (storm.lifeSeconds <= 0) storm.retiring = true;
      }

      // ENVELOPE. Linear, not exponential, so the fade ARRIVES: "the envelope
      // reached zero" is the removal condition, and an exponential approach
      // never gets there. (weather's advanceWeather makes the same argument.)
      hostile = hostileTerrainFraction(storm, world);
      const terrainDecay = hostile * profile.hostileTerrainDecayPerSecond * dt;
      storm.envelope = storm.retiring
        ? Math.max(0, storm.envelope - dt / profile.fadeSeconds - terrainDecay)
        : Math.min(1, Math.max(0, storm.envelope + dt / profile.spinUpSeconds - terrainDecay));
    }

    const intensity = storm.peakIntensity * storm.envelope;

    // LANDFALL, once per storm, on the tick the EYE first has land under it.
    // The eye rather than the disc, because "the storm came ashore" is about
    // where its centre is — a hurricane's outer arms are over land for an hour
    // before anyone would say it had landed.
    if (storm.kind === 'cyclone' && !storm.landfallReported) {
      const ex = Math.round(storm.x);
      const ey = Math.round(storm.y);
      const inside = ex >= 0 && ey >= 0 && ex < world.worldSize && ey < world.worldSize;
      if (inside && !isWaterAt(world, ex, ey)) {
        storm.landfallReported = true;
        landfalls.push({
          stormId: storm.id,
          kind: storm.kind,
          x: roundBroadcastPosition(storm.x),
          y: roundBroadcastPosition(storm.y),
          intensity: roundBroadcastIntensity(intensity),
          ...(storm.name === undefined ? {} : { name: storm.name }),
        });
      }
    }

    // DAMAGE, on its own cadence. The debt is accumulated in seconds rather
    // than in ticks so the interval means the same thing at any TICK_HZ, and it
    // is carried on the storm so two storms born a tick apart do not both fire
    // on the same tick forever.
    storm.damageDebtSeconds += dt;
    if (storm.damageDebtSeconds >= DAMAGE_INTERVAL_SECONDS && intensity > 0) {
      const durationSeconds = storm.damageDebtSeconds;
      storm.damageDebtSeconds = 0;
      damage.push({
        stormId: storm.id,
        kind: storm.kind,
        x: roundBroadcastPosition(storm.x),
        y: roundBroadcastPosition(storm.y),
        radius: roundBroadcastPosition(storm.radius),
        eyeRadius:
          storm.kind === 'cyclone'
            ? roundBroadcastPosition(storm.radius * CYCLONE_EYE_RADIUS_FRACTION)
            : 0,
        intensity: roundBroadcastIntensity(intensity),
        durationSeconds,
        cells: sampleStruckCells(storm, world, intensity),
      });
    }

    // DEATH. A storm whose envelope has reached zero AFTER it began to spin up
    // is finished — the `retiring || hostile` guard is what stops a newborn
    // being removed on its first tick, when its envelope is legitimately still
    // zero.
    const spentOut = storm.envelope <= 0 && (storm.retiring || hostile > 0);
    if (!devFrozen && (spentOut || hasLeftWorld(storm, world.worldSize))) {
      storms.splice(index, 1);
    }
  }

  return { changed, damage, landfalls };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRE.

/**
 * The storms as they go on the wire.
 *
 * Positions, radii and velocities are rounded to BROADCAST_POSITION_DECIMALS
 * and intensity to STORM_INTENSITY_DECIMALS on the way out, which is what makes
 * the payload's encoded size bounded and exactly assertable.
 *
 * VELOCITY IS DERIVED FROM THE HEADING here rather than stored, because the
 * heading is what the sim integrates and a stored vx/vy would be a second copy
 * of it that could disagree after a veer.
 */
export function stormStates(): StormState[] {
  return storms.map((storm) => {
    const profile = profileFor(storm.kind);
    return {
      id: storm.id,
      kind: storm.kind,
      x: roundBroadcastPosition(storm.x),
      y: roundBroadcastPosition(storm.y),
      radius: roundBroadcastPosition(storm.radius),
      intensity: roundBroadcastIntensity(storm.peakIntensity * storm.envelope),
      vx: roundBroadcastPosition(Math.cos(storm.heading) * profile.speedCellsPerSecond),
      vy: roundBroadcastPosition(Math.sin(storm.heading) * profile.speedCellsPerSecond),
      ...(storm.name === undefined ? {} : { name: storm.name }),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE — the snapshot shape, owned here because this file owns the state.

export interface StormSnapshot {
  readonly nextStormId: number;
  readonly namedCycloneCount: number;
  readonly rngState: number;
  readonly storms: readonly Storm[];
}

export function stormSnapshot(): StormSnapshot {
  return {
    nextStormId,
    namedCycloneCount,
    rngState: rng.state(),
    // Copied rather than handed out live: the slice is serialised by the host
    // after this returns, and a tick between the two would otherwise mutate
    // what is being written.
    storms: storms.map((storm) => ({ ...storm })),
  };
}

export function restoreStorms(snapshot: StormSnapshot): void {
  storms.length = 0;
  for (const storm of snapshot.storms) storms.push({ ...storm });
  nextStormId = snapshot.nextStormId;
  namedCycloneCount = snapshot.namedCycloneCount;
  rng = createStormRng(snapshot.rngState);
}

/**
 * The generator, for the spawn rolls ./index.ts owns.
 *
 * Exposed rather than duplicated: a second generator for spawning would be a
 * second thing to persist and a second sequence to reproduce, and the whole
 * argument for seeding this plugin at all is that ONE sequence explains a
 * world.
 */
export function spawnRoll(ratePerSecond: number, dt: number): boolean {
  return rollEvent(rng, ratePerSecond, dt);
}

/**
 * The next value of the same sequence, for ./surge.ts's siting draws.
 *
 * A function rather than the generator itself, so nothing outside this file can
 * reach `state()` and mint a second generator from it — the persistence slice
 * is the only thing that gets to know where the sequence is.
 */
export function stormRandom(): number {
  return rng.next();
}
