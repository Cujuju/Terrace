import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';

export type TerrainMesher = 'auto' | 'gpu' | 'cpu';

export const TERRAIN_MESHERS: readonly TerrainMesher[] = ['auto', 'gpu', 'cpu'];

export const DEFAULT_TERRAIN_MESHER: TerrainMesher = 'auto';

const TERRAIN_MESHER_STORAGE_KEY = 'terrace.terrainMesher.v1';

const MESHER_QUERY_FLAG = 'mesher';

/** `auto` is the stored default, so pinning it from the URL would say nothing. */
const PINNABLE_MESHERS: readonly TerrainMesher[] = ['gpu', 'cpu'];

// The parity harness runs the same world twice, one mesher each. Read once at boot and
// never stored: a harness run must not change what the browser remembers.
function pinnedMesher(): TerrainMesher | null {
  if (!import.meta.env.DEV) return null;
  try {
    const raw = new URLSearchParams(location.search).get(MESHER_QUERY_FLAG);
    return PINNABLE_MESHERS.includes(raw as TerrainMesher) ? (raw as TerrainMesher) : null;
  } catch {
    return null;
  }
}

const pinned = pinnedMesher();

const [storedTerrainMesher, setTerrainMesherSignal] = persistedChoice<TerrainMesher>(
  TERRAIN_MESHER_STORAGE_KEY,
  TERRAIN_MESHERS,
  DEFAULT_TERRAIN_MESHER,
);

/** The choice in force: the DEV URL pin when there is one, else the stored choice. */
export const terrainMesher = (): TerrainMesher => pinned ?? storedTerrainMesher();

export const setTerrainMesher = setTerrainMesherSignal;

export function resetTerrainMesherPrefs(): void {
  setTerrainMesherSignal(DEFAULT_TERRAIN_MESHER);
  clearPersistedChoice(TERRAIN_MESHER_STORAGE_KEY);
}
