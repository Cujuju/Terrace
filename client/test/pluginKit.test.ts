// Contract tests for client/src/plugins/kit — the client half of the plugin
// kit. Abbreviated on purpose: each plugin keeps its own suite over its own
// payload, and what is asserted here is only what the kit itself promises.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoseInterpolator, type PoseSegment } from '../src/plugins/kit/interpolator.ts';
import { watchReducedMotion } from '../src/plugins/kit/reducedMotion.ts';
import { reconcileById } from '../src/plugins/kit/viewReconcile.ts';
import {
  PUFF_ALPHA_DISCARD_GLSL,
  PUFF_BILLBOARD_GLSL,
  PUFF_INSTANCE_BASE_GLSL,
  puffMaskGlsl,
} from '../src/plugins/kit/puffDeck.ts';

// ─── interpolator ────────────────────────────────────────────────────────────

/** A one-axis payload, standing in for any plugin's broadcast state. */
interface DemoState {
  readonly id: number;
  readonly x: number;
  readonly label: string;
}

interface DemoSegment extends PoseSegment {
  x: number;
}

interface DemoRecord {
  id: number;
  x: number;
  label: string;
}

function demoInterpolator(): PoseInterpolator<DemoState, DemoSegment, DemoRecord> {
  return new PoseInterpolator<DemoState, DemoSegment, DemoRecord>({
    minWindowSeconds: 1 / 60,
    maxWindowSeconds: 2,
    defaultWindowSeconds: 1,
    createSegment: () => ({ x: 0, generation: 0 }),
    freeze: (target, source) => {
      target.x = source.x;
    },
    createRecord: (state) => ({ ...state }),
    updateRecord: (record, state, segment, t) => {
      record.label = state.label;
      record.x = segment === undefined ? state.x : segment.x + (state.x - segment.x) * t;
    },
  });
}

