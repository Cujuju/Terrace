import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimWorldHeaderAction,
  clearWorldHeaderAction,
  worldHeaderAction,
  type WorldHeaderAction,
} from '../src/plugins/hudPanels.ts';

function action(pluginName: string): WorldHeaderAction {
  return {
    pluginName,
    icon: () => null,
    label: `${pluginName} action`,
    onClick: () => undefined,
  };
}

afterEach(() => {
  clearWorldHeaderAction();
  vi.restoreAllMocks();
});

describe('world-header action registry', () => {
  it('starts unclaimed', () => {
    expect(worldHeaderAction()).toBeNull();
  });

  it('the first claim wins and is returned intact', () => {
    const first = action('chronicle');
    claimWorldHeaderAction(first);
    expect(worldHeaderAction()).toBe(first);
  });

  it('a second claim is ignored and warned about, naming both plugins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = action('chronicle');
    claimWorldHeaderAction(first);
    claimWorldHeaderAction(action('almanac'));
    expect(worldHeaderAction()).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('chronicle');
    expect(message).toContain('almanac');
  });

  it('clearing re-opens the claim (rejoin hygiene)', () => {
    claimWorldHeaderAction(action('chronicle'));
    clearWorldHeaderAction();
    expect(worldHeaderAction()).toBeNull();
    const second = action('almanac');
    claimWorldHeaderAction(second);
    expect(worldHeaderAction()).toBe(second);
  });
});
