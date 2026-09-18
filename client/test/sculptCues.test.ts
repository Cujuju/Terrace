import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  BAND_HEIGHT,
  BEDROCK_BAND,
  bandLevelHeight,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  MAX_DRAG_SWEEP_CELLS,
  applySculpt,
  cellIndex,
  chebyshevDistance,
  sculptOptionsOf,
  setColumn,
  spanAt,
  type ChunkPayload,
  type JoinSnapshotMessage,
  type SculptIntent,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, TOUCH_STROKE_GRACE_MS } from '../src/config.ts';
import {
  REFUSED_PULSE_MS,
  SILENT_REPEAT_BLINK_AFTER,
  createSculptInput,
  repeatDelayMs,
  type SculptInput,
  type SendOutcome,
} from '../src/input/sculptInput.ts';
import { applySnapshot, createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';
import { bandAtCellIn, graspSpanBandIn } from '../src/terrain/pickBand.ts';
import { createPredictionStore } from '../src/terrain/prediction.ts';
import {
  CUE_BLINK_ON_MS,
  DENIED_BLINK_SETTLE_MS,
  createDenialCue,
  type DenialCue,
} from '../src/render/denialCue.ts';
import {
  pickTerrainCellByRay,
  pickTerrainInColumn,
  type PickFace,
  type TerrainRayPick,
  type Vec3,
} from '../src/terrain/picking.ts';
import {
  brushRadius,
  brushTool,
  effectiveSculptMode,
  sculptMode,
  setBrushRadius,
  setBrushTool,
  setSculptChord,
  setSculptMode,
} from '../src/state/hudState.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 600;
const CENTRE_X = VIEW_WIDTH / 2;
const CENTRE_Y = VIEW_HEIGHT / 2;

const UNDERSIDE_PICK: TerrainRayPick = {
  x: 30,
  y: 30,
  surfaceY: 0,
  spanIndex: 0,
  face: 'underside',
  hitY: 0,
  hitX: 30 * CELL_WORLD_SIZE,
  hitZ: 30 * CELL_WORLD_SIZE,
};

function flatWorld(): TerrainMirror {
  const mirror = createTerrainMirror(WORLD);
  const perEdge = WORLD / CHUNK_SIZE;
  const chunks: ChunkPayload[] = [];
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      chunks.push({ cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(0) });
    }
  }
  applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks } as JoinSnapshotMessage);
  return mirror;
}

interface DriveKnobs {
  send?: (intent: SculptIntent) => SendOutcome;
  attempts?: SculptIntent[];
  pickCell?: (origin: Vec3, direction: Vec3) => TerrainRayPick | null;
  pickInColumn?: (x: number, y: number, origin: Vec3, direction: Vec3) => TerrainRayPick | null;
  riserBand?: (pick: TerrainRayPick | null) => number | null;
  bandAtCell?: (x: number, y: number, spanBand: number | null) => number | null;
  runFloorBandAt?: (x: number, y: number, band: number) => number | null;
  graspSpanBand?: (pick: TerrainRayPick | null, atX: number, atY: number) => number | null;
  origin?: Vec3;
  lookAt?: Vec3;
}

function driveInput(mirror: TerrainMirror, knobs: DriveKnobs = {}): {
  input: SculptInput;
  attempts: SculptIntent[];
  fire: (type: string, event?: Partial<PointerEvent> & { clientX?: number; clientY?: number }) => void;
  dispose: () => void;
} {
  const handlers = new Map<string, (event: Event) => void>();
  const listen = (type: string, fn: (event: Event) => void): void => {
    handlers.set(type, fn);
  };
  const canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: VIEW_WIDTH,
      height: VIEW_HEIGHT,
    }),
    addEventListener: listen,
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;

  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    addEventListener: listen,
    removeEventListener: () => {},
  };

  const camera = new PerspectiveCamera(60, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 5000);
  const origin = knobs.origin ?? {
    x: 30 * CELL_WORLD_SIZE,
    y: 20 * BAND_HEIGHT * HEIGHT_WORLD_SCALE,
    z: 30 * CELL_WORLD_SIZE,
  };
  const lookAt = knobs.lookAt ?? { x: 30 * CELL_WORLD_SIZE, y: 0, z: 30 * CELL_WORLD_SIZE };
  camera.position.set(origin.x, origin.y, origin.z);
  camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
  camera.updateMatrixWorld(true);

  const attempts = knobs.attempts ?? [];
  const send = knobs.send ?? (() => 'sent');
  const input = createSculptInput({
    canvas,
    camera,
    pickCell: knobs.pickCell ?? ((o, d) => pickTerrainCellByRay(mirror, o, d)),
    pickInColumn: knobs.pickInColumn ?? ((x, y, o, d) => pickTerrainInColumn(mirror, x, y, o, d)),
    worldSize: () => mirror.map.size,
    riserBand: knobs.riserBand ?? (() => null),
    bandAtCell: knobs.bandAtCell ?? (() => null),
    runFloorBandAt: knobs.runFloorBandAt ?? (() => null),
    graspSpanBand: knobs.graspSpanBand ?? (() => null),
    carveBand: () => null,
    carveReach: () => null,
    send: (intent) => {
      attempts.push(intent);
      return send(intent);
    },
  });

  handlers.get('pointermove')?.({
    clientX: CENTRE_X,
    clientY: CENTRE_Y,
    pointerId: 1,
    pointerType: 'mouse',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  } as unknown as Event);

  const fire = (
    type: string,
    event: Partial<PointerEvent> & { clientX?: number; clientY?: number } = {},
  ): void => {
    handlers.get(type)?.({
      clientX: CENTRE_X,
      clientY: CENTRE_Y,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
      ...event,
    } as unknown as Event);
  };

  return {
    input,
    attempts,
    fire,
    dispose: () => {
      input.dispose();
      (globalThis as { window?: unknown }).window = previousWindow;
    },
  };
}

