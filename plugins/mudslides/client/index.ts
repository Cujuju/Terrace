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

export const MAX_EXTRAPOLATION_SECONDS = 1;

const FRONT_TAIL_SCALE = 0.8;
const FRONT_HEAD_SCALE = 1.2;

const DEBRIS_RELAY_INTERVAL_SECONDS = 0.5;

let slides: readonly SlideState[] = [];
let receivedAtSeconds = 0;
let elapsedSeconds = 0;

let debris: Clump[] = [];
let sinceDebrisRelaySeconds = 0;

let front: ClumpField | null = null;
let settled: ClumpField | null = null;
let unsubscribes: Array<() => void> = [];

function extrapolated(slide: SlideState): { x: number; y: number } {
  const age = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, elapsedSeconds - receivedAtSeconds));
  return { x: slide.x + slide.vx * age, y: slide.y + slide.vy * age };
}

function frontClumps(): Clump[] {
  const clumps: Clump[] = [];
  for (const slide of slides) {
    const at = extrapolated(slide);
    if (slide.load <= 0) continue;

    const speed = Math.hypot(slide.vx, slide.vy);
    const ux = speed > 0 ? slide.vx / speed : 0;
    const uy = speed > 0 ? slide.vy / speed : 0;

    const tail = Math.max(1, Math.round(FRONT_TAIL_CELLS * slide.load));
    for (let back = 0; back < tail; back++) {
      const cellX = Math.round(at.x - ux * back);
      const cellY = Math.round(at.y - uy * back);
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

const DEBRIS_FIELD_DRAW_OBJECTS = 1;

const DEBRIS_FIELDS = 2;

export const clientPlugin: TerraceClientPlugin = {
  name: MUDSLIDES_PLUGIN_NAME,

  drawBudget: DEBRIS_FIELDS * DEBRIS_FIELD_DRAW_OBJECTS,

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
        if (active === null) return;
        slides = active.slides;
        receivedAtSeconds = elapsedSeconds;
      }),

      ctx.onMessage(MUDSLIDES_DEBRIS_MESSAGE, (payload) => {
        const parsed = parseDebrisPayload(payload);
        if (parsed === null) return;
        for (const cell of parsed.cells) debris.push(...debrisClumps(cell.x, cell.y, cell.depth));
        if (debris.length > MAX_DEBRIS_INSTANCES) {
          debris = debris.slice(debris.length - MAX_DEBRIS_INSTANCES);
        }
        settled?.apply(debris, groundAt);
      }),

      ctx.onFrame((dt) => {
        elapsedSeconds += dt;
        front?.apply(frontClumps(), groundAt);

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
