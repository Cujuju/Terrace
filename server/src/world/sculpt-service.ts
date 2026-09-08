import type { CellDiff, SculptOptions } from '@terrace/shared';
import { timePhase } from '../tick-timing.ts';
import { partitionDiffByViewer } from './mask-filter.ts';
import type { World } from './world.ts';

export interface TerrainChangeListener {
  notifyTerrainChanged(diff: readonly CellDiff[], sculptorToken?: string): void;
}

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
    for (const { playerId, cells } of partitionDiffByViewer(world, diff)) {
      world.sendTo(playerId, { type: 'terrainDiff', cells });
    }
  });

  timePhase('sculpt.listeners', () => {
    listener.notifyTerrainChanged(diff, sculptorToken);
  });
  return diff;
}
