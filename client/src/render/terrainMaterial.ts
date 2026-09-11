import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  type Group,
  Mesh,
  SRGBColorSpace,
} from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  colorSpaceToWorking,
  diffuseColor,
  mix,
  positionGeometry,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl';
import {
  COMPONENTS_PER_COLOR,
  COMPONENTS_PER_NORMAL,
  VERTICES_PER_TRIANGLE,
  createChunkGeometryBuffers,
  type ChunkGeometryBuffers,
} from '../terrain/capEmission.ts';
import {
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  POSITION_Y_UNITS_PER_WORLD_UNIT,
  SNORM16_MAX,
} from './gpuMesher/gpuChunkAnswer.ts';
import { compose } from './materialSlots.ts';
import { applyGroundShade } from './groundShade.ts';

const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

/** How the arena's vertex positions are stored: world-unit floats, or quantized i16 units. */
export type TerrainVertexLayout = 'float32' | 'snorm16';

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

// The hardware hands the shader `units / SNORM16_MAX`; round recovers the integer exactly,
// and the per-axis divisor turns it back into world units around the super-mesh centre.
function decodeSnorm16Position(material: MeshStandardNodeMaterial): void {
  compose(material, 'position', () =>
    positionGeometry
      .mul(SNORM16_MAX)
      .round()
      .mul(
        vec3(
          1 / POSITION_XZ_UNITS_PER_WORLD_UNIT,
          1 / POSITION_Y_UNITS_PER_WORLD_UNIT,
          1 / POSITION_XZ_UNITS_PER_WORLD_UNIT,
        ),
      ),
  );
}

export function createTerrainMaterial(
  layout: TerrainVertexLayout = 'float32',
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    flatShading: true,
    roughness: TERRAIN_ROUGHNESS,
    metalness: TERRAIN_METALNESS,
    side: DoubleSide,
  });
  if (layout === 'snorm16') decodeSnorm16Position(material);
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

export interface PackedArenaGeometry {
  readonly geometry: BufferGeometry;
  readonly positionAttribute: BufferAttribute;
  readonly colorAttribute: BufferAttribute;
}

/** x, y, z and a spare, so the packed vertex is two whole words. */
const PACKED_POSITION_COMPONENTS = 4;

// @types/three marks `count` readonly; three writes it from the array length in the
// constructor and never again (BufferAttribute.js:89), so an empty array needs it set.
function setVertexCapacity(attribute: BufferAttribute, vertexCapacity: number): void {
  (attribute as { count: number }).count = vertexCapacity;
}

// The arrays stay empty: the GPU store injects the buffer three would otherwise allocate,
// and `count` is what three reads to clamp the draw range.
export function createPackedArenaGeometry(vertexCapacity: number): PackedArenaGeometry {
  const positionAttribute = new BufferAttribute(
    new Int16Array(0),
    PACKED_POSITION_COMPONENTS,
    true,
  );
  const colorAttribute = new BufferAttribute(new Uint8Array(0), COMPONENTS_PER_COLOR, true);
  setVertexCapacity(positionAttribute, vertexCapacity);
  setVertexCapacity(colorAttribute, vertexCapacity);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('color', colorAttribute);
  return { geometry, positionAttribute, colorAttribute };
}

const WARM_UP_TRIANGLES = 0;

// A hidden mesh with the arena's attribute set. Inert on WebGPURenderer, which skips
// invisible objects in render and compileAsync alike (Renderer.js:3082).
export function warmTerrainMaterial(
  group: Group,
  material: MeshStandardNodeMaterial,
  layout: TerrainVertexLayout,
): Mesh {
  const { geometry } =
    layout === 'snorm16'
      ? createPackedArenaGeometry(WARM_UP_TRIANGLES * VERTICES_PER_TRIANGLE)
      : createArenaGeometry(createChunkGeometryBuffers(WARM_UP_TRIANGLES));
  const mesh = new Mesh(geometry, material);
  mesh.visible = false;
  group.add(mesh);
  return mesh;
}
