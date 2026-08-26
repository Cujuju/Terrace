// structures — the wire contract between the plugin's two halves.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free — the plugin-local equivalent of
// @terrace/shared, exactly as flora/protocol.ts is for that plugin.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: DELTAS, PLUS A SNAPSHOT ON JOIN — the same choice flora made, for the
// same reason. A building never moves. Its life is a handful of events (it is
// founded, it upgrades tier a few times, it is demolished) separated by whole
// CA generations, so a full-state push at any cadence would spend its whole
// budget re-announcing a fact that has not changed. The one addition over
// flora's shape is a THIRD delta kind: `upgraded`, because a standing
// structure can change (its tier) without being founded or demolished —
// flora's trees have no equivalent event.
//
// WHAT "founded" / "upgraded" / "demolished" MEAN UNDER THE HOOD (server/life.ts
// owns the mechanism; this file only carries its output). A cell's life is
// Conway's Game of Life (classic B3/S23) run over the world's buildable
// ground: `founded` is a birth (from the B3 rule, or from an occasional seed
// pattern), `demolished` is a death (the S23 rule, OR a terrain edit under a
// live cell — see life.ts), and `upgraded` is a surviving cell whose TIER
// advanced, which happens on a cell old enough and well-enough-neighboured to
// earn its next tier (tiers.ts). The wire does not know or care that the
// mechanism changed; it only ever described events, never the rule that
// produced them.
// ─────────────────────────────────────────────────────────────────────────────

/** Plugin name on both sides. Also the message namespace. */
export const STRUCTURES_PLUGIN_NAME = 'structures';

/**
 * Server → client, the WHOLE standing-structure list (`structures:all`). Sent
 * to a joining player, at world create, and on the keepalive cadence.
 * Replaces the receiver's entire structure list.
 */
export const STRUCTURES_ALL_MESSAGE = 'all';

/**
 * Server → client, what changed since the last message (`structures:changes`).
 * Applied on top of whatever the receiver already has.
 */
export const STRUCTURES_CHANGES_MESSAGE = 'changes';

/**
 * Hard ceiling on live cells the CA population is allowed to reach.
 *
 * A pure, unbounded B3/S23 board on a large enough buildable area could in
 * principle sustain a live population in the tens of thousands (a glider gun,
 * were one ever to arise from a random soup, produces gliders forever). This
 * plugin has no glider guns in its seed library (see life.ts's
 * CA_FIXED_SEED_PATTERNS) and terrain fragmentation keeps most boards small in
 * practice, but the cap exists so wire size and client instance-buffer size
 * are a CONSTANT regardless — the server refuses new BIRTHS once at the cap
 * (never evicts an already-surviving cell to make room; see life.ts's
 * GenerationSurvey), and the client sizes every tier's InstancedMesh from this
 * one number.
 *
 * 512 — comfortably above what a single 512² world's terrain fragmentation and
 * the shipped seed cadence produce in ordinary play (measured informally
 * against the test suite's worlds; there is no hard formula here, unlike the
 * old settlement-density model this superseded). At 512 × 3 numbers packed
 * (8 B, see below) a full snapshot is ~4 KB — trivial next to flora's 18 KB
 * ceiling, because a CA world of buildings is sparser than a forest.
 */
export const STRUCTURES_CAP = 512;

/** The six tiers, from a lean-to camp to a fortified stone watchtower. */
export const STRUCTURE_TIERS = [
  'camp',
  'hut',
  'timber-house',
  'longhouse',
  'stone-cottage',
  'watchtower',
] as const;

export type StructureTier = number;

/** Number of tiers, and the exclusive upper bound on a tier index. */
export const STRUCTURE_TIER_COUNT = STRUCTURE_TIERS.length;

/** The last, most advanced tier index. */
export const MAX_STRUCTURE_TIER = STRUCTURE_TIER_COUNT - 1;

export function isStructureTier(value: unknown): value is StructureTier {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < STRUCTURE_TIER_COUNT;
}

/**
 * A standing structure. There is at most one per cell by construction — the
 * cell IS the structure's identity, exactly as a tree's cell is its identity
 * in flora — so no id allocator or id persistence is needed anywhere in this
 * plugin.
 */
