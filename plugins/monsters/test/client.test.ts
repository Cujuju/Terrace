// The client half's PURE logic: payload validation, interpolation, and the
// placement/silhouette maths. Rendering is verified by eye per design doc ("no
// headless GL rig"), so nothing here imports three — which is also what lets it
// run in the same node environment as the server tests.

import { describe, expect, it } from 'vitest';
import { CatmullRomCurve3, Vector3 } from 'three';
import { BAND_HEIGHT, MIN_HEIGHT, SEA_LEVEL, cellsAcross } from '@terrace/shared';
import { parseMonstersPayload, type MonsterState } from '../protocol.ts';
import {
  CTHULHU_BODY_WRINKLE_DEPTH,
  CTHULHU_HEAD_WRINKLE_DEPTH,
  CTHULHU_LURK_DEPTH,
  CTHULHU_WIDTH_CELLS,
} from '../client/anatomy.ts';
import {
  BOLT_MAX_RADIUS_CELLS,
  dreadSpecOf,
  LightningSchedule,
  MAX_FLASH_INTERVAL_SECONDS,
  MIN_FLASH_INTERVAL_SECONDS,
  createStrikeRandom,
  nextFlashIntervalSeconds,
} from '../client/dread.ts';
import {
  DEFAULT_INTERPOLATION_SECONDS,
  MAX_INTERPOLATION_SECONDS,
  MonsterInterpolator,
  lerpAngle,
} from '../client/interpolation.ts';
import {
  KRAKEN_LURK_DEPTH,
  KRAKEN_MANTLE_APEX_BACKSET,
  KRAKEN_MANTLE_APEX_HEIGHT,
  KRAKEN_MANTLE_RISE_BACKSET,
  KRAKEN_MANTLE_RISE_HEIGHT,
  KRAKEN_MANTLE_ROOT_BACKSET,
  KRAKEN_MANTLE_ROOT_HEIGHT,
  KRAKEN_MANTLE_TIP_BACKSET,
  KRAKEN_MANTLE_TIP_HEIGHT,
  krakenMantleRadiusAt,
  KRAKEN_TOTAL_HEIGHT,
  KRAKEN_WIDTH_CELLS,
} from '../client/kraken-anatomy.ts';
import {
  SEA_SURFACE_WORLD_Y,
  lurkDepthOf,
  monsterOriginWorldY,
  monsterOriginY,
  walkerGroundWorldY,
} from '../client/placement.ts';
import {
  YETI_BOB_CELLS,
  YETI_FOOT_GROUND_HALF_EXTENT,
  YETI_LEAN_RADIANS,
  YETI_VARIANT_METRICS,
  YETI_VARIANT_SPECS,
  YETI_WIDEST_VARIANT_WIDTH_CELLS,
  yetiWorldParts,
} from '../client/yeti-anatomy.ts';
import {
  CTHULHU_FOOTPRINT_CELLS,
  KRAKEN_FOOTPRINT_CELLS,
  YETI_FOOTPRINT_CELLS,
} from '../server/kinds.ts';
// The pilgrims plugin's own figure, imported HERE and only here: this file is
// where the two halves of a restated constant are allowed to meet.
import { PILGRIM_HEIGHT } from '../../pilgrims/client/models.ts';

function monster(id: number, overrides: Partial<MonsterState> = {}): MonsterState {
  return { id, kind: 'cthulhu', x: 0, y: 0, heading: 0, ...overrides };
}

describe('state payload parsing', () => {
  it('accepts a well-formed payload', () => {
    const parsed = parseMonstersPayload({
      monsters: [{ id: 3, kind: 'cthulhu', x: 1.25, y: -2.5, heading: 1.5 }],
    });
    expect(parsed).toEqual([{ id: 3, kind: 'cthulhu', x: 1.25, y: -2.5, heading: 1.5 }]);
  });
});

