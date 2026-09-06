// Scratch check (uncommitted): bake the ray from its .glb and report what the
// draw budget is counted against — surfaces, joints, triangles — plus the
// envelope the installer measured. Node feeds the SAME install path the
// browser's preload does, via parseRigAsset off disk. With --old it also bakes
// the procedural ray (client/species/.old-ray.ts, a `git show HEAD:` copy)
// through a minimal SpeciesModelPool for the report's draw-budget table.
import { readFile } from 'node:fs/promises';
import {
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { parseRigAsset } from '../../client/src/render/rigAsset.ts';
import { bakeRig, type RigBlueprint } from '../../client/src/render/rigSkin.ts';
import { installSpeciesAsset } from './client/species/assetSpecies.ts';
import { RAY_ASSET, RAY_ENVELOPE, RAY_REST_ENVELOPE, buildRay } from './client/species/ray.ts';
import type { SpeciesModelPool } from './client/species/speciesModel.ts';

function report(label: string, blueprint: RigBlueprint): void {
  let triangles = 0;
  for (const surface of blueprint.surfaces) {
    const index = surface.geometry.getIndex();
    triangles += (index ? index.count : surface.geometry.getAttribute('position').count) / 3;
  }
  console.log(`${label}:`);
  console.log(`  surfaces: ${blueprint.surfaceCount}`);
  console.log(`  joints:   ${blueprint.jointCount}`);
  console.log(`  triangles:${triangles}`);
  console.log('  materials:', blueprint.surfaces.map((s) => s.material.type).join(', '));
}

const url = new URL('./client/assets/ray.glb', import.meta.url);
const buffer = await readFile(url);
const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const asset = await parseRigAsset(bytes, 'ray.glb');
installSpeciesAsset(RAY_ASSET, asset);
console.log('installSpeciesAsset: accepted ray.glb');

const authored = buildRay(null as never);
const blueprint = bakeRig(authored.root);
report('GLB ray', blueprint);
console.log('  joints resolved:', Object.keys(authored.joints).join(', '));

const bounds = new Box3().setFromObject(asset.scene);
const size = bounds.getSize(new Vector3());
console.log(
  `  bounds x[${bounds.min.x.toFixed(4)}, ${bounds.max.x.toFixed(4)}] ` +
    `y[${bounds.min.y.toFixed(4)}, ${bounds.max.y.toFixed(4)}] ` +
    `z[${bounds.min.z.toFixed(4)}, ${bounds.max.z.toFixed(4)}] size ${size.x.toFixed(3)}`,
);
console.log('  declared RAY_REST_ENVELOPE (asserted at install):', JSON.stringify(RAY_REST_ENVELOPE));
  console.log('  declared RAY_ENVELOPE (swept, placement):', JSON.stringify(RAY_ENVELOPE));
for (const name of ['nose', 'tail_tip', 'crown', 'belly', 'flank']) {
  const a = asset.anchor(name);
  console.log(`    ${name.padEnd(9)} (${a.x.toFixed(4)}, ${a.y.toFixed(4)}, ${a.z.toFixed(4)})`);
}

blueprint.dispose();
asset.dispose();
console.log('disposed blueprint then asset');

if (process.argv.includes('--old')) {
  const { buildRay: buildOldRay } = await import('./client/species/.old-ray.ts');
  const kept: BufferGeometry[] = [];
  const pool: SpeciesModelPool = {
    keepGeometry(geometry) {
      kept.push(geometry);
      return geometry;
    },
    lambert: (color, options = {}) =>
      new MeshLambertMaterial({ color, flatShading: options.flatShading ?? true }),
    unlit: (color) => new MeshBasicMaterial({ color }),
    part(geometry: BufferGeometry, material: Material, x, y, z) {
      const mesh = new Mesh(geometry, material);
      mesh.position.set(x, y, z);
      return mesh;
    },
    rigged() {
      const root = new Group();
      const rig = new Group();
      root.add(rig);
      return { root, rig };
    },
  };
  const old = buildOldRay(pool);
  const oldBlueprint = bakeRig(old.root);
  report('procedural ray (HEAD)', oldBlueprint);
  old.root.updateMatrixWorld(true);
  const oldBounds = new Box3().setFromObject(old.root);
  console.log(
    `  bounds x[${oldBounds.min.x.toFixed(4)}, ${oldBounds.max.x.toFixed(4)}] ` +
      `y[${oldBounds.min.y.toFixed(4)}, ${oldBounds.max.y.toFixed(4)}] ` +
      `z[${oldBounds.min.z.toFixed(4)}, ${oldBounds.max.z.toFixed(4)}]`,
  );
  oldBlueprint.dispose();
  for (const geometry of kept) geometry.dispose();
}
