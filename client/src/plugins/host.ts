import type { SculptIntent } from '@terrace/shared';
import { Group, Raycaster, Vector2, type Intersection, type Object3D } from 'three';
import type { Component } from 'solid-js';
import { FPS_SAMPLE_INTERVAL_MS } from '../config.ts';
import { createAudioEngine } from '../audio/audioEngine.ts';
import type { Connection } from '../net/connection.ts';
import { rendererBackendName, type FramePhase, type Viewport } from '../render/scene.ts';
import { loadRigAsset } from '../render/rigAsset.ts';
import { frameStatsSample, recordPluginFrame } from '../render/frameStats.ts';
import { applySkyRig, type SkyRigState } from '../render/skyRig.ts';
import {
  clearGroundShade,
  configureGroundShade,
  groundShadeMaxFor,
  setGroundShade,
} from '../render/groundShade.ts';
import { setFrameDraw, setRenderPath } from '../state/hudState.ts';
import { pointerToNdc, worldPointToCell, type CellOccupancy } from '../terrain/picking.ts';
import type { World } from '../world.ts';
import {
  addPluginHudPanel,
  claimWorldHeaderAction,
  releaseWorldHeaderAction,
  removePluginDrawRow,
  removePluginHudPanels,
  setPluginDrawRows,
  type PluginDrawRow,
} from './hudPanels.ts';
import { addPluginTool, removePluginTools } from './toolbar.ts';
import type {
  ClientPluginCtx,
  GroundShadeDisc,
  MoverPose,
  TerraceClientPlugin,
  WorldPosition,
} from './types.ts';

export function countDrawObjects(root: Object3D): number {
  if (!root.visible) return 0;
  const node = root as Object3D & {
    isMesh?: boolean;
    isLine?: boolean;
    isPoints?: boolean;
    isSprite?: boolean;
    isInstancedMesh?: boolean;
    count?: number;
    geometry?: { drawRange?: { count: number } };
  };
  let drawn = 0;
  if (
    node.isMesh === true ||
    node.isLine === true ||
    node.isPoints === true ||
    node.isSprite === true
  ) {
    const emptyInstances = node.isInstancedMesh === true && (node.count ?? 0) <= 0;
    const drawRange = node.geometry?.drawRange;
    const emptyRange = drawRange !== undefined && drawRange.count === 0;
    if (!emptyInstances && !emptyRange) drawn = 1;
  }
  for (const child of root.children) drawn += countDrawObjects(child);
  return drawn;
}

export const DRAW_BUDGET_CLEAR_SAMPLES = 2;

export const DRAW_BUDGET_CLEAR_MARGIN = 0.1;

export interface DrawBudgetBreachState {
  readonly breached: boolean;
  readonly lowSamples: number;
}

export const NO_DRAW_BUDGET_BREACH: DrawBudgetBreachState = {
  breached: false,
  lowSamples: 0,
};

export function stepDrawBudgetBreach(
  state: DrawBudgetBreachState,
  objects: number,
  budget: number,
): DrawBudgetBreachState {
  if (!Number.isFinite(budget)) return { breached: true, lowSamples: 0 };
  if (objects > budget) return { breached: true, lowSamples: 0 };
  if (!state.breached) return NO_DRAW_BUDGET_BREACH;
  if (objects > budget * (1 - DRAW_BUDGET_CLEAR_MARGIN)) {
    return { breached: true, lowSamples: 0 };
  }
  const lowSamples = state.lowSamples + 1;
  return lowSamples >= DRAW_BUDGET_CLEAR_SAMPLES
    ? NO_DRAW_BUDGET_BREACH
    : { breached: true, lowSamples };
}

export interface ClientPluginHost {
  routeMessage(type: string, payload: unknown): void;
  allowLocalIntent(intent: SculptIntent): boolean;
  syncLivePlugins(liveNames: readonly string[] | undefined): void;
  frameDrawBudget(): number;
  dispose(): void;
}

