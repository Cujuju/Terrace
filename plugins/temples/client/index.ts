import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { isTextEntry } from '../../../client/src/plugins/kit/textEntry.ts';
import {
  TEMPLES_PLUGIN_NAME,
  TEMPLE_PLACE_MESSAGE,
  TEMPLE_REFUSED_MESSAGE,
  TEMPLE_REFUSED_STANDING,
  TEMPLE_REMOVE_MESSAGE,
  TEMPLE_STATE_MESSAGE,
  TEMPLE_SURVEY_RADIUS_CELLS,
  parseTempleRefusalPayload,
  parseTempleStatePayload,
  type TempleCell,
} from '../protocol.ts';
import { TempleIcon } from './TempleIcon.tsx';
import { createTempleModels, type TempleModels } from './temple.ts';

const TEMPLE_TOOL_ID = 'place';

const TEMPLE_TOOL_LABEL = 'Temple';

const TEMPLE_TOOL_TITLE =
  'Temple: place the settlers’ temple (Ctrl takes a standing one back down)';

const PLACEMENT_BUTTON = 0;

let models: TempleModels | null = null;
let temple: TempleCell | null = null;
let toolHeld = false;
let hoverCell: TempleCell | null = null;

const RAZE_KEY = 'Control';

let ctrlTapArmed = false;

let refusedCells = new Set<number>();

const REFUSED_KEY_STRIDE = 65536;

function refusedKey(x: number, y: number): number {
  return y * REFUSED_KEY_STRIDE + x;
}

let crownSeconds = 0;

let unsubscribeMessages: (() => void) | null = null;
let unsubscribeRefusals: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribePress: (() => void) | null = null;
let onPointerMove: ((event: PointerEvent) => void) | null = null;
let windowListeners: Array<[string, EventListener]> = [];

function worldX(cell: number): number {
  return cell * CELL_WORLD_SIZE;
}

function isGhostSite(ctx: ClientPluginCtx, cell: TempleCell): boolean {
  if (refusedCells.has(refusedKey(cell.x, cell.y))) return false;
  const centre = ctx.terrainHeightAt(cell.x, cell.y);
  if (centre === null) return false;
  for (let dy = -TEMPLE_SURVEY_RADIUS_CELLS; dy <= TEMPLE_SURVEY_RADIUS_CELLS; dy++) {
    for (let dx = -TEMPLE_SURVEY_RADIUS_CELLS; dx <= TEMPLE_SURVEY_RADIUS_CELLS; dx++) {
      const height = ctx.terrainHeightAt(cell.x + dx, cell.y + dy);
      if (height === null || height !== centre) return false;
      if (height <= -1) return false;
    }
  }
  return true;
}

function isOnTemple(cell: TempleCell): boolean {
  if (temple === null) return false;
  return (
    Math.abs(cell.x - temple.x) <= TEMPLE_SURVEY_RADIUS_CELLS &&
    Math.abs(cell.y - temple.y) <= TEMPLE_SURVEY_RADIUS_CELLS
  );
}

function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  if (models === null) return;

  crownSeconds += dt;

  const groundY = temple === null ? null : ctx.terrainHeightAt(temple.x, temple.y);
  if (temple === null || groundY === null) {
    models.standing.visible = false;
  } else {
    models.standing.visible = true;
    models.standing.position.set(worldX(temple.x), groundY, worldX(temple.y));
    models.setBeaconVisible(toolHeld);
    models.animate(crownSeconds);
  }

  if (!toolHeld || hoverCell === null) {
    models.ghost.visible = false;
    return;
  }

  if (temple !== null) {
    const razing = isOnTemple(hoverCell);
    models.ghost.visible = razing && groundY !== null;
    if (models.ghost.visible && temple !== null && groundY !== null) {
      models.setGhostLegal(false);
      models.ghost.position.set(worldX(temple.x), groundY, worldX(temple.y));
    }
    return;
  }

  const hoverGroundY = ctx.terrainHeightAt(hoverCell.x, hoverCell.y);
  if (hoverGroundY === null) {
    models.ghost.visible = false;
    return;
  }
  models.ghost.visible = true;
  models.setGhostLegal(isGhostSite(ctx, hoverCell));
  models.ghost.position.set(worldX(hoverCell.x), hoverGroundY, worldX(hoverCell.y));
}

