import type { Texture } from 'three';
import type { Renderer } from 'three/webgpu';
import { rendererBackendName } from './rendererBackend.ts';

// three's WebGPU backend re-uploads a whole texture on every needsUpdate and ignores
// update ranges, so a small edit to a large data texture costs the full image.

interface BackendTextureData {
  readonly texture?: GPUTexture;
}

interface WebGpuBackendInternals {
  readonly device?: GPUDevice;
  get(object: object): BackendTextureData;
}

export interface TextureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Writes `region` of the texture's own row-major `data` straight to its GPU texture.
 * False without a WebGPU texture yet: the caller falls back to `needsUpdate`.
 */
export function writeTextureRegion(
  renderer: Renderer,
  texture: Texture,
  data: Uint8Array,
  bytesPerTexel: number,
  rowTexels: number,
  region: TextureRegion,
): boolean {
  if (rendererBackendName(renderer) !== 'webgpu') return false;
  const backend = renderer.backend as unknown as WebGpuBackendInternals;
  const device = backend.device;
  const gpuTexture = backend.get(texture).texture;
  if (device === undefined || gpuTexture === undefined) return false;
  // Packed first: the browser stages every byte the source layout spans, whole rows included.
  const rowBytes = region.width * bytesPerTexel;
  const packed = new Uint8Array(rowBytes * region.height);
  for (let row = 0; row < region.height; row++) {
    const from = ((region.y + row) * rowTexels + region.x) * bytesPerTexel;
    packed.set(data.subarray(from, from + rowBytes), row * rowBytes);
  }
  device.queue.writeTexture(
    { texture: gpuTexture, origin: { x: region.x, y: region.y } },
    packed,
    { offset: 0, bytesPerRow: rowBytes, rowsPerImage: region.height },
    { width: region.width, height: region.height },
  );
  return true;
}
