// Scratch check (uncommitted): bake the humpback from its .glb and report what
// the draw budget is counted against — surfaces, joints, triangles — plus the
// envelope the installer measured. Node feeds the SAME install path the
// browser's preload does, via parseRigAsset off disk. Also proves the hull's
// vertex tint reaches the bake (rigSkin multiplies material colour by the
// COLOR_0 attribute), that the flukes hinge rests at identity, and — the
// whale's own check — bakes the two remaining PROCEDURAL whale bodies
// (whaleSpecies.ts) so the draw-object tally can be shown to equal index.ts's
// drawBudget. From the main checkout's .verify-angelfish-asset.mts,
// parameterised; the "old" humpback row is the species sheet's table.
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
import { HUMPBACK_ASSET, HUMPBACK_ENVELOPE, buildHumpback } from './client/species/humpback.ts';
import { WHALE_ENVELOPE, assembleWhale, buildWhaleGeometrySets } from './client/whaleSpecies.ts';

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

const url = new URL('./client/assets/humpback.glb', import.meta.url);
const buffer = await readFile(url);
const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const asset = await parseRigAsset(bytes, 'humpback.glb');
installSpeciesAsset(HUMPBACK_ASSET, asset);
console.log('installSpeciesAsset: accepted humpback.glb');

const authored = buildHumpback(null as never);
const blueprint = bakeRig(authored.root);
report('GLB humpback (whale-humpback)', blueprint);
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
for (const name of ['flukes_blade', 'flukes_blade_underside', 'flipper_starboard', 'dorsal', 'body']) {
  const node = asset.node(name);
  console.log(`    mesh ${name.padEnd(22)} parent=${node.parent?.name ?? '(none)'}`);
}

const bounds = new Box3().setFromObject(asset.scene);
const size = bounds.getSize(new Vector3());
console.log(
  `  bounds x[${bounds.min.x.toFixed(4)}, ${bounds.max.x.toFixed(4)}] ` +
    `y[${bounds.min.y.toFixed(4)}, ${bounds.max.y.toFixed(4)}] ` +
    `z[${bounds.min.z.toFixed(4)}, ${bounds.max.z.toFixed(4)}] size ${size.x.toFixed(3)}`,
);
console.log('  declared HUMPBACK_ENVELOPE (asserted at install):', JSON.stringify(HUMPBACK_ENVELOPE));
console.log('  WHALE_ENVELOPE (placement contract):             ', JSON.stringify(WHALE_ENVELOPE));
for (const name of ['nose', 'tail_tip', 'crown', 'belly', 'flank']) {
  const a = asset.anchor(name);
  console.log(`    ${name.padEnd(9)} (${a.x.toFixed(4)}, ${a.y.toFixed(4)}, ${a.z.toFixed(4)})`);
}

// The hull's tint: the file's material is white and COLOR_0 carries the body
// and throat tones; the bake multiplies them (rigSkin.ts paintVertexColor).
const body = asset.node('body') as Mesh;
const bodyMaterial = body.material as { color: Color; vertexColors: boolean };
const tint = body.geometry.getAttribute('color');
console.log(
  `  body material colour #${bodyMaterial.color.getHexString()} vertexColors=${String(bodyMaterial.vertexColors)}; ` +
    `COLOR_0 present=${String(tint !== undefined)} (${String(tint?.count)} vertices, ${String(tint?.itemSize)} components)`,
);
const extremes = { dark: [1, 1, 1], pale: [0, 0, 0] };
for (let v = 0; v < tint.count; v++) {
  const lum = tint.getX(v) + tint.getY(v) + tint.getZ(v);
  if (lum < extremes.dark[0]! + extremes.dark[1]! + extremes.dark[2]!) extremes.dark = [tint.getX(v), tint.getY(v), tint.getZ(v)];
  if (lum > extremes.pale[0]! + extremes.pale[1]! + extremes.pale[2]!) extremes.pale = [tint.getX(v), tint.getY(v), tint.getZ(v)];
}
const asHex = (rgb: number[]): string => new Color(rgb[0]!, rgb[1]!, rgb[2]!).getHexString();
console.log(`  hull COLOR_0 range (linear -> sRGB hex): darkest #${asHex(extremes.dark)}, palest #${asHex(extremes.pale)}`);
const baked = blueprint.surfaces[0]!.geometry.getAttribute('color');
console.log(`  baked surface carries a colour attribute: ${String(baked !== undefined)} (${String(baked.count)} vertices)`);
const bodyLinear = new Color(0x39506b);
const ventralLinear = new Color(0xb9c6d2);
console.log(`  expected: body #${bodyLinear.getHexString()} (WHALE_COLOR), ventral #${ventralLinear.getHexString()}`);

blueprint.dispose();
asset.dispose();
console.log('disposed blueprint then asset');

// The two procedural whale bodies, baked the way models.ts bakes them, for
// the draw-object tally.
const material = new MeshLambertMaterial({ color: 0x39506b, flatShading: false });
let proceduralSurfaces = 0;
for (const set of buildWhaleGeometrySets()) {
  const root = new Group();
  const rig = new Group();
  root.add(rig);
  const { body: whaleBody } = assembleWhale(set, material);
  rig.add(whaleBody);
  const bp = bakeRig(root);
  report(`procedural whale body "${set.species}" (fitScale ${set.fitScale.toFixed(4)})`, bp);
  root.updateMatrixWorld(true);
  const b = new Box3().setFromObject(root);
  console.log(
    `  bounds x[${b.min.x.toFixed(4)}, ${b.max.x.toFixed(4)}] y[${b.min.y.toFixed(4)}, ${b.max.y.toFixed(4)}] ` +
      `z[${b.min.z.toFixed(4)}, ${b.max.z.toFixed(4)}] length ${(b.max.x - b.min.x).toFixed(3)}`,
  );
  proceduralSurfaces += bp.surfaceCount;
  bp.dispose();
}
const SINGLE_SURFACE_SPECIES = 9;
const GRAZER_ASSET_DRAW_OBJECTS = 1;
const DEEPSEA_SURFACES = 2;
const tally = SINGLE_SURFACE_SPECIES + GRAZER_ASSET_DRAW_OBJECTS + DEEPSEA_SURFACES + proceduralSurfaces;
console.log(
  `draw-object tally: ${SINGLE_SURFACE_SPECIES} single-surface species (incl. humpback) + ${GRAZER_ASSET_DRAW_OBJECTS} grazer ` +
    `+ ${DEEPSEA_SURFACES} deepsea + ${proceduralSurfaces} (two procedural whales) = ${tally}`,
);
console.log('index.ts drawBudget = 9 + 1 + (1 + 2) * 2 =', 9 + 1 + (1 + 2) * 2);
if (tally !== 9 + 1 + (1 + 2) * 2) throw new Error('tally does not match drawBudget');
