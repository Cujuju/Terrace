// The client's local mirror of the authoritative heightmap.
//
// CRITICAL CODE — this is the client half of the sync path (design doc).
// Everything the client draws is derived from this mirror, so a mis-applied
// message is a permanently wrong world until the next join. Two invariants
// carry the whole module:
//
//   1. The mirror only ever contains data the SERVER sent. Locked chunks are
//      never on the wire (anti-cheat by omission), so "which chunks have
//      we received" IS the client's notion of what exists. `received` is that
//      set; the renderer draws exactly those chunks and nothing else.
//   2. Cells of never-received chunks stay at their allocated zero, which is
//      SEA_LEVEL. That is deliberate: it makes the edge of revealed territory
//      slope down into the sea instead of ending in a floating cliff (see
//      vertexGrid.ts, which samples across chunk borders for seam continuity).
//      — PARTLY SUPERSEDED (issue #22): the RENDERER no longer reads those
//      zeros. `sampleRenderHeight` below pulls a sample in a never-received
//      chunk back onto received terrain, so the frontier draws no accidental
//      cliff at all; the mist curtain (render/frontierFog.ts) marks the
//      boundary instead. The zeros still back every non-render consumer of
//      `sampleHeight`.
//
// This module is deliberately free of Three.js and DOM references so it can be
// unit-tested headless — see test/mirror.test.ts.

import {
  CHUNK_SIZE,
  applyPackedSpans,
  cellIndex,
  chunkIndex,
  columnCoversBand,
  columnSampleAtBand,
  chunksPerEdge,
  createHeightmap,
  isValidHeight,
  writeChunkPayload,
  type ChunkPayload,
  type ChunkUnlockMessage,
  type Heightmap,
  type JoinSnapshotMessage,
  type TerrainDiffMessage,
} from '@terrace/shared';

export interface TerrainMirror {
  readonly map: Heightmap;
  /** Flat chunk indices the server has sent us. Only these are rendered. */
  readonly received: Set<number>;
}

/**
 * Allocates the mirror up front for the world size the server reported in its
 * join snapshot. 512² Int16 is 512 KB — trivial, and it means no reallocation
 * ever happens as territory is revealed (design doc).
 */
export function createTerrainMirror(worldSize: number): TerrainMirror {
  chunksPerEdge(worldSize); // throws unless worldSize is a positive multiple of CHUNK_SIZE
  return { map: createHeightmap(worldSize), received: new Set<number>() };
}

/**
 * Reads a cell, clamping the coordinates into the world. Clamping (rather than
 * returning a sentinel) is what lets vertexGrid sample one cell past a chunk's
 * last row without special-casing the world border.
 */
export function sampleHeight(mirror: TerrainMirror, x: number, y: number): number {
  const max = mirror.map.size - 1;
  const cx = x < 0 ? 0 : x > max ? max : x;
  const cy = y < 0 ? 0 : y > max ? max : y;
  return mirror.map.cells[cellIndex(mirror.map, cx, cy)];
}

export function hasChunk(mirror: TerrainMirror, chunkIdx: number): boolean {
  return mirror.received.has(chunkIdx);
}

/**
 * Whether `sampleHeight` at (x, y) would answer from a RECEIVED chunk — the
 * same edge clamp, so the two agree about which cell is being asked about.
 *
 * THE COMPANION `sampleHeight` ALWAYS NEEDED (2026-09-02). Invariant 2 above
 * says a never-received cell reads as SEA_LEVEL, which is band 0, which is the
 * plane the sea surface is drawn on. Every plugin reader of the height that
 * took a MAX over a footprint (a whale's hull, a walker's feet) therefore saw
 * "ground at the waterline" one cell past the fog frontier and lifted its
 * creature onto it — a whale patrolling the edge of revealed territory surfaced
 * and swam along the top of the sea. The zero is a storage fact, not a
 * terrain fact, and this is how a reader tells the two apart.
 */
export function isCellReceived(mirror: TerrainMirror, x: number, y: number): boolean {
  const max = mirror.map.size - 1;
  const cx = x < 0 ? 0 : x > max ? max : x;
  const cy = y < 0 ? 0 : y > max ? max : y;
  return cellChunkReceived(mirror, cx, cy);
}

/** Whether the chunk OWNING cell (x, y) has been received. In-bounds only. */
function cellChunkReceived(mirror: TerrainMirror, x: number, y: number): boolean {
  return mirror.received.has(
    chunkIndex(
      mirror.map.size,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
    ),
  );
}

