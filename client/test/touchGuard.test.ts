// The touch-dolly guard: the contract that OrbitControls is never shown a
// two-finger separation it can amplify into a zoom slam (owner bug
// 2026-08-19: a two-finger tap "reset the camera to a default location" —
// iOS touch coalescing collapsed the reported separation for one frame, and
// OrbitControls' unguarded `_dollyEnd.y / _dollyStart.y` ratio drove the
// orbit distance to its 900 clamp in one event; reproduced via CDP).
//
// The numbers in these tests mirror that reproduction: the 200px→1px step is
// the slam-to-max case, the sub-floor pair birth is the slam-to-min case.

import { describe, expect, it } from 'vitest';
import { createTouchDollyGuard } from '../src/input/cameraBindings.ts';
import {
  TOUCH_DOLLY_MAX_STEP_RATIO,
  TOUCH_DOLLY_MIN_SEPARATION_PX,
} from '../src/config.ts';

describe('createTouchDollyGuard', () => {
  it('passes an ordinary two-finger pair and its gentle moves', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    g.down(2, 220, 400);
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(2, 218, 400)).toBe('pass');
    expect(g.move(1, 102, 401)).toBe('pass');
  });

  it('marks a pair born under the merge floor degenerate and swallows its every move — even after it spreads', () => {
    const g = createTouchDollyGuard();
    g.down(1, 200, 400);
    g.down(2, 204, 400); // 4px apart: one coalesced contact, not a pinch
    expect(g.pairIsDegenerate()).toBe(true);
    expect(g.move(2, 206, 401)).toBe('swallow');
    // The re-split: fingers "reappear" far apart. This exact transition is
    // the min-clamp slam (0px → 30px reproduced distance 80 → 20); the pair
    // stays dead until it is re-formed by a lift and a fresh press.
    expect(g.move(2, 400, 400)).toBe('swallow');
  });

  it('swallows the reproduction case: separation collapsing 200px → 1px in one event, then passes the honest next frame', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    g.down(2, 300, 400); // 200px apart
    expect(g.pairIsDegenerate()).toBe(false);
    // The coalescing artifact frame (reproduced: distance 80 → 900).
    expect(g.move(1, 199, 400)).toBe('swallow'); // sep 1px vs accepted 200
    // Truth resumes: fingers really are still ~200 apart. Ratio vs the HELD
    // baseline is ~1, so motion is not lost — it passes immediately.
    expect(g.move(1, 101, 400)).toBe('pass');
  });

  it('swallows an implausible spread as its reciprocal', () => {
    const g = createTouchDollyGuard();
    g.down(1, 200, 400);
    g.down(2, 230, 400); // 30px: above the floor, legitimate
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(2, 430, 400)).toBe('swallow'); // 30 → 230: ratio ≈ 7.7
  });

  it('passes a genuinely fast pinch, each step inside the ratio bound', () => {
    const g = createTouchDollyGuard();
    g.down(1, 150, 400);
    g.down(2, 250, 400); // 100
    expect(g.move(2, 220, 400)).toBe('pass'); // 70: ratio 0.7
    expect(g.move(2, 199, 400)).toBe('pass'); // 49: ratio 0.7
    expect(g.move(2, 184, 400)).toBe('pass'); // 34: ratio ~0.69
  });

  it('swallows moves that dip under the floor mid-gesture but keeps the baseline for the recovery', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    g.down(2, 220, 400); // 120
    expect(g.move(2, 110, 400)).toBe('swallow'); // sep 10 < floor
    expect(g.move(2, 218, 400)).toBe('pass'); // back to 118: ratio 118/120
  });

  it('ignores pointers it never saw go down (mouse, HUD-born touches)', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    g.down(2, 220, 400);
    expect(g.move(99, 0, 0)).toBe('pass');
    // And the stray id did not disturb the tracked pair.
    expect(g.move(2, 218, 400)).toBe('pass');
  });

  it('stays out of one- and three-finger states, and re-judges the pair on a lift', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    expect(g.move(1, 150, 450)).toBe('pass'); // one finger: sculpt's business
    g.down(2, 220, 400);
    g.down(3, 160, 700);
    expect(g.move(3, 161, 701)).toBe('pass'); // three fingers: controls inert
    g.up(3);
    // Back to two: fresh baseline from current positions, guard live again.
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(2, 221, 400)).toBe('pass');
    // The artifact step: finger 2 collapses onto finger 1's position (1px
    // apart — under the floor), the coalescing shape.
    expect(g.move(2, 151, 450)).toBe('swallow');
  });

  it('lets a degenerate pair be replaced by a healthy one after a lift', () => {
    const g = createTouchDollyGuard();
    g.down(1, 200, 400);
    g.down(2, 210, 400); // 10px: degenerate
    expect(g.pairIsDegenerate()).toBe(true);
    g.up(2);
    g.down(3, 340, 400); // re-formed at 140px
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(3, 338, 400)).toBe('pass');
  });

  it('floor and ratio constants are wired, not shadowed', () => {
    // The guard's behaviour above must move if these move; pin the values the
    // scenarios were written against so a retune re-derives the fixtures.
    expect(TOUCH_DOLLY_MIN_SEPARATION_PX).toBe(24);
    expect(TOUCH_DOLLY_MAX_STEP_RATIO).toBe(1.5);
  });
});
