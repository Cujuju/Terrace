import { DRAG_INTENTS_PER_TICK, SCULPT_REPEAT_INTERVAL_MS } from '../config.ts';

export const PREDICTION_TTL_MS = 1000;

export const MAX_PENDING_PREDICTIONS =
  Math.ceil(PREDICTION_TTL_MS / SCULPT_REPEAT_INTERVAL_MS) * DRAG_INTENTS_PER_TICK;

/** Relaxation exchanges height between 4-neighbours, so a written cell's value needs the next one. */
export const PREDICTION_HALO_CELLS = 1;
