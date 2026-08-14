// Contract tests for camera-pose persistence (render/cameraPose.ts).
//
// The module is deliberately three.js-free, so all of this runs in the plain
// node environment with no GL and no DOM (design doc §8 "Testing"); only
// localStorage is stubbed, exactly as the control-prefs tests do.
//
// What is under test is the guarantee scene.ts leans on: a stored pose is a
// HINT, and every way it can be wrong resolves to null — meaning "frame the
// world from scratch" — rather than to a camera pointed at nothing.

import { afterEach, describe, expect, it } from 'vitest';
import {
  CAMERA_POSE_FORMAT_VERSION,
  CAMERA_POSE_KEY_PREFIX,
  cameraPoseStorageKey,
  loadCameraPose,
  parseCameraPose,
  saveCameraPose,
  serialiseCameraPose,
  type CameraPose,
} from '../src/render/cameraPose.ts';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  CELL_WORLD_SIZE,
} from '../src/config.ts';

const WORLD = 64;
/** Highest cell coordinate in a WORLD-cell world, in world units. */
const WORLD_MAX_COORD = (WORLD - 1) * CELL_WORLD_SIZE;
const CENTRE = WORLD_MAX_COORD / 2;

/** Minimal in-memory localStorage, installed on globalThis per test. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function installStorage(storage: Storage | undefined): void {
  (globalThis as { localStorage?: Storage }).localStorage = storage as Storage;
}

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

/**
 * A pose looking at the middle of the world from `distance` away, along a
 * diagonal so all six components are distinct (a pose that happened to be
 * axis-aligned could hide a transposed component).
 */
function poseAtDistance(distance: number): CameraPose {
  const leg = distance / Math.sqrt(3);
  return {
    target: { x: CENTRE, y: 0, z: CENTRE },
    position: { x: CENTRE + leg, y: leg, z: CENTRE + leg },
  };
}

/** Serialised payload with one field overridden or removed. */
function payload(overrides: Record<string, unknown>): string {
  const pose = poseAtDistance(CAMERA_MIN_DISTANCE + 1);
  return JSON.stringify({
    version: CAMERA_POSE_FORMAT_VERSION,
    target: pose.target,
    position: pose.position,
    ...overrides,
  });
}

describe('cameraPoseStorageKey', () => {
  it('namespaces and versions the key', () => {
    expect(cameraPoseStorageKey('ws://localhost:2567', WORLD)).toBe(
      `${CAMERA_POSE_KEY_PREFIX}:ws://localhost:2567:${WORLD}`,
    );
  });

  it('separates two servers', () => {
    expect(cameraPoseStorageKey('ws://localhost:2567', WORLD)).not.toBe(
      cameraPoseStorageKey('ws://192.168.1.10:2567', WORLD),
    );
  });

  it('separates two world sizes on the same server', () => {
    const url = 'ws://localhost:2567';
    expect(cameraPoseStorageKey(url, 64)).not.toBe(
      cameraPoseStorageKey(url, 512),
    );
  });
});

describe('round trip', () => {
  it('restores all six components exactly', () => {
    const pose: CameraPose = {
      target: { x: 12.5, y: -1.25, z: 44.75 },
      position: { x: 30.125, y: 22.5, z: 60.0625 },
    };
    const parsed = parseCameraPose(serialiseCameraPose(pose), WORLD);
    expect(parsed).toEqual(pose);
  });

  it('accepts the exact zoom-band endpoints', () => {
    for (const distance of [CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE]) {
      const raw = serialiseCameraPose(poseAtDistance(distance));
      expect(parseCameraPose(raw, WORLD)).not.toBeNull();
    }
  });

  it('accepts a target panned just off the map edge', () => {
    const pose: CameraPose = {
      target: { x: WORLD_MAX_COORD + 1, y: 0, z: -1 },
      position: { x: WORLD_MAX_COORD + 1, y: CAMERA_MIN_DISTANCE, z: -1 },
    };
    expect(parseCameraPose(serialiseCameraPose(pose), WORLD)).not.toBeNull();
  });
});

