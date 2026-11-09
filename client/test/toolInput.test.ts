import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOUCH_STROKE_GRACE_MS } from '../src/config.ts';
import { createToolInputRouter } from '../src/input/toolInput.ts';
import type { ToolCell } from '../src/plugins/types.ts';
import { controlBindings, setBinding } from '../src/state/controlPrefs.ts';

const originalOrbit = { ...controlBindings().orbit };
afterEach(() => { setBinding('orbit', originalOrbit); vi.useRealTimers(); });

function fixture(pick: 'terrain' | 'world' = 'world') {
  vi.useFakeTimers();
  const events = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: events },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
  }) as unknown as HTMLCanvasElement;
  let visible: ToolCell | null = { x: 4, y: 8 };
  let active = true;
  const terrain = vi.fn(() => visible);
  const world = vi.fn(() => visible);
  const presses: (ToolCell | null)[] = [];
  const router = createToolInputRouter(canvas, { terrain, world });
  const input = router.bind({ active: () => active, pick, onPress: (cell) => presses.push(cell) });
  const fire = (type: string, patch: Record<string, unknown> = {}): PointerEvent => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100,
      button: 0, shiftKey: false, ctrlKey: false, altKey: false, ...patch,
    }) as PointerEvent;
    events.dispatchEvent(event);
    if (type === 'pointerdown') router.press(event);
    return event;
  };
  return { input, router, fire, presses, terrain, world,
    visible: (cell: ToolCell | null) => { visible = cell; }, active: (value: boolean) => { active = value; } };
}

describe('logical tool input', () => {
  it.each(['terrain', 'world'] as const)('uses the selected %s picker for current hover and commit', (pick) => {
    const f = fixture(pick);
    try {
      f.fire('pointermove');
      expect(f.input.aim()).toEqual({ x: 4, y: 8 });
      f.visible({ x: 7, y: 9 });
      expect(f.input.aim()).toEqual({ x: 7, y: 9 });
      f.fire('pointerdown');
      expect(f.presses).toEqual([{ x: 7, y: 9 }]);
      expect(pick === 'terrain' ? f.world : f.terrain).not.toHaveBeenCalled();
    } finally { f.router.dispose(); }
  });

  it('passes a custom Alt+Left camera gesture without claiming or spending', () => {
    const f = fixture();
    setBinding('orbit', { button: 'left', modifier: 'alt' });
    try {
      expect(f.fire('pointerdown', { altKey: true }).defaultPrevented).toBe(false);
      expect(f.presses).toEqual([]);
      expect(f.input.aim()).toBeNull();
    } finally { f.router.dispose(); }
  });

  it('defers touch to the existing grace; both fingers propagate and cancel the pending press', () => {
    const f = fixture();
    try {
      const first = f.fire('pointerdown', { pointerType: 'touch' });
      expect(first.defaultPrevented).toBe(true);
      expect(first.cancelBubble).toBe(false);
      vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS - 1);
      expect(f.presses).toEqual([]);
      f.fire('pointerdown', { pointerType: 'touch', pointerId: 2 });
      vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS);
      f.fire('pointerup', { pointerType: 'touch', pointerId: 2 });
      f.fire('pointerup', { pointerType: 'touch' });
      expect(f.presses).toEqual([]);
    } finally { f.router.dispose(); }
  });

  it('commits a short single-finger tap on release, using its current ray', () => {
    const f = fixture('terrain');
    try {
      f.fire('pointerdown', { pointerType: 'touch' });
      f.visible({ x: 9, y: 10 });
      f.fire('pointerup', { pointerType: 'touch' });
      vi.runAllTimers();
      expect(f.presses).toEqual([{ x: 9, y: 10 }]);
    } finally { f.router.dispose(); }
  });

  it('commits a held single touch once and cancels on deselection, cancel, blur and disposal', () => {
    const f = fixture();
    f.fire('pointerdown', { pointerType: 'touch' });
    vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS);
    f.fire('pointerup', { pointerType: 'touch' });
    expect(f.presses).toHaveLength(1);
    for (const cancellation of ['pointercancel', 'blur', 'deselect', 'dispose']) {
      f.fire('pointerdown', { pointerType: 'touch' });
      if (cancellation === 'deselect') f.active(false);
      else if (cancellation === 'dispose') f.input.dispose();
      else f.fire(cancellation, { pointerType: 'touch' });
      vi.advanceTimersByTime(TOUCH_STROKE_GRACE_MS);
      f.fire('pointerup', { pointerType: 'touch' });
      f.active(true);
    }
    expect(f.presses).toHaveLength(1);
    f.router.dispose();
  });
});
