// THE SHAPE OF A SKY — the narrow, declarative contract a client plugin drives
// core's lighting rig through (design's "nothing gamey in core": core knows
// this shape exists and nothing about what day/night, weather-tinted skies, or
// any other future sky effect actually IS).
//
// SkyRigState is nine plain numbers — no Object3D, no Scene, no Color
// instance. A plugin computes them however it likes (plugins/daynight/client/
// sky.ts is the first, and only, caller today) and hands them to
// ClientPluginCtx.setSkyRig; applySkyRig below is the ONE place that turns
// those numbers into mutations on the three real light objects, which is what
// keeps "a plugin can drive the sky" from turning into "a plugin gets the
// scene". The state's tenth number, backgroundColor, is intentionally inert
// since issue #326 — see the note where it would have been applied, below.
//
// MUTATES IN PLACE, EVERY CALL. This runs once a frame for as long as the
// claimant plugin is attached (the day/night plugin calls it from its own
// onFrame), so allocating a Color or a Vector3 here would be a per-frame
// allocation on the hottest path this module has. Every light already exists
// (render/scene.ts builds them once at boot); this only ever writes into
// them.

import { Color } from 'three';
// SkyRigState is DEFINED in plugins/types.ts, not here, even though this file
// is its natural home — see that interface's own doc comment for why: this
// module also needs Viewport, and Viewport's home (./scene.ts) imports
// config.ts's import.meta.env, which a plugin's standalone node test must
// never be forced to resolve just to name the shape it hands to setSkyRig.
import type { SkyRigState } from '../plugins/types.ts';
import { SUN_DISTANCE_WORLD_UNITS, type Viewport } from './scene.ts';

export type { SkyRigState };

/**
 * Writes `state` onto `viewport`'s real lights. The only function in this
 * codebase that may mutate Viewport.lighting or scene.background — see the
 * doc comment on Viewport.lighting and on
 * ClientPluginCtx.setSkyRig for the single-claimant rule that makes that
 * true in practice, not just in a comment.
 */
export function applySkyRig(viewport: Viewport, state: SkyRigState): void {
  const { sun, hemisphere, ambient } = viewport.lighting;

  sun.position
    .set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z)
    .normalize()
    .multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
  sun.color.setHex(state.sunColor);
  sun.intensity = state.sunIntensity;

  hemisphere.color.setHex(state.hemisphereSkyColor);
  hemisphere.groundColor.setHex(state.hemisphereGroundColor);
  hemisphere.intensity = state.hemisphereIntensity;

  ambient.color.setHex(state.ambientColor);
  ambient.intensity = state.ambientIntensity;

  // scene.background AND WHY THIS NO LONGER WRITES ANYTHING (issue #326).
  //
  // Core does not set a background any more. What is drawn outside the map is
  // render/celestialVoid.ts's fullscreen pass, and the owner's rule for it is
  // that time of day must not touch it at all: the map goes from day to night
  // while the void keeps the same look. So `scene.background` stays null
  // (render/scene.ts), the guard below never matches, and every
  // `state.backgroundColor` a plugin computes is deliberately ignored.
  //
  // The field is NOT removed from SkyRigState, and this line is NOT deleted.
  // Both remain because the guard is what makes the rule structural instead of
  // a convention: plugins/daynight and plugins/cyclone keep publishing a
  // background colour, core keeps declining to apply it, and neither side had
  // to learn about the other. If a future look ever wants a tintable flat
  // background again, setting one here is all it takes.
  const background = viewport.scene.background;
  if (background instanceof Color) background.setHex(state.backgroundColor);

  // The reflection follows the lamps — see ./skyEnvironment.ts. A string
  // compare when nothing changed; a throttled repaint when it did.
  viewport.skyEnvironment.retint(state);
}
