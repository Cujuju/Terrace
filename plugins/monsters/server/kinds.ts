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
//   banishable       NO, ever         yes, drain it     yes, level it
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
// ─────────────────────────────────────────────────────────────────────────────

import { BAND_HEIGHT, CHUNK_SIZE, DEFAULT_SCULPT_AMOUNT, MAX_STEP, SEA_COLUMN_BANDS, SEA_LEVEL } from '@terrace/shared';
import { MONSTER_KINDS, type MonsterKind } from '../protocol.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  HABITAT_REGIMES,
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
  WATER_HABITAT,
  habitatBoundaryHeight,
  type HabitatRegime,
} from './habitat.ts';

/**
 * HARD SINGLETON, PER HABITAT REGIME. Each habitat holds at most this many
 * living monsters, of any kind that lives there, ever, at once.
 *
 * ONE PER HABITAT, NOT ONE PER WORLD (owner decision, 2026-08-14 — superseding
 * the world-wide cap of one). The owner's original brief was "no more than one
 * per map", and it was written as a single world-wide slot because every kind
 * that existed lived in the sea: two sea horrors in one ocean is a bestiary, and
 * the dramatic weight of this plugin is that the thing in the water is THE thing
 * in the water.
 *
 * A MOUNTAIN YETI DOES NOT CONTEND FOR THAT. He occupies a disjoint half of the
 * heightmap: no player can see him and the kraken in one frame without also
 * seeing the sea and a snow line, and a world where digging a trench silently
 * cost you the yeti on the peak you spent an hour building reads as a BUG rather
 * than as scarcity. Scarcity is preserved exactly where it means something — the
 * sea still holds one thing, and the snow still holds one thing.
 *
 * The invariant remains STRUCTURAL rather than counted: summoning.ts holds one
 * nullable slot per regime, so a second monster in one habitat is
 * unrepresentable (see the note at the top of that file).
 *
 * SUPERSEDED 2026-08-19 (owner decision: "let's allow multiple sea monsters to
 * spawn" — the kraken had never once appeared, because Cthulhu takes the sea
 * slot first and nothing short of his impossible banishment frees it). The
 * singleton is now PER KIND, not per habitat: the sea may hold one Cthulhu AND
 * one kraken at once. Everything the paragraphs above argue survives at the
 * kind level — an arrival is still an event, and "the thing in the water" is
 * still the only one of ITS kind in the water; what changes is that two
 * different horrors no longer contend for one slot. The structural invariant
 * moves with it: summoning.ts now holds one nullable slot per KIND (a total
 * record over MonsterKind), so two krakens stay unrepresentable.
 */
export const MAX_LIVING_MONSTERS_PER_KIND = 1;

/**
 * The world-wide ceiling, DERIVED rather than chosen: one per kind, times the
 * kinds that exist. Three today (was: one per habitat, times the habitats —
 * two — until the 2026-08-19 per-kind decision above).
 *
 * It is what the broadcast's bandwidth note and the client's reconcile are sized
 * against, and it is the name to grep for the day the shape of this changes
 * again.
 */
export const MAX_LIVING_MONSTERS = MAX_LIVING_MONSTERS_PER_KIND * MONSTER_KINDS.length;

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
export const MIN_LAIR_DEEP_CELLS = LAIR_MIN_AREA_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Lurking speed, cells per second.
 *
 * 0.25 — under a third of the wildlife plugin's whale (0.8 cells/s), which is
 * the slowest thing otherwise in the water, and it crosses one chunk in just
 * over a minute. Read alongside the ~7-cell body: it covers a third of its own
 * width per second, which at any watchable camera distance is the difference
 * between "swimming" and "the horizon is moving".
 */
export const CTHULHU_LURK_SPEED_CELLS_PER_SECOND = 0.25;

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
 * Horizontal extent of the modelled body, in cells (CELL_WORLD_SIZE is 1, so
 * also world units). Wing tip to wing tip on the client model — see
 * client/anatomy.ts, which is where the silhouette's numbers live.
 *
 * The server needs it for two things: steering (a monster must never commit to
 * a step that would put its SHOULDER through a cliff, so the look-ahead probe
 * is never shorter than half of this) and, for a kind that protects its ground,
 * the radius of the terrain it forbids raising (./protection.ts).
 */
