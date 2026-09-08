import { describe, expect, it } from 'vitest';
import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import { readFile } from 'node:fs/promises';
import {
  BOAT_SHAPE,
  HULL_MESH_NAME,
  SAIL_MESH_NAME,
  createBoatModels,
  installBoatKit,
  type BoatModels,
} from '../client/models.ts';
import {
  ASSET_FIT_TOLERANCE_WORLD_UNITS,
  parseRigAsset,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';

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

const FIGHTER_X = 0;
const BYSTANDER_X = 10;
const SAIL_MATCH_WORLD_UNITS = 1;

function meshNamed(models: BoatModels, name: string): InstancedMesh {
  const found = models.objects.find((object) => object.name === name);
  if (!(found instanceof InstancedMesh)) throw new Error(`no InstancedMesh named ${name}`);
  return found;
}

function drawnBox(models: BoatModels): Box3 {
  const box = new Box3();
  for (const object of models.objects) box.union(new Box3().setFromObject(object));
  return box;
}

describe('the boat model', () => {
  it('fits inside one cell, so "five cells away" looks like five cells', () => {
    const models = createBoatModels();
    models.beginFrame();
    const boat = models.create();
    boat.draw(0, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const size = drawnBox(models).getSize(new Vector3());
    expect(size.x).toBeLessThanOrEqual(1);
    expect(size.z).toBeLessThanOrEqual(1);

    boat.dispose();
    models.dispose();
  });

  it('sits IN the water, not on it', () => {
    const models = createBoatModels();
    models.beginFrame();
    const boat = models.create();
    boat.draw(0, BOAT_SHAPE.waterlineLift, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const box = drawnBox(models);
    expect(BOAT_SHAPE.waterlineLift).toBeLessThan(0);
    expect(box.min.y).toBeLessThan(0);
    expect(box.max.y).toBeGreaterThan(0);

    boat.dispose();
    models.dispose();
  });

  it('reddens only its own sail when it engages', () => {
    const models = createBoatModels();
    const fighter = models.create();
    const bystander = models.create();

    models.beginFrame();
    fighter.draw(FIGHTER_X, 0, 0, 0, 0, 0, 0, false);
    bystander.draw(BYSTANDER_X, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const sails = meshNamed(models, SAIL_MESH_NAME);
    const matrix = new Matrix4();
    const tint = new Color();
    const sailNear = (x: number): Color => {
      for (let slot = 0; slot < sails.count; slot++) {
        sails.getMatrixAt(slot, matrix);
        if (Math.abs(matrix.elements[12]! - x) < SAIL_MATCH_WORLD_UNITS) {
          sails.getColorAt(slot, tint);
          return tint.clone();
        }
      }
      throw new Error(`no sail instance near x=${x}`);
    };

    const restingFighter = sailNear(FIGHTER_X);
    const restingBystander = sailNear(BYSTANDER_X);
    expect(restingFighter.getHex()).toBe(restingBystander.getHex());

    models.beginFrame();
    fighter.draw(FIGHTER_X, 0, 0, 0, 1, 0, 1, true);
    bystander.draw(BYSTANDER_X, 0, 0, 0, 1, 0, 1, false);
    models.commitFrame();
    expect(sailNear(FIGHTER_X).getHex()).not.toBe(restingFighter.getHex());
    expect(sailNear(BYSTANDER_X).getHex()).toBe(restingBystander.getHex());

    fighter.dispose();
    bystander.dispose();
    models.dispose();
  });

  it('stops drawing a sunk boat\'s sail', () => {
    const models = createBoatModels();
    const boat = models.create();
    models.beginFrame();
    boat.draw(FIGHTER_X, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    const sails = meshNamed(models, SAIL_MESH_NAME);
    const matrix = new Matrix4();
    const scaleOfSlotZero = (): number => {
      sails.getMatrixAt(0, matrix);
      return matrix.getMaxScaleOnAxis();
    };
    expect(scaleOfSlotZero()).toBeGreaterThan(0);

    boat.dispose();
    models.beginFrame();
    models.commitFrame();
    expect(scaleOfSlotZero()).toBe(0);
    expect(sails.count).toBe(0);
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(0);

    models.dispose();
  });

  it('shares hull geometry between boats', () => {
    const models = createBoatModels();
    const a = models.create();
    const b = models.create();
    models.beginFrame();
    a.draw(0, 0, 0, 0, 0, 0, 0, false);
    b.draw(BYSTANDER_X, 0, 0, 0, 0, 0, 0, false);
    models.commitFrame();

    expect(models.objects.filter((object) => object.name === HULL_MESH_NAME)).toHaveLength(1);
    expect(meshNamed(models, HULL_MESH_NAME).count).toBe(2);

    a.dispose();
    b.dispose();
    models.dispose();
  });

  it('rows without any oar leaving the water plane or entering the hull', () => {
    const models = createBoatModels();
    const boat = models.create();

    const rest = models.joints.map((bone) => ({
      position: bone.position.clone(),
      x: bone.rotation.x,
      z: bone.rotation.z,
    }));
    for (let step = 0; step < 12; step++) {
      models.beginFrame();
      boat.draw(0, 0, 0, 0, step * 0.25, 0, 0.25, false);
      models.commitFrame();
      models.joints.forEach((bone, index) => {
        expect(bone.position.equals(rest[index]!.position)).toBe(true);
        expect(bone.rotation.x).toBe(rest[index]!.x);
        expect(bone.rotation.z).toBe(rest[index]!.z);
      });
    }
    expect(models.joints.some((bone) => bone.rotation.y !== 0)).toBe(true);

    boat.dispose();
    models.dispose();
  });
});

const DECK_TOP_Y = 0.165;
const VALID_FIRE_TOP_Y = 0.779;

function fakeBoatAsset(options: { silhouetteCells: number; fireTopY: number }): RigAsset {
  const scene = new Group();
  const hull = new Mesh(
    new BoxGeometry(options.silhouetteCells, 0.3, options.silhouetteCells),
    new MeshStandardMaterial(),
  );
  hull.name = 'hull';
  scene.add(hull);
  const sail = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial());
  sail.name = 'sail';
  scene.add(sail);
  for (const name of ['oar_port_1', 'oar_port_2', 'oar_starboard_1', 'oar_starboard_2']) {
    const pivot = new Object3D();
    pivot.name = name;
    scene.add(pivot);
  }
  const anchors = new Map<string, Vector3>([
    ['waterline', new Vector3(0, -0.11, 0)],
    ['deck_top', new Vector3(0, DECK_TOP_Y, 0)],
    ['fire_top', new Vector3(0, options.fireTopY, 0)],
  ]);
  return {
    scene,
    node(name: string) {
      const found = scene.getObjectByName(name);
      if (found === undefined) throw new Error(`fake boat asset: node "${name}" not found`);
      return found;
    },
    anchor(name: string) {
      const found = anchors.get(name);
      if (found === undefined) throw new Error(`fake boat asset: anchor "${name}" not found`);
      return found.clone();
    },
    dispose(): void {},
  };
}

describe('installBoatKit', () => {
  it('refuses a silhouette wider than one cell plus the fit tolerance', () => {
    const overhang = 1 + ASSET_FIT_TOLERANCE_WORLD_UNITS * 2;
    expect(() =>
      installBoatKit(fakeBoatAsset({ silhouetteCells: overhang, fireTopY: VALID_FIRE_TOP_Y })),
    ).toThrow(/one-cell fit budget/);
  });

  it('refuses a fire_top that is not above deck_top', () => {
    expect(() =>
      installBoatKit(fakeBoatAsset({ silhouetteCells: 0.9, fireTopY: DECK_TOP_Y - 0.1 })),
    ).toThrow(/is not above deck_top/);
  });
});
