// A TOOL'S HOVER RING — the circle under the cursor that says which cell a
// press would act on, and how far that act reaches.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT (owner, 2026-09-06: "wherever I have moused to, I will see that
// orange or blue circle across all of the bands that it technically covers
// instead of being drawn just at the selected band and bands below").
//
// Every tool ring in this repo was a flat ring at ONE sampled height, drawn
// with ordinary depth testing. Terraced ground is flat caps separated by
// risers, so any band standing above the sampled one OCCLUDED the ring — the
// circle was sliced away wherever the ground rose through it and survived only
// over the hovered band and everything below. A player aiming at band three of
// five saw two thirds of a circle and had to infer the rest.
//
// CORE ALREADY SETTLED THIS, for the sculpt brush and in the same words (owner,
// 2026-08-22: "the brush is drawn as if it's floating ... it is difficult to
// make out where it would be drawing"). client/src/render/brushPreview.ts's
// outline turns its depth test OFF and its render order UP, so it "reads
// through terrain steps inside the footprint instead of being sliced by them",
// and its header states why that is the honest presentation: THE TOOL AFFECTS
// THOSE CELLS WHATEVER THEIR CURRENT HEIGHT. A ring that stops at a riser is
// making a promise about reach that the tool does not keep.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A KIT CONTRACT AND NOT A FIX IN TWO PLUGINS.
//
// fire's torch marker and hydro's pour marker were byte-identical apart from a
// colour and a radius, and both had the same defect for the same reason: each
// picked its own overlay behaviour, and neither knew what core had already
// decided. That is ./groundFollow.ts's situation exactly — four plugins each
// writing the same wrong assignment — and it takes the same answer: the ring
// is one thing, built once, and a plugin supplies only what is genuinely its
// own (what colour it is, and how far it reaches).
//
// THE RENDER ORDER IS PARTICULARLY NOT A PLUGIN'S TO PICK. It has to sit in the
// family brushPreview.ts already occupies (997 skirt, 998 outline, 999
// crosshair) or a ring and an outline drawn in the same frame would order by
// accident. A plugin choosing a number would be guessing at core's business.
//
// WHAT THIS DELIBERATELY DOES NOT DO is draw brushPreview's SKIRT — the wall
// extruded down from the outline, depth-tested, whose visible bottom edge is
// where the boundary meets the ground. That answers a second question ("where
// does the ring touch?") and it costs a second mesh per tool. The rings here
// mark a cell and a reach, not a stroke about to be dragged; if a tool is ever
// added that needs the contact line, the skirt belongs in this file too rather
// than in that tool.

import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry } from 'three';

/**
 * How far above the sampled surface the ring floats, in world units.
 *
 * brushPreview.ts's OUTLINE_LIFT_WORLD_UNITS, and its reasoning transfers whole:
 * with depthTest off the ring CANNOT z-fight, so this buys legibility at
 * glancing angles only, and it stays small enough that the ring still reads as
 * lying on the ground rather than hovering over it.
 */
const RING_LIFT_WORLD_UNITS = 0.05;

/**
 * Where the ring sits in the frame.
 *
 * 996 — BELOW THE WHOLE of brushPreview.ts's family (997 skirt, 998 outline,
 * 999 crosshair) rather than interleaved with it. The two are never live in the
 * same frame, because holding a tool is precisely what takes the pointer away
 * from the brush (client/src/plugins/toolbar.ts), so this is not a tie that has
 * to be broken — it is a number chosen so that if that ever stops being true,
 * the brush's own promise is the one on top. It is still above everything a
 * plugin draws in the world; see the header on why the number is core's.
 */
const RING_RENDER_ORDER = 996;

/**
 * How wide the band of the ring is, in world units.
 *
 * The width both markers already used. It is a LINE WEIGHT, not a reach: it has
 * to stay readable at the far end of the camera's range without thickening into
 * a disc at the near end, and it is deliberately independent of the radius so a
 * 0.4-unit ring and a 1.5-unit ring read as the same instrument.
 */
const RING_BAND_WIDTH = 0.12;

/**
 * Segments around the ring. Thirty-two: the widest ring a tool asks for is a
 * couple of world units across, at which a 32-gon's flats are under a pixel at
 * the closest the camera comes.
 */
const RING_SEGMENTS = 32;

/**
 * The ring breathes rather than sitting still, so it reads as a live cursor and
 * not as something already painted on the ground. The floor is well clear of
 * zero: a marker that vanished at the bottom of its cycle would flicker.
 */
const RING_MIN_OPACITY = 0.35;
const RING_MAX_OPACITY = 0.85;
const RING_PULSE_HZ = 0.8;

const TWO_PI = Math.PI * 2;

export interface HoverRingSpec {
  /** Scene-graph name, `<plugin>:<what>` as every other named object here is. */
  readonly name: string;
  /** The tool's own colour — the one thing about the ring that identifies it. */
  readonly color: number;
  /** How far the tool reaches, in world units. The ring's centreline. */
  readonly radius: number;
}

export interface HoverRing {
  /** The ring itself. The plugin adds it to its own layer. */
  readonly mesh: Mesh;
  /** Puts the ring on the cell at (x, z), sitting on ground height `groundY`. */
  showAt(x: number, groundY: number, z: number): void;
  hide(): void;
  /** Advances the pulse. `elapsed` is the plugin's own animation clock. */
  update(elapsed: number): void;
  dispose(): void;
}

export function createHoverRing(spec: HoverRingSpec): HoverRing {
  const geometry = new RingGeometry(
    spec.radius - RING_BAND_WIDTH / 2,
    spec.radius + RING_BAND_WIDTH / 2,
    RING_SEGMENTS,
  );
  // RingGeometry is authored in the XY plane; the ground is XZ.
  geometry.rotateX(-Math.PI / 2);

  const material = new MeshBasicMaterial({
    color: spec.color,
    transparent: true,
    opacity: RING_MAX_OPACITY,
    side: DoubleSide,
    // THE WHOLE FIX, and the header is why: terrain no longer slices the ring,
    // so it is drawn across every band its radius covers rather than only the
    // hovered one and those below it.
    depthTest: false,
    // An overlay writes no depth either, or it would occlude whatever is drawn
    // after it — including the flames and the water the ring is aimed at.
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = spec.name;
  mesh.renderOrder = RING_RENDER_ORDER;
  mesh.visible = false;

  return {
    mesh,

    showAt(x: number, groundY: number, z: number): void {
      mesh.position.set(x, groundY + RING_LIFT_WORLD_UNITS, z);
      mesh.visible = true;
    },

    hide(): void {
      mesh.visible = false;
    },

    update(elapsed: number): void {
      if (!mesh.visible) return;
      const phase = (Math.sin(elapsed * RING_PULSE_HZ * TWO_PI) + 1) / 2;
      material.opacity = RING_MIN_OPACITY + (RING_MAX_OPACITY - RING_MIN_OPACITY) * phase;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
