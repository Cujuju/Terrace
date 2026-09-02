// The almanac clock: the world's day drawn as a horizon line, the sun or moon
// on its arc above or below it, and the words of the clock — weekday, day
// number, time — laid out around it. Rendered inside the world header
// (WorldHeader.tsx) from the reading the day/night plugin writes through
// plugins/hudPanels.ts.
//
// THE PICTURE (owner pick, 2026-09-01, concept "06A pinned" of ten): a strip
// the width of the banner. Above the horizon line, a sky gradient that runs
// night → dawn → day → dusk → night left to right; below it, dark ground with
// stars under the night hours. A dotted curve traces the whole day's path —
// up over the horizon between sunrise and sunset, down under it through the
// night — and the current body sits on that curve at the fraction of the day
// the reading names. The weekday is captioned top-left, the day number
// bottom-left, and the time sits in a fixed tag at the bottom centre: the
// night curve only dips near the strip's edges, so nothing ever crosses it and
// the eye learns one place to look for the time.
//
// CORE DRAWS, THE PLUGIN DECIDES. Every number here is a fraction of the day
// handed over as `phase` (WorldClockReading); this file never advances a
// clock, never wraps a phase and never formats a time. The one piece of sky
// knowledge it restates is the convention that phase 0 is dawn and 0.5 dusk —
// the same one the wire uses — because it must know where the horizon
// crossings are to draw them.
//
// STATIC PARTS ARE BUILT ONCE. The curve, the gradients, the stars and the
// horizon ticks depend on nothing in the reading, so they are module-level
// constants rather than per-render work; the only nodes that change from one
// minute to the next are the two bodies, the tag text and the two captions.

import { createMemo, type JSX } from 'solid-js';
import type { WorldClockReading } from '../plugins/hudPanels.ts';

// ── Geometry, in the strip's own units (the SVG viewBox; CSS scales it) ─────

/** The strip's drawing size. 220 fits under the longest generated world name
 *  at the header's 17px title without widening the banner. */
const STRIP_WIDTH = 220;
const STRIP_HEIGHT = 48;
/** Where the horizon line sits: the sky gets a little less than half the strip,
 *  the ground the rest, because the ground also has to hold the time tag. */
const HORIZON_Y = 21;
/** How high the day arc climbs above the horizon at noon … */
const DAY_ARC_HEIGHT = 12;
/** … and how deep the night arc dips at midnight. Shallower than the day arc so
 *  the moon at its lowest clears the tag and the day caption. */
const NIGHT_ARC_DEPTH = 9;
/** Corner radius of the sky and ground panels. */
const PANEL_RADIUS = 3;

/**
 * Phase conventions restated from the day/night wire (plugins/daynight/
 * protocol.ts): 0 is sunrise, 0.5 sunset, so daytime is the first half of
 * the lap. The strip's LEFT EDGE IS MIDNIGHT, so the sun rises a quarter of
 * the way across — which is where `PHASE_OF_MIDNIGHT` moves it.
 */
const SUNSET_PHASE = 0.5;
const PHASE_OF_MIDNIGHT = 0.75;
const SUNRISE_X = STRIP_WIDTH * (1 - PHASE_OF_MIDNIGHT);
const SUNSET_X = STRIP_WIDTH * (1 - PHASE_OF_MIDNIGHT + SUNSET_PHASE);

/**
 * How long the handover at each horizon takes, as a fraction of the day: the
 * setting body fades out while the rising one fades in over this span,
 * centred on the crossing. Half an in-world hour — long enough to read as a
 * dissolve at the 1 s-per-minute clock rate, short enough that the sky is
 * never showing two bodies at full strength.
 */
const HANDOVER_PHASE_SPAN = 0.5 / 24;
/** Where the body that is not in the sky waits during the handover: just under
 *  the horizon, so it fades in rising and fades out setting. */
const BELOW_HORIZON_Y = HORIZON_Y + 2;

/** Sun disc and its glow halo. */
const SUN_RADIUS = 3.2;
const SUN_HALO_RADIUS = 7;
const SUN_HALO_OPACITY = 0.18;
/** Moon disc; the crescent is cut by a second circle offset toward its lit
 *  side — see MOON_MASK below. */
