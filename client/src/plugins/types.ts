// The CLIENT half of the plugin contract — the rendering and UI mirror of a
// server plugin. Everything a plugin touches arrives through `attach`'s ctx.

import type { SculptIntent } from '@terrace/shared';
import type { Group, Material, Object3D } from 'three';
import type { Component } from 'solid-js';
import type { CellOccupancy } from '../terrain/occupancy.ts';
/**
 * TYPE-ONLY, AND SAFE TO REACH FROM HERE: nothing in revealMask.ts's import
 * chain reaches `import.meta.env`.
 */
import type { RevealClipUniforms } from '../render/revealMask.ts';
import type { RigAsset } from '../render/rigAsset.ts';

/**
 * RE-EXPORTED so a plugin declaring an occupancy lookup imports this contract
 * rather than the client's terrain internals.
 */
export type { CellColumn, CellOccupancy, CellRayChord } from '../terrain/occupancy.ts';

/**
 * The declarative sky/lighting state a plugin may drive core's rig with; see
 * ClientPluginCtx.setSkyRig for its single-claimant rule. Colours are 0xRRGGBB
 * ints, intensities three's own scale.
 */

/**
 * How an authored asset's PBR materials are lit — see
 * ClientPluginCtx.loadRigAsset for why this is a required, explicit choice.
 */
export type RigLighting = 'sky-environment' | 'lamps-only';

export interface SkyRigState {
  /**
   * Unit-ish direction the sun shines FROM, the convention
   * DirectionalLight.position uses — not the direction the light TRAVELS in.
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
   * scene.background. Independently settable from hemisphereSkyColor; nothing
   * forces a claimant to keep the two equal.
   */
  readonly backgroundColor: number;
}

/**
 * Where something is drawn, in WORLD units, not cell space. `y` is the point
 * the thing STANDS ON, not its centre; `bodyBottomY` / `bodyHeight` span the
 * BODY.
 */

/**
 * One shade the terrain and water darken under (`publishGroundShade`). World
 * units. `y` is THIS disc's own height, not a shared cloud base; `inner`
 * starts the falloff.
 */
export interface GroundShadeDisc {
  readonly x: number;
  readonly z: number;
  /** The disc's own height in world units — the deck it belongs to. */
  readonly y: number;
  readonly radius: number;
  readonly darkness: number;
  readonly inner: number;
}

/**
 * A point in WORLD units, not cell space. A readonly triple rather than three's
 * `Vector3`, which would offer ways to write into an object the reader does not
 * own.
 */
export interface WorldPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** How a one-shot is placed and coloured — see `PluginAudio.playSfx`. */
export interface SfxOptions {
  /**
   * Where the sound happens, in WORLD units. Present makes the voice
   * POSITIONAL; absent, a flat voice at full bus level. Copied during the call.
   */
  readonly at?: WorldPosition;
  /**
   * Level relative to the bus, 0..1, default 1. NOT absolute loudness: a plugin
   * that needs to be louder needs a louder ASSET. Clamped.
   */
  readonly gain?: number;
  /** Speed multiplier for variation; pitch moves with it. Default 1. */
  readonly playbackRate?: number;
  /**
   * Seconds from now until the sound is heard, default 0. NO TIMER: Web Audio
   * schedules it, and it holds its pool slot from then.
   */
  readonly delaySeconds?: number;
}

/** What a generator plugs into: core's context, core's node on the music bus. */
export interface MusicOutlet {
  readonly context: AudioContext;
  readonly destination: AudioNode;
}

/** The handle a generator hands back so core can end it. */
export interface MusicGenerator {
  /** Ramp to silence over `fadeSeconds`, then release every node. */
  stop(fadeSeconds: number): void;
}

/**
 * Everything a plugin may do to the player's ears. Core owns the Web Audio
 * graph; a plugin says what it wants heard. Every method is safe at any time.
 */
export interface PluginAudio {
  /**
   * Fetches and decodes an asset now. Call it from `attach` for every URL the
   * plugin can play, or the FIRST event of each kind is silent. Idempotent.
   */
  preload(url: string): void;

  /**
   * Fires a one-shot on the SFX bus and returns. An undecoded URL starts the
   * decode and plays NOTHING. Too many one-shots steal the oldest voice.
   */
  playSfx(url: string, opts?: SfxOptions): void;

  /**
   * A looping layer faded toward `weight` (0..1) on the ambience bus. ONE LOOP
   * PER (PLUGIN, URL): calling again RETARGETS. Weight 0 releases the voice.
   */
  ambience(url: string, weight: number): void;

