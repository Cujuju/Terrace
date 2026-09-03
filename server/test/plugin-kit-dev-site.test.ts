// Contract test for server/src/plugins/kit/devSite.ts — the reach a plugin's
// dev force-spawn searches for somewhere to put the thing it is forcing.
//
// WHAT IS UNDER TEST is the one thing storms' and mudslides' copies of these
// constants actually agreed on: how far out a forced site may be looked for,
// and that the step is a coarse whole number of cells. The SEARCHES themselves
// are not shared and are not tested here — see the module header for why.

import { describe, expect, it } from 'vitest';
import { DEV_SEARCH_RADIUS_CELLS, DEV_SEARCH_STEP_CELLS } from '../src/plugins/kit/devSite.ts';

describe('dev force-spawn search reach', () => {
  it('steps in whole cells, coarsely enough to be a search and not a scan', () => {
    expect(Number.isInteger(DEV_SEARCH_STEP_CELLS)).toBe(true);
    expect(DEV_SEARCH_STEP_CELLS).toBeGreaterThan(0);
    expect(DEV_SEARCH_STEP_CELLS).toBeLessThan(DEV_SEARCH_RADIUS_CELLS);
  });
});
