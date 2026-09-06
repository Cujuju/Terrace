// The top-right diagnostic stack: which commit each half of the stack is
// running, and how fast it is drawing. Pinned top-right in small text (owner
// request, 2026-08-19; the frame-rate line joined it 2026-08-20).
//
// WHY IT EXISTS: that same morning the dev stack served a client bundle built
// from newer shared/ math than the server was running (a Vite-only restart
// after a shared/ commit), and every sculpt previewed one thing while the
// server applied another. Matching versions are quiet chrome; a mismatch
// turns the watermark loud, because a skewed stack lies to the player about
// every stroke.
//
// Versions are derived from git, never hand-bumped — `<commit count>.<short
// hash>`, stamped into this bundle by vite.config.ts and into the server at
// boot (server/src/version.ts, carried on the join snapshot). They bump on
// every commit by construction.
//
// WHY THE FRAME RATE LIVES HERE (owner, 2026-08-20) rather than in its own
// corner: this block is already the page's diagnostic column — the numbers you
// read when something is wrong and never look at when it is not — and it is
// already the one piece of chrome that takes no pointer events, so a readout
// added to it cannot steal a corner drag from the camera. render/frameRate.ts
// owns the measurement; this file only prints it.
//
// SOLID REACTIVITY: serverVersion() and frameRate() are called at each use
// site. The version arrives with the join snapshot, after first render, and
// changes on every rejoin; the frame rate changes twice a second forever.
// CLIENT_VERSION alone is a const on purpose: it is a build-time literal that
// cannot change for the life of the page.

import { For, Show, type JSX } from 'solid-js';
import { frameDraw, frameRate, frameStats, perfOpen, serverVersion } from '../state/hudState.ts';
import { pluginDrawRows } from '../plugins/hudPanels.ts';

/** This bundle's stamp; the `typeof` guard keeps any non-Vite runtime (a
 *  future test harness importing UI) at the sentinel instead of throwing. */
const CLIENT_VERSION: string =
  typeof __CLIENT_VERSION__ === 'string' ? __CLIENT_VERSION__ : 'unversioned';

/**
 * A millisecond reading as the frame rate it corresponds to.
 *
 * EVERY MILLISECOND ROW CARRIES ONE (owner, 2026-09-06), and they do not all
 * mean the same thing, so read the label first:
 *
 *   - `interval` is the rate actually being presented — the honest fps, the
 *     same quantity the meter at the top of this column reports.
 *   - `frame` is the rate the frame's CPU work would ALLOW if nothing else
 *     capped it. Higher than the presented rate whenever vsync holds frames
 *     back, and the number that says whether there is headroom against the
 *     project's 140 fps bar.
 *   - `render`, `outside`, `p99` and `max` are the rate that COMPONENT alone
 *     would allow, were it the only cost in the frame. None of them is an
 *     achievable rate; each answers "what is this piece costing me, in the
 *     units I think in", which is the question a millisecond does not answer
 *     at a glance.
 *
 * Zero is not divided into: a window with no interval yet (the first frame has
 * no predecessor) has no rate, and an infinity in a diagnostic is noise.
 *
 * A RATE BELOW ONE PRINTS "<1", NEVER "0". Rounding 0.31 fps to "0 fps" says
 * the renderer has stopped, which is a different and much worse fact than "this
 * is desperately slow" — and the frames it was measured from prove it has not.
 * A diagnostic that lies at its own extreme is worse than no diagnostic.
 */
const MIN_PRINTABLE_FPS = 1;

function asFps(ms: number): string {
  if (ms <= 0) return '';
  const fps = 1000 / ms;
  return fps < MIN_PRINTABLE_FPS ? '<1 fps' : `${String(Math.round(fps))} fps`;
}

/**
 * One millisecond reading and, in parentheses, the frame rate it corresponds
 * to. Its own component because every ms row is the same shape, and six
 * hand-built template strings is five chances to format one of them differently
 * from the rest.
 */
function PerfMsRow(props: { label: string; ms: number }): JSX.Element {
  const fps = (): string => asFps(props.ms);
  return (
    <PerfRow
      label={props.label}
      value={`${props.ms.toFixed(2)} ms${fps() === '' ? '' : ` (${fps()})`}`}
    />
  );
}

/** One labelled reading of the frame meter — label and value, both left. */
function PerfRow(props: { label: string; value: string }): JSX.Element {
  return (
    <span class="hud-version__perf">
      <span class="hud-version__perf-label">{props.label}</span>
      <span>{props.value}</span>
    </span>
  );
}

