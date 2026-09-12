import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BufferGeometry,
  Group,
  InstancedMesh,
  Line,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  Scene,
  Sprite,
} from 'three';
import {
  countDrawObjects,
  createClientPluginHost,
  stepDrawBudgetBreach,
  DRAW_BUDGET_CLEAR_MARGIN,
  DRAW_BUDGET_CLEAR_SAMPLES,
  NO_DRAW_BUDGET_BREACH,
} from '../src/plugins/host.ts';
import { pluginDrawRows, setPluginDrawRows } from '../src/plugins/hudPanels.ts';
import { frameDraw } from '../src/state/hudState.ts';
import { FPS_SAMPLE_INTERVAL_MS, FRAME_STATS_WINDOW_MS } from '../src/config.ts';
import { recordFrame, resetFrameStats, setFrameCounterSource } from '../src/render/frameStats.ts';
import type { TerraceClientPlugin } from '../src/plugins/types.ts';
import type { Viewport } from '../src/render/scene.ts';
import type { World } from '../src/world.ts';
import type { Connection } from '../src/net/connection.ts';

const material = new MeshBasicMaterial();

function mesh(): Mesh {
  return new Mesh(new BufferGeometry(), material);
}

describe('countDrawObjects', () => {
  it('counts one per Mesh, Line, Points and Sprite', () => {
    const root = new Group();
    root.add(mesh());
    root.add(new Line(new BufferGeometry(), material));
    root.add(new LineSegments(new BufferGeometry(), material));
    root.add(new Points(new BufferGeometry(), material));
    root.add(new Sprite());
    expect(countDrawObjects(root)).toBe(5);
  });

  it('counts a Group as nothing and walks into it', () => {
    const root = new Group();
    const inner = new Group();
    inner.add(mesh(), mesh());
    root.add(inner);
    expect(countDrawObjects(root)).toBe(2);
  });

  it('counts nothing under an invisible node, however visible its children', () => {
    const root = new Group();
    const hidden = new Group();
    hidden.visible = false;
    const child = mesh();
    child.visible = true;
    hidden.add(child);
    root.add(hidden);
    expect(countDrawObjects(root)).toBe(0);
  });

  it('counts an invisible mesh as nothing', () => {
    const root = new Group();
    const hidden = mesh();
    hidden.visible = false;
    root.add(hidden);
    expect(countDrawObjects(root)).toBe(0);
  });

  it('counts an InstancedMesh as ONE however many instances, and none at count 0', () => {
    const root = new Group();
    const parked = new InstancedMesh(new BufferGeometry(), material, 32);
    parked.count = 0;
    root.add(parked);
    expect(countDrawObjects(root)).toBe(0);

    const busy = new InstancedMesh(new BufferGeometry(), material, 32);
    busy.count = 5;
    root.add(busy);
    expect(countDrawObjects(root)).toBe(1);
  });

  it('counts a geometry with an empty draw range as nothing', () => {
    const root = new Group();
    const empty = mesh();
    empty.geometry.setDrawRange(0, 0);
    root.add(empty);
    expect(countDrawObjects(root)).toBe(0);
  });
});

describe('the draw-budget breach hysteresis', () => {
  const BUDGET = 100;
  const OVER = BUDGET + 1;
  const LOW = Math.floor(BUDGET * (1 - DRAW_BUDGET_CLEAR_MARGIN)) - 1;
  const AT_MARGIN = BUDGET * (1 - DRAW_BUDGET_CLEAR_MARGIN);

  it('does not breach under budget', () => {
    expect(stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, LOW, BUDGET).breached).toBe(false);
  });

  it('does not breach a plugin sitting at EXACTLY its budget', () => {
    expect(stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, BUDGET, BUDGET).breached).toBe(false);
  });

  it('breaches on the FIRST sample OVER the budget', () => {
    expect(stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, OVER, BUDGET).breached).toBe(true);
  });

  it('leaves a plugin that draws nothing against a budget of 0 healthy', () => {
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, 0, 0);
    expect(state.breached).toBe(false);
    state = stepDrawBudgetBreach(state, 0, 0);
    expect(state.breached).toBe(false);
  });

  it('breaches a zero-budget plugin that draws anything, and lets it clear', () => {
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, 1, 0);
    expect(state.breached).toBe(true);
    for (let i = 0; i < DRAW_BUDGET_CLEAR_SAMPLES; i++) {
      state = stepDrawBudgetBreach(state, 0, 0);
    }
    expect(state.breached).toBe(false);
  });

  it('does not clear after a single low sample', () => {
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, OVER, BUDGET);
    state = stepDrawBudgetBreach(state, LOW, BUDGET);
    expect(state.breached).toBe(true);
  });

  it('clears after DRAW_BUDGET_CLEAR_SAMPLES consecutive samples under the margin', () => {
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, OVER, BUDGET);
    for (let i = 0; i < DRAW_BUDGET_CLEAR_SAMPLES; i++) {
      state = stepDrawBudgetBreach(state, LOW, BUDGET);
    }
    expect(state.breached).toBe(false);
  });

  it('clears on samples sitting exactly ON the clear margin', () => {
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, OVER, BUDGET);
    for (let i = 0; i < DRAW_BUDGET_CLEAR_SAMPLES; i++) {
      state = stepDrawBudgetBreach(state, AT_MARGIN, BUDGET);
    }
    expect(state.breached).toBe(false);
  });

  it('a sample between the margin and the budget restarts the count', () => {
    const nearBudget = BUDGET - 1;
    expect(nearBudget).toBeGreaterThan(BUDGET * (1 - DRAW_BUDGET_CLEAR_MARGIN));
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, OVER, BUDGET);
    state = stepDrawBudgetBreach(state, LOW, BUDGET);
    state = stepDrawBudgetBreach(state, nearBudget, BUDGET);
    expect(state.breached).toBe(true);
    state = stepDrawBudgetBreach(state, LOW, BUDGET);
    expect(state.breached).toBe(true);
  });

  it('treats a missing or non-finite budget as a breach that cannot clear', () => {
    const missing = undefined as unknown as number;
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, 0, missing);
    expect(state.breached).toBe(true);
    state = stepDrawBudgetBreach(state, 0, missing);
    state = stepDrawBudgetBreach(state, 0, missing);
    expect(state.breached).toBe(true);
  });
});

