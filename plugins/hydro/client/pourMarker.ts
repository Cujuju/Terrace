// The ring under the cursor while the Hydro tool is held.
//
// WHY THERE IS A MARKER AT ALL. Pouring water is a server decision with no
// answer on the wire: the server broadcasts a patch or stays silent (see
// ../protocol.ts's HYDRO_POUR_MESSAGE). That is the right protocol — the client
// predicts nothing about a pour — but it leaves the player holding a tool with
// no idea what it is aimed at, on a world where a cell is a quarter of a world
// unit and the cursor covers several.
//
// So the marker answers the only question the client CAN answer honestly:
// "which cell will I pour on?" It never claims the water will do anything —
// whether the ground under it is a rim that will let go is mudslides' business,
// on the server, in a plugin this one must not import, and a ring that promised
// a landslide would be a promise the server did not make.
//
// SIZED TO THE PATCH, NOT TO THE CELL, which is where it differs from the
// torch's ring (../../fire/client/torchMarker.ts, a band around the foot of the
// one thing that would burn). A pour wets HYDRO_PATCH_RADIUS_WORLD_UNITS of
// ground in every direction, so the honest ring is the outline of the patch
// itself — the player is aiming an area, and an area is what they should see.
//
// ONE RING, one draw call, built at attach and left in the graph — hidden by
// visibility rather than added and removed, which keeps holding and dropping
// the tool free of any allocation at all.

import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry } from 'three';
import { HYDRO_PATCH_RADIUS_WORLD_UNITS } from '../protocol.ts';

/**
 * The ring's band, in world units: it sits ON the patch's outline, half its
 * width either side. DERIVED from the radius the pour actually has rather than
 * chosen, so a re-tuned patch cannot leave the marker describing the old one.
 */
const RING_BAND_WIDTH = 0.12;
const RING_INNER_RADIUS = HYDRO_PATCH_RADIUS_WORLD_UNITS - RING_BAND_WIDTH / 2;
const RING_OUTER_RADIUS = HYDRO_PATCH_RADIUS_WORLD_UNITS + RING_BAND_WIDTH / 2;
/** Smooth enough not to read as a polygon at the game's orbit distance. */
const RING_SEGMENTS = 48;

/**
 * How far above the ground the ring floats.
 *
 * Coplanar geometry z-fights, and on terraced ground the fight is visible as a
 * flickering band. The torch's ring uses the same fiftieth of a world unit on
 * the same surface at the same camera distances; see ./puddles.ts's
 * PUDDLE_HOVER_HEIGHT, which is the third member of that agreement.
 */
const RING_HOVER_HEIGHT = 0.02;

/** Pale water blue, matching the patch's own sheen rather than a UI accent. */
const RING_COLOR = 0x6fc4ec;

/** Peak and trough of the slow pulse. Alive, not blinking. */
const RING_MIN_OPACITY = 0.35;
const RING_MAX_OPACITY = 0.85;
/** Pulses per second. Slow — a heartbeat, not a strobe. */
const RING_PULSE_HZ = 0.8;

const TWO_PI = Math.PI * 2;

export interface PourMarker {
  /** Add to the plugin's layer. */
  readonly mesh: Mesh;
  /** Puts the ring on this world position and shows it. */
  showAt(x: number, groundY: number, z: number): void;
  /** Hides it — the tool was dropped, or the cursor left the terrain. */
  hide(): void;
  /** Pulses the ring. `elapsed` is the plugin's animation clock. */
  update(elapsed: number): void;
  dispose(): void;
}

export function createPourMarker(): PourMarker {
  const geometry = new RingGeometry(RING_INNER_RADIUS, RING_OUTER_RADIUS, RING_SEGMENTS);
  // RingGeometry is authored in the XY plane; the ground is XZ.
  geometry.rotateX(-Math.PI / 2);

  const material = new MeshBasicMaterial({
    color: RING_COLOR,
    transparent: true,
    opacity: RING_MAX_OPACITY,
    side: DoubleSide,
    // A marker is an overlay on the ground, not a surface: writing depth would
    // let it occlude the very fire it is aimed at.
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'hydro:pour-marker';
  mesh.visible = false;

  return {
    mesh,

    showAt(x: number, groundY: number, z: number): void {
      mesh.position.set(x, groundY + RING_HOVER_HEIGHT, z);
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
