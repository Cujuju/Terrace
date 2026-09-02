// Pins the CONTRACT added 2026-08-19 for the reported bug: "the animals/
// wildlife on the terrestrial side are traveling across the map with no
// regard for separate levels … a four-legged thing walk[s] across the slope
// of ten-plus terrace layers like it's nothing."
//
// These tests build a minimal hand-made HabitatWorld directly — no real
// World, no plugin host — so they exercise exactly the predicate
// (census.ts's canTraverse) and the two call sites (movement.ts's
// steerToValidHeading and advanceEntity) that decide whether a step crosses
// a slope too steep to walk. That is the contract; which file happens to
// call it is an implementation detail these tests do not depend on.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, DEEP_WATER_MAX_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { type HabitatWorld, canTraverse } from '../server/census.ts';
import { advanceEntity, lookaheadCellsFor, speedOf, steerToValidHeading } from '../server/movement.ts';
import type { WildlifeEntity } from '../server/population.ts';
import { AQUATIC_MAX_GRADIENT_PER_CELL, GRAZER_MAX_GRADIENT_PER_CELL } from '../server/species.ts';

/**
 * A world whose height is a pure function of x (uniform along y), unlocked
 * and in-bounds everywhere out to `worldSize`. That is enough to express a
 * terrace riser (a step in `heightAt(x, *)`) without pulling in real terrain
 * generation, and the y-invariance is what makes "turn along the terrace"
 * observable: a heading with no x component never changes height at all.
 */
function fakeWorld(heightAtX: (x: number) => number, worldSize = 40): HabitatWorld {
  return {
    worldSize,
    chunksPerEdge: 1,
    heightAt: (x) => heightAtX(x),
    isChunkUnlocked: () => true,
    isCellUnlocked: () => true,
  };
}

/** A land riser at x=10: flat at `belowHeight` for x<10, `aboveHeight` at x>=10. */
function riserWorld(riseUnits: number): HabitatWorld {
  const belowHeight = SEA_LEVEL + BAND_HEIGHT;
  return fakeWorld((x) => (x < 10 ? belowHeight : belowHeight + riseUnits));
}

function grazer(x: number, y: number, overrides: Partial<WildlifeEntity> = {}): WildlifeEntity {
  return {
    id: 1,
    species: 'grazer',
    schoolId: 1,
    size: 'medium',
    // Born moving, like every spawned creature (population.ts). Required on
    // WildlifeEntity since the idle bouts landed (2026-09-02); the grazer
    // declares no bouts, so nothing can ever set it.
    idle: false,
    x,
    y,
    heading: 0,
    fleeSecondsRemaining: 0,
    ...overrides,
  };
}

describe('gradient-limited traversal (canTraverse)', () => {
  it('rejects a grazer riser step that exceeds GRAZER_MAX_GRADIENT_PER_CELL', () => {
    // A riser one unit steeper than the limit, concentrated in a single cell
    // step (x=9 → x=10) — exactly the "ten-plus terrace layers" shape from
    // the bug report, minimised to one.
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL + 1);
    expect(canTraverse(world, 'grazer', 9.5, 5, 10.5, 5)).toBe(false);
  });

  it('accepts a grazer ramp step at exactly the limit', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL);
    expect(canTraverse(world, 'grazer', 9.5, 5, 10.5, 5)).toBe(true);
  });

  it('rejects a mid-path riser even when both endpoints share a height (case e)', () => {
    // x=0 and x=2 are the SAME height; the drop is entirely inside the
    // segment, at x=1. An endpoint-only check would see identical heights at
    // both ends and wave this through — the bug this plugin must not have.
    const plateauHeight = SEA_LEVEL + BAND_HEIGHT;
    const gorgeHeight = plateauHeight - (GRAZER_MAX_GRADIENT_PER_CELL + 1);
    const world = fakeWorld((x) => (x >= 1 && x < 2 ? gorgeHeight : plateauHeight));
    expect(canTraverse(world, 'grazer', 0.5, 5, 2.5, 5)).toBe(false);
  });

  it('is unconstrained for aquatic species regardless of gradient', () => {
    expect(AQUATIC_MAX_GRADIENT_PER_CELL).toBe(Infinity);
    // Both endpoints sit inside the SAME habitat band (shallow — see
    // species.ts's habitatOf), but the seabed between them drops by far more
    // than any land species would ever be allowed to cross. Irrelevant to a
    // fish or whale: canTraverse only reasons about gradient, never habitat.
    const shallowFloor = SEA_LEVEL - 10;
    const world = fakeWorld((x) => (x < 10 ? shallowFloor : shallowFloor - 100));
    expect(canTraverse(world, 'fish', 9.5, 5, 10.5, 5)).toBe(true);
    expect(canTraverse(world, 'whale', 9.5, 5, 10.5, 5)).toBe(true);
  });
});

/**
 * One tick, matching the host's TICK_HZ of 10 — the `dt` every steering call
 * below is asked about.
 *
 * `stepCells` is required by shared's `SteerOptions` and these cases supply no
 * occupants, so it changes none of their answers: separation is the only thing
 * that reads it, and separation is off. It is still stated truthfully rather
 * than as a placeholder, so the test cannot be read as claiming the field is
 * decorative.
 */
const TICK_DT = 0.1;

