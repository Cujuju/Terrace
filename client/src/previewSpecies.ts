import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CircleGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { backgroundRadiance } from './render/skyEnvironment.ts';
import { bakeRig } from './render/rigSkin.ts';
import { loadRigAsset } from './render/rigAsset.ts';
import { createRigHerd } from './render/rigHerd.ts';
import { MOVER_GAITS, moverGaitIndex, type MoverGait } from './plugins/kit/moverGait.ts';
import type { SpeciesModelBuilder, SpeciesModelPool } from '../../plugins/wildlife/client/species/speciesModel.ts';
import { buildFish } from '../../plugins/wildlife/client/species/fish.ts';
import { installSpeciesAsset } from '../../plugins/wildlife/client/species/assetSpecies.ts';
import { SPECIES_ASSETS } from '../../plugins/wildlife/client/species/assets.ts';
import { buildGrazer } from '../../plugins/wildlife/client/species/grazer.ts';
import { buildWolf } from '../../plugins/wildlife/client/species/wolf.ts';
import { buildIbex } from '../../plugins/wildlife/client/species/ibex.ts';
import { buildBison } from '../../plugins/wildlife/client/species/bison.ts';
import { buildRay } from '../../plugins/wildlife/client/species/ray.ts';
import { buildShark } from '../../plugins/wildlife/client/species/shark.ts';
import { buildEel } from '../../plugins/wildlife/client/species/eel.ts';
import { buildAngelfish } from '../../plugins/wildlife/client/species/angelfish.ts';
import { buildHumpback } from '../../plugins/wildlife/client/species/humpback.ts';
import { buildBlueWhale } from '../../plugins/wildlife/client/species/blueWhale.ts';
import { buildSpermWhale } from '../../plugins/wildlife/client/species/spermWhale.ts';
import { buildDeepsea } from '../../plugins/wildlife/client/species/deepsea.ts';

const BUILDERS: Readonly<Record<string, SpeciesModelBuilder>> = {
  fish: buildFish,
  grazer: buildGrazer,
  wolf: buildWolf,
  ibex: buildIbex,
  bison: buildBison,
  ray: buildRay,
  shark: buildShark,
  eel: buildEel,
  angelfish: buildAngelfish,
  'whale-humpback': buildHumpback,
  'whale-blue': buildBlueWhale,
  'whale-sperm': buildSpermWhale,
  deepsea: buildDeepsea,
};

const SKY_COLOR = 0x9fc7e8;
const GROUND_BOUNCE_COLOR = 0x9a948a;
const HEMISPHERE_LIGHT_INTENSITY = 1.5;
const SUN_LIGHT_INTENSITY = 1.2;
const AMBIENT_FLOOR_INTENSITY = 0.9;
const SUN_DIRECTION = new Vector3(0.7, 0.45, 0.55);
const TONE_MAPPING_EXPOSURE = 1.25;
const CAMERA_FOV_DEGREES = 55;
const BACKDROP_COLOR = 0x808080;
const GROUND_COLOR = 0x6c6c6c;
const GROUND_RADIUS = 4;
const CAMERA_FRAMING_PADDING = 1.25;
const SETTLE_FRAME_COUNT = 3;
const POSE_SLOTS = 32;

const CAMERA_VIEWS = {
  iso: new Vector3(0.6, 0.45, 0.85),
  side: new Vector3(0.05, 0.12, 1),
  top: new Vector3(0.05, 1, 0.35),
  front: new Vector3(1, 0.25, 0.2),
  right: new Vector3(0.05, 0.12, -1),
  bottom: new Vector3(0.05, -1, 0.35),
} as const;
type CameraView = keyof typeof CAMERA_VIEWS;

function readGait(query: URLSearchParams): MoverGait {
  const named = query.get('gait');
  return MOVER_GAITS.find((gait) => gait === named) ?? 'walk';
}

function buildScene(): { scene: Scene; camera: PerspectiveCamera; renderer: WebGPURenderer; ground: Mesh } {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const scene = new Scene();
  const ground = new Mesh(new CircleGeometry(GROUND_RADIUS, 32), new MeshLambertMaterial({ color: GROUND_COLOR }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new HemisphereLight(SKY_COLOR, GROUND_BOUNCE_COLOR, HEMISPHERE_LIGHT_INTENSITY));
  scene.add(new AmbientLight(0xffffff, AMBIENT_FLOOR_INTENSITY));
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(20);
  scene.add(sun);
  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, window.innerWidth / window.innerHeight, 0.05, 100);
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  scene.background = backgroundRadiance(BACKDROP_COLOR, renderer);
  renderer.outputColorSpace = SRGBColorSpace;
  return { scene, camera, renderer, ground };
}

