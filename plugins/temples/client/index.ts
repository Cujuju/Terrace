import { CELL_WORLD_SIZE } from '@terrace/shared';
import { createComponent, createSignal } from 'solid-js';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { isTextEntry } from '../../../client/src/plugins/kit/textEntry.ts';
import {
  TEMPLES_PLUGIN_NAME,
  TEMPLE_PLACE_MESSAGE,
  TEMPLE_REFUSED_MESSAGE,
  TEMPLE_REFUSED_GROUND,
  TEMPLE_REFUSED_NO_SETTLERS,
  TEMPLE_REFUSED_STANDING,
  TEMPLE_REMOVE_MESSAGE,
  TEMPLE_REPLACE_MESSAGE,
  TEMPLE_STATE_MESSAGE,
  TEMPLE_SURVEY_RADIUS_CELLS,
  parseTempleRefusalPayload,
  parseTempleStatePayload,
  type TempleCell,
} from '../protocol.ts';
import { TempleIcon } from './TempleIcon.tsx';
import { PlacementHint } from './PlacementHint.tsx';
import { isTempleGround } from '../suitability.ts';
import { createTempleModels, type TempleModels } from './temple.ts';
import { buildingQuality, registerBuildingQualityConsumer } from '../../../client/src/state/buildingQualityPrefs.ts';
import type { BuildingAssetKit } from '../../../client/src/render/buildingAssetKit.ts';
import { preloadAuthoredTemple } from './authoredAssets.ts';

const TEMPLE_TOOL_ID = 'place';

const TEMPLE_TOOL_LABEL = 'Temple';

const TEMPLE_TOOL_TITLE =
  'Temple: place the settlers’ temple (Ctrl-click to move it; tap Ctrl to take it down)';

const PLACEMENT_BUTTON = 0;

let models: TempleModels | null = null;
let assetKit: BuildingAssetKit | null = null;
let unsubscribeQuality: (() => void) | null = null;
let temple: TempleCell | null = null;
let toolHeld = false;
let hoverCell: TempleCell | null = null;

const RAZE_KEY = 'Control';

let ctrlTapArmed = false;
let ctrlTapStartedAt = 0;
let ctrlHeld = false;

const CTRL_TAP_MAX_MS = 250;

let refusedCell: TempleCell | null = null;

function updateControlModifier(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): void {
  const held = event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
  if (held !== ctrlHeld) refusedCell = null;
  ctrlHeld = held;
}

const [placementHint, setPlacementHint] = createSignal<string | null>(null);
let cancelFeedbackExpiry: (() => void) | null = null;

const REFUSAL_VISIBLE_MS = 6000;

const GROUND_HINT = 'The temple and its apron need flat, dry ground fully inside unlocked land.';

const REFUSAL_HINTS: Readonly<Record<number, string>> = {
  [TEMPLE_REFUSED_STANDING]: 'A temple is already standing in this world. Ctrl-click to move it here, or tap Ctrl to take it down.',
  [TEMPLE_REFUSED_GROUND]: GROUND_HINT,
  [TEMPLE_REFUSED_NO_SETTLERS]:
    'Settlers need a clear home site they can reach from this temple. Clear room nearby, then try again.',
};

function resetPlacementFeedback(): void {
  cancelFeedbackExpiry?.();
  cancelFeedbackExpiry = null;
  refusedCell = null;
  setPlacementHint(!toolHeld ? null : temple === null
    ? 'Choose flat, dry, unlocked land with room for settlers nearby. Ctrl-click moves an existing temple here.'
    : 'Ctrl-click a new site to move the temple. Click the temple or tap Ctrl to take it down.');
}

function showPlacementRefusal(ctx: ClientPluginCtx, cell: TempleCell, reason: number): void {
  cancelFeedbackExpiry?.();
  refusedCell = cell;
  setPlacementHint(REFUSAL_HINTS[reason] ??
    'The temple could not be placed here. Try again or choose another site.');
  cancelFeedbackExpiry = ctx.setTimeout(resetPlacementFeedback, REFUSAL_VISIBLE_MS);
}

let crownSeconds = 0;

