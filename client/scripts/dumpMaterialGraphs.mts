// Dumps the node graph of every migrated material that builds without a GPU device, so a later
// change to a composition shows up as a diff rather than as a pixel.
// Run: node client/scripts/dumpMaterialGraphs.mts          (per-slot node-type summary)
//      node client/scripts/dumpMaterialGraphs.mts --json   (full node.toJSON() per slot)
import { Color, Group, Mesh, type Object3D } from 'three';
import { MeshBasicNodeMaterial, type NodeMaterial } from 'three/webgpu';
import { CHUNK_SIZE, NEIGHBOURHOOD_CELLS } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import { createTerrainMeshes } from '../src/render/terrainMeshes.ts';
import { createWater } from '../src/render/water.ts';
import { createRevealMask } from '../src/render/revealMask.ts';
import { createCumulusDeck } from '../src/plugins/kit/cumulusDeck.ts';
import { createSpiral } from '../../plugins/cyclone/client/spiral.ts';
import { createPlume } from '../../plugins/volcanoes/client/plume.ts';
import { createLavaFlow } from '../../plugins/volcanoes/client/lavaFlow.ts';
import { createFunnel } from '../../plugins/tornado/client/funnel.ts';
import { createWorkshop } from '../../plugins/monsters/client/geometry.ts';
import { createLaserPool } from '../../plugins/saucers/client/effects.ts';
import { createFireSmoke } from '../../plugins/fire/client/smoke.ts';
import { createFireScar } from '../../plugins/fire/client/scar.ts';
import { buildRibbonFlames } from '../../plugins/fire/client/flames/ribbons.ts';
import { buildShaderPlumeFlames } from '../../plugins/fire/client/flames/shaderPlume.ts';
import { createPuddles } from '../../plugins/hydro/client/puddles.ts';
import { createGemMaterial } from '../../plugins/relics/client/gemMaterial.ts';
import { createSpireMaterial } from '../../plugins/relics/client/relicSpire.ts';

const WORLD = NEIGHBOURHOOD_CELLS * 4;
const FULL_JSON = process.argv.includes('--json');

const SLOTS = [
  'positionNode',
  'normalNode',
  'colorNode',
  'opacityNode',
  'emissiveNode',
  'outputNode',
  'specularColorNode',
  'maskNode',
  'vertexNode',
  'fragmentNode',
  'sizeNode',
] as const;

interface NodeJson {
  readonly type: string;
  readonly nodes?: readonly { readonly type: string }[];
}

// "RootType <- ChildTypexN, ..." over the node's flattened graph, in a stable order.
function summarise(json: NodeJson): string {
  const counts = new Map<string, number>();
  for (const child of json.nodes ?? []) counts.set(child.type, (counts.get(child.type) ?? 0) + 1);
  const children = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}x${count}`)
    .join(', ');
  return children.length === 0 ? json.type : `${json.type} <- ${children}`;
}

function describe(label: string, material: NodeMaterial): void {
  const slots = material as unknown as Record<string, { toJSON?: () => unknown } | null>;
  if (FULL_JSON) {
    const graph: Record<string, unknown> = {};
    for (const slot of SLOTS) {
      const node = slots[slot];
      graph[slot] = node === null || node === undefined ? null : (node.toJSON?.() ?? null);
    }
    console.log(JSON.stringify({ label, type: material.type, graph }, null, 2));
    return;
  }
  console.log(`${label} ${material.type}`);
  for (const slot of SLOTS) {
    const node = slots[slot];
    if (node === null || node === undefined) continue;
    console.log(`  ${slot}: ${summarise(node.toJSON?.() as NodeJson)}`);
  }
}

function describeMeshes(label: string, root: Object3D): void {
  root.traverse((object) => {
    if (object instanceof Mesh) describe(`${label}/${object.name}`, object.material as NodeMaterial);
  });
}

const mirror = createTerrainMirror(WORLD);
const snapshot = {
  type: 'snapshot' as const,
  worldSize: WORLD,
  chunks: [{ cx: 0, cy: 0, heights: new Array<number>(CHUNK_SIZE * CHUNK_SIZE).fill(0) }],
};

const terrainGroup = new Group();
const meshes = createTerrainMeshes(terrainGroup, mirror);
meshes.update(applySnapshot(mirror, snapshot));
describe('terrain', meshes.pickables()[0]!.material as NodeMaterial);

const waterGroup = new Group();
createWater(waterGroup, WORLD);
const waterMesh = waterGroup.children[0];
if (waterMesh instanceof Mesh) describe('water', waterMesh.material as NodeMaterial);

const revealMask = createRevealMask(WORLD);
const clip = (material: NodeMaterial, label: string): void =>
  revealMask.applyRevealClip(material, label);

const clipped = new MeshBasicNodeMaterial();
clip(clipped, 'reveal clip');
describe('reveal clip on a stock material', clipped);

const deck = createCumulusDeck({
  maxMasses: 2,
  puffSizeFraction: 0.12,
  color: 0xffffff,
  name: 'dump',
  applyRevealClip: clip,
});
describeMeshes('cumulus deck', deck.object);
describeMeshes('cyclone spiral', createSpiral(clip).root);
describeMeshes('volcano plume', createPlume().root);
describeMeshes('lava flow', createLavaFlow().root);
describeMeshes('tornado', createFunnel(clip).root);

const workshop = createWorkshop();
describe('monster fur', workshop.lambert(0x888888, { furFrequency: 3 }));
describe('monster fur shell', workshop.shellMaterial(0x888888, 1, 4, 3));
describeMeshes('saucer bolts', createLaserPool().root);

describeMeshes('fire smoke', createFireSmoke().root);
describeMeshes('fire scar', createFireScar().root);
describeMeshes('fire ribbons', buildRibbonFlames().root);
describeMeshes('fire shader plume', buildShaderPlumeFlames().root);
describeMeshes('hydro puddles', createPuddles().root);
describe('relic gem', createGemMaterial(1));
describe('relic spire', createSpireMaterial(new Color(0xff0000)));

// The celestial void is not dumped: createCelestialVoid bakes its gas pattern through the
// renderer at construction, which needs a device.
