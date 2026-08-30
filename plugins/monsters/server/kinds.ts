// The monster table: one profile per kind, every number named and justified.
//
// Two rules govern this file, both inherited from the wildlife plugin's
// species table for the same reasons:
//
//   1. Sizes and depths are written in BAND_HEIGHT / cell terms, never as raw
//      height units. BAND_HEIGHT is explicitly provisional (shared/src/
//      constants.ts "feel-tune in Phase 2"); "three bands below the sea"
//      survives a retune, "-192" does not.
//   2. Rates are per SECOND of simulated time and are consumed through
//      rollEvent (./rng.ts), so behaviour is identical at any TICK_HZ.
//
// It is a TABLE rather than a set of cthulhu-named globals because the
// singleton, the summon roll, the lair test, the banishment rule and the
// terrain guard are all written against the profile, not against Cthulhu:
// adding a kraken was adding a row plus a model, and adding a yeti was a row, a
// model and one new HABITAT REGIME (./habitat.ts) — not editing the lifecycle.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE KINDS, AND THE AXES THAT SEPARATE THEM (owner decisions, 2026-08-14)
//
//                    Cthulhu          Kraken            Yeti
//   habitat          any deep basin   a TRENCH, big     high snow
//   banishable       NO, ever         not for now       yes, level it
//   blocks raising   yes              no                no
//
// Cthulhu and the kraken are deliberately opposite on both behavioural axes:
// Cthulhu is the horror you cannot do anything about (you may not even build
// over him), the kraken is the one you can fight with a shovel. The yeti takes
// the kraken's corner of that table in the OTHER habitat — you drove the kraken
// off by taking its water away, and you drive the yeti off by taking his
// altitude away. Neither behaviour is written into the lifecycle —
// `banishment: null` and `protectsGround` are fields, so a fourth kind picks
// its own corner of the same table.
//
// AMENDED 2026-08-19 — THE KRAKEN'S MIDDLE CELL IS NOW EMPTY (owner: "For now,
// no eviction. Later, if we do boats, they can attack the kraken."). "Fight it
// with a shovel" was the paragraph above's whole argument for the kraken, and a
// correctness pass found the code never implemented it: the collapse test
// counted DEEP-WATER cells, not trench cells, so refilling its trench did
// nothing, draining it properly meant raising ~87% of a fresh world's ocean,
// and the only cheap counter was walling it into a pocket — a trick nothing
// documented. Rather than retune three numbers to rescue a mechanic nobody had
// designed, the owner withdrew it until it has a fiction: BOATS attack the
// kraken (backlog issue #43), terrain does not.
//
// SO THE TABLE'S SHAPE SURVIVES AND ONLY THE KRAKEN'S ROW MOVED: the yeti is
// still the banishable kind, Cthulhu is still the one nothing touches, and the
// kraken now sits between them — removable in principle (it keeps a cooldown
// and a BanishmentRule, which is what boats will hang off) but with nothing in
// the world today that removes it, save the physics every kind obeys: raise the
// ground out from under it and it cannot stay standing on land.
// ─────────────────────────────────────────────────────────────────────────────

import {
  AMPHIBIOUS_WALKER_PROFILE,
  BAND_HEIGHT,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_STEP,
  NEIGHBOURHOOD_CELLS,
  OPEN_WATER_PROFILE,
  SEA_COLUMN_BANDS,
  SEA_LEVEL,
  WORLD_UNIT_CELLS,
  cellsAcross,
  type TraversalProfile,
} from '@terrace/shared';
import { MONSTER_KINDS, type MonsterKind } from '../protocol.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  HABITAT_REGIMES,
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
  WATER_HABITAT,
  habitatBoundaryHeight,
  type HabitatRegime,
  type LairFitRule,
} from './habitat.ts';

// MAX_LIVING_MONSTERS_PER_KIND MOVED TO ../protocol.ts (2026-08-29) — see the
// note on MAX_LIVING_MONSTERS below, which is derived from it.
import { MAX_LIVING_MONSTERS_PER_KIND } from '../protocol.ts';
export { MAX_LIVING_MONSTERS_PER_KIND };

// MAX_LIVING_MONSTERS MOVED TO ../protocol.ts (2026-08-29), with
// MAX_LIVING_MONSTERS_PER_KIND: it is the cap the CLIENT half's draw budget is
// written against (part B of docs/plans/frame-budget-growth-and-draw-calls.md),
// and a client half may not import a plugin's server half. Re-exported here so
// every importer that had it from this module keeps working.
import { MAX_LIVING_MONSTERS } from '../protocol.ts';
export { MAX_LIVING_MONSTERS };

/**
 * Mean wait, in simulated seconds, between a world becoming eligible and a
 * monster arriving. THE dial for how often the event happens.
 *
 * PLUGIN-WIDE, NOT PER KIND, and that is the decision the single name records:
 * arrival pacing is a statement about how often this plugin interrupts a
 * session, which is the same question whichever animal answers the door. What
 * differs between kinds is WHERE they can live, not how eagerly they come. The
 * profile field stays per-kind so a future kind CAN differ; every row today
 * points at this one number rather than at three copies of it.
 *
 * NOTE ON THE PER-HABITAT SLOTS: each habitat rolls its own arrival, so a world
 * that can host both a sea kind and the yeti sees two independent Poisson
 * processes at this rate rather than one. That is the intended reading — "how
 * often does the sea produce a horror" and "how often does the mountain" are
 * separate questions — and it is why the mean is stated per kind rather than
 * per world.
 *
 * 240 s = 4 minutes. The roll is a Poisson process of rate 1/240 per second
 * (see rollEvent), so the derivation is exact rather than approximate:
 *
 *   P(arrived within  30 s) = 1 - e^(-30/240)  ≈ 12%
 *   P(arrived within 240 s) = 1 - e^(-1)       ≈ 63%
 *   P(arrived within 600 s) = 1 - e^(-2.5)     ≈ 92%
 *
 * That is the shape the brief asks for: never on the first minute of a session
 * as a matter of course, essentially certain across an evening's play, and with
 * no fixed timer a player could learn to count down. Arrival is an EVENT.
 */
export const SUMMON_MEAN_WAIT_SECONDS = 240;

// ── Cthulhu ──────────────────────────────────────────────────────────────────

/**
 * Cells in the smallest deep-water region Cthulhu will accept as a lair, given
 * as a multiple of a chunk's area.
 *
 * Four chunks — 1024 cells, a 32×32 basin if it were square. Sized off the
 * animal, not off taste: Cthulhu's footprint is ~7 cells across, so 32 cells is
 * about four and a half body-widths in every direction. That is the smallest
 * region in which it can lurk and wander for minutes without its shoulders
 * grinding along a shoreline — which is the actual failure mode the threshold
 * exists to prevent. A Cthulhu in a puddle is comedy, not horror.
 *
 * For scale: a nominal half-water 512² world holds ~79 000 deep cells, so this
 * is 1.3% of one — a real basin, and easily dug on purpose by a player who
 * wants one.
 */
export const LAIR_MIN_AREA_CHUNKS = 4;
export const MIN_LAIR_DEEP_CELLS =
  LAIR_MIN_AREA_CHUNKS * NEIGHBOURHOOD_CELLS * NEIGHBOURHOOD_CELLS;