function stubViewport() {
  const scene = new Scene();
  const listeners = new Set<() => void>();
  const canvas = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return {
    viewport: {
      scene,
      renderer: { domElement: canvas, backend: {} },
      onFrame: (handler: () => void) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    } as unknown as Viewport,
    scene,
    frame: (): void => {
      for (const handler of listeners) handler();
    },
  };
}

const stubWorld = {
  worldSize: () => 0,
  terrainMesherActive: () => 'cpu',
  terrainHeightAt: () => null,
  drawnGroundYAt: () => null,
  pickCell: () => null,
} as unknown as World;

function testPlugin(name: string, drawBudget: number): TerraceClientPlugin {
  return { name, drawBudget, attach: () => undefined };
}

describe("the frame's draw budget", () => {
  const CORE = 40;
  const host = () =>
    createClientPluginHost([testPlugin('alpha', 10), testPlugin('beta', 25)], {
      viewport: stubViewport().viewport,
      world: stubWorld,
      connection: () => ({}) as unknown as Connection,
      coreDrawBudget: () => CORE,
    });

  it('is core plus every mounted plugin', () => {
    expect(host().frameDrawBudget()).toBe(CORE + 10 + 25);
  });

  it('follows syncLivePlugins, not the compiled-in registry', () => {
    const h = host();
    h.syncLivePlugins(['alpha']);
    expect(h.frameDrawBudget()).toBe(CORE + 10);
    h.syncLivePlugins(['alpha', 'beta']);
    expect(h.frameDrawBudget()).toBe(CORE + 10 + 25);
    h.syncLivePlugins([]);
    expect(h.frameDrawBudget()).toBe(CORE);
  });

  it('leaves a non-finite budget out of the total rather than poisoning it', () => {
    const missing = undefined as unknown as number;
    const h = createClientPluginHost([testPlugin('ghost', missing)], {
      viewport: stubViewport().viewport,
      world: stubWorld,
      connection: () => ({}) as unknown as Connection,
      coreDrawBudget: () => CORE,
    });
    expect(h.frameDrawBudget()).toBe(CORE);
  });
});

describe("the host's sampler", () => {
  function filler(name: string, drawBudget: number, objects: number): TerraceClientPlugin {
    return {
      name,
      drawBudget,
      attach(ctx) {
        for (let i = 0; i < objects; i++) ctx.layer.add(mesh());
      },
    };
  }

  function rig(plugin: TerraceClientPlugin, drawCalls = 7) {
    const view = stubViewport();
    resetFrameStats();
    setFrameCounterSource(() => ({
      pixelWidth: 0,
      pixelHeight: 0,
      cameraDistance: 0,
      drawCalls,
      triangles: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    }));
    recordFrame(0, 0, FRAME_STATS_WINDOW_MS);
    let clockMs = 0;
    const host = createClientPluginHost([plugin], {
      viewport: view.viewport,
      world: stubWorld,
      connection: () => ({}) as unknown as Connection,
      coreDrawBudget: () => 0,
      now: () => clockMs,
    });
    const window = (): void => {
      clockMs += FPS_SAMPLE_INTERVAL_MS;
      view.frame();
    };
    return { host, window, view, frame: view.frame };
  }

  beforeEach(() => {
    setPluginDrawRows([]);
  });

  it('publishes a row per mounted plugin and the frame total, once per window', () => {
    const { window } = rig(filler('alpha', 10, 3));
    expect(pluginDrawRows()).toEqual([]);

    window();

    expect(pluginDrawRows()).toEqual([
      { pluginName: 'alpha', objects: 3, budget: 10, breached: false },
    ]);
    expect(frameDraw()).toEqual({ calls: 7, objects: 3, budget: 10 });
  });

  it('samples nothing before the window has elapsed', () => {
    const { frame } = rig(filler('alpha', 10, 3));
    frame();
    frame();
    expect(pluginDrawRows()).toEqual([]);
  });

  it('marks a breach, logs it ONCE per transition, and names the numbers', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { window } = rig(filler('alpha', 2, 3));

    window();
    expect(pluginDrawRows()[0]?.breached).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain('alpha');
    expect(message).toContain('3');
    expect(message).toContain('2');

    window();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
