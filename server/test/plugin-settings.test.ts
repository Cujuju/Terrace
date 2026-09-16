import { describe, expect, it } from 'vitest';
import { resolveDeclaredSettings } from '../src/plugins/settings.ts';

const RENAMED = { key: 'damage', values: ['off', 'on'], defaultValue: 'on', formerKeys: ['surge'] };

describe('resolveDeclaredSettings', () => {
  it('carries a value stored under a former key to the renamed setting', () => {
    expect(resolveDeclaredSettings([RENAMED], { surge: 'off' })).toMatchObject({ damage: 'off' });
  });

  it('lets a row under the current key win over a former one', () => {
    expect(resolveDeclaredSettings([RENAMED], { surge: 'off', damage: 'on' }).damage).toBe('on');
  });

  it('passes undeclared rows through and leaves an unset setting unset', () => {
    const resolved = resolveDeclaredSettings([RENAMED], { frequency: 'rare' });
    expect(resolved).toEqual({ frequency: 'rare' });
  });
});
