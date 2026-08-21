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
import { createWorld } from './world.ts';
import { brushRadius, setConnectionStatus } from './state/hudState.ts';
import { applyRestorePointList, applyRollbackResult } from './state/rollbackState.ts';
import { createBrushPreview } from './render/brushPreview.ts';
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
  onStatus: (status: ConnectionStatus) => setConnectionStatus(status),
  onPluginMessage: (type, payload) => pluginHost.routeMessage(type, payload),
});

const sculptInput = createSculptInput({
  canvas,
  camera: viewport.camera,
  // Accessors, not snapshots: both the mesh list and the world size change
  // when chunks stream in or a new session starts.
  pickCell: (origin, direction) => world.pickCell(origin, direction),
  worldSize: () => world.worldSize(),
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
    if (!pluginHost.allowLocalIntent(intent)) return;
    if (connection.sendSculpt(intent)) world.predictSculpt(intent);
  },
});

// The brush outline follows the hover pick each frame. hoverTarget is cached
// on the pointer position AND the camera pose, so a still mouse over a still
// camera costs nothing — but a PAN re-picks every frame, deliberately (the
// outline has to track the cursor while the world moves under it). That is
// affordable because the pick marches the height field rather than raycasting
// the meshes; brushRadius is read live so the outline resizes the moment the
// HUD changes it.
const brushPreview = createBrushPreview(viewport.scene, canvas);
viewport.onFrame(() => brushPreview.update(sculptInput.hoverTarget(), brushRadius()));

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
