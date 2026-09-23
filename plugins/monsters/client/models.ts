import {
  DEFAULT_YETI_VARIANT,
  YETI_VARIANTS,
  type MonsterKind,
  type YetiVariant,
} from '../protocol.ts';
import { createCthulhuFactory } from './cthulhu.ts';
import {
  createWorkshop,
  surfaceArraysOf,
  surfaceTransfers,
  type ModelWorkshop,
  type SurfaceArrays,
} from './geometry.ts';
import { createKrakenFactory } from './kraken.ts';
import { buildYetiVariant } from './yeti.ts';

export { MONSTER_MODEL_DETAIL } from './geometry.ts';
export type { MonsterModel } from './geometry.ts';

import type { MonsterModel } from './geometry.ts';

export interface MonsterModels {
  create(kind: MonsterKind, variant?: YetiVariant): MonsterModel;
  dispose(): void;
}

export type TemplateKey = `yeti:${YetiVariant}` | Exclude<MonsterKind, 'yeti'>;

const YETI_KEY_PREFIX = 'yeti:';
const yetiTemplate = (variant: YetiVariant): TemplateKey => `${YETI_KEY_PREFIX}${variant}`;
const yetiVariantOf = (key: TemplateKey): YetiVariant => key.slice(YETI_KEY_PREFIX.length) as YetiVariant;

/** Reports each finished warm-up template build, so the owner can hold a warm specimen. */
export type TemplateWarmed = (kind: MonsterKind, variant: YetiVariant | undefined) => void;

interface TemplateSpec {
  readonly kind: MonsterKind;
  readonly variant: YetiVariant | undefined;
}

const templateSpec = (key: TemplateKey): TemplateSpec =>
  key === 'cthulhu' || key === 'kraken'
    ? { kind: key, variant: undefined }
    : { kind: 'yeti', variant: yetiVariantOf(key) };

// Warm-up order: the likeliest first appearance first.
const TEMPLATE_KEYS: readonly TemplateKey[] = [
  yetiTemplate(DEFAULT_YETI_VARIANT),
  ...YETI_VARIANTS.filter((variant) => variant !== DEFAULT_YETI_VARIANT).map(yetiTemplate),
  'cthulhu',
  'kraken',
];

export function buildTemplate(workshop: ModelWorkshop, key: TemplateKey): () => MonsterModel {
  if (key === 'cthulhu') return createCthulhuFactory(workshop);
  if (key === 'kraken') return createKrakenFactory(workshop);
  return buildYetiVariant(workshop, yetiVariantOf(key));
}

/** One template's organic surfaces, built by the template worker. */
export interface TemplateSurfaces {
  readonly key: TemplateKey;
  readonly surfaces: ReadonlyArray<readonly [string, SurfaceArrays]>;
}

export function templateSurfaceTransfers(answer: TemplateSurfaces): ArrayBuffer[] {
  return answer.surfaces.flatMap(([, surface]) => surfaceTransfers(surface));
}

// A template costs 20-200 ms of main thread for one living monster, so boot builds none:
// first use builds one; the template worker builds the rest's surfaces.
export function createMonsterModels(onTemplateWarmed?: TemplateWarmed): MonsterModels {
  const bank = new Map<string, SurfaceArrays>();
  const workshop = createWorkshop({ bank });
  const built = new Map<TemplateKey, () => MonsterModel>();

  const templateOf = (key: TemplateKey): (() => MonsterModel) => {
    let make = built.get(key);
    if (make === undefined) {
      make = buildTemplate(workshop, key);
      built.set(key, make);
    }
    return make;
  };

  const cancelWarmUp = warmInWorker(TEMPLATE_KEYS, bank, (key) => {
    // A template a spawn already built is compiled: a specimen and its re-warm buy nothing.
    const spawnBuilt = built.has(key);
    templateOf(key);
    if (spawnBuilt || onTemplateWarmed === undefined) return;
    const spec = templateSpec(key);
    onTemplateWarmed(spec.kind, spec.variant);
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

// Without a worker (tests, old engines) nothing warms ahead: a template builds on first use.
function warmInWorker(
  keys: readonly TemplateKey[],
  bank: Map<string, SurfaceArrays>,
  warm: (key: TemplateKey) => void,
): () => void {
  if (typeof Worker === 'undefined') return () => undefined;
  const worker = new Worker(new URL('./templateWorker.ts', import.meta.url), { type: 'module' });
  let remaining = keys.length;
  worker.onmessage = (event: MessageEvent<TemplateSurfaces>): void => {
    const { key, surfaces } = event.data;
    for (const [surfaceKey, surface] of surfaces) bank.set(surfaceKey, surface);
    // finally: a throw in one template must not strand the rest, nor keep its arrays.
    try {
      warm(key);
    } finally {
      for (const [surfaceKey] of surfaces) bank.delete(surfaceKey);
      remaining--;
      if (remaining === 0) worker.terminate();
    }
  };
  worker.onerror = (event: ErrorEvent): void => {
    console.error('[terrace] monsters template worker failed; templates build on first use', event.message);
    worker.terminate();
  };
  for (const key of keys) worker.postMessage(key);
  return () => worker.terminate();
}
