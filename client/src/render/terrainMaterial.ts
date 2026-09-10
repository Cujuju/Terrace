import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  type Group,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import {
  COMPONENTS_PER_COLOR,
  COMPONENTS_PER_NORMAL,
  createChunkGeometryBuffers,
  type ChunkGeometryBuffers,
} from '../terrain/capEmission.ts';
import { spliceShader } from './shaderSplice.ts';
import { applyGroundShade } from './groundShade.ts';

const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

export const SELF_LIT_ATTRIBUTE = 'selfLit';

function makeSelfLitAware(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        '#include <common>',
        `#include <common>\nattribute float ${SELF_LIT_ATTRIBUTE};\nvarying float vSelfLit;`,
        'terrain',
      ),
      '#include <begin_vertex>',
      `vSelfLit = ${SELF_LIT_ATTRIBUTE};\n#include <begin_vertex>`,
      'terrain',
    );
    shader.vertexShader = spliceShader(
      shader.vertexShader,
      '#include <color_vertex>',
      `#include <color_vertex>
      vColor.rgb = mix(
        vColor.rgb / 12.92,
        pow( ( vColor.rgb + 0.055 ) / 1.055, vec3( 2.4 ) ),
        step( vec3( 0.04045 ), vColor.rgb )
      );`,
      'terrain',
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        '#include <common>',
        '#include <common>\nvarying float vSelfLit;',
        'terrain',
      ),
      '#include <opaque_fragment>',
      'outgoingLight = mix( outgoingLight, diffuseColor.rgb, vSelfLit );\n#include <opaque_fragment>',
      'terrain',
    );
  };
}

export function createTerrainMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
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
  readonly selfLitAttribute: BufferAttribute;
}

export function createArenaGeometry(buffers: ChunkGeometryBuffers): ArenaGeometry {
  const positionAttribute = new BufferAttribute(buffers.positions, 3);
  const normalAttribute = new BufferAttribute(buffers.normals, COMPONENTS_PER_NORMAL, true);
  const colorAttribute = new BufferAttribute(buffers.colors, COMPONENTS_PER_COLOR, true);
  const selfLitAttribute = new BufferAttribute(buffers.selfLit, 1, true);
  positionAttribute.setUsage(DynamicDrawUsage);
  normalAttribute.setUsage(DynamicDrawUsage);
  colorAttribute.setUsage(DynamicDrawUsage);
  selfLitAttribute.setUsage(DynamicDrawUsage);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('normal', normalAttribute);
  geometry.setAttribute('color', colorAttribute);
  geometry.setAttribute(SELF_LIT_ATTRIBUTE, selfLitAttribute);
  return { geometry, positionAttribute, normalAttribute, colorAttribute, selfLitAttribute };
}

const WARM_UP_TRIANGLES = 0;

// A hidden mesh with the arena's attribute set puts the exact program in the scene from boot,
// so the pre-frame link batch compiles it instead of the first terrain frame.
export function warmTerrainMaterial(group: Group, material: MeshStandardMaterial): Mesh {
  const { geometry } = createArenaGeometry(createChunkGeometryBuffers(WARM_UP_TRIANGLES));
  const mesh = new Mesh(geometry, material);
  mesh.visible = false;
  group.add(mesh);
  return mesh;
}
