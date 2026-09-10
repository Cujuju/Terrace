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
import { voidAnchor, voidStyle } from './state/voidPrefs.ts';
import { layerEdgeStyle } from './state/layerEdgePrefs.ts';
import { frameRateTarget, frameRateTargetFps } from './state/frameRatePrefs.ts';
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
import { createDenialCue } from './render/denialCue.ts';
import { SCULPT_TOOL_ID, activeToolId } from './plugins/toolbar.ts';
import {
  createPickDebugOverlay,
  PICK_DEBUG_OVERLAY_DRAW_OBJECTS,
} from './render/pickDebugOverlay.ts';
import { startFrameRateMeter } from './render/frameRate.ts';
import { installPerfHandle } from './render/perfHandle.ts';
import { Hud } from './ui/Hud.tsx';
import './ui/hud.css';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
const hudRoot = document.querySelector<HTMLElement>('#hud');
if (canvas === null || hudRoot === null) {
  throw new Error('index.html must provide #viewport and #hud');
}

const viewport = createViewport(canvas);
if (import.meta.env.DEV) installPerfProbeEarly(viewport);
const world = createWorld(viewport);
const celestialVoid = createCelestialVoid(
  viewport,
  voidStyle(),
  voidAnchor(),
  () => world.worldSize(),
);
createEffect(() => celestialVoid.setStyle(voidStyle()));
createEffect(() => celestialVoid.setAnchor(voidAnchor()));

createEffect(() => world.setLayerEdgeStyle(layerEdgeStyle()));
createEffect(() => viewport.setFrameRateTarget(frameRateTargetFps(frameRateTarget())));

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
createEffect(() => {
  canvas.style.cursor = armedAction() === null ? '' : 'crosshair';
});
viewport.setGroundHeightSampler((worldX, worldZ) => {
  const size = world.worldSize();
  if (size === 0) return null;
  const cell = worldPointToCell(worldX, worldZ, size);
  if (cell === null) return null;
  return world.terrainHeightAt(cell.x, cell.y);
});
viewport.start();
bindCameraControls(canvas, viewport.controls);

const pluginHost = createClientPluginHost(CLIENT_PLUGINS, {
  viewport,
  world,
  connection: () => connection,
  coreDrawBudget: () =>
    world.drawBudget() +
    BRUSH_PREVIEW_DRAW_OBJECTS +
    (pickDebug === null ? 0 : PICK_DEBUG_OVERLAY_DRAW_OBJECTS),
});

const connection = connect({
  sink: world,
  operator: {
    onRestorePointList: (msg) => applyRestorePointList(msg),
    onRollbackResult: (msg) => applyRollbackResult(msg),
  },
  worldAdmin: {
    onWorldListing: (msg) => applyWorldListing(msg),
    onWorldPluginListing: (msg) => applyWorldPluginListing(msg),
    onWorldAdminResult: (msg) => applyWorldAdminResult(msg),
    onWorldSwitchNotice: (msg) => applyWorldSwitchNotice(msg),
    onWorldUnloaded: () => setWorldLoaded(false),
    onServerRestartNotice: (msg) => setPendingRestartSeconds(msg.secondsRemaining),
  },
  onStatus: (status: ConnectionStatus) => setConnectionStatus(status),
  onPluginMessage: (type, payload) => pluginHost.routeMessage(type, payload),
  onLivePlugins: (names) => pluginHost.syncLivePlugins(names),
});

const PICK_DEBUG_QUERY_FLAG = 'pickdebug';

const litLipSpan = (): number => brushRadius() * CELL_WORLD_SIZE;

const sculptInput = createSculptInput({
  canvas,
  camera: viewport.camera,
  pickCell: (origin, direction) => world.pickCell(origin, direction),
  pickInColumn: (x, y, origin, direction) => world.pickInColumn(x, y, origin, direction),
  worldSize: () => world.worldSize(),
  riserBand: (pick) =>
    world.highlightLayerEdge(pick, { litSpanWorldUnits: litLipSpan(), tool: brushTool() }),
  bandAtCell: (x, y) => world.bandAtCell(x, y),
  graspSpanBand: (pick) => world.graspSpanBand(pick),
  carveBand: (pick) => world.carveBand(pick),
  carveReach: (origin, direction, band) => world.carveReach(origin, direction, band),
  send: (intent) => {
    if (!pluginHost.allowLocalIntent(intent)) {
      sculptInput.releaseStroke();
      return false;
    }
    if (!connection.sendSculpt(intent)) return false;
    world.predictSculpt(intent);
    return true;
  },
});

const denialCue = createDenialCue(() => sculptInput.refusedHold());
const brushPreview = createBrushPreview(
  viewport.scene,
  canvas,
  () => world.worldSize(),
  denialCue,
);
const pickDebug = new URLSearchParams(window.location.search).has(PICK_DEBUG_QUERY_FLAG)
  ? createPickDebugOverlay(viewport.scene, canvas)
  : null;
viewport.onFrame(() => {
  const pick = activeToolId() === SCULPT_TOOL_ID ? sculptInput.hoverTarget() : null;
  world.setBrushRefused(denialCue.isRed());
  const grabbedBand = world.highlightLayerEdge(pick, {
    litSpanWorldUnits: litLipSpan(),
    heldBand: sculptInput.heldBand(),
    tool: brushTool(),
  });
  brushPreview.update(
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
      dir: sculptDirection(sculptMode()),
    },
  );
  pickDebug?.update(pick, grabbedBand);
});

startFrameRateMeter(viewport.onFrame);
installPerfHandle();

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

if (import.meta.env.DEV) {
  (window as unknown as { __terrace?: unknown }).__terrace = {
    viewport,
    world,
    connection,
  };
  installPerfProbe({ viewport, world, connection, pluginHost });
}
