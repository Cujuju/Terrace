// THE SKY AS SOMETHING TO REFLECT — an image-based-lighting environment map
// painted from the same nine numbers that drive the light rig (SkyRigState).
//
// WHY THIS EXISTS (issue #314). The three analytic lamps in render/scene.ts
// light a diffuse surface well, but a metal gets its colour almost entirely
// from what it REFLECTS, and with no environment there is nothing to reflect:
// an authored gunmetal hull, an aluminium one and an oxidised-iron one all
// collapse to the same dull grey. This module gives PBR materials a sky to
// mirror — a sky gradient over a ground gradient with a soft glow where the
// sun is — so authored metalness and roughness mean what the modeller meant.
//
// SCOPED, NOT GLOBAL. This texture is NOT set as scene.environment. Terrain,
// water and every procedural surface were tuned against the lamps alone
// (2026-08-14 daylight retune) and pay for every shader term under the 140 fps
// budget; only assets that ask for it (ClientPluginCtx.loadRigAsset with
// `'sky-environment'`) sample it, via their materials' own envMap.
//
// RETINTED WITH THE SKY. applySkyRig (./skyRig.ts) hands every sky state here
// as well as to the lamps, so at night a chrome hull reflects a night sky —
// otherwise it would carry a noon reflection through the whole cycle. Repaints
// are throttled (SKY_ENVIRONMENT_REFRESH_MS) and skipped entirely while the
// state's lighting numbers have not changed, so an unmodded server pays for
// exactly one paint, at boot.

