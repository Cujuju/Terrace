// THE ROTATING-STORM SIM ENGINE — where a storm goes once it exists, how it
// weakens, what kills it, and what the wind hits on the way.
//
// ONE ENGINE, ONE PROFILE PER INSTANCE. Everything that differs between a small
// fast funnel and a large slow spiral is a number in the profile its owner hands
// in; every rule — spin-up, the terrain that weakens it, the life countdown, the
// fade, the damage footprint, the snapshot — is written once against that
// profile. Before 2026-09-02 the two kinds were two constant tables inside one
// plugin and the sim branched on a `kind` string; now they are two plugins, each
// holding one instance of this, and there is no kind for anything here to branch
// on.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LIFE OF A STORM, in the four fields that describe it.
//
//   envelope   0 → 1 → 0. Spins up at birth, falls as the storm dies. The
//              intensity on the wire is peakIntensity × envelope, so a storm is
//              never seen appearing or vanishing.
//   retiring   Set once, when the life countdown runs out. It never un-sets:
//              a dying storm does not come back, which is what makes "envelope
//              reached zero" a safe removal condition.
//   lifeSeconds  Drawn ONCE from an exponential and counted down, so it survives
//              a snapshot. A per-tick death roll would re-draw the whole
//              remaining life on every boot.
//   hostile terrain  A storm over the ground its profile calls hostile decays on
//              top of everything else. It is a RATE, not a switch: a storm that
//              clips a headland is weakened, one that parks over a continent
//              dies.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT READS AND WHAT IT WRITES.
//
// It reads `heightAt` (is this cell under the sea?) and `worldSize`, and it
// writes nothing at all: no terrain, no wire, no events — it RETURNS what one
// tick produced and its owner decides what any of that means. The one thing in
// this family that writes terrain (a storm surge) is a plugin's own module and
// takes a WorldApi explicitly, so a reader of this file can see at the type
// level that nothing here can move the ground.
//
// SITING IS NOT HERE EITHER. Where a storm may be born is the one rule that is
// genuinely per-plugin — inside a cloud, or over open water — so `trySpawn`
// takes the draw as an argument and this file only counts the attempts.
//
// LOCKED TERRAIN IS READ FREELY. Every caller's broadcast goes out through
// `WorldApi.broadcastVisible`, so a storm over locked water is a storm nobody is
// told about; the sim itself is allowed to know where the sea is.

import {
  SEA_LEVEL,
  createSeededRng,
  exponentialWaitSeconds,
  isFiniteNumber,
  parseRecordArray,
  randomInRange,
  rollEvent,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type RotatingStormState,
} from '@terrace/shared';

/**
 * The narrow world this sim needs — `worldSize` and `heightAt`, named exactly as
 * WorldApi names them so a WorldApi can be handed straight in with no adapter
 * object built per call (the same structural-typing trick shared's
 * TerrainSampler relies on).
 *
 * NARROW ON PURPOSE: it is the list of things a storm is allowed to know about
 * the world, and it does not include `sculpt`.
 */
export interface RotatingStormWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PROFILE — everything one owner's storms do differently from another's.

/** Which ground weakens a storm of this profile, and which is home. */
export type HostileTerrain = 'land' | 'water';

export interface RotatingStormProfile {
  /** Cells per second the eye travels. */
  readonly speedCellsPerSecond: number;
  /** Radians per second the track curves. A storm that goes straight is a dart. */
  readonly veerRadiansPerSecond: number;
  /** Mean seconds a storm lives, before terrain kills it. */
  readonly meanLifetimeSeconds: number;
  /** Seconds the envelope takes to climb from 0 to 1 at birth. */
  readonly spinUpSeconds: number;
  /** Seconds the envelope takes to fall from 1 to 0 once retiring. */
  readonly fadeSeconds: number;
  /**
   * Extra envelope lost per second at FULL exposure to the terrain this profile
   * calls hostile. Scaled by how much of the disc is over it, so a graze costs a
   * little and a parking costs everything.
   */
  readonly hostileTerrainDecayPerSecond: number;
  /** Weakest and strongest a storm gets, at full envelope. */
  readonly minPeakIntensity: number;
  readonly maxPeakIntensity: number;
  /** How many storms of this profile may exist at once. */
  readonly maxActive: number;
  /** The ground that decays this storm — the complement is where it is at home. */
  readonly hostileTerrain: HostileTerrain;
  /**
   * The calm middle this storm's wind does NOT cover, as a fraction of its own
   * radius. 0 for a storm that is strongest in the middle.
   *
   * A FRACTION rather than a length because it is a fact about the SHAPE of a
   * storm, and a shape scales with the thing it is the shape of.
   */
  readonly eyeRadiusFraction: number;
  /**
   * How hard the wind blows at `r` — the distance from the eye as a fraction of
   * the radius, always in [0, 1) — as a fraction of the storm's intensity.
   *
   * SUPPLIED, NOT CHOSEN HERE, because the shape of a storm's wind field is the
   * one piece of physics that is genuinely about what kind of storm it is: one
   * profile peaks in the middle and falls off quadratically, another is calm in
   * the eye and peaks at the eyewall. An engine that carried both would be an
   * engine with a kind in it.
   */
  windFalloff(r: number): number;
}

