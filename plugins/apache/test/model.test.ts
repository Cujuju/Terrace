import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { Group } from 'three';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { readAsset } from './fixtures.ts';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/apache.glb?url')) return { url: 'apache-test:url', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'apache-test:url') return { format: 'module', source: 'export default "apache.glb";', shortCircuit: true };
    return next(url, context);
  },
});
const { preloadApache, releaseApache, createApache } = await import('../client/model.ts');
hooks.deregister();

test('the shipped aircraft fits the complete-rotor envelope; an oversized pivot is rejected and released', async () => {
  for (const file of ['apache.glb', 'apache-high.glb']) {
    const asset = readAsset(new URL(`../../../client/src/assets/apache/${file}`, import.meta.url));
    const mount = new AbortController();
    const ctx = { signal: mount.signal, loadRigAsset: async () => asset } as unknown as ClientPluginCtx;
    await preloadApache(ctx);
    mount.abort();
    releaseApache();
  }
  const oversized = readAsset(new URL('../../../client/src/assets/apache/apache.glb', import.meta.url));
  oversized.node('main_rotor_pivot').position.y = 1;
  let disposed = false;
  const dispose = oversized.dispose;
  oversized.dispose = () => { disposed = true; dispose(); };
  await assert.rejects(preloadApache({ signal: new AbortController().signal,
    loadRigAsset: async () => oversized } as unknown as ClientPluginCtx), /clearance envelope/);
  assert.ok(disposed);
  releaseApache();
});

test('a canceled aircraft preload cannot replace or release its mounted replacement', async () => {
  const old = new AbortController(), current = new AbortController();
  const assetUrl = new URL('../../../client/src/assets/apache/apache.glb', import.meta.url);
  const a = readAsset(assetUrl), b = readAsset(assetUrl);
  let disposedA = 0, disposedB = 0;
  const disposeA = a.dispose, disposeB = b.dispose;
  a.dispose = () => { disposedA++; disposeA(); };
  b.dispose = () => { disposedB++; disposeB(); };
  let resolveOld!: (asset: typeof a) => void;
  const first = preloadApache({ signal: old.signal,
    loadRigAsset: () => new Promise((resolve) => { resolveOld = resolve; }) } as unknown as ClientPluginCtx);
  old.abort();
  const ctx = { signal: current.signal, layer: new Group(), loadRigAsset: async () => b,
    applyRevealClip() {}, requestShaderWarmup() {} } as unknown as ClientPluginCtx;
  await preloadApache(ctx);
  const model = createApache(ctx);
  resolveOld(a);
  await first;
  assert.equal(disposedA, 1);
  assert.equal(disposedB, 0);
  model.dispose();
  releaseApache();
  assert.equal(disposedB, 1);
});
