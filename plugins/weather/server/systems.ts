// Weather systems: the whole sim.
//
// Owner, 2026-08-14: "Now we need weather. Rain, sun, snow, fog, lightning. Like
// regular weather patterns, it should move together in large chunks."
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL, AND WHAT "MOVES TOGETHER IN LARGE CHUNKS" MEANS HERE
//
// A weather system is a DISC: a centre, a radius of tens of cells, a kind and a
// strength. Not a per-cell field, not a noise texture, not a particle stream —
// one object with one position. That is the owner's phrase made literal at two
// scales:
//
//   * WITHIN a system, the whole mass moves as one. The rain does not swirl
//     inside its own cloud; a system's shape is fixed for its whole life and the
//     only thing that changes is where its centre is. A player watching a front
//     cross the map sees a coherent body of rain arrive and leave.
//   * ACROSS systems, there is exactly ONE WIND. Every system rides the same
//     velocity, so two systems never sail past each other in opposite
//     directions — the sky moves as a piece, which is what "regular weather
//     patterns" describes and what a per-system random heading would destroy.
//
// REJECTED: per-system velocity. It is one extra pair of numbers and it looks
// wrong immediately — weather that disagrees with itself about which way the
// wind is blowing reads as decoration, not as a climate. The wire still carries
// the velocity per system (see protocol.ts) because the client needs it as a
// direction and because a future per-system drift would then need no protocol
// change; the SIM is what commits to one wind.
//
// REJECTED: a scalar weather field sampled per cell (Perlin/simplex over the
// map). It would give softer, more organic edges, but there is then no such
// thing as "a system": nothing to spawn, decay, count, cap or send. The
// bandwidth would be a texture instead of ~92 B × 3, and the client could not
// know where to put a bolt.
//
// CLOCK: `dt` from the host, exactly like the wildlife and monsters sims. No
// wall clock anywhere in this file.
//
// ANTI-CHEAT: this file reads terrain in exactly ONE place — the snow siting
// test below — and there it looks only at UNLOCKED cells. See
// SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA for why that restriction is load-bearing
// rather than tidy.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BAND_HEIGHT,
  SEA_LEVEL,
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';
import {
  WEATHER_KINDS,
  type WeatherKind,
  type WeatherSystemState,
  roundBroadcastIntensity,
  roundBroadcastPosition,
} from '../protocol.ts';
import {
  pickWeightedIndex,
  randomInRange,
  randomSigned,
  rollEvent,
  weatherRandom,
} from './rng.ts';

/** The slice of the server's WorldApi this plugin reads. Note how little it is. */
export interface WeatherWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

// ── How many, how big, how long ──────────────────────────────────────────────

/**
 * Weather systems alive at once. THREE, and it is an aesthetic number before it
 * is a bandwidth one — see the budget in ./index.ts, where three systems come to
 * 2.4 kbit/s, i.e. 0.6% of what the wildlife plugin already spends.
 *
 * One system would make weather a single event a player either is in or is not.
 * Three is the smallest number that can put a rain front over one coast, fog in
 * a valley and clear sky in between — a SKY rather than an effect — while still
 * leaving most of a 512² world clear at any moment, which is what keeps clear
 * weather the default the owner's "sun" asks for.
 */
export const MAX_ACTIVE_SYSTEMS = 3;

/**
 * Mean simulated seconds between system arrivals, as a constant hazard of 1/T
 * per second (see rollEvent), so arrivals are memoryless rather than metronomic.
 *
 * 40 s (measured retune, 2026-08-14 — first shipped as 90). The 90-second
 * figure's ~2.1 equilibrium assumed systems die of old age (240 s), but on a
 * small world DRIFT is the dominant killer: a system crosses 128 cells in
 * 64–210 s and is removed at the far edge, so the effective lifetime is far
 * shorter and the sky measured EMPTY 60% of the time on the live 128² world —
 * the owner's report was "I don't see any weather spawning", and he was right.
 * At 40 s the same birth-death arithmetic against the drift-shortened lifetime
 * keeps at least one system alive most of the time on a small world and runs
 * 2–3 on a 512² one, where crossings are long enough for old age to matter
 * again.
 */