/** How one population of rotating storms is configured. */
export interface RotatingStormsSpec {
  readonly profile: RotatingStormProfile;
  /**
   * The generator's starting state.
   *
   * SEEDED AND PERSISTED, because a storm is not a thing that can be forgotten:
   * it is persisted, it emits events other plugins act on destructively, and its
   * owner may sculpt the shore under it. "A typhoon ate my harbour" has to be
   * reproducible from a snapshot and a bug report. The generator's whole state
   * is one uint32, so persisting it costs one number in the slice.
   */
  readonly seed: number;
  /** A storm's radius on a world of this size, in cells. Fixed for its life. */
  radiusFor(worldSize: number): number;
  /**
   * The name the Nth named storm of this world gets, or absent for an owner
   * whose storms are anonymous. `index` counts named storms and is persisted, so
   * a restarted world resumes the roster rather than starting it again.
   */
  nameFor?(index: number, x: number, y: number, worldSize: number): string;
  /**
   * Whether this owner wants to be told the tick its storm's EYE first has land
   * under it. Absent means it does not, and `landfalls` is always empty.
   */
  readonly reportsLandfall?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED CONSTANTS — the rules that are the same whatever the profile.

/**
 * Attempts made to find a spawn site before giving up on this roll.
 *
 * SIX, and a failed roll is simply a roll that produced nothing — not a retry
 * next tick and not a relaxed test. The disc-systems engine's siting works the
 * same way and for the same reason: a world with no open water should grow no
 * cyclones, and the honest way to express that is a siting test that keeps
 * failing, not a fallback that puts one somewhere unsuitable.
 */
export const ROTATING_STORM_SITING_ATTEMPTS = 6;

/**
 * Sample offsets, in units of the disc's own radius, used to ask "how much of
 * this disc is over water?".
 *
 * THIRTEEN SAMPLES — the centre plus two rings of six — rather than every cell
 * under the storm, which at a large radius is eleven thousand `heightAt` calls
 * per tick. A disc this size is either at sea or it is not; thirteen samples
 * resolve that, and the number it produces is used as a RATE multiplier, where
 * being one sample out changes a decay by 8% for one tick.
 *
 * Two rings at 0.55 and 1.0 of the radius, offset 30° from each other so the
 * pattern has no axis: a single ring would report a strait as open ocean if the
 * strait happened to run between two spokes.
 */
export const ROTATING_STORM_DISC_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = (() => {
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
 * How far past the world edge a storm may drift before it is forgotten, in
 * multiples of its own radius.
 *
 * 1.5 — the disc-systems engine's despawn margin, and for its reason: at 1.0 the
 * disc's near edge is exactly on the map boundary when it is removed, which a
 * player standing on the coast can watch happen. Half a radius further out and
 * the last of it is already gone.
 */
export const ROTATING_STORM_DESPAWN_MARGIN_RADII = 1.5;

/**
 * Seconds of storm one damage event accounts for.
 *
 * ONE SECOND, not one tick. A tick is 100 ms at the shipped TICK_HZ, and a
 * fan-out through every installed plugin's `onWorldEvent` ten times a second per
 * storm is a cost no consumer asked for — a tree does not need to be told about
 * the wind at 10 Hz to fall down. One second is also a round number for
 * `durationSeconds`, which is what lets a consumer turn a severity into a rate
 * without knowing this server's tick rate.
 */
export const ROTATING_STORM_DAMAGE_INTERVAL_SECONDS = 1;

/**
 * Cells named individually in one damage event.
 *
 * TWELVE, and the count is the same for a small storm and a large one even
 * though their footprints differ by three orders of magnitude — because this is
 * a SAMPLE for consumers with no spatial index, not an enumeration. A consumer
 * that owns an index reads `x`/`y`/`radius` and answers the question exactly;
 * one that does not gets twelve places a tree could fall, which at 1 Hz for
 * eight minutes is nearly six thousand chances across a large storm's life.
 */
export const ROTATING_STORM_DAMAGE_SAMPLE_CELLS = 12;

// ─────────────────────────────────────────────────────────────────────────────
// STATE.

/** One live storm. Mutable; the tick loop writes it in place. */
export interface RotatingStorm {
  readonly id: number;
  /** Cell-space centre. May be outside the world — a storm drifts in. */
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
  /** `Hurricane Ada`, when this owner names its storms. */
  readonly name?: string;
  /** True once the eye has been over land. Makes landfall a once-only event. */
  landfallReported: boolean;
  /** Seconds of storm not yet accounted for by a damage event. */
  damageDebtSeconds: number;
  /**
   * Seconds banked toward whatever periodic work the OWNER does per storm — a
   * shoreline surge, in the one caller that has any. This engine never reads it:
   * it exists here because it is state OF A STORM that has to survive a restart
   * with the storm, and a side table beside the roster needed its own reset and
   * prune to stay in step with it (review 2026-08-28). An owner with no such
   * work leaves it at zero forever.
   */
  ownerDebtSeconds: number;
}

/** One tick's worth of wind damage from one storm, for its owner to publish. */
export interface RotatingStormDamage {
  readonly stormId: number;
  /** The eye, in cells. */
  readonly x: number;
  readonly y: number;
  /** The disc the wind covers, in cells. */
  readonly radius: number;
  /** The calm middle the wind does NOT cover. 0 for a profile with no eye. */
  readonly eyeRadius: number;
  /** The storm's own strength in [0, 1] — the ceiling on any cell's severity. */
  readonly intensity: number;
  /** Seconds of storm this event accounts for, so a rate can be recovered. */
  readonly durationSeconds: number;
  /** A bounded sample of cells the wind struck. */
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly severity: number;
  }>;
}

/** The tick a storm's eye first crossed onto land. */
export interface RotatingStormLandfall {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly intensity: number;
  readonly name?: string;
}

/** What one tick of the sim produced, for the owner to publish. */
export interface RotatingStormTick {
  /** True when any storm moved, was born or died — i.e. clients are stale. */
  readonly changed: boolean;
  /** Damage events due this tick, at most one per storm. */
  readonly damage: readonly RotatingStormDamage[];
  /** Eyes that crossed onto land this tick. At most one per storm. */
  readonly landfalls: readonly RotatingStormLandfall[];
}

/** Everything a world has to remember about its storms. */
export interface RotatingStormsSnapshot {
  readonly nextStormId: number;
  readonly namedCount: number;
  readonly rngState: number;
  readonly storms: readonly RotatingStorm[];
}

/** One population of rotating storms. */
export interface RotatingStorms {
  /** How many attempts a birth gets — ROTATING_STORM_SITING_ATTEMPTS. */
  readonly sitingAttempts: number;
  /** How many of these storms may be in the air at once — the profile's cap. */
  readonly maxActive: number;
  /**
   * The next value of the ONE seeded sequence that explains this world.
   *
   * Exposed rather than duplicated: a second generator for an owner's own draws
   * would be a second thing to persist and a second sequence to reproduce.
   */
  random(): number;
  /** Did a Poisson event of this rate fire during `dt` seconds? */
  rollSpawn(ratePerSecond: number, dt: number): boolean;
  /** The living storms, in birth order. */
  storms(): readonly RotatingStorm[];
  count(): number;
  /**
   * ONE BIRTH ROLL. `drawSite` is called up to `sitingAttempts` times with this
   * engine's own generator and returns a centre it is happy with, or null to
   * spend an attempt. The FIRST accepted centre is born on; null means this roll
   * produced nothing, which is the correct outcome for a world with nowhere to
   * put one.
   */
  trySpawn(
    world: RotatingStormWorld,
    drawSite: (random: () => number) => { readonly x: number; readonly y: number } | null,
  ): RotatingStorm | null;
  /**
   * BIRTHS A STORM AT AN EXACT CELL, SKIPPING EVERY SITING TEST — the seam a dev
   * force-spawn and an admin action need. Deliberately not the ordinary path:
   * the siting rules are what an owner exists to enforce, and this bypasses
   * them. The radius and the name still come from the same spec the real
   * spawner uses, so a forced storm is identical to a natural one in every
   * respect except where it was put.
   */
  spawnAt(world: RotatingStormWorld, x: number, y: number): RotatingStorm;
  /**
   * ONE SIM STEP: moves every storm, ages it, kills what the terrain kills, and
   * collects the events this tick owes. Iterating backwards is what lets the
   * removal splice inside the same pass.
   */
  advance(world: RotatingStormWorld, dt: number): RotatingStormTick;
  /** The storms as they go on the wire, at the broadcast precision. */
  states(): RotatingStormState[];
  snapshot(): RotatingStormsSnapshot;
  /** REPLACES the population, the generator and the counters. */
  restore(snapshot: RotatingStormsSnapshot): void;
  /**
   * Drops all state so a suite (or a boot) starts from zero: no storms, a fresh
   * generator, and both counters rewound. The generator is re-seeded from the
   * FIXED seed rather than left where it was, so a process that creates two
   * worlds does not hand the second one the first one's tail (PersistenceSlice's
   * re-runnable rule — a load followed by a worldCreate must REPLACE state).
   */
  reset(): void;
  /**
   * Drops every live storm, keeping the generator and the name counter where
   * they are — the dev force-spawn's seam. Nothing on the tick path calls it.
   */
  clear(): void;
  /**
   * THE DEV FREEZE — storms stop moving, ageing and weakening.
   *
   * WHY IT HAD TO EXIST, and it is not a convenience. A small storm travels ten
   * cells a second and lives about a minute; a headless client renders this
   * world at one to four frames a second under software GL, so a screenshot
   * takes minutes. A forced funnel was therefore always dead — and usually out
   * at sea, since water kills one in four seconds — before a single frame of it
   * reached the file.
   *
   * WHAT IT DOES NOT STOP: the damage events. A frozen storm still emits, so the
   * seam every consumer plugin will attach to is exercised exactly as it would
   * be in a live world, and a frozen fixture is not a different code path
   * pretending to be this one.
   */
  freeze(frozen: boolean): void;
  isFrozen(): boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// TERRAIN.

/** Is this cell under the sea? The one terrain question this sim asks. */
function isWaterAt(world: RotatingStormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

/**
 * The fraction of a disc that is over water, in [0, 1], from
 * ROTATING_STORM_DISC_SAMPLE_OFFSETS.
 *
 * A sample OUTSIDE the world counts as water. That is not a shortcut: the world
 * is an island in an unbounded sea (every renderer draws it that way), so beyond
 * the edge is ocean, and treating it as land would make a storm born off the
 * coast decay as if it had come ashore.
 */
export function waterFractionUnder(
  world: RotatingStormWorld,
  x: number,
  y: number,
  radius: number,
): number {
  let water = 0;
  for (const [dx, dy] of ROTATING_STORM_DISC_SAMPLE_OFFSETS) {
    const sx = Math.round(x + dx * radius);
    const sy = Math.round(y + dy * radius);
    const outside = sx < 0 || sy < 0 || sx >= world.worldSize || sy >= world.worldSize;
    if (outside || isWaterAt(world, sx, sy)) water++;
  }
  return water / ROTATING_STORM_DISC_SAMPLE_OFFSETS.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE PARSING — owned here, because this file owns the record shape.
//
// STRUCTURAL VALIDATION ON LOAD, exactly as every plugin's slice does: the saved
// blob comes from a database file that may predate this code, so a shape that
// does not parse is DISCARDED WHOLE rather than half-applied. What discarding
// costs is cheap and worth stating: the world loses whatever storms were in the
// air and starts its roster again. Nothing permanent goes with them — the only
// permanent thing a storm does is a sculpt, which core has already saved.

function parseStorm(value: unknown): RotatingStorm | null {
  if (typeof value !== 'object' || value === null) return null;
  const {
    id,
    x,
    y,
    radius,
    heading,
    peakIntensity,
    envelope,
    retiring,
    lifeSeconds,
    name,
    landfallReported,
    damageDebtSeconds,
    ownerDebtSeconds,
  } = value as Record<string, unknown>;

  if (!Number.isInteger(id)) return null;
  for (const number of [x, y, radius, heading, peakIntensity, envelope, lifeSeconds]) {
    if (!isFiniteNumber(number)) return null;
  }
  if (!isFiniteNumber(damageDebtSeconds) || damageDebtSeconds < 0) return null;
  // Absent in a slice written by a build that had no owner-side periodic work; a
  // missing debt is a debt of zero, not a corrupt storm.
  const ownerDebt = ownerDebtSeconds === undefined ? 0 : ownerDebtSeconds;
  if (!isFiniteNumber(ownerDebt) || ownerDebt < 0) return null;
  if (typeof retiring !== 'boolean' || typeof landfallReported !== 'boolean') return null;
  if (name !== undefined && typeof name !== 'string') return null;

  return {
    id: id as number,
    x: x as number,
    y: y as number,
    radius: radius as number,
    heading: heading as number,
    peakIntensity: peakIntensity as number,
    envelope: envelope as number,
    retiring: retiring as boolean,
    lifeSeconds: lifeSeconds as number,
    ...(typeof name === 'string' ? { name } : {}),
    landfallReported: landfallReported as boolean,
    damageDebtSeconds: damageDebtSeconds as number,
    ownerDebtSeconds: ownerDebt,
  };
}

/** Parses what `snapshot()` produced, or null for anything else. */
export function parseRotatingStormsSnapshot(data: unknown): RotatingStormsSnapshot | null {
  if (typeof data !== 'object' || data === null) return null;
  const { nextStormId, namedCount, rngState, storms } = data as Record<string, unknown>;
  if (!Number.isInteger(nextStormId) || !Number.isInteger(namedCount)) return null;
  if (!Number.isInteger(rngState)) return null;
  const parsed = parseRecordArray(storms, parseStorm);
  if (parsed === null) return null;
  return {
    nextStormId: nextStormId as number,
    namedCount: namedCount as number,
    rngState: rngState as number,
    storms: parsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE.

export function createRotatingStorms(spec: RotatingStormsSpec): RotatingStorms {
  const { profile } = spec;
  const storms: RotatingStorm[] = [];
  let nextStormId = 1;
  /** How many storms this world has named — the index into the owner's roster. */
  let namedCount = 0;
  let rng = createSeededRng(spec.seed);
  /** Set ONLY by a dev force-spawn. Every real deployment leaves it false. */
  let frozen = false;

  function birth(
    world: RotatingStormWorld,
    x: number,
    y: number,
    name: string | undefined,
  ): RotatingStorm {
    const storm: RotatingStorm = {
      id: nextStormId++,
      x,
      y,
      radius: spec.radiusFor(world.worldSize),
      // Drawn before the intensity and the life, and this order is the
      // sequence: a seeded replay depends on it.
      heading: rng.next() * Math.PI * 2,
      peakIntensity: randomInRange(rng.next, profile.minPeakIntensity, profile.maxPeakIntensity),
      envelope: 0,
      retiring: false,
      lifeSeconds: exponentialWaitSeconds(rng.next, profile.meanLifetimeSeconds),
      ...(name === undefined ? {} : { name }),
      landfallReported: false,
      damageDebtSeconds: 0,
      ownerDebtSeconds: 0,
    };
    storms.push(storm);
    return storm;
  }

  /** The next name off the owner's roster, or undefined for anonymous storms. */
  function nextName(world: RotatingStormWorld, x: number, y: number): string | undefined {
    if (spec.nameFor === undefined) return undefined;
    return spec.nameFor(namedCount++, x, y, world.worldSize);
  }

  function hasLeftWorld(storm: RotatingStorm, worldSize: number): boolean {
    const margin = storm.radius * ROTATING_STORM_DESPAWN_MARGIN_RADII;
    return (
      storm.x < -margin ||
      storm.y < -margin ||
      storm.x > worldSize + margin ||
      storm.y > worldSize + margin
    );
  }

  /**
   * How exposed a storm is to the terrain that kills it, in [0, 1].
   *
   * ONE EXPRESSION FOR BOTH ANSWERS, because they are complements of each other:
   * a storm killed by land is exposed by the land fraction, one killed by water
   * by the water fraction.
   */
  function hostileTerrainFraction(storm: RotatingStorm, world: RotatingStormWorld): number {
    const water = waterFractionUnder(world, storm.x, storm.y, storm.radius);
    return profile.hostileTerrain === 'land' ? 1 - water : water;
  }

  /** Draws ROTATING_STORM_DAMAGE_SAMPLE_CELLS struck cells inside a storm's disc. */
  function sampleStruckCells(
    storm: RotatingStorm,
    world: RotatingStormWorld,
    intensity: number,
  ): RotatingStormDamage['cells'] {
    const cells: Array<{ x: number; y: number; severity: number }> = [];
    for (let i = 0; i < ROTATING_STORM_DAMAGE_SAMPLE_CELLS; i++) {
      const angle = rng.next() * Math.PI * 2;
      // Uniform over AREA — without the sqrt every sample would bunch at the
      // eye, which for a storm with one is the one place the wind is not
      // blowing.
      const distance = Math.sqrt(rng.next()) * storm.radius;
      const x = Math.round(storm.x + Math.cos(angle) * distance);
      const y = Math.round(storm.y + Math.sin(angle) * distance);
      if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
      const severity = intensity * windFalloffAt(distance, storm.radius);
      // A cell in the eye scores zero; reporting it would be reporting no damage
      // at a cell, which is a consumer's time spent on nothing.
      if (severity <= 0) continue;
      cells.push({ x, y, severity });
    }
    return cells;
  }

  /**
   * The profile's wind field, with the two guards that are not its business: a
   * storm with no extent blows nothing, and nothing outside the disc is struck.
   */
  function windFalloffAt(distance: number, radius: number): number {
    if (radius <= 0) return 0;
    const r = distance / radius;
    if (r >= 1) return 0;
    return profile.windFalloff(r);
  }

  return {
    sitingAttempts: ROTATING_STORM_SITING_ATTEMPTS,
    maxActive: profile.maxActive,

    random(): number {
      return rng.next();
    },

    rollSpawn(ratePerSecond: number, dt: number): boolean {
      return rollEvent(rng.next, ratePerSecond, dt);
    },

    storms(): readonly RotatingStorm[] {
      return storms;
    },

    count(): number {
      return storms.length;
    },

    trySpawn(
      world: RotatingStormWorld,
      drawSite: (random: () => number) => { readonly x: number; readonly y: number } | null,
    ): RotatingStorm | null {
      for (let attempt = 0; attempt < ROTATING_STORM_SITING_ATTEMPTS; attempt++) {
        const site = drawSite(rng.next);
        if (site === null) continue;
        return birth(world, site.x, site.y, nextName(world, site.x, site.y));
      }
      return null;
    },

    spawnAt(world: RotatingStormWorld, x: number, y: number): RotatingStorm {
      return birth(world, x, y, nextName(world, x, y));
    },

    advance(world: RotatingStormWorld, dt: number): RotatingStormTick {
      const damage: RotatingStormDamage[] = [];
      const landfalls: RotatingStormLandfall[] = [];
      let changed = false;

      for (let index = storms.length - 1; index >= 0; index--) {
        const storm = storms[index]!;
        changed = true;

        // THE THREE THINGS THE DEV FREEZE SKIPS — movement, ageing and
        // weakening. Everything below them (landfall, damage, the wire) runs
        // either way; see `freeze` for why this exists at all.
        let hostile = 0;
        if (!frozen) {
          // TRACK. The heading wanders on a bounded random walk, exactly as the
          // world's wind does, so a storm curves instead of ruling a line across
          // the map.
          storm.heading += (rng.next() * 2 - 1) * profile.veerRadiansPerSecond * dt;
          storm.x += Math.cos(storm.heading) * profile.speedCellsPerSecond * dt;
          storm.y += Math.sin(storm.heading) * profile.speedCellsPerSecond * dt;

          // LIFE. Counted down rather than re-rolled, so it survives a snapshot.
          if (!storm.retiring) {
            storm.lifeSeconds -= dt;
            if (storm.lifeSeconds <= 0) storm.retiring = true;
          }

          // ENVELOPE. Linear, not exponential, so the fade ARRIVES: "the
          // envelope reached zero" is the removal condition, and an exponential
          // approach never gets there.
          hostile = hostileTerrainFraction(storm, world);
          const terrainDecay = hostile * profile.hostileTerrainDecayPerSecond * dt;
          storm.envelope = storm.retiring
            ? Math.max(0, storm.envelope - dt / profile.fadeSeconds - terrainDecay)
            : Math.min(
                1,
                Math.max(0, storm.envelope + dt / profile.spinUpSeconds - terrainDecay),
              );
        }

        const intensity = storm.peakIntensity * storm.envelope;

        // LANDFALL, once per storm, on the tick the EYE first has land under it.
        // The eye rather than the disc, because "the storm came ashore" is about
        // where its centre is — a large storm's outer arms are over land for an
        // hour before anyone would say it had landed.
        if (spec.reportsLandfall === true && !storm.landfallReported) {
          const ex = Math.round(storm.x);
          const ey = Math.round(storm.y);
          const inside = ex >= 0 && ey >= 0 && ex < world.worldSize && ey < world.worldSize;
          if (inside && !isWaterAt(world, ex, ey)) {
            storm.landfallReported = true;
            landfalls.push({
              stormId: storm.id,
              x: roundBroadcastPosition(storm.x),
              y: roundBroadcastPosition(storm.y),
              intensity: roundBroadcastIntensity(intensity),
              ...(storm.name === undefined ? {} : { name: storm.name }),
            });
          }
        }

        // DAMAGE, on its own cadence. The debt is accumulated in seconds rather
        // than in ticks so the interval means the same thing at any TICK_HZ, and
        // it is carried on the storm so two storms born a tick apart do not both
        // fire on the same tick forever.
        storm.damageDebtSeconds += dt;
        if (
          storm.damageDebtSeconds >= ROTATING_STORM_DAMAGE_INTERVAL_SECONDS &&
          intensity > 0
        ) {
          const durationSeconds = storm.damageDebtSeconds;
          storm.damageDebtSeconds = 0;
          damage.push({
            stormId: storm.id,
            x: roundBroadcastPosition(storm.x),
            y: roundBroadcastPosition(storm.y),
            radius: roundBroadcastPosition(storm.radius),
            eyeRadius: roundBroadcastPosition(storm.radius * profile.eyeRadiusFraction),
            intensity: roundBroadcastIntensity(intensity),
            durationSeconds,
            cells: sampleStruckCells(storm, world, intensity),
          });
        }

        // DEATH. A storm whose envelope has reached zero AFTER it began to spin
        // up is finished — the `retiring || hostile` guard is what stops a
        // newborn being removed on its first tick, when its envelope is
        // legitimately still zero.
        const spentOut = storm.envelope <= 0 && (storm.retiring || hostile > 0);
        if (!frozen && (spentOut || hasLeftWorld(storm, world.worldSize))) {
          storms.splice(index, 1);
        }
      }

      return { changed, damage, landfalls };
    },

    /**
     * VELOCITY IS DERIVED FROM THE HEADING here rather than stored, because the
     * heading is what the sim integrates and a stored vx/vy would be a second
     * copy of it that could disagree after a veer.
     */
    states(): RotatingStormState[] {
      return storms.map((storm) => ({
        id: storm.id,
        x: roundBroadcastPosition(storm.x),
        y: roundBroadcastPosition(storm.y),
        radius: roundBroadcastPosition(storm.radius),
        intensity: roundBroadcastIntensity(storm.peakIntensity * storm.envelope),
        vx: roundBroadcastPosition(Math.cos(storm.heading) * profile.speedCellsPerSecond),
        vy: roundBroadcastPosition(Math.sin(storm.heading) * profile.speedCellsPerSecond),
        ...(storm.name === undefined ? {} : { name: storm.name }),
      }));
    },

    snapshot(): RotatingStormsSnapshot {
      return {
        nextStormId,
        namedCount,
        rngState: rng.state(),
        // Copied rather than handed out live: the slice is serialised by the
        // host after this returns, and a tick between the two would otherwise
        // mutate what is being written.
        storms: storms.map((storm) => ({ ...storm })),
      };
    },

    restore(snapshot: RotatingStormsSnapshot): void {
      storms.length = 0;
      for (const storm of snapshot.storms) storms.push({ ...storm });
      nextStormId = snapshot.nextStormId;
      namedCount = snapshot.namedCount;
      rng = createSeededRng(snapshot.rngState);
    },

    reset(): void {
      storms.length = 0;
      nextStormId = 1;
      namedCount = 0;
      rng = createSeededRng(spec.seed);
    },

    clear(): void {
      storms.length = 0;
    },

    freeze(value: boolean): void {
      frozen = value;
    },

    isFrozen(): boolean {
      return frozen;
    },
  };
}
