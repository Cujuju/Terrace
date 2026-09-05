// Verifies the three authored hulls against the convention this plugin's client
// half relies on: the four mesh names, the two Empties, one material per mesh,
// and the outer diameter.
// three's GLTFLoader touches `self` at module scope; Node has no such global.
// The same shim every headless model check in this repo needs.
(globalThis as unknown as { self?: unknown }).self ??= globalThis;

import { readFile } from 'node:fs/promises';
import { parseRigAsset } from '/mnt/e/Development/Projects/Terrace/.claude/worktrees/saucers/client/src/render/rigAsset.ts';
import { Box3, Vector3 } from 'three';

const DIR = '/mnt/e/Development/Projects/Terrace/.claude/worktrees/saucers/plugins/saucers/client/assets';
const NAMES = ['saucer-a.glb', 'saucer-b.glb', 'saucer-c.glb'];
const REQUIRED = ['hull', 'ring', 'dome', 'lights', 'muzzle', 'top'];

for (const name of NAMES) {
  const bytes = await readFile(`${DIR}/${name}`);
  try {
    const asset = await parseRigAsset(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      name,
    );
    const missing: string[] = [];
    for (const node of REQUIRED) {
      if (asset.scene.getObjectByName(node) === undefined) missing.push(node);
    }
    const size = new Box3().setFromObject(asset.scene).getSize(new Vector3());
    const names: string[] = [];
    let tris = 0;
    asset.scene.traverse((child: any) => {
      if (child.name) names.push(`${child.name}:${child.type}`);
      if (child.isMesh) {
        const m = child.material;
        names[names.length - 1] += `[emissiveIntensity=${m.emissiveIntensity} map=${m.map ? 'yes' : 'no'} uv=${child.geometry.getAttribute('uv') ? 'yes' : 'no'}]`;
        const index = child.geometry.getIndex();
        tris += (index ? index.count : child.geometry.getAttribute('position').count) / 3;
      }
    });
    names.push(`TOTAL_TRIS=${Math.round(tris)}`);
    console.log(
      `${name}\n  size (model units) = ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)}` +
        `\n  missing = [${missing.join(', ')}]\n  nodes = ${names.join(', ')}`,
    );
    asset.dispose();
  } catch (error) {
    console.log(`${name}\n  REJECTED: ${(error as Error).message}`);
  }
}
