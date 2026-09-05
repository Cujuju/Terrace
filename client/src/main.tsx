// Entry point. Boots the imperative renderer, wires input and network to it,
// then mounts the Solid HUD alongside — never inside — the canvas.
//
// Boot order matters: the viewport and world are created FIRST and the render
// loop starts immediately, so the app is a usable (if empty) sea before any
// network activity. Nothing here blocks on the server being reachable.

import { createEffect } from 'solid-js';
import { render } from 'solid-js/web';
import { Raycaster, Vector2 } from 'three';
import { connect, type ConnectionStatus } from './net/connection.ts';
import { bindCameraControls } from './input/cameraBindings.ts';
import { createSculptInput } from './input/sculptInput.ts';
import { createClientPluginHost } from './plugins/host.ts';
import { CLIENT_PLUGINS } from './plugins/registry.ts';
import { createViewport } from './render/scene.ts';
import { createCelestialVoid } from './render/celestialVoid.ts';
import { voidStyle } from './state/voidPrefs.ts';
import { pointerToNdc, worldPointToCell } from './terrain/picking.ts';
import { CELL_WORLD_SIZE } from './config.ts';
import { createWorld } from './world.ts';
import { installPerfProbe, installPerfProbeEarly } from './perfProbe.ts';
import {
  brushProfile,
  brushRadius,
  brushTool,
  sculptDirection,
  sculptMode,
  setConnectionStatus,
} from './state/hudState.ts';
import { applyRestorePointList, applyRollbackResult } from './state/rollbackState.ts';
import {
  applyWorldAdminResult,
  applyWorldListing,
  applyWorldPluginListing,
  applyWorldSwitchNotice,
  armedAction,
  setArmedAction,
  setPendingRestartSeconds,
  setWorldFeedback,
  setWorldLoaded,
  worldAdminKey,
} from './state/worldsState.ts';
import { BRUSH_PREVIEW_DRAW_OBJECTS, createBrushPreview } from './render/brushPreview.ts';
import { SCULPT_TOOL_ID, activeToolId } from './plugins/toolbar.ts';
import {
  createPickDebugOverlay,
  PICK_DEBUG_OVERLAY_DRAW_OBJECTS,
} from './render/pickDebugOverlay.ts';
import { startFrameRateMeter } from './render/frameRate.ts';
import { Hud } from './ui/Hud.tsx';
import './ui/hud.css';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
const hudRoot = document.querySelector<HTMLElement>('#hud');
if (canvas === null || hudRoot === null) {
  throw new Error('index.html must provide #viewport and #hud');
}

const viewport = createViewport(canvas);
// THE REAL-GPU BENCHMARK'S FIRST HALF (client/src/perfProbe.ts,
// scripts/gpu-bench.md). Here, before createWorld, because this is what wraps
// viewport.onFrame — every frame handler core and the plugins register below
// has to go through it to be attributable. Inert without `?perfprobe=<scenario>`
// on the page URL, and eliminated entirely from a production build: DEV is
// statically false there, exactly as for the __terrace handle at the bottom.
if (import.meta.env.DEV) installPerfProbeEarly(viewport);
// WHAT IS OUTSIDE THE MAP (render/celestialVoid.ts, issue #326). Wired here
// rather than inside createViewport because the look is a player preference
// (state/voidPrefs.ts) and the viewport deliberately knows nothing about the
// HUD's state — same split as the ground-height sampler below. Created with
// the stored style so the first frame is already the right look, then kept in
// step by the effect: Solid re-runs it on every change, which is what makes
// the panel's <select> apply live with no reload.
const celestialVoid = createCelestialVoid(viewport, voidStyle());
createEffect(() => celestialVoid.setStyle(voidStyle()));
const world = createWorld(viewport);

