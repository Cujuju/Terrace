// The wolf: a real wolf, imported (owner, 2026-09-04: "add the wolf in game").
//
// IT IS THE SECOND DOWNLOADED SPECIES, and it is the deer's twin in every
// mechanical respect: a CC0 Quaternius model from the same pack, through the
// same tools/blender/import_model.py, on the same ./assetSpecies.ts contract,
// posed by the same ./quadruped.ts poseWalk. ../assets/LICENSES.md records the
// source, the licence and the exact import command; ./grazer.ts argues every
// decision the two share and is the file to read first. Only what DIFFERS is
// argued here.
//
// IT IS A PREDATOR BY SILHOUETTE AND BY NOTHING ELSE. It walks, idles and is
// drawn; it does not hunt, and nothing else in the plugin reacts to it. That
// is a scope decision (2026-09-04), not an omission: predation is a design
// question of the owner's, and a half-built one — a flag, a hook, a `hunts`
// field filled in "for later" — would be a mechanic nobody chose. The
// vocabulary for it already exists unused (../../server/species/profile.ts,
// `Predation`) and stays unused.
//
// SMOOTH-SKINNED, like the deer since 2026-09-04: the import runs WITHOUT
// `--rigidify`, so the artist's weights ship in the file and `bakeRig` keeps
// four influences per vertex. 3 500 of its 4 030 vertices are shared across
// two bones or more (measured on the exported file). A rigidified wolf would
// open the same shoulder and hip seams the deer opened.

import { poseWalk } from './quadruped.ts';
import {
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
  type SpeciesEnvelope,
} from './assetSpecies.ts';
import { TWO_PI } from './speciesModel.ts';

/**
 * The grazer's standing height, restated rather than imported.
 *
 * The wolf's height is DERIVED from the deer's (below), so the deer's number
 * has to appear here — but as a written-down constant, the way ./grazer.ts
 * restates the hand-built figure it replaced. Importing GRAZER_ENVELOPE
 * instead would make a re-import of the DEER silently move the WOLF's declared
 * envelope, and the wolf would then fail its own install assertion naming the
 * wrong file. See ./grazer.ts, GRAZER_HEIGHT_WORLD_UNITS.
 */
const GRAZER_CROWN_HEIGHT_WORLD_UNITS = 0.464;

/**
 * How tall the wolf stands beside the deer, as a ratio.
 *
 * THREE QUARTERS. A grey wolf stands about 0.8 m at the shoulder against a
 * deer's ~1.05 m, and both models carry their crown at the EAR TIPS with the
 * head up, so the shoulder ratio carries to the crown without a second
 * measurement. It is a ratio and not a height because the rule it has to
 * satisfy is a relative one: ./grazer.ts's PILGRIM_HEIGHT rule (owner,
 * 2026-08-24) is about how an animal reads BESIDE a settler, and the wolf has
 * to read below the deer as well.
 */
const WOLF_TO_GRAZER_CROWN_RATIO = 0.75;

/**
 * How tall the imported model stands, in world units.
 *
 * 0.348 — the shortest land animal in the plugin (bison 0.54, ibex 0.511,
 * grazer 0.464), and 0.56 of PILGRIM_HEIGHT (0.62, plugins/pilgrims/client/
 * models.ts:53), so it is plainly under the rule rather than near it. It is
 * also the number the import was FITTED to: `--height 0.348` was the binding
 * axis (the 0.8 x 0.8 footprint clears the model's 0.721 length and so does
 * not bind), which is what lets the envelope below state it exactly.
 */
const WOLF_HEIGHT_WORLD_UNITS = GRAZER_CROWN_HEIGHT_WORLD_UNITS * WOLF_TO_GRAZER_CROWN_RATIO;

/**
 * What this wolf measures, in world units at model scale 1 — declared here and
 * asserted against the file at install (./assetSpecies.ts).
 *
 * MEASURED, not estimated: a per-vertex probe of the fitted file put every one
 * of these at a named vertex (../assets/LICENSES.md records which). A walker
 * is authored at its FEET, so `bellyY` is zero and `crownY` IS the standing
 * height — see ./grazer.ts for why the same five numbers serve swimmers too.
 */
