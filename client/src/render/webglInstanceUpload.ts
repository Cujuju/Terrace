import type { Backend } from 'three/webgpu';

interface BackendInternals {
  readonly isWebGLBackend?: boolean;
  readonly capabilities: { getUniformBufferLimit(): number };
}

// three r185 reads this limit only to decide whether InstancedMesh matrices (and instance
// ranges) travel as a uniform buffer; zero sends them through instanced attributes.
const NO_UNIFORM_BUFFER_INSTANCING = 0;

// On the WebGL2 backend a uniform-buffered instance matrix is re-specified with bufferData every
// frame, changed or not (#464); instanced attributes upload only when their version moves.
export function routeInstancesThroughAttributes(backend: Backend): void {
  const internals = backend as unknown as BackendInternals;
  if (internals.isWebGLBackend !== true) return;
  internals.capabilities.getUniformBufferLimit = () => NO_UNIFORM_BUFFER_INSTANCING;
}
