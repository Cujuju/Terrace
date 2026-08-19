// The kraken silhouette, as numbers. The sibling of ./anatomy.ts, which owns
// Cthulhu's, and it keeps that file's contract exactly:
//
//   * every dimension of the model lives here rather than inside the builder,
//     because the placement maths needs some of them (how deep the thing sits is
//     DERIVED from where its eyes are, not guessed) and a node test can read
//     them without importing three (design §8 — no headless GL rig);
//   * UNITS are cells. CELL_WORLD_SIZE is 1 and HEIGHT_WORLD_SCALE maps one
//     terrace band to one world unit, so a number here is simultaneously cells
//     across the board and world units of height;
//   * FRAME: the model faces +X. The origin is the PIVOT, at the crown where the
//     arms meet the head — the point the server's cell position is placed at.
//
// REACHES ARE MEASURED FROM THE AXIS, always: an arm's "reach" is how far that
// point is from the model's vertical centre line, not how far it is from where
// the arm started. That is the only convention under which the footprint below
// can be checked by adding two numbers, which is what its test does.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAKES IT NOT A SECOND CTHULHU
//
// Cthulhu is BILATERAL and TALL: a hunched body, shoulders, folded wings, a face
// carried forward, and 61% of it hidden under the water at rest. He is a figure.
//
// The kraken is RADIAL and LOW-SLUNG: a crown of eight arms lying ON the water
// in every direction, a squat head at the waterline with two lamp eyes, and the
// long humped back of its mantle running down into the sea behind it, tail
// fins slicing the surface at the far end. There is no front to it except the
// way it happens to be swimming, nothing is folded, and the parts that break
// the surface are limbs and a back rather than a face. At a hundred cells the
// two read as a standing man and a spider on the water, which is the distance
// the silhouettes have to hold at.
//
// SAME BOX, DIFFERENT SHAPE. It is built to the SAME 7-cell footprint (see
// KRAKEN_WIDTH_CELLS), which is the number the server's steering probe and the
// atmosphere's lightning clearance were both sized from. A wider animal would
// have meant re-deriving effects tuned around the first one, for nothing the
// silhouette could not get from its shape instead.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HEAD: the squat mass the arms and the mantle both grow out of, centred just
 * above the origin. As wide as it is long and shorter than either — a hood, not
 * a skull.
 */
export const KRAKEN_HEAD_CENTER_HEIGHT = 0.9;
export const KRAKEN_HEAD_LENGTH = 2.8;
export const KRAKEN_HEAD_HEIGHT = 2.2;
export const KRAKEN_HEAD_WIDTH = 2.8;

/** Top of the head above the origin. The mantle's base is buried below it. */
export const KRAKEN_HEAD_TOP = KRAKEN_HEAD_CENTER_HEIGHT + KRAKEN_HEAD_HEIGHT / 2;

/**
 * MANTLE: the animal's great back — an ARCH, not a tower.
 *
 * SUPERSEDED 2026-08-19 (owner: "the model is physically wrong"): the first
 * mantle stood 6.4 cells NEAR-VERTICAL out of the head, which put ~90% of the
 * body above the waterline — a soft-bodied animal cantilevering its whole mass
 * into the sky off a floating head, wearing its fins as a hat brim. It read as
 * a witch's hat standing on the sea. A real cephalopod's mantle is COLLINEAR
 * with its body axis: at the surface it lies along the water, not across it.
 *
 * So the mantle is now a swept tube along an arched axis in the fore-aft
 * plane: it leaves the back of the head, crests at the APEX — the humped back
 * of a surfaced animal, the new tallest point of the whole model — and runs
 * back DOWN to a tip that rides just under the waterline behind it, where the
 * fins are. Most of its volume sits at or below the water, which is what a
 * floating body looks like; what shows is a hump, exactly like the surfaced
 * whale-back read the sea already trades in.
 *
 * All three axis points are stated here as (backset, height) pairs — backset
 * measured from the axis like every reach — so the footprint tests can sample
 * the REAL swept curve and hold its rearmost skin inside the 3.5-cell
 * half-footprint the server steers by.
 */
export const KRAKEN_MANTLE_ROOT_BACKSET = 0.7;
export const KRAKEN_MANTLE_ROOT_HEIGHT = 1;
/** A fourth axis point between root and apex (round 3): without it the
 *  three-point curve left a pinched notch between the back of the head and
 *  the hump's front face — the hump read as a backpack, not a back. */
