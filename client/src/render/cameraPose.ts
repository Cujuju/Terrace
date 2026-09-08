import { MAX_HEIGHT, MIN_HEIGHT, NEIGHBOURHOOD_CELLS } from '@terrace/shared';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
} from '../config.ts';
import { isFiniteNumber } from '@terrace/shared';

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CameraPose {
  readonly target: Vec3Like;
  readonly position: Vec3Like;
}

export const CAMERA_POSE_KEY_PREFIX = 'terrace.cameraPose.v1';

export const CAMERA_POSE_FORMAT_VERSION = 1;

export const CAMERA_POSE_SAVE_DEBOUNCE_MS = 400;

const CAMERA_POSE_TARGET_MARGIN = NEIGHBOURHOOD_CELLS * CELL_WORLD_SIZE;

const CAMERA_POSE_DISTANCE_TOLERANCE = 1e-6;

const TERRAIN_MAX_WORLD_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE;
const TERRAIN_MIN_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE;

export function cameraPoseStorageKey(
  serverUrl: string,
  worldSize: number,
): string {
  return `${CAMERA_POSE_KEY_PREFIX}:${serverUrl}:${worldSize}`;
}

function readVec3(value: unknown): Vec3Like | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y) || !isFiniteNumber(v.z)) {
    return null;
  }
  return { x: v.x, y: v.y, z: v.z };
}

function distanceBetween(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function targetIsInWorld(target: Vec3Like, worldSize: number): boolean {
  const maxCoord = (worldSize - 1) * CELL_WORLD_SIZE + CAMERA_POSE_TARGET_MARGIN;
  const minCoord = -CAMERA_POSE_TARGET_MARGIN;
  if (target.x < minCoord || target.x > maxCoord) return false;
  if (target.z < minCoord || target.z > maxCoord) return false;
  return (
    target.y >= TERRAIN_MIN_WORLD_Y - CAMERA_POSE_TARGET_MARGIN &&
    target.y <= TERRAIN_MAX_WORLD_Y + CAMERA_POSE_TARGET_MARGIN
  );
}

export function serialiseCameraPose(pose: CameraPose): string {
  return JSON.stringify({
    version: CAMERA_POSE_FORMAT_VERSION,
    target: { x: pose.target.x, y: pose.target.y, z: pose.target.z },
    position: {
      x: pose.position.x,
      y: pose.position.y,
      z: pose.position.z,
    },
  });
}

export function parseCameraPose(
  raw: string | null,
  worldSize: number,
): CameraPose | null {
  if (raw === null) return null;
  if (!Number.isInteger(worldSize) || worldSize <= 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as {
    version?: unknown;
    target?: unknown;
    position?: unknown;
  };
  if (record.version !== CAMERA_POSE_FORMAT_VERSION) return null;

  const target = readVec3(record.target);
  const position = readVec3(record.position);
  if (target === null || position === null) return null;

  const distance = distanceBetween(position, target);
  if (
    distance < CAMERA_MIN_DISTANCE - CAMERA_POSE_DISTANCE_TOLERANCE ||
    distance > CAMERA_MAX_DISTANCE + CAMERA_POSE_DISTANCE_TOLERANCE
  ) {
    return null;
  }

  if (!targetIsInWorld(target, worldSize)) return null;

  return { target, position };
}

export function loadCameraPose(
  key: string,
  worldSize: number,
): CameraPose | null {
  try {
    return parseCameraPose(localStorage.getItem(key), worldSize);
  } catch {
    return null;
  }
}

export function saveCameraPose(key: string, pose: CameraPose): void {
  try {
    localStorage.setItem(key, serialiseCameraPose(pose));
  } catch {
  }
}
