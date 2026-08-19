// The client half's PURE logic: payload validation, interpolation, and the
// placement/silhouette maths. Rendering is verified by eye per design §8 ("no
// headless GL rig"), so nothing here imports three — which is also what lets it
// run in the same node environment as the server tests.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, MIN_HEIGHT, SEA_LEVEL } from '@terrace/shared';
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
  KRAKEN_MANTLE_BASE_HEIGHT,
  KRAKEN_MANTLE_RADIUS,
  KRAKEN_MANTLE_TOP,
  KRAKEN_MANTLE_WRINKLE_DEPTH,
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
  YETI_AMBLE_HZ,
  YETI_AMBLE_SPEED_CELLS_PER_SECOND as YETI_MODEL_AMBLE_SPEED,
  YETI_ARM_HAND_DROP,
  YETI_ARM_HAND_FLARE,
  YETI_ARM_HAND_FORWARD,
  YETI_ARM_SWING_RADIANS,
  YETI_BOB_CELLS,
  YETI_FOOT_CENTER_HEIGHT,
  YETI_FOOT_GROUND_HALF_EXTENT_CELLS,
  YETI_FOOT_RISE,
  YETI_FOOT_WIDTH,
  YETI_FUR_WRINKLE_DEPTH,
  YETI_HAND_HEIGHT,
  YETI_HAND_RADIUS,
  YETI_HAND_REACH,
  YETI_HEAD_TOP,
  YETI_HIP_HEIGHT,
  YETI_LEAN_RADIANS,
  YETI_LEG_LENGTH,
  YETI_LEG_SWING_RADIANS,
  YETI_RUFF_REACH,
  YETI_RUFF_TUFT_COUNT,
  YETI_RUFF_TUFT_TIP_RADIUS,
  YETI_SHADE_VARIATION,
  YETI_SHOULDER_HALF_SPAN,
  YETI_SHOULDER_JOINT_HALF_SPAN,
  YETI_SHOULDER_JOINT_HEIGHT,
  YETI_SHOULDER_WIDTH,
  YETI_STANCE_HALF_WIDTH,
  YETI_STRIDE_CELLS,
  YETI_TORSO_WIDTH,
  YETI_TOTAL_HEIGHT,
  YETI_WIDTH_CELLS,
} from '../client/yeti-anatomy.ts';
import {
  CTHULHU_FOOTPRINT_CELLS,
  KRAKEN_FOOTPRINT_CELLS,
  YETI_AMBLE_SPEED_CELLS_PER_SECOND,
  YETI_FOOTPRINT_CELLS,
} from '../server/kinds.ts';

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
    expect(krakenSubmerged).toBeLessThan(0.2);
    expect(krakenSubmerged).toBeLessThan(
      submergedFraction(monsterOriginWorldY(-20, CTHULHU_DEPTH), CTHULHU_TOTAL_HEIGHT),
    );
  });

  it('puts the kraken\'s eyes at the waterline and its mantle clear of it', () => {
    const originY = monsterOriginWorldY(-20, lurkDepthOf('kraken'));
    // Eye bottoms exactly one waterline bite under; the mantle standing out.
    expect(originY + KRAKEN_EYE_BOTTOM).toBeCloseTo(-KRAKEN_WATERLINE_BITE, 10);
    expect(originY + KRAKEN_MANTLE_TOP).toBeGreaterThan(SEA_SURFACE_WORLD_Y);
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
    expect(CTHULHU_WIDTH_CELLS).toBe(CTHULHU_FOOTPRINT_CELLS);
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
    expect(KRAKEN_WIDTH_CELLS).toBe(KRAKEN_FOOTPRINT_CELLS);
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
    expect(KRAKEN_MANTLE_RADIUS).toBeLessThanOrEqual(halfFootprint);
    // ...and the arm tip really is the widest of them, which is what the anatomy
    // claims when it names the binding constraint.
    expect(KRAKEN_ARM_TIP_REACH + KRAKEN_ARM_TIP_RADIUS).toBeGreaterThan(crestReach);
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

  it('is shorter than Cthulhu and wears its height as a mantle, not a skull', () => {
    expect(KRAKEN_TOTAL_HEIGHT).toBeLessThan(CTHULHU_TOTAL_HEIGHT);
    expect(KRAKEN_TOTAL_HEIGHT).toBe(KRAKEN_MANTLE_TOP);
    expect(KRAKEN_MANTLE_TOP).toBeGreaterThan(KRAKEN_HEAD_TOP);
    // Taller than it is wide, like the other one: a raft is not a monster.
    expect(KRAKEN_TOTAL_HEIGHT).toBeGreaterThan(KRAKEN_WIDTH_CELLS);
  });

  it('buries the mantle\'s collar inside the head instead of balancing it on top', () => {
    expect(KRAKEN_MANTLE_BASE_HEIGHT).toBeLessThan(KRAKEN_HEAD_TOP);
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
    expect(walkerGroundWorldY(straddling, 10.5, 10.5, YETI_FOOT_GROUND_HALF_EXTENT_CELLS)).toBe(12);
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
    expect(YETI_FOOT_GROUND_HALF_EXTENT_CELLS).toBeGreaterThanOrEqual(
      YETI_STANCE_HALF_WIDTH + YETI_FOOT_WIDTH / 2,
    );
    expect(YETI_FOOT_GROUND_HALF_EXTENT_CELLS).toBeLessThan(YETI_WIDTH_CELLS / 2);
  });

  it('puts the sole exactly on the origin plane', () => {
    // The walker's equivalent of the swimmers' waterline bite: the client places
    // the origin at the terrain height, so the bottom of the foot has to BE the
    // origin's height, or he hovers.
    expect(YETI_FOOT_CENTER_HEIGHT - YETI_FOOT_RISE / 2).toBe(0);
  });
});

