// TRAVERSAL — the one predicate for "may this mover stand here / cross here",
// shared by every plugin that moves something across the heightmap on foot,
// through water, or over it (wildlife's grazers/fish/whales, pilgrims'
// pilgrims and wanderers, monsters' yeti and sea kinds, boats' fleet, and
// whatever moves next).
//
// ROOT CAUSE THIS FIXES (2026-08-19, owner report on pilgrims + wildlife
// parity): two plugins each grew their own answer to "can this thing be here
// / go there" — wildlife's canTraverse (species.ts + census.ts) got a
// gradient-aware fix earlier the same day; pilgrims' isWalkableCell still
// tested only `heightAt > SEA_LEVEL`, the exact rule wildlife shipped with
// BEFORE its fix, because pilgrims' own doc comment says so. Two independent
// copies of terrain math is exactly how one drifted behind the other, and a
// third caller would drift the same way. This file is the contract layer:
// the predicate lives here ONCE, and every mover plugin adapts a
// TraversalProfile onto it instead of re-deriving the maths.
//
// WIDENED 2026-08-20 (owner: "it would be nice if this pathing code was
// semi-generic so that we could add the ability to specify certain rules for
// different objects as to what they should and should not go around … the
// Yeti should easily be able to traverse water. Same with terrestrial
// monsters, though the terrestrial monsters should only be able to traverse
// the rivers, not the lakes. Boats should be able to go anywhere in the
// water."). The profile used to carry exactly two facts — ONE ground class
// and a slope limit — and every one of those requests is inexpressible in
// two facts: "water or land" needs a SET of ground classes, "rivers but not
// lakes" needs a freshwater axis the sea-derived ground classes know nothing
// about, and "anywhere in the water" needs both. So the profile now carries
// four axes (see TraversalProfile), each independently checked, and the
// archetypes every shipped mover uses are named at the bottom of this file
// rather than re-derived per plugin.
//
// DETERMINISM CONTRACT (same as every other file in shared/): integer-only
// except heightAt itself (already Int16 in the authoritative heightmap), no
// wall clock, no RNG, fixed iteration order. Two callers running this against
// the same heights get byte-identical answers.

import { BAND_HEIGHT, MAX_STEP, MIN_HEIGHT, SEA_LEVEL } from './constants.ts';
import { NO_FRESHWATER, type Freshwater, type FreshwaterMap } from './freshwater.ts';

// ─────────────────────────────────────────────────────────────────────────────
// The world, as this file needs to read it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal shape a caller must expose. Deliberately NOT the concrete
 * `Heightmap` from heightmap.ts: every plugin already reads terrain through
 * its own narrow view of the server's WorldApi (wildlife's `HabitatWorld`,
 * pilgrims' `PilgrimWorld`), and both already declare `worldSize` and
 * `heightAt(x, y)` with this exact shape — so those interfaces satisfy
 * `TerrainSampler` structurally, with no adapter object to construct.
 */