describe('interpolation', () => {

  it('walks halfway across the window in half the window', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 0, y: 0 })]);
    // Two messages one second apart: the measured window becomes 1 s.
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([monster(1, { x: 4, y: 0 })]);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.progress()).toBeCloseTo(0.5, 10);
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(2, 10);
  });

  it('clamps a stalled gap to the ceiling, which is sized for one dropped message', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 0 })]);
    // A ten-second stall: the window must not become ten seconds.
    interpolator.advance(10);
    interpolator.receive([monster(1, { x: 4 })]);

    interpolator.advance(MAX_INTERPOLATION_SECONDS);
    expect(interpolator.progress()).toBe(1);
    // One dropped message at the 1 Hz cadence is a 2 s gap, and the ceiling has
    // to be able to span it without clamping.
    expect(MAX_INTERPOLATION_SECONDS).toBeGreaterThanOrEqual(DEFAULT_INTERPOLATION_SECONDS * 2);
  });

  it('drops a monster the moment it is absent from a message', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1)]);
    expect(interpolator.sample().size).toBe(1);

    interpolator.receive([]);
    expect(interpolator.sample().size).toBe(0);
  });

  it('turns the short way round through ±π', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(3 + (Math.PI * 2 - 6) / 2, 10);
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 10);
  });
});

describe('placement', () => {
  /** The depth every kind's origin is asked for by name, never by default. */
  const CTHULHU_DEPTH = lurkDepthOf('cthulhu');

  it('rides at its lurking depth when the water is deep enough', () => {
    const abyssY = -20;
    expect(monsterOriginWorldY(abyssY, CTHULHU_DEPTH)).toBe(
      SEA_SURFACE_WORLD_Y - CTHULHU_LURK_DEPTH,
    );
    expect(monsterOriginWorldY(abyssY, lurkDepthOf('kraken'))).toBe(
      SEA_SURFACE_WORLD_Y - KRAKEN_LURK_DEPTH,
    );
  });

  it('stands on the bottom rather than sinking through it', () => {
    // The shallowest water it can ever be in: exactly the deep threshold, three
    // bands = three world units below the surface.
    const shallowestLairY = -3;
    expect(monsterOriginWorldY(shallowestLairY, CTHULHU_DEPTH)).toBe(shallowestLairY);
    expect(monsterOriginWorldY(shallowestLairY, CTHULHU_DEPTH)).toBeGreaterThan(
      SEA_SURFACE_WORLD_Y - CTHULHU_LURK_DEPTH,
    );
  });

  /**
   * The world's floor and the deep-water line, in the WORLD units placement
   * speaks. One band is one world unit (client/src/config.ts:
   * BAND_WORLD_HEIGHT = CELL_WORLD_SIZE), restated here rather than imported
   * for the reason everything else in this plugin's client half is: the plugin
   * must build and test with the rest of the client absent. Deriving the floor
   * from shared's MIN_HEIGHT — rather than writing -24 — is what makes these
   * follow a Deep Strata retune instead of pinning yesterday's world.
   */
  const WORLD_FLOOR_Y = MIN_HEIGHT / BAND_HEIGHT;
  const DEEP_WATER_LINE_Y = -3;
});

describe('silhouette', () => {

  it('agrees with the server about how wide it is', () => {
    // The server sizes its steering look-ahead off CTHULHU_FOOTPRINT_CELLS so
    // the body never swims into a cliff the centre point cleared. The server
    // half must not import the client half (it runs where three does not
    // exist), so the two numbers are pinned to each other HERE.
    // THROUGH THE CONVERSION since the 2026-08-21 re-sample: the client models
    // in WORLD UNITS and the server steers in CELLS, and the two were the same
    // number only while a cell was a world unit.
    expect(cellsAcross(CTHULHU_WIDTH_CELLS)).toBe(CTHULHU_FOOTPRINT_CELLS);
  });
});

describe('skin sculpt', () => {
  it('only ever carves inward, so the stated extents are real bounds', () => {
    // The sculpt is what makes the model organic, and the reason it is stated
    // as a DEPTH rather than an amplitude: every dimension in anatomy.ts — and
    // CTHULHU_LURK_DEPTH, derived from one of them — is a bound the placement
    // maths trusts. Both depths are positive distances taken off the surface.
    expect(CTHULHU_HEAD_WRINKLE_DEPTH).toBeGreaterThan(0);
    expect(CTHULHU_BODY_WRINKLE_DEPTH).toBeGreaterThan(0);
  });
});

