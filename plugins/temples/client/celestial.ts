// THE CROWN — what sits on top of the temple (owner, 2026-08-24: "some
// animation to the temple that makes it feel like it's connected to the
// celestials or to the stars … something at the top").
//
// A STAR-STONE HELD IN AN ARMILLARY. Four pieces, and each one is doing a
// different job:
//
//   * the STONE — a faceted octahedron hanging a hand's breadth above the
//     shrine's lintel, touching nothing. It turns slowly on its own axis and
//     breathes up and down. Nothing else in this world floats, so the fact
//     that it is unsupported is the whole read: this is not masonry.
//   * its HALO — a second, larger octahedron drawn additively over the first.
//     A cheap standing-in for a bloom pass (this renderer has none): it makes
//     the stone read as a light SOURCE rather than a lit object, which is what
//     separates a star from a polished rock.
//   * two ARMILLARY RINGS — bronze hoops on tilted, mismatched axes, turning
//     at different rates and in opposite directions. An orrery is the oldest
//     visual shorthand there is for "this instrument is about the heavens",
//     and two rings that never line up read as MACHINERY tracking something
//     rather than as decoration spinning in place. Three motes ride the outer
//     hoop, so the eye has something to follow around it.
//   * the SHAFT — a very faint cone widening upward out of the stone, going
//     off past where the camera cares. This is the "connected to" part of the
//     brief said literally: the temple is not merely decorated with a star, it
//     has a line to the sky.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THESE ARE SEPARATE MESHES when the temple itself is one merged geometry.
// The stone's spin, the two hoops' rotations and the shaft's pulse are four
// independent transforms; merging them would freeze exactly the motion they
// exist for (pilgrims/client/models.ts states the same rule for a walker's
// limbs). That costs about six draw calls — and it is affordable for a reason
// that will not change: THERE IS AT MOST ONE TEMPLE IN THE WORLD (temples/
// server/index.ts makes a second one unrepresentable), so this is six calls
// total, not six per instance. If the one-temple rule ever goes, this crown
// must become instanced before it ships; that is the condition, written down.
//
// DETERMINISTIC AND STATELESS. `animate` is a pure function of elapsed seconds
// — no accumulators, no per-frame deltas — so a dropped frame, a paused tab or
// a re-attach cannot leave the crown out of step with itself, and two clients
// watching the same temple see the same sky-machine.
// ─────────────────────────────────────────────────────────────────────────────

