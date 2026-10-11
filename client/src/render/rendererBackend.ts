import type { Renderer } from 'three/webgpu';

export type RendererBackendName = 'webgpu' | 'webgl2';

/** WebGPURenderer falls back to WebGL2 silently; the backend flag is the only witness. */
export function rendererBackendName(renderer: Renderer): RendererBackendName {
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  return backend.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}
