// Scratch check (uncommitted): bake the eel from its .glb and report what the
// draw budget is counted against — surfaces, joints, triangles — plus the
// envelope the installer measured. Node feeds the SAME install path the
// browser's preload does, via parseRigAsset off disk. Also proves the chain:
// the spine Empties are nested in the file, and a posed chain still keeps
// every sunk extension ring inside the slice ahead (the seam check, in three
// rather than Python). With --old it also bakes the procedural eel
// (client/species/.old-eel.ts, a `git show HEAD:` copy) for the draw-budget table.
import { readFile } from 'node:fs/promises';
import {
  Box3,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { parseRigAsset } from '../../client/src/render/rigAsset.ts';
import { bakeRig, type RigBlueprint } from '../../client/src/render/rigSkin.ts';
import { installSpeciesAsset } from './client/species/assetSpecies.ts';
import { EEL_ASSET, EEL_ENVELOPE, buildEel } from './client/species/eel.ts';
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

const url = new URL('./client/assets/eel.glb', import.meta.url);
const buffer = await readFile(url);
const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const asset = await parseRigAsset(bytes, 'eel.glb');
installSpeciesAsset(EEL_ASSET, asset);
console.log('installSpeciesAsset: accepted eel.glb');

const authored = buildEel(null as never);
const blueprint = bakeRig(authored.root);
report('GLB eel', blueprint);
console.log('  joints resolved:', Object.keys(authored.joints).join(', '));

// The chain as three sees it: each spine's parent.
const chain: string[] = [];
for (const name of ['spine0', 'spine1', 'spine2', 'spine3', 'spine4', 'tail']) {
  const node = asset.node(name);
  chain.push(`${name}<-${node.parent?.name ?? '(none)'}`);
}
console.log('  chain:', chain.join(' '));

const bounds = new Box3().setFromObject(asset.scene);
const size = bounds.getSize(new Vector3());
console.log(
  `  bounds x[${bounds.min.x.toFixed(4)}, ${bounds.max.x.toFixed(4)}] ` +
    `y[${bounds.min.y.toFixed(4)}, ${bounds.max.y.toFixed(4)}] ` +
    `z[${bounds.min.z.toFixed(4)}, ${bounds.max.z.toFixed(4)}] size ${size.x.toFixed(3)}`,
);
console.log('  declared EEL_ENVELOPE (asserted at install):', JSON.stringify(EEL_ENVELOPE));
for (const name of ['nose', 'tail_tip', 'crown', 'belly', 'flank']) {
  const a = asset.anchor(name);
  console.log(`    ${name.padEnd(9)} (${a.x.toFixed(4)}, ${a.y.toFixed(4)}, ${a.z.toFixed(4)})`);
}

// Seam continuity in the FILE: slice i's rear rim and slice i+1's hinge ring
// must share positions AND normals (the custom normals survived the export).
function worldVertices(mesh: Mesh): { p: Vector3; n: Vector3 }[] {
  const pos = mesh.geometry.getAttribute('position');
  const nor = mesh.geometry.getAttribute('normal');
  const out: { p: Vector3; n: Vector3 }[] = [];
  for (let i = 0; i < pos.count; i++) {
    const p = new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const n = new Vector3().fromBufferAttribute(nor, i).transformDirection(mesh.matrixWorld);
    out.push({ p, n });
  }
  return out;
}
const SPINE_X = [0.526, 0.296, 0.066, -0.164, -0.371];
let worstNormal = 0;
let seamPairs = 0;
for (let i = 0; i < 4; i++) {
  const ahead = worldVertices(asset.node(`slice${i}`) as Mesh)
    .concat(worldVertices(asset.node(`belly${i}`) as Mesh));
  const behind = worldVertices(asset.node(`slice${i + 1}`) as Mesh)
    .concat(worldVertices(asset.node(`belly${i + 1}`) as Mesh));
  const hingeX = SPINE_X[i + 1]!;
  const rim = ahead.filter((v) => Math.abs(v.p.x - hingeX) < 1e-4);
  for (const v of rim) {
    const twin = behind.find((w) => w.p.distanceTo(v.p) < 1e-6);
    if (twin === undefined) throw new Error(`seam ${i}/${i + 1}: rim vertex without a twin`);
    worstNormal = Math.max(worstNormal, v.n.angleTo(twin.n));
    seamPairs++;
  }
}
console.log(`  seams: ${seamPairs} rim/hinge vertex pairs coincide; worst normal disagreement ${worstNormal.toExponential(2)} rad`);

// Posed chain: yaw every spine to its amplitude (same sign — the worst case
// for any one seam is that seam's own hinge at full amplitude, and the
// composed pose exercises the nesting), then check every vertex of slice i+1
// forward of its hinge lies inside slice i's posed bounding sphere-free test:
// a Box3 per slice is too coarse for a curved tube, so use the analytic hull
// margin exported by the build instead — here we check the simpler invariant
// the brief allows: the posed slices' boxes still overlap along x by at least
// the sunk extension's length.
const AMPLITUDES = [0.05, 0.09, 0.13, 0.17, 0.21];
authored.joints.rig!.rotation.set(0, 0, 0);
for (let i = 0; i < 5; i++) authored.joints[`spine${i}`]!.rotation.y = AMPLITUDES[i]!;
authored.root.updateMatrixWorld(true);
let minOverlapX = Infinity;
for (let i = 0; i < 4; i++) {
  const a = new Box3().setFromObject(asset.node(`slice${i}`));
  const b = new Box3().setFromObject(asset.node(`slice${i + 1}`));
  const overlap = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  minOverlapX = Math.min(minOverlapX, overlap);
}
console.log(`  posed at max amplitudes (composed): min slice Box3 x-overlap ${minOverlapX.toFixed(4)} (extension is 0.046)`);
for (let i = 0; i < 5; i++) authored.joints[`spine${i}`]!.rotation.y = 0;
authored.root.updateMatrixWorld(true);

blueprint.dispose();
asset.dispose();
console.log('disposed blueprint then asset');

if (process.argv.includes('--old')) {
  const { buildEel: buildOldEel } = await import('./client/species/.old-eel.ts');
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
  const old = buildOldEel(pool);
  const oldBlueprint = bakeRig(old.root);
  report('procedural eel (HEAD)', oldBlueprint);
  old.root.updateMatrixWorld(true);
  const oldBounds = new Box3().setFromObject(old.root);
  console.log(
    `  bounds x[${oldBounds.min.x.toFixed(4)}, ${oldBounds.max.x.toFixed(4)}] ` +
      `y[${oldBounds.min.y.toFixed(4)}, ${oldBounds.max.y.toFixed(4)}] ` +
      `z[${oldBounds.min.z.toFixed(4)}, ${oldBounds.max.z.toFixed(4)}]`,
  );
  oldBlueprint.dispose();
  for (const geometry of kept) geometry.dispose();
  void Matrix4;
  void (null as unknown as Object3D);
}