export const SYSTEM_MEAN_SPAWN_INTERVAL_SECONDS = 40;

/**
 * Mean simulated seconds a system lives before it starts dissipating, again as a
 * constant hazard.
 *
 * FOUR MINUTES, which is the "spawn/decay over minutes" the brief asks for and
 * is sized against the crossing time rather than pulled from the air: at the
 * mean wind of 1.3 cells/s a system covers ~310 cells in 240 s, i.e. rather more
 * than the whole 512-cell world and about 2.4 times a 128-cell one. So the
 * ordinary end of a system is that it drifts off the map, and this hazard is
 * what makes the OTHER ending possible — weather that dies where it stands.
 * Both endings look the same to a player (the fade below), and having both is
 * what stops every system taking the identical one-way trip.
 */
export const SYSTEM_MEAN_LIFETIME_SECONDS = 240;

/**
 * Seconds a system takes to gather from nothing to full strength, and to
 * dissipate back to nothing.
 *
 * THIRTY. Weather gathers; it does not switch on. It is also what makes the
 * client need no fade of its own: a system enters the broadcast at intensity ~0
 * and leaves it at ~0, so appearing and disappearing in the list are both
 * invisible events. Sized well above the 1 s broadcast interval (30 broadcasts
 * across the ramp), so nothing about the fade can be aliased against message
 * arrival.
 */
export const SYSTEM_FADE_SECONDS = 30;

/**
 * The radius band a system is drawn from, in cells — stated in WORLD UNITS and
 * converted, because a weather system's size is measured against the camera and
 * the world's width, neither of which the 2026-08-21 re-sample moved.
 *
 * The floor is 24 — with the camera orbiting at 80 world units
 * (client/src/config.ts, CAMERA_INITIAL_DISTANCE) a 48-unit-wide mass fills a
 * good part of the view, so anything smaller reads as a local effect rather
 * than as weather. The ceiling is 56, a 112-unit body: most of a 128-unit
 * world's width and about a fifth of a 512-unit one, which is as large as a
 * system can get and still have an outside that a player can stand in and look
 * at.
 */
export const SYSTEM_MIN_RADIUS_CELLS = cellsAcross(24);
export const SYSTEM_MAX_RADIUS_CELLS = cellsAcross(56);

/**
 * Ceiling on a system's radius as a fraction of the world edge.
 *
 * WORLD_SIZE is a self-hoster's setting and a 128-unit world is explicitly
 * supported (docs/DESIGN.md §3.4), where a 56-unit radius would blanket the
 * entire map and "clear weather" would stop existing. 0.35 keeps the largest
 * system's diameter at 70% of the world edge, so there is always somewhere else
 * to stand. It is a FRACTION, so it needs no conversion and binds identically
 * at any sampling density; on the nominal world it never binds (0.35 × 512 =
 * 179 ≫ 56).
 */
export const SYSTEM_MAX_RADIUS_WORLD_FRACTION = 0.35;

/**
 * The strength band a system's PEAK intensity is drawn from.
 *
 * Never below 0.45, because a system that arrives at a tenth strength is a
 * system nobody notices arriving — the fade already provides every value below
 * this on the way in and on the way out. The variety a player actually reads is
 * "that one is heavier than the last one", which this band delivers.
 */
export const SYSTEM_MIN_PEAK_INTENSITY = 0.45;
export const SYSTEM_MAX_PEAK_INTENSITY = 1;

// ── The wind ─────────────────────────────────────────────────────────────────

/**
 * The speed band the single shared wind wanders within, in cells per second —
 * stated in world units per second and converted, like every distance here.
 *
 * The ceiling is the interesting one and it is set by the broadcast, not by
 * meteorology: at the 1 Hz cadence 2 world units/s moves a system 2 units
 * between messages, which is 8% of the SMALLEST system's radius — comfortably
 * inside what the client's interpolation renders as a continuous glide. The
 * floor of 0.6 is the slowest a front can move and still visibly be moving: it
 * crosses a 24-unit radius in 40 s, so a player standing still sees the edge of the rain
 * reach them within a look-around.
 */
