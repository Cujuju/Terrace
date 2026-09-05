// The ray: the bottom glider, and the THIRD species drawn from a Blender-built
// asset — the first whose joints are not SWIMMER_JOINTS.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; fish.ts and shark.ts went first, this file follows them).
// The body used to be built here out of a swept hull, extruded fins and a
// tapered tube (../whaleHull.ts, ./bodyKit.ts). It is now ../assets/ray.glb,
// authored by tools/blender/build_ray.py and loaded through ./assetSpecies.ts.
// Those two helpers are NOT orphaned — ibex, bison, eel and angelfish still
// build on bodyKit, the whale bodies on whaleHull, and quadruped.ts on both.
//
// WHAT DID NOT CHANGE, and must not:
//   * RAY_ENVELOPE. It is the placement contract (../placement.ts's
//     SWIM_PROFILES.ray and BODY_COLUMNS.ray read it): the same five numbers,
//     written from the same constants by the same formula, so the ray sits in
//     the same water it always did.
//   * The animation. Same flap rate and amplitude, same tail wave and lag, and
//     the same NO tail-beat propulsion — a ray is driven by its wings, and the
//     asset supplies joints, never motion.
//   * The colours. 0x3f4b5a body (slate blue-grey, seabed-coloured from
//     above), 0x0f1114 eyes: the owner reads a species by its colour, and
//     build_ray.py paints the same two (plus a darker line for the mouth and
//     gill slits).
//
// TWO ENVELOPES — the decision this pass adds to the rule shark.ts set
// (docs/model-assets.md, "Wildlife species"). The shark showed that an
// envelope extreme must be authored in its rest pose, because
// installSpeciesAsset measures the file AT REST. The ray's placement envelope
// cannot be: its crownY and bellyY are a WING TIP AT THE TOP AND BOTTOM OF ITS
// BEAT, ±0.2244, and a file whose wings are flat at rest (they must be — the
// hinges are at identity and the flap is symmetric about flat) reaches
// neither. So this file declares two envelopes and writes their relationship
// once:
//
//   RAY_REST_ENVELOPE  what the FILE measures with the wings flat. This is
//                      RAY_ASSET.envelope, asserted at install.
//   RAY_ENVELOPE       what PLACEMENT reads: the rest disc plus the flap's
//                      reach, derived here as `rest ± wingReach · sin(flap)`.
//
// Fish and shark have one envelope because their extremes are static. Any
// later species whose extremes move with its animation does what this file
// does.
//
// JOINT NAMES. `wing_port` / `wing_starboard` replace the procedural body's
// `leftWing` / `rightWing`. Port is -Z (docs/model-assets.md: with +X forward
// and +Y up, left = up × forward = Y × X = -Z), and the old `leftWing` sat at
// +Z — it was the starboard wing under a misnomer, which is not carried over.
// The sign derivation in `animate` starts from the axis, not from the old
// names.
import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

/**
 * Wing beat: slow and wide. 0.6 Hz is a glide with an occasional stroke;
 * 0.30 rad (~17°) lifts a 0.59 wing tip ~0.17 either side of level.
 */
const WING_FLAP_HZ = 0.6;
const WING_FLAP_RADIANS = 0.30;
/** The tail lags the wing beat and waves a little in the wake. */
const TAIL_WAVE_RADIANS = 0.12;
const TAIL_LAG_RADIANS = 1.2;

/**
 * The disc's half-height at its thickest station: its underside there is the
 * REST belly, and it is the disc term of the SWEPT envelope's formula (a wing
 * tip at the top of its beat sits this much above the tip's own arc, because
 * the arc is measured from the hinge at the disc's mid-plane). The eyes stand
 * EYE_DOME_ABOVE_DISC above it and are inside the sweep.
 */
const MAX_HALF_HEIGHT = 0.05;
/**
 * How far the eye domes stand above the disc's back; their tops are the REST
 * crown. Seated on the head's shoulders rather than its centreline.
 */
const EYE_DOME_ABOVE_DISC = 0.012;
/**
 * Where each wing hinges on the disc, and how far its tip reaches out from
 * the hinge. Their sum is the wingspan's half, the envelope's halfWidth, and
 * the radius of the arc a tip sweeps when the wing flaps.
 */
