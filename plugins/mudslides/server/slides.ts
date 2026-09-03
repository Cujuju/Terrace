// THE SIM: which hillsides are wet, which one lets go, and where the mud ends up.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF IT.
//
//   SURVEY   a bounded random sample of REVEALED ground, on a slow interval,
//            admits steep cells to a capped site table (`surveySites`).
//   SOAK     every tracked site accumulates saturation from rain (weather's
//            `precipitationAt`, through ./weather-bridge.ts) or from fresh water
//            cutting into it (`WorldApi.freshwater`), and dries out when neither
//            applies (`soakSites`).
//   TRIGGER  ONE world-level Poisson arrival, whose rate scales with how much of
//            the sampled ground is saturated, picks a saturated site and starts
//            a slide there (`rollTrigger`).
//   RUN      the front walks steepest descent one cell at a time while a sculpt
//            cadence scours the head and lays the run-out down (`advanceSlides`).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GROUND IS ONLY EVER MOVED THROUGH `WorldApi.sculpt` (issue #212's rule and
// the design record's): ./terrain.ts's `sculptGuarded` is the single call site,
// so relaxation, banded spill and the broadcast filter apply exactly as they do
// to a player's stroke — and so does the reveal guard, which is the one thing a
// player's stroke gets from core that a plugin has to supply for itself.
//
// ─────────────────────────────────────────────────────────────────────────────
// MASS, AND HOW CLOSE IT IS TO CONSERVED.
//
// A slide keeps a LEDGER in height units. The head scour measures what it
// actually removed (the heightmap, read before and after — `sculptGuarded`), and
// every deposit measures what it actually added and subtracts it from the
// ledger. The run therefore self-corrects: a deposit the relaxation refused to
// make in full leaves the balance owed and the next step tries again.
//
// IT IS NOT EXACT, and these are the three reasons, all measured rather than
// assumed:
//   1. THE RUN-OUT CAN BE REFUSED. Piling onto a valley floor eventually meets
//      MAX_STEP and the relaxation stops accepting height. Whatever is left when
//      the toe dump is exhausted is the RESIDUAL — reported on the slide's
//      console line and recoverable from the flow event (`volumeMoved` against
//      the sum of the event's positive cell deltas).
//   2. THE MEASUREMENT WINDOW IS FINITE (terrain.ts's
//      MUDSLIDE_MEASURE_MARGIN_CELLS). A diff cell beyond it is counted as
//      UNMEASURED rather than as zero, and the count travels with the slide.
//   3. BANDED SPILL MOVES GROUND OUTSIDE THE BRUSH. That ground is inside the
//      window, so it IS measured — which is exactly why the ledger is kept in
//      measured units rather than in requested ones.

import { BAND_HEIGHT, CHUNK_SIZE } from '@terrace/shared';
import {
  MUDSLIDE_MAX_PATH_CELLS,
  cellsAcross,
  type DebrisCell,
  type MudslideFlowEvent,
  type MudslideStop,
  type SlideState,
  MAX_ACTIVE_SLIDES,
} from '../protocol.ts';
import {
  cellKey,
  footprintUnlocked,
  freshwaterAdjacent,
  inBounds,
  nextFlowCell,
  sculptGuarded,
  slopeAt,
  type MudslideWorld,
} from './terrain.ts';
import { rainAt } from './weather-bridge.ts';
import {
  MUDSLIDE_RNG_DEFAULT_SEED,
  createMudslideRng,
  randomIndex,
  rollEvent,
  type MudslideRng,
} from './rng.ts';

// ─────────────────────────────────────────────────────────────────────────────
// THE SURVEY.

/**
 * Seconds between surveys.
 *
 * FIVE. A survey rebuilds the revealed-chunk list (one `isChunkUnlocked` per
 * chunk — 16 384 on a default world) and samples cells out of it, so it is the
 * one periodically-expensive thing this plugin does. Five seconds puts that cost
 * at a fiftieth of the tick budget at the shipped TICK_HZ of 10, and nothing it
 * measures moves faster than that: a chunk unlock is a once-a-minute event and a
 * hillside's steepness only changes when somebody sculpts it.
 */
export const MUDSLIDE_SURVEY_INTERVAL_SECONDS = 5;

/**
 * Candidate cells drawn per survey.
 *
 * SIXTY-FOUR. Only a small share of revealed cells is steep enough to qualify
 * (protocol.ts's MUDSLIDE_TRIGGER_STEEPNESS and MUDSLIDE_RIM_STEEPNESS), so a
 * survey admits a handful of sites and the table below fills over a few minutes
 * of play rather than instantly — which is what makes the site set follow the
 * territory a player is actually revealing instead of freezing at whatever the
 * first survey saw.
 *
 * LEFT AT SIXTY-FOUR when #301 narrowed the site contract to rims (2026-09-02),
 * which cut the qualifying share to about two fifths of what it was: measured,
 * one revealed cell in ninety to a hundred rather than one in forty. What that
 * changes is the FILL TIME of the table below — a few minutes becomes several —
 * and not the arrival rate it feeds, because `saturatedFraction` is measured
 * against MAX_TRACKED_SITES and the table still reaches it on any world with
 * rims in the revealed square. Raising the sample count to hold the fill time
 * constant would be tuning the survey to hide a change the owner asked for.
 */
export const MUDSLIDE_SURVEY_SAMPLES = 64;

/**
 * How many steep sites are tracked at once.
 *
 * NINETY-SIX, and the number is a MEMORY and TICK bound rather than a game dial:
 * every tracked site is soaked once per tick (a rain query and a comparison), so
 * this is what caps the per-tick cost of the whole soak phase at a few hundred
 * operations. A full table evicts the DRIEST site to make room, so the set
 * converges on the wettest ground the survey has found rather than on the oldest.
 */
export const MAX_TRACKED_SITES = 96;

// ─────────────────────────────────────────────────────────────────────────────
// SATURATION.

/**
 * Rain intensity at or above which the ground is being SOAKED rather than merely
 * rained on, in weather's own [0, 1] scale.
 *
 * 0.35. Weather's systems ramp their envelope up and down over their life, so a
 * front spends most of its time below its peak; a threshold near the middle means
 * a passing shower does not count and a system sitting overhead does. Below about
 * 0.2 every drizzle in the world saturates everything, and the trigger stops
 * being about weather at all.
 */
export const MUDSLIDE_SOAKING_RAIN_INTENSITY = 0.35;

