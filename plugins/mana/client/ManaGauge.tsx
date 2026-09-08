import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import {
  fillFraction,
  formatRegenRate,
  formatSculptCost,
  isPoolFull,
  pulsePeriodSeconds,
} from './gauge.ts';
import { currentBrushCost, deniedCount, liveBalance, manaPool } from './state.ts';

const DENIAL_FLASH_MS = 600;

const VIEW_W = 32;
const VIEW_H = 40;

const GAUGE_DISPLAY_SCALE = 1;
const DISPLAY_W = Math.round(VIEW_W * GAUGE_DISPLAY_SCALE);
const DISPLAY_H = Math.round(VIEW_H * GAUGE_DISPLAY_SCALE);
const GLASS_CENTER_X = 16;
const BULB_TOP_Y = 17;
const BULB_BOTTOM_Y = 25.5;
const BULB_HEIGHT = BULB_BOTTOM_Y - BULB_TOP_Y;

const GLASS_SILHOUETTE_PATH = `M10.5 6.5 H21.5 L16.9 15 V${BULB_TOP_Y} L21.5 ${BULB_BOTTOM_Y} H10.5 L15.1 ${BULB_TOP_Y} V15 Z`;

const LOWER_FUNNEL_PATH = `M15.1 ${BULB_TOP_Y} H16.9 L21.5 ${BULB_BOTTOM_Y} H10.5 Z`;

const GRAIN_START_Y = 16;
const GRAIN_RADIUS = 0.8;

const SURFACE_LINE_H = 0.8;

const POST_LEFT_X = 8.4;
const POST_RIGHT_X = 22;
const POST_WIDTH = 1.6;
const POST_TOP_Y = 6;
const POST_BOTTOM_Y = 26;
const BEAD_RADIUS = 1.1;

const BRONZE_LIGHT = '#e0a463';
const BRONZE_MID = '#b0733a';
const BRONZE_DARK = '#6d4220';

const TILE_TOP_LIGHT = '#a6e08a';
const TILE_TOP_DARK = '#4f9a4a';
const TILE_LEFT_LIGHT = '#9a6a45';
const TILE_LEFT_DARK = '#5a3a22';
const TILE_RIGHT_LIGHT = '#6e4a2f';
const TILE_RIGHT_DARK = '#3a2415';

const SAND_LIGHT = '#f5cf74';
const SAND_DEEP = '#cf8f24';
const SAND_SURFACE = '#ffeab3';

const DENIED_LIGHT = '#f08e80';
const DENIED_MID = '#d9584a';
const DENIED_DARK = '#6d241c';

const GLASS_STROKE = 'rgba(255, 234, 196, 0.75)';
const GLASS_TINT = 'rgba(255, 238, 208, 0.18)';
const GLASS_SHEEN = 'rgba(255, 255, 255, 0.14)';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const FRAME_GRADIENT_ID = 'mana-gauge-frame-grad';
const SAND_GRADIENT_ID = 'mana-gauge-sand-grad';
const BULB_CLIP_ID = 'mana-gauge-bulb-clip';
const GLASS_CLIP_ID = 'mana-gauge-glass-clip';
const TILE_TOP_GRADIENT_ID = 'mana-gauge-tile-top';
const TILE_LEFT_GRADIENT_ID = 'mana-gauge-tile-left';
const TILE_RIGHT_GRADIENT_ID = 'mana-gauge-tile-right';

const GAUGE_CSS = `
.mana-gauge {
  /* HOVERABLE ON PURPOSE, and the reason this is not 'none'. A native title
     tooltip is delivered by hit-testing, so an element the pointer passes
     straight through can never show one — the gauge would carry an explanation
     nobody could ever read. The cost is that the small patch of world directly
     behind the instrument is no longer sculptable, which is what every other
     HUD control already costs (the corner panel is pointer-events: auto too);
     the gauge sits at the bottom edge, clear of where the brush works, and the
     camera can pan whatever it hides into reach. */
  pointer-events: auto;
  cursor: help;
  user-select: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 5px 13px 5px 8px;
  /* The glass the modeler dock and the toolbar wear (hud.css --hud-glass),
     with the same fallbacks the text colours carry below. */
  border-radius: 14px;
  background: var(--hud-glass, linear-gradient(180deg, rgba(34, 41, 52, 0.86), rgba(14, 18, 24, 0.9)));
  box-shadow:
    var(--hud-glass-shadow, 0 12px 32px rgba(0, 0, 0, 0.45)),
    var(--hud-glass-edge, inset 0 1px 0 rgba(255, 255, 255, 0.09));
  backdrop-filter: blur(6px);
  font-family: inherit;
  line-height: 1;
}
.mana-gauge__icon {
  /* Lifted off the panel exactly as .hud-tool__icon is (hud.css). */
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
}
.mana-gauge__stats {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.mana-gauge__balance {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-text, #e8edf2);
}
.mana-gauge__capacity {
  color: var(--hud-muted, #97a3b0);
}
.mana-gauge__rate,
.mana-gauge__cost {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: var(--hud-muted, #97a3b0);
}
.mana-gauge__grain {
  animation-name: mana-gauge-fall;
  animation-duration: var(--mana-gauge-period, 1.25s);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
@keyframes mana-gauge-fall {
  0%   { transform: translateY(0); opacity: 0; }
  12%  { opacity: 1; }
  88%  { opacity: 1; }
  100% { transform: translateY(var(--mana-gauge-fall, 0px)); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .mana-gauge__grain { animation: none; display: none; }
}
`;

