// The angelfish, as anatomy: the striped disc.
//
// A tall swept hull — taller than long, thin across — with long trailing
// dorsal and anal fins sweeping past the peduncle, a modest forked gold
// caudal beating between them, fluttering pectorals, two dark bars painted
// across the flanks, and two eyes. Golden, smooth-shaded like the fish.
//
// THE BARS are upright fins hung THROUGH the body: thin in Z, tall in Y,
// standing proud of each flank by a hair. A second hull or a split sweep would
// be the honest construction and a week of fiddling; a fin is already the
// right orientation (an XY plane, thin across) and seats into the hull exactly
// the way the dorsal does.
//
// MOTION: the tail sweeps side to side about the peduncle like the fish's
// (fish.ts for why that is a yaw about a hinge), at a disc's tempo — slower
// than the fish's 3.2 Hz, quicker than the eel's 1.6 — with the fish's own
// counter-yaw fraction and fluttering pectorals. A shoaler moves like the
// shoal it schools beside.
//
// ENVELOPE. ANGELFISH_ENVELOPE is what placement.ts reads. The dorsal tip is
// the binding dimension above, the anal tip below.
import { Group } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { flatFin, smoothEllipsoid, uprightFin } from './bodyKit.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

const ANGEL_BODY_COLOR = 0xe8b83c; // golden against blue shallows
const ANGEL_BAR_COLOR = 0x23232a; // near-black bars
const ANGEL_FIN_COLOR = 0xdfa838; // fins a shade deeper than the body
const ANGEL_EYE_COLOR = 0x141310;

/** Nose-to-peduncle length of the hull. The caudal fin adds to it behind. */
const HULL_LENGTH = 0.50;
/** Centred: nose at +0.25, peduncle at -0.25. */
const HULL_CENTRE_X = 0.0;
const MAX_HALF_WIDTH = 0.07;
/** Peduncle: the hinge the tail swings from. */
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
/** Behind the peduncle the caudal fork's tips reach this far back. */
const CAUDAL_REACH = 0.15;
/** How tall the fork stands, tip to tip half-height. */
const CAUDAL_HALF_SPAN = 0.15;

const HULL_RINGS = 22;
const HULL_SEGMENTS = 14;
/** See fish.ts FIN_SEAT_BITE. */
const FIN_SEAT_BITE = 0.035;
const FIN_THICKNESS = 0.012;
/**
 * How far a bar stands proud of each flank. The hull is 0.07 across at its
 * widest and less at the bars' stations; 0.085 half-thickness clears it by a
 * hair without reading as a separate plate.
 */
const BAR_HALF_THICKNESS = 0.085;
const EYE_RADIUS = 0.02;
const EYE_SEGMENTS = 6;

/**
 * Tail beat: 2.2 Hz between the fish's dart and the eel's pour, 0.35 rad —
 * the caudal tip travels ~0.05 either way, a crisp flick for a small disc.
 */
export const ANGELFISH_TAIL_HZ = 2.2;
export const ANGELFISH_TAIL_SWING_RADIANS = 0.35;
/** The head's counter-yaw as a fraction of the tail's swing (fish.ts). */
const BODY_COUNTER_YAW_FRACTION = 0.18;
/** Pectoral flutter, same character as the fish's. */
const PECTORAL_DIHEDRAL_RADIANS = 0.55;
const PECTORAL_FLUTTER_RADIANS = 0.14;
const PECTORAL_LAG_RADIANS = 0.9;

/**
 * The hull's lines, module-level so the envelope below is derived from the
 * same numbers the builder assembles rather than restated beside them.
 * A disc: blunt snout, deepest just ahead of the middle, quick taper to a
 * narrow peduncle — and TALL, two and a half times its own width at the
 * crown of the curve.
 */
const angelWidth = profileFromPoints([
  [0.00, 0.55], [0.10, 0.85], [0.25, 1.00], [0.45, 0.95], [0.65, 0.75],
  [0.85, 0.45], [1.00, 0.28],
]);
const angelHeightRatio = profileFromPoints([
  [0.00, 1.60], [0.15, 2.30], [0.35, 2.60], [0.55, 2.40], [0.75, 1.90],
  [0.90, 1.40], [1.00, 1.10],
]);
const angelHalfWidth: BodyProfile = (t) => angelWidth(t) * MAX_HALF_WIDTH;
const angelHalfHeight: BodyProfile = (t) => angelHalfWidth(t) * angelHeightRatio(t);
/** Body t for a station x, on the authored hull. */
const angelBodyT = (x: number): number => (HULL_CENTRE_X + HULL_LENGTH / 2 - x) / HULL_LENGTH;

/**
 * The rear trio, after the concept sculpt (angelfish.py): the dorsal and the
 * anal are LONG trailers, not sails — each rooted along most of the rear
 * midline with its tip sweeping past the peduncle — and the gold caudal is a
 * modest fork on the peduncle between them, clear of both above and below.
 * Three separate pronounced points at the rear, with water between each pair:
 * the trailing edges pass 0.06+ clear of the fork's tips.
 */