/**
 * Seconds of soaking rain that fully saturates a hillside.
 *
 * NINETY. A weather system lives on the order of minutes, so a hillside under one
 * is saturated by the time it passes and one that catches only its edge is not.
 * Short enough that a player who watches a storm arrive sees the consequence
 * during the same storm, which is what makes the two read as cause and effect
 * rather than as two unrelated events.
 */
export const MUDSLIDE_SATURATION_SECONDS = 90;

/**
 * How fast freshwater-adjacent ground saturates, relative to soaking rain.
 *
 * HALF. A river cutting into a bank is a slower, always-on version of the same
 * process: the bank gets there in three minutes instead of ninety seconds, and it
 * gets there whether or not it ever rains — which is what makes this a genuine
 * SECOND trigger (issue #212) and not a bonus on the first. On a world with no
 * weather plugin installed it is the only trigger there is (./weather-bridge.ts).
 */
export const MUDSLIDE_FRESHWATER_SOAK_RATE = 0.5;

/**
 * How fast saturation drains when nothing is wetting the ground, relative to how
 * fast it accumulates.
 *
 * A THIRD. Ground holds water longer than it takes to get wet — so two showers an
 * hour apart still add up, which is the "sustained rain" the issue asks for, while
 * a genuinely dry spell (four and a half minutes at this rate) puts a hillside
 * back to safe. Symmetric drying would make saturation a memoryless measure of the
 * last few seconds' weather, which is not what saturation means.
 */
export const MUDSLIDE_DRYING_RATE = 1 / 3;

/**
 * Seconds a site that has just slid is ineligible to slide again.
 *
 * TEN MINUTES. The physical claim is that the hillside has already shed its loose
 * material; the practical one is that without it the same steep site wins the
 * weighted draw again the moment it re-saturates, and a world gets one hillside
 * that collapses forever instead of a world that has mudslides.
 */
export const MUDSLIDE_SITE_COOLDOWN_SECONDS = 600;

// ─────────────────────────────────────────────────────────────────────────────
// THE TRIGGER.

/**
 * Mean seconds between slides on a world whose sampled ground is ENTIRELY
 * saturated, at the two ends of `WorldApi.difficulty`.
 *
 * The two-anchor lerp is WorldApi.difficulty's own instruction (a plugin picks
 * what the rating means to it). EIGHT MINUTES on the gentlest world — rare enough
 * to be an event — and NINETY SECONDS on the harshest, where a storm should be
 * visibly tearing the landscape apart. Both are for a fully saturated world,
 * which is itself uncommon: the live rate is scaled by the saturated FRACTION.
 */
export const MUDSLIDE_INTERVAL_AT_MIN_DIFFICULTY_SECONDS = 480;
export const MUDSLIDE_INTERVAL_AT_MAX_DIFFICULTY_SECONDS = 90;

/** The ends of `WorldApi.difficulty`'s documented range. */
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 100;

/**
 * What the frequency setting does to that mean interval.
 *
 * `common` IS THE UNSCALED RATE and `rare` is six times the wait — the same ratio
 * storms uses, chosen there so the two settings are recognisably different kinds
 * of world rather than two nearby dials. `uncommon`, the shipped default, is
 * THREE: halfway between them on a log scale is 2.45, and 3 is the integer that
 * keeps both relations sayable — half `rare`'s wait, three times `common`'s.
 * `off` never reaches any caller of this: the tick returns before the trigger
 * runs.
 */
export const FREQUENCY_INTERVAL_MULTIPLIERS = { rare: 6, uncommon: 3, common: 1 } as const;

// MAX_ACTIVE_SLIDES lives in ../protocol.ts (2026-08-28): the client sizes its
// front-instance buffer from it, and a cap the client cannot import is a cap the
// client restates as a literal.
export { MAX_ACTIVE_SLIDES };

// ─────────────────────────────────────────────────────────────────────────────
// THE SLIDE ITSELF.

/**
 * The brush radius for EVERY sculpt this plugin makes, in world units.
 *
 * ONE AND A HALF — a scar six cells across, about the footprint of a small
 * building, which is the smallest thing that reads as a landslide rather than as
 * a dent.
 *
 * THE SAME RADIUS FOR THE HEAD AND THE RUN-OUT, and that is load-bearing rather
 * than lazy: the volume a `sculpt` actually moves for a given `amount` depends on
 * the radius in a way this plugin cannot predict (relaxation and banded spill
 * decide it), so the head's own measurement is what CALIBRATES the deposits — see
 * `Slide.gain`. Two radii would mean two calibrations, and the second one would
 * have nothing to calibrate against.
 */
export const MUDSLIDE_BRUSH_RADIUS_WORLD_UNITS = 1.5;
export const MUDSLIDE_BRUSH_RADIUS_CELLS = cellsAcross(MUDSLIDE_BRUSH_RADIUS_WORLD_UNITS);

/**
 * Terrace bands the head is scoured by, per scour step.
 *
 * ONE. Stated in bands because a band is what the eye reads: one terrace step
 * down per pull.
 */
export const MUDSLIDE_HEAD_SCOUR_BANDS_PER_STEP = 1;

/**
 * How many sculpt steps the head scour is spread over.
 *
 * THREE, and it is spread rather than done at once so the SCARP DEEPENS WHILE THE
 * FRONT IS ALREADY RUNNING. A single sculpt at t=0 puts the whole hole there
 * before the mud has moved, which reads as the ground being deleted; three across
 * the first second reads as the hillside pulling away behind the flow.
 *
 * THE CELL IT DEEPENS REALLY IS THE SCARP (issue #301, 2026-09-02). Every one of
 * these steps sculpts the frozen head, and until #301 the head was any cell the
 * survey drew that had relief a span below it — so on a plateau this deepened the
 * flat tread and the sentence above was true only by coincidence. `slopeAt` now
 * admits a cell only where the ground itself steps down, which is what makes the
 * head the scarp by construction.
 */
export const MUDSLIDE_HEAD_SCOUR_STEPS = 3;

/**
 * Seconds between sculpt operations within one slide.
 *
 * 0.3 — three ops a second, so the head scour takes about a second and the
 * run-out is laid down in a dozen visible steps rather than in one. Each op is a
 * `WorldApi.sculpt`, the same cost as one frame of a player holding the brush
 * down; three a second per slide, times MAX_ACTIVE_SLIDES, is under a tenth of
 * what one player painting continuously already costs the server.
 */
