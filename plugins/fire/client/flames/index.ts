// The candidate flame looks, in the order the owner reviews them.
//
// This file exists so the preview harness (client/src/previewFire.ts) can select
// a candidate by INDEX from a query string without importing four modules and
// hard-coding an order that then disagrees with the screenshots' file names.
// When a look is chosen, the losers are deleted and this list shrinks to one.

import { buildConeStackFlames } from './coneStack.ts';
import { buildBillboardFlames } from './billboards.ts';
import { buildShaderPlumeFlames } from './shaderPlume.ts';
import { buildRibbonFlames } from './ribbons.ts';
import type { FlameRendererBuilder } from './types.ts';

/** A → D, matching the brief's lettering and the screenshot file names. */
export const FLAME_CANDIDATES: readonly FlameRendererBuilder[] = [
  buildConeStackFlames,
  buildBillboardFlames,
  buildShaderPlumeFlames,
  buildRibbonFlames,
];
