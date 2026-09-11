import type { Backend } from 'three/webgpu';

interface BackendInternals {
  readonly capabilities: { getUniformBufferLimit(): number };
}

// three r185 reads this limit only to decide whether InstancedMesh matrices (and instance
// ranges) travel as a uniform buffer; zero sends them through instanced attributes.
const NO_UNIFORM_BUFFER_INSTANCING = 0;

// A uniform-buffered instance matrix re-uploads in full every frame, changed or not (#464
// bufferData on WebGL2, writeBuffer on WebGPU); instanced attributes upload on version.
export function routeInstancesThroughAttributes(backend: Backend): void {
  const internals = backend as unknown as BackendInternals;
  internals.capabilities.getUniformBufferLimit = () => NO_UNIFORM_BUFFER_INSTANCING;
}
