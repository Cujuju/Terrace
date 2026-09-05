// THE SHAPE OF A SKY — the narrow, declarative contract a client plugin drives
// core's lighting rig through (design's "nothing gamey in core": core knows
// this shape exists and nothing about what day/night, weather-tinted skies, or
// any other future sky effect actually IS).
//
// SkyRigState is nine plain numbers — no Object3D, no Scene, no Color
// instance. A plugin computes them however it likes (plugins/daynight/client/
// sky.ts is the first, and only, caller today) and hands them to
// ClientPluginCtx.setSkyRig; applySkyRig below is the ONE place that turns
// those numbers into mutations on the three real light objects and the
// scene's background, which is what keeps "a plugin can drive the sky" from
// turning into "a plugin gets the scene".
//
// MUTATES IN PLACE, EVERY CALL. This runs once a frame for as long as the
// claimant plugin is attached (the day/night plugin calls it from its own
// onFrame), so allocating a Color or a Vector3 here would be a per-frame
// allocation on the hottest path this module has. Every light and the
// background Color already exist (render/scene.ts builds them once at boot);
// this only ever writes into them.

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
 * Writes `state` onto `viewport`'s real lights and background. The only
 * function in this codebase that may mutate Viewport.lighting or
 * scene.background — see the doc comment on Viewport.lighting and on
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

  // scene.background is typed Color | Texture | CubeTexture | null because
  // three's Scene allows all three; core (render/scene.ts) only ever sets it
  // to `new Color(SKY_COLOR)` at boot, so the instanceof guard is a defensive
  // no-op today and a correct no-op forever — a background that somehow
  // became a Texture is simply left alone rather than fought over.
  const background = viewport.scene.background;
  if (background instanceof Color) background.setHex(state.backgroundColor);

  // The reflection follows the lamps — see ./skyEnvironment.ts. A string
  // compare when nothing changed; a throttled repaint when it did.
  viewport.skyEnvironment.retint(state);
}
