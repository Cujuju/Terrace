// THE TEMPLE — a small stone step-pyramid (owner, 2026-08-24: "a small stone
// temple in the shape of a pyramid"). Four battered courses of dressed stone
// on a plinth, a stair up the front face, and a shrine cell at the top with a
// dark doorway; the whole thing is one landmark, not a hut, so it is exactly
// twice a settlement building's footprint across.
//
// ONE DRAW CALL FOR THE STONE. Every block is baked into a single merged,
// vertex-coloured geometry, built once and shared by the standing temple AND
// the placement ghost (which differs only in its material). The masonry never
// moves and never varies — there is one temple in the world — so there is
// nothing here that a merge would have to give up, unlike a walker's limbs.
//
// WHAT DOES MOVE IS ABOVE IT: the celestial crown (./celestial.ts) turning over
// the shrine, which is separate meshes for exactly the reason the stone is not
// — see that file's header for the draw-call reasoning and the one-temple
// condition it rests on.
//
// FLAT-SHADED, like the rest of the environment: the little people are the one
// family of models in this world that is deliberately smooth (see
// pilgrims/client/models.ts); stone is not.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT FITS THE GROUND IT WAS PROMISED. Every dimension below derives from
// TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS, and the widest course is exactly that
// span — so the model's half-extent is half the span, in X and in Z, which is
// inside TEMPLE_SURVEYED_GROUND_RADIUS (protocol.ts) with room to spare.
//
// The comparison is a CHEBYSHEV one, not a radial one, and that is sound here
// where it would not be for a settlement building: the server surveys a SQUARE
// of ground, structures must compare a radial reach against it only because
// its buildings are drawn at a random yaw and a rotated box sweeps its corners
// √2 further out. THE TEMPLE HAS NO YAW ROLL — it is placed by a hand, axis-
// aligned, and a pyramid reads best square-on anyway — so its corners stay in
// the corners of the surveyed square, where the ground was checked.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS,
  TEMPLE_FRONT_APRON_WORLD_UNITS,
} from '../protocol.ts';
import { createCelestialCrown, type CelestialCrown } from './celestial.ts';

// ── Proportions, every one derived from the footprint span ──────────────────

/** The widest course, on the ground: the footprint contract itself. */
const BASE_SPAN = TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS;

/**
 * Stepped courses above the plinth. FOUR — enough for the stepped silhouette
 * to read as a pyramid at play distance (three looks like a plinth with a lid,
 * five makes each course too thin to catch a shadow at this size).
 */
const COURSE_COUNT = 4;

/** How much each course draws in PER SIDE, as a fraction of the base span.
 *  0.09 → the top course is 28% of the base, a steep-but-climbable batter. */
const COURSE_INSET_FRACTION = 0.09;

/** Course height, as a fraction of the base span. Squat courses: a temple
 *  this size is broad and low, not a tower. */
const COURSE_HEIGHT_FRACTION = 0.13;

/** The plinth the courses stand on — a thin lip of ground-coloured stone. */
const PLINTH_HEIGHT_FRACTION = 0.045;

/** The shrine cell on the summit, as a fraction of the topmost course. */
const SHRINE_WIDTH_FRACTION = 0.78;
/**
 * Shrine height, as a fraction of the base span. TALL ENOUGH TO HOLD A DOOR:
 * at 0.17 it was a slab with a letterbox scratched in it, because no portrait
 * opening fits in a cell shorter than it is wide. The cell is sized by what it
 * must contain, and what it contains is a doorway a person could walk through.
 */
const SHRINE_HEIGHT_FRACTION = 0.3;

/**
 * The lintel slab that caps the shrine. It overhangs the shrine on every side
 * — but it must stay NARROWER than the top course, or the summit reads as a
 * lid clapped over the pyramid rather than a shrine cell standing on top of
 * it. Both numbers below are enforced together where the lintel is cut.
 */
const LINTEL_OVERHANG_OF_SHRINE = 0.09;
/** The reveal of top course left visible around the lintel, as a fraction of
 *  that course — the ledge that keeps the last step reading as a step. */
const LINTEL_TOP_COURSE_REVEAL = 0.08;
const LINTEL_HEIGHT_FRACTION = 0.035;

/** The stair up the front (+X) face, as a fraction of the base span. */
const STAIR_WIDTH_FRACTION = 0.26;

/**
 * EVERY OPENING ON THIS BUILDING IS PORTRAIT.
 *
 * An opening wider than it is tall is a letterbox, not a way in. Each of the
 * three openings here had been given its own independent pair of fixed
 * fractions, so each could be — and each was — a letterbox on its own. The
 * aspect is not a property of any one of them; it is what "opening" means, so
 * it lives here, once, and the callsites cannot forget it.
 *
 * An opening is described by the HEIGHT its wall affords and the WIDEST it
 * would like to be; `opening` returns the width that actually reads.
 */
