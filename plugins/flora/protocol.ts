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
// THE ARITHMETIC, at the shipped FLORA_TREE_CAP of 4096 on a 512² world.
// A tree on the wire is two integers; msgpack encodes 0…127 in one byte, 128…255
// in two, and 256…65535 in three, so a 512² world (coordinates up to 511) costs
// 6 B per tree in a flat array and a 128² world costs 2 B.
//
//   full snapshot   4096 × 6 B                    = 24 KB, ONCE, at join
//   growth deltas   48 sprouts × 6 B / 5 s        = 58 B/s  ≈ 0.46 kbit/s
//   fell deltas     ≤ ~30 trees × 6 B per sculpt  = ≤ 180 B per edit
//   keepalive       24 KB / 60 s                  = 400 B/s ≈ 3.2 kbit/s
//                                                   ─────────────────────
//                                                   ≈ 3.7 kbit/s per client
//
// The rejected alternative is wildlife's: full state at 5 Hz. That would be
// 24 KB × 5 = 120 KB/s ≈ 960 kbit/s per client — nearly double the ENTIRE
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
 * Raised 3000 → 4096 (2026-08-25) so the cap keeps pace with the density
 * retune: at FLORA_CELLS_PER_TREE = 4 the old 3000 would bind on a 512² world
 * of which only ~73% is stable green ground. It remains a bandwidth-and-
 * geometry number, not an ecology one:
 *
 *   * WIRE — 4096 × 6 B ≈ 24 KB for a full snapshot on the largest world. The
 *     design's join budget is "tens of KB" for a typical early world, and an
 *     early world has almost no unlocked chunks, so this figure is the ceiling a
 *     fully revealed 512² veteran world reaches, not what a new player pays.
 *   * GEOMETRY — the client draws every tree from three InstancedMeshes
 *     (client/models.ts), so 4096 trees are 3 draw calls and roughly 4096 × 40 ≈
 *     164k triangles. That sits well under the terrain's own budget (up to 1024
 *     chunk meshes at 512²), which is what makes the cap a wire number.
 *
 * It BINDS only on a very large, very green world: the cap asks for exactly
 * FLORA_TREE_CAP × FLORA_CELLS_PER_TREE = 16 384 square world units = 262 144
 * cells of stable green ground — every cell of a fully revealed 512² world. Any
 * realistic mix of water, coast, rock and churn stays well below it. Past that
 * point the forest simply stops getting denser, which reads as woodland rather
 * than as a bug.
 *
 * It lives HERE rather than in the server half because both halves need it: the
 * server enforces it, and the client sizes its instance buffers from it.
 */
export const FLORA_TREE_CAP = 4096;

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
 * ~8 B where the pair costs 2. Over a 4096-tree snapshot that is 33 KB versus
 * 8 KB, for exactly the same information.
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

/**
 * Where the stalks of one plot are planted, as fractions of the cluster span,
 * and therefore how many there are.
 *
 * HERE RATHER THAN IN cropModels.ts because three modules now have to agree on
 * it: the renderer that instances the stalks, wheatVariants.ts (which asserts
 * each variant's own reach against the plot it has to fit inside), and the
 * preview harness that has to draw exactly what the game draws. It shipped as
 * three copies of "0.22" for one afternoon, which is one afternoon longer than
 * shared/src/traversal.ts's header suggests such things survive.
 *
 * FOUR, in a square: the fewest that reads as a clump rather than as isolated
 * dots at the game's camera distance, and a small fixed multiple of
 * FLORA_CROP_CAP for the instance buffers. They are fractions of the SPAN, not
 * of a cell and not world units, so changing how big a plot is moves the
 * planting with it and no stalk can be left standing outside its own plot.
 */
export const CROP_STALK_OFFSET_IN_CLUSTER_SPANS = 0.19;