/**
 * Lurking speed, cells per second — a quarter of a WORLD UNIT per second,
 * converted (see WORLD_UNIT_CELLS: every speed and body size in this file is a
 * fact about the world, stated in world units and multiplied into the sampling
 * grid, so the 2026-08-21 re-sample could not shrink the bestiary).
 *
 * 0.25 — under a third of the wildlife plugin's whale (0.8 cells/s), which is
 * the slowest thing otherwise in the water, and it crosses one chunk in just
 * over a minute. Read alongside the ~7-cell body: it covers a third of its own
 * width per second, which at any watchable camera distance is the difference
 * between "swimming" and "the horizon is moving".
 */
export const CTHULHU_LURK_SPEED_CELLS_PER_SECOND = cellsAcross(0.25);

/**
 * Maximum random heading change, radians per second. 0.1 rad/s is ~6°/s: over a
 * ten-second stretch it can drift a right angle at most, so its course reads as
 * inexorable rather than as browsing. (The wildlife whale, the least twitchy
 * creature there, is 0.25.)
 */
export const CTHULHU_TURN_NOISE_RADIANS_PER_SECOND = 0.1;

/**
 * IDLE BEATS — the long holds that make it read as watching rather than
 * commuting. A two-state Poisson process, both rates named here:
 *
 *   onset 0.05/s → while moving, a mean 20 s before it stops;
 *   end   0.12/s → once stopped, a mean 8.3 s of absolute stillness.
 *
 * Steady state is onset/(onset+end) ≈ 29% of the time stationary, in beats
 * averaging eight seconds. Eight seconds is the number chosen first: it is long
 * enough that a player watching it notices the stillness and starts wondering,
 * and short enough that it never reads as a frozen entity or a stuck server.
 */
export const CTHULHU_IDLE_ONSET_PER_SECOND = 0.05;
export const CTHULHU_IDLE_END_PER_SECOND = 0.12;

/**
 * Horizontal extent of the modelled body, in cells — seven WORLD UNITS,
 * converted, which is the unit the client model is built in. Wing tip to wing
 * tip on the client model — see
 * client/anatomy.ts, which is where the silhouette's numbers live.
 *
 * The server needs it for two things: steering (a monster must never commit to
 * a step that would put its SHOULDER through a cliff, so the look-ahead probe
 * is never shorter than half of this) and, for a kind that protects its ground,
 * the radius of the terrain it forbids raising (./protection.ts).
 */
export const CTHULHU_FOOTPRINT_CELLS = cellsAcross(7);

/**
 * Cells of Cthulhu's lair he must actually FIT ON — one body's worth of area,
 * `footprint²`, which at 28 cells across is 784 (owner decision, 2026-08-26;
 * see MonsterProfile.minLairFittingCells for why the rule is an area rather
 * than a typed number).
 *
 * WHAT IT MEANS FOR A PLAYER, stated plainly so nobody meets it as a surprise.
 * On a fresh all-ocean world it is met trivially and changes nothing — the sea
 * is one region tens of thousands of cells wide. On a SCULPTED basin it is a
 * real second bar: 784 fitting cells is a 28×28 core of legal centres, and a
 * body 28 cells across has to sit inside that core, so a square basin dug for
 * Cthulhu now has to be roughly 28 + 28 = 56 cells across rather than merely
 * MIN_LAIR_DEEP_CELLS in total area. A compact basin that clears the area bar
 * (16 384 cells, ~128 across) clears this one comfortably; what no longer
 * passes is the same area drawn as a channel or a crescent.
 */
export const CTHULHU_MIN_LAIR_FITTING_CELLS = Math.ceil(CTHULHU_FOOTPRINT_CELLS ** 2);

// ── Kraken ───────────────────────────────────────────────────────────────────

/**
 * Cells in the smallest region the kraken will accept, as a multiple of a
 * chunk's area.
 *
 * Nine chunks — 2304 cells, a 48×48 basin if it were square, and 2.25× the
 * Cthulhu threshold. Derived from the way it MOVES rather than from its size
 * (the two animals are the same 7 cells across): the kraken cruises at 0.6
 * cells/s, so it crosses Cthulhu's minimum 32-cell basin in 53 seconds and
 * would spend its life turning at a shoreline — which reads as an animal pacing
 * a tank, the opposite of the thing that came up from the deep. 48 cells is 80
 * seconds of straight travel, long enough that its course reads as a patrol
 * between the turns.
 */
export const KRAKEN_LAIR_MIN_AREA_CHUNKS = 9;
export const KRAKEN_MIN_LAIR_DEEP_CELLS =
  KRAKEN_LAIR_MIN_AREA_CHUNKS * NEIGHBOURHOOD_CELLS * NEIGHBOURHOOD_CELLS;