export function createClientPluginHost(
  plugins: readonly TerraceClientPlugin[],
  deps: {
    viewport: Viewport;
    world: World;
    connection: () => Connection;
    coreDrawBudget: () => number;
    now?: () => number;
  },
): ClientPluginHost {
  const { viewport, world } = deps;

  const handlers = new Map<string, Set<(payload: unknown) => void>>();

  interface MountedPlugin {
    readonly plugin: TerraceClientPlugin;
    readonly layer: Group;
    readonly undo: (() => void)[];
  }

  const mounted = new Map<string, MountedPlugin>();

  const mountGenerations = new Map<string, number>();

  const pendingMounts = new Set<string>();

  const breachStates = new Map<string, DrawBudgetBreachState>();

  const canvas = viewport.renderer.domElement;

  const audioEngine = createAudioEngine(viewport);

  const pressHandlers: ((event: PointerEvent) => boolean)[] = [];
  const localIntentHandlers: ((intent: SculptIntent) => boolean)[] = [];

  let skyRigClaimant: string | null = null;

  const skyRigRefusals = new Set<string>();

  const skyRigModifiers: ((state: SkyRigState) => SkyRigState)[] = [];

  const onCanvasPointerDown = (event: PointerEvent): void => {
    audioEngine.unlock();
    for (const handler of pressHandlers) {
      let claimed = false;
      try {
        claimed = handler(event);
      } catch (error) {
        console.error('[terrace] plugin canvas-press handler threw', error);
      }
      if (claimed) {
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
      }
    }
  };
  canvas.addEventListener('pointerdown', onCanvasPointerDown, { capture: true });

  const pickTerrainCell = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const size = world.worldSize();
    if (size <= 0) return null;
    const device = pointerToNdc(clientX, clientY, canvas.getBoundingClientRect());
    if (device === null) return null;
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(device.x, device.y), viewport.camera);
    const hit = world.pickCell(raycaster.ray.origin, raycaster.ray.direction);
    return hit === null ? null : { x: hit.x, y: hit.y };
  };

  const pickableObjects: Object3D[] = [];

  const pickableOccupancy: CellOccupancy[] = [];

  const NO_OCCUPANTS: readonly CellOccupancy[] = [];

  const cameraScratch = { x: 0, y: 0, z: 0 };
  const cameraPosition = (): WorldPosition => {
    const position = viewport.camera.position;
    cameraScratch.x = position.x;
    cameraScratch.y = position.y;
    cameraScratch.z = position.z;
    return cameraScratch;
  };

  const pickRaycaster = new Raycaster();
  const pickNdc = new Vector2();

  const pickWorldCell = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const size = world.worldSize();
    if (size <= 0) return null;

    const device = pointerToNdc(clientX, clientY, canvas.getBoundingClientRect());
    if (device === null) return null;
    pickRaycaster.setFromCamera(pickNdc.set(device.x, device.y), viewport.camera);
    const ray = pickRaycaster.ray;

    const onCanvas = device.x >= -1 && device.x <= 1 && device.y >= -1 && device.y <= 1;

    const pointed = world.pickPointedCell(
      ray.origin,
      ray.direction,
      onCanvas ? pickableOccupancy : NO_OCCUPANTS,
    );

    if (onCanvas && pickableObjects.length > 0) {
      pickRaycaster.far = pointed === null ? Infinity : pointed.distance;
      const hits: Intersection[] = pickRaycaster.intersectObjects(pickableObjects, true);
      for (const hit of hits) {
        const cell = worldPointToCell(hit.point.x, hit.point.z, size);
        if (cell !== null) return { x: cell.x, y: cell.y };
      }
    }

    return pointed === null ? null : { x: pointed.x, y: pointed.y };
  };

  const moverLookups = new Map<string, (id: number) => MoverPose | null>();

  const gaugeLookups = new Map<string, () => number>();

  const groundShadeLookups = new Map<string, () => readonly GroundShadeDisc[]>();

  const groundShadeBreaches = new Set<string>();

  const gatheredShade: GroundShadeDisc[] = [];

  const gatherGroundShade = (): void => {
    if (groundShadeLookups.size === 0) {
      clearGroundShade();
      return;
    }
    gatheredShade.length = 0;
    for (const [name, lookup] of groundShadeLookups) {
      const entry = mounted.get(name);
      if (entry === undefined) continue;
      let discs: readonly GroundShadeDisc[];
      try {
        discs = lookup();
      } catch (error) {
        console.error(`[terrace] client plugin "${name}" threw publishing ground shade`, error);
        continue;
      }
      const declared = entry.plugin.groundShadeBudget;
      const budget =
        declared !== undefined && Number.isFinite(declared) && declared > 0 ? declared : 0;
      if (discs.length > budget && !groundShadeBreaches.has(name)) {
        groundShadeBreaches.add(name);
        console.error(
          `[terrace] client plugin "${name}" is over its ground-shade budget: ` +
            `${String(discs.length)} discs against a budget of ${String(budget)}; ` +
            `the excess is dropped`,
        );
      }
      for (let i = 0; i < discs.length && i < budget; i++) gatheredShade.push(discs[i]);
    }
    setGroundShade(viewport.lighting.sun.position, gatheredShade);
  };

  const moverPose = (pluginName: string, id: number): MoverPose | null => {
    const lookup = moverLookups.get(pluginName);
    if (lookup === undefined) return null;
    try {
      return lookup(id);
    } catch {
      return null;
    }
  };

  const gauge = (pluginName: string, key: string): number | null => {
    const read = gaugeLookups.get(`${pluginName}:${key}`);
    if (read === undefined) return null;
    try {
      return read();
    } catch {
      return null;
    }
  };

  interface DeferredFrameHandler {
    readonly handler: (dt: number) => void;
    unregister: (() => void) | null;
    cancelled: boolean;
  }

  const mountPlugin = (plugin: TerraceClientPlugin): void => {
    const undo: (() => void)[] = [];
    const track = (unregister: () => void): (() => void) => {
      undo.push(unregister);
      return unregister;
    };
    const deferredFrameHandlers: DeferredFrameHandler[] = [];
    const layer = new Group();
    layer.name = `plugin:${plugin.name}`;
    viewport.scene.add(layer);

    const audioHandle = audioEngine.forPlugin(plugin.name);
    track(audioHandle.release);

    const ctx: ClientPluginCtx = {
      layer,
      audio: audioHandle.audio,
      worldSize: () => world.worldSize(),
      terrainHeightAt: (x, y) => world.terrainHeightAt(x, y),
      terrainRevisionAt: (x, y) => world.terrainRevisionAt(x, y),
      drawnGroundYAt: (cellX, cellZ) => world.drawnGroundYAt(cellX, cellZ),
      onMessage(type, handler) {
        const key = `${plugin.name}:${type}`;
        let set = handlers.get(key);
        if (set === undefined) {
          set = new Set();
          handlers.set(key, set);
        }
        set.add(handler);
        return track(() => {
          set.delete(handler);
          if (set.size === 0) handlers.delete(key);
        });
      },
      send(type, payload) {
        deps.connection().sendPlugin(`${plugin.name}:${type}`, payload);
      },
      onFrame(handler) {
        const deferred: DeferredFrameHandler = { handler, unregister: null, cancelled: false };
        deferredFrameHandlers.push(deferred);
        return track(() => {
          deferred.cancelled = true;
          deferred.unregister?.();
          deferred.unregister = null;
        });
      },
      registerHudPanel(
        component: Component,
        options?: {
          placement?:
            | 'panel'
            | 'top-center'
            | 'bottom-center'
            | 'bottom-right'
            | 'connection'
            | 'settings';
          headerSummary?: Component;
          tabSummary?: () => string;
          hasBody?: () => boolean;
        },
      ) {
        addPluginHudPanel({
          pluginName: plugin.name,
          component,
          placement: options?.placement ?? 'panel',
          headerSummary: options?.headerSummary,
          tabSummary: options?.tabSummary,
          hasBody: options?.hasBody,
        });
      },
      registerTool(tool) {
        addPluginTool({ ...tool, id: `${plugin.name}:${tool.id}`, pluginName: plugin.name });
      },
      registerWorldHeaderAction(action) {
        claimWorldHeaderAction({ ...action, pluginName: plugin.name });
      },
      onCanvasPress(handler) {
        pressHandlers.push(handler);
        return track(() => {
          const i = pressHandlers.indexOf(handler);
          if (i !== -1) pressHandlers.splice(i, 1);
        });
      },
      pickTerrainCell,
      pickWorldCell,
      cameraPosition,
      moverPose,
      revealedAt: (x, y) => world.revealedAt(x, y),
      applyRevealClip: (material, label) => world.applyRevealClip(material, label),
      revealClipUniforms: () => world.revealClipUniforms(),
      publishGroundShade(lookup: () => readonly GroundShadeDisc[]): () => void {
        groundShadeLookups.set(plugin.name, lookup);
        return track(() => {
          if (groundShadeLookups.get(plugin.name) === lookup) {
            groundShadeLookups.delete(plugin.name);
          }
        });
      },
      gauge,
      publishGauge(key: string, read: () => number): () => void {
        const id = `${plugin.name}:${key}`;
        gaugeLookups.set(id, read);
        return track(() => {
          if (gaugeLookups.get(id) === read) gaugeLookups.delete(id);
        });
      },
      publishMovers(lookup: (id: number) => MoverPose | null): () => void {
        moverLookups.set(plugin.name, lookup);
        return track(() => {
          if (moverLookups.get(plugin.name) === lookup) moverLookups.delete(plugin.name);
        });
      },
      markPickable(object: Object3D, occupancy?: CellOccupancy): () => void {
        if (occupancy !== undefined) {
          pickableOccupancy.push(occupancy);
          return track(() => {
            const index = pickableOccupancy.indexOf(occupancy);
            if (index !== -1) pickableOccupancy.splice(index, 1);
          });
        }
        if (!pickableObjects.includes(object)) pickableObjects.push(object);
        return track(() => {
          const index = pickableObjects.indexOf(object);
          if (index !== -1) pickableObjects.splice(index, 1);
        });
      },
      onLocalIntent(handler) {
        localIntentHandlers.push(handler);
        return track(() => {
          const i = localIntentHandlers.indexOf(handler);
          if (i !== -1) localIntentHandlers.splice(i, 1);
        });
      },
      setSkyRig(state: SkyRigState) {
        if (skyRigClaimant === null) skyRigClaimant = plugin.name;
        if (skyRigClaimant !== plugin.name) {
          if (!skyRigRefusals.has(plugin.name)) {
            skyRigRefusals.add(plugin.name);
            console.warn(
              `sky rig already claimed by "${skyRigClaimant}"; ` +
                `ignoring updates from "${plugin.name}"`,
            );
          }
          return;
        }
        let modulated = state;
        for (const modify of skyRigModifiers) {
          try {
            modulated = modify(modulated);
          } catch (error) {
            console.error('[terrace] plugin sky-rig modifier threw', error);
          }
        }
        applySkyRig(viewport, modulated);
      },
      loadRigAsset(url, lighting) {
        return loadRigAsset(
          url,
          lighting === 'sky-environment' ? viewport.skyEnvironment.texture : null,
        );
      },
      modulateSkyRig(modify: (state: SkyRigState) => SkyRigState) {
        skyRigModifiers.push(modify);
        return track(() => {
          const index = skyRigModifiers.indexOf(modify);
          if (index !== -1) skyRigModifiers.splice(index, 1);
        });
      },
    };

    const finishMount = (): void => {
      try {
        plugin.attach(ctx);

        const phase: FramePhase =
          moverLookups.has(plugin.name) || groundShadeLookups.has(plugin.name)
            ? 'pose'
            : 'draw';
        for (const deferred of deferredFrameHandlers) {
          if (deferred.cancelled) continue;
          const handler = deferred.handler;
          const name = plugin.name;
          const timed = (dt: number): void => {
            const startMs = performance.now();
            handler(dt);
            recordPluginFrame(name, performance.now() - startMs);
          };
          deferred.unregister = viewport.onFrame(timed, phase);
        }
        deferredFrameHandlers.length = 0;
      } catch (error) {
        console.error(`[terrace] client plugin "${plugin.name}" threw in attach`, error);
      }

      mounted.set(plugin.name, { plugin, layer, undo });
    };

    const dropUnattached = (): void => {
      for (const unregister of undo) {
        try {
          unregister();
        } catch (error) {
          console.error(`[terrace] client plugin "${plugin.name}" threw unregistering`, error);
        }
      }
      layer.clear();
      viewport.scene.remove(layer);
    };

    const preload = plugin.preload;
    if (preload === undefined) {
      finishMount();
      return;
    }
    const generation = (mountGenerations.get(plugin.name) ?? 0) + 1;
    mountGenerations.set(plugin.name, generation);
    pendingMounts.add(plugin.name);
    void Promise.resolve()
      .then(() => preload(ctx))
      .then(
        () => {
          pendingMounts.delete(plugin.name);
          if (mountGenerations.get(plugin.name) !== generation) {
            dropUnattached();
            return;
          }
          finishMount();
        },
        (error: unknown) => {
          pendingMounts.delete(plugin.name);
          console.error(`[terrace] client plugin "${plugin.name}" threw in preload`, error);
          dropUnattached();
        },
      );
  };

  const unmountPlugin = (name: string): void => {
    mountGenerations.set(name, (mountGenerations.get(name) ?? 0) + 1);
    pendingMounts.delete(name);
    const entry = mounted.get(name);
    if (entry === undefined) return;
    mounted.delete(name);

    removePluginTools(name);
    removePluginHudPanels(name);
    removePluginDrawRow(name);
    breachStates.delete(name);
    groundShadeBreaches.delete(name);
    releaseWorldHeaderAction(name);

    try {
      entry.plugin.dispose?.();
    } catch (error) {
      console.error(`[terrace] client plugin "${name}" threw in dispose`, error);
    }
    for (const unregister of entry.undo) {
      try {
        unregister();
      } catch (error) {
        console.error(`[terrace] client plugin "${name}" threw unregistering`, error);
      }
    }
    entry.layer.clear();
    viewport.scene.remove(entry.layer);

    if (skyRigClaimant === name) skyRigClaimant = null;
    skyRigRefusals.delete(name);
  };

  configureGroundShade(groundShadeMaxFor(plugins));

  for (const plugin of plugins) mountPlugin(plugin);

  const stopGroundShade = viewport.onFrame(gatherGroundShade);

  const frameDrawBudget = (): number => {
    let budget = deps.coreDrawBudget();
    for (const entry of mounted.values()) {
      const declared = entry.plugin.drawBudget;
      if (Number.isFinite(declared)) budget += declared;
    }
    return budget;
  };

  const sampleDrawObjects = (): void => {
    const rows: PluginDrawRow[] = [];
    for (const [name, entry] of mounted) {
      const objects = countDrawObjects(entry.layer);
      const budget = entry.plugin.drawBudget;
      const before = breachStates.get(name) ?? NO_DRAW_BUDGET_BREACH;
      const after = stepDrawBudgetBreach(before, objects, budget);
      breachStates.set(name, after);
      if (after.breached && !before.breached) {
        console.error(
          `[terrace] client plugin "${name}" is over its draw budget: ` +
            `${String(objects)} objects against a budget of ${String(budget)}`,
        );
      }
      rows.push({ pluginName: name, objects, budget, breached: after.breached });
    }
    setPluginDrawRows(rows);
    // Frame handlers run before render, after three's own loop has reset the per-frame
    // counters; frameStats reads them after render, so its draw calls are the frame's.
    setFrameDraw({
      calls: frameStatsSample()?.counters.drawCalls ?? 0,
      objects: countDrawObjects(viewport.scene),
      budget: frameDrawBudget(),
    });
    setRenderPath({
      backend: rendererBackendName(viewport.renderer),
      mesher: world.terrainMesherActive(),
    });
  };

  const now = deps.now ?? ((): number => performance.now());
  let sampleWindowStartMs = now();
  const stopSampling = viewport.onFrame(() => {
    const nowMs = now();
    if (nowMs - sampleWindowStartMs < FPS_SAMPLE_INTERVAL_MS) return;
    sampleWindowStartMs = nowMs;
    sampleDrawObjects();
  });

  return {
    frameDrawBudget,
    allowLocalIntent(intent: SculptIntent): boolean {
      for (const handler of localIntentHandlers) {
        try {
          if (!handler(intent)) return false;
        } catch (error) {
          console.error('[terrace] plugin local-intent handler threw', error);
        }
      }
      return true;
    },

    routeMessage(type: string, payload: unknown): void {
      const set = handlers.get(type);
      if (set === undefined) return;
      for (const handler of set) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[terrace] plugin handler for "${type}" threw`, error);
        }
      }
    },

    syncLivePlugins(liveNames: readonly string[] | undefined): void {
      if (liveNames === undefined) return;
      const live = new Set(liveNames);

      for (const [name, entry] of [...mounted]) {
        if (entry.plugin.clientOnly === true) continue;
        if (!live.has(name)) unmountPlugin(name);
      }
      for (const plugin of plugins) {
        const wanted = live.has(plugin.name) || plugin.clientOnly === true;
        if (wanted && !mounted.has(plugin.name) && !pendingMounts.has(plugin.name))
          mountPlugin(plugin);
      }
    },

    dispose(): void {
      stopSampling();
      stopGroundShade();
      for (const name of [...mounted.keys()]) unmountPlugin(name);
      for (const name of [...pendingMounts]) {
        mountGenerations.set(name, (mountGenerations.get(name) ?? 0) + 1);
      }
      pendingMounts.clear();
      canvas.removeEventListener('pointerdown', onCanvasPointerDown, {
        capture: true,
      });
      pressHandlers.length = 0;
      localIntentHandlers.length = 0;
      handlers.clear();
      skyRigClaimant = null;
      audioEngine.dispose();
    },
  };
}