export const WIND_MIN_SPEED_CELLS_PER_SECOND = cellsAcross(0.6);
export const WIND_MAX_SPEED_CELLS_PER_SECOND = cellsAcross(2);

/**
 * Maximum magnitude of the wind's random heading change, in radians per second.
 *
 * A BOUNDED RANDOM WALK, not a target it steers toward: real wind veers and
 * backs without a preferred direction, and a restoring force would give the
 * world a prevailing wind that no part of this design has any business choosing.
 *
 * 0.01 rad/s is "slowly veering" quantified. The per-second step is uniform on
 * ±0.01, so its standard deviation is 0.01/√3 ≈ 0.0058 rad; over an hour the
 * heading wanders about 0.0058 × √3600 = 0.35 rad ≈ 20°. A system whose whole
 * life is four minutes therefore flies an essentially straight course (≈2.7° of
 * drift), which is what makes a front look like a front — while a player who
 * leaves a world running all evening finds the wind somewhere else.
 */
export const WIND_VEER_RADIANS_PER_SECOND = 0.01;

/**
 * Maximum magnitude of the wind's random speed change, in cells per second per
 * second.
 *
 * 0.05 traverses the whole 1.4-units/s speed band in ~28 s of one-sided drift,
 * which never happens (the walk is symmetric), so in practice the speed breathes
 * within the band over minutes. The band's ends are hard clamps rather than
 * reflections: a clamp holds the wind at the limit for a moment, which is what a
 * calm or a steady blow looks like, where a reflection would make the wind
 * bounce off its own ceiling.
 */
export const WIND_SPEED_DRIFT_CELLS_PER_SECOND_SQUARED = cellsAcross(0.05);

// ── Where a system is born, and where it stops existing ──────────────────────

/**
 * How far outside the world a system may be born, as a multiple of its own
 * radius.
 *
 * ONE radius, so a newborn system can be tangent to the map edge — it is
 * entirely off-world but its rim is about to arrive. Weather that could only
 * ever be born inside the world would always be seen forming overhead and never
 * seen coming in off the sea.
 */
export const SYSTEM_SPAWN_MARGIN_RADII = 1;

/**
 * How far outside the world a system's centre may drift before it is removed
 * outright, as a multiple of its radius.
 *
 * STRICTLY LARGER than the spawn margin (1.5 vs 1), and that gap is not
 * cosmetic: a system born at exactly the spawn margin with the wind blowing
 * outward would otherwise be deleted on its first tick. At 1.5 radii the whole
 * disc is half a radius clear of the map, so nothing is ever removed while a
 * cell of the world is still under it.
 *
 * Removal here is INSTANT rather than a fade, unlike a natural death: there is
 * nothing to fade in front of, because no part of the world is under the system
 * any more. Fading it would be thirty seconds of updates about weather nobody
 * can see.
 */
export const SYSTEM_DESPAWN_MARGIN_RADII = 1.5;

// ── Snow, and the one place this file reads terrain ──────────────────────────

/**
 * How high the ground under a candidate snow system must average, in terrace
 * bands above sea level.
 *
 * SNOW GOES OVER HIGH GROUND, and the server has the heights, so it does this
 * honestly rather than declaring snow "a cold system" and scattering it over the
 * ocean. Two bands is one sculpt above the shoreline flat — the lowest bar that
 * still means "land that someone raised", so a modest island gets snow while the
 * open sea (a fresh world's floor is three bands DOWN, docs/DESIGN.md) never
 * does. Requiring an alpine peak would mean most worlds never see snow at all.
 *
 * REJECTED: "a snow system is just a cold system", i.e. no terrain read. The
 * cost of doing it properly is SNOW_ELEVATION_SAMPLES height lookups per siting
 * attempt, a handful of times a minute — literally nothing — and the payoff is
 * that snow lands on mountains, which is the entire recognisable fact about
 * snow. There is no honest argument for the cheap version at this price.
 *
 * ANTI-CHEAT, AND WHY THE UNLOCK MASK IS CHECKED HERE. Terrain in locked chunks
 * is never sent to clients at all — "anti-cheat by omission" (docs/DESIGN.md
 * §3.4). Snow that formed over hidden mountains would be a side channel: a
 * player could read the shape of unrevealed terrain off the sky. So the
 * elevation test counts UNLOCKED samples only, and a candidate with no unlocked
 * sample fails. Consequence, accepted and symmetrical with the wildlife
 * plugin's birds: a system is visible over ground the player has not revealed,
 * and tells them nothing about it.
 */
