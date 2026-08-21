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

import { Show, type JSX } from 'solid-js';
import { frameRate, serverVersion } from '../state/hudState.ts';

/** This bundle's stamp; the `typeof` guard keeps any non-Vite runtime (a
 *  future test harness importing UI) at the sentinel instead of throwing. */
const CLIENT_VERSION: string =
  typeof __CLIENT_VERSION__ === 'string' ? __CLIENT_VERSION__ : 'unversioned';

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
      <Show when={mismatch()}>
        <span class="hud-version__flag">version skew — restart the stack</span>
      </Show>
    </div>
  );
}