let unsubscribeMessages: (() => void) | null = null;
let unsubscribeRefusals: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribePress: (() => void) | null = null;
let unsubscribeTerrain: (() => void) | null = null;
let onPointerMove: ((event: PointerEvent) => void) | null = null;
let windowListeners: Array<[string, EventListener, boolean?]> = [];

function worldX(cell: number): number {
  return cell * CELL_WORLD_SIZE;
}

function isGhostSite(ctx: ClientPluginCtx, cell: TempleCell): boolean {
  return isTempleGround({
    worldSize: ctx.worldSize(),
    heightAt: (x, y) => ctx.terrainSampleAt(x, y),
  }, cell.x, cell.y);
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

  const groundY = temple === null ? null : ctx.drawnGroundYAt(temple.x, temple.y);
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

  if (temple !== null && !ctrlHeld) {
    const razing = isOnTemple(hoverCell);
    models.ghost.visible = razing && groundY !== null;
    if (models.ghost.visible && temple !== null && groundY !== null) {
      models.setGhostLegal(false);
      models.ghost.position.set(worldX(temple.x), groundY, worldX(temple.y));
    }
    return;
  }

  const hoverGroundY = ctx.drawnGroundYAt(hoverCell.x, hoverCell.y);
  if (hoverGroundY === null) {
    models.ghost.visible = false;
    return;
  }
  models.ghost.visible = true;
  const refused = refusedCell?.x === hoverCell.x && refusedCell.y === hoverCell.y;
  models.setGhostLegal(isGhostSite(ctx, hoverCell) && !refused);
  models.ghost.position.set(worldX(hoverCell.x), hoverGroundY, worldX(hoverCell.y));
}

function handlePress(ctx: ClientPluginCtx, event: PointerEvent): boolean {
  if (!toolHeld) return false;
  if (event.button !== PLACEMENT_BUTTON) return false;
  ctrlTapArmed = false;
  updateControlModifier(event);

  const cell = ctx.pickTerrainCell(event.clientX, event.clientY);
  if (cell === null) return true;
  hoverCell = cell;
  resetPlacementFeedback();

  if (temple !== null && !ctrlHeld) {
    if (isOnTemple(cell)) ctx.send(TEMPLE_REMOVE_MESSAGE, {});
    return true;
  }
  if (isGhostSite(ctx, cell)) {
    ctx.send(ctrlHeld ? TEMPLE_REPLACE_MESSAGE : TEMPLE_PLACE_MESSAGE, { x: cell.x, y: cell.y });
  }
  else showPlacementRefusal(ctx, cell, TEMPLE_REFUSED_GROUND);
  return true;
}

function armCtrlTap(event: KeyboardEvent): void {
  if (event.key !== RAZE_KEY || event.repeat) return;
  ctrlTapArmed =
    toolHeld && !event.altKey && !event.shiftKey && !event.metaKey && !isTextEntry(event.target);
  ctrlTapStartedAt = event.timeStamp;
}

function fireCtrlTap(ctx: ClientPluginCtx, event: KeyboardEvent): void {
  if (event.key !== RAZE_KEY) return;
  const armed = ctrlTapArmed;
  const elapsed = event.timeStamp - ctrlTapStartedAt;
  ctrlTapArmed = false;
  if (!armed || !toolHeld || elapsed < 0 || elapsed > CTRL_TAP_MAX_MS) return;
  ctx.send(TEMPLE_REMOVE_MESSAGE, {});
}

const TEMPLE_STANDING_DRAW_OBJECTS = 10;

const TEMPLE_GHOST_DRAW_OBJECTS = 1;

const TEMPLE_BEACON_DRAW_OBJECTS = 2;

const TEMPLES_PER_WORLD = 1;

