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
//   * its AUREOLE — a second, larger octahedron around the first, drawn
//     BACK-FACES-ONLY so it rings the stone without veiling it. This is the
//     piece that makes the stone read as a light SOURCE rather than a lit
//     object, and it is opaque-ish and saturated for a reason written out
//     under DAYLIGHT below.
//   * its BLOOM — a third, larger shell, additive. The cheap stand-in for a
//     bloom pass this renderer does not have. It is a BONUS, not the read: it
//     earns its keep once the sky darkens and contributes almost nothing at
//     midday, which is exactly what additive light does.
//   * two ARMILLARY RINGS — gilded hoops on tilted, mismatched axes, turning
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
// ─────────────────────────────────────────────────────────────────────────────
// DAYLIGHT IS THE HARD CASE, AND ADDITIVE BLENDING FAILS IT.
//
// Everything up here was additive once — halo, shaft, and a near-white stone —
// and the whole crown was invisible against a bright sky. That is not a
// tuning miss, it is what the blend mode does: additive light ADDS to what is
// behind it, and the daylit sky is already near white, so every channel
// saturates and nothing changes. Raising opacity cannot fix it; adding to
// white is white at any strength.
//
// So the read is carried by HUE AND VALUE CONTRAST from opaque, saturated
// surfaces — a deep violet aureole the pale sky cannot swallow, with the white
// stone sitting inside it — and additive is kept only as the night bonus it is
// good at. Anything added here must be legible with the additive layers
// switched off entirely.
// ─────────────────────────────────────────────────────────────────────────────
//
// DETERMINISTIC AND STATELESS. `animate` is a pure function of elapsed seconds
// — no accumulators, no per-frame deltas — so a dropped frame, a paused tab or
// a re-attach cannot leave the crown out of step with itself, and two clients
// watching the same temple see the same sky-machine.
// ─────────────────────────────────────────────────────────────────────────────

