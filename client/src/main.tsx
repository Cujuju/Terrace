// Entry point. Boots the imperative renderer, wires input and network to it,
// then mounts the Solid HUD alongside — never inside — the canvas.
//
// Boot order matters: the viewport and world are created FIRST and the render
// loop starts immediately, so the app is a usable (if empty) sea before any
// network activity. Nothing here blocks on the server being reachable.

import { render } from 'solid-js/web';
import { connect, type ConnectionStatus } from './net/connection.ts';
import { bindCameraControls } from './input/cameraBindings.ts';
import { createSculptInput } from './input/sculptInput.ts';
import { createClientPluginHost } from './plugins/host.ts';
import { CLIENT_PLUGINS } from './plugins/registry.ts';
import { createViewport } from './render/scene.ts';
import { worldPointToCell } from './terrain/picking.ts';
import { createWorld } from './world.ts';
import {
  brushProfile,
  brushRadius,
  brushTool,
  setConnectionStatus,
} from './state/hudState.ts';
import { applyRestorePointList, applyRollbackResult } from './state/rollbackState.ts';
import {
  applyWorldAdminResult,
  applyWorldListing,
  applyWorldSwitchNotice,
  setWorldLoaded,
} from './state/worldsState.ts';
import { createBrushPreview } from './render/brushPreview.ts';
import { createPickDebugOverlay } from './render/pickDebugOverlay.ts';
import { startFrameRateMeter } from './render/frameRate.ts';
import { Hud } from './ui/Hud.tsx';
import './ui/hud.css';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
const hudRoot = document.querySelector<HTMLElement>('#hud');
if (canvas === null || hudRoot === null) {
  throw new Error('index.html must provide #viewport and #hud');
}

const viewport = createViewport(canvas);
const world = createWorld(viewport);
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
    onWorldAdminResult: (msg) => applyWorldAdminResult(msg),
    onWorldSwitchNotice: (msg) => applyWorldSwitchNotice(msg),
    // The server has closed its world. The banner says so until a snapshot
    // arrives, which is what marks a world loaded again (see world.ts).
    onWorldUnloaded: () => setWorldLoaded(false),
  },
  onStatus: (status: ConnectionStatus) => setConnectionStatus(status),
  onPluginMessage: (type, payload) => pluginHost.routeMessage(type, payload),
});

const sculptInput = createSculptInput({
  canvas,
  camera: viewport.camera,
  // Accessors, not snapshots: both the mesh list and the world size change
  // when chunks stream in or a new session starts.
  pickCell: (origin, direction) => world.pickCell(origin, direction),
  // The outline's ground height, re-read every frame for the cell the pick
  // already chose — see sculptInput's hoverTarget for why the cell is cached
  // and this is not.
  terrainHeightAt: (x, y) => world.terrainHeightAt(x, y),
  worldSize: () => world.worldSize(),
  // THE GRAB QUERY — the same call the frame loop below makes to highlight the
  // lip under the cursor, so what is lit up is exactly what a press grabs.
  grabbableLip: (cell) => world.highlightLayerEdge(cell),
  // CLIENT-SIDE PREDICTION (design §3.3). Send first, then apply the very same
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
const brushPreview = createBrushPreview(viewport.scene, canvas);
// The pick-debug overlay reads the SAME pick object as the outline, so the two
// can never disagree about what is under the pointer. See its module header for
// why it draws one cell and nothing richer.
const pickDebug = createPickDebugOverlay(viewport.scene, canvas);
viewport.onFrame(() => {
  const pick = sculptInput.hoverTarget();
  // THE LIP QUERY RUNS FIRST, and its answer feeds all three consumers: it
  // lights the contour, it tells the readout which band is grabbable, and it
  // tells the outline whether this press would drag (crosshair) or stamp
  // (footprint). One query, so the highlight the player sees, the readout and
  // the pointer shape can never disagree about what is under the cursor —
  // and it is the same question input/sculptInput.ts asks on pointerdown.
  const grabbedBand = world.highlightLayerEdge(pick);
  brushPreview.update(
    // GRABBABLE MEANS "THIS PRESS WILL TAKE HOLD", so it is gated on the tool
    // the same way pointerdown is (input/sculptInput.ts). A lip under the
    // cursor with Stamp selected is not grabbable — the press will stamp — and
    // a pointer that said otherwise would be advertising the wrong edit.
    pick === null
      ? null
      : { ...pick, grabbable: grabbedBand !== null && brushTool() === 'drag' },
    {
      radius: brushRadius(),
      tool: brushTool(),
      profile: brushProfile(),
    },
  );
  pickDebug.update(pick, grabbedBand);
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
}