export interface TerrainSampler {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  /**
   * Where the rivers and lakes are, for the freshwater axis of a profile.
   *
   * OPTIONAL, and absent means NO_FRESHWATER — "this world has no fresh water
   * as far as traversal is concerned". That default is what keeps the axis
   * ADDITIVE: every caller that predates it (every `shared/` unit test,
   * wildlife's HabitatWorld, boats' BoatWorld) keeps compiling and keeps its
   * previous answers, and a plugin opts in by handing over a map built from
   * the network it already computes. It is a `FreshwaterMap`, not a
   * `RiverNetwork`, because traversal asks a per-cell question and a network
   * answers a per-river one — see freshwater.ts's header for the cost of
   * getting that the wrong way round.
   */
  readonly freshwater?: FreshwaterMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ground classification — moved from wildlife/server/species.ts's `habitatOf`
// (2026-08-14), which read purely from height and owed nothing to wildlife
// specifically. `dry`/`shallow`/`deep` name the same three bands that plugin
// called `land`/`shallow`/`deep`; the renamed `dry` is this file's own word so
// it never reads as a re-statement of wildlife's `Habitat` union, which stays
// a plugin-local type mapped onto this one (species.ts's `habitatOf` is now a
// one-line wrapper).
// ─────────────────────────────────────────────────────────────────────────────

export type TerrainGround = 'dry' | 'shallow' | 'deep';

/**
 * Depth below sea level, in HEIGHT UNITS, at which water stops being coastal
 * shallows and becomes open sea.
 *
 * A PHYSICAL DEPTH, NOT A BAND COUNT (2026-08-20). It was "three bands", which
 * meant 192 units while BAND_HEIGHT was 64 and would have silently become 48
 * when the world was re-terraced — moving the coastline of every world, and
 * with it every monster's habitat, because the render got finer. The depth is
 * the fact; the number of terraces that fit in it is not.
 *
 * 192 units is what "three bands" bought, kept exactly. It stays meaningful
 * rather than arbitrary for the same reason it always did, restated against
 * the current gradient limit: MAX_STEP is BAND_HEIGHT, so terrain falls at
 * most 16 units per cell and a cell this deep is at least twelve cells from
 * the nearest shoreline. "Deep" is water something can be IN, not a puddle it
 * would be beached in the middle of. (It was six cells before the re-terrace
 * halved the maximum slope; the shore got gentler, so open water starts
 * further out — the same statement about the world, drawn on a finer grid.)
 */
export const DEEP_WATER_DEPTH = 192;

/** The same depth counted in terrace bands — derived, never restated. */
export const DEEP_WATER_BANDS_BELOW_SEA = DEEP_WATER_DEPTH / BAND_HEIGHT;

/** Heights at or below this are deep water; above it, up to SEA_LEVEL, shallow. */
export const DEEP_WATER_MAX_HEIGHT = SEA_LEVEL - DEEP_WATER_DEPTH;

/** Classifies one cell height into dry land / shallow water / deep water. */
export function groundOf(height: number): TerrainGround {
  if (height > SEA_LEVEL) return 'dry';
  return height <= DEEP_WATER_MAX_HEIGHT ? 'deep' : 'shallow';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gradient limits — moved from wildlife/server/species.ts (2026-08-19 gradient
// fix). The reasoning is unchanged; only the names generalise past "grazer"
// and "aquatic" since a land walker that isn't a grazer (pilgrims, wanderers)
// needs the exact same number for the exact same reason.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "No limit at all" for a walker whose ground has no risers — deep or
 * shallow water, where the seabed's steepness never blocks anything that
 * swims. `Number.isFinite` short-circuits every gradient check below to
 * `true` without sampling a height, so a water-ground profile answers the
 * same `maxGradientPerCell` question as a land one and nothing downstream
 * needs a "does this walker care about slope" flag.
 */
export const UNCONSTRAINED_GRADIENT_PER_CELL = Infinity;

/**
 * The standard land-walker gradient limit: the most height a walker on dry
 * ground will climb or descend in ONE CELL of travel before it must turn
 * along the level instead of crossing.
 *
 * Sized against the terrain's OWN gradient cap, not picked independently:
 * relaxation bounds every 4-neighbor height difference, so that bound is the
 * STEEPEST slope that can exist anywhere in the world — anything steeper is
 * not legal terrain. Half of it means the steepest HALF of legally-possible
 * slopes are impassable to a walker — a terrace riser reads as a riser —
 * while an ordinary rolling ramp still crosses freely.
 *
 * THE BOUND IS MAX_STEP + RELAX_SLACK, NOT MAX_STEP (issue #108, 2026-08-29),
 * and this constant is deliberately still half of MAX_STEP alone. Relaxation
 * splits a pair's excess exactly in half now, so it comes to rest at
 * MAX_STEP + 1 rather than MAX_STEP (constants.ts, RELAX_SLACK) and the
 * steepest legal slope is 5 units per cell. Half of THAT is 2.5, which is not
 * a height: the walker rule has to be an integer number of height units per
 * cell or every caller rounds it differently. Rounding down gives 2, which is
 * this constant unchanged; rounding up gives 3, which would let a walker take
 * slopes it used to refuse. So the tie is broken DOWNWARD and the sentence
 * above holds a fortiori — the walker refuses slightly more than half of the
 * legally-possible slopes, never fewer.
 *
 * WRITTEN AGAINST MAX_STEP, NOT BAND_HEIGHT (2026-08-20). It used to say
 * `BAND_HEIGHT / 4` and note in passing that this equalled MAX_STEP/2. The
 * two stopped being equal the moment MAX_STEP was re-derived as BAND_HEIGHT
 * rather than half of it, and the version that would have survived is the one
 * this comment's own argument uses: HALF THE STEEPEST LEGAL SLOPE. That is
 * now what the code says.
 *
 * ONE NUMBER FOR EVERY LAND WALKER, on purpose: wildlife's grazer and
 * pilgrims'/wanderers' human(-ish) walk are both "a legged thing walking on
 * dry ground", and nothing about that judgement is species-specific. Before
 * this file existed each plugin re-derived (or, for pilgrims, forgot to
 * derive) the same number; a future land species reuses this constant rather
 * than re-deriving half of MAX_STEP a third time.
 */
export const LAND_WALKER_MAX_GRADIENT_PER_CELL = MAX_STEP / 2;

/**
 * The lowest stored height a LAND walker will accept as ground: the floor of
 * band 1.
 *
 * Derived from what the renderer draws, not picked: terrain is drawn snapped
 * DOWN to its band floor (`quantizeToBand`), and the sea plane sits a hair
 * above SEA_LEVEL (client/src/render/water.ts's WATER_SURFACE_LIFT, whose own
 * comment says it exists because "band-0 terrain renders exactly there and
 * would z-fight"). So band 0 — every dry height from SEA_LEVEL + 1 up to
 * BAND_HEIGHT − 1 — is the one dry band drawn AT the waterline, underneath
 * the water. BAND_HEIGHT is the first height that clears it.
 *
 * WHY A WALKER RULE AND NOT A NEW WATER RULE. `groundOf`'s threshold is a
 * settled decision (design record Q3, "height ≤ 0 is water"), and moving it
 * would let fish swim onto dry land — the classes are shared by everything
 * that swims as well as everything that walks. This is the narrower true
 * statement: that fringe is land, and a land walker declines to stand on it
 * because it does not read as land.
 *
 * MEASURED COST, not hidden: 292 of the live world's 4557 dry cells (6.4%,
 * server/data/world.db snapshot #188, 2026-08-20) stop being walkable, all of
 * it coastal fringe. A settlement that lands on one of those cells dispatches
 * no walkers — its own `isWalkableCell` gate already refuses it, so this
 * degrades to a quiet town rather than to a stuck one.
 */
export const LAND_WALKER_MIN_GROUND_HEIGHT = BAND_HEIGHT;

/**
 * "No minimum at all" — the vacuous value for a profile whose ground is
 * already water, or that is explicitly allowed everywhere. MIN_HEIGHT rather
 * than -Infinity so the whole profile stays in the integer domain the
 * determinism contract asks for.
 */
export const UNCONSTRAINED_MIN_GROUND_HEIGHT = MIN_HEIGHT;

// ─────────────────────────────────────────────────────────────────────────────
// The walker profile and the two predicates every caller adapts onto.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What kind of thing is walking, expressed as the two facts terrain math
 * needs to know about it: what ground it may stand on, and how steep a step
 * it will accept. Everything else about a species (speed, size, habitat
 * population targets, ...) is plugin business and stays out of `shared/`.
 */
export interface TraversalProfile {
  /**
   * Which ground classifications this mover may occupy — a SET, not one
   * class, because "the yeti should easily be able to traverse water" and
   * "boats should be able to go anywhere in the water" are both statements
   * about more than one band (owner, 2026-08-20). A single-element array is
   * the ordinary case and reads no worse than the scalar it replaces.
   */
  readonly grounds: readonly TerrainGround[];
  /**
   * The lowest stored height a cell may have and still count as this mover's
   * ground — the axis that keeps a mover off ground that is legally dry but
   * DRAWN as sea.
   *
   * This exists because `groundOf` classifies by raw height against
   * SEA_LEVEL (design record Q3: "height ≤ 0 is water"), while the renderer
   * draws terrain QUANTIZED DOWN to its band floor (heightmap.ts's
   * quantizeToBand) and floats the sea plane just above SEA_LEVEL
   * (client/src/render/water.ts). A cell at height 1–63 is therefore dry by
   * the settled rule and drawn at exactly the waterline underneath the sea
   * film — 292 of the live world's 4557 dry cells when this was measured
   * (2026-08-20), all of it shoreline, which is exactly where routes hug. A
   * land walker standing there reads as wading. LAND_WALKER_MIN_GROUND_HEIGHT
   * below is the constant that says "band 1 or higher"; MIN_HEIGHT is the
   * vacuous value for a mover whose ground is water anyway.
   */
  readonly minGroundHeight: number;
  /**
   * What this mover does about fresh water — the axis that separates "may
   * cross a river" from "may swim a lake" (owner, 2026-08-20: "terrestrial
   * monsters should only be able to traverse the rivers, not the lakes").
   * Checked against `TerrainSampler.freshwater`, and vacuous in a world that
   * supplies none.
   */
  readonly freshwater: FreshwaterPassability;
  /**
   * Max |height difference| accepted crossing ONE CELL of travel.
   * UNCONSTRAINED_GRADIENT_PER_CELL (Infinity) for a mover whose ground has
   * no risers (water); LAND_WALKER_MAX_GRADIENT_PER_CELL for one that walks
   * dry ground.
   */
  readonly maxGradientPerCell: number;
}

/**
 * How a profile treats fresh water (freshwater.ts's `Freshwater`).
 *
 * - `blocked`  — neither channels nor pools may be entered. The default for
 *                anything that walks: a river is a river.
 * - `channels` — a FLOWING river point may be crossed, a standing pool may
 *                not. The terrestrial-monster rule, stated once.
 * - `all`      — fresh water is no obstacle at all. Amphibious things
 *                (the yeti) and anything that is already in water.
 */
export type FreshwaterPassability = 'blocked' | 'channels' | 'all';

/** Does `passability` admit a cell carrying this fresh water? */
function admitsFreshwater(passability: FreshwaterPassability, water: Freshwater): boolean {
  if (water === 'none' || passability === 'all') return true;
  return passability === 'channels' && water === 'channel';
}

/**
 * Is this single cell somewhere `profile` may stand? Bounds, ground class,
 * minimum ground height and fresh water — no "from" cell, so no gradient
 * term (see `canTraverseSegment` for the predicate that has one). Used for
 * standalone cell queries: a goal cell, a spawn candidate, a viewpoint
 * candidate, and every neighbour A* considers (pathing.ts).
 */
export function isWalkableCell(
  world: TerrainSampler,
  profile: TraversalProfile,
  x: number,
  y: number,
): boolean {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) return false;

  const height = world.heightAt(cx, cy);
  if (height < profile.minGroundHeight) return false;
  if (!profile.grounds.includes(groundOf(height))) return false;

  const freshwater = (world.freshwater ?? NO_FRESHWATER).at(cx, cy);
  return admitsFreshwater(profile.freshwater, freshwater);
}

/**
 * Can `profile` walk in a straight line from (fromX, fromY) to (toX, toY)
 * without crossing a slope steeper than its own `maxGradientPerCell`?
 *
 * SAMPLES ALONG THE WHOLE SEGMENT, not just the two endpoints. An
 * endpoint-only check could step from one terrace level, over a riser, to a
 * DIFFERENT terrace level that happens to sit within limit of the far side —
 * invisible to it, since the two endpoints can be similarly high while the
 * ground between them drops away in a cliff. Steps are spaced ~1 cell apart
 * (`Math.ceil` of the segment length), matching `heightAt`'s own
 * grain, so no riser narrower than a full cell can hide between two
 * consecutive samples.
 *
 * Ground legality of the endpoints is NOT this function's job — callers that
 * need it call `isWalkableCell` too (see `isWalkableCell`'s own doc). This
 * function answers exactly one question: is the SLOPE crossable.
 */
export function canTraverseSegment(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const limit = profile.maxGradientPerCell;
  if (!Number.isFinite(limit)) return true; // water-ground: no risers to cross.

  const dx = toX - fromX;
  const dy = toY - fromY;
  // Math.sqrt, NOT Math.hypot, and the result is consumed by Math.ceil on the
  // very next line. This is the determinism rule in CLAUDE.md being obeyed to
  // the letter, and it is load-bearing now that this predicate lives in
  // shared/ and BOTH sides run it: ECMA-262 specifies Math.sqrt as IEEE-754
  // correctly-rounded, but leaves Math.hypot implementation-approximated — it
  // is explicitly allowed to differ between engines and versions. One ULP of
  // disagreement either side of an integer flips `steps`, which moves every
  // sample position, which can flip this function's verdict; server and client
  // would then disagree about whether a walker may cross a slope. Harmless
  // while this code was server-only (it came from plugins/wildlife); a real
  // divergence risk the moment it moved here.
  const distance = Math.sqrt(dx * dx + dy * dy);
  // At least one step even for a same-cell probe; otherwise ~1 sample per
  // cell of travel, per the "no riser can hide between samples" argument above.
  const steps = Math.max(1, Math.ceil(distance));

  let previousHeight = world.heightAt(Math.floor(fromX), Math.floor(fromY));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const sampleX = Math.floor(fromX + dx * t);
    const sampleY = Math.floor(fromY + dy * t);
    const height = world.heightAt(sampleX, sampleY);
    if (Math.abs(height - previousHeight) > limit) return false;
    previousHeight = height;
  }
  return true;
}

/**
 * Is the straight line from (fromX, fromY) to (toX, toY) somewhere `profile`
 * may GO — ground legality AND slope, sampled the whole way along?
 *
 * ROOT CAUSE THIS FIXES (owner report, 2026-08-24: whales "will do 90-degree
 * turns in place and have a tendency to glitch into the seabed"; fish "get
 * stuck in place"). The steering sweep used to ask two questions about a
 * candidate heading: `isWalkableCell` at the FAR END of the probe, and
 * `canTraverseSegment` along it. For a mover with a finite gradient limit the
 * second one incidentally sampled the interior of the path; for a mover with
 * `UNCONSTRAINED_GRADIENT_PER_CELL` — every swimmer and every boat — it
 * returns `true` on its first line without reading a single height, so
 * NOTHING looked at the ground between the mover and its look-ahead point.
 *
 * A whale therefore probed twenty cells ahead, found deep water at the far
 * end, and swam straight at a shallow ridge sitting ten cells in front of it:
 * invisible until the per-tick destination re-check refused a 0.32-cell step,
 * at which point the only heading left was a hard one. That is the reported
 * "90-degree turn in place", and the frames before it — a five-unit body
 * pressed against a bank its centre had not reached yet — are the reported
 * clipping.
 *
 * ONE PREDICATE, ONE LOOP, and that is the point: "may I be there" and "may I
 * get there" were two functions, so a profile that answered the second one
 * vacuously silently stopped asking the first one anywhere but at the end
 * point. Merging them means a sample is a sample — every point on the path is
 * tested for everything — and the gradient term costs nothing extra because
 * it reuses the height this loop already fetched.
 *
 * THE START CELL IS NOT GROUND-CHECKED, only used as the gradient's first
 * height. A mover already standing somewhere illegal (the terrain was sculpted
 * under it) must still be able to steer OUT; vetoing every heading because the
 * cell under its own body fails would freeze it exactly where it most needs to
 * move.
 *
 * Sample spacing is `canTraverseSegment`'s, unchanged and for its reason: ~1
 * cell, matching `heightAt`'s own grain, so nothing narrower than a full cell
 * can hide between two consecutive samples. `Math.sqrt` rather than
 * `Math.hypot` for the determinism reason spelled out there.
 */
export function canProceedAlong(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const limit = profile.maxGradientPerCell;
  const checksGradient = Number.isFinite(limit);

  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(distance));