export const MUDSLIDE_SCULPT_INTERVAL_SECONDS = 0.3;

/**
 * How fast the front travels, in world units per second.
 *
 * FOUR — eight times volcanoes' lava (0.5), because mud is not lava: a debris
 * flow is the fast hazard, and a front that crept would be neither frightening
 * nor recognisable. At this speed the longest run
 * (MUDSLIDE_MAX_PATH_WORLD_UNITS = 24) takes six seconds, long enough to notice
 * and short enough that a player who looks away does not miss the whole thing.
 */
export const MUDSLIDE_FRONT_SPEED_WORLD_UNITS_PER_SECOND = 4;
const FRONT_SPEED_CELLS_PER_SECOND = cellsAcross(MUDSLIDE_FRONT_SPEED_WORLD_UNITS_PER_SECOND);

/**
 * Cell steps (and sculpt ops) one slide may take in a single tick.
 *
 * A CLAMP, not a speed: at the shipped tick rate the front takes two cells a
 * tick, and this only binds if a tick is enormously long (a debugger pause, a
 * host that stalled). Without it one 30-second `dt` would walk the entire path
 * inside a single tick with no sculpt cadence in between, which is the "the whole
 * slide happened in one frame" failure the cap exists to make impossible.
 */
const MAX_STEPS_PER_TICK = 8;

/**
 * Fraction of what the front is still carrying that it drops at each deposit
 * point along the TRACK (as opposed to at the toe).
 *
 * 0.15. A real debris flow leaves a thin veneer along its track and piles the
 * bulk into a lobe at the run-out; dropping a fixed fraction reproduces that
 * shape for free — the trail thins geometrically as the front runs and whatever
 * survives to the end is the lobe. Zero would give a flow that carries a hill
 * intact for twenty world units and drops it in one place; a half would leave
 * nothing to run out with.
 *
 * RE-MEASURED AND DELIBERATELY NOT RETUNED after the conserving relaxation
 * (issue #108, 2026-08-29), together with MUDSLIDE_TOE_DUMP_STEPS and
 * MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS below — the three of them are one
 * mechanism and were re-derived as one. A full slide simulated at the shipped
 * cadence on a 512² genesis world (.sim-108/plugins.mjs, `=== MUDSLIDES ===`):
 *
 *   rule  excavated  deposited  residual  residual %
 *   old         675       1811         0        0.0
 *   new        1848       1828        20        1.1
 *
 * The old row is the defect, not the target. Under the manufacturing rule a
 * scour MEASURED 675 units out of a hillside and the run-out then put 1811 units
 * back — the ledger was not conserving anything, it was laundering height the
 * relaxation invented, and the reason it "cleared" is that every deposit
 * over-delivered. Under the conserving rule `sculptGuarded`'s net is exactly
 * what the brush displaced, so `Slide.gain` is an exact calibration and each
 * deposit lands what it asks for; 1.1% of the load left owed after the toe dump
 * is the run-out genuinely meeting MAX_STEP, which is the residual this
 * mechanism was always documented to have. Raising the fraction to 0.25 moves
 * it to 1.2% and doubling MUDSLIDE_TOE_DUMP_STEPS to 16 to 0.8% — noise, not a
 * mis-tuning, and both cost sculpts.
 */
export const MUDSLIDE_TRACK_DEPOSIT_FRACTION = 0.15;

/**
 * Sculpt steps spent dumping whatever is left once the front has stopped.
 *
 * EIGHT. Each one raises the ground a little; the relaxation refuses more and
 * more of them as the lobe builds, so this is the point at which "keep trying
 * until the ledger clears" has to become "stop and report what is left".
 *
 * STILL EIGHT after the conserving relaxation (issue #108): the measured
 * residual at eight steps is 1.1% of the load, and sixteen steps buys 0.3
 * points of it for twice the sculpts — see MUDSLIDE_TRACK_DEPOSIT_FRACTION
 * above for the table.
 */
export const MUDSLIDE_TOE_DUMP_STEPS = 8;

/**
 * How many of the run-out's last cells the toe dump is spread across.
 *
 * FOUR. Dumping eight times on one cell just meets the same MAX_STEP ceiling
 * eight times; walking the dump back up the last four cells of the path gives the
 * lobe somewhere to go and makes it look like a lobe rather than a pimple.
 */
export const MUDSLIDE_TOE_LOBE_CELLS = 4;

/**
 * Height units below which the ledger counts as cleared.
 *
 * FOUR — a quarter of a band, which is less than the smallest height change a
 * single sculpt of this brush can produce. Stated as an absolute because the
 * ledger is absolute: a slide with four height units left has, for every purpose
 * a player can see, finished.
 *
 * STILL FOUR after the conserving relaxation (issue #108). It is a floor on the
 * ledger's RESOLUTION, not a tolerance for its error, and the resolution did not
 * move: the smallest deposit this brush can make is still one height unit's
 * worth of displacement across its footprint. The measured residual after the
 * toe dump (1.1% of a ~1848-unit load, i.e. ~20 units) is reported through
 * `residualHeightUnits`, not swallowed here — see
 * MUDSLIDE_TRACK_DEPOSIT_FRACTION for the measurement.
 */
export const MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS = 4;

/**
 * Seconds a finished slide stays in the active list before it is dropped.
 *
 * ONE. The front has stopped and the ground is already final; this is purely so
 * the client's flow renderer gets a beat to fade the mud out instead of having it
 * vanish between two broadcasts.
 */
export const MUDSLIDE_LINGER_SECONDS = 1;

/**
 * Debris cells remembered for the join snapshot.
 *
 * 256, oldest evicted. Debris is a permanent mark on the terrain — it is IN the
 * heightmap, which core persists — so this list is only the client's decoration,
 * and forgetting the oldest of it costs a late joiner some clumps on a slide that
 * happened an hour ago.
 */
export const MAX_TRACKED_DEBRIS = 256;

// ─────────────────────────────────────────────────────────────────────────────
// STATE.

/** One steep, watched hillside. */
export interface Site {
  readonly x: number;
  readonly y: number;
  /** Seconds of accumulated soaking, clamped to [0, MUDSLIDE_SATURATION_SECONDS]. */
  saturation: number;
  /** Seconds left before this site may slide again; 0 when it may. */
  cooldownSeconds: number;
  /** Whether fresh water cuts into it — re-checked on the survey interval. */
  freshwater: boolean;
}

