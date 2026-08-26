// The client half's PURE logic: payload validation, interpolation, and the
// placement/silhouette maths. Rendering is verified by eye per design §8 ("no
// headless GL rig"), so nothing here imports three — which is also what lets it
// run in the same node environment as the server tests.

import { describe, expect, it } from 'vitest';
import { CatmullRomCurve3, Vector3 } from 'three';
import { BAND_HEIGHT, MIN_HEIGHT, SEA_LEVEL, cellsAcross } from '@terrace/shared';
import { parseMonstersPayload, type MonsterState } from '../protocol.ts';
import {
  CTHULHU_BODY_WRINKLE_DEPTH,
  CTHULHU_FACE_TENTACLE_COUNT,
  CTHULHU_HEAD_BOTTOM,
  CTHULHU_HEAD_TOP,
  CTHULHU_HEAD_WRINKLE_DEPTH,
  CTHULHU_LURK_DEPTH,
  CTHULHU_SHOULDER_HEIGHT,
  CTHULHU_SHOULDER_OFFSET,
  CTHULHU_SHOULDER_THICKNESS,
  CTHULHU_SHOULDER_WIDTH,
  CTHULHU_TORSO_HEIGHT,
  CTHULHU_TOTAL_HEIGHT,
  CTHULHU_WATERLINE_BITE,
  CTHULHU_WIDTH_CELLS,
  CTHULHU_WING_ARM_RADIUS,
  CTHULHU_WING_ELBOW_BULGE,
  CTHULHU_WING_ELBOW_RISE_FRACTION,
  CTHULHU_WING_FINGER_COUNT,
  CTHULHU_WING_FINGER_FAN_START_RADIANS,
  CTHULHU_WING_FINGER_LENGTH,
  CTHULHU_WING_FINGER_RADIUS,
  CTHULHU_WING_FINGER_RISE,
  CTHULHU_WING_FINGER_SPREAD,
  CTHULHU_WING_FOLD_RISE,
  CTHULHU_WING_LEAN_RADIANS,
  CTHULHU_WING_OFFSET,
  CTHULHU_WING_TIP_HEIGHT,
} from '../client/anatomy.ts';
import {
  BOLT_BOTTOM_CELLS,
  BOLT_MAX_RADIUS_CELLS,
  BOLT_MIN_RADIUS_CELLS,
  BOLT_TOP_CELLS,
  EYE_HEIGHT_ABOVE_WATER_CELLS,
  FLASH_ATTACK_SECONDS,
  FLASH_DURATION_SECONDS,
  FLASH_LIGHT_CLEARANCE_CELLS,
  FLASH_LIGHT_HEIGHT_CELLS,
  dreadSpecOf,
  LightningSchedule,
  MAX_FLASH_INTERVAL_SECONDS,
  MEAN_FLASH_INTERVAL_SECONDS,
  MIN_FLASH_INTERVAL_SECONDS,
  MIST_FADE_SECONDS,
  MIST_LAYERS,
  MIST_RADIUS_CELLS,
  SILHOUETTE_ABOVE_WATER_CELLS,
  approachEnvelope,
  createStrikeRandom,
  flashBrightness,
  nextFlashIntervalSeconds,
} from '../client/dread.ts';
import {
  DEFAULT_INTERPOLATION_SECONDS,
  MAX_INTERPOLATION_SECONDS,
  MonsterInterpolator,
  lerpAngle,
} from '../client/interpolation.ts';
import {
  KRAKEN_ARM_COUNT,
  KRAKEN_ARM_CREST_HEIGHT,
  KRAKEN_ARM_CREST_REACH,
  KRAKEN_ARM_DRIFT,
  KRAKEN_ARM_RADIUS,
  KRAKEN_ARM_TIP_HEIGHT,
  KRAKEN_ARM_TIP_RADIUS,
  KRAKEN_ARM_TIP_REACH,
  KRAKEN_CLUB_LENGTH,
  KRAKEN_EYE_BOTTOM,
  KRAKEN_FIN_SPAN,
  KRAKEN_HEAD_TOP,
  KRAKEN_HEAD_WRINKLE_DEPTH,
  KRAKEN_LIMB_COUNT,
  KRAKEN_LURK_DEPTH,
  KRAKEN_HEAD_CENTER_HEIGHT,
  KRAKEN_HEAD_HEIGHT,
  KRAKEN_HEAD_LENGTH,
  KRAKEN_FIN_BACKSET,
  KRAKEN_FIN_CENTER_HEIGHT,
  KRAKEN_FIN_LENGTH,
  KRAKEN_MANTLE_APEX_BACKSET,
  KRAKEN_MANTLE_APEX_HEIGHT,
  KRAKEN_MANTLE_RADIUS,
  KRAKEN_MANTLE_RISE_BACKSET,
  KRAKEN_MANTLE_RISE_HEIGHT,
  KRAKEN_MANTLE_ROOT_BACKSET,
  KRAKEN_MANTLE_ROOT_HEIGHT,
  KRAKEN_MANTLE_TIP_BACKSET,
  KRAKEN_MANTLE_TIP_HEIGHT,
  KRAKEN_MANTLE_WRINKLE_DEPTH,
  krakenMantleRadiusAt,
  KRAKEN_SHADE_VARIATION,
  KRAKEN_TENTACLE_COUNT,
  KRAKEN_TENTACLE_CREST_HEIGHT,
  KRAKEN_TENTACLE_TIP_HEIGHT,
  KRAKEN_TENTACLE_TIP_REACH,
  KRAKEN_TOTAL_HEIGHT,
  KRAKEN_WATERLINE_BITE,
  KRAKEN_WIDTH_CELLS,
} from '../client/kraken-anatomy.ts';
import {
  SEA_SURFACE_WORLD_Y,
  UNKNOWN_TERRAIN_WORLD_Y,
  lurkDepthOf,
  monsterOriginWorldY,
  monsterOriginY,
  placementRuleOf,
  submergedFraction,
  walkerGroundWorldY,
} from '../client/placement.ts';
import {
  PEEP_HEIGHT_WORLD_UNITS,
  YETI_AMBLE_SPEED_CELLS_PER_SECOND as YETI_MODEL_AMBLE_SPEED,
  YETI_ARM_SWING_RADIANS,
  YETI_BOB_CELLS,
  YETI_FOOT_GROUND_HALF_EXTENT,
  YETI_FUR_WRINKLE_DEPTH,
  YETI_HEIGHT_IN_PEEPS,
  YETI_LEAN_RADIANS,
  YETI_LEG_SWING_RADIANS,
  YETI_SHADE_VARIATION,
  YETI_TOTAL_HEIGHT,
  YETI_VARIANT_METRICS,
  YETI_VARIANT_SPECS,
  YETI_VARIANT_WIDTH_CELLS,
  YETI_WIDEST_VARIANT_WIDTH_CELLS,
  YETI_WIDTH_CELLS,
  yetiWorldParts,
} from '../client/yeti-anatomy.ts';
import {
  CTHULHU_FOOTPRINT_CELLS,
  KRAKEN_FOOTPRINT_CELLS,
  YETI_AMBLE_SPEED_CELLS_PER_SECOND,
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

  it('accepts an EMPTY list — that is the despawn, not a malformed message', () => {
    expect(parseMonstersPayload({ monsters: [] })).toEqual([]);
  });

  it('returns null when the payload is not a monster list at all', () => {
    for (const bad of [null, undefined, 7, 'x', {}, { monsters: 5 }]) {
      expect(parseMonstersPayload(bad)).toBeNull();
    }
  });

  it('drops malformed entries individually rather than failing the message', () => {
    const parsed = parseMonstersPayload({
      monsters: [
        { id: 1, kind: 'cthulhu', x: 0, y: 0, heading: 0 },
        null,
        { id: 'two', kind: 'cthulhu', x: 0, y: 0, heading: 0 },
        // A kind this client's bundle has never heard of — the version-skew case.
        { id: 3, kind: 'dagon', x: 0, y: 0, heading: 0 },
        { id: 4, kind: 'cthulhu', x: Number.NaN, y: 0, heading: 0 },
        { id: 5, kind: 'cthulhu', x: 0, y: 0, heading: Number.POSITIVE_INFINITY },
      ],
    });
    expect(parsed).toEqual([{ id: 1, kind: 'cthulhu', x: 0, y: 0, heading: 0 }]);
  });
});

