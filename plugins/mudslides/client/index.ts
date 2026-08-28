// mudslides — client half. Draws the mud that `mudslides:active` says is moving,
// and the debris `mudslides:debris` says has settled.
//
// IT HOLDS NO AUTHORITY: it never starts a slide, never moves one, never decides
// one has finished. A slide that stops appearing in the full-state list has
// finished, and the renderer turns that ABSENCE into the front thinning out on
// its own. The GROUND ITSELF is not this plugin's to draw at all — the terrain
// moved because the server sculpted it, so core's own mesh shows the scarp and
// the lobe, and what is drawn here is only the mud on top.
//
// FOG OF WAR IS THE SERVER'S, and this half inherits it for free: both messages
// go out through `WorldApi.broadcastVisible`, so a client is only ever told about
// slides and debris on ground it has revealed. There is nothing to filter here
// and nothing this half could leak — it cannot draw what it was never sent.

import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  MUDSLIDES_ACTIVE_MESSAGE,
  MUDSLIDES_DEBRIS_MESSAGE,
  MUDSLIDES_PLUGIN_NAME,
  parseActivePayload,
  parseDebrisPayload,
  type SlideState,
} from '../protocol.ts';
import {
  CLUMPS_PER_FRONT_CELL,
  FRONT_TAIL_CELLS,
  MAX_DEBRIS_INSTANCES,
  createDebrisField,
  createFrontField,
  debrisClumps,
  type Clump,
  type ClumpField,
} from './debris.ts';

/**
 * Seconds a slide's last-known velocity may be extrapolated past the push that
 * carried it.
 *
 * ONE SECOND, five times the 200 ms broadcast interval, so a client rides out four
 * consecutive dropped messages before a front visibly stalls. Extrapolation rather
 * than interpolation between two samples, and the difference is what is being
 * smoothed: a front covers sixteen cells a second, so rendering it a push behind
 * would put the mud three cells from the ground the server has already moved.
 */
export const MAX_EXTRAPOLATION_SECONDS = 1;

/**
 * The moving mass's clump scale at the leading edge and at the back of the tail,
 * as multipliers on the clump radius.
 *
 * The front of a debris flow is its snout — the biggest material rides at the
 * head — so the leading clumps are drawn at 1.2 and the trailing ones at 0.8.
 * Both are larger than settled debris (debris.ts's DEBRIS_MIN/MAX_SCALE), which
 * is the visual difference between mud that is moving and mud that has stopped.
 */
const FRONT_TAIL_SCALE = 0.8;
const FRONT_HEAD_SCALE = 1.2;

/**
 * Seconds between unconditional re-lays of the settled debris field.
 *
 * HALF A SECOND. The field is otherwise only re-laid when a debris message
 * arrives, and a clump whose chunk had not streamed in at that moment is skipped
 * (`terrainHeightAt` answers null) and would never be drawn again. The same
 * re-lay picks up debris whose GROUND has since moved — a later slide running
 * over it, or a player sculpting there — which would otherwise leave clumps
 * hanging in the air. At 1024 instances this costs about one frame's worth of
 * matrix work twice a second.
 */
const DEBRIS_RELAY_INTERVAL_SECONDS = 0.5;

let slides: readonly SlideState[] = [];
/** Seconds on this plugin's own clock when `slides` last arrived. */
let receivedAtSeconds = 0;
let elapsedSeconds = 0;

/** Settled debris, oldest first — the eviction order when the field fills. */
let debris: Clump[] = [];
/** Seconds since the settled field was last re-laid. */
let sinceDebrisRelaySeconds = 0;

let front: ClumpField | null = null;
let settled: ClumpField | null = null;
let unsubscribes: Array<() => void> = [];

/** Where a front is RIGHT NOW, in cell space, extrapolated from its velocity. */
function extrapolated(slide: SlideState): { x: number; y: number } {
  const age = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, elapsedSeconds - receivedAtSeconds));
  return { x: slide.x + slide.vx * age, y: slide.y + slide.vy * age };
}

/**
 * The moving mass, as clumps.
 *
 * THE TAIL IS DRAWN BEHIND THE FRONT ALONG ITS OWN VELOCITY, not along the path —
 * the client is never sent the path, deliberately (it would be ninety-six cells
 * per slide per push, for a decoration). Backing up along the velocity is exact
 * for the straight runs a steepest-descent front mostly makes and wrong by a cell
 * or two on a bend, which is invisible under the jitter the clumps already carry.
 *
 * SCALED BY `load`, so a front that has dropped most of what it was carrying is
 * visibly thinner than one that just let go. That is the server's own ledger
 * arriving on the wire and being drawn, rather than a fade this half invented.
 */