// THE PLACEMENT LISTENER — where an armed admin action lands (owner,
// 2026-09-01; ui/AdminPanel.tsx arms, ui/AdminAim.tsx explains). Capture
// phase, and registered BEFORE the plugin host's capture listener below so
// it is consulted first: while an action is armed the press belongs to it,
// not to a relic under the pointer, the brush or the camera. Only the
// primary button — a right-drag mid-aim still orbits, so the operator can
// line the shot up. The pick is the same height-field ray the brush uses.
const placementRaycaster = new Raycaster();
const placementNdc = new Vector2();
const onPlacementPointerDown = (event: PointerEvent): void => {
  const armed = armedAction();
  if (armed === null || event.button !== 0) return;
  event.stopImmediatePropagation();
  event.preventDefault();
  const device = pointerToNdc(event.clientX, event.clientY, canvas.getBoundingClientRect());
  if (device === null) return;
  placementNdc.set(device.x, device.y);
  placementRaycaster.setFromCamera(placementNdc, viewport.camera);
  const pick = world.pickCell(placementRaycaster.ray.origin, placementRaycaster.ray.direction);
  // A miss (the sky, fog) leaves the action armed: the operator meant to
  // aim, and has not yet.
  if (pick === null) return;
  setArmedAction(null);
  setWorldFeedback({ kind: 'working' });
  connection.sendWorldAdmin({
    type: 'worldPluginAct',
    key: worldAdminKey(),
    plugin: armed.plugin,
    action: armed.key,
    x: pick.x,
    y: pick.y,
  });
};
canvas.addEventListener('pointerdown', onPlacementPointerDown, { capture: true });
// A crosshair while aiming, so the arm is visible at the pointer and not
// only in the banner.
createEffect(() => {
  canvas.style.cursor = armedAction() === null ? '' : 'crosshair';
});
// The camera's ground floor (render/cameraClearance.ts). Wired here because
// this is the only place that holds both halves: the viewport owns the camera
// and knows nothing of terrain, the world owns the height field and knows
// nothing of the camera. Reads the world on every call rather than capturing a
// height field, so a rejoin's replacement mirror is picked up for free.
viewport.setGroundHeightSampler((worldX, worldZ) => {
  const size = world.worldSize();
  if (size === 0) return null; // no snapshot yet: no ground to be under
  const cell = worldPointToCell(worldX, worldZ, size);
  if (cell === null) return null; // camera is off the world
  return world.terrainHeightAt(cell.x, cell.y);
});
viewport.start();
bindCameraControls(canvas, viewport.controls);

// The host is created before the connection because the connection's options
// need routeMessage; the host reads the connection lazily (see plugins/host.ts)
// so the cycle is broken without a setter. Plugin attach() runs here, before
// any server contact — sends during attach would go nowhere by design.
const pluginHost = createClientPluginHost(CLIENT_PLUGINS, {
  viewport,
  world,
  connection: () => connection,
  // Core's own share of the frame's draw budget — the same ratchet the plugins
  // are held to, with no pass for core (part B of
  // docs/plans/frame-budget-growth-and-draw-calls.md). The world owns the five
  // terrain-side rigs and reports them itself; the two rigs THIS file owns are
  // added here. A thunk because both of them are built below, after the host,
  // and because the world's half is live (super-mesh counts grow as a world is
  // revealed).
  coreDrawBudget: () =>
    world.drawBudget() +
    BRUSH_PREVIEW_DRAW_OBJECTS +
    (pickDebug === null ? 0 : PICK_DEBUG_OVERLAY_DRAW_OBJECTS),
});

const connection = connect({
  sink: world,
  // Operator answers (world rollback) go straight to the panel's state, the
  // same documented "imperative layer writes the signals" pattern the terrain
  // sink uses for world identity.
  operator: {
    onRestorePointList: (msg) => applyRestorePointList(msg),
    onRollbackResult: (msg) => applyRollbackResult(msg),
  },
  // World-management answers (multi-world). Same pattern, a separate sink
  // because it is gated by a separate key — see WorldAdminSink.
  worldAdmin: {
    onWorldListing: (msg) => applyWorldListing(msg),
    onWorldPluginListing: (msg) => applyWorldPluginListing(msg),
    onWorldAdminResult: (msg) => applyWorldAdminResult(msg),
    onWorldSwitchNotice: (msg) => applyWorldSwitchNotice(msg),
    // The server has closed its world. The banner says so until a snapshot
    // arrives, which is what marks a world loaded again (see world.ts).
    onWorldUnloaded: () => setWorldLoaded(false),
    // The process is going down. The banner says so; the reconnect and the
    // one-shot reload that follow are the connection layer's own business.
    onServerRestartNotice: (msg) => setPendingRestartSeconds(msg.secondsRemaining),
  },
  onStatus: (status: ConnectionStatus) => setConnectionStatus(status),
  onPluginMessage: (type, payload) => pluginHost.routeMessage(type, payload),
  // Per-world plugin enablement: the snapshot names the plugins the server is
  // running, and the host mounts/unmounts to match. A toggle reopens the world,
  // which re-sends the snapshot, so this is also how a toggle reaches a client
  // that never asked for anything.
  onLivePlugins: (names) => pluginHost.syncLivePlugins(names),
});