describe('the yeti silhouette', () => {
  const halfFootprint = YETI_WIDTH_CELLS / 2;

  it('agrees with the server about how wide he is', () => {
    // Same arrangement as the other two kinds': the server steers by its own
    // copy of this number, the client half must not be imported by the server,
    // so the two are pinned to each other here.
    expect(YETI_WIDTH_CELLS).toBe(YETI_FOOTPRINT_CELLS);
    // ...and he is NARROWER than the sea horrors, on purpose: he is an animal,
    // and his minimum snowfield is derived from this number.
    expect(YETI_FOOTPRINT_CELLS).toBeLessThan(CTHULHU_FOOTPRINT_CELLS);
    expect(YETI_FOOTPRINT_CELLS).toBeLessThan(KRAKEN_FOOTPRINT_CELLS);
  });

  it('is the smallest of the three, and still taller than he is wide', () => {
    expect(YETI_TOTAL_HEIGHT).toBeLessThan(KRAKEN_TOTAL_HEIGHT);
    expect(YETI_TOTAL_HEIGHT).toBeLessThan(CTHULHU_TOTAL_HEIGHT);
    expect(YETI_TOTAL_HEIGHT).toBeGreaterThan(YETI_WIDTH_CELLS);
    // The crown of the head is the highest point, which is what the total is.
    expect(YETI_TOTAL_HEIGHT).toBe(YETI_HEAD_TOP);
  });

  it('hangs its hands below its hips — the one proportion that says APE', () => {
    expect(YETI_HAND_HEIGHT).toBeLessThan(YETI_HIP_HEIGHT);
  });

  it('keeps the shoulders and the ruff inside the footprint', () => {
    expect(YETI_SHOULDER_HALF_SPAN + YETI_SHOULDER_WIDTH / 2).toBeLessThanOrEqual(halfFootprint);
    expect(YETI_RUFF_REACH + YETI_RUFF_TUFT_TIP_RADIUS).toBeLessThanOrEqual(halfFootprint);
    expect(YETI_TORSO_WIDTH / 2).toBeLessThanOrEqual(halfFootprint);
    // Odd, so a tuft lies on the centre line and the collar is symmetric about
    // the way he faces. (Cthulhu's face tentacles are odd for the same reason.)
    expect(YETI_RUFF_TUFT_COUNT % 2).toBe(1);
  });

  it('keeps a hand inside it — the binding constraint, standing still', () => {
    expect(YETI_HAND_REACH + YETI_HAND_RADIUS).toBeLessThanOrEqual(halfFootprint);
    // ...and it really is the widest thing on him.
    expect(YETI_HAND_REACH + YETI_HAND_RADIUS).toBeGreaterThan(
      YETI_SHOULDER_HALF_SPAN + YETI_SHOULDER_WIDTH / 2,
    );
  });

  it('keeps a hand inside it while the gait is running, too', () => {
    // Written the way the builder computes it: the arm swings about its shoulder
    // joint in the fore-aft plane, then the LEAN rolls the whole upper body
    // about the rig's origin. Both are taken at their peaks at once, which the
    // animation never actually does — the lean is a cosine and the swing a sine
    // of the same wave, so they are a quarter cycle apart — making this a strict
    // upper bound on a measured worst case of 2.15 cells.
    const swung = {
      x:
        YETI_ARM_HAND_DROP * Math.sin(YETI_ARM_SWING_RADIANS) +
        YETI_ARM_HAND_FORWARD * Math.cos(YETI_ARM_SWING_RADIANS),
      y:
        YETI_SHOULDER_JOINT_HEIGHT -
        (YETI_ARM_HAND_DROP * Math.cos(YETI_ARM_SWING_RADIANS) -
          YETI_ARM_HAND_FORWARD * Math.sin(YETI_ARM_SWING_RADIANS)),
      z: YETI_SHOULDER_JOINT_HALF_SPAN + YETI_ARM_HAND_FLARE,
    };
    // The lean can only push the outboard hand further out by |y|·sin(lean).
    const leaned =
      swung.z * Math.cos(YETI_LEAN_RADIANS) + swung.y * Math.sin(YETI_LEAN_RADIANS);
    const reach = Math.hypot(swung.x, leaned) + YETI_HAND_RADIUS;

    expect(reach).toBeLessThanOrEqual(halfFootprint);
  });

  it('wears fur rather than skin: a deeper carve and the strongest mottle', () => {
    // A white mass in sunlight has no contrast of its own, which is why he needs
    // the largest shade variation of the three, and fur is a surface that is
    // broken everywhere, which is why the carve is the deepest.
    expect(YETI_FUR_WRINKLE_DEPTH).toBeGreaterThan(KRAKEN_MANTLE_WRINKLE_DEPTH);
    expect(YETI_FUR_WRINKLE_DEPTH).toBeGreaterThan(CTHULHU_BODY_WRINKLE_DEPTH);
    expect(YETI_SHADE_VARIATION).toBeGreaterThan(KRAKEN_SHADE_VARIATION);
  });
});

