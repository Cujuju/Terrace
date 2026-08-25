// The ring under the cursor while the Torch tool is held.
//
// WHY THERE IS A MARKER AT ALL. Lighting a fire is a server decision with no
// answer on the wire: the server broadcasts a fire or stays silent (see
// ../protocol.ts's FIRE_IGNITE_MESSAGE). That is the right protocol — the client
// predicts nothing about a fire — but it leaves the player holding a tool with
// no idea what it is aimed at, on a world where a cell is a quarter of a world
// unit and the cursor covers several.
//
// So the marker answers the only question the client CAN answer honestly:
// "which cell will I light?" It never claims the cell will catch — it cannot
// know what fuel the server has there, and guessing would be a promise the
// server did not make. A ring on bare rock is the truth: that is where the
// torch goes, and nothing will come of it.
//
// ONE RING, one draw call, built at attach and left in the graph — hidden by
// visibility rather than added and removed, which keeps holding and dropping the
// tool free of any allocation at all.

import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry } from 'three';

/**
 * Ring size in WORLD units, not cells. A cell is a quarter of a world unit
 * (CELL_WORLD_SIZE) and a full-grown tree is ~0.9 across, so a ring sized to the
 * cell would be a dot lost under the crown. 0.34/0.46 draws a band around the
 * FOOT OF THE THING THAT WOULD BURN, which is what the player is actually
 * aiming at.
 */
const RING_INNER_RADIUS = 0.34;
const RING_OUTER_RADIUS = 0.46;
/** Smooth enough not to read as a polygon at the game's orbit distance. */
const RING_SEGMENTS = 32;

/**
 * How far above the ground the ring floats.
 *
 * Coplanar geometry z-fights, and on terraced ground the fight is visible as a
 * flickering band. A fiftieth of a world unit is below the eye's ability to see
 * the ring float at play distance and comfortably clear of the depth buffer's
 * resolution here.
 */
const RING_HOVER_HEIGHT = 0.02;

/** Ember orange, matching the flame's own core rather than a UI accent. */
const RING_COLOR = 0xff7a33;

/** Peak and trough of the slow pulse. Alive, not blinking. */
const RING_MIN_OPACITY = 0.35;
const RING_MAX_OPACITY = 0.85;
/** Pulses per second. Slow — a heartbeat, not a strobe. */
const RING_PULSE_HZ = 0.8;

const TWO_PI = Math.PI * 2;

export interface TorchMarker {
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

export function createTorchMarker(): TorchMarker {
  const geometry = new RingGeometry(RING_INNER_RADIUS, RING_OUTER_RADIUS, RING_SEGMENTS);
  // RingGeometry is authored in the XY plane; the ground is XZ.
  geometry.rotateX(-Math.PI / 2);

  const material = new MeshBasicMaterial({
    color: RING_COLOR,
    transparent: true,
    opacity: RING_MAX_OPACITY,
    side: DoubleSide,
    // A marker is an overlay on the ground, not a surface: writing depth would
    // let it occlude the very flame it is aimed at.
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'fire:torch-marker';
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