import {
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PMREMGenerator,
  RGBAFormat,
  Vector3,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import type { SkyRigState } from '../plugins/types.ts';

/**
 * Width of the equirectangular source image, in texels. PMREMGenerator derives
 * its cube-face size from this (width / 4 — verified in three 0.185's
 * `_fromTexture`), so 256 gives a 64² face: enough to keep the sun glow's
 * shape and the horizon line, and 32 768 texels is under a millisecond to
 * paint in JS. Anything finer buys nothing for a gradient.
 */
export const SKY_ENVIRONMENT_WIDTH = 256;
const SKY_ENVIRONMENT_HEIGHT = SKY_ENVIRONMENT_WIDTH / 2;

/**
 * Minimum time between two repaints while the sky is changing. The day/night
 * plugin pushes a new state EVERY FRAME; a repaint is a CPU paint plus a
 * PMREM convolution on the GPU (a few draws), and a reflection that updates
 * once a second is indistinguishable from one that updates at 60 Hz when the
 * whole cycle takes minutes. At a 7 ms frame budget (140 fps) this amortises
 * to well under a percent.
 */
export const SKY_ENVIRONMENT_REFRESH_MS = 1000;

/**
 * Exponent of the cosine lobe that paints the sun's glow. 64 puts the glow's
 * half-brightness at about 8° from the sun's direction: a visible bright patch
 * in a curved metal reflection rather than a point (which a 64² face could
 * not resolve) or a wash across the whole sky.
 *
 * NOT THE SUN'S TRUE SPECULAR HIGHLIGHT — the DirectionalLight already gives
 * that. This lobe is what makes a metal read as a metal: a reflected bright
 * region that moves as the hull turns. The lobe's total irradiance is about a
 * tenth of the lamp's (solid angle ≈ 2π / (sharpness + 1)), which is the
 * degree of double-counting accepted for it.
 */
const SUN_GLOW_SHARPNESS = 64;

/**
 * Half-height, in the direction's y, of the blend between the ground and sky
 * radiances at the horizon. A hard step would alias into a jagged horizon
 * line in the PMREM's coarse mip levels; 0.1 (≈ 6°) is the softest band that
 * still reads as a horizon in a reflection.
 */
const HORIZON_BLEND_HALF_HEIGHT = 0.1;

/** RGBA floats per texel. */
const TEXEL_COMPONENTS = 4;

export interface SkyEnvironment {
  /**
   * The prefiltered environment a material's `envMap` points at. ONE object
   * for the life of the viewport — repaints render into the same target — so
   * a material handed this texture at load time never needs re-pointing.
   */
  readonly texture: Texture;
  /**
   * Asks for the environment to match `state`. Cheap to call every frame: an
   * unchanged state is a string compare and nothing else, and a changed one
   * is recorded and painted by the next `flush` that falls outside the refresh
   * window. Called by applySkyRig; nothing else should need it.
   */
  retint(state: SkyRigState): void;
  /**
   * Paints a pending retint if the refresh window has elapsed. Called by the
   * render loop BEFORE the frame's render, so the PMREM's own draw calls
   * (which reset renderer.info like any render) never land in the frame's
   * draw count.
   */
  flush(nowMs: number): void;
  dispose(): void;
}

/**
 * Builds the environment and paints it to `initial` at once, so the texture is
 * complete before any asset can load.
 */
export function createSkyEnvironment(
  renderer: WebGLRenderer,
  initial: SkyRigState,
  nowMs: number,
): SkyEnvironment {
  const texels = new Float32Array(
    SKY_ENVIRONMENT_WIDTH * SKY_ENVIRONMENT_HEIGHT * TEXEL_COMPONENTS,
  );
  const source = new DataTexture(
    texels,
    SKY_ENVIRONMENT_WIDTH,
    SKY_ENVIRONMENT_HEIGHT,
    RGBAFormat,
    FloatType,
  );
  source.mapping = EquirectangularReflectionMapping;
  // Radiance values are painted in LINEAR light (Color.setHex already decodes
  // the sRGB hex constants); the texture must say so or the PMREM would decode
  // them a second time.
  source.colorSpace = LinearSRGBColorSpace;
  source.minFilter = LinearFilter;
  source.magFilter = LinearFilter;

  const pmrem = new PMREMGenerator(renderer);
  // Compile the equirect-to-cube shader once, here, rather than inside the
  // first frame that happens to repaint.
  pmrem.compileEquirectangularShader();

  // Scratch objects, allocated once: paint() runs on the render thread.
  const skyColor = new Color();
  const groundColor = new Color();
  const ambientColor = new Color();
  const sunColor = new Color();
  const ambientRadiance = new Color();
  const skyRadiance = new Color();
  const groundRadiance = new Color();
  const sunDirection = new Vector3();
  const direction = new Vector3();

  const paint = (state: SkyRigState): void => {
    skyColor.setHex(state.hemisphereSkyColor);
    groundColor.setHex(state.hemisphereGroundColor);
    ambientColor.setHex(state.ambientColor);
    sunColor.setHex(state.sunColor);
    sunDirection
      .set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z)
      .normalize();

    // RADIANCE, MATCHED TO THE LAMPS. A diffuse surface lit by the environment
    // receives PI × (average radiance) as irradiance (three's getIBLIrradiance
    // in envmap_physical_pars_fragment.glsl.js), while a hemisphere or ambient
    // lamp delivers intensity × colour as irradiance directly
    // (getHemisphereLightIrradiance, lights_pars_begin.glsl.js — both verified
    // in three 0.185). Dividing the lamp terms by PI therefore makes "the sky
    // above" in a reflection exactly as bright as the sky the lamps model, so
    // the reflection sits in the same exposure as everything around it.
    ambientRadiance.copy(ambientColor).multiplyScalar(state.ambientIntensity / Math.PI);
    skyRadiance
      .copy(skyColor)
      .multiplyScalar(state.hemisphereIntensity / Math.PI)
      .add(ambientRadiance);
    groundRadiance
      .copy(groundColor)
      .multiplyScalar(state.hemisphereIntensity / Math.PI)
      .add(ambientRadiance);

    let i = 0;
    for (let row = 0; row < SKY_ENVIRONMENT_HEIGHT; row++) {
      // three's equirect convention (equirectUv in common.glsl.js): v runs
      // from -y at the bottom row to +y at the top, u is atan2(z, x) around
      // the horizon. A DataTexture's first row is the bottom (flipY false).
      const v = (row + 0.5) / SKY_ENVIRONMENT_HEIGHT;
      const y = Math.sin((v - 0.5) * Math.PI);
      const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
      // smoothstep of y across the horizon band: 0 = ground, 1 = sky.
      const t = Math.min(
        1,
        Math.max(0, (y + HORIZON_BLEND_HALF_HEIGHT) / (2 * HORIZON_BLEND_HALF_HEIGHT)),
      );
      const skyWeight = t * t * (3 - 2 * t);
      const baseR = groundRadiance.r + (skyRadiance.r - groundRadiance.r) * skyWeight;
      const baseG = groundRadiance.g + (skyRadiance.g - groundRadiance.g) * skyWeight;
      const baseB = groundRadiance.b + (skyRadiance.b - groundRadiance.b) * skyWeight;
      for (let column = 0; column < SKY_ENVIRONMENT_WIDTH; column++) {
        const u = (column + 0.5) / SKY_ENVIRONMENT_WIDTH;
        const azimuth = (u - 0.5) * 2 * Math.PI;
        direction.set(horizontal * Math.cos(azimuth), y, horizontal * Math.sin(azimuth));
        const towardSun = Math.max(0, direction.dot(sunDirection));
        const glow = Math.pow(towardSun, SUN_GLOW_SHARPNESS) * state.sunIntensity;
        texels[i++] = baseR + sunColor.r * glow;
        texels[i++] = baseG + sunColor.g * glow;
        texels[i++] = baseB + sunColor.b * glow;
        texels[i++] = 1;
      }
    }
    source.needsUpdate = true;
  };

  /**
   * The lighting numbers of the last state painted, as one string — the
   * background colour is left out because a reflection never shows it. A
   * string compare per frame is the whole cost of an unchanged sky.
   */
  const fingerprintOf = (state: SkyRigState): string =>
    [
      state.sunDirection.x,
      state.sunDirection.y,
      state.sunDirection.z,
      state.sunColor,
      state.sunIntensity,
      state.hemisphereSkyColor,
      state.hemisphereGroundColor,
      state.hemisphereIntensity,
      state.ambientColor,
      state.ambientIntensity,
    ].join(',');

  paint(initial);
  let target: WebGLRenderTarget = pmrem.fromEquirectangular(source);
  let painted = fingerprintOf(initial);
  let lastPaintMs = nowMs;
  let pending: SkyRigState | null = null;
  let disposed = false;

  return {
    texture: target.texture,
    retint(state: SkyRigState): void {
      if (fingerprintOf(state) === painted) {
        pending = null;
        return;
      }
      pending = state;
    },
    flush(now: number): void {
      if (pending === null || disposed) return;
      if (now - lastPaintMs < SKY_ENVIRONMENT_REFRESH_MS) return;
      paint(pending);
      // INTO THE SAME TARGET, so `texture` stays the object every loaded asset
      // already holds (PMREMGenerator.fromEquirectangular's second argument,
      // three 0.185).
      target = pmrem.fromEquirectangular(source, target);
      painted = fingerprintOf(pending);
      pending = null;
      lastPaintMs = now;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      target.dispose();
      source.dispose();
      pmrem.dispose();
    },
  };
}
