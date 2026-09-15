import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  DEFAULT_SCULPT_AMOUNT,
  applySculpt,
  bandLevelHeight,
  heightAt,
  packColumnSpans,
  setColumn,
  spanAt,
  spanCount,
  spanIndexCoveringBand,
  type ChunkPayload,
  type JoinSnapshotMessage,
  type SculptIntent,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, TOUCH_STROKE_GRACE_MS } from '../src/config.ts';
import {
  SILENT_REPEAT_BLINK_AFTER,
  createSculptInput,
  repeatDelayMs,
  type SculptInput,
  type SendOutcome,
} from '../src/input/sculptInput.ts';
import { applySnapshot, createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';
import {
  carveReachCell,
  pickTerrainCellByRay,
  pickTerrainInColumn,
  type TerrainRayPick,
  type Vec3,
} from '../src/terrain/picking.ts';
import { carveBandOfPick } from '../src/terrain/pickBand.ts';
import { createPredictionStore } from '../src/terrain/prediction.ts';
import {
  brushRadius,
  brushTool,
  sculptMode,
  setBrushRadius,
  setBrushTool,
  setSculptMode,
} from '../src/state/hudState.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
const ROW = 32;

const worldX = (cell: number): number => cell * CELL_WORLD_SIZE;
const worldY = (height: number): number => height * HEIGHT_WORLD_SCALE;

function worldOf(heightOf: (x: number, y: number) => number): TerrainMirror {
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

const RIDGE_X = 20;
const RIDGE_BAND = 12;
const PLATEAU_BAND = 10;
const AIM_ORIGIN_CELL = 4;
const AIM_ORIGIN_BAND = 20;
/** ~20 degrees of pitch: the aim clears the ridge and lands well past it. */
const AIM_SLOPE = -0.36;

const AIM_ORIGIN: Vec3 = {
  x: worldX(AIM_ORIGIN_CELL),
  y: worldY(bandLevelHeight(AIM_ORIGIN_BAND)),
  z: worldX(ROW),
};
const AIM_DIRECTION: Vec3 = { x: 1, y: AIM_SLOPE, z: 0 };

describe('carveReachCell reaches from the cell the aim struck', () => {
  it('a ray that flies over a nearer ridge carves the lip it struck, not the ridge', () => {
    const plateauX = 30;
    const mirror = worldOf((x) => {
      if (x === RIDGE_X) return bandLevelHeight(RIDGE_BAND);
      if (x >= plateauX) return bandLevelHeight(PLATEAU_BAND);
      return 0;
    });

    const aim = pickTerrainCellByRay(mirror, AIM_ORIGIN, AIM_DIRECTION);
    expect(aim).not.toBeNull();
    expect(aim!.x).toBeGreaterThanOrEqual(plateauX);

    const band = carveBandOfPick(mirror.map, aim!, () => true);
    expect(band).toBe(PLATEAU_BAND);
    // The ridge covers the grasped band as well — that is what made the reach ambiguous.
    expect(spanIndexCoveringBand(mirror.map, RIDGE_X, ROW, band!)).not.toBeNull();

    expect(carveReachCell(mirror, AIM_ORIGIN, AIM_DIRECTION, band!)).toEqual({
      x: aim!.x,
      y: ROW,
    });
  });

  it('walks one cell inward per cut and goes silent when the cut breaks through', () => {
    const firstX = 32;
    const lastX = 36;
    const mirror = worldOf((x) =>
      x >= firstX && x <= lastX ? bandLevelHeight(PLATEAU_BAND) : 0,
    );
    const aim = pickTerrainCellByRay(mirror, AIM_ORIGIN, AIM_DIRECTION);
    const band = carveBandOfPick(mirror.map, aim!, () => true);
    expect(band).toBe(PLATEAU_BAND);

    const cut: number[] = [];
    for (let tick = 0; tick < lastX - firstX + 2; tick++) {
      const reach = carveReachCell(mirror, AIM_ORIGIN, AIM_DIRECTION, band!);
      if (reach === null) break;
      cut.push(reach.x);
      const diff = applySculpt(mirror.map, reach.x, reach.y, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'carve',
        spanBand: band!,
      });
      expect(diff.length).toBeGreaterThan(0);
    }
    expect(cut).toEqual([32, 33, 34, 35, 36]);
    expect(carveReachCell(mirror, AIM_ORIGIN, AIM_DIRECTION, band!)).toBeNull();
  });

  it('reaches a cell the ray marched past — the pick may name a neighbour', () => {
    // Chrome sweep (4 cameras, ~10k rays each): ~6% of carvable aims had a
    // reach of null. The pick names the column that OWNS the struck band, and
    // that column can be a neighbour of the cell the ray's own march entered.
    const TOWER = bandLevelHeight(PLATEAU_BAND);
    const mirror = worldOf(() => 0);
    setColumn(mirror.map, 12, 12, [{ floor: BEDROCK_FLOOR, ceiling: TOWER }]);

    const origin = { x: 11.4 * CELL_WORLD_SIZE, y: worldY(TOWER) + 5, z: 11.4 * CELL_WORLD_SIZE };
    const down = { x: 0, y: -1, z: 0 };

    const aim = pickTerrainCellByRay(mirror, origin, down);
    expect(aim).not.toBeNull();
    // The ray walks (11, 11); the pick names the diagonal owner.
    expect({ x: aim!.x, y: aim!.y }).toEqual({ x: 12, y: 12 });

    const band = carveBandOfPick(mirror.map, aim!, () => true);
    expect(band).toBe(PLATEAU_BAND);
    expect(carveReachCell(mirror, origin, down, band!)).toEqual({ x: 12, y: 12 });
  });

  it('answers nothing for a degenerate aim instead of marching forever', () => {
    const mirror = worldOf(() => bandLevelHeight(PLATEAU_BAND));
    const nowhere = { x: 0, y: 0, z: 0 };
    const nan = { x: Number.NaN, y: -1, z: 0 };
    expect(carveReachCell(mirror, AIM_ORIGIN, nowhere, PLATEAU_BAND)).toBeNull();
    expect(carveReachCell(mirror, AIM_ORIGIN, nan, PLATEAU_BAND)).toBeNull();
    // A ray parallel to the ground never meets it: the march is bounded, not endless.
    expect(
      carveReachCell(mirror, AIM_ORIGIN, { x: 1, y: 0, z: 0 }, PLATEAU_BAND + 6),
    ).toBeNull();
  });
});

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 600;
const CENTRE_X = VIEW_WIDTH / 2;
const CENTRE_Y = VIEW_HEIGHT / 2;

interface CarveKnobs {
  carveBand?: (pick: TerrainRayPick | null) => number | null;
  carveReach?: (origin: Vec3, direction: Vec3, band: number) => { x: number; y: number } | null;
  send?: (intent: SculptIntent) => SendOutcome;
}

function driveCarve(
  mirror: TerrainMirror,
  knobs: CarveKnobs = {},
): {
  input: SculptInput;
  sent: SculptIntent[];
  fire: (type: string, event?: Partial<PointerEvent>) => void;
  dispose: () => void;
} {
  const handlers = new Map<string, (event: Event) => void>();
  const listen = (type: string, fn: (event: Event) => void): void => {
    handlers.set(type, fn);
  };
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: VIEW_WIDTH, height: VIEW_HEIGHT }),
    addEventListener: listen,
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;

  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    addEventListener: listen,
    removeEventListener: () => {},
  };

  const camera = new PerspectiveCamera(60, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 5000);
  camera.position.set(worldX(ROW), worldY(bandLevelHeight(AIM_ORIGIN_BAND)), worldX(ROW));
  camera.lookAt(worldX(ROW), 0, worldX(ROW));
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
    carveBand: knobs.carveBand ?? (() => PLATEAU_BAND),
    carveReach: knobs.carveReach ?? (() => null),
    send: (intent) => {
      sent.push(intent);
      return knobs.send?.(intent) ?? 'sent';
    },
  });

  const fire = (type: string, event: Partial<PointerEvent> = {}): void => {
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

  fire('pointermove');

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

function flatWorld(): TerrainMirror {
  return worldOf(() => bandLevelHeight(PLATEAU_BAND));
}

describe('a held carve stroke', () => {
  const tool = brushTool();
  const radius = brushRadius();
  const mode = sculptMode();

  afterEach(() => {
    setBrushTool(tool);
    setBrushRadius(radius);
    setSculptMode(mode);
    vi.useRealTimers();
  });

  it('latches the band at the press and re-aims the reach every repeat', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    const mirror = flatWorld();
    const reaches = [
      { x: 10, y: ROW },
      { x: 11, y: ROW },
      { x: 12, y: ROW },
    ];
    let asked = 0;
    let offered = PLATEAU_BAND;
    const { input, sent, fire, dispose } = driveCarve(mirror, {
      carveBand: () => offered,
      carveReach: (_o, _d, band) => {
        expect(band).toBe(PLATEAU_BAND);
        return reaches[asked++] ?? null;
      },
    });
    try {
      fire('pointerdown');
      expect(sent).toHaveLength(1);
      expect(input.carveHeldBand()).toBe(PLATEAU_BAND);

      // The band never re-derives: a column the cut has changed cannot move it.
      offered = PLATEAU_BAND + 5;
      vi.advanceTimersByTime(repeatDelayMs(0) + repeatDelayMs(1) + repeatDelayMs(2));
      expect(input.carveHeldBand()).toBe(PLATEAU_BAND);
      expect(sent.map((i) => i.spanBand)).toEqual(new Array<number>(4).fill(PLATEAU_BAND));
      // The press anchors on the aim; the repeats walk inward with the reach.
      expect(sent.slice(1).map((i) => i.x)).toEqual([10, 11, 12]);
      for (const intent of sent) {
        expect(intent.tool).toBe('carve');
        expect(intent.dir).toBe(-1);
        expect(intent.profile).toBeUndefined();
      }
    } finally {
      dispose();
    }
  });

  it('is silent, with no blink, once the cut has broken through', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    const mirror = flatWorld();
    let reach: { x: number; y: number } | null = { x: 10, y: ROW };
    const { input, sent, fire, dispose } = driveCarve(mirror, { carveReach: () => reach });
    try {
      fire('pointerdown');
      vi.advanceTimersByTime(repeatDelayMs(0));
      expect(sent).toHaveLength(2);

      reach = null;
      let elapsed = 0;
      for (let tick = 1; tick <= SILENT_REPEAT_BLINK_AFTER * 3; tick++) {
        elapsed += repeatDelayMs(tick);
      }
      vi.advanceTimersByTime(elapsed);
      expect(sent).toHaveLength(2);
      expect(input.flatBlinks()).toBe(0);
      expect(input.offlineBlinks()).toBe(0);
      expect(input.carveHeldBand()).toBe(PLATEAU_BAND);
    } finally {
      dispose();
    }
  });

  it('keeps the latched band and sends nothing extra when the pointer moves', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    const mirror = flatWorld();
    const { input, sent, fire, dispose } = driveCarve(mirror, {
      carveReach: () => ({ x: 10, y: ROW }),
    });
    try {
      fire('pointerdown');
      expect(sent).toHaveLength(1);
      fire('pointermove', { clientX: CENTRE_X + 40, clientY: CENTRE_Y + 30 });
      expect(sent).toHaveLength(1);
      expect(input.carveHeldBand()).toBe(PLATEAU_BAND);
    } finally {
      dispose();
    }
  });

  it('blinks the flat cue once and sends nothing when the aim has no span', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    const mirror = flatWorld();
    const { input, sent, fire, dispose } = driveCarve(mirror, { carveBand: () => null });
    try {
      fire('pointerdown');
      expect(sent).toHaveLength(0);
      expect(input.flatBlinks()).toBe(1);
      expect(input.carveHeldBand()).toBeNull();
      vi.advanceTimersByTime(repeatDelayMs(0) + repeatDelayMs(1) + repeatDelayMs(2));
      expect(sent).toHaveLength(0);
      // One blink per silent repeat streak, not one per tick.
      expect(input.flatBlinks()).toBe(2);
    } finally {
      dispose();
    }
  });

  it('carves downward whatever the sticky mode says, and never writes it', () => {
    vi.useFakeTimers();
    setSculptMode('raise');
    setBrushTool('carve');
    const mirror = flatWorld();
    const { input, sent, fire, dispose } = driveCarve(mirror, {
      carveReach: () => ({ x: 10, y: ROW }),
    });
    try {
      fire('pointerdown', { shiftKey: true });
      vi.advanceTimersByTime(repeatDelayMs(0));
      fire('pointerup');
      expect(sent.length).toBeGreaterThan(1);
      for (const intent of sent) expect(intent.dir).toBe(-1);
      expect(sculptMode()).toBe('raise');
      expect(input.deadGuardHits()).toBe(0);
    } finally {
      dispose();
    }
  });

  it('taps once on touch, and a second finger drops the held band', () => {
    vi.useFakeTimers();
    setBrushTool('carve');
    const mirror = flatWorld();
    const { input, sent, fire, dispose } = driveCarve(mirror, {
      carveReach: () => ({ x: 10, y: ROW }),
    });
    try {
      fire('pointerdown', { pointerType: 'touch', pointerId: 7 });
      expect(sent).toHaveLength(0);
      fire('pointerup', { pointerType: 'touch', pointerId: 7 });
      expect(sent).toHaveLength(1);
      expect(input.carveHeldBand()).toBeNull();

      fire('pointerdown', { pointerType: 'touch', pointerId: 8 });
      vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS);
      expect(sent).toHaveLength(2);
      expect(input.carveHeldBand()).toBe(PLATEAU_BAND);
      fire('pointerdown', { pointerType: 'touch', pointerId: 9 });
      expect(input.carveHeldBand()).toBeNull();
      vi.advanceTimersByTime(repeatDelayMs(0) + repeatDelayMs(1));
      expect(sent).toHaveLength(2);
    } finally {
      dispose();
    }
  });
});

