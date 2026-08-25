// The CLIENT half of the plugin contract (design §3.5: "client-side plugins
// register HUD panels (Solid components) and Three.js scene layers"; decision
// Q6: client halves are compiled in, against this stable module signature, so
// runtime loading can be added later without changing plugins).
//
// A client plugin is the rendering/UI mirror of a server plugin with the same
// name. Everything it may touch arrives through the ctx handed to `attach` —
// a plugin never reaches into the renderer, the connection, or another
// plugin's layer. Message types are un-namespaced here exactly like the server
// side's `messages` record: the host prefixes `<name>:` on the wire in both
// directions, so a plugin cannot collide with core messages or another plugin.

import type { SculptIntent } from '@terrace/shared';
import type { Group, Object3D } from 'three';
import type { Component } from 'solid-js';

/**
 * The declarative sky/lighting state a plugin may drive core's rig with — see
 * ClientPluginCtx.setSkyRig below for the capability this backs and its
 * single-claimant rule, and client/src/render/skyRig.ts for applySkyRig, the
 * one function that turns this into real Three.js light mutations.
 *
 * DEFINED HERE, NOT IN render/skyRig.ts, DELIBERATELY. skyRig.ts also needs
 * Viewport (client/src/render/scene.ts) to do its job, and scene.ts imports
 * client/src/config.ts, which reads import.meta.env — fine for the real
 * browser build, but fatal to a PLUGIN's standalone `tsc`/`vitest` run the
 * moment any of its files pull that chain in, even through a type-only
 * import (tsc still has to resolve and diagnose every file reachable in the
 * program, type-only or not). This file already has zero such imports (every
 * plugin's client half type-only-imports ClientPluginCtx from here), so the
 * shared TYPE lives on this side of the boundary and skyRig.ts imports it
 * back, instead of the other way around — the same reason plugins/weather/
 * client/sky.ts restates numeric constants rather than importing scene.ts
 * directly (see that file's WORLD_UNITS_PER_BAND comment), just applied to a
 * TYPE instead of a value.
 *
 * Every colour is a 0xRRGGBB int (matching every other colour constant in
 * this codebase — see render/scene.ts's SKY_COLOR); every intensity is in
 * the same unitless scale DirectionalLight/HemisphereLight/AmbientLight
 * already use.
 */
export interface SkyRigState {
  /**
   * Unit-ish direction the sun shines FROM, in the same convention
   * DirectionalLight.position already uses (core places the light at this
   * direction, scaled out to SUN_DISTANCE_WORLD_UNITS, and its target defaults to
   * the origin) — not the direction the light TRAVELS in.
   */
  readonly sunDirection: { readonly x: number; readonly y: number; readonly z: number };
  readonly sunColor: number;
  readonly sunIntensity: number;
  /** HemisphereLight's sky-side colour, and (by default) the background too. */
  readonly hemisphereSkyColor: number;
  /** HemisphereLight's ground-side (bounce) colour. */
  readonly hemisphereGroundColor: number;
  readonly hemisphereIntensity: number;
  /** AmbientLight's colour and intensity — the orientation-independent floor. */
  readonly ambientColor: number;
  readonly ambientIntensity: number;
  /**
   * scene.background. Independently settable from hemisphereSkyColor even
   * though core's boot-time values for the two happen to be equal (both
   * SKY_COLOR) — nothing forces a claimant to keep them equal, and core has
   * no opinion either way.
   */
  readonly backgroundColor: number;
}

export interface ClientPluginCtx {
  /**
   * Plugin-owned Three.js layer, already parented into the scene. Everything
   * the plugin renders goes in here — never into the terrain group, whose
   * children are what the sculpt raycaster treats as terrain.
   */
  readonly layer: Group;

  /** Live world size in cells; 0 until the join snapshot arrives. */
  worldSize(): number;

  /**
   * World-space Y of the RENDERED terrain surface at cell (x, y) — the
   * terraced (band-quantised) height, i.e. where a thing standing on the
   * ground should stand. Cells in chunks this client was never sent read as
   * band 0 (sea floor), exactly like the terrain mesh would draw them. Null
   * until the first snapshot arrives.
   */
  terrainHeightAt(x: number, y: number): number | null;

