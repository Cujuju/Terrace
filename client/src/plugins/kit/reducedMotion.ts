const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface ReducedMotionWatch {
  matches(): boolean;
  stop(): void;
}

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
