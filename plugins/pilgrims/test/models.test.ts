import { describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import {
  ARM_SWING_RADIANS,
  LEG_SWING_RADIANS,
  STRIDE_HZ,
  createPilgrimModels,
} from '../client/models.ts';
import { SETTLER_RACES, WALKER_KINDS, type SettlerRace, type WalkerKind } from '../protocol.ts';

const TWO_PI = Math.PI * 2;

function drawnObjects(root: Object3D): Object3D[] {
  const drawn: Object3D[] = [];
  root.traverse((node) => {
    if ((node as { isMesh?: boolean }).isMesh === true) drawn.push(node);
  });
  return drawn;
}

const RACES = SETTLER_RACES;
const KINDS = WALKER_KINDS;

const RACE_KINDS = RACES.flatMap((race: SettlerRace) =>
  KINDS.map((kind: WalkerKind) => ({ race, kind })),
);

describe('pilgrim models (rigSkin)', () => {
  it('draws each walker as exactly 2 skinned surfaces, every race × kind', () => {
    const models = createPilgrimModels();
    try {
      for (const { race, kind } of RACE_KINDS) {
        const walker = models.create(race, kind);
        const drawn = drawnObjects(walker.root);
        expect(drawn.length).toBe(2);
      }
    } finally {
      models.dispose();
    }
  });

  it('keeps the gait: legs counter-swing, arms counter-swing their own leg', () => {
    const models = createPilgrimModels();
    try {
      for (const race of RACES) {
        const walker = models.create(race, 'wanderer');
        const seconds = 0.21;
        walker.animate(seconds, 0);
        const stride = Math.sin(seconds * TWO_PI * STRIDE_HZ);
        expect(Math.abs(stride)).toBeGreaterThan(0.1);

        const { leftLeg, rightLeg, leftArm, rightArm } = walker.joints;
        expect(leftLeg.rotation.z).toBeCloseTo(stride * LEG_SWING_RADIANS, 10);
        expect(rightLeg.rotation.z).toBeCloseTo(-stride * LEG_SWING_RADIANS, 10);
        expect(Math.sign(leftArm.rotation.z)).toBe(-Math.sign(leftLeg.rotation.z));
        expect(Math.sign(rightArm.rotation.z)).toBe(-Math.sign(rightLeg.rotation.z));
      }
    } finally {
      models.dispose();
    }
  });
});
