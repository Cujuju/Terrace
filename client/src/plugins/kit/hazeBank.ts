import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
} from 'three';

const TWO_PI = Math.PI * 2;

const HAZE_RADIAL_SEGMENTS = 64;
const HAZE_RINGS = 6;

export interface HazeLayerSpec {
  readonly height: number;
  readonly radiusScale: number;
  readonly opacity: number;
  readonly spinHz: number;
  readonly bobUnits: number;
  readonly bobHz: number;
}

export const HAZE_COLOR = 0xa9b8c2;

export const HAZE_LAYERS: readonly HazeLayerSpec[] = [
  { height: 0.25, radiusScale: 1, opacity: 0.3, spinHz: 0.013, bobUnits: 0.1, bobHz: 0.043 },
  { height: 0.85, radiusScale: 0.9, opacity: 0.24, spinHz: -0.019, bobUnits: 0.16, bobHz: 0.031 },
  { height: 1.55, radiusScale: 0.76, opacity: 0.17, spinHz: 0.027, bobUnits: 0.22, bobHz: 0.023 },
  { height: 2.4, radiusScale: 0.58, opacity: 0.1, spinHz: -0.037, bobUnits: 0.28, bobHz: 0.017 },
];

export const HAZE_EDGE_WOBBLE = 0.22;
export const HAZE_EDGE_LOBES_A = 4;
export const HAZE_EDGE_LOBES_B = 7;
export const HAZE_EDGE_PHASE_A = 1.1;
export const HAZE_EDGE_PHASE_B = 2.7;

export const HAZE_EDGE_SOFTNESS = 1.8;

export function hazeEdgeWobble(angle: number): number {
  return (
    1 +
    HAZE_EDGE_WOBBLE *
      (Math.sin(HAZE_EDGE_LOBES_A * angle + HAZE_EDGE_PHASE_A) * 0.6 +
        Math.sin(HAZE_EDGE_LOBES_B * angle + HAZE_EDGE_PHASE_B) * 0.4)
  );
}

export const PRECIPITATION_HAZE_SCALE = 1 / 3;

export function buildHazeGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  positions.push(0, 0, 0);
  colors.push(1, 1, 1, 1);

  for (let ring = 1; ring <= HAZE_RINGS; ring++) {
    const out = ring / HAZE_RINGS;
    const alpha = Math.pow(1 - out * out, HAZE_EDGE_SOFTNESS);
    for (let side = 0; side < HAZE_RADIAL_SEGMENTS; side++) {
      const angle = (side / HAZE_RADIAL_SEGMENTS) * TWO_PI;
      const radius = out * hazeEdgeWobble(angle);
      positions.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));
      colors.push(1, 1, 1, alpha);
    }
  }

  for (let side = 0; side < HAZE_RADIAL_SEGMENTS; side++) {
    const here = 1 + side;
    const next = 1 + ((side + 1) % HAZE_RADIAL_SEGMENTS);
    indices.push(0, next, here);
  }

  for (let ring = 1; ring < HAZE_RINGS; ring++) {
    const inner = 1 + (ring - 1) * HAZE_RADIAL_SEGMENTS;
    const outer = 1 + ring * HAZE_RADIAL_SEGMENTS;
    for (let side = 0; side < HAZE_RADIAL_SEGMENTS; side++) {
      const nextSide = (side + 1) % HAZE_RADIAL_SEGMENTS;
      indices.push(inner + side, outer + nextSide, outer + side);
      indices.push(inner + side, inner + nextSide, outer + nextSide);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

export interface HazeBank {
  readonly sheets: readonly Mesh[];
  update(worldRadius: number, intensity: number, elapsed: number): void;
  dispose(): void;
}

export function createHazeBank(
  geometry: BufferGeometry,
  strength: number,
  renderOrder: number,
): HazeBank {
  const materials: MeshBasicMaterial[] = [];
  const sheets: Mesh[] = [];

  for (const _layer of HAZE_LAYERS) {
    const material = new MeshBasicMaterial({
      color: HAZE_COLOR,
      transparent: true,
      opacity: 0,
      vertexColors: true,
      side: DoubleSide,
      depthWrite: false,
    });
    const sheet = new Mesh(geometry, material);
    sheet.renderOrder = renderOrder;
    materials.push(material);
    sheets.push(sheet);
  }

  return {
    sheets,

    update(worldRadius: number, intensity: number, elapsed: number): void {
      for (let index = 0; index < sheets.length; index++) {
        const layer = HAZE_LAYERS[index]!;
        const sheet = sheets[index]!;
        materials[index]!.opacity = layer.opacity * strength * intensity;
        sheet.scale.setScalar(worldRadius * layer.radiusScale);
        sheet.rotation.y = elapsed * layer.spinHz * TWO_PI;
        sheet.position.y = layer.height + Math.sin(elapsed * layer.bobHz * TWO_PI) * layer.bobUnits;
      }
    },

    dispose(): void {
      for (const material of materials) material.dispose();
    },
  };
}