function restoreHud(tool: ReturnType<typeof brushTool>, radius: number): void {
  setBrushTool(tool);
  setBrushRadius(radius);
}

const bandY = (bands: number): number => bands * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
const cellW = (cells: number): number => cells * CELL_WORLD_SIZE;

describe('offline cue (grey/hollow, never red)', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('a press that never leaves latches offline, blinks once, and gates the repeat', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, { send: () => 'offline' });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      expect(input.offlineHold()).toBe(true);
      expect(input.offlineBlinks()).toBe(1);
      expect(input.flatBlinks()).toBe(0);
      expect(input.refusedHold()).toBe(false);

      vi.advanceTimersByTime(repeatDelayMs(0) + repeatDelayMs(1) + repeatDelayMs(2));
      expect(attempts).toHaveLength(1);
      expect(input.offlineBlinks()).toBe(1);
    } finally {
      dispose();
    }
  });

  it('pointerup releases the offline latch', () => {
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror, { send: () => 'offline' });
    try {
      fire('pointerdown', {});
      expect(input.offlineHold()).toBe(true);
      fire('pointerup', {});
      expect(input.offlineHold()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('a local plugin veto ends the emit red without latching offline', () => {
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, { send: () => 'refused' });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      // The host pulses red via releaseStroke (main.tsx owns that half); the
      // input side must not also latch grey or spend the offline blink.
      expect(input.offlineHold()).toBe(false);
      expect(input.offlineBlinks()).toBe(0);
      expect(input.refusedHold()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('an offline repeat tick freezes the repeat until the next press', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    let calls = 0;
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      send: () => {
        calls++;
        return calls < 2 ? 'sent' : 'offline';
      },
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      vi.advanceTimersByTime(repeatDelayMs(0));
      expect(attempts).toHaveLength(2);
      expect(input.offlineHold()).toBe(true);
      vi.advanceTimersByTime(repeatDelayMs(1) + repeatDelayMs(2) + repeatDelayMs(3));
      expect(attempts).toHaveLength(2);
      expect(input.offlineBlinks()).toBe(1);
    } finally {
      dispose();
    }
  });
});

describe('flat cue (posture refusals)', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('an underside raise blinks flat once on press and sends nothing', () => {
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      pickCell: () => UNDERSIDE_PICK,
      pickInColumn: () => UNDERSIDE_PICK,
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(0);
      expect(input.flatBlinks()).toBe(1);
      expect(input.offlineHold()).toBe(false);
      expect(input.offlineBlinks()).toBe(0);
    } finally {
      dispose();
    }
  });

  it('no-target frames stay silent, however long the hold', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      pickCell: () => null,
      pickInColumn: () => null,
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(0);
      for (let tick = 0; tick < SILENT_REPEAT_BLINK_AFTER + 2; tick++) {
        vi.advanceTimersByTime(repeatDelayMs(tick));
      }
      expect(attempts).toHaveLength(0);
      expect(input.flatBlinks()).toBe(0);
      expect(input.offlineBlinks()).toBe(0);
    } finally {
      dispose();
    }
  });

  it('three silent repeat ticks blink flat once per streak, then the budget holds', () => {
    vi.useFakeTimers();
    expect(SILENT_REPEAT_BLINK_AFTER).toBe(3);
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      pickCell: () => UNDERSIDE_PICK,
      pickInColumn: () => UNDERSIDE_PICK,
    });
    try {
      fire('pointerdown', {});
      expect(input.flatBlinks()).toBe(1);
      vi.advanceTimersByTime(repeatDelayMs(0) + repeatDelayMs(1));
      expect(input.flatBlinks()).toBe(1);
      vi.advanceTimersByTime(repeatDelayMs(2));
      expect(input.flatBlinks()).toBe(2);
      vi.advanceTimersByTime(
        repeatDelayMs(3) + repeatDelayMs(4) + repeatDelayMs(5) + repeatDelayMs(6),
      );
      expect(input.flatBlinks()).toBe(2);
      expect(attempts).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it('a successful send re-arms the streak blink', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    let posture = false;
    const realPick = (o: Vec3, d: Vec3): TerrainRayPick | null => pickTerrainCellByRay(mirror, o, d);
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      pickCell: (o, d) => (posture ? UNDERSIDE_PICK : realPick(o, d)),
      pickInColumn: (x, y, o, d) =>
        posture ? UNDERSIDE_PICK : pickTerrainInColumn(mirror, x, y, o, d),
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      expect(input.flatBlinks()).toBe(0);

      posture = true;
      vi.advanceTimersByTime(repeatDelayMs(0) + repeatDelayMs(1));
      expect(input.flatBlinks()).toBe(0);

      posture = false;
      vi.advanceTimersByTime(repeatDelayMs(2));
      expect(attempts).toHaveLength(2);

      posture = true;
      vi.advanceTimersByTime(repeatDelayMs(3) + repeatDelayMs(4) + repeatDelayMs(5));
      expect(input.flatBlinks()).toBe(1);
    } finally {
      dispose();
    }
  });

  it('a seed that moves nothing blinks flat and grabs nothing', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      bandAtCell: () => 5,
    });
    try {
      fire('pointerdown', {});
      // The seed intent goes out (raise into flat ground moves nothing)...
      expect(attempts).toHaveLength(1);
      // ...so there is no band to grab and the flat cue blinks once.
      expect(input.heldBand()).toBeNull();
      expect(input.flatBlinks()).toBe(1);
      expect(input.offlineHold()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('a drag press that takes no hold blinks flat instead of going silent', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    const ungrabbable: TerrainRayPick = { ...UNDERSIDE_PICK, face: 'riser' };
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      pickCell: () => ungrabbable,
      pickInColumn: () => ungrabbable,
      riserBand: () => null,
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(0);
      expect(input.heldBand()).toBeNull();
      expect(input.flatBlinks()).toBe(1);
      expect(input.offlineBlinks()).toBe(0);
      expect(input.refusedHold()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('a seed whose band cannot be read blinks flat too', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      bandAtCell: () => null,
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      expect(input.heldBand()).toBeNull();
      expect(input.flatBlinks()).toBe(1);
    } finally {
      dispose();
    }
  });

  it('lowers grab the pre-seed band', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    let reads = 0;
    const { input, fire, dispose } = driveInput(mirror, {
      bandAtCell: () => {
        reads++;
        return reads === 1 ? 5 : 4;
      },
    });
    try {
      fire('pointerdown', { shiftKey: true });
      expect(input.heldBand()).toBe(5);
      expect(input.flatBlinks()).toBe(0);
    } finally {
      dispose();
    }
  });
});