describe('the kraken silhouette', () => {
  const halfFootprint = KRAKEN_WIDTH_CELLS / 2;

  it('agrees with the server about how wide it is', () => {
    // Same arrangement as Cthulhu's: the server steers by its own copy of this
    // number, the client half must not be imported by the server, so the two are
    // pinned to each other here.
    expect(cellsAcross(KRAKEN_WIDTH_CELLS)).toBe(KRAKEN_FOOTPRINT_CELLS);
    // ...and both kinds share the box on purpose — the second kind was fitted to
    // the first one's footprint rather than widening the steering probe and the
    // atmosphere's lightning clearance that were derived from it.
    expect(KRAKEN_FOOTPRINT_CELLS).toBe(CTHULHU_FOOTPRINT_CELLS);
  });

  it('holds the mantle\'s swept SKIN inside the footprint, sampled off the real curve', () => {
    // The arch (2026-08-19) runs backward along X, so the rearmost skin is a
    // property of the whole swept tube — axis point plus local radius — not of
    // any single constant. This samples the exact curve the builder sweeps
    // (same control points, same radius function; three's CatmullRom is plain
    // maths and runs fine under node) and holds every sample inside the
    // half-footprint. It also proves KRAKEN_TOTAL_HEIGHT really is an upper
    // bound on the skin's top, which the placement and dread maths lean on.
    const axis = new CatmullRomCurve3([
      new Vector3(-KRAKEN_MANTLE_ROOT_BACKSET, KRAKEN_MANTLE_ROOT_HEIGHT, 0),
      new Vector3(-KRAKEN_MANTLE_RISE_BACKSET, KRAKEN_MANTLE_RISE_HEIGHT, 0),
      new Vector3(-KRAKEN_MANTLE_APEX_BACKSET, KRAKEN_MANTLE_APEX_HEIGHT, 0),
      new Vector3(-KRAKEN_MANTLE_TIP_BACKSET, KRAKEN_MANTLE_TIP_HEIGHT, 0),
    ]);
    const SAMPLES = 128;
    let maxBack = 0;
    let maxTop = -Infinity;
    for (let step = 0; step <= SAMPLES; step++) {
      const along = step / SAMPLES;
      const point = axis.getPoint(along, new Vector3());
      const radius = krakenMantleRadiusAt(along);
      maxBack = Math.max(maxBack, Math.abs(point.x) + radius);
      maxTop = Math.max(maxTop, point.y + radius);
    }
    expect(maxBack).toBeLessThanOrEqual(halfFootprint);
    expect(maxTop).toBeLessThanOrEqual(KRAKEN_TOTAL_HEIGHT);
  });
});

describe('the yeti is placed on the ground, not in the water', () => {
  /** A terrain sampler over a hand-written height field, in world Y. */
  function sampler(heights: Record<string, number>): (x: number, y: number) => number | null {
    return (x, y) => heights[`${x},${y}`] ?? null;
  }

  it('stands ON the terrain — the origin IS the ground height', () => {
    const ground = sampler({ '10,10': 9, '9,9': 9, '9,11': 9, '11,9': 9, '11,11': 9 });
    expect(monsterOriginY('yeti', ground, 10.5, 10.5)).toBe(9);
  });

  it('stands on the HIGHEST band its feet overlap, not the one under its centre', () => {
    // The clipping bug the wildlife plugin already reported: a walker whose
    // centre is on a low band but whose foot overhangs a higher one stands at
    // the low height and its body intersects the riser face.
    const straddling = sampler({ '10,10': 9, '11,11': 12, '9,9': 9, '9,11': 9, '11,9': 9 });
    expect(monsterOriginY('yeti', straddling, 10.5, 10.5)).toBe(12);
    // walkerGroundWorldY steps in CELLS, so the anatomy's world units convert —
    // exactly as placement.ts does it. Passing the raw world-unit figure here is
    // the bug this test caught on 2026-08-22; see the unit test below.
    expect(
      walkerGroundWorldY(straddling, 10.5, 10.5, cellsAcross(YETI_FOOT_GROUND_HALF_EXTENT)),
    ).toBe(12);
  });
});

