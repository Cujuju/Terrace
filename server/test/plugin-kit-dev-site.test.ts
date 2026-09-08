import { describe, expect, it } from 'vitest';
import { DEV_SEARCH_RADIUS_CELLS, DEV_SEARCH_STEP_CELLS } from '../src/plugins/kit/devSite.ts';

describe('dev force-spawn search reach', () => {
  it('steps in whole cells, coarsely enough to be a search and not a scan', () => {
    expect(Number.isInteger(DEV_SEARCH_STEP_CELLS)).toBe(true);
    expect(DEV_SEARCH_STEP_CELLS).toBeGreaterThan(0);
    expect(DEV_SEARCH_STEP_CELLS).toBeLessThan(DEV_SEARCH_RADIUS_CELLS);
  });
});
