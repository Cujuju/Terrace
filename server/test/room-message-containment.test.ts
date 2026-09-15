import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LogThrottle,
  ROOM_FAILURE_LOG_INTERVAL_MS,
  containRoomMessage,
} from '../src/net/contain-message.ts';

const SCULPT = 'sculpt';

function throttle(): LogThrottle {
  return new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS);
}

function silenceErrors(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('containRoomMessage', () => {
  it('lets a healthy handler through and never reaches for its refusal', () => {
    const steps: string[] = [];
    containRoomMessage(SCULPT, throttle(), () => steps.push('ran'), () => steps.push('refused'));
    expect(steps).toEqual(['ran']);
  });

  it('swallows a throw and answers the sender with that handler\'s refusal', () => {
    silenceErrors();
    const steps: string[] = [];
    expect(() =>
      containRoomMessage(
        SCULPT,
        throttle(),
        () => {
          throw new Error('terrain engine fault');
        },
        () => steps.push('refused'),
      ),
    ).not.toThrow();
    expect(steps).toEqual(['refused']);
  });

  it('swallows a throw from the refusal itself', () => {
    silenceErrors();
    expect(() =>
      containRoomMessage(
        SCULPT,
        throttle(),
        () => {
          throw new Error('terrain engine fault');
        },
        () => {
          throw new Error('the socket is already closed');
        },
      ),
    ).not.toThrow();
  });

  it('still contains a handler that has no refusal to send', () => {
    silenceErrors();
    expect(() =>
      containRoomMessage(SCULPT, throttle(), () => {
        throw new Error('EIO');
      }),
    ).not.toThrow();
  });

  it('logs the first fault of an interval and stays quiet for the rest', () => {
    const logged = silenceErrors();
    const shared = throttle();
    const boom = (): never => {
      throw new Error('terrain engine fault');
    };

    containRoomMessage(SCULPT, shared, boom, undefined, 0);
    containRoomMessage(SCULPT, shared, boom, undefined, ROOM_FAILURE_LOG_INTERVAL_MS - 1);
    expect(logged).toHaveBeenCalledTimes(1);

    containRoomMessage(SCULPT, shared, boom, undefined, ROOM_FAILURE_LOG_INTERVAL_MS);
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it('refuses every fault even while the log is throttled', () => {
    silenceErrors();
    const shared = throttle();
    let refusals = 0;
    for (let i = 0; i < 5; i++) {
      containRoomMessage(
        SCULPT,
        shared,
        () => {
          throw new Error('terrain engine fault');
        },
        () => {
          refusals++;
        },
        0,
      );
    }
    expect(refusals).toBe(5);
  });

  it('gives each message type its own throttle, so one noisy type hides no other', () => {
    const logged = silenceErrors();
    const sculptLog = throttle();
    const rollbackLog = throttle();
    const boom = (): never => {
      throw new Error('EIO');
    };

    containRoomMessage(SCULPT, sculptLog, boom, undefined, 0);
    containRoomMessage('rollback', rollbackLog, boom, undefined, 0);
    expect(logged).toHaveBeenCalledTimes(2);
  });
});

describe('LogThrottle', () => {
  it('opens immediately, then once per its own interval', () => {
    const INTERVAL_MS = 250;
    const gate = new LogThrottle(INTERVAL_MS);

    expect(gate.due(0)).toBe(true);
    expect(gate.due(INTERVAL_MS - 1)).toBe(false);
    expect(gate.due(INTERVAL_MS)).toBe(true);
    expect(gate.due(INTERVAL_MS + 1)).toBe(false);
  });
});
