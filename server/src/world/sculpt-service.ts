import {
  CHUNK_SIZE,
  chunksPerEdge,
  sculptOptionsOf,
  sculptReachCells,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  type CellDiff,
  type ChunkPayload,
  type SculptIntent,
  type SculptOptions,
} from '@terrace/shared';
import { logError } from '../log.ts';
import {
  LogThrottle,
  ROOM_FAILURE_LOG_INTERVAL_MS,
  throttledLog,
} from '../net/contain-message.ts';
import { timePhase } from '../tick-timing.ts';
import { chunkPayloadOf, partitionDiffByViewer, type ViewerDiff } from './mask-filter.ts';
import type { World } from './world.ts';

export interface TerrainChangeListener {
  notifyTerrainChanged(diff: readonly CellDiff[], sculptorToken?: string): void;
}

/** An edit on a chunk's rim moves its neighbour's mesh seam, so a resync overshoots by one chunk. */
export const MESH_SEAM_HALO_CHUNKS = 1;

const diffSendLog = new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS);

export function applyServerSculpt(
  world: World,
  listener: TerrainChangeListener,
  x: number,
  y: number,
  radius: number,
  amount: number,
  options?: SculptOptions,
  sculptorToken?: string,
): CellDiff[] {
  const diff = timePhase('sculpt.relax', () => world.applySculpt(x, y, radius, amount, options));
  if (diff.length === 0) return diff;

  timePhase('sculpt.broadcast', () => {
    broadcastDiff(world, diff);
  });

  timePhase('sculpt.listeners', () => {
    listener.notifyTerrainChanged(diff, sculptorToken);
  });
  return diff;
}

/**
 * One viewer's failed send is that viewer's problem: the others still get the
 * diff, and the one that failed gets the authoritative chunks instead.
 */
function broadcastDiff(world: World, diff: readonly CellDiff[]): void {
  let shares: ViewerDiff[];
  try {
    shares = partitionDiffByViewer(world, diff);
  } catch (error) {
    noteDiffSendFailure(error);
    resendDiffChunks(world, diff);
    return;
  }

  const stranded: string[] = [];
  for (const { playerId, cells } of shares) {
    try {
      world.sendTo(playerId, { type: 'terrainDiff', cells });
    } catch (error) {
      noteDiffSendFailure(error);
      stranded.push(playerId);
    }
  }
  if (stranded.length > 0) {
    resendDiffChunks(world, diff, stranded);
  }
}

function noteDiffSendFailure(error: unknown): void {
  throttledLog(diffSendLog, () => {
    logError('a terrain diff could not be delivered; resending the authoritative chunks', error);
  });
}

/**
 * Re-sends the authoritative heights of every chunk the sculpt actually wrote.
 * The diff is the only honest account of reach: a smooth's cascade outruns
 * its brush.
 */
function resendDiffChunks(
  world: World,
  diff: readonly CellDiff[],
  toPlayerIds?: readonly string[],
): void {
  const edge = chunksPerEdge(world.size);
  const touched = new Set<number>();
  for (const cell of diff) {
    const cx = chunkOfCell(cell.x);
    const cy = chunkOfCell(cell.y);
    for (let hy = -MESH_SEAM_HALO_CHUNKS; hy <= MESH_SEAM_HALO_CHUNKS; hy++) {
      for (let hx = -MESH_SEAM_HALO_CHUNKS; hx <= MESH_SEAM_HALO_CHUNKS; hx++) {
        const nx = cx + hx;
        const ny = cy + hy;
        if (nx < 0 || ny < 0 || nx > edge - 1 || ny > edge - 1) continue;
        touched.add(ny * edge + nx);
      }
    }
  }
  sendChunkResync(
    world,
    [...touched].sort((a, b) => a - b),
    edge,
    toPlayerIds,
  );
}

/**
 * Re-sends every chunk a sculpt whose handling threw could have edited. No
 * diff exists for a fault, so the rectangle is the stroke's worst case.
 */
function resendSculptFootprint(
  world: World,
  x: number,
  y: number,
  radius: number,
  options?: SculptOptions,
  toPlayerIds?: readonly string[],
): void {
  const reach = faultedSculptReachCells(radius, options);
  const sweepFrom = options?.sweepFrom ?? null;
  const fromX = sweepFrom?.x ?? x;
  const fromY = sweepFrom?.y ?? y;

  const edge = chunksPerEdge(world.size);
  const first = clampChunk(chunkOfCell(Math.min(x, fromX) - reach) - MESH_SEAM_HALO_CHUNKS, edge);
  const last = clampChunk(chunkOfCell(Math.max(x, fromX) + reach) + MESH_SEAM_HALO_CHUNKS, edge);
  const firstRow = clampChunk(chunkOfCell(Math.min(y, fromY) - reach) - MESH_SEAM_HALO_CHUNKS, edge);
  const lastRow = clampChunk(chunkOfCell(Math.max(y, fromY) + reach) + MESH_SEAM_HALO_CHUNKS, edge);

  const keys: number[] = [];
  for (let cy = firstRow; cy <= lastRow; cy++) {
    for (let cx = first; cx <= last; cx++) keys.push(cy * edge + cx);
  }
  sendChunkResync(world, keys, edge, toPlayerIds);
}

/**
 * How far past the brush a stroke could have written when nothing measured it.
 * Only smooth and settle relax; shared/ states both bounds.
 */
function faultedSculptReachCells(radius: number, options?: SculptOptions): number {
  const tool = options?.tool ?? WIRE_DEFAULT_SCULPT_OPTIONS.tool;
  const profile = options?.profile ?? WIRE_DEFAULT_SCULPT_OPTIONS.profile;
  const anchor = options?.anchor ?? WIRE_DEFAULT_SCULPT_OPTIONS.anchor;
  return sculptReachCells(radius, profile, tool, anchor);
}

/** Sends each named chunk to every player in the audience who can see it. */
function sendChunkResync(
  world: World,
  chunkKeys: readonly number[],
  edge: number,
  toPlayerIds?: readonly string[],
): void {
  const audience = toPlayerIds ?? world.players().map((player) => player.id);
  const chunksByPlayer = new Map<string, ChunkPayload[]>();
  for (const playerId of audience) chunksByPlayer.set(playerId, []);

  for (const key of chunkKeys) {
    const cx = key % edge;
    const cy = (key - cx) / edge;
    let payload: ChunkPayload | null = null;
    for (const [playerId, chunks] of chunksByPlayer) {
      if (!world.isChunkVisibleTo(playerId, cx, cy)) continue;
      payload ??= chunkPayloadOf(world, cx, cy);
      chunks.push(payload);
    }
  }

  for (const [playerId, chunks] of chunksByPlayer) {
    if (chunks.length === 0) continue;
    try {
      world.sendTo(playerId, { type: 'chunkUnlock', chunks });
    } catch (error) {
      noteDiffSendFailure(error);
    }
  }
}

export function resendIntentFootprint(world: World, intent: SculptIntent): void {
  resendSculptFootprint(world, intent.x, intent.y, intent.radius, sculptOptionsOf(intent));
}

function chunkOfCell(cell: number): number {
  return Math.floor(cell / CHUNK_SIZE);
}

function clampChunk(index: number, edge: number): number {
  if (index < 0) return 0;
  return index > edge - 1 ? edge - 1 : index;
}