/**
 * `sampleHeight` for the RENDERER: a sample that falls in a never-received
 * chunk is pulled back across the frontier onto received terrain, exactly the
 * way the world border is handled by clamping (issue #22).
 *
 * WHY. The mesh builder (vertexGrid.ts) samples one cell past its chunk on
 * the +x/+y sides for seam continuity. Reading a never-received chunk there
 * returns the allocated zero — a phantom sea-level neighbour — and the
 * ordinary contour/skirt machinery then draws a frontier-shaped CLIFF wherever
 * the edge terrain happens to sit above sea level (see terrain/frontier.ts's
 * header for why that inconsistency is an accident, not a boundary). Pulling
 * the sample back instead makes the caps extend flat to the domain edge and
 * grow no contour and no skirt — the frontier renders exactly like the world's
 * outer border, whatever the local height, and the mist curtain
 * (render/frontierFog.ts) is the only boundary treatment left.
 *
 * SEAM SAFETY. The pull-back must be a pure function of the WORLD sample
 * position and the received set — never of which chunk is asking — or two
 * received chunks sharing a border would disagree about a corner sample and
 * crack the seam (contract S1/S3 in vertexGrid.ts). An out-of-chunk sample
 * always lies on a chunk seam (the lattice overflows by exactly one cell), so:
 *
 *   - sample on a COLUMN seam only (x % CHUNK_SIZE === 0): its one possible
 *     reader is the chunk to the west — step one cell back west;
 *   - sample on a ROW seam only: mirror-image, step one cell back north;
 *   - sample on BOTH (a chunk corner): up to three received chunks read it, so
 *     the replacement is chosen in one fixed order (north neighbour's cell,
 *     then west's, then the diagonal's) that every reader computes
 *     identically.
 *
 * Samples inside a RECEIVED chunk — every sample two received chunks share —
 * are returned untouched, so seams between received chunks are bit-identical
 * to before.
 */
export function sampleRenderHeight(mirror: TerrainMirror, x: number, y: number): number {
  const cell = renderSampleCell(mirror, x, y);
  return mirror.map.cells[cellIndex(mirror.map, cell.x, cell.y)];
}

/**
 * `sampleRenderHeight` for ONE BAND of a layered column: the same pull-back,
 * the same clamping, but the sample the contour pass needs to answer "is this
 * cell solid at band k" (shared's columnSampleAtBand).
 *
 * Identical to `sampleRenderHeight` at every band while a column holds one
 * span, which is what lets the mesh builder keep marching the plain height
 * lattice until a chunk actually carries a layer.
 */
export function sampleRenderBandHeight(
  mirror: TerrainMirror,
  x: number,
  y: number,
  band: number,
): number {
  const cell = renderSampleCell(mirror, x, y);
  return columnSampleAtBand(mirror.map, cell.x, cell.y, band);
}

/**
 * Whether the column a render sample reads is SOLID at one band — the ceiling
 * pass's field, resolved through the same pull-back as every other sampler
 * here so a cave mouth cannot crack a seam.
 */
export function sampleRenderBandSolid(
  mirror: TerrainMirror,
  x: number,
  y: number,
  band: number,
): boolean {
  const cell = renderSampleCell(mirror, x, y);
  return columnCoversBand(mirror.map, cell.x, cell.y, band);
}

/**
 * WHICH CELL a render sample reads, after clamping to the world and pulling
 * back across the frontier. Extracted so that every render sampler — the
 * height, and the per-band one above — resolves the position identically;
 * seam contracts S1/S3 hold because the answer depends only on the world
 * position and the received set, never on which chunk is asking.
 */
function renderSampleCell(
  mirror: TerrainMirror,
  x: number,
  y: number,
): { x: number; y: number } {
  const max = mirror.map.size - 1;
  const sx = x < 0 ? 0 : x > max ? max : x;
  const sy = y < 0 ? 0 : y > max ? max : y;
  if (cellChunkReceived(mirror, sx, sy)) return { x: sx, y: sy };
  const onColumnSeam = sx > 0 && sx % CHUNK_SIZE === 0;
  const onRowSeam = sy > 0 && sy % CHUNK_SIZE === 0;
  if (onColumnSeam && onRowSeam) {
    if (cellChunkReceived(mirror, sx, sy - 1)) return { x: sx, y: sy - 1 };
    if (cellChunkReceived(mirror, sx - 1, sy)) return { x: sx - 1, y: sy };
    return { x: sx - 1, y: sy - 1 };
  }
  if (onColumnSeam) return { x: sx - 1, y: sy };
  if (onRowSeam) return { x: sx, y: sy - 1 };
  // Interior of a never-received chunk: no received chunk's lattice reaches
  // here (the overflow is exactly one cell, always landing on a seam), so the
  // value is unobservable by any mesh — read the cell itself.
  return { x: sx, y: sy };
}