describe('descent gate', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('a shallow aim with a held band freezes the stroke and flags the flat-mark', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      riserBand: () => 3,
      origin: { x: cellW(10), y: bandY(2), z: cellW(10) },
      lookAt: { x: cellW(50), y: bandY(2), z: cellW(50) },
    });
    try {
      fire('pointerdown', {});
      expect(input.heldBand()).toBe(3);
      expect(attempts).toHaveLength(0);
      expect(input.dragDescentFrozen()).toBe(true);
      expect(input.flatBlinks()).toBe(1);

      fire('pointermove', { clientX: CENTRE_X + 40, clientY: CENTRE_Y + 30 });
      expect(attempts).toHaveLength(0);
      expect(input.dragDescentFrozen()).toBe(true);
      expect(input.flatBlinks()).toBe(1);

      fire('pointerup', {});
      expect(input.dragDescentFrozen()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('the stroke thaws as soon as the aim comes back down onto the held band', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      riserBand: () => 1,
      origin: { x: cellW(10), y: bandY(2), z: cellW(10) },
      lookAt: { x: cellW(50), y: bandY(2), z: cellW(50) },
    });
    try {
      fire('pointerdown', {});
      expect(input.dragDescentFrozen()).toBe(true);
      expect(attempts).toHaveLength(0);

      fire('pointermove', { clientY: VIEW_HEIGHT - 1 });
      expect(input.dragDescentFrozen()).toBe(false);
      expect(attempts).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('a nack lets go of the grabbed band, so no leg targets a rolled-back seed', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror, { riserBand: () => 2 });
    try {
      fire('pointerdown', {});
      expect(input.heldBand()).toBe(2);
      // What main.tsx does on sculptDenied.
      input.releaseStroke();
      expect(input.heldBand()).toBeNull();
      expect(input.refusedHold()).toBe(true);
    } finally {
      dispose();
    }
  });

  it('a second finger lets go of the held band', () => {
    vi.useFakeTimers();
    setBrushTool('drag');
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror, { riserBand: () => 2 });
    try {
      fire('pointerdown', { pointerType: 'touch', pointerId: 7 });
      vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS);
      expect(input.heldBand()).toBe(2);
      fire('pointerdown', { pointerType: 'touch', pointerId: 8 });
      expect(input.heldBand()).toBeNull();
    } finally {
      dispose();
    }
  });
});

