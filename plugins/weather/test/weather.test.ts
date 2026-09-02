// The weather sim, driven through the REAL plugin host on a REAL world.
//
// The three properties this suite exists to hold, because they are the ones the
// owner's brief actually asks for and the ones a retune could quietly break:
//
//   * DRIFT COHERENCE — a system moves as a whole, and every system moves
//     together. "Like regular weather patterns, it should move together in large
//     chunks."
//   * SPAWN AND DECAY BOUNDS — never more than the cap, never a radius outside
//     the band, never an intensity outside [0, 1], and both the arrival and the
//     death are Poisson processes with the stated means.
//   * BROADCAST SHAPE AND CADENCE — one message a second, carrying exactly what
//     protocol.ts says it carries, and parseable back by the client's own parser.
//
// Everything stochastic is driven through setWeatherRandomSource, so nothing
// here is a flaky statistical assertion where a deterministic one would do.

import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL, cellsAcross, createSeededRng } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin } from '../../../server/test/support/harness.ts';
import {
  WEATHER_KINDS,
  WEATHER_PLUGIN_NAME,
  WEATHER_SYSTEMS_MESSAGE,
  parseSystemsPayload,
  type WeatherKind,
} from '../protocol.ts';
import {
  BROADCAST_SYSTEM_CEILING,
  BROADCAST_TICK_INTERVAL,
  plugin as weatherPlugin,
  resetWeatherState,
} from '../server/index.ts';
import {
  pickWeightedIndex,
  rollEvent,
  setWeatherRandomSource,
} from '../server/rng.ts';
import {
  EFFECTIVE_SYSTEM_LIFETIME_SECONDS,
  MAX_ACTIVE_SYSTEMS,
  SNOW_ELEVATION_SAMPLES,
  SNOW_MIN_TERRAIN_HEIGHT,
  SYSTEM_DESPAWN_MARGIN_RADII,
  SYSTEM_FADE_SECONDS,
  SYSTEM_KIND_WEIGHTS,
  SYSTEM_MAX_RADIUS_CELLS,
  SYSTEM_MAX_RADIUS_WORLD_FRACTION,
  SYSTEM_MEAN_LIFETIME_SECONDS,
  SYSTEM_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS,
  SYSTEM_MIN_PEAK_INTENSITY,
  SYSTEM_MIN_RADIUS_CELLS,
  WIND_MAX_SPEED_CELLS_PER_SECOND,
  WIND_MIN_SPEED_CELLS_PER_SECOND,
  WIND_VEER_RADIANS_PER_SECOND,
  activeSystemCapFor,
  advanceWeather,
  currentWind,
  isSnowSite,
  livingSystems,
  maxRadiusFor,
  meanUnlockedHeightUnder,
  resetWeather,
  spawnSystem,
  systemStates,
  windVelocity,
  type WeatherWorld,
} from '../server/systems.ts';
import { worldWithTerrain } from './support/world.ts';

/** The shipped tick period: TICK_HZ 10 (docs/DESIGN.md). */
const TICK_SECONDS = 0.1;

/**
 * The nominal world — 512 WORLD UNITS square, in cells.
 *
 * STATED AS LAND (2026-08-21). A bare 512 was the nominal world only while a
 * cell was a world unit; afterwards it is a 128-unit world, the smallest one
 * shipped, where the radius fraction binds instead of never binding — the
 * exact opposite of what this constant is here to provide.
 */
const WORLD_SIZE = cellsAcross(512);

/** A world with no land at all — a fresh Terrace world's shape. */
function flatSeaWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
}

/**
 * A world that is entirely highland: every cell four bands up, so every
 * candidate centre is a legal snow site and siting never has to reject.
 */
function highlandWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL + 4 * BAND_HEIGHT);
}

