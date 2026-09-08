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

export const WORLD_POSITION_VERTEX_GLSL = `vec4 tWorldPosition = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
        tWorldPosition = batchingMatrix * tWorldPosition;
    #endif
    #ifdef USE_INSTANCING
        tWorldPosition = instanceMatrix * tWorldPosition;
    #endif
    tWorldPosition = modelMatrix * tWorldPosition;`;

export const WORLD_POSITION_VERTEX_ANCHOR = '#include <project_vertex>';
