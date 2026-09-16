import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  applySculpt,
  setColumn,
  spanIndexCoveringBand,
  type ChunkPayload,
  type JoinSnapshotMessage,
  type SculptIntent,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import { createSculptInput, repeatDelayMs, type SculptInput } from '../src/input/sculptInput.ts';
import { applySnapshot, createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';
import {
  carveReachCell,
  pickTerrainCellByRay,
  pickTerrainInColumn,
  type Vec3,
} from '../src/terrain/picking.ts';
import { carveBandOfPick, resolvePick } from '../src/terrain/pickBand.ts';
import { brushRadius, brushTool, setBrushRadius, setBrushTool } from '../src/state/hudState.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 600;
const CENTRE_X = VIEW_WIDTH / 2;
const CENTRE_Y = VIEW_HEIGHT / 2;

const WALL_X = 32;
const AIM_Z = 20;
const GROUND_BAND = 5;
const WALL_BAND = 10;

function flatWorld(heightOf: (x: number, y: number) => number): TerrainMirror {
  const mirror = createTerrainMirror(WORLD);
  const perEdge = WORLD / CHUNK_SIZE;
  const chunks: ChunkPayload[] = [];
  for (let cy = 0; cy < perEdge; cy++) {
    for (let cx = 0; cx < perEdge; cx++) {
      const heights = new Array<number>(CELLS_PER_CHUNK);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          heights[ly * CHUNK_SIZE + lx] = heightOf(cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly);
        }
      }
      chunks.push({ cx, cy, heights });
    }
  }
  applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks } as JoinSnapshotMessage);
  return mirror;
}