export const CROP_STALK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-CROP_STALK_OFFSET_IN_CLUSTER_SPANS, -CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
  [CROP_STALK_OFFSET_IN_CLUSTER_SPANS, -CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
  [-CROP_STALK_OFFSET_IN_CLUSTER_SPANS, CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
  [CROP_STALK_OFFSET_IN_CLUSTER_SPANS, CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
];

export const CROP_STALKS_PER_PLOT = CROP_STALK_OFFSETS.length;

// ─────────────────────────────────────────────────────────────────────────────
// PER-STALK VARIATION (owner, 2026-08-24: "so it looks more organic")
//
// cropVariation above rolls the whole PLOT — one yaw and one scale applied to
// the cluster as a unit. That was enough while a plot was a tilled bed with
// four identical stalks standing on it in a rigid 2×2: the bed's own square
// declared the grid, so the grid read as deliberate. With the bed gone the
// grid is all that is left, and four identical clones on perfect lattice
// points read as manufactured rather than grown.
//
// So each stalk of a plot gets its own roll on top of its plot's: a yaw so no
// two face the same way, a height so the cluster has a skyline, and a nudge
// off its lattice point so the four are not a perfect square. Together they
// are the difference between "four copies of a model" and "a clump of wheat".
//
// STILL FREE, ON THE WIRE AND IN DRAW CALLS. Stalks are already instanced, so
// a per-stalk matrix costs nothing a per-plot matrix did not — this is
// variation bought with arithmetic rather than with geometry, which is the
// same trade treeVariation makes for a forest.
//
// DERIVED FROM THE CELL AND THE STALK INDEX, integer-only, so every client
// draws the same clump on the same cell: two players looking at the same field
// must see the same field, exactly as fishingHuts.ts argues for its variant
// roll and for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Salt for the per-stalk roll.
 *
 * cropVariation has already spent this cell's hash — the low byte on scale and
 * the next sixteen bits on yaw — and a stalk needs three more values that must
 * not correlate with either (a taller stalk should be no more likely to lean a
 * particular way). Rather than carve up what is left, the roll re-avalanches
 * the cell hash through a second mixing function seeded with this constant,
 * the same move fishingHuts.ts's FISHING_HUT_ROLL_SALT makes for the same
 * reason. 0x9e3779b1 is the 32-bit golden-ratio odd constant, the conventional
 * choice for "mix again, differently".
 */
const CROP_STALK_ROLL_SALT = 0x9e3779b1;

/** How much shorter or taller than its plot one stalk may be, as a fraction. */
export const CROP_STALK_HEIGHT_SPREAD = 0.22;

/**
 * How far a stalk may wander off its lattice point, as a fraction of the
 * cluster span.
 *
 * Bounded rather than free, and the bound is not decorative: the wander adds
 * straight onto CROP_STALK_OFFSET_IN_CLUSTER_SPANS in the worst case, and the
 * two together plus the plant's own widest part have to fit inside half a
 * cluster span — wheatVariants.ts asserts exactly that at load, per variant.
 * So this number and the offset above are spending one budget between them,
 * and pushing either up means pushing the other down or shortening the plant.
 * At 0.03 the four stalks visibly break formation while the widest of the
 * three variants still clears its bound with room in hand.
 */
export const CROP_STALK_JITTER_IN_CLUSTER_SPANS = 0.03;

/** Everything that makes one stalk of a plot its own plant. */
export interface CropStalkVariation {
  /** Yaw about Y, radians, in [0, 2π) — this stalk's own facing. */
  readonly yaw: number;
  /** Height multiplier, in [1 − CROP_STALK_HEIGHT_SPREAD, 1 + CROP_STALK_HEIGHT_SPREAD]. */
  readonly height: number;
  /** Offset from the lattice point, in cluster spans, each in ±CROP_STALK_JITTER_IN_CLUSTER_SPANS. */
  readonly jitterX: number;
  readonly jitterZ: number;
}

/**
 * A second, independent 32-bit hash of a cell, mixed once more per stalk
 * INDEX so the four stalks of one plot roll differently from each other.
 * Math.imul throughout — integer-only, so every JS engine agrees bit for bit.
 */
function cropStalkHash(x: number, y: number, index: number): number {
  let h = (hashCell(x, y) ^ CROP_STALK_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (index + 1), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0);
}

/** Bits per jitter axis. 8 → 256 positions across the wander, far finer than the eye. */
const JITTER_BITS = 8;
const JITTER_DIVISOR = 1 << JITTER_BITS;

/**
 * The deterministic variation for stalk `index` of the plot at (x, y). Four
 * independent bit slices of one hash, so height does not correlate with facing
 * and neither correlates with which way the stalk drifted.
 */
export function cropStalkVariation(x: number, y: number, index: number): CropStalkVariation {
  const hash = cropStalkHash(x, y, index);
  const yawRoll = hash & (YAW_DIVISOR - 1);
  const heightRoll = (hash >>> 16) & 0xff;
  const jitterXRoll = (hash >>> 8) & (JITTER_DIVISOR - 1);
  const jitterZRoll = (hash >>> 24) & (JITTER_DIVISOR - 1);
  const centred = (roll: number): number => (roll / (JITTER_DIVISOR - 1)) * 2 - 1;
  return {
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
    height: 1 + centred(heightRoll) * CROP_STALK_HEIGHT_SPREAD,
    jitterX: centred(jitterXRoll) * CROP_STALK_JITTER_IN_CLUSTER_SPANS,
    jitterZ: centred(jitterZRoll) * CROP_STALK_JITTER_IN_CLUSTER_SPANS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE IMPORT. This file is otherwise dependency-free by design (see the
// banner) and it stays that way in spirit: @terrace/shared is the single source
// of truth for terrain math that BOTH halves of every plugin already import,
// which is exactly what a footprint derived from the terrain's own contour
// guard needs. The alternative was restating "1/8 of a cell" here, which is the
// duplicated-terrain-math mistake shared/src/traversal.ts's header records.
// ─────────────────────────────────────────────────────────────────────────────
import { CONTOUR_CELL_CENTRE_GUARD } from '@terrace/shared';

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
// import: the lattice states how far a plot may reach, the cluster's span is
// DERIVED from that reach, and the client's geometry is derived in turn. A
// plot that would overlap its neighbours or overhang its ground is no longer
// something the code can express, so nothing downstream has to filter for it.
//
// THE TILLED BED IS GONE (owner, 2026-08-24: "get rid of the brown plot on the
// bottom, so it looks more organic"). A plot used to be a brown box with wheat
// standing on it, and the box WAS the footprint. It is now four stalks growing
// straight out of the terrain, so the footprint is the stalk CLUSTER's own
// square instead — the same number playing the same role, which is why the
// constant below is a span and not a bed.
//
// IN CELLS, NOT WORLD UNITS, so this file stays dependency-free (see the
// banner). The one multiply by CELL_WORLD_SIZE happens in the client, at the
// single point where a cell fraction becomes geometry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Half the diagonal of a unit square, i.e. the factor turning a square's EDGE
 * into its CIRCUMRADIUS — the distance from its centre to a corner.
 *
 * This factor is the whole reason the span is not simply "0.82 of a cell". A
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
 * The square one plot's stalk cluster is planted in, as a fraction of a CELL
 * edge — DERIVED from the reach bound above rather than chosen, so a plot
 * cannot be authored into overlapping its neighbours.
 *
 * Read it as: the largest square that, turned to its worst angle and rolled to
 * its largest scale (CROP_SCALE_MAX — the scale roll multiplies the whole
 * model, so the bound has to hold for the biggest roll, not the average one),
 * still fits inside the cell it stands on. Works out at ~0.61 of a cell.
 *
 * The client plants stalks at fractions of THIS span and measures each stalk's
 * own reach against it, so "how big is a plot" has one answer no matter what
 * the plant on it looks like.
 */
export const CROP_PLOT_CLUSTER_CELL_SPAN =
  CROP_PLOT_MAX_REACH_CELLS / (SQUARE_CIRCUMRADIUS_PER_EDGE * CROP_SCALE_MAX);

/**
 * How much SOLID same-band tread a plot needs around the cell it stands on, in
 * cells — the setback that stops a plot hanging over a terrace lip.
 *
 * DERIVED, and the derivation is the whole argument. A terrace's drawn outline
 * is a contour between cell CENTRES, not a cell boundary, and it may come as
 * close as CONTOUR_CELL_CENTRE_GUARD to a centre — an eighth of a cell, and at
 * a deep-water shoreline it lands at exactly that bound. So a cell that is
 * "farmland" carries a guarantee of an eighth of a cell of ground, and a plot
 * reaching CROP_PLOT_MAX_REACH_CELLS (half a cell) past that centre overhangs
 * by everything in between — the defect the owner photographed on 2026-08-23.
 *
 * A plot is safe once every contour is further from its centre than the plot
 * reaches. Requiring the whole square of radius R around the plot to be
 * same-band dry land puts the nearest possible contour at R + the guard, since
 * a contour only ever crosses an edge running from an inside sample to an
 * outside one, and never comes closer than the guard to either end. So the
 * requirement is reach ≤ R + guard, i.e. R ≥ reach − guard. At the shipped plot
 * this is 1: crops grow one cell back from the water's edge, on a full cell of
 * tread, with the lip 1.125 cells away.
 *
 * The alternative — keeping crops on the lip and shrinking the model to the
 * guard — was rejected with the owner: an eighth of a cell is 0.03 world units,
 * which is not a visible crop.
 */
export const CROP_PLOT_TREAD_RING_CELLS = Math.max(
  0,
  Math.ceil(CROP_PLOT_MAX_REACH_CELLS - CONTOUR_CELL_CENTRE_GUARD),
);

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
  CROP_PLOT_CLUSTER_CELL_SPAN * CROP_SCALE_MAX * SQUARE_CIRCUMRADIUS_PER_EDGE >
  CROP_PLOT_MAX_REACH_CELLS
) {
  throw new RangeError(
    `a crop plot of ${CROP_PLOT_CLUSTER_CELL_SPAN} cells reaches past ${CROP_PLOT_MAX_REACH_CELLS} cells and would overlap its neighbours`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GRASS (owner, 2026-08-24: "another texture just like the wheat, but green …
// spawn abundantly on all of the green or green-like bands"). A THIRD
// independent static population, alongside the forest and the crop field, and
// independent for the same reason those two are independent of each other: a
// different eligibility rule, a different cap, a different cadence, its own
// wire messages. Nothing below is a second view of a tree or a crop.
//
// WHAT MAKES IT DIFFERENT FROM CROPS, which it otherwise mirrors line for line:
//
//   * ELIGIBILITY is bands.ts's isGreenBand — the same predicate the forest
//     already plants by — not farmland. Grass wants the whole green ramp,
//     including the ground trees and settlements stand on.
//   * IT GROWS UNDER TREES (owner's call, 2026-08-24). Only crops and
//     buildings exclude it: a wheat plot is cultivated ground and a house has
//     a floor, but a forest floor is grass.
//   * IT IS THINNED. Every eligible cell would be a carpet — a cell is a
//     quarter of a world unit since the 2026-08-21 re-sample — so a
//     deterministic per-cell roll keeps roughly one tuft per
//     GRASS_CELLS_PER_TUFT cells. See FLORA_GRASS_SHARE_OF_256.
//
// WHAT IT IS FOR, beyond looking like a meadow: the standing tuft count IS the
// forage measure the grazer population will be sized from (owner, same day),
// which is why the field is server-authoritative state rather than a client
// decoration derived from the heightmap. The server has to be able to answer
// "how much grass is there" without asking anybody.
//
// THE ARITHMETIC, at FLORA_GRASS_CAP on a fully revealed 512² world — the
// worst case this population has, and materially bigger than the other two, so
// it is stated rather than assumed:
//
//   wire      40 960 × 6 B ≈ 246 KB for a full snapshot, sent on join and on
//             the FLORA_KEEPALIVE_SECONDS repair cadence — ≈ 4 KB/s ≈ 33
//             kbit/s per client at 60 s. Ten times the forest's own keepalive
//             for ten times the objects; still under a tenth of wildlife's
//             budget. Fog of war caps what a real client pays at the ground it
//             has actually unlocked, which early on is almost none of this.
//   geometry  three InstancedMeshes (client/grassModels.ts) since the
//             wildflowers landed, so THREE draw calls whatever the count — the
//             third adds at most FLORA_GRASS_CAP × 10 triangles and 2.6 MB of
//             matrices, and no wire traffic at all (see WILDFLOWERS below).
//             40 960 × GRASS_BLADES_PER_TUFT ≈ 205k
//             blade instances at FIVE triangles each ≈ 1.0M triangles at the
//             absolute cap — which the terrain's own 1024 chunk meshes dwarf,
//             and which is what the flat-ribbon blade buys (see
//             grassModels.ts's "why a ribbon and not a box"). The instance
//             matrices are the other half of that bill: 205k × 64 B × 2 meshes
//             ≈ 26 MB of GPU buffer, allocated up front at the cap.
//
// RESIDUAL, stated the way FLORA_CROP_CAP states its own: past the cap grass
// simply stops appearing on the newest ground swept, rather than thinning out
// evenly. On a world large enough to hit it that reads as "the far meadow has
// not come in yet"; it is not silently wrong, but it is not graceful either,
// and the fix if it ever bites is a distance-sorted survey rather than a
// bigger number.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server → client, the WHOLE grass field (`flora:grass`). Replaces the
 * receiver's entire tuft list — FLORA_CROPS_MESSAGE's contract exactly.
 */
export const FLORA_GRASS_MESSAGE = 'grass';

/** Server → client, what changed since the last message (`flora:grassChanges`). */
export const FLORA_GRASS_CHANGES_MESSAGE = 'grassChanges';

/**
 * How many green cells there are, on average, per DRAWN tuft of grass — the
 * density dial, and the only one. Owner's choice, 2026-08-24: "abundant", which
 * at a quarter-world-unit cell means roughly one tuft per world unit rather than
 * one per cell (a carpet) or one per eight (scattered dots).
 *
 * A LOOK, NOT A FACT ABOUT THE WORLD (issue #289, owner 2026-09-01: the tuft
 * roll decides "only what is drawn"). Every unoccupied green cell is meadow —
 * it is fuel, it burns, and it scars — whether or not this roll put a blade on
 * it (server/grass.ts's isMeadowCell, server/index.ts's floraFuelAt). So what
 * this number buys is coverage on screen and the wire and GPU cost of it,
 * nothing more. The paragraph below is kept because the measurement was real,
 * but its conclusion is not: this constant no longer decides whether a meadow
 * fire runs.
 *
 * Expressed as cells-per-tuft rather than as a probability so it reads as the
 * spacing it produces, matching FLORA_CELLS_PER_TREE's own framing.
 *
 * TIGHTENED 3.5 → 2.5 (2026-08-24) after the first screenshots: at 3.5, tufts
 * a little over half a cell wide left more bare ground than meadow between
 * them, which reads as scattered clumps rather than as the cover the owner
 * asked for. Every step down here is paid for in the cap below and in the
 * wire, so it is a dial with a real price rather than a free one.
 *
 * TIGHTENED 2.5 → 1.78 (owner, 2026-08-29), then, at the time, so meadow fires
 * could run — superseded as a fire lever by #289, and kept at 1.78 because the
 * cover it draws is what the owner has been looking at since. 1.78
 * rounds to FLORA_GRASS_SHARE_OF_256 = 144, a density of 0.5625 — the lowest
 * that, paired with FLORA_GRASS_BURN_SECONDS = 22, burns a 256² bed to the
 * step cap in 19 of 20 trials (0.50 managed only 6 of 20). Neither number does
 * it alone; see the note on FLORA_GRASS_BURN_SECONDS (server/index.ts) for the
 * site-bond mechanism and the full density × burn-time sweep.
 */
export const GRASS_CELLS_PER_TUFT = 1.78;

/**
 * The thinning roll's threshold, out of 256 — GRASS_CELLS_PER_TUFT expressed
 * as the byte comparison the survey actually does, so the two can never drift.
 * Rounded, because the roll is a byte and a fraction of one is not a thing.
 */
export const FLORA_GRASS_SHARE_OF_256 = Math.round(256 / GRASS_CELLS_PER_TUFT);

/**
 * Hard ceiling on standing grass tufts, whatever the terrain asks for.
 *
 * A GEOMETRY number first and a wire number second — see the section header
 * for both figures. DERIVED, not picked, and re-derived on 2026-08-25 from a
 * MEASURED world rather than an assumed one: the old derivation here assumed
 * ~35% of a 512² world is green ramp, which was never measured. Surveying the
 * shipped worldgen (world `frostwick-hollows`, all 1024 chunks unlocked,
 * 262 144 cells) against isGreenBand gives 10 846 green cells — 4.1% — which
 * FLORA_GRASS_SHARE_OF_256 thins to 4 293 tufts, a tenth of this cap.
 *
 * The cap is kept at 40 960 anyway, because the number that has to be safe is
 * the WORST case, not the measured one: an all-green 512² world thins to
 * 262 144 / GRASS_CELLS_PER_TUFT ≈ 104 858 tufts, so no cap that also fits the
 * GPU budget below can promise "never binds". 40 960 is the power-of-two step
 * that holds a world roughly ten times greener than the one we actually ship
 * while keeping the instance buffers at the ≈ 26 MB the geometry note costs
 * out. On a greener world it binds, and the RESIDUAL paragraph above says what
 * that looks like.
 *
 * Here rather than in the server half because both halves need it: the server
 * enforces it, the client sizes its instance buffers from it, and
 * parseGrassCells caps a hostile payload against it.
 */
export const FLORA_GRASS_CAP = 40960;

/**
 * A cell showing one tuft of grass. At most one per cell by construction — the
 * cell IS the tuft's identity, exactly TreeCell's and CropCell's own contract.
 */
export interface GrassCell {
  readonly x: number;
  readonly y: number;
}

/**
 * Shares FLORA_CELL_KEY_STRIDE with trees and crops for cropKey's own reason:
 * the three populations are keyed into SEPARATE Sets, so sharing the stride
 * costs nothing and keeps every cell key in this plugin one encoding.
 */
export function grassKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function grassCellOf(key: number): GrassCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

/** Cells → the flat `[x0, y0, x1, y1, …]` wire form — packTreeCells' shape, restated for grass. */
export function packGrassCells(cells: Iterable<GrassCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

/**
 * Defensive parse of a flat coordinate list, capped at FLORA_GRASS_CAP.
 * Otherwise identical to parseTreeCells and parseCropCells — see the former
 * for why the cap has to be this population's own and not a shared one.
 */
export function parseGrassCells(value: unknown): GrassCell[] | null {
  if (!Array.isArray(value)) return null;
  const cells: GrassCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_GRASS_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

/** `flora:grass` — the receiver's whole tuft list. */
export interface FloraGrassPayload {
  readonly grass: readonly number[];
}

/** `flora:grassChanges` — what to add and what to remove. */
export interface FloraGrassChangesPayload {
  readonly sprouted: readonly number[];
  readonly withered: readonly number[];
}

export function parseGrassPayload(payload: unknown): GrassCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseGrassCells((payload as { grass?: unknown }).grass);
}

export function parseGrassChangesPayload(
  payload: unknown,
): { sprouted: GrassCell[]; withered: GrassCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { sprouted?: unknown; withered?: unknown };
  const sprouted = parseGrassCells(message.sprouted ?? []);
  const withered = parseGrassCells(message.withered ?? []);
  if (sprouted === null || withered === null) return null;
  return { sprouted, withered };
}

/**
 * Salt for the grass rolls.
 *
 * hashCell(x, y) is already spent twice on this cell — treeVariation slices it
 * for a tree's kind/scale/yaw, cropVariation for a plot's scale/yaw — and a
 * tuft's rolls must not correlate with either, or grass would appear
 * preferentially where a tree would have been broadleaf. Re-avalanching
 * through a second mixer seeded with a distinct constant is the same move
 * CROP_STALK_ROLL_SALT makes, and 0x85ebca77 is an odd constant unrelated to
 * that one.
 */
const GRASS_ROLL_SALT = 0x85ebca77;

/** The grass hash for a cell — integer-only, so server and client agree bit for bit. */
function grassHash(x: number, y: number): number {
  let h = (hashCell(x, y) ^ GRASS_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  return ((h ^ (h >>> 15)) >>> 0);
}

/**
 * Does the thinning roll put a tuft on this cell?
 *
 * PURE AND DETERMINISTIC, no RNG: which cells carry grass is a fact about the
 * cell's coordinates, not about when the survey happened to run, so a tuft
 * removed by a sculpt and re-surveyed later comes back in the SAME place
 * rather than jumping — which is what stops a meadow shimmering every time
 * anybody digs near it.
 *
 * Lives here, not in the server half, because it is half the definition of
 * "where grass is": the server applies it, and the tests and any future
 * client-side prediction have to be able to ask the same question.
 */
export function grassCoversCell(x: number, y: number): boolean {
  return (grassHash(x, y) & 0xff) < FLORA_GRASS_SHARE_OF_256;
}

/** Uniform scale bounds applied to a whole tuft — cropVariation's shape, its own range. */
export const GRASS_SCALE_MIN = 0.75;
export const GRASS_SCALE_MAX = 1.25;

export interface GrassVariation {
  readonly scale: number;
  readonly yaw: number;
}

/**
 * The deterministic variation for the tuft at (x, y) — two independent bit
 * slices of the grass hash, so a big tuft is no more likely to face one way
 * than another. Wider scale spread than a crop's (0.85…1.15): a wheat field is
 * a planting and reads better even, where grass is not and a visible range of
 * tuft sizes is most of what stops a meadow looking stamped.
 */
export function grassVariation(x: number, y: number): GrassVariation {
  const hash = grassHash(x, y);
  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);
  return {
    scale: GRASS_SCALE_MIN + (scaleRoll / 0xff) * (GRASS_SCALE_MAX - GRASS_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TUFT FOOTPRINT — CROP_PLOT_MAX_REACH_CELLS' lattice argument, and it
// lands on the same number for the same reason.
//
// IT DID NOT, FOR ONE AFTERNOON, AND THAT WAS THE BUG (owner, 2026-08-24: "I
// don't see the grass spawning"). This first shipped bound to
// CONTOUR_CELL_CENTRE_GUARD — an eighth of a cell — on the argument that a
// tuft which cannot reach past the closest a contour can come to a cell centre
// can never overhang a terrace lip, and so needs no tread-ring test of the
// kind crops pay for. That reasoning is sound and the result was useless: an
// eighth-cell clump is 0.03 world units across, about ONE PIXEL at the game's
// CLOSEST zoom (config.ts's CAMERA_CLOSEST_VIEW_WORLD_UNITS frames 10 world
// units). Verified by screenshot, not by argument — the tufts were being
// drawn the whole time and could not be seen.
//
// So the guarantee is traded away deliberately: a tuft claims HALF A CELL,
// exactly as a crop plot does, and tufts on adjacent cells meet corner to
// corner without ever crossing. That is what makes a meadow read as ground
// cover rather than as scattered dots.
//
// THE RESIDUAL THAT BUYS, NAMED. A tuft on a cell whose contour runs close to
// its centre can lean up to (reach − CONTOUR_CELL_CENTRE_GUARD) = 0.375 cells
// past the lip — under a tenth of a world unit of blade tip hanging over an
// edge. Crops answer the same exposure with CROP_PLOT_TREAD_RING_CELLS, and
// that answer is NOT available here: a tread ring would strip every frontier
// cell of grass, and the band edge is precisely where a meadow must still be
// green. The exposure is also an order of magnitude less severe than the one
// the owner photographed on crops, because what overhangs is a blade tip
// rather than a whole plot on a bed. If it ever reads badly, the fix is to
// shorten the blade's arch (grassModels.ts's BLADE_ARCH_RADIANS, which is what
// actually converts height into horizontal reach), not to re-introduce a ring
// test this population cannot afford.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The furthest any part of a tuft may reach from the cell it stands on, in
 * CELLS — and therefore "tufts touch, never overlap" in one number, exactly as
 * CROP_PLOT_MAX_REACH_CELLS states it for plots. Tufts sit one per cell on the
 * cell lattice, so each may claim half the distance to its neighbour.
 */
export const GRASS_TUFT_MAX_REACH_CELLS = 0.5;

/**
 * The square one tuft's blades are planted in, as a fraction of a CELL edge —
 * DERIVED from the reach bound above exactly as CROP_PLOT_CLUSTER_CELL_SPAN
 * is: the largest square that, turned to its worst angle by the yaw roll and
 * rolled to GRASS_SCALE_MAX, still fits inside the reach.
 */
export const GRASS_TUFT_CLUSTER_CELL_SPAN =
  GRASS_TUFT_MAX_REACH_CELLS / (SQUARE_CIRCUMRADIUS_PER_EDGE * GRASS_SCALE_MAX);

/**
 * How far a tuft's blades are planted from its crown, as a fraction of the
 * cluster span, and how many there are.
 *
 * FIVE, IN A RING, not the crop plot's four in a square: a square reads as the
 * lattice it came from when seen from above, which is near where this game's
 * camera spends its time, and an odd count in a ring has no such alignment at
 * any angle. Five is also mass — three was what the first, invisible version
 * shipped with, and a tuft that has to read as ground cover from ten world
 * units away needs more silhouette than three hairlines.
 *
 * The blades fan OUTWARD as they arc (grassModels.ts authors the arch in the
 * blade's local +X, and each blade's own yaw is which way that points), so
 * these are where a blade meets the ground, not where its tip ends up.
 */
const GRASS_BLADE_RADIUS_IN_CLUSTER_SPANS = 0.25;

const GRASS_BLADE_COUNT = 5;

export const GRASS_BLADE_OFFSETS: ReadonlyArray<readonly [number, number]> =
  Array.from({ length: GRASS_BLADE_COUNT }, (_unused, index): readonly [number, number] => {
    const angle = (Math.PI * 2 * index) / GRASS_BLADE_COUNT;
    return [
      GRASS_BLADE_RADIUS_IN_CLUSTER_SPANS * Math.sin(angle),
      GRASS_BLADE_RADIUS_IN_CLUSTER_SPANS * Math.cos(angle),
    ];
  });

export const GRASS_BLADES_PER_TUFT = GRASS_BLADE_OFFSETS.length;

/** How much shorter or taller than its tuft one blade may be, as a fraction. */
export const GRASS_BLADE_HEIGHT_SPREAD = 0.35;

/**
 * How far a blade may wander off its lattice point, as a fraction of the
 * cluster span. Spends the same budget CROP_STALK_JITTER_IN_CLUSTER_SPANS
 * does: jitter plus the planting radius plus the blade's own outward lean has
 * to stay inside half a cluster span, which grassModels.ts asserts at load.
 */
export const GRASS_BLADE_JITTER_IN_CLUSTER_SPANS = 0.06;

/** Everything that makes one blade of a tuft its own blade. */
export interface GrassBladeVariation {
  /** Yaw about Y, radians, in [0, 2π) — which way this blade arcs. */
  readonly yaw: number;
  /** Height multiplier, in [1 − GRASS_BLADE_HEIGHT_SPREAD, 1 + GRASS_BLADE_HEIGHT_SPREAD]. */
  readonly height: number;
  /** Offset from the lattice point, in cluster spans, each in ±GRASS_BLADE_JITTER_IN_CLUSTER_SPANS. */
  readonly jitterX: number;
  readonly jitterZ: number;
}

/**
 * A third mix of the cell hash, per blade INDEX — cropStalkHash's construction
 * with grass's own salt already folded in by grassHash, so a blade's rolls
 * correlate with neither a tree's nor a crop's on the same cell.
 */
function grassBladeHash(x: number, y: number, index: number): number {
  let h = grassHash(x, y);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (index + 1), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0);
}

/** The deterministic variation for blade `index` of the tuft at (x, y). */
export function grassBladeVariation(x: number, y: number, index: number): GrassBladeVariation {
  const hash = grassBladeHash(x, y, index);
  const yawRoll = hash & (YAW_DIVISOR - 1);
  const heightRoll = (hash >>> 16) & 0xff;
  const jitterXRoll = (hash >>> 8) & (JITTER_DIVISOR - 1);
  const jitterZRoll = (hash >>> 24) & (JITTER_DIVISOR - 1);
  const centred = (roll: number): number => (roll / (JITTER_DIVISOR - 1)) * 2 - 1;
  return {
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
    height: 1 + centred(heightRoll) * GRASS_BLADE_HEIGHT_SPREAD,
    jitterX: centred(jitterXRoll) * GRASS_BLADE_JITTER_IN_CLUSTER_SPANS,
    jitterZ: centred(jitterZRoll) * GRASS_BLADE_JITTER_IN_CLUSTER_SPANS,
  };
}

/**
 * The tuft analogue of the crop plot's load-time lattice check — every input
 * is a constant, so this either always holds or never does.
 */
if (
  GRASS_TUFT_CLUSTER_CELL_SPAN * GRASS_SCALE_MAX * SQUARE_CIRCUMRADIUS_PER_EDGE >
  GRASS_TUFT_MAX_REACH_CELLS + Number.EPSILON
) {
  throw new RangeError(
    `a grass tuft of ${GRASS_TUFT_CLUSTER_CELL_SPAN} cells reaches past ${GRASS_TUFT_MAX_REACH_CELLS} cells and could overhang a terrace lip`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WILDFLOWERS (GH #190) — THE ONE ADDITION IN THIS PLUGIN THAT COSTS NOTHING ON
// THE WIRE.
//
// A flowering tuft is not a new population. It is not a new cell list, not a new
// cap, not a new message pair — it is ONE MORE ROLL off the grass hash the
// server already sends the cell for. The server does not know or care which
// tufts flower; the client asks grassFlowerOf about a cell it already has, and
// the answer is a pure function of that cell's coordinates.
//
// THAT IS THE WHOLE DESIGN CONSTRAINT, and it is what decides everything below.
// Because the roll is derived rather than transmitted:
//
//   * the two halves cannot disagree — there is nothing to disagree ABOUT;
//   * a keepalive re-send cannot re-colour a meadow, for grassCoversCell's own
//     reason (the same coordinates give the same answer forever), which is what
//     stops flowers strobing every time somebody digs nearby;
//   * adding it costs one geometry and one InstancedMesh, and nothing else.
//
// WHERE THE BLOSSOM SITS, and why that is also free. The blossom geometry is
// authored in the BLADE's local space, at the blade's own tip — so a flowering
// blade's blossom instance reuses that blade's instance matrix exactly, with no
// second transform to compute and no way for the flower to drift off the stem
// it grows on. The per-blade height roll scales the blade and its blossom by the
// identical factor, so a taller blade carries its flower higher and nothing
// else changes. See client/grassModels.ts, which builds it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Share of tufts, out of 256, that carry a blossom.
 *
 * A MINORITY BY DESIGN. Flowers read as flowers because most of the meadow is
 * not flowering: at a half or a third the field becomes a flowerbed, which is a
 * planting, and this ground is not planted. A sixth is the largest share that
 * still leaves plain green as the thing the eye calls the meadow — and because
 * the roll is per TUFT and a tuft is one cell in GRASS_CELLS_PER_TUFT, the
 * realised density on the ground is a sixth of an already-thinned population.
 */
export const GRASS_FLOWERING_SHARE_OF_256 = 42;

/** What a flowering tuft's blossom needs, beyond the blade it grows on. */
export interface GrassFlower {
  /** Which blade of the tuft carries it, in [0, GRASS_BLADES_PER_TUFT). */
  readonly bladeIndex: number;
  /** Which colour, as a roll in [0, 255] — the client owns the palette, not this file. */
  readonly tintRoll: number;
}

/**
 * A fourth mix of the cell hash, for the flower rolls.
 *
 * A SEPARATE MIX rather than more bit slices of grassHash, for
 * grassBladeHash's own reason: grassHash's low byte already decides whether the
 * cell carries a tuft AT ALL, and its other slices are spent on scale and yaw.
 * Slicing what is left would correlate flowering with tuft size — every flower
 * on a big tuft, or none of them — which is the exact artefact the salted
 * re-avalanche exists to prevent. 0x2f1c8ad3 is an odd constant unrelated to
 * the other three.
 */
const GRASS_FLOWER_ROLL_SALT = 0x2f1c8ad3;

function grassFlowerHash(x: number, y: number): number {
  let h = (grassHash(x, y) ^ GRASS_FLOWER_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x9e3779b1);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * Does the tuft at (x, y) flower, and if so, how? Null for the large majority
 * of tufts.
 *
 * PURE AND DETERMINISTIC, exactly like grassCoversCell and for the identical
 * reason — see this section's header.
 */
export function grassFlowerOf(x: number, y: number): GrassFlower | null {
  const hash = grassFlowerHash(x, y);
  if ((hash & 0xff) >= GRASS_FLOWERING_SHARE_OF_256) return null;
  return {
    // Modulo of a full byte by a small blade count: the bias is at most one
    // blade in 256 and it is a choice of which stem a flower grows on, which is
    // not a quantity anything measures.
    bladeIndex: ((hash >>> 8) & 0xff) % GRASS_BLADES_PER_TUFT,
    tintRoll: (hash >>> 16) & 0xff,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FRINGE — SHORE REEDS (GH #192) AND ALPINE HEATHER (GH #194), ONE
// POPULATION.
//
// Everything above the green window is bare rock and everything below it is
// bare sand. Two species fill those two edges: reeds on the wet ground at the
// waterline, heather on the first rock bands under the snow line.
//
// THEY ARE ONE POPULATION AND NOT TWO, WHICH IS THE ONLY INTERESTING DECISION
// HERE. Trees, crops and grass are three separate fields because they are three
// separate MECHANISMS — different eligibility, different cadence, different
// occupancy rules, different caps, and each one exists for a different reason.
// Reeds and heather are one mechanism with a height test that has two answers:
// same survey, same cadence, same occupancy, same cap, same wire. Giving each
// its own field would be four more constants, another cursor, another credit
// and another message pair to say something one species roll already says — the
// "same shape, different contract" trap read backwards. The rule this plugin
// keeps is: a second FIELD when the mechanism differs, a second SPECIES when
// only the answer does.
//
// THE SPECIES RIDES THE WIRE, AS ONE LIST PER SPECIES, and the alternative was
// tried first and rejected on a concrete fact rather than on taste.
//
// The tempting version is to send two integers per plant like every other
// population here and let the client DERIVE the species from the cell's own
// height — the height it must already know to stand the plant on the ground.
// That derivation is not available to it. `ClientPluginCtx.terrainHeightAt`
// returns a WORLD-space Y (band floor × HEIGHT_WORLD_SCALE), not a heightmap
// height, and HEIGHT_WORLD_SCALE lives in client/src/config.ts — a module the
// plugin halves deliberately do not import, because it reads `import.meta.env`
// and would drag Vite into the server and the test runner (plugins/mana's
// env.d.ts and plugins/weather's sky.ts are two existing records of that trap).
// Recovering the height would mean restating the scale factor inside this
// plugin, which is the duplicated-terrain-math mistake `shared/` exists to
// prevent, to save one array header on a message that already carries thousands
// of integers.
//
// So the wire carries the answer instead of the inputs to it: `reeds` and
// `heather`, two flat coordinate lists in one message, and the client's only
// job is to draw what it is told. Withering needs no such split — a cell is
// removed by key, and a client that holds the key knows which list it is in.
//
// THE ARITHMETIC, at FLORA_FRINGE_CAP on a fully revealed 512² world:
//
//   wire      8192 × 6 B ≈ 49 KB for a full snapshot, split across the two
//             per-species lists — a fifth of the meadow's 246 KB, on the same
//             join / keepalive / unlock paths.
//   geometry  FOUR InstancedMeshes (two species × base and tip tone), so four
//             draw calls whatever the count. Instances are allocated per
//             species at the cap × that species' stem count, which is a hard
//             guarantee rather than a shared pool: 8192 × 3 reed stems and
//             8192 × 7 heather sprigs is 82k plants' worth of stems, and BOTH
//             TONES carry the full set — 164k matrices ≈ 10.5 MB of GPU
//             buffer, a third of what the meadow already allocates.
//             (Corrected 2026-09-01: this read "6 sprigs ≈ 74k ≈ 9 MB", which
//             undercounted FRINGE_HEATHER_STEM_COUNT and counted one tone.)
//
// WHAT IS DELIBERATELY NOT HERE: the fringe is not fuel. Grass, crops and trees
// register with fire (server/fire-bridge.ts); reeds and heather do not, so a
// fire reaching the waterline or the snow line stops there. That is an explicit
// punt, not an oversight — heather in particular is famously flammable, and
// making it burn means sizing a burn time and a flame height and re-checking
// the percolation argument FLORA_GRASS_BURN_SECONDS records. It is tracked
// separately rather than smuggled in here.
// ─────────────────────────────────────────────────────────────────────────────

/** Server → client, the WHOLE fringe (`flora:fringe`). Replaces the receiver's list. */
export const FLORA_FRINGE_MESSAGE = 'fringe';

/** Server → client, what changed since the last message (`flora:fringeChanges`). */
export const FLORA_FRINGE_CHANGES_MESSAGE = 'fringeChanges';

/**
 * The two things that grow on the fringe. A string union rather than an enum:
 * `shared/` bans enums for type-stripping, and this plugin keeps that rule so a
 * type can move between the two without a syntax question.
 */
export type FringeSpecies = 'reed' | 'heather';

/**
 * How far from a fringe cell the server looks for water before it will put a
 * REED there, in cells. Heather has no such test.
 *
 * THREE CELLS, which is 0.75 world units since the 2026-08-21 re-sample. A
 * one-cell test draws a hairline that reads as an outline around the water
 * rather than as a stand of reeds; much past three and the reeds detach from the
 * water and become beach scrub, which is a different plant (GH #193) and should
 * look like one. It is a Chebyshev radius — a square ring test, matching
 * farmland.ts's own shore sweep — because a reed bed does not care which
 * diagonal the water lies on.
 */
export const FRINGE_REED_SHORE_RADIUS_CELLS = 3;

/**
 * How many eligible cells there are, on average, per plant — GRASS_CELLS_PER_TUFT's
 * framing, once per species because the two grow at genuinely different
 * densities.
 *
 * REEDS ARE DENSE. Their eligible ground is already a strip a few cells wide
 * along the water, so a sparse roll over it gives a handful of stems rather than
 * a bed. HEATHER IS SPARSE: its eligible ground is every rock cell in a whole
 * ramp anchor, and mountainside scrub that covered it at meadow density would
 * read as the grass simply carrying on over the rock, which is the one thing
 * this species exists to avoid.
 */
export const FRINGE_REED_CELLS_PER_PLANT = 2;
export const FRINGE_HEATHER_CELLS_PER_PLANT = 4;

/** The two thinning thresholds out of 256 — derived, so they cannot drift from the densities above. */
export const FRINGE_REED_SHARE_OF_256 = Math.round(256 / FRINGE_REED_CELLS_PER_PLANT);
export const FRINGE_HEATHER_SHARE_OF_256 = Math.round(256 / FRINGE_HEATHER_CELLS_PER_PLANT);

/**
 * Hard ceiling on standing fringe plants.
 *
 * A GEOMETRY number first, exactly as FLORA_GRASS_CAP is, and a quarter of that
 * one: the fringe's eligible ground is two narrow height windows where the
 * meadow's is the whole green ramp, and its instance buffers are allocated per
 * species at the cap (see the section header's 10.5 MB).
 *
 * MEASURED, not assumed — surveying the shipped world `frostwick-hollows` (512²,
 * all 262 144 cells) against the real predicates gives:
 *
 *   water            236 180 cells  90.10%
 *   green ramp        10 846 cells   4.14%   (matches FLORA_GRASS_CAP's own
 *                                             independent measurement exactly)
 *   reed ground        5 270 cells   2.01%  → 2 651 plants after thinning
 *   heather ground       544 cells   0.21%  →   138 plants after thinning
 *                                              ─────
 *                                              2 789 plants, 34% of this cap
 *
 * So the cap does NOT bind on the world we ship, with a factor of three in hand
 * — which is the point, since the number that has to be safe is the worst case
 * rather than the measured one. Two things about that measurement are worth
 * carrying forward: reeds are the population that matters (they are 95% of the
 * fringe, because shoreline is what this worldgen makes), and heather is nearly
 * absent on a world this low — 544 cells of rock in its window. Heather will
 * read as a mountain plant, seen only on worlds that actually have mountains,
 * and that is the intended outcome rather than a density that needs raising.
 *
 * Past the cap the fringe stops appearing on the newest ground swept, which is
 * FLORA_GRASS_CAP's own named residual and reads the same way.
 */
export const FLORA_FRINGE_CAP = 8192;

/** A cell holding one fringe plant. The cell IS its identity — TreeCell's contract. */
export interface FringeCell {
  readonly x: number;
  readonly y: number;
}

/** Shares FLORA_CELL_KEY_STRIDE with the other three populations — cropKey's reason. */
export function fringeKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function fringeCellOf(key: number): FringeCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

/** Cells → the flat `[x0, y0, x1, y1, …]` wire form. */
export function packFringeCells(cells: Iterable<FringeCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

/** Defensive parse of a flat coordinate list, capped at FLORA_FRINGE_CAP. */
export function parseFringeCells(value: unknown): FringeCell[] | null {
  if (!Array.isArray(value)) return null;
  const cells: FringeCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_FRINGE_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

/** `flora:fringe` — the receiver's whole fringe, ONE FLAT LIST PER SPECIES. */
export interface FloraFringePayload {
  readonly reeds: readonly number[];
  readonly heather: readonly number[];
}

/**
 * `flora:fringeChanges` — what to add, by species, and what to remove.
 *
 * `withered` is NOT split by species, and that asymmetry is the point: a cell
 * is removed by key, and the receiver already knows which species it had.
 * Splitting it would be a second list carrying information the receiver cannot
 * fail to have.
 */
export interface FloraFringeChangesPayload {
  readonly reeds: readonly number[];
  readonly heather: readonly number[];
  readonly withered: readonly number[];
}

/** One parsed fringe payload — the cells this receiver should now hold, by species. */
export interface FringeBySpecies {
  readonly reed: FringeCell[];
  readonly heather: FringeCell[];
}

/**
 * Defensive parse of the two per-species lists.
 *
 * EACH LIST IS CAPPED SEPARATELY at FLORA_FRINGE_CAP, so a hostile payload
 * carrying two full lists yields at most twice the cap. That is deliberate and
 * bounded: the client's per-species instance buffers are each sized at the cap,
 * so neither can overrun, and the drawing loop stops at the cap across both
 * species anyway (client/fringeModels.ts). The alternative — a running total
 * across both lists — would make a long `reeds` list silently truncate a valid
 * `heather` one, which is a worse failure than drawing a bounded surplus.
 */
function parseFringeBySpecies(value: {
  reeds?: unknown;
  heather?: unknown;
}): FringeBySpecies | null {
  const reed = parseFringeCells(value.reeds ?? []);
  const heather = parseFringeCells(value.heather ?? []);
  if (reed === null || heather === null) return null;
  return { reed, heather };
}

export function parseFringePayload(payload: unknown): FringeBySpecies | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseFringeBySpecies(payload as { reeds?: unknown; heather?: unknown });
}

export function parseFringeChangesPayload(
  payload: unknown,
): { sprouted: FringeBySpecies; withered: FringeCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { reeds?: unknown; heather?: unknown; withered?: unknown };
  const sprouted = parseFringeBySpecies(message);
  const withered = parseFringeCells(message.withered ?? []);
  if (sprouted === null || withered === null) return null;
  return { sprouted, withered };
}

/**
 * Salt for the fringe rolls — GRASS_ROLL_SALT's job for this population.
 *
 * A fringe plant and a tuft of grass can never share a cell (their height
 * windows are disjoint by construction), so this salt is not preventing an
 * artefact anybody could see today. It is here because the day somebody widens
 * a window is not the day they should discover that two populations were sharing
 * a hash. 0x6b43a9f5 is odd and unrelated to the other four.
 */
const FRINGE_ROLL_SALT = 0x6b43a9f5;

function fringeHash(x: number, y: number): number {
  let h = (hashCell(x, y) ^ FRINGE_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * Does the thinning roll put a plant of `species` on this cell?
 *
 * Takes the species rather than the height so the caller — which has already
 * resolved the species to decide eligibility at all — does not resolve it twice.
 */
export function fringeCoversCell(x: number, y: number, species: FringeSpecies): boolean {
  const share = species === 'reed' ? FRINGE_REED_SHARE_OF_256 : FRINGE_HEATHER_SHARE_OF_256;
  return (fringeHash(x, y) & 0xff) < share;
}

/** Uniform scale bounds applied to a whole fringe plant — grassVariation's shape and spread. */
export const FRINGE_SCALE_MIN = 0.75;
export const FRINGE_SCALE_MAX = 1.25;

export interface FringeVariation {
  readonly scale: number;
  readonly yaw: number;
}

/** The deterministic variation for the plant at (x, y) — grassVariation, restated. */
export function fringeVariation(x: number, y: number): FringeVariation {
  const hash = fringeHash(x, y);
  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);
  return {
    scale: FRINGE_SCALE_MIN + (scaleRoll / 0xff) * (FRINGE_SCALE_MAX - FRINGE_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

/**
 * The footprint bound, and it lands on half a cell for GRASS_TUFT_MAX_REACH_CELLS'
 * reason: fringe plants sit one per cell on the cell lattice, so each may claim
 * half the distance to its neighbour and no two can ever overlap. The named
 * residual is the meadow's too — a blade tip may lean up to
 * (reach − CONTOUR_CELL_CENTRE_GUARD) past a terrace lip.
 */
export const FRINGE_MAX_REACH_CELLS = 0.5;

/** The square a plant's stems are planted in — GRASS_TUFT_CLUSTER_CELL_SPAN's derivation. */
export const FRINGE_CLUSTER_CELL_SPAN =
  FRINGE_MAX_REACH_CELLS / (SQUARE_CIRCUMRADIUS_PER_EDGE * FRINGE_SCALE_MAX);

/**
 * How many stems each species carries, and how far from the plant's crown they
 * are planted as a fraction of the cluster span.
 *
 * REEDS ARE FEW AND TIGHT — three tall stems standing almost together is what a
 * reed reads as, and spreading them turns one plant into three. HEATHER IS MANY
 * AND WIDE: it is a low mound, and the mound is made of the count. Both are odd,
 * for GRASS_BLADE_OFFSETS' reason — an even ring in a top-down camera reads as
 * the lattice it came from.
 */
const FRINGE_REED_STEM_COUNT = 3;
const FRINGE_HEATHER_STEM_COUNT = 7;
const FRINGE_REED_STEM_RADIUS_IN_SPANS = 0.12;
const FRINGE_HEATHER_STEM_RADIUS_IN_SPANS = 0.28;

function ringOffsets(count: number, radius: number): ReadonlyArray<readonly [number, number]> {
  return Array.from({ length: count }, (_unused, index): readonly [number, number] => {
    const angle = (TWO_PI * index) / count;
    return [radius * Math.sin(angle), radius * Math.cos(angle)];
  });
}

export const FRINGE_REED_STEM_OFFSETS = ringOffsets(
  FRINGE_REED_STEM_COUNT,
  FRINGE_REED_STEM_RADIUS_IN_SPANS,
);

export const FRINGE_HEATHER_STEM_OFFSETS = ringOffsets(
  FRINGE_HEATHER_STEM_COUNT,
  FRINGE_HEATHER_STEM_RADIUS_IN_SPANS,
);

/** The stem lattice for one species — the client's single lookup. */
export function fringeStemOffsets(
  species: FringeSpecies,
): ReadonlyArray<readonly [number, number]> {
  return species === 'reed' ? FRINGE_REED_STEM_OFFSETS : FRINGE_HEATHER_STEM_OFFSETS;
}

/**
 * The most stems any one species carries — what the client sizes the WORST of
 * its instance buffers from, so a species gaining a stem cannot silently
 * overrun one.
 */
export const FRINGE_MAX_STEMS_PER_PLANT = Math.max(
  FRINGE_REED_STEM_COUNT,
  FRINGE_HEATHER_STEM_COUNT,
);

/** How much shorter or taller than its plant one stem may be, as a fraction. */
export const FRINGE_STEM_HEIGHT_SPREAD = 0.3;

/** How far a stem may wander off its lattice point, as a fraction of the cluster span. */
export const FRINGE_STEM_JITTER_IN_SPANS = 0.05;

/** GrassBladeVariation, restated for a fringe stem. */
export interface FringeStemVariation {
  readonly yaw: number;
  readonly height: number;
  readonly jitterX: number;
  readonly jitterZ: number;
}

function fringeStemHash(x: number, y: number, index: number): number {
  let h = fringeHash(x, y);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (index + 1), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The deterministic variation for stem `index` of the plant at (x, y). */
export function fringeStemVariation(x: number, y: number, index: number): FringeStemVariation {
  const hash = fringeStemHash(x, y, index);
  const yawRoll = hash & (YAW_DIVISOR - 1);
  const heightRoll = (hash >>> 16) & 0xff;
  const jitterXRoll = (hash >>> 8) & (JITTER_DIVISOR - 1);
  const jitterZRoll = (hash >>> 24) & (JITTER_DIVISOR - 1);
  const centred = (roll: number): number => (roll / (JITTER_DIVISOR - 1)) * 2 - 1;
  return {
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
    height: 1 + centred(heightRoll) * FRINGE_STEM_HEIGHT_SPREAD,
    jitterX: centred(jitterXRoll) * FRINGE_STEM_JITTER_IN_SPANS,
    jitterZ: centred(jitterZRoll) * FRINGE_STEM_JITTER_IN_SPANS,
  };
}

/** The tuft lattice check, a second time — every input is a constant, so it holds always or never. */
if (
  FRINGE_CLUSTER_CELL_SPAN * FRINGE_SCALE_MAX * SQUARE_CIRCUMRADIUS_PER_EDGE >
  FRINGE_MAX_REACH_CELLS + Number.EPSILON
) {
  throw new RangeError(
    `a fringe plant of ${FRINGE_CLUSTER_CELL_SPAN} cells reaches past ${FRINGE_MAX_REACH_CELLS} cells and could overhang a terrace lip`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STUMPS (GH #195) — the fifth population, and the first that is a RESIDUE
// rather than a crop of the ground.
//
// The other four are all answers to "what does this cell's terrain deserve":
// re-derivable from the heightmap at any moment, which is why three of them
// persist nothing and the fourth persists only because a forest is the record
// of something the player did. A stump is not derivable from anything. It is
// the mark left by an EVENT — a fire that finished burning the tree standing
// here — and the only way to know it is there is to have been told.
//
// ONE CAUSE, DELIBERATELY (owner, 2026-08-26). Four things remove a standing
// tree today, and only one of them leaves anything behind:
//
//   fire burned out   → A STUMP. The tree was destroyed where it stood; its
//                       ground was never touched and its cell is still free.
//   sculpt            → nothing. The ground itself moved, so the tree was
//                       uprooted, not cut — and sculpting is the player's main
//                       verb, so a stump per felled tree would litter the
//                       meadow after every edit.
//   building seeded   → nothing. The structure's floor is on that cell now;
//                       a stump would be inside it.
//   survey cull       → nothing. The cull fires when the ground stopped being
//                       able to hold a tree at all (it went to water, to rock,
//                       under a building) — there is nowhere for a stump to be.
//
// So a stump means exactly one thing wherever a player sees one: fire came
// through here. That legibility is the feature; a stump from every cause would
// be scenery.
//
// A LIFETIME, NOT A CAP DISCIPLINE. Stumps rot (FLORA_STUMP_ROT_SECONDS) and
// the list is emptied by the passage of time rather than by pressure against
// FLORA_STUMP_CAP — which is what keeps a burn scar an event the world heals
// from rather than a permanent monument. The cap is a bound, not a mechanism.
//
// NOT PERSISTED, matching crops, grass and the fringe and for a stronger
// reason than any of them: a stump is a countdown, and a restart that restored
// one would have to restore its remaining seconds too or silently reset every
// scar in the world to a full lifetime. Losing them is honest — they were
// going to rot anyway, and a fire nobody was connected to see is a fire that
// left no impression.
//
// THE ARITHMETIC, at FLORA_STUMP_CAP on a 512² world, following the tree
// arithmetic at the top of this file exactly:
//
//   full snapshot   4096 × 6 B                      = 24 KB, ONCE, at join
//   keepalive       24 KB / 60 s                     = 400 B/s ≈ 3.2 kbit/s
//
// And that is the CAP, not the expectation: the cap is only reachable if the
// entire forest burns down inside one rot window. The steady state on a world
// that is not on fire is an empty list and no message at all
// (FLORA_SKIP_EMPTY).
// ─────────────────────────────────────────────────────────────────────────────

/** Server → client, the WHOLE stump list. Replaces the receiver's list. */
export const FLORA_STUMP_MESSAGE = 'stumps';

/** Server → client, a delta: stumps LEFT by a burn, stumps that have ROTTED away. */
export const FLORA_STUMP_CHANGES_MESSAGE = 'stumpChanges';

/**
 * The most stumps that can stand at once.
 *
 * FLORA_TREE_CAP exactly, and derived from it rather than chosen: a stump is
 * the remains of a tree, at most one tree ever stands on a cell, and a stump
 * holds its cell against replanting until it rots (server/index.ts's
 * occupiedCells) — so the standing forest and the stumps left by burning it
 * down cannot both exceed the tree cap at the same moment. Sizing this
 * independently would be inventing a second bound for a quantity the first one
 * already bounds.
 */
export const FLORA_STUMP_CAP = FLORA_TREE_CAP;

/**
 * A cell holding one stump. TreeCell's contract exactly — the cell is the
 * identity, so there is no id here either, and "the stump at that cell" is
 * unambiguous because the tree that left it was unambiguous.
 */
export interface StumpCell {
  readonly x: number;
  readonly y: number;
}

/** Cell → integer key. treeKey's encoding, restated for this population's own map. */
export function stumpKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

/** Integer key → cell. The exact inverse of stumpKey. */
export function stumpCellOf(key: number): StumpCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

/** Cells → the flat wire form. packTreeCells' encoding and its byte argument. */
export function packStumpCells(cells: Iterable<StumpCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

/** Defensive parse of a flat coordinate list — parseTreeCells, capped at this population's own cap. */
export function parseStumpCells(value: unknown): StumpCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: StumpCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_STUMP_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

/** `flora:stumps` — the receiver's whole stump list. */
export interface FloraStumpsPayload {
  readonly stumps: readonly number[];
}

/** `flora:stumpChanges` — what a burn left, and what has rotted away. */
export interface FloraStumpChangesPayload {
  readonly left: readonly number[];
  readonly rotted: readonly number[];
}

export function parseStumpsPayload(payload: unknown): StumpCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseStumpCells((payload as { stumps?: unknown }).stumps);
}

export function parseStumpChangesPayload(
  payload: unknown,
): { left: StumpCell[]; rotted: StumpCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { left?: unknown; rotted?: unknown };
  // An absent half is an empty half — parseChangesPayload's own rule, and it
  // earns its keep here: a decay tick that rots stumps with nothing new burning
  // sends only `rotted`, so `left` is genuinely absent in ordinary traffic.
  const left = parseStumpCells(message.left ?? []);
  const rotted = parseStumpCells(message.rotted ?? []);
  if (left === null || rotted === null) return null;
  return { left, rotted };
}

/**
 * Uniform scale bounds for a stump.
 *
 * NARROWER than the tree spread it comes from (0.78–1.25) on purpose. A stump
 * is a cross-section near the ground, where a tree's trunk varies least, and
 * the tree that stood here is already gone — so a stump twice the width of its
 * neighbour would read as a different kind of object rather than as the same
 * object at a different size.
 */
export const FLORA_STUMP_SCALE_MIN = 0.85;
export const FLORA_STUMP_SCALE_MAX = 1.15;

export interface StumpVariation {
  readonly scale: number;
  readonly yaw: number;
}

/**
 * The deterministic variation for the stump at (x, y).
 *
 * Salted off hashCell rather than reusing treeVariation's rolls directly: the
 * yaw a stump is drawn at must NOT match the yaw the tree that stood there was
 * drawn at, because a stump's whole silhouette is the splintered break across
 * its top and reusing the tree's roll would line every stump's break up with
 * the crown that is no longer there.
 */
const STUMP_ROLL_SALT = 0x51ab7d29;

export function stumpVariation(x: number, y: number): StumpVariation {
  let hash = (hashCell(x, y) ^ STUMP_ROLL_SALT) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x9e3779b1);
  hash = (hash ^ (hash >>> 15)) >>> 0;

  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);
  return {
    scale:
      FLORA_STUMP_SCALE_MIN + (scaleRoll / 0xff) * (FLORA_STUMP_SCALE_MAX - FLORA_STUMP_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

/**
 * The footprint bound — GRASS_TUFT_MAX_REACH_CELLS' half-cell rule, for the
 * same reason: stumps sit one per cell on the cell lattice, so each may claim
 * half the distance to its neighbour and no two can overlap. The client's model
 * checks its built radius against this (client/stumpModels.ts).
 */
export const STUMP_MAX_REACH_CELLS = 0.5;
