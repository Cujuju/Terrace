import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoseInterpolator, type PoseSegment } from '../src/plugins/kit/interpolator.ts';
import { watchReducedMotion } from '../src/plugins/kit/reducedMotion.ts';
import { reconcileById } from '../src/plugins/kit/viewReconcile.ts';
import { Matrix4 } from 'three';
import { float, mat4, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import {
  puffAlphaDiscard,
  puffBillboard,
  puffInstanceBase,
  puffMask,
} from '../src/plugins/kit/puffDeck.ts';

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

describe('watchReducedMotion', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reports "not reduced" where matchMedia does not exist (the node runner)', () => {
    const watch = watchReducedMotion();
    expect(watch.matches()).toBe(false);
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

interface GraphEntry {
  readonly type: string;
  readonly op?: string;
  readonly value?: unknown;
  readonly method?: string;
  readonly components?: string;
}

function graphOf(node: Node): { root: string; nodes: readonly GraphEntry[] } {
  const json = node.toJSON() as { type: string; nodes?: GraphEntry[] };
  return { root: json.type, nodes: json.nodes ?? [] };
}

function has(node: Node, entry: GraphEntry): boolean {
  return graphOf(node).nodes.some((candidate) =>
    Object.entries(entry).every(
      ([key, value]) => JSON.stringify(candidate[key as keyof GraphEntry]) === JSON.stringify(value),
    ),
  );
}

describe('puff deck nodes', () => {
  it('offsets the vertex AFTER the view transform — that is the billboard', () => {
    const billboard = puffBillboard(vec3(1, 2, 3), float(2));
    expect(graphOf(billboard).root).toBe('SplitNode');
    expect(has(billboard, { type: 'OperatorNode', op: '+' })).toBe(true);
    expect(has(billboard, { type: 'SplitNode', components: 'xy' })).toBe(true);
    expect(has(billboard, { type: 'SplitNode', components: 'zw' })).toBe(true);
    expect(has(billboard, { type: 'ConstNode', value: 2 })).toBe(true);
  });

  it('reads the instance matrix as a position only', () => {
    const base = puffInstanceBase(mat4(new Matrix4()));
    expect(graphOf(base).root).toBe('SplitNode');
    expect(has(base, { type: 'OperatorNode', op: '*' })).toBe(true);
    expect(has(base, { type: 'ConstNode', value: [0, 0, 0, 1] })).toBe(true);
  });

  it('builds a radial mask that discards outside the quad, at the given inner edge', () => {
    const inner = puffMask(0.15);
    expect(has(inner.puff, { type: 'MathNode', method: 'smoothstep' })).toBe(true);
    expect(has(inner.puff, { type: 'ConstNode', value: 0.15 })).toBe(true);
    expect(has(puffMask(0).puff, { type: 'ConstNode', value: 0 })).toBe(true);
    expect(has(inner.discarded, { type: 'OperatorNode', op: '<=' })).toBe(true);
  });

  it('discards a puff too faint to be worth blending', () => {
    const discarded = puffAlphaDiscard(float(1));
    expect(has(discarded, { type: 'OperatorNode', op: '<=' })).toBe(true);
    expect(has(discarded, { type: 'ConstNode', value: 0.004 })).toBe(true);
  });
});
