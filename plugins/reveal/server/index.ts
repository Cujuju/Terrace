import {
  CHUNK_SIZE,
  chunkIndex,
  chunksPerEdge,
  revealChunkIndices,
  type CellDiff,
  type SculptIntent,
} from '@terrace/shared';
import type { IntentCtx, TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';

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
  for (const index of revealChunkIndices(
    world.worldSize,
    intent.x,
    intent.y,
    intent.radius,
  )) {
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