function prefersReducedMotion(): () => boolean {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  const [reduced, setReduced] = createSignal(query?.matches ?? false);

  if (query !== null) {
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    onCleanup(() => query.removeEventListener('change', onChange));
  }

  return reduced;
}

export function ManaGauge(): JSX.Element {
  const [displayed, setDisplayed] = createSignal(0);
  const [flashing, setFlashing] = createSignal(false);
  const reduced = prefersReducedMotion();

  createEffect(() => {
    const pool = manaPool();
    if (pool === null) return;
    setDisplayed(liveBalance(pool));
  });

  createEffect<number>((previous) => {
    const count = deniedCount();
    if (previous !== undefined && count !== previous) {
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), DENIAL_FLASH_MS);
      onCleanup(() => clearTimeout(timer));
    }
    return count;
  });

  createEffect(() => {
    if (reduced()) return;

    let frame = 0;
    const step = () => {
      const pool = manaPool();
      if (pool !== null) setDisplayed(liveBalance(pool));
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    onCleanup(() => cancelAnimationFrame(frame));
  });

  const fill = () => {
    const pool = manaPool();
    return pool === null ? 0 : fillFraction(displayed(), pool.capacity);
  };
  const fillHeight = () => fill() * BULB_HEIGHT;
  const fillTopY = () => BULB_BOTTOM_Y - fillHeight();
  const full = () => {
    const pool = manaPool();
    return pool !== null && isPoolFull(displayed(), pool.capacity);
  };

  const frameLight = () => (flashing() ? DENIED_LIGHT : BRONZE_LIGHT);
  const frameMid = () => (flashing() ? DENIED_MID : BRONZE_MID);
  const frameDark = () => (flashing() ? DENIED_DARK : BRONZE_DARK);
  const sandLight = () => (flashing() ? DENIED_LIGHT : SAND_LIGHT);
  const sandDeep = () => (flashing() ? DENIED_MID : SAND_DEEP);
  const sandSurface = () => (flashing() ? DENIED_LIGHT : SAND_SURFACE);
  const glassColor = () => (flashing() ? DENIED_MID : GLASS_STROKE);

  const periodSeconds = () => {
    const pool = manaPool();
    return pool === null ? 0 : pulsePeriodSeconds(currentBrushCost(), pool.regenPerSecond);
  };
  const grainFall = () => Math.max(0, fillTopY() - GRAIN_START_Y);

  return (
    <Show when={manaPool() !== null}>
      {
}
      <div
        class="mana-gauge"
        role="img"
        aria-label={`Mana ${Math.floor(displayed())} of ${manaPool()!.capacity}, refilling ${formatRegenRate(manaPool()!.regenPerSecond)}, current brush costs ${currentBrushCost()}`}
        title={`Mana: ${Math.floor(displayed())} of ${manaPool()!.capacity}`}
      >
        <style>{GAUGE_CSS}</style>

        <svg
          class="mana-gauge__icon"
          width={DISPLAY_W}
          height={DISPLAY_H}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          aria-hidden="true"
        >
          <defs>
            {
}
            <linearGradient id={FRAME_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={frameLight()} />
              <stop offset="45%" stop-color={frameMid()} />
              <stop offset="100%" stop-color={frameDark()} />
            </linearGradient>

            {
}
            <linearGradient
              id={SAND_GRADIENT_ID}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1={BULB_TOP_Y}
              x2="0"
              y2={BULB_BOTTOM_Y}
            >
              <stop offset="0%" stop-color={sandLight()} />
              <stop offset="100%" stop-color={sandDeep()} />
            </linearGradient>

            {}
            <linearGradient id={TILE_TOP_GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color={TILE_TOP_LIGHT} />
              <stop offset="1" stop-color={TILE_TOP_DARK} />
            </linearGradient>
            <linearGradient id={TILE_LEFT_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color={TILE_LEFT_LIGHT} />
              <stop offset="1" stop-color={TILE_LEFT_DARK} />
            </linearGradient>
            <linearGradient id={TILE_RIGHT_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color={TILE_RIGHT_LIGHT} />
              <stop offset="1" stop-color={TILE_RIGHT_DARK} />
            </linearGradient>

            <clipPath id={BULB_CLIP_ID}>
              <path d={LOWER_FUNNEL_PATH} />
            </clipPath>
            {}
            <clipPath id={GLASS_CLIP_ID}>
              <path d={GLASS_SILHOUETTE_PATH} />
            </clipPath>
          </defs>

          {
}
          <ellipse cx="16" cy="35.5" rx="12" ry="3" fill="#000" opacity="0.35" />
          <polygon points="16,21 28,27 16,33 4,27" fill={`url(#${TILE_TOP_GRADIENT_ID})`} />
          <polygon points="4,27 16,33 16,37 4,31" fill={`url(#${TILE_LEFT_GRADIENT_ID})`} />
          <polygon points="28,27 16,33 16,37 28,31" fill={`url(#${TILE_RIGHT_GRADIENT_ID})`} />
          {}
          <ellipse cx="16" cy="27.6" rx="8" ry="3.2" fill="#2e5a2e" opacity="0.5" />

          {
}
          <g fill={`url(#${FRAME_GRADIENT_ID})`}>
            <rect
              x={POST_LEFT_X}
              y={POST_TOP_Y}
              width={POST_WIDTH}
              height={POST_BOTTOM_Y - POST_TOP_Y}
              rx="0.8"
            />
            <rect
              x={POST_RIGHT_X}
              y={POST_TOP_Y}
              width={POST_WIDTH}
              height={POST_BOTTOM_Y - POST_TOP_Y}
              rx="0.8"
            />
            <circle cx={POST_LEFT_X + POST_WIDTH / 2} cy={POST_TOP_Y} r={BEAD_RADIUS} />
            <circle cx={POST_RIGHT_X + POST_WIDTH / 2} cy={POST_TOP_Y} r={BEAD_RADIUS} />
            <circle cx={POST_LEFT_X + POST_WIDTH / 2} cy={POST_BOTTOM_Y} r={BEAD_RADIUS} />
            <circle cx={POST_RIGHT_X + POST_WIDTH / 2} cy={POST_BOTTOM_Y} r={BEAD_RADIUS} />
          </g>
          {
}
          <g stroke={frameLight()} stroke-width="0.4" opacity="0.55">
            <line
              x1={POST_LEFT_X + 0.5}
              y1={POST_TOP_Y + 1}
              x2={POST_LEFT_X + 0.5}
              y2={POST_BOTTOM_Y - 1}
            />
            <line
              x1={POST_RIGHT_X + 0.5}
              y1={POST_TOP_Y + 1}
              x2={POST_RIGHT_X + 0.5}
              y2={POST_BOTTOM_Y - 1}
            />
          </g>

          {
}
          <path d={GLASS_SILHOUETTE_PATH} fill={GLASS_TINT} />

          {
}
          <g clip-path={`url(#${BULB_CLIP_ID})`}>
            <rect
              x="0"
              y={fillTopY()}
              width={VIEW_W}
              height={fillHeight()}
              fill={`url(#${SAND_GRADIENT_ID})`}
            />
            <Show when={fill() > 0}>
              <rect
                x="0"
                y={fillTopY()}
                width={VIEW_W}
                height={SURFACE_LINE_H}
                fill={sandSurface()}
              />
            </Show>
          </g>

          {
}
          <Show when={!full()}>
            <g
              class="mana-gauge__grain"
              style={{
                '--mana-gauge-period': `${periodSeconds()}s`,
                '--mana-gauge-fall': `${grainFall()}px`,
              }}
            >
              <circle
                cx={GLASS_CENTER_X}
                cy={GRAIN_START_Y}
                r={GRAIN_RADIUS}
                fill={sandSurface()}
              />
            </g>
          </Show>

          {
}
          <g clip-path={`url(#${GLASS_CLIP_ID})`}>
            <rect
              x="10"
              y="-4"
              width="2.4"
              height="50"
              fill={GLASS_SHEEN}
              transform={`rotate(18 ${GLASS_CENTER_X} 16)`}
            />
          </g>

          {}
          <path
            d={GLASS_SILHOUETTE_PATH}
            fill="none"
            stroke={glassColor()}
            stroke-width="0.8"
            stroke-linejoin="round"
          />

          {
}
          <g fill={`url(#${FRAME_GRADIENT_ID})`}>
            <rect x="7" y="4" width="18" height="1.6" rx="0.8" />
            <rect x="9" y="5.4" width="14" height="1.4" rx="0.6" />

            <rect x="9" y="25.2" width="14" height="1.4" rx="0.6" />
            <rect x="7" y="26.4" width="18" height="1.8" rx="0.9" />
          </g>
          {
}
          <g fill={frameLight()} opacity="0.7">
            <rect x="8" y="4.2" width="16" height="0.4" rx="0.2" />
            <rect x="8" y="26.6" width="16" height="0.4" rx="0.2" />
          </g>
        </svg>

        {
}
        <div class="mana-gauge__stats">
          <span class="mana-gauge__balance">
            {Math.floor(displayed())}
            <span class="mana-gauge__capacity">/{manaPool()!.capacity}</span>
          </span>
          <span
            class="mana-gauge__rate"
            title="Refill: mana earned every second"
          >
            {formatRegenRate(manaPool()!.regenPerSecond)}
          </span>
          {
}
          <span
            class="mana-gauge__cost"
            title="Cost: one click of this brush"
          >
            {formatSculptCost(currentBrushCost())}
          </span>
        </div>
      </div>
    </Show>
  );
}
