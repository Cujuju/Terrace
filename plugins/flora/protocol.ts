// flora — the wire contract between the plugin's two halves.
//
// Imported by BOTH server/ and client/, so it stays dependency-free (no three,
// no node builtins) and side-effect-free. It is the plugin-local equivalent of
// @terrace/shared: one definition of the payload, so the halves cannot drift.
//
// Namespacing: the hosts prefix `flora:` on the wire in both directions, so
// every type here is the UN-namespaced form (see server/src/plugins/host.ts and
// client/src/plugins/host.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: DELTAS, PLUS A SNAPSHOT ON JOIN. The opposite of wildlife's choice, for
// the opposite reason.
//
// A creature moves every tick, so its previous position is worthless and
// re-sending the whole population is both simpler and self-healing. A TREE NEVER
// MOVES. Its entire life is two events — it grows, it is felled — separated by
// minutes or hours, so a full-state push at any cadence would spend its entire
// budget re-transmitting a fact that has not changed since the last time it was
// sent. Terrain itself is synced exactly this way (snapshot on join, diffs
// after), and a forest is terrain-shaped state.
//
// THE ARITHMETIC, at the shipped FLORA_TREE_CAP of 3000 on a 512² world.
// A tree on the wire is two integers; msgpack encodes 0…127 in one byte, 128…255
// in two, and 256…65535 in three, so a 512² world (coordinates up to 511) costs
// 6 B per tree in a flat array and a 128² world costs 2 B.
//
//   full snapshot   3000 × 6 B                    = 18 KB, ONCE, at join
//   growth deltas   24 sprouts × 6 B / 5 s        = 29 B/s  ≈ 0.23 kbit/s
//   fell deltas     ≤ ~30 trees × 6 B per sculpt  = ≤ 180 B per edit
//   keepalive       18 KB / 60 s                  = 300 B/s ≈ 2.4 kbit/s
//                                                   ─────────────────────
//                                                   ≈ 2.7 kbit/s per client
//
// The rejected alternative is wildlife's: full state at 5 Hz. That would be
// 18 KB × 5 = 90 KB/s ≈ 720 kbit/s per client — nearly double the ENTIRE
// wildlife budget (390 kbit/s), to tell every client sixty times a minute that
// three thousand trees are still standing exactly where they were.
//
// What deltas cost, and how that cost is bounded: a dropped or reordered message
// desynchronises a client permanently, where a full-state stream self-heals in
// one frame. Colyseus messages ride one ordered, reliable WebSocket, so a drop
// without a disconnect is not a case the transport produces — but a reconnect
// can straddle one, so FLORA_KEEPALIVE_SECONDS re-sends the whole forest once a
// minute anyway (see server/index.ts). That caps any divergence at one minute
// for 0.6% of what wildlife already spends, which is the honest price of the
// delta model rather than a claim that the failure cannot happen.
// ─────────────────────────────────────────────────────────────────────────────

/** Plugin name on both sides. Also the message namespace. */
export const FLORA_PLUGIN_NAME = 'flora';

/**
 * Server → client, the WHOLE forest (`flora:forest`). Sent to a joining player,
 * at world create, and on the keepalive cadence. Replaces the receiver's entire
 * tree list.
 */
export const FLORA_FOREST_MESSAGE = 'forest';

/**
 * Server → client, what changed since the last message (`flora:changes`).
 * Applied on top of whatever the receiver already has.
 */
export const FLORA_CHANGES_MESSAGE = 'changes';