export const KRAKEN_MANTLE_RISE_BACKSET = 1.2;
export const KRAKEN_MANTLE_RISE_HEIGHT = 1.9;
export const KRAKEN_MANTLE_APEX_BACKSET = 2;
/** The AXIS height of the hump's crest; the skin above it adds the local tube
 *  radius, which is why KRAKEN_TOTAL_HEIGHT below carries the max radius too. */
export const KRAKEN_MANTLE_APEX_HEIGHT = 2.35;
export const KRAKEN_MANTLE_TIP_BACKSET = 2.75;
/** Just under the waterline (which sits at KRAKEN_LURK_DEPTH + bite ≈ 0.85). */
export const KRAKEN_MANTLE_TIP_HEIGHT = 0.55;
export const KRAKEN_MANTLE_BASE_RADIUS = 0.8;
export const KRAKEN_MANTLE_RADIUS = 1.35;
/** Where along the mantle the widest ring sits, 0 at the base and 1 at the tip.
 *  PAST the crest on purpose (round 2 eyes-on): the fattest ring on the
 *  DOWNSLOPE puts the belly of the mass in the water — buoyancy where the
 *  buoyancy should be — where a fat ring at the crest read as a looming cowl. */
export const KRAKEN_MANTLE_SHOULDER = 0.55;
/** Taper curve past the shoulder: radius = lerp(max, tip, t^exponent). */
export const KRAKEN_MANTLE_TAPER_EXPONENT = 0.85;
/** The tip. Not zero: a tube that closes to a true point pinches its shading. */
export const KRAKEN_MANTLE_TIP_RADIUS = 0.06;

/**
 * The mantle's radius profile: swelling from the collar to the shoulder, then a
 * long taper to the tip. Two segments, each stated as a lerp, so the widest
 * ring is exactly KRAKEN_MANTLE_RADIUS and exactly where SHOULDER says.
 *
 * A PURE FUNCTION, HERE, so the builder (kraken.ts) and the footprint test
 * sweep the SAME skin: the test samples axis point + this radius along the
 * whole curve and holds it inside the half-footprint — a bound on the real
 * surface, not on control points.
 */
export function krakenMantleRadiusAt(along: number): number {
  if (along <= KRAKEN_MANTLE_SHOULDER) {
    const swell = along / KRAKEN_MANTLE_SHOULDER;
    return KRAKEN_MANTLE_BASE_RADIUS + (KRAKEN_MANTLE_RADIUS - KRAKEN_MANTLE_BASE_RADIUS) * swell;
  }
  const taper = (along - KRAKEN_MANTLE_SHOULDER) / (1 - KRAKEN_MANTLE_SHOULDER);
  return (
    KRAKEN_MANTLE_RADIUS +
    (KRAKEN_MANTLE_TIP_RADIUS - KRAKEN_MANTLE_RADIUS) *
      Math.pow(taper, KRAKEN_MANTLE_TAPER_EXPONENT)
  );
}

/**
 * FINS: two thin horizontal blades flanking the mantle's TIP, half-awash.
 *
 * A squid's fins live at the far end of the mantle — which is now the tail
 * riding at the waterline behind the hump, so the blades slice the surface the
 * way a tail fluke does instead of hanging in mid-air. Each is an ellipsoid
 * whose lateral extent runs from the mantle's own line outward, so its inner
 * half is buried in the tube at any taper and no gap can open when either is
 * retuned.
 */
export const KRAKEN_FIN_CENTER_HEIGHT = 0.7;
/** Fore-and-aft chord of a fin. Sized so the fin's rear edge (BACKSET +
 *  LENGTH/2 = 3.15) stays inside the arm tips' 3.195 — the arm stays the
 *  binding constraint the footprint doc names. */
export const KRAKEN_FIN_LENGTH = 1.1;
/** Vertical extent — thin, but never zero: an edge-on plane is invisible. */
export const KRAKEN_FIN_RISE = 0.32;
/** How far out from the axis the blade reaches. Overlapped well into the tail
 *  tube (round 3) so blade and body fuse into one fluke instead of two
 *  pancakes floating beside it. */
export const KRAKEN_FIN_SPAN = 1.3;
/** How far behind the axis a fin's centre sits: ON the tail, where the tube
 *  has tapered thin enough (round 2: blades at the hump's fat base read as
 *  detached pancakes; a fluke belongs where the body ENDS). */
export const KRAKEN_FIN_BACKSET = 2.6;