describe('gradient veto in steering (steerToValidHeading)', () => {
  it('turns a grazer along the terrace instead of crossing a riser (case a)', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL + 1);
    const entity = grazer(9.5, 20);
    const lookahead = 2; // comfortably reaches across the riser at x=10.
    const heading = steerToValidHeading(
      world,
      entity,
      0 /* due east, into the riser */,
      lookahead,
      speedOf(entity) * TICK_DT,
    );

    expect(heading).not.toBeNull();
    // The only headings that survive on a riser with no y-variation are the
    // ones with (near) zero x-component — the creature deflects along the
    // level rather than climbing it. cos(±90°) = 0.
    expect(Math.abs(Math.cos(heading!))).toBeLessThan(1e-9);
  });

  it('lets a grazer cross a gentle ramp under the limit (case b)', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL - 1);
    const entity = grazer(9.5, 20);
    const heading = steerToValidHeading(world, entity, 0, 2, speedOf(entity) * TICK_DT);

    expect(heading).not.toBeNull();
    // Nothing blocks the desired heading, so the very first candidate (0°,
    // due east) is returned unchanged.
    expect(heading).toBeCloseTo(0, 9);
  });

  it('does not constrain a fish crossing the same-shaped terrain (case c)', () => {
    // Reuse the riser shape but classify it as water throughout by shifting
    // it below SEA_LEVEL and inside the shallow band on both sides.
    const shallowFloor = SEA_LEVEL - 10;
    const world = fakeWorld((x) => (x < 10 ? shallowFloor : shallowFloor - 100));
    const entity: WildlifeEntity = {
      id: 2,
      species: 'fish',
      schoolId: 1,
      size: 'small',
      idle: false,
      x: 9.5,
      y: 20,
      heading: 0,
      fleeSecondsRemaining: 0,
    };
    const heading = steerToValidHeading(world, entity, 0, 2, speedOf(entity) * TICK_DT);
    expect(heading).toBeCloseTo(0, 9);
  });
});

describe('flee still respects the gradient veto (advanceEntity, case d)', () => {
  it('a panicking grazer deflects along the terrace instead of bolting up the riser', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL + 1);
    const entity = grazer(9.5, 20, { heading: 0, fleeSecondsRemaining: 2 });
    const startX = entity.x;
    const startHeight = world.heightAt(Math.floor(startX), 20);

    // Sanity: fleeing widens the look-ahead well past the riser at x=10, so
    // this is a real test of the veto and not an accident of a short probe.
    expect(entity.x + lookaheadCellsFor(entity)).toBeGreaterThan(10);

    advanceEntity(world, entity, 0.1);

    // The creature must still be on the near side of the riser, at (or very
    // near) its start height — it did not climb, whether by steering away
    // from the riser or by the destination re-check turning it back.
    expect(Math.floor(entity.x)).toBeLessThan(10);
    expect(world.heightAt(Math.floor(entity.x), Math.floor(entity.y))).toBe(startHeight);
  });
});

describe('contour-following instead of reversal (2026-08-19, "go around, not over or through")', () => {
  it('holds position and heading, rather than flipping 180°, when fully boxed in', () => {
    // A single-cell pocket of shallow water (cell (5,5): x,y in [5,6))
    // surrounded by deep water on every side. A 1×1 pocket's farthest corner
    // is 0.5·√2 ≈ 0.707 cells from its centre in any direction; `fish` (used
    // here as a species with a comfortably large look-ahead: bodyLength 0.7,
    // cruise 3 c/s × LOOKAHEAD_SECONDS 0.6 = 1.8 cells, so lookaheadCellsFor
    // = 1.8) gives a contour-fallback probe of 1.8/2 = 0.9 — still bigger
    // than 0.707, so BOTH the primary sweep (at 1.8) and the contour retry
    // (at 0.9) land in deep water in every direction: genuinely nowhere to
    // go this tick, not merely boxed in at the longer probe.
    // The wall of the pocket is stated as the DEEP-WATER THRESHOLD ITSELF, not
    // as a band count: it was `SEA_LEVEL - 4 * BAND_HEIGHT`, which cleared the
    // threshold only while a band was 64 units, and at 16 it is -64 against a
    // -192 line — shallow, so the fish simply swam out and the test stopped
    // describing a boxed-in creature at all.
    const DEEP = DEEP_WATER_MAX_HEIGHT;
    const world = fakeWorld(() => DEEP); // deep water everywhere by default
    const pocketWorld: HabitatWorld = {
      ...world,
      heightAt: (x, y) => (Math.floor(x) === 5 && Math.floor(y) === 5 ? SEA_LEVEL : DEEP),
    };
    const entity: WildlifeEntity = {
      id: 9,
      species: 'fish',
      schoolId: 9,
      size: 'medium',
      idle: false,
      x: 5.5,
      y: 5.5,
      heading: 1.23,
      fleeSecondsRemaining: 0,
    };

    advanceEntity(pocketWorld, entity, 0.1);

    // No blind reversal (heading += PI) and no phantom movement: the
    // creature holds exactly where — and which way — it already was.
    expect(entity.x).toBe(5.5);
    expect(entity.y).toBe(5.5);
    expect(entity.heading).toBeCloseTo(1.23, 9);
  });
});
