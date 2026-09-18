import type { Camera } from 'three';
import type { TerrainRayPick, Vec3 } from '../../terrain/picking.ts';
import { CUE_BLINK_ON_MS, DENIED_BLINK_SETTLE_MS } from '../../render/denialCue.ts';
import type { SculptIntent } from '@terrace/shared';

/**
 * The four sculpt-brush cue states the input path reports for lane E to render.
 * Lane C owns the transitions; lane E owns the pixels.
 *
 * - `refused` — the server (or a local plugin) refused the stroke. Red brush.
 *   Pulsed by releaseStroke(); read via refusedHold().
 * - `offline` — send() returned 'offline': the room is gone, so the intent never
 *   left. Grey/hollow brush, never red. Latched for the stroke; read via
 *   offlineHold().
 * - `ghost` — the stroke grabbed a band but the prediction was a no-op (held
 *   drag into unknown or already-settled ground). Tracked by the prediction
 *   store (ghostSeqs), not here: the intent WAS sent, so the brush must not
 *   read as unsent-held.
 * - `flat` — a posture refusal: the aim geometry cannot take this tool
 *   (underside raise, carve with no span, seed that moves nothing, the drag
 *   plane leaving the held band). Flat-mark; read via flatBlinks() and
 *   dragDescentFrozen().
 */
export type SculptCue = 'refused' | 'offline' | 'ghost' | 'flat';

/**
 * What the host did with an intent. 'sent' reached the room (predict it);
 * 'refused' died to a local plugin veto whose red pulse the host already latched
 * via releaseStroke(), so the input must not blink grey for it; 'offline' never
 * left (grey/hollow cue here, never red).
 */
export type SendOutcome = 'sent' | 'refused' | 'offline';

/**
 * Consecutive silent repeat ticks before the held button blinks the flat cue
 * once. Press-time failures blink immediately instead of counting here.
 */
export const SILENT_REPEAT_BLINK_AFTER = 3;

/** Red for this long when no button holds it. Derived so the pulse outlasts the cue's own blinks. */
export const REFUSED_PULSE_MS = DENIED_BLINK_SETTLE_MS + CUE_BLINK_ON_MS;

export interface SculptInputOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  pickCell: (origin: Vec3, direction: Vec3) => TerrainRayPick | null;
  pickInColumn: (
    x: number,
    y: number,
    origin: Vec3,
    direction: Vec3,
  ) => TerrainRayPick | null;
  worldSize: () => number;
  riserBand: (pick: TerrainRayPick | null) => number | null;
  bandAtCell: (x: number, y: number, spanBand: number | null) => number | null;
  runFloorBandAt: (x: number, y: number, band: number) => number | null;
  graspSpanBand: (
    pick: TerrainRayPick | null,
    atX: number,
    atY: number,
  ) => number | null;
  carveBand: (pick: TerrainRayPick | null) => number | null;
  carveReach: (
    origin: Vec3,
    direction: Vec3,
    band: number,
  ) => { x: number; y: number } | null;
  send: (intent: SculptIntent) => SendOutcome;
}

export interface SculptInput {
  hoverTarget(): TerrainRayPick | null;
  heldBand(): number | null;
  carveHeldBand(): number | null;
  releaseStroke(): void;
  refusedHold(): boolean;
  /** Grey/hollow brush: send() returned 'offline' during this stroke. Never red. */
  offlineHold(): boolean;
  /** The drag plane left the held band: freeze the stroke, grey the highlight. */
  dragDescentFrozen(): boolean;
  /** Press-time offline failures plus one blink per dropped sweep, transition-only. */
  offlineBlinks(): number;
  /** Press-time posture failures plus one blink per silent repeat streak. */
  flatBlinks(): number;
  /** Hits on the dead directionless-raise guard: logged, never cued. */
  deadGuardHits(): number;
  dispose(): void;
}
