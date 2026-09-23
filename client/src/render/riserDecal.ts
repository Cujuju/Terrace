import { Color, Vector2 } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { cross, dFdx, dFdy, dot, mix, positionWorld, step, uniform, vec4 } from 'three/tsl';
import { compose } from './materialSlots.ts';

/** Drawn walls are vertical and treads flat; the midpoint splits them with the most slack. */
const RISER_MAX_NORMAL_Y = 0.5;

const decalOn = uniform(0);
const decalAim = uniform(new Vector2());
const decalReach = uniform(0);
const decalFootY = uniform(0);
const decalCapY = uniform(0);
const decalColor = uniform(new Color());
const decalOpacity = uniform(0);

export interface RiserDecal {
  readonly aimX: number;
  readonly aimZ: number;
  readonly reach: number;
  readonly footY: number;
  readonly capY: number;
}

export function showRiserDecal(decal: RiserDecal): void {
  decalAim.value.set(decal.aimX, decal.aimZ);
  decalReach.value = decal.reach;
  decalFootY.value = decal.footY;
  decalCapY.value = decal.capY;
  decalOn.value = 1;
}

export function hideRiserDecal(): void {
  decalOn.value = 0;
}

export function setRiserDecalTint(color: number, opacity: number): void {
  decalColor.value.setHex(color);
  decalOpacity.value = opacity;
}

// Tints the drawn wall itself, so it never disagrees with the surface in depth. The frame stays
// linear until the output pass, so this mix equals an overlay's blend.
export function applyRiserDecal(material: NodeMaterial): void {
  compose(material, 'output', (previous) => {
    const faceNormal = cross(dFdx(positionWorld), dFdy(positionWorld));
    const wall = step(
      faceNormal.y.mul(faceNormal.y),
      dot(faceNormal, faceNormal).mul(RISER_MAX_NORMAL_Y * RISER_MAX_NORMAL_Y),
    );
    const slab = step(decalFootY, positionWorld.y).mul(step(positionWorld.y, decalCapY));
    const reach = step(positionWorld.xz.distance(decalAim), decalReach);
    const cover = decalOn.mul(wall).mul(slab).mul(reach).mul(decalOpacity);
    return vec4(mix(previous.rgb, decalColor, cover), previous.a);
  });
}