/**
 * How deep the deepest cell of the kraken's lair must be, in bands below sea
 * level. THE FIELD THAT MAKES A SECOND KIND MEAN SOMETHING: Cthulhu takes any
 * deep water, the kraken wants a trench.
 *
 * DERIVED from the deepest ocean floor a world NATURALLY shows (owner-decided
 * 2026-08-19), superseding the original "half the water column" derivation
 * (which gave 8 bands, −512). That fraction had two failures the owner's
 * decision removes:
 *
 *   * it sat one band below the deepest natural genesis floor, so every world
 *     demanded one MANDATORY manual dig before its first kraken — friction,
 *     not gameplay;
 *   * it was anchored to the whole water column, so Deep Strata (which
 *     deepened MIN_HEIGHT, shared constants) would have silently dragged the
 *     bar from 8 to 12 bands — the opposite of the decision. The crust is not
 *     sea; a deeper world floor says nothing about what "deep water" means.
 *
 * THE MECHANISM, MEASURED RATHER THAN ASSERTED. The first version of this
 * comment derived the bar from three claims about worldgen, and a correctness
 * pass (2026-08-19, read against server/src/world/world.ts and measured over
 * 400 seeds) found all three wrong. They are corrected here rather than
 * deleted, because the SHAPE of the derivation is what the owner ratified and
 * the next person will re-derive from it:
 *
 *   * GENESIS WRITES EXACT BAND MULTIPLES, AND KEEPS THEM. `World.createFresh`
 *     never smooths: every cell is `outerTerrainBandAt(...) * BAND_HEIGHT`, a
 *     floored integer band. So a FRESH world's floor is always a whole band,
 *     and the −496 the live world reads is not a genesis height at all — it is
 *     a genesis floor some later EDIT relaxed. (Nor is that shave capped at
 *     MAX_STEP / 2: relaxation moves the lower cell by `floor(e/2)` of the
 *     excess `e` over MAX_STEP — `ceil(e/2)` until 2026-08-29, when the split
 *     was made exact so the pass conserves height, issue #108 — and either way
 *     that is only half of ONE step's excess. A floor beside a neighbour
 *     raised again and again rises again and again.)
 *   * BAND −8 IS NOT THE DEEPEST an ordinary ocean settles at. The noise
 *     lattice draws band offsets across its whole
 *     [OUTER_TERRAIN_MIN_BAND_OFFSET, OUTER_TERRAIN_MAX_BAND_OFFSET] =
 *     [−10, +4] range, so the deepest floor is a per-seed draw, not a
 *     constant: over 400 seeds at 512² the world-wide deepest cell was band
 *     −10 in 12% of worlds and band −3 — the starter square's FRESH_SEABED
 *     clamp, i.e. no deep ocean anywhere — in 23%.
 *   * THE BAR THEREFORE REMOVES THE MANDATORY DIG FOR SOME WORLDS, NOT ALL.
 *     Only UNLOCKED cells are habitat (isLairCell), and on day one that is the
 *     starter square alone; over the same 400 seeds its deepest cell clears 7
 *     bands in 121 of them — 30%. The other 70% still dig, which is the
 *     paragraph below, restated as the common case rather than the exception.
 *
 * SUPERSEDED THE SAME DAY, on the TERRAIN half only (owner decision
 * 2026-08-19, after the correctness pass above surfaced the number): worldgen
 * now GUARANTEES the deep floor rather than rolling for it. Genesis surveys the
 * oceans its noise drew and, when none of them is both lair-sized and deep
 * enough, cuts a trench to the reference band through the deepest one it has
 * (server/src/world/world.ts, "The trench"). So the third bullet's measurement
 * still describes the NOISE — and the monsters suite goes on pinning that it
 * does, so the guarantee can never quietly become vacuous — but it no longer
 * describes a shipped world: every fresh world now CONTAINS a qualifying basin,
 * at 128² and 512² alike, measured over 48 seeds through the real survey.
 *
 * NOTHING ON THIS SIDE MOVED. The bar is still 7 bands, still derived the same
 * way, and the generator restates it rather than importing it (pinned both ways
 * in test/monsters.test.ts). What changed is where the trench comes from. The
 * UNLOCK half of the sentence is untouched and still true: a basin outside the
 * starter square is habitat only once a player's territory reaches it, so day
 * one remains a mixture and progression still means something.
 *
 * WHY 7 IS STILL THE RIGHT NUMBER, on the corrected facts: it is the deepest
 * bar that admits BOTH an untouched band-8 genesis floor and that same floor
 * after one one-band relaxation shave (−496), expressed in the whole bands the
 * admission test (reachesIntoHabitat) counts — floor((8·64 − 16) / 64) = 7. The
 * `− MAX_STEP / 2` is a ONE-BAND MARGIN against relaxation, not a bound on it.
 * Going shallower to make the dig-free case universal is not on the table: the
 * shallowest "deepest natural floor" a world can have is the 3-band
 * FRESH_SEABED clamp, which is Cthulhu's own line, and a kraken bar there
 * would erase the only thing separating the two sea kinds. Moving it is an
 * owner decision, not a tuning one. `test/monsters.test.ts` pins every claim
 * above against the real generator, so none of them can rot again.
 *
 * Worlds whose noise never dipped that deep no longer exist as SHIPPED worlds
 * — see the supersession above; genesis gives every one of them a trench. The
 * bar still does not hand every puddle a kraken, and that is still the point:
 * a basin must be lair-sized AND reach this depth AND be unlocked. What the
 * guarantee removed is the coin toss on the middle condition, not the other
 * two.
 *
 * STATED IN HEIGHT UNITS SINCE 2026-08-20, band count derived, matching the
 * core-side restatement in server/src/world/world.ts. As "band 8" the whole
 * kraken bar was a function of the render quantum and would have moved to a
 * quarter of its depth on a re-terraced world.
 *
 * For scale against the other threshold: the deep-water line is 192 units, so a
 * kraken trench is still well over twice as deep as the shallowest water
 * Cthulhu will take.
 */
export const WORLD_WATER_COLUMN_BANDS = SEA_COLUMN_BANDS;

/**
 * The band a world WITH a deep ocean is taken to bottom out at — the reference
 * the owner's bar is set from.
 *
 * NOT "the deepest band genesis produces" (it was named that, wrongly, until
 * the correctness pass above): the lattice can reach band −10, and a calm
 * seed reaches only −3. Eight is the reference point, and what makes it the
 * right one is the sentence in the mechanism above — it is the shallowest
 * reference whose derived bar still keeps the kraken meaningfully deeper than
 * Cthulhu.
 *
 * As of the 2026-08-19 guarantee it is also the band genesis's trench pass cuts
 * its floor TO, so on a world that needed a trench this is not a reference at
 * all but the literal depth of the ocean floor. Core restates the number rather
 * than importing it; the two are pinned equal in test/monsters.test.ts.
 */
export const GENESIS_DEEP_OCEAN_REFERENCE_DEPTH = 512;
export const GENESIS_DEEP_OCEAN_REFERENCE_BAND =
  GENESIS_DEEP_OCEAN_REFERENCE_DEPTH / BAND_HEIGHT;

/**
 * That reference floor with one band of relaxation margin taken off it: the
 * height the owner's decision names (−496 below sea, as a positive depth).
 * See the mechanism above for why the margin is a margin and not a bound.
 */
export const NATURAL_OCEAN_FLOOR_MIN_DEPTH =
  GENESIS_DEEP_OCEAN_REFERENCE_DEPTH - MAX_STEP / 2;

export const KRAKEN_LAIR_MIN_DEPTH_BANDS = Math.floor(
  NATURAL_OCEAN_FLOOR_MIN_DEPTH / BAND_HEIGHT,
);

// THE KRAKEN'S COLLAPSE THRESHOLD USED TO LIVE HERE, and its absence is the
// 2026-08-19 owner ruling ("For now, no eviction. Later, if we do boats, they
// can attack the kraken"), not an oversight — see the amendment in this file's
// header and the one in summoning.ts.
//
// It was KRAKEN_LAIR_COLLAPSE_AREA_CHUNKS = 2 (512 cells), justified as a
// quarter of the arrival threshold for hysteresis. The hysteresis reasoning was
// sound; what was wrong was the quantity being measured. It counted cells of
// the DEEP-WATER region (3 bands, the habitat's own floor) rather than of the
// TRENCH the kraken actually demanded (7 bands), so the mechanic the comment
// advertised — "drain its trench and it goes" — could not fire from draining a
// trench at all. That is recorded here rather than in a commit message because
// the next person to give the kraken a departure rule needs to know which of
// the two regions to count, and the honest answer is neither by default: the
// boats arc should remove it because something FOUGHT it, not because a region
// crossed a number.
//
// The kraken's row keeps its BanishmentRule and its cooldown (below). Only the
// threshold is gone, expressed as a null `lairCollapseCells` so the field goes
// on meaning "losing the habitat around it removes it" for the kind that still
// works that way — the yeti — instead of becoming a dead 0 on every row.

/**
 * Simulated seconds after a kraken is banished before it may be rolled for
 * again. Ten minutes.
 *
 * Draining its trench is the only way a player can be rid of it, so being rid
 * of it has to feel earned and has to LAST — long enough to reshape the coast,
 * not so long that a world becomes permanently monster-free by accident. With
 * the 4-minute mean wait on top, a player who banishes it and then refloods the
 * trench waits ~14 minutes on average for the sequel.
 *
 * AMENDED 2026-08-19: draining is no longer a way to be rid of it — the
 * collapse threshold is gone (owner ruling, see this file's header). What can
 * still banish a kraken is raising the seabed under its own feet, which
 * enforceHabitat answers, and that is the departure this cooldown governs
 * today. The figure is DELIBERATELY UNCHANGED and the constant is DELIBERATELY
 * KEPT: ten minutes is the right absence for any cause, the reasoning above
 * transfers to the boats arc unaltered (being rid of it should be earned and
 * should last), and deleting the number would mean re-deriving it from scratch
 * the day something is allowed to drive the kraken off on purpose.
 */
export const KRAKEN_RESPAWN_COOLDOWN_SECONDS = 600;

