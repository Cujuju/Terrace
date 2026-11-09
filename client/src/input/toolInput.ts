import { TOUCH_STROKE_GRACE_MS } from '../config.ts';
import { cameraPressVerb } from './cameraPointerLock.ts';
import type { ToolCell, ToolInput, ToolInputOptions } from '../plugins/types.ts';
type Picker = (clientX: number, clientY: number) => ToolCell | null;

/** Primary tools share sculpt's touch grace, while OrbitControls still sees every touch. */
export function createToolInputRouter(
  canvas: HTMLCanvasElement,
  pickers: Record<ToolInputOptions['pick'], Picker>,
) {
  const bindings = new Set<ToolInputOptions>();
  const touches = new Set<number>();
  const cameraPointers = new Set<number>();
  let events: Window | null = null;
  let pointer: { x: number; y: number } | null = null;
  let multiTouch = false;
  let disposed = false;
  let pending: { binding: ToolInputOptions; id: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

  const cancel = (): void => {
    if (pending !== null && pending.timer !== null) clearTimeout(pending.timer);
    pending = null;
  };
  const reset = (): void => {
    cancel();
    pointer = null;
    multiTouch = touches.size > 0;
  };
  const forget = (): void => {
    reset();
    touches.clear();
    cameraPointers.clear();
    multiTouch = false;
  };
  const remember = (event: PointerEvent): void => {
    pointer = { x: event.clientX, y: event.clientY };
  };
  const aim = (binding: ToolInputOptions): ToolCell | null => {
    if (!bindings.has(binding) || !binding.active() || pointer === null || multiTouch || cameraPointers.size > 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (pointer.x < rect.left || pointer.x > rect.right || pointer.y < rect.top || pointer.y > rect.bottom) return null;
    return pickers[binding.pick](pointer.x, pointer.y);
  };
  const commit = (binding: ToolInputOptions): void => {
    if (!bindings.has(binding) || !binding.active() || multiTouch || cameraPointers.size > 0) return;
    try {
      binding.onPress(aim(binding));
    } catch (error) {
      console.error('[terrace] plugin tool-press handler threw', error);
    }
  };
  const onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      touches.add(event.pointerId);
      if (touches.size > 1) {
        multiTouch = true;
        cancel();
      }
    } else if (cameraPressVerb(event.button, event) !== null) {
      cameraPointers.add(event.pointerId);
      cancel();
    }
  };
  const onMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || event.pointerId === pending?.id) remember(event);
  };
  const onEnd = (event: PointerEvent): void => {
    if (event.pointerId === pending?.id) {
      remember(event);
      if (event.type === 'pointerup' && pending.timer !== null) commit(pending.binding);
      cancel();
    }
    cameraPointers.delete(event.pointerId);
    if (event.pointerType !== 'touch') return;
    touches.delete(event.pointerId);
    if (touches.size === 0) {
      multiTouch = false;
      pointer = null;
    }
  };
  const onLeave = (): void => { if (pending === null) pointer = null; };
  const listen = (): void => {
    if (events !== null) return;
    events = canvas.ownerDocument.defaultView;
    if (events === null) throw new Error('Tool input requires a window');
    events.addEventListener('pointerdown', onDown, true);
    events.addEventListener('pointermove', onMove, true);
    events.addEventListener('pointerup', onEnd, true);
    events.addEventListener('pointercancel', onEnd, true);
    events.addEventListener('blur', forget);
    canvas.addEventListener('pointerleave', onLeave);
  };

  return {
    bind(binding: ToolInputOptions): ToolInput {
      if (disposed) throw new Error('Tool input router is disposed');
      listen();
      bindings.add(binding);
      return {
        aim: () => aim(binding),
        dispose(): void {
          bindings.delete(binding);
          if (pending?.binding === binding) cancel();
        },
      };
    },
    press(event: PointerEvent): boolean {
      if (disposed || event.defaultPrevented) return false;
      if (event.pointerType !== 'touch' && (event.button !== 0 || cameraPressVerb(event.button, event) !== null)) return false;
      if (cameraPointers.size > 0) return false;
      const binding = [...bindings].find((entry) => entry.active());
      if (binding === undefined) return false;
      remember(event);
      event.preventDefault();
      if (event.pointerType === 'touch') {
        // Prevent sculpt, not propagation: OrbitControls must track both fingers for its existing camera gesture.
        if (!multiTouch && touches.size === 1) {
          cancel();
          pending = { binding, id: event.pointerId, timer: setTimeout(() => {
            if (pending?.binding !== binding || pending.id !== event.pointerId) return;
            pending.timer = null;
            commit(binding);
          }, TOUCH_STROKE_GRACE_MS) };
        }
      } else commit(binding);
      return true;
    },
    reset,
    dispose(): void {
      disposed = true;
      forget();
      bindings.clear();
      events?.removeEventListener('pointerdown', onDown, true);
      events?.removeEventListener('pointermove', onMove, true);
      events?.removeEventListener('pointerup', onEnd, true);
      events?.removeEventListener('pointercancel', onEnd, true);
      events?.removeEventListener('blur', forget);
      canvas.removeEventListener('pointerleave', onLeave);
      events = null;
    },
  };
}