describe('the yeti gait', () => {
  it('derives its rate from the speed the server actually moves him at', () => {
    // The skating-feet bug is a walk cycle whose rate has nothing to do with how
    // fast the thing travels. The client half restates the server's speed rather
    // than importing it (the bundle must not pull the server in); this is the
    // test that says the two are meant to be the same number.
    expect(YETI_MODEL_AMBLE_SPEED).toBe(YETI_AMBLE_SPEED_CELLS_PER_SECOND);
    expect(YETI_AMBLE_HZ * YETI_STRIDE_CELLS).toBeCloseTo(YETI_AMBLE_SPEED_CELLS_PER_SECOND, 10);
  });

  it('takes a short step, and derives the swing angle from it', () => {
    // A heavy short-legged animal picking its way over snow strides well under
    // half its leg length.
    expect(YETI_STRIDE_CELLS / 2).toBeLessThan(YETI_LEG_LENGTH / 2);
    expect(Math.sin(YETI_LEG_SWING_RADIANS) * YETI_LEG_LENGTH).toBeCloseTo(
      YETI_STRIDE_CELLS / 4,
      10,
    );
  });

  it('reads as a weight shift rather than a march when he is standing still', () => {
    // The wire carries no gait flag — deliberately (protocol.ts) — so the cycle
    // runs whatever he is doing. Under 15° is the amplitude that survives that;
    // a convincing WALK (25–30°, as a human's) would make a stationary yeti look
    // like he was marching on the spot.
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
    expect(YETI_BOB_CELLS).toBeLessThan(YETI_FOOT_RISE);
    expect(YETI_LEAN_RADIANS).toBeGreaterThan(0);
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
