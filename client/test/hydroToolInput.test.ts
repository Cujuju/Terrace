import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { ClientPluginCtx, ToolCell } from '../src/plugins/types.ts';
import { TOUCH_STROKE_GRACE_MS } from '../src/config.ts';
import { createToolInputRouter } from '../src/input/toolInput.ts';
import { controlBindings, setBinding } from '../src/state/controlPrefs.ts';
import { clientPlugin } from '../../plugins/hydro/client/index.ts';
import { HYDRO_POUR_MESSAGE } from '../../plugins/hydro/protocol.ts';

vi.mock('../../plugins/hydro/client/WaterIcon.tsx', () => ({ WaterIcon: () => null }));

const originalOrbit = { ...controlBindings().orbit };
const routers: Array<ReturnType<typeof createToolInputRouter>> = [];

function mountHydro() {
  vi.useFakeTimers();
  const callbacks: {
    frame?: (dt: number) => void;
    selected?: (selected: boolean) => void;
  } = {};
  let currentAim: ToolCell | null = null;
  let groundY: number | null = 2;
  const events = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: events },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
  }) as unknown as HTMLCanvasElement;
  const layer = new Group();
  const worldPicker = vi.fn(() => ({ x: 1, y: 1 }));
  const router = createToolInputRouter(canvas, { terrain: () => currentAim, world: worldPicker });
  routers.push(router);
  const send = vi.fn();
  const onCanvasPress = vi.fn();
  const ctx = {
    layer,
    send,
    onCanvasPress,
    pickWorldCell: worldPicker,
    drawnGroundYAt: () => groundY,
    publishGroundShade: () => () => {},
    registerTool: (tool) => { callbacks.selected = tool.onSelected; },
    bindToolInput: (options) => router.bind(options),
    onMessage: () => () => {},
    onTerrainChanged: () => () => {},
    onFrame: (handler) => { callbacks.frame = handler; return () => {}; },
  } satisfies Partial<ClientPluginCtx>;
  clientPlugin.attach(ctx as unknown as ClientPluginCtx);
  const marker = layer.getObjectByName('hydro:pour-marker')!;
  const fire = (type: string, patch: Partial<PointerEvent> = {}): PointerEvent => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100,
      button: 0, shiftKey: false, ctrlKey: false, altKey: false, ...patch,
    }) as PointerEvent;
    events.dispatchEvent(event);
    if (type === 'pointerdown') router.press(event);
    return event;
  };
  return {
    send, onCanvasPress, worldPicker, marker, fire,
    select: (selected: boolean) => callbacks.selected!(selected),
    frame: () => callbacks.frame!(0.1),
    aimAt: (cell: ToolCell | null) => { currentAim = cell; },
    groundAt: (height: number | null) => { groundY = height; },
  };
}

afterEach(() => {
  clientPlugin.dispose?.();
  for (const router of routers) router.dispose();
  routers.length = 0;
  setBinding('orbit', originalOrbit);
  vi.useRealTimers();
});

describe('Hydro with core tool input', () => {
  it('refreshes stationary-pointer terrain aim and commits that picker, including a missing hit', () => {
    const hydro = mountHydro();
    const first = { x: 80, y: 80 };
    const next = { x: 160, y: 160 };
    hydro.select(true);
    hydro.aimAt(first);
    hydro.fire('pointermove');
    hydro.frame();
    expect(hydro.marker.position.x).toBe(first.x * CELL_WORLD_SIZE);
    hydro.aimAt(next);
    hydro.frame();
    expect(hydro.marker.position.x).toBe(next.x * CELL_WORLD_SIZE);
    expect(hydro.marker.position.z).toBe(next.y * CELL_WORLD_SIZE);
    hydro.fire('pointerdown');
    expect(hydro.send).toHaveBeenCalledExactlyOnceWith(HYDRO_POUR_MESSAGE, next);
    hydro.fire('pointerup');

    hydro.aimAt(null);
    hydro.frame();
    expect(hydro.marker.visible).toBe(false);
    hydro.fire('pointerdown');
    expect(hydro.send).toHaveBeenCalledTimes(1);
    expect(hydro.onCanvasPress).not.toHaveBeenCalled();
    expect(hydro.worldPicker).not.toHaveBeenCalled();
  });

  it('passes a custom Alt+Left camera binding without pouring', () => {
    const hydro = mountHydro();
    setBinding('orbit', { button: 'left', modifier: 'alt' });
    hydro.select(true);
    hydro.aimAt({ x: 80, y: 80 });
    hydro.fire('pointermove');
    expect(hydro.fire('pointerdown', { altKey: true }).defaultPrevented).toBe(false);
    hydro.frame();
    expect(hydro.marker.visible).toBe(false);
    expect(hydro.send).not.toHaveBeenCalled();
  });

  it('lets both touch contacts propagate and cancels the pending pour', () => {
    const hydro = mountHydro();
    hydro.select(true);
    hydro.aimAt({ x: 80, y: 80 });
    const first = hydro.fire('pointerdown', { pointerType: 'touch' });
    expect(first.defaultPrevented).toBe(true);
    expect(first.cancelBubble).toBe(false);
    vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS - 1);
    expect(hydro.send).not.toHaveBeenCalled();
    const second = hydro.fire('pointerdown', { pointerType: 'touch', pointerId: 2 });
    expect(second.cancelBubble).toBe(false);
    vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS);
    hydro.fire('pointerup', { pointerType: 'touch', pointerId: 2 });
    hydro.fire('pointerup', { pointerType: 'touch' });
    expect(hydro.send).not.toHaveBeenCalled();
  });

  it('commits one short tap at the current terrain hit and cancels a pending tap on disposal', () => {
    const hydro = mountHydro();
    hydro.select(true);
    hydro.aimAt({ x: 80, y: 80 });
    hydro.fire('pointerdown', { pointerType: 'touch' });
    const release = { x: 160, y: 160 };
    hydro.aimAt(release);
    hydro.fire('pointerup', { pointerType: 'touch' });
    vi.runAllTimers();
    expect(hydro.send).toHaveBeenCalledExactlyOnceWith(HYDRO_POUR_MESSAGE, release);
    hydro.fire('pointerdown', { pointerType: 'touch' });
    clientPlugin.dispose?.();
    vi.runAllTimers();
    hydro.fire('pointerup', { pointerType: 'touch' });
    expect(hydro.send).toHaveBeenCalledTimes(1);
  });

  it('hides unknown ground and deselection prevents another pour', () => {
    const hydro = mountHydro();
    hydro.select(true);
    hydro.aimAt({ x: 80, y: 80 });
    hydro.fire('pointermove');
    hydro.frame();
    expect(hydro.marker.visible).toBe(true);
    hydro.groundAt(null);
    hydro.frame();
    expect(hydro.marker.visible).toBe(false);
    hydro.select(false);
    hydro.fire('pointerdown');
    expect(hydro.send).not.toHaveBeenCalled();
  });
});
