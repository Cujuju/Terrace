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
//   1. the sand level in the lower bulb — how much you have, right now
//   2. the falling grain's RHYTHM       — one grain per sculpt's worth of regen
//                                         FOR THE BRUSH IN HAND, so a fast world
//                                         streams, a slow one drips, and a big
//                                         brush stretches either one out
//   3. "480 / 810", "+20/s", "−270/use" — the exact numbers, beside the glass
//
// WHY THE PRICE IS ON HERE AT ALL. Since sculpting is priced by the volume it
// displaces (2026-08-14), the cost of the next click is no longer a constant the
// player can learn once — it changes every time they change brush, by up to 45×.
// A gauge that showed only the pool would leave them discovering that by running
// out. The brush's price is read from the HUD's own brush selection, so the two
// controls agree by construction.
//
// ART DIRECTION (owner brief): this is a game object, not a UI widget — a
// bronze-and-amber instrument that would not look out of place in an RPG
// inventory. Everything is drawn: moulded caps built from stacked profiles,
// corner posts with finials and studs, a gradient-lit frame, a diagonal sheen
// across the glass. Pure inline SVG, no raster, no external assets. The warm
// palette is deliberately narrow (three bronzes, two sands) so it stays
// harmonious against the HUD's dark slate rather than competing with it.
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
  formatSculptCost,
  isPoolFull,
  pulsePeriodSeconds,
  syncedDisplayBalance,
} from './gauge.ts';
import { currentBrushCost, deniedCount, manaPool } from './state.ts';

/** How long the denial flash lasts. Matches the HUD's other transient cues. */
const DENIAL_FLASH_MS = 600;

// ── Geometry, in SVG user units of the 52 × 74 viewBox ──────────────────────
// The instrument is symmetric about x = 26. Vertically it reads as five bands:
// top cap (3–12), upper funnel (12–35), neck (35–39), lower funnel (39–62),
// bottom cap (62–71), with the corner posts spanning cap to cap behind it all.
//
// Only the lower funnel moves, so its extents are the named ones: the sand
// rect, the grain's fall distance and the clip path are all derived from them
// and cannot drift apart.
const VIEW_W = 52;
const VIEW_H = 74;
const GLASS_CENTER_X = 26;
const BULB_TOP_Y = 39;
const BULB_BOTTOM_Y = 62;
const BULB_HEIGHT = BULB_BOTTOM_Y - BULB_TOP_Y;

/**
 * The glass as ONE continuous silhouette — both funnels AND the neck tube
 * between them. Drawing the funnels as two separate triangles left a gap at the
 * waist and read as two shapes rather than as one hourglass (caught in a 5×
 * render); the neck walls are what make it a single vessel.
 */
const GLASS_SILHOUETTE_PATH = `M11 12 H41 L27.5 35 V${BULB_TOP_Y} L41 ${BULB_BOTTOM_Y} H11 L24.5 ${BULB_TOP_Y} V35 Z`;

/** The lower funnel alone: what the sand is clipped to. */
const LOWER_FUNNEL_PATH = `M24.5 ${BULB_TOP_Y} H27.5 L41 ${BULB_BOTTOM_Y} H11 Z`;

/** Where a grain appears — inside the neck, above an empty bulb's floor. */
const GRAIN_START_Y = 37;
const GRAIN_RADIUS = 1.8;

/** Thickness of the brighter band drawn along the top of the sand. */
const SURFACE_LINE_H = 1.3;

/** Corner posts: narrow columns joining the caps, with a finial at each end. */
const POST_LEFT_X = 5.5;
const POST_RIGHT_X = 43.5;
const POST_WIDTH = 3;
const POST_TOP_Y = 10;
const POST_BOTTOM_Y = 64;
const FINIAL_RADIUS = 2.1;
const STUD_RADIUS = 0.9;

// ── Palette ─────────────────────────────────────────────────────────────────
// Self-contained on purpose: this plugin may not touch client/src/ui/hud.css,
// and a plugin that hard-depends on core CSS classes is a plugin that breaks
// when core restyles. The HUD's own custom properties are used for the text and
// the chrome, each with a literal fallback so the gauge stays legible even if a
// future core drops them.
//
// The frame is three bronzes rather than one flat colour: a lit edge, a body
// and a shadow, fed to a top-to-bottom gradient so the mouldings read as turned
// metal instead of as stacked rectangles.
const BRONZE_LIGHT = '#e0b262';
const BRONZE_MID = '#a8752c';
const BRONZE_DARK = '#4e3315';

/** Sand: warm amber, lit from the top of the bulb. */
const SAND_LIGHT = '#f5cf74';
const SAND_DEEP = '#cf8f24';
const SAND_SURFACE = '#ffeab3';

/** The denial flash: the same three-tone treatment, in red. */
const DENIED_LIGHT = '#f08e80';
const DENIED_MID = '#d9584a';
const DENIED_DARK = '#6d241c';

