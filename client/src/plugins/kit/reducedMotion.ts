// The user's motion preference, watched LIVE.
//
// WHY IT IS HERE. Five files carried a byte-identical copy of the function
// below — daynight, storms and weather's client entry points, monsters'
// atmosphere and core's own river rig — each with a header saying it was
// restated rather than imported because plugin halves do not depend on each
// other's internals. That reasoning is right about a PLUGIN and wrong about
// this: the kit is core, not a plugin, so importing it is the same kind of
// dependency as importing `three`.
//
// FALLS BACK TO "NOT REDUCED" where matchMedia does not exist, which here is the
// node test runner: the only environment in this repo without it, and it draws
// nothing, so defaulting to `true` there would let the normal (non-frozen)
// render path go untested.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** A live view of the preference, plus the unsubscribe that goes with it. */
export interface ReducedMotionWatch {
  /** Whether the user is currently asking for reduced motion. */
  matches(): boolean;
  /** Drops the listener. Safe to call when there was never one. */
  stop(): void;
}

/**
 * Starts watching the preference.
 *
 * LIVE rather than sampled once: the preference is an OS-level setting a user
 * can change while the page is open — which is exactly when someone who has just
 * been made uncomfortable by the motion will change it.
 */
export function watchReducedMotion(): ReducedMotionWatch {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  if (query === null) return { matches: () => false, stop: () => {} };

  let reduced = query.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    reduced = event.matches;
  };
  query.addEventListener('change', onChange);
  return {
    matches: () => reduced,
    stop: () => query.removeEventListener('change', onChange),
  };
}
