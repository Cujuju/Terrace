import { describe, expect, it } from 'vitest';
import { InstancedMesh } from 'three';
import { readFile } from 'node:fs/promises';
import {
  BOAT_SHAPE,
  HULL_MESH_NAME,
  SAIL_MESH_NAME,
  createBoatModels,
  installBoatKit,
  type BoatModels,
} from '../client/models.ts';
import { parseRigAsset } from '../../../client/src/render/rigAsset.ts';

function stubImageLoading(): void {
  const scope = globalThis as unknown as { document?: unknown; self?: unknown };
  if (scope.self === undefined) scope.self = globalThis;
  if (scope.document !== undefined) return;
  scope.document = {
    createElementNS: (): unknown => {
      const listeners = new Map<string, Array<() => void>>();
      const image = {
        width: 256,
        height: 256,
        addEventListener(type: string, listener: (this: unknown) => void): void {
          listeners.set(type, [...(listeners.get(type) ?? []), () => listener.call(image)]);
        },
        removeEventListener(type: string, listener: (this: unknown) => void): void {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((kept) => kept !== listener),
          );
        },
        set src(_url: string) {
          queueMicrotask(() => {
            for (const listener of listeners.get('load') ?? []) listener();
          });
        },
      };
      return image;
    },
  };
}

stubImageLoading();
const assetUrl = new URL('../client/assets/war-boat.glb', import.meta.url);
const assetBuffer = await readFile(assetUrl);
const assetBytes = assetBuffer.buffer.slice(
  assetBuffer.byteOffset,
  assetBuffer.byteOffset + assetBuffer.byteLength,
);
installBoatKit(await parseRigAsset(assetBytes, 'war-boat.glb'));

function meshNamed(models: BoatModels, name: string): InstancedMesh {
  const found = models.objects.find((object) => object.name === name);
  if (!(found instanceof InstancedMesh)) throw new Error(`no InstancedMesh named ${name}`);
  return found;
}

describe('the boat as a rigged drawable', () => {
  it('draws ONE object per hull, and the whole fleet\'s sails in ONE more', () => {
    const models = createBoatModels();
    models.beginFrame();
    const boat = models.create();
    boat.draw(0, 0, 0, 0, 0, 0, 0, false);

    expect(models.objects).toHaveLength(2);
    expect(BOAT_SHAPE.drawObjects).toBe(1);

    const second = models.create();
    second.draw(5, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();
    expect(models.objects).toHaveLength(2);
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(2);
    expect(meshNamed(models, SAIL_MESH_NAME).count).toBe(2);

    second.dispose();
    boat.dispose();
    models.dispose();
  });

  it('keeps the rig at ONE surface, shared by every boat', () => {
    const models = createBoatModels();
    models.beginFrame();
    const a = models.create();
    const b = models.create();
    a.draw(0, 0, 0, 0, 0, 0, 0, false);
    b.draw(5, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const hulls = models.objects.filter((object) => object.name === HULL_MESH_NAME);
    expect(hulls).toHaveLength(1);
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(2);

    a.dispose();
    b.dispose();
    models.dispose();
  });

  it('counter-swings the oars through their baked bones', () => {
    const models = createBoatModels();
    const boat = models.create();

    let swings: number[] = [];
    for (let step = 0; step < 12 && swings.every((s) => s === 0); step++) {
      models.beginFrame();
      boat.draw(0, 0, 0, 0, 0, 0, 0.25, false);
      models.commitFrame();
      swings = models.joints.map((bone) => bone.rotation.y).filter((yaw) => yaw !== 0);
    }
    expect(swings).toHaveLength(4);
    expect(new Set(swings.map((yaw) => Math.sign(yaw)))).toEqual(new Set([-1, 1]));

    boat.dispose();
    models.dispose();
  });
});