function handlePress(ctx: ClientPluginCtx, event: PointerEvent): boolean {
  if (!toolHeld) return false;
  if (event.button !== PLACEMENT_BUTTON) return false;

  const cell = ctx.pickTerrainCell(event.clientX, event.clientY);
  if (cell === null) return true;

  if (temple !== null) {
    if (isOnTemple(cell)) ctx.send(TEMPLE_REMOVE_MESSAGE, {});
    return true;
  }
  if (isGhostSite(ctx, cell)) ctx.send(TEMPLE_PLACE_MESSAGE, { x: cell.x, y: cell.y });
  return true;
}

function armCtrlTap(event: KeyboardEvent): void {
  if (event.key !== RAZE_KEY || event.repeat) return;
  ctrlTapArmed =
    !event.altKey && !event.shiftKey && !event.metaKey && !isTextEntry(event.target);
}

function fireCtrlTap(ctx: ClientPluginCtx, event: KeyboardEvent): void {
  if (event.key !== RAZE_KEY) return;
  const armed = ctrlTapArmed;
  ctrlTapArmed = false;
  if (!armed || !toolHeld || temple === null) return;
  ctx.send(TEMPLE_REMOVE_MESSAGE, {});
}

const TEMPLE_STANDING_DRAW_OBJECTS = 10;

const TEMPLE_GHOST_DRAW_OBJECTS = 1;

const TEMPLE_BEACON_DRAW_OBJECTS = 2;

const TEMPLES_PER_WORLD = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: TEMPLES_PLUGIN_NAME,

  drawBudget:
    TEMPLES_PER_WORLD *
    (TEMPLE_STANDING_DRAW_OBJECTS + TEMPLE_GHOST_DRAW_OBJECTS + TEMPLE_BEACON_DRAW_OBJECTS),

  attach(ctx: ClientPluginCtx): void {
    models = createTempleModels();
    ctx.layer.add(models.standing, models.ghost);

    unsubscribeMessages = ctx.onMessage(TEMPLE_STATE_MESSAGE, (payload) => {
      temple = parseTempleStatePayload(payload);
    });

    unsubscribeRefusals = ctx.onMessage(TEMPLE_REFUSED_MESSAGE, (payload) => {
      const refusal = parseTempleRefusalPayload(payload);
      if (refusal === null) return;
      if (refusal.reason === TEMPLE_REFUSED_STANDING) return;
      refusedCells.add(refusedKey(refusal.x, refusal.y));
    });

    ctx.registerTool({
      id: TEMPLE_TOOL_ID,
      label: TEMPLE_TOOL_LABEL,
      title: TEMPLE_TOOL_TITLE,
      icon: TempleIcon,
      onSelected: (selected) => {
        toolHeld = selected;
        if (selected) {
          refusedCells = new Set();
        }
        if (!selected) {
          hoverCell = null;
          if (models !== null) {
            models.ghost.visible = false;
            models.setBeaconVisible(false);
          }
        }
      },
    });

    onPointerMove = (event: PointerEvent): void => {
      if (!toolHeld) return;
      hoverCell = ctx.pickTerrainCell(event.clientX, event.clientY);
    };

    windowListeners = [
      ['pointermove', onPointerMove as EventListener],
      ['keydown', ((event: KeyboardEvent) => {
        if (event.key === RAZE_KEY) armCtrlTap(event);
        else ctrlTapArmed = false;
      }) as EventListener],
      ['keyup', ((event: KeyboardEvent) => fireCtrlTap(ctx, event)) as EventListener],
      ['pointerdown', (() => { ctrlTapArmed = false; }) as EventListener],
      ['wheel', (() => { ctrlTapArmed = false; }) as EventListener],
      ['blur', (() => { ctrlTapArmed = false; }) as EventListener],
    ];
    for (const [type, handler] of windowListeners) window.addEventListener(type, handler);

    unsubscribePress = ctx.onCanvasPress((event) => handlePress(ctx, event));
    unsubscribeFrames = ctx.onFrame((dt) => renderFrame(ctx, dt));
  },

  dispose(): void {
    unsubscribeMessages?.();
    unsubscribeRefusals?.();
    unsubscribeFrames?.();
    unsubscribePress?.();
    unsubscribeMessages = null;
    unsubscribeRefusals = null;
    unsubscribeFrames = null;
    unsubscribePress = null;

    for (const [type, handler] of windowListeners) window.removeEventListener(type, handler);
    windowListeners = [];
    onPointerMove = null;

    models?.dispose();
    models = null;
    temple = null;
    toolHeld = false;
    hoverCell = null;
    refusedCells = new Set();
    crownSeconds = 0;
    ctrlTapArmed = false;
  },
};
