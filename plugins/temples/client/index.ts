// temples — client half: the Temple tool on the bottom toolbar, the placement
// ghost it drags around, and the one standing temple the server says exists.
//
// NO AUTHORITY, NO PREDICTION. A press sends an intent and nothing more; the
// temple appears when `temples:state` says it does — nothing is drawn that a
// refusal would have to take away.
//
// WHAT A REFUSAL DOES INSTEAD IS TEACH THE GHOST. The server answers a refused
// press with the cell and a reason (`temples:refused`), and this half remembers
// that cell: the ghost reads red there from the next frame on, so the press
// that failed explains itself in the world's own vocabulary and a second press
// on the same spot is never offered. No banner, no toast, no error text — the
// affordance is the message, which is the same principle the rest of this file
// is built on.
//
// THE REMEMBERED SET IS PROVABLY FRESH, and it is the tool that proves it:
// terrain can only be sculpted with a sculpt tool held, and picking up any
// other tool drops this one — so clearing the set whenever the tool is taken
// up again means no refusal can survive an edit to the ground it was about.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TOOL'S TWO ACTIONS, AND WHY THE GHOST IS THE ONLY UI.
//
// Holding the tool with NO temple standing: a stone ghost follows the cursor,
// green where the ground will take it and red where it will not, and a press
// builds. Holding it with a temple ALREADY standing: no ghost anywhere except
// over the temple itself, where the ghost turns red — a press there knocks it
// down. That is the whole of "you can place one, and you can move it by
// destroying it and rebuilding it" (owner, 2026-08-24), said in the world
// rather than in an error message: there is never a press that fails with an
// explanation, because the affordance is only ever offered where a press does
// something.
//
// THE ONE HONEST GAP, named rather than papered over. The client tests the
// ground with the RENDERED band height (ClientPluginCtx.terrainHeightAt),
// which cannot tell dry land at raw height 0 from the waterline at raw height
// 0 — band 0 covers both, and no client has the raw height (structures'
// client/site.ts documents this in full). So on a strip of exactly-sea-level
// ground the ghost can read green where the server will refuse. The refusal
// is silent and costs nothing, the strip is one band deep at the waterline,
// and closing it would mean putting raw heights on the wire for a cosmetic
// hint. Every OTHER way the two can disagree is closed: the ghost surveys the
// same square, by the same rule, as server/suitability.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
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

/** The tool's id within this plugin; the host namespaces it `temples:place`. */
const TEMPLE_TOOL_ID = 'place';

const TEMPLE_TOOL_LABEL = 'Temple';

const TEMPLE_TOOL_TITLE =
  'Put down the stone temple settlers come from — one per world. Press it again to knock it down and build elsewhere.';

/**
 * The mouse button a placement press is made with. 0 — the primary button
 * only, so a middle- or right-drag still reaches the camera: holding a tool
 * must never cost the player the ability to look around.
 */
const PLACEMENT_BUTTON = 0;

let models: TempleModels | null = null;
/** The server's answer, and the only reason the standing temple is drawn. */
let temple: TempleCell | null = null;
/** True while this plugin's tool is the held one (core tells us — toolbar.ts). */
let toolHeld = false;
/** The cell under the cursor, or null when the pointer is off the ground. */
let hoverCell: TempleCell | null = null;

/**
 * Cells the server has refused a placement on this tool-hold, packed x*STRIDE+y.
 *
 * Only cells refused for a reason ABOUT THE GROUND go in — "a temple already
 * stands" is a fact about the world, not about the cell, and remembering it
 * would leave a red patch behind after the temple came down. Cleared whenever
 * the tool is taken up: see this file's header for why that is enough to keep
 * the set honest across a sculpt.
 */
let refusedCells = new Set<number>();

/**
 * Packs a cell into one comparable key. 65536 — the stride every plugin in
 * this repo uses for the same job, and for the same reason: the heightmap's
 * Int16 storage caps a world edge at 32767, so no two cells can collide.
 */
const REFUSED_KEY_STRIDE = 65536;

function refusedKey(x: number, y: number): number {
  return y * REFUSED_KEY_STRIDE + x;
}

/**
 * The crown's clock: elapsed seconds since attach, accumulated from the host's
 * already-capped `dt` so a backgrounded tab cannot jump the star half a turn.
 *
 * IT RUNS WHETHER OR NOT A TEMPLE STANDS, deliberately: the crown's pose is a
 * pure function of this number (celestial.ts), so a temple built, razed and
 * rebuilt picks the sky-machine up mid-turn instead of snapping it back to a
 * start pose every time — which is what "the heavens do not wait for you"
 * looks like in one variable.
 */
let crownSeconds = 0;

let unsubscribeMessages: (() => void) | null = null;
let unsubscribeRefusals: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribePress: (() => void) | null = null;
let onPointerMove: ((event: PointerEvent) => void) | null = null;

/** Cell → world-unit X/Z, the one conversion every placement in this repo makes. */
function worldX(cell: number): number {
  return cell * CELL_WORLD_SIZE;
}

/**
 * Would a press on this cell build? The client's copy of the server's site
 * rule (server/suitability.ts), expressed against the only terrain a client
 * has: the RENDERED, band-quantised surface. Same square, same "one flat
 * terrace, all of it known" test — see this file's header for the one case
 * where the two can still disagree.
 *
 * Unknown ground (a chunk this client has never been sent) counts as NOT
 * suitable: a ghost that promised a temple on terrain nobody has seen would
 * be guessing, and the server would refuse it anyway.
 */
