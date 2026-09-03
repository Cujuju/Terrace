// The CLIENT half of the plugin contract (design doc: "client-side plugins
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
import type { CellOccupancy } from '../terrain/occupancy.ts';

/**
 * RE-EXPORTED so a plugin declaring an occupancy lookup imports one module —
 * this contract — rather than reaching into the client's terrain internals for
 * half its types (GH #252).
 */
export type { CellColumn, CellOccupancy, CellRayChord } from '../terrain/occupancy.ts';

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

/**
 * Where something is drawn, in WORLD units — three's own space, the same
 * coordinates `ClientPluginCtx.layer` is in, not cell space.
 *
 * `y` is the point the thing STANDS ON (its feet, a hull's waterline), not its
 * centre or its top: whatever is attached to it AT THE GROUND is attached here.
 *
 * `bodyBottomY` / `bodyHeight` describe the BODY itself — the span a flame
 * drawn on the thing should cover, at the scale it is drawn at. For a walker
 * the bottom is its feet and `bodyBottomY === y`; for a swimmer it is the belly
 * line below a centre-origin hull; for a boat it is the deck, not the keel. The
 * owner publishes these because only the owner knows the drawn scale and where
 * the body sits on its origin (decision record, fire: "the position is not on
 * the wire" — neither is the size, for the same reason).
 */
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
   *
   * NULL FOR GROUND THIS CLIENT WAS NEVER SENT, too (2026-09-02) — the
   * "band 0" sentence above is superseded. Band 0 is the sea-surface plane,
   * and a plugin that samples a footprint and keeps the highest reading (a
   * whale's hull, a walker's feet) was reading "ground at the waterline" one
   * cell past the fog frontier and lifting its creature onto it. Treat null as
   * "no ground here yet" whatever the reason; every existing consumer already
   * hides or skips on it. `drawnGroundYAt` below answers the same way.
   */
  terrainHeightAt(x: number, y: number): number | null;

  /**
   * AN OPAQUE COUNTER THAT CHANGES WHENEVER THE TERRAIN NEAR CELL (x, y) MAY
   * HAVE CHANGED — the cache key for anything a plugin derives from the ground.
   *
   * WHY A PLUGIN WANTS THIS. A plugin that reads a patch of terrain to decide
   * something (structures classifies each settlement's SITE from a 748-cell
   * disc, plugins/structures/client/site.ts) otherwise has to redo that read on
   * every event that could conceivably have moved the ground — which, for a
   * plugin driven by its own server deltas, means on every delta, however
   * small. Comparing this value against the one held alongside a cached answer
   * turns that into one array read per chunk the patch covers.
   *
   * PER CHUNK (`CHUNK_SIZE`, @terrace/shared), not per cell: it mirrors the
   * dirty sets core already derives to patch the terrain meshes. A plugin whose
   * patch spans more than one chunk asks about each of them — stepping by
   * CHUNK_SIZE across the patch is enough to touch every one.
   *
   * CONSERVATIVE IN THE SAFE DIRECTION: it may report a change where a
   * particular reader would have seen none (a predicted sculpt, its
   * authoritative echo, a neighbouring chunk across a shared border). It never
   * misses one.
   *
   * COMPARE FOR EQUALITY ONLY. The value is monotonic within a session, so
   * summing it over a FIXED set of chunks is a collision-free fingerprint of
   * that neighbourhood; nothing else about its magnitude or step size is
   * promised. 0 until the first snapshot arrives.
   */
  terrainRevisionAt(x: number, y: number): number;

  /**
   * World-space Y of the cap the terrain ACTUALLY DRAWS at a (fractional) cell
   * coordinate. Null until the first snapshot arrives.
   *
   * WHEN TO USE THIS RATHER THAN `terrainHeightAt`. A band's cap is drawn over
   * the region enclosed by the terrain's SMOOTHED MARCHED CONTOUR, not over
   * the cells the lattice assigns to that band, and the two disagree by a full
   * band — a whole world unit of relief — wherever a cell sits on the wrong
   * side of its own contour (terrain/drawnGround.ts). Anything a plugin LAYS
   * FLAT ON the ground — a decal, a scorch mark, a sheet of liquid — is seen
   * directly against that surface and must ask this one. Anything that STANDS
   * on the ground (a tree, a flame, a marker ring) can use `terrainHeightAt`:
   * a thing standing up is not seen against the surface under it, and the
   * lattice answer costs nothing.
   *
   * COST. The answer is planned per CHUNK and memoised, so the first query in
   * a chunk pays for that chunk's contour plan and the rest are lookups; the
   * whole cache is dropped whenever the terrain changes. It is a query for
   * server-delta moments (something appeared here), not a per-frame one.
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
   *
   * `occupancy` REPLACES THE RAYCAST FOR THIS SUBTREE, and any population big
   * enough to be worth drawing with an InstancedMesh should supply one (GH
   * #252). A raycast descent tests every live instance — a mature forest is
   * eight thousand of them, measured at 0.72–0.85 ms per pick, paid IN FULL
   * even when the ray hits nothing, because a world-spanning population's
   * bounding sphere accepts every ray. With a lookup the host instead marches
   * the cells the ray crosses (tens of them) and asks this what stands on
   * each. The plugin already knows: it placed them by cell.
   *
   * The lookup answers with the SILHOUETTE over that cell — see CellOccupancy.
   */
  markPickable(object: Object3D, occupancy?: CellOccupancy): () => void;

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
   * COSTS ONE CELL MARCH PLUS WHATEVER IS STILL RAYCAST (GH #252). Populations
   * that supplied an occupancy lookup to `markPickable` cost a handful of
   * lookups per cell the ray crosses; populations that did not are still
   * descended in full, per instance. It used to be the second kind only, at
   * 0.72–0.85 ms per call with a mature forest declared — a tenth of the
   * frame budget, paid even when the ray hit nothing.
   *
   * Still not free, and a tool that follows the cursor should remember the last
   * coordinates and pick ONCE PER FRAME rather than once per pointer event
   * (plugins/fire/client/index.ts's torch does exactly this).
   */
  pickWorldCell(clientX: number, clientY: number): { x: number; y: number } | null;

  /**
   * Publishes where THIS plugin's movable things are drawn, so that another
   * plugin can draw something ON one of them. Returns an unpublish function.
   *
   * PUBLISHING MOVES THIS PLUGIN EARLIER IN THE FRAME. A pose is read by
   * somebody else during the SAME frame it is written, so the host puts every
   * frame callback of a plugin that publishes into the pose phase, ahead of
   * every plugin that does not (render/scene.ts's FramePhase). Nothing is asked
   * of the publisher — it is a consequence of calling this — but it is the
   * reason a reader is entitled to say the pose it gets is the one being drawn
   * now, rather than the one drawn last frame.
   *
   * A NEUTRAL PRIMITIVE, deliberately — core's answer to the same problem
   * WorldApi.emitEvent solves on the server (design §"World events"): a plugin
   * addresses another BY NAME and validates what it gets structurally, never by
   * importing it. Core knows nothing about what is being drawn or why; it holds
   * one lookup per plugin and hands it to whoever asks.
   *
   * WHY A LOOKUP AND NOT A LIST OF POSITIONS. The reader needs the pose the
   * OWNER IS DRAWING RIGHT NOW, after that plugin's own interpolation — a
   * position copied out and re-interpolated separately drifts away from the
   * body it is supposed to be attached to, which is precisely the bug a flame
   * on a running animal would be made of. Answering per id, per frame, from the
   * owner's own draw state is what makes that impossible rather than unlikely.
   *
   * `id` is the plugin's own id for the thing, the same one its wire protocol
   * uses. Null for an id it no longer has, or is not currently drawing.
   */
  publishMovers(lookup: (id: number) => MoverPose | null): () => void;

  /**
   * Where another plugin's movable thing is drawn right now — the reading half
   * of `publishMovers`. Null when that plugin publishes nothing, does not have
   * the id, or is not drawing it this frame.
   *
   * Cheap enough for a per-frame call: one map lookup and the owner's own
   * answer.
   */
  moverPose(pluginName: string, id: number): MoverPose | null;

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

  /**
   * DARKENS, TINTS OR OTHERWISE ADJUSTS THE SKY THE CLAIMANT PRODUCED, without
   * claiming it (2026-08-27, for the storms plugin's overhead cyclone).
   *
   * WHY THIS EXISTS AT ALL, given `setSkyRig` above. The single-claimant rule
   * there is right and stays: two plugins WRITING the lights would fight, and
   * the last one to run each frame would win by accident of registration order.
   * But "who OWNS the sky" and "who has something to say about it" are two
   * different questions, and only the first of them has one answer. The
   * day/night plugin owns the sky because it is the thing that knows what time
   * it is; a hurricane parked overhead has no opinion about the time and every
   * opinion about how much of the sun gets through. Before this seam existed
   * the second plugin's only options were to fight for the claim (breaking
   * whichever of the two lost) or to draw its own dark canopy into the scene
   * (a second, inconsistent sky). Neither is a contract; this is.
   *
   * WHAT A MODIFIER IS. A PURE function from the sky as it stands to the sky as
   * this plugin would rather have it. It is called once per `setSkyRig`, in
   * registration order, and each modifier sees the previous one's output — so
   * two of them compose rather than the last one winning. Returning the state
   * unchanged is the correct way to say "not right now"; a modifier that is
   * registered but idle costs one call and one object per frame.
   *
   * WHAT IT MUST NOT DO. Touch the scene, keep the state object it was handed
   * (core does not promise to keep it either), or throw — a modifier that
   * throws is skipped for that frame and logged, exactly like every other
   * plugin-supplied callback here. It runs on the render path, so it is a place
   * for arithmetic and nothing else.
   *
   * RESIDUAL, NAMED: modifiers only run when SOMEBODY has claimed the rig,
   * because core never calls `applySkyRig` on its own — an unclaimed sky is
   * core's static boot-time look and stays that way. A world running storms
   * with no day/night plugin installed therefore gets storms it can see and a
   * sky that does not darken. That is the honest degradation (the plugin that
   * owns the sky is absent, so the sky does not move) rather than a bug, but it
   * is worth knowing before wondering why the gloom did nothing.
   *
   * Returns an unregister function; the host also drops every modifier a plugin
   * registered when that plugin is unloaded.
   */
  modulateSkyRig(modify: (state: SkyRigState) => SkyRigState): () => void;
}

export interface TerraceClientPlugin {
  /** Must equal the server plugin's name — it is the message namespace. */
  readonly name: string;

  /**
   * The most renderable objects this plugin's layer may hold — its share of
   * the frame's draw calls (part B of
   * docs/plans/frame-budget-growth-and-draw-calls.md).
   *
   * WHY EVERY PLUGIN DECLARES ONE. Every plugin gets a Group under the scene
   * and adds whatever it likes, and nothing counted: the per-object cost is
   * `projectObject` → render list → `setProgram` → uniforms → `drawArrays`,
   * measured on the owner's world at 1.55 ms for 197 calls and 3.10 ms for
   * 340 — 44 % of a 140 fps frame's 7.1 ms, at idle. The frame budget was
   * therefore spent by whichever population happened to be largest.
   *
   * WRITTEN AS AN EXPRESSION OF THE PLUGIN'S OWN CAPS — `SCAR_CAP`,
   * `MAX_FUNNELS`, `STRUCTURES_CAP` … — times the objects each of those costs,
   * plus its fixed rigs. Never a number copied from one measurement: a budget
   * set from one instant breaches by construction the next time the population
   * is larger, whereas the caps are the honest maximum. A plugin whose
   * population has NO cap needs the cap first — that is the defect, and this
   * field is where it surfaces.
   *
   * COUNTED THE WAY THREE DRAWS (see `countDrawObjects` in ./host.ts): one per
   * Mesh/Line/Points/Sprite, one for a whole InstancedMesh however many
   * instances it carries (and none while its `count` is 0), and none for a
   * subtree whose root is invisible.
   *
   * Required at the type level; at runtime a missing or non-finite value is
   * itself a breach, because a plugin loaded at runtime (design Q6) can supply
   * one.
   */
  readonly drawBudget: number;

  /** Called once at boot with the plugin's context. */
  attach(ctx: ClientPluginCtx): void;

  /** Optional teardown; the host empties and removes the layer itself. */
  dispose?(): void;
}
