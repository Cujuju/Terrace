import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  type Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import {
  attribute,
  colorSpaceToWorking,
  diffuseColor,
  mix,
  positionGeometry,
  texture,
  vec2,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl';
import {
  COMPONENTS_PER_COLOR,
  // COMPONENTS_PER_NORMAL,
  VERTICES_PER_TRIANGLE,
  createChunkGeometryBuffers,
  type ChunkGeometryBuffers,
} from '../terrain/capEmission.ts';
import {
  LUT_VEC4_COUNT,
  buildBandLutBytes,
} from './gpuMesher/bandLut.ts';
import {
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  POSITION_Y_UNITS_PER_WORLD_UNIT,
  SNORM16_MAX,
  TERRAIN_KEY_ATTRIBUTE,
} from './gpuMesher/gpuChunkAnswer.ts';
import { compose } from './materialSlots.ts';
import { applyGroundShade } from './groundShade.ts';

const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

export type TerrainVertexLayout = 'float32' | 'snorm16';

// @types/three types the colour-space helpers as a bare Node; the decode is a vec3.
function srgbToWorking(node: Node<'vec3'>): Node<'vec3'> {
  return colorSpaceToWorking(node, SRGBColorSpace) as unknown as Node<'vec3'>;
}

// `rgba` holds sRGB bytes, self-lit flag in the alpha byte; the graph decodes them
// where the vertex splice used to.
function makeSelfLitAware(material: MeshStandardNodeMaterial, rgba: Node<'vec4'>): void {
  compose(material, 'color', (previous) => previous.mul(srgbToWorking(rgba.rgb)));
  compose(material, 'output', (previous) =>
    vec4(mix(previous.rgb, diffuseColor.rgb, rgba.a), previous.a),
  );
}

/** z and the band-LUT slot: the halves of the packed vertex's second word. */
function terrainKey(): Node<'vec2'> {
  return attribute(TERRAIN_KEY_ATTRIBUTE, 'vec2');
}

const BAND_LUT_TEXTURE_HEIGHT = 1;

/** Samples the middle of the single row, and the centre of the slot's own texel. */
const BAND_LUT_ROW_V = 0.5;
const BAND_LUT_TEXEL_CENTRE = 0.5;

// No colour space on the texture: the bytes are the sRGB bytes the CPU path stores in its
// colour attribute, and the graph decodes them with the same srgbToWorking below.
function createBandLutTexture(): DataTexture {
  const lut = new DataTexture(
    buildBandLutBytes(),
    LUT_VEC4_COUNT,
    BAND_LUT_TEXTURE_HEIGHT,
    RGBAFormat,
    UnsignedByteType,
  );
  lut.magFilter = NearestFilter;
  lut.minFilter = NearestFilter;
  lut.generateMipmaps = false;
  lut.needsUpdate = true;
  return lut;
}

// The slot rides the position's fourth component, so the colour costs no vertex bytes of
// its own; round recovers the integer the kernel wrote before it picks the texel.
function bandLutRgba(lut: DataTexture): Node<'vec4'> {
  const slot = terrainKey().y.mul(SNORM16_MAX).round();
  return texture(lut, vec2(slot.add(BAND_LUT_TEXEL_CENTRE).div(LUT_VEC4_COUNT), BAND_LUT_ROW_V));
}

// The hardware hands the shader `units / SNORM16_MAX`; round recovers the integer exactly,
// and the per-axis divisor turns it back into world units. z rides the second word.
function decodeSnorm16Position(material: MeshStandardNodeMaterial): void {
  compose(material, 'position', () =>
    vec3(positionGeometry.x, positionGeometry.y, terrainKey().x)
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
  if (layout === 'snorm16') {
    const lut = createBandLutTexture();
    material.addEventListener('dispose', () => { lut.dispose(); });
    decodeSnorm16Position(material);
    makeSelfLitAware(material, bandLutRgba(lut));
  } else {
    makeSelfLitAware(material, vertexColor());
  }
  applyGroundShade(material, 'terrain');
  return material;
}

export interface ArenaGeometry {
  readonly geometry: BufferGeometry;
  readonly positionAttribute: BufferAttribute;
  // readonly normalAttribute: BufferAttribute;
  readonly colorAttribute: BufferAttribute;
}

export function createArenaGeometry(buffers: ChunkGeometryBuffers): ArenaGeometry {
  const positionAttribute = new BufferAttribute(buffers.positions, 3);
  // const normalAttribute = new BufferAttribute(buffers.normals, COMPONENTS_PER_NORMAL, true);
  const colorAttribute = new BufferAttribute(buffers.colors, COMPONENTS_PER_COLOR, true);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  // geometry.setAttribute('normal', normalAttribute);
  geometry.setAttribute('color', colorAttribute);
  return { geometry, positionAttribute, /* normalAttribute, */ colorAttribute };
}

export interface PackedArenaGeometry {
  readonly geometry: BufferGeometry;
  /** What the GPU store injects its buffer into; both attributes read through it. */
  readonly vertexBuffer: InterleavedBuffer;
  readonly positionAttribute: InterleavedBufferAttribute;
  readonly keyAttribute: InterleavedBufferAttribute;
}

/** x, y, z and the band-LUT slot: four i16 halves, two whole words. */
const PACKED_VERTEX_COMPONENTS = 4;

/** Each attribute reads one word of the pair as snorm16x2. */
const PACKED_ATTRIBUTE_COMPONENTS = 2;

/** `position` takes x and y from the first word, `terrainKey` z and the slot from the second. */
const PACKED_POSITION_OFFSET = 0;
const PACKED_KEY_OFFSET = 2;

// @types/three marks `count` readonly; three writes it from the array length in the
// constructor and never again (InterleavedBuffer.js:48), so an empty array needs it set.
function setVertexCapacity(buffer: InterleavedBuffer, vertexCapacity: number): void {
  (buffer as { count: number }).count = vertexCapacity;
}

// The array stays empty: the GPU store injects the buffer three would otherwise allocate,
// and `count` is what three reads to clamp the draw range.
export function createPackedArenaGeometry(vertexCapacity: number): PackedArenaGeometry {
  const vertexBuffer = new InterleavedBuffer(new Int16Array(0), PACKED_VERTEX_COMPONENTS);
  setVertexCapacity(vertexBuffer, vertexCapacity);
  const positionAttribute = new InterleavedBufferAttribute(
    vertexBuffer,
    PACKED_ATTRIBUTE_COMPONENTS,
    PACKED_POSITION_OFFSET,
    true,
  );
  const keyAttribute = new InterleavedBufferAttribute(
    vertexBuffer,
    PACKED_ATTRIBUTE_COMPONENTS,
    PACKED_KEY_OFFSET,
    true,
  );

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute(TERRAIN_KEY_ATTRIBUTE, keyAttribute);
  return { geometry, vertexBuffer, positionAttribute, keyAttribute };
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