describe('interpolation', () => {
  it('holds the first message exactly, with no history to blend from', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 10, y: 20, heading: 1 })]);
    const sampled = interpolator.sample().get(1);
    expect(sampled).toMatchObject({ x: 10, y: 20, heading: 1 });
  });

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

  it('clamps at the target rather than extrapolating past it', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 0 })]);
    interpolator.advance(1);
    interpolator.receive([monster(1, { x: 4 })]);

    interpolator.advance(10);
    expect(interpolator.progress()).toBe(1);
    expect(interpolator.sample().get(1)!.x).toBe(4);
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

  it('does not blend a new arrival out of the departed one\'s position', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1, { x: 100, y: 100 })]);
    interpolator.advance(1);
    // Banished, then a later arrival somewhere else — a NEW id, so no history.
    interpolator.receive([]);
    interpolator.advance(1);
    interpolator.receive([monster(2, { x: 0, y: 0 })]);

    const sampled = interpolator.sample().get(2)!;
    expect(sampled.x).toBe(0);
    expect(sampled.y).toBe(0);
  });

  it('turns the short way round through ±π', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(3 + (Math.PI * 2 - 6) / 2, 10);
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 10);
  });

  it('forgets everything on clear', () => {
    const interpolator = new MonsterInterpolator();
    interpolator.receive([monster(1)]);
    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});

describe('placement', () => {
  /** The depth every kind's origin is asked for by name, never by default. */
  const CTHULHU_DEPTH = lurkDepthOf('cthulhu');

  it('looks each kind\'s lurking depth up by kind', () => {
    expect(CTHULHU_DEPTH).toBe(CTHULHU_LURK_DEPTH);
    expect(lurkDepthOf('kraken')).toBe(KRAKEN_LURK_DEPTH);
  });

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

  it('never lets the seabed bind the kraken — its silhouette is depth-invariant', () => {
    // THE CONTRACT, checked across the WHOLE range a cell may legally hold
    // since Deep Strata took the floor to -1536 (-24 world units): from the
    // shallowest water the kraken may occupy down to the lava floor, `max`
    // must pick the preferred depth every time.
    //
    // Why it is a contract and not a coincidence: the kraken's lurk depth is
    // derived from its EYES (kraken-anatomy.ts), which puts it far above the
    // deep-water line, and the server will not place it anywhere shallower
    // than that line. If a retune ever pushed the lurk depth past 3, this
    // fails — and it should, because the animal would start dropping onto the
    // floor in shallow basins, which is Cthulhu's read, not the kraken's.
    const krakenDepth = lurkDepthOf('kraken');
    expect(krakenDepth).toBeLessThan(-DEEP_WATER_LINE_Y);
    for (let seabedY = DEEP_WATER_LINE_Y; seabedY >= WORLD_FLOOR_Y; seabedY--) {
      expect(monsterOriginWorldY(seabedY, krakenDepth)).toBe(
        SEA_SURFACE_WORLD_Y - krakenDepth,
      );
    }
    // Including the exact floor, which is not on the integer walk above if the
    // strata stack ever stops dividing evenly.
    expect(monsterOriginWorldY(WORLD_FLOOR_Y, krakenDepth)).toBe(
      SEA_SURFACE_WORLD_Y - krakenDepth,
    );
  });

  it('does let the seabed bind Cthulhu — the clamp is his, and the contrast is the point', () => {
    // The other half of the same contract: the clamp is not dead code, it is
    // one kind's behaviour. Cthulhu lurks past the deep-water line, so every
    // basin shallower than his lurk depth stands him on the bottom.
    expect(CTHULHU_DEPTH).toBeGreaterThan(-DEEP_WATER_LINE_Y);
    expect(monsterOriginWorldY(DEEP_WATER_LINE_Y, CTHULHU_DEPTH)).toBe(DEEP_WATER_LINE_Y);
    // ...and in the deep strata he floats, exactly as the kraken always does.
    expect(monsterOriginWorldY(WORLD_FLOOR_Y, CTHULHU_DEPTH)).toBe(
      SEA_SURFACE_WORLD_Y - CTHULHU_DEPTH,
    );
  });

  it('assumes deep water, not band 0, when the chunk has not arrived', () => {
    // Band 0 is the sea SURFACE plane; clamping against it would beach the
    // model. Unknown must mean "no clamp".
    expect(monsterOriginWorldY(null, CTHULHU_DEPTH)).toBe(
      SEA_SURFACE_WORLD_Y - CTHULHU_LURK_DEPTH,
    );
    expect(monsterOriginWorldY(null, CTHULHU_DEPTH)).toBeLessThan(SEA_LEVEL);
  });

  it('leaves the head clear of the water and the torso under it', () => {
    const originY = monsterOriginWorldY(-20, CTHULHU_DEPTH);
    // Head bottom just under the surface by the waterline bite; head top well
    // clear of it.
    expect(originY + CTHULHU_HEAD_BOTTOM).toBeCloseTo(-CTHULHU_WATERLINE_BITE, 10);
    expect(originY + CTHULHU_HEAD_TOP).toBeGreaterThan(SEA_SURFACE_WORLD_Y);
    // Shoulder crowns break the surface; the whole torso does not.
    expect(originY + CTHULHU_SHOULDER_HEIGHT + CTHULHU_SHOULDER_THICKNESS / 2).toBeGreaterThan(
      SEA_SURFACE_WORLD_Y,
    );
    expect(originY + CTHULHU_TORSO_HEIGHT / 2).toBeLessThan(SEA_SURFACE_WORLD_Y);
  });

  it('is mostly submerged at its lurking depth', () => {
    const originY = monsterOriginWorldY(-20, CTHULHU_DEPTH);
    const fraction = submergedFraction(originY, CTHULHU_TOTAL_HEIGHT);
    expect(fraction).toBeGreaterThan(0.5);
    expect(fraction).toBeLessThan(0.8);
  });

  it('shows the kraken where it hides Cthulhu — the two are placed oppositely', () => {
    // The contrast is the feature (kraken-anatomy.ts: "two monsters that hid the
    // same amount of themselves would be one monster twice"). Cthulhu is mostly
    // gone; the kraken has surfaced and shows nearly all of itself.
    const krakenOriginY = monsterOriginWorldY(-20, lurkDepthOf('kraken'));
    const krakenSubmerged = submergedFraction(krakenOriginY, KRAKEN_TOTAL_HEIGHT);
    // Under 0.35 since the 2026-08-19 anatomy correction (was 0.2 for the old
    // vertical mantle): the surfaced read survives, but a floating body now
    // carries an honest share of itself in the water instead of 90% in the sky.
    expect(krakenSubmerged).toBeLessThan(0.35);
    expect(krakenSubmerged).toBeLessThan(
      submergedFraction(monsterOriginWorldY(-20, CTHULHU_DEPTH), CTHULHU_TOTAL_HEIGHT),
    );
  });

  it('puts the kraken\'s eyes at the waterline, its hump out of it, its tail in it', () => {
    const originY = monsterOriginWorldY(-20, lurkDepthOf('kraken'));
    // Eye bottoms exactly one waterline bite under; the hump's crest standing
    // out of the sea; the mantle's TAIL riding under it — the surfaced-animal
    // read of the 2026-08-19 anatomy correction: a back breaking the water,
    // not a tower balanced on it.
    expect(originY + KRAKEN_EYE_BOTTOM).toBeCloseTo(-KRAKEN_WATERLINE_BITE, 10);
    expect(originY + KRAKEN_MANTLE_APEX_HEIGHT).toBeGreaterThan(SEA_SURFACE_WORLD_Y);
    expect(originY + KRAKEN_MANTLE_TIP_HEIGHT).toBeLessThan(SEA_SURFACE_WORLD_Y);
    // ...and the arms lying ON the water: their crests break it, their tips do
    // not. That is the whole read of the crown from a boat.
    expect(originY + KRAKEN_ARM_CREST_HEIGHT).toBeGreaterThan(SEA_SURFACE_WORLD_Y);
    expect(originY + KRAKEN_ARM_TIP_HEIGHT).toBeLessThan(SEA_SURFACE_WORLD_Y);
  });
});

