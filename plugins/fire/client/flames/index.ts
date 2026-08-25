// The flame looks: what ships, and what is still worth being able to draw.
//
// FOUR CANDIDATES WERE AUTHORED (2026-08-24) and reviewed from renders. The
// owner chose a COMPOSITE of two of them — ./plumeToRibbons.ts, the shader
// plume crossfading into the licking ribbons as a fire takes hold — so the two
// that lost, the faceted tongues and the ember sprites, are gone. They are in
// git if the decision is ever revisited; keeping dead looks compiled into the
// client to preserve an option nobody has taken is how a renderer accumulates
// four ways to draw the same thing.

import { buildRibbonsToPlumeFlames } from './ribbonsToPlume.ts';
import type { FlameRendererBuilder } from './types.ts';

/**
 * The shipped look. The fire plugin's client half builds exactly this
 * (../index.ts), and the preview harness (client/preview-fire.html) draws
 * exactly this — so a picture of the flame is always a picture of the game's
 * flame, which is the property that made the last round of renders worth
 * trusting.
 */
export const SHIPPED_FLAMES: FlameRendererBuilder = buildRibbonsToPlumeFlames;