/**
 * EYES: two large lamps on the sides of the head, at the waterline.
 *
 * Big, and deliberately: proportionally far larger than Cthulhu's (0.42 against
 * 0.22, on a smaller head), because a squid's eye is the largest in the animal
 * kingdom and because these are the only part of this creature at eye level for
 * a player looking across the water.
 */
export const KRAKEN_EYE_RADIUS = 0.42;
export const KRAKEN_EYE_HEIGHT = 1.15;
export const KRAKEN_EYE_FORWARD = 0.9;
export const KRAKEN_EYE_OFFSET = 1.15;
/** How far outside the skin the eye's centre sits, as a fraction of its radius. */
export const KRAKEN_EYE_BULGE = 0.45;
/** The glow: a second, larger, fainter sphere, and how much light gets through. */
export const KRAKEN_EYE_HALO_SCALE = 2.4;
export const KRAKEN_EYE_HALO_OPACITY = 0.18;
/** Bottom of an eye above the origin — what the lurking depth is derived from. */
export const KRAKEN_EYE_BOTTOM = KRAKEN_EYE_HEIGHT - KRAKEN_EYE_RADIUS;

/**
 * ARMS: eight, evenly spaced around the crown, each an arc that reaches out,
 * crests ABOVE the water and falls away below it.
 *
 * Eight because a squid has eight arms and two tentacles, and the count is what
 * makes the crown read as radial rather than as a handful of limbs. Even, unlike
 * Cthulhu's odd tentacle fan, and for the opposite reason: this creature has no
 * centre line to be symmetric about, so there is nothing for an odd count to
 * balance.
 *
 * Three points define one: where it leaves the head, where it crests, and where
 * its tip ends up. The crest is what breaks the surface; the drop is what makes
 * the thing look anchored to something under the water.
 */
export const KRAKEN_ARM_COUNT = 8;
export const KRAKEN_ARM_ROOT_REACH = 0.85;
export const KRAKEN_ARM_ROOT_HEIGHT = 0.55;
/**
 * DRAPED, NOT PLANTED (same 2026-08-19 correction as the mantle): the first
 * crown crested 1.5 high and dove to −3.4, which made every arm a rigid stilt
 * the animal seemed to STAND on. An arm floats: it crests barely above the
 * waterline (≈0.85 in model space), reaches most of its length along the
 * surface, and its tip trails a modest way under — weight in the water, not
 * legs on it.
 */
export const KRAKEN_ARM_CREST_REACH = 2.3;
export const KRAKEN_ARM_CREST_HEIGHT = 0.95;
export const KRAKEN_ARM_TIP_REACH = 3.15;
/** Round 3: tips trail JUST under the surface (waterline ≈ 0.85 in model
 *  space, so this is ~0.5 cells of water over them). Deeper tips turned the
 *  submerged run of every arm into a steep blue cone — legs again. A floating
 *  animal's arms lie ALONG the water; only the tentacles hunt deep. */
export const KRAKEN_ARM_TIP_HEIGHT = 0.35;
export const KRAKEN_ARM_RADIUS = 0.42;
export const KRAKEN_ARM_TIP_RADIUS = 0.045;
/**
 * Taper curve: radius = lerp(root, tip, t^exponent). Below 1, so the thinning
 * happens early and the last third of every arm is a fine point.
 */
export const KRAKEN_ARM_TAPER_EXPONENT = 0.7;
/**
 * Sideways wander of an arm at its crest, in cells — this is what stops the
 * crown reading as a machined turbine. Signed per arm by the noise field, and
 * TANGENTIAL (across the arm's own radial direction), so it swirls the crown
 * rather than widening it.
 */
export const KRAKEN_ARM_DRIFT = 0.3;
/**
 * Per-arm length variation, as a fraction, and it only ever SHORTENS.
 *
 * Same contract as the inward-only wrinkle carve: KRAKEN_WIDTH_CELLS is a bound
 * the server steers by, so a variation that could lengthen an arm would make the
 * stated footprint a claim the geometry exceeds. Written as (1 - v·variation)
 * with v ∈ [0, 1] at every use.
 */
export const KRAKEN_ARM_LENGTH_VARIATION = 0.22;

/**
 * TENTACLES: two, longer and thinner than the arms, ending in a flattened club.
 *
 * The pair is the other half of the squid's ten limbs and the one asymmetry the
 * crown has — they flank the direction of travel. They do NOT reach further than
 * the arms, because the footprint forbids it; they are distinguished by rearing
 * HIGHER and hanging DEEPER instead, which is also what a hunting tentacle does
 * that a manipulating arm does not.
 */
