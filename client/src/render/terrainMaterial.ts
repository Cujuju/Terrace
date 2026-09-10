import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  type Group,
  Mesh,
  SRGBColorSpace,
} from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { colorSpaceToWorking, diffuseColor, mix, vec4, vertexColor } from 'three/tsl';
import {
  COMPONENTS_PER_COLOR,
  COMPONENTS_PER_NORMAL,
  createChunkGeometryBuffers,
  type ChunkGeometryBuffers,
} from '../terrain/capEmission.ts';
import { compose } from './materialSlots.ts';
import { applyGroundShade } from './groundShade.ts';

const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

// @types/three types the colour-space helpers as a bare Node; the decode is a vec3.
function srgbToWorking(node: Node<'vec3'>): Node<'vec3'> {
  return colorSpaceToWorking(node, SRGBColorSpace) as unknown as Node<'vec3'>;
}

// The colour attribute holds sRGB bytes, self-lit flag in the alpha byte; the graph
// decodes them where the vertex splice used to.
function makeSelfLitAware(material: MeshStandardNodeMaterial): void {
  compose(material, 'color', (previous) => previous.mul(srgbToWorking(vertexColor().rgb)));
  compose(material, 'output', (previous) =>
    vec4(mix(previous.rgb, diffuseColor.rgb, vertexColor().a), previous.a),
  );
}

export function createTerrainMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    flatShading: true,
    roughness: TERRAIN_ROUGHNESS,
    metalness: TERRAIN_METALNESS,
    side: DoubleSide,
  });
  makeSelfLitAware(material);
  applyGroundShade(material, 'terrain');
  return material;
}

export interface ArenaGeometry {
  readonly geometry: BufferGeometry;
  readonly positionAttribute: BufferAttribute;
  readonly normalAttribute: BufferAttribute;
  readonly colorAttribute: BufferAttribute;
}

export function createArenaGeometry(buffers: ChunkGeometryBuffers): ArenaGeometry {
  const positionAttribute = new BufferAttribute(buffers.positions, 3);
  const normalAttribute = new BufferAttribute(buffers.normals, COMPONENTS_PER_NORMAL, true);
  const colorAttribute = new BufferAttribute(buffers.colors, COMPONENTS_PER_COLOR, true);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('normal', normalAttribute);
  geometry.setAttribute('color', colorAttribute);
  return { geometry, positionAttribute, normalAttribute, colorAttribute };
}

const WARM_UP_TRIANGLES = 0;

// A hidden mesh with the arena's attribute set. Inert on WebGPURenderer, which skips
// invisible objects in render and compileAsync alike (Renderer.js:3082).
export function warmTerrainMaterial(group: Group, material: MeshStandardNodeMaterial): Mesh {
  const { geometry } = createArenaGeometry(createChunkGeometryBuffers(WARM_UP_TRIANGLES));
  const mesh = new Mesh(geometry, material);
  mesh.visible = false;
  group.add(mesh);
  return mesh;
}