describe('the yeti silhouette', () => {
  // FOUR BODIES, ONE SET OF RULES (2026-08-26). Everything below used to be
  // asserted of the one animal this plugin built; it is asserted of each of the
  // four now, because the contract was never about that animal — it is about
  // what any yeti has to be for the server's steering, the client's placement
  // and the owner's size ceiling to hold. A variant that breaks one of these
  // fails here rather than by walking its shoulder into a cliff.
  const VARIANTS = ['silverback', 'ram', 'ibex', 'fanged'] as const;

  it('agrees with the server about how wide the widest of them is', () => {
    // Same arrangement as the other two kinds': the server steers by its own
    // copy of this number, the client half must not be imported by the server,
    // so the two are pinned to each other here. Against the WIDEST VARIANT,
    // because the server steers ONE footprint for every yeti and the look-ahead
    // is decided before the dice are rolled.
    expect(cellsAcross(YETI_WIDEST_VARIANT_WIDTH_CELLS)).toBe(YETI_FOOTPRINT_CELLS);
    // ...and he is NARROWER than the sea horrors, on purpose: he is an animal,
    // and his minimum snowfield is derived from this number.
    expect(YETI_FOOTPRINT_CELLS).toBeLessThan(CTHULHU_FOOTPRINT_CELLS);
    expect(YETI_FOOTPRINT_CELLS).toBeLessThan(KRAKEN_FOOTPRINT_CELLS);
  });

  it('keeps every part of every variant inside the footprint it steers', () => {
    // The reason the width is SOLVED rather than stated: it has to bound the
    // masses, the limbs, the horns and the fur shells, in the worst pose the
    // gait can reach. Re-derived here from the parts themselves — the rest-pose
    // lateral extent, which the solver only ever adds the lean to.
    for (const variant of VARIANTS) {
      const body = yetiWorldParts(variant);
      const halfFootprint = YETI_WIDEST_VARIANT_WIDTH_CELLS / 2;
      for (const part of body.parts) {
        const origin =
          part.joint === 'arm'
            ? body.joints.arm
            : part.joint === 'leg' || part.joint === 'ankle'
              ? body.joints.leg
              : { forward: 0, height: 0, lateral: 0 };
        const grow = part.shells === null ? 1 : 1 + part.shells.length;
        let lateral = 0;
        if (part.kind === 'mass') {
          lateral = Math.abs(part.center.lateral) + part.radii.lateral * grow;
        } else if (part.kind === 'limb') {
          lateral =
            Math.max(Math.abs(part.from.lateral), Math.abs(part.to.lateral)) +
            Math.max(part.rootRadius, part.tipRadius) * grow;
        } else {
          for (const at of part.path) {
            lateral = Math.max(lateral, Math.abs(at.lateral) + part.rootRadius);
          }
        }
        expect(Math.abs(origin.lateral) + lateral).toBeLessThanOrEqual(halfFootprint);
      }
    }
  });
});

describe('the yeti gait', () => {
  const VARIANTS = ['silverback', 'ram', 'ibex', 'fanged'] as const;

  it('never puts a foot through the ground it was placed on', () => {
    // The bob is written as (1 - cos)/2 — zero at its lowest, never negative —
    // and the LEAN is applied to the upper body only, so nothing that can dip
    // below the origin plane is ever rotated. Both are bounds the placement
    // maths depends on; the amplitudes are pinned here so a retune cannot
    // quietly make either of them two-sided.
    expect(YETI_BOB_CELLS).toBeGreaterThan(0);
    for (const variant of VARIANTS) {
      // Smaller than the shallowest foot on any of the four, so a lift can never
      // be read as the animal hovering.
      const footHeight =
        YETI_VARIANT_SPECS[variant].leg.footHeight * YETI_VARIANT_METRICS[variant].scale;
      expect(YETI_BOB_CELLS).toBeLessThan(footHeight);
    }
    expect(YETI_LEAN_RADIANS).toBeGreaterThan(0);
  });
});