/**
 * Cruising speed, cells per second.
 *
 * 0.6 — 2.4× Cthulhu's lurk and still below the wildlife whale's 0.8, so
 * nothing in the water is faster than the whale. It is the difference the two
 * kinds are BUILT around: Cthulhu broods in place and the kraken hunts, and at
 * 0.6 cells/s it covers most of a body-width every ten seconds, which is a
 * speed you can watch it make progress at without it ever looking like a boat.
 */
export const KRAKEN_LURK_SPEED_CELLS_PER_SECOND = cellsAcross(0.6);

/**
 * Maximum random heading change, radians per second. 0.18 rad/s is ~10°/s —
 * nearly twice Cthulhu's drift and still under the whale's 0.25: it prowls,
 * changing its mind on the scale of a few seconds, where Cthulhu's course is
 * inexorable.
 */
export const KRAKEN_TURN_NOISE_RADIANS_PER_SECOND = 0.18;

/**
 * IDLE BEATS, the mirror image of Cthulhu's:
 *
 *   onset 0.02/s → while moving, a mean 50 s before it stops;
 *   end   0.20/s → once stopped, a mean 5 s hold.
 *
 * Steady state is 0.02/0.22 ≈ 9% of the time stationary, in beats averaging
 * five seconds — a third of Cthulhu's share, in beats little more than half as
 * long. The stillness is Cthulhu's characteristic behaviour, so the kraken must
 * not borrow it: it pauses the way a hunter pauses, briefly and rarely.
 */
export const KRAKEN_IDLE_ONSET_PER_SECOND = 0.02;
export const KRAKEN_IDLE_END_PER_SECOND = 0.2;

/**
 * Horizontal extent of the modelled body, in cells: the crown of arms, tip to
 * tip (client/kraken-anatomy.ts).
 *
 * The SAME 7 cells as Cthulhu, and deliberately so rather than by coincidence.
 * The footprint is the number the steering look-ahead is sized from and the
 * number the atmosphere (client/dread.ts) keeps its lightning clear of, so a
 * wider second kind would have meant re-deriving effects that were tuned around
 * the first one. The kraken is built to fit inside the same 7 cells — it is a
 * different SHAPE in the same box, which is where a silhouette should differ
 * anyway. A test pins the model's reach against it.
 */
export const KRAKEN_FOOTPRINT_CELLS = cellsAcross(7);

/**
 * The same rule as CTHULHU_MIN_LAIR_FITTING_CELLS, from the kraken's own
 * footprint — the two animals are the same 28 cells across, so the two numbers
 * are the same 784 today, and each follows its own model if either is resized.
 * Restated rather than shared for exactly that reason: one constant would make
 * the two kinds one body again, which is the failure this table is built to
 * avoid.
 *
 * Trivially met on a fresh all-ocean world; on a sculpted trench it means the
 * same ~56-cells-across shape requirement Cthulhu's note spells out, inside a
 * region that must already carry KRAKEN_MIN_LAIR_DEEP_CELLS of water.
 */
export const KRAKEN_MIN_LAIR_FITTING_CELLS = Math.ceil(KRAKEN_FOOTPRINT_CELLS ** 2);

// ── Yeti ─────────────────────────────────────────────────────────────────────
//
// The first LAND kind (owner request, 2026-08-14: "I would like to see a snow
// Yeti that spawns in the high Alps"). Everything below is stated against the
// land habitat — cells at or above SNOW_LINE_BANDS_ABOVE_SEA (habitat.ts) —
// exactly as the two sea kinds are stated against deep water. Nothing in the
// lifecycle knows which habitat it is reading.

/**
 * Horizontal extent of the modelled body, in world units: shoulder to shoulder,
 * including the arms that hang either side of them (client/yeti-anatomy.ts).
 *
 * 1.203, against the sea kinds' seven, and the gap is the point rather than an
 * accident of modelling. Cthulhu and the kraken are gods that rise out of an
 * ocean; the yeti is an ANIMAL, and as of the owner's 2026-08-22 and 2026-08-24
 * decisions a SMALL one — still under a quarter of the five world units he was.
 * The client half states the same number and a test fails the day the two
 * disagree, so a change to the model has to touch both.
 *
 * THE LITERAL IS UNROUND ON PURPOSE. Over there it is SOLVED — the client walks
 * the widest variant's own masses, limbs and horns, in every pose the gait can
 * take, and takes the furthest from the axis (client/yeti-anatomy.ts,
 * solveBounds) — so this is that answer written out to the last digit that
 * round-trips through a double, which is what lets the pinning test compare with
 * `toBe` instead of a tolerance. Do not tidy it; re-derive it.
 *
 * ONE FOOTPRINT FOR ALL FOUR VARIANTS (2026-08-26). The client half states a
 * width per variant and this is pinned to the WIDEST of them
 * (YETI_WIDEST_VARIANT_WIDTH_CELLS) — see that constant for why the server
 * steers the broadest body rather than the rolled one: the look-ahead and the
 * minimum lair are both decided before a variant exists, and a footprint that
 * under-stated the widest yeti would walk that one's shoulder into a cliff its
 * centre point cleared.
 *
 * IT WENT UP A THIRD WHEN THE FOUR BODIES LANDED, from 0.901 to 1.203, and the
 * reason is the SILVERBACK: he is a knuckle-walker with a gorilla's shoulders
 * and the widest stance of the four, where the single body this replaced was a
 * narrow upright. The other three come in at or under the old number (ram
 * 0.969, fanged 0.901, ibex 0.667). His minimum lair below is DERIVED from
 * this, so it rises with the square — 29 snow cells to 52 — which is still
 * inside the connected snowfield the 2026-08-23 reachability amendment was
 * measured against (79 cells), and it is the SIZE moving rather than the
 * divisor, which is what that amendment asked for.
 */
export const YETI_FOOTPRINT_CELLS = cellsAcross(1.2031547978277752);

