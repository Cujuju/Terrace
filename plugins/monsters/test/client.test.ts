// The client half's PURE logic: payload validation, interpolation, and the
// placement/silhouette maths. Rendering is verified by eye per design §8 ("no
// headless GL rig"), so nothing here imports three — which is also what lets it
// run in the same node environment as the server tests.

import { describe, expect, it } from 'vitest';
import { SEA_LEVEL } from '@terrace/shared';
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
  lurkDepthOf,
  monsterOriginWorldY,
  submergedFraction,
} from '../client/placement.ts';
import { CTHULHU_FOOTPRINT_CELLS, KRAKEN_FOOTPRINT_CELLS } from '../server/kinds.ts';

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

describe('dread: the mist bank', () => {
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