export const SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA = 2;

/** The height, in height units, that threshold works out to. Derived. */
export const SNOW_MIN_TERRAIN_HEIGHT =
  SEA_LEVEL + SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA * BAND_HEIGHT;

/**
 * Offsets, as fractions of the candidate radius, at which the ground under a
 * candidate snow system is sampled. The centre plus four points at half radius.
 *
 * FIVE SAMPLES, not one and not a full sweep of the disc. One is noise — a
 * single peak in an ocean would qualify a system 50 cells across. A full sweep
 * would be thousands of lookups to answer a question whose answer is "is this
 * broadly highland", which five points spread over the inner half of the disc
 * settle. Half radius rather than full, so the test is about the ground the
 * system is CENTRED on and not about its rim, which will have drifted somewhere
 * else within a minute anyway.
 */
export const SNOW_ELEVATION_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.5, 0],
  [-0.5, 0],
  [0, 0.5],
  [0, -0.5],
];

export const SNOW_ELEVATION_SAMPLES = SNOW_ELEVATION_SAMPLE_OFFSETS.length;

/**
 * How many centres a snow system may try before giving up.
 *
 * FOUR. On a world that is mostly highland the first attempt almost always
 * lands; on a world with one island the odds per attempt are the island's share
 * of the map, and four attempts is where the expected cost stays trivial. Trying
 * until success would hang the tick on a world with no land at all — which is
 * exactly what a fresh Terrace world IS (docs/DESIGN.md: "a fresh world has no
 * land"), so this is the common case and not the pathological one.
 */
export const SNOW_SITING_ATTEMPTS = 4;

/**
 * What a snow system becomes when it can find no high ground.
 *
 * RAIN, because the alternative — abandoning the spawn — would silently make
 * weather rarer on flat worlds, which is the opposite of what a player on a
 * flat world wants. The same cloud arrived; it is just not cold enough up there
 * to snow.
 */
export const SNOW_FALLBACK_KIND: WeatherKind = 'rain';

/**
 * Relative likelihood of each kind at spawn, indexed like WEATHER_KINDS
 * (rain, storm, snow, fog).
 *
 * Rain is the ordinary weather of the world and gets half of all systems.
 * Storms are rain that also throws lightning, and lightning is the one thing
 * here with a photosensitivity budget attached (client/sky.ts), so it is the
 * rarest: a fifth of systems, which at ~2.1 systems alive puts a storm somewhere
 * in the world about 40% of the time and over any given player far less often.
 * Fog and snow split the rest; snow additionally has to find high ground, so its
 * REALISED share on a low world is lower than this table and on an alpine one is
 * exactly this table.
 */
export const SYSTEM_KIND_WEIGHTS: readonly number[] = [5, 2, 1.5, 1.5];

// ── State ────────────────────────────────────────────────────────────────────

/** One live system. Mutable; the tick loop writes it in place. */
export interface WeatherSystem {
  readonly id: number;
  readonly kind: WeatherKind;
  /** Cell-space centre. May be outside the world; see the margins above. */
  x: number;
  y: number;
  /** Cell-space radius. Fixed for the system's whole life — it moves as a whole. */
  readonly radius: number;
  /** Strength at full gather, in [SYSTEM_MIN_PEAK_INTENSITY, 1]. */
  readonly peakIntensity: number;
  /** Gather envelope in [0, 1]. Multiplied by peakIntensity to get intensity. */
  envelope: number;
  /** True once the system has begun dissipating; it never gathers again. */
  retiring: boolean;
}

