// Where the lightning actually lands.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SERVER PICKS THE CELL AT ALL (2026-08-24).
//
// Until now every bolt in this game was a CLIENT decision: each storm rig ran
// its own LightningSchedule (../client/sky.ts) and flashed on its own random
// clock, so no two players ever saw the same bolt and the server never knew one
// had happened. That was exactly right while lightning was decoration.
//
// It stops being right the moment lightning DOES something. A fire started by a
// bolt the client chose would be a fire the server never authorised; a fire
// started by a bolt the server chose, drawn by a client flashing elsewhere,
// would be a forest going up under a clear patch of sky. There is no version of
// "lightning sets trees alight" that survives two independent RNGs.
//
// So the strike moves to the server, and the client is told. The rig keeps
// everything it was good at — the jag, the flash envelope, the photosensitivity
// governor — and gives up only the choice of when and where.
//
// WHAT THE STRIKE IS NOT: it is not a wire-synced simulation object. A strike is
// an instant, so it travels as a one-shot event and is never re-sent. A client
// that misses one missed a flash, which is the correct amount to care.
// ─────────────────────────────────────────────────────────────────────────────

import { rollEvent, weatherRandom } from './rng.ts';
import { livingSystems, type WeatherSystem, type WeatherWorld } from './systems.ts';

/**
 * Strikes per second from ONE storm at full intensity.
 *
 * Sized against the storm's own life, not chosen for feel alone: a system lives
 * SYSTEM_MEAN_LIFETIME_SECONDS (240 s), so at 0.06/s a typical storm throws
 * something like a dozen bolts over its whole passage. Frequent enough that a
 * storm overhead reads as dangerous, rare enough that each one is an event —
 * and far below the client governor's MIN_FLASH_INTERVAL_SECONDS floor of one
 * flash per 3 s, so the photosensitivity limit stays a backstop rather than
 * becoming the thing that actually sets the rhythm.
 */
export const STRIKE_RATE_PER_SECOND = 0.06;

/**
 * Candidate cells sampled inside the storm before one is struck.
 *
 * Lightning hits the tallest thing under it. Sampling several cells and taking
 * the highest is the cheapest honest way to say that, and it is what makes the
 * lone tree on the ridge the one that gets hit — a rule players learn by
 * watching rather than by being told.
 *
 * SIX, because the return diminishes fast: with six samples the struck cell is
 * in the top ~15% of the storm's footprint by height, which reads as "it went
 * for the high ground" without being so deterministic that the same ridge is
 * struck every single time.
 */
export const STRIKE_TARGET_SAMPLES = 6;

/** A strike, in the cell space everything else in this plugin sims in. */
export interface Strike {
  /** Which system threw it — the client needs it to find the rig to flash. */
  readonly systemId: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A uniformly random cell inside the system's disc, clamped to the world.
 *
 * Uniform over the DISC, not over the radius: drawing r uniformly would pile
 * two thirds of the samples into the middle third of the storm, so the strike
 * would drift toward the eye of every system. `sqrt` of a uniform is the
 * standard correction and it is one call.
 */
function sampleCell(system: WeatherSystem, worldSize: number): { x: number; y: number } | null {
  const angle = weatherRandom() * Math.PI * 2;
  const radius = Math.sqrt(weatherRandom()) * system.radius;
  const x = Math.round(system.x + Math.cos(angle) * radius);
  const y = Math.round(system.y + Math.sin(angle) * radius);
  // A system may sit partly off the edge of the world (systems.ts's spawn
  // margins), so a sample can land outside it. Dropped rather than clamped:
  // clamping would pile every off-world sample onto the world's rim and strike
  // the coastline far more often than the interior.
  if (x < 0 || y < 0 || x >= worldSize || y >= worldSize) return null;
  return { x, y };
}

/**
 * Picks the cell this storm strikes: the highest of several samples (see
 * STRIKE_TARGET_SAMPLES). Null when the storm is far enough off the edge of the
 * world that nothing under it can be sampled.
 */
export function chooseStrikeCell(
  system: WeatherSystem,
  world: WeatherWorld,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestHeight = Number.NEGATIVE_INFINITY;

  for (let sample = 0; sample < STRIKE_TARGET_SAMPLES; sample++) {
    const cell = sampleCell(system, world.worldSize);
    if (cell === null) continue;
    const height = world.heightAt(cell.x, cell.y);
    if (height <= bestHeight) continue;
    bestHeight = height;
    best = cell;
  }

  return best;
}

/**
 * Rolls this step's strikes across every living storm. Returns them in system
 * order; the empty array is the overwhelmingly common answer.
 *
 * Only `storm` throws bolts — the kind exists for exactly that reason
 * (../protocol.ts: "`storm` is `rain` plus lightning rather than a
 * `hasLightning` flag on rain"). Intensity scales the rate, so a system that is
 * still gathering or already dissipating throws proportionally fewer, and one
 * at zero throws none.
 */
export function rollStrikes(world: WeatherWorld, dt: number): Strike[] {
  const strikes: Strike[] = [];

  for (const system of livingSystems()) {
    if (system.kind !== 'storm') continue;
    const intensity = system.peakIntensity * system.envelope;
    if (intensity <= 0) continue;
    if (!rollEvent(STRIKE_RATE_PER_SECOND * intensity, dt)) continue;

    const cell = chooseStrikeCell(system, world);
    if (cell === null) continue;
    strikes.push({ systemId: system.id, x: cell.x, y: cell.y });
  }

  return strikes;
}