  /**
   * Puts a looping track on the music bus, crossfading; `null` fades out.
   * SINGLE-CLAIMANT like `setSkyRig`: the first caller owns it. Unmounting the
   * claimant frees the bus.
   */
  setMusic(url: string | null): void;

  /**
   * Drives the music bus from code instead of a file. SAME CLAIMANT SLOT as
   * `setMusic`. `start` runs once; null fades out.
   */
  setMusicGenerator(start: ((outlet: MusicOutlet) => MusicGenerator) | null): void;
}

export interface MoverPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** World Y of the lowest point of the drawn body. */
  readonly bodyBottomY: number;
  /** Drawn height of the body, world units, from `bodyBottomY` to its crown. */
  readonly bodyHeight: number;
}

export interface ClientPluginCtx {
  /**
   * Plugin-owned Three.js layer, already parented into the scene. Everything
   * the plugin renders goes here, never into the terrain group.
   */
  readonly layer: Group;

  /**
   * Everything this plugin may make the player hear (PluginAudio, above).
   * PER-PLUGIN: the handle knows who holds it, so a detach releases exactly
   * this plugin's voices.
   */
  readonly audio: PluginAudio;

  /** Live world size in cells; 0 until the join snapshot arrives. */
  worldSize(): number;

  /**
   * World-space Y of the band the cell LATTICE puts (x, y) in. FOR LOGIC, NOT
   * FOR A DRAWN Y: anything drawn at ground level asks `drawnGroundYAt`.
   */
  terrainHeightAt(x: number, y: number): number | null;

  /**
   * AN OPAQUE COUNTER THAT CHANGES WHENEVER THE TERRAIN NEAR (x, y) MAY HAVE
   * CHANGED. PER CHUNK, not per cell, and conservative. COMPARE FOR EQUALITY
   * ONLY. 0 before the first snapshot.
   */
  terrainRevisionAt(x: number, y: number): number;

  /**
   * World-space Y of the cap the terrain ACTUALLY DRAWS at a (fractional) cell
   * coordinate — the region its SMOOTHED MARCHED CONTOUR encloses, not the
   * lattice band.
   */
  drawnGroundYAt(cellX: number, cellZ: number): number | null;

  /**
   * Subscribes to this plugin's namespaced server messages by un-namespaced
   * type. Returns an unsubscribe function.
   */
  onMessage(type: string, handler: (payload: unknown) => void): () => void;

  /** Sends `<name>:<type>` to the server. A no-op while disconnected. */
  send(type: string, payload: unknown): void;

  /**
   * Registers a per-frame animation callback (`dt` in seconds, capped by the
   * host). Returns an unregister function.
   */
  onFrame(handler: (dt: number) => void): () => void;