const OPENING_MIN_HEIGHT_OVER_WIDTH = 1.6;

function opening(
  maxWidth: number,
  height: number,
): { readonly width: number; readonly height: number } {
  return { width: Math.min(maxWidth, height / OPENING_MIN_HEIGHT_OVER_WIDTH), height };
}

/** The doorway sunk into the shrine's front face — the height it is given,
 *  and the most width it would take if the aspect guard allowed it. */
const DOORWAY_MAX_WIDTH_FRACTION = 0.3;
const DOORWAY_HEIGHT_FRACTION = 0.2;

/**
 * THE GROUND PORTALS — the door a settler actually walks out of (owner,
 * 2026-08-24: "Are those settlers supposed to come out of the temple
 * specifically? Because they're definitely not").
 *
 * TWO of them, flanking the stair rather than one behind it. The stair
 * occupies the middle of the front face all the way to the ground, so a single
 * centred portal would be a dark patch tucked behind a flight of steps —
 * invisible from the only angle that matters. A symmetric pair reads as a
 * temple entrance from any approach, and leaves the stair the clear run up the
 * middle that makes the silhouette a pyramid.
 *
 * They are cut into the FIRST COURSE, flanking the stair. THE STAIR IS THE
 * WAY OUT, not these: a settler is spawned on the centreline at the foot of
 * the flight (../protocol.ts's templeDoorCell), so what these two have to do
 * is read as a temple entrance from any approach while leaving that centreline
 * clear. The number that keeps them honest is not their own — it is
 * TEMPLE_FRONT_APRON_WORLD_UNITS, which STAIR_TREAD_DEPTH is clamped against
 * below so no part of this model can ever stand where a person is spawned.
 */
const PORTAL_MAX_WIDTH_FRACTION = 0.13;
const PORTAL_HEIGHT_FRACTION = 0.105;
/** Gap between the stair's edge and the near edge of each portal. */
const PORTAL_STAIR_GAP_FRACTION = 0.05;

// Derived, once: the numbers every block below is placed by.
const PLINTH_HEIGHT = BASE_SPAN * PLINTH_HEIGHT_FRACTION;
const COURSE_HEIGHT = BASE_SPAN * COURSE_HEIGHT_FRACTION;
const COURSE_INSET = BASE_SPAN * COURSE_INSET_FRACTION;
const STAIR_WIDTH = BASE_SPAN * STAIR_WIDTH_FRACTION;

/** The two ground portals, sized by the opening contract. */
const PORTAL = opening(
  BASE_SPAN * PORTAL_MAX_WIDTH_FRACTION,
  BASE_SPAN * PORTAL_HEIGHT_FRACTION,
);
/** Off the centreline, clear of the stair on either side. */
const PORTAL_Z = STAIR_WIDTH / 2 + BASE_SPAN * PORTAL_STAIR_GAP_FRACTION + PORTAL.width / 2;

/**
 * How much of the apron the stair is allowed to eat. Half.
 *
 * THE DOOR IS ON THIS AXIS, so this is the one dimension of this model that
 * can put stone where a person is spawned — and it did: the flight's bottom
 * tread stood exactly where the settler appeared. Half the apron leaves the
 * settler the other half to stand in, which at the shipped span is a clear
 * quarter of a world unit between a peep and the step it walks up.
 */
const STAIR_APRON_SHARE = 0.5;

/**
 * The depth each tread juts out from the course it serves — CAPPED so the
 * flight can never cross the apron.
 *
 * The belt to the protocol's braces. A later hand widening COURSE_INSET_
 * FRACTION (which is about the pyramid's batter, and says nothing about
 * spawning) would otherwise walk the bottom step back over the door, silently,
 * in a file with no reason to mention settlers. The cap has the last word.
 */
const STAIR_TREAD_DEPTH = Math.min(
  COURSE_INSET * 2,
  TEMPLE_FRONT_APRON_WORLD_UNITS * STAIR_APRON_SHARE * 2,
);

/**
 * Total height of the finished model, world units: the top of the lintel,
 * which is where the celestial crown is told the summit is. It is 0.9 x the
 * footprint span by construction — 1.8 world units at the shipped span of 2.
 * (It is NOT ~0.9 world units; that comment was wrong, and it was the number
 * the crown was sized against.)
 */
export const TEMPLE_HEIGHT =
  PLINTH_HEIGHT +
  COURSE_HEIGHT * COURSE_COUNT +
  BASE_SPAN * SHRINE_HEIGHT_FRACTION +
  BASE_SPAN * LINTEL_HEIGHT_FRACTION;

