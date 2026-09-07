// Which way up a legged mover is drawn, for the gait that is drawing it.
//
// THE DEFECT (owner, 2026-09-06, seen in motion in the preview harness:
// "neither fall pose reads as falling: nothing rotates a falling body"). The
// wall gaits shipped as LIMB poses only — arms overhead, legs spread — so a
// peep dropped at eight times climbing speed standing upright on its feet and
// an ibex dropped level with its hooves under it, which reads as a trot. A
// faller is attached to nothing, so its orientation is the whole read.
//
// ONE FUNCTION, THREE FAMILIES. Pilgrims, monsters and wildlife all pose
// through `animate(seconds, phase, gait)`, so which way up a gait holds a body
// is answered here rather than three times over. Each family applies the answer
// to its rig's ROOT bone: the one node in every family that carries the whole
// creature — legs included — and that no per-family animation writes. Not
// `rigHerd.place`, which takes a yaw and a uniform scale on purpose (see the
// note at its matrix fast path) and would have to give that up to take a pitch.
//
// A GAIT THIS FILE DOES NOT NAME IS UPRIGHT. New members of MoverGait keep
// compiling and keep standing up straight, which is what a `stand` or a `sit`
// wants anyway.
import type { Object3D } from 'three';
import { FALL_SECONDS_PER_BAND } from '@terrace/shared';
import type { MoverGait } from './moverGait.ts';

const TWO_PI = Math.PI * 2;

/** A gait this file does not name stands the body up straight. */
const UPRIGHT_RADIANS = 0;

/**
 * How far over a body that has let go of the wall has gone, in radians.
 *
 * A HALF TURN — head down the drop, feet up, the limb pose's raised arms
 * streaming past it. A quarter turn was tried first and rejected at the preview
 * harness: flat-out lays the body level, and level reads as LYING DOWN, which is
 * the same defect wearing a different hat. Upside down is the one attitude
 * nothing else here ever draws — no walk, no climb, no standing still — so it
 * cannot be misread. It snaps there the instant the mover lets go rather than
 * easing: there is no "seconds since it let go" on the wire to ease from, and
 * the limb pose snaps at the same instant anyway.
 */
const FALL_PITCH_RADIANS = Math.PI;

/**
 * How far it keeps turning either side of that, in radians.
 *
 * BOUNDED, AND BOUNDED ON PURPOSE: a body that turned freely would pass through
 * UPRIGHT once every revolution, and an upright faller is the whole defect —
 * one frame of it a turn is one frame too many. An eighth of a turn either side
 * keeps every frame within striking distance of head-down while still visibly
 * turning.
 */
const FALL_TUMBLE_RADIANS = Math.PI / 8;

/**
 * Full swings of that turn per BAND of wall dropped.
 *
 * PACED BY THE FALL ITSELF rather than picked by eye: the rate is this over
 * @terrace/shared's FALL_SECONDS_PER_BAND, so a longer drop turns further and a
 * re-timed fall re-times the turn with it. Half a swing a band is one whole
 * swing every two bands, and the walls in this world are a handful of bands.
 */
const FALL_TUMBLE_SWINGS_PER_BAND = 0.5;
const FALL_TUMBLE_HZ = FALL_TUMBLE_SWINGS_PER_BAND / FALL_SECONDS_PER_BAND;

/**
 * How far a climber leans into the rock it is facing, in radians.
 *
 * IT FACES THE WALL: the server keeps the climbing mover's heading pointed at
 * the face throughout (@terrace/shared's climb.ts, `approachAndClimb` — "a body
 * climbing with its back to the cliff reads as a bug"), so a NEGATIVE pitch is
 * toward the rock. Eight degrees is a body hugging the wall; more and the head
 * pushes through it.
 */
const CLIMB_LEAN_RADIANS = -0.14;

/**
 * How far a gait tips a body fore-and-aft, in radians, in the mover's own frame.
 *
 * ONE AXIS, ON PURPOSE. Every model in this repo faces +X with +Y up and every
 * limb in every gait swings about Z, so Z is the pitch — positive tips the body
 * BACKWARD, away from what it faces. A second axis was tried and cut: the tilt
 * is taken about the rig root, whose origin is at the mover's feet, so a roll
 * added on top of a pitch this large swings the whole body sideways through an
 * arc a body-length across rather than reading as a wobble.
 */
function pitchOf(gait: MoverGait, seconds: number, phase: number): number {
  if (gait === 'fall') {
    return (
      FALL_PITCH_RADIANS + Math.sin(seconds * TWO_PI * FALL_TUMBLE_HZ + phase) * FALL_TUMBLE_RADIANS
    );
  }
  if (gait === 'climb') return CLIMB_LEAN_RADIANS;
  return UPRIGHT_RADIANS;
}

/**
 * Turns one mover's rig ROOT bone to the way up its gait holds it.
 *
 * THE WHOLE CONTRACT, not just the angle: which Euler component is the pitch is
 * decided here once, because three families applying it themselves is three
 * places to get it wrong. Pass the root bone — the node that carries the legs
 * too, and that no family's own animation writes.
 *
 * `seconds` is the shared animation clock and `phase` the pose slot's phase in
 * radians, exactly as every `animate` takes them — so two fallers in different
 * slots are at different points of the same turn rather than turning as one.
 */
export function applyMoverBodyTilt(
  root: Object3D,
  gait: MoverGait,
  seconds: number,
  phase: number,
): void {
  root.rotation.z = pitchOf(gait, seconds, phase);
}
