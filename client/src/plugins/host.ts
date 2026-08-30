// The client plugin host: builds each compiled-in plugin's ctx and routes its
// namespaced messages (decision Q6; contract in ./types.ts).
//
// Mirrors the server host's namespacing exactly: a plugin subscribes and sends
// with UN-namespaced types, and the host prefixes `<name>:` on the wire in
// both directions. Handlers live in one flat map keyed by the full namespaced
// type, so dispatch is a single lookup per message — no per-plugin fan-out on
// the hot path.

import type { SculptIntent } from '@terrace/shared';
import { Group, Raycaster, Vector2, type Intersection, type Object3D } from 'three';
import type { Component } from 'solid-js';
import { FPS_SAMPLE_INTERVAL_MS } from '../config.ts';
import type { Connection } from '../net/connection.ts';
import type { FramePhase, Viewport } from '../render/scene.ts';
import { applySkyRig, type SkyRigState } from '../render/skyRig.ts';
import { setFrameDraw } from '../state/hudState.ts';
import { pointerToNdc, worldPointToCell } from '../terrain/picking.ts';
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
import type { ClientPluginCtx, MoverPose, TerraceClientPlugin } from './types.ts';

/**
 * How many objects three would DRAW under `root`, before frustum culling —
 * the unit the draw budget is denominated in (part B of
 * docs/plans/frame-budget-growth-and-draw-calls.md).
 *
 * THE RULE IS `projectObject`'s OWN (three/src/renderers/WebGLRenderer.js):
 *   - descend a node only while `visible !== false`. Visibility is INHERITED,
 *     and hiding a subtree root is how several plugins park a whole rig;
 *   - count a node when it is a Mesh, Line, Points or Sprite;
 *   - an InstancedMesh is ONE object however many instances it holds, and NO
 *     object when `count` is 0 — three skips a `primcount === 0` draw, and
 *     pools parked at 0 are how flora, fire, storms and mudslides idle;
 *   - a geometry whose `drawRange.count` is 0 draws nothing either.
 *
 * FRUSTUM CULLING IS THE ONLY DIFFERENCE from `renderer.info.render.calls`:
 * this number is what the scene CONTAINS, which is camera-independent and
 * therefore the only thing a budget can be written against; the renderer's
 * count is what one camera happened to keep. The HUD shows both and never
 * shows them as one ratio.
 */
