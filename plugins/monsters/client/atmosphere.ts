import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  type PointLight,
  DoubleSide,
} from 'three';
import {
  BOLT_JAG_CELLS,
  BOLT_MAX_RADIUS_CELLS,
  BOLT_TIP_WIDTH_FRACTION,
  BOLT_TOP_CELLS,
  BOLT_WIDTH_CELLS,
  FLASH_COLOR,
  FLASH_GLOW_LAYER_INDEX,
  FLASH_GLOW_OPACITY,
  FLASH_LIGHT_PEAK_INTENSITY,
  LightningSchedule,
  MIST_COLOR,
  MIST_EDGE_LOBES_A,
  MIST_EDGE_LOBES_B,
  MIST_EDGE_PHASE_A,
  MIST_EDGE_PHASE_B,
  MIST_EDGE_SOFTNESS,
  MIST_EDGE_WOBBLE,
  MIST_FADE_SECONDS,
  MIST_RADIUS_CELLS,
  approachEnvelope,
  type SwimmerDreadSpec,
} from './dread.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';

const TWO_PI = Math.PI * 2;

const MIST_RADIAL_SEGMENTS = 48;
const MIST_RINGS = 6;

const BOLT_SEGMENTS = 7;
const BOLT_JAG_TURN_RADIANS = 2.4;

const DREAD_RENDER_ORDER = 1;

function edgeWobble(angle: number): number {
  return (
    1 +
    MIST_EDGE_WOBBLE *
      (Math.sin(MIST_EDGE_LOBES_A * angle + MIST_EDGE_PHASE_A) * 0.6 +
        Math.sin(MIST_EDGE_LOBES_B * angle + MIST_EDGE_PHASE_B) * 0.4)
  );
}

function buildMistGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  positions.push(0, 0, 0);
  colors.push(1, 1, 1, 1);

  for (let ring = 1; ring <= MIST_RINGS; ring++) {
    const out = ring / MIST_RINGS;
    const alpha = Math.pow(1 - out * out, MIST_EDGE_SOFTNESS);
    for (let side = 0; side < MIST_RADIAL_SEGMENTS; side++) {
      const angle = (side / MIST_RADIAL_SEGMENTS) * TWO_PI;
      const radius = MIST_RADIUS_CELLS * out * edgeWobble(angle);
      positions.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));
      colors.push(1, 1, 1, alpha);
    }
  }

  for (let side = 0; side < MIST_RADIAL_SEGMENTS; side++) {
    const here = 1 + side;
    const next = 1 + ((side + 1) % MIST_RADIAL_SEGMENTS);
    indices.push(0, next, here);
  }

  for (let ring = 1; ring < MIST_RINGS; ring++) {
    const inner = 1 + (ring - 1) * MIST_RADIAL_SEGMENTS;
    const outer = 1 + ring * MIST_RADIAL_SEGMENTS;
    for (let side = 0; side < MIST_RADIAL_SEGMENTS; side++) {
      const nextSide = (side + 1) % MIST_RADIAL_SEGMENTS;
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

function buildBoltGeometry(bottomCells: number): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const span = BOLT_TOP_CELLS - bottomCells;

  function ribbon(sideways: 'x' | 'z'): void {
    const first = positions.length / 3;
    for (let step = 0; step <= BOLT_SEGMENTS; step++) {
      const along = step / BOLT_SEGMENTS;
      const y = BOLT_TOP_CELLS - along * span;
      const jag = BOLT_JAG_CELLS * Math.sin(step * BOLT_JAG_TURN_RADIANS);
      const halfWidth =
        (BOLT_WIDTH_CELLS * (1 - (1 - BOLT_TIP_WIDTH_FRACTION) * along)) / 2;
      for (const edge of [-1, 1]) {
        const offset = jag + edge * halfWidth;
        positions.push(
          sideways === 'x' ? offset : 0,
          y,
          sideways === 'z' ? offset : 0,
        );
      }
    }
    for (let step = 0; step < BOLT_SEGMENTS; step++) {
      const corner = first + step * 2;
      indices.push(corner, corner + 1, corner + 3);
      indices.push(corner, corner + 3, corner + 2);
    }
  }

  ribbon('x');
  ribbon('z');

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

export interface Dread {
  readonly root: Group;

  reset(): void;

  setFlashLight(light: PointLight | null): void;

  update(seconds: number, dt: number, present: boolean): void;

  isFaded(): boolean;

  dispose(): void;
}

export interface DreadRigs {
  readonly rigs: readonly Dread[];

  dispose(): void;
}

// Every geometry and material a kind's dreads will ever need, built once: spawning
// one built five materials and two geometries, and spawns are not rare.
export function createDreadRigs(spec: SwimmerDreadSpec, count: number): DreadRigs {
  const mistGeometry = buildMistGeometry();
  const boltGeometry = buildBoltGeometry(spec.boltBottomCells);

  const rigs: Dread[] = [];
  for (let index = 0; index < count; index++) {
    rigs.push(createDread(spec, mistGeometry, boltGeometry));
  }

  return {
    rigs,

    dispose(): void {
      for (const rig of rigs) rig.dispose();
      rigs.length = 0;
      mistGeometry.dispose();
      boltGeometry.dispose();
    },
  };
}

function createDread(
  spec: SwimmerDreadSpec,
  mistGeometry: BufferGeometry,
  boltGeometry: BufferGeometry,
): Dread {
  const root = new Group();
  root.name = 'monsters:dread';

  const mistMaterials: MeshBasicMaterial[] = [];
  const mistSheets: Mesh[] = [];
  for (const layer of spec.mistLayers) {
    const material = new MeshBasicMaterial({
      color: MIST_COLOR,
      transparent: true,
      opacity: 0,
      vertexColors: true,
      side: DoubleSide,
      depthWrite: false,
    });
    const sheet = new Mesh(mistGeometry, material);
    sheet.scale.setScalar(layer.radiusScale);
    sheet.position.y = layer.height;
    sheet.renderOrder = DREAD_RENDER_ORDER;
    sheet.visible = false;
    root.add(sheet);
    mistMaterials.push(material);
    mistSheets.push(sheet);
  }

  const glowMaterial = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    vertexColors: true,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const glowSheet = new Mesh(mistGeometry, glowMaterial);
  glowSheet.position.y = spec.mistLayers[FLASH_GLOW_LAYER_INDEX]!.height;
  glowSheet.renderOrder = DREAD_RENDER_ORDER;
  glowSheet.visible = false;
  root.add(glowSheet);

  const boltMaterial = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const bolt = new Mesh(boltGeometry, boltMaterial);
  bolt.renderOrder = DREAD_RENDER_ORDER;
  bolt.visible = false;
  const boltPivot = new Group();
  boltPivot.add(bolt);
  root.add(boltPivot);

  // The flash light stays parented to the plugin's bank, never to this rig: reparenting
  // reorders the scene's lights, and three keys every lit pipeline on that order.
  let flashLight: PointLight | null = null;
  let flashOffsetX = 0;
  let flashOffsetZ = 0;

  const reducedMotion = watchReducedMotion();
  let lightning = new LightningSchedule();
  let envelope = 0;

  return {
    root,

    reset(): void {
      envelope = 0;
      lightning = new LightningSchedule();
      flashOffsetX = 0;
      flashOffsetZ = 0;
      boltPivot.position.set(0, 0, 0);
      boltPivot.rotation.y = 0;
      bolt.visible = false;
      glowSheet.visible = false;
      for (const sheet of mistSheets) sheet.visible = false;
      if (flashLight !== null) flashLight.intensity = 0;
    },

    setFlashLight(light: PointLight | null): void {
      if (flashLight !== null && flashLight !== light) flashLight.intensity = 0;
      flashLight = light;
    },

    update(seconds: number, dt: number, present: boolean): void {
      const reduced = reducedMotion.matches();

      const target = present ? 1 : 0;
      envelope = reduced
        ? target
        : approachEnvelope(envelope, target, dt, MIST_FADE_SECONDS);

      for (let index = 0; index < mistSheets.length; index++) {
        const layer = spec.mistLayers[index]!;
        const sheet = mistSheets[index]!;
        mistMaterials[index]!.opacity = layer.opacity * envelope;
        sheet.visible = envelope > 0;
        if (reduced) {
          sheet.rotation.y = 0;
          sheet.position.y = layer.height;
          continue;
        }
        sheet.rotation.y = seconds * layer.spinHz * TWO_PI;
        sheet.position.y =
          layer.height + Math.sin(seconds * layer.bobHz * TWO_PI) * layer.bobCells;
      }

      const strike = lightning.advance(dt, present && !reduced);
      if (strike !== null) {
        const distance =
          spec.boltMinRadiusCells +
          strike.reach * (BOLT_MAX_RADIUS_CELLS - spec.boltMinRadiusCells);
        const x = Math.cos(strike.bearing) * distance;
        const z = Math.sin(strike.bearing) * distance;
        boltPivot.position.set(x, 0, z);
        boltPivot.rotation.y = strike.yaw;
        flashOffsetX = x;
        flashOffsetZ = z;
      }

      const brightness = reduced ? 0 : lightning.brightness() * envelope;
      const lit = brightness > 0;
      bolt.visible = lit;
      glowSheet.visible = lit;
      if (lit) {
        boltMaterial.opacity = brightness;
        glowMaterial.opacity = brightness * FLASH_GLOW_OPACITY;
      }
      if (flashLight !== null) {
        flashLight.position.set(
          root.position.x + flashOffsetX,
          root.position.y + spec.flashLightHeightCells,
          root.position.z + flashOffsetZ,
        );
        flashLight.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
      }
    },

    isFaded(): boolean {
      return envelope <= 0;
    },

    dispose(): void {
      reducedMotion.stop();
      flashLight = null;
      root.clear();
      for (const material of mistMaterials) material.dispose();
      glowMaterial.dispose();
      boltMaterial.dispose();
    },
  };
}
