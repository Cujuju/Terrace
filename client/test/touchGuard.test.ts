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
    g.down(2, 204, 400);
    expect(g.pairIsDegenerate()).toBe(true);
    expect(g.move(2, 206, 401)).toBe('swallow');
    expect(g.move(2, 400, 400)).toBe('swallow');
  });

  it('swallows the reproduction case: separation collapsing 200px → 1px in one event, then passes the honest next frame', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    g.down(2, 300, 400);
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(1, 199, 400)).toBe('swallow');
    expect(g.move(1, 101, 400)).toBe('pass');
  });

  it('swallows an implausible spread as its reciprocal', () => {
    const g = createTouchDollyGuard();
    g.down(1, 200, 400);
    g.down(2, 230, 400);
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(2, 430, 400)).toBe('swallow');
  });

  it('passes a genuinely fast pinch, each step inside the ratio bound', () => {
    const g = createTouchDollyGuard();
    g.down(1, 150, 400);
    g.down(2, 250, 400);
    expect(g.move(2, 220, 400)).toBe('pass');
    expect(g.move(2, 199, 400)).toBe('pass');
    expect(g.move(2, 184, 400)).toBe('pass');
  });

  it('swallows moves that dip under the floor mid-gesture but keeps the baseline for the recovery', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    g.down(2, 220, 400);
    expect(g.move(2, 110, 400)).toBe('swallow');
    expect(g.move(2, 218, 400)).toBe('pass');
  });

  it('ignores pointers it never saw go down (mouse, HUD-born touches)', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    g.down(2, 220, 400);
    expect(g.move(99, 0, 0)).toBe('pass');
    expect(g.move(2, 218, 400)).toBe('pass');
  });

  it('stays out of one- and three-finger states, and re-judges the pair on a lift', () => {
    const g = createTouchDollyGuard();
    g.down(1, 100, 400);
    expect(g.move(1, 150, 450)).toBe('pass');
    g.down(2, 220, 400);
    g.down(3, 160, 700);
    expect(g.move(3, 161, 701)).toBe('pass');
    g.up(3);
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(2, 221, 400)).toBe('pass');
    expect(g.move(2, 151, 450)).toBe('swallow');
  });

  it('lets a degenerate pair be replaced by a healthy one after a lift', () => {
    const g = createTouchDollyGuard();
    g.down(1, 200, 400);
    g.down(2, 210, 400);
    expect(g.pairIsDegenerate()).toBe(true);
    g.up(2);
    g.down(3, 340, 400);
    expect(g.pairIsDegenerate()).toBe(false);
    expect(g.move(3, 338, 400)).toBe('pass');
  });

  it('floor and ratio constants are wired, not shadowed', () => {
    expect(TOUCH_DOLLY_MIN_SEPARATION_PX).toBe(24);
    expect(TOUCH_DOLLY_MAX_STEP_RATIO).toBe(1.5);
  });
});
