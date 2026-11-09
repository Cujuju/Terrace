import { afterEach, describe, expect, it } from 'vitest';
import { Group } from 'three';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/rain/client/index.ts';

afterEach(() => clientPlugin.dispose?.());

describe('rain audio across world generations', () => {
  it('zeros ambience synchronously on reset while visual frames remain held', () => {
    const frames: ((dt: number) => void)[] = [];
    const resets: (() => void)[] = [];
    const handlers = new Map<string, (payload: unknown) => void>();
    const weights: number[] = [];
    const ctx = {
      layer: new Group(),
      onFrame(handler: (dt: number) => void) { frames.push(handler); return () => {}; },
      onWorldReset(handler: () => void) { resets.push(handler); return () => {}; },
      onMessage(type: string, handler: (payload: unknown) => void) {
        handlers.set(type, handler); return () => {};
      },
      cameraPosition: () => ({ x: 0, y: 0, z: 0 }),
      publishGroundShade: () => () => {},
      publishGauge: () => () => {},
      applyRevealClip: () => {},
      audio: { preload: () => {}, ambience: (_url: string, weight: number) => weights.push(weight) },
    } as unknown as ClientPluginCtx;
    clientPlugin.attach(ctx);
    handlers.get('systems')?.({ systems: [{ id: 1, x: 0, y: 0, radius: 10, intensity: 1, vx: 0, vy: 0 }] });
    for (const frame of frames) frame(1 / 60);
    expect(weights.at(-1)).toBe(1);
    for (const reset of resets) reset();
    expect(weights.at(-1)).toBe(0);
  });
});
