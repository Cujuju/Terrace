import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface BridgedMonsterState {
  readonly id: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

export interface MonstersApi {
  monsterStates(): BridgedMonsterState[];
}

const MONSTERS_PLUGIN_NAME = 'monsters';

export const MONSTERS_UNAVAILABLE_WARNING =
  '[pilgrims] monsters plugin not available — nothing to pilgrimage to';

function asMonstersApi(module: SiblingModule | null): MonstersApi | null {
  if (module === null) return null;
  if (typeof module.monsterStates !== 'function') return null;
  return module as unknown as MonstersApi;
}

const bridge = createSiblingBridge<MonstersApi>({
  pluginName: MONSTERS_PLUGIN_NAME,
  duckType: asMonstersApi,
  unavailableWarning: MONSTERS_UNAVAILABLE_WARNING,
});

export function loadMonstersBridge(world: WorldApi): void {
  bridge.load(world);
}

export function bridgedMonsters(): BridgedMonsterState[] {
  const states = bridge.api()?.monsterStates();
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

export function resetMonstersBridge(): void {
  bridge.reset();
}
