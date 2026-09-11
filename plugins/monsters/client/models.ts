import {
  DEFAULT_YETI_VARIANT,
  YETI_VARIANTS,
  type MonsterKind,
  type YetiVariant,
} from '../protocol.ts';
import { createCthulhuFactory } from './cthulhu.ts';
import { createWorkshop } from './geometry.ts';
import { createKrakenFactory } from './kraken.ts';
import { buildYetiVariant } from './yeti.ts';

export { MONSTER_MODEL_DETAIL } from './geometry.ts';
export type { MonsterModel } from './geometry.ts';

import type { MonsterModel } from './geometry.ts';

export interface MonsterModels {
  create(kind: MonsterKind, variant?: YetiVariant): MonsterModel;
  dispose(): void;
}

type TemplateKey = `yeti:${YetiVariant}` | Exclude<MonsterKind, 'yeti'>;

const YETI_KEY_PREFIX = 'yeti:';
const yetiTemplate = (variant: YetiVariant): TemplateKey => `${YETI_KEY_PREFIX}${variant}`;
const yetiVariantOf = (key: TemplateKey): YetiVariant => key.slice(YETI_KEY_PREFIX.length) as YetiVariant;

// Warm-up order: the likeliest first appearance first.
const TEMPLATE_KEYS: readonly TemplateKey[] = [
  yetiTemplate(DEFAULT_YETI_VARIANT),
  ...YETI_VARIANTS.filter((variant) => variant !== DEFAULT_YETI_VARIANT).map(yetiTemplate),
  'cthulhu',
  'kraken',
];

/** A tab that never reports idle still warms every template within this many ms per step. */
const IDLE_WARM_UP_TIMEOUT_MS = 4000;

// A template (organic surfaces, merged vertices, baked rig) costs 20-200 ms of main thread and
// there are twelve of them for at most one living monster, so boot builds none: each is built on
// first use, and the rest are filled in one per idle callback.
export function createMonsterModels(): MonsterModels {
  const workshop = createWorkshop();
  const built = new Map<TemplateKey, () => MonsterModel>();

  const templateOf = (key: TemplateKey): (() => MonsterModel) => {
    let make = built.get(key);
    if (make === undefined) {
      make =
        key === 'cthulhu'
          ? createCthulhuFactory(workshop)
          : key === 'kraken'
            ? createKrakenFactory(workshop)
            : buildYetiVariant(workshop, yetiVariantOf(key));
      built.set(key, make);
    }
    return make;
  };

  const cancelWarmUp = warmWhenIdle(TEMPLATE_KEYS, (key) => {
    templateOf(key);
  });

  return {
    create(kind, variant) {
      return templateOf(kind === 'yeti' ? yetiTemplate(variant ?? DEFAULT_YETI_VARIANT) : kind)();
    },
    dispose() {
      cancelWarmUp();
      workshop.dispose();
    },
  };
}

function warmWhenIdle<T>(items: readonly T[], warm: (item: T) => void): () => void {
  const queue = [...items];
  let idleHandle: number | null = null;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;
  const step = (): void => {
    idleHandle = null;
    timerHandle = null;
    const item = queue.shift();
    if (item === undefined) return;
    warm(item);
    schedule();
  };
  const schedule = (): void => {
    if (typeof requestIdleCallback === 'function') {
      idleHandle = requestIdleCallback(step, { timeout: IDLE_WARM_UP_TIMEOUT_MS });
    } else {
      timerHandle = setTimeout(step, IDLE_WARM_UP_TIMEOUT_MS);
    }
  };
  schedule();
  return () => {
    queue.length = 0;
    if (idleHandle !== null) cancelIdleCallback(idleHandle);
    if (timerHandle !== null) clearTimeout(timerHandle);
    idleHandle = null;
    timerHandle = null;
  };
}
