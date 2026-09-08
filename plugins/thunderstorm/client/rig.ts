import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  type Material,
} from 'three';
import {
  buildHazeGeometry,
  HAZE_LAYERS,
  PRECIPITATION_HAZE_SCALE,
} from '../../../client/src/plugins/kit/hazeBank.ts';
import {
  createDiscRig,
  createRigPool,
  DISC_RENDER_ORDER,
  type DiscRig,
} from '../../../client/src/plugins/kit/discRig.ts';
import {
  createCumulusDeck,
  CUMULUS_DECK_DRAW_OBJECTS,
  puffsForCoverage,
  type CumulusDeck,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import type { InterpolatedDisc } from '../../../client/src/plugins/kit/discInterpolator.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { MAX_ACTIVE_SYSTEMS, THUNDERSTORM_PLUGIN_NAME } from '../protocol.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  BOLT_JAG_WORLD_UNITS,
  BOLT_TIP_WIDTH_FRACTION,
  BOLT_TOP_WORLD_Y,
  BOLT_WIDTH_WORLD_UNITS,
  FLASH_COLOR,
  FLASH_GLOW_OPACITY,
  FLASH_LIGHT_PEAK_INTENSITY,
  FLASH_LIGHT_RANGE_CELLS,
  LightningSchedule,
  type LightningGovernor,
} from './lightning.ts';

export const THUNDERSTORM_DROP_COUNT = 1350;

export const THUNDERSTORM_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: THUNDERSTORM_DROP_COUNT,
  fallSpeed: 30,
  streakLength: 1.1,
  spriteSize: 0,
  opacity: 0.55,
  color: 0x8fa8bd,
  swayCells: 0,
  swayHz: 0,
  innerRadiusFraction: 0,
};

export const THUNDERSTORM_PUFF_SIZE_FRACTION = 0.12;

export const THUNDERSTORM_PUFFS_PER_MASS = puffsForCoverage(THUNDERSTORM_PUFF_SIZE_FRACTION);

export const THUNDERSTORM_DECK_COLOR = 0x51565f;

export const THUNDERSTORM_SHADE_DARKNESS = 0.45;

export const STORM_FLASH_LIGHT_BANK_SIZE = MAX_ACTIVE_SYSTEMS;

const BOLT_SEGMENTS = 9;
const BOLT_JAG_TURN_RADIANS = 2.4;

