// Scratch check (uncommitted): bake the angelfish from its .glb and report what
// the draw budget is counted against — surfaces, joints, triangles — plus the
// envelope the installer measured. Node feeds the SAME install path the
// browser's preload does, via parseRigAsset off disk. Also proves the bars:
// the front bar's widest vertex IS the flank anchor, and the pectoral hinges
// rest at identity. With --old it also bakes the procedural angelfish
// (client/species/.old-angelfish.ts, a `git show HEAD:` copy) for the
// draw-budget table.
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
import { ANGELFISH_ASSET, ANGELFISH_ENVELOPE, buildAngelfish } from './client/species/angelfish.ts';
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

const url = new URL('./client/assets/angelfish.glb', import.meta.url);
const buffer = await readFile(url);
const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const asset = await parseRigAsset(bytes, 'angelfish.glb');
installSpeciesAsset(ANGELFISH_ASSET, asset);
console.log('installSpeciesAsset: accepted angelfish.glb');

const authored = buildAngelfish(null as never);
const blueprint = bakeRig(authored.root);
report('GLB angelfish', blueprint);
console.log('  joints resolved:', Object.keys(authored.joints).join(', '));
for (const name of ['tail', 'pectoral_port', 'pectoral_starboard']) {
  const node = asset.node(name);
  const p = node.position;
  const r = node.rotation;
  console.log(
    `    ${name.padEnd(19)} parent=${node.parent?.name ?? '(none)'} at (${p.x.toFixed(4)}, ` +
      `${p.y.toFixed(4)}, ${p.z.toFixed(4)}) rotation (${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)})`,
  );
}

const bounds = new Box3().setFromObject(asset.scene);
const size = bounds.getSize(new Vector3());
console.log(
  `  bounds x[${bounds.min.x.toFixed(4)}, ${bounds.max.x.toFixed(4)}] ` +
    `y[${bounds.min.y.toFixed(4)}, ${bounds.max.y.toFixed(4)}] ` +
    `z[${bounds.min.z.toFixed(4)}, ${bounds.max.z.toFixed(4)}] size ${size.x.toFixed(3)}`,
);
console.log('  declared ANGELFISH_ENVELOPE (asserted at install):', JSON.stringify(ANGELFISH_ENVELOPE));
for (const name of ['nose', 'tail_tip', 'crown', 'belly', 'flank']) {
  const a = asset.anchor(name);
  console.log(`    ${name.padEnd(9)} (${a.x.toFixed(4)}, ${a.y.toFixed(4)}, ${a.z.toFixed(4)})`);
}

// The bars in the FILE: the widest hull-side vertex (body + bars, not fins)
// is on the front bar, at the flank anchor; the rear bar stays under it.
function widestZ(name: string): { z: number; x: number } {
  const mesh = asset.node(name) as Mesh;
  const pos = mesh.geometry.getAttribute('position');
  let best = { z: 0, x: 0 };
  for (let i = 0; i < pos.count; i++) {
    const p = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (Math.abs(p.z) > best.z) best = { z: Math.abs(p.z), x: p.x };
  }
  return best;
}
for (const name of ['body', 'bar_front_starboard', 'bar_front_port', 'bar_rear_starboard', 'bar_rear_port']) {
  const w = widestZ(name);
  console.log(`  ${name.padEnd(20)} widest |z| ${w.z.toFixed(4)} at x ${w.x.toFixed(4)}`);
}
const flank = asset.anchor('flank');
const frontBar = widestZ('bar_front_starboard');
if (Math.abs(frontBar.z - Math.abs(flank.z)) > 1e-6) throw new Error('front bar face is not the flank anchor');
console.log(`  front bar face == flank anchor (${flank.z.toFixed(6)}) within 1e-6`);

blueprint.dispose();
asset.dispose();
console.log('disposed blueprint then asset');

if (process.argv.includes('--old')) {
  const { buildAngelfish: buildOld } = await import('./client/species/.old-angelfish.ts');
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
  const old = buildOld(pool);
  const oldBlueprint = bakeRig(old.root);
  report('procedural angelfish (HEAD)', oldBlueprint);
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
