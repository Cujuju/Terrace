// Camera-pose persistence: the pure logic behind "reload and you are looking
// at exactly what you were looking at".
//
// Deliberately free of three.js: everything here is plain numbers and JSON, so
// it is node-testable without a GL context. render/scene.ts owns the only
// bridge between these plain vectors and the live Vector3s.
//
// WHAT IS STORED, AND WHY THAT PAIR: the orbit target plus the camera
// position. Azimuth, polar angle and distance are all derivable from those six
// numbers, so the pair reproduces the view exactly with no trigonometry to get
// wrong in either direction — and it is exactly what OrbitControls itself
// keeps (`controls.target` + `camera.position`).
//
// A stored pose is only ever a hint. Anything about it that fails validation
// falls back to the default framing: a corrupt entry must never be able to
// leave the player staring at a black screen with no way back.

import { CHUNK_SIZE, MAX_HEIGHT, MIN_HEIGHT } from '@terrace/shared';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
} from '../config.ts';

/** Plain-data stand-in for three's Vector3; no three import needed. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A complete orbit pose: what the camera looks at, and from where. */
export interface CameraPose {
  readonly target: Vec3Like;
  readonly position: Vec3Like;
}

/**
 * Key namespace and schema version. The version is in the KEY (not only in the
 * payload) so that a future schema change orphans the old entries instead of
 * having to migrate them — an orphaned pose costs one default framing.
 */
export const CAMERA_POSE_KEY_PREFIX = 'terrace.cameraPose.v1';

/**
 * Version stamped inside the payload as well. Belt and suspenders: the key
 * guards against a schema change, this guards against an entry written under
 * the right key by anything else (a hand-edited value, a future branch).
 */
export const CAMERA_POSE_FORMAT_VERSION = 1;

/**
 * Milliseconds between pose saves while the camera is moving continuously.
 *
 * Wheel zoom, trackpad pan and damping decay all stream OrbitControls 'change'
 * events with no 'end' to bracket them, so 'end' alone would miss them
 * entirely; saving per event would mean a localStorage write per frame. 400 ms
 * is far longer than a frame (so writes stay rare) and far shorter than the
 * gap between "stop moving the camera" and "hit reload" (so the saved pose is
 * the one on screen).
 */
export const CAMERA_POSE_SAVE_DEBOUNCE_MS = 400;

/**
 * How far outside the terrain's own extent a saved target may sit and still be
 * restored, in world units. Panning until the target leaves the map while
 * looking back at the coast is normal, so the box cannot be tight to the
 * terrain; one chunk of slack allows that while still rejecting the
 * wildly-out-of-range coordinates that corruption produces.
 */
const CAMERA_POSE_TARGET_MARGIN = CHUNK_SIZE * CELL_WORLD_SIZE;

/**
 * Slack, in world units, on the orbit-distance band check. The distance we
 * store is one OrbitControls has already clamped into
 * [CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE], but it is recovered here by a
 * `sqrt` of the stored components rather than read back as a radius, so it can
 * land a few floating-point ulps outside the band. 1e-6 is orders of magnitude
 * above that round-off and a millionth of a cell — invisible either way.
 */
const CAMERA_POSE_DISTANCE_TOLERANCE = 1e-6;

/** Highest/lowest world-space Y any terrain vertex can reach. */
const TERRAIN_MAX_WORLD_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE;
const TERRAIN_MIN_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE;

/**
 * Storage key for one world identity.
 *
 * Both parts matter. Two servers are two different worlds, and the same server
 * rebuilt at a different size is also a different world — a pose from either
 * would frame the wrong terrain (or nothing at all), so neither may inherit
 * the other's entry.
 */
export function cameraPoseStorageKey(
  serverUrl: string,
  worldSize: number,
): string {
  return `${CAMERA_POSE_KEY_PREFIX}:${serverUrl}:${worldSize}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Accepts only an object carrying three finite numeric components. */
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

/**
 * True when the orbit target is somewhere that could plausibly be looked at in
 * a world of this size: inside the terrain footprint (plus a margin) on X/Z,
 * and inside the height range terrain can occupy (plus the same margin) on Y.
 */
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

/** The payload actually written to storage. */
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

/**
 * Parses and validates a stored pose against a world of `worldSize` cells.
 * Returns null — meaning "frame the world from scratch" — for anything that is
 * not a complete, in-range pose:
 *
 * - unreadable JSON, or a non-object;
 * - a payload from another schema version;
 * - a missing or non-finite component (NaN and Infinity included);
 * - an orbit distance outside the zoom band the controls enforce;
 * - a target outside the world (plus CAMERA_POSE_TARGET_MARGIN);
 * - a nonsensical world size, which would make those bounds meaningless.
 */
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

/**
 * Reads the pose stored under `key`, or null if there is none, it is invalid,
 * or storage is unavailable (private mode, disabled cookies — the session then
 * simply runs without pose memory).
 */
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

/** Best-effort write; a full or unavailable storage costs only the memory. */
export function saveCameraPose(key: string, pose: CameraPose): void {
  try {
    localStorage.setItem(key, serialiseCameraPose(pose));
  } catch {
    // Ignored: the live camera is unaffected, only the next reload is.
  }
}