/** One running slide. */
export interface Slide {
  readonly id: number;
  readonly headX: number;
  readonly headY: number;
  /** The cell the front is in. */
  x: number;
  y: number;
  /** The cell it is walking towards; meaningless once `stop` is set. */
  nextX: number;
  nextY: number;
  /** Progress towards `next`, in [0, 1). */
  progress: number;
  /** Seconds accumulated towards the next sculpt op. */
  sculptTimerSeconds: number;
  /** Head scour steps already taken, of MUDSLIDE_HEAD_SCOUR_STEPS. */
  headSteps: number;
  /** Toe dump steps already taken, of MUDSLIDE_TOE_DUMP_STEPS. */
  toeSteps: number;
  /** Height units the head gave up, in total. The denominator of `load`. */
  excavated: number;
  /** Height units still being carried. */
  carried: number;
  /**
   * Measured height units of volume per unit of brush `amount`, learned from the
   * head scour. Zero until the first scour lands.
   */
  gain: number;
  /** Cells changed outside the measurement window, over the whole run. */
  unmeasuredCells: number;
  /** The path, head first, in the order the front crossed it. */
  readonly path: Array<{ readonly x: number; readonly y: number }>;
  /** Net measured height change per cell, accumulated for the flow event. */
  readonly deltas: Map<number, number>;
  /** Debris laid down since the last broadcast, for the additive message. */
  readonly pendingDebris: DebrisCell[];
  /** Cells the front has already been through, so it cannot loop. */
  readonly visited: Set<number>;
  /** Why the front stopped, or null while it is still running. */
  stop: MudslideStop | null;
  /** Seconds since it stopped, counted against MUDSLIDE_LINGER_SECONDS. */
  lingerSeconds: number;
}

let sites = new Map<number, Site>();
let slides: Slide[] = [];
let debris: DebrisCell[] = [];
let nextSlideId = 1;
let rng: MudslideRng = createMudslideRng(MUDSLIDE_RNG_DEFAULT_SEED);
let surveyTimerSeconds = MUDSLIDE_SURVEY_INTERVAL_SECONDS;
/** Revealed chunks, rebuilt each survey — the population the sample is drawn from. */
let revealedChunks: Array<{ readonly cx: number; readonly cy: number }> = [];
/** Set by ./dev.ts: the trigger never fires on its own on a forced world. */
let devFrozen = false;

/**
 * Divides the `dt` a RUNNING SLIDE sees. 1 in every real deployment.
 *
 * WHY IT EXISTS (./dev.ts's MUDSLIDES_DEV_SLOW). A run lasts about six seconds,
 * and a headless SwiftShader client in WSL2 takes roughly twenty-five seconds to
 * produce ONE frame — so a mid-flow capture is not merely hard, it is arithmetically
 * impossible. Slowing the slide is the only lever that makes it possible, and it
 * is applied to the SLIDE'S OWN dt rather than to the server's tick so nothing
 * else in the world changes speed: the front still walks the same cells in the
 * same order and the sculpt cadence still fires the same number of times, just
 * spread over more wall clock. The run a slow capture photographs is the same run.
 */
let devSlowFactor = 1;

/** Drops every scrap of state. Called on world close and by the test seam. */
export function resetSlides(): void {
  sites = new Map();
  slides = [];
  debris = [];
  nextSlideId = 1;
  rng = createMudslideRng(MUDSLIDE_RNG_DEFAULT_SEED);
  surveyTimerSeconds = MUDSLIDE_SURVEY_INTERVAL_SECONDS;
  revealedChunks = [];
  devFrozen = false;
  devSlowFactor = 1;
}

/**
 * Stops the world-level trigger from firing (./dev.ts).
 *
 * A forced world is a FIXTURE: the developer wants exactly the slide they asked
 * for, and a second one arriving from the ordinary Poisson process while they are
 * photographing the first is the difference between a capture and a guess.
 */
export function setDevFrozen(frozen: boolean): void {
  devFrozen = frozen;
}

/** See `devSlowFactor`. A factor at or below 1 is ignored. */
export function setDevSlowFactor(factor: number): void {
  devSlowFactor = Number.isFinite(factor) && factor > 1 ? factor : 1;
}

export function livingSlides(): readonly Slide[] {
  return slides;
}

export function trackedSites(): ReadonlyMap<number, Site> {
  return sites;
}

export function trackedDebris(): readonly DebrisCell[] {
  return debris;
}

// ─────────────────────────────────────────────────────────────────────────────
// SURVEY + SOAK.

// Cells per chunk edge, IMPORTED from shared — the same number, read the same
// way, as ./terrain.ts's `footprintUnlocked` uses to map a cell to its chunk.
//
// It used to be DERIVED here as `worldSize / chunksPerEdge`, on the argument
// that deriving cannot be wrong for a non-default world size. That argument
// does not hold, and the derivation was the more dangerous of the two: a world
// size is a positive multiple of `CHUNK_SIZE` BY CONSTRUCTION — shared's
// `chunksPerEdge()` throws a RangeError for anything else (shared/src/chunks.ts),
// and it is the only producer of `WorldApi.chunksPerEdge` (server/src/world/world.ts),
// with the config loader (server/src/config.ts) and the world-admin validator
// (server/src/world/world-admin.ts) both rejecting a non-multiple before a world
// exists at all. So `worldSize === chunksPerEdge × CHUNK_SIZE` always holds, the
// two forms can never disagree, and the derived form's `Math.max`/`Math.floor`
// clamps only served to turn an impossible input into a silently wrong chunk
// size instead of a throw. Importing also matches every other plugin that maps
// cells to chunks (chronicle, fire, flora).
//
// Used by `surveySites` below to turn a revealed chunk into a cell to sample.

function rebuildRevealedChunks(world: MudslideWorld): void {
  revealedChunks = [];
  for (let cy = 0; cy < world.chunksPerEdge; cy++) {
    for (let cx = 0; cx < world.chunksPerEdge; cx++) {
      if (world.isChunkUnlocked(cx, cy)) revealedChunks.push({ cx, cy });
    }
  }
}

