import type { IUniform, Material } from 'three';

export function spliceShader(
  source: string,
  anchor: string,
  replacement: string,
  materialLabel: string,
): string {
  if (!source.includes(anchor)) {
    throw new Error(
      `${materialLabel} shader patch failed: three no longer emits "${anchor}". ` +
        `Re-anchor the patch at its call site.`,
    );
  }
  return source.replace(anchor, replacement);
}

export function glslFloat(value: number): string {
  return value.toFixed(6);
}

const SHADER_COMMON_ANCHOR = '#include <common>';

const WORLD_POSITION_VERTEX_ANCHOR = '#include <project_vertex>';

/** Left behind so the next effect appends after `world`, not before it. */
const WORLD_POSITION_MARKER = '// terrace world position';

const WORLD_POSITION_VERTEX_GLSL = `vec4 tWorldPosition = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
        tWorldPosition = batchingMatrix * tWorldPosition;
    #endif
    #ifdef USE_INSTANCING
        tWorldPosition = instanceMatrix * tWorldPosition;
    #endif
    tWorldPosition = modelMatrix * tWorldPosition;
    vec3 world = tWorldPosition.xyz;`;

export type ShaderInsertion = 'before' | 'after';

/**
 * One effect spliced onto a stock three material. The host owns the world
 * position, the declaration site and the program cache key, so effects stack.
 */
export interface ShaderEffect {
  readonly key: string;
  readonly label: string;
  readonly uniforms: Readonly<Record<string, IUniform>>;
  /** Read at compile time, so a value fixed at boot is still current. */
  declarations(): string;
  /** Runs where `world` is in scope; null when the effect needs no position. */
  readonly worldPositionVertexGlsl: string | null;
  readonly fragmentAnchor: string;
  readonly fragmentGlsl: string;
  readonly fragmentInsertion: ShaderInsertion;
}

function declareIn(source: string, declarations: string, label: string): string {
  return spliceShader(
    source,
    SHADER_COMMON_ANCHOR,
    `${SHADER_COMMON_ANCHOR}\n${declarations}`,
    label,
  );
}

function withWorldPosition(vertexShader: string, glsl: string, label: string): string {
  const source = vertexShader.includes(WORLD_POSITION_MARKER)
    ? vertexShader
    : spliceShader(
        vertexShader,
        WORLD_POSITION_VERTEX_ANCHOR,
        [
          WORLD_POSITION_VERTEX_ANCHOR,
          WORLD_POSITION_VERTEX_GLSL,
          WORLD_POSITION_MARKER,
        ].join('\n    '),
        label,
      );
  return spliceShader(
    source,
    WORLD_POSITION_MARKER,
    `${glsl}\n    ${WORLD_POSITION_MARKER}`,
    label,
  );
}

export function applyShaderEffect(material: Material, effect: ShaderEffect): void {
  const previousCompile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    Object.assign(shader.uniforms, effect.uniforms);
    const declarations = effect.declarations();
    let vertexShader = declareIn(shader.vertexShader, declarations, effect.label);
    if (effect.worldPositionVertexGlsl !== null) {
      vertexShader = withWorldPosition(
        vertexShader,
        effect.worldPositionVertexGlsl,
        effect.label,
      );
    }
    shader.vertexShader = vertexShader;
    shader.fragmentShader = spliceShader(
      declareIn(shader.fragmentShader, declarations, effect.label),
      effect.fragmentAnchor,
      effect.fragmentInsertion === 'before'
        ? `${effect.fragmentGlsl}\n    ${effect.fragmentAnchor}`
        : `${effect.fragmentAnchor}\n    ${effect.fragmentGlsl}`,
      effect.label,
    );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|${effect.key}`;
  material.needsUpdate = true;
}