function frontClumps(): Clump[] {
  const clumps: Clump[] = [];
  for (const slide of slides) {
    const at = extrapolated(slide);
    // A front with nothing left to carry is water, and water is not this
    // plugin's to draw.
    if (slide.load <= 0) continue;

    // The heading, as a unit step in cell space. A stopped front (zero velocity)
    // keeps its mass on the cell it stopped on rather than smearing it north.
    const speed = Math.hypot(slide.vx, slide.vy);
    const ux = speed > 0 ? slide.vx / speed : 0;
    const uy = speed > 0 ? slide.vy / speed : 0;

    // The tail shortens with the load, so the mass shrinks from the back as the
    // slide runs out instead of thinning uniformly and reading as a fade.
    const tail = Math.max(1, Math.round(FRONT_TAIL_CELLS * slide.load));
    for (let back = 0; back < tail; back++) {
      const cellX = Math.round(at.x - ux * back);
      const cellY = Math.round(at.y - uy * back);
      // Clumps thin out towards the back of the mass, which is what gives the
      // flow a leading edge rather than a uniform sausage.
      const share = 1 - back / tail;
      const count = Math.max(1, Math.round(CLUMPS_PER_FRONT_CELL * share));
      const scale = FRONT_TAIL_SCALE + (FRONT_HEAD_SCALE - FRONT_TAIL_SCALE) * share;
      for (let index = 0; index < count; index++) {
        clumps.push({ cellX, cellY, index, scale });
      }
    }
  }
  return clumps;
}

export const clientPlugin: TerraceClientPlugin = {
  name: MUDSLIDES_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    slides = [];
    debris = [];
    sinceDebrisRelaySeconds = 0;
    receivedAtSeconds = 0;
    elapsedSeconds = 0;

    front = createFrontField();
    ctx.layer.add(front.mesh);
    settled = createDebrisField();
    ctx.layer.add(settled.mesh);

    const groundAt = (x: number, y: number): number | null => ctx.terrainHeightAt(x, y);

    unsubscribes = [
      ctx.onMessage(MUDSLIDES_ACTIVE_MESSAGE, (payload) => {
        const active = parseActivePayload(payload);
        // A malformed payload is dropped WHOLE — the previous state keeps
        // rendering until the next good message, which is 200 ms away. Every
        // plugin in this repo follows the same rule.
        if (active === null) return;
        slides = active.slides;
        receivedAtSeconds = elapsedSeconds;
      }),

      ctx.onMessage(MUDSLIDES_DEBRIS_MESSAGE, (payload) => {
        const parsed = parseDebrisPayload(payload);
        if (parsed === null) return;
        for (const cell of parsed.cells) debris.push(...debrisClumps(cell.x, cell.y, cell.depth));
        // OLDEST EVICTED at the field's ceiling. Debris is decoration over
        // terrain core has already changed permanently, so dropping the oldest of
        // it costs a viewer some clumps on a slide from an hour ago and never
        // costs them the scar itself.
        if (debris.length > MAX_DEBRIS_INSTANCES) {
          debris = debris.slice(debris.length - MAX_DEBRIS_INSTANCES);
        }
        settled?.apply(debris, groundAt);
      }),

      ctx.onFrame((dt) => {
        elapsedSeconds += dt;
        // The front is re-laid every frame because it MOVES every frame (the
        // extrapolation above).
        front?.apply(frontClumps(), groundAt);

        // The debris field is re-laid on its own slow cadence — see
        // DEBRIS_RELAY_INTERVAL_SECONDS for the two things that would otherwise
        // be missed.
        sinceDebrisRelaySeconds += dt;
        if (sinceDebrisRelaySeconds < DEBRIS_RELAY_INTERVAL_SECONDS) return;
        sinceDebrisRelaySeconds = 0;
        if (debris.length > 0) settled?.apply(debris, groundAt);
      }),
    ];
  },

  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];

    slides = [];
    debris = [];
    sinceDebrisRelaySeconds = 0;
    receivedAtSeconds = 0;
    elapsedSeconds = 0;

    front?.dispose();
    front = null;
    settled?.dispose();
    settled = null;
  },
};