export interface StructureCell {
  readonly x: number;
  readonly y: number;
  readonly tier: StructureTier;
}

/**
 * Multiplier that packs a cell into one integer key: `y * STRIDE + x`.
 *
 * 65536, exactly flora's choice and for the same reason: the key must be
 * computable before the world size is known (persistence restores before
 * onWorldCreate hands the plugin a world), and the heightmap's Int16 storage
 * caps a real world edge at 32767, so no two cells can collide.
 */
export const STRUCTURES_CELL_KEY_STRIDE = 65536;

/** Cell → integer key. */
export function structureKey(x: number, y: number): number {
  return y * STRUCTURES_CELL_KEY_STRIDE + x;
}

/** Integer key → cell (x, y only — the tier is not part of a cell's identity). */
export function cellOfKey(key: number): { x: number; y: number } {
  return { x: key % STRUCTURES_CELL_KEY_STRIDE, y: Math.floor(key / STRUCTURES_CELL_KEY_STRIDE) };
}

/**
 * Structures → the flat `[x0, y0, t0, x1, y1, t1, …]` wire form. Flat rather
 * than an array of objects for the same reason flora packs trees as pairs: no
 * per-object key strings to re-send under msgpack.
 */
export function packStructureCells(cells: Iterable<StructureCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y, cell.tier);
  return packed;
}

function isCellCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < STRUCTURES_CELL_KEY_STRIDE
  );
}

/**
 * Defensive parse of a flat `[x, y, tier, …]` list. Malformed triples are
 * dropped individually; something that is not an array at all yields null so
 * the caller can ignore the message whole — the same contract
 * flora's parseTreeCells keeps, extended with a tier-range check.
 */
export function parseStructureCells(value: unknown): StructureCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: StructureCell[] = [];
  for (let i = 0; i + 2 < value.length; i += 3) {
    if (cells.length >= STRUCTURES_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    const tier = value[i + 2];
    if (!isCellCoordinate(x) || !isCellCoordinate(y) || !isStructureTier(tier)) continue;
    cells.push({ x, y, tier });
  }
  return cells;
}

/** Bare cells (no tier) — used only for the `demolished` half of a delta. */
export function packCells(cells: Iterable<{ readonly x: number; readonly y: number }>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseCells(value: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(value)) return null;

  const cells: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= STRUCTURES_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

/** `structures:all` — the receiver's whole structure list. */
export interface StructuresAllPayload {
  readonly structures: readonly number[];
}

/**
 * `structures:changes` — what changed. `founded` and `upgraded` both carry
 * tiers (a founding is always tier 0, but sending it through the same packer
 * as `upgraded` means the client has exactly one code path that reads a
 * `[x, y, tier]` triple and sets a cell's tier, whether it is new or not).
 * `demolished` carries bare cells — there is nothing left to say about a
 * removed structure but where it was.
 */
export interface StructuresChangesPayload {
  readonly founded: readonly number[];
  readonly upgraded: readonly number[];
  readonly demolished: readonly number[];
}

export function parseAllPayload(payload: unknown): StructureCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseStructureCells((payload as { structures?: unknown }).structures);
}

export function parseChangesPayload(
  payload: unknown,
): { founded: StructureCell[]; upgraded: StructureCell[]; demolished: Array<{ x: number; y: number }> } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { founded?: unknown; upgraded?: unknown; demolished?: unknown };
  // An absent field reads as empty, not malformed — the same forward-
  // compatibility rule flora's parseChangesPayload keeps.
  const founded = parseStructureCells(message.founded ?? []);
  const upgraded = parseStructureCells(message.upgraded ?? []);
  const demolished = parseCells(message.demolished ?? []);
  if (founded === null || upgraded === null || demolished === null) return null;
  return { founded, upgraded, demolished };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-building variation — the same deterministic-hash trick flora uses for
// its trees, cut down to what a building needs: a facing (yaw) and a small
// uniform scale jitter. There is no "kind" roll here because the tier already
// picks the model; two watchtowers must look like two watchtowers, not two
// species of watchtower.
// ─────────────────────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** Uniform scale bounds applied to a structure's whole model. */
export const STRUCTURE_SCALE_MIN = 0.9;
export const STRUCTURE_SCALE_MAX = 1.1;

