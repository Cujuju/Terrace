import { describe, expect, it, vi } from 'vitest';
import { Scene, Vector3 } from 'three';
import {
  GROUND_SHADE_MIN_SUN_Y,
  configureGroundShade,
  groundShadeAt,
  groundShadeMaxFor,
  groundShadeUniforms,
  type GroundShadeDisc,
} from '../src/render/groundShade.ts';
import { createClientPluginHost } from '../src/plugins/host.ts';
import type { TerraceClientPlugin } from '../src/plugins/types.ts';
import type { Viewport } from '../src/render/scene.ts';
import type { World } from '../src/world.ts';
import type { Connection } from '../src/net/connection.ts';

const SUN_OVERHEAD = { x: 0, y: 1, z: 0 };
const SUN_45_DEGREES = { x: 1, y: 1, z: 0 };

const DISC_HEIGHT = 10;
const DISC_RADIUS = 4;

function disc(over: Partial<GroundShadeDisc> = {}): GroundShadeDisc {
  return {
    x: 0,
    z: 0,
    y: DISC_HEIGHT,
    radius: DISC_RADIUS,
    darkness: 0.5,
    inner: 0,
    ...over,
  };
}

describe('groundShadeAt — the projection the shader runs', () => {
  it('is full darkness at the centre and zero past the rim', () => {
    const discs = [disc()];
    expect(groundShadeAt(0, 0, 0, SUN_OVERHEAD, discs)).toBeCloseTo(0.5, 10);
    expect(groundShadeAt(DISC_RADIUS, 0, 0, SUN_OVERHEAD, discs)).toBe(0);
    expect(groundShadeAt(DISC_RADIUS + 1, 0, 0, SUN_OVERHEAD, discs)).toBe(0);
  });

  it('falls off smoothly between the rim and the centre', () => {
    const discs = [disc()];
    const half = groundShadeAt(DISC_RADIUS / 2, 0, 0, SUN_OVERHEAD, discs);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(0.5);
  });

  it('holds full darkness inside `inner` before the falloff begins', () => {
    const discs = [disc({ inner: 0.5 })];
    expect(groundShadeAt(0, 0, 0, SUN_OVERHEAD, discs)).toBeCloseTo(0.5, 10);
    expect(
      groundShadeAt(DISC_RADIUS * 0.5, 0, 0, SUN_OVERHEAD, discs),
    ).toBeCloseTo(0.5, 10);
    expect(groundShadeAt(DISC_RADIUS * 0.75, 0, 0, SUN_OVERHEAD, discs)).toBeLessThan(0.5);
  });

  it('displaces the shadow along the sun, by the disc height over the sun slope', () => {
    const discs = [disc()];
    expect(groundShadeAt(0, 0, 0, SUN_45_DEGREES, discs)).toBe(0);
    expect(groundShadeAt(-DISC_HEIGHT, 0, 0, SUN_45_DEGREES, discs)).toBeCloseTo(0.5, 10);
  });

  it('measures the drop from the fragment, not from sea level', () => {
    const discs = [disc()];
    const hilltopY = DISC_HEIGHT / 2;
    expect(
      groundShadeAt(-hilltopY, hilltopY, 0, SUN_45_DEGREES, discs),
    ).toBeCloseTo(0.5, 10);
  });

  it('takes the darkest disc, never the sum', () => {
    const discs = [disc({ darkness: 0.2 }), disc({ darkness: 0.45 })];
    expect(groundShadeAt(0, 0, 0, SUN_OVERHEAD, discs)).toBeCloseTo(0.45, 10);
  });

  it('is zero with no discs at all', () => {
    expect(groundShadeAt(0, 0, 0, SUN_OVERHEAD, [])).toBe(0);
  });

  it('is zero at and below GROUND_SHADE_MIN_SUN_Y, on either side of the horizon', () => {
    const discs = [disc()];
    const grazing = { x: Math.sqrt(1 - GROUND_SHADE_MIN_SUN_Y ** 2), y: GROUND_SHADE_MIN_SUN_Y, z: 0 };
    expect(groundShadeAt(0, 0, 0, grazing, discs)).toBe(0);
    expect(groundShadeAt(0, 0, 0, { x: 1, y: 0, z: 0 }, discs)).toBe(0);
    expect(groundShadeAt(0, 0, 0, { x: 0, y: -1, z: 0 }, discs)).toBe(0);
  });

  it('is unchanged by the length of the sun vector', () => {
    const discs = [disc()];
    expect(groundShadeAt(-DISC_HEIGHT, 0, 0, { x: 7, y: 7, z: 0 }, discs)).toBeCloseTo(
      groundShadeAt(-DISC_HEIGHT, 0, 0, SUN_45_DEGREES, discs),
      10,
    );
  });
});