describe('dread: per-kind derivation (2026-08-19)', () => {
  // The whole effect was authored against Cthulhu's anatomy and then applied
  // to every swimmer; on the kraken the bank sat OVER its waterline eyes and
  // the flash light INSIDE its silhouette. These are the four invariants, per
  // kind, that the correctness pass found unpinned.
  const SWIMMERS = ['cthulhu', 'kraken'] as const;

  it('keeps every kind\'s bolts outside its own footprint', () => {
    expect(dreadSpecOf('cthulhu')!.boltMinRadiusCells).toBeGreaterThan(CTHULHU_WIDTH_CELLS / 2);
    expect(dreadSpecOf('kraken')!.boltMinRadiusCells).toBeGreaterThan(KRAKEN_WIDTH_CELLS / 2);
    for (const kind of SWIMMERS) {
      expect(dreadSpecOf(kind)!.boltMinRadiusCells).toBeLessThan(BOLT_MAX_RADIUS_CELLS);
    }
  });
});

describe('dread: lightning', () => {

  it('clamps every sampled interval into the safety floor and the tail ceiling', () => {
    for (let step = 0; step <= 1000; step++) {
      const interval = nextFlashIntervalSeconds(step / 1000);
      expect(interval).toBeGreaterThanOrEqual(MIN_FLASH_INTERVAL_SECONDS);
      expect(interval).toBeLessThanOrEqual(MAX_FLASH_INTERVAL_SECONDS);
    }
    // Degenerate inputs no generator here produces, handled anyway.
    expect(nextFlashIntervalSeconds(1)).toBe(MAX_FLASH_INTERVAL_SECONDS);
    expect(nextFlashIntervalSeconds(-1)).toBe(MIN_FLASH_INTERVAL_SECONDS);
  });

  it('holds the photosensitivity floor across an hour of frames', () => {
    // THE CONTRACT, asserted end to end rather than constant by constant: over a
    // real frame loop, no three brightness transitions fall inside one second.
    const schedule = new LightningSchedule(createStrikeRandom(20260814));
    const dt = 1 / 60;
    const strikeTimes: number[] = [];
    const transitionTimes: number[] = [];
    let elapsed = 0;
    let previous = 0;
    let direction = 0;

    for (let frame = 0; frame < 60 * 60 * 60; frame++) {
      if (schedule.advance(dt, true) !== null) strikeTimes.push(elapsed);
      elapsed += dt;
      const brightness = schedule.brightness();
      if (!(brightness >= 0 && brightness <= 1)) {
        throw new Error(`brightness out of range: ${brightness}`);
      }
      const sign = Math.sign(brightness - previous);
      if (sign !== 0 && sign !== direction) {
        transitionTimes.push(elapsed);
        direction = sign;
      }
      previous = brightness;
    }

    expect(strikeTimes.length).toBeGreaterThan(0);
    for (let index = 1; index < strikeTimes.length; index++) {
      // Minus one frame: the countdown is only checked at frame boundaries.
      expect(strikeTimes[index]! - strikeTimes[index - 1]!).toBeGreaterThan(
        MIN_FLASH_INTERVAL_SECONDS - dt,
      );
    }
    for (let index = 0; index + 3 < transitionTimes.length; index++) {
      expect(transitionTimes[index + 3]! - transitionTimes[index]!).toBeGreaterThan(1);
    }
  });

  it('starts nothing while disarmed, and lets a strike in progress die away', () => {
    // Disarmed is both "the monster has been banished" and "the user asked for
    // reduced motion": no new lightning, and no bolt frozen in the air either.
    const schedule = new LightningSchedule(createStrikeRandom(3));
    const dt = 1 / 60;
    let started: unknown = null;
    for (let frame = 0; frame < 60 * 60 && started === null; frame++) {
      started = schedule.advance(dt, true);
    }
    expect(started).not.toBeNull();

    let sawBrightness = false;
    for (let frame = 0; frame < 60 * 60; frame++) {
      expect(schedule.advance(dt, false)).toBeNull();
      if (schedule.brightness() > 0) sawBrightness = true;
    }
    expect(sawBrightness).toBe(true);
    expect(schedule.brightness()).toBe(0);
  });
});
