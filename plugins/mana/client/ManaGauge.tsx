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
// ART DIRECTION (owner brief): this is a game object, not a UI widget. Since
// 2026-09-04 ("a new hourglass icon in the same style as the other two HUDs")
// it is drawn in the modeler dock's and toolbar's idiom — client/src/ui/
// BrushIcons.tsx, Toolbar.tsx — a shaded object standing on an isometric grass
// tile, lifted off its panel by a drop shadow, on the same glass chrome those
// two panels wear. The vessel itself keeps its parts: turned wooden caps and
// posts in the trowel handle's own browns, a gradient-lit sand, a diagonal
// sheen across the glass. Pure inline SVG, no raster, no external assets.
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
  fillFraction,
  formatRegenRate,
  formatSculptCost,
  isPoolFull,
  pulsePeriodSeconds,
} from './gauge.ts';
import { currentBrushCost, deniedCount, liveBalance, manaPool } from './state.ts';

/** How long the denial flash lasts. Matches the HUD's other transient cues. */
const DENIAL_FLASH_MS = 600;

// ── Geometry, in SVG user units of the 32 × 40 viewBox ──────────────────────
// The tile is the toolbar icons' own (a 24-wide diamond, two 4-deep walls),
// pushed to the foot of a taller box so the vessel has room to stand on it.
// The instrument is symmetric about x = 16. Vertically it reads as five
// bands: top cap (4–6.5), upper funnel (6.5–15), neck (15–17), lower funnel
// (17–25.5), bottom cap (25.5–28), with the posts spanning cap to cap.
//
// Only the lower funnel moves, so its extents are the named ones: the sand
// rect, the grain's fall distance and the clip path are all derived from them
// and cannot drift apart.
const VIEW_W = 32;
const VIEW_H = 40;

/**
 * On-screen scale of the icon relative to its viewBox. The toolbar draws its
 * 32-unit faces at 32px; this one is taller than it is wide, so the same
 * scale lands it at 32 × 40 px — the height the old 52 × 74 glass had at its
 * 0.6 reduction (owner, 2026-08-14: "reduce the size of the hourglass by maybe
 * 40%"), so the panel keeps its footprint. Applied to the rendered
 * width/height only; every geometric constant stays in user units.
 */
const GAUGE_DISPLAY_SCALE = 1;
const DISPLAY_W = Math.round(VIEW_W * GAUGE_DISPLAY_SCALE);
const DISPLAY_H = Math.round(VIEW_H * GAUGE_DISPLAY_SCALE);
const GLASS_CENTER_X = 16;
const BULB_TOP_Y = 17;
const BULB_BOTTOM_Y = 25.5;
const BULB_HEIGHT = BULB_BOTTOM_Y - BULB_TOP_Y;

/**
 * The glass as ONE continuous silhouette — both funnels AND the neck tube
 * between them. Drawing the funnels as two separate triangles left a gap at the
 * waist and read as two shapes rather than as one hourglass (caught in a 5×
 * render); the neck walls are what make it a single vessel.
 */
const GLASS_SILHOUETTE_PATH = `M10.5 6.5 H21.5 L16.9 15 V${BULB_TOP_Y} L21.5 ${BULB_BOTTOM_Y} H10.5 L15.1 ${BULB_TOP_Y} V15 Z`;

/** The lower funnel alone: what the sand is clipped to. */
const LOWER_FUNNEL_PATH = `M15.1 ${BULB_TOP_Y} H16.9 L21.5 ${BULB_BOTTOM_Y} H10.5 Z`;

/** Where a grain appears — inside the neck, above an empty bulb's floor. */
const GRAIN_START_Y = 16;
const GRAIN_RADIUS = 0.8;

/** Thickness of the brighter band drawn along the top of the sand. */
const SURFACE_LINE_H = 0.8;

/** Posts: narrow turned columns joining the caps, a bead at each end. */
const POST_LEFT_X = 8.4;
const POST_RIGHT_X = 22;
const POST_WIDTH = 1.6;
const POST_TOP_Y = 6;
const POST_BOTTOM_Y = 26;
const BEAD_RADIUS = 1.1;

// ── Palette ─────────────────────────────────────────────────────────────────
// Self-contained on purpose: this plugin may not touch client/src/ui/hud.css,
// and a plugin that hard-depends on core CSS classes is a plugin that breaks
// when core restyles. The HUD's own custom properties are used for the text and
// the chrome, each with a literal fallback so the gauge stays legible even if a
// future core drops them.
//
// The frame is three browns rather than one flat colour: a lit edge, a body
// and a shadow, fed to a top-to-bottom gradient so the caps read as turned
// wood instead of as stacked rectangles. They are the trowel handle's stops
// (Toolbar.tsx, sculpt-handle), so the vessel and the tools share one timber.
const BRONZE_LIGHT = '#e0a463';
const BRONZE_MID = '#b0733a';
const BRONZE_DARK = '#6d4220';

