// Scratch check: every geometry closed (each edge shared by exactly 2 faces
// after merging coincident vertices) and every part's world bbox overlaps
// another part's by a real margin (nothing floating).
import { Box3, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Vector3, type BufferGeometry, type Material } from 'three';
import { buildBison } from './client/species/bison.ts';

const geoms = new Set<BufferGeometry>();
const pool = {
  keepGeometry<T extends BufferGeometry>(g: T): T { geoms.add(g); return g; },
  lambert(color: number) { return new MeshLambertMaterial({ color }); },
  unlit(color: number) { return new MeshBasicMaterial({ color }); },
  part(g: BufferGeometry, m: Material, x: number, y: number, z: number) { const mesh = new Mesh(g, m); mesh.position.set(x, y, z); return mesh; },
  rigged() { const root = new Group(); const rig = new Group(); root.add(rig); return { root, rig }; },
};
const { root } = buildBison(pool as never);
root.updateMatrixWorld(true);

function openEdges(g: BufferGeometry): number {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const q = (v: number) => Math.round(v * 1e5) + 0 || 0; // no -0 keys
  const key = (i: number) => `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`;
  const ids = new Map<string, number>();
  const vid = (i: number) => { const k = key(i); let v = ids.get(k); if (v === undefined) { v = ids.size; ids.set(k, v); } return v; };
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const edges = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const a = vid(idx ? idx.getX(t * 3) : t * 3), b = vid(idx ? idx.getX(t * 3 + 1) : t * 3 + 1), c = vid(idx ? idx.getX(t * 3 + 2) : t * 3 + 2);
    if (a === b || b === c || a === c) continue; // degenerate (pole) triangle
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = p < q ? `${p}-${q}` : `${q}-${p}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
  }
  let bad = 0; for (const n of edges.values()) if (n !== 2) bad++;
  return bad;
}
let openTotal = 0;
for (const g of geoms) { const n = openEdges(g); openTotal += n; if (n) console.log('OPEN', g.type, g.uuid.slice(0, 8), n, 'edges'); }
console.log(`geometries: ${geoms.size}, open edges: ${openTotal}`);

const meshes: Mesh[] = [];
root.traverse((o) => { if (o instanceof Mesh) meshes.push(o); });
// A part is attached if at least one of its vertices lies INSIDE another
// part's closed mesh (odd ray-crossing parity). Bounds overlap is not enough:
// two shapes can share a box and never touch.
import { Raycaster, DoubleSide } from 'three';
const ray = new Raycaster();
const dir = new Vector3(0.7071, 0.7071, 0); // off-axis so it never grazes a seam
const boxes = meshes.map((m) => new Box3().setFromObject(m));
for (const m of meshes) (m.material as MeshLambertMaterial).side = DoubleSide;
function inside(p: Vector3, m: Mesh, box: Box3): boolean {
  if (!box.containsPoint(p)) return false;
  ray.set(p, dir);
  return ray.intersectObject(m, false).length % 2 === 1;
}
const v = new Vector3();
meshes.forEach((m, i) => {
  const pos = m.geometry.getAttribute('position');
  let attachedTo = -1, hits = 0;
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(m.matrixWorld);
    for (let j = 0; j < meshes.length; j++) {
      if (j === i) continue;
      if (inside(v, meshes[j]!, boxes[j]!)) { attachedTo = j; hits++; break; }
    }
  }
  const c = boxes[i]!.getCenter(new Vector3());
  console.log(`part ${String(i).padStart(2)} ${m.geometry.type.padEnd(16)} centre (${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) ${hits ? `${hits}/${pos.count} verts inside part ${attachedTo}` : 'FLOATING'}`);
});