describe('sweep truncation', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('dropped legs blink offline once for the whole sweep', () => {
    setBrushTool('drag');
    const mirror = flatWorld();
    let calls = 0;
    const { input, attempts, fire, dispose } = driveInput(mirror, {
      riserBand: () => 3,
      // A raked view so one pointer throw spans several sweep legs.
      origin: { x: cellW(8), y: bandY(30), z: cellW(32) },
      lookAt: { x: cellW(56), y: 0, z: cellW(32) },
      send: () => {
        calls++;
        return calls < 3 ? 'sent' : 'offline';
      },
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      const from = { x: attempts[0]!.x, y: attempts[0]!.y };

      fire('pointermove', { clientX: VIEW_WIDTH - 5, clientY: VIEW_HEIGHT - 5 });
      const legs = attempts.slice(1);
      // The sweep must actually span legs for this to cover truncation.
      const last = legs[legs.length - 1]!;
      expect(
        chebyshevDistance(from.x, from.y, last.x, last.y) > MAX_DRAG_SWEEP_CELLS,
      ).toBe(true);
      expect(input.offlineHold()).toBe(true);
      expect(input.offlineBlinks()).toBe(1);
      // The tail is dropped: every sent leg chains from the previous one.
      for (const leg of legs) {
        if (leg.fromX !== undefined) {
          expect(
            attempts.some((sent) => sent.x === leg.fromX && sent.y === leg.fromY),
          ).toBe(true);
        }
      }
    } finally {
      dispose();
    }
  });
});

describe('dead directionless-raise guard', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('normal carve strokes never trip it', () => {
    setBrushTool('carve');
    setBrushRadius(1);
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror);
    try {
      fire('pointerdown', {});
      expect(input.deadGuardHits()).toBe(0);
    } finally {
      dispose();
    }
  });
});

const GRASPED_BAND = 6;

const LAYERED_RISER_PICK: TerrainRayPick = {
  x: 30,
  y: 30,
  surfaceY: GRASPED_BAND * BAND_HEIGHT * HEIGHT_WORLD_SCALE,
  spanIndex: 1,
  face: 'riser',
  hitY: GRASPED_BAND * BAND_HEIGHT * HEIGHT_WORLD_SCALE,
  hitX: (30 - 0.5) * CELL_WORLD_SIZE,
  hitZ: 30 * CELL_WORLD_SIZE,
};