/**
 * Hard ceiling on standing trees, whatever the density maths asks for.
 *
 * 3000 is a bandwidth-and-geometry number, not an ecology one:
 *
 *   * WIRE — 3000 × 6 B = 18 KB for a full snapshot on the largest world. The
 *     design's join budget is "tens of KB" for a typical early world, and an
 *     early world has almost no unlocked chunks, so this figure is the ceiling a
 *     fully revealed 512² veteran world reaches, not what a new player pays.
 *   * GEOMETRY — the client draws every tree from three InstancedMeshes
 *     (client/models.ts), so 3000 trees are 3 draw calls and roughly 3000 × 40 ≈
 *     120k triangles. That sits well under the terrain's own budget (up to 1024
 *     chunk meshes at 512²), which is what makes the cap a wire number.
 *
 * It BINDS only on a large, largely-revealed, largely-green world: at
 * FLORA_CELLS_PER_TREE = 12 the cap is reached once 36 000 stable green cells
 * exist, i.e. ~14% of a 512² world (and it can never bind at 128², whose 16 384
 * cells could ask for at most 1365 trees). Past that the forest simply stops
 * getting denser, which reads as woodland rather than as a bug.
 *
 * It lives HERE rather than in the server half because both halves need it: the
 * server enforces it, and the client sizes its instance buffers from it.
 */
export const FLORA_TREE_CAP = 3000;

/**
 * A cell holding one tree. There is at most one tree per cell by construction —
 * the cell IS the tree's identity, which is why nothing here carries an id.
 *
 * That is the whole reason this plugin needs no id allocator, no id persistence,
 * and no id high-water mark: a fell message names a cell, and "the tree at that
 * cell" is unambiguous.
 */
export interface TreeCell {
  readonly x: number;
  readonly y: number;
}

/**
 * Multiplier that packs a cell into one integer key: `y * STRIDE + x`.
 *
 * 65536 rather than the world size, deliberately: the key must be computable
 * BEFORE the world size is known, because the persistence slice is restored
 * before onWorldCreate hands the plugin a world. A world edge can never reach
 * this bound — the heightmap is Int16, so 32767 is the arithmetic ceiling and
 * the shipped sizes are 128 and 512 — so no two cells can collide.
 */
export const FLORA_CELL_KEY_STRIDE = 65536;

/** Cell → integer key. */
export function treeKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

/** Integer key → cell. The exact inverse of treeKey. */
export function treeCellOf(key: number): TreeCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

/**
 * Cells → the flat `[x0, y0, x1, y1, …]` wire form.
 *
 * Flat rather than an array of `{x, y}` objects because msgpack re-sends the key
 * strings for every object (there is no schema here): `{x: 12, y: 34}` costs
 * ~8 B where the pair costs 2. Over a 3000-tree snapshot that is 24 KB versus
 * 6 KB, for exactly the same information.
 */
export function packTreeCells(cells: Iterable<TreeCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

function isCellCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < FLORA_CELL_KEY_STRIDE
  );
}

/**
 * Defensive parse of a flat coordinate list.
 *
 * The client trusts the server, but "trusts" is not "assumes well-formed": a
 * self-hoster's server and a cached client bundle at different versions is an
 * ordinary event, and the right failure mode is "some trees are missing", never
 * a throw inside the render loop. Malformed pairs are dropped individually;
 * something that is not an array at all yields null so the caller can ignore the
 * message whole. The count is capped at FLORA_TREE_CAP so a hostile or broken
 * payload cannot make the client allocate past its own instance buffers.
 */
export function parseTreeCells(value: unknown): TreeCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: TreeCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_TREE_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

/** `flora:forest` — the receiver's whole tree list. */
export interface FloraForestPayload {
  readonly trees: readonly number[];
}

/** `flora:changes` — what to add and what to remove. */
export interface FloraChangesPayload {
  readonly grown: readonly number[];
  readonly felled: readonly number[];
}

export function parseForestPayload(payload: unknown): TreeCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseTreeCells((payload as { trees?: unknown }).trees);
}

export function parseChangesPayload(
  payload: unknown,
): { grown: TreeCell[]; felled: TreeCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { grown?: unknown; felled?: unknown };
  // An absent half is an empty half, not a malformed message: the server omits
  // neither today, but a future one that only ever fells trees should not have
  // its messages dropped whole by an older client.
  const grown = parseTreeCells(message.grown ?? []);
  const felled = parseTreeCells(message.felled ?? []);
  if (grown === null || felled === null) return null;
  return { grown, felled };
}

