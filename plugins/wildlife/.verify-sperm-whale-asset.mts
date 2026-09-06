// Scratch check (uncommitted): bake the sperm whale from its .glb and report
// what the draw budget is counted against — surfaces, joints, triangles — plus
// the envelope the installer measured. Node feeds the SAME install path the
// browser's preload does, via parseRigAsset off disk. Also proves the jaw's
// vertex tint reaches the bake (rigSkin multiplies material colour by the
// COLOR_0 attribute), that the flukes hinge rests at identity, and — the end
// of the procedural whale — bakes the humpback and blue whale assets too so
// the draw-object tally can be shown to equal index.ts's drawBudget with NO
// procedural body left. From the main checkout's .verify-blue-whale-asset.mts,
// parameterised; `--old` bakes HEAD's procedural sperm body from
// client/.old-whaleSpecies.ts for the comparison row.
import { readFile } from 'node:fs/promises';
import {
  Box3,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
  Vector3,
} from 'three';
import { parseRigAsset } from '../../client/src/render/rigAsset.ts';
import { bakeRig, type RigBlueprint } from '../../client/src/render/rigSkin.ts';
import { installSpeciesAsset } from './client/species/assetSpecies.ts';
import { SPERM_WHALE_ASSET, SPERM_WHALE_ENVELOPE, buildSpermWhale } from './client/species/spermWhale.ts';
import { HUMPBACK_ASSET, buildHumpback } from './client/species/humpback.ts';
import { BLUE_WHALE_ASSET, buildBlueWhale } from './client/species/blueWhale.ts';
import { WHALE_ENVELOPE, WHALE_SPECIES } from './client/whaleSpecies.ts';

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
  console.log(
    '  materials:',
    blueprint.surfaces
      .map((s) => {
        const m = s.material as { type: string; flatShading?: boolean; roughness?: number };
        return `${m.type}(${m.flatShading === true ? 'flat' : 'smooth'}, roughness ${String(m.roughness)})`;
      })
      .join(', '),
  );
}

const old = process.argv.includes('--old');
if (old) {
  const { buildWhaleGeometrySets, assembleWhale } = await import('./client/.old-whaleSpecies.ts');
  const material = new MeshLambertMaterial({ color: 0x39506b, flatShading: false });
  for (const set of buildWhaleGeometrySets()) {
    const root = new Group();
    const rig = new Group();
    root.add(rig);
    const { body: whaleBody } = assembleWhale(set, material);
    rig.add(whaleBody);
    const bp = bakeRig(root);
    report(`HEAD procedural whale body "${set.species}" (fitScale ${set.fitScale.toFixed(4)})`, bp);
    root.updateMatrixWorld(true);
    const b = new Box3().setFromObject(root);
    console.log(
      `  bounds x[${b.min.x.toFixed(4)}, ${b.max.x.toFixed(4)}] y[${b.min.y.toFixed(4)}, ${b.max.y.toFixed(4)}] ` +
        `z[${b.min.z.toFixed(4)}, ${b.max.z.toFixed(4)}] length ${(b.max.x - b.min.x).toFixed(3)}`,
    );
    bp.dispose();
  }
  process.exit(0);
}

const url = new URL('./client/assets/sperm-whale.glb', import.meta.url);
const buffer = await readFile(url);
const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const asset = await parseRigAsset(bytes, 'sperm-whale.glb');
installSpeciesAsset(SPERM_WHALE_ASSET, asset);
console.log('installSpeciesAsset: accepted sperm-whale.glb');

const authored = buildSpermWhale(null as never);
const blueprint = bakeRig(authored.root);
report('GLB sperm whale (whale-sperm)', blueprint);
console.log('  joints resolved:', Object.keys(authored.joints).join(', '));
for (const name of ['rig', 'flukes']) {
  const node = asset.node(name);
  const p = node.position;
  const r = node.rotation;
  console.log(
    `    ${name.padEnd(8)} parent=${node.parent?.name ?? '(none)'} at (${p.x.toFixed(4)}, ` +
      `${p.y.toFixed(4)}, ${p.z.toFixed(4)}) rotation (${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)})`,
  );
}
for (const name of ['flukes_blade', 'flipper_port', 'flipper_starboard', 'jaw', 'eye_port', 'eye_starboard', 'body']) {
  const node = asset.node(name);
  console.log(`    mesh ${name.padEnd(18)} parent=${node.parent?.name ?? '(none)'}`);
}

const bounds = new Box3().setFromObject(asset.scene);
const size = bounds.getSize(new Vector3());
console.log(
  `  bounds x[${bounds.min.x.toFixed(4)}, ${bounds.max.x.toFixed(4)}] ` +
    `y[${bounds.min.y.toFixed(4)}, ${bounds.max.y.toFixed(4)}] ` +
    `z[${bounds.min.z.toFixed(4)}, ${bounds.max.z.toFixed(4)}] size ${size.x.toFixed(3)}`,
);
console.log('  declared SPERM_WHALE_ENVELOPE (asserted at install):', JSON.stringify(SPERM_WHALE_ENVELOPE));
console.log('  WHALE_ENVELOPE (placement contract):              ', JSON.stringify(WHALE_ENVELOPE));
for (const name of ['nose', 'tail_tip', 'crown', 'belly', 'flank']) {
  const a = asset.anchor(name);
  console.log(`    ${name.padEnd(9)} (${a.x.toFixed(4)}, ${a.y.toFixed(4)}, ${a.z.toFixed(4)})`);
}