const CARVE_WALL_X = 34;
const CARVE_WALL_BAND = 20;

function wallWorld(): TerrainMirror {
  return worldOf((x) => (x >= CARVE_WALL_X ? bandLevelHeight(CARVE_WALL_BAND) : 0));
}

const carveIntent = (seq: number): SculptIntent => ({
  type: 'sculpt',
  x: CARVE_WALL_X,
  y: ROW,
  radius: 1,
  dir: -1,
  tool: 'carve',
  spanBand: PLATEAU_BAND,
  seq,
});

describe('predicting a carve', () => {
  it('dirties the chunk for a cut that leaves the cap where it was', () => {
    const mirror = wallWorld();
    const store = createPredictionStore(mirror);
    const capBefore = heightAt(mirror.map, CARVE_WALL_X, ROW);

    const dirty = store.predict(carveIntent(1), 0);

    expect(dirty.size).toBeGreaterThan(0);
    expect(heightAt(mirror.map, CARVE_WALL_X, ROW)).toBe(capBefore);
    expect(spanCount(mirror.map, CARVE_WALL_X, ROW)).toBe(2);
    expect(store.pendingCount()).toBe(1);
    expect(store.ghostSeqs()).toHaveLength(0);
  });

  it('holds the cut until the ack, and the authoritative spans land without a second cut', () => {
    const mirror = wallWorld();
    const store = createPredictionStore(mirror);
    store.predict(carveIntent(1), 0);

    const server = wallWorld();
    const cells = applySculpt(server.map, CARVE_WALL_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: PLATEAU_BAND,
    });
    expect(cells).toHaveLength(1);
    const authoritative = packColumnSpans(server.map, CARVE_WALL_X, ROW);

    store.applyCellDiff({ type: 'terrainDiff', cells }, 1);
    // A layered cut can never be confirmed by heights, so the ack is what releases it.
    expect(store.pendingCount()).toBe(1);
    expect(packColumnSpans(mirror.map, CARVE_WALL_X, ROW)).toEqual(authoritative);

    store.resolveSeq(1);
    expect(store.pendingCount()).toBe(0);
    expect(packColumnSpans(mirror.map, CARVE_WALL_X, ROW)).toEqual(authoritative);
    expect(heightAt(mirror.map, CARVE_WALL_X, ROW)).toBe(heightAt(server.map, CARVE_WALL_X, ROW));
  });
});