function driveInput(
  mirror: TerrainMirror,
  origin: Vec3,
  lookAt: Vec3,
): {
  input: SculptInput;
  sent: SculptIntent[];
  fire: (type: string, event: Partial<PointerEvent>) => void;
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
  camera.position.set(origin.x, origin.y, origin.z);
  camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
  camera.updateMatrixWorld(true);

  const sent: SculptIntent[] = [];
  const input = createSculptInput({
    canvas,
    camera,
    pickCell: (o, d) => pickTerrainCellByRay(mirror, o, d),
    pickInColumn: (x, y, o, d) => pickTerrainInColumn(mirror, x, y, o, d),
    worldSize: () => mirror.map.size,
    riserBand: () => null,
    bandAtCell: () => null,
    graspSpanBand: () => null,
    carveBand: (pick) => (pick === null ? null : carveBandOfPick(mirror.map, pick, () => false)),
    carveReach: (o, d, band) => carveReachCell(mirror, o, d, band),
    send: (intent) => {
      sent.push(intent);
      return 'sent';
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

  const fire = (type: string, event: Partial<PointerEvent>): void => {
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
      ...event,
    } as unknown as Event);
  };

  return {
    input,
    sent,
    fire,
    dispose: () => {
      input.dispose();
      (globalThis as { window?: unknown }).window = previousWindow;
    },
  };
}

const bandY = (bands: number): number => bands * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
const cellW = (cells: number): number => cells * CELL_WORLD_SIZE;

describe('hoverTarget pins the cell and re-derives the pick', () => {
  it('keeps the aimed cell when the ground under it is RAISED, and follows its new surface', () => {
    const mirror = flatWorld(() => 0);
    const target = { x: cellW(30), y: 0, z: cellW(30) };
    const { input, dispose } = driveInput(
      mirror,
      { x: cellW(30), y: bandY(20), z: cellW(30) },
      target,
    );
    try {
      const before = input.hoverTarget();
      expect(before).not.toBeNull();
      expect(before!.surfaceY).toBe(bandY(-1));
      const cell = { x: before!.x, y: before!.y };

      setColumn(mirror.map, cell.x, cell.y, [
        { floor: BEDROCK_FLOOR, ceiling: BAND_HEIGHT * 3 },
      ]);
      const after = input.hoverTarget();
      expect(after).not.toBeNull();
      expect({ x: after!.x, y: after!.y }).toEqual(cell);
      expect(after!.surfaceY).toBe(bandY(3));
    } finally {
      dispose();
    }
  });

  it('re-marches past the aimed cell when the ground is LOWERED clear of the ray (F5)', () => {
    const mirror = flatWorld((x) => (x >= WALL_X ? BAND_HEIGHT * WALL_BAND : 0));
    const { input, dispose } = driveInput(
      mirror,
      { x: cellW(WALL_X - 8), y: bandY(WALL_BAND + 8), z: cellW(AIM_Z) },
      { x: cellW(WALL_X), y: bandY(WALL_BAND), z: cellW(AIM_Z) },
    );
    try {
      const before = input.hoverTarget();
      expect(before).not.toBeNull();
      const cell = { x: before!.x, y: before!.y };

      setColumn(mirror.map, cell.x, cell.y, [{ floor: BEDROCK_FLOOR, ceiling: 0 }]);
      const after = input.hoverTarget();
      expect(after).not.toBeNull();
      // F5: the lowered column no longer fabricates a tread below the ray, so
      // hover re-marches to the ray-true surface: the next wall riser.
      expect({ x: after!.x, y: after!.y }).toEqual({ x: cell.x + 1, y: cell.y });
      expect(after!.face).toBe('riser');
    } finally {
      dispose();
    }
  });

  it('does not name the band BELOW the cut after a carve opens the aimed band (#324)', () => {
    const mirror = flatWorld((x) =>
      x >= WALL_X ? BAND_HEIGHT * WALL_BAND : BAND_HEIGHT * GROUND_BAND,
    );
    const rayY = bandY(GROUND_BAND + 0.5);
    const { input, dispose } = driveInput(
      mirror,
      { x: cellW(WALL_X - 10), y: rayY, z: cellW(AIM_Z) },
      { x: cellW(WALL_X), y: rayY, z: cellW(AIM_Z) },
    );
    try {
      const struck = input.hoverTarget();
      expect(struck).not.toBeNull();
      expect(struck!.x).toBe(WALL_X);
      expect(struck!.face).toBe('riser');
      const grabbed = resolvePick(mirror.map, struck!);
      const k = GROUND_BAND + 1;
      expect(grabbed).toEqual({ face: 'riser', band: k });

      const CARVE_RADIUS_CELLS = 1;
      applySculpt(mirror.map, struck!.x, struck!.y, CARVE_RADIUS_CELLS, -BAND_HEIGHT, {
        tool: 'carve',
        spanBand: k,
      });
      expect(mirror.map.columnSpans.size).toBeGreaterThan(0);

      const next = input.hoverTarget();
      expect(next).not.toBeNull();
      // F5: the carved-open column reads as open passage, so hover continues
      // to the next ray-true surface instead of naming the tread below the
      // cut. The #324 guarantee holds in the stronger form: the named band is
      // the aimed band, never below it.
      expect({ x: next!.x, y: next!.y }).toEqual({ x: struck!.x + 1, y: struck!.y });
      expect(next!.face).toBe('riser');
      const stillAimed = resolvePick(mirror.map, next!);
      expect(stillAimed?.face).toBe('riser');
      expect(stillAimed?.band).toBe(k);
    } finally {
      dispose();
    }
  });

  it('re-marches when the pinned column has nothing left under the ray', () => {
    const mirror = flatWorld(() => 0);
    const { input, dispose } = driveInput(
      mirror,
      { x: cellW(30), y: bandY(20), z: cellW(30) },
      { x: cellW(30), y: 0, z: cellW(30) },
    );
    try {
      expect(input.hoverTarget()).not.toBeNull();
      mirror.received.clear();
      expect(input.hoverTarget()).toBeNull();
    } finally {
      dispose();
    }
  });
});

function restoreHud(tool: ReturnType<typeof brushTool>, radius: number): void {
  setBrushTool(tool);
  setBrushRadius(radius);
}

describe('the aimed-cell pin is released when the stroke ends (#349)', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  it('keeps the aimed cell WHILE the button is down', () => {
    const mirror = flatWorld(() => 0);
    const { input, fire, dispose } = driveInput(
      mirror,
      { x: cellW(30), y: bandY(20), z: cellW(30) },
      { x: cellW(30), y: 0, z: cellW(30) },
    );
    try {
      const before = input.hoverTarget();
      expect(before).not.toBeNull();
      const cell = { x: before!.x, y: before!.y };
      fire('pointerdown', {});
      setColumn(mirror.map, cell.x, cell.y, [
        { floor: BEDROCK_FLOOR, ceiling: BAND_HEIGHT * 3 },
      ]);
      expect({ x: input.hoverTarget()!.x, y: input.hoverTarget()!.y }).toEqual(cell);
    } finally {
      dispose();
    }
  });

  it('re-marches on the very next read after pointerup, with the pointer still', () => {
    const mirror = flatWorld((x) =>
      x >= WALL_X ? BAND_HEIGHT * WALL_BAND : BAND_HEIGHT * GROUND_BAND,
    );
    const rayY = bandY(GROUND_BAND + 0.5);
    const { input, fire, dispose } = driveInput(
      mirror,
      { x: cellW(WALL_X - 10), y: rayY, z: cellW(AIM_Z) },
      { x: cellW(WALL_X), y: rayY, z: cellW(AIM_Z) },
    );
    try {
      const struck = input.hoverTarget();
      expect(struck!.x).toBe(WALL_X);
      expect(struck!.face).toBe('riser');

      fire('pointerdown', {});
      const CARVE_RADIUS_CELLS = 1;
      applySculpt(mirror.map, WALL_X, struck!.y, CARVE_RADIUS_CELLS, -BAND_HEIGHT, {
        tool: 'carve',
        spanBand: GROUND_BAND + 1,
      });
      // F5: the carved-open pinned column reads as open passage, so the preview
      // re-marches past it. The stroke anchor was seeded at press and is unaffected.
      expect(input.hoverTarget()!.x).toBe(WALL_X + 1);

      fire('pointerup', {});
      const after = input.hoverTarget();
      expect(after).not.toBeNull();
      expect(after!.x).toBeGreaterThan(WALL_X);
    } finally {
      dispose();
    }
  });
});