/**
 * Chunks whose RENDERED geometry depends on cell (x,y).
 *
 * Since the 2026-08-14 cliff renderer, a chunk's mesh emits per-cell top quads
 * plus wall quads against its +x/+y neighbours, and a chunk's LAST row/column
 * walls read the FIRST row/column of the next chunk (see vertexGrid.ts). The
 * consequence for diff application is unchanged in shape: a cell on a chunk's
 * first row or column is also read by the chunk before it —
 *
 *   cell x is owned by chunk floor(x / CHUNK_SIZE), and additionally feeds the
 *   border walls of chunk floor(x / CHUNK_SIZE) - 1 exactly when
 *   x % CHUNK_SIZE === 0.
 *
 * The same holds independently on y. The up-left DIAGONAL dirty this function
 * also emits is now slightly over-conservative for the wall geometry (the old
 * vertex-per-cell grid's corner sample needed it); it costs one harmless extra
 * chunk patch on corner cells and is kept for simplicity.
 * Missing this is precisely how seam cracks appear after an edit, which is why
 * it is its own tested function rather than inline arithmetic.
 *
 * THE FRONTIER PULL-BACK IS PART OF THIS QUESTION (issue #22's other half).
 * A sample in a never-received chunk is not read as a zero — `renderSampleCell`
 * answers it with a RECEIVED cell one step back — so a cell is also read by
 * every chunk whose lattice covers a sample that pulls back onto it. That is
 * why the mirror is the argument: which chunks read a cell is a function of
 * the received set, not of arithmetic alone. Missing it left one stale corner
 * vertex behind after a sculpt at a frontier's inside corner — the seam crack
 * this function exists to prevent, arriving by the one route the arithmetic
 * could not see.
 *
 * Returned indices are all in-bounds, but are NOT filtered against `received`
 * — the caller does that, because a chunk we do not have simply has no mesh.
 */
export function chunksDirtiedByCell(
  mirror: TerrainMirror,
  x: number,
  y: number,
): number[] {
  const worldSize = mirror.map.size;
  const perEdge = chunksPerEdge(worldSize);
  const out: number[] = [];
  addSampleReaders(out, worldSize, perEdge, x, y);

  // The only samples that can pull back onto (x, y) are its +x/+y neighbours
  // ON A CHUNK SEAM: the pull-back steps exactly one cell, and it only fires
  // for a sample that lies on a seam (`renderSampleCell`). So a cell anywhere
  // but its chunk's LAST row or column cannot be reached this way, and the
  // arithmetic above is the whole answer for it.
  const lastInChunkColumn = (x + 1) % CHUNK_SIZE === 0;
  const lastInChunkRow = (y + 1) % CHUNK_SIZE === 0;
  if (lastInChunkColumn) addPullBackReaders(out, mirror, perEdge, x + 1, y, x, y);
  if (lastInChunkRow) addPullBackReaders(out, mirror, perEdge, x, y + 1, x, y);
  if (lastInChunkColumn && lastInChunkRow) {
    addPullBackReaders(out, mirror, perEdge, x + 1, y + 1, x, y);
  }
  return out;
}

/**
 * Adds chunk (cx, cy) to `out` if it exists and is not already there. The
 * de-duplication is what lets the callers below name the same reader twice
 * without the caller of `chunksDirtiedByCell` seeing a repeat.
 */
function addChunk(
  out: number[],
  worldSize: number,
  perEdge: number,
  cx: number,
  cy: number,
): void {
  if (cx < 0 || cy < 0 || cx >= perEdge || cy >= perEdge) return;
  const idx = chunkIndex(worldSize, cx, cy);
  if (!out.includes(idx)) out.push(idx);
}

/**
 * Every chunk whose mesh READS the sample at lattice position (px, py) — its
 * own chunk plus, because a chunk's lattice overflows one cell past its last
 * row and column (vertexGrid.ts, S2), the chunk to the west of a column seam,
 * the one to the north of a row seam, and the diagonal one at a corner.
 *
 * A sample position may be `worldSize` (the last chunk's overflow), which owns
 * no chunk at all; `addChunk` drops it and the seam readers still land.
 */