  /**
   * Subscribes to this plugin's namespaced server messages by un-namespaced
   * type. Returns an unsubscribe function.
   */
  onMessage(type: string, handler: (payload: unknown) => void): () => void;

  /** Sends `<name>:<type>` to the server. A no-op while disconnected. */
  send(type: string, payload: unknown): void;

  /**
   * Registers a per-frame animation callback (`dt` in seconds, capped by the
   * host so a background-tab hiccup cannot produce a giant step). Returns an
   * unregister function.
   */
  onFrame(handler: (dt: number) => void): () => void;

  /**
   * Adds a Solid component to the HUD. Default placement stacks it inside the
   * corner panel; 'top-center' floats it centred along the top of the screen
   * for at-a-glance status; 'bottom-center' floats it centred along the
   * bottom; 'bottom-right' seats it in the bottom-right strip cell, just left
   * of the settings icon-button column; 'connection' renders inside the
   * connection popup, below its status row and hint.
   */
  registerHudPanel(
    component: Component,
    options?: {
      placement?:
        | 'panel'
        | 'top-center'
        | 'bottom-center'
        | 'bottom-right'
        | 'connection';
      /**
       * A one-row summary rendered inside the corner panel's HEADER rather
       * than its body (owner move: the corner panel is named for its first
       * plugin's line, so that line belongs in the title bar).
       */
      headerSummary?: Component;
      /**
       * Live label for the corner panel's COLLAPSED tab, read at render time
       * (e.g. `Relics (3)`). Falls back to the capitalised plugin name when
       * absent.
       */
      tabSummary?: () => string;
    },
  ): void;

  /**
   * Adds a TOOL to the bottom toolbar — a mode the player can hold instead of
   * the sculpt brush (plugins/toolbar.ts owns the selection; read its header
   * for why core owns it and the plugin does not).
   *
   * `id` is namespaced `<plugin>:<id>` by the host, like every message type,
   * so two plugins may both call theirs `place`. `onSelected` is the plugin's
   * ONLY view of the selection: it fires with true when this tool becomes the
   * held one and false when it stops being it — including when another
   * plugin's tool takes over, or when the player goes back to the brush. A
   * plugin that shows a placement ghost builds it on true and tears it down
   * on false.
   *
   * TAKING THE PRESS IS STILL THE PLUGIN'S JOB: holding a tool does not route
   * clicks anywhere by itself. Claim them with `onCanvasPress` while selected
   * — core suppresses only its OWN brush (the outline preview and the sculpt
   * press) while any tool is held.
   */
  registerTool(tool: {
    id: string;
    label: string;
    title: string;
    icon: Component;
    onSelected: (selected: boolean) => void;
  }): void;

  /**
   * Claims the top-centre world banner as this plugin's entry point: core
   * renders `icon` to the right of the world name and makes the whole banner
   * a button firing `onClick`, labelled `label` for tooltip and screen
   * readers. ONE claimant per client — first registration wins (the same rule
   * as onCanvasPress); later claims warn and are ignored. Unclaimed, the
   * banner stays an inert title card.
   */
  registerWorldHeaderAction(action: {
    icon: Component;
    label: string;
    onClick: () => void;
  }): void;

  /**
   * Lets the plugin claim pointer presses on the canvas BEFORE the sculpt
   * brush or the camera see them (the host listens in the capture phase and
   * stops a claimed event's propagation). Return true to claim — e.g. a click
   * that landed on one of the plugin's own meshes — false to let the press
   * fall through to sculpting/camera. Handlers run in plugin registration
   * order; the first claim wins. Returns an unregister function.
   */
  onCanvasPress(handler: (event: PointerEvent) => boolean): () => void;

  /**
   * The terrain cell under a client-space point, via the app's own camera and
   * terrain meshes — what a click "on the ground" means. Null when the ray
   * misses (sea with no terrain, locked territory, off-canvas). Allocates per
   * call: fine for clicks, not for per-frame use.
   */
  pickTerrainCell(clientX: number, clientY: number): { x: number; y: number } | null;