/** The World as the plugin reads it: core calls the field `size`, the API `worldSize`. */
function asWeatherWorld(world: World): WeatherWorld {
  return {
    worldSize: world.size,
    heightAt: (x, y) => world.heightAt(x, y),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

/** mulberry32 — a named stream, so every stochastic assertion is reproducible. */
function seededRandom(seed: number): () => number {
  return createSeededRng(seed).next;
}

/** A source that yields a fixed list and then repeats its last value forever. */
function scriptedRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

beforeEach(() => {
  setWeatherRandomSource(seededRandom(20260814));
  resetWeatherState();
});

// ── The Poisson primitive ────────────────────────────────────────────────────

describe('rollEvent', () => {
  it('is 1 - e^(-rate·dt), not the linear approximation', () => {
    // Two ticks of 0.1 s must compose to exactly one tick of 0.2 s. That is the
    // property the naive `random() < rate·dt` breaks, and breaking it would make
    // the weather's frequency depend on the host's TICK_HZ.
    const rate = 1 / 90;
    const oneStep = 1 - Math.exp(-rate * 0.2);
    const twoSteps = 1 - (1 - (1 - Math.exp(-rate * 0.1))) ** 2;
    expect(twoSteps).toBeCloseTo(oneStep, 12);
  });

  it('never fires on a non-positive rate or a non-finite dt', () => {
    setWeatherRandomSource(() => 0);
    expect(rollEvent(0, 1)).toBe(false);
    expect(rollEvent(-1, 1)).toBe(false);
    expect(rollEvent(1, Number.NaN)).toBe(false);
    expect(rollEvent(1, Number.POSITIVE_INFINITY)).toBe(false);
    // …and does fire on a legitimate one, so the guards above are not passing
    // by accident.
    expect(rollEvent(1, 1)).toBe(true);
  });

  it('picks weighted indices in the declared order', () => {
    // The kind table is [rain 5, storm 2, snow 1.5, fog 1.5], total 10.
    const total = SYSTEM_KIND_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(10);
    setWeatherRandomSource(scriptedRandom([0]));
    expect(pickWeightedIndex(SYSTEM_KIND_WEIGHTS)).toBe(0);
    setWeatherRandomSource(scriptedRandom([0.6]));
    expect(pickWeightedIndex(SYSTEM_KIND_WEIGHTS)).toBe(1);
    setWeatherRandomSource(scriptedRandom([0.99]));
    expect(pickWeightedIndex(SYSTEM_KIND_WEIGHTS)).toBe(WEATHER_KINDS.length - 1);
  });
});

// ── Drift coherence: "moves together in large chunks" ────────────────────────

describe('drift coherence', () => {
  it('moves every system by exactly the same vector each tick', () => {
    const world = asWeatherWorld(highlandWorld());
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) spawnSystem(world);
    expect(livingSystems()).toHaveLength(MAX_ACTIVE_SYSTEMS);

    const before = livingSystems().map((system) => ({ x: system.x, y: system.y }));
    advanceWeather(world, TICK_SECONDS);
    const after = livingSystems().map((system) => ({ x: system.x, y: system.y }));
    expect(after).toHaveLength(before.length);

    const deltas = after.map((pose, index) => ({
      dx: pose.x - before[index]!.x,
      dy: pose.y - before[index]!.y,
    }));
    for (const delta of deltas) {
      expect(delta.dx).toBeCloseTo(deltas[0]!.dx, 12);
      expect(delta.dy).toBeCloseTo(deltas[0]!.dy, 12);
    }
    // …and it is the wind's own displacement, not merely a shared one.
    const { vx, vy } = windVelocity();
    expect(deltas[0]!.dx).toBeCloseTo(vx * TICK_SECONDS, 12);
    expect(deltas[0]!.dy).toBeCloseTo(vy * TICK_SECONDS, 12);
  });

  it('never changes a system’s radius — the mass moves as a whole', () => {
    const world = asWeatherWorld(highlandWorld());
    const system = spawnSystem(world);
    const radius = system.radius;
    for (let tick = 0; tick < 600; tick++) advanceWeather(world, TICK_SECONDS);
    // It may have died of old age or drifted off; if it is still here, its shape
    // is untouched.
    const survivor = livingSystems().find((live) => live.id === system.id);
    if (survivor !== undefined) expect(survivor.radius).toBe(radius);
  });

  it('keeps the wind inside its speed band and veers it slowly', () => {
    const world = asWeatherWorld(flatSeaWorld());
    let previousHeading = currentWind().heading;
    const maxVeerPerTick = WIND_VEER_RADIANS_PER_SECOND * TICK_SECONDS;

    for (let tick = 0; tick < 20000; tick++) {
      advanceWeather(world, TICK_SECONDS);
      const wind = currentWind();
      expect(wind.speed).toBeGreaterThanOrEqual(WIND_MIN_SPEED_CELLS_PER_SECOND);
      expect(wind.speed).toBeLessThanOrEqual(WIND_MAX_SPEED_CELLS_PER_SECOND);

      // Shortest angular distance, so the 2π wrap does not read as a huge veer.
      let delta = (wind.heading - previousHeading) % (Math.PI * 2);
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      expect(Math.abs(delta)).toBeLessThanOrEqual(maxVeerPerTick + 1e-12);
      previousHeading = wind.heading;
    }
  });

  it('holds the heading in [0, 2π) however long the world runs', () => {
    const world = asWeatherWorld(flatSeaWorld());
    for (let tick = 0; tick < 20000; tick++) advanceWeather(world, TICK_SECONDS);
    expect(currentWind().heading).toBeGreaterThanOrEqual(0);
    expect(currentWind().heading).toBeLessThan(Math.PI * 2);
  });
});

// ── Spawn and decay bounds ───────────────────────────────────────────────────

describe('spawn and decay', () => {
  it('never exceeds MAX_ACTIVE_SYSTEMS, and stays inside every band, over a long run', () => {
    const world = asWeatherWorld(highlandWorld());
    const ceiling = maxRadiusFor(WORLD_SIZE);
    let mostAlive = 0;
    // Violations are counted rather than asserted per tick: two hours of
    // simulated time at 10 Hz is 72 000 ticks, and an assertion inside the loop
    // would make the suite spend all its time in the matcher rather than in the
    // sim. A count of zero is the same guarantee.
    let overCap = 0;
    let outOfBand = 0;
    for (let tick = 0; tick < 72000; tick++) {
      advanceWeather(world, TICK_SECONDS);
      const alive = livingSystems();
      if (alive.length > activeSystemCapFor(WORLD_SIZE)) overCap++;
      if (alive.length > mostAlive) mostAlive = alive.length;
      for (const system of alive) {
        if (system.radius < SYSTEM_MIN_RADIUS_CELLS || system.radius > ceiling) outOfBand++;
        if (system.peakIntensity < SYSTEM_MIN_PEAK_INTENSITY || system.peakIntensity > 1) {
          outOfBand++;
        }
        if (system.envelope < 0 || system.envelope > 1) outOfBand++;
      }
    }
    expect(overCap).toBe(0);
    expect(outOfBand).toBe(0);
    // The cap must actually BIND at some point, or this test proves nothing.
    // The cap is the world's own (activeSystemCapFor) since 2026-08-28;
    // MAX_ACTIVE_SYSTEMS is the ceiling that cap is clamped to.
    expect(mostAlive).toBe(activeSystemCapFor(WORLD_SIZE));
    expect(activeSystemCapFor(WORLD_SIZE)).toBeLessThanOrEqual(MAX_ACTIVE_SYSTEMS);
    expect(BROADCAST_SYSTEM_CEILING).toBe(MAX_ACTIVE_SYSTEMS);
  });

  it('caps the radius against the WORLD on a small world, not only the band', () => {
    // A 128-unit world is explicitly supported (docs/DESIGN.md) and is
    // where the fraction binds: 0.35 of its edge is under SYSTEM_MAX_RADIUS.
    // maxRadiusFor takes a size IN CELLS — it multiplies a fraction by it and
    // compares the result against cell radii — so every world here is a span
    // in world units, converted.
    const SMALL_WORLD = cellsAcross(128);
    const TINY_WORLD = cellsAcross(32);
    expect(maxRadiusFor(SMALL_WORLD)).toBeCloseTo(
      SMALL_WORLD * SYSTEM_MAX_RADIUS_WORLD_FRACTION,
      12,
    );
    expect(maxRadiusFor(SMALL_WORLD)).toBeLessThan(SYSTEM_MAX_RADIUS_CELLS);
    // …and never below the floor, however small the world.
    expect(maxRadiusFor(TINY_WORLD)).toBe(SYSTEM_MIN_RADIUS_CELLS);
    // On the nominal world the band binds instead.
    expect(maxRadiusFor(WORLD_SIZE)).toBe(SYSTEM_MAX_RADIUS_CELLS);
  });

  it('gathers a new system from nothing rather than popping it in', () => {
    const world = asWeatherWorld(highlandWorld());
    const system = spawnSystem(world);
    expect(system.envelope).toBe(0);
    expect(systemStates()[0]!.intensity).toBe(0);

    // Half the fade later it is half gathered; a full fade later, fully.
    const halfTicks = Math.round(SYSTEM_FADE_SECONDS / 2 / TICK_SECONDS);
    for (let tick = 0; tick < halfTicks; tick++) advanceWeather(world, TICK_SECONDS);
    expect(system.envelope).toBeCloseTo(0.5, 6);
    for (let tick = 0; tick < halfTicks + 1; tick++) advanceWeather(world, TICK_SECONDS);
    expect(system.envelope).toBe(1);
  });

  it('dissipates over the same fade, then removes the system', () => {
    const world = asWeatherWorld(highlandWorld());
    // A source that never rolls a spawn or a death, so the only thing that
    // happens is the one system we place by hand.
    const system = spawnSystem(world);
    setWeatherRandomSource(() => 0.999999);
    system.envelope = 1;
    system.retiring = true;

    const fadeTicks = Math.round(SYSTEM_FADE_SECONDS / TICK_SECONDS);
    for (let tick = 0; tick < fadeTicks - 1; tick++) advanceWeather(world, TICK_SECONDS);
    expect(livingSystems()).toHaveLength(1);
    expect(system.envelope).toBeGreaterThan(0);

    // Two more ticks, not one: 300 accumulations of 0.1/30 land a floating-point
    // hair above zero, so the fade ARRIVES within one tick of nominal rather
    // than exactly on it. That slack is the reason the fade is linear at all —
    // an exponential approach would never reach the removal condition.
    advanceWeather(world, TICK_SECONDS);
    advanceWeather(world, TICK_SECONDS);
    expect(livingSystems()).toHaveLength(0);
  });

  it('removes a system that has drifted clear of the world', () => {
    const world = asWeatherWorld(highlandWorld());
    setWeatherRandomSource(() => 0.999999);
    const system = spawnSystem(world);
    system.envelope = 1;
    // Just inside the despawn margin: one tick of wind must not remove it…
    system.x = WORLD_SIZE + system.radius * SYSTEM_DESPAWN_MARGIN_RADII - 1;
    system.y = WORLD_SIZE / 2;
    advanceWeather(world, TICK_SECONDS);
    expect(livingSystems()).toHaveLength(1);

    // …and past it, one tick must.
    system.x = WORLD_SIZE + system.radius * SYSTEM_DESPAWN_MARGIN_RADII + 1;
    advanceWeather(world, TICK_SECONDS);
    expect(livingSystems()).toHaveLength(0);
  });

  it('sits at the equilibrium population its per-slot interval sets (#240)', () => {
    // A statistical check on the ONE number a player feels: how much weather
    // is on screen at once. This replaces a prior version of this test that
    // measured mean ARRIVAL interval against a [0.5x, 6x] band — a bound so
    // wide (see issue #240) that it passed unchanged whether
    // SYSTEM_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS was 5 or 40, because after
    // the 2026-08-28 per-slot retune the arrival rate races the cap, and
    // arrival interval alone no longer pins the constant down.
    //
    // What the constant actually controls — per its own doc comment in
    // systems.ts — is the EQUILIBRIUM POPULATION: advanceWeather rolls one
    // arrival hazard per free slot (rate 1/T per slot, T =
    // SYSTEM_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS) and one death hazard per
    // living system (rate 1/EFFECTIVE_SYSTEM_LIFETIME_SECONDS, folding in
    // drift-off-map removal as well as old age — see that constant's doc
    // comment). That is `cap` independent alternating renewal processes, each
    // "empty, waiting mean T" then "full, waiting mean L" — a per-slot
    // continuous-time Markov chain whose stationary "full" probability is the
    // textbook two-state result L/(L+T) (this is exactly
    // EQUILIBRIUM_OCCUPANCY's derivation in systems.ts). Summed over `cap`
    // slots: mean population = cap × L/(L+T).
    //
    // DESIGN SNAPSHOT, NOT A LIVE IMPORT. activeSystemCapFor divides by
    // EQUILIBRIUM_OCCUPANCY when it sizes the cap, specifically so that a
    // change to T is absorbed into the cap and the target sky coverage holds
    // regardless of T's value — which means a formula built from LIVE T (and
    // a live-recomputed cap) tracks any accidental change to T and reports
    // the "correct" equilibrium for whatever T has become, never failing.
    // (Verified: temporarily setting T to 80 — 4x the shipped 20 — and
    // rerunning this measurement with a live-recomputed expectation still
    // matches observed population to within ~7%.) Pinning "expected" to the
    // value T is DESIGNED to hold, and separately asserting the import still
    // equals that snapshot, is what makes a drive-by change to T fail this
    // test instead of silently passing through the cap's compensation.
    const DESIGN_SPAWN_INTERVAL_PER_SLOT_SECONDS = 20;
    expect(SYSTEM_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS).toBe(
      DESIGN_SPAWN_INTERVAL_PER_SLOT_SECONDS,
    );

    // This world's cap saturates MAX_ACTIVE_SYSTEMS (activeSystemCapFor's own
    // "wanted" sizing is exactly 14 at the design T, and still clamps to 14 at
    // 4x that T — verified above) — confirmed live so the formula below can
    // use the ceiling directly instead of re-deriving activeSystemCapFor's own
    // T-dependent sizing, which would reintroduce the same self-tracking
    // problem T's snapshot above exists to avoid.
    expect(activeSystemCapFor(WORLD_SIZE)).toBe(MAX_ACTIVE_SYSTEMS);

    const expectedPopulation =
      (MAX_ACTIVE_SYSTEMS * EFFECTIVE_SYSTEM_LIFETIME_SECONDS) /
      (EFFECTIVE_SYSTEM_LIFETIME_SECONDS + DESIGN_SPAWN_INTERVAL_PER_SLOT_SECONDS);

    setWeatherRandomSource(seededRandom(7));
    resetWeather();
    const world = asWeatherWorld(highlandWorld());

    let arrivals = 0;
    let populationSeconds = 0;
    const seconds = 36000;
    for (let tick = 0; tick < seconds / TICK_SECONDS; tick++) {
      const before = livingSystems().length;
      advanceWeather(world, TICK_SECONDS);
      if (livingSystems().length > before) arrivals++;
      populationSeconds += livingSystems().length * TICK_SECONDS;
    }
    const observedMeanPopulation = populationSeconds / seconds;

    // TOLERANCE, derived rather than copied: this is ~14 roughly-independent
    // alternating slots, each Bernoulli-ish at p = L/(L+T) ≈ 0.867, sampled
    // over a run of ~36000 / (L + T) ≈ 240 renewal cycles. For a mean of
    // independent-ish Bernoulli slots, Var[time-average population] ≈
    // cap·p(1-p) / cycles ≈ 14 × 0.867 × 0.133 / 240 ≈ 0.0068, so
    // sd/mean ≈ sqrt(0.0068) / 12.13 ≈ 0.7%. The measured run above lands at
    // ~1.0% off formula, consistent with that estimate. 5% is ~7x that
    // 1-sigma noise (comfortable headroom against flakiness) while staying
    // far under the ~24% gap a 4x change to
    // SYSTEM_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS produces against this same
    // pinned expectation (measured: ~9.25 observed vs ~12.13 expected).
    const POPULATION_TOLERANCE_FRACTION = 0.05;
    expect(observedMeanPopulation).toBeGreaterThanOrEqual(
      expectedPopulation * (1 - POPULATION_TOLERANCE_FRACTION),
    );
    expect(observedMeanPopulation).toBeLessThanOrEqual(
      expectedPopulation * (1 + POPULATION_TOLERANCE_FRACTION),
    );

    // Every system that ever existed also stopped existing, or the sky would
    // have silently jammed at the cap.
    expect(arrivals).toBeGreaterThan(MAX_ACTIVE_SYSTEMS);
  });

  it('kills a system whose death roll fires, whatever its age', () => {
    const world = asWeatherWorld(highlandWorld());
    const system = spawnSystem(world);
    system.envelope = 1;
    expect(system.retiring).toBe(false);
    // A source that always rolls below the hazard: the death is certain.
    setWeatherRandomSource(() => 0);
    advanceWeather(world, TICK_SECONDS);
    expect(system.retiring).toBe(true);
    expect(1 / SYSTEM_MEAN_LIFETIME_SECONDS).toBeGreaterThan(0);
  });
});

// ── Snow siting, and the anti-cheat rule inside it ───────────────────────────

describe('snow siting', () => {
  it('samples five points and averages only UNLOCKED ground', () => {
    expect(SNOW_ELEVATION_SAMPLES).toBe(5);
    const world = asWeatherWorld(highlandWorld());
    const mean = meanUnlockedHeightUnder(world, 256, 256, 30);
    expect(mean).toBe(SEA_LEVEL + 4 * BAND_HEIGHT);
    expect(mean).toBeGreaterThanOrEqual(SNOW_MIN_TERRAIN_HEIGHT);
  });

  it('refuses to site snow on a world with no land', () => {
    const world = asWeatherWorld(flatSeaWorld());
    expect(isSnowSite(world, 256, 256, 30)).toBe(false);
  });

  it('never spawns snow on a world with no land — it rains instead', () => {
    // spawnSystem is exercised directly: the cap lives in advanceWeather, so
    // this walks the spawn path many times without the sim getting in the way.
    const world = asWeatherWorld(flatSeaWorld());
    const kinds = new Set<WeatherKind>();
    for (let n = 0; n < 400; n++) kinds.add(spawnSystem(world).kind);
    expect(kinds.has('snow')).toBe(false);
    // The fallback is rain, not "nothing happened": weather still arrives.
    expect(kinds.has('rain')).toBe(true);
  });

  it('does spawn snow on highland', () => {
    const world = asWeatherWorld(highlandWorld());
    const kinds = new Set<WeatherKind>();
    for (let n = 0; n < 400; n++) kinds.add(spawnSystem(world).kind);
    expect(kinds.has('snow')).toBe(true);
  });

  it('IGNORES mountains in LOCKED chunks — no side channel on hidden terrain', () => {
    // Every cell is alpine, but only the first chunk column is revealed and that
    // column is dug down to the seabed. A siting rule that read locked heights
    // would find snow everywhere; one that respects the mask finds it nowhere.
    const revealedColumns = 1;
    const world = asWeatherWorld(
      worldWithTerrain(
        WORLD_SIZE,
        (x) => (x < revealedColumns * CHUNK_SIZE ? SEA_LEVEL - BAND_HEIGHT : SEA_LEVEL + 8 * BAND_HEIGHT),
        (cx) => cx >= revealedColumns,
      ),
    );

    const kinds = new Set<WeatherKind>();
    for (let n = 0; n < 400; n++) kinds.add(spawnSystem(world).kind);
    expect(kinds.has('snow')).toBe(false);
  });

  it('treats a candidate with no unlocked sample as unknown, not as sea level', () => {
    // Fully locked world: the honest answer is "this plugin is not allowed to
    // know", which must fail the site rather than default to flat ground.
    const world = asWeatherWorld(
      worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL + 8 * BAND_HEIGHT, () => true),
    );
    expect(meanUnlockedHeightUnder(world, 256, 256, 30)).toBeNull();
    expect(isSnowSite(world, 256, 256, 30)).toBe(false);
  });

  it('clamps sample coordinates into the world for an off-map centre', () => {
    // A system may legitimately be born entirely outside the map; a height
    // lookup there would read past the end of the Int16Array and return
    // undefined, which would poison the mean.
    const world = asWeatherWorld(highlandWorld());
    const mean = meanUnlockedHeightUnder(world, -200, WORLD_SIZE + 200, 40);
    expect(mean).not.toBeNull();
    expect(Number.isFinite(mean!)).toBe(true);
  });
});