const DORSAL_BASE_FRONT_X = 0.15;
const dorsalSeatFrontY = angelHalfHeight(angelBodyT(DORSAL_BASE_FRONT_X)) - FIN_SEAT_BITE;
/** Rear of the dorsal's root, a membrane point just behind the peduncle. */
const DORSAL_BASE_REAR_X = -0.31;
const DORSAL_BASE_REAR_Y = 0.02;
/** The dorsal's tip: past the peduncle, above the tail fan. */
const DORSAL_TIP_X = -0.49;
const DORSAL_TIP_Y = 0.40;
const ANAL_BASE_FRONT_X = 0.13;
const analSeatFrontY = -angelHalfHeight(angelBodyT(ANAL_BASE_FRONT_X)) + FIN_SEAT_BITE;
const ANAL_BASE_REAR_X = -0.29;
const ANAL_BASE_REAR_Y = -0.02;
const ANAL_TIP_X = -0.46;
const ANAL_TIP_Y = -0.38;

/**
 * What this body measures, in world units at model scale 1 — the numbers
 * placement.ts fits the angelfish into its water column with. Read them; do
 * not restate them there.
 */
export const ANGELFISH_ENVELOPE = {
  /** Nose tip to caudal tip. */
  length: 0.25 + -PEDUNCLE_X + CAUDAL_REACH,
  halfLength: (0.25 + -PEDUNCLE_X + CAUDAL_REACH) / 2,
  /** To a bar's outer face. */
  halfWidth: BAR_HALF_THICKNESS,
  /** Top of the dorsal trailer's tip above the origin. */
  crownY: DORSAL_TIP_Y,
  /** Bottom of the anal trailer's tip below the origin. */
  bellyY: ANAL_TIP_Y,
} as const;