/** Glass. Warm-tinted rather than neutral white, so it belongs to the bronze. */
const GLASS_STROKE = 'rgba(255, 228, 178, 0.46)';
const GLASS_TINT = 'rgba(255, 238, 208, 0.05)';
const GLASS_SHEEN = 'rgba(255, 255, 255, 0.14)';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// SVG ids are document-global, so every one this component mints is namespaced.
const FRAME_GRADIENT_ID = 'mana-gauge-frame-grad';
const SAND_GRADIENT_ID = 'mana-gauge-sand-grad';
const BULB_CLIP_ID = 'mana-gauge-bulb-clip';
const GLASS_CLIP_ID = 'mana-gauge-glass-clip';

/**
 * The one stylesheet this component renders. Keyframes cannot be expressed as
 * inline styles, which is the only reason a <style> element exists here; the
 * per-instance values (the cue's period, its fall distance) still arrive as
 * inline custom properties, so the CSS itself stays constant.
 *
 * LAYOUT: one horizontal control — glass on the left, stats stacked to its
 * right and left-aligned against it. It sits over the play view, so it stays as
 * small as the numbers allow.
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
  flex-direction: row;
  align-items: center;
  gap: 9px;
  padding: 5px 13px 5px 9px;
  border: 1px solid var(--hud-border, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: var(--hud-bg, rgba(18, 22, 28, 0.78));
  backdrop-filter: blur(6px);
  font-family: inherit;
  line-height: 1;
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

  // THE FLASH. It recolours the FRAME and the SAND together, through the two
  // gradients' stops. A flash carried only by the sand would be a few pixels at
  // the bottom of an empty bulb — silent at exactly the moment a denial happens
  // — so the whole instrument goes red instead. (Verified against a rendered
  // empty gauge; that was the defect the first render exposed.)
  const frameLight = () => (flashing() ? DENIED_LIGHT : BRONZE_LIGHT);
  const frameMid = () => (flashing() ? DENIED_MID : BRONZE_MID);
  const frameDark = () => (flashing() ? DENIED_DARK : BRONZE_DARK);
  const sandLight = () => (flashing() ? DENIED_LIGHT : SAND_LIGHT);
  const sandDeep = () => (flashing() ? DENIED_MID : SAND_DEEP);
  const sandSurface = () => (flashing() ? DENIED_LIGHT : SAND_SURFACE);
  const glassColor = () => (flashing() ? DENIED_MID : GLASS_STROKE);

  /**
   * Seconds per grain: one CURRENT-BRUSH sculpt's worth of regen.
   *
   * currentBrushCost() reads the HUD's live brush selection (state.ts), so
   * switching from the point brush to a radius-4 hard stamp re-times the cue on
   * the spot — 45× slower, because that is 45× the mana and therefore 45× the
   * wait. Recomputed at the use site rather than cached, per the project's Solid
   * rule; a perk collected mid-stroke changes the pushed rate and re-times it
   * through the same accessor.
   */
  const periodSeconds = () => {
    const pool = manaPool();
    return pool === null ? 0 : pulsePeriodSeconds(currentBrushCost(), pool.regenPerSecond);
  };
  /** A grain falls from the neck to the CURRENT surface, never through it. */
  const grainFall = () => Math.max(0, fillTopY() - GRAIN_START_Y);

  return (
    <Show when={manaPool() !== null}>
      <div
        class="mana-gauge"
        role="img"
        aria-label={`Mana ${Math.floor(displayed())} of ${manaPool()!.capacity}, refilling ${formatRegenRate(manaPool()!.regenPerSecond)}, current brush costs ${currentBrushCost()}`}
      >
        <style>{GAUGE_CSS}</style>

        <svg
          width={VIEW_W}
          height={VIEW_H}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          aria-hidden="true"
        >
          <defs>
            {/* Frame lighting: lit edge at the top, shadow at the bottom, so
                every moulding picks up the same imaginary light. */}
            <linearGradient id={FRAME_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={frameLight()} />
              <stop offset="45%" stop-color={frameMid()} />
              <stop offset="100%" stop-color={frameDark()} />
            </linearGradient>

            {/* Sand lighting, pinned to the BULB rather than to the sand rect
                (userSpaceOnUse): the shading then belongs to the vessel and
                does not rescale every time the level moves. */}
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

            <clipPath id={BULB_CLIP_ID}>
              <path d={LOWER_FUNNEL_PATH} />
            </clipPath>
            {/* The whole vessel, for the sheen that crosses it. */}
            <clipPath id={GLASS_CLIP_ID}>
              <path d={GLASS_SILHOUETTE_PATH} />
            </clipPath>
          </defs>

          {/* ── Corner posts, behind everything: the columns the caps are
                turned onto, each capped with a finial. ── */}
          <g fill={`url(#${FRAME_GRADIENT_ID})`}>
            <rect
              x={POST_LEFT_X}
              y={POST_TOP_Y}
              width={POST_WIDTH}
              height={POST_BOTTOM_Y - POST_TOP_Y}
              rx="1.2"
            />
            <rect
              x={POST_RIGHT_X}
              y={POST_TOP_Y}
              width={POST_WIDTH}
              height={POST_BOTTOM_Y - POST_TOP_Y}
              rx="1.2"
            />
            <circle cx={POST_LEFT_X + POST_WIDTH / 2} cy={POST_TOP_Y} r={FINIAL_RADIUS} />
            <circle cx={POST_RIGHT_X + POST_WIDTH / 2} cy={POST_TOP_Y} r={FINIAL_RADIUS} />
            <circle cx={POST_LEFT_X + POST_WIDTH / 2} cy={POST_BOTTOM_Y} r={FINIAL_RADIUS} />
            <circle cx={POST_RIGHT_X + POST_WIDTH / 2} cy={POST_BOTTOM_Y} r={FINIAL_RADIUS} />
          </g>
          {/* A single lit edge down each post — one line is all it takes to
              read as round rather than as a flat bar. */}
          <g stroke={frameLight()} stroke-width="0.6" opacity="0.55">
            <line
              x1={POST_LEFT_X + 0.8}
              y1={POST_TOP_Y + 1.5}
              x2={POST_LEFT_X + 0.8}
              y2={POST_BOTTOM_Y - 1.5}
            />
            <line
              x1={POST_RIGHT_X + 0.8}
              y1={POST_TOP_Y + 1.5}
              x2={POST_RIGHT_X + 0.8}
              y2={POST_BOTTOM_Y - 1.5}
            />
          </g>

          {/* ── The glass, tinted and outlined. The upper funnel is deliberately
                NOT drawn as draining: mana is not a fixed quantity moving from
                one bulb to the other, and a shrinking top would promise an end
                that the server's regen does not have. ── */}
          <path d={GLASS_SILHOUETTE_PATH} fill={GLASS_TINT} />

          {/* ── The sand: a full-width rect clipped to the bulb, so it takes the
                glass's silhouette instead of being a floating box. ── */}
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

          {/* ── THE RATE CUE. One grain per sculpt's worth of regen, falling
                from the neck to the current surface; unmounted at capacity,
                where there is nothing left to fall. ── */}
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

          {/* ── Sheen: one diagonal streak across both bulbs, clipped to the
                glass. Drawn over the sand — it is a reflection ON the glass. ── */}
          <g clip-path={`url(#${GLASS_CLIP_ID})`}>
            <rect
              x="9"
              y="-16"
              width="5.5"
              height="110"
              fill={GLASS_SHEEN}
              transform={`rotate(18 ${GLASS_CENTER_X} 37)`}
            />
          </g>

          {/* Outlines last, so the glass edge stays crisp over sand and sheen. */}
          <path
            d={GLASS_SILHOUETTE_PATH}
            fill="none"
            stroke={glassColor()}
            stroke-width="1"
            stroke-linejoin="round"
          />

          {/* ── Caps: three stacked profiles each (lip, body, shoulder) rather
                than one bar — the step between them is what makes a moulding
                read as moulded. Studs sit on the outer lips. ── */}
          <g fill={`url(#${FRAME_GRADIENT_ID})`}>
            <rect x="4" y="2.5" width="44" height="3.4" rx="1.7" />
            <rect x="7.5" y="5.6" width="37" height="4" rx="1.2" />
            <rect x="10.5" y="9.4" width="31" height="2.4" rx="1.2" />

            <rect x="10.5" y="62.2" width="31" height="2.4" rx="1.2" />
            <rect x="7.5" y="64.4" width="37" height="4" rx="1.2" />
            <rect x="4" y="68.1" width="44" height="3.4" rx="1.7" />
          </g>
          {/* Studs: four on each lip. Small, but they are most of what says
              "forged object" at this size. */}
          <g fill={frameLight()} opacity="0.8">
            <circle cx="9" cy="4.2" r={STUD_RADIUS} />
            <circle cx="19.5" cy="4.2" r={STUD_RADIUS} />
            <circle cx="32.5" cy="4.2" r={STUD_RADIUS} />
            <circle cx="43" cy="4.2" r={STUD_RADIUS} />
            <circle cx="9" cy="69.8" r={STUD_RADIUS} />
            <circle cx="19.5" cy="69.8" r={STUD_RADIUS} />
            <circle cx="32.5" cy="69.8" r={STUD_RADIUS} />
            <circle cx="43" cy="69.8" r={STUD_RADIUS} />
          </g>
        </svg>

        {/* Stats beside the glass, stacked and left-aligned, in the order the
            player needs them: what you have, what it fills at, what the brush in
            your hand takes out. All three stay visible at capacity, where the
            cue is paused and the numbers are the only readout left. */}
        <div class="mana-gauge__stats">
          <span class="mana-gauge__balance">
            {Math.floor(displayed())}
            <span class="mana-gauge__capacity">/{manaPool()!.capacity}</span>
          </span>
          <span class="mana-gauge__rate">{formatRegenRate(manaPool()!.regenPerSecond)}</span>
          {/* The price of the CURRENT brush: the one number that makes volume
              pricing visible before the pool drains, and the answer to "why did
              that stamp cost so much more than the last one". */}
          <span class="mana-gauge__cost">{formatSculptCost(currentBrushCost())}</span>
        </div>
      </div>
    </Show>
  );
}