// ─────────────────────────────────────────────────────────────────────────────
// THE FOOTPRINT CONTRACT, STATED ONCE (2026-08-21).
//
// How wide, in WORLD UNITS, the widest building the game can roll may be on
// the ground. This is a size on the GROUND — a terrace tread is one world
// unit across (MAX_STEP = BAND_HEIGHT per world unit), and buildings reading
// as roughly one tread wide is the tuned look — so it is stated in world
// units here and DERIVED on both sides, never restated:
//
//   * client/models.ts bounds every tier's unscaled model reach by half of
//     it (divided by STRUCTURE_SCALE_MAX, since variation scale multiplies
//     reach);
//   * server/suitability.ts derives the checked neighbourhood from it via
//     cellsAcross(), so hasClearFootprint always surveys every cell the
//     model could stand on, whatever the sampling density.
//
// Before the 2026-08-21 re-sample the two sides agreed only by accident: the
// client said "half a world unit" while the server checked a hard-coded 3×3
// CELL Moore ring, and one cell happened to be one world unit. At four cells
// per world unit that ring covers 0.75 world units of ground under a 1.0
// world-unit building — ground nobody checked, i.e. the "buildings straddle
// terrace edges" defect live again. Deriving both from this one number is
// what makes that class of drift impossible rather than merely fixed.
// ─────────────────────────────────────────────────────────────────────────────
export const STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS = 1;

export interface StructureVariation {
  /** Yaw about Y, in radians, in [0, 2π) — which way the building faces. */
  readonly yaw: number;
  /** Uniform model scale, in [STRUCTURE_SCALE_MIN, STRUCTURE_SCALE_MAX]. */
  readonly scale: number;
}

/**
 * 32-bit integer hash of a cell — a copy of flora's `hashCell` (own copy per
 * plugin, not an import: every plugin must build and test with every other
 * plugin deleted).
 */
export function hashStructureCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The deterministic variation for the structure at (x, y). Two independent
 * bit slices of one hash, so scale and facing do not correlate.
 */
