// The walker model set, built headlessly — no WebGLRenderer, no DOM. This
// pins the rigSkin port's whole point: one walker costs TWO draw calls (one
// Lambert surface carrying body + limbs + tail + staff, one Phong surface for
// the glossy eyes/nose), down from the eight meshes-per-part the pre-skinning
// rig paid. It also pins the gait: legs counter-swing, each arm counter-swings
// its own side's leg — the animate() contract the port promised not to change.
//
// pilgrims/client/models.ts draws nothing at module init (unlike structures'),
// so no canvas stub is needed here.

import { describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import {
  ARM_SWING_RADIANS,
  LEG_SWING_RADIANS,
  STRIDE_HZ,
  createPilgrimModels,
} from '../client/models.ts';
import { SETTLER_RACES, WALKER_KINDS, type SettlerRace, type WalkerKind } from '../protocol.ts';

/** Twoπ — one full stride cycle in radians. */
const TWO_PI = Math.PI * 2;

/** Every Mesh under `root` — the things a renderer would charge a draw for. */
function drawnObjects(root: Object3D): Object3D[] {
  const drawn: Object3D[] = [];
  root.traverse((node) => {
    if ((node as { isMesh?: boolean }).isMesh === true) drawn.push(node);
  });
  return drawn;
}

const RACES = SETTLER_RACES;
const KINDS = WALKER_KINDS;

/** The four (race, kind) pairs a model set must cover. */
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
        // One merged Lambert surface + one Phong gloss surface. The four matte
        // materials (body, both furs, staff) share a materialSignature —
        // colour being vertex data — and that collapse IS the win.
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
        // An arbitrary non-trivial sample of the stride cycle.
        const seconds = 0.21;
        walker.animate(seconds, 0);
        const stride = Math.sin(seconds * TWO_PI * STRIDE_HZ);
        // Sanity: the sample must actually be mid-stride for this to mean anything.
        expect(Math.abs(stride)).toBeGreaterThan(0.1);

        const { leftLeg, rightLeg, leftArm, rightArm } = walker.joints;
        // Counter-swinging legs, each at the full swing amplitude.
        expect(leftLeg.rotation.z).toBeCloseTo(stride * LEG_SWING_RADIANS, 10);
        expect(rightLeg.rotation.z).toBeCloseTo(-stride * LEG_SWING_RADIANS, 10);
        // Each arm counter-swings its OWN side's leg — opposite sign to that leg.
        expect(Math.sign(leftArm.rotation.z)).toBe(-Math.sign(leftLeg.rotation.z));
        expect(Math.sign(rightArm.rotation.z)).toBe(-Math.sign(rightLeg.rotation.z));
      }
    } finally {
      models.dispose();
    }
  });
});
