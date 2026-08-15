// THE MODEL REGISTRY: one constructor per monster kind, over one shared pool.
//
// This file used to BE the Cthulhu. It is now the table that answers "the server
// says `kind`; what do I add to the scene?", and each creature lives in its own
// file beside it:
//
//   ./geometry.ts   the workshop — the toolkit and the resource pool;
//   ./anatomy.ts    Cthulhu's numbers        ./cthulhu.ts  his builder.
//
// That split is the point: adding a kind is adding two files and one row here,
// and no two animals can quietly borrow a constant from each other. The
// alternative — every builder inlined into this file — is a module in which the
// creatures and the tools they share are interleaved, and it grows by a
// thousand lines per kind.
//
// ONE WORKSHOP FOR ALL KINDS, built at attach and disposed exactly once. Every
// kind's geometry and materials are created up front, not on first sight of that
// kind: MAX_LIVING_MONSTERS is 1 and the whole set is a few megabytes of vertex
// data, so the alternative would trade a fixed, invisible cost at load for a
// visible hitch at the exact moment a monster surfaces.

import type { MonsterKind } from '../protocol.ts';
import { createCthulhuFactory } from './cthulhu.ts';
import { createWorkshop } from './geometry.ts';

// Re-exported so the rest of the client half keeps importing its model contract
// from `./models.ts` — the workshop is an implementation detail of this folder.
export { MONSTER_MODEL_DETAIL } from './geometry.ts';
export type { MonsterModel } from './geometry.ts';

import type { MonsterModel } from './geometry.ts';

export interface MonsterModels {
  create(kind: MonsterKind): MonsterModel;
  /** Frees every shared geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** Builds the shared geometry/material pool and the per-kind constructors. */
export function createMonsterModels(): MonsterModels {
  const workshop = createWorkshop();

  const constructors: Readonly<Record<MonsterKind, () => MonsterModel>> = {
    cthulhu: createCthulhuFactory(workshop),
  };

  return {
    create(kind) {
      return constructors[kind]();
    },
    dispose() {
      workshop.dispose();
    },
  };
}