export function VersionWatermark(): JSX.Element {
  // A mismatch needs BOTH stamps: a server too old to send one (null) is
  // "unknown", and unknown must render quiet, not accused — same absent-means-
  // unknown contract as the world header's fields.
  const mismatch = (): boolean =>
    serverVersion() !== null && serverVersion() !== CLIENT_VERSION;
  return (
    <div class="hud-version" classList={{ 'hud-version--mismatch': mismatch() }}>
      <span>cli {CLIENT_VERSION}</span>
      <Show when={serverVersion()}>{(v) => <span>srv {v()}</span>}</Show>
      {/* Null until the first sampling window closes — show nothing rather
          than a made-up figure (hudState's frameRate contract). Tested for
          null rather than truthiness: a real reading of 0 must still print,
          and "the renderer has stopped" is precisely when this line matters. */}
      <Show when={frameRate() !== null}>
        <span class="hud-version__fps">{frameRate()} fps</span>
      </Show>
      {/* The draw-call budget (part B of
          docs/plans/frame-budget-growth-and-draw-calls.md). TWO NUMBERS AND A
          BUDGET, never one ratio: `objects` is what the scene contains before
          frustum culling — the camera-independent thing a budget can be
          written against — and `calls` is what the renderer actually submitted
          last frame, which is lower whenever much of the world is off screen.
          Null until the host's first sampling window closes, same contract as
          the frame rate above. */}
      <Show when={frameDraw()}>
        {(draw) => (
          <span
            class="hud-version__draw"
            classList={{
              // OVER, not at: the budget is the most the frame may hold.
              'hud-version__draw--over': draw().objects > draw().budget,
            }}
          >
            {draw().objects}/{draw().budget} objects · {draw().calls} calls
          </span>
        )}
      </Show>
      {/* THE FRAME METER (render/frameStats.ts), backquote to toggle. It joins
          the diagnostic column rather than taking a corner of its own for the
          reason the frame rate did: this block already takes no pointer events,
          so nothing added to it can steal a corner drag from the camera.

          `uptime` is first because it is the axis every other number on these
          rows is read against — the decay in
          docs/plans/frame-rate-decay-2026-09-05.md §7d is a slope in minutes,
          invisible in any single reading. `render` is second because it is the
          quantity that was shown to grow; `outside` sits beside it so a growing
          render can be told at a glance from a growing plugin frame handler.
          Two decimals: the whole decay is 2.1 ms per ten minutes, and one
          decimal would round away a window's worth of it. */}
      <Show when={perfOpen() ? frameStats() : null}>
        {(stat) => (
          <>
            {/* ONE READING PER LINE (owner, 2026-09-06: packed rows are "too
                hard to read"). Each row is a label and its number, the label
                left and the number right, so the numbers form a single column
                the eye can run down — which is the whole job here, since what
                matters is a value CHANGING, not its absolute size. Packing
                three per line saved height and cost exactly that.

                Order is the order the questions get asked: how long has this
                page been up, how big is what it is drawing, where is the frame
                time going, how bad do the worst frames get, and what is three
                holding on to. */}
            <PerfRow label="up" value={`${Math.round(stat().uptimeS)}s`} />
            <PerfRow label="frames" value={String(stat().frames)} />
            <PerfRow
              label="pixels"
              value={`${stat().counters.pixelWidth}x${stat().counters.pixelHeight}`}
            />
            {/* Two decimals throughout: the decay this exists to show is about
                2 ms per ten minutes, and one decimal rounds a window's worth of
                it away. */}
            <PerfMsRow label="render" ms={stat().renderMsP50} />
            <PerfMsRow label="outside" ms={stat().outsideMsP50} />
            <PerfMsRow label="frame" ms={stat().frameMsP50} />
            <PerfMsRow label="p99" ms={stat().frameMsP99} />
            <PerfMsRow label="max" ms={stat().frameMsMax} />
            <PerfMsRow label="interval" ms={stat().intervalMsP50} />
            {/* THE ROW THAT SAYS WHOSE FAULT A SLOW FRAME IS. Read against
                `frame`: GPU well above it means the CPU is finishing early and
                waiting on the adapter; GPU well below it while `interval` is
                far above BOTH means neither is busy and something outside the
                renderer is pacing presentation — a display refresh, a
                compositor, a throttle. Absent where the adapter offers no
                timer, which is a different fact from zero. */}
            <Show when={stat().gpuMsP50 !== null} fallback={<PerfRow label="gpu" value="unavailable" />}>
              <PerfMsRow label="gpu" ms={stat().gpuMsP50 ?? 0} />
            </Show>
            {/* THE POSE, beside the draw calls it explains. A frame time is
                only comparable with another taken from the same distance:
                the bench's own framing sees a third of the draw calls the
                stored play pose does (2026-09-06). */}
            <PerfRow label="camera" value={stat().counters.cameraDistance.toFixed(0)} />
            <PerfRow label="draws" value={String(stat().counters.drawCalls)} />
            <PerfRow
              label="triangles"
              value={`${(stat().counters.triangles / 1e6).toFixed(2)} M`}
            />
            <PerfRow label="geometries" value={String(stat().counters.geometries)} />
            <PerfRow label="textures" value={String(stat().counters.textures)} />
            <PerfRow label="programs" value={String(stat().counters.programs)} />
            {/* EVERY PLUGIN THAT RAN A FRAME CALLBACK, dearest first (owner,
                2026-09-06). Two numbers, because "how much is this eating" has
                two answers and only both together are actionable: the
                milliseconds it costs the frame, and that as a SHARE of the
                frame — 0.40 ms is most of a fast frame and nothing at all in a
                slow one, and the share is what says which.

                A SHARE RATHER THAN AN fps, unlike the millisecond rows above.
                A plugin is not a frame rate: "0.40 ms (2500 fps)" invites the
                reading that this plugin runs at 2500 fps, which is not a fact
                about anything. The share answers the question actually being
                asked, which is what to delete first.

                The draw-budget row below is deliberately separate — objects
                against budget is a different accounting (part B of
                docs/plans/frame-budget-growth-and-draw-calls.md), sampled by
                the host, and only breaches are worth permanent HUD space. */}
            <For each={stat().plugins}>
              {(row) => (
                <PerfRow
                  label={row.name}
                  value={`${row.msPerFrame.toFixed(2)} ms (${String(Math.round(row.shareOfFrame * 100))}%)`}
                />
              )}
            </For>
          </>
        )}
      </Show>
      {/* One row per plugin over its budget. Only the breaches: seventeen rows
          of healthy plugins would bury the one that matters, and the full
          table belongs to the probe, not to a watermark. */}
      <For each={pluginDrawRows().filter((row) => row.breached)}>
        {(row) => (
          <span class="hud-version__draw hud-version__draw--over">
            {row.pluginName} {row.objects}/{row.budget}
          </span>
        )}
      </For>
      <Show when={mismatch()}>
        <span class="hud-version__flag">version skew — restart the stack</span>
      </Show>
    </div>
  );
}
