// The WHALE-ASSET piece every whale body shares: the joints, the envelope
// rule, and the one fluke animation — written once here for the humpback
// (pass 6) and reused by the blue (pass 7) and sperm (pass 8) bodies.
//
// ONE WIRE SPECIES, THREE BODIES. `whale` on the wire is drawn as one of
// WHALE_SPECIES (../whaleSpecies.ts), picked by entity id in ../models.ts
// `drawableOf`; an individual keeps its body for life. Each body that has
// become a Blender-built asset is its own SpeciesAssetSpec keyed
// `whale-<body>` — the key is only the install-map key in ./assetSpecies.ts,
// the wire species stays `whale`. The bodies not yet converted keep drawing
// from ../whaleSpecies.ts's procedural sets, and take their motion from
// HERE, so each number below exists once.
//
// EVERY WHALE ASSET FILLS THE BOX. WHALE_ENVELOPE (../whaleSpecies.ts) is
// the placement contract — ../placement.ts's BODY_COLUMNS.whale reads its
// crownY/bellyY, SWIM_PROFILES.whale is hand-set against its 5.05 length,
// and ../protocol.ts cites it — and the procedural bodies were FITTED into
// it (uniform scale, the tightest of three ratios), so each filled one axis
// and sat inside on the others. An asset is authored straight into it
// instead: its rest file measures crownY 0.670, bellyY -0.575 and length
// 5.05 exactly, the same three numbers for every body, and only the hull's
// half-width is the body's own. `whaleEnvelope` is that rule, written once.
//
// ONE ENVELOPE (REST). The flukes pitch ±WHALE_FLUKE_SWING_RADIANS about a
// hinge at the peduncle: a tip `reach` behind the hinge sweeps
// ±reach·sin(0.3) in y — for the humpback 0.525 behind a hinge at y 0.12,
// so ±0.155, well inside 0.670/-0.575 — and its x-extreme only SHORTENS
// under pitch (cos ≤ 1), so the straight file is the conservative reading,
// the eel's argument. The body's roll (WHALE_BODY_ROLL_FRACTION of the
// swing, 0.036 rad about the origin) is the animation the procedural whale
// always had, unchanged here; a crown 0.9 behind the origin rises 0.03
// under it, which is exactly the 0.7 - 0.67 the swim profile leaves.
// build_humpback.py prints both (check_fluke_sweep).
import type { SpeciesJoints } from './speciesModel.ts';
import { TWO_PI } from './speciesModel.ts';
import type { SpeciesEnvelope } from './assetSpecies.ts';
import { WHALE_ENVELOPE } from '../whaleSpecies.ts';

/**
 * The joint convention for a WHALE body, in the swimmer's frame (+X forward,
 * +Y up, port -Z):
 *
 *   rig      an Empty at the origin; the whole body hangs under it, and the
 *            body roll acts on it.
 *   flukes   an Empty AT THE PEDUNCLE, identity rotation, both fluke blades
 *            its children — so a pitch about Z sweeps them from the tail
 *            stock. The flippers are RIGID body parts (no joint), exactly as
 *            the procedural bodies had them.
 */
export const WHALE_JOINTS: readonly string[] = ['rig', 'flukes'];

/**
 * The envelope a whale asset must measure: WHALE_ENVELOPE's three numbers,
 * the half-length they imply, and the body's own hull half-width — the one
 * free field (see the header).
 */
export function whaleEnvelope(halfWidth: number): SpeciesEnvelope {
  return {
    length: WHALE_ENVELOPE.length,
    halfLength: WHALE_ENVELOPE.length / 2,
    halfWidth,
    crownY: WHALE_ENVELOPE.crownY,
    bellyY: WHALE_ENVELOPE.bellyY,
  };
}

/** Fluke beat, in cycles per second: slow, because large (models.ts's rule). */
export const WHALE_FLUKE_HZ = 0.45;
/** Half the flukes' pitch travel about the peduncle hinge, in radians. */
export const WHALE_FLUKE_SWING_RADIANS = 0.3;
/**
 * The body's counter-pitch as a fraction of the flukes' swing: the whole rig
 * rocks a little with the stroke, which is what sells the flukes as driving
 * the animal rather than flapping on it.
 */
export const WHALE_BODY_ROLL_FRACTION = 0.12;

/**
 * The one whale animation, for every body: whales flap vertically, slowly.
 * Pitch about Z, the axis across a model that faces +X.
 */
export function animateWhale(joints: SpeciesJoints, seconds: number, phase: number): void {
  const swing = Math.sin(seconds * WHALE_FLUKE_HZ * TWO_PI + phase);
  joints.flukes!.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS;
  joints.rig!.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS * WHALE_BODY_ROLL_FRACTION;
}
