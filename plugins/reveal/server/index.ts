import {
  CHUNK_SIZE,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  chunksWithinSweep,
  revealReachCells,
  strokeSweep,
  strokeWriteSweep,
  type CellDiff,
  type SculptIntent,
} from '@terrace/shared';
import type { IntentCtx, TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';

/** Before application, bounds every possible unlock; afterwards, names the reach and changed chunks. */
export function sculptUnlockChunks(worldSize: number, intent: SculptIntent, diff?: readonly CellDiff[]): number[] {
  const core = strokeSweep(intent);
  const chunks = new Set(chunksWithinSweep(worldSize, core, revealReachCells(core.radius)));
  if (diff === undefined) {
    const writes = strokeWriteSweep(intent);
    for (const chunk of chunksWithinSweep(worldSize, writes, writes.radius)) chunks.add(chunk);
  } else {
    for (const cell of diff) chunks.add(chunkIndexOfCell(worldSize, cell.x, cell.y));
  }
  return [...chunks].sort((a, b) => a - b);
}

function creepForSculptor(
  world: WorldApi,
  diff: readonly CellDiff[],
  sculptorToken: string,
): void {
  const worldSize = world.worldSize;
  const touchedChunks = new Set<number>();

  for (const cell of diff) {
    const cx = Math.floor(cell.x / CHUNK_SIZE);
    const cy = Math.floor(cell.y / CHUNK_SIZE);
    const index = chunkIndex(worldSize, cx, cy);
    if (touchedChunks.has(index)) continue;
    touchedChunks.add(index);

    world.unlockChunkForToken(sculptorToken, cx, cy);
  }
}

function openReach(world: WorldApi, intent: SculptIntent, token: string): void {
  const cols = chunksPerEdge(world.worldSize);
  for (const index of sculptUnlockChunks(world.worldSize, intent, [])) {
    world.unlockChunkForToken(token, index % cols, Math.floor(index / cols));
  }
}

export const plugin: TerracePlugin = {
  name: 'reveal',

  onIntentApplied(intent: SculptIntent, ctx: IntentCtx): void {
    openReach(ctx.world, intent, ctx.player.token);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[], sculptorToken?: string): void {
    if (sculptorToken === undefined) return;
    creepForSculptor(world, diff, sculptorToken);
  },
};