let ZOOM = 1;
function frameCameraOn(camera: PerspectiveCamera, drawn: Object3D, view: CameraView): void {
  const box = new Box3().setFromObject(drawn);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  const verticalFovRadians = (CAMERA_FOV_DEGREES * Math.PI) / 180;
  const distance = (radius * CAMERA_FRAMING_PADDING) / Math.sin(verticalFovRadians / 2) / ZOOM;
  const direction = CAMERA_VIEWS[view].clone().normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

async function installAssets(): Promise<void> {
  for (const { spec, url } of SPECIES_ASSETS) {
    installSpeciesAsset(spec, await loadRigAsset(url, null));
  }
}

async function main(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const species = query.get('species') ?? 'fish';
  const viewName = query.get('view') ?? 'iso';
  const view: CameraView = viewName in CAMERA_VIEWS ? (viewName as CameraView) : 'iso';
  const seconds = Number.parseFloat(query.get('t') ?? '0') || 0;
  const phase = Number.parseFloat(query.get('phase') ?? '0') || 0;
  const gait = readGait(query);
  const scale = Number.parseFloat(query.get('scale') ?? '1') || 1;
  const zoom = Number.parseFloat(query.get('zoom') ?? '1') || 1;
  const build = BUILDERS[species] ?? buildFish;

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const pool: SpeciesModelPool = {
    keepGeometry(geometry) { geometries.push(geometry); return geometry; },
    lambert(color, options = {}) {
      const m = new MeshLambertMaterial({ color, flatShading: options.flatShading ?? true });
      materials.push(m);
      return m;
    },
    unlit(color) { const m = new MeshBasicMaterial({ color }); materials.push(m); return m; },
    part(geometry, material, x, y, z) { const mesh = new Mesh(geometry, material); mesh.position.set(x, y, z); return mesh; },
    rigged() { const root = new Group(); const rig = new Group(); root.add(rig); return { root, rig }; },
  };

  const authored = build(pool);
  const blueprint = bakeRig(authored.root);
  const jointIndices: Record<string, number> = {};
  for (const [name, node] of Object.entries(authored.joints)) jointIndices[name] = blueprint.jointIndex(node);
  const herd = createRigHerd(blueprint, {
    capacity: 1,
    poseSlots: POSE_SLOTS,
    poseVariants: MOVER_GAITS.length,
  });
  const joints: Record<string, import('three').Bone> = {};
  for (const [name, index] of Object.entries(jointIndices)) joints[name] = herd.joints[index]!;

  let triangles = 0;
  for (const mesh of herd.meshes) {
    const g = (mesh as Mesh).geometry;
    const idx = g.getIndex();
    triangles += (idx ? idx.count : g.getAttribute('position').count) / 3;
  }

  const { scene, camera, renderer, ground } = buildScene();
  await renderer.init();
  const group = new Group();
  for (const object of herd.meshes) group.add(object);
  scene.add(group);

  herd.beginFrame();
  const slot = herd.poseSlotOf(phase, moverGaitIndex(gait));
  authored.animate(joints, seconds, herd.poseSlotPhase(slot), gait);
  herd.capturePose(slot);
  herd.place(slot, 0, 0, 0, 0, scale);
  herd.endFrame();

  authored.root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(authored.root);
  const bounds = new Group();
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  ground.position.y = Math.min(0, box.min.y * scale - 0.02);
  bounds.position.copy(centre).multiplyScalar(scale);
  const probe = new Mesh(new CircleGeometry(Math.max(size.x, size.y, size.z) * scale * 0.5, 4));
  probe.visible = false;
  bounds.add(probe);
  scene.add(bounds);
  ZOOM = zoom;
  frameCameraOn(camera, bounds, view);

  (window as unknown as { __previewStats: unknown }).__previewStats = {
    triangles,
    surfaces: herd.meshes.length,
    instances: (herd.meshes[0] as any).count,
    bounds: { min: box.min.toArray(), max: box.max.toArray() },
  };

  let framesRendered = 0;
  function renderFrame(): void {
    renderer.render(scene, camera);
    framesRendered++;
    if (framesRendered < SETTLE_FRAME_COUNT) requestAnimationFrame(renderFrame);
    else (window as unknown as { __previewReady: boolean }).__previewReady = true;
  }
  requestAnimationFrame(renderFrame);
}

void installAssets().then(main);
