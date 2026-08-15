// THE MODEL REGISTRY: one constructor per monster kind, over one shared pool.
//
// This file used to BE the Cthulhu. It is now the table that answers "the server
// says `kind`; what do I add to the scene?", and each creature lives in its own
// file beside it:
//
//   ./geometry.ts        the workshop — the toolkit and the resource pool;
//   ./anatomy.ts         Cthulhu's numbers          ./cthulhu.ts  his builder;
//   ./kraken-anatomy.ts  the kraken's numbers       ./kraken.ts   its builder.
//
// That split is the point: adding a kind is adding two files and one row here,
// and neither animal can quietly borrow a constant from the other. The alternative
// — a second builder inlined into this file — was a 1 400-line module in which
// the two creatures and the tools they share were interleaved.
//
// ONE WORKSHOP FOR ALL KINDS, built at attach and disposed exactly once. Every
// kind's geometry and materials are created up front, not on first sight of that
// kind: MAX_LIVING_MONSTERS is 1 and the whole set is a few megabytes of vertex
// data, so the alternative would trade a fixed, invisible cost at load for a
// visible hitch at the exact moment a monster surfaces.

import type { MonsterKind } from '../protocol.ts';
import { createCthulhuFactory } from './cthulhu.ts';
import { createWorkshop } from './geometry.ts';
import { createKrakenFactory } from './kraken.ts';

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
    kraken: createKrakenFactory(workshop),
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