/**
 * Cells in the smallest snowfield the yeti will accept as a lair, as a multiple
 * of a chunk's area.
 *
 * TWO chunks — 512 cells, a ~23×23 field if it were square — and it is DERIVED
 * from Cthulhu's threshold rather than picked: his 1024 cells is 32 cells
 * across for a 7-cell body, which that constant justifies as "about four and a
 * half body-widths in every direction … the smallest region in which it can
 * lurk and wander for minutes without its shoulders grinding along a shoreline".
 * The same 4.5 body-widths for a 5-cell yeti is 22.5 cells across, i.e. 506
 * cells, and two chunks is the nearest chunk multiple above it.
 *
 * IT IS ALSO THE CONSTRAINT THAT DECIDES WHETHER HE EVER EXISTS, which the
 * water thresholds never had to worry about. A fresh world is all ocean and no
 * land (design record, 2026-08-14 genesis): every snow cell in the world is one
 * a player raised nine bands out of the sea. 512 cells of it is a real project —
 * roughly a couple of hundred hard-stamp strokes with the level-fill brush — and
 * that is the intended weight of the event. Four chunks, the sea threshold
 * verbatim, would have doubled a bill that is already the largest thing this
 * plugin asks of a player.
 *
 * AMENDMENT (owner decision, 2026-08-19): the bar is lowered to ONE THIRD of
 * the above so a yeti is reachable without a mega-project. What it counts is
 * unchanged: a TOTAL over one connected, flood-filled region, of any shape —
 * never a chunk grid cell, never a bounding box.
 *
 * SECOND AMENDMENT (owner decision, 2026-08-22, with the quarter-size rescale):
 * it is now WRITTEN as the argument above rather than as a chunk count that
 * happened to equal it. Four and a half body-widths across, squared, cut by the
 * 2026-08-19 third — which reproduces the old number to within 1% at his old
 * size (4.5 × 20 cells = 90 across, 8 100 square, 2 700 against the 2 730 that
 * stood here) and, unlike a chunk count, follows the animal when he changes
 * size. At the YETI_FOOTPRINT_CELLS of that day, 5, that is 168 cells, a ~13×13 patch: a small
 * creature wants a small territory, and a snowfield that used to be a project is
 * now a modest hilltop.
 *
 * THIRD AMENDMENT (owner decision, 2026-08-23: "just substantially reduce the
 * requirements needed to spawn these things"). 168 was still more snow than any
 * world on this machine had ever held. Measured the same day, the only world
 * anyone had sculpted (Frostwick Hollows) carried 241 snow cells in total but
 * its largest CONNECTED field — which is what this threshold counts — was 79, so
 * the yeti was unreachable on the one mountain range that existed. The divisor
 * goes from three to nine, i.e. one and a half body-widths of room rather than
 * four and a half, and the threshold with it: 56 cells, a ~7.5×7.5 patch, which
 * that range clears with room to spare.
 *
 * THE FLOOR THIS CANNOT GO BELOW, stated so a fourth amendment does not have to
 * rediscover it: the yeti's own footprint is YETI_FOOTPRINT_CELLS², and at the
 * 2026-08-24 size that is 13 cells against a 29-cell threshold — he already
 * occupies nearly half his own lair, exactly as he did at 25-against-56. A lair
 * he fills is not a lair, and further cuts should move his SIZE, which this
 * constant follows, rather than this divisor.
 *
 * FOURTH AMENDMENT (2026-08-26) — THE NUMBER IS UNCHANGED AND IS NO LONGER THE
 * BAR THAT DECIDES; YETI_MIN_LAIR_FITTING_CELLS below is, and this is the cheap
 * filter in front of it. A cell count says how much snow a region holds and nothing about
 * its SHAPE, and the two came apart: a 52-cell ribbon one cell wide cleared this
 * threshold, so the yeti was summoned onto a cell his body does not fit on and
 * lived out his life in lurk.ts's pinched-body fallback with his flanks in the
 * rock. Since today a region must ALSO contain at least one cell whose CENTRED
 * BODY POSE is entirely snow (habitat.ts's LairFitRule, counted by the survey
 * into LairRegion.fittingCells and required by summoning.ts's bestLairFor), and
 * the summon cell is picked from exactly those cells.
 *
 * THE ARITHMETIC, at today's numbers: 52 cells is a square ~7.2 cells across;
 * the yeti is YETI_FOOTPRINT_CELLS = 4.81 across, so the fitting core of such a
 * square — the set of centres whose whole body is inside it — is ~7.2 − 4.81 ≈
 * 2.4 cells across, about 6 cells. He fits, with roughly his own radius of room
 * to travel in. That was judged too thin the same day: the owner's answer was
 * not to move this number but to add the fitting bar, which asks for 24 such
 * cells and so wants a snowfield ~9.7 cells across (≈95 cells) before he will
 * come. This constant therefore no longer decides anything on its own — it
 * remains the floor on how much snow there must be, and the cheap test the
 * survey applies first. Raising it is still the owner's dial.
 */

/**
 * How many of its own body-widths of room a lurking monster wants in every
 * direction — the figure Cthulhu's own threshold is justified by, named here so
 * the yeti's can be derived from it instead of restating the arithmetic.
 */
export const LAIR_BODY_WIDTHS_ACROSS = 4.5;

/**
 * The reachability cut, as the divisor it is — 2026-08-19's third, deepened to
 * a ninth on 2026-08-23. See the amendments above.
 */
export const YETI_LAIR_REACHABILITY_DIVISOR = 9;

export const YETI_MIN_LAIR_SNOW_CELLS = Math.floor(
  (LAIR_BODY_WIDTHS_ACROSS * YETI_FOOTPRINT_CELLS) ** 2 / YETI_LAIR_REACHABILITY_DIVISOR,
);

/**
 * Cells of his snowfield the yeti must actually FIT ON — his own footprint
 * squared, one body's worth of ground to roam, which at YETI_FOOTPRINT_CELLS =
 * 4.81 is 24 (owner decision, 2026-08-26).
 *
 * THIS IS THE BAR THAT NOW DECIDES, and YETI_MIN_LAIR_SNOW_CELLS above is the
 * cheap first filter in front of it: a raw cell count is one increment per cell
 * of the survey's walk, where a fitting cell is a nine-probe pose test, so the
 * count goes first and this one settles it.
 *
 * THE ARITHMETIC, so the two numbers can be compared without re-deriving them.
 * The fitting core of a square snowfield `S` cells across is `(S − 4.81)²`
 * (the body has to sit inside the field), so reaching 24 fitting cells needs
 * `S ≈ 4.81 + √24 ≈ 4.8 + 4.9 = 9.7` cells across — about 95 snow cells, where
 * the raw bar asks for 52 (a 7.2-cell square, whose fitting core is only ~6
 * cells). So a square lair now has to be roughly twice the AREA the cell count
 * alone demanded, and a ribbon of any length does not qualify at all. The 52
 * stays as written because it is a floor on the amount of snow, not on the
 * shape of it; this is the shape.
 */
export const YETI_MIN_LAIR_FITTING_CELLS = Math.ceil(YETI_FOOTPRINT_CELLS ** 2);

/**
 * How high the highest cell of the yeti's lair must be, in bands above sea.
 *
 * NO EXTRA DEMAND: the global snow line IS his habitat, exactly as the deep
 * water line is Cthulhu's. The field exists so a future land kind can want a
 * summit the way the kraken wants a trench; the yeti is the kind that takes any
 * snow it can stand on.
 */
export const YETI_LAIR_MIN_HEIGHT_BANDS = SNOW_LINE_BANDS_ABOVE_SEA;

/**
 * How much smaller than its arrival threshold a lair must get before its
 * occupant leaves. A QUARTER.
 *
 * Hysteresis, and not sloppiness: arrival and departure being the same number
 * would mean a player idly nibbling the rim of a marginal lair could evict the
 * monster and re-qualify the lair repeatedly, turning a dread event into a light
 * switch. Two distinct numbers mean the habitat has to be genuinely, visibly
 * gone before the thing goes.
 *
 * Named here rather than left implicit because the kraken's pair (9 chunks
 * arriving, 2 leaving) already encoded it — its own comment called 2/9 "a
 * quarter" — and a second kind reproducing that ratio by hand is how two
 * different hysteresis rules end up in one table. The kraken's numbers were NOT
 * re-derived from this: they were owner-settled and 2 chunks is a rounder number
 * than 2.25 would be; this is the rule new rows follow.
 *
 * THE KRAKEN'S HALF OF THAT STORY IS HISTORY as of 2026-08-19 — it has no
 * collapse threshold any more (owner ruling, see this file's header), so the
 * yeti is the only kind this divisor governs. It is kept, and kept general,
 * because it is the RULE rather than the row: the argument it encodes — that
 * arrival and departure must be two different numbers or the monster becomes a
 * light switch — is what any future departure rule has to satisfy, the boats
 * arc's included.
 */
export const LAIR_COLLAPSE_HYSTERESIS_DIVISOR = 4;

