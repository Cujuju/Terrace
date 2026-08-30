// The draw-call budget's contract (part B of
// docs/plans/frame-budget-growth-and-draw-calls.md).
//
// THE DEFECT IT ANSWERS: every plugin gets a Group under the scene and adds
// whatever it likes, and nothing counted — so the frame's draw calls were spent
// by whichever population happened to be largest at the moment (measured on the
// owner's world: 197 calls → 1.55 ms of idle `renderer.render`, 340 calls →
// 3.10 ms, 44 % of a 140 fps frame's 7.1 ms budget at idle).
//
// These test the CONTRACT — the counting rule, the hysteresis, the total — and
// not the callsites. The per-plugin numbers are pinned by the registry test at
// the bottom, which is a statement about the runtime shape rather than the
// compile-time one the type already enforces.

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
import { FPS_SAMPLE_INTERVAL_MS } from '../src/config.ts';
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
    // VISIBILITY IS INHERITED in three's projectObject, and hiding a subtree
    // root is how several plugins park a whole rig (pilgrims' model.root,
    // temples' standing/ghost, monsters' atmosphere).
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
    // Three skips a draw with `primcount === 0`, and parking a pool at 0 is
    // exactly how flora, fire, storms and mudslides idle — a pool counted as
    // one object while empty would make every such plugin look permanently
    // busy.
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
  /** Comfortably under the clear margin. */
  const LOW = Math.floor(BUDGET * (1 - DRAW_BUDGET_CLEAR_MARGIN)) - 1;

  it('does not breach under budget', () => {
    expect(stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, LOW, BUDGET).breached).toBe(false);
  });

  it('breaches on the FIRST sample at the budget', () => {
    // AT, not over: a budget is a ceiling, and reaching it is already the
    // failure the developer has to see.
    expect(stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, BUDGET, BUDGET).breached).toBe(true);
  });

  it('does not clear after a single low sample', () => {
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, BUDGET, BUDGET);
    state = stepDrawBudgetBreach(state, LOW, BUDGET);
    expect(state.breached).toBe(true);
  });

  it('clears after DRAW_BUDGET_CLEAR_SAMPLES consecutive samples under the margin', () => {
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, BUDGET, BUDGET);
    for (let i = 0; i < DRAW_BUDGET_CLEAR_SAMPLES; i++) {
      state = stepDrawBudgetBreach(state, LOW, BUDGET);
    }
    expect(state.breached).toBe(false);
  });

  it('a sample between the margin and the budget restarts the count', () => {
    // ONE SAMPLE OF POPULATION NOISE MUST NOT CLEAR A BREACH. A plugin sitting
    // just under its budget is still the plugin that breached.
    const nearBudget = BUDGET - 1;
    expect(nearBudget).toBeGreaterThan(BUDGET * (1 - DRAW_BUDGET_CLEAR_MARGIN));
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, BUDGET, BUDGET);
    state = stepDrawBudgetBreach(state, LOW, BUDGET);
    state = stepDrawBudgetBreach(state, nearBudget, BUDGET);
    expect(state.breached).toBe(true);
    // And the count really restarted: one more low sample is not enough.
    state = stepDrawBudgetBreach(state, LOW, BUDGET);
    expect(state.breached).toBe(true);
  });

  it('treats a missing or non-finite budget as a breach that cannot clear', () => {
    // A plugin loaded at runtime (design Q6) is not held to the compile-time
    // type, so "no budget declared" has to be a runtime failure too.
    const missing = undefined as unknown as number;
    let state = stepDrawBudgetBreach(NO_DRAW_BUDGET_BREACH, 0, missing);
    expect(state.breached).toBe(true);
    state = stepDrawBudgetBreach(state, 0, missing);
    state = stepDrawBudgetBreach(state, 0, missing);
    expect(state.breached).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The frame total, against a real host. Stubs stand in for the two things a
// node process cannot have — a WebGLRenderer and its canvas — and nothing else:
// the scene, the layers and the plugins are the real ones.
// -----------------------------------------------------------------------------

function stubViewport(calls = 0) {
  const scene = new Scene();
  const listeners = new Set<() => void>();
  const canvas = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return {
    viewport: {
      scene,
      renderer: { domElement: canvas, info: { render: { calls } } },
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
    // MOUNTED ≠ REGISTERED. A world running only one of the two plugins must
    // not license the other's draw calls.
    const h = host();
    h.syncLivePlugins(['alpha']);
    expect(h.frameDrawBudget()).toBe(CORE + 10);
    h.syncLivePlugins(['alpha', 'beta']);
    expect(h.frameDrawBudget()).toBe(CORE + 10 + 25);
    h.syncLivePlugins([]);
    expect(h.frameDrawBudget()).toBe(CORE);
  });

  it('leaves a non-finite budget out of the total rather than poisoning it', () => {
    // It is a breach in its own row; adding NaN would destroy the one number
    // the whole frame is judged by.
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

// THE REGISTRY-DRIVEN TEST IS NOT HERE, and that is a limit of the harness
// rather than a decision. B6 asks for "every registered plugin's drawBudget is
// finite", which means importing plugins/registry.ts — and that pulls in every
// plugin's client half, several of which import Solid `.tsx` panels that this
// package's vitest transform does not handle for files outside client/
// (verified: `plugins/chronicle/client/ChroniclePanel.tsx` fails
// vite:import-analysis). What covers the same ground meanwhile: the TYPE makes
// the field mandatory on `CLIENT_PLUGINS`, so a plugin cannot be registered
// without one, and "a missing or non-finite budget is itself a breach" above
// covers the runtime-loaded case the type cannot reach.

describe("the host's sampler", () => {
  /** A plugin that fills its layer with `objects` meshes at attach. */
  function filler(name: string, drawBudget: number, objects: number): TerraceClientPlugin {
    return {
      name,
      drawBudget,
      attach(ctx) {
        for (let i = 0; i < objects; i++) ctx.layer.add(mesh());
      },
    };
  }

  function rig(plugin: TerraceClientPlugin, calls = 7) {
    const view = stubViewport(calls);
    let clockMs = 0;
    const host = createClientPluginHost([plugin], {
      viewport: view.viewport,
      world: stubWorld,
      connection: () => ({}) as unknown as Connection,
      coreDrawBudget: () => 0,
      now: () => clockMs,
    });
    /** One sampling window's worth of frames. */
    const window = (): void => {
      clockMs += FPS_SAMPLE_INTERVAL_MS;
      view.frame();
    };
    return { host, window, view, frame: view.frame };
  }

  // The rows are a module-scope signal, exactly like the panels beside them, so
  // one test's published rows would otherwise be the next one's starting state.
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

    // Still over budget on the next window, and still one line: a message per
    // sample would bury the console it is trying to be read in.
    window();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