describe('foot-anchored grasp', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('asks for the grasp at the cell it anchors at, not the cell it struck', () => {
    setBrushTool('stamp');
    const mirror = flatWorld();
    const asked: { x: number; y: number }[] = [];
    const { attempts, fire, dispose } = driveInput(mirror, {
      origin: { x: cellW(20), y: bandY(20), z: cellW(30) },
      lookAt: { x: cellW(30), y: 0, z: cellW(30) },
      pickCell: () => LAYERED_RISER_PICK,
      pickInColumn: () => LAYERED_RISER_PICK,
      graspSpanBand: (_pick, atX, atY) => {
        asked.push({ x: atX, y: atY });
        return GRASPED_BAND;
      },
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      // Foot anchoring moved the stroke off the struck riser cell.
      expect(attempts[0]!.x).not.toBe(LAYERED_RISER_PICK.x);
      expect(asked[0]).toEqual({ x: attempts[0]!.x, y: attempts[0]!.y });
    } finally {
      dispose();
    }
  });

  it('omits spanBand when the anchored column holds no such span', () => {
    setBrushTool('stamp');
    const mirror = flatWorld();
    const { attempts, fire, dispose } = driveInput(mirror, {
      origin: { x: cellW(20), y: bandY(20), z: cellW(30) },
      lookAt: { x: cellW(30), y: 0, z: cellW(30) },
      pickCell: () => LAYERED_RISER_PICK,
      pickInColumn: () => LAYERED_RISER_PICK,
      graspSpanBand: (pick, atX, atY) =>
        pick !== null && atX === pick.x && atY === pick.y ? GRASPED_BAND : null,
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.spanBand).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

describe('refused pulse path', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('releaseStroke latches the refused hold until pointerup', () => {
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror);
    try {
      fire('pointerdown', {});
      expect(input.refusedHold()).toBe(false);
      input.releaseStroke();
      expect(input.refusedHold()).toBe(true);
      fire('pointerup', {});
      expect(input.refusedHold()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('a refusal that lands after the click is over still shows, then clears', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror);
    try {
      fire('pointerdown', {});
      fire('pointerup', {});
      // A server nack for a quick click arrives with no button left to hold it.
      input.releaseStroke();
      expect(input.refusedHold()).toBe(true);
      vi.advanceTimersByTime(REFUSED_PULSE_MS - 1);
      expect(input.refusedHold()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(input.refusedHold()).toBe(false);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('the re-click clears a pulsing refusal', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror);
    try {
      fire('pointerdown', {});
      fire('pointerup', {});
      input.releaseStroke();
      expect(input.refusedHold()).toBe(true);
      fire('pointerdown', {});
      expect(input.refusedHold()).toBe(false);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('a held refusal outlasts the pulse — the button is what ends it', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror);
    try {
      fire('pointerdown', {});
      input.releaseStroke();
      vi.advanceTimersByTime(REFUSED_PULSE_MS * 2);
      expect(input.refusedHold()).toBe(true);
      fire('pointerup', {});
      expect(input.refusedHold()).toBe(false);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('the pulse outlasts the blinks the cue has to show', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror);
    const cue = createDenialCue(input.refusedHold);
    try {
      fire('pointerdown', {});
      fire('pointerup', {});
      input.releaseStroke();
      cue.isRed();
      vi.advanceTimersByTime(DENIED_BLINK_SETTLE_MS);
      expect(input.refusedHold()).toBe(true);
      expect(cue.isRed()).toBe(true);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('dispose and blur drop a pulsing refusal', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror);
    try {
      fire('pointerdown', {});
      fire('pointerup', {});
      input.releaseStroke();
      expect(input.refusedHold()).toBe(true);
      fire('blur', {});
      expect(input.refusedHold()).toBe(false);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});

describe('a held foot-anchored stroke keeps the cell it pressed on', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  const eyeSide = {
    origin: { x: cellW(20), y: bandY(20), z: cellW(30) },
    lookAt: { x: cellW(30), y: 0, z: cellW(30) },
  };

  for (const held of ['stamp', 'smooth'] as const) {
    it(`${held}: a cap that flips tread to riser does not walk the anchor`, () => {
      vi.useFakeTimers();
      setBrushTool(held);
      const mirror = flatWorld();
      let face: PickFace = 'tread';
      const aimed = (): TerrainRayPick => ({ ...LAYERED_RISER_PICK, face });
      const { attempts, fire, dispose } = driveInput(mirror, {
        ...eyeSide,
        pickCell: aimed,
        pickInColumn: aimed,
      });
      try {
        fire('pointerdown', {});
        expect(attempts).toHaveLength(1);
        const pressed = { x: attempts[0]!.x, y: attempts[0]!.y };
        // The raise the press just made turns the pinned column's cap into a
        // riser under the unchanged ray.
        face = 'riser';
        vi.advanceTimersByTime(repeatDelayMs(0));
        expect(attempts).toHaveLength(2);
        expect({ x: attempts[1]!.x, y: attempts[1]!.y }).toEqual(pressed);
      } finally {
        dispose();
      }
    });
  }

  it('a pointer move re-derives the anchor from the new aim', () => {
    vi.useFakeTimers();
    setBrushTool('stamp');
    const mirror = flatWorld();
    let face: PickFace = 'tread';
    const aimed = (): TerrainRayPick => ({ ...LAYERED_RISER_PICK, face });
    const { attempts, fire, dispose } = driveInput(mirror, {
      ...eyeSide,
      pickCell: aimed,
      pickInColumn: aimed,
    });
    try {
      fire('pointerdown', {});
      const pressed = { x: attempts[0]!.x, y: attempts[0]!.y };
      face = 'riser';
      fire('pointermove', { clientX: CENTRE_X + 60, clientY: CENTRE_Y + 20 });
      vi.advanceTimersByTime(repeatDelayMs(0));
      expect(attempts).toHaveLength(2);
      expect({ x: attempts[1]!.x, y: attempts[1]!.y }).not.toEqual(pressed);
    } finally {
      dispose();
    }
  });
});

describe('the HUD direction toggle holds against an unmodified mouse', () => {
  const tool = brushTool();
  const radius = brushRadius();
  const mode = sculptMode();
  afterEach(() => {
    restoreHud(tool, radius);
    setSculptMode(mode);
    setSculptChord(false);
    vi.useRealTimers();
  });

  it('survives plain pointer moves — no chord change, no mode write', () => {
    setBrushTool('stamp');
    const mirror = flatWorld();
    const { fire, dispose } = driveInput(mirror);
    try {
      setSculptMode('lower');
      fire('pointermove', { clientX: CENTRE_X + 10, clientY: CENTRE_Y + 10 });
      fire('pointermove', { clientX: CENTRE_X + 20, clientY: CENTRE_Y + 20 });
      expect(sculptMode()).toBe('lower');
    } finally {
      dispose();
    }
  });

  it('still previews the chord: shift down lowers, shift up returns to raise', () => {
    setBrushTool('stamp');
    const mirror = flatWorld();
    const { fire, dispose } = driveInput(mirror);
    try {
      setSculptMode('raise');
      fire('keydown', { shiftKey: true });
      expect(effectiveSculptMode()).toBe('lower');
      expect(sculptMode()).toBe('raise');
      fire('keyup', { shiftKey: false });
      expect(effectiveSculptMode()).toBe('raise');
    } finally {
      dispose();
    }
  });

  it('a chord pressed mid-stroke still previews once the stroke ends', () => {
    setBrushTool('stamp');
    const mirror = flatWorld();
    const { fire, dispose } = driveInput(mirror);
    try {
      setSculptMode('raise');
      fire('pointerdown', {});
      fire('keydown', { shiftKey: true });
      expect(sculptMode()).toBe('raise');

      fire('pointerup', {});
      fire('pointermove', { shiftKey: true });
      expect(effectiveSculptMode()).toBe('lower');
      expect(sculptMode()).toBe('raise');
    } finally {
      dispose();
    }
  });

  it('a chord pressed while carve is selected previews after the tool changes', () => {
    setBrushTool('carve');
    const mirror = flatWorld();
    const { fire, dispose } = driveInput(mirror);
    try {
      setSculptMode('raise');
      fire('keydown', { shiftKey: true });
      expect(sculptMode()).toBe('raise');

      setBrushTool('stamp');
      fire('pointermove', { shiftKey: true });
      expect(effectiveSculptMode()).toBe('lower');
    } finally {
      dispose();
    }
  });

  it('a toggled direction reaches the intent a touch press sends', () => {
    vi.useFakeTimers();
    setBrushTool('stamp');
    const mirror = flatWorld();
    const { attempts, fire, dispose } = driveInput(mirror);
    try {
      setSculptMode('lower');
      fire('pointerdown', { pointerType: 'touch', pointerId: 7 });
      vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.dir).toBe(-1);
    } finally {
      dispose();
    }
  });
});

describe('the host wiring turns every cue into something the brush can read', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  // The same composition main.tsx builds: the input reports transitions, the
  // prediction store reports ghosts, and the cue turns both into levels.
  const cueOver = (input: SculptInput, ghostSeqs: () => readonly number[]): DenialCue =>
    createDenialCue(() => input.refusedHold(), {
      offline: () => input.offlineHold(),
      ghost: () => ghostSeqs().length > 0,
      flat: () => input.dragDescentFrozen(),
      flatBlinks: () => input.flatBlinks(),
    });

  it('an offline press reads grey, never red, for the whole hold', () => {
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror, { send: () => 'offline' });
    try {
      const cue = cueOver(input, () => []);
      expect(cue.offline()).toBe(false);
      fire('pointerdown', {});
      expect(cue.offline()).toBe(true);
      // Offline outranks red for as long as the latch holds.
      expect(cue.isRed()).toBe(false);
      fire('pointerup', {});
      expect(cue.offline()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('a posture refusal flashes the flat mark, then lets the footprint back', () => {
    vi.useFakeTimers();
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror, {
      pickCell: () => UNDERSIDE_PICK,
      pickInColumn: () => UNDERSIDE_PICK,
    });
    try {
      const cue = cueOver(input, () => []);
      expect(cue.flat()).toBe(false);
      fire('pointerdown', {});
      expect(cue.flat()).toBe(true);
      vi.advanceTimersByTime(CUE_BLINK_ON_MS);
      expect(cue.flat()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('a frozen drag descent holds the flat mark for as long as it is frozen', () => {
    vi.useFakeTimers();
    setBrushTool('drag');
    const mirror = flatWorld();
    const { input, fire, dispose } = driveInput(mirror, {
      riserBand: () => 3,
      origin: { x: cellW(10), y: bandY(2), z: cellW(10) },
      lookAt: { x: cellW(50), y: bandY(2), z: cellW(50) },
    });
    try {
      const cue = cueOver(input, () => []);
      fire('pointerdown', {});
      expect(input.dragDescentFrozen()).toBe(true);
      // The press blinked flat once; the freeze holds the mark past that flash.
      vi.advanceTimersByTime(CUE_BLINK_ON_MS);
      expect(cue.flat()).toBe(true);
      fire('pointerup', {});
      vi.advanceTimersByTime(CUE_BLINK_ON_MS);
      expect(cue.flat()).toBe(false);
    } finally {
      dispose();
    }
  });

  it('a settled smooth stroke ghosts: the intent left, the prediction shows nothing', () => {
    const mirror = flatWorld();
    const predictions = createPredictionStore(mirror);
    const { input, fire, dispose } = driveInput(mirror, {
      send: (intent) => {
        predictions.predict(intent, 0);
        return 'sent';
      },
    });
    try {
      setBrushTool('smooth');
      const cue = cueOver(input, () => predictions.ghostSeqs());
      expect(cue.ghost()).toBe(false);
      fire('pointerdown', {});
      // Smooth on already-flat ground relaxes nothing, so the seq holds a ghost
      // until the server answers it.
      expect(cue.ghost()).toBe(true);
      expect(cue.offline()).toBe(false);
      expect(cue.isRed()).toBe(false);
      predictions.resolveSeq(1);
      expect(cue.ghost()).toBe(false);
    } finally {
      dispose();
    }
  });
});

const FOOT_COLUMN_X = 29;
const WALL_COLUMN_X = 30;
const LAYERED_ROW = 30;
const FOOT_TREAD_CEILING = 48;
const FOOT_TREAD_BAND = 3;
const FOOT_TREAD_RAISED_CEILING = 64;
const FOOT_ROOF_BAND = 10;
const FOOT_ROOF_CEILING = 208;
const WALL_TREAD_CEILING = 112;
const WALL_ROOF_BAND = 19;
const WALL_ROOF_CEILING = 340;
const WALL_RISER_BAND = 5;

const WALL_RISER_PICK: TerrainRayPick = {
  x: WALL_COLUMN_X,
  y: LAYERED_ROW,
  surfaceY: bandY(WALL_RISER_BAND),
  spanIndex: 0,
  face: 'riser',
  hitY: bandY(WALL_RISER_BAND),
  hitX: (WALL_COLUMN_X - 0.5) * CELL_WORLD_SIZE,
  hitZ: LAYERED_ROW * CELL_WORLD_SIZE,
};

function layeredFootWorld(): TerrainMirror {
  const mirror = flatWorld();
  setColumn(mirror.map, FOOT_COLUMN_X, LAYERED_ROW, [
    { floorBand: BEDROCK_BAND, ceiling: FOOT_TREAD_CEILING },
    { floorBand: FOOT_ROOF_BAND, ceiling: FOOT_ROOF_CEILING },
  ]);
  setColumn(mirror.map, WALL_COLUMN_X, LAYERED_ROW, [
    { floorBand: BEDROCK_BAND, ceiling: WALL_TREAD_CEILING },
    { floorBand: WALL_ROOF_BAND, ceiling: WALL_ROOF_CEILING },
  ]);
  return mirror;
}

describe('a foot-anchored grasp on a layered column', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('grasps the tread the anchor stands on, and raising it leaves the roof alone', () => {
    setBrushTool('stamp');
    setBrushRadius(1);
    const mirror = layeredFootWorld();
    const { attempts, fire, dispose } = driveInput(mirror, {
      origin: { x: cellW(20), y: bandY(20), z: cellW(LAYERED_ROW) },
      lookAt: { x: cellW(WALL_COLUMN_X), y: 0, z: cellW(LAYERED_ROW) },
      pickCell: () => WALL_RISER_PICK,
      pickInColumn: () => WALL_RISER_PICK,
      graspSpanBand: (pick, atX, atY) =>
        pick === null ? null : graspSpanBandIn(mirror.map, pick, atX, atY),
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      const intent = attempts[0]!;
      expect({ x: intent.x, y: intent.y }).toEqual({ x: FOOT_COLUMN_X, y: LAYERED_ROW });
      expect(intent.spanBand).toBe(FOOT_TREAD_BAND);

      applySculpt(
        mirror.map,
        intent.x,
        intent.y,
        intent.radius,
        DEFAULT_SCULPT_AMOUNT * intent.dir,
        sculptOptionsOf(intent),
      );
      expect(spanAt(mirror.map, FOOT_COLUMN_X, LAYERED_ROW, 0).ceiling).toBe(
        FOOT_TREAD_RAISED_CEILING,
      );
      expect(spanAt(mirror.map, FOOT_COLUMN_X, LAYERED_ROW, 1).ceiling).toBe(FOOT_ROOF_CEILING);
    } finally {
      dispose();
    }
  });

  it('keeps the struck band when the anchor column covers it', () => {
    setBrushTool('stamp');
    const mirror = layeredFootWorld();
    setColumn(mirror.map, FOOT_COLUMN_X, LAYERED_ROW, [
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(FOOT_ROOF_BAND - 2) },
      { floorBand: FOOT_ROOF_BAND, ceiling: FOOT_ROOF_CEILING },
    ]);
    const { attempts, fire, dispose } = driveInput(mirror, {
      origin: { x: cellW(20), y: bandY(20), z: cellW(LAYERED_ROW) },
      lookAt: { x: cellW(WALL_COLUMN_X), y: 0, z: cellW(LAYERED_ROW) },
      pickCell: () => WALL_RISER_PICK,
      pickInColumn: () => WALL_RISER_PICK,
      graspSpanBand: (pick, atX, atY) =>
        pick === null ? null : graspSpanBandIn(mirror.map, pick, atX, atY),
    });
    try {
      fire('pointerdown', {});
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.spanBand).toBe(WALL_RISER_BAND);
    } finally {
      dispose();
    }
  });
});

// A terrace wall cell: genesis steps walls by MAX_STEP, so its cap sits inside a
// drawn band instead of on a canonical band level.
const WALL_STEP_HEIGHT = 8;
const WALL_STEP_DRAWN_BAND = 1;
const WALL_STEP_RAISED_DRAWN_BAND = 2;

function wallStepWorld(): TerrainMirror {
  const mirror = flatWorld();
  mirror.map.cells[cellIndex(mirror.map, 30, 30)] = WALL_STEP_HEIGHT;
  return mirror;
}

function driveDragSeed(mirror: TerrainMirror, shiftKey: boolean): {
  input: SculptInput;
  attempts: SculptIntent[];
  dispose: () => void;
} {
  const { input, attempts, fire, dispose } = driveInput(mirror, {
    bandAtCell: (x, y, spanBand) => bandAtCellIn(mirror, x, y, spanBand),
    send: (intent) => {
      applySculpt(
        mirror.map,
        intent.x,
        intent.y,
        intent.radius,
        DEFAULT_SCULPT_AMOUNT * intent.dir,
        sculptOptionsOf(intent),
      );
      return 'sent';
    },
  });
  fire('pointerdown', { shiftKey });
  return { input, attempts, dispose };
}

describe('a drag seed on ground that is not at a canonical band level', () => {
  const tool = brushTool();
  const radius = brushRadius();
  const mode = sculptMode();
  afterEach(() => {
    restoreHud(tool, radius);
    setSculptMode(mode);
    vi.useRealTimers();
  });

  it('a raise grabs the band the seed drew, not the band its raw height floors to', () => {
    setBrushTool('drag');
    setBrushRadius(1);
    const mirror = wallStepWorld();
    const { input, attempts, dispose } = driveDragSeed(mirror, false);
    try {
      expect(input.heldBand()).toBe(WALL_STEP_RAISED_DRAWN_BAND);
      const leg = attempts.find((intent) => intent.tool === 'drag');
      expect(leg?.targetBand).toBe(WALL_STEP_RAISED_DRAWN_BAND);
    } finally {
      dispose();
    }
  });

  it('a lower grabs the starting band instead of blinking flat at a real drop', () => {
    setBrushTool('drag');
    setBrushRadius(1);
    const mirror = wallStepWorld();
    const { input, attempts, dispose } = driveDragSeed(mirror, true);
    try {
      expect(input.flatBlinks()).toBe(0);
      expect(input.heldBand()).toBe(WALL_STEP_DRAWN_BAND);
      const leg = attempts.find((intent) => intent.tool === 'drag');
      expect(leg?.targetBand).toBe(WALL_STEP_DRAWN_BAND);
    } finally {
      dispose();
    }
  });
});

describe('a modifier change steers the leg it arrived on', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  const HELD_BAND = 5;

  const dragWithHold = (): ReturnType<typeof driveInput> => {
    setBrushTool('drag');
    return driveInput(flatWorld(), { riserBand: () => HELD_BAND });
  };

  it('a shift that arrives with the move lowers that leg, not the next one', () => {
    const { input, attempts, fire, dispose } = dragWithHold();
    try {
      fire('pointerdown', {});
      expect(input.heldBand()).toBe(HELD_BAND);
      expect(attempts.at(-1)!.dir).toBe(1);

      fire('pointermove', { clientX: CENTRE_X + 40, shiftKey: true });
      expect(attempts.at(-1)!.dir).toBe(-1);
    } finally {
      dispose();
    }
  });

  it('an unmodified move keeps the direction the press armed', () => {
    const { attempts, fire, dispose } = dragWithHold();
    try {
      fire('pointerdown', {});
      fire('pointermove', { clientX: CENTRE_X + 40 });
      expect(attempts.at(-1)!.dir).toBe(1);
    } finally {
      dispose();
    }
  });
});