  /**
   * Declares one of this plugin's objects to be A THING STANDING ON THE GROUND
   * — a tree, a hut, a boat, an animal — so that `pickWorldCell` can aim at it.
   * Returns an unregister function.
   *
   * OPT-IN, NOT AUTOMATIC, and that is the whole point. A plugin's layer also
   * holds things that are emphatically NOT aimable: weather's sky dome, the
   * frontier fog, a flame. An indiscriminate raycast over the layers would hit
   * the sky before it ever reached a tree, so a plugin says which of its
   * objects are part of the solid world and the host believes exactly that.
   *
   * The object may be a Group or an InstancedMesh: the host descends into it,
   * so a whole forest is ONE registration. The cell comes from WHERE THE RAY
   * HIT rather than from which instance it was, so the host needs no
   * instance-to-cell mapping — and a plugin whose group also holds something
   * unaimable should register the aimable child instead of the group.
   */
  markPickable(object: Object3D): () => void;

  /**
   * The cell the player is POINTING AT — which is not the same question as
   * `pickTerrainCell`, and the difference is the bug this exists to fix.
   *
   * A tree's canopy is drawn ABOVE its cell. At an orbit camera's angle a ray
   * through the canopy carries on and meets the ground several cells BEHIND
   * it, so a player who clicks the tree they can plainly see targets bare
   * ground somewhere past it. Aiming at things standing on the ground was
   * therefore impossible with a terrain-only pick, however carefully the
   * player clicked.
   *
   * So this asks the objects first (whatever `markPickable` declared, nearest
   * hit wins) and falls back to the terrain when the ray hits none of them.
   * Null when it hits nothing at all.
   *
   * Allocates and raycasts per call: a click or a hover, never a per-instance
   * inner loop.
   */
  pickWorldCell(clientX: number, clientY: number): { x: number; y: number } | null;

  /**
   * The client-side mirror of the server's onIntent interceptor chain: lets a
   * plugin veto a local sculpt BEFORE it is sent or predicted. Return true to
   * allow, false to veto — a vetoed intent never leaves the machine, so there
   * is no phantom stroke and no nack round trip.
   *
   * This is UX, not authority: the server runs its own chain regardless, and
   * a plugin using this hook must gate on REPLICATED server state (e.g. the
   * mana balance the server pushes), never on rules it invented locally —
   * otherwise the two chains drift and the visual glitching this hook exists
   * to remove comes back. Handlers run in plugin registration order; the
   * first veto wins. Returns an unregister function.
   */
  onLocalIntent(handler: (intent: SculptIntent) => boolean): () => void;

  /**
   * Drives the scene's sky/lighting rig — the sun's direction, colour and
   * intensity; the hemisphere and ambient fill lights; and the background
   * colour (render/scene.ts's SkyLightingRig; the full declarative shape is
   * SkyRigState, above). ONE claimant per client — the FIRST
   * plugin to call this in a given frame owns the rig for the rest of the
   * session; every later call, from any OTHER plugin, is ignored with a
   * console.warn instead of fighting the first claimant's writes silently.
   * There is no unclaim: like registerWorldHeaderAction this is a boot-time
   * configuration decision, not a runtime handoff.
   *
   * UNCLAIMED, THE SKY IS EXACTLY WHAT core SET IT TO AT BOOT — today's
   * static noon look — because core never calls this itself; it only builds
   * the rig and exposes this one seam onto it. A plugin that wants a static
   * sky simply never calls it, same as a plugin that skips
   * registerWorldHeaderAction leaves the banner an inert title card.
   *
   * Call this as often as the plugin's own state changes — typically every
   * frame, from inside its own onFrame handler, the same way weather redraws
   * its rigs every frame from the interpolated system list rather than only
   * on each server broadcast.
   */
  setSkyRig(state: SkyRigState): void;
}

export interface TerraceClientPlugin {
  /** Must equal the server plugin's name — it is the message namespace. */
  readonly name: string;

  /** Called once at boot with the plugin's context. */
  attach(ctx: ClientPluginCtx): void;

  /** Optional teardown; the host empties and removes the layer itself. */
  dispose?(): void;
}
