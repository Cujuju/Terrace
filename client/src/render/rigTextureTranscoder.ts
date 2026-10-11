import { LoadingManager } from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { WebGPURenderer } from 'three/webgpu';
import basisTranscoderScriptUrl from 'three/examples/jsm/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasmUrl from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url';
import { setRigTextureTranscoder } from './rigAsset.ts';

// KTX2Loader fetches these file names from its transcoder path; Vite emits them under hashed URLs.
const BASIS_TRANSCODER_URLS: ReadonlyMap<string, string> = new Map([
  ['basis_transcoder.js', basisTranscoderScriptUrl],
  ['basis_transcoder.wasm', basisTranscoderWasmUrl],
]);

let installed: KTX2Loader | null = null;

/** Enables KTX2 (Basis) rig textures; call after `await renderer.init()`. Returns the uninstaller. */
export function installRigTextureTranscoder(renderer: WebGPURenderer): () => void {
  if (installed !== null) {
    throw new Error('rigTextureTranscoder: a transcoder is already installed');
  }
  const manager = new LoadingManager();
  manager.setURLModifier(
    (url) => BASIS_TRANSCODER_URLS.get(url.slice(url.lastIndexOf('/') + 1)) ?? url,
  );
  const transcoder = new KTX2Loader(manager).detectSupport(renderer);
  installed = transcoder;
  setRigTextureTranscoder(transcoder);
  return () => {
    if (installed !== transcoder) return;
    setRigTextureTranscoder(null);
    transcoder.dispose();
    installed = null;
  };
}
