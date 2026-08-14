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
import type { Group } from 'three';
import type { Component } from 'solid-js';

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
   * bottom for persistent instruments (gauges, timers).
   */
  registerHudPanel(
    component: Component,
    options?: { placement?: 'panel' | 'top-center' | 'bottom-center' },
  ): void;

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
}

export interface TerraceClientPlugin {
  /** Must equal the server plugin's name — it is the message namespace. */
  readonly name: string;

  /** Called once at boot with the plugin's context. */
  attach(ctx: ClientPluginCtx): void;

  /** Optional teardown; the host empties and removes the layer itself. */
  dispose?(): void;
}
