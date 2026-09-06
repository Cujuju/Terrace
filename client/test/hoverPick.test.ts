// THE HOVER-PICK CONTRACT (input/sculptInput.ts's hoverTarget, issue #324,
// 2026-09-04).
//
// CRITICAL PATH — what these pin is which CELL a held stroke edits and what a
// press is told about the ground there.
//
// The cache pins two things and only two: the CELL the player aimed at and the
// RAY that aimed at it. Everything else is re-derived from the LIVE map on
// every read, so a span index an edit renumbered, or a struck height the ground
// has moved away from, has no way to survive into the next frame.
//
// It used to patch a cached pick field by field after each edit, guarded by
// ad-hoc checks that each new kind of edit could defeat — the owner's
// 2026-09-04 report (a second carve press with the mouse still dug the band
// BELOW the one just cut) was one such escape.

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

/** Viewport the fake canvas reports; the centre pixel is NDC (0, 0). */
const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 600;
const CENTRE_X = VIEW_WIDTH / 2;
const CENTRE_Y = VIEW_HEIGHT / 2;

/** The cliff fixture: flat ground to the west, a wall from this cell eastward. */
const WALL_X = 32;
const AIM_Z = 20;
/** Ground height west of the wall, and the wall's own cap, in bands. */
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

/**
 * A `createSculptInput` wired to `mirror`, with the pointer parked on the
 * centre pixel and the camera aimed along `direction` from `origin`.
 *
 * The listener registration is captured rather than stubbed away: `pointermove`
 * is the only way to tell the module where the pointer is, and calling the
 * handler it registered is exactly what the browser does.
 */
function driveInput(
  mirror: TerrainMirror,
  origin: Vec3,
  lookAt: Vec3,
): {
  input: SculptInput;
  /** Every intent the input put on the wire, in order. */
  sent: SculptIntent[];
  /** Fires the handler the module registered, exactly as the browser would. */
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
    // THE REAL DERIVATIONS, against this mirror. `lipNear` is always false
    // because there is no overlay here, which is the D1 "interior floor"
    // answer — a tread carves nothing — and leaves riser hits answering
    // exactly as they do in the app.
    carveBand: (pick) => (pick === null ? null : carveBandOfPick(mirror.map, pick, () => false)),
    carveReach: (o, d, band) => carveReachCell(mirror, o, d, band),
    // PREDICTION IS NOT WIRED, so nothing here applies the cut: a test that
    // wants the terrain to change makes the change itself, through the same
    // shared `applySculpt` the server runs.
    send: (intent) => {
      sent.push(intent);
      return true;
    },
  });

  // Park the pointer on the centre pixel — NDC (0, 0), i.e. straight down the
  // camera's own forward axis, so the ray is exactly `origin → lookAt`.
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

/** World Y of a band boundary. */
const bandY = (bands: number): number => bands * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
/** World X/Z of a cell centre. */
const cellW = (cells: number): number => cells * CELL_WORLD_SIZE;