describe('validation rejects', () => {
  it('a missing entry', () => {
    expect(parseCameraPose(null, WORLD)).toBeNull();
  });

  it('junk JSON', () => {
    expect(parseCameraPose('{not json', WORLD)).toBeNull();
    expect(parseCameraPose('', WORLD)).toBeNull();
  });

  it('a non-object payload', () => {
    expect(parseCameraPose('42', WORLD)).toBeNull();
    expect(parseCameraPose('null', WORLD)).toBeNull();
    expect(parseCameraPose('[1,2,3]', WORLD)).toBeNull();
  });

  it('another schema version', () => {
    expect(parseCameraPose(payload({ version: 2 }), WORLD)).toBeNull();
    expect(parseCameraPose(payload({ version: undefined }), WORLD)).toBeNull();
  });

  it('a missing vector', () => {
    expect(parseCameraPose(payload({ position: undefined }), WORLD)).toBeNull();
    expect(parseCameraPose(payload({ target: undefined }), WORLD)).toBeNull();
  });

  it('a missing component', () => {
    expect(
      parseCameraPose(payload({ target: { x: CENTRE, z: CENTRE } }), WORLD),
    ).toBeNull();
  });

  it('a non-numeric component', () => {
    expect(
      parseCameraPose(
        payload({ target: { x: CENTRE, y: '0', z: CENTRE } }),
        WORLD,
      ),
    ).toBeNull();
  });

  it('NaN and Infinity (which JSON.stringify writes as null)', () => {
    const nan = JSON.stringify({
      version: CAMERA_POSE_FORMAT_VERSION,
      target: { x: CENTRE, y: Number.NaN, z: CENTRE },
      position: { x: CENTRE, y: CAMERA_MIN_DISTANCE, z: CENTRE },
    });
    expect(parseCameraPose(nan, WORLD)).toBeNull();
    expect(
      parseCameraPose(
        payload({ position: { x: CENTRE, y: Infinity, z: CENTRE } }),
        WORLD,
      ),
    ).toBeNull();
  });

  it('a distance below the zoom band', () => {
    const raw = serialiseCameraPose(poseAtDistance(CAMERA_MIN_DISTANCE - 1));
    expect(parseCameraPose(raw, WORLD)).toBeNull();
  });

  it('a distance above the zoom band', () => {
    const raw = serialiseCameraPose(poseAtDistance(CAMERA_MAX_DISTANCE + 1));
    expect(parseCameraPose(raw, WORLD)).toBeNull();
  });

  it('a degenerate pose with the camera on its own target', () => {
    const at = { x: CENTRE, y: 0, z: CENTRE };
    const raw = serialiseCameraPose({ target: at, position: at });
    expect(parseCameraPose(raw, WORLD)).toBeNull();
  });

  it('a target far outside the world on X or Z', () => {
    const far = 1e6;
    for (const target of [
      { x: far, y: 0, z: CENTRE },
      { x: CENTRE, y: 0, z: -far },
    ]) {
      const raw = serialiseCameraPose({
        target,
        position: { x: target.x, y: CAMERA_MIN_DISTANCE, z: target.z },
      });
      expect(parseCameraPose(raw, WORLD)).toBeNull();
    }
  });

  it('a target far above or below any terrain', () => {
    for (const y of [1000, -1000]) {
      const raw = serialiseCameraPose({
        target: { x: CENTRE, y, z: CENTRE },
        position: { x: CENTRE, y: y + CAMERA_MIN_DISTANCE, z: CENTRE },
      });
      expect(parseCameraPose(raw, WORLD)).toBeNull();
    }
  });

  it('a pose saved for a LARGER world than the one now joined', () => {
    // Same server rebuilt smaller: the old centre is off the new map. Keys
    // differ too, so this is the second line of defence, not the first.
    const raw = serialiseCameraPose(poseAtDistance(CAMERA_MIN_DISTANCE + 1));
    expect(parseCameraPose(raw, WORLD)).not.toBeNull();
    expect(parseCameraPose(raw, 8)).toBeNull();
  });

  it('a nonsensical world size', () => {
    const raw = serialiseCameraPose(poseAtDistance(CAMERA_MIN_DISTANCE + 1));
    for (const size of [0, -64, 1.5, Number.NaN]) {
      expect(parseCameraPose(raw, size)).toBeNull();
    }
  });
});

describe('storage', () => {
  it('saves and reloads a pose under its key', () => {
    installStorage(fakeStorage());
    const key = cameraPoseStorageKey('ws://localhost:2567', WORLD);
    const pose = poseAtDistance(CAMERA_MIN_DISTANCE + 5);
    saveCameraPose(key, pose);
    expect(loadCameraPose(key, WORLD)).toEqual(pose);
  });

  it('does not read another world identity\'s pose', () => {
    installStorage(fakeStorage());
    const pose = poseAtDistance(CAMERA_MIN_DISTANCE + 5);
    saveCameraPose(cameraPoseStorageKey('ws://a:2567', WORLD), pose);
    expect(
      loadCameraPose(cameraPoseStorageKey('ws://b:2567', WORLD), WORLD),
    ).toBeNull();
  });

  it('falls back to default framing on a corrupted entry', () => {
    const key = cameraPoseStorageKey('ws://localhost:2567', WORLD);
    installStorage(fakeStorage({ [key]: '{"version":1,"target":' }));
    // null is scene.ts's signal to run focusWorld instead — the fallback.
    expect(loadCameraPose(key, WORLD)).toBeNull();
  });

  it('survives storage being unavailable entirely', () => {
    installStorage(undefined);
    const key = cameraPoseStorageKey('ws://localhost:2567', WORLD);
    expect(loadCameraPose(key, WORLD)).toBeNull();
    expect(() =>
      saveCameraPose(key, poseAtDistance(CAMERA_MIN_DISTANCE + 5)),
    ).not.toThrow();
  });

  it('survives a storage that throws on write (quota, private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    installStorage(throwing);
    const key = cameraPoseStorageKey('ws://localhost:2567', WORLD);
    expect(loadCameraPose(key, WORLD)).toBeNull();
    expect(() =>
      saveCameraPose(key, poseAtDistance(CAMERA_MIN_DISTANCE + 5)),
    ).not.toThrow();
  });
});