/**
 * Cells in its own snowfield below which the yeti's lair has COLLAPSED and he
 * leaves: a quarter of the arrival threshold above — 14 cells against its 56,
 * a ~3.7×3.7 patch.
 *
 * AREA ONLY, DELIBERATELY — not height, for the reason the kraken's collapse
 * test is area-only: re-testing an arrival condition every five seconds is the
 * light switch above. What drives him off is a player carving the snow away from
 * under him until there is not enough of it left to be a mountain, and the
 * cheapest way to do that is to take the whole massif below the snow line — one
 * band off the top turns every cell of a level plateau to bare rock at once.
 */
export const YETI_LAIR_COLLAPSE_SNOW_CELLS = Math.floor(
  YETI_MIN_LAIR_SNOW_CELLS / LAIR_COLLAPSE_HYSTERESIS_DIVISOR,
);

/**
 * Simulated seconds after a yeti is driven off before he may be rolled for
 * again. Ten minutes.
 *
 * The same figure the kraken serves, reached from the opposite direction and
 * therefore worth stating rather than copying. Levelling a snowfield is FASTER
 * than draining a trench: a hard stamp takes a whole band off ~45 cells at a
 * time and the level-fill brush works the highest band first, so the ~512 cells
 * of his lair drop below the snow line in a couple of dozen strokes. A cheap
 * eviction is exactly the case that needs a LONG absence — anything shorter and
 * a player could toggle him off and on inside one sculpting session, and an
 * arrival is supposed to be an event. Ten minutes is long enough to outlast the
 * session that evicted him and short enough that a world does not become
 * permanently monster-free by accident; with the 4-minute mean wait on top, a
 * player who levels his peak and then rebuilds it waits ~14 minutes for the
 * sequel.
 */
export const YETI_RESPAWN_COOLDOWN_SECONDS = 600;

/**
 * Ambling speed, cells per second.
 *
 * 0.1125 — a quarter of the 0.45 that stood here, cut alongside the body by the
 * owner's 2026-08-22 rescale, because A SPEED IS A LENGTH PER SECOND: a
 * quarter-size animal holding the old speed crosses its own body four times as
 * fast as it used to, and that is scurrying rather than ambling.
 *
 * WHAT THE ORIGINAL 0.45 WAS ARGUED FROM SURVIVES THE CUT, which is why the cut
 * is the right one. He covers his own width in the same eleven seconds — a walk
 * you can watch make progress, and never a stride — and he is still far under
 * the wildlife plugin's grazer (1.6 cells/s), the animal he shares the hillside
 * with, so he cannot read as livestock. What he is no longer between is the two
 * sea kinds' speeds (Cthulhu's 0.25 brood, the kraken's 0.6 hunt): those are
 * gods four to nine times his size and comparing their absolute speeds to his
 * stopped meaning anything the moment he stopped being their scale.
 *
 * The client half restates this as YETI_AMBLE_SPEED_CELLS_PER_SECOND and derives
 * his step rate from it (client/yeti-anatomy.ts), so his feet cannot skate; a
 * test pins the two together.
 */
export const YETI_AMBLE_SPEED_CELLS_PER_SECOND = cellsAcross(0.08110465116279071);

/**
 * Maximum random heading change, radians per second. 0.35 rad/s is ~20°/s —
 * twice the kraken's drift, a third of the wildlife grazer's 1.1.
 *
 * A walker picks its way: it is turning around rocks and along a ridge, not
 * holding a course through open water, so the two sea kinds' near-inexorable
 * drift would read as a man on rails. A grazer's 1.1 is the other failure —
 * that is browsing, which is a small animal's behaviour.
 */
export const YETI_TURN_NOISE_RADIANS_PER_SECOND = 0.35;

/**
 * IDLE BEATS — and they are decomposed the OPPOSITE way from Cthulhu's on
 * purpose:
 *
 *   onset 0.08/s → while moving, a mean 12.5 s before he stops;
 *   end   0.25/s → once stopped, a mean 4 s hold.
 *
 * Steady state is 0.08/0.33 ≈ 24% of the time stationary, in beats averaging
 * four seconds. That is a similar SHARE to Cthulhu's 29% and a completely
 * different rhythm: his is a few long broods (8.3 s each), the yeti's is many
 * short halts. Share is not what a player reads — beat length is. A yeti that
 * held still for eight seconds at a time would be borrowing the one behaviour
 * the table says is Cthulhu's, and four seconds is the length of a halt that
 * reads as an animal checking the wind before it moves on.
 */
export const YETI_IDLE_ONSET_PER_SECOND = 0.08;
export const YETI_IDLE_END_PER_SECOND = 0.25;

// ── The table ────────────────────────────────────────────────────────────────

/**
 * How a kind can be driven out of the world, or `null` for one that cannot.
 *
 * THE POINT OF THE NULL (owner decision, 2026-08-14): Cthulhu cannot be
 * banished by any means. Expressing that as a missing RULE rather than as a
 * `banishable: false` flag is what keeps the two numbers that only make sense
 * for a banishable kind — the collapse threshold and the cooldown that follows
 * a banishment — from having to exist as dead values on his row. There is
 * nothing to leave unset and nothing to accidentally read.
 */
export interface BanishmentRule {
  /**
   * Habitat cells in its own region below which it leaves, or NULL for a kind
   * that losing the habitat AROUND it does not remove.
   *
   * THE TWO QUESTIONS ARE SEPARATE, which is why this is nullable inside a rule
   * that is itself nullable, and the pair is not one flag: `banishment === null`
   * asks "can anything remove this kind at all" (Cthulhu: no), and this asks
   * "does its habitat shrinking do it" (the kraken since the 2026-08-19 owner
   * ruling: no). A kraken can still be removed — the ground under its own feet
   * becoming land removes it, which is enforceHabitat, and it serves a cooldown
   * when it happens — it simply has no threshold on the region's SIZE.
   *
   * Null rather than a sentinel 0 or Infinity: those are numbers that a
   * comparison silently accepts, and "no threshold" then reads as "a threshold
   * nothing can cross", which is the same behaviour by accident instead of on
   * purpose. Null makes the collapse test say `continue` in so many words.
   */
  readonly lairCollapseCells: number | null;
  /** Simulated seconds of enforced absence after a banishment. */
  readonly respawnCooldownSeconds: number;
}

/** Tuning for one kind. All rates are per SECOND of simulated time. */
export interface MonsterProfile {
  readonly kind: MonsterKind;

  /**
   * WHERE IT LIVES — the half of the heightmap this kind's every rule is read
   * against (habitat.ts). It decides which survey admits it, which cells its
   * steering will accept, and which of the world's monster slots it contests.
   *
   * It is the regime VALUE rather than an id plus a lookup, so a row cannot name
   * a habitat that does not exist and no call site has to resolve one.
   */
  readonly habitat: HabitatRegime;

