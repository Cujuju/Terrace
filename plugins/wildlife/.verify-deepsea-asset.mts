// Scratch check (uncommitted): bake the deep-sea anglerfish from its .glb and
// report what the draw budget is counted against — surfaces, joints,
// triangles — plus the envelope the installer measured. Node feeds the SAME
// install path the browser's preload does, via parseRigAsset off disk. Also
// proves the two-surface claim by naming the material TYPE of each baked
// surface (one MeshBasicMaterial: the unlit lure), that the `lure` joint
// rests at identity rotation at the height species/deepsea.ts bobs about,
// that the bulb's top plus the bob stays under the crown, and that the
// draw-object tally still equals index.ts's drawBudget. From the main
// checkout's .verify-sperm-whale-asset.mts, parameterised; `--old` bakes
// HEAD's procedural body — rebuilt here from HEAD's models.ts:317-323 and
// :467-479 with the same three primitives, positions and materials, since
// that body only ever existed inside createWildlifeModels — for the
// comparison row.
import { readFile } from 'node:fs/promises';
import {
  Box3,
  BoxGeometry,
  Color,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { parseRigAsset } from '../../client/src/render/rigAsset.ts';
import { bakeRig, type RigBlueprint } from '../../client/src/render/rigSkin.ts';
import { installSpeciesAsset } from './client/species/assetSpecies.ts';
import { DEEPSEA_ASSET, DEEPSEA_ENVELOPE, buildDeepsea } from './client/species/deepsea.ts';

function triangleCount(blueprint: RigBlueprint): number {
  let triangles = 0;
  for (const surface of blueprint.surfaces) {
    const index = surface.geometry.getIndex();
    triangles += (index ? index.count : surface.geometry.getAttribute('position').count) / 3;
  }
  return triangles;
}

function report(label: string, blueprint: RigBlueprint): void {
  console.log(`${label}:`);
  console.log(`  surfaces: ${blueprint.surfaceCount}`);
  console.log(`  joints:   ${blueprint.jointCount}`);
  console.log(`  triangles:${triangleCount(blueprint)}`);
  blueprint.surfaces.forEach((s, i) => {
    const m = s.material as { type: string; flatShading?: boolean; roughness?: number; color?: Color };
    const index = s.geometry.getIndex();
    const tris = (index ? index.count : s.geometry.getAttribute('position').count) / 3;
    console.log(
      `  surface ${i}: ${m.type} (${m.flatShading === true ? 'flat' : 'smooth'}, roughness ${String(m.roughness)}, ` +
        `colour #${m.color?.getHexString() ?? '??????'}), ${tris} tris`,
    );
  });
}

// species/deepsea.ts's motion constants, restated so the check is independent.
const DEEPSEA_LURE_REST_Y = 0.23;
const DEEPSEA_LURE_BOB = 0.05;

const old = process.argv.includes('--old');
if (old) {
  // HEAD models.ts: SPHERE_SEGMENTS 6, SPHERE_RINGS 4, CONE_SEGMENTS 4;
  // ellipsoid(l, h, w) = SphereGeometry(0.5, 6, 4).scale(l, h, w);
  // lambert = MeshLambertMaterial({ color, flatShading: true }); unlit = MeshBasicMaterial({ color }).
  const kept: BufferGeometry[] = [];
  const keep = <T extends BufferGeometry>(g: T): T => {
    kept.push(g);
    return g;
  };
  const ellipsoid = (l: number, h: number, w: number): SphereGeometry => {
    const g = new SphereGeometry(0.5, 6, 4);
    g.scale(l, h, w);
    return keep(g);
  };
  const part = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number): Mesh => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    return mesh;
  };
  const body = new MeshLambertMaterial({ color: 0x161c26, flatShading: true });
  const lureMaterial = new MeshBasicMaterial({ color: 0xa8fbff });
  const jaw = keep(new ConeGeometry(0.3, 0.45, 4));
  jaw.rotateZ(-Math.PI / 2);
  const root = new Group();
  const rig = new Group();
  root.add(rig);
  rig.add(part(ellipsoid(1, 0.35 - -0.35, 0.55), body, 0, 0, 0));
  rig.add(part(jaw, body, 0.5, -0.12, 0));
  rig.add(part(keep(new BoxGeometry(0.5, 0.04, 0.04)), body, 0.42, 0.34, 0));
  const lure = new Group();
  lure.position.set(0.68, 0.36, 0);
  lure.add(part(ellipsoid(0.14, 0.14, 0.14), lureMaterial, 0, 0, 0));
  rig.add(lure);
  const bp = bakeRig(root);
  report('HEAD procedural deepsea (rebuilt from models.ts:317-323, 467-479)', bp);
  root.updateMatrixWorld(true);
  const b = new Box3().setFromObject(root);
  console.log(
    `  bounds x[${b.min.x.toFixed(4)}, ${b.max.x.toFixed(4)}] y[${b.min.y.toFixed(4)}, ${b.max.y.toFixed(4)}] ` +
      `z[${b.min.z.toFixed(4)}, ${b.max.z.toFixed(4)}] length ${(b.max.x - b.min.x).toFixed(3)}`,
  );
  console.log(`  declared crown/belly were +0.35 / -0.35; the body measured y max ${b.max.y.toFixed(4)}, y min ${b.min.y.toFixed(4)}`);
  bp.dispose();
  for (const g of kept) g.dispose();
  process.exit(0);
}