describe('silhouette', () => {
  it('is 10–14 cells tall, as briefed — several times a whale', () => {
    expect(CTHULHU_TOTAL_HEIGHT).toBeGreaterThanOrEqual(10);
    expect(CTHULHU_TOTAL_HEIGHT).toBeLessThanOrEqual(14);
  });

  it('has a fan of 6–8 face tentacles', () => {
    expect(CTHULHU_FACE_TENTACLE_COUNT).toBeGreaterThanOrEqual(6);
    expect(CTHULHU_FACE_TENTACLE_COUNT).toBeLessThanOrEqual(8);
    // Odd, so one tentacle hangs on the centre line and the fan is symmetric
    // about it rather than parted down the middle.
    expect(CTHULHU_FACE_TENTACLE_COUNT % 2).toBe(1);
  });

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

  it('is taller than it is wide — the hunch, not a raft', () => {
    expect(CTHULHU_TOTAL_HEIGHT).toBeGreaterThan(CTHULHU_WIDTH_CELLS);
  });

  it('is as tall as it is because of the wings, not the skull', () => {
    // The tallest point is the tip of the topmost folded finger. If the head
    // ever overtakes it the hunch has stopped reading, and this is the test
    // that says so rather than a screenshot nobody takes.
    expect(CTHULHU_TOTAL_HEIGHT).toBe(CTHULHU_WING_TIP_HEIGHT);
    expect(CTHULHU_WING_TIP_HEIGHT).toBeGreaterThan(CTHULHU_HEAD_TOP);
  });

  it('aims the topmost finger at exactly the rise its tip height is derived from', () => {
    // The wing geometry places that finger by ANGLE and the silhouette height
    // claims its RISE; this is the derivation that keeps the two the same
    // number. Break it and the model is quietly a different height than the
    // placement maths and the tests above believe.
    expect(
      Math.cos(CTHULHU_WING_FINGER_FAN_START_RADIANS) * CTHULHU_WING_FINGER_LENGTH,
    ).toBeCloseTo(CTHULHU_WING_FINGER_RISE, 10);
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

  it('cannot wrinkle the head back under the waterline it was lifted clear of', () => {
    // The head bottom rides exactly CTHULHU_WATERLINE_BITE under the surface, so
    // a dent deeper than the bite could put dry skull below the water — or, on
    // the other side of the same coin, lift a piece of the rim out of it.
    expect(CTHULHU_HEAD_WRINKLE_DEPTH).toBeLessThan(CTHULHU_WATERLINE_BITE);
  });

  it('cannot wrinkle a shoulder crown under the surface it has to break', () => {
    const crownClearance =
      CTHULHU_SHOULDER_HEIGHT + CTHULHU_SHOULDER_THICKNESS / 2 - CTHULHU_LURK_DEPTH;
    expect(crownClearance).toBeGreaterThan(0);
    expect(CTHULHU_BODY_WRINKLE_DEPTH).toBeLessThan(crownClearance);
  });
});

describe('footprint', () => {
  /**
   * The three candidates for the widest point on the model, each written the way
   * the builder computes it. The server steers by CTHULHU_WIDTH_CELLS, so a
   * wing that grows past it is a wing that goes through a cliff the look-ahead
   * probe called clear — and nothing else in the suite would notice.
   */
  const halfFootprint = CTHULHU_WIDTH_CELLS / 2;

  it('keeps the shoulders inside the footprint the server steers by', () => {
    expect(CTHULHU_SHOULDER_OFFSET + CTHULHU_SHOULDER_WIDTH / 2).toBeLessThanOrEqual(halfFootprint);
  });

  it('keeps the wing elbow inside it', () => {
    const elbowRise = CTHULHU_WING_FOLD_RISE * CTHULHU_WING_ELBOW_RISE_FRACTION;
    const elbowReach =
      CTHULHU_WING_OFFSET +
      elbowRise * Math.tan(CTHULHU_WING_LEAN_RADIANS) +
      CTHULHU_WING_ELBOW_BULGE +
      CTHULHU_WING_ARM_RADIUS;
    expect(elbowReach).toBeLessThanOrEqual(halfFootprint);
  });

  it('keeps the outermost finger inside it', () => {
    const fingerReach =
      CTHULHU_WING_OFFSET +
      CTHULHU_WING_FOLD_RISE * Math.tan(CTHULHU_WING_LEAN_RADIANS) +
      (CTHULHU_WING_FINGER_COUNT - 1) * CTHULHU_WING_FINGER_SPREAD +
      CTHULHU_WING_FINGER_RADIUS;
    expect(fingerReach).toBeLessThanOrEqual(halfFootprint);
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

  it('keeps the arm tips — its widest point — inside that footprint', () => {
    expect(KRAKEN_ARM_TIP_REACH + KRAKEN_ARM_TIP_RADIUS).toBeLessThanOrEqual(halfFootprint);
  });

  it('keeps the crest, the drift, the tentacle clubs, the fins and the mantle inside it too', () => {
    // The crest is out at its reach AND drifted sideways, so its distance from
    // the axis is the hypotenuse of the two, plus the tube's radius there.
    const crestReach = Math.hypot(KRAKEN_ARM_CREST_REACH, KRAKEN_ARM_DRIFT) + KRAKEN_ARM_RADIUS;
    expect(crestReach).toBeLessThanOrEqual(halfFootprint);
    expect(KRAKEN_TENTACLE_TIP_REACH + KRAKEN_CLUB_LENGTH / 2).toBeLessThanOrEqual(halfFootprint);
    expect(KRAKEN_FIN_SPAN).toBeLessThanOrEqual(halfFootprint);
    // The fins live at the TAIL since 2026-08-19, so their REAR edge is a
    // horizontal-extent candidate too, not just their lateral span.
    const finRear = KRAKEN_FIN_BACKSET + KRAKEN_FIN_LENGTH / 2;
    expect(finRear).toBeLessThanOrEqual(halfFootprint);
    expect(KRAKEN_MANTLE_RADIUS).toBeLessThanOrEqual(halfFootprint);
    // ...and the arm tip really is the widest of them, which is what the anatomy
    // claims when it names the binding constraint.
    const armTip = KRAKEN_ARM_TIP_REACH + KRAKEN_ARM_TIP_RADIUS;
    expect(armTip).toBeGreaterThan(crestReach);
    expect(armTip).toBeGreaterThan(finRear);
    expect(armTip).toBeGreaterThan(KRAKEN_TENTACLE_TIP_REACH + KRAKEN_CLUB_LENGTH / 2);
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

  it('fits inside the lightning clearance the atmosphere derived from Cthulhu', () => {
    // dread.ts keeps every bolt outside CTHULHU_WIDTH_CELLS/2 + clearance so a
    // strike never lights the inside of the model. The second kind shares the
    // effect, so it has to share the assumption — this is the test that says so
    // rather than a screenshot of a bolt inside a crown of arms.
    expect(BOLT_MIN_RADIUS_CELLS).toBeGreaterThan(halfFootprint);
  });

  it('is a ring of ten limbs: eight arms and two tentacles', () => {
    expect(KRAKEN_ARM_COUNT).toBe(8);
    expect(KRAKEN_TENTACLE_COUNT).toBe(2);
    expect(KRAKEN_LIMB_COUNT).toBe(KRAKEN_ARM_COUNT + KRAKEN_TENTACLE_COUNT);
    // Even, so the crown is a ring rather than a fan with a middle. (Cthulhu's
    // tentacle count is odd for exactly the opposite reason.)
    expect(KRAKEN_LIMB_COUNT % 2).toBe(0);
  });

  it('rears higher on its tentacles than on its arms, and hangs deeper', () => {
    // They cannot reach FURTHER — the footprint forbids it — so this is the
    // whole difference between the hunting pair and the other eight.
    expect(KRAKEN_TENTACLE_CREST_HEIGHT).toBeGreaterThan(KRAKEN_ARM_CREST_HEIGHT);
    expect(KRAKEN_TENTACLE_TIP_HEIGHT).toBeLessThan(KRAKEN_ARM_TIP_HEIGHT);
    expect(KRAKEN_TENTACLE_TIP_REACH).toBeLessThan(KRAKEN_ARM_TIP_REACH);
  });

  it('is far shorter than Cthulhu and wears its height as a humped back', () => {
    // 2026-08-19 anatomy correction: the height IS the hump — apex plus the
    // widest ring the skin can add — and the animal is deliberately WIDER than
    // it is tall. The old pin ("taller than it is wide") described the
    // physically-wrong tower; the spider-on-the-water read the header claims
    // was only ever true of a low, broad silhouette.
    expect(KRAKEN_TOTAL_HEIGHT).toBeLessThan(CTHULHU_TOTAL_HEIGHT / 2);
    expect(KRAKEN_TOTAL_HEIGHT).toBe(KRAKEN_MANTLE_APEX_HEIGHT + KRAKEN_MANTLE_RADIUS);
    expect(KRAKEN_MANTLE_APEX_HEIGHT).toBeGreaterThan(KRAKEN_HEAD_TOP);
    expect(KRAKEN_WIDTH_CELLS).toBeGreaterThan(KRAKEN_TOTAL_HEIGHT);
  });

  it('grows the mantle out of the head instead of balancing it on top', () => {
    // The axis root must sit INSIDE the head ellipsoid, so the arch reads as
    // the animal's own back leaving its body — no seam, no backpack.
    const headHalfLength = KRAKEN_HEAD_LENGTH / 2;
    const headHalfHeight = KRAKEN_HEAD_HEIGHT / 2;
    const normalized =
      (KRAKEN_MANTLE_ROOT_BACKSET / headHalfLength) ** 2 +
      ((KRAKEN_MANTLE_ROOT_HEIGHT - KRAKEN_HEAD_CENTER_HEIGHT) / headHalfHeight) ** 2;
    expect(normalized).toBeLessThan(1);
  });

  it('rides its tail at the waterline, fins fused into it', () => {
    // The fins are the tail's fluke (2026-08-19): their centre must overlap
    // the mantle's own tip fore-and-aft, and sit at its height — a blade
    // floating beside the body is a pancake, not a fin.
    expect(Math.abs(KRAKEN_FIN_BACKSET - KRAKEN_MANTLE_TIP_BACKSET)).toBeLessThan(
      KRAKEN_FIN_LENGTH / 2,
    );
    expect(Math.abs(KRAKEN_FIN_CENTER_HEIGHT - KRAKEN_MANTLE_TIP_HEIGHT)).toBeLessThan(0.5);
  });

  it('cannot wrinkle skin back through the waterline it was placed against', () => {
    // Same contract as Cthulhu's carve: the lurk depth is derived from the eye
    // bottoms, so a dent deeper than the bite could dunk skin the placement
    // maths lifted clear — or lift skin it sank.
    expect(KRAKEN_MANTLE_WRINKLE_DEPTH).toBeGreaterThan(0);
    expect(KRAKEN_HEAD_WRINKLE_DEPTH).toBeGreaterThan(0);
    expect(KRAKEN_MANTLE_WRINKLE_DEPTH).toBeLessThan(KRAKEN_WATERLINE_BITE);
    expect(KRAKEN_HEAD_WRINKLE_DEPTH).toBeLessThan(KRAKEN_WATERLINE_BITE);
  });

  it('derives its lurk depth from the eyes rather than choosing one', () => {
    expect(KRAKEN_LURK_DEPTH).toBe(KRAKEN_EYE_BOTTOM + KRAKEN_WATERLINE_BITE);
    // Far shallower than Cthulhu's: the two are placed oppositely on purpose.
    expect(KRAKEN_LURK_DEPTH).toBeLessThan(CTHULHU_LURK_DEPTH);
  });
});

describe('the yeti is placed on the ground, not in the water', () => {
  /** A terrain sampler over a hand-written height field, in world Y. */
  function sampler(heights: Record<string, number>): (x: number, y: number) => number | null {
    return (x, y) => heights[`${x},${y}`] ?? null;
  }

  it('is a walker, and the two sea kinds are swimmers', () => {
    expect(placementRuleOf('yeti').placement).toBe('walker');
    expect(placementRuleOf('cthulhu').placement).toBe('swimmer');
    expect(placementRuleOf('kraken').placement).toBe('swimmer');
  });

  it('has no lurking depth to ask for', () => {
    // A caller asking a mountain animal how deep it lurks has a bug, and a
    // plausible answer (zero, or Cthulhu's) would hide it.
    expect(() => lurkDepthOf('yeti')).toThrow();
  });

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

  it('samples his feet in CELLS, not in the world units the anatomy states', () => {
    // THE BUG THIS PINS. Everything in yeti-anatomy.ts has been world units
    // since the 2026-08-21 re-sample cut a cell to a quarter of one, but this
    // constant was named `..._CELLS` and handed straight to walkerGroundWorldY,
    // which adds it to a CELL coordinate — so the walker probed a quarter of the
    // ground his feet cover and could stand below a riser his foot overhung.
    //
    // It went unnoticed for a day because at his full size the wrong number
    // (1.02) still reached the neighbouring cell and the fixture above still
    // passed; at a quarter of that size it reaches nothing but his own cell,
    // which is what surfaced it. The conversion is the fix, not the fixture.
    const rule = placementRuleOf('yeti');
    if (rule.placement !== 'walker') throw new Error('the yeti is a walker');
    const halfExtentCells = rule.footGroundHalfExtentCells;
    expect(halfExtentCells).toBe(cellsAcross(YETI_FOOT_GROUND_HALF_EXTENT));
    // A foot really does overhang its own cell: the probe has to reach past the
    // cell BOUNDARY at ±0.5, or the whole conversion buys nothing.
    //
    // STATED AGAINST THE BOUNDARY, NOT AGAINST A CELL COUNT. This assertion read
    // `> 1` until 2026-08-24, which was true of the animal's size that day and
    // of nothing else — the 2026-08-24 rescale to two peep-heights took the
    // half-extent to 0.74 cells and failed a test that had caught no bug. What
    // the conversion actually guarantees, at every size he will ever be, is that
    // the CELL figure exceeds the world-unit one it is made from; that, plus the
    // boundary, is the contract and neither moves with his scale.
    expect(halfExtentCells).toBeGreaterThan(0.5);
    expect(halfExtentCells).toBeGreaterThan(YETI_FOOT_GROUND_HALF_EXTENT);
  });

  it('falls back to the DRAWN ground when its chunk has not arrived', () => {
    // The opposite answer from the swimmers', and both are right: band 0 is what
    // the mesh draws for unknown cells, so a walker standing there matches what
    // the player sees — where a swimmer clamped against it would be beached at
    // full height on the sea surface.
    expect(monsterOriginY('yeti', () => null, 10.5, 10.5)).toBe(UNKNOWN_TERRAIN_WORLD_Y);
    expect(monsterOriginY('cthulhu', () => null, 10.5, 10.5)).toBeLessThan(
      UNKNOWN_TERRAIN_WORLD_Y,
    );
  });

  it('routes the swimmers through the same entry point, unchanged', () => {
    const seabed = sampler({ '10,10': -20 });
    expect(monsterOriginY('kraken', seabed, 10.5, 10.5)).toBe(
      monsterOriginWorldY(-20, lurkDepthOf('kraken')),
    );
  });

  it('samples the FEET, which are narrower than the body', () => {
    // A walker stands on what it steps on. Sampling the shoulders would have him
    // ride up onto every band his elbow overhangs.
    //
    // ONE HALF-EXTENT FOR FOUR BODIES, and it is the WIDEST of their stances:
    // placement is looked up by KIND, before a variant is in hand, and the safe
    // direction to err in is standing a fraction too high.
    for (const variant of ['silverback', 'ram', 'ibex', 'fanged'] as const) {
      const spec = YETI_VARIANT_SPECS[variant];
      const metrics = YETI_VARIANT_METRICS[variant];
      const outerEdge = (spec.stanceHalfWidth + spec.leg.footWidth) * metrics.scale;
      expect(YETI_FOOT_GROUND_HALF_EXTENT).toBeGreaterThanOrEqual(outerEdge);
    }
    expect(YETI_FOOT_GROUND_HALF_EXTENT).toBeLessThan(YETI_WIDTH_CELLS / 2);
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

  it('takes the widest as a real maximum over the four, not one of them', () => {
    // The failure this guards is a Phase-B model that outgrows the variant the
    // pin above happened to be written against: the max has to be over the
    // TABLE, so the day any body widens, the pin fails rather than the steering.
    for (const variant of VARIANTS) {
      expect(YETI_VARIANT_WIDTH_CELLS[variant]).toBeLessThanOrEqual(
        YETI_WIDEST_VARIANT_WIDTH_CELLS,
      );
    }
    expect(Math.max(...VARIANTS.map((v) => YETI_VARIANT_WIDTH_CELLS[v]))).toBe(
      YETI_WIDEST_VARIANT_WIDTH_CELLS,
    );
  });

  it('stands every variant on the owner\'s ceiling of exactly two peeps', () => {
    // THE RESTATEMENT, PINNED. yeti-anatomy.ts states a peep's height rather
    // than importing it — a monster must not pull the pilgrims plugin's model
    // module into its bundle for one number — which is only safe while this
    // fails the day the two drift apart.
    expect(PEEP_HEIGHT_WORLD_UNITS).toBe(PILGRIM_HEIGHT);
    expect(YETI_HEIGHT_IN_PEEPS).toBe(2);
    // And the ceiling itself (owner, 2026-08-24: "no more than two times taller
    // than one of the peeps"). Each variant's SCALE is solved for it — against
    // that variant's own highest point, which is a horn tip on one and a crest
    // on another — so it holds to the last bit rather than approximately.
    for (const variant of VARIANTS) {
      const metrics = YETI_VARIANT_METRICS[variant];
      expect(metrics.totalHeight).toBeLessThanOrEqual(YETI_HEIGHT_IN_PEEPS * PILGRIM_HEIGHT);
      expect(metrics.totalHeight).toBeCloseTo(YETI_TOTAL_HEIGHT, 10);
    }
  });

  it('solves that scale against the WHOLE animal, horns included', () => {
    // The bug this pins is the one the file is built to make impossible: a scale
    // solved against the skull, with horns then planted above it, puts the
    // animal over the ceiling silently. Every part of every variant — masses,
    // limbs, swept horns and the fur shells that stand off all of them — has to
    // be under the total, and one of them has to REACH it.
    for (const variant of VARIANTS) {
      const { scale, totalHeight } = YETI_VARIANT_METRICS[variant];
      let apex = 0;
      for (const part of yetiWorldParts(variant).parts) {
        if (part.joint !== 'head' && part.joint !== 'upper') continue;
        const grow = part.shells === null ? 1 : 1 + part.shells.length;
        if (part.kind === 'mass') {
          // The support of the ellipsoid in +Y, tilt included — a chest turned
          // into the hunch reaches higher than its own vertical radius.
          const height = Math.hypot(
            part.radii.height * Math.cos(part.tilt),
            part.radii.forward * Math.sin(part.tilt),
          );
          apex = Math.max(apex, part.center.height + height * grow);
        } else if (part.kind === 'sweep') {
          for (const at of part.path) {
            apex = Math.max(apex, at.height + Math.max(part.rootRadius, part.tipRadius));
          }
        }
      }
      expect(apex).toBeLessThanOrEqual(totalHeight + 1e-9);
      expect(apex).toBeCloseTo(totalHeight, 6);
      expect(scale).toBeGreaterThan(0);
    }
  });

  it('is the smallest of the three kinds, and taller than it is wide', () => {
    // Size ordering by each animal's own magnitude axis: the yeti stands under
    // Cthulhu's height and inside the kraken's spread.
    expect(YETI_TOTAL_HEIGHT).toBeLessThan(KRAKEN_WIDTH_CELLS);
    expect(YETI_TOTAL_HEIGHT).toBeLessThan(CTHULHU_TOTAL_HEIGHT);
    // EVERY body, the knuckle-walking silverback included — he is the one this
    // can fail on, because a gorilla build spends its size sideways.
    for (const variant of VARIANTS) {
      expect(YETI_VARIANT_WIDTH_CELLS[variant]).toBeLessThan(YETI_TOTAL_HEIGHT);
    }
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

  it('hangs its hands below its hips — the one proportion that says APE', () => {
    for (const variant of VARIANTS) {
      const metrics = YETI_VARIANT_METRICS[variant];
      expect(metrics.handHeight).toBeLessThan(metrics.hipHeight);
    }
    // ...and the knuckle-walker's fists are ON the ground, which is what that
    // spec flag means and the one thing a posed-by-eye arm gets wrong.
    expect(YETI_VARIANT_SPECS.silverback.knuckle).toBe(true);
    expect(YETI_VARIANT_METRICS.silverback.handHeight).toBeLessThan(
      YETI_VARIANT_METRICS.silverback.legLength / 3,
    );
  });

  it('stands every variant on its soles, with the ankle over the foot', () => {
    // The walker's equivalent of the swimmers' waterline bite: the client places
    // the origin at the terrain height, so the sole has to BE that height. The
    // ankle sits half a foot above it — never below, which would put the joint
    // through the snow.
    for (const variant of VARIANTS) {
      const metrics = YETI_VARIANT_METRICS[variant];
      const soleToAnkle = YETI_VARIANT_SPECS[variant].leg.footHeight * metrics.scale;
      expect(metrics.ankleHeight).toBeGreaterThan(0);
      expect(metrics.ankleHeight).toBeLessThanOrEqual(soleToAnkle);
    }
  });

  it('wears fur rather than skin: a deeper carve and the strongest mottle', () => {
    // THE CARVE IS COMPARED RELATIVE TO THE BODY IT IS ON, as a fraction of the
    // creature's height, and that is the only comparison that was ever meant: an
    // absolute depth says nothing across animals of different sizes.
    const relativeCarve = (depth: number, height: number): number => depth / height;
    expect(relativeCarve(YETI_FUR_WRINKLE_DEPTH, YETI_TOTAL_HEIGHT)).toBeGreaterThan(
      relativeCarve(KRAKEN_MANTLE_WRINKLE_DEPTH, KRAKEN_WIDTH_CELLS),
    );
    expect(relativeCarve(YETI_FUR_WRINKLE_DEPTH, YETI_TOTAL_HEIGHT)).toBeGreaterThan(
      relativeCarve(CTHULHU_BODY_WRINKLE_DEPTH, CTHULHU_TOTAL_HEIGHT),
    );
    // Shade variation is already a FRACTION of the material's colour, so it is
    // scale-free and compares directly.
    expect(YETI_SHADE_VARIATION).toBeGreaterThan(KRAKEN_SHADE_VARIATION);
  });

  it('gives each variant the coat, horns and fangs its concept was picked for', () => {
    // The four are a DECISION (owner, 2026-08-26), not four random tunings, and
    // these are the four one-line theses. A variant that quietly loses its horns
    // is a variant that has stopped being the one that was chosen.
    expect(YETI_VARIANT_SPECS.silverback.saddle).not.toBe(0);
    expect(YETI_VARIANT_SPECS.silverback.horns).toBe('none');
    expect(YETI_VARIANT_SPECS.ram.horns).toBe('ram');
    expect(YETI_VARIANT_SPECS.ibex.horns).toBe('ibex');
    expect(YETI_VARIANT_SPECS.fanged.horns).toBe('stub');
    expect(YETI_VARIANT_SPECS.fanged.fangs).toBeGreaterThan(YETI_VARIANT_SPECS.ram.fangs);
    expect(YETI_VARIANT_SPECS.ibex.hunch).toBeLessThan(YETI_VARIANT_SPECS.silverback.hunch);
  });
});

describe('the yeti gait', () => {
  const VARIANTS = ['silverback', 'ram', 'ibex', 'fanged'] as const;

  it('derives its rate from the speed the server actually moves him at', () => {
    // The skating-feet bug is a walk cycle whose rate has nothing to do with how
    // fast the thing travels. The client half restates the server's speed rather
    // than importing it (the bundle must not pull the server in); this is the
    // test that says the two are meant to be the same number.
    expect(cellsAcross(YETI_MODEL_AMBLE_SPEED)).toBe(YETI_AMBLE_SPEED_CELLS_PER_SECOND);
    // PER VARIANT, since the four have different legs and therefore different
    // strides: each one's cycle rate times its own stride has to come back to
    // the one speed the server moves any yeti at.
    for (const variant of VARIANTS) {
      const metrics = YETI_VARIANT_METRICS[variant];
      expect(cellsAcross(metrics.ambleHz * metrics.strideCells)).toBeCloseTo(
        YETI_AMBLE_SPEED_CELLS_PER_SECOND,
        10,
      );
    }
  });

  it('takes a short step, and derives one swing angle from all four', () => {
    // A heavy short-legged animal picking its way over snow strides well under
    // half its leg length — and because the stride is a FRACTION of the leg, the
    // angle comes out identical for every body, which is the sign the
    // derivation runs the right way round.
    for (const variant of VARIANTS) {
      const metrics = YETI_VARIANT_METRICS[variant];
      expect(metrics.strideCells / 2).toBeLessThan(metrics.legLength / 2);
      expect(Math.sin(YETI_LEG_SWING_RADIANS) * metrics.legLength).toBeCloseTo(
        metrics.strideCells / 4,
        10,
      );
      expect(metrics.legSwingRadians).toBe(YETI_LEG_SWING_RADIANS);
    }
  });

  it('reads as a weight shift rather than a march when he is standing still', () => {
    // The wire carries no gait flag — deliberately (protocol.ts) — so the cycle
    // runs whatever he is doing. Under 15° is the amplitude that survives that.
    expect(YETI_LEG_SWING_RADIANS).toBeLessThan(0.26);
    expect(YETI_ARM_SWING_RADIANS).toBeLessThan(YETI_LEG_SWING_RADIANS);
  });

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

  it('exists for exactly the swimmer kinds', () => {
    expect(dreadSpecOf('cthulhu')).not.toBeNull();
    expect(dreadSpecOf('kraken')).not.toBeNull();
    expect(dreadSpecOf('yeti')).toBeNull();
  });

  it('keeps every kind\'s mist bank under its own eyes, bob included', () => {
    for (const kind of SWIMMERS) {
      const spec = dreadSpecOf(kind)!;
      const top = spec.mistLayers[spec.mistLayers.length - 1]!;
      expect(top.height + top.bobCells).toBeLessThan(spec.eyeHeightAboveWaterCells);
      // Bolts terminate in that same bank, whatever height it scaled to.
      expect(spec.boltBottomCells).toBe(top.height);
    }
  });

  it('rakes each kind\'s flash light across its silhouette from just above it', () => {
    for (const kind of SWIMMERS) {
      const spec = dreadSpecOf(kind)!;
      expect(spec.flashLightHeightCells).toBeGreaterThan(spec.silhouetteAboveWaterCells);
      expect(BOLT_TOP_CELLS).toBeGreaterThan(spec.silhouetteAboveWaterCells);
    }
  });

  it('keeps every kind\'s bolts outside its own footprint', () => {
    expect(dreadSpecOf('cthulhu')!.boltMinRadiusCells).toBeGreaterThan(CTHULHU_WIDTH_CELLS / 2);
    expect(dreadSpecOf('kraken')!.boltMinRadiusCells).toBeGreaterThan(KRAKEN_WIDTH_CELLS / 2);
    for (const kind of SWIMMERS) {
      expect(dreadSpecOf(kind)!.boltMinRadiusCells).toBeLessThan(BOLT_MAX_RADIUS_CELLS);
    }
  });

  it('reproduces the authored values exactly for the anatomy they were authored on', () => {
    // Parameterised, not retuned: Cthulhu's spec IS the original effect.
    const spec = dreadSpecOf('cthulhu')!;
    expect(spec.eyeHeightAboveWaterCells).toBe(EYE_HEIGHT_ABOVE_WATER_CELLS);
    expect(spec.silhouetteAboveWaterCells).toBe(SILHOUETTE_ABOVE_WATER_CELLS);
    expect(spec.flashLightHeightCells).toBe(FLASH_LIGHT_HEIGHT_CELLS);
    expect(spec.boltMinRadiusCells).toBe(BOLT_MIN_RADIUS_CELLS);
    expect(spec.mistLayers).toEqual(MIST_LAYERS);
    expect(FLASH_LIGHT_HEIGHT_CELLS).toBe(
      SILHOUETTE_ABOVE_WATER_CELLS + FLASH_LIGHT_CLEARANCE_CELLS,
    );
  });
});

describe('dread: the mist bank', () => {
  it('belongs to the SEA kinds only', () => {
    // The client attaches it on exactly this test (client/index.ts), and the
    // reason is geometric rather than aesthetic: every sheet in the bank is
    // authored above SEA_SURFACE_WORLD_Y, so on a mountain animal it would be a
    // mist bank at sea level under a peak nine bands up.
    expect(placementRuleOf('cthulhu').placement).toBe('swimmer');
    expect(placementRuleOf('kraken').placement).toBe('swimmer');
    expect(placementRuleOf('yeti').placement).not.toBe('swimmer');
  });

  const topLayer = MIST_LAYERS[MIST_LAYERS.length - 1]!;

  it('never drifts over the eyes', () => {
    // The face is what the model is for; mist that covered it would be
    // atmosphere bought by hiding the thing the atmosphere is about. The bob is
    // in the sum because the sheet spends half its time above its stated height.
    expect(topLayer.height + topLayer.bobCells).toBeLessThan(EYE_HEIGHT_ABOVE_WATER_CELLS);
  });

  it('keeps every sheet above the water it lies on', () => {
    // A sheet whose bob took it below the sea surface would spend half of every
    // cycle being dimmed by a translucent plane the size of the world.
    for (const layer of MIST_LAYERS) {
      expect(layer.height - layer.bobCells).toBeGreaterThan(0);
    }
  });

  it('stacks: each sheet sits higher, narrower and fainter than the last', () => {
    for (let index = 1; index < MIST_LAYERS.length; index++) {
      const below = MIST_LAYERS[index - 1]!;
      const above = MIST_LAYERS[index]!;
      expect(above.height).toBeGreaterThan(below.height);
      expect(above.radiusScale).toBeLessThan(below.radiusScale);
      expect(above.opacity).toBeLessThan(below.opacity);
    }
  });

  it('stays local — it can never read as fog over the scene', () => {
    // Every sheet is inside the stated bank radius, which is a small multiple of
    // the monster's own footprint. Nothing here touches scene.fog, which is the
    // global this effect exists to avoid.
    for (const layer of MIST_LAYERS) {
      expect(layer.radiusScale).toBeGreaterThan(0);
      expect(layer.radiusScale).toBeLessThanOrEqual(1);
    }
    expect(MIST_RADIUS_CELLS).toBeGreaterThan(0);
  });

  it('fades all the way in and all the way back out, in the stated time', () => {
    // ARRIVAL is the contract: the plugin frees the effect's GPU resources when
    // the fade reaches zero, so an envelope that only approached it would leak.
    const dt = 1 / 60;
    let envelope = 0;
    let frames = 0;
    while (envelope < 1 && frames < 10_000) {
      envelope = approachEnvelope(envelope, 1, dt, MIST_FADE_SECONDS);
      frames++;
    }
    expect(envelope).toBe(1);
    expect(frames * dt).toBeCloseTo(MIST_FADE_SECONDS, 1);

    frames = 0;
    while (envelope > 0 && frames < 10_000) {
      envelope = approachEnvelope(envelope, 0, dt, MIST_FADE_SECONDS);
      frames++;
    }
    expect(envelope).toBe(0);
    expect(frames * dt).toBeCloseTo(MIST_FADE_SECONDS, 1);
  });

  it('never overshoots its target', () => {
    // A frame far longer than the fade (a background tab coming back) must land
    // ON the target rather than past it and back.
    expect(approachEnvelope(0, 1, 60, MIST_FADE_SECONDS)).toBe(1);
    expect(approachEnvelope(1, 0, 60, MIST_FADE_SECONDS)).toBe(0);
  });
});

describe('dread: lightning', () => {
  it('strikes clear of the model, inside the mist', () => {
    // The bolt is additive and depth-tested: one drawn through the wings would
    // light the inside of the monster, which reads as a bug, not as weather.
    expect(BOLT_MIN_RADIUS_CELLS).toBeGreaterThan(CTHULHU_WIDTH_CELLS / 2);
    expect(BOLT_MAX_RADIUS_CELLS).toBeGreaterThan(BOLT_MIN_RADIUS_CELLS);
    expect(BOLT_MAX_RADIUS_CELLS).toBeLessThanOrEqual(MIST_RADIUS_CELLS);
  });

  it('falls out of the sky and terminates in the bank', () => {
    expect(BOLT_TOP_CELLS).toBeGreaterThan(SILHOUETTE_ABOVE_WATER_CELLS);
    expect(BOLT_BOTTOM_CELLS).toBe(MIST_LAYERS[MIST_LAYERS.length - 1]!.height);
    expect(BOLT_TOP_CELLS).toBeGreaterThan(BOLT_BOTTOM_CELLS);
  });

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

  it('averages an occasional strike, not a rhythm', () => {
    const random = createStrikeRandom(7);
    const samples = 20_000;
    let total = 0;
    for (let sample = 0; sample < samples; sample++) {
      total += nextFlashIntervalSeconds(random());
    }
    // The two clamps pull the realised mean either side of the nominal one; what
    // matters is that it stays inside the "occasional" band the effect is for.
    expect(MEAN_FLASH_INTERVAL_SECONDS).toBeGreaterThanOrEqual(8);
    expect(MEAN_FLASH_INTERVAL_SECONDS).toBeLessThanOrEqual(15);
    expect(total / samples).toBeGreaterThan(8);
    expect(total / samples).toBeLessThan(15);
  });

  it('rises once and falls once, and is dark outside the strike', () => {
    expect(flashBrightness(-1)).toBe(0);
    expect(flashBrightness(FLASH_DURATION_SECONDS)).toBe(0);
    expect(flashBrightness(FLASH_DURATION_SECONDS * 2)).toBe(0);
    expect(flashBrightness(FLASH_ATTACK_SECONDS)).toBeCloseTo(1, 10);

    let direction = 0;
    let turns = 0;
    let previous = 0;
    for (let step = 1; step <= 2000; step++) {
      const brightness = flashBrightness((step / 1000) * FLASH_DURATION_SECONDS);
      expect(brightness).toBeGreaterThanOrEqual(0);
      expect(brightness).toBeLessThanOrEqual(1);
      const sign = Math.sign(brightness - previous);
      if (sign !== 0 && sign !== direction) {
        turns++;
        direction = sign;
      }
      previous = brightness;
    }
    // Exactly two: up, then down. A third would be a flicker, which is the
    // waveform this effect is forbidden to produce.
    expect(turns).toBe(2);
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

  it('gives every client the same mist and a different bolt', () => {
    // The randomness is seeded client-side on purpose: this is visual weather,
    // not world state. Two differently seeded generators must diverge — if they
    // did not, the seeding would be decoration.
    const one = createStrikeRandom(1);
    const two = createStrikeRandom(2);
    let differed = false;
    for (let sample = 0; sample < 16; sample++) {
      const a = one();
      const b = two();
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
      if (a !== b) differed = true;
    }
    expect(differed).toBe(true);
    // ...while the MIST is geometry: no random anywhere in it, so every client
    // builds the same bank, exactly as every client builds the same wrinkles.
    expect(MIST_LAYERS.every((layer) => Number.isFinite(layer.height))).toBe(true);
  });
});
