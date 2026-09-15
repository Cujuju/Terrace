import { AdditiveBlending, BufferGeometry, DoubleSide, Group, Mesh, type Object3D } from 'three';
import { MeshBasicNodeMaterial, type NodeMaterial } from 'three/webgpu';
import {
  buildHazeGeometry,
  HAZE_LAYERS,
  PRECIPITATION_HAZE_SCALE,
} from '../../../client/src/plugins/kit/hazeBank.ts';
import {
  createRigPool,
  DISC_RENDER_ORDER,
  type DiscRig,
} from '../../../client/src/plugins/kit/discRig.ts';
import {
  createDiscKindRigs,
  type DiscKindRigs,
} from '../../../client/src/plugins/kit/discKindRigs.ts';
import type { CumulusDeck } from '../../../client/src/plugins/kit/cumulusDeck.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import type { InterpolatedDisc } from '../../../client/src/plugins/kit/discInterpolator.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { MAX_ACTIVE_SYSTEMS, THUNDERSTORM_PLUGIN_NAME } from '../protocol.ts';
import { buildBoltGeometry, createDryBoltRig, type DryBoltRig } from './bolt.ts';
import { createFlashLight, type FlashLight } from './flashLight.ts';
import { THUNDERSTORM_DECK, THUNDERSTORM_PROFILE } from './look.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  FLASH_COLOR,
  FLASH_GLOW_OPACITY,
  LightningSchedule,
  type LightningGovernor,
} from './lightning.ts';

// The governor admits one flash at a time, so the reachable peak is one
// storm's glow sheet and bolt; the dry bolt's single draw is never concurrent.
export const FLASH_DRAW_OBJECTS = 2;

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
  flash: FlashLight,
  body: DiscRig,
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): ThunderstormRig {
  const root = body.root;

  const lightning = new LightningSchedule();

  const glowMaterial = new MeshBasicNodeMaterial({
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

  const boltMaterial = new MeshBasicNodeMaterial({
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

  let wasFlashing = false;
  let strikeOffsetX = 0;
  let strikeOffsetZ = 0;

  function park(): void {
    if (!wasFlashing) return;
    wasFlashing = false;
    flash.park();
  }

  return {
    root,

    update(disc, elapsed, dt, reduced): void {
      const lit = body.update(disc, elapsed);
      lightning.advance(dt);

      const brightness = lit && !reduced ? lightning.brightness() * disc.intensity : 0;
      const flashing = brightness > 0;
      bolt.visible = flashing;
      glowSheet.visible = flashing;
      if (!flashing) {
        park();
        return;
      }

      boltMaterial.opacity = brightness;
      glowMaterial.opacity = brightness * FLASH_GLOW_OPACITY;
      glowSheet.scale.setScalar(disc.radius * CELL_WORLD_SIZE * HAZE_LAYERS[0]!.radiusScale);
      glowSheet.position.y = HAZE_LAYERS[0]!.height;

      wasFlashing = true;
      flash.flash(
        root.position.x + strikeOffsetX,
        BOLT_BOTTOM_WORLD_Y,
        root.position.z + strikeOffsetZ,
        brightness,
      );
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
      bolt.visible = false;
      glowSheet.visible = false;
      park();
    },

    dispose(): void {
      body.dispose();
      glowMaterial.dispose();
      boltMaterial.dispose();
    },
  };
}

export interface ThunderstormRigs {
  readonly flashLight: FlashLight;
  readonly deck: CumulusDeck | null;
  readonly dryBolt: DryBoltRig;
  kindObjects(): readonly Object3D[];
  acquire(): ThunderstormRig;
  release(rig: ThunderstormRig): void;
  dispose(): void;
}

export function createThunderstormRigs(ctx: ClientPluginCtx): ThunderstormRigs {
  const hazeGeometry = buildHazeGeometry();
  const boltGeometry = buildBoltGeometry();
  const clip = (material: NodeMaterial, label: string): void => {
    ctx.applyRevealClip(material, label);
  };
  const flashLight = createFlashLight();
  const dryBolt = createDryBoltRig(boltGeometry, clip, flashLight);

  const kind: DiscKindRigs = createDiscKindRigs({
    name: THUNDERSTORM_PLUGIN_NAME,
    maxMasses: MAX_ACTIVE_SYSTEMS,
    hazeStrength: PRECIPITATION_HAZE_SCALE,
    deck: THUNDERSTORM_DECK,
    profile: THUNDERSTORM_PROFILE,
    applyRevealClip: clip,
  });

  // Every rig is built here: a storm arriving mid-play must never trigger a
  // material and node-graph build, unlike every other weather kind.
  const pool = createRigPool<ThunderstormRig>(
    () => createThunderstormRig(hazeGeometry, boltGeometry, flashLight, kind.acquire(), clip),
    (rig) => rig.reset(),
    MAX_ACTIVE_SYSTEMS,
  );

  return {
    flashLight,
    deck: kind.deck,
    dryBolt,
    kindObjects: () => kind.kindObjects(),
    acquire: pool.acquire,
    release: pool.release,
    dispose(): void {
      pool.dispose();
      dryBolt.dispose();
      flashLight.dispose();
      kind.dispose();
      hazeGeometry.dispose();
      boltGeometry.dispose();
    },
  };
}