/**
 * Admits `site` to the table, evicting the DRIEST tracked site if it is full.
 *
 * Driest rather than oldest: the table's job is to hold the ground most likely to
 * go, and a site that has sat at zero saturation for ten minutes is exactly the
 * one whose slot is worth more to somebody else. A site on cooldown scores below
 * every dry one, so a hillside that has already slid is the first to go.
 *
 * A newcomer arrives DRY, so it only takes a slot when the driest incumbent is on
 * cooldown; otherwise the table would churn on every survey and never accumulate
 * saturation anywhere.
 */
function admitSite(site: Site): void {
  const key = cellKey(site.x, site.y);
  if (sites.has(key)) return;
  if (sites.size >= MAX_TRACKED_SITES) {
    let driestKey = -1;
    let driest = Number.POSITIVE_INFINITY;
    for (const [otherKey, other] of sites) {
      const score = other.cooldownSeconds > 0 ? -other.cooldownSeconds : other.saturation;
      if (score >= driest) continue;
      driest = score;
      driestKey = otherKey;
    }
    if (driestKey < 0 || driest >= 0) return;
    sites.delete(driestKey);
  }
  sites.set(key, site);
}

/**
 * One survey pass: rebuild the revealed-chunk population, draw
 * MUDSLIDE_SURVEY_SAMPLES cells out of it, and admit the steep ones.
 *
 * SAMPLED FROM REVEALED CHUNKS, not from the world, and that is both a cost
 * decision and the reveal rule (issue #212's open question): a default world is
 * four million cells of which a fresh player has revealed a hundred thousand, so a
 * uniform world sample would spend most of its draws in fog — and every one of
 * those draws would be a site this plugin is forbidden to sculpt anyway.
 */
export function surveySites(world: MudslideWorld, dt: number): void {
  surveyTimerSeconds += dt;
  if (surveyTimerSeconds < MUDSLIDE_SURVEY_INTERVAL_SECONDS) return;
  surveyTimerSeconds = 0;

  rebuildRevealedChunks(world);
  if (revealedChunks.length === 0) return;

  const size = CHUNK_SIZE;
  for (let sample = 0; sample < MUDSLIDE_SURVEY_SAMPLES; sample++) {
    const chunk = revealedChunks[randomIndex(rng, revealedChunks.length)]!;
    const x = chunk.cx * size + randomIndex(rng, size);
    const y = chunk.cy * size + randomIndex(rng, size);
    if (!inBounds(world, x, y)) continue;
    if (slopeAt(world, x, y) === null) continue;
    admitSite({
      x,
      y,
      saturation: 0,
      cooldownSeconds: 0,
      freshwater: freshwaterAdjacent(world, x, y),
    });
  }

  // Re-check freshwater adjacency for the sites already in the table on the same
  // interval: a river re-routes when the terrain around it is sculpted, and a bank
  // that has stopped being a bank must stop saturating for free.
  // And the slope: a hillside a slide (or a player) has flattened is no longer a
  // site, and left in the table it would saturate and inflate the trigger rate
  // while never being able to let go.
  for (const [key, site] of sites) {
    if (slopeAt(world, site.x, site.y) === null) {
      sites.delete(key);
      continue;
    }
    site.freshwater = freshwaterAdjacent(world, site.x, site.y);
  }
}

/** True once a site holds enough water to be able to let go. */
export function isSaturated(site: Site): boolean {
  return site.cooldownSeconds <= 0 && site.saturation >= MUDSLIDE_SATURATION_SECONDS;
}

/**
 * Advances every tracked site's saturation and cooldown by `dt`.
 *
 * RAIN AND FRESH WATER ARE A MAXIMUM, NOT A SUM: a river bank in a downpour
 * saturates at the rain's rate, not at one and a half times it. Saturation is a
 * state of the ground with a ceiling, and adding two ways of reaching the ceiling
 * faster than either is what a sum would mean.
 */
