import { BAND_HEIGHT } from '@terrace/shared';
import { HEIGHT_WORLD_SCALE } from '../../config.ts';
import {
  pointerToNdc,
  worldPointToCell,
  type TerrainRayPick,
} from '../../terrain/picking.ts';
import type { PointerRay, StrokeState } from './strokeState.ts';

export const pointerRay = (s: StrokeState): PointerRay | null => {
  const size = s.options.worldSize();
  if (size <= 0 || !s.havePointer) return null;

  const rect = s.options.canvas.getBoundingClientRect();
  const device = pointerToNdc(s.pointerClientX, s.pointerClientY, rect);
  if (device === null) return null;

  s.ndc.set(device.x, device.y);
  s.raycaster.setFromCamera(s.ndc, s.options.camera);
  const o = s.raycaster.ray.origin;
  const d = s.raycaster.ray.direction;
  return {
    origin: { x: o.x, y: o.y, z: o.z },
    direction: { x: d.x, y: d.y, z: d.z },
  };
};

const MIN_DRAG_PLANE_DESCENT = 0.05;

export const dragPlaneCell = (
  s: StrokeState,
  band: number,
): { x: number; y: number } | null => {
  const size = s.options.worldSize();
  const ray = pointerRay(s);
  if (size <= 0 || ray === null) return null;
  const { origin, direction } = ray;
  const planeY = band * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
  if (direction.y > -MIN_DRAG_PLANE_DESCENT) return null;
  const distance = (planeY - origin.y) / direction.y;
  if (!Number.isFinite(distance) || distance <= 0) return null;

  const worldX = origin.x + direction.x * distance;
  const worldZ = origin.z + direction.z * distance;
  return worldPointToCell(worldX, worldZ, size);
};

export const repick = (s: StrokeState): TerrainRayPick | null => {
  s.hoverPin++;
  const ray = pointerRay(s);
  s.hoverRay = ray;
  if (ray === null) {
    s.hoverCell = null;
    return null;
  }
  const pick = s.options.pickCell(ray.origin, ray.direction);
  s.hoverCell = pick === null ? null : { x: pick.x, y: pick.y };
  return pick;
};

export const hoverTarget = (s: StrokeState): TerrainRayPick | null => {
  const p = s.options.camera.position;
  const q = s.options.camera.quaternion;
  const key = s.havePointer
    ? `${s.pointerClientX},${s.pointerClientY},${s.options.worldSize()},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`
    : 'away';
  if (key !== s.hoverKey) {
    s.hoverKey = key;
    return repick(s);
  }
  if (s.hoverCell === null || s.hoverRay === null) return repick(s);
  const pick = s.options.pickInColumn(
    s.hoverCell.x,
    s.hoverCell.y,
    s.hoverRay.origin,
    s.hoverRay.direction,
  );
  if (pick === null) return repick(s);
  return pick;
};