// ── The broadcast ────────────────────────────────────────────────────────────

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/** Boots the plugin, through the real host, onto an already-built world. */
function bootOn(world: World): Harness {
  resetWeatherState();
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(world, [weatherPlugin].map(asLoadedPlugin));
  host.worldCreate();
  return { world, host, sink };
}

const NAMESPACED_TYPE = `${WEATHER_PLUGIN_NAME}:${WEATHER_SYSTEMS_MESSAGE}`;

describe('broadcast', () => {
  it('is sent once per BROADCAST_TICK_INTERVAL ticks — 1 Hz at TICK_HZ 10', () => {
    const { host, sink } = bootOn(highlandWorld());
    for (let tick = 0; tick < BROADCAST_TICK_INTERVAL - 1; tick++) {
      host.tick(TICK_SECONDS);
    }
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(0);

    host.tick(TICK_SECONDS);
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(1);

    for (let tick = 0; tick < BROADCAST_TICK_INTERVAL * 9; tick++) {
      host.tick(TICK_SECONDS);
    }
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(10);
    expect(BROADCAST_TICK_INTERVAL * TICK_SECONDS).toBe(1);
  });

  it('sends an EMPTY list for a clear sky rather than no message at all', () => {
    // A source that always returns 1 never fires a Poisson roll (rollEvent
    // compares against a probability strictly below 1), so the sky is
    // deterministically clear for this second. It used to be clear by luck —
    // one arrival per 40 s made a spawn in the first second unlikely — and the
    // 2026-08-28 retune raised the arrival rate enough that luck ran out.
    setWeatherRandomSource(scriptedRandom([1]));
    const { host, sink } = bootOn(highlandWorld());
    for (let tick = 0; tick < BROADCAST_TICK_INTERVAL; tick++) host.tick(TICK_SECONDS);
    const message = sink.ofType(NAMESPACED_TYPE)[0]!;
    expect(message.payload).toEqual({ systems: [] });
    // …and the client's own parser reads that as "no weather", not as garbage.
    expect(parseSystemsPayload(message.payload)).toEqual([]);
  });

  it('carries exactly the eight documented keys, rounded, and round-trips', () => {
    const { world, host, sink } = bootOn(highlandWorld());
    const weatherWorld = asWeatherWorld(world);
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) spawnSystem(weatherWorld);
    // Gather them so intensity is not zero.
    for (let tick = 0; tick < SYSTEM_FADE_SECONDS / TICK_SECONDS; tick++) {
      host.tick(TICK_SECONDS);
    }

    const message = sink.ofType(NAMESPACED_TYPE).at(-1)!;
    const payload = message.payload as { systems: Record<string, unknown>[] };
    expect(payload.systems.length).toBeGreaterThan(0);
    expect(payload.systems.length).toBeLessThanOrEqual(BROADCAST_SYSTEM_CEILING);

    for (const system of payload.systems) {
      expect(Object.keys(system).sort()).toEqual(
        ['id', 'intensity', 'kind', 'radius', 'vx', 'vy', 'x', 'y'].sort(),
      );
      expect(WEATHER_KINDS).toContain(system.kind as WeatherKind);
      // Rounded to the documented precision — two places for anything in cells,
      // three for the intensity fraction.
      for (const key of ['x', 'y', 'radius', 'vx', 'vy'] as const) {
        const value = system[key] as number;
        expect(Math.round(value * 100)).toBeCloseTo(value * 100, 9);
      }
      const intensity = system.intensity as number;
      expect(Math.round(intensity * 1000)).toBeCloseTo(intensity * 1000, 9);
      expect(intensity).toBeGreaterThanOrEqual(0);
      expect(intensity).toBeLessThanOrEqual(1);
    }

    const parsed = parseSystemsPayload(message.payload);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(payload.systems.length);
  });

  it('gives every system the same velocity — one wind, on the wire too', () => {
    const world = asWeatherWorld(highlandWorld());
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) spawnSystem(world);
    const states = systemStates();
    expect(states.length).toBeGreaterThan(1);
    for (const state of states) {
      expect(state.vx).toBe(states[0]!.vx);
      expect(state.vy).toBe(states[0]!.vy);
    }
  });

  it('contributes nothing to the snapshot — weather is not persisted', () => {
    // The birds precedent (docs/DESIGN.md): transient ambience is re-created,
    // never restored. Asserted on the plugin object itself, because the absence
    // of a slice is the whole mechanism.
    expect(weatherPlugin.persistence).toBeUndefined();
  });

  it('never vetoes a sculpt and never edits the world', () => {
    // Weather is ambience. Rain that stopped you building would be a game
    // mechanic, and reacting to every cell of a held stroke would be pure cost.
    expect(weatherPlugin.onIntent).toBeUndefined();
    expect(weatherPlugin.onTerrainChanged).toBeUndefined();
  });

  it('starts a fresh sky on world create, whatever ran before it', () => {
    const world = highlandWorld();
    const weatherWorld = asWeatherWorld(world);
    spawnSystem(weatherWorld);
    expect(livingSystems()).toHaveLength(1);
    bootOn(world);
    expect(livingSystems()).toHaveLength(0);
  });
});