/** Page-URL query flag that turns the pick-debug overlay on (see its creation below). */
const PICK_DEBUG_QUERY_FLAG = 'pickdebug';

/**
 * How much of the grabbed lip lights up either side of the pointer, in world
 * units: THE BRUSH RADIUS (owner, 2026-08-27 — "I want that mouse pointer to be
 * pointing to those cells on the band lip"). The lit stretch is then exactly
 * the run of lip a press would move, so the pointer and the highlight name the
 * same cells instead of leaving the player to intersect the two by eye. It was
 * a fixed 2 world units inside the overlay, a length with no relationship to
 * the edit a press makes.
 *
 * CONVERTED HERE because this is the one place both units are in scope: the
 * HUD's radius is in CELLS (state/hudState.ts, and the wire's own unit) while
 * the overlay measures every distance in world units.
 */
const litLipSpan = (): number => brushRadius() * CELL_WORLD_SIZE;

const sculptInput = createSculptInput({
  canvas,
  camera: viewport.camera,
  // Accessors, not snapshots: both the mesh list and the world size change
  // when chunks stream in or a new session starts.
  pickCell: (origin, direction) => world.pickCell(origin, direction),
  // THE HOVER CACHE'S ONLY MAP QUERY: the pinned ray, re-asked of the pinned
  // column of the live terrain, every read. See sculptInput's hoverTarget for
  // why the cell and the ray are cached and nothing derived from them is.
  pickInColumn: (x, y, origin, direction) => world.pickInColumn(x, y, origin, direction),
  worldSize: () => world.worldSize(),
  // THE GRAB QUERY — the same call the frame loop below makes to highlight the
  // lip under the cursor, so what is lit up is exactly what a press grabs.
  // The TOOL rides along because the carve reads a tread differently from the
  // pull (world.ts's LayerEdgeLight.tool); read live, like every other HUD
  // state here.
  riserBand: (pick) =>
    world.highlightLayerEdge(pick, { litSpanWorldUnits: litLipSpan(), tool: brushTool() }),
  bandAtCell: (x, y) => world.bandAtCell(x, y),
  graspSpanBand: (pick) => world.graspSpanBand(pick),
  carveBand: (pick) => world.carveBand(pick),
  // CLIENT-SIDE PREDICTION (design doc). Send first, then apply the very same
  // intent locally with the shared terrain math so the brush responds this
  // frame instead of a round trip later; the world reconciles it against the
  // authoritative diff when that arrives. Predicting only when the intent
  // reached the wire is deliberate — an intent dropped while offline will never
  // be answered, so predicting it would put the local terrain permanently ahead
  // of the server.
  send: (intent) => {
    // Client-side interceptor chain first (mirrors the server's): a plugin
    // veto (out of mana, say) stops the intent HERE — nothing is sent, nothing
    // is predicted, so a refusal cannot flicker. The server still runs its own
    // authoritative chain on whatever does go out.
    if (!pluginHost.allowLocalIntent(intent)) return false;
    if (!connection.sendSculpt(intent)) return false;
    world.predictSculpt(intent);
    // Reported back so the caller knows the intent reached the wire. A drag
    // no longer depends on the answer to stay whole — it re-sends its entire
    // region on the next pointer move — but it still uses it to avoid marking
    // a region as sent when it was not.
    return true;
  },
});

// The brush outline follows the hover pick each frame. hoverTarget is cached
// on the pointer position AND the camera pose, so a still mouse over a still
// camera costs nothing — but a PAN re-picks every frame, deliberately (the
// outline has to track the cursor while the world moves under it). That is
// affordable because the pick marches the height field rather than raycasting
// the meshes; radius, tool and edge are all read live so the outline reshapes
// the moment the
// HUD changes it.
const brushPreview = createBrushPreview(viewport.scene, canvas, () => world.worldSize());
// The pick-debug overlay reads the SAME pick object as the outline, so the two
// can never disagree about what is under the pointer. See its module header for
// why it draws one cell and nothing richer.
//
// A DIAGNOSTIC, OFF BY DEFAULT (owner, 2026-08-27: "why does the square still
// draw on the top band?"). Its marker is one flat cell at the column's CAP,
// which on a riser hit is the clifftop — exactly the place the pointer no
// longer stands. Opt in with `?pickdebug` on the page URL, the same query-flag
// convention the preview pages use (previewArch.ts, previewFire.ts).
const pickDebug = new URLSearchParams(window.location.search).has(PICK_DEBUG_QUERY_FLAG)
  ? createPickDebugOverlay(viewport.scene, canvas)
  : null;