// ── Palette: dressed limestone, weathered ───────────────────────────────────
// One material, read as one material — but with a REAL VALUE RANGE across it.
// The first palette lived in 0xb0-0xc2, four greys within twenty levels of each
// other, and under this world's ambient rig every one of them washed to the
// same white plastic: no course could be told from the course above it.
//
// So the range is opened to roughly 0x55-0xae, and the courses ALTERNATE light
// and dark rather than drifting one way. The courses are what make the
// silhouette legible; alternation is what guarantees an edge between each pair
// of them no matter which way the sun happens to be.
//
// The lintel is the darkest thing on the building on purpose: it is the last
// stone before the sky, and the crown above it has to read against something.
const PLINTH_COLOR = 0x5f5a4e;
const COURSE_COLORS = [0x9a9280, 0x7e7767, 0x8d8574, 0x726b5c];
const STAIR_COLOR = 0xaea48e;
const SHRINE_COLOR = 0x8a8271;
const LINTEL_COLOR = 0x554f45;
/**
 * Every opening — the shrine's doorway and the two ground portals — is a hole,
 * drawn as one near-black face (cheaper and more legible at this size than a
 * real recess, which would read as noise).
 *
 * DEEP NIGHT-INDIGO rather than the brown-black it began as (owner, 2026-08-24:
 * "give the temples accoutrement colors that give it a celestial heavens
 * feel"). A warm black reads as a shadowed room; this one reads as an opening
 * onto night sky, which is what the rest of the building is about.
 */
const DOORWAY_COLOR = 0x141731;

// ── Block assembly ──────────────────────────────────────────────────────────

/**
 * One block, positioned by its CENTRE in X/Z and by its BOTTOM in Y — every
 * course here is stacked, so a bottom-anchored Y is the coordinate the caller
 * actually has. The colour is baked into a vertex-colour attribute so the
 * whole temple can merge into one geometry with one material.
 */
function block(
  width: number,
  height: number,
  depth: number,
  x: number,
  bottomY: number,
  z: number,
  color: number,
): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  geometry.translate(x, bottomY + height / 2, z);

  const rgb = new Color(color);
  const count = geometry.attributes['position']!.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = rgb.r;
    colors[i * 3 + 1] = rgb.g;
    colors[i * 3 + 2] = rgb.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Builds the temple's single geometry. Origin at the CENTRE of the base, on
 * the ground (y = 0), so the caller places it with one terrain lookup exactly
 * as every other world object here is placed. The front face — the stair and
 * the doorway — is +X, which is the direction every model in this repo faces.
 */
function buildTempleGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // The plinth: the full span, a hand's thickness, seating the pyramid on the
  // ground rather than letting the bottom course meet the grass edge-on.
  parts.push(block(BASE_SPAN, PLINTH_HEIGHT, BASE_SPAN, 0, 0, 0, PLINTH_COLOR));

  // Four battered courses, each drawn in COURSE_INSET per side.
  let courseBottom = PLINTH_HEIGHT;
  const courseSpans: number[] = [];
  for (let i = 0; i < COURSE_COUNT; i++) {
    const span = BASE_SPAN - COURSE_INSET * 2 * i;
    courseSpans.push(span);
    parts.push(
      block(span, COURSE_HEIGHT, span, 0, courseBottom, 0, COURSE_COLORS[i % COURSE_COLORS.length]!),
    );
    courseBottom += COURSE_HEIGHT;
  }

  // The stair: one tread per course, each standing on the course below and
  // reaching out to that course's own front face, so the flight climbs the
  // batter instead of hanging in front of it.
  let stairBottom = PLINTH_HEIGHT;
  for (let i = 0; i < COURSE_COUNT; i++) {
    const span = courseSpans[i]!;
    // Half the tread juts proud of the course it serves; the other half is
    // buried in it, which is what keeps the flight visually attached — and how
    // far it may jut is STAIR_TREAD_DEPTH's business, not this loop's.
    parts.push(
      block(
        STAIR_TREAD_DEPTH,
        COURSE_HEIGHT,
        STAIR_WIDTH,
        span / 2,
        stairBottom,
        0,
        STAIR_COLOR,
      ),
    );
    stairBottom += COURSE_HEIGHT;
  }

  // The shrine cell on the summit, and the lintel slab capping it.
  const summit = PLINTH_HEIGHT + COURSE_HEIGHT * COURSE_COUNT;
  const topSpan = courseSpans[COURSE_COUNT - 1]!;
  const shrineSpan = topSpan * SHRINE_WIDTH_FRACTION;
  const shrineHeight = BASE_SPAN * SHRINE_HEIGHT_FRACTION;
  parts.push(block(shrineSpan, shrineHeight, shrineSpan, 0, summit, 0, SHRINE_COLOR));

  // The overhang the shrine wants, capped by the reveal the top course must
  // keep — whichever is narrower wins, so the lid case cannot come back.
  const lintelSpan = Math.min(
    shrineSpan * (1 + LINTEL_OVERHANG_OF_SHRINE * 2),
    topSpan * (1 - LINTEL_TOP_COURSE_REVEAL),
  );
  const lintelHeight = BASE_SPAN * LINTEL_HEIGHT_FRACTION;
  parts.push(
    block(lintelSpan, lintelHeight, lintelSpan, 0, summit + shrineHeight, 0, LINTEL_COLOR),
  );

  // The doorway: a dark slab set a hair proud of the shrine's front face, so
  // it never z-fights the wall it is cut into.
  const door = opening(
    BASE_SPAN * DOORWAY_MAX_WIDTH_FRACTION,
    BASE_SPAN * DOORWAY_HEIGHT_FRACTION,
  );
  const doorSkin = shrineSpan * 0.04;
  parts.push(
    block(
      doorSkin,
      door.height,
      door.width,
      shrineSpan / 2,
      summit,
      0,
      DOORWAY_COLOR,
    ),
  );

  // The two ground portals, on the first course's front face, one either side
  // of the stair. Set a hair proud of the stone for the same reason the shrine
  // doorway is: a coplanar face z-fights.
  const portalSkin = BASE_SPAN * 0.01;
  for (const side of [-1, 1]) {
    parts.push(
      block(
        portalSkin,
        PORTAL.height,
        PORTAL.width,
        courseSpans[0]! / 2,
        PLINTH_HEIGHT,
        PORTAL_Z * side,
        DOORWAY_COLOR,
      ),
    );
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (merged === null) {
    // mergeGeometries returns null only on mismatched attribute sets, which
    // cannot happen here (every part comes from `block`) — but the render loop
    // must never meet a null geometry, so fall back to the plinth alone rather
    // than throwing inside attach.
    return block(BASE_SPAN, PLINTH_HEIGHT, BASE_SPAN, 0, 0, 0, PLINTH_COLOR);
  }
  merged.computeVertexNormals();
  return merged;
}