export const CTHULHU_FOOTPRINT_CELLS = 7;

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
export const KRAKEN_MIN_LAIR_DEEP_CELLS = KRAKEN_LAIR_MIN_AREA_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

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
 * THE MECHANISM, so the numbers below are a derivation rather than a ledger:
 * genesis noise floors bottom out in whole bands (world.ts writes band
 * multiples; its lattice reaches OUTER_TERRAIN_MIN_BAND_OFFSET = −10 bands,
 * and band −8 is the deepest an ordinary ocean settles at — the palette's
 * depth ramp documents the same fact from the render side). A genesis floor
 * does not STAY a band multiple: the first relaxation that touches its rim
 * moves the extreme cell by up to half the gradient limit (MAX_STEP / 2 = 16;
 * see shared's smoothing contract, "higher loses floor(e/2)"), which is
 * exactly how the live world's deepest natural floor reads −496 rather than
 * −512. The bar the owner ratified is that RELAXED natural floor, expressed
 * in the whole bands the admission test (reachesIntoHabitat) counts:
 * floor((8·64 − 16) / 64) = 7 bands. A natural −496 trench qualifies; no dig
 * required.
 *
 * Worlds whose noise never dipped to band −8 still summon no kraken until
 * someone digs — unchanged, and correct: the decision removes the mandatory
 * dig from worlds that HAVE a deep floor, it does not hand every puddle a
 * kraken.
 *
 * For scale against the other threshold: the deep-water line is 3 bands, so a
 * kraken trench is still well over twice as deep as the shallowest water
 * Cthulhu will take.
 */
export const WORLD_WATER_COLUMN_BANDS = SEA_COLUMN_BANDS;

/** Deepest band an ordinary genesis ocean settles at (see mechanism above). */
export const DEEPEST_NATURAL_OCEAN_BAND_DEPTH = 8;

/**
 * That floor after the relaxation shave that inevitably reaches it: the
 * height the owner's decision names (−496 below sea, as a positive depth).
 */
export const NATURAL_OCEAN_FLOOR_MIN_DEPTH =
  DEEPEST_NATURAL_OCEAN_BAND_DEPTH * BAND_HEIGHT - MAX_STEP / 2;

export const KRAKEN_LAIR_MIN_DEPTH_BANDS = Math.floor(
  NATURAL_OCEAN_FLOOR_MIN_DEPTH / BAND_HEIGHT,
);

/**
 * Cells in its own region below which the kraken's trench has COLLAPSED and it
 * leaves, as a multiple of a chunk's area.
 *
 * Two chunks (512 cells, ~23×23). A QUARTER of the arrival threshold, which is
 * hysteresis and not sloppiness: arrival and departure being the same number
 * would mean a player idly nibbling the rim of a marginal basin could evict the
 * monster and re-qualify the basin repeatedly, turning a dread event into a
 * light switch. Two distinct numbers mean the water has to be genuinely,
 * visibly gone before it submerges.
 *
 * AREA ONLY, DELIBERATELY — not depth. Refilling the trench to shallower than
 * KRAKEN_LAIR_MIN_DEPTH_BANDS does NOT evict it: the depth requirement says
 * where it comes FROM, and re-testing an arrival condition every five seconds
 * is exactly the light switch the previous paragraph rejects. Draining is the
 * eviction, and it is the one a player can see themselves doing.
 */
export const KRAKEN_LAIR_COLLAPSE_AREA_CHUNKS = 2;
export const KRAKEN_LAIR_COLLAPSE_DEEP_CELLS =
  KRAKEN_LAIR_COLLAPSE_AREA_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Simulated seconds after a kraken is banished before it may be rolled for
 * again. Ten minutes.
 *
 * Draining its trench is the only way a player can be rid of it, so being rid
 * of it has to feel earned and has to LAST — long enough to reshape the coast,
 * not so long that a world becomes permanently monster-free by accident. With
 * the 4-minute mean wait on top, a player who banishes it and then refloods the
 * trench waits ~14 minutes on average for the sequel.
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
export const KRAKEN_LURK_SPEED_CELLS_PER_SECOND = 0.6;

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
export const KRAKEN_FOOTPRINT_CELLS = 7;

// ── Yeti ─────────────────────────────────────────────────────────────────────
//
// The first LAND kind (owner request, 2026-08-14: "I would like to see a snow
// Yeti that spawns in the high Alps"). Everything below is stated against the
// land habitat — cells at or above SNOW_LINE_BANDS_ABOVE_SEA (habitat.ts) —
// exactly as the two sea kinds are stated against deep water. Nothing in the
// lifecycle knows which habitat it is reading.

/**
 * Horizontal extent of the modelled body, in cells: shoulder to shoulder,
 * including the arms that hang either side of them (client/yeti-anatomy.ts).
 *
 * FIVE, against the sea kinds' seven, and the difference is the point rather
 * than an accident of modelling. Cthulhu and the kraken are gods that rise out
 * of an ocean; the yeti is an ANIMAL — the biggest thing on the mountain, and
 * still something a mountain could hold several of. Five cells is also what lets
 * him live on a snowfield a player can plausibly build: his minimum lair below
 * is derived from this number, and a seven-cell yeti would have demanded half
 * again as much snow for the same room to move.
 */
export const YETI_FOOTPRINT_CELLS = 5;

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
 * the above — 170 cells — so a yeti is reachable without a mega-project. The
 * chunk-multiple framing above no longer holds at a third of a chunk, so the
 * source of truth is now the CELL COUNT itself, derived directly from the
 * pre-cut figure this comment justified. What it counts is unchanged: a TOTAL
 * over one connected, flood-filled region, of any shape — never a chunk grid
 * cell, never a bounding box.
 */
export const YETI_MIN_LAIR_SNOW_CELLS = Math.floor((2 * CHUNK_SIZE * CHUNK_SIZE) / 3);

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
 * arriving, 2 leaving) already encodes it — its own comment calls 2/9 "a
 * quarter" — and a second kind reproducing that ratio by hand is how two
 * different hysteresis rules end up in one table. The kraken's numbers are NOT
 * re-derived from this: they are owner-settled and 2 chunks is a rounder number
 * than 2.25 would be; this is the rule new rows follow.
 */
