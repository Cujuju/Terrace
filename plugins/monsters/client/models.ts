// THE MODEL REGISTRY: one constructor per monster kind, over one shared pool.
//
// This file used to BE the Cthulhu. It is now the table that answers "the server
// says `kind`; what do I add to the scene?", and each creature lives in its own
// file beside it:
//
//   ./geometry.ts        the workshop — the toolkit and the resource pool;
//   ./anatomy.ts         Cthulhu's numbers          ./cthulhu.ts  his builder;
//   ./kraken-anatomy.ts  the kraken's numbers       ./kraken.ts   its builder;
//   ./yeti-anatomy.ts    the yeti's numbers         ./yeti.ts     his builder.
//
// That split is the point: adding a kind is adding two files and one row here,
// and no animal can quietly borrow a constant from another. The alternative
// — a second builder inlined into this file — was a 1 400-line module in which
// the creatures and the tools they share were interleaved.
//
// ONE WORKSHOP FOR ALL KINDS, built at attach and disposed exactly once. Every
// kind's geometry and materials are created up front, not on first sight of that
// kind: MAX_LIVING_MONSTERS is a small constant and the whole set is a few
// megabytes of vertex data, so the alternative would trade a fixed, invisible
// cost at load for a visible hitch at the exact moment a monster arrives.

import { DEFAULT_YETI_VARIANT, type MonsterKind, type YetiVariant } from '../protocol.ts';
import { createCthulhuFactory } from './cthulhu.ts';
import { createWorkshop } from './geometry.ts';
import { createKrakenFactory } from './kraken.ts';
import { createYetiFactory } from './yeti.ts';

// Re-exported so the rest of the client half keeps importing its model contract
// from `./models.ts` — the workshop is an implementation detail of this folder.
export { MONSTER_MODEL_DETAIL } from './geometry.ts';
export type { MonsterModel } from './geometry.ts';

import type { MonsterModel } from './geometry.ts';

export interface MonsterModels {
  /**
   * The model for one monster. `variant` is the yeti's body (../protocol.ts);
   * it is IGNORED by every other kind, which has exactly one.
   *
   * OPTIONAL, and what fills the gap is DEFAULT_YETI_VARIANT — the same
   * constant the wire parse and the snapshot read-back fall back to, so a
   * caller with no variant to offer (the preview harnesses, a payload from a
   * server that predates variants) gets the same animal all three ways.
   */
  create(kind: MonsterKind, variant?: YetiVariant): MonsterModel;
  /** Frees every shared geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** Builds the shared geometry/material pool and the per-kind constructors. */
export function createMonsterModels(): MonsterModels {
  const workshop = createWorkshop();

  /**
   * The single-bodied kinds. Typed over MonsterKind MINUS the yeti rather than
   * over all of it, so the yeti cannot be given a variant-blind constructor
   * here by accident — the exclusion is what makes the compiler ask for the
   * table below.
   */
  const constructors: Readonly<Record<Exclude<MonsterKind, 'yeti'>, () => MonsterModel>> = {
    cthulhu: createCthulhuFactory(workshop),
    kraken: createKrakenFactory(workshop),
  };

  /** One constructor per yeti variant — four rows, four bodies (Phase B). */
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
