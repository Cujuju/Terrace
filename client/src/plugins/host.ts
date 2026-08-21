// The client plugin host: builds each compiled-in plugin's ctx and routes its
// namespaced messages (decision Q6; contract in ./types.ts).
//
// Mirrors the server host's namespacing exactly: a plugin subscribes and sends
// with UN-namespaced types, and the host prefixes `<name>:` on the wire in
// both directions. Handlers live in one flat map keyed by the full namespaced
// type, so dispatch is a single lookup per message — no per-plugin fan-out on
// the hot path.

import type { SculptIntent } from '@terrace/shared';
import { Group, Raycaster, Vector2 } from 'three';
import type { Component } from 'solid-js';
import type { Connection } from '../net/connection.ts';
import type { Viewport } from '../render/scene.ts';
import { applySkyRig, type SkyRigState } from '../render/skyRig.ts';
import { pointerToNdc } from '../terrain/picking.ts';
import type { World } from '../world.ts';
import { addPluginHudPanel, claimWorldHeaderAction } from './hudPanels.ts';
import type { ClientPluginCtx, TerraceClientPlugin } from './types.ts';

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

  for (const plugin of plugins) {
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
        const unregister = viewport.onFrame(handler);
        unregisterFns.push(unregister);
        return unregister;
      },
      registerHudPanel(
        component: Component,
        options?: { placement?: 'panel' | 'top-center' | 'bottom-center' },
      ) {
        addPluginHudPanel({
          pluginName: plugin.name,
          component,
          placement: options?.placement ?? 'panel',
        });
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