// ─────────────────────────────────────────────────────────────────────────────
// CROPS (card 28, "Terrace Farming") — a second, independent static-object
// list on the SAME wire shape trees already use: deltas plus a snapshot on
// join, for the identical reason (a crop does not move; its life is one
// event — it sprouts or withers — separated from the next by a whole survey
// interval at least, so a full-state push at any cadence would spend its
// budget re-announcing a fact that has not changed). Deliberately its own
// message pair rather than folded into `flora:forest`/`flora:changes`: a
// tree and a crop are different populations with different caps and
// different growth mechanisms (crops.ts has no RNG, no stochastic sprouting
// and nothing persisted, unlike Forest — see that module's header), and
// merging their wire shapes would force one cap and one message cadence on
// two mechanisms that do not share either.
//
// THE ARITHMETIC, at FLORA_CROP_CAP on a 512² world, following protocol.ts's
// own tree arithmetic above exactly (6 B per cell in msgpack, coordinates up
// to 511):
//
//   full snapshot   2048 × 6 B                     = 12 KB, ONCE, at join
//   keepalive       12 KB / 60 s                    = 200 B/s ≈ 1.6 kbit/s
//
// Delta cost is not separately budgeted: crops.ts's survey interval (5s) and
// the terrain-edit reactive path both emit deltas only on an actual
// sprout/wither, which — like Forest's own growth deltas — is rare against
// the keepalive's steady cost. A crop survey CAN in principle report up to
// FLORA_CROP_CAP sprouts in one delta (a huge shoreline just unlocked at
// once); that is bounded by the same cap the snapshot is, so the worst-case
// single delta costs no more than one keepalive already does.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server → client, the WHOLE crop list (`flora:crops`). Sent to a joining
 * player, at world create, and on the keepalive cadence. Replaces the
 * receiver's entire crop list.
 */
export const FLORA_CROPS_MESSAGE = 'crops';

/**
 * Server → client, what changed since the last message (`flora:cropChanges`).
 * Applied on top of whatever the receiver already has.
 */
export const FLORA_CROP_CHANGES_MESSAGE = 'cropChanges';

/**
 * Hard ceiling on visible crop cells, whatever the terrain asks for.
 *
 * 2048 — half FLORA_TREE_CAP, deliberately: farmland (@terrace/shared's
 * farmland.ts) is the INTERSECTION of two conditions (flat AND touching
 * water) where a tree only needs one (a green band), so a materially
 * smaller population is the expected shape, not an arbitrary cut. At
 * 2048 × 6 B a full snapshot is 12 KB — under trees' own 18 KB ceiling —
 * and the client sizes one InstancedMesh's instance buffer from this
 * number (client/cropModels.ts), 2048 × 16 floats × 4 B ≈ 128 KB, a small
 * fraction of the 576 KB trees already spend across three meshes.
 *
 * It BINDS only on a world whose revealed coastline/riverbank is unusually
 * long relative to its area (a maze of inlets, not a simple shore) — past
 * that, crops simply stop appearing on the newest farmland found, which
 * reads as a field that has already reached the edge of what one farmstead
 * tends rather than as a bug.
 */
export const FLORA_CROP_CAP = 2048;

/**
 * A cell showing one crop. There is at most one crop per cell by
 * construction — the cell IS the crop's identity, exactly TreeCell's own
 * reasoning restated for a different population.
 */
export interface CropCell {
  readonly x: number;
  readonly y: number;
}

/**
 * Cell → integer key, and its inverse. Reuses FLORA_CELL_KEY_STRIDE — trees
 * and crops are keyed into SEPARATE Sets (Forest.standing vs
 * CropField.standing), so sharing the stride costs nothing and keeps every
 * packed-key convention in this plugin identical.
 */