describe('carveReachCell: where a held carve cuts next (#349)', () => {
  const RAY_Y = bandY(GROUND_BAND + 0.5);
  const CARVE_RADIUS_CELLS = 1;
  const eastward = { origin: { x: cellW(WALL_X - 10), y: RAY_Y, z: cellW(AIM_Z) },
    direction: { x: 1, y: 0, z: 0 } };
  const cliff = (): TerrainMirror =>
    flatWorld((x) => (x >= WALL_X ? BAND_HEIGHT * WALL_BAND : BAND_HEIGHT * GROUND_BAND));

  it('names the first cell along the ray that still has material at the band', () => {
    const mirror = cliff();
    expect(carveReachCell(mirror, eastward.origin, eastward.direction, GROUND_BAND + 1))
      .toEqual({ x: WALL_X, y: AIM_Z });
  });

  it('SKIPS what is already open, which is what makes a repeat advance', () => {
    const mirror = cliff();
    const k = GROUND_BAND + 1;
    const cut: number[] = [];
    for (let repeat = 0; repeat < 4; repeat++) {
      const reach = carveReachCell(mirror, eastward.origin, eastward.direction, k);
      expect(reach).not.toBeNull();
      cut.push(reach!.x);
      applySculpt(mirror.map, reach!.x, reach!.y, CARVE_RADIUS_CELLS, -BAND_HEIGHT, {
        tool: 'carve',
        spanBand: k,
      });
      expect(spanIndexCoveringBand(mirror.map, reach!.x, reach!.y, k)).toBeNull();
    }
    expect(cut).toEqual([WALL_X, WALL_X + 1, WALL_X + 2, WALL_X + 3]);
  });

  it('is null when the aim has no material at that band — the tunnel broke through', () => {
    const mirror = flatWorld(() => BAND_HEIGHT * GROUND_BAND);
    expect(carveReachCell(mirror, eastward.origin, eastward.direction, GROUND_BAND + 1))
      .toBeNull();
  });
});