describe('PoseInterpolator', () => {
  it('starts a first-seen id at the server pose, with nothing to walk from', () => {
    const interpolator = demoInterpolator();
    interpolator.receive([{ id: 1, x: 10, label: 'a' }]);
    expect(interpolator.sample().get(1)!.x).toBe(10);
  });

  it('walks from the rendered pose to the newest one over the window', () => {
    const interpolator = demoInterpolator();
    interpolator.receive([{ id: 1, x: 0, label: 'a' }]);
    interpolator.advance(1);
    interpolator.receive([{ id: 1, x: 10, label: 'a' }]);
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(0, 9);
    interpolator.advance(0.5);
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(5, 9);
    interpolator.advance(0.5);
    expect(interpolator.sample().get(1)!.x).toBe(10);
  });

  it('clamps at the end of the window rather than extrapolating', () => {
    const interpolator = demoInterpolator();
    interpolator.receive([{ id: 1, x: 0, label: 'a' }]);
    interpolator.advance(1);
    interpolator.receive([{ id: 1, x: 10, label: 'a' }]);
    interpolator.advance(50);
    expect(interpolator.sample().get(1)!.x).toBe(10);
    expect(interpolator.progress()).toBe(1);
  });

  it('measures the window from the inter-message gap, clamped to the bounds', () => {
    const interpolator = demoInterpolator();
    interpolator.receive([{ id: 1, x: 0, label: 'a' }]);
    interpolator.advance(0.5);
    interpolator.receive([{ id: 1, x: 10, label: 'a' }]);
    interpolator.advance(0.25);
    // Half the measured 0.5 s window has passed.
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(5, 9);
  });

  it('carries non-interpolated fields through untouched', () => {
    const interpolator = demoInterpolator();
    interpolator.receive([{ id: 1, x: 0, label: 'a' }]);
    interpolator.receive([{ id: 1, x: 0, label: 'b' }]);
    expect(interpolator.sample().get(1)!.label).toBe('b');
  });

  it('drops an id the newest message no longer lists', () => {
    const interpolator = demoInterpolator();
    interpolator.receive([
      { id: 1, x: 0, label: 'a' },
      { id: 2, x: 0, label: 'a' },
    ]);
    interpolator.receive([{ id: 1, x: 0, label: 'a' }]);
    expect(interpolator.sample().has(2)).toBe(false);
  });

  it('clear() forgets everything', () => {
    const interpolator = demoInterpolator();
    interpolator.receive([{ id: 1, x: 0, label: 'a' }]);
    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});

// ─── reduced motion ──────────────────────────────────────────────────────────

describe('watchReducedMotion', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reports "not reduced" where matchMedia does not exist (the node runner)', () => {
    const watch = watchReducedMotion();
    expect(watch.matches()).toBe(false);
    // stop() must be safe when there was nothing to listen to.
    watch.stop();
  });

  it('tracks the media query LIVE, and unsubscribes on stop', () => {
    let listener: ((event: { matches: boolean }) => void) | null = null;
    const removeEventListener = vi.fn();
    (globalThis as { window?: unknown }).window = {
      matchMedia: (query: string) => {
        expect(query).toBe('(prefers-reduced-motion: reduce)');
        return {
          matches: false,
          addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => {
            listener = fn;
          },
          removeEventListener,
        };
      },
    };

    const watch = watchReducedMotion();
    expect(watch.matches()).toBe(false);
    listener!({ matches: true });
    expect(watch.matches()).toBe(true);
    watch.stop();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});

// ─── view reconcile ──────────────────────────────────────────────────────────

describe('reconcileById', () => {
  it('acquires a view for every id that appeared', () => {
    const views = new Map<number, string>();
    reconcileById(new Map([[1, 'a']]), views, {
      acquire: (id) => `view${id}`,
      release: () => {},
    });
    expect([...views]).toEqual([[1, 'view1']]);
  });

  it('releases a view for every id that vanished', () => {
    const views = new Map<number, string>([[1, 'view1']]);
    const released: string[] = [];
    reconcileById(new Map<number, string>(), views, {
      acquire: (id) => `view${id}`,
      release: (_, view) => released.push(view),
    });
    expect(released).toEqual(['view1']);
    expect(views.size).toBe(0);
  });

  it('releases BEFORE it acquires when asked to, so a pooled view can be reused', () => {
    const order: string[] = [];
    const views = new Map<number, string>([[1, 'view1']]);
    reconcileById(new Map([[2, 'b']]), views, {
      order: 'release-first',
      acquire: (id) => {
        order.push(`acquire${id}`);
        return `view${id}`;
      },
      release: (id) => order.push(`release${id}`),
    });
    expect(order).toEqual(['release1', 'acquire2']);
  });

  it('acquires first by default', () => {
    const order: string[] = [];
    const views = new Map<number, string>([[1, 'view1']]);
    reconcileById(new Map([[2, 'b']]), views, {
      acquire: (id) => {
        order.push(`acquire${id}`);
        return `view${id}`;
      },
      release: (id) => order.push(`release${id}`),
    });
    expect(order).toEqual(['acquire2', 'release1']);
  });

  it('lets a live id REPLACE its view when the item says the body changed', () => {
    const views = new Map<number, string>([[1, 'old']]);
    reconcileById(new Map([[1, 'b']]), views, {
      acquire: () => 'fresh',
      release: () => {},
      replace: (_id, item, view) => (view === 'old' ? `rebuilt-${item}` : null),
    });
    expect(views.get(1)).toBe('rebuilt-b');
  });

  it('keeps the existing view when replace returns null', () => {
    const views = new Map<number, string>([[1, 'old']]);
    reconcileById(new Map([[1, 'b']]), views, {
      acquire: () => 'fresh',
      release: () => {},
      replace: () => null,
    });
    expect(views.get(1)).toBe('old');
  });
});

// ─── puff deck ───────────────────────────────────────────────────────────────

describe('puff deck GLSL', () => {
  it('offsets the vertex AFTER the view transform — that is the billboard', () => {
    expect(PUFF_BILLBOARD_GLSL).toContain('vec4 viewPosition = viewMatrix * vec4(world, 1.0);');
    expect(PUFF_BILLBOARD_GLSL).toContain('viewPosition.xy += position.xy * size;');
    expect(PUFF_BILLBOARD_GLSL).toContain('gl_Position = projectionMatrix * viewPosition;');
  });

  it('reads the instance matrix as a position only', () => {
    expect(PUFF_INSTANCE_BASE_GLSL).toContain('(instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz');
  });

  it('builds a radial mask that discards outside the quad, at the given inner edge', () => {
    expect(puffMaskGlsl('0.15')).toContain('smoothstep(0.15, 1.0, radius)');
    expect(puffMaskGlsl('0.0')).toContain('smoothstep(0.0, 1.0, radius)');
    expect(puffMaskGlsl('0.0')).toContain('if (puff <= 0.0) discard;');
  });

  it('discards a puff too faint to be worth blending', () => {
    expect(PUFF_ALPHA_DISCARD_GLSL).toContain('if (alpha <= 0.004) discard;');
  });
});