const MOON_RADIUS = 3.4;

/** The pinned time tag, centred at the bottom of the ground. */
const TAG_WIDTH = 34;
const TAG_HEIGHT = 10;
const TAG_RADIUS = 2;
const TAG_X = STRIP_WIDTH / 2 - TAG_WIDTH / 2;
const TAG_Y = STRIP_HEIGHT - TAG_HEIGHT - 3;

/** Caption baselines: weekday in the sky's top-left, day in the ground's
 *  bottom-left. */
const CAPTION_X = 3;
const WEEKDAY_BASELINE_Y = 7.5;
const DAY_BASELINE_Y = STRIP_HEIGHT - 3;

/** Horizon ticks at the two crossings. */
const TICK_HALF_HEIGHT = 3;

/** How finely the day's curve is sampled — 8 per hour reads as smooth at any
 *  size the banner is drawn at. */
const CURVE_SAMPLES = 24 * 8;

// ── Palette — the sky's colours, named for the hours they stand for ─────────

const NIGHT_DEEP = '#151c33';
const NIGHT = '#5468a8';
const DAWN = '#f0a36b';
const DUSK = '#e8865f';
const DAY_SKY = '#79b5e6';
const DAY_SKY_HIGH = '#c9e6fb';
const GROUND_TOP = '#1a2238';
const GROUND_BOTTOM = '#0c1020';
const SUN = '#f2c14e';
const SUN_HOT = '#ffe58f';
const MOON = '#e6edf7';
/** The tag's fill is the HUD's own slate so it reads as chrome, not sky. */
const TAG_FILL = '#0f141b';
const SKY_OPACITY = 0.8;
/** The horizon line and the dotted day path, both white at a whisper. */
const HORIZON_STROKE = 'rgba(255, 255, 255, 0.35)';
const CURVE_STROKE = 'rgba(255, 255, 255, 0.28)';
const TAG_STROKE = 'rgba(255, 255, 255, 0.18)';

/** Stars: how many in each night half of the ground, and the seeds that fix
 *  their places so the sky is the same on every render. */
const STARS_PER_NIGHT_HALF = 9;
const STAR_SEED_LEFT = 11;
const STAR_SEED_RIGHT = 23;
const STAR_MIN_RADIUS = 0.4;
const STAR_RADIUS_RANGE = 0.6;
const STAR_MIN_OPACITY = 0.25;
const STAR_OPACITY_RANGE = 0.6;

// ── Pure geometry ────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** Horizontal position of a phase: midnight at the left edge, wrapping. */
function xOfPhase(phase: number): number {
  return ((phase - PHASE_OF_MIDNIGHT + 1) % 1) * STRIP_WIDTH;
}

/** Vertical position of a phase: above the horizon by day, below it by night —
 *  the same single sine the sky rig uses for the sun's height. */
function yOfPhase(phase: number): number {
  const height = Math.sin(phase * TWO_PI);
  return HORIZON_Y - height * (height >= 0 ? DAY_ARC_HEIGHT : NIGHT_ARC_DEPTH);
}

function isDaytime(phase: number): boolean {
  return phase < SUNSET_PHASE;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * The sun's visibility at `phase`: 1 through the day, 0 through the night,
 * crossfading over HANDOVER_PHASE_SPAN centred on each horizon crossing. The
 * moon's is its complement.
 */
function sunVisibility(phase: number): number {
  // Signed distance from sunrise, in (-0.5, 0.5]: negative is "before dawn".
  const fromSunrise = phase > SUNSET_PHASE ? phase - 1 : phase;
  const risen = clamp01(0.5 + fromSunrise / HANDOVER_PHASE_SPAN);
  const set = clamp01(0.5 + (phase - SUNSET_PHASE) / HANDOVER_PHASE_SPAN);
  return risen * (1 - set);
}

const f1 = (n: number): string => n.toFixed(1);

/** The whole day's path, sampled once: left edge (midnight) to right edge. */
const CURVE_PATH = ((): string => {
  let d = '';
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const phase = (PHASE_OF_MIDNIGHT + i / CURVE_SAMPLES) % 1;
    const x = (i / CURVE_SAMPLES) * STRIP_WIDTH;
    d += `${i === 0 ? 'M' : 'L'}${f1(x)} ${f1(yOfPhase(phase))}`;
  }
  return d;
})();

