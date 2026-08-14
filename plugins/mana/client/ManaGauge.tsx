// The mana gauge: a top-centre hourglass whose LOWER BULB IS THE POOL.
//
// WHY AN HOURGLASS, AND WHY TOP CENTRE. The old HUD row was a bar in the corner
// panel: it answered "how much mana do I have" and nothing else. The thing a
// player actually needs to know while their brush is stopped is "how long until
// I can sculpt again", and that is a RATE — which every world may configure
// differently (MANA_REGEN_PER_S, plus whatever regen perk this player holds).
// An hourglass is the one vessel whose whole cultural job is showing a rate, so
// the shape carries the meaning before any number is read; top centre is where
// the eye already is when the terrain stops responding to the brush.
//
// THE READOUTS, IN ORDER OF HOW FAST THEY ANSWER:
//   1. the level in the lower bulb  — how much you have, right now
//   2. the falling grain's RHYTHM   — one grain per sculpt's worth of regen, so
//                                     a fast world streams and a slow one drips
//   3. "480 / 600" and "+20/s"      — the exact numbers, for when you want them
//
// SMOOTHING IS DISPLAY ONLY. Between server pushes the level advances locally
// at the pushed rate (gauge.ts) so the motion is continuous rather than a 10 Hz
// staircase. Every authoritative push — and every local gate debit, which is
// also a pool change — resyncs it wholesale. None of it feeds back into the
// affordability decision, which stays server balance vs server cost in state.ts.
//
// SOLID REACTIVITY: every reactive read is behind an accessor called at its use
// site; nothing reactive is captured in a component-body const. Timers, frame
// loops and media listeners are all torn down through onCleanup.

import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import {
  MS_PER_SECOND,
  advanceDisplayBalance,
  fillFraction,
  formatRegenRate,
  isPoolFull,
  pulsePeriodSeconds,
  syncedDisplayBalance,
} from './gauge.ts';
import { deniedCount, manaPool } from './state.ts';

/** How long the denial flash lasts. Matches the HUD's other transient cues. */
const DENIAL_FLASH_MS = 600;

// ── Geometry, in SVG user units of the 44 × 62 viewBox ──────────────────────
// The glass is symmetric about x = 22: two 23-unit-tall funnels meeting at a
// 4-unit neck, capped top and bottom. The lower funnel is the only part that
// moves, so its extents are named — the fill rect and the grain's fall distance
// are both derived from them and cannot drift apart.
const VIEW_W = 44;
const VIEW_H = 62;
const GLASS_CENTER_X = 22;
const BULB_TOP_Y = 33;
const BULB_BOTTOM_Y = 56;
const BULB_HEIGHT = BULB_BOTTOM_Y - BULB_TOP_Y;

/** Where a grain appears — just under the neck, above an empty bulb's floor. */
const GRAIN_START_Y = 31;
const GRAIN_RADIUS = 1.7;

/** Thickness of the lighter band drawn along the top of the fill. */
const SURFACE_LINE_H = 1.2;

// ── Palette ─────────────────────────────────────────────────────────────────
// Self-contained on purpose: this plugin may not touch client/src/ui/hud.css,
// and a plugin that hard-depends on core CSS classes is a plugin that breaks
// when core restyles. The HUD's own custom properties are used where they
// exist, each with a literal fallback so the gauge is legible even if a future
// core drops them.
const POOL_COLOR = '#5a9bd4';
const POOL_SURFACE_COLOR = '#9fd2f2';
const DENIED_COLOR = '#d9584a';
const GLASS_STROKE = 'rgba(255, 255, 255, 0.34)';
const GLASS_CAP = 'rgba(255, 255, 255, 0.22)';
const RESERVOIR_FILL = 'rgba(255, 255, 255, 0.07)';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Clip id for the lower bulb. Namespaced so it cannot collide with core's. */
const BULB_CLIP_ID = 'mana-gauge-bulb-clip';

/**
 * The one stylesheet this component renders. Keyframes cannot be expressed as
 * inline styles, which is the only reason a <style> element exists here; the
 * per-instance values (the cue's period, its fall distance) still arrive as
 * inline custom properties, so the CSS itself stays constant.
 *
 * The reduced-motion block is belt-and-suspenders with the JS branch below: the
 * component already skips the frame loop and unmounts the grain when the user
 * asks for less motion, and this stops the animation even if that wiring ever
 * regresses.
 */
