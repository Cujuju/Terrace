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
// THE PAINTING IS THE WHOLE BANNER (owner ask, 2026-09-01, after seeing the
// strip in-world): the sky and ground run edge to edge behind the title row
// too, so the header reads as one card painted with the hour rather than a
// title over a picture. The SVG therefore carries an empty TITLE BAND of sky
// at its top, sized to the title row's height, and WorldHeader overlays the
// name on it; a scrim darkens the band so the title stays legible at noon.
//
// THE PAINTING FITS THE CARD, THE CARD FITS THE NAME (owner rule, 2026-09-01:
// the name must never be reduced to an ellipsis). The banner's width is set
// by its title row in hud.css; the SVG fills that width and measures it with a
// ResizeObserver, and every horizontal position here is a function of the
// measured width, in units of one CSS pixel. The height never changes: the
// strip is TOTAL_HEIGHT px tall whatever the name is.
//
// STATIC PARTS ARE BUILT ONCE PER WIDTH. The curve, the stars, the tag's
// place and the horizon crossings depend only on the width, so they are memos
// keyed on it rather than per-render work; the gradients are in fractions of
// the width and never change at all. The only nodes that change from one
// minute to the next are the two bodies, the tag text and the two captions.

import { createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import type { WorldClockReading } from '../plugins/hudPanels.ts';

// ── Geometry, in CSS pixels (the SVG viewBox is sized 1:1 with the element) ─

/** The strip's narrowest width: what a short name leaves the painting, and
 *  the least the dawn-to-dusk arc needs to read as an arc. hud.css's
 *  .world-header__clock carries the same floor as its min-width. */
const STRIP_MIN_WIDTH = 220;
/**
 * The sky above the clock proper that the title row sits on. Matches the
 * title row's rendered height at 1× — 17px type at line-height 1.2 plus the
 * banner's 6px top padding — so the weekday caption below it clears the name.
 * hud.css's .world-header--almanac positions the title row over this band.
 */
const TITLE_BAND_HEIGHT = 28;
/**
 * Breathing room above and below the clock's words (owner ask, 2026-09-01,
 * after the first in-world look: the weekday sat hard under the title and the
 * banner's rounded corner clipped the day number). The sky and ground still
 * paint through the inset; only the captions, curve and tag keep clear of it.
 */
const STRIP_INSET = 5;
/** The clock strip itself, below the title band: the inset at both ends
 *  around the drawing proper. */
const STRIP_DRAWING_HEIGHT = 48;
const STRIP_HEIGHT = STRIP_INSET + STRIP_DRAWING_HEIGHT + STRIP_INSET;
const TOTAL_HEIGHT = TITLE_BAND_HEIGHT + STRIP_HEIGHT;
/** The top of the drawing proper, under the title band and the inset. */
const STRIP_TOP_Y = TITLE_BAND_HEIGHT + STRIP_INSET;
/** Where the horizon line sits: the strip's sky gets a little less than half of
 *  it, the ground the rest, because the ground also has to hold the time tag. */
const HORIZON_Y = STRIP_TOP_Y + 21;
/** How high the day arc climbs above the horizon at noon … */
const DAY_ARC_HEIGHT = 12;
/** … and how deep the night arc dips at midnight. Shallower than the day arc so
 *  the moon at its lowest clears the tag and the day caption. */
const NIGHT_ARC_DEPTH = 9;
/** How much of the title band the scrim darkens, fading to nothing at its
 *  foot so the sky shows through unbroken by a hard edge. */
const TITLE_SCRIM_OPACITY = 0.55;

/**
 * Phase conventions restated from the day/night wire (plugins/daynight/
 * protocol.ts): 0 is sunrise, 0.5 sunset, so daytime is the first half of
 * the lap. The strip's LEFT EDGE IS MIDNIGHT, so the sun rises a quarter of
 * the way across — which is where `PHASE_OF_MIDNIGHT` moves it.
 */
const SUNSET_PHASE = 0.5;
const PHASE_OF_MIDNIGHT = 0.75;
/** Where the two crossings fall, as fractions of the strip's width. */
const SUNRISE_FRACTION = 1 - PHASE_OF_MIDNIGHT;
const SUNSET_FRACTION = 1 - PHASE_OF_MIDNIGHT + SUNSET_PHASE;

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

/**
 * The pinned time tag, centred at the bottom of the ground. It is an HTML
 * element floated over the SVG, not a drawn rect (owner ask, 2026-09-01):
 * it wears the same frosted chrome as the title band, and `backdrop-filter`
 * does not apply to SVG content. The type is 8.5px (hud.css .almanac__time);
 * the tag is as wide as the time it holds. Its vertical place is set here,
 * in the painting's own pixels, so the geometry has one home.
 */
const TAG_HEIGHT = 12;
const TAG_TOP_Y = TOTAL_HEIGHT - STRIP_INSET - TAG_HEIGHT - 3;

/** Caption baselines: weekday in the sky's top-left, day in the ground's
 *  bottom-left. The x inset clears the banner's rounded corner, which
 *  otherwise bites the day number's first letter. */
const CAPTION_X = 6;
const WEEKDAY_BASELINE_Y = STRIP_TOP_Y + 7.5;
const DAY_BASELINE_Y = TOTAL_HEIGHT - STRIP_INSET - 3;

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
/** The scrim's tint is the HUD's own slate so it reads as chrome, not sky. */
const SCRIM_TINT = '#0f141b';
const SKY_OPACITY = 0.8;
/** The horizon line and the dotted day path, both white at a whisper. */
const HORIZON_STROKE = 'rgba(255, 255, 255, 0.35)';
const CURVE_STROKE = 'rgba(255, 255, 255, 0.28)';

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
function xOfPhase(phase: number, width: number): number {
  return ((phase - PHASE_OF_MIDNIGHT + 1) % 1) * width;
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

/** The whole day's path, sampled once per width: left edge (midnight) to
 *  right edge. */
function curvePath(width: number): string {
  let d = '';
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const phase = (PHASE_OF_MIDNIGHT + i / CURVE_SAMPLES) % 1;
    const x = (i / CURVE_SAMPLES) * width;
    d += `${i === 0 ? 'M' : 'L'}${f1(x)} ${f1(yOfPhase(phase))}`;
  }
  return d;
}

/**
 * Fixed star fields under the two night stretches of the ground. A small
 * linear-congruential generator rather than Math.random so the stars are in
 * the same places every render and every session — a HUD element that changed
 * between mounts would look broken, not lively. Positions are fractions of the
 * night stretch, so a wider strip spreads the same stars rather than rolling
 * new ones.
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
  const yTo = TOTAL_HEIGHT - STRIP_INSET - 2;
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

function stars(width: number): readonly Star[] {
  return [
    ...starField(0, SUNRISE_FRACTION * width, STAR_SEED_LEFT),
    ...starField(SUNSET_FRACTION * width, width, STAR_SEED_RIGHT),
  ];
}

/** How far either side of a crossing the warm dawn/dusk band reaches. */
const TWILIGHT_INNER_SPAN = 0.08;
const TWILIGHT_OUTER_SPAN = 0.04;

/** Element ids for the SVG defs. There is one header per page, so fixed ids
 *  cannot collide. */
const SKY_GRADIENT_ID = 'almanac-sky';
const GROUND_GRADIENT_ID = 'almanac-ground';
const TITLE_SCRIM_ID = 'almanac-scrim';
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
  // The strip's width in CSS pixels: the floor until the element is measured,
  // then whatever the card gives it. Integer so the viewBox stays 1:1 with
  // device pixels at 1× and the horizon line stays crisp.
  const [width, setWidth] = createSignal(STRIP_MIN_WIDTH);
  let svg: SVGSVGElement | undefined;
  onMount(() => {
    if (svg === undefined || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(Math.max(STRIP_MIN_WIDTH, measured));
    });
    observer.observe(svg);
    onCleanup(() => observer.disconnect());
  });

  const sunriseX = createMemo(() => SUNRISE_FRACTION * width());
  const sunsetX = createMemo(() => SUNSET_FRACTION * width());
  const path = createMemo(() => curvePath(width()));
  const skyStars = createMemo(() => stars(width()));

  const phase = (): number => props.reading.phase;
  const x = createMemo(() => xOfPhase(phase(), width()));
  const y = createMemo(() => yOfPhase(phase()));
  const sunAlpha = createMemo(() => sunVisibility(phase()));
  // The body in the sky follows the curve; the other waits under the horizon.
  const sunY = (): number => (isDaytime(phase()) ? y() : BELOW_HORIZON_Y);
  const moonY = (): number => (isDaytime(phase()) ? BELOW_HORIZON_Y : y());

  return (
    <>
    <svg
      ref={svg}
      class="almanac"
      viewBox={`0 0 ${width()} ${TOTAL_HEIGHT}`}
      height={TOTAL_HEIGHT}
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
        <linearGradient id={TITLE_SCRIM_ID} x1="0" y1="0" x2="0" y2="1">
          <stop offset={0} stop-color={SCRIM_TINT} stop-opacity={TITLE_SCRIM_OPACITY} />
          <stop offset={1} stop-color={SCRIM_TINT} stop-opacity={0} />
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

      {/* Sky and ground, edge to edge — the banner's own rounded corners clip
        * them (hud.css, overflow hidden) */}
      <rect
        x={0}
        y={0}
        width={width()}
        height={HORIZON_Y}
        fill={`url(#${SKY_GRADIENT_ID})`}
        opacity={SKY_OPACITY}
      />
      <rect
        x={0}
        y={HORIZON_Y}
        width={width()}
        height={TOTAL_HEIGHT - HORIZON_Y}
        fill={`url(#${GROUND_GRADIENT_ID})`}
      />
      <rect x={0} y={0} width={width()} height={TITLE_BAND_HEIGHT} fill={`url(#${TITLE_SCRIM_ID})`} />
      {skyStars().map((star) => (
        <circle cx={f1(star.x)} cy={f1(star.y)} r={f1(star.r)} fill={MOON} opacity={f1(star.opacity)} />
      ))}

      {/* The day's path, the horizon, and its two crossings */}
      <path d={path()} fill="none" stroke={CURVE_STROKE} stroke-width={1} stroke-dasharray="1.5 2" />
      <line x1={0} y1={HORIZON_Y} x2={width()} y2={HORIZON_Y} stroke={HORIZON_STROKE} stroke-width={1} />
      <line
        x1={sunriseX()}
        y1={HORIZON_Y - TICK_HALF_HEIGHT}
        x2={sunriseX()}
        y2={HORIZON_Y + TICK_HALF_HEIGHT}
        stroke={DAWN}
        stroke-width={1.2}
      />
      <line
        x1={sunsetX()}
        y1={HORIZON_Y - TICK_HALF_HEIGHT}
        x2={sunsetX()}
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

    </svg>
    {/* The time, pinned: frosted like the title band (hud.css) */}
    <span class="almanac__time hud-frost" style={{ top: `${TAG_TOP_Y}px`, height: `${TAG_HEIGHT}px` }}>
      {props.reading.time}
    </span>
    </>
  );
}