/**
 * Fixed star fields under the two night stretches of the ground. A small
 * linear-congruential generator rather than Math.random so the stars are in
 * the same places every render and every session — a HUD element that changed
 * between mounts would look broken, not lively.
 */
interface Star {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly opacity: number;
}

function starField(xFrom: number, xTo: number, seed: number): readonly Star[] {
  let state = seed;
  const next = (): number => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  const yFrom = HORIZON_Y + 2;
  const yTo = STRIP_HEIGHT - 2;
  const stars: Star[] = [];
  for (let i = 0; i < STARS_PER_NIGHT_HALF; i++) {
    stars.push({
      x: xFrom + next() * (xTo - xFrom),
      y: yFrom + next() * (yTo - yFrom),
      r: STAR_MIN_RADIUS + next() * STAR_RADIUS_RANGE,
      opacity: STAR_MIN_OPACITY + next() * STAR_OPACITY_RANGE,
    });
  }
  return stars;
}

const STARS: readonly Star[] = [
  ...starField(0, SUNRISE_X, STAR_SEED_LEFT),
  ...starField(SUNSET_X, STRIP_WIDTH, STAR_SEED_RIGHT),
];

/** Gradient stop offsets, as fractions of the strip's width. */
const SUNRISE_FRACTION = SUNRISE_X / STRIP_WIDTH;
const SUNSET_FRACTION = SUNSET_X / STRIP_WIDTH;
/** How far either side of a crossing the warm dawn/dusk band reaches. */
const TWILIGHT_INNER_SPAN = 0.08;
const TWILIGHT_OUTER_SPAN = 0.04;

/** Element ids for the SVG defs. There is one header per page, so fixed ids
 *  cannot collide. */
const SKY_GRADIENT_ID = 'almanac-sky';
const GROUND_GRADIENT_ID = 'almanac-ground';
const MOON_MASK_ID = 'almanac-moon';

/** The crescent: a circle with a second, offset circle masked out of it. */
const MOON_MASK_CUT_DX = 1.9;
const MOON_MASK_CUT_DY = -0.9;
const MOON_MASK_CUT_RADIUS = 2.9;

// ── The component ────────────────────────────────────────────────────────────

export interface AlmanacClockProps {
  readonly reading: WorldClockReading;
}