export const buildAngelfish: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(ANGEL_BODY_COLOR, { flatShading: false });
  const bar = pool.lambert(ANGEL_BAR_COLOR, { flatShading: false });
  const fin = pool.lambert(ANGEL_FIN_COLOR, { flatShading: false });
  const eye = pool.lambert(ANGEL_EYE_COLOR, { flatShading: false });

  // The hull's lines live at module level (angelHalfWidth/angelHalfHeight/
  // angelBodyT) so the envelope derives from them; the builder just sweeps them.
  const hull = sweptHull({
    length: HULL_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth: angelHalfWidth,
    halfHeight: angelHalfHeight,
    noseCapReach: 0.7,
    tailCapReach: 0.4,
  });
  hull.translate(HULL_CENTRE_X, 0, 0);
  pool.keepGeometry(hull);

  // Long trailing dorsal: rooted from the mid-back to just behind the
  // peduncle, tip sweeping up and back past it — the concept's angel wing,
  // not a sail. Its trailing edge passes well above the tail fan's top tip.
  const dorsal = pool.keepGeometry(uprightFin((shape) => {
    const tipX = DORSAL_TIP_X - DORSAL_BASE_FRONT_X;
    const tipY = DORSAL_TIP_Y - dorsalSeatFrontY;
    const rearX = DORSAL_BASE_REAR_X - DORSAL_BASE_FRONT_X;
    const rearY = DORSAL_BASE_REAR_Y - dorsalSeatFrontY;
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(tipX * 0.45, tipY * 0.75, tipX, tipY);
    shape.quadraticCurveTo((tipX + rearX) / 2, (tipY + rearY) / 2 - 0.02, rearX, rearY);
    shape.lineTo(0, 0);
  }, FIN_THICKNESS));

  // Matching anal trailer below, mirrored.
  const anal = pool.keepGeometry(uprightFin((shape) => {
    const tipX = ANAL_TIP_X - ANAL_BASE_FRONT_X;
    const tipY = ANAL_TIP_Y - analSeatFrontY;
    const rearX = ANAL_BASE_REAR_X - ANAL_BASE_FRONT_X;
    const rearY = ANAL_BASE_REAR_Y - analSeatFrontY;
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(tipX * 0.45, tipY * 0.75, tipX, tipY);
    shape.quadraticCurveTo((tipX + rearX) / 2, (tipY + rearY) / 2 + 0.02, rearX, rearY);
    shape.lineTo(0, 0);
  }, FIN_THICKNESS));

  // Modest gold fork on the peduncle, beating between the dark trailers:
  // root seated into the stem, tips well short of either trailer tip, notch
  // halfway back. Authored with x = 0 AT THE HINGE.
  const caudal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.05, 0);
    shape.quadraticCurveTo(-0.05, 0.10, -CAUDAL_REACH, CAUDAL_HALF_SPAN);
    shape.quadraticCurveTo(-0.08, 0.05, -0.05, 0);
    shape.quadraticCurveTo(-0.08, -0.05, -CAUDAL_REACH, -CAUDAL_HALF_SPAN);
    shape.quadraticCurveTo(-0.05, -0.10, 0.05, 0);
  }, FIN_THICKNESS));

  // The bars: lens-shaped upright fins through the flanks, shorter than the
  // hull is tall at their stations so their crowns and heels stay buried and
  // only the flat sides show. Bevelled as a FIN_THICKNESS plate, not as the
  // 0.17 slab they extrude: the kit proportions bevel to depth, and a slab
  // bevelled as itself balloons 0.07 in every direction, merges the two bars
  // into one black mass and buries the eye (seen 2026-09-05 in the
  // preview-wildlife screenshots).
  const BAR_XS = [0.08, -0.10] as const;
  const bars = BAR_XS.map((barX) => {
    const barHalfHeight = angelHalfHeight(angelBodyT(barX)) * 0.88;
    const geometry = pool.keepGeometry(uprightFin((shape) => {
      shape.moveTo(0.035, 0);
      shape.quadraticCurveTo(0.03, barHalfHeight * 0.7, 0, barHalfHeight);
      shape.quadraticCurveTo(-0.03, barHalfHeight * 0.7, -0.035, 0);
      shape.quadraticCurveTo(-0.03, -barHalfHeight * 0.7, 0, -barHalfHeight);
      shape.quadraticCurveTo(0.03, -barHalfHeight * 0.7, 0.035, 0);
    }, BAR_HALF_THICKNESS * 2, FIN_THICKNESS));
    return { geometry, barX };
  });

  // Between the bars on the gold flank: at 0.08 the hinge sat inside the
  // front bar's slab and the fin grew out of the stripe instead of the flank.
  const PECTORAL_X = 0.0;
  const pectoralGeometries = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    shape.moveTo(0.02, 0);
    shape.quadraticCurveTo(-0.01, s * 0.04, -0.07, s * 0.07);
    shape.quadraticCurveTo(-0.07, s * 0.03, -0.04, 0);
    shape.lineTo(0.02, 0);
  }, sign, FIN_THICKNESS * 0.8)));

  const eyeGeometry = pool.keepGeometry(
    smoothEllipsoid(EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_SEGMENTS, EYE_SEGMENTS),
  );
  const EYE_X = 0.16;
  const eyeZ = angelHalfWidth(angelBodyT(EYE_X)) * 0.92;

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.add(pool.part(hull, body, 0, 0, 0));
  // The trailers wear the bars' near-black, not the fins' gold: the source's
  // dorsal and anal are dark fins on a dark disc, and gold trailers on a gold
  // flank merge into one kite. Dark trailers + gold body keeps the three rear
  // fins three separate reads with the gold fork beating between them.
  rig.add(pool.part(dorsal, bar, DORSAL_BASE_FRONT_X, dorsalSeatFrontY, 0));
  rig.add(pool.part(anal, bar, ANAL_BASE_FRONT_X, analSeatFrontY, 0));
  for (const { geometry, barX } of bars) rig.add(pool.part(geometry, bar, barX, 0, 0));
  rig.add(pool.part(eyeGeometry, eye, EYE_X, 0.03, eyeZ));
  rig.add(pool.part(eyeGeometry, eye, EYE_X, 0.03, -eyeZ));

  // THE HINGE at the peduncle, as in fish.ts.
  const tailHinge = new Group();
  tailHinge.position.set(PEDUNCLE_X, 0, 0);
  tailHinge.add(pool.part(caudal, fin, 0, 0, 0));
  rig.add(tailHinge);

  const pectoralSeatZ = angelHalfWidth(angelBodyT(PECTORAL_X)) * 0.8;
  const pectorals = pectoralGeometries.map((geometry, i) => {
    const sign = i === 0 ? 1 : -1;
    const hinge = new Group();
    hinge.position.set(PECTORAL_X, -0.04, sign * pectoralSeatZ);
    hinge.rotation.set(sign * PECTORAL_DIHEDRAL_RADIANS, 0, 0);
    hinge.add(pool.part(geometry, fin, 0, 0, 0));
    rig.add(hinge);
    return hinge;
  });

  return {
    root,
    joints: { rig, tail: tailHinge, leftPectoral: pectorals[0]!, rightPectoral: pectorals[1]! },
    animate(joints, seconds, phase) {
      const beat = seconds * ANGELFISH_TAIL_HZ * TWO_PI + phase;
      const swing = Math.sin(beat);
      // Side to side about the peduncle. Nothing here touches pitch (Z).
      joints.tail!.rotation.y = swing * ANGELFISH_TAIL_SWING_RADIANS;
      joints.rig!.rotation.y = -swing * ANGELFISH_TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
      const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
      joints.leftPectoral!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
      joints.rightPectoral!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
    },
  };
};