export const KRAKEN_TENTACLE_COUNT = 2;
export const KRAKEN_TENTACLE_CREST_REACH = 1.9;
/** Rears above the crown — the pair stays the tallest limbs — but no longer
 *  past the hump: the 2026-08-19 correction keeps every limb subordinate to
 *  the body mass, the way a lure is smaller than the animal casting it. */
export const KRAKEN_TENTACLE_CREST_HEIGHT = 2.1;
export const KRAKEN_TENTACLE_TIP_REACH = 2.6;
export const KRAKEN_TENTACLE_TIP_HEIGHT = -1.6;
export const KRAKEN_TENTACLE_RADIUS = 0.2;
export const KRAKEN_TENTACLE_TIP_RADIUS = 0.04;
/** The club: a flattened paddle near the tip, and where along the arc it sits.
 *  Bigger than the first pass — at gameplay distance a 0.5-cell paddle on a
 *  0.04-cell wire simply vanished, and the pair read as antennae. */
export const KRAKEN_CLUB_AT = 0.86;
export const KRAKEN_CLUB_LENGTH = 1;
export const KRAKEN_CLUB_RISE = 0.4;
export const KRAKEN_CLUB_WIDTH = 0.6;

/**
 * THE LIMB RING. All ten limbs sit on ONE evenly spaced ring rather than on an
 * arm ring with two tentacles squeezed in between: a squid's ten limbs are a
 * single crown, and two overlapping rings would eventually place a tentacle
 * through an arm at some count nobody re-checked.
 *
 * Limb k sits at (k + ½) steps around from the forward axis, so the ring is
 * symmetric about that axis and no limb lies exactly along it. The two limbs
 * either side of forward — the ones half a step out — are the TENTACLES, which
 * is what puts the hunting pair ahead of the animal where it is going.
 */
export const KRAKEN_LIMB_COUNT = KRAKEN_ARM_COUNT + KRAKEN_TENTACLE_COUNT;
export const KRAKEN_LIMB_STEP_RADIANS = (Math.PI * 2) / KRAKEN_LIMB_COUNT;
/** Angle between the two tentacles: one step, half of it either side of ahead. */
export const KRAKEN_TENTACLE_SPREAD_RADIANS = KRAKEN_LIMB_STEP_RADIANS;

/**
 * Total modelled height: the hump's axis crest plus the widest ring the skin
 * could add above it — a stated UPPER BOUND on the silhouette (the fattest
 * ring actually sits past the crest, so the real skin tops a little lower).
 * ~3.7 cells against Cthulhu's 10.9: the kraken is the LOW, BROAD animal (its
 * own header: "a standing man and a spider on the water"), and after the
 * 2026-08-19 correction its height finally agrees with that sentence — what
 * shows above the sea is a humped back and a crown of arms, not a tower.
 */
export const KRAKEN_TOTAL_HEIGHT = KRAKEN_MANTLE_APEX_HEIGHT + KRAKEN_MANTLE_RADIUS;

/**
 * Widest horizontal extent: arm tip to arm tip across the crown.
 *
 * The same 7 cells the SERVER knows as KRAKEN_FOOTPRINT_CELLS (server/kinds.ts),
 * where it sets the steering look-ahead so the body never swims into a cliff the
 * centre point cleared. The two are pinned to each other by a test rather than
 * by an import: the server half must not depend on the client half (it runs in a
 * process that never loads three), so the honest arrangement is one number in
 * each place plus a test that fails the day they disagree.
 *
 * THE BINDING CONSTRAINT is an arm tip: KRAKEN_ARM_TIP_REACH plus the tube's own
 * tip radius, 3.195 against the 3.5 half-footprint. Every other candidate — the
 * crest with its drift, a tentacle club, a fin's rear edge, and (since the
 * 2026-08-19 arch) the mantle's rearmost SKIN, tip backset plus local radius
 * along the whole swept curve — is further inside, and all of them are pinned
 * by tests (the mantle by sampling the real curve, not by adding two numbers).
 * Widening any of these without re-checking is how a limb ends up inside a
 * cliff the server's probe said was clear.
 */
export const KRAKEN_WIDTH_CELLS = 7;

/**
 * How much of an eye the water swallows at rest, in cells.
 *
 * 0.12 — an eighth of a cell, the same trick as Cthulhu's waterline bite: it is
 * the difference between a lamp floating above the sea and one that is IN it.
 */
export const KRAKEN_WATERLINE_BITE = 0.12;