import {
  AdditiveBlending,
  BackSide,
  Color,
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

// A CROWN, NOT A BAUBLE. Every size here was roughly half what it is now, and
// the result sat on the roof like an ornament: the hoops were narrower than
// the lintel they hovered over, so the eye read them as something ON the
// building rather than something the building reaches into. The rule the
// numbers below keep is that THE OUTER HOOP IS WIDER THAN THE LINTEL — it
// encircles the summit instead of perching on it — and it clears the stone by
// enough that the gap, not the roof, is what the silhouette is about.

/** The stone's half-diagonal: how far its points reach from its centre. */
const STONE_RADIUS_FRACTION = 0.085;
/** The aureole, as a multiple of the stone. Clearly a glow around the stone
 *  rather than a second stone. */
const HALO_SCALE = 1.9;
/** The additive bloom shell, as a multiple of the stone — outside the aureole,
 *  so at night the glow reads as reaching past it. */
const BLOOM_SCALE = 2.8;
/** How far above the temple's summit the stone hangs. Nearly a third of the
 *  span: a clear column of air, so the crown is plainly not resting on the
 *  lintel. */
const HOVER_GAP_FRACTION = 0.3;

/** The two hoops, as fractions of the span. The outer one is 0.52 of the span
 *  across — wider than the lintel below it (about 0.42), which is the whole
 *  point of the number. */
const OUTER_RING_RADIUS_FRACTION = 0.26;
const INNER_RING_RADIUS_FRACTION = 0.19;
/** Hoop thickness — thin enough to read as wire, thick enough not to alias
 *  into a dashed line when the camera pulls back. */
const RING_TUBE_FRACTION = 0.01;

/** Tilts of the two hoops, radians. Deliberately not multiples of each other:
 *  two rings on related axes read as a single wobbling ring. */
const OUTER_RING_TILT = 0.42;
const INNER_RING_TILT = -1.05;

/** The motes riding the outer hoop. */
const MOTE_COUNT = 3;
const MOTE_RADIUS_FRACTION = 0.017;

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

/**
 * Shaft opacity floor and swing. Still low — a shaft you NOTICE is a laser —
 * but no longer the near-nothing that additive blending needed, because the
 * shaft now tints what is behind it instead of adding to it (see DAYLIGHT in
 * the header). Against a pale sky this is a soft violet column; against a dark
 * one it is a faint one.
 */
const SHAFT_OPACITY_BASE = 0.2;
const SHAFT_OPACITY_SWING = 0.07;

/** The aureole's opacity. High enough to hold its own hue against a white
 *  sky, short of opaque so the bloom behind it still shows through at night. */
const AUREOLE_OPACITY = 0.72;
/** The bloom's opacity — the night bonus, deliberately slight. */
const BLOOM_OPACITY = 0.3;

// ── Palette: THE CELESTIAL VAULT ────────────────────────────────────────────
// Owner, 2026-08-24: "give the temples accoutrement colors that give it a
// celestial heavens feel".
//
// The scheme is the oldest one there is for painting the heavens — GILT ON
// DEEP BLUE, the star-ceiling of every vaulted nave and every astrolabe's
// engraved limb. It settles three questions at once:
//
//   * the ARMILLARY is gold, not the weathered bronze it began as. Bronze is
//     the colour of a tool left outside; gold is the colour of an instrument
//     made for the sky, and it is the one warm thing up here, so the eye reads
//     the hoops as the OBJECT and everything around them as light.
//   * the LIGHT is violet-indigo rather than the daylight blue it began as.
//     Sky blue at midday says "weather"; indigo says "the hour when stars come
//     out", which is the register the whole crown is written in.
//   * the STONE at the centre stays near-white but is warmed a touch toward
//     starlight, so it does not read as a chip of the same light its own halo
//     is made of — a star is white, its corona is not.
//
// The MOTES break the gold/indigo pair on purpose: pale ice-cyan, the one hue
// in neither family, so three small moving things stay findable against a gold
// hoop AND against the violet glow behind it.
const STONE_COLOR = 0xfff6e2;
/** The aureole and the bloom share this hue. DEEP and SATURATED, not a pastel
 *  wash: it is the only thing separating a white stone from a white sky. */
const HALO_COLOR = 0x4a2fd6;
const RING_COLOR = 0xe0b45c;
const MOTE_COLOR = 0xbdf0ff;
const SHAFT_COLOR = 0x8f74ff;

/**
 * The AURORA DRIFT: the halo and the shaft do not hold one colour, they wander
 * slowly between indigo and a cold teal and back.
 *
 * It is the cheapest possible aurora — two constants and a lerp on a clock
 * already being read — and it is what stops the crown reading as a coloured
 * lamp. A light that never changes hue is electric; one that drifts is
 * atmospheric, and the register this whole palette is aiming at is atmosphere.
 *
 * Its own clock, slower than the breath, so hue and brightness never swell
 * together into an obvious pulse.
 */
const AURORA_HZ = 0.043;
const AURORA_COOL_COLOR = 0x3fd6c8;

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

  // The AUREOLE: normal blending, so it TINTS the sky behind it rather than
  // adding to it, and BackSide, so only its far shell is drawn — the stone
  // inside stays a crisp white silhouette instead of being veiled by violet.
  // Depth is tested but not written: the aureole's back faces lose to the
  // stone that already wrote depth in front of them, which is what keeps the
  // stone clean without any sorting for the renderer to get wrong.
  const haloMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: HALO_COLOR,
      transparent: true,
      opacity: AUREOLE_OPACITY,
      side: BackSide,
      depthWrite: false,
    }),
  );
  const halo = new Mesh(keepGeometry(new OctahedronGeometry(stoneRadius, 0)), haloMaterial);
  halo.scale.setScalar(HALO_SCALE);
  stone.add(halo);

  // The BLOOM: the additive layer, kept for what additive is actually good at
  // — a night sky, where there is headroom to add into. It contributes almost
  // nothing at midday and nothing here depends on it.
  const bloomMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: HALO_COLOR,
      transparent: true,
      opacity: BLOOM_OPACITY,
      blending: AdditiveBlending,
      // Additive glows must never write depth or they punch holes in
      // whatever is drawn after them, including each other.
      depthWrite: false,
    }),
  );
  const bloom = new Mesh(keepGeometry(new OctahedronGeometry(stoneRadius, 0)), bloomMaterial);
  bloom.scale.setScalar(BLOOM_SCALE);
  stone.add(bloom);

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
      // Normal blending, for the reason in DAYLIGHT above: an additive shaft
      // against a bright sky is nothing at all.
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

  // The aurora's two ends, plus ONE scratch colour to lerp into. Allocated
  // here and reused for the life of the crown: `animate` runs at frame rate,
  // and three colour objects per frame is exactly the kind of per-frame
  // allocation every other animated model in this repo is careful not to make.
  const auroraWarm = new Color(HALO_COLOR);
  const auroraCool = new Color(AURORA_COOL_COLOR);
  const auroraShaftWarm = new Color(SHAFT_COLOR);
  const scratch = new Color();

  return {
    root,

    animate(seconds: number): void {
      stone.position.y = hoverY + Math.sin(seconds * BOB_HZ * TWO_PI) * bobAmplitude;
      core.rotation.y = seconds * STONE_SPIN_TURNS_PER_SECOND * TWO_PI;
      halo.rotation.y = seconds * HALO_SPIN_TURNS_PER_SECOND * TWO_PI;
      bloom.rotation.y = -halo.rotation.y;

      outerSpin.rotation.y = seconds * OUTER_RING_TURNS_PER_SECOND * TWO_PI;
      innerSpin.rotation.y = seconds * INNER_RING_TURNS_PER_SECOND * TWO_PI;

      // ONE breath drives both swells — see BREATH_HZ.
      const breath = Math.sin(seconds * BREATH_HZ * TWO_PI);
      halo.scale.setScalar(HALO_SCALE + breath * HALO_BREATH);
      bloom.scale.setScalar(BLOOM_SCALE + breath * HALO_BREATH);
      shaftMaterial.opacity = SHAFT_OPACITY_BASE + breath * SHAFT_OPACITY_SWING;

      // The aurora drift, on its OWN slower clock (AURORA_HZ) so hue and
      // brightness never swell together. Mapped from sine's [-1, 1] into the
      // [0, 1] a lerp wants.
      const drift = (Math.sin(seconds * AURORA_HZ * TWO_PI) + 1) / 2;
      haloMaterial.color.copy(scratch.lerpColors(auroraWarm, auroraCool, drift));
      bloomMaterial.color.copy(haloMaterial.color);
      shaftMaterial.color.copy(
        scratch.lerpColors(auroraShaftWarm, auroraCool, drift),
      );
    },

    dispose(): void {
      root.clear();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
