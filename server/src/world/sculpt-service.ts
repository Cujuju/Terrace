import {
  CHUNK_SIZE,
  chunksPerEdge,
  sculptOptionsOf,
  sculptSweepRadius,
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

/** Relaxation can nudge cells just outside the footprint, so the resync overshoots by a chunk. */
const SCULPT_FAULT_RESYNC_HALO_CELLS = CHUNK_SIZE;

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
    broadcastDiff(world, diff, x, y, radius, options);
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
function broadcastDiff(
  world: World,
  diff: readonly CellDiff[],
  x: number,
  y: number,
  radius: number,
  options?: SculptOptions,
): void {
  let shares: ViewerDiff[];
  try {
    shares = partitionDiffByViewer(world, diff);
  } catch (error) {
    noteDiffSendFailure(error);
    resendSculptFootprint(world, x, y, radius, options);
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
    resendSculptFootprint(world, x, y, radius, options, stranded);
  }
}

function noteDiffSendFailure(error: unknown): void {
  throttledLog(diffSendLog, () => {
    logError('a terrain diff could not be delivered; resending the authoritative chunks', error);
  });
}

/**
 * Re-sends the authoritative heights of every chunk a sculpt could have edited,
 * so a half-applied or undelivered edit cannot leave a viewer diverged.
 */
export function resendSculptFootprint(
  world: World,
  x: number,
  y: number,
  radius: number,
  options?: SculptOptions,
  toPlayerIds?: readonly string[],
): void {
  const tool = options?.tool ?? WIRE_DEFAULT_SCULPT_OPTIONS.tool;
  const profile = options?.profile ?? WIRE_DEFAULT_SCULPT_OPTIONS.profile;
  const anchor = options?.anchor ?? WIRE_DEFAULT_SCULPT_OPTIONS.anchor;
  const sweepFrom = options?.sweepFrom ?? null;
  const reach =
    (tool === 'stamp' ? sculptSweepRadius(radius, profile, tool, anchor) : radius) +
    SCULPT_FAULT_RESYNC_HALO_CELLS;

  const fromX = sweepFrom?.x ?? x;
  const fromY = sweepFrom?.y ?? y;
  const edge = chunksPerEdge(world.size);
  const first = chunkOfCell(Math.min(x, fromX) - reach, edge);
  const last = chunkOfCell(Math.max(x, fromX) + reach, edge);
  const firstRow = chunkOfCell(Math.min(y, fromY) - reach, edge);
  const lastRow = chunkOfCell(Math.max(y, fromY) + reach, edge);

  const audience =
    toPlayerIds ?? world.players().map((player) => player.id);
  const chunksByPlayer = new Map<string, ChunkPayload[]>();
  for (const playerId of audience) chunksByPlayer.set(playerId, []);

  for (let cy = firstRow; cy <= lastRow; cy++) {
    for (let cx = first; cx <= last; cx++) {
      let payload: ChunkPayload | null = null;
      for (const [playerId, chunks] of chunksByPlayer) {
        if (!world.isChunkVisibleTo(playerId, cx, cy)) continue;
        payload ??= chunkPayloadOf(world, cx, cy);
        chunks.push(payload);
      }
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

function chunkOfCell(cell: number, edge: number): number {
  const index = Math.floor(cell / CHUNK_SIZE);
  if (index < 0) return 0;
  return index > edge - 1 ? edge - 1 : index;
}