const CAVE_MOUTH_X = 33;
const CAVE_FLOOR_TOP = bandLevelHeight(6);
const CAVE_ROOF_BASE = bandLevelHeight(10);
const CAVE_ROOF_TOP = bandLevelHeight(20);

describe('a carve aimed at a cave ceiling', () => {
  it('opens the band the ceiling hangs at and leaves the floor below byte-untouched', () => {
    const mirror = worldOf(() => 0);
    for (let x = CAVE_MOUTH_X + 1; x <= CAVE_MOUTH_X + 4; x++) {
      setColumn(mirror.map, x, ROW, [
        { floor: BEDROCK_FLOOR, ceiling: CAVE_FLOOR_TOP },
        { floor: CAVE_ROOF_BASE, ceiling: CAVE_ROOF_TOP },
      ]);
    }
    const inside = CAVE_MOUTH_X + 1;
    const underside: TerrainRayPick = {
      x: inside,
      y: ROW,
      spanIndex: 1,
      face: 'underside',
      hitY: worldY(CAVE_ROOF_BASE),
      surfaceY: worldY(CAVE_ROOF_TOP),
      hitX: worldX(inside),
      hitZ: worldX(ROW),
    };

    const band = carveBandOfPick(mirror.map, underside, () => false);
    expect(band).toBe(PLATEAU_BAND);

    const floorBefore = spanAt(mirror.map, inside, ROW, 0);
    const diff = applySculpt(mirror.map, inside, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: band!,
    });

    expect(diff).toHaveLength(1);
    expect(spanAt(mirror.map, inside, ROW, 0)).toEqual(floorBefore);
    expect(spanAt(mirror.map, inside, ROW, 1).floor).toBeGreaterThan(CAVE_ROOF_BASE);
  });
});
