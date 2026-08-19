// pilgrims → monsters, the same cross-plugin bridge shape as
// ./structures-bridge.ts (and relics' mana-bridge.ts before it — its header
// is the contract). READ-ONLY: this plugin only ever polls where the living
// monsters are; it never writes a byte of monsters' state.
//
// DEGRADED BEHAVIOUR when monsters is absent: nothing ever settles, so no
// pilgrimages ever start — true by definition. One warning, once.

/** One living monster, structurally typed (never imported). */
export interface BridgedMonsterState {
  readonly id: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

/** The slice of monsters this plugin uses. */
export interface MonstersApi {
  monsterStates(): BridgedMonsterState[];
}

export type MonstersModuleLoader = () => Promise<unknown>;

const DEFAULT_MONSTERS_MODULE_LOADER: MonstersModuleLoader = () =>
  import('../../monsters/server/index.ts');

export const MONSTERS_UNAVAILABLE_WARNING =
  '[pilgrims] monsters plugin not available — nothing to pilgrimage to';

let loadModule: MonstersModuleLoader = DEFAULT_MONSTERS_MODULE_LOADER;
let monstersApi: MonstersApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

function asMonstersApi(module: unknown): MonstersApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<MonstersApi>;
  if (typeof candidate.monsterStates !== 'function') return null;
  return candidate as MonstersApi;
}

function warnUnavailable(error?: unknown): void {
  if (warned) return;
  warned = true;
  if (error === undefined) console.warn(MONSTERS_UNAVAILABLE_WARNING);
  else console.warn(MONSTERS_UNAVAILABLE_WARNING, error);
}

/** Starts (once) the load. Always resolves — absence is an outcome, not an error. */
export function loadMonstersBridge(): Promise<void> {
  if (loadPromise !== null) return loadPromise;

  loadPromise = loadModule()
    .then((module) => {
      const resolved = asMonstersApi(module);
      if (resolved === null) {
        warnUnavailable();
        return;
      }
      monstersApi = resolved;
    })
    .catch((error: unknown) => {
      warnUnavailable(error);
    });

  return loadPromise;
}

/** Resolves when the load has settled, whichever way. Test/boot-order seam. */
export function monstersBridgeReady(): Promise<void> {
  return loadPromise ?? Promise.resolve();
}

/**
 * The living monsters right now, or none while monsters is absent/loading.
 * Entries are re-validated structurally on every poll: the bridge trusts the
 * module's SHAPE once, but a fork could still hand back malformed rows.
 */
export function bridgedMonsters(): BridgedMonsterState[] {
  const states = monstersApi?.monsterStates();
  if (!Array.isArray(states)) return [];
  const valid: BridgedMonsterState[] = [];
  for (const state of states) {
    if (typeof state !== 'object' || state === null) continue;
    const entry = state as Partial<BridgedMonsterState>;
    if (typeof entry.id !== 'number' || !Number.isFinite(entry.id)) continue;
    if (typeof entry.kind !== 'string') continue;
    if (typeof entry.x !== 'number' || !Number.isFinite(entry.x)) continue;
    if (typeof entry.y !== 'number' || !Number.isFinite(entry.y)) continue;
    valid.push({ id: entry.id, kind: entry.kind, x: entry.x, y: entry.y });
  }
  return valid;
}

/** Test seam: swaps the loader. Pass null to restore the real one. */
export function setMonstersModuleLoader(loader: MonstersModuleLoader | null): void {
  loadModule = loader ?? DEFAULT_MONSTERS_MODULE_LOADER;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetMonstersBridge(): void {
  loadModule = DEFAULT_MONSTERS_MODULE_LOADER;
  monstersApi = null;
  loadPromise = null;
  warned = false;
}