const GAUGE_CSS = `
.mana-gauge {
  pointer-events: none;
  user-select: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 12px 6px;
  border: 1px solid var(--hud-border, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: var(--hud-bg, rgba(18, 22, 28, 0.78));
  backdrop-filter: blur(6px);
  font-family: inherit;
  line-height: 1;
}
.mana-gauge__numbers {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.mana-gauge__balance {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-text, #e8edf2);
}
.mana-gauge__capacity {
  color: var(--hud-muted, #97a3b0);
}
.mana-gauge__rate {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-muted, #97a3b0);
  opacity: 0.85;
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

/**
 * Tracks the user's motion preference live — someone who turns it on mid-session
 * should not have to reload to stop the animation.
 */
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
  /** The smoothed balance the gauge draws; resynced from the pool below. */
  const [displayed, setDisplayed] = createSignal(0);
  const [flashing, setFlashing] = createSignal(false);
  const reduced = prefersReducedMotion();

  // WHOLESALE RESYNC. Fires for BOTH kinds of pool change, which is the whole
  // point: an authoritative push replaces the local estimate, and a local gate
  // debit (state.ts writes a new pool on every allowed sculpt) shows the spend
  // on the very next frame instead of a round trip later.
  createEffect(() => {
    const pool = manaPool();
    if (pool === null) return;
    setDisplayed(syncedDisplayBalance(pool.balance, pool.capacity));
  });

  // A denial (the COUNT changing, see state.ts) starts/restarts the flash.
  createEffect<number>((previous) => {
    const count = deniedCount();
    if (previous !== undefined && count !== previous) {
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), DENIAL_FLASH_MS);
      onCleanup(() => clearTimeout(timer));
    }
    return count;
  });

  // THE SMOOTHING LOOP. Skipped entirely under prefers-reduced-motion, which
  // leaves the gauge static between server pushes — the level still tells the
  // truth, it just steps instead of sliding.
  createEffect(() => {
    if (reduced()) return;

    let frame = 0;
    let previousTime = performance.now();

    const step = (now: number) => {
      const dt = (now - previousTime) / MS_PER_SECOND;
      previousTime = now;
      // Read inside the callback, which runs outside any tracking scope, so
      // this does not subscribe the effect to the pool and restart the loop on
      // every push.
      const pool = manaPool();
      if (pool !== null) {
        setDisplayed((current) =>
          advanceDisplayBalance(current, pool.capacity, pool.regenPerSecond, dt),
        );
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    onCleanup(() => cancelAnimationFrame(frame));
  });

  // ── Derived accessors (called at their use sites, never cached in a const) ──
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
  const poolColor = () => (flashing() ? DENIED_COLOR : POOL_COLOR);
  const surfaceColor = () => (flashing() ? DENIED_COLOR : POOL_SURFACE_COLOR);
  // The GLASS flashes too, not just the liquid. A denial happens precisely when
  // the pool is near empty, so a flash carried only by the fill would be a few
  // red pixels at the bottom of the bulb — loudest exactly when there is
  // nothing left to colour. Verified against a rendered empty gauge.
  const glassColor = () => (flashing() ? DENIED_COLOR : GLASS_STROKE);
  const capColor = () => (flashing() ? DENIED_COLOR : GLASS_CAP);
  /**
   * Seconds per grain: one sculpt's worth of regen. Recomputed from the live
   * pool rather than cached, so a cost that changes under the player (a perk
   * collected mid-stroke, or a future non-flat cost model) re-times the cue
   * instead of lying about it.
   */
  const periodSeconds = () => {
    const pool = manaPool();
    return pool === null ? 0 : pulsePeriodSeconds(pool.cost, pool.regenPerSecond);
  };
  /** A grain falls from the neck to the CURRENT surface, never through it. */
  const grainFall = () => Math.max(0, fillTopY() - GRAIN_START_Y);

  return (
    <Show when={manaPool() !== null}>
      <div
        class="mana-gauge"
        role="img"
        aria-label={`Mana ${Math.floor(displayed())} of ${manaPool()!.capacity}, refilling ${formatRegenRate(manaPool()!.regenPerSecond)}`}
      >
        <style>{GAUGE_CSS}</style>

        <svg
          width={VIEW_W}
          height={VIEW_H}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          aria-hidden="true"
        >
          <defs>
            <clipPath id={BULB_CLIP_ID}>
              {/* The lower funnel: neck (top) widening to the base. */}
              <path d={`M20.5 ${BULB_TOP_Y} H23.5 L36 ${BULB_BOTTOM_Y} H8 Z`} />
            </clipPath>
          </defs>

          {/* Frame: the two caps a real hourglass is held by. */}
          <rect x="5" y="2" width="34" height="3.5" rx="1.75" fill={capColor()} />
          <rect x="5" y="56.5" width="34" height="3.5" rx="1.75" fill={capColor()} />

          {/* Upper funnel: the world's reservoir. Deliberately NOT drawn as
              draining — mana is not a fixed quantity moving from one bulb to
              the other, and a shrinking top would promise an end that the
              server's regen does not have. */}
          <path
            d="M8 6 H36 L23.5 29 H20.5 Z"
            fill={RESERVOIR_FILL}
            stroke={glassColor()}
            stroke-width="1"
            stroke-linejoin="round"
          />

          {/* Lower funnel: the pool. */}
          <path
            d={`M20.5 ${BULB_TOP_Y} H23.5 L36 ${BULB_BOTTOM_Y} H8 Z`}
            fill="none"
            stroke={glassColor()}
            stroke-width="1"
            stroke-linejoin="round"
          />

          {/* The level. A full-width rect clipped to the bulb, so the liquid
              takes the glass's silhouette instead of being a floating box. */}
          <g clip-path={`url(#${BULB_CLIP_ID})`}>
            <rect
              x="0"
              y={fillTopY()}
              width={VIEW_W}
              height={fillHeight()}
              fill={poolColor()}
            />
            <Show when={fill() > 0}>
              <rect
                x="0"
                y={fillTopY()}
                width={VIEW_W}
                height={SURFACE_LINE_H}
                fill={surfaceColor()}
              />
            </Show>
          </g>

          {/* THE RATE CUE. One grain per sculpt's worth of regen; unmounted at
              capacity, where there is nothing left to fall. */}
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
                fill={surfaceColor()}
              />
            </g>
          </Show>
        </svg>

        <div class="mana-gauge__numbers">
          <span class="mana-gauge__balance">
            {Math.floor(displayed())}
            <span class="mana-gauge__capacity">/{manaPool()!.capacity}</span>
          </span>
          {/* The rate in numerals, quieter than the balance, and shown even at
              capacity where the cue is paused — "how fast does this world
              refill" is a property of the world, not of the current level. */}
          <span class="mana-gauge__rate">{formatRegenRate(manaPool()!.regenPerSecond)}</span>
        </div>
      </div>
    </Show>
  );
}