  /** Habitat cells required in one connected region before this kind arrives. */
  readonly minLairCells: number;
  /**
   * FITTING cells required in that same region — cells whose CENTRE POSE holds
   * this kind's whole body inside the habitat (habitat.ts's LairFitRule, counted
   * by the survey into LairRegion.fittingCells). Owner decision, 2026-08-26.
   *
   * IT IS ROOM TO ROAM, NOT SOMEWHERE TO ARRIVE, and the distinction is load
   * bearing: it counts poses anywhere in the region and pays no attention to
   * `minLairReachBands`, exactly as lurk.ts's steering does. The arrival bar is
   * a separate count (LairRegion.summonableCells) that gate 3 only requires to
   * be non-zero. Folding the two together would have made a natural-floor ocean
   * refuse the kraken — he arrives in 177 cells of trench and lives in eighty
   * thousand cells of basin — and the owner settled on 2026-08-19 that the
   * natural floor admits him with no digging.
   *
   * TWO BARS, BECAUSE THEY MEASURE DIFFERENT THINGS. `minLairCells` measures how
   * much habitat there is; this measures how much of it the ANIMAL can be in,
   * and a region can be enormous on the first and empty on the second — a
   * 52-cell snow ribbon one cell wide was the shipped case, and the yeti born in
   * it lived pinched. The first bar is also the cheap one, so it stays: it is a
   * counter incremented per cell, where this is a nine-probe pose test.
   *
   * EVERY ROW DERIVES IT FROM ITS OWN FOOTPRINT — `ceil(footprintCells²)`, one
   * body's worth of area to roam — rather than typing a number. That is the
   * owner's rule stated in the unit it was decided in ("the animal can move at
   * least its own area"), and it follows the kind when its model is resized,
   * which is exactly how the yeti's other thresholds went stale.
   */
  readonly minLairFittingCells: number;
  /**
   * How far INTO its habitat the lair's most extreme cell must reach, in bands
   * from sea level — deeper for a water kind, higher for a land one. The
   * habitat's own threshold (habitat.ts) is the floor for every kind; a kind may
   * demand more, and the kraken does.
   */
  readonly minLairReachBands: number;

  /** Mean simulated seconds from "eligible" to "arrived". See rollEvent. */
  readonly summonMeanWaitSeconds: number;

  /** How it can be driven off, or null if nothing can drive it off. */
  readonly banishment: BanishmentRule | null;

  /**
   * True if this kind vetoes RAISE intents whose brush reaches its body (see
   * ./protection.ts). Lowering is always allowed — for a banishable kind that
   * is the eviction, and for Cthulhu it is the only sculpt near him that still
   * does anything.
   */
  readonly protectsGround: boolean;

  /** Wander speed while not idling, cells per second. */
  readonly lurkSpeedCellsPerSecond: number;
  /** Maximum random heading change, radians per second. */
  readonly turnNoiseRadiansPerSecond: number;

  /** Rate of entering an idle beat while moving. */
  readonly idleOnsetPerSecond: number;
  /** Rate of leaving an idle beat. */
  readonly idleEndPerSecond: number;

  /** Widest horizontal extent of the model, in cells. */
  readonly footprintCells: number;

  /**
   * WHAT IT MAY CROSS, in shared's own vocabulary (shared/src/traversal.ts) —
   * the axis `habitat` above cannot express, added 2026-08-20 on the owner's
   * ask: "the Yeti should easily be able to traverse water. Same with
   * terrestrial monsters, though the terrestrial monsters should only be able
   * to traverse the rivers, not the lakes."
   *
   * ORTHOGONAL TO `habitat`, NOT A REPLACEMENT FOR IT, and the split is worth
   * stating because the two look similar. `habitat` answers "how far into deep
   * water / how far above the snow line must this cell be" — a question about
   * REACH that only this plugin asks, and the one that decides where a lair
   * may form and how a kind is driven off. This answers "is there fresh water
   * in the way", which every mover in the game asks and which the heightmap
   * alone cannot answer (a river runs across dry ground). Both are checked;
   * neither subsumes the other.
   *
   * ALWAYS AN ARCHETYPE, never a literal — see traversal.ts on why a per-caller
   * literal is how this contract drifted the first time.
   */
  readonly traversal: TraversalProfile;
}

export const MONSTER_PROFILES: Readonly<Record<MonsterKind, MonsterProfile>> = {
  cthulhu: {
    kind: 'cthulhu',
    habitat: WATER_HABITAT,
    minLairCells: MIN_LAIR_DEEP_CELLS,
    minLairFittingCells: CTHULHU_MIN_LAIR_FITTING_CELLS,
    // No extra demand: the global deep-water line IS his habitat.
    minLairReachBands: DEEP_WATER_BANDS_BELOW_SEA,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    // HE CANNOT BE BANISHED. See BanishmentRule and summoning.ts.
    banishment: null,
    protectsGround: true,
    lurkSpeedCellsPerSecond: CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: CTHULHU_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: CTHULHU_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: CTHULHU_IDLE_END_PER_SECOND,
    footprintCells: CTHULHU_FOOTPRINT_CELLS,
    // A sea kind is at home in the whole sea, and an estuary is still water.
    traversal: OPEN_WATER_PROFILE,
  },
  kraken: {
    kind: 'kraken',
    habitat: WATER_HABITAT,
    minLairCells: KRAKEN_MIN_LAIR_DEEP_CELLS,
    minLairFittingCells: KRAKEN_MIN_LAIR_FITTING_CELLS,
    minLairReachBands: KRAKEN_LAIR_MIN_DEPTH_BANDS,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    // NO COLLAPSE THRESHOLD (owner, 2026-08-19: "For now, no eviction. Later,
    // if we do boats, they can attack the kraken"). The rule is present, not
    // null, and that is the distinction the table draws: something CAN remove
    // a kraken — the seabed rising under its own feet does, and this cooldown
    // is what follows — but no amount of taking the ocean away around it will.
    banishment: {
      lairCollapseCells: null,
      respawnCooldownSeconds: KRAKEN_RESPAWN_COOLDOWN_SECONDS,
    },
    protectsGround: false,
    lurkSpeedCellsPerSecond: KRAKEN_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: KRAKEN_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: KRAKEN_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: KRAKEN_IDLE_END_PER_SECOND,
    footprintCells: KRAKEN_FOOTPRINT_CELLS,
    traversal: OPEN_WATER_PROFILE,
  },
  yeti: {
    kind: 'yeti',
    habitat: LAND_HABITAT,
    minLairCells: YETI_MIN_LAIR_SNOW_CELLS,
    minLairFittingCells: YETI_MIN_LAIR_FITTING_CELLS,
    // No extra demand: the snow line IS his habitat, as the deep-water line is
    // Cthulhu's. Both of the "takes any of it" kinds sit at their habitat's own
    // threshold, and both of them are the kind a world gets first.
    minLairReachBands: YETI_LAIR_MIN_HEIGHT_BANDS,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    // LEVELLING HIS PEAKS DRIVES HIM OFF. Same machinery as the kraken's
    // drained trench, pointed at the land predicate.
    banishment: {
      lairCollapseCells: YETI_LAIR_COLLAPSE_SNOW_CELLS,
      respawnCooldownSeconds: YETI_RESPAWN_COOLDOWN_SECONDS,
    },
    // HE DOES NOT BLOCK SCULPTING, and the two fields are one decision: a
    // banishable kind that vetoed raises would be half-vetoing its own counter,
    // and a player who wants him gone has to be able to reach the ground he is
    // standing on. Cthulhu is the only kind that gets both.
    protectsGround: false,
    lurkSpeedCellsPerSecond: YETI_AMBLE_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: YETI_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: YETI_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: YETI_IDLE_END_PER_SECOND,
    footprintCells: YETI_FOOTPRINT_CELLS,
    // THE YETI SWIMS (owner, 2026-08-20: "the Yeti should easily be able to
    // traverse water"), so a tarn or a meltwater channel in his snowfield is
    // scenery rather than a wall. What this does NOT change is where he lives:
    // his snowfield confinement is the `habitat` field above and the banishment
    // rule beside it — settled, and levelling his peaks is still how he goes.
    // Amphibious means the water inside his range stops being an obstacle, not
    // that his range grew.
    //
    // A future TERRESTRIAL monster that is not amphibious picks
    // RIVER_FORDING_WALKER_PROFILE instead — long-legged enough to ford the
    // channel, not to swim the lake. That archetype exists and is tested; the
    // yeti is simply not its subject, because the owner named him on the other
    // side of the line.
    traversal: AMPHIBIOUS_WALKER_PROFILE,
  },
};

