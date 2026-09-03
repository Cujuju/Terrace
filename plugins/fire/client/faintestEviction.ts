// FAINTEST-FIRST EVICTION — the one selection ./smoke.ts and ./scar.ts share.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS ONE FILE AND NOT TWO FUNCTIONS.
//
// Both caches are the same shape: a Map keyed by ./flames/types.ts's `key`,
// holding a record with a `strength` that fades and an `alive` flag that says
// whether this frame's fire list still contains it, capped at
// FIRE_FLAME_INSTANCE_CAP, and refilled every frame from that list. Both need
// exactly one thing when the cap binds — "free N slots" — and both had written
// that selection out themselves, identically. Two copies of one selection is
// one contract in two places, so it lives here and the callers ask by count.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT TAKES A COUNT, AND WHAT ONE-AT-A-TIME COST (measured 2026-09-02).
//
// The two copies each dropped ONE entry per insert, scanning the whole map to
// find it. Smoke and scars outlive their fire, so both caches sit at their cap
// while the world burns, and a fire whose entry was evicted asks for a slot
// again on the very next frame — so the scan ran per fire, per frame, over the
// whole cap. Measured on the owner's live burn with `renderer.render` stubbed:
// 52.1 ms/frame in smoke's copy and 40.2 ms/frame in scar's, together 98.5 % of
// the fire plugin's entire 93.7 ms frame callback.
//
// Taking a COUNT is what removes the multiplication. The caller gathers the
// frame's whole shortfall first and asks once, so the selection runs ONCE per
// cache per frame however many slots the frame needs.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY ONLY A DEAD ENTRY IS EVER A CANDIDATE.
//
// This is the one behavioural change, and it is a defect fix rather than a
// tuning choice. "Evict the faintest" is self-defeating taken literally, because
// A NEW ENTRY IS BORN AT STRENGTH 0 and is therefore the faintest thing in the
// map the instant it exists. The old one-at-a-time loop only escaped that by
// accident: its victim was almost always a column it had itself inserted a few
// iterations earlier, so an oversubscribed world quietly rotated ONE slot and
// left the rest alone. Asking for the whole shortfall at once removes the
// accident and exposes the policy — and the honest version of it selected the
// N faintest and traded N established columns for N invisible newborns. Driven
// to 2000 fires against a 448 cap, that emptied and refilled the entire cache
// every frame: 448 columns drawn, every one of them at strength 0.004, where
// the old loop had held a real spread of strengths.
//
// So the candidates are the entries whose fire is GONE — `alive === false`,
// which ./smoke.ts and ./scar.ts both set from this frame's list before asking.
// That is the set where "faintest" means what it says: a fading entry has no
// future, only a dwindling memory of a fire that is over, and the faintest of
// them is the least of those. An entry whose fire is still alight is not a
// candidate at any strength, because trading it for another alight fire's
// newborn entry loses everything the first one had accumulated and gains a
// thing that cannot be seen. When the dead cannot cover the shortfall the
// surplus is REFUSED — the callers stop inserting — which is stable, is what
// the old loop did in effect, and never pops anything already on screen.
//
// It also puts the cost where the pressure comes from: both caches exceed their
// cap ONLY because smoke and scars outlive their fire, so the afterlife is what
// pays for the overflow.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A BUCKET PASS, AND NOT A HEAP OR A FREE LIST.
//
// NOT A HEAP: a heap is the textbook answer for "the k smallest" only when the
// keys hold still. These keys do not — every surviving entry's `strength` moves
// EVERY FRAME (both caches advance or decay all of them in `update`), so a heap
// would have to be re-heapified from scratch each frame. That is the same O(n)
// pass done below, plus a heap to maintain and keep in sync with the Map on
// every insert and every retirement.
//
// NOT A BUCKETED FREE LIST: same reason, one step worse. A structure that
// remembers which bucket an entry is in has to MOVE entries between buckets as
// their strength drifts, which is a per-entry write every frame plus the
// bookkeeping — again O(n) per frame, to avoid an O(n) pass per frame.
//
// So: one counting pass and one deleting pass over the Map, both O(n), with no
// structure kept between frames at all. Nothing to maintain, nothing to get out
// of sync, and the cost no longer depends on how many slots the frame wants.

/** What eviction needs of an entry, and nothing else. */
export interface FadingEntry {
  /** 0 at birth, 1 at full presence — the thing that fades. */
  strength: number;
  /** Whether this frame's fire list still contains the fire behind it. */
  alive: boolean;
}

/**
 * How finely strength is resolved when choosing what to drop.
 *
 * 256, because strength drives ALPHA and nothing else: two entries inside one
 * bucket differ by less than one step of an 8-bit alpha channel, which is less
 * than the frame buffer can show. Within a bucket the entries are therefore
 * equally faint as far as the screen is concerned, and dropping either is the
 * same decision — which is what lets the second pass delete from the boundary
 * bucket in map order instead of sorting it.
 */
const STRENGTH_BUCKETS = 256;

/**
 * Scratch, allocated once: how many dead entries fall in each strength bucket.
 *
 * A module-level array is safe here because `evictFaintest` never yields — it
 * fills this and consumes it inside one synchronous call, on the one thread
 * every renderer runs on — so no two callers can ever hold it at once.
 */
const bucketCounts = new Uint32Array(STRENGTH_BUCKETS);

/** The bucket an entry's strength falls in, clamped to the legal range. */
function bucketOf(strength: number): number {
  if (!(strength > 0)) return 0; // also catches NaN, which must not index out
  if (strength >= 1) return STRENGTH_BUCKETS - 1;
  return (strength * STRENGTH_BUCKETS) | 0;
}

/**
 * Frees UP TO `count` slots by dropping the faintest entries whose fire is gone.
 *
 * Fewer than asked when the dead run out, and none at all when there are none:
 * the caller then finds the map still at its cap and refuses the surplus, which
 * is the intended answer rather than a failure (see the header).
 *
 * Deleting DURING iteration is safe on a Map and is how both callers already
 * retire a faded entry as they pass it.
 */
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

  // Walk up from the faintest bucket: everything below `boundary` goes
  // outright, and `remainder` more come out of `boundary` itself. When the dead
  // cannot cover the shortfall every one of them goes and the walk is skipped.
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
