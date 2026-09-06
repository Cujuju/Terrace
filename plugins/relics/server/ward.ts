// Bedrock Ward — the ground a holder has just shaped refuses another hand.
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT: a ward is only real if EVERY
// path that writes terrain consults it. Relics has two — a player's own sculpt
// intents, which run the interceptor chain, and a relic CAST, which does not
// (handleCast → applyTerraform → WorldApi.sculpt bypasses onIntent entirely,
// verified 2026-09-05). A ward checked only in onIntent would be walked
// straight through by any Quake or Landslide holder, so both callers ask the
// same predicate here rather than each writing their own.
//
// WHAT IS WARDED IS THE BRUSH FOOTPRINT, NOT THE DIFF. onIntentApplied hands
// over the full server-side diff, which includes everything gradient
// relaxation moved — a cascade that reaches a dozen cells past the brush on
// steep ground. Warding that would let one stroke on a mountainside claim a
// region out of all proportion to what the player touched, growing with the
// terrain rather than with the effort. The footprint is what the player aimed
// at, so the footprint is what they hold.
//
// RESIDUAL, NAMED (not fixed): relaxation started by a LEGAL stroke just
// outside a ward can still move warded cells, by at most one terrace band
// (banded spill, the same bound the containment test pins). This is the same
// leak the chunk mask has and for the same reason — the cascade is not
// addressable at its source — so it is documented here rather than papered
// over with a wider ward that would only move the boundary.
//
// KEYED BY SESSION ID, so wards are player state: they are not persisted, and
// they are dropped when their owner leaves (index.ts, onPlayerLeave), for the
// reason identity decision 2 gives — a session id belongs to a connection, not
// to a person, and restoring one to whoever the transport hands it to next is
// worse than losing it.

import { forEachFootprintOffset } from '@terrace/shared';

/**
 * Seconds a stroke's ground stays warded (owner, 2026-09-05).
 *
 * Refreshed by every stroke, so a player working an area holds it continuously
 * and only lets go once they have actually stopped — the window is the length
 * of a pause, not the length of a claim.
 */
export const BEDROCK_WARD_SECONDS = 15;

/**
 * Seconds between "that ground is warded" notices to one refused player.
 *
 * A dragged stroke emits an intent per pointer move, so an unthrottled notice
 * is one message per frame at the exact moment a player is already being told
 * no. One second is slower than any drag and faster than a player can wonder
 * why nothing is happening.
 */
export const WARD_NOTICE_INTERVAL_S = 1;

interface Ward {
  readonly owner: string;
  remainingS: number;
}

/**
 * Live wards by cell index (y·size + x).
 *
 * Bounded by what a player can physically draw in BEDROCK_WARD_SECONDS: a
 * MAX_BRUSH_RADIUS footprint is roughly 800 cells, so even continuous
 * fastest-possible sculpting settles at a five-figure map — kilobytes, and it
 * drains to nothing the moment the sculpting stops.
 */
const wards = new Map<number, Ward>();

/** Seconds until each session may be told again that it hit a ward. */
const noticeSilenceS = new Map<string, number>();

/**
 * Marks a stroke's footprint as its sculptor's.
 *
 * LAST WRITER WINS, deliberately: a cell can only be re-stamped by someone
 * else once its ward has already lapsed (a live one refuses their stroke), so
 * overwriting is exactly "whoever last worked this ground holds it", with no
 * special case for contested cells because there are none.
 */
export function stampWard(
  size: number,
  owner: string,
  x: number,
  y: number,
  radius: number,
): void {
  forEachFootprintOffset(radius, (dx, dy) => {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return;
    wards.set(cy * size + cx, { owner, remainingS: BEDROCK_WARD_SECONDS });
  });
}

/**
 * The first foreign ward holder a brush at (x, y) would touch, or null when
 * the whole footprint is free or is the caller's own.
 *
 * Returns the HOLDER rather than a boolean so a caller can name them; the
 * footprint is walked in forEachFootprintOffset's fixed order, so which holder
 * comes back is deterministic when a stroke straddles two people's ground.
 */
export function wardHolderAgainst(
  size: number,
  actor: string,
  x: number,
  y: number,
  radius: number,
): string | null {
  let holder: string | null = null;
  forEachFootprintOffset(radius, (dx, dy) => {
    if (holder !== null) return;
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return;
    const ward = wards.get(cy * size + cx);
    if (ward !== undefined && ward.owner !== actor) holder = ward.owner;
  });
  return holder;
}

/** Ages every ward by one tick and drops the ones that have run out. */
export function sweepWards(dt: number): void {
  for (const [cell, ward] of wards) {
    ward.remainingS -= dt;
    if (ward.remainingS <= 0) wards.delete(cell);
  }
  for (const [session, remaining] of noticeSilenceS) {
    const next = remaining - dt;
    if (next <= 0) noticeSilenceS.delete(session);
    else noticeSilenceS.set(session, next);
  }
}

/**
 * Whether this session should be told, now, that a ward refused it — and, if
 * so, starts its silence. One call answers and arms, so a caller cannot ask
 * and then forget to arm.
 */
export function claimWardNotice(sessionId: string): boolean {
  if (noticeSilenceS.has(sessionId)) return false;
  noticeSilenceS.set(sessionId, WARD_NOTICE_INTERVAL_S);
  return true;
}

/** Drops every ward a session holds. Called when its owner leaves. */
export function dropWardsOf(owner: string): void {
  for (const [cell, ward] of wards) {
    if (ward.owner === owner) wards.delete(cell);
  }
  noticeSilenceS.delete(owner);
}

/** Test seam: every warded cell count, and a way back to zero. */
export function wardedCellCount(): number {
  return wards.size;
}

export function resetWards(): void {
  wards.clear();
  noticeSilenceS.clear();
}