export const LAIR_COLLAPSE_HYSTERESIS_DIVISOR = 4;

/**
 * Cells in its own snowfield below which the yeti's lair has COLLAPSED and he
 * leaves: a quarter of the (now 170-cell) arrival threshold — 42 cells, a
 * ~6.5×6.5 patch.
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
 * 0.45 — between Cthulhu's 0.25 brood and the kraken's 0.6 hunt, and far under
 * the wildlife plugin's grazer (1.6 cells/s), which is the animal he shares the
 * hillside with. That last comparison is the one that matters: a monster that
 * moved at grazer speed would read as livestock, and the whole silhouette
 * argument (a five-cell biped against a one-cell deer) is undone if it also
 * moves like one. At 0.45 cells/s he covers his own five-cell width in eleven
 * seconds — a walk you can watch make progress, and never a stride.
 */
export const YETI_AMBLE_SPEED_CELLS_PER_SECOND = 0.45;

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
  /** Habitat cells in its own region below which it leaves. */
  readonly lairCollapseCells: number;
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
}

export const MONSTER_PROFILES: Readonly<Record<MonsterKind, MonsterProfile>> = {
  cthulhu: {
    kind: 'cthulhu',
    habitat: WATER_HABITAT,
    minLairCells: MIN_LAIR_DEEP_CELLS,
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
  },
  kraken: {
    kind: 'kraken',
    habitat: WATER_HABITAT,
    minLairCells: KRAKEN_MIN_LAIR_DEEP_CELLS,
    minLairReachBands: KRAKEN_LAIR_MIN_DEPTH_BANDS,
    summonMeanWaitSeconds: SUMMON_MEAN_WAIT_SECONDS,
    banishment: {
      lairCollapseCells: KRAKEN_LAIR_COLLAPSE_DEEP_CELLS,
      respawnCooldownSeconds: KRAKEN_RESPAWN_COOLDOWN_SECONDS,
    },
    protectsGround: false,
    lurkSpeedCellsPerSecond: KRAKEN_LURK_SPEED_CELLS_PER_SECOND,
    turnNoiseRadiansPerSecond: KRAKEN_TURN_NOISE_RADIANS_PER_SECOND,
    idleOnsetPerSecond: KRAKEN_IDLE_ONSET_PER_SECOND,
    idleEndPerSecond: KRAKEN_IDLE_END_PER_SECOND,
    footprintCells: KRAKEN_FOOTPRINT_CELLS,
  },
  yeti: {
    kind: 'yeti',
    habitat: LAND_HABITAT,
    minLairCells: YETI_MIN_LAIR_SNOW_CELLS,
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
