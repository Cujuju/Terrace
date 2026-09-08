export interface FadingEntry {
  strength: number;
  alive: boolean;
}

const STRENGTH_BUCKETS = 256;

const bucketCounts = new Uint32Array(STRENGTH_BUCKETS);

function bucketOf(strength: number): number {
  if (!(strength > 0)) return 0;
  if (strength >= 1) return STRENGTH_BUCKETS - 1;
  return (strength * STRENGTH_BUCKETS) | 0;
}

export function evictFaintest<T extends FadingEntry>(entries: Map<number, T>, count: number): void {
  if (count <= 0) return;

  bucketCounts.fill(0);
  let dead = 0;
  for (const entry of entries.values()) {
    if (entry.alive) continue;
    const bucket = bucketOf(entry.strength);
    bucketCounts[bucket] = bucketCounts[bucket]! + 1;
    dead++;
  }
  if (dead === 0) return;

  let boundary = STRENGTH_BUCKETS;
  let remainder = 0;
  if (count < dead) {
    boundary = 0;
    let below = 0;
    while (boundary < STRENGTH_BUCKETS - 1 && below + bucketCounts[boundary]! < count) {
      below += bucketCounts[boundary]!;
      boundary++;
    }
    remainder = count - below;
  }

  for (const [key, entry] of entries) {
    if (entry.alive) continue;
    const bucket = bucketOf(entry.strength);
    if (bucket < boundary) {
      entries.delete(key);
    } else if (bucket === boundary && remainder > 0) {
      entries.delete(key);
      remainder--;
    }
  }
}
