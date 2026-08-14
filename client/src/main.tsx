// Entry point. Boots the imperative renderer, wires input and network to it,
// then mounts the Solid HUD alongside — never inside — the canvas.
//
// Boot order matters: the viewport and world are created FIRST and the render
// loop starts immediately, so the app is a usable (if empty) sea before any
// network activity. Nothing here blocks on the server being reachable.

import { render } from 'solid-js/web';
import { connect, type ConnectionStatus } from './net/connection.ts';
import { createSculptInput } from './input/sculptInput.ts';
import { createViewport } from './render/scene.ts';
import { createWorld } from './world.ts';
import { setConnectionStatus } from './state/hudState.ts';
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

const connection = connect({
  sink: world,
  onStatus: (status: ConnectionStatus) => setConnectionStatus(status),
});

createSculptInput({
  canvas,
  camera: viewport.camera,
  // Accessors, not snapshots: both the mesh list and the world size change
  // when chunks stream in or a new session starts.
  pickables: () => world.pickables(),
  worldSize: () => world.worldSize(),
  // CLIENT-SIDE PREDICTION (design §3.3). Send first, then apply the very same
  // intent locally with the shared terrain math so the brush responds this
  // frame instead of a round trip later; the world reconciles it against the
  // authoritative diff when that arrives. Predicting only when the intent
  // reached the wire is deliberate — an intent dropped while offline will never
  // be answered, so predicting it would put the local terrain permanently ahead
  // of the server.
  send: (intent) => {
    if (connection.sendSculpt(intent)) world.predictSculpt(intent);
  },
});

render(() => <Hud />, hudRoot);
