const BOOT_MARK_PREFIX = 'terrace:';

export const BOOT_MARKS = {
  viewportReady: `${BOOT_MARK_PREFIX}viewport-ready`,
  joinIssued: `${BOOT_MARK_PREFIX}join-issued`,
  roomJoined: `${BOOT_MARK_PREFIX}room-joined`,
  snapshot: `${BOOT_MARK_PREFIX}snapshot`,
  firstFrame: `${BOOT_MARK_PREFIX}first-frame`,
  firstTerrainUpdate: `${BOOT_MARK_PREFIX}first-terrain-update`,
  terrainQueueEmpty: `${BOOT_MARK_PREFIX}terrain-queue-empty`,
} as const;

export type BootMark = (typeof BOOT_MARKS)[keyof typeof BOOT_MARKS];

// User-timing marks: they land in Chrome traces (blink.user_timing) and in the perf probe report.
export function markBoot(name: BootMark): void {
  performance.mark(name);
}

/** First occurrence of each boot mark, in ms since navigation. */
export function readBootMarks(): Record<string, number> {
  const out = new Map<string, number>();
  for (const entry of performance.getEntriesByType('mark')) {
    if (!entry.name.startsWith(BOOT_MARK_PREFIX) || out.has(entry.name)) continue;
    out.set(entry.name, entry.startTime);
  }
  return Object.fromEntries(out);
}