/** The single wind every system rides. Cells per second, as a polar pair. */
export interface Wind {
  /** Radians. The system moves toward (cos heading, sin heading) in cell space. */
  heading: number;
  speed: number;
}

const systems: WeatherSystem[] = [];
let nextSystemId = 1;

/**
 * The wind, at rest until the first tick veers it.
 *
 * Seeded from the RNG at reset rather than fixed, so two worlds booted from the
 * same binary do not both start blowing due east — but it is ONE draw for the
 * whole world, not one per system, which is the point of this file.
 */
let wind: Wind = { heading: 0, speed: 0 };

/** Live systems, in spawn order. */
export function livingSystems(): readonly WeatherSystem[] {
  return systems;
}

/** The current wind. Read-only to callers; only advanceWind writes it. */
export function currentWind(): Readonly<Wind> {
  return wind;
}

/**
 * Drops all weather state so a suite (or a boot) starts from zero: no systems,
 * a freshly drawn wind, and the id counter rewound.
 */
export function resetWeather(): void {
  systems.length = 0;
  nextSystemId = 1;
  wind = {
    heading: weatherRandom() * Math.PI * 2,
    speed: randomInRange(WIND_MIN_SPEED_CELLS_PER_SECOND, WIND_MAX_SPEED_CELLS_PER_SECOND),
  };
}

// Draw the boot wind immediately, so a host that never calls reset still has a
// wind rather than a dead calm blowing due east.
resetWeather();

// ── Geometry ─────────────────────────────────────────────────────────────────

/** The largest radius a system may have on a world of this size, in cells. */
export function maxRadiusFor(worldSize: number): number {
  const fromWorld = worldSize * SYSTEM_MAX_RADIUS_WORLD_FRACTION;
  // The floor keeps the band non-empty on a world so small that even the
  // minimum radius is more than a third of it; there, every system is the
  // minimum size and the fraction has simply run out of room to bind.
  return Math.max(SYSTEM_MIN_RADIUS_CELLS, Math.min(SYSTEM_MAX_RADIUS_CELLS, fromWorld));
}

/** Cell-space velocity of the shared wind. */
export function windVelocity(): { vx: number; vy: number } {
  return {
    vx: Math.cos(wind.heading) * wind.speed,
    vy: Math.sin(wind.heading) * wind.speed,
  };
}

/** True once a system's centre has drifted far enough out to be removed. */
export function hasLeftWorld(system: WeatherSystem, worldSize: number): boolean {
  const margin = system.radius * SYSTEM_DESPAWN_MARGIN_RADII;
  return (
    system.x < -margin ||
    system.y < -margin ||
    system.x > worldSize + margin ||
    system.y > worldSize + margin
  );
}

// ── Siting ───────────────────────────────────────────────────────────────────

/** Clamps a cell coordinate into the world so a height lookup is always in range. */
function clampCell(value: number, worldSize: number): number {
  const cell = Math.floor(value);
  if (cell < 0) return 0;
  if (cell > worldSize - 1) return worldSize - 1;
  return cell;
}

/**
 * Mean height of the UNLOCKED ground under a candidate system, or null when no
 * sample point falls on unlocked ground.
 *
 * Null is not "sea level" — it is "this plugin is not allowed to know", and the
 * caller must treat it as a failed candidate rather than as flat ground. See the
 * anti-cheat note on SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA.
 */
export function meanUnlockedHeightUnder(
  world: WeatherWorld,
  centreX: number,
  centreY: number,
  radius: number,
): number | null {
  let total = 0;
  let counted = 0;
  for (const [offsetX, offsetY] of SNOW_ELEVATION_SAMPLE_OFFSETS) {
    const x = clampCell(centreX + offsetX * radius, world.worldSize);
    const y = clampCell(centreY + offsetY * radius, world.worldSize);
    if (!world.isCellUnlocked(x, y)) continue;
    total += world.heightAt(x, y);
    counted++;
  }
  return counted === 0 ? null : total / counted;
}