/**
 * The temple model set: one shared stone geometry, the materials that draw it,
 * and the two objects that use them. Built once at attach and disposed with
 * the plugin.
 */
export interface TempleModels {
  /**
   * The real, standing temple — the stone AND the celestial crown turning
   * above it (celestial.ts). The caller positions and shows/hides it, and
   * drives the crown through `animate`.
   */
  readonly standing: Group;
  /**
   * The placement GHOST the tool follows. The same stone, made translucent
   * and drawn without depth-writes so it reads as a proposal rather than a
   * building — and tinted by `setGhostLegal` to say whether the ground under
   * the cursor will actually take it.
   */
  readonly ghost: Group;
  /** Green while the press would build, red while it would be refused. */
  setGhostLegal(legal: boolean): void;
  /**
   * Poses the standing temple's crown for the given elapsed seconds. Pure in
   * `seconds`; the caller need only skip it while the temple is hidden, and
   * the crown picks up mid-turn when it comes back rather than snapping to a
   * start pose (celestial.ts's header).
   */
  animate(seconds: number): void;
  dispose(): void;
}

/** Ghost tints: the HUD's own accent green for "yes", a warm red for "no" —
 *  the same two answers the brush panel's Raise/Lower colours already give. */
const GHOST_LEGAL_COLOR = 0x6fbf73;
const GHOST_ILLEGAL_COLOR = 0xd9634a;

export function createTempleModels(): TempleModels {
  const geometry = buildTempleGeometry();

  const stone = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const ghostMaterial = new MeshLambertMaterial({
    color: GHOST_LEGAL_COLOR,
    flatShading: true,
    transparent: true,
    opacity: 0.42,
    // No depth WRITE, so the ghost never occludes the world behind it or
    // fights its own back faces; depth TEST stays on, so a ghost behind a
    // hill is still hidden by the hill.
    depthWrite: false,
  });

  const standing = new Group();
  standing.name = 'temples:standing';
  standing.add(new Mesh(geometry, stone));
  // The crown rides the STANDING temple only. The ghost is a question about
  // ground — "will a temple fit here" — and a star turning over a proposal
  // that may never be built would answer a different one.
  const crown: CelestialCrown = createCelestialCrown(BASE_SPAN, TEMPLE_HEIGHT);
  standing.add(crown.root);
  standing.visible = false;

  const ghost = new Group();
  ghost.name = 'temples:ghost';
  ghost.add(new Mesh(geometry, ghostMaterial));
  ghost.visible = false;

  return {
    standing,
    ghost,
    setGhostLegal(legal: boolean): void {
      ghostMaterial.color.setHex(legal ? GHOST_LEGAL_COLOR : GHOST_ILLEGAL_COLOR);
    },
    animate(seconds: number): void {
      crown.animate(seconds);
    },
    dispose(): void {
      crown.dispose();
      standing.clear();
      ghost.clear();
      geometry.dispose();
      stone.dispose();
      ghostMaterial.dispose();
    },
  };
}