const WOLF_ASSET_ENVELOPE: SpeciesEnvelope = {
  /** Nose tip to the last vertex of the tail. */
  length: 0.7208,
  halfLength: 0.3604,
  /** Half the model's width, at the ribs. Nothing on a wolf reaches wider. */
  halfWidth: 0.0691,
  /** An ear tip. A walker's origin is at its feet, so this is its height. */
  crownY: WOLF_HEIGHT_WORLD_UNITS,
  /** A hind paw, which is the ground the model stands on. */
  bellyY: 0,
};

/**
 * How much of the model's half-length its FEET actually stand within.
 *
 * THE WOLF IS THE FIRST SPECIES THAT CANNOT USE ITS HALF-LENGTH HERE, and the
 * reason is the tail. ./grazer.ts takes the whole half-length as its ground
 * probe and calls the over-reach "at most the tail's overhang", which on a deer
 * is a stub. A wolf's tail is a third of its box: the paws span x -0.1066 to
 * 0.2074 (measured on the fitted file, ../assets/LICENSES.md), so the whole
 * half-length would probe 0.153 world units — 0.6 of a cell — of ground under
 * a tail that bears no weight. `walkerGroundY` (../placement.ts) stands a
 * creature on the HIGHEST cell it probes, so that surplus is an animal
 * hovering beside a riser its tail merely overhangs.
 *
 * 0.6 OF THE HALF-LENGTH, i.e. 0.216, is the measured 0.2074 rounded up to the
 * next tenth — every paw inside it with room to spare, and the surplus down
 * from 0.6 of a cell to 0.04. It is a FRACTION rather than the measurement
 * itself so that it re-derives from the envelope the file is asserted against:
 * a re-import that changed the animal's proportions would move both together.
 */
const WOLF_STANCE_FRACTION_OF_HALF_LENGTH = 0.6;

/**
 * The same shape ../placement.ts asks a walker for, derived — never restated —
 * from the envelope the asset is checked against, so the two cannot drift.
 */
export const WOLF_ENVELOPE = {
  /** Nose to tail tip. */
  length: WOLF_ASSET_ENVELOPE.length,
  /** Half the ground the FEET stand within; see the constant above. */
  bodyHalfLength: WOLF_ASSET_ENVELOPE.halfLength * WOLF_STANCE_FRACTION_OF_HALF_LENGTH,
  height: WOLF_ASSET_ENVELOPE.crownY,
} as const;

/**
 * The joints poseWalk drives, by the names the import gave the asset's bones.
 * `rig` is not in the file — assetSpecies.ts synthesises it; see
 * `SpeciesAssetSpec.rigidified`.
 *
 * THE HIP, NOT THE STIFLE, on the hind legs. The wolf's chain is
 * BackShoulder -> BackLeg -> BackUpperLeg -> BackLowerLeg, and `BackLeg` is
 * renamed to `hindLeft`/`hindRight` at import because `modelAxisPivot` re-homes
 * a driven joint under `rig` and severs what is above it: driving the hip
 * swings the whole leg, driving the stifle would swing only the shank. The
 * fore chain has no such pair — FrontUpperLeg IS the shoulder joint.
 */
const WOLF_JOINTS = ['rig', 'foreLeft', 'foreRight', 'hindLeft', 'hindRight', 'head'];

/**
 * The source rig's IK TARGETS, and the leg each one's geometry belongs under —
 * the deer's problem exactly (./grazer.ts, GRAZER_ADOPTIONS): Quaternius' animal
 * rigs hang the IK targets at the ARMATURE ROOT while weighting the paw and the
 * pastern to them, so without this the wolf walks out of its own feet. Adopting
 * the target brings its children (FF, FFB) and every vertex weighted to any of
 * them.
 *
 * THE POLE TARGETS ARE DELIBERATELY ABSENT. `PoleTarget.L/R` and
 * `PoleTargetBack.L/R` hang off `Body` a good 0.1 units in FRONT of the nose
 * and below the ground, which would be alarming if they carried geometry — they
 * do not. Measured on the exported file (2026-09-04): no vertex weighs more
 * than 1e-4 on any of the four, so they are pure IK scaffolding and moving them
 * would move nothing. They stay where the artist put them.
 *
 * THE NAMES HAVE NO DOTS: three's GLTFLoader sanitises node names on the way in
 * (PropertyBinding.sanitizeNodeName), so `IKFrontLeg.L` is addressable as
 * `IKFrontLegL`. See ./grazer.ts.
 */