export function soakSites(dt: number): void {
  for (const site of sites.values()) {
    if (site.cooldownSeconds > 0) {
      site.cooldownSeconds = Math.max(0, site.cooldownSeconds - dt);
      // A hillside on cooldown still dries out, so it does not come off cooldown
      // pre-loaded from the storm that set it going.
      site.saturation = Math.max(0, site.saturation - dt * MUDSLIDE_DRYING_RATE);
      continue;
    }

    const rainRate = rainAt(site.x, site.y) >= MUDSLIDE_SOAKING_RAIN_INTENSITY ? 1 : 0;
    const waterRate = site.freshwater ? MUDSLIDE_FRESHWATER_SOAK_RATE : 0;
    const wetting = Math.max(rainRate, waterRate);

    site.saturation =
      wetting > 0
        ? Math.min(MUDSLIDE_SATURATION_SECONDS, site.saturation + dt * wetting)
        : Math.max(0, site.saturation - dt * MUDSLIDE_DRYING_RATE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TRIGGER.

/** Linear interpolation between the two difficulty anchors. */
export function meanIntervalSeconds(difficulty: number): number {
  const clamped = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, difficulty));
  const t = (clamped - MIN_DIFFICULTY) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
  return (
    MUDSLIDE_INTERVAL_AT_MIN_DIFFICULTY_SECONDS +
    t * (MUDSLIDE_INTERVAL_AT_MAX_DIFFICULTY_SECONDS - MUDSLIDE_INTERVAL_AT_MIN_DIFFICULTY_SECONDS)
  );
}

/**
 * The saturated share of the tracked table, in [0, 1] — what scales the trigger
 * rate.
 *
 * THE SAMPLE STANDS IN FOR THE WORLD. The table is a random sample of revealed
 * steep ground (see `surveySites`), so the fraction of it that is saturated is an
 * estimate of the fraction of the world's steep ground that is, and scaling the
 * arrival rate by it is what makes a world under one small front slide far less
 * often than a world under a week of rain. Measured against MAX_TRACKED_SITES
 * rather than against the table's current size, deliberately: a world that has
 * found only four steep sites has almost no steep ground, and four wet ones out
 * of four should not read as "the whole world is saturated".
 */
export function saturatedFraction(): number {
  let saturated = 0;
  for (const site of sites.values()) if (isSaturated(site)) saturated++;
  return Math.min(1, saturated / MAX_TRACKED_SITES);
}

/**
 * Picks the site that lets go, weighted by saturation.
 *
 * WEIGHTED, NOT UNIFORM: everything in the pool is over the saturation threshold,
 * but ground that has been soaking for ten minutes is likelier to go than ground
 * that crossed the line a second ago, and a uniform draw would throw that ordering
 * away.
 */
function pickSaturatedSite(): Site | null {
  const pool: Site[] = [];
  let total = 0;
  for (const site of sites.values()) {
    if (!isSaturated(site)) continue;
    pool.push(site);
    total += site.saturation;
  }
  if (pool.length === 0) return null;

  let ticket = rng.next() * total;
  for (const site of pool) {
    ticket -= site.saturation;
    if (ticket <= 0) return site;
  }
  return pool[pool.length - 1]!;
}

/**
 * Rolls the world's single arrival for this tick and starts a slide if it fires.
 * Returns the slide, or null.
 */
export function rollTrigger(
  world: MudslideWorld,
  difficulty: number,
  intervalMultiplier: number,
  dt: number,
): Slide | null {
  if (devFrozen) return null;
  if (slides.length >= MAX_ACTIVE_SLIDES) return null;

  const wetShare = saturatedFraction();
  if (wetShare <= 0) return null;

  const meanInterval = meanIntervalSeconds(difficulty) * intervalMultiplier;
  if (!rollEvent(rng, wetShare / meanInterval, dt)) return null;

  const site = pickSaturatedSite();
  if (site === null) return null;
  const slide = startSlide(world, site.x, site.y);
  // A saturated site the ground refuses (scoured flat by its own last slide,
  // typically) must leave the table: kept, it counts toward the saturated
  // fraction — raising the arrival rate — and swallows every arrival that draws
  // it (review 2026-08-28: "six real slides and then fifty-two silent no-ops").
  if (slide === null) sites.delete(cellKey(site.x, site.y));
  return slide;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SLIDE.

/**
 * Starts a slide at (x, y), whatever the site table thinks. Returns null if the
 * ground there will not support one — too gentle, at the sea, or with nowhere
 * downhill to go.
 *
 * THE SITE IS PUT ON COOLDOWN HERE rather than by the caller, so every route into
 * a slide (the trigger, ./dev.ts) leaves the table in the same state.
 */
export function startSlide(world: MudslideWorld, x: number, y: number): Slide | null {
  if (slopeAt(world, x, y) === null) return null;

  // THE HEAD'S OWN BRUSH FOOTPRINT MUST BE REVEALED, checked HERE rather than
  // left to `sculptGuarded` to refuse later. Found in-world: a site on the edge
  // of the revealed square passes every test above, starts a slide, and then
  // every one of its head scours is silently refused — so the run walks its whole
  // path carrying nothing, deposits nothing, and still emits a flow event
  // claiming a slide happened. Refusing at the start is the difference between
  // "the guard held" and "the guard held but everything downstream lied about it".
  if (!footprintUnlocked(world, x, y, MUDSLIDE_BRUSH_RADIUS_CELLS)) return null;

  const first = nextFlowCell(world, x, y, new Set([cellKey(x, y)]));
  if (typeof first === 'string') return null;

  const site = sites.get(cellKey(x, y));
  if (site !== undefined) {
    site.cooldownSeconds = MUDSLIDE_SITE_COOLDOWN_SECONDS;
    site.saturation = 0;
  }

  const slide: Slide = {
    id: nextSlideId++,
    headX: x,
    headY: y,
    x,
    y,
    nextX: first.x,
    nextY: first.y,
    progress: 0,
    sculptTimerSeconds: 0,
    headSteps: 0,
    toeSteps: 0,
    excavated: 0,
    carried: 0,
    gain: 0,
    unmeasuredCells: 0,
    path: [{ x, y }],
    deltas: new Map(),
    pendingDebris: [],
    visited: new Set([cellKey(x, y), cellKey(first.x, first.y)]),
    stop: null,
    lingerSeconds: 0,
  };
  slides.push(slide);
  return slide;
}

/** Records a measured height change against the cell it happened on. */
function recordDelta(slide: Slide, x: number, y: number, delta: number): void {
  const key = cellKey(x, y);
  slide.deltas.set(key, (slide.deltas.get(key) ?? 0) + delta);
}

/** One head-scour step: pull a band out of the scarp and pick the load up. */
function scourHead(world: MudslideWorld, slide: Slide): void {
  const bandAmount = -MUDSLIDE_HEAD_SCOUR_BANDS_PER_STEP * BAND_HEIGHT;
  const measured = sculptGuarded(
    world,
    slide.headX,
    slide.headY,
    MUDSLIDE_BRUSH_RADIUS_CELLS,
    bandAmount,
  );
  slide.headSteps++;
  slide.unmeasuredCells += measured.unmeasuredCells;
  if (measured.net >= 0) {
    // NOTHING CAME AWAY. The hillside is already at a floor the relaxation will
    // not go below — typically ground a previous slide has already stripped. A
    // slide with no load is not a slide, so it is ABANDONED here rather than left
    // to walk its whole path depositing nothing and then report a flow that moved
    // no ground. Found in-world: repeated forced slides on the same hillside kept
    // emitting `mudslides:flow` with volumeMoved 0.
    //
    // THIS IS NOW A DEFENSIVE GUARD, not the common path (issue #239, fixed
    // 2026-08-29). The reason a scour on STEEP ground used to net >= 0 was
    // core: relaxation manufactured height, so the surroundings rose by more
    // than the centre fell and a real excavation measured as a gain (#108).
    // Relaxation conserves exactly now — it can move ground away from the head
    // but never invent it — so a scour into ground that has anything to give
    // measures negative. The branch is kept because net >= 0 remains REACHABLE
    // and correct for the case it was written for: already-stripped ground with
    // nothing left to remove, and a head fully contained by band or span caps
    // that refuse the move. Both leave measured.net at exactly 0.
    if (slide.excavated <= 0 && slide.headSteps >= MUDSLIDE_HEAD_SCOUR_STEPS) {
      slide.stop = 'spent';
    }
    return;
  }

  const removed = -measured.net;
  slide.excavated += removed;
  slide.carried += removed;
  recordDelta(slide, slide.headX, slide.headY, measured.net);

  // THE CALIBRATION (see MUDSLIDE_BRUSH_RADIUS_WORLD_UNITS): how much volume one
  // unit of brush amount actually moved, at this radius, on this ground. Every
  // deposit's `amount` is derived from it, so the run-out is sized in the same
  // units the head was measured in rather than from a guessed constant. Averaged
  // across the scour steps, because the second and third pull into ground the
  // first one already relaxed and are the better estimate of what a deposit will
  // meet.
  const gain = removed / Math.abs(bandAmount);
  slide.gain = slide.gain === 0 ? gain : (slide.gain + gain) / 2;
}

/** Lays some of the load down at (x, y) and takes it off the ledger. */
function deposit(world: MudslideWorld, slide: Slide, x: number, y: number, volume: number): void {
  if (slide.gain <= 0 || volume <= 0) return;
  // AN INTEGER, because `WorldApi.sculpt` refuses anything else — the heightmap
  // is Int16 and shared/'s determinism contract is integer-only, so a fractional
  // brush amount throws rather than being rounded somewhere downstream. Rounded
  // UP to one height unit rather than down to zero: a slide that owes a small
  // balance must still be able to place it, or the ledger could never clear and
  // every run would report a residual it had no way to spend.
  const amount = Math.max(1, Math.round(volume / slide.gain));

  const measured = sculptGuarded(world, x, y, MUDSLIDE_BRUSH_RADIUS_CELLS, amount);
  slide.unmeasuredCells += measured.unmeasuredCells;
  if (measured.net <= 0) return;

  // MEASURED, NOT REQUESTED: whatever the relaxation actually accepted is what
  // comes off the ledger, so a refused deposit stays owed and the next step tries
  // again. This is the whole of the mass-conservation mechanism.
  slide.carried = Math.max(0, slide.carried - measured.net);
  recordDelta(slide, x, y, measured.net);

  const cell: DebrisCell = { x, y, depth: Math.max(1, Math.round(measured.net)) };
  slide.pendingDebris.push(cell);
  debris.push(cell);
  if (debris.length > MAX_TRACKED_DEBRIS) debris.splice(0, debris.length - MAX_TRACKED_DEBRIS);
}

/** Walks the front downhill by up to `dt` seconds' worth of cells. */
function advanceFront(world: MudslideWorld, slide: Slide, dt: number): void {
  if (slide.stop !== null) return;

  slide.progress += dt * FRONT_SPEED_CELLS_PER_SECOND;
  let steps = 0;
  while (slide.progress >= 1 && steps < MAX_STEPS_PER_TICK) {
    slide.progress -= 1;
    steps++;

    slide.x = slide.nextX;
    slide.y = slide.nextY;
    slide.path.push({ x: slide.x, y: slide.y });

    if (slide.path.length >= MUDSLIDE_MAX_PATH_CELLS) {
      slide.stop = 'length';
      slide.progress = 0;
      return;
    }

    const next = nextFlowCell(world, slide.x, slide.y, slide.visited);
    if (typeof next === 'string') {
      slide.stop = next;
      slide.progress = 0;
      return;
    }
    slide.nextX = next.x;
    slide.nextY = next.y;
    slide.visited.add(cellKey(next.x, next.y));
  }
  // The clamp bit: drop the unspent progress rather than carrying it into the
  // next tick, where it would produce the same burst one tick later.
  if (slide.progress >= 1) slide.progress = 0;
}

/** One sculpt op, whichever phase the slide is in. */
function sculptStep(world: MudslideWorld, slide: Slide): void {
  if (slide.headSteps < MUDSLIDE_HEAD_SCOUR_STEPS) {
    scourHead(world, slide);
    return;
  }

  if (slide.carried <= MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS) {
    // The ledger is clear. A front still running keeps running — it is just clean
    // water now — and one that has stopped is done.
    if (slide.stop === null) slide.stop = 'spent';
    return;
  }

  if (slide.stop === null) {
    // ALONG THE TRACK: a thin veneer, a fixed share of what is still carried.
    deposit(world, slide, slide.x, slide.y, slide.carried * MUDSLIDE_TRACK_DEPOSIT_FRACTION);
    return;
  }

  if (slide.toeSteps >= MUDSLIDE_TOE_DUMP_STEPS) return;
  slide.toeSteps++;
  // THE LOBE: walk the dump back up the last few cells of the path, so eight dumps
  // do not all meet the same MAX_STEP ceiling on one cell. The share rises as the
  // remaining steps run out, so the last one tries to place the whole balance.
  const back = slide.toeSteps % MUDSLIDE_TOE_LOBE_CELLS;
  const cell = slide.path[Math.max(0, slide.path.length - 1 - back)]!;
  const stepsLeft = Math.max(1, MUDSLIDE_TOE_DUMP_STEPS - slide.toeSteps + 1);
  deposit(world, slide, cell.x, cell.y, slide.carried / stepsLeft);
}

/**
 * Did this slide actually move any ground?
 *
 * The one question `mudslides:flow` is worth emitting for. A slide that excavated
 * nothing crossed cells and changed no heights; telling structures to demolish
 * and chronicle to write a line about it would be reporting an event that did not
 * happen.
 */
export function movedGround(slide: Slide): boolean {
  return slide.excavated > 0;
}

/** True once a slide has nothing left to do and may be dropped. */
function isFinished(slide: Slide): boolean {
  if (slide.stop === null) return false;
  const owing = slide.carried > MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS;
  if (owing && slide.toeSteps < MUDSLIDE_TOE_DUMP_STEPS) return false;
  return slide.lingerSeconds >= MUDSLIDE_LINGER_SECONDS;
}

/** The flow event for a slide that has just finished. */
export function flowEventFor(slide: Slide): MudslideFlowEvent {
  const toe = slide.path[slide.path.length - 1]!;
  return {
    slideId: slide.id,
    headX: slide.headX,
    headY: slide.headY,
    toeX: toe.x,
    toeY: toe.y,
    // The whole crossed run, head first. Cells the mud passed over with no
    // measured height change of their own are included with a zero delta, because
    // "the mud came through here" is the fact a consumer that fells a tree or puts
    // a fire out actually needs.
    cells: slide.path.map((cell) => ({
      x: cell.x,
      y: cell.y,
      delta: Math.round(slide.deltas.get(cellKey(cell.x, cell.y)) ?? 0),
    })),
    volumeMoved: Math.round(slide.excavated),
    stop: slide.stop ?? 'spent',
  };
}

/** Height units this slide excavated but never managed to put down. */
export function residualHeightUnits(slide: Slide): number {
  return Math.max(0, Math.round(slide.carried));
}

/** What one tick of the sim produced, for the host half to publish. */
export interface SlideTick {
  /** Slides that finished this tick — one `mudslides:flow` event each. */
  readonly finished: readonly Slide[];
  /** True if anything is running, so a still world costs no broadcast. */
  readonly changed: boolean;
}

/** Advances every running slide by `dt`. */
export function advanceSlides(world: MudslideWorld, rawDt: number): SlideTick {
  if (slides.length === 0) return { finished: [], changed: false };
  const dt = rawDt / devSlowFactor;

  const finished: Slide[] = [];
  const surviving: Slide[] = [];

  for (const slide of slides) {
    advanceFront(world, slide, dt);

    slide.sculptTimerSeconds += dt;
    // A LOOP, not an `if`: a long tick owes several sculpt ops, and skipping them
    // would let a stalled host silently shorten every slide it interrupted.
    // Bounded by the same clamp the front's steps are, for the same reason.
    let ops = 0;
    while (
      slide.sculptTimerSeconds >= MUDSLIDE_SCULPT_INTERVAL_SECONDS &&
      ops < MAX_STEPS_PER_TICK
    ) {
      slide.sculptTimerSeconds -= MUDSLIDE_SCULPT_INTERVAL_SECONDS;
      ops++;
      sculptStep(world, slide);
    }
    if (slide.sculptTimerSeconds >= MUDSLIDE_SCULPT_INTERVAL_SECONDS) {
      slide.sculptTimerSeconds = 0;
    }

    if (slide.stop !== null) slide.lingerSeconds += dt;

    if (isFinished(slide)) finished.push(slide);
    else surviving.push(slide);
  }

  slides = surviving;
  return { finished, changed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRE.

/** The running slides, as the client sees them. */
export function slideStates(): readonly SlideState[] {
  return slides.map((slide) => {
    const dx = slide.stop === null ? slide.nextX - slide.x : 0;
    const dy = slide.stop === null ? slide.nextY - slide.y : 0;
    return {
      id: slide.id,
      x: slide.x + dx * slide.progress,
      y: slide.y + dy * slide.progress,
      vx: dx * FRONT_SPEED_CELLS_PER_SECOND,
      vy: dy * FRONT_SPEED_CELLS_PER_SECOND,
      load: slide.excavated > 0 ? Math.min(1, slide.carried / slide.excavated) : 0,
    };
  });
}

/**
 * Debris laid down since the last call, and clears the pending lists. `alsoFrom`
 * is for slides that finished THIS tick — `advanceSlides` has already dropped
 * them from the live list, and a toe dump routinely lands on the finishing tick.
 */
export function takePendingDebris(alsoFrom: readonly Slide[] = []): DebrisCell[] {
  const cells: DebrisCell[] = [];
  for (const slide of [...slides, ...alsoFrom]) {
    if (slide.pendingDebris.length === 0) continue;
    cells.push(...slide.pendingDebris);
    slide.pendingDebris.length = 0;
  }
  return cells;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE (the shapes; the parsing is ./persistence.ts's).

export interface SlidesSnapshot {
  readonly nextSlideId: number;
  readonly rngState: number;
  readonly sites: readonly Site[];
  readonly slides: readonly SerializedSlide[];
  readonly debris: readonly DebrisCell[];
}

/**
 * A slide, flattened for the slice.
 *
 * `visited` AND `deltas` ARE NOT SAVED, and the two omissions are deliberate and
 * different. `visited` is rebuilt from `path` on restore — it is a derived index,
 * and saving it would be saving the same fact twice. `deltas` is genuinely lost: a
 * restored slide's flow event reports a zero delta on the cells it crossed before
 * the restart. The HEIGHTS are core's and are already saved, so what is lost is
 * the EVENT's detail on those cells, not the terrain — an acceptable price for
 * not persisting a map per slide, and named here so nobody has to rediscover it.
 */
export interface SerializedSlide {
  readonly id: number;
  readonly headX: number;
  readonly headY: number;
  readonly x: number;
  readonly y: number;
  readonly nextX: number;
  readonly nextY: number;
  readonly progress: number;
  readonly sculptTimerSeconds: number;
  readonly headSteps: number;
  readonly toeSteps: number;
  readonly excavated: number;
  readonly carried: number;
  readonly gain: number;
  readonly unmeasuredCells: number;
  readonly path: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly stop: MudslideStop | null;
  readonly lingerSeconds: number;
}

export function slidesSnapshot(): SlidesSnapshot {
  return {
    nextSlideId,
    rngState: rng.state(),
    sites: [...sites.values()],
    slides: slides.map((slide) => ({
      id: slide.id,
      headX: slide.headX,
      headY: slide.headY,
      x: slide.x,
      y: slide.y,
      nextX: slide.nextX,
      nextY: slide.nextY,
      progress: slide.progress,
      sculptTimerSeconds: slide.sculptTimerSeconds,
      headSteps: slide.headSteps,
      toeSteps: slide.toeSteps,
      excavated: slide.excavated,
      carried: slide.carried,
      gain: slide.gain,
      unmeasuredCells: slide.unmeasuredCells,
      path: slide.path.map((cell) => ({ x: cell.x, y: cell.y })),
      stop: slide.stop,
      lingerSeconds: slide.lingerSeconds,
    })),
    debris: [...debris],
  };
}

export function restoreSlides(snapshot: SlidesSnapshot): void {
  nextSlideId = snapshot.nextSlideId;
  rng = createMudslideRng(snapshot.rngState);
  sites = new Map();
  for (const site of snapshot.sites) sites.set(cellKey(site.x, site.y), { ...site });
  debris = [...snapshot.debris];
  slides = snapshot.slides.map((saved) => ({
    id: saved.id,
    headX: saved.headX,
    headY: saved.headY,
    x: saved.x,
    y: saved.y,
    nextX: saved.nextX,
    nextY: saved.nextY,
    progress: saved.progress,
    sculptTimerSeconds: saved.sculptTimerSeconds,
    headSteps: saved.headSteps,
    toeSteps: saved.toeSteps,
    excavated: saved.excavated,
    carried: saved.carried,
    gain: saved.gain,
    unmeasuredCells: saved.unmeasuredCells,
    path: saved.path.map((cell) => ({ x: cell.x, y: cell.y })),
    deltas: new Map<number, number>(),
    pendingDebris: [],
    visited: new Set(saved.path.map((cell) => cellKey(cell.x, cell.y))),
    stop: saved.stop,
    lingerSeconds: saved.lingerSeconds,
  }));
  // The survey population belongs to the world that built it.
  revealedChunks = [];
  surveyTimerSeconds = MUDSLIDE_SURVEY_INTERVAL_SECONDS;
}
