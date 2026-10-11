import { createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import type { WorldClockReading } from '../plugins/hudPanels.ts';

const STRIP_MIN_WIDTH = 220;
const TITLE_BAND_HEIGHT = 28;
const STRIP_INSET = 5;
const STRIP_DRAWING_HEIGHT = 48;
const STRIP_HEIGHT = STRIP_INSET + STRIP_DRAWING_HEIGHT + STRIP_INSET;
const TOTAL_HEIGHT = TITLE_BAND_HEIGHT + STRIP_HEIGHT;
const STRIP_TOP_Y = TITLE_BAND_HEIGHT + STRIP_INSET;
const HORIZON_Y = STRIP_TOP_Y + 21;
const DAY_ARC_HEIGHT = 12;
const NIGHT_ARC_DEPTH = 9;
const TITLE_SCRIM_OPACITY = 0.55;

const SUNSET_PHASE = 0.5;
const PHASE_OF_MIDNIGHT = 0.75;
const SUNRISE_FRACTION = 1 - PHASE_OF_MIDNIGHT;
const SUNSET_FRACTION = 1 - PHASE_OF_MIDNIGHT + SUNSET_PHASE;

const HANDOVER_PHASE_SPAN = 0.5 / 24;
const BELOW_HORIZON_Y = HORIZON_Y + 2;

const SUN_RADIUS = 3.2;
const SUN_HALO_RADIUS = 7;
const SUN_HALO_OPACITY = 0.18;
const MOON_RADIUS = 3.4;

const TAG_HEIGHT = 12;
const TAG_TOP_Y = TOTAL_HEIGHT - STRIP_INSET - TAG_HEIGHT - 3;

const CAPTION_X = 6;
const WEEKDAY_TOP_Y = STRIP_TOP_Y + 2;
const DAY_TOP_Y = TAG_TOP_Y;

const TICK_HALF_HEIGHT = 3;

const CURVE_SAMPLES = 24 * 8;

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
const SCRIM_TINT = '#0f141b';
const SKY_OPACITY = 0.8;
const HORIZON_STROKE = 'rgba(255, 255, 255, 0.35)';
const CURVE_STROKE = 'rgba(255, 255, 255, 0.28)';

const STARS_PER_NIGHT_HALF = 9;
const STAR_SEED_LEFT = 11;
const STAR_SEED_RIGHT = 23;
const STAR_MIN_RADIUS = 0.4;
const STAR_RADIUS_RANGE = 0.6;
const STAR_MIN_OPACITY = 0.25;
const STAR_OPACITY_RANGE = 0.6;

const TWO_PI = Math.PI * 2;

function xOfPhase(phase: number, width: number): number {
  return ((phase - PHASE_OF_MIDNIGHT + 1) % 1) * width;
}

function yOfPhase(phase: number): number {
  const height = Math.sin(phase * TWO_PI);
  return HORIZON_Y - height * (height >= 0 ? DAY_ARC_HEIGHT : NIGHT_ARC_DEPTH);
}

function isDaytime(phase: number): boolean {
  return phase < SUNSET_PHASE;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function sunVisibility(phase: number): number {
  const fromSunrise = phase > SUNSET_PHASE ? phase - 1 : phase;
  const risen = clamp01(0.5 + fromSunrise / HANDOVER_PHASE_SPAN);
  const set = clamp01(0.5 + (phase - SUNSET_PHASE) / HANDOVER_PHASE_SPAN);
  return risen * (1 - set);
}

const f1 = (n: number): string => n.toFixed(1);

function curvePath(width: number): string {
  let d = '';
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const phase = (PHASE_OF_MIDNIGHT + i / CURVE_SAMPLES) % 1;
    const x = (i / CURVE_SAMPLES) * width;
    d += `${i === 0 ? 'M' : 'L'}${f1(x)} ${f1(yOfPhase(phase))}`;
  }
  return d;
}

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

const TWILIGHT_INNER_SPAN = 0.08;
const TWILIGHT_OUTER_SPAN = 0.04;

const SKY_GRADIENT_ID = 'almanac-sky';
const GROUND_GRADIENT_ID = 'almanac-ground';
const TITLE_SCRIM_ID = 'almanac-scrim';
const MOON_MASK_ID = 'almanac-moon';

const MOON_MASK_CUT_DX = 1.9;
const MOON_MASK_CUT_DY = -0.9;
const MOON_MASK_CUT_RADIUS = 2.9;

export interface AlmanacClockProps {
  readonly reading: WorldClockReading;
}

export function AlmanacClock(props: AlmanacClockProps): JSX.Element {
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

      {
}
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

      {}
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

      {}
      <g transform={`translate(${f1(x())} ${f1(sunY())})`} opacity={f1(sunAlpha())}>
        <circle r={SUN_HALO_RADIUS} fill={SUN} opacity={SUN_HALO_OPACITY} />
        <circle r={SUN_RADIUS} fill={SUN_HOT} />
      </g>
      <g transform={`translate(${f1(x())} ${f1(moonY())})`} opacity={f1(1 - sunAlpha())}>
        <circle r={MOON_RADIUS} fill={MOON} mask={`url(#${MOON_MASK_ID})`} />
      </g>

    </svg>
    {}
    <span class="almanac__weekday" style={{ left: `${CAPTION_X}px`, top: `${WEEKDAY_TOP_Y}px`, height: `${TAG_HEIGHT}px` }}>
      {props.reading.weekday?.toUpperCase() ?? ''}
    </span>
    <span class="almanac__day" style={{ left: `${CAPTION_X}px`, top: `${DAY_TOP_Y}px`, height: `${TAG_HEIGHT}px` }}>
      {props.reading.day !== null ? `DAY ${props.reading.day}` : ''}
    </span>
    {}
    <span class="almanac__time" style={{ top: `${TAG_TOP_Y}px`, height: `${TAG_HEIGHT}px` }}>
      {props.reading.time}
    </span>
    </>
  );
}