import {
  AdditiveBlending,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

const TWO_PI = Math.PI * 2;

// ── Sizes, in world units, all relative to the temple's own footprint span ──
// Passed in rather than imported so this module says nothing about how big a
// temple is — it decorates whatever it is given.

/** The stone's half-diagonal: how far its points reach from its centre. */
const STONE_RADIUS_FRACTION = 0.05;
/** The halo, as a multiple of the stone. 1.9 — clearly a glow around the
 *  stone rather than a second stone. */
const HALO_SCALE = 1.9;
/** How far above the temple's summit the stone hangs. */
const HOVER_GAP_FRACTION = 0.11;

/** The two hoops, as fractions of the span. */
const OUTER_RING_RADIUS_FRACTION = 0.13;
const INNER_RING_RADIUS_FRACTION = 0.095;
/** Hoop thickness — thin enough to read as wire, thick enough not to alias
 *  into a dashed line when the camera pulls back. */
const RING_TUBE_FRACTION = 0.006;

/** Tilts of the two hoops, radians. Deliberately not multiples of each other:
 *  two rings on related axes read as a single wobbling ring. */
const OUTER_RING_TILT = 0.42;
const INNER_RING_TILT = -1.05;

/** The motes riding the outer hoop. */
const MOTE_COUNT = 3;
const MOTE_RADIUS_FRACTION = 0.011;

/** The shaft: how far up it reaches, and how wide it is at the stone and at
 *  its top. Widening upward — a beam leaving, not one arriving. */
const SHAFT_HEIGHT_FRACTION = 1.6;
const SHAFT_TOP_RADIUS_FRACTION = 0.075;

// ── Rates. Everything here is SLOW — the celestial read depends on it. ──────
// A turn measured in tens of seconds says "vast and indifferent"; the same
// motion at one turn a second says "spinning prop".

/** Stone spin, turns per second. 0.055 → about eighteen seconds a turn. */
const STONE_SPIN_TURNS_PER_SECOND = 0.055;
/** The halo turns the other way and slower, so the two facet-sets drift
 *  across each other instead of moving as one solid. */
const HALO_SPIN_TURNS_PER_SECOND = -0.031;

/** Hoop rates, turns per second — opposed, and not a simple ratio, so the
 *  pair never settles into a repeating pose a viewer can predict. */
const OUTER_RING_TURNS_PER_SECOND = 0.043;
const INNER_RING_TURNS_PER_SECOND = -0.067;

/** The bob: how far the stone rises and falls, and how often. */
const BOB_AMPLITUDE_FRACTION = 0.018;
const BOB_HZ = 0.11;

/**
 * The breath: the halo's size and the shaft's opacity swell together, on one
 * clock, so the whole crown reads as ONE thing pulsing rather than two props
 * pulsing near each other.
 */
const BREATH_HZ = 0.17;
/** Halo scale swing, either side of HALO_SCALE. */
const HALO_BREATH = 0.13;

/** Shaft opacity floor and swing. Kept low: a shaft you notice is a laser. */
const SHAFT_OPACITY_BASE = 0.1;
const SHAFT_OPACITY_SWING = 0.045;

// ── Palette ─────────────────────────────────────────────────────────────────
// The stone is COLD and the metal around it is WARM, which is what keeps the
// stone reading as light and the armillary as an object holding it.
const STONE_COLOR = 0xe4f1ff;
const HALO_COLOR = 0x6ea6ff;
const RING_COLOR = 0xb08a4c;
const MOTE_COLOR = 0xffe6a4;
const SHAFT_COLOR = 0x8fbaff;

/** What the plugin gets back: one group to parent, and a clock to drive it. */
export interface CelestialCrown {
  /** Parent this into the temple, at the temple's own origin. */
  readonly root: Group;
  /**
   * Poses the whole crown for the given ELAPSED SECONDS. Pure in `seconds` —
   * see this file's header for why that matters.
   */
  animate(seconds: number): void;
  dispose(): void;
}

/**
 * Builds the crown for a temple of `span` world units, whose summit (the top
 * of its lintel) is `summitY` world units above its base.
 */
export function createCelestialCrown(span: number, summitY: number): CelestialCrown {
  // Everything built here is owned here; one list, one dispose.
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keepGeometry = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const keepMaterial = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  const stoneRadius = span * STONE_RADIUS_FRACTION;
  const hoverY = summitY + span * HOVER_GAP_FRACTION + stoneRadius;

  const root = new Group();
  root.name = 'temples:crown';

  // ── The stone and its halo ────────────────────────────────────────────────
  // `stone` is the bobbing carrier; the two meshes inside it spin
  // independently, so the bob is written in one place and cannot desynchronise
  // between them.
  const stone = new Group();
  stone.position.y = hoverY;
  root.add(stone);

  // detail 0 — eight flat triangles. A faceted stone catches the sun in hard
  // planes as it turns, which is the flicker that sells it as a gem; a
  // subdivided one just reads as a ball.
  const core = new Mesh(
    keepGeometry(new OctahedronGeometry(stoneRadius, 0)),
    // Basic, not Lambert: this object is a LIGHT, and a lit material would go
    // dark on its shadowed side at exactly the moment it should be brightest.
    keepMaterial(new MeshBasicMaterial({ color: STONE_COLOR })),
  );
  stone.add(core);

  const halo = new Mesh(
    keepGeometry(new OctahedronGeometry(stoneRadius, 0)),
    keepMaterial(
      new MeshBasicMaterial({
        color: HALO_COLOR,
        transparent: true,
        opacity: 0.3,
        blending: AdditiveBlending,
        // Additive glows must never write depth or they punch holes in
        // whatever is drawn after them, including each other.
        depthWrite: false,
      }),
    ),
  );
  halo.scale.setScalar(HALO_SCALE);
  stone.add(halo);

  // ── The armillary ─────────────────────────────────────────────────────────
  // Each hoop is a TILT group holding a SPIN group: the tilt is fixed at build
  // time and the spin is written every frame, so `animate` never has to
  // recompose two rotations and the tilt can never drift.
  const ringMaterial = keepMaterial(
    new MeshLambertMaterial({ color: RING_COLOR, flatShading: true }),
  );

  const outerTilt = new Group();
  outerTilt.position.y = hoverY;
  outerTilt.rotation.z = OUTER_RING_TILT;
  const outerSpin = new Group();
  outerTilt.add(outerSpin);
  root.add(outerTilt);

  const outerRadius = span * OUTER_RING_RADIUS_FRACTION;
  const ringTube = span * RING_TUBE_FRACTION;
  const outerRing = new Mesh(
    keepGeometry(new TorusGeometry(outerRadius, ringTube, 6, 40)),
    ringMaterial,
  );
  // A torus is built in the XY plane; a hoop around a standing stone lies in
  // the horizontal one before its tilt is applied.
  outerRing.rotation.x = Math.PI / 2;
  outerSpin.add(outerRing);

  // The motes ride the outer hoop, evenly spaced, parented to its spin group
  // so they are carried around by the same rotation that turns the ring —
  // there is no second orbit to keep in step.
  const moteGeometry = keepGeometry(
    new SphereGeometry(span * MOTE_RADIUS_FRACTION, 8, 6),
  );
  const moteMaterial = keepMaterial(new MeshBasicMaterial({ color: MOTE_COLOR }));
  for (let i = 0; i < MOTE_COUNT; i++) {
    const angle = (i / MOTE_COUNT) * TWO_PI;
    const mote = new Mesh(moteGeometry, moteMaterial);
    mote.position.set(Math.cos(angle) * outerRadius, 0, Math.sin(angle) * outerRadius);
    outerSpin.add(mote);
  }

  const innerTilt = new Group();
  innerTilt.position.y = hoverY;
  innerTilt.rotation.x = INNER_RING_TILT;
  const innerSpin = new Group();
  innerTilt.add(innerSpin);
  root.add(innerTilt);

  const innerRing = new Mesh(
    keepGeometry(
      new TorusGeometry(span * INNER_RING_RADIUS_FRACTION, ringTube, 6, 36),
    ),
    ringMaterial,
  );
  innerRing.rotation.x = Math.PI / 2;
  innerSpin.add(innerRing);

  // ── The shaft ─────────────────────────────────────────────────────────────
  // A cone's apex is at +Y and its base at -Y, so it is turned over to put the
  // point ON the stone and the open end above it. Open-ended: a cap on the top
  // would be a visible disc hanging in the sky.
  const shaftHeight = span * SHAFT_HEIGHT_FRACTION;
  const shaftMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: SHAFT_COLOR,
      transparent: true,
      opacity: SHAFT_OPACITY_BASE,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  const shaft = new Mesh(
    keepGeometry(
      new ConeGeometry(span * SHAFT_TOP_RADIUS_FRACTION, shaftHeight, 12, 1, true),
    ),
    shaftMaterial,
  );
  shaft.rotation.x = Math.PI;
  shaft.position.y = hoverY + shaftHeight / 2;
  root.add(shaft);

  const bobAmplitude = span * BOB_AMPLITUDE_FRACTION;

  return {
    root,

    animate(seconds: number): void {
      stone.position.y = hoverY + Math.sin(seconds * BOB_HZ * TWO_PI) * bobAmplitude;
      core.rotation.y = seconds * STONE_SPIN_TURNS_PER_SECOND * TWO_PI;
      halo.rotation.y = seconds * HALO_SPIN_TURNS_PER_SECOND * TWO_PI;

      outerSpin.rotation.y = seconds * OUTER_RING_TURNS_PER_SECOND * TWO_PI;
      innerSpin.rotation.y = seconds * INNER_RING_TURNS_PER_SECOND * TWO_PI;

      // ONE breath drives both swells — see BREATH_HZ.
      const breath = Math.sin(seconds * BREATH_HZ * TWO_PI);
      halo.scale.setScalar(HALO_SCALE + breath * HALO_BREATH);
      shaftMaterial.opacity = SHAFT_OPACITY_BASE + breath * SHAFT_OPACITY_SWING;
    },

    dispose(): void {
      root.clear();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