/**
 * How far below the sea surface the model's origin sits when the water is deep
 * enough to allow it.
 *
 * DERIVED, not chosen: exactly the depth that puts the bottom of the eyes a
 * WATERLINE_BITE under the surface. That leaves the eyes AT the waterline, the
 * crown of arms lying on it with their crests arching clear, and the mantle
 * standing seven cells out of the sea.
 *
 * IT IS DELIBERATELY SHALLOW — 0.85 cells against Cthulhu's 6.6. He lurks and
 * shows you a head; this one has SURFACED and shows you everything it has. Two
 * monsters that hid the same amount of themselves would be one monster twice.
 */
export const KRAKEN_LURK_DEPTH = KRAKEN_EYE_BOTTOM + KRAKEN_WATERLINE_BITE;

/**
 * Bruised violet-black, against Cthulhu's green-black: the colour does the same
 * job as the shape, which is to be recognisable in one glance at whatever the
 * water is doing that frame.
 *
 * Five tones, and they climb the way light falls on a thing standing in water:
 * the mantle is the lightest lit surface (it is the part up in the sky), the fin
 * a step under it, the head darker, the arms darkest — they are half submerged —
 * and the clubs pale enough to catch the eye as the tentacles move.
 */
export const KRAKEN_MANTLE_COLOR = 0x3a2a45;
export const KRAKEN_FIN_COLOR = 0x33253d;
export const KRAKEN_HEAD_COLOR = 0x2d2035;
export const KRAKEN_ARM_COLOR = 0x271b30;
export const KRAKEN_CLUB_COLOR = 0x4a3557;
/** The eye's own dark shell, so it is not a floating dot when unlit. */
export const KRAKEN_EYE_COLOR = 0x14100c;
/** Cold lamp-amber. The one thing on the model that emits. */
export const KRAKEN_EYE_EMISSIVE = 0xd9a441;

/**
 * SKIN DETAIL. Same fields as Cthulhu's and the same inward-only rule: the carve
 * may never push a vertex outward, or KRAKEN_TOTAL_HEIGHT, KRAKEN_WIDTH_CELLS
 * and the lurk depth derived from the eyes stop being bounds.
 *
 * Both depths are under the waterline bite, for the reason Cthulhu's head carve
 * is: a dent deeper than the bite could dunk skin the placement maths believes
 * it lifted clear, or lift skin it believes it sank.
 */
export const KRAKEN_MANTLE_WRINKLE_DEPTH = 0.07;
export const KRAKEN_HEAD_WRINKLE_DEPTH = 0.05;
/** Spatial frequency of the wrinkle field, in cycles per cell. */
export const KRAKEN_WRINKLE_FREQUENCY = 1.4;
/** Per-vertex shade variation either side of the material colour, and its rate. */
export const KRAKEN_SHADE_VARIATION = 0.18;
export const KRAKEN_SHADE_FREQUENCY = 0.5;

/**
 * Idle animation rates, cycles per second, and their amplitudes.
 *
 * The limbs carry a TRAVELLING WAVE — each leads the next by
 * KRAKEN_ARM_PHASE_STEP radians — so the crown ripples around itself instead of
 * flapping as one piece. 0.16 Hz is a six-second circuit: slow enough that a
 * glance sees a still creature, fast enough that watching it is unsettling. Both
 * rates stay under the "fast idles make a monster look like a toy" line
 * anatomy.ts draws.
 *
 * KRAKEN_ARM_WAVE_RADIANS is a YAW about the model's own vertical, never a lift
 * — see the note at the animation in kraken.ts, which works out what a vertical
 * swing of the same amplitude would do to the footprint (3.9 cells from the axis
 * against the 3.5 the server steers by). A yaw provably cannot leave the static
 * footprint, so this amplitude is free to be chosen for how the crown reads.
 *
 * The mantle PULSES rather than breathing: a squid moves water through itself,
 * so the mass swells and settles on a nine-second cycle while the whole animal
 * rides very slightly up and down with it.
 */
export const KRAKEN_ARM_WAVE_HZ = 0.16;
export const KRAKEN_ARM_WAVE_RADIANS = 0.2;
export const KRAKEN_ARM_PHASE_STEP = 0.8;
export const KRAKEN_PULSE_HZ = 0.11;
export const KRAKEN_PULSE_RISE = 0.16;
/** How much the mantle swells at the top of the pulse, as a fraction. */
export const KRAKEN_PULSE_SWELL = 0.035;