describe('groundShadeMaxFor — the uniform array bound', () => {
  it('is the sum of the declared budgets', () => {
    expect(groundShadeMaxFor([{ groundShadeBudget: 7 }, { groundShadeBudget: 3 }])).toBe(10);
  });

  it('ignores plugins that publish no shade', () => {
    expect(
      groundShadeMaxFor([{ groundShadeBudget: 2 }, {}, { groundShadeBudget: undefined }]),
    ).toBe(2);
  });

  it('is at least 1, because GLSL forbids a zero-length array', () => {
    expect(groundShadeMaxFor([])).toBe(1);
    expect(groundShadeMaxFor([{ groundShadeBudget: 0 }])).toBe(1);
  });

  it('leaves a non-finite budget out rather than poisoning the total', () => {
    const missing = Number.NaN;
    expect(groundShadeMaxFor([{ groundShadeBudget: 4 }, { groundShadeBudget: missing }])).toBe(4);
  });
});

function stubViewport() {
  const scene = new Scene();
  const listeners = new Set<() => void>();
  return {
    viewport: {
      scene,
      renderer: {
        domElement: { addEventListener: () => undefined, removeEventListener: () => undefined },
        info: { render: { calls: 0 } },
      },
      lighting: { sun: { position: new Vector3(0, 1, 0) } },
      onFrame: (handler: () => void) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    } as unknown as Viewport,
    frame: (): void => {
      for (const handler of listeners) handler();
    },
  };
}

const stubWorld = {
  worldSize: () => 0,
  terrainHeightAt: () => null,
  drawnGroundYAt: () => null,
  pickCell: () => null,
  revealedAt: () => false,
  applyRevealClip: () => undefined,
  revealClipUniforms: () => null,
} as unknown as World;

function publisher(
  name: string,
  budget: number | undefined,
  count: number,
): TerraceClientPlugin {
  const discs = Array.from({ length: count }, (_unused, i) => disc({ x: i }));
  return {
    name,
    drawBudget: 0,
    groundShadeBudget: budget,
    attach(ctx) {
      ctx.publishGroundShade(() => discs);
    },
  };
}

function rig(...plugins: readonly TerraceClientPlugin[]) {
  const view = stubViewport();
  const host = createClientPluginHost(plugins, {
    viewport: view.viewport,
    world: stubWorld,
    connection: () => ({}) as unknown as Connection,
    coreDrawBudget: () => 0,
  });
  return { host, frame: view.frame };
}

describe('the host gathering ground-shade discs', () => {
  it('takes every disc a plugin publishes within its budget', () => {
    configureGroundShade(groundShadeMaxFor([{ groundShadeBudget: 3 }]));
    const { frame } = rig(publisher('alpha', 3, 3));
    frame();
    expect(groundShadeUniforms().uShadeCount.value).toBe(3);
  });

  it('drops the excess and logs ONE line, rather than throwing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureGroundShade(groundShadeMaxFor([{ groundShadeBudget: 2 }]));
    const { frame } = rig(publisher('beta', 2, 5));

    expect(() => {
      frame();
      frame();
    }).not.toThrow();

    expect(groundShadeUniforms().uShadeCount.value).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain('beta');
    expect(message).toContain('5');
    expect(message).toContain('2');
    error.mockRestore();
  });

  it('treats a plugin that declared no budget as publishing nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureGroundShade(groundShadeMaxFor([{ groundShadeBudget: 4 }]));
    const { frame } = rig(publisher('gamma', undefined, 2));
    frame();
    expect(groundShadeUniforms().uShadeCount.value).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('publishes nothing at all when no plugin publishes', () => {
    configureGroundShade(groundShadeMaxFor([]));
    const { frame } = rig({ name: 'quiet', drawBudget: 0, attach: () => undefined });
    frame();
    expect(groundShadeUniforms().uShadeCount.value).toBe(0);
  });
});