const WING_ROOT_Z = 0.09;
const WING_SPAN = 0.50;
const WING_REACH = WING_ROOT_Z + WING_SPAN;

/**
 * The cephalic lobes' tips and the whip's tip, in world units at model scale
 * 1 — the two stations the asset's `nose` and `tail_tip` anchors sit at, and
 * the only place the ray's length is written down. 0.33 is the lobe tip the
 * procedural ray's envelope always summed from; -0.76 its whip tip.
 */
const RAY_NOSE_X = 0.33;
const RAY_TAIL_TIP_X = -0.76;
const RAY_LENGTH = RAY_NOSE_X - RAY_TAIL_TIP_X;

/**
 * What the FILE measures with the wings flat — the envelope the asset is
 * CHECKED against at install (./assetSpecies.ts). placement.ts does not read
 * this one; it reads RAY_ENVELOPE below.
 */
export const RAY_REST_ENVELOPE = {
  /** Cephalic lobes to whip tip. */
  length: RAY_LENGTH,
  halfLength: RAY_LENGTH / 2,
  /** A wing tip, flat: the model's z extent. */
  halfWidth: WING_REACH,
  /** Top of an eye dome above the disc's back. */
  crownY: MAX_HALF_HEIGHT + EYE_DOME_ABOVE_DISC,
  /** The disc's underside at its thickest station. */
  bellyY: -MAX_HALF_HEIGHT,
} as const;

/**
 * What PLACEMENT reads: the SWEPT envelope — the numbers placement.ts fits the
 * ray into its water column with (SWIM_PROFILES.ray, BODY_COLUMNS.ray). Same
 * length and width as at rest; the vertical extremes are a wing tip at the
 * top and bottom of its beat, plus the disc's half-height, which is how the
 * procedural ray always wrote them. Read them; do not restate them there.
 */
export const RAY_ENVELOPE = {
  /** Cephalic lobes to tail tip. */
  length: RAY_REST_ENVELOPE.length,
  halfLength: RAY_REST_ENVELOPE.halfLength,
  /** Half the wingspan, the disc's own width being inside it. */
  halfWidth: RAY_REST_ENVELOPE.halfWidth,
  /** A wing tip at the top of its beat, plus the disc. The eyes are inside it. */
  crownY: WING_REACH * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT,
  /** A wing tip at the bottom of its beat, plus the disc. */
  bellyY: -(WING_REACH * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT),
} as const;

/**
 * The joints this species drives, by the names they carry in ray.glb. NOT
 * SWIMMER_JOINTS: a ray has no caudal to yaw and no pectorals to flutter —
 * its pectorals ARE its wings, and they flap about X from hinges inside the
 * disc. `tail` here is the whip's root at the disc's rear.
 */
const RAY_JOINTS: readonly string[] = ['rig', 'wing_port', 'wing_starboard', 'tail'];

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk.
 */
export const RAY_ASSET: SpeciesAssetSpec = {
  species: 'ray',
  file: 'ray.glb',
  joints: RAY_JOINTS,
  envelope: RAY_REST_ENVELOPE,
};

export const buildRay = assetSpeciesBuilder(RAY_ASSET, (joints, seconds, phase) => {
  const beat = seconds * WING_FLAP_HZ * TWO_PI + phase;
  const flap = Math.sin(beat) * WING_FLAP_RADIANS;
  // Both tips must rise together when `flap` is positive. A rotation about +X
  // by θ moves a point at +Z to y' = -z·sin θ: it sends the +Z tip DOWN and
  // the -Z tip UP. So the starboard wing (+Z) takes -flap and the port wing
  // (-Z) takes +flap, and the two tips rise as one. (The procedural body gave
  // its +Z hinge -flap and its -Z hinge +flap under the old names; the motion
  // is the same, only the names now say which side is which.)
  joints.wing_starboard!.rotation.x = -flap;
  joints.wing_port!.rotation.x = flap;
  joints.tail!.rotation.y = Math.sin(beat - TAIL_LAG_RADIANS) * TAIL_WAVE_RADIANS;
});
