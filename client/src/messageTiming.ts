/** Instruments message callbacks without changing native listener identity or dispatch semantics. */
export function instrumentMessageListeners(
  label: (target: EventTarget) => string,
  record: (key: string, elapsedMs: number) => void,
  prototype: EventTarget = EventTarget.prototype,
): () => void {
  const originalAdd = prototype.addEventListener;
  const originalRemove = prototype.removeEventListener;
  const listeners = new WeakMap<EventTarget, WeakMap<EventListenerOrEventListenerObject, EventListener>>();

  const add: typeof originalAdd = function (this: EventTarget, type, listener, options): void {
    if (type !== 'message' || listener === null) {
      originalAdd.call(this, type, listener, options);
      return;
    }
    let targetListeners = listeners.get(this);
    if (targetListeners === undefined) {
      targetListeners = new WeakMap();
      listeners.set(this, targetListeners);
    }
    let wrapped = targetListeners.get(listener);
    if (wrapped === undefined) {
      const key = label(this);
      wrapped = function (this: EventTarget, event): void {
        const started = performance.now();
        try {
          if (typeof listener === 'function') listener.call(this, event);
          else listener.handleEvent(event);
        } finally {
          record(key, performance.now() - started);
        }
      };
      targetListeners.set(listener, wrapped);
    }
    // Native add/remove still own capture, once, passive, signal and duplicate handling.
    originalAdd.call(this, type, wrapped, options);
  };
  const remove: typeof originalRemove = function (this: EventTarget, type, listener, options): void {
    const wrapped = listener === null ? undefined : listeners.get(this)?.get(listener);
    originalRemove.call(this, type, type === 'message' ? wrapped ?? listener : listener, options);
  };
  prototype.addEventListener = add;
  prototype.removeEventListener = remove;
  return () => {
    if (prototype.addEventListener === add) prototype.addEventListener = originalAdd;
    if (prototype.removeEventListener === remove) prototype.removeEventListener = originalRemove;
  };
}