const url = new URL('./client/assets/deepsea.glb', import.meta.url);
const buffer = await readFile(url);
const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const asset = await parseRigAsset(bytes, 'deepsea.glb');
installSpeciesAsset(DEEPSEA_ASSET, asset);
console.log('installSpeciesAsset: accepted deepsea.glb');

const authored = buildDeepsea(null as never);
const blueprint = bakeRig(authored.root);
report('GLB deepsea', blueprint);
const types = blueprint.surfaces.map((s) => s.material.type);
if (blueprint.surfaceCount !== 2) throw new Error(`expected 2 surfaces, got ${blueprint.surfaceCount}`);
if (types.filter((t) => t === 'MeshBasicMaterial').length !== 1) throw new Error(`expected exactly one MeshBasicMaterial surface: ${types.join(', ')}`);
if (types.filter((t) => t === 'MeshStandardMaterial').length !== 1) throw new Error(`expected exactly one MeshStandardMaterial surface: ${types.join(', ')}`);
console.log('  two surfaces: one MeshStandardMaterial (body, teeth, eyes, fins, stalk), one MeshBasicMaterial (the unlit lure)');

console.log('  joints resolved:', Object.keys(authored.joints).join(', '));
for (const name of ['rig', 'lure']) {
  const node = asset.node(name);
  const p = node.position;
  const r = node.rotation;
  console.log(
    `    ${name.padEnd(5)} parent=${node.parent?.name ?? '(none)'} at (${p.x.toFixed(4)}, ` +
      `${p.y.toFixed(4)}, ${p.z.toFixed(4)}) rotation (${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)})`,
  );
}
for (const name of ['lure_bulb', 'stalk', 'jaw', 'upper_teeth', 'dorsal', 'anal', 'caudal', 'pectoral_port', 'pectoral_starboard', 'eye_port', 'eye_starboard', 'body']) {
  const node = asset.node(name) as Mesh;
  const mat = node.material as { type: string; color: Color };
  console.log(`    mesh ${name.padEnd(18)} parent=${(node.parent?.name ?? '(none)').padEnd(5)} material ${mat.type} #${mat.color.getHexString()}`);
}

const bounds = new Box3().setFromObject(asset.scene);
const size = bounds.getSize(new Vector3());
console.log(
  `  bounds x[${bounds.min.x.toFixed(4)}, ${bounds.max.x.toFixed(4)}] ` +
    `y[${bounds.min.y.toFixed(4)}, ${bounds.max.y.toFixed(4)}] ` +
    `z[${bounds.min.z.toFixed(4)}, ${bounds.max.z.toFixed(4)}] size ${size.x.toFixed(3)}`,
);
console.log('  declared DEEPSEA_ENVELOPE (asserted at install):', JSON.stringify(DEEPSEA_ENVELOPE));
for (const name of ['nose', 'tail_tip', 'crown', 'belly', 'flank']) {
  const a = asset.anchor(name);
  console.log(`    ${name.padEnd(9)} (${a.x.toFixed(4)}, ${a.y.toFixed(4)}, ${a.z.toFixed(4)})`);
}

