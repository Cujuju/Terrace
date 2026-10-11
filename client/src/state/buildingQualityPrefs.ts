import { createSignal } from 'solid-js';
import { persistedChoice } from './persistedChoice.ts';

export type BuildingQuality = 'low' | 'original';
export interface PreparedBuildingQuality {
  apply(): void;
  discard(): void;
}
type Prepare = (quality: BuildingQuality) => Promise<PreparedBuildingQuality>;

const [buildingQuality, persistQuality] = persistedChoice<BuildingQuality>(
  'terrace.buildingQuality.v1', ['low', 'original'], 'low',
);
const [buildingQualityLoading, setLoading] = createSignal(false);
const [buildingQualityError, setError] = createSignal<string | null>(null);
export { buildingQuality, buildingQualityLoading, buildingQualityError };

const consumers = new Set<Prepare>();
let consumerRevision = 0;

export function registerBuildingQualityConsumer(prepare: Prepare): () => void {
  consumers.add(prepare);
  consumerRevision++;
  return () => { consumers.delete(prepare); consumerRevision++; };
}

export async function setBuildingQuality(quality: BuildingQuality): Promise<void> {
  if (buildingQualityLoading() || quality === buildingQuality()) return;
  setLoading(true);
  setError(null);
  const handlers = [...consumers];
  const revision = consumerRevision;
  try {
    const results = await Promise.allSettled(handlers.map(async (prepare) => prepare(quality)));
    if (revision !== consumerRevision || results.some((result) => result.status === 'rejected')) {
      for (const result of results) if (result.status === 'fulfilled') result.value.discard();
      setError('Building quality could not load. Your previous setting is still active; try again.');
      return;
    }
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status !== 'fulfilled') continue;
      if (consumers.has(handlers[i])) result.value.apply();
      else result.value.discard();
    }
    persistQuality(quality);
  } finally {
    setLoading(false);
  }
}