export const clientPlugin: TerraceClientPlugin = {
  async preload(): Promise<void> {
    assetKit?.dispose();
    assetKit = await preloadAuthoredTemple(buildingQuality());
  },
  name: TEMPLES_PLUGIN_NAME,

  drawBudget:
    TEMPLES_PER_WORLD *
    (TEMPLE_STANDING_DRAW_OBJECTS + TEMPLE_GHOST_DRAW_OBJECTS + TEMPLE_BEACON_DRAW_OBJECTS),

  attach(ctx: ClientPluginCtx): void {
    models = createTempleModels(assetKit ?? undefined);
    ctx.layer.add(models.standing, models.ghost);
    unsubscribeQuality = registerBuildingQualityConsumer(async (quality) => {
      const nextKit = await preloadAuthoredTemple(quality);
      let nextModels: TempleModels;
      try { nextModels = createTempleModels(nextKit); }
      catch (error) { nextKit.dispose(); throw error; }
      return {
        apply() {
          const previousModels = models;
          const previousKit = assetKit;
          models = nextModels;
          assetKit = nextKit;
          ctx.layer.add(models.standing, models.ghost);
          if (previousModels !== null) ctx.layer.remove(previousModels.standing, previousModels.ghost);
          renderFrame(ctx, 0);
          previousModels?.dispose();
          previousKit?.dispose();
          ctx.requestShaderWarmup();
        },
        discard() { nextModels.dispose(); nextKit.dispose(); },
      };
    });

    unsubscribeMessages = ctx.onMessage(TEMPLE_STATE_MESSAGE, (payload) => {
      temple = parseTempleStatePayload(payload);
      resetPlacementFeedback();
    });

    unsubscribeRefusals = ctx.onMessage(TEMPLE_REFUSED_MESSAGE, (payload) => {
      const refusal = parseTempleRefusalPayload(payload);
      if (refusal === null || !toolHeld) return;
      showPlacementRefusal(ctx, refusal, refusal.reason);
    });

    unsubscribeTerrain = ctx.onTerrainChanged(() => { refusedCell = null; });
    ctx.registerHudPanel(() => createComponent(PlacementHint, {
      get message() { return placementHint(); },
    }), { placement: 'bottom-center' });

    ctx.registerTool({
      id: TEMPLE_TOOL_ID,
      label: TEMPLE_TOOL_LABEL,
      title: TEMPLE_TOOL_TITLE,
      icon: TempleIcon,
      onSelected: (selected) => {
        toolHeld = selected;
        ctrlTapArmed = false;
        resetPlacementFeedback();
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
      ctrlTapArmed = false;
      updateControlModifier(event);
      hoverCell = ctx.pickTerrainCell(event.clientX, event.clientY);
      if (refusedCell !== null &&
        (hoverCell?.x !== refusedCell.x || hoverCell?.y !== refusedCell.y)) refusedCell = null;
    };

    windowListeners = [
      ['pointermove', onPointerMove as EventListener],
      ['keydown', ((event: KeyboardEvent) => {
        updateControlModifier(event);
        if (event.key === RAZE_KEY) armCtrlTap(event);
        else ctrlTapArmed = false;
      }) as EventListener],
      ['keyup', ((event: KeyboardEvent) => {
        updateControlModifier(event);
        fireCtrlTap(ctx, event);
      }) as EventListener],
      ['pointerdown', (() => { ctrlTapArmed = false; }) as EventListener, true],
      ['wheel', (() => { ctrlTapArmed = false; }) as EventListener, true],
      ['blur', (() => { ctrlTapArmed = false; ctrlHeld = false; }) as EventListener],
    ];
    for (const [type, handler, capture] of windowListeners) window.addEventListener(type, handler, capture);

    unsubscribePress = ctx.onCanvasPress((event) => handlePress(ctx, event));
    unsubscribeFrames = ctx.onFrame((dt) => renderFrame(ctx, dt));
  },

  dispose(): void {
    unsubscribeQuality?.();
    unsubscribeQuality = null;
    unsubscribeMessages?.();
    unsubscribeRefusals?.();
    unsubscribeFrames?.();
    unsubscribePress?.();
    unsubscribeTerrain?.();
    unsubscribeMessages = null;
    unsubscribeRefusals = null;
    unsubscribeFrames = null;
    unsubscribePress = null;
    unsubscribeTerrain = null;

    for (const [type, handler, capture] of windowListeners) window.removeEventListener(type, handler, capture);
    windowListeners = [];
    onPointerMove = null;

    models?.dispose();
    models = null;
    assetKit?.dispose();
    assetKit = null;
    temple = null;
    toolHeld = false;
    hoverCell = null;
    resetPlacementFeedback();
    crownSeconds = 0;
    ctrlTapArmed = false;
    ctrlHeld = false;
  },
};
