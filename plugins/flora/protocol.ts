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