describe('a held carve keeps the band it pressed on and tunnels inward (#349)', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  const applyLast = (mirror: TerrainMirror, sent: readonly SculptIntent[]): void => {
    const intent = sent[sent.length - 1]!;
    applySculpt(mirror.map, intent.x, intent.y, intent.radius, -BAND_HEIGHT, {
      tool: 'carve',
      spanBand: intent.spanBand ?? null,
    });
  };

  it('cuts the SAME band at consecutive cells, never the band above', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    setBrushRadius(1);
    const mirror = flatWorld((x) =>
      x >= WALL_X ? BAND_HEIGHT * WALL_BAND : BAND_HEIGHT * GROUND_BAND,
    );
    const rayY = bandY(GROUND_BAND + 0.5);
    const { input, sent, fire, dispose } = driveInput(
      mirror,
      { x: cellW(WALL_X - 10), y: rayY, z: cellW(AIM_Z) },
      { x: cellW(WALL_X), y: rayY, z: cellW(AIM_Z) },
    );
    try {
      const k = GROUND_BAND + 1;
      expect(input.hoverTarget()!.x).toBe(WALL_X);

      fire('pointerdown', {});
      applyLast(mirror, sent);
      for (let repeat = 0; repeat < 3; repeat++) {
        vi.advanceTimersByTime(repeatDelayMs(repeat));
        applyLast(mirror, sent);
      }

      expect(sent).toHaveLength(4);
      expect(sent.map((i) => i.spanBand)).toEqual([k, k, k, k]);
      expect(sent.map((i) => i.x)).toEqual([WALL_X, WALL_X + 1, WALL_X + 2, WALL_X + 3]);
      expect(sent.every((i) => i.tool === 'carve')).toBe(true);
    } finally {
      dispose();
    }
  });

  it('emits nothing once the band it pressed on runs out along the aim', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    setBrushRadius(1);
    const mirror = flatWorld((x) =>
      x === WALL_X ? BAND_HEIGHT * WALL_BAND : BAND_HEIGHT * GROUND_BAND,
    );
    const rayY = bandY(GROUND_BAND + 0.5);
    const { sent, fire, dispose } = driveInput(
      mirror,
      { x: cellW(WALL_X - 10), y: rayY, z: cellW(AIM_Z) },
      { x: cellW(WALL_X), y: rayY, z: cellW(AIM_Z) },
    );
    try {
      fire('pointerdown', {});
      expect(sent).toHaveLength(1);
      applyLast(mirror, sent);
      vi.advanceTimersByTime(repeatDelayMs(0) + repeatDelayMs(1));
      expect(sent).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('exposes the latched band to the preview while the stroke is armed', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    setBrushRadius(1);
    const mirror = flatWorld((x) =>
      x >= WALL_X ? BAND_HEIGHT * WALL_BAND : BAND_HEIGHT * GROUND_BAND,
    );
    const rayY = bandY(GROUND_BAND + 0.5);
    const { input, sent, fire, dispose } = driveInput(
      mirror,
      { x: cellW(WALL_X - 10), y: rayY, z: cellW(AIM_Z) },
      { x: cellW(WALL_X), y: rayY, z: cellW(AIM_Z) },
    );
    try {
      const k = GROUND_BAND + 1;
      expect(input.carveHeldBand()).toBeNull();

      fire('pointerdown', {});
      expect(sent).toHaveLength(1);
      expect(sent[0]!.spanBand).toBe(k);
      expect(input.carveHeldBand()).toBe(k);
      expect(input.heldBand()).toBeNull();

      applyLast(mirror, sent);
      vi.advanceTimersByTime(repeatDelayMs(0));
      expect(sent.map((i) => i.spanBand)).toEqual([k, k]);
      expect(input.carveHeldBand()).toBe(k);

      fire('pointerup', {});
      expect(input.carveHeldBand()).toBeNull();
    } finally {
      dispose();
    }
  });
});

describe('a held stroke with a still pointer keeps its press-time cell (#WALK)', () => {
  const tool = brushTool();
  const radius = brushRadius();
  afterEach(() => {
    restoreHud(tool, radius);
    vi.useRealTimers();
  });

  const HOLD_REPEATS = 8;
  const EYE_DISTANCE_CELLS = 12;
  const DEGREES_TO_RADIANS = Math.PI / 180;

  const raiseHeld = (elevationDegrees: number): SculptIntent[] => {
    const mirror = flatWorld(() => 0);
    const eye = cellW(EYE_DISTANCE_CELLS);
    const elevation = elevationDegrees * DEGREES_TO_RADIANS;
    const { sent, fire, dispose } = driveInput(
      mirror,
      {
        x: cellW(30) - eye * Math.cos(elevation),
        y: eye * Math.sin(elevation),
        z: cellW(30),
      },
      { x: cellW(30), y: 0, z: cellW(30) },
    );
    try {
      fire('pointerdown', {});
      for (let repeat = 0; repeat < HOLD_REPEATS; repeat++) {
        const last = sent[sent.length - 1]!;
        applySculpt(mirror.map, last.x, last.y, last.radius, BAND_HEIGHT, {
          tool: last.tool ?? 'stamp',
          profile: last.profile ?? 'soft',
        });
        vi.advanceTimersByTime(repeatDelayMs(repeat));
      }
      return [...sent];
    } finally {
      dispose();
    }
  };

  for (const elevation of [90, 60, 45, 30]) {
    it(`does not walk at ${elevation} degrees`, () => {
      vi.useFakeTimers();
      setBrushTool('stamp');
      setBrushRadius(1);
      const sent = raiseHeld(elevation);
      expect(sent.length).toBeGreaterThan(HOLD_REPEATS);
      const first = { x: sent[0]!.x, y: sent[0]!.y };
      for (const intent of sent) {
        expect({ x: intent.x, y: intent.y }).toEqual(first);
      }
    });
  }
});