// The jaw's tint: the file's jaw material is white and COLOR_0 carries the
// lip and body tones; the bake multiplies them (rigSkin.ts paintVertexColor).
const jaw = asset.node('jaw') as Mesh;
const jawMaterial = jaw.material as { color: Color; vertexColors: boolean };
const tint = jaw.geometry.getAttribute('color');
console.log(
  `  jaw material colour #${jawMaterial.color.getHexString()} vertexColors=${String(jawMaterial.vertexColors)}; ` +
    `COLOR_0 present=${String(tint !== undefined)} (${String(tint?.count)} vertices, ${String(tint?.itemSize)} components)`,
);
const extremes = { dark: [1, 1, 1], pale: [0, 0, 0] };
for (let v = 0; v < tint.count; v++) {
  const lum = tint.getX(v) + tint.getY(v) + tint.getZ(v);
  if (lum < extremes.dark[0]! + extremes.dark[1]! + extremes.dark[2]!) extremes.dark = [tint.getX(v), tint.getY(v), tint.getZ(v)];
  if (lum > extremes.pale[0]! + extremes.pale[1]! + extremes.pale[2]!) extremes.pale = [tint.getX(v), tint.getY(v), tint.getZ(v)];
}
const asHex = (rgb: number[]): string => new Color(rgb[0]!, rgb[1]!, rgb[2]!).getHexString();
console.log(`  jaw COLOR_0 range (linear -> sRGB hex): darkest #${asHex(extremes.dark)}, palest #${asHex(extremes.pale)}`);
const body = asset.node('body') as Mesh;
const bodyMaterial = body.material as { color: Color; vertexColors: boolean };
console.log(`  body material colour #${bodyMaterial.color.getHexString()} vertexColors=${String(bodyMaterial.vertexColors)}`);
const baked = blueprint.surfaces[0]!.geometry.getAttribute('color');
console.log(`  baked surface carries a colour attribute: ${String(baked !== undefined)} (${String(baked.count)} vertices)`);
console.log(`  expected: body #${new Color(0x39506b).getHexString()} (the old WHALE_COLOR), lip #${new Color(0xb8c4cf).getHexString()}`);

blueprint.dispose();
asset.dispose();
console.log('disposed blueprint then asset');

// The other two whale assets, baked the same way, for the draw-object tally.
let whaleSurfaces = blueprint.surfaceCount;
for (const [label, spec, build, file] of [
  ['humpback', HUMPBACK_ASSET, buildHumpback, 'humpback.glb'],
  ['blue whale', BLUE_WHALE_ASSET, buildBlueWhale, 'blue-whale.glb'],
] as const) {
  const buf = await readFile(new URL(`./client/assets/${file}`, import.meta.url));
  const other = await parseRigAsset(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), file);
  installSpeciesAsset(spec, other);
  const bp = bakeRig(build(null as never).root);
  report(`GLB ${label} (${spec.species})`, bp);
  whaleSurfaces += bp.surfaceCount;
  bp.dispose();
  other.dispose();
}

// index.ts's constants, restated here so the tally is independent of them.
const SINGLE_SURFACE_SPECIES = 11; // fish, ibex, bison, ray, shark, eel, angelfish, humpback, blue whale, sperm whale, bird
const GRAZER_ASSET_DRAW_OBJECTS = 1;
const WOLF_ASSET_DRAW_OBJECTS = 1;
const TWO_SURFACE_SPECIES = 1; // deepsea
const nonWhaleSingles = SINGLE_SURFACE_SPECIES - WHALE_SPECIES.length;
const tally = nonWhaleSingles + whaleSurfaces + GRAZER_ASSET_DRAW_OBJECTS + WOLF_ASSET_DRAW_OBJECTS + TWO_SURFACE_SPECIES * 2;
console.log(
  `draw-object tally: ${nonWhaleSingles} single-surface non-whale species + ${whaleSurfaces} (three whale assets, measured) ` +
    `+ ${GRAZER_ASSET_DRAW_OBJECTS} grazer + ${WOLF_ASSET_DRAW_OBJECTS} wolf + ${TWO_SURFACE_SPECIES * 2} deepsea = ${tally}`,
);
const budget = SINGLE_SURFACE_SPECIES + GRAZER_ASSET_DRAW_OBJECTS + WOLF_ASSET_DRAW_OBJECTS + TWO_SURFACE_SPECIES * 2;
console.log('index.ts drawBudget = 11 + 1 + 1 + 1 * 2 =', budget);
if (tally !== budget) throw new Error('tally does not match drawBudget');
