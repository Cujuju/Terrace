import { describe, expect, it } from 'vitest';
import { Sprite } from 'three';
import { PointsNodeMaterial } from 'three/webgpu';
import { createPrecipitationField } from '../src/plugins/kit/precipitationField.ts';
import { SNOW_PROFILE } from '../../plugins/snow/client/rig.ts';

describe('size-aware snowfall', () => {
  it('uses one instanced sprite draw with per-particle attributes and the authored size', () => {
    const maxMasses = 2;
    const field = createPrecipitationField(SNOW_PROFILE, {
      name: 'snow', maxMasses, renderOrder: 1, canopyFraction: 1, applyRevealClip: () => {},
    });
    expect(field.object).toBeInstanceOf(Sprite);
    const sprite = field.object as Sprite;
    expect(sprite.count).toBe(maxMasses * SNOW_PROFILE.count);
    expect(sprite.geometry.getAttribute('aSlot').count).toBe(sprite.count);
    expect(sprite.geometry.getAttribute('aSlot')).toHaveProperty('isInstancedBufferAttribute', true);
    expect(sprite.geometry.getAttribute('position').count).toBe(4);
    expect(sprite.material).toBeInstanceOf(PointsNodeMaterial);
    expect(sprite.material).toHaveProperty('size', SNOW_PROFILE.spriteSize);
    expect(sprite.material.sizeAttenuation).toBe(true);
    const material = sprite.material;
    const geometry = sprite.geometry;
    const slot = field.claimSlot();
    field.updateWorld(slot, 0, 0, 1, 1, 0, 0, 0);
    expect(sprite.visible).toBe(true);
    field.park(slot);
    expect(sprite.visible).toBe(false);
    expect(sprite.material).toBe(material);
    expect(sprite.geometry).toBe(geometry);
    field.dispose();
  });
});