function buildBoltGeometry(): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const span = BOLT_TOP_WORLD_Y - BOLT_BOTTOM_WORLD_Y;

  function ribbon(sideways: 'x' | 'z'): void {
    const first = positions.length / 3;
    for (let step = 0; step <= BOLT_SEGMENTS; step++) {
      const along = step / BOLT_SEGMENTS;
      const y = BOLT_TOP_WORLD_Y - along * span;
      const jag = BOLT_JAG_WORLD_UNITS * Math.sin(step * BOLT_JAG_TURN_RADIANS);
      const halfWidth =
        (BOLT_WIDTH_WORLD_UNITS * (1 - (1 - BOLT_TIP_WIDTH_FRACTION) * along)) / 2;
      for (const edge of [-1, 1]) {
        const offset = jag + edge * halfWidth;
        positions.push(sideways === 'x' ? offset : 0, y, sideways === 'z' ? offset : 0);
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

export interface ThunderstormRig {
  readonly root: Group;
  update(disc: InterpolatedDisc, elapsed: number, dt: number, reduced: boolean): void;
  strike(offsetX: number, offsetZ: number, governor: LightningGovernor): void;
  reset(): void;
  dispose(): void;
}

function createThunderstormRig(
  hazeGeometry: BufferGeometry,
  boltGeometry: BufferGeometry,
  lentLight: PointLight | null,
  deck: CumulusDeck,
  applyRevealClip: (material: Material, label: string) => void,
): ThunderstormRig {
  const body: DiscRig = createDiscRig({
    hazeGeometry,
    hazeStrength: PRECIPITATION_HAZE_SCALE,
    profile: THUNDERSTORM_PROFILE,
    name: `${THUNDERSTORM_PLUGIN_NAME}:system`,
    deck,
    applyRevealClip,
  });
  const root = body.root;

  const lightning = new LightningSchedule();

  const glowMaterial = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    vertexColors: true,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const glowSheet = new Mesh(hazeGeometry, glowMaterial);
  glowSheet.renderOrder = DISC_RENDER_ORDER;
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
  applyRevealClip(glowMaterial, `${THUNDERSTORM_PLUGIN_NAME} glow`);
  applyRevealClip(boltMaterial, `${THUNDERSTORM_PLUGIN_NAME} bolt`);

  const boltPivot = new Group();
  const bolt = new Mesh(boltGeometry, boltMaterial);
  bolt.visible = false;
  bolt.renderOrder = DISC_RENDER_ORDER;
  boltPivot.add(bolt);
  root.add(boltPivot);

  const flashLight = lentLight;
  let strikeOffsetX = 0;
  let strikeOffsetZ = 0;

  return {
    root,

    update(disc, elapsed, dt, reduced): void {
      const lit = body.update(disc, elapsed);
      if (!lit) return;

      const worldRadius = disc.radius * CELL_WORLD_SIZE;

      lightning.advance(dt);

      const brightness = reduced ? 0 : lightning.brightness() * disc.intensity;
      const flashing = brightness > 0;
      bolt.visible = flashing;
      glowSheet.visible = flashing;
      if (flashing) {
        boltMaterial.opacity = brightness;
        glowMaterial.opacity = brightness * FLASH_GLOW_OPACITY;
        glowSheet.scale.setScalar(worldRadius * HAZE_LAYERS[0]!.radiusScale);
        glowSheet.position.y = HAZE_LAYERS[0]!.height;
      }
      if (flashLight !== null) {
        flashLight.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
        flashLight.position.set(
          root.position.x + strikeOffsetX,
          BOLT_BOTTOM_WORLD_Y,
          root.position.z + strikeOffsetZ,
        );
      }
    },

    strike(offsetX: number, offsetZ: number, governor: LightningGovernor): void {
      if (!lightning.strike(governor)) return;

      boltPivot.position.set(offsetX, 0, offsetZ);
      boltPivot.rotation.y = Math.atan2(offsetZ, offsetX);
      strikeOffsetX = offsetX;
      strikeOffsetZ = offsetZ;
    },

    reset(): void {
      lightning.reset();
      body.park();
      if (flashLight !== null) flashLight.intensity = 0;
    },

    dispose(): void {
      body.dispose();
      glowMaterial.dispose();
      boltMaterial.dispose();
    },
  };
}

export interface DryBoltRig {
  readonly root: Group;
  strike(worldX: number, worldZ: number, governor: LightningGovernor): void;
  update(dt: number, reduced: boolean): void;
  dispose(): void;
}

export function createDryBoltRig(
  boltGeometry: BufferGeometry,
  applyRevealClip: (material: Material, label: string) => void,
): DryBoltRig {
  const root = new Group();
  root.name = `${THUNDERSTORM_PLUGIN_NAME}:dry-bolt`;

  const material = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  applyRevealClip(material, `${THUNDERSTORM_PLUGIN_NAME} dry bolt`);

  const bolt = new Mesh(boltGeometry, material);
  bolt.visible = false;
  bolt.renderOrder = DISC_RENDER_ORDER;

  const pivot = new Group();
  pivot.add(bolt);
  root.add(pivot);

  const light = new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS);
  light.position.y = BOLT_BOTTOM_WORLD_Y;
  root.add(light);

  const schedule = new LightningSchedule();

  return {
    root,

    strike(worldX: number, worldZ: number, governor: LightningGovernor): void {
      if (!schedule.strike(governor)) return;
      pivot.position.set(worldX, 0, worldZ);
      pivot.rotation.y = Math.atan2(worldZ, worldX);
      light.position.set(worldX, BOLT_BOTTOM_WORLD_Y, worldZ);
    },

    update(dt: number, reduced: boolean): void {
      schedule.advance(dt);
      const brightness = reduced ? 0 : schedule.brightness();
      const flashing = brightness > 0;
      bolt.visible = flashing;
      if (flashing) material.opacity = brightness;
      light.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
    },

    dispose(): void {
      root.clear();
      material.dispose();
    },
  };
}

export interface ThunderstormRigs {
  readonly lightBank: Group;
  readonly deck: CumulusDeck;
  readonly dryBolt: DryBoltRig;
  acquire(): ThunderstormRig;
  release(rig: ThunderstormRig): void;
  dispose(): void;
}

export function createThunderstormRigs(ctx: ClientPluginCtx): ThunderstormRigs {
  const hazeGeometry = buildHazeGeometry();
  const boltGeometry = buildBoltGeometry();
  const clip = (material: Material, label: string): void => {
    ctx.applyRevealClip(material, label);
  };
  const dryBolt = createDryBoltRig(boltGeometry, clip);

  const deck = createCumulusDeck({
    maxMasses: MAX_ACTIVE_SYSTEMS,
    puffSizeFraction: THUNDERSTORM_PUFF_SIZE_FRACTION,
    color: THUNDERSTORM_DECK_COLOR,
    name: `${THUNDERSTORM_PLUGIN_NAME}:deck`,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });

  const lightBank = new Group();
  lightBank.name = `${THUNDERSTORM_PLUGIN_NAME}:flash-lights`;
  const unlent: PointLight[] = [];
  for (let index = 0; index < STORM_FLASH_LIGHT_BANK_SIZE; index++) {
    const light = new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS);
    light.position.y = BOLT_BOTTOM_WORLD_Y;
    lightBank.add(light);
    unlent.push(light);
  }

  const pool = createRigPool<ThunderstormRig>(
    () =>
      createThunderstormRig(hazeGeometry, boltGeometry, unlent.pop() ?? null, deck, clip),
    (rig) => rig.reset(),
  );

  return {
    lightBank,
    deck,
    dryBolt,
    acquire: pool.acquire,
    release: pool.release,
    dispose(): void {
      pool.dispose();
      lightBank.clear();
      dryBolt.dispose();
      deck.dispose();
      hazeGeometry.dispose();
      boltGeometry.dispose();
    },
  };
}

export const THUNDERSTORM_RIG_DRAW_OBJECTS = 7;

export const DRY_BOLT_DRAW_OBJECTS = 1;

export const LIGHT_BANK_DRAW_OBJECTS = 0;

export const THUNDERSTORM_DECK_DRAW_OBJECTS = CUMULUS_DECK_DRAW_OBJECTS;
