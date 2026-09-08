import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry } from 'three';

const RING_LIFT_WORLD_UNITS = 0.05;

const RING_RENDER_ORDER = 996;

const RING_BAND_WIDTH = 0.12;

const RING_SEGMENTS = 32;

const RING_MIN_OPACITY = 0.35;
const RING_MAX_OPACITY = 0.85;
const RING_PULSE_HZ = 0.8;

const TWO_PI = Math.PI * 2;

export interface HoverRingSpec {
  readonly name: string;
  readonly color: number;
  readonly radius: number;
}

export interface HoverRing {
  readonly mesh: Mesh;
  showAt(x: number, groundY: number, z: number): void;
  hide(): void;
  update(elapsed: number): void;
  dispose(): void;
}

export function createHoverRing(spec: HoverRingSpec): HoverRing {
  const geometry = new RingGeometry(
    spec.radius - RING_BAND_WIDTH / 2,
    spec.radius + RING_BAND_WIDTH / 2,
    RING_SEGMENTS,
  );
  geometry.rotateX(-Math.PI / 2);

  const material = new MeshBasicMaterial({
    color: spec.color,
    transparent: true,
    opacity: RING_MAX_OPACITY,
    side: DoubleSide,
    depthTest: false,
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
