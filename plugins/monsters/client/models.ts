import { DEFAULT_YETI_VARIANT, type MonsterKind, type YetiVariant } from '../protocol.ts';
import { createCthulhuFactory } from './cthulhu.ts';
import { createWorkshop } from './geometry.ts';
import { createKrakenFactory } from './kraken.ts';
import { createYetiFactory } from './yeti.ts';

export { MONSTER_MODEL_DETAIL } from './geometry.ts';
export type { MonsterModel } from './geometry.ts';

import type { MonsterModel } from './geometry.ts';

export interface MonsterModels {
  create(kind: MonsterKind, variant?: YetiVariant): MonsterModel;
  dispose(): void;
}

export function createMonsterModels(): MonsterModels {
  const workshop = createWorkshop();

  const constructors: Readonly<Record<Exclude<MonsterKind, 'yeti'>, () => MonsterModel>> = {
    cthulhu: createCthulhuFactory(workshop),
    kraken: createKrakenFactory(workshop),
  };

  const yetiConstructors = createYetiFactory(workshop);

  return {
    create(kind, variant) {
      if (kind === 'yeti') return yetiConstructors[variant ?? DEFAULT_YETI_VARIANT]();
      return constructors[kind]();
    },
    dispose() {
      workshop.dispose();
    },
  };
}
