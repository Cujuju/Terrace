// THE SKY-KIND REGISTRY — the inward half of the weather hub.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY REGISTRATION IS INWARD, AND NOT A BRIDGE PER KIND.
//
// "How wet is this cell" is a union over an OPEN set of kinds: rain, snow and
// thunderstorm wet the ground today, and a self-hoster may add a fifth kind or
// delete one tomorrow. fire's fuel.ts already settled the shape an open set
// takes — the members register with the thing that asks the question, so the
// asker never changes when a new member appears. A consumer that bridged to
// every kind by name would have to be edited to learn about a fifth.
//
// The OTHER direction stays a bridge, and both are right for their own reason:
// wind is one fact from one named plugin, so fire and mudslides ask `weather`
// for it (plugins/fire/server/weather-bridge.ts) exactly as they always did.
//
// THE KIND IS STAMPED HERE, from the name the entry registered under. A tornado
// looking for a thunderstorm cell filters `livingSystems()` by kind, and that
// filter must not be steerable by whatever a cell claims about itself — the hub
// knows who registered, so the hub says what the kind is.
//
// STRUCTURAL VALIDATION AT REGISTER TIME. A kind plugin is an independently
// deletable folder that may be older than this hub, and the failure mode of a
// missing `wetnessAt` must not be a TypeError inside fire's spread loop half an
// hour later. It throws at registration, where the host's per-callback guard
// turns it into one logged line and a kind that simply is not in the sky.
// ─────────────────────────────────────────────────────────────────────────────

/** One disc in the sky, as a consumer sees it. */
export interface SkyCell {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

/** What a kind plugin hands the hub when it joins the sky. */
export interface SkyKindEntry {
  /** The registering plugin's name. Also the key: one entry per name. */
  readonly name: string;
  /** This kind's living systems, for consumers that need the masses themselves. */
  cells(): readonly SkyCell[];
  /** How wet this kind makes a cell, in [0, 1]. Zero for a non-wetting kind. */
  wetnessAt(x: number, y: number): number;
  /**
   * Births ONE unsited system of this kind right now, within this kind's own
   * cap, and answers whether it did (#285).
   *
   * OPTIONAL. It exists so a kind that loses a birth to its own siting rule can
   * hand the roll to another kind BY NAME — snow's old fallback to rain,
   * preserved across the split — and a kind nobody hands anything to needs no
   * such entry point.
   */
  spawnOne?(): boolean;
}

/** A living system, with the kind the HUB stamped on it. */
export interface SkyKindSystem extends SkyCell {
  readonly kind: string;
}

/**
 * The registered kinds, in registration order — which is plugin LOAD order,
 * since each registers from its own onWorldCreate. Fixed order is what makes
 * `livingSystems()` reproducible for a consumer that samples it.
 */
const entries: SkyKindEntry[] = [];

function isSkyKindEntry(entry: unknown): entry is SkyKindEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const candidate = entry as Partial<SkyKindEntry>;
  if (typeof candidate.name !== 'string' || candidate.name === '') return false;
  if (typeof candidate.cells !== 'function') return false;
  if (typeof candidate.wetnessAt !== 'function') return false;
  if (candidate.spawnOne !== undefined && typeof candidate.spawnOne !== 'function') return false;
  return true;
}

/**
 * Adds a kind to the sky and returns the function that removes it again.
 *
 * SAME NAME REPLACES. A plugin's onWorldCreate replays on a reopen and on a
 * rollback (server/src/plugins/types.ts), so registering twice is ordinary and
 * must leave one entry, not two — otherwise every reopen would double a kind's
 * contribution to `livingSystems` and its wetness would be counted twice.
 *
 * The returned unregister is IDEMPOTENT and removes only the entry it made: a
 * kind that has since re-registered is left alone, so a late `clear()` from a
 * closing world cannot tear down a live one.
 */
export function registerSkyKind(entry: SkyKindEntry): () => void {
  if (!isSkyKindEntry(entry)) {
    throw new TypeError(
      '[weather] a sky kind must register { name, cells(), wetnessAt(x, y) } — registration refused',
    );
  }

  const existing = entries.findIndex((candidate) => candidate.name === entry.name);
  if (existing >= 0) entries.splice(existing, 1);
  entries.push(entry);

  return () => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  };
}

/**
 * Asks the kind called `name` to birth one system now. False when no such kind
 * is running here, when it offers no hand-off, or when it declined — the caller
 * loses the roll either way and must not have to tell those apart.
 */
export function spawnSkyKind(name: string): boolean {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry?.spawnOne === undefined) return false;
  return entry.spawnOne() === true;
}

/**
 * How wet cell (x, y) is right now, in [0, 1] — the strongest wetting kind
 * covering it, or 0 under clear sky.
 *
 * STRONGEST rather than summed, because two overlapping fronts do not make the
 * ground twice as wet as water can make it, and a sum would exceed 1 and break
 * every caller that treats this as a fraction. A malformed answer from one kind
 * is skipped rather than trusted into the arithmetic, where a NaN would silently
 * disable rain suppression everywhere.
 */
export function precipitationAt(x: number, y: number): number {
  let wettest = 0;
  for (const entry of entries) {
    const wetness = entry.wetnessAt(x, y);
    if (!Number.isFinite(wetness)) continue;
    if (wetness > wettest) wettest = wetness;
  }
  return Math.min(1, Math.max(0, wettest));
}

/**
 * Every living system in the sky, whatever kind, each stamped with the name of
 * the plugin that owns it.
 *
 * READ-ONLY BY CONSTRUCTION at the type level. The cells themselves are each
 * kind's own state; a consumer that wrote to one would be steering the weather.
 */
export function livingSystems(): readonly SkyKindSystem[] {
  const all: SkyKindSystem[] = [];
  for (const entry of entries) {
    for (const cell of entry.cells()) {
      all.push({
        kind: entry.name,
        x: cell.x,
        y: cell.y,
        radius: cell.radius,
        intensity: cell.intensity,
      });
    }
  }
  return all;
}

/**
 * Empties the registry.
 *
 * Called from the hub's onWorldClose and NOT from its onWorldCreate. Plugins are
 * invoked in load order — alphabetical by directory — so `fog`, `rain`, `snow`
 * and `thunderstorm` all register before `weather` creates, and a create-time
 * clear would wipe every registration the world had just made.
 */
export function resetSkyRegistry(): void {
  entries.length = 0;
}