describe('hoverTarget pins the cell and re-derives the pick', () => {
  it('keeps the aimed cell when the ground under it is RAISED, and follows its new surface', () => {
    // The still-mouse RAISE. The 2026-08-22 promise: a held stroke targets the
    // cell the player aimed at — re-marching would walk it uphill into the
    // ground it just built (issue #25) — while the outline still lies on the
    // ground, which is the half a frozen pick got wrong.
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
      expect(before!.surfaceY).toBe(0);
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

  it('keeps the aimed cell when the ground is LOWERED clear of the ray', () => {
    // The still-mouse LOWER: the cap the ray met has dropped below it, so the
    // ray meets nothing in the column. A march would answer some cell further
    // on and the stroke would walk away from the player's aim; the fallback
    // answers with the ground still under the pinned ray.
    const mirror = flatWorld((x) => (x >= WALL_X ? BAND_HEIGHT * WALL_BAND : 0));
    // Aimed at the top of the wall from above and to the west.
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
      expect({ x: after!.x, y: after!.y }).toEqual(cell);
      // The tread of what is left: a horizontal face at the span's own cap.
      expect(after!.hitRiser).toBe(false);
      expect(after!.hitY).toBe(after!.surfaceY);
      expect(after!.surfaceY).toBe(0);
    } finally {
      dispose();
    }
  });

  it('does not name the band BELOW the cut after a carve opens the aimed band (#324)', () => {
    // THE REPRODUCTION. A riser hit at band k, carved so that band k is open;
    // the pinned ray now crosses the cell through that opening. The old cache
    // kept the riser claim and `bandOfPick` clamped it into the floor piece,
    // answering band k−1 — a second press with the mouse still dug the band
    // below the one just cut.
    //
    // The floor a carve leaves is level with the ground outside it (owner,
    // 2026-09-02), so the fixture puts the wall's foot at the ground's own
    // band: what is left after the cut is an interior floor with no lip beside
    // it, which is the case D1 says carves nothing.
    const mirror = flatWorld((x) =>
      x >= WALL_X ? BAND_HEIGHT * WALL_BAND : BAND_HEIGHT * GROUND_BAND,
    );
    // A level ray due east, half a band above the ground, into the wall's face.
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
      expect(struck!.hitRiser).toBe(true);
      const grabbed = resolvePick(mirror.map, struck!);
      // Band k: the face of band k spans [(k−1)·BH, k·BH], so a ray half a band
      // above boundary GROUND_BAND is on the face of the band above it.
      const k = GROUND_BAND + 1;
      expect(grabbed).toEqual({ face: 'riser', band: k });

      // The real cut, through the shared library the server runs: a carve
      // grasped at band k opens band k and floors the cut at (k−1)·BH. Radius
      // 1 because radius 0 has no footprint cells at all.
      const CARVE_RADIUS_CELLS = 1;
      applySculpt(mirror.map, struck!.x, struck!.y, CARVE_RADIUS_CELLS, -BAND_HEIGHT, {
        tool: 'carve',
        spanBand: k,
      });
      expect(mirror.map.columnSpans.size).toBeGreaterThan(0);

      const next = input.hoverTarget();
      expect(next).not.toBeNull();
      // THE CELL IS KEPT — that is what the cache promises.
      expect({ x: next!.x, y: next!.y }).toEqual({ x: struck!.x, y: struck!.y });
      // AND THE CLAIM IS HONEST: the ray now crosses the opening in air, so
      // this is the floor piece's TREAD, not a riser on a band that is gone.
      expect(next!.hitRiser).toBe(false);
      expect(next!.hitY).toBe(next!.surfaceY);
      expect(next!.spanIndex).toBe(0);

      // AND THE CARVE TAKES NOTHING THERE. The floor of the cut is level with
      // the ground outside, so band k−1 has no lip within reach of the point
      // the ray met the tread — the interior-floor case.
      const noLipInReach = (): boolean => false;
      expect(carveBandOfPick(mirror.map, next!, noLipInReach)).toBeNull();
      // Not k−1 by any route: the pick is not a riser claim any more.
      const asTread = resolvePick(mirror.map, next!);
      expect(asTread?.face).toBe('tread');
      expect(asTread?.band).toBe(k - 1);
    } finally {
      dispose();
    }
  });

  it('re-marches when the pinned column has nothing left under the ray', () => {
    // The column's chunk is gone (a rejoin between two reads). There is no
    // aimed-at cell left to keep faith with, so a fresh march is the answer.
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

// ── THE PIN DOES NOT OUTLIVE THE PRESS, AND A CARVE TUNNELS ALONG ITS AIM
//    (GH #349, owner 2026-09-05).
//
// The pin above is a promise about a stroke IN FLIGHT: issue #25 asks that a
// held stamp not march into the mound it is raising. Nothing released it, so
// with the mouse still it governed the next hover and the next click too — the
// crosshair sat below the pointer on the floor of the cut, and a second click
// was dead.
//
// A carve's BAND is frozen with its press for the same reason its tool is:
// re-deriving it per repeat asked about the very column the cut had just
// changed, and the answer walked to a band the player was not pointing at.

/** Restores the HUD signals these tests drive; they are module-level state. */
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
    // The half of the contract that must not regress: issue #25's promise
    // still holds for as long as the press does.
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
    // THE REPRODUCTION, as the owner saw it: two reads one click apart with the
    // mouse untouched. The cut opens the aimed band and the pinned ray then
    // crosses the cell through that opening, so while the pin stood the answer
    // stayed the wall cell and reported the floor of the cut. Released, the
    // same ray marches on and meets the wall's face one cell further in.
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
      expect(struck!.hitRiser).toBe(true);

      fire('pointerdown', {});
      const CARVE_RADIUS_CELLS = 1;
      applySculpt(mirror.map, WALL_X, struck!.y, CARVE_RADIUS_CELLS, -BAND_HEIGHT, {
        tool: 'carve',
        spanBand: GROUND_BAND + 1,
      });
      // Still pressed: the cell is kept.
      expect(input.hoverTarget()!.x).toBe(WALL_X);

      fire('pointerup', {});
      const after = input.hoverTarget();
      expect(after).not.toBeNull();
      // THE PIN IS GONE: the ray passes through the opening and strikes the
      // next wall cell in, which is where the pointer is genuinely aimed.
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
    // The measured failure of re-picking: after the cut the ray meets the
    // hole's own floor inside the SAME cell, so a repeat that asked "what
    // surface is here" re-cut an open band and moved nothing. Asking "what is
    // still solid at this band" walks past the hole instead.
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
      // Every repeat removes something: the band it named was solid.
      expect(spanIndexCoveringBand(mirror.map, reach!.x, reach!.y, k)).toBeNull();
    }
    // ONE CELL PER REPEAT, straight along the aim — the tunnel.
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

  /** Applies the last intent through the same shared math the server runs. */
  const applyLast = (mirror: TerrainMirror, sent: readonly SculptIntent[]): void => {
    const intent = sent[sent.length - 1]!;
    applySculpt(mirror.map, intent.x, intent.y, intent.radius, -BAND_HEIGHT, {
      tool: 'carve',
      spanBand: intent.spanBand ?? null,
    });
  };

  it('cuts the SAME band at consecutive cells, never the band above', () => {
    // The owner, 2026-09-05: "Why would I get a different band when I'm still
    // explicitly pointing at band three?" Before this, each repeat re-derived
    // the band from a column the previous repeat had just opened, met the
    // ceiling that cut exposed, and named the roof's lowest drawn band — the
    // "band three and four missing" report of the same day.
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
        // THE RAMP'S OWN SCHEDULE, repeat by repeat. A fixed advance would
        // overshoot: each delay is shorter than the last (repeatDelayMs), so
        // stepping by the first one fires two repeats in a later iteration.
        vi.advanceTimersByTime(repeatDelayMs(repeat));
        applyLast(mirror, sent);
      }

      expect(sent).toHaveLength(4);
      // THE BAND NEVER MOVES.
      expect(sent.map((i) => i.spanBand)).toEqual([k, k, k, k]);
      // AND THE CUT WALKS INWARD, one cell per repeat.
      expect(sent.map((i) => i.x)).toEqual([WALL_X, WALL_X + 1, WALL_X + 2, WALL_X + 3]);
      expect(sent.every((i) => i.tool === 'carve')).toBe(true);
    } finally {
      dispose();
    }
  });

  it('emits nothing once the band it pressed on runs out along the aim', () => {
    // "Cut through this band until there's no more cutting and then you stop"
    // (owner, 2026-09-05). A one-cell-thick wall: the press cuts it, and the
    // repeat finds nothing solid left at that band and sends nothing — which
    // also costs no mana, since a carve is priced from its radius alone and
    // deliberately never reads the terrain (shared/src/heightmap.ts).
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
});