/** True when the ground under this candidate is high enough to snow on. */
export function isSnowSite(
  world: WeatherWorld,
  centreX: number,
  centreY: number,
  radius: number,
): boolean {
  const mean = meanUnlockedHeightUnder(world, centreX, centreY, radius);
  return mean !== null && mean >= SNOW_MIN_TERRAIN_HEIGHT;
}

/** A centre drawn uniformly over the world square expanded by the spawn margin. */
function randomCentre(worldSize: number, radius: number): { x: number; y: number } {
  const margin = radius * SYSTEM_SPAWN_MARGIN_RADII;
  return {
    x: randomInRange(-margin, worldSize + margin),
    y: randomInRange(-margin, worldSize + margin),
  };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Puts one system in the sky and returns it.
 *
 * Exported so a test can place a system deterministically instead of waiting out
 * a stochastic timer.
 *
 * ORDER OF DRAWS IS FIXED — kind, radius, centre (possibly re-drawn for snow),
 * peak intensity — so a seeded generator produces the same system every time.
 * A system is born at envelope 0: it has to gather like everything else, so
 * nothing ever pops into existence at full strength.
 */
export function spawnSystem(world: WeatherWorld): WeatherSystem {
  const drawnKind = WEATHER_KINDS[pickWeightedIndex(SYSTEM_KIND_WEIGHTS)]!;
  const radius = randomInRange(SYSTEM_MIN_RADIUS_CELLS, maxRadiusFor(world.worldSize));

  let centre = randomCentre(world.worldSize, radius);
  let kind = drawnKind;
  if (kind === 'snow') {
    // Rejection sampling on elevation: try a few centres, and if none of them
    // is over high ground the cloud is still here, it just rains instead.
    let sited = isSnowSite(world, centre.x, centre.y, radius);
    for (let attempt = 1; !sited && attempt < SNOW_SITING_ATTEMPTS; attempt++) {
      centre = randomCentre(world.worldSize, radius);
      sited = isSnowSite(world, centre.x, centre.y, radius);
    }
    if (!sited) kind = SNOW_FALLBACK_KIND;
  }

  const system: WeatherSystem = {
    id: nextSystemId++,
    kind,
    x: centre.x,
    y: centre.y,
    radius,
    peakIntensity: randomInRange(SYSTEM_MIN_PEAK_INTENSITY, SYSTEM_MAX_PEAK_INTENSITY),
    envelope: 0,
    retiring: false,
  };
  systems.push(system);
  return system;
}

// ── The tick ─────────────────────────────────────────────────────────────────

/**
 * Veers and freshens the one shared wind. Both walks are symmetric and both are
 * clamped, never reflected — see the constants.
 */
export function advanceWind(dt: number): void {
  wind.heading += randomSigned(WIND_VEER_RADIANS_PER_SECOND) * dt;
  // Kept in a canonical range so a world left running for days does not
  // accumulate a heading with no significant bits left in its fraction.
  const twoPi = Math.PI * 2;
  wind.heading = ((wind.heading % twoPi) + twoPi) % twoPi;

  const speed = wind.speed + randomSigned(WIND_SPEED_DRIFT_CELLS_PER_SECOND_SQUARED) * dt;
  wind.speed = Math.min(
    WIND_MAX_SPEED_CELLS_PER_SECOND,
    Math.max(WIND_MIN_SPEED_CELLS_PER_SECOND, speed),
  );
}

/**
 * ONE TICK OF THE WHOLE SKY. Fixed order:
 *
 *   1. the wind veers — ONCE, before anything moves, so every system in this
 *      tick is displaced by exactly the same vector. That is what makes "moves
 *      together" an invariant of the code rather than a coincidence of the
 *      numbers, and it is what the drift-coherence test asserts;
 *   2. each system ages: its gather envelope moves toward 1 (or toward 0 once it
 *      is retiring), it rolls for a natural death, and it drifts;
 *   3. dead systems are removed — the fully dissipated, and the ones that have
 *      drifted clear off the map;
 *   4. an arrival is rolled, if there is a free slot.
 *
 * Iterating backwards is what lets step 3 splice inside the same pass.
 */
/**
 * The kinds that put WATER on the ground. Fog is a haze and does not wet
 * anything; the other three do, and snow counts because a fire under falling
 * snow is a fire under falling water with extra steps.
 */
const WETTING_KINDS: readonly WeatherKind[] = ['rain', 'storm', 'snow'];

/**
 * How wet cell (x, y) is right now, in [0, 1] — the strongest wetting system
 * covering it, or 0 under clear sky.
 *
 * Added 2026-08-24 for fire (plugins/fire/server/weather-bridge.ts): rain is
 * what puts a fire out, and it closes the loop the storm opened by starting one.
 * STRONGEST rather than summed, because two overlapping fronts do not make the
 * ground twice as wet as water can make it, and a sum would exceed 1 and break
 * every caller that treats this as a fraction.
 *
 * A HARD-EDGED DISC, matching how the client draws a system's footprint and how
 * every other query in this file treats a system's radius — a soft falloff here
 * would put out fires at a range no player can see the rain reaching.
 */
export function precipitationAt(x: number, y: number): number {
  let wettest = 0;
  for (const system of systems) {
    if (!WETTING_KINDS.includes(system.kind)) continue;
    const dx = x - system.x;
    const dy = y - system.y;
    if (dx * dx + dy * dy > system.radius * system.radius) continue;
    const intensity = system.peakIntensity * system.envelope;
    if (intensity > wettest) wettest = intensity;
  }
  return Math.min(1, wettest);
}

export function advanceWeather(world: WeatherWorld, dt: number): void {
  advanceWind(dt);
  const { vx, vy } = windVelocity();
  const envelopeStep = dt / SYSTEM_FADE_SECONDS;
  const deathRate = 1 / SYSTEM_MEAN_LIFETIME_SECONDS;

  for (let index = systems.length - 1; index >= 0; index--) {
    const system = systems[index]!;

    if (!system.retiring && rollEvent(deathRate, dt)) system.retiring = true;

    // Linear, not exponential, so the fade ARRIVES: "the envelope reached zero"
    // is the condition this system is removed on, and an exponential approach
    // never gets there. Same reasoning as the monsters plugin's
    // approachEnvelope.
    system.envelope = system.retiring
      ? Math.max(0, system.envelope - envelopeStep)
      : Math.min(1, system.envelope + envelopeStep);

    system.x += vx * dt;
    system.y += vy * dt;

    const dissipated = system.retiring && system.envelope <= 0;
    if (dissipated || hasLeftWorld(system, world.worldSize)) {
      systems.splice(index, 1);
    }
  }

  if (systems.length >= MAX_ACTIVE_SYSTEMS) return;
  if (!rollEvent(1 / SYSTEM_MEAN_SPAWN_INTERVAL_SECONDS, dt)) return;
  spawnSystem(world);
}

// ── Wire ─────────────────────────────────────────────────────────────────────

/**
 * The systems as they go on the wire.
 *
 * Every system carries the SAME velocity today, and that redundancy is paid for
 * knowingly: see the note on WeatherSystemState.vx. Positions, radii and
 * velocities are rounded to WEATHER_POSITION_DECIMALS and intensity to
 * WEATHER_INTENSITY_DECIMALS on the way out, which is what makes the payload's
 * encoded size bounded and exactly assertable.
 */
export function systemStates(): WeatherSystemState[] {
  const { vx, vy } = windVelocity();
  const roundedVx = roundBroadcastPosition(vx);
  const roundedVy = roundBroadcastPosition(vy);

  return systems.map((system) => ({
    id: system.id,
    kind: system.kind,
    x: roundBroadcastPosition(system.x),
    y: roundBroadcastPosition(system.y),
    radius: roundBroadcastPosition(system.radius),
    intensity: roundBroadcastIntensity(system.peakIntensity * system.envelope),
    vx: roundedVx,
    vy: roundedVy,
  }));
}