export function cropKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function cropCellOf(key: number): CropCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

/** Cells → the flat `[x0, y0, x1, y1, …]` wire form — packTreeCells' shape, restated for crops. */
export function packCropCells(cells: Iterable<CropCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

/**
 * Defensive parse of a flat coordinate list, capped at FLORA_CROP_CAP rather
 * than FLORA_TREE_CAP — the one reason this is not a call to
 * parseTreeCells: reusing that function would cap crops at the WRONG
 * ceiling and let a hostile or broken payload allocate past this plugin's
 * own crop instance buffer. Otherwise identical to parseTreeCells,
 * including its malformed-pair and whole-payload failure handling.
 */
export function parseCropCells(value: unknown): CropCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: CropCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_CROP_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

/** `flora:crops` — the receiver's whole crop list. */
export interface FloraCropsPayload {
  readonly crops: readonly number[];
}

/** `flora:cropChanges` — what to add and what to remove. */
export interface FloraCropChangesPayload {
  readonly sprouted: readonly number[];
  readonly withered: readonly number[];
}

export function parseCropsPayload(payload: unknown): CropCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseCropCells((payload as { crops?: unknown }).crops);
}

export function parseCropChangesPayload(
  payload: unknown,
): { sprouted: CropCell[]; withered: CropCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { sprouted?: unknown; withered?: unknown };
  const sprouted = parseCropCells(message.sprouted ?? []);
  const withered = parseCropCells(message.withered ?? []);
  if (sprouted === null || withered === null) return null;
  return { sprouted, withered };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tree variation
//
// A forest of three thousand identical cones is a texture, not a forest. The
// variation has to be IDENTICAL ON EVERY CLIENT, though — two players looking at
// the same hill must see the same trees, or a screenshot stops being evidence
// and "the big fir by the lake" stops being a landmark.
//
// So it is derived from the cell coordinates by an integer hash rather than
// drawn from a generator, and it costs NOTHING on the wire: the server never
// sends a kind, a scale or a rotation, because every client can compute all
// three from the two numbers it already received. Integer ops only (Math.imul,
// shifts, xor), so every JS engine agrees bit for bit — the same discipline
// shared/'s terrain math keeps, for the same reason.
//
// Why the kind is NOT derived from the terrace band, which would be prettier:
// the client's height for a cell is band-quantised, arrives with the chunk, and
// is locally predicted during a sculpt. A band-derived kind would therefore have
// three ways to be temporarily wrong (chunk not streamed, prediction in flight,
// snapshot lag) and every one of them would show up as a tree changing SPECIES
// in front of the player. Coordinates have none of those problems.
// ─────────────────────────────────────────────────────────────────────────────

/** The two silhouettes. Ordered; the order is not on the wire, only in code. */
export const FLORA_TREE_KINDS = ['conifer', 'broadleaf'] as const;

export type FloraTreeKind = (typeof FLORA_TREE_KINDS)[number];

/**
 * Share of trees that are conifers, as a numerator over 256 (the hash byte the
 * roll is taken from). 154/256 ≈ 60%.
 *
 * Not 50/50: an even mix of two silhouettes reads as a checkerboard, where a
 * clear majority with a minority scattered through it reads as "a fir wood with
 * broadleaves in it" — one kind of place rather than two kinds of tree. 60/40 is
 * the smallest majority that still reads as one from the game's camera distance.
 */
export const FLORA_CONIFER_SHARE_OF_256 = 154;

/** Uniform scale bounds applied to a tree's whole model. */
export const FLORA_TREE_SCALE_MIN = 0.78;
export const FLORA_TREE_SCALE_MAX = 1.25;

/** Everything a client needs to draw one tree, beyond where it stands. */
export interface FloraTreeVariation {
  readonly kind: FloraTreeKind;
  /** Uniform model scale, in [FLORA_TREE_SCALE_MIN, FLORA_TREE_SCALE_MAX]. */
  readonly scale: number;
  /** Yaw about Y, in radians, in [0, 2π). */
  readonly yaw: number;
}

/**
 * 32-bit integer hash of a cell. A standard xorshift-multiply finaliser
 * (murmur3's), fed by two odd multipliers so x and y contribute independently —
 * without that, mirrored cells like (3, 7) and (7, 3) would hash alike and a
 * diagonal of identical trees would appear.
 */
export function hashCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const TWO_PI = Math.PI * 2;

/** Bits of the hash used for the yaw. 16 → ~0.005° of angular resolution. */
const YAW_BITS = 16;
const YAW_DIVISOR = 1 << YAW_BITS;

/**
 * The deterministic variation for the tree at (x, y). Three independent bit
 * slices of one hash, so the three properties do not correlate — a tall tree is
 * no more likely to be a conifer than a short one.
 */
export function treeVariation(x: number, y: number): FloraTreeVariation {
  const hash = hashCell(x, y);
  const kindRoll = hash & 0xff;
  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);

  return {
    kind: kindRoll < FLORA_CONIFER_SHARE_OF_256 ? 'conifer' : 'broadleaf',
    scale:
      FLORA_TREE_SCALE_MIN + (scaleRoll / 0xff) * (FLORA_TREE_SCALE_MAX - FLORA_TREE_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-crop variation (card 28, "Terrace Farming") — yaw and scale only, no
// "kind" (unlike trees' conifer/broadleaf split): the card asks for visible
// crops, not a second silhouette taxonomy, and one style of patch keeps a
// field reading as one field rather than a mixed planting. Reuses hashCell
// rather than a second hash function, and the same bit-slicing discipline
// treeVariation uses, restated for a smaller set of properties.
// ─────────────────────────────────────────────────────────────────────────────

export const CROP_SCALE_MIN = 0.85;
export const CROP_SCALE_MAX = 1.15;

export interface CropVariation {
  readonly scale: number;
  readonly yaw: number;
}

export function cropVariation(x: number, y: number): CropVariation {
  const hash = hashCell(x, y);
  const scaleRoll = hash & 0xff;
  const yawRoll = (hash >>> 8) & (YAW_DIVISOR - 1);
  return {
    scale: CROP_SCALE_MIN + (scaleRoll / 0xff) * (CROP_SCALE_MAX - CROP_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PLOT FOOTPRINT (owner, 2026-08-23: "these terrace patches must not spawn
// over the top of each other, only next to each other, and never on a section
// of land that isn't at least as large as the model").
//
// WHY THIS LIVES HERE AND NOT IN client/cropModels.ts, WHERE THE GEOMETRY IS.
// A crop's size and a crop's eligibility are the SAME fact seen from two
// sides, and until this block they were two unrelated numbers in two files
// that could not see each other: cropModels.ts authored a bed 0.82 wide,
// crops.ts (server) staged one crop per farmland CELL, and nothing anywhere
// compared the two. That is exactly how the defect this block closes got in —
// cropModels.ts was written when CELL_WORLD_SIZE was 1, the 2026-08-21
// re-sample made it 0.25, and a bed that had been 0.82 of a cell silently
// became 3.28 CELLS wide, so every plot was drawn overlapping its neighbours
// roughly three deep and spilling off whatever terrace it stood on. The model
// changed size and the placement rule had no way to notice.
//
// So the footprint is stated ONCE, in CELLS, in the file both halves already
// import: the lattice states how far a plot may reach, the bed's size is
// DERIVED from that reach, and the client's geometry is derived in turn. A
// plot that would overlap its neighbours or overhang its ground is no longer
// something the code can express, so nothing downstream has to filter for it.
//
// IN CELLS, NOT WORLD UNITS, so this file stays dependency-free (see the
// banner). The one multiply by CELL_WORLD_SIZE happens in the client, at the
// single point where a cell fraction becomes geometry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Half the diagonal of a unit square, i.e. the factor turning a square's EDGE
 * into its CIRCUMRADIUS — the distance from its centre to a corner.
 *
 * This factor is the whole reason the bed is not simply "0.82 of a cell". A
 * plot is a square that cropVariation's yaw roll can turn to ANY angle, so the
 * bound on how far it reaches from its own centre is set by its corners, never
 * by its edges: a square rotated 45° covers 41% more distance in X and Z than
 * the same square axis-aligned. Sizing a rotatable plot by its edge is the
 * same mistake fishingHuts.ts's header records paying for with three-sided
 * cones (a shape whose corners stand at the circumradius, measured 2.2× over
 * its bound while looking perfectly fine in a picture).
 */
const SQUARE_CIRCUMRADIUS_PER_EDGE = Math.SQRT2 / 2;

/**
 * The furthest any part of a plot may reach from the cell it stands on, in
 * CELLS — and therefore the rule "plots touch, never overlap" in one number.
 *
 * HALF A CELL, because crops are placed one per cell on the cell lattice
 * (crops.ts stages cropKey(x, y); cropPlacement.ts puts the plot's CENTRE at
 * the cell's centre — see brushPreview.ts on why cell·CELL_WORLD_SIZE is a
 * centre and carries no half-cell shift). Two plots on adjacent cells are one
 * cell apart, so each may claim half that distance and no more. At exactly
 * half, neighbouring plots meet corner to corner and never cross: "next to
 * each other", which is what a field of them should read as, and which a
 * smaller bound would break up into isolated dots.
 */
export const CROP_PLOT_MAX_REACH_CELLS = 0.5;

/**
 * How wide the tilled bed of one plot is, as a fraction of a CELL edge —
 * DERIVED from the reach bound above rather than chosen, so a plot cannot be
 * authored into overlapping its neighbours.
 *
 * Read it as: the largest square that, turned to its worst angle and rolled to
 * its largest scale (CROP_SCALE_MAX — the scale roll multiplies the whole
 * model, so the bound has to hold for the biggest roll, not the average one),
 * still fits inside the cell it stands on. Works out at ~0.61 of a cell.
 */
export const CROP_PLOT_BED_CELL_COVERAGE =
  CROP_PLOT_MAX_REACH_CELLS / (SQUARE_CIRCUMRADIUS_PER_EDGE * CROP_SCALE_MAX);

/**
 * The rule the two constants above exist to enforce, checked at module load
 * rather than trusted — brushPreview.ts's own precedent for a derived size
 * that must fit a lattice: every input is a constant, so this either always
 * holds or never does, and a build that violates it should not start.
 *
 * "Not over the top of each other, only next to each other" (owner,
 * 2026-08-23) is a statement about a LATTICE, and this is it: plots sit one
 * per cell, one cell apart, so no plot may reach more than half a cell from
 * its own centre. It is enforced HERE, on the size, rather than as a filter in
 * the survey, because a filter would be the symptom's fix — it would drop
 * crops to hide a model that had outgrown its ground, where this makes the
 * overlap unrepresentable. It is also why the survey needs no spacing pass and
 * no larger-than-a-cell land test: a plot never covers more than the dry,
 * unlocked, single-band cell isFarmlandCell already vouched for, so the ground
 * it stands on is always at least as large as the model standing on it.
 */
if (
  CROP_PLOT_BED_CELL_COVERAGE * CROP_SCALE_MAX * SQUARE_CIRCUMRADIUS_PER_EDGE >
  CROP_PLOT_MAX_REACH_CELLS
) {
  throw new RangeError(
    `a crop plot of ${CROP_PLOT_BED_CELL_COVERAGE} cells reaches past ${CROP_PLOT_MAX_REACH_CELLS} cells and would overlap its neighbours`,
  );
}
