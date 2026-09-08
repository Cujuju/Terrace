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
// FINDING THE TEMPLE YOU ALREADY BUILT. Everything below is written around a
// player who can SEE their temple, and a world sixteen units of relief deep
// does not guarantee that: the one press that does anything while a temple
// stands is a press ON it, so a temple behind a ridge left the tool inert with
// nothing on screen to explain it. Taking the tool up therefore lights a
// bright spire over the temple (./beacon.ts), tall enough that no terrain in
// this world can hide its tip, and Ctrl razes the temple from wherever the
// camera happens to be — the same intent the press sends, minus the need to
// find the building first. Both live and die with the tool: outside placement
// mode the temple is a building like any other.
//
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

/** The tool's id within this plugin; the host namespaces it `temples:place`. */
const TEMPLE_TOOL_ID = 'place';

const TEMPLE_TOOL_LABEL = 'Temple';

const TEMPLE_TOOL_TITLE =
  'Temple: place the settlers’ temple (Ctrl takes a standing one back down)';

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
 * The key that takes a standing temple down from anywhere — the same intent a
 * press on the building sends, for a player who cannot see the building.
 *
 * `KeyboardEvent.key`, so either Ctrl answers, on every layout.
 */
const RAZE_KEY = 'Control';

/**
 * True while a held Ctrl is still a candidate for the raze.
 *
 * IT FIRES ON RELEASE, NOT ON PRESS, and this flag is why. Ctrl is also a
 * camera modifier here — Ctrl-drag orbits or pans depending on the player's
 * bindings, and Ctrl-wheel is a pinch zoom — so a raze on keydown would knock
 * the temple down every time the player so much as looked around with the tool
 * in hand. Anything that turns the hold into a gesture (a pointer press, a
 * wheel, another key) disarms it, so what is left to fire on release is a Ctrl
 * pressed and let go ON ITS OWN. That is the whole rule, and it is what makes
 * a destructive shortcut safe to put on a modifier key.
 */
let ctrlTapArmed = false;

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
/** Every window listener this plugin holds, registered and dropped as one. */
let windowListeners: Array<[string, EventListener]> = [];

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
    // The spire is placement mode's own affordance, so it is asked the same
    // question every frame the temple is: is the tool up?
    models.setBeaconVisible(toolHeld);
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

/**
 * Ctrl went down. The tap is armed only if it is bare: no other modifier, not
 * an auto-repeat, and not in a text field, where Ctrl is the first half of
 * every editing shortcut there is.
 */
function armCtrlTap(event: KeyboardEvent): void {
  if (event.key !== RAZE_KEY || event.repeat) return;
  ctrlTapArmed =
    !event.altKey && !event.shiftKey && !event.metaKey && !isTextEntry(event.target);
}

/**
 * Ctrl came up. A tap that survived the hold razes the standing temple — the
 * same `temples:remove` intent a press on it sends, so the server decides and
 * this half predicts nothing, exactly as everywhere else in this file.
 */
function fireCtrlTap(ctx: ClientPluginCtx, event: KeyboardEvent): void {
  if (event.key !== RAZE_KEY) return;
  const armed = ctrlTapArmed;
  ctrlTapArmed = false;
  if (!armed || !toolHeld || temple === null) return;
  ctx.send(TEMPLE_REMOVE_MESSAGE, {});
}

/**
 * The standing temple: TEN surfaces (the stone shell plus the celestial rig's
 * core, halo, bloom, rings, motes and shaft — ./temple.ts and ./celestial.ts),
 * measured 2026-08-29.
 */
const TEMPLE_STANDING_DRAW_OBJECTS = 10;

/** The placement ghost: ONE. */
const TEMPLE_GHOST_DRAW_OBJECTS = 1;

/**
 * The placement beacon: TWO — the needle and its additive sheath
 * (./beacon.ts). Drawn only while the tool is held, and budgeted as if it
 * always were: a budget that only holds while a tool is down is not a budget.
 */
const TEMPLE_BEACON_DRAW_OBJECTS = 2;

/**
 * Temples in a world: ONE. The server refuses a placement with
 * TEMPLE_REFUSED_STANDING while one stands (../protocol.ts), so this is the
 * population cap and not an estimate.
 */
const TEMPLES_PER_WORLD = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: TEMPLES_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget:
    TEMPLES_PER_WORLD *
    (TEMPLE_STANDING_DRAW_OBJECTS + TEMPLE_GHOST_DRAW_OBJECTS + TEMPLE_BEACON_DRAW_OBJECTS),

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
          // Dropped the tool: the ghost and the spire go with it THIS INSTANT
          // rather than on the next frame, so putting the brush back never
          // leaves a stone pyramid hanging over the cursor for a frame.
          hoverCell = null;
          if (models !== null) {
            models.ghost.visible = false;
            models.setBeaconVisible(false);
          }
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

    // THE CTRL TAP, and the four things that disarm it (see `ctrlTapArmed`).
    // A pointer press, a wheel and any other key all mean the hold was part of
    // a gesture; losing the window means the release will never be seen.
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