  let previousHeight = world.heightAt(Math.floor(fromX), Math.floor(fromY));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const sampleX = Math.floor(fromX + dx * t);
    const sampleY = Math.floor(fromY + dy * t);
    if (
      sampleX < 0 ||
      sampleY < 0 ||
      sampleX >= world.worldSize ||
      sampleY >= world.worldSize
    ) {
      return false;
    }

    const height = world.heightAt(sampleX, sampleY);
    if (checksGradient && Math.abs(height - previousHeight) > limit) return false;
    previousHeight = height;

    if (height < profile.minGroundHeight) return false;
    if (!profile.grounds.includes(groundOf(height))) return false;
    const freshwater = (world.freshwater ?? NO_FRESHWATER).at(sampleX, sampleY);
    if (!admitsFreshwater(profile.freshwater, freshwater)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The archetypes — the shipped answers to "what may this thing cross?"
//
// NAMED HERE, ONCE, rather than built per plugin. Before 2026-08-20 each
// plugin assembled its own profile literal, which is how pilgrims ended up
// with wildlife's PRE-fix rule (this file's own header) and how "the yeti
// swims" was a sentence nobody could write down. A plugin now picks the
// archetype that describes its mover and adds nothing; a mover whose rule is
// genuinely new earns a new archetype here, where every other rule is visible
// beside it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A legged thing on dry ground: pilgrims, wanderers, wildlife's grazer.
 * Terrace risers are walls (LAND_WALKER_MAX_GRADIENT_PER_CELL), the band-0
 * waterline fringe is not ground (LAND_WALKER_MIN_GROUND_HEIGHT), and a river
 * or a lake is something to go around.
 */
export const LAND_WALKER_PROFILE: TraversalProfile = {
  grounds: ['dry'],
  minGroundHeight: LAND_WALKER_MIN_GROUND_HEIGHT,
  freshwater: 'blocked',
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
};

/**
 * A land animal long-legged enough to ford a river but not to swim a lake —
 * the terrestrial-monster rule (owner, 2026-08-20). Identical to
 * LAND_WALKER_PROFILE but for the one axis that differs, written as a spread
 * so the two can never drift on the axes they share.
 */
export const RIVER_FORDING_WALKER_PROFILE: TraversalProfile = {
  ...LAND_WALKER_PROFILE,
  freshwater: 'channels',
};

/**
 * Equally at home wet or dry — the yeti (owner, 2026-08-20: "the Yeti should
 * easily be able to traverse water"). Every ground class, fresh water no
 * obstacle, and NO minimum ground height, because the band-0 fringe reading
 * as water is precisely not a problem for something that swims.
 *
 * The gradient limit STAYS the land walker's: an amphibious animal is still
 * a legged animal on the dry stretches, and a terrace riser it could not
 * climb on land does not become climbable because there is a lake nearby.
 */
export const AMPHIBIOUS_WALKER_PROFILE: TraversalProfile = {
  grounds: ['dry', 'shallow', 'deep'],
  minGroundHeight: UNCONSTRAINED_MIN_GROUND_HEIGHT,
  freshwater: 'all',
  maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL,
};

/**
 * Anything that floats on or swims through the sea and treats the whole of it
 * as open: boats (owner, 2026-08-20: "boats should be able to go anywhere in
 * the water"), and the sea monsters that range across both depths. Shallows
 * and deeps alike, no gradient limit (a seabed has no risers to a hull),
 * fresh water passable — an estuary is still water.
 */
export const OPEN_WATER_PROFILE: TraversalProfile = {
  grounds: ['shallow', 'deep'],
  minGroundHeight: UNCONSTRAINED_MIN_GROUND_HEIGHT,
  freshwater: 'all',
  maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL,
};

/**
 * Bound to ONE water band — wildlife's coastal and open-sea species, which
 * are placed by a habitat census that means the band literally. Built by
 * function rather than named twice because the two differ in exactly one
 * field and nothing else about them is a decision.
 */
export function waterBandProfile(ground: 'shallow' | 'deep'): TraversalProfile {
  return {
    grounds: [ground],
    minGroundHeight: UNCONSTRAINED_MIN_GROUND_HEIGHT,
    freshwater: 'all',
    maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL,
  };
}