function addSampleReaders(
  out: number[],
  worldSize: number,
  perEdge: number,
  px: number,
  py: number,
): void {
  const cx = Math.floor(px / CHUNK_SIZE);
  const cy = Math.floor(py / CHUNK_SIZE);
  const onColumnSeam = px % CHUNK_SIZE === 0;
  const onRowSeam = py % CHUNK_SIZE === 0;
  addChunk(out, worldSize, perEdge, cx, cy);
  if (onColumnSeam) addChunk(out, worldSize, perEdge, cx - 1, cy);
  if (onRowSeam) addChunk(out, worldSize, perEdge, cx, cy - 1);
  if (onColumnSeam && onRowSeam) addChunk(out, worldSize, perEdge, cx - 1, cy - 1);
}

/**
 * The readers of sample (px, py), but only when that sample actually resolves
 * to cell (x, y) — i.e. when the frontier pull-back sends it there.
 *
 * ASKED OF `renderSampleCell` ITSELF rather than re-derived from the received
 * set, so the invalidation rule cannot drift from the sampling rule it is
 * invalidating: whatever that function decides a sample reads is what this
 * treats as depending on it.
 */
function addPullBackReaders(
  out: number[],
  mirror: TerrainMirror,
  perEdge: number,
  px: number,
  py: number,
  x: number,
  y: number,
): void {
  const read = renderSampleCell(mirror, px, py);
  if (read.x !== x || read.y !== y) return;
  addSampleReaders(out, mirror.map.size, perEdge, px, py);
}

/**
 * A writer's report that it is about to overwrite one cell, by flat cell index.
 *
 * Exists because "which chunks did this change" is not answerable by the code
 * doing the writing when the write is one step of a longer reconciliation —
 * see `applyTerrainDiff`'s `onCellWrite` note. The sink is called BEFORE the
 * write so the recipient can read the outgoing value.
 */
export type CellWriteSink = (cellIdx: number) => void;

/**
 * Writes one chunk payload into the mirror and marks it received.
 * Returns every chunk index whose mesh is now stale — the chunk itself plus,
 * for the same border-sampling reason as above, the neighbours that sample
 * into it (the chunk to its left, above, and up-left).
 */