function isGhostSite(ctx: ClientPluginCtx, cell: TempleCell): boolean {
  // The server has already said no about this exact cell, for a reason no
  // amount of local terrain reading could have predicted. Its answer outranks
  // the survey below, so it is checked first.
  if (refusedCells.has(refusedKey(cell.x, cell.y))) return false;
  const centre = ctx.terrainHeightAt(cell.x, cell.y);
  if (centre === null) return false;
  for (let dy = -TEMPLE_SURVEY_RADIUS_CELLS; dy <= TEMPLE_SURVEY_RADIUS_CELLS; dy++) {
    for (let dx = -TEMPLE_SURVEY_RADIUS_CELLS; dx <= TEMPLE_SURVEY_RADIUS_CELLS; dx++) {
      const height = ctx.terrainHeightAt(cell.x + dx, cell.y + dy);
      if (height === null || height !== centre) return false;
      // Confirmed water only — rendered Y at or below -1 is unambiguously
      // below sea level, whatever the raw height was (see the header).
      if (height <= -1) return false;
    }
  }
  return true;
}

/** Is this cell part of the standing temple — i.e. would a press raze it? */
function isOnTemple(cell: TempleCell): boolean {
  if (temple === null) return false;
  return (
    Math.abs(cell.x - temple.x) <= TEMPLE_SURVEY_RADIUS_CELLS &&
    Math.abs(cell.y - temple.y) <= TEMPLE_SURVEY_RADIUS_CELLS
  );
}

/**
 * Places both objects for this frame. Run every frame rather than only on a
 * change, because the ground under either can arrive LATE: a temple in a chunk
 * that has not streamed in yet has no height to stand on, and re-asking each
 * frame is how it appears the moment it does (flora and structures retry the
 * same way, on their own cadence).
 */
function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  if (models === null) return;

  crownSeconds += dt;

  // The standing temple.
  const groundY = temple === null ? null : ctx.terrainHeightAt(temple.x, temple.y);
  if (temple === null || groundY === null) {
    models.standing.visible = false;
  } else {
    models.standing.visible = true;
    models.standing.position.set(worldX(temple.x), groundY, worldX(temple.y));
    // Posed only while it is on screen: a hidden crown costs nothing, and
    // because `animate` is pure in the clock it is never out of step when the
    // temple comes back.
    models.animate(crownSeconds);
  }

  // The ghost — only while the tool is held and the pointer is on the ground.
  if (!toolHeld || hoverCell === null) {
    models.ghost.visible = false;
    return;
  }

  if (temple !== null) {
    // A temple already stands: the only press that does anything is the one
    // that razes it, so the ghost appears over the temple and nowhere else.
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

/**
 * A press with the tool held. Returns true to CLAIM it — which, while the
 * tool is held, is every primary-button press on the canvas, legal or not: a
 * press that fell through would sculpt the ground the player was aiming a
 * building at, which is the one outcome that must be impossible.
 */
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

export const clientPlugin: TerraceClientPlugin = {
  name: TEMPLES_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    models = createTempleModels();
    ctx.layer.add(models.standing, models.ghost);

    unsubscribeMessages = ctx.onMessage(TEMPLE_STATE_MESSAGE, (payload) => {
      // A malformed payload parses to null, which means the same thing as an
      // empty state to the only consumer here — see parseTempleStatePayload.
      temple = parseTempleStatePayload(payload);
    });

    unsubscribeRefusals = ctx.onMessage(TEMPLE_REFUSED_MESSAGE, (payload) => {
      const refusal = parseTempleRefusalPayload(payload);
      if (refusal === null) return;
      // "A temple already stands" says nothing about the ground pressed — see
      // `refusedCells`. Every other reason, known or added later, means "not
      // this cell", which is exactly what the set is for.
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
          // Taking the tool up forgets every refusal — the ground may have been
          // sculpted since, and it could only have been sculpted while this
          // tool was down (this file's header).
          refusedCells = new Set();
        }
        if (!selected) {
          // Dropped the tool: the ghost goes with it THIS INSTANT rather than
          // on the next frame, so putting the brush back never leaves a stone
          // pyramid hanging over the cursor for a frame.
          hoverCell = null;
          if (models !== null) models.ghost.visible = false;
        }
      },
    });

    // HOVER, on window rather than on the canvas: a plugin is handed no canvas
    // (ClientPluginCtx has none by design), and pickTerrainCell takes CLIENT
    // coordinates, so a window listener answers the same question. Cheap: the
    // pick only runs while this plugin's tool is actually held.
    onPointerMove = (event: PointerEvent): void => {
      if (!toolHeld) return;
      hoverCell = ctx.pickTerrainCell(event.clientX, event.clientY);
    };
    window.addEventListener('pointermove', onPointerMove);

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

    if (onPointerMove !== null) window.removeEventListener('pointermove', onPointerMove);
    onPointerMove = null;

    models?.dispose();
    models = null;
    temple = null;
    toolHeld = false;
    hoverCell = null;
    refusedCells = new Set();
    crownSeconds = 0;
  },
};