  /**
   * Adds a Solid component to the HUD. 'panel' stacks it in the corner panel;
   * the three edge placements float it there; 'connection' and 'settings'
   * render inside those popups.
   */
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
      /**
       * A one-row summary rendered inside the corner panel's HEADER rather
       * than its body.
       */
      headerSummary?: Component;
      /**
       * Live label for the corner panel's COLLAPSED tab, read at render time.
       * Falls back to the capitalised plugin name.
       */
      tabSummary?: () => string;
      /**
       * Live "my body has something to show", read at render time. While every
       * panel answers false the corner shows only headers. Absent means always.
       */
      hasBody?: () => boolean;
    },
  ): void;

  /**
   * Adds a TOOL to the bottom toolbar — a mode the player holds instead of the
   * sculpt brush. `id` is namespaced `<plugin>:<id>` by the host.
   */
  registerTool(tool: {
    id: string;
    label: string;
    title: string;
    icon: Component;
    onSelected: (selected: boolean) => void;
  }): void;

  /**
   * Claims the top-centre world banner: core renders `icon` beside the world
   * name and makes the banner a button firing `onClick`. ONE claimant per
   * client, first registration wins.
   */
  registerWorldHeaderAction(action: {
    icon: Component;
    label: string;
    onClick: () => void;
  }): void;

  /**
   * Claims pointer presses on the canvas BEFORE the sculpt brush or the camera
   * see them. True claims, false falls through; the first claim wins.
   */
  onCanvasPress(handler: (event: PointerEvent) => boolean): () => void;

  /**
   * The terrain cell under a client-space point — what a click "on the ground"
   * means. Null when the ray misses. Allocates per call.
   */
  pickTerrainCell(clientX: number, clientY: number): { x: number; y: number } | null;

  /**
   * Declares one of this plugin's objects to be A THING STANDING ON THE GROUND,
   * so `pickWorldCell` can aim at it. OPT-IN: a layer also holds things that
   * are not aimable.
   */
  markPickable(object: Object3D, occupancy?: CellOccupancy): () => void;

  /**
   * The cell the player is POINTING AT, which is not `pickTerrainCell`: a
   * canopy is drawn ABOVE its cell, so a ray through it meets the ground
   * several cells behind.
   */
  pickWorldCell(clientX: number, clientY: number): { x: number; y: number } | null;

  /**
   * WHERE THE CAMERA IS, in WORLD units. For ORDERING questions only — which
   * of two transparent things is in front. Nothing is LAID OUT from it.
   */
  cameraPosition(): WorldPosition;

  /**
   * Is cell (x, y) in a chunk this client has been SENT, and inside the world?
   * The same predicate the reveal mask texture is built from.
   */
  revealedAt(x: number, y: number): boolean;

  /**
   * CLIPS A STOCK MATERIAL to the received map and the world's edge: fragments
   * are discarded wherever `revealedAt` would be false. Call it ONCE PER
   * MATERIAL, not per mesh.
   */
  applyRevealClip(material: Material, label: string): void;

  /**
   * The shared uniform object a `ShaderMaterial` merges into its own — see
   * kit/revealClip.ts for the whole pattern. Shared, not copied: one mask
   * upload reaches every material holding it.
   */
  revealClipUniforms(): RevealClipUniforms;

  /**
   * Publishes the shades THIS plugin's sky things cast on the ground, so the
   * terrain and water darken under them. Returns an unpublish function.
   */
  publishGroundShade(lookup: () => readonly GroundShadeDisc[]): () => void;

  /**
   * Publishes where THIS plugin's movable things are drawn, so another plugin
   * can draw something ON one of them. Returns an unpublish function.
   */
  publishMovers(lookup: (id: number) => MoverPose | null): () => void;

  /**
   * Where another plugin's movable thing is drawn right now — the reading half
   * of `publishMovers`. Null when it publishes nothing or lacks the id.
   */
  moverPose(pluginName: string, id: number): MoverPose | null;

  /**
   * Publishes a named scalar this plugin knows — a phase, a weight.
   * `publishMovers`' rules, but NO FRAME-PHASE CONSEQUENCE: gauges read
   * off-frame.
   */
  publishGauge(key: string, read: () => number): () => void;

  /**
   * Another plugin's gauge now — `publishGauge`'s reading half. Null when
   * unpublished. The reader validates range. One lookup plus the owner's
   * closure.
   */
  gauge(pluginName: string, key: string): number | null;

  /**
   * The client mirror of the server's onIntent chain: veto a local sculpt
   * BEFORE it is sent or predicted. A vetoed intent never leaves the machine.
   */
  onLocalIntent(handler: (intent: SculptIntent) => boolean): () => void;

  /**
   * Drives the scene's sky/lighting rig — sun, hemisphere and ambient fills,
   * background colour (SkyRigState, above). Call it as often as the plugin's
   * state changes, typically every frame.
   */
  setSkyRig(state: SkyRigState): void;

  /**
   * Loads an authored model file through core, which owns the sky environment
   * its PBR materials reflect. Call from `preload`; the asset is the plugin's
   * to dispose.
   */
  loadRigAsset(url: string, lighting: RigLighting): Promise<RigAsset>;

  /**
   * DARKENS, TINTS OR OTHERWISE ADJUSTS THE SKY THE CLAIMANT PRODUCED, without
   * claiming it. Returns an unregister function; the host drops a plugin's
   * modifiers when it is unloaded.
   */
  modulateSkyRig(modify: (state: SkyRigState) => SkyRigState): () => void;
}

export interface TerraceClientPlugin {
  /** Must equal the server plugin's name — it is the message namespace. */
  readonly name: string;

  /**
   * The most renderable objects this plugin's layer may hold — its share of the
   * frame's draw calls. Required; at runtime a missing or non-finite value is
   * itself a breach.
   */
  readonly drawBudget: number;

  /**
   * The most ground-shade discs this plugin may publish — its share of the
   * shaders' shade array. Absent means none; over-publishing drops the excess.
   */
  readonly groundShadeBudget?: number;

  /**
   * NO SERVER HALF, so the live set can never name it and `syncLivePlugins`
   * must not unmount it. Absent: the server's set decides.
   */
  readonly clientOnly?: boolean;

  /** Called once at boot with the plugin's context. */
  attach(ctx: ClientPluginCtx): void;

  /**
   * Optional async bootstrap the host awaits BEFORE attach(), for setup with no
   * sync path — parsing a glTF file.
   */
  preload?(ctx: ClientPluginCtx): Promise<void>;

  /** Optional teardown; the host empties and removes the layer itself. */
  dispose?(): void;
}
