import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { SculptProfile, SculptTool } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import {
  cellGridSegments,
  markOutline,
  oneClickMark,
  skirtDropWorldUnits,
} from './footprintMark.ts';

export interface BrushGeometry {
  readonly ring: BufferGeometry;
  readonly skirt: BufferGeometry;
  readonly cellGrid: BufferGeometry;
}

export function brushGeometry(radius: number, tool: SculptTool, profile: SculptProfile): BrushGeometry {
  const mark = oneClickMark(radius, tool, profile);
  const outline = markOutline(radius, mark);
  const drop = skirtDropWorldUnits(mark);

  // Closed by repeating the first point: WebGPURenderer draws Line, not LineLoop.
  const ringPositions: number[] = [];
  for (const point of [...outline, outline[0]!]) {
    ringPositions.push(point.x * CELL_WORLD_SIZE, 0, point.z * CELL_WORLD_SIZE);
  }
  const ring = new BufferGeometry();
  ring.setAttribute('position', new Float32BufferAttribute(ringPositions, 3));

  const skirtPositions: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const ax = a.x * CELL_WORLD_SIZE;
    const az = a.z * CELL_WORLD_SIZE;
    const bx = b.x * CELL_WORLD_SIZE;
    const bz = b.z * CELL_WORLD_SIZE;
    skirtPositions.push(
      ax, 0, az, bx, 0, bz, bx, -drop, bz,
      ax, 0, az, bx, -drop, bz, ax, -drop, az,
    );
  }
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new Float32BufferAttribute(skirtPositions, 3));

  const gridPositions: number[] = [];
  const flat = cellGridSegments(mark);
  for (let i = 0; i < flat.length; i += 2) {
    gridPositions.push(flat[i]! * CELL_WORLD_SIZE, 0, flat[i + 1]! * CELL_WORLD_SIZE);
  }
  const cellGrid = new BufferGeometry();
  cellGrid.setAttribute('position', new Float32BufferAttribute(gridPositions, 3));

  return { ring, skirt, cellGrid };
}
