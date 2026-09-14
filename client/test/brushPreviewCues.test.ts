import { describe, expect, it } from 'vitest';
import { Line, LineSegments, Mesh, Scene, type Material } from 'three';
import { BRUSH_RADII } from '../src/state/hudState.ts';
import { createBrushPreview, type BrushSelection } from '../src/render/brushPreview.ts';
import {
  DENIED_COLOR,
  OFFLINE_COLOR,
  createDenialCue,
} from '../src/render/denialCue.ts';

const WORLD_SIZE = 64;

function fakeCanvas(): {
  on: boolean;
  classList: { toggle(token: string, force: boolean): void };
} {
  const surface = {
    on: false,
    classList: {
      toggle(_token: string, force: boolean): void {
        surface.on = force;
      },
    },
  };
  return surface;
}

function ringOf(scene: Scene): Line {
  const found = scene.children.find(
    (c): c is Line => c instanceof Line && !(c instanceof LineSegments),
  );
  if (!found) throw new Error('brush ring missing');
  return found;
}

function skirtOf(scene: Scene): Mesh {
  const found = scene.children.find((c): c is Mesh => c instanceof Mesh);
  if (!found) throw new Error('brush skirt missing');
  return found;
}

function segmentsOf(scene: Scene): { cellGrid: LineSegments; crosshair: LineSegments } {
  const segments = scene.children.filter(
    (c): c is LineSegments => c instanceof LineSegments,
  );
  if (segments.length !== 2) throw new Error(`expected 2 segments, saw ${segments.length}`);
  const cellGrid = segments.find(
    (s) => (s.material as Material).clippingPlanes !== null,
  );
  const crosshair = segments.find(
    (s) => (s.material as Material).clippingPlanes === null,
  );
  if (!cellGrid || !crosshair) throw new Error('cell grid / crosshair missing');
  return { cellGrid, crosshair };
}

function colorOf(object: { material: unknown }): number {
  const material = object.material as { color: { getHex(): number } };
  return material.color.getHex();
}

function opacityOf(object: { material: unknown }): number {
  const material = object.material as { opacity: number };
  return material.opacity;
}

const HOVER = { x: 8, y: 8, surfaceY: 0, face: 'tread', grabbable: false } as const;
const BRUSH: BrushSelection = {
  radius: BRUSH_RADII[0]!,
  tool: 'stamp',
  profile: 'hard',
  dir: 1,
};

describe('lane E: brush preview cue states', () => {
  it('refused renders red', () => {
    const scene = new Scene();
    const preview = createBrushPreview(
      scene,
      fakeCanvas(),
      () => WORLD_SIZE,
      createDenialCue(() => true),
    );
    preview.update(HOVER, BRUSH);
    expect(colorOf(ringOf(scene))).toBe(DENIED_COLOR);
    expect(colorOf(skirtOf(scene))).toBe(DENIED_COLOR);
    preview.dispose();
  });

  it('offline renders grey hollow and never red', () => {
    const denial = createDenialCue(() => true, { offline: () => true });
    expect(denial.isRed()).toBe(false);
    const scene = new Scene();
    const preview = createBrushPreview(scene, fakeCanvas(), () => WORLD_SIZE, denial);
    preview.update(HOVER, BRUSH);
    const { cellGrid, crosshair } = segmentsOf(scene);
    expect(colorOf(ringOf(scene))).toBe(OFFLINE_COLOR);
    expect(colorOf(crosshair)).toBe(OFFLINE_COLOR);
    // Hollow: the ring stays, the skirt fill and cell grid go.
    expect(ringOf(scene).visible).toBe(true);
    expect(skirtOf(scene).visible).toBe(false);
    expect(cellGrid.visible).toBe(false);
    expect(crosshair.visible).toBe(true);
    preview.dispose();
  });

  it('ghost renders hollow and dimmed', () => {
    const scene = new Scene();
    const preview = createBrushPreview(
      scene,
      fakeCanvas(),
      () => WORLD_SIZE,
      createDenialCue(() => false, { ghost: () => true }),
    );
    preview.update(HOVER, BRUSH);
    const { cellGrid, crosshair } = segmentsOf(scene);
    expect(ringOf(scene).visible).toBe(true);
    expect(skirtOf(scene).visible).toBe(false);
    expect(cellGrid.visible).toBe(false);
    expect(crosshair.visible).toBe(true);
    expect(opacityOf(ringOf(scene))).toBeLessThan(0.45);
    preview.dispose();
  });

  it('flat renders the crosshair mark only', () => {
    const scene = new Scene();
    const preview = createBrushPreview(
      scene,
      fakeCanvas(),
      () => WORLD_SIZE,
      createDenialCue(() => false, { flat: () => true }),
    );
    preview.update(HOVER, BRUSH);
    const { cellGrid, crosshair } = segmentsOf(scene);
    expect(ringOf(scene).visible).toBe(false);
    expect(skirtOf(scene).visible).toBe(false);
    expect(cellGrid.visible).toBe(false);
    expect(crosshair.visible).toBe(true);
    preview.dispose();
  });

  it('no cue renders the full footprint', () => {
    const scene = new Scene();
    const preview = createBrushPreview(
      scene,
      fakeCanvas(),
      () => WORLD_SIZE,
      createDenialCue(() => false),
    );
    preview.update(HOVER, BRUSH);
    const { cellGrid, crosshair } = segmentsOf(scene);
    expect(ringOf(scene).visible).toBe(true);
    expect(skirtOf(scene).visible).toBe(true);
    expect(cellGrid.visible).toBe(true);
    expect(crosshair.visible).toBe(true);
    preview.dispose();
  });

  it('drag keeps the radius outline up on both faces, tinted by face', () => {
    const scene = new Scene();
    const preview = createBrushPreview(
      scene,
      fakeCanvas(),
      () => WORLD_SIZE,
      createDenialCue(() => false),
    );
    const drag: BrushSelection = {
      radius: BRUSH_RADII[0]!,
      tool: 'drag',
      profile: 'hard',
      dir: 1,
    };
    // The old path hid the ring for drag/carve (crosshair only); the outline
    // must stay up so the brush never bounces away at a face flip.
    preview.update({ ...HOVER, face: 'riser' }, drag);
    expect(ringOf(scene).visible).toBe(true);
    expect(skirtOf(scene).visible).toBe(true);
    expect(colorOf(ringOf(scene))).toBe(0xffb347);
    preview.update(HOVER, drag);
    expect(ringOf(scene).visible).toBe(true);
    expect(colorOf(ringOf(scene))).toBe(0xffffff);
    preview.dispose();
  });
});