export function AlmanacClock(props: AlmanacClockProps): JSX.Element {
  const phase = (): number => props.reading.phase;
  const x = createMemo(() => xOfPhase(phase()));
  const y = createMemo(() => yOfPhase(phase()));
  const sunAlpha = createMemo(() => sunVisibility(phase()));
  // The body in the sky follows the curve; the other waits under the horizon.
  const sunY = (): number => (isDaytime(phase()) ? y() : BELOW_HORIZON_Y);
  const moonY = (): number => (isDaytime(phase()) ? BELOW_HORIZON_Y : y());

  return (
    <svg
      class="almanac"
      viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
      width={STRIP_WIDTH}
      height={STRIP_HEIGHT}
      role="img"
      aria-label={[props.reading.weekday, props.reading.day !== null ? `Day ${props.reading.day}` : null, props.reading.time]
        .filter((part) => part !== null)
        .join(', ')}
    >
      <defs>
        <linearGradient id={SKY_GRADIENT_ID}>
          <stop offset={0} stop-color={NIGHT_DEEP} />
          <stop offset={SUNRISE_FRACTION - TWILIGHT_OUTER_SPAN} stop-color={NIGHT} />
          <stop offset={SUNRISE_FRACTION} stop-color={DAWN} />
          <stop offset={SUNRISE_FRACTION + TWILIGHT_INNER_SPAN} stop-color={DAY_SKY} />
          <stop offset={0.5} stop-color={DAY_SKY_HIGH} />
          <stop offset={SUNSET_FRACTION - TWILIGHT_INNER_SPAN} stop-color={DAY_SKY} />
          <stop offset={SUNSET_FRACTION} stop-color={DUSK} />
          <stop offset={SUNSET_FRACTION + TWILIGHT_OUTER_SPAN} stop-color={NIGHT} />
          <stop offset={1} stop-color={NIGHT_DEEP} />
        </linearGradient>
        <linearGradient id={GROUND_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
          <stop offset={0} stop-color={GROUND_TOP} />
          <stop offset={1} stop-color={GROUND_BOTTOM} />
        </linearGradient>
        <mask id={MOON_MASK_ID}>
          <rect
            x={-MOON_RADIUS - 2}
            y={-MOON_RADIUS - 2}
            width={MOON_RADIUS * 2 + 4}
            height={MOON_RADIUS * 2 + 4}
            fill="#fff"
          />
          <circle cx={MOON_MASK_CUT_DX} cy={MOON_MASK_CUT_DY} r={MOON_MASK_CUT_RADIUS} fill="#000" />
        </mask>
      </defs>

      {/* Sky and ground */}
      <rect
        x={0}
        y={0}
        width={STRIP_WIDTH}
        height={HORIZON_Y}
        rx={PANEL_RADIUS}
        fill={`url(#${SKY_GRADIENT_ID})`}
        opacity={SKY_OPACITY}
      />
      <rect
        x={0}
        y={HORIZON_Y}
        width={STRIP_WIDTH}
        height={STRIP_HEIGHT - HORIZON_Y}
        rx={PANEL_RADIUS}
        fill={`url(#${GROUND_GRADIENT_ID})`}
      />
      {STARS.map((star) => (
        <circle cx={f1(star.x)} cy={f1(star.y)} r={f1(star.r)} fill={MOON} opacity={f1(star.opacity)} />
      ))}

      {/* The day's path, the horizon, and its two crossings */}
      <path d={CURVE_PATH} fill="none" stroke={CURVE_STROKE} stroke-width={1} stroke-dasharray="1.5 2" />
      <line x1={0} y1={HORIZON_Y} x2={STRIP_WIDTH} y2={HORIZON_Y} stroke={HORIZON_STROKE} stroke-width={1} />
      <line
        x1={SUNRISE_X}
        y1={HORIZON_Y - TICK_HALF_HEIGHT}
        x2={SUNRISE_X}
        y2={HORIZON_Y + TICK_HALF_HEIGHT}
        stroke={DAWN}
        stroke-width={1.2}
      />
      <line
        x1={SUNSET_X}
        y1={HORIZON_Y - TICK_HALF_HEIGHT}
        x2={SUNSET_X}
        y2={HORIZON_Y + TICK_HALF_HEIGHT}
        stroke={DUSK}
        stroke-width={1.2}
      />

      {/* Captions */}
      <text class="almanac__weekday" x={CAPTION_X} y={WEEKDAY_BASELINE_Y}>
        {props.reading.weekday?.toUpperCase() ?? ''}
      </text>
      <text class="almanac__day" x={CAPTION_X} y={DAY_BASELINE_Y}>
        {props.reading.day !== null ? `DAY ${props.reading.day}` : ''}
      </text>

      {/* The bodies — both always in the tree, crossfading at the horizons */}
      <g transform={`translate(${f1(x())} ${f1(sunY())})`} opacity={f1(sunAlpha())}>
        <circle r={SUN_HALO_RADIUS} fill={SUN} opacity={SUN_HALO_OPACITY} />
        <circle r={SUN_RADIUS} fill={SUN_HOT} />
      </g>
      <g transform={`translate(${f1(x())} ${f1(moonY())})`} opacity={f1(1 - sunAlpha())}>
        <circle r={MOON_RADIUS} fill={MOON} mask={`url(#${MOON_MASK_ID})`} />
      </g>

      {/* The time, pinned */}
      <g transform={`translate(${TAG_X} ${TAG_Y})`}>
        <rect
          width={TAG_WIDTH}
          height={TAG_HEIGHT}
          rx={TAG_RADIUS}
          fill={TAG_FILL}
          stroke={TAG_STROKE}
          stroke-width={0.6}
        />
        <text class="almanac__time" x={TAG_WIDTH / 2} y={TAG_HEIGHT - 2.5}>
          {props.reading.time}
        </text>
      </g>
    </svg>
  );
}