function applyChunkPayload(mirror: TerrainMirror, chunk: ChunkPayload): number[] {
  const worldSize = mirror.map.size;
  // writeChunkPayload bounds-checks the chunk coords, the payload length, and
  // every individual height (isValidHeight) — a malformed server message
  // throws rather than silently corrupting the map. Caught immediately below
  // and dropped: the established drop-don't-crash policy for server-
  // originated messages (see applyTerrainDiff below), because one bad chunk
  // in a broadcast must not take down every client's render loop, and the
  // chunk is simply never marked received.
  //
  // The chunk's LAYERED COLUMNS ride in the same call, after the heights and
  // after the reset the heights imply, so a chunk that used to hold an arch
  // and no longer does comes back flat instead of keeping the old split. A
  // single bad span entry does not throw — it costs that one column, which
  // writeChunkPayload counts and we log once for the chunk.
  try {
    const rejected = writeChunkPayload(
      mirror.map,
      chunk.cx,
      chunk.cy,
      chunk.heights,
      chunk.layered,
    );
    if (rejected > 0) {
      console.warn(
        `[terrace] chunk (${chunk.cx},${chunk.cy}): dropped ${rejected} malformed layered column(s)`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[terrace] dropping malformed chunk (${chunk.cx},${chunk.cy}): ${message}`);
    return [];
  }

  const idx = chunkIndex(worldSize, chunk.cx, chunk.cy);
  mirror.received.add(idx);

  const dirty = [idx];
  if (chunk.cx > 0) dirty.push(chunkIndex(worldSize, chunk.cx - 1, chunk.cy));
  if (chunk.cy > 0) dirty.push(chunkIndex(worldSize, chunk.cx, chunk.cy - 1));
  if (chunk.cx > 0 && chunk.cy > 0) {
    dirty.push(chunkIndex(worldSize, chunk.cx - 1, chunk.cy - 1));
  }
  return dirty;
}

/**
 * Applies the join snapshot: the world's size plus ONLY the chunks unlocked
 * for this client. Returns the set of chunk indices needing a mesh rebuild.
 *
 * The caller creates the mirror from `msg.worldSize` before calling this, so
 * the size is not re-read here.
 */
export function applySnapshot(
  mirror: TerrainMirror,
  msg: JoinSnapshotMessage,
): Set<number> {
  const dirty = new Set<number>();
  for (const chunk of msg.chunks) {
    for (const idx of applyChunkPayload(mirror, chunk)) dirty.add(idx);
  }
  return dirty;
}

/** Applies newly revealed chunks streaming in mid-session. */
export function applyChunkUnlock(
  mirror: TerrainMirror,
  msg: ChunkUnlockMessage,
): Set<number> {
  const dirty = new Set<number>();
  for (const chunk of msg.chunks) {
    for (const idx of applyChunkPayload(mirror, chunk)) dirty.add(idx);
  }
  return dirty;
}

/**
 * Applies an authoritative cell diff — the hot path: this runs for every
 * sculpt anyone in the world performs.
 *
 * Cells outside the map, or carrying an invalid height, are dropped
 * defensively rather than thrown on: a diff is a broadcast to every client,
 * and one malformed entry must not take down a client's whole render loop.
 * (The server validates intents before applying them, so this is
 * belt-and-suspenders, not an expected path.)
 *
 * A cell's LAYERED COLUMNS ride in the same entry (`CellDiff.spans`) and are
 * written right behind its height, through the shared `applyPackedSpans`: a
 * diff that carried a carve installs the split, and — the half that is easy
 * to forget — a diff that carries NO spans deletes any split this client is
 * still holding, because absent means one span and the world may have
 * re-merged the column since the last diff we saw.
 *
 * Returns the chunk indices to re-patch. Note it returns chunks regardless of
 * whether we hold them; the renderer ignores indices with no mesh.
 *
 * `onCellWrite` INVERTS THAT LAST SENTENCE, deliberately. A diff is applied
 * inside a prediction reconciliation that rolls predictions off, writes these
 * cells and replays the survivors; the only cells worth re-patching are the
 * ones whose RENDERED value differs across that whole sequence, and a
 * per-write comparison here cannot see it (a correctly predicted sculpt writes
 * each cell twice — once rolling back to base, once with the server's
 * identical value — and would call both writes a change). So when a sink is
 * supplied this function reports each cell it is ABOUT TO WRITE and returns an
 * EMPTY set: the caller holds the before-picture and decides. Without a sink
 * the behaviour is exactly what it always was, which is what every direct
 * caller — tests, the mesh harnesses — still wants.
 */
export function applyTerrainDiff(
  mirror: TerrainMirror,
  msg: TerrainDiffMessage,
  onCellWrite?: CellWriteSink,
): Set<number> {
  const worldSize = mirror.map.size;
  const dirty = new Set<number>();
  // Counted across the whole message and reported once, not once per cell:
  // the same policy the chunk payload path uses for its rejected layered
  // columns above. A diff is a broadcast — every client logs the same bad
  // entry, and one noisy column must not become one log line per recipient
  // per sculpt.
  let rejectedSpans = 0;

  for (const cell of msg.cells) {
    if (
      !Number.isInteger(cell.x) ||
      !Number.isInteger(cell.y) ||
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x >= worldSize ||
      cell.y >= worldSize ||
      !isValidHeight(cell.h)
    ) {
      continue;
    }
    const i = cellIndex(mirror.map, cell.x, cell.y);
    // BEFORE the write, which is the whole contract of the sink: it is the
    // last moment the cell still holds the value the screen was drawn from.
    onCellWrite?.(i);
    mirror.map.cells[i] = cell.h;

    // A diff that DISAGREES WITH ITSELF — a span list whose topmost ceiling
    // is not the height beside it in the same entry — is refused its spans
    // (the height still stands), exactly as `writeChunkPayload` refuses the
    // same tear within a chunk payload: `setColumn` inside `applyPackedSpans`
    // would otherwise overwrite the height we just wrote with the list's own
    // last ceiling, rendering a surface the server never sent. Degrading the
    // column to one span at the sent height keeps it renderable until the
    // server's next word on it, and passing `undefined` rather than leaving
    // the old list standing is the delete-half of "absent means one span".
    if (cell.spans !== undefined && cell.spans[cell.spans.length - 1] !== cell.h) {
      rejectedSpans++;
      applyPackedSpans(mirror.map, cell.x, cell.y, undefined);
    } else if (!applyPackedSpans(mirror.map, cell.x, cell.y, cell.spans)) {
      // A PRESENT list that did not parse costs this cell its span list —
      // `applyPackedSpans` has already deleted it — but not its height.
      rejectedSpans++;
    }

    // With a sink the CALLER owns the dirty question — see the doc above — so
    // nothing is added here and the returned set stays empty.
    if (onCellWrite === undefined) {
      for (const idx of chunksDirtiedByCell(mirror, cell.x, cell.y)) {
        dirty.add(idx);
      }
    }
  }
  if (rejectedSpans > 0) {
    console.warn(
      `[terrace] terrain diff: dropped ${rejectedSpans} malformed layered column(s)`,
    );
  }
  return dirty;
}
