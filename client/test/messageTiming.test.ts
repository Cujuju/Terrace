import { describe, expect, it } from 'vitest';
import { instrumentMessageListeners } from '../src/messageTiming.ts';

function fixture() {
  class Target extends EventTarget {}
  const costs: number[] = [];
  const restore = instrumentMessageListeners(() => 'message', (_key, ms) => costs.push(ms), Target.prototype);
  return { target: new Target(), restore, costs };
}

describe('instrumented message listener semantics', () => {
  it('deduplicates listeners and removes with the original identity and capture', () => {
    const { target, restore, costs } = fixture();
    let calls = 0;
    const listener = function (this: EventTarget): void { expect(this).toBe(target); calls++; };
    try {
      target.addEventListener('message', listener);
      target.addEventListener('message', listener);
      target.addEventListener('message', listener, true);
      target.dispatchEvent(new Event('message'));
      expect(calls).toBe(2);
      target.removeEventListener('message', listener, false);
      target.dispatchEvent(new Event('message'));
      expect(calls).toBe(3);
      target.removeEventListener('message', listener, { capture: true });
      target.dispatchEvent(new Event('message'));
      expect(calls).toBe(3);
      expect(costs).toHaveLength(3);
    } finally { restore(); }
  });

  it('preserves object receivers, once, abort and registration after once', () => {
    const { target, restore } = fixture();
    const listener = { calls: 0, handleEvent(): void { this.calls++; } };
    const aborted = new AbortController();
    try {
      target.addEventListener('message', listener, { once: true });
      target.dispatchEvent(new Event('message'));
      target.dispatchEvent(new Event('message'));
      expect(listener.calls).toBe(1);
      target.addEventListener('message', listener, { signal: aborted.signal });
      aborted.abort();
      target.dispatchEvent(new Event('message'));
      expect(listener.calls).toBe(1);
      target.addEventListener('message', listener);
      target.dispatchEvent(new Event('message'));
      expect(listener.calls).toBe(2);
      target.removeEventListener('message', listener);
    } finally { restore(); }
  });
});