viewport.onFrame(() => {
  // THE BRUSH IS ONLY LIVE WHEN NOTHING ELSE IS HELD (owner, 2026-08-24).
  // A plugin tool takes the pointer (plugins/toolbar.ts), so core stops
  // answering "what would a press do here" — no outline, no lit contour, no
  // pick readout. Suppressed at the PICK, not at each consumer, so the three
  // of them cannot disagree about whether the brush is in play; the press
  // itself is already the plugin's, claimed in the capture phase.
  const pick = activeToolId() === SCULPT_TOOL_ID ? sculptInput.hoverTarget() : null;
  // THE LIP QUERY RUNS FIRST, and its answer feeds all three consumers: it
  // lights the contour, it tells the readout which band is grabbable, and it
  // tells the outline whether this press would drag (crosshair) or stamp
  // (footprint). One query, so the highlight the player sees, the readout and
  // the pointer shape can never disagree about what is under the cursor —
  // and it is the same question input/sculptInput.ts asks on pointerdown.
  //
  // A LIVE STROKE'S GRAB OVERRIDES THE PICK. A pull drags the pointer off the
  // riser it grabbed within the first cell of travel, and the pick-derived band
  // is null everywhere but on a riser — so without this the lip the player was
  // holding went dark while they were still holding it.
  const grabbedBand = world.highlightLayerEdge(pick, {
    litSpanWorldUnits: litLipSpan(),
    heldBand: sculptInput.heldBand(),
    // THE SAME TOOL THE PRESS WOULD USE, so the lit lip is the one a press
    // takes — the carve's corner-edge rule and the pull's riser-only rule
    // genuinely differ on a tread (D1, owner 2026-09-04).
    tool: brushTool(),
  });
  brushPreview.update(
    // GRABBABLE MEANS "THIS PRESS WILL TAKE HOLD", so it is gated on the tool
    // the same way pointerdown is (input/sculptInput.ts). A lip under the
    // cursor with Stamp selected is not grabbable — the press will stamp — and
    // a pointer that said otherwise would be advertising the wrong edit.
    pick === null
      ? null
      : {
          ...pick,
          grabbable: grabbedBand !== null && brushTool() === 'drag',
          band: grabbedBand,
        },
    {
      radius: brushRadius(),
      tool: brushTool(),
      profile: brushProfile(),
      // THE MODE IS PART OF THE SHAPE, not just of the sign. Lowering drops the
      // whole footprint a band while a soft raise clears the band above only at
      // the centre, so the same radius promises up to 31 cells more one way
      // than the other (the table in render/brushPreview.ts). Read the same way
      // input/sculptInput.ts reads it for the intent it sends, so the ring and
      // the click are the same direction by construction.
      //
      // RESIDUAL, stated: a press resolves through `resolvePress` (button AND
      // modifier), while `syncMode` can only infer the mode from the MODIFIER.
      // Under the default bindings the two agree — raise and lower share the
      // left button and differ by shift — but a player who rebinds Lower to a
      // different BUTTON at the same modifier gets a ring for the mode the HUD
      // shows, not for the button they are about to press. A hover knows no
      // button, so closing that needs the Mode readout to become
      // button-aware — the same gap the HUD indicator already has.
      dir: sculptDirection(sculptMode()),
    },
  );
  pickDebug?.update(pick, grabbedBand);
});

// The frame-rate readout in the top-right watermark. Started here, beside the
// other viewport frame hooks, because the viewport is what it measures.
startFrameRateMeter(viewport.onFrame);

render(
  () => (
    <Hud
      chartSource={() => world.chartSource()}
      rollback={{
        list: (key) => connection.requestRestorePoints(key),
        apply: (key, toId) => connection.requestRollback(key, toId),
      }}
      worlds={{
        send: (message) => connection.sendWorldAdmin(message),
      }}
      restartStack={() => connection.sendStackRestart()}
    />
  ),
  hudRoot,
);

// Dev-only handle for headless smoke automation: lets a driver read the real
// camera matrices and world state instead of guessing them. import.meta.env.DEV
// is statically false in production builds, so the whole block is eliminated.
if (import.meta.env.DEV) {
  (window as unknown as { __terrace?: unknown }).__terrace = {
    viewport,
    world,
    connection,
  };
  // The benchmark's second half — the scenario runner, which needs the world,
  // the connection and the plugin host, so it cannot be installed with the
  // early wrappers above. Also inert without `?perfprobe=<scenario>`.
  installPerfProbe({ viewport, world, connection, pluginHost });
}
