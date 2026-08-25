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
import { TEMPLE_FOOTPRINT_SPAN_WORLD_UNITS } from '../protocol.ts';
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
const SHRINE_HEIGHT_FRACTION = 0.17;

/** The lintel slab that caps the shrine, overhanging it on every side. */
const LINTEL_OVERHANG_FRACTION = 0.06;
const LINTEL_HEIGHT_FRACTION = 0.035;

/** The stair up the front (+X) face, as a fraction of the base span. */
const STAIR_WIDTH_FRACTION = 0.26;

/** The doorway sunk into the shrine's front face. */
const DOORWAY_WIDTH_FRACTION = 0.3;
const DOORWAY_HEIGHT_FRACTION = 0.11;

// Derived, once: the numbers every block below is placed by.
const PLINTH_HEIGHT = BASE_SPAN * PLINTH_HEIGHT_FRACTION;
const COURSE_HEIGHT = BASE_SPAN * COURSE_HEIGHT_FRACTION;
const COURSE_INSET = BASE_SPAN * COURSE_INSET_FRACTION;
const STAIR_WIDTH = BASE_SPAN * STAIR_WIDTH_FRACTION;

/** Total height of the finished model, world units — used by the ghost's
 *  hover marker and by nothing else. ~0.9 world units at the shipped span. */
export const TEMPLE_HEIGHT =
  PLINTH_HEIGHT +
  COURSE_HEIGHT * COURSE_COUNT +
  BASE_SPAN * SHRINE_HEIGHT_FRACTION +
  BASE_SPAN * LINTEL_HEIGHT_FRACTION;

// ── Palette: dressed limestone, weathered ───────────────────────────────────
// Three greys close enough to read as one material and far enough apart that
// each course catches its own light — the courses are what make the silhouette
// legible, so they must not merge into one grey mass.
const PLINTH_COLOR = 0x8f887a;
const COURSE_COLORS = [0xb6afa0, 0xaea798, 0xb9b2a3, 0xa8a192];
const STAIR_COLOR = 0xc2bbac;
const SHRINE_COLOR = 0xb2ab9c;
const LINTEL_COLOR = 0x9a9385;
/** The doorway is a hole, drawn as an almost-black face — cheaper and more
 *  legible at this size than a real recess, which would read as noise. */
const DOORWAY_COLOR = 0x272219;

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
    // buried in it, which is what keeps the flight visually attached.
    const tread = COURSE_INSET * 2;
    parts.push(
      block(
        tread,
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

  const lintelSpan = shrineSpan + BASE_SPAN * LINTEL_OVERHANG_FRACTION * 2;
  const lintelHeight = BASE_SPAN * LINTEL_HEIGHT_FRACTION;
  parts.push(
    block(lintelSpan, lintelHeight, lintelSpan, 0, summit + shrineHeight, 0, LINTEL_COLOR),
  );

  // The doorway: a dark slab set a hair proud of the shrine's front face, so
  // it never z-fights the wall it is cut into.
  const doorWidth = BASE_SPAN * DOORWAY_WIDTH_FRACTION;
  const doorHeight = BASE_SPAN * DOORWAY_HEIGHT_FRACTION;
  const doorSkin = shrineSpan * 0.04;
  parts.push(
    block(
      doorSkin,
      doorHeight,
      doorWidth,
      shrineSpan / 2,
      summit,
      0,
      DOORWAY_COLOR,
    ),
  );

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