const WOLF_ADOPTIONS = [
  { node: 'IKFrontLegL', under: 'foreLeft' },
  { node: 'IKFrontLegR', under: 'foreRight' },
  { node: 'IKBackLegL', under: 'hindLeft' },
  { node: 'IKBackLegR', under: 'hindRight' },
];

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (../index.ts); Node feeds the same install from disk.
 */
export const WOLF_ASSET: SpeciesAssetSpec = {
  species: 'wolf',
  file: 'wolf.glb',
  joints: WOLF_JOINTS,
  envelope: WOLF_ASSET_ENVELOPE,
  rigidified: true,
  adopt: WOLF_ADOPTIONS,
};

/**
 * The distance between the fore and hind paws, in world units — the wolf's own
 * stride scale, measured on the fitted file (x -0.1066 to 0.2074).
 *
 * NOT THE ENVELOPE LENGTH, which is what ./grazer.ts uses. A deer's box is
 * nearly all animal, so "a stride of roughly a body length" and "a stride of
 * roughly the distance between its feet" are the same sentence there. On a
 * wolf they are not: a third of the box is tail, and pacing the gait against
 * it would give a long-legged animal's slow, floating step to a short-legged
 * one.
 */
const WOLF_PAW_SPAN_WORLD_UNITS = 0.314;

/**
 * The server's cruise speed, restated so the stride below can be derived from
 * it rather than tuned against it. ../../server/species/wolf.ts argues the
 * number; a `cellsAcross` figure cannot be imported here, because this file
 * measures in world units and that one in cells.
 */
const WOLF_CRUISE_WORLD_UNITS_PER_SECOND = 1.0;

/**
 * Stride rate: the cruise speed divided by the stride length above — 3.18 a
 * second.
 *
 * That is 1.6x the grazer's 2.0, for an animal whose legs are three quarters as
 * long moving 1.25x as fast: 1.25 / 0.75 = 1.67. The two rates therefore say
 * the same thing about the same gait rather than each having been tuned by eye.
 */
const STRIDE_HZ = WOLF_CRUISE_WORLD_UNITS_PER_SECOND / WOLF_PAW_SPAN_WORLD_UNITS;
/**
 * Unchanged from the grazer. 0.32 rad (~18°) either side of vertical is a
 * walking swing; the wolf's quicker step comes from its SHORTER LEGS, not from
 * a longer reach, so the angle is the one thing that should not move.
 */
const LEG_SWING_RADIANS = 0.32;
/**
 * In WORLD units, and the grazer's 0.012 taken at the wolf's height: 0.012 x
 * 0.75 (WOLF_TO_GRAZER_CROWN_RATIO). A bob is a fraction of an animal, so it
 * scales with the animal.
 */
const WALK_BOB_WORLD_UNITS = 0.012 * WOLF_TO_GRAZER_CROWN_RATIO;
/** The head follows the shoulder, so the nod scales with the bob: 0.05 x 0.75. */
const HEAD_NOD_RADIANS = 0.05 * WOLF_TO_GRAZER_CROWN_RATIO;

export const buildWolf = assetSpeciesBuilder(WOLF_ASSET, (joints, seconds, phase) => {
  const beat = seconds * STRIDE_HZ * TWO_PI + phase;
  poseWalk(joints, beat, LEG_SWING_RADIANS, WALK_BOB_WORLD_UNITS);
  joints.head!.rotation.z = Math.sin(beat * 2) * HEAD_NOD_RADIANS;
});