export function countDrawObjects(root: Object3D): number {
  if (!root.visible) return 0;
  // Structural, not `instanceof`: three's own render path tests these flags,
  // and a plugin may legitimately hand in an object from a different copy of
  // three (a bundled model loader) where `instanceof` would say no.
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

/**
 * Consecutive samples under `budget × (1 − DRAW_BUDGET_CLEAR_MARGIN)` needed to
 * clear a breach.
 *
 * TWO, because one is not evidence. Populations move every sample — a creature
 * despawns, a storm's funnel retires — and a breach cleared by a single dip
 * would flicker on and off while the plugin sat over its budget the whole time.
 */
export const DRAW_BUDGET_CLEAR_SAMPLES = 2;

/**
 * How far under budget those samples must be, as a fraction.
 *
 * A TENTH: one creature in ten. Clearing at the budget itself would let a
 * population sitting on the line toggle the breach on every sample.
 */
export const DRAW_BUDGET_CLEAR_MARGIN = 0.1;

/** One plugin's breach state between samples — see `stepDrawBudgetBreach`. */
export interface DrawBudgetBreachState {
  readonly breached: boolean;
  /** Consecutive samples under the clear margin while breached. */
  readonly lowSamples: number;
}

export const NO_DRAW_BUDGET_BREACH: DrawBudgetBreachState = {
  breached: false,
  lowSamples: 0,
};

/**
 * One sample of the breach state machine, as a pure step so the hysteresis is
 * testable as the contract it is rather than through a frame loop.
 *
 * BREACH IS `objects > budget`, NOT `>=`. A budget is THE MOST the layer may
 * hold — the value `TerraceClientPlugin.drawBudget` is documented as, and the
 * value every plugin's expression computes: the count its layer reaches when
 * its population is AT its cap. An inclusive test would report that healthy
 * full state as a failure (flora at 14/14, weather at its 14 systems, fire
 * with all five pools alight), and would make a budget of 0 — which four
 * plugins that deliberately draw nothing declare — a breach from the first
 * sample that no later sample could clear.
 *
 * Clearing needs DRAW_BUDGET_CLEAR_SAMPLES consecutive samples AT OR UNDER
 * `budget × (1 − DRAW_BUDGET_CLEAR_MARGIN)`; anything between that margin and
 * the budget is a population sitting on the line and restarts the count.
 * Inclusive here for the same reason it is exclusive above: at a budget of 0
 * the margin is 0, and a plugin that has dropped back to drawing nothing has
 * to be able to come back.
 *
 * A budget that is not a finite number is itself a breach that can never clear
 * (a plugin loaded at runtime, design Q6, can supply `undefined`).
 */
export function stepDrawBudgetBreach(
  state: DrawBudgetBreachState,
  objects: number,
  budget: number,
): DrawBudgetBreachState {
  if (!Number.isFinite(budget)) return { breached: true, lowSamples: 0 };
  if (objects > budget) return { breached: true, lowSamples: 0 };
  if (!state.breached) return NO_DRAW_BUDGET_BREACH;
  // Breached and within budget: only a sample at or under the MARGIN counts
  // toward clearing.
  if (objects > budget * (1 - DRAW_BUDGET_CLEAR_MARGIN)) {
    return { breached: true, lowSamples: 0 };
  }
  const lowSamples = state.lowSamples + 1;
  return lowSamples >= DRAW_BUDGET_CLEAR_SAMPLES
    ? NO_DRAW_BUDGET_BREACH
    : { breached: true, lowSamples };
}

export interface ClientPluginHost {
  /**
   * Wire this as ConnectionOptions.onPluginMessage. Messages whose namespace
   * no plugin claimed are dropped silently — the server may legitimately run
   * plugins this build has no client half for.
   */
  routeMessage(type: string, payload: unknown): void;
  /**
   * Runs the client-side intent chain (ClientPluginCtx.onLocalIntent); false
   * means some plugin vetoed and the intent must be neither sent nor
   * predicted. A handler that throws counts as ALLOW: a buggy client half
   * must degrade to the server-authoritative path, never to a player who
   * cannot sculpt at all.
   */
  allowLocalIntent(intent: SculptIntent): boolean;
  /**
   * Reconciles what is mounted against the plugin set the server says it is
   * running (JoinSnapshotMessage.livePlugins): plugins no longer live are
   * unmounted, newly live ones are mounted, and the rest are left untouched —
   * so a toggle of one plugin costs one plugin's teardown, not the whole HUD's.
   *
   * `undefined` means the server did not say (too old to announce), and
   * everything compiled in stays mounted — absence is not "nothing is live".
   */
  syncLivePlugins(liveNames: readonly string[] | undefined): void;
  /**
   * The frame's whole draw budget: every MOUNTED plugin's `drawBudget` plus
   * core's named contributors.
   *
   * MOUNTED, NOT REGISTERED — `syncLivePlugins` is what decides which plugins
   * are running on this world, and a budget that counted the compiled-in list
   * would license draw calls no one is making.
   */
  frameDrawBudget(): number;
  dispose(): void;
}

export function createClientPluginHost(
  plugins: readonly TerraceClientPlugin[],
  deps: {
    viewport: Viewport;
    world: World;
    /** Late-bound because the Connection is created after the host (it needs
     * routeMessage in its options); the host only sends, never at attach
     * time, so reading it lazily breaks the cycle without a setter dance. */
    connection: () => Connection;
    /**
     * Core's own share of the frame's draw budget — the terrain, the frontier
     * fog, water, the rivers, the layer-edge overlay, the brush preview and
     * the pick-debug overlay, each from its own `drawCallCount()` or named
     * constant.
     *
     * SUPPLIED BY THE CALLER, not read here, for the reason every other core
     * fact is: the host knows plugins, and main.tsx is the one place that
     * holds every core rig. Late-bound like `connection` because several of
     * those rigs are built after the host is (the brush preview, the
     * pick-debug overlay), and the number is dynamic anyway — the terrain's
     * super-mesh count grows as a world is revealed.
     */
    coreDrawBudget: () => number;
    /**
     * Monotonic millisecond clock the draw sampler's window is measured
     * against. Injectable so a test can advance it by a known amount instead of
     * racing a real one — the same seam render/frameRate.ts and
     * render/terrainMeshes.ts already take; defaults to `performance.now`.
     */
    now?: () => number;
  },
): ClientPluginHost {
  const { viewport, world } = deps;

  /** `<plugin>:<type>` → subscribed handlers, across all plugins. */
  const handlers = new Map<string, Set<(payload: unknown) => void>>();

  /** One mounted plugin: its scene layer and everything to undo on unmount. */
  interface MountedPlugin {
    readonly plugin: TerraceClientPlugin;
    readonly layer: Group;
    /**
     * The unregister closure of every registration this plugin made through
     * its ctx, in registration order. Each is the SAME closure the plugin was
     * handed, and every one of them is idempotent (a Set delete, a splice
     * guarded by indexOf), so a plugin that already cleaned up in its own
     * dispose() and the host running these are not in conflict.
     */
    readonly undo: (() => void)[];
  }

  /** Mounted plugins by name. */
  const mounted = new Map<string, MountedPlugin>();

  /**
   * The draw-budget breach state machine's memory, per plugin. Dropped on
   * unmount with everything else that plugin owns, so a plugin that comes back
   * starts clean rather than inheriting a breach from a previous world.
   */
  const breachStates = new Map<string, DrawBudgetBreachState>();

  const canvas = viewport.renderer.domElement;

  /**
   * Canvas-press claims, in plugin registration order; first claim wins. One
   * capture-phase listener serves every plugin: capture runs before the
   * sculpt brush's bubble-phase pointerdown AND before OrbitControls', so a
   * claimed press (a click on a relic, say) neither sculpts nor drags the
   * camera. stopImmediatePropagation is deliberate — cameraBindings' own
   * capture listener registered earlier has already run harmlessly, and
   * nothing after this listener may act on a claimed press.
   */
  const pressHandlers: ((event: PointerEvent) => boolean)[] = [];
  const localIntentHandlers: ((intent: SculptIntent) => boolean)[] = [];

  /**
   * Name of the plugin that has claimed setSkyRig, or null while the sky is
   * still core's static boot-time look. Set on the FIRST call to setSkyRig
   * from ANY plugin (not at registration time — there is nothing to claim
   * until a plugin actually has a value to push), which is why this is a
   * single host-scoped variable rather than per-plugin state: two plugins
   * racing to be first is exactly the case the warning below exists for.
   */
  let skyRigClaimant: string | null = null;

  /**
   * Plugins already told they lost the sky-rig claim. This capability is
   * driven from a frame loop, so the refusal has to be idempotent per plugin
   * or the console fills at frame rate — see setSkyRig below.
   */
  const skyRigRefusals = new Set<string>();

  /**
   * The registered sky-rig MODIFIERS, in registration order — see
   * ClientPluginCtx.modulateSkyRig. Separate from the claimant above because
   * they answer a different question: the claimant WRITES the sky, a modifier
   * only gets a say in what is written, and any number of plugins may have one.
   */
  const skyRigModifiers: ((state: SkyRigState) => SkyRigState)[] = [];

  const onCanvasPointerDown = (event: PointerEvent): void => {
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

  /**
   * Click → terrain cell for plugins. Allocates its own raycaster per call —
   * clicks are rare; the sculpt brush keeps its own allocation-free variant
   * for the held-stroke hot path (input/sculptInput.ts).
   *
   * The raycaster is only used to unproject the pointer into a world ray. The
   * cell itself comes from World.pickCell, the SAME pick the sculpt brush
   * uses, so a plugin click and a brush click can never resolve to different
   * cells — they used to be two independent mesh raycasts that merely happened
   * to agree.
   */
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

  /**
   * Everything any plugin has declared aimable (ClientPluginCtx.markPickable).
   * An ARRAY because that is what Raycaster.intersectObjects takes, and the
   * membership churn is a handful of registrations at attach time rather than
   * anything per-frame.
   */
  const pickableObjects: Object3D[] = [];

  /**
   * Scratch for the object pick, allocated once.
   *
   * Both picks below used to build a fresh Raycaster and Vector2 per call, and
   * `pickWorldCell` is called from pointer handlers — so a tool held across a
   * drag allocated two of each per pointer event.
   */
  const pickRaycaster = new Raycaster();
  const pickNdc = new Vector2();

  /**
   * The cell the player is pointing at: the nearest declared object under the
   * pointer, and the terrain only when there is none.
   *
   * See ClientPluginCtx.pickWorldCell for WHY this is a different question
   * from pickTerrainCell. The conversion from the hit point is
   * `worldPointToCell` — the terrain picker's own function, so an object hit
   * and a ground hit can never disagree about which cell a world position is
   * in.
   */
  const pickWorldCell = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const size = world.worldSize();
    if (size <= 0) return null;

    if (pickableObjects.length > 0) {
      const device = pointerToNdc(clientX, clientY, canvas.getBoundingClientRect());
      // OFF THE CANVAS IS NOT A MISS TO BE COMPUTED. `pointerToNdc` only fails
      // on a zero-sized viewport, so a pointer over the toolbar or off the
      // window still produces coordinates — and the declared subtrees span the
      // whole world, so their bounding spheres accept the ray and the descent
      // runs in full to answer a question about a pixel that is not in the
      // scene. Costed at 2.28 ms with a mature forest declared.
      if (device !== null && device.x >= -1 && device.x <= 1 && device.y >= -1 && device.y <= 1) {
        // The scratch is module-scoped and reused: this runs on pointer events,
        // which arrive far faster than frames.
        pickRaycaster.setFromCamera(pickNdc.set(device.x, device.y), viewport.camera);
        const raycaster = pickRaycaster;
        // RECURSIVE, because what a plugin holds is a Group: flora's whole
        // forest is one node over three InstancedMeshes. A registration
        // therefore declares a SUBTREE aimable, and keeping unaimable things
        // out of it is the registrant's business — which is the right place
        // for it, since the registrant is the only one who knows.
        const hits: Intersection[] = raycaster.intersectObjects(pickableObjects, true);
        // Sorted nearest-first by Raycaster, so the first hit is the object the
        // player can actually see at that pixel.
        for (const hit of hits) {
          const cell = worldPointToCell(hit.point.x, hit.point.z, size);
          if (cell !== null) return { x: cell.x, y: cell.y };
        }
      }
    }

    return pickTerrainCell(clientX, clientY);
  };

  /**
   * One pose lookup per publishing plugin (ClientPluginCtx.publishMovers),
   * keyed by plugin name — the same by-name addressing the wire and the
   * server's world events use, and for the same reason: it is unforgeable and
   * needs no import.
   */
  const moverLookups = new Map<string, (id: number) => MoverPose | null>();

  const moverPose = (pluginName: string, id: number): MoverPose | null => {
    const lookup = moverLookups.get(pluginName);
    if (lookup === undefined) return null;
    // A publisher that throws answers "I am not drawing that" rather than
    // taking down its reader's frame — the same degradation every other
    // plugin-supplied callback here gets.
    try {
      return lookup(id);
    } catch {
      return null;
    }
  };

  /** One plugin's frame callbacks, held until its attach() has finished. */
  interface DeferredFrameHandler {
    readonly handler: (dt: number) => void;
    unregister: (() => void) | null;
    cancelled: boolean;
  }

  /**
   * Builds one plugin's ctx, runs its attach(), and records everything that
   * has to be undone if it is later unmounted.
   *
   * Registration order is the order plugins are mounted in, which is what the
   * first-claim-wins hooks (canvas presses, the world-header action) arbitrate
   * by. A plugin mounted LATE by a live-set change therefore joins at the back
   * of those queues rather than at its registry position — the only way it
   * could take a claim from a plugin already holding one would be to evict it,
   * and a plugin arriving must not disturb one that is already running.
   */
  const mountPlugin = (plugin: TerraceClientPlugin): void => {
    const undo: (() => void)[] = [];
    /**
     * Records a registration's unregister closure and hands it back to the
     * plugin unchanged — so unmounting undoes registrations the plugin never
     * cleaned up itself, without taking the closure away from one that does.
     */
    const track = (unregister: () => void): (() => void) => {
      undo.push(unregister);
      return unregister;
    };
    const deferredFrameHandlers: DeferredFrameHandler[] = [];
    const layer = new Group();
    layer.name = `plugin:${plugin.name}`;
    // Into the scene, NOT terrainGroup: the sculpt raycaster must never see a
    // plugin's meshes as terrain (input/sculptInput.ts picks terrain only).
    viewport.scene.add(layer);

    const ctx: ClientPluginCtx = {
      layer,
      worldSize: () => world.worldSize(),
      terrainHeightAt: (x, y) => world.terrainHeightAt(x, y),
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
          // The key goes with the last subscriber: routeMessage's lookup must
          // not keep finding an empty Set for a plugin that is gone.
          if (set.size === 0) handlers.delete(key);
        });
      },
      send(type, payload) {
        deps.connection().sendPlugin(`${plugin.name}:${type}`, payload);
      },
      onFrame(handler) {
        // THE PHASE IS NOT THE PLUGIN'S TO CHOOSE, and that is the point: a
        // plugin that publishes poses must draw before the plugins that read
        // them (render/scene.ts's FramePhase), and asking every publisher to
        // remember to say so would make the guarantee only as good as the next
        // registration. So the handler is HELD until this plugin's attach()
        // has finished, and then registered in the 'pose' phase if the plugin
        // published a pose lookup during it, or the 'draw' phase if it did not.
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
            | 'connection';
          headerSummary?: Component;
          tabSummary?: () => string;
        },
      ) {
        addPluginHudPanel({
          pluginName: plugin.name,
          component,
          placement: options?.placement ?? 'panel',
          headerSummary: options?.headerSummary,
          tabSummary: options?.tabSummary,
        });
      },
      registerTool(tool) {
        // Namespaced exactly like a message type, and for the same reason: a
        // tool's id is a public name two plugins could otherwise both take.
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
      moverPose,
      publishMovers(lookup: (id: number) => MoverPose | null): () => void {
        // Last publisher wins rather than first: unlike the sky rig there is
        // nothing to arbitrate — a plugin publishes its OWN things under its
        // OWN name, so a second call is the same plugin replacing its own
        // lookup (a re-attach), never a rival claiming someone else's.
        moverLookups.set(plugin.name, lookup);
        return track(() => {
          if (moverLookups.get(plugin.name) === lookup) moverLookups.delete(plugin.name);
        });
      },
      markPickable(object: Object3D): () => void {
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
          // ONCE PER LOSING PLUGIN, not once per call. Unlike every other
          // single-claimant hook here, this one is called from a FRAME loop —
          // a second claimant driving its own cycle would warn 60 times a
          // second and bury whatever else the console was trying to say. The
          // warning is a configuration diagnostic; it says everything it has
          // to say the first time.
          if (!skyRigRefusals.has(plugin.name)) {
            skyRigRefusals.add(plugin.name);
            console.warn(
              `sky rig already claimed by "${skyRigClaimant}"; ` +
                `ignoring updates from "${plugin.name}"`,
            );
          }
          return;
        }
        // EVERY MODIFIER SEES THE PREVIOUS ONE'S OUTPUT, so two compose
        // instead of the last one winning. A modifier that throws is skipped
        // for this frame — the sky keeps the state it had reached, which is
        // the claimant's own if nothing has modified it yet.
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
      modulateSkyRig(modify: (state: SkyRigState) => SkyRigState) {
        skyRigModifiers.push(modify);
        return track(() => {
          const index = skyRigModifiers.indexOf(modify);
          if (index !== -1) skyRigModifiers.splice(index, 1);
        });
      },
    };

    // A plugin that throws in attach loses its own features, not the app:
    // same containment stance as the server host's `safely`.
    try {
      plugin.attach(ctx);

      // Now that attach() has run we know whether this plugin publishes poses,
      // so its frame callbacks can go into the phase that fact demands.
      const phase: FramePhase = moverLookups.has(plugin.name) ? 'pose' : 'draw';
      for (const deferred of deferredFrameHandlers) {
        if (deferred.cancelled) continue;
        deferred.unregister = viewport.onFrame(deferred.handler, phase);
      }
      deferredFrameHandlers.length = 0;
    } catch (error) {
      console.error(`[terrace] client plugin "${plugin.name}" threw in attach`, error);
    }

    // Recorded even when attach threw: a plugin that failed half-way through
    // may still have registered things, and those are exactly what an unmount
    // has to be able to take back.
    mounted.set(plugin.name, { plugin, layer, undo });
  };

  /**
   * Tears one plugin back down: its tools, its HUD, its own dispose(), every
   * registration it made, and its scene layer. Silent no-op for a plugin that
   * is not mounted, so the diff below can call it without checking twice.
   */
  const unmountPlugin = (name: string): void => {
    const entry = mounted.get(name);
    if (entry === undefined) return;
    mounted.delete(name);

    // The toolbar FIRST, for the reason dispose() has always given: dropping a
    // held tool deselects it, and a tool tearing down its placement ghost must
    // do it while its own layer is still in the scene.
    removePluginTools(name);
    removePluginHudPanels(name);
    // Its draw row goes with its panels, and for the same reason: the HUD must
    // not show a budget for a plugin that has stopped running, not even for the
    // rest of the sampling window.
    removePluginDrawRow(name);
    breachStates.delete(name);
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

    // The sky goes back up for grabs only if THIS plugin was holding it; the
    // rig itself keeps whatever look it was last given, because core has no
    // state to restore it to (see setSkyRig).
    if (skyRigClaimant === name) skyRigClaimant = null;
    skyRigRefusals.delete(name);
  };

  for (const plugin of plugins) mountPlugin(plugin);

  const frameDrawBudget = (): number => {
    let budget = deps.coreDrawBudget();
    for (const entry of mounted.values()) {
      const declared = entry.plugin.drawBudget;
      // A non-finite budget contributes NOTHING to the total — it is a breach
      // in its own row, and adding NaN would destroy the whole frame's number.
      if (Number.isFinite(declared)) budget += declared;
    }
    return budget;
  };

  /**
   * One walk of every mounted plugin's layer and of the whole scene, published
   * to the HUD.
   *
   * CORE'S OBJECTS ARE THE REMAINDER — the scene minus the plugin layers —
   * rather than an enumeration of core's rigs, because the plugin layers are
   * the only children of the scene whose owner is known here, and a remainder
   * cannot fall out of date when core gains a rig.
   */
  const sampleDrawObjects = (): void => {
    const rows: PluginDrawRow[] = [];
    for (const [name, entry] of mounted) {
      const objects = countDrawObjects(entry.layer);
      const budget = entry.plugin.drawBudget;
      const before = breachStates.get(name) ?? NO_DRAW_BUDGET_BREACH;
      const after = stepDrawBudgetBreach(before, objects, budget);
      breachStates.set(name, after);
      // ON THE TRANSITION ONLY: a plugin over budget stays over budget for as
      // long as its population is large, and one line per sample twice a
      // second would bury the console it is trying to be read in.
      if (after.breached && !before.breached) {
        console.error(
          `[terrace] client plugin "${name}" is over its draw budget: ` +
            `${String(objects)} objects against a budget of ${String(budget)}`,
        );
      }
      rows.push({ pluginName: name, objects, budget, breached: after.breached });
    }
    setPluginDrawRows(rows);
    setFrameDraw({
      calls: viewport.renderer.info.render.calls,
      objects: countDrawObjects(viewport.scene),
      budget: frameDrawBudget(),
    });
  };

  /**
   * The sampler's own window, at FPS_SAMPLE_INTERVAL_MS.
   *
   * ITS OWN, not the fps meter's: that meter's window lives inside a closure
   * with no seam to share and no need of one, and the two are only the same
   * LENGTH — half a second, which is as often as a HUD number can be read.
   * A walk of ~1 000 objects is ~0.05 ms, so twice a second is free.
   */
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
      // A server too old to announce its set says nothing about it, and
      // nothing is what this must then change.
      if (liveNames === undefined) return;
      const live = new Set(liveNames);

      // Down before up: a plugin leaving frees its single-claimant hooks (the
      // sky rig, the world-header banner) in the same pass that a plugin
      // arriving might want them.
      for (const name of [...mounted.keys()]) {
        if (!live.has(name)) unmountPlugin(name);
      }
      // Over `plugins`, not over `liveNames`: the client mounts what it has
      // compiled in, and a name it does not recognise is a plugin whose server
      // half runs without a client half — which is legitimate (see
      // routeMessage) and not an error.
      for (const plugin of plugins) {
        if (live.has(plugin.name) && !mounted.has(plugin.name)) mountPlugin(plugin);
      }
    },

    dispose(): void {
      stopSampling();
      for (const name of [...mounted.keys()]) unmountPlugin(name);
      canvas.removeEventListener('pointerdown', onCanvasPointerDown, {
        capture: true,
      });
      pressHandlers.length = 0;
      localIntentHandlers.length = 0;
      handlers.clear();
      skyRigClaimant = null;
    },
  };
}