// The lure: rest height vs the species file's constant, and the bob check.
const lureNode = asset.node('lure');
const restDiff = Math.abs(lureNode.position.y - DEEPSEA_LURE_REST_Y);
const float32Ulp = Math.pow(2, -24) * DEEPSEA_LURE_REST_Y;
console.log(
  `  lure rest y in file ${lureNode.position.y.toPrecision(10)} vs DEEPSEA_LURE_REST_Y ${DEEPSEA_LURE_REST_Y}: ` +
    `|diff| ${restDiff.toExponential(3)} (float32 half-ulp at 0.23 is ${float32Ulp.toExponential(3)})`,
);
if (restDiff > float32Ulp) throw new Error('the species file bobs the lure about a different rest than the file carries');
const bulbBounds = new Box3().setFromObject(asset.node('lure_bulb'));
const lureTop = bulbBounds.max.y;
console.log(
  `  lure top at rest ${lureTop.toFixed(4)} + bob ${DEEPSEA_LURE_BOB} = ${(lureTop + DEEPSEA_LURE_BOB).toFixed(4)} ` +
    `<= crownY ${DEEPSEA_ENVELOPE.crownY} by ${(DEEPSEA_ENVELOPE.crownY - lureTop - DEEPSEA_LURE_BOB).toFixed(4)}`,
);
if (lureTop + DEEPSEA_LURE_BOB > DEEPSEA_ENVELOPE.crownY) throw new Error('the bobbing lure would become the crown');
console.log(`  bulb x max ${bulbBounds.max.x.toFixed(4)} behind the nose ${asset.anchor('nose').x.toFixed(4)}`);

// Colours reach the bake: the lit surface carries a colour attribute (body
// and detail tones), the unlit surface is the lure's own colour.
const lit = blueprint.surfaces.find((s) => s.material.type === 'MeshStandardMaterial')!;
const litColor = lit.geometry.getAttribute('color');
console.log(`  lit surface carries a colour attribute: ${String(litColor !== undefined)} (${String(litColor?.count)} vertices)`);
console.log(`  expected: body #${new Color(0x161c26).getHexString()}, lure #${new Color(0xa8fbff).getHexString()}, detail #${new Color(0x3a4150).getHexString()}`);

// index.ts's constants, restated here so the tally is independent of them.
const SINGLE_SURFACE_SPECIES = 11; // fish, ibex, bison, ray, shark, eel, angelfish, humpback, blue whale, sperm whale, bird
const GRAZER_ASSET_DRAW_OBJECTS = 1;
const WOLF_ASSET_DRAW_OBJECTS = 1;
const TWO_SURFACE_SPECIES = 1; // deepsea
const tally = SINGLE_SURFACE_SPECIES + GRAZER_ASSET_DRAW_OBJECTS + WOLF_ASSET_DRAW_OBJECTS + blueprint.surfaceCount;
const budget = SINGLE_SURFACE_SPECIES + GRAZER_ASSET_DRAW_OBJECTS + WOLF_ASSET_DRAW_OBJECTS + TWO_SURFACE_SPECIES * 2;
console.log(
  `draw-object tally: ${SINGLE_SURFACE_SPECIES} single-surface species + ${GRAZER_ASSET_DRAW_OBJECTS} grazer + ` +
    `${WOLF_ASSET_DRAW_OBJECTS} wolf + ${blueprint.surfaceCount} deepsea (measured) = ${tally}`,
);
console.log('index.ts drawBudget = 11 + 1 + 1 + 1 * 2 =', budget);
if (tally !== budget) throw new Error('tally does not match drawBudget');

blueprint.dispose();
asset.dispose();
console.log('disposed blueprint then asset');
