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
import type { Connection } from '../net/connection.ts';
import type { FramePhase, Viewport } from '../render/scene.ts';
import { applySkyRig, type SkyRigState } from '../render/skyRig.ts';
import { pointerToNdc, worldPointToCell } from '../terrain/picking.ts';
import type { World } from '../world.ts';
import { addPluginHudPanel, claimWorldHeaderAction } from './hudPanels.ts';
import { addPluginTool, clearPluginTools } from './toolbar.ts';
import type { ClientPluginCtx, MoverPose, TerraceClientPlugin } from './types.ts';

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
  },
): ClientPluginHost {
  const { viewport, world } = deps;

  /** `<plugin>:<type>` → subscribed handlers, across all plugins. */
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const layers: Group[] = [];
  const unregisterFns: (() => void)[] = [];

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

  for (const plugin of plugins) {
    const deferredFrameHandlers: DeferredFrameHandler[] = [];
    const layer = new Group();
    layer.name = `plugin:${plugin.name}`;
    // Into the scene, NOT terrainGroup: the sculpt raycaster must never see a
    // plugin's meshes as terrain (input/sculptInput.ts picks terrain only).
    viewport.scene.add(layer);
    layers.push(layer);

    const ctx: ClientPluginCtx = {
      layer,
      worldSize: () => world.worldSize(),
      terrainHeightAt: (x, y) => world.terrainHeightAt(x, y),
      onMessage(type, handler) {
        const key = `${plugin.name}:${type}`;
        let set = handlers.get(key);
        if (set === undefined) {
          set = new Set();
          handlers.set(key, set);
        }
        set.add(handler);
        return () => set.delete(handler);
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
        return () => {
          deferred.cancelled = true;
          deferred.unregister?.();
          deferred.unregister = null;
        };
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
        return () => {
          const i = pressHandlers.indexOf(handler);
          if (i !== -1) pressHandlers.splice(i, 1);
        };
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
        return () => {
          if (moverLookups.get(plugin.name) === lookup) moverLookups.delete(plugin.name);
        };
      },
      markPickable(object: Object3D): () => void {
        if (!pickableObjects.includes(object)) pickableObjects.push(object);
        return () => {
          const index = pickableObjects.indexOf(object);
          if (index !== -1) pickableObjects.splice(index, 1);
        };
      },
      onLocalIntent(handler) {
        localIntentHandlers.push(handler);
        return () => {
          const i = localIntentHandlers.indexOf(handler);
          if (i !== -1) localIntentHandlers.splice(i, 1);
        };
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
        applySkyRig(viewport, state);
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
        const unregister = viewport.onFrame(deferred.handler, phase);
        deferred.unregister = unregister;
        unregisterFns.push(unregister);
      }
      deferredFrameHandlers.length = 0;
    } catch (error) {
      console.error(`[terrace] client plugin "${plugin.name}" threw in attach`, error);
    }
  }

  return {
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

    dispose(): void {
      // The toolbar FIRST, before any plugin is disposed: dropping the tools
      // deselects whichever was held, and a tool tearing down its placement
      // ghost must do it while its own layer is still in the scene.
      clearPluginTools();
      for (const plugin of plugins) {
        try {
          plugin.dispose?.();
        } catch (error) {
          console.error(`[terrace] client plugin "${plugin.name}" threw in dispose`, error);
        }
      }
      for (const unregister of unregisterFns) unregister();
      for (const layer of layers) {
        layer.clear();
        viewport.scene.remove(layer);
      }
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