export function structureVariation(x: number, y: number): StructureVariation {
  const hash = hashStructureCell(x, y);
  const yawRoll = hash & 0xffff;
  const scaleRoll = (hash >>> 16) & 0xff;
  return {
    yaw: (yawRoll / 0x10000) * TWO_PI,
    scale: STRUCTURE_SCALE_MIN + (scaleRoll / 0xff) * (STRUCTURE_SCALE_MAX - STRUCTURE_SCALE_MIN),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Settler races (owner decision 2026-08-19). Every settlement belongs to one
// of two peoples: RUDYS — little dog people — or UNOS — cat people. Race is
// DERIVED, never stored and never on the wire: it is a pure integer function
// of WHERE a settlement stands, so server and client agree without a byte of
// sync and a demolished-then-refounded cell keeps its people.
//
// RACE IS PER DISTRICT, NOT PER CELL, deliberately: a CA cluster is one town,
// and a town whose huts rolled race independently would read as noise, not as
// "a Rudy village". Hashing the district a cell stands in gives whole
// neighbourhoods one people while still splitting the wider world roughly
// evenly between the two.
// ─────────────────────────────────────────────────────────────────────────────

// The one import this dependency-free module allows itself: a district's size
// is a fact about the ground, and @terrace/shared owns how many cells the
// ground is sampled at.
import {
  CELL_WORLD_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';

// ─────────────────────────────────────────────────────────────────────────────
// HOW MUCH GROUND A STANDING STRUCTURE IS GUARANTEED, stated once (2026-08-23).
//
// STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS (above) says how wide a model may be.
// This pair says how much ground the SERVER has actually checked underneath
// it, which is a different — and larger — number, because the server surveys
// whole CELLS: every cell within STRUCTURE_SURVEY_RADIUS_CELLS (Chebyshev) of
// the structure's own cell must be same-band dry land before it may be founded
// (server/suitability.ts). A cell is a square of ground, so the guarantee
// reaches half a cell past the last surveyed sample's centre.
//
// WHY THE CLIENT NEEDS IT TOO, AND WHY IT LIVES HERE. A model is drawn at a
// per-building YAW (structureVariation), and a rotated model sweeps its RADIAL
// reach, not its axis-aligned one — √2 further in the worst case. The
// axis-aligned footprint bound alone therefore does not answer "can this
// building hang over a terrace edge?"; the honest test is
// radial × scale ≤ this radius. That makes it a fact BOTH halves need, which
// is exactly what protocol.ts is for: before this, the server derived the
// survey radius privately and the client had no name for the ground it was
// promised.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chebyshev radius, in CELLS, of the square the server surveys under a
 * structure. The unscaled model reaches half the footprint span in any
 * direction; converted straight through cellsAcross(), that IS the radius to
 * survey, with no extra half-cell term — see suitability.ts's
 * FOOTPRINT_NEIGHBOR_OFFSETS for the inequality.
 */
export const STRUCTURE_SURVEY_RADIUS_CELLS = Math.ceil(
  cellsAcross(STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS / 2),
);

/**
 * The same guarantee in WORLD UNITS: how far from a structure's origin the
 * ground is known to be flat, same-band and dry. The +0.5 is the surveyed
 * cell's own half-width — the guarantee covers the whole cell, not just the
 * sample at its centre. Two cells plus a half at today's sampling: 0.625.
 *
 * A model whose radial reach × STRUCTURE_SCALE_MAX exceeds this can render
 * standing on ground nobody checked; inside it, no yaw and no scale roll can
 * put a vertex over a terrace edge.
 */
export const STRUCTURE_SURVEYED_GROUND_RADIUS =
  (STRUCTURE_SURVEY_RADIUS_CELLS + 0.5) * CELL_WORLD_SIZE;

// ─────────────────────────────────────────────────────────────────────────────
// A BUILDING'S KEEP-CLEAR GROUND (owner, 2026-08-26: "buildings do not spawn
// on top of each other, with the exception of the teepees" — teepees may
// overlap teepees, nothing may overlap a building).
//
// WHY A SEPARATION RULE HAD TO EXIST AT ALL. A cell is a quarter of a world
// unit; every structure model is up to a whole world unit across — four cells
// — and the CA's survival rule (B3/S23) is defined over cells ONE apart. So
// every cluster the CA keeps alive is, by construction, a pile of
// interpenetrating models. Measured 2026-08-26: the camp reaches 0.454 wu
// radially, the longhouse 0.518, against a 0.25 wu cell. The simulation unit
// and the model's footprint differ by 4×, and no amount of tuning inside the
// CA's own rules closes that gap — the rule below is what closes it.
//
// STATED IN WORLD UNITS, BECAUSE THAT IS WHAT IT IS (owner, 2026-08-26: "if
// buildings take up an entire world unit, it would make more sense to do the
// calculation in world units instead of quarter cells"). How far apart two
// models must stand is a fact about MODELS — their reach is measured in world
// units, in a file that has never heard of a cell. Cells are only how the
// board is indexed. So the separation is a world-unit length, and the cell
// arithmetic below is the index-space shadow of it, never the definition.
//
// The rule: no structure may be PLACED within STRUCTURE_SEPARATION_WORLD_UNITS
// of a structure at tier ≥ 1, measured as a EUCLIDEAN distance between
// origins. Read at four places, all of them placements: server/life.ts's
// birth rule and its teepee→building tier gate, its placePatternAt (the
// seeder) and attemptStir, and index.ts's canFoundStructure (a settler moving
// in). A building that spawns CLEARS this ground of the teepees standing in
// it, and thereafter nothing may be placed inside it.
//
// EUCLIDEAN, NOT CHEBYSHEV — corrected 2026-08-26, having shipped as a square
// first. A model sweeps a DISC (that is what a yaw roll makes of it), so two
// models overlap exactly when their origins are closer than the sum of their
// radii — a radial test. Reserving the enclosing SQUARE instead also reserved
// its corners, which stand √2 further out than the rule needs: 120 cells held
// against 68, 43% of the ground taken for nothing, and buildings pushed to
// 2.12 wu apart diagonally when 1.25 is the honest bound.
//
// TEEPEES ARE EXEMPT OF EACH OTHER, deliberately: tents cluster — a camp is
// many tents on adjoining cells — and the CA needs dense Moore neighbourhoods
// to work at all. The rule is about a BUILDING's ground only.
//
// DERIVED, NOT TUNED: a model at max variation scale, yawed to its worst
// case, sweeps at most STRUCTURE_SURVEYED_GROUND_RADIUS from its origin —
// exactly the bound test/models.test.ts enforces. Two structures therefore
// cannot overlap once their origins are 2 × that radius apart. The half-cell
// already inside that radius IS the safety margin, which is why the test
// below is a strict `<`: at exactly the separation the two worst-case discs
// are tangent, and tangent is not overlapping.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far apart two structures must stand, in WORLD UNITS — the rule itself,
 * and the only form of it that is a statement about the models. 1.25 today.
 */
export const STRUCTURE_SEPARATION_WORLD_UNITS = STRUCTURE_SURVEYED_GROUND_RADIUS * 2;

/**
 * The same length in cells, SQUARED — the number the test actually compares
 * against, so a placement check is `dx * dx + dy * dy < this` over integer
 * cell offsets: no square root, no float on the left-hand side, one fixed
 * double on the right, and therefore the same answer on every machine (the
 * determinism rule in CLAUDE.md).
 *
 * NOT ROUNDED, unlike the scan bound below. This is the rule; rounding it
 * either way would move the rule rather than the loop that hunts for it.
 */
export const STRUCTURE_SEPARATION_CELLS_SQUARED =
  cellsAcross(STRUCTURE_SEPARATION_WORLD_UNITS) ** 2;

/**
 * How far the search for a nearby building has to look, in whole cells — the
 * bounding box around the disc, and NOTHING else. A cell outside this box
 * cannot be within the separation; a cell inside it still has to pass the
 * squared-distance test above.
 *
 * CEILED because cellsAcross returns world units × WORLD_UNIT_CELLS and has
 * no obligation to land on a whole cell (5 exactly, today). Rounding a scan
 * bound DOWN would skip cells the rule covers; rounding it up only costs a
 * few lookups that then fail the real test.
 */
export const STRUCTURE_SEPARATION_CELLS = Math.ceil(
  cellsAcross(STRUCTURE_SEPARATION_WORLD_UNITS),
);

/** The two settler races. Order is meaningful: index = the race hash bit. */
export const SETTLER_RACES = ['rudy', 'uno'] as const;

export type SettlerRace = (typeof SETTLER_RACES)[number];

/**
 * Edge, in cells, of the square district that shares one race.
 *
 * 16 WORLD UNITS — one NEIGHBOURHOOD (shared's NEIGHBOURHOOD_CELLS), restated
 * here as its own constant
 * because this protocol module stays dependency-free (see the header). The
 * chunk is already the game's neighbourhood unit (unlock creep, the CA sweep,
 * targeted refreshes all move in chunks), so "a town that grows up inside one
 * chunk is one people" needs no second spatial unit. The two values drifting
 * apart would not be a bug — districts never touch chunk logic — merely a
 * missed rhyme.
 */
export const SETTLER_DISTRICT_CELLS = cellsAcross(16);

/**
 * The race of the settlement standing at cell (x, y).
 *
 * Bit 24 of the DISTRICT hash. The cell-hash consumers (structureVariation's
 * bits 0–23 here, isDurandsCell's bits 24–31 in the client) hash CELL
 * coordinates; this hashes district coordinates, a different input domain, so
 * no correlation arises even where the two share a bit index — except at
 * district (0, 0), whose hash input coincides with cell (0, 0)'s, where the
 * race bit and one Durand's roll bit are the same coin flip for exactly one
 * cell of the world. Named rather than fixed: it is one landmark cell, both
 * reads are cosmetic, and dodging it would cost a second hash function.
 */
export function settlementRace(x: number, y: number): SettlerRace {
  const districtX = Math.floor(x / SETTLER_DISTRICT_CELLS);
  const districtY = Math.floor(y / SETTLER_DISTRICT_CELLS);
  return SETTLER_RACES[(hashStructureCell(districtX, districtY) >>> 24) & 1];
}