/** The tile under the vessel: the toolbar icons' own grass and earth. */
const TILE_TOP_LIGHT = '#a6e08a';
const TILE_TOP_DARK = '#4f9a4a';
const TILE_LEFT_LIGHT = '#9a6a45';
const TILE_LEFT_DARK = '#5a3a22';
const TILE_RIGHT_LIGHT = '#6e4a2f';
const TILE_RIGHT_DARK = '#3a2415';

/** Sand: warm amber, lit from the top of the bulb. */
const SAND_LIGHT = '#f5cf74';
const SAND_DEEP = '#cf8f24';
const SAND_SURFACE = '#ffeab3';

/** The denial flash: the same three-tone treatment, in red. */
const DENIED_LIGHT = '#f08e80';
const DENIED_MID = '#d9584a';
const DENIED_DARK = '#6d241c';

/** Glass. Warm-tinted rather than neutral white, so it belongs to the wood;
 * denser than the old 52 × 74 glass needed, because at 32 units across the
 * funnels are a few pixels wide and a fainter tint left only the frame. */
const GLASS_STROKE = 'rgba(255, 234, 196, 0.75)';
const GLASS_TINT = 'rgba(255, 238, 208, 0.18)';
const GLASS_SHEEN = 'rgba(255, 255, 255, 0.14)';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// SVG ids are document-global, so every one this component mints is namespaced.
const FRAME_GRADIENT_ID = 'mana-gauge-frame-grad';
const SAND_GRADIENT_ID = 'mana-gauge-sand-grad';
const BULB_CLIP_ID = 'mana-gauge-bulb-clip';
const GLASS_CLIP_ID = 'mana-gauge-glass-clip';
const TILE_TOP_GRADIENT_ID = 'mana-gauge-tile-top';
const TILE_LEFT_GRADIENT_ID = 'mana-gauge-tile-left';
const TILE_RIGHT_GRADIENT_ID = 'mana-gauge-tile-right';

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
  /**
   * The balance the gauge draws.
   *
   * IT IS NOT A SECOND COPY OF THE POOL, and it used to be (owner, 2026-08-24:
   * "that sounds like there are two sources of truth racing each other — how
   * can the gauge show full and internally it's zero"). This signal held a
   * value that advanced ITSELF every frame from its own previous output, so it
   * and the intent gate were two independent accumulators of the same quantity
   * with nothing tying them together. They duly disagreed: a burst of pull
   * intents drained the gate's estimate to nothing while this one, which never
   * looked at it, went on filling the vessel to the brim.
   *
   * Now it re-derives from `liveBalance` — the ONE function that says what the
   * pool holds — every frame. What the gauge shows and what the gate spends
   * cannot diverge, because there is nothing left to diverge.
   */
  const [displayed, setDisplayed] = createSignal(0);
  const [flashing, setFlashing] = createSignal(false);
  const reduced = prefersReducedMotion();

  // WHOLESALE RESYNC on any pool change — an authoritative push, or a local
  // gate debit (state.ts writes a new pool on every allowed sculpt, so a spend
  // shows on the very next frame instead of a round trip later). The rAF loop
  // below keeps it moving between those; this is what makes it jump the moment
  // something real happens, including under prefers-reduced-motion where there
  // is no loop at all.
  createEffect(() => {
    const pool = manaPool();
    if (pool === null) return;
    setDisplayed(liveBalance(pool));
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

  // THE SMOOTHING LOOP — a re-read, not an accumulator. Each frame simply asks
  // `liveBalance` what the pool holds now; the smooth rise the player sees is
  // that function's own regen term, not a separate integration this component
  // performs. Skipped entirely under prefers-reduced-motion, which leaves the
  // gauge stepping on pool changes instead of sliding — the level still tells
  // the truth either way, which is the property that matters and the one the
  // old accumulator could not promise.
  //
  // A DISCONNECTED CLIENT STILL CLIMBS TO FULL, stated rather than discovered:
  // `liveBalance` measures regen from the last push, and a dead socket sends
  // none. The accumulator this replaces had the same behaviour — its
  // per-frame cap only slowed the climb, it never stopped it — so nothing is
  // lost here, and nothing is applied either way, because a sculpt that cannot
  // be sent is never predicted (see main.tsx's send).
  createEffect(() => {
    if (reduced()) return;

    let frame = 0;
    const step = () => {
      // Read inside the callback, which runs outside any tracking scope, so
      // this does not subscribe the effect to the pool and restart the loop on
      // every push.
      const pool = manaPool();
      if (pool !== null) setDisplayed(liveBalance(pool));
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
      {/* The `title` is one sentence for the whole instrument, assembled from
          the same accessors the readouts use so it restates the LIVE numbers
          rather than a snapshot taken at mount. It ends on the grain because
          the falling cue is the only part of the gauge whose meaning is not
          written in words anywhere on screen. */}
      <div
        class="mana-gauge"
        role="img"
        aria-label={`Mana ${Math.floor(displayed())} of ${manaPool()!.capacity}, refilling ${formatRegenRate(manaPool()!.regenPerSecond)}, current brush costs ${currentBrushCost()}`}
        title={`Mana ${Math.floor(displayed())} of ${manaPool()!.capacity}, refilling ${formatRegenRate(manaPool()!.regenPerSecond)} — the brush in your hand costs ${currentBrushCost()} a click, so one grain falls each time you have earned another.`}
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
            {/* Frame lighting: lit edge at the top, shadow at the bottom, so
                every cap and post picks up the same imaginary light. */}
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

            {/* The tile's three faces, the toolbar icons' own gradients. */}
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
            {/* The whole vessel, for the sheen that crosses it. */}
            <clipPath id={GLASS_CLIP_ID}>
              <path d={GLASS_SILHOUETTE_PATH} />
            </clipPath>
          </defs>

          {/* ── The tile: ground shadow, grass top, two earth walls — the
                toolbar's own stand, at the foot of the box. ── */}
          <ellipse cx="16" cy="35.5" rx="12" ry="3" fill="#000" opacity="0.35" />
          <polygon points="16,21 28,27 16,33 4,27" fill={`url(#${TILE_TOP_GRADIENT_ID})`} />
          <polygon points="4,27 16,33 16,37 4,31" fill={`url(#${TILE_LEFT_GRADIENT_ID})`} />
          <polygon points="28,27 16,33 16,37 28,31" fill={`url(#${TILE_RIGHT_GRADIENT_ID})`} />
          {/* The shade the vessel casts on the grass. */}
          <ellipse cx="16" cy="27.6" rx="8" ry="3.2" fill="#2e5a2e" opacity="0.5" />

          {/* ── Posts, behind the glass: the turned columns the caps sit on,
                a bead at each end. ── */}
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
          {/* A single lit edge down each post — one line is all it takes to
              read as round rather than as a flat bar. */}
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
              x="10"
              y="-4"
              width="2.4"
              height="50"
              fill={GLASS_SHEEN}
              transform={`rotate(18 ${GLASS_CENTER_X} 16)`}
            />
          </g>

          {/* Outlines last, so the glass edge stays crisp over sand and sheen. */}
          <path
            d={GLASS_SILHOUETTE_PATH}
            fill="none"
            stroke={glassColor()}
            stroke-width="0.8"
            stroke-linejoin="round"
          />

          {/* ── Caps: two stacked profiles each (lip and body) rather than one
                bar — the step between them is what makes a turning read as
                turned. ── */}
          <g fill={`url(#${FRAME_GRADIENT_ID})`}>
            <rect x="7" y="4" width="18" height="1.6" rx="0.8" />
            <rect x="9" y="5.4" width="14" height="1.4" rx="0.6" />

            <rect x="9" y="25.2" width="14" height="1.4" rx="0.6" />
            <rect x="7" y="26.4" width="18" height="1.8" rx="0.9" />
          </g>
          {/* One highlight along each lip, so the caps read as lit from above
              like the tile's grass. */}
          <g fill={frameLight()} opacity="0.7">
            <rect x="8" y="4.2" width="16" height="0.4" rx="0.2" />
            <rect x="8" y="26.6" width="16" height="0.4" rx="0.2" />
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
          <span
            class="mana-gauge__rate"
            title="Mana this world hands back every second, even while you do nothing."
          >
            {formatRegenRate(manaPool()!.regenPerSecond)}
          </span>
          {/* The price of the CURRENT brush: the one number that makes volume
              pricing visible before the pool drains, and the answer to "why did
              that stamp cost so much more than the last one". */}
          <span
            class="mana-gauge__cost"
            title="What one click of the current brush costs — bigger and harder brushes cost more."
          >
            {formatSculptCost(currentBrushCost())}
          </span>
        </div>
      </div>
    </Show>
  );
}