/** Deterministic iteration order over kinds (see MONSTER_KINDS). */
export function profileOf(kind: MonsterKind): MonsterProfile {
  return MONSTER_PROFILES[kind];
}

/**
 * Summon rate in events per second — the reciprocal of the mean wait, which is
 * the exact relationship for the Poisson process rollEvent implements. Derived
 * here rather than written into the table so the tuning dial stays the number a
 * human can reason about ("four minutes"), with no second constant to keep in
 * sync with it.
 */
export function summonRatePerSecond(profile: MonsterProfile): number {
  return 1 / profile.summonMeanWaitSeconds;
}

/**
 * The height this kind's lair must reach past — at or below it for a water
 * kind, at or above it for a land one. Bands are what the table states (rule 1
 * at the top of this file); heights are what the survey measures, and this is
 * the one place the two meet.
 *
 * The admission test itself is `reachesIntoHabitat` (habitat.ts), which compares
 * in the habitat's own direction so no caller has to know which way that is.
 * This is here for the tests and for anyone reading a profile who wants the
 * number in world terms.
 */
export function minLairExtremeHeight(profile: MonsterProfile): number {
  return habitatBoundaryHeight(profile.habitat, profile.minLairReachBands);
}

/**
 * Extra cells of no-raise standoff around a ground-protecting monster, beyond
 * its own half-width. ONE cell, and it is derived rather than picked.
 *
 * One sculpt intent does not stop at its brush footprint: gradient relaxation
 * (shared/heightmap.ts) then pulls each over-steep 4-neighbour pair halfway
 * together. The expression is the STAIRCASE BOUND — how many cells of full
 * MAX_STEP rise it takes to absorb one raise — and at today's ratio
 * (DEFAULT_SCULPT_AMOUNT = 2 × MAX_STEP) the actual arithmetic lands on the
 * same answer: on flat ground a +64 raise lifts its 4-neighbour by half the
 * 32-unit excess, and the cell beyond THAT sees a 16-unit step, well inside the
 * limit, and is left alone. One cell is how far an edit reaches past its own
 * footprint on terrain that is not already at the gradient limit.
 *
 * RESIDUAL, STATED RATHER THAN PAPERED OVER: on ground that IS everywhere at
 * the limit, relaxation carries a diminishing ripple much further (a ±1 step
 * can travel until it meets slack terrain or SMOOTH_PASS_LIMIT), so no fixed
 * radius can promise that the seabed under a monster is never lifted by a
 * distant edit. This guard is about what a player may AIM at; the consequence
 * of the residual is bounded by the kind that uses it being unbanishable, so
 * the worst outcome is a monster left standing in a puddle (see summoning.ts),
 * never one silently destroyed by an edit made a hundred cells away.
 */
export const MONSTER_GROUND_STANDOFF_CELLS = DEFAULT_SCULPT_AMOUNT / MAX_STEP - 1;

/**
 * Radius, in cells, of the ground this kind forbids raising, measured from its
 * live (fractional) position. Half the body plus the standoff above — 4.5 cells
 * for both of today's 7-cell kinds.
 */
/**
 * Radius, in cells, of the monster's own BODY — half its footprint, and nothing
 * else. 3.5 cells for both of today's 7-cell sea kinds.
 *
 * DISTINCT FROM `groundProtectionRadiusCells`, which is this plus the sculpt
 * standoff, and the two must not be confused: the standoff answers "what may a
 * player AIM at", which has to allow for gradient relaxation reaching a cell
 * past the brush, whereas this answers "where IS the animal", which is a fact
 * about the model and owes nothing to how sculpting spreads. Steering (lurk.ts)
 * wants this one — holding a monster a standoff away from its own shoreline
 * would keep it a cell offshore of water it can legitimately occupy.
 */
export function bodyRadiusCells(profile: MonsterProfile): number {
  return profile.footprintCells / 2;
}

export function groundProtectionRadiusCells(profile: MonsterProfile): number {
  return profile.footprintCells / 2 + MONSTER_GROUND_STANDOFF_CELLS;
}

/** The kinds, in the fixed order the summoner considers them. */
export const SUMMON_ORDER: readonly MonsterKind[] = MONSTER_KINDS;

/**
 * The kinds that live in one habitat, in SUMMON_ORDER.
 *
 * Computed once per regime at module load rather than filtered per summon
 * attempt: the summon pass runs every tick for every empty slot, and this is a
 * fixed property of the table. Empty for a habitat no kind claims, which is a
 * legal (if dull) table — the summoner simply never fills that slot.
 */
const KINDS_BY_HABITAT: ReadonlyMap<HabitatRegime, readonly MonsterKind[]> = new Map(
  HABITAT_REGIMES.map((regime) => [
    regime,
    SUMMON_ORDER.filter((kind) => MONSTER_PROFILES[kind].habitat === regime),
  ]),
);

export function kindsInHabitat(regime: HabitatRegime): readonly MonsterKind[] {
  return KINDS_BY_HABITAT.get(regime) ?? [];
}

/**
 * The whole-body admission rules of one habitat's kinds, in the same
 * SUMMON_ORDER `kindsInHabitat` reports them in — what `surveyLairs` counts
 * fitting cells against (2026-08-26).
 *
 * Precomputed beside KINDS_BY_HABITAT and for the same reason: it is a fixed
 * property of the table, and the survey asks for it on an interval forever.
 * Derived from the profiles rather than restated, so a kind that changes size
 * or depth bar changes the rule the survey counts by in the same edit.
 */
const LAIR_FIT_RULES_BY_HABITAT: ReadonlyMap<HabitatRegime, readonly LairFitRule[]> = new Map(
  HABITAT_REGIMES.map((regime) => [
    regime,
    kindsInHabitat(regime).map((kind) => ({
      radiusCells: bodyRadiusCells(MONSTER_PROFILES[kind]),
      minReachBands: MONSTER_PROFILES[kind].minLairReachBands,
    })),
  ]),
);

export function lairFitRulesInHabitat(regime: HabitatRegime): readonly LairFitRule[] {
  return LAIR_FIT_RULES_BY_HABITAT.get(regime) ?? [];
}

/**
 * Where this kind sits in its own habitat's lists — the index that reads its
 * row out of `LairRegion.fittingCells`, and the ONE place the alignment between
 * `kindsInHabitat`, `lairFitRulesInHabitat` and that array is stated.
 *
 * -1 is unreachable for a kind of the table (every kind is in exactly one
 * habitat's list by construction); it is what `indexOf` returns and the caller
 * reads it as "no fitting count", which fails closed.
 */
export function habitatKindIndex(kind: MonsterKind): number {
  return kindsInHabitat(MONSTER_PROFILES[kind].habitat).indexOf(kind);
}
