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
  ACESFilmicToneMapping,
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
 * CONTRAST IS WHAT MAKES A METAL READ AS A METAL — not the average level.
 * The lamps were tuned flat on purpose (2026-08-14: "too dark", three
 * rounds), and a first version of this map that simply re-encoded them gave
 * every hull a near-uniform grey-blue to mirror, which looks like dull paint
 * (owner, 2026-09-04: "the lighting for the saucers still looks exactly the
 * same"). So the map keeps the LAMPS' colours but shapes them the way a real
 * sky is shaped: a dark ground under a bright sky, a horizon brighter than the
 * zenith, and a sun you can see in the reflection. The three constants below
 * are that shape.
 */

/**
 * THE SKY IN A MIRROR IS THE SKY YOU SEE. scene.background is a plain Color,
 * which three clears the framebuffer to WITHOUT tone mapping
 * (WebGLBackground.setClear, verified in 0.185), while every reflection goes
 * through ACES at the renderer's exposure. So the sky radiance is solved for,
 * per paint: the scalar that makes ACES(exposure × radiance) land on the
 * background colour's own value — a perfect mirror then shows exactly the sky
 * drawn behind it, and a first version that anchored the radiance to the
 * hemisphere lamp instead (radiance = intensity × colour / PI) mirrored a sky
 * about half as bright as the one on screen, which read as grey paint.
 * Bisection bounds and tolerance below; the search is a few dozen cheap
 * evaluations, once per repaint.
 *
 * THE MATCH IS AT THE HORIZON, NOT THE ZENITH. The drawn sky is one flat
 * colour, but the map's sky is brightest at the horizon (HORIZON_BRIGHTENING)
 * and darkest straight up, so only one band can equal the backdrop. It is the
 * horizon: that is where a hull's silhouette meets the drawn sky, so the
 * mirror never shows a sky brighter than the one beside it, and the zenith —
 * what every top-down view of a flat deck reflects, which in this game is
 * most views — sits 1/HORIZON_BRIGHTENING below it, as a real zenith does. A
 * first version anchored the zenith instead, and from above every hull, dark
 * gunmetal and green-black iron included, mirrored a sky 1.6× brighter than
 * the backdrop and read as pale (owner, 2026-09-04: "1 and 3 don't look
 * correct").
 */
const RADIANCE_SEARCH_MAX = 64;
const RADIANCE_SEARCH_STEPS = 40;

/**
 * Fraction of the hemisphere's ground colour the ground below the horizon
 * radiates. The lamp's ground colour is an artistic FILL (it stops downward
 * faces going black); real ground only re-radiates what its albedo keeps of
 * the light falling on it, ~0.2–0.35 for earth and vegetation. 0.3 puts the
 * ground at roughly a fifth of the sky's radiance — the bright-top / dark-
 * underside split a curved metal shows.
 */
const GROUND_RADIANCE_FRACTION = 0.3;

/**
 * How much brighter the sky is at the horizon than at the zenith. Aerosol
 * scattering whitens and brightens a real sky toward the horizon by about
 * this much on a clear day; in a reflection it is the bright band that runs
 * around a hull just above its dark underside.
 */
const HORIZON_BRIGHTENING = 1.6;

/**
 * Exponent and peak of the cosine lobe that paints the sun. 256 puts the
 * lobe's half-brightness at about 4° from the sun's direction: a compact
 * bright disc a 64² PMREM face can still resolve, that a rough metal blurs
 * into a soft highlight and a smooth one keeps as a spot. The peak is the sun
 * lamp's intensity times SUN_GLOW_GAIN: high enough to survive ACES as white.
 *
 * NOT THE SUN'S TRUE SPECULAR HIGHLIGHT — the DirectionalLight already gives
 * that. The lobe's total irradiance is about 2π / (sharpness + 1) × peak ≈
 * 14 % of the lamp's, which is the double-counting accepted for a visible sun
 * in the reflection.
 */
const SUN_GLOW_SHARPNESS = 256;
const SUN_GLOW_GAIN = 6;

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
  const sunColor = new Color();
  const skyRadiance = new Color();
  const groundRadiance = new Color();
  const sunDirection = new Vector3();
  const direction = new Vector3();

  const paint = (state: SkyRigState): void => {
    skyColor.setHex(state.backgroundColor);
    groundColor.setHex(state.hemisphereGroundColor);
    sunColor.setHex(state.sunColor);
    sunDirection
      .set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z)
      .normalize();

    // RADIANCE SCALE — see RADIANCE_SEARCH_MAX. The HORIZON is the background
    // colour at the radiance that tone-maps back to itself, so the zenith is
    // that over HORIZON_BRIGHTENING (the sky gain below runs zenith 1 →
    // horizon HORIZON_BRIGHTENING); the ground keeps the rig's ground hue at
    // the zenith's scale, dimmed to what ground reflects. The hemisphere and
    // ambient lamps are deliberately NOT encoded here: the ambient is an
    // orientation-free floor, and a floor added to every direction is exactly
    // the flatness this map must not have.
    const zenithScale = radianceMatchingDisplay(skyColor, renderer) / HORIZON_BRIGHTENING;
    skyRadiance.copy(skyColor).multiplyScalar(zenithScale);
    groundRadiance.copy(groundColor).multiplyScalar(zenithScale * GROUND_RADIANCE_FRACTION);

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
      // Zenith → horizon brightening: full at the horizon (y = 0), none
      // straight up (y = 1); applied to the sky side only.
      const horizonWeight = 1 - Math.max(0, y);
      const skyGain = 1 + (HORIZON_BRIGHTENING - 1) * horizonWeight;
      const skyR = skyRadiance.r * skyGain;
      const skyG = skyRadiance.g * skyGain;
      const skyB = skyRadiance.b * skyGain;
      const baseR = groundRadiance.r + (skyR - groundRadiance.r) * skyWeight;
      const baseG = groundRadiance.g + (skyG - groundRadiance.g) * skyWeight;
      const baseB = groundRadiance.b + (skyB - groundRadiance.b) * skyWeight;
      for (let column = 0; column < SKY_ENVIRONMENT_WIDTH; column++) {
        const u = (column + 0.5) / SKY_ENVIRONMENT_WIDTH;
        const azimuth = (u - 0.5) * 2 * Math.PI;
        direction.set(horizontal * Math.cos(azimuth), y, horizontal * Math.sin(azimuth));
        const towardSun = Math.max(0, direction.dot(sunDirection));
        const glow = Math.pow(towardSun, SUN_GLOW_SHARPNESS) * state.sunIntensity * SUN_GLOW_GAIN;
        texels[i++] = baseR + sunColor.r * glow;
        texels[i++] = baseG + sunColor.g * glow;
        texels[i++] = baseB + sunColor.b * glow;
        texels[i++] = 1;
      }
    }
    source.needsUpdate = true;
  };

  /**
   * The numbers of the last state painted, as one string — only the ones
   * paint() reads (the ambient lamp and the hemisphere's sky colour are
   * deliberately not among them, see paint). A string compare per frame is
   * the whole cost of an unchanged sky.
   */
  const fingerprintOf = (state: SkyRigState): string =>
    [
      state.sunDirection.x,
      state.sunDirection.y,
      state.sunDirection.z,
      state.sunColor,
      state.sunIntensity,
      state.backgroundColor,
      state.hemisphereGroundColor,
      renderer.toneMapping,
      renderer.toneMappingExposure,
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

// ---------------------------------------------------------------------------
// ACES, on the CPU — three's ACESFilmicToneMapping (tonemapping_pars_fragment
// .glsl.js, 0.185) transcribed so the radiance search above can ask "what
// does this radiance display as?" with the renderer's own curve.
// ---------------------------------------------------------------------------

/** sRGB => XYZ => D65_2_D60 => AP1 => RRT_SAT, row-major as applied to (r,g,b). */
const ACES_INPUT = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
] as const;
/** ODT_SAT => XYZ => D60_2_D65 => sRGB, row-major. */
const ACES_OUTPUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
] as const;
/** The 1/0.6 pre-scale three's implementation applies with the exposure. */
const ACES_EXPOSURE_PRESCALE = 1 / 0.6;

const acesScratch = new Color();

function rrtAndOdtFit(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

/** three's ACES filmic curve applied to a linear colour, in place. */
function acesFilmic(color: Color, exposure: number): Color {
  const k = exposure * ACES_EXPOSURE_PRESCALE;
  const r = color.r * k;
  const g = color.g * k;
  const b = color.b * k;
  const fr = rrtAndOdtFit(ACES_INPUT[0][0] * r + ACES_INPUT[0][1] * g + ACES_INPUT[0][2] * b);
  const fg = rrtAndOdtFit(ACES_INPUT[1][0] * r + ACES_INPUT[1][1] * g + ACES_INPUT[1][2] * b);
  const fb = rrtAndOdtFit(ACES_INPUT[2][0] * r + ACES_INPUT[2][1] * g + ACES_INPUT[2][2] * b);
  color.r = Math.min(1, Math.max(0, ACES_OUTPUT[0][0] * fr + ACES_OUTPUT[0][1] * fg + ACES_OUTPUT[0][2] * fb));
  color.g = Math.min(1, Math.max(0, ACES_OUTPUT[1][0] * fr + ACES_OUTPUT[1][1] * fg + ACES_OUTPUT[1][2] * fb));
  color.b = Math.min(1, Math.max(0, ACES_OUTPUT[2][0] * fr + ACES_OUTPUT[2][1] * fg + ACES_OUTPUT[2][2] * fb));
  return color;
}

/** Rec. 709 luminance of a linear colour. */
function luminance(color: Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/**
 * The scalar s such that `displayed` drawn at radiance s × displayed, through
 * the renderer's tone mapping, has the luminance of `displayed` itself — i.e.
 * a mirror of that radiance shows the colour the background is cleared to.
 * With no tone mapping (or one this module does not model) the answer is 1.
 * ACES saturates, so a background brighter than the curve can reach is
 * matched as closely as the search bound allows.
 */
function radianceMatchingDisplay(displayed: Color, renderer: WebGLRenderer): number {
  if (renderer.toneMapping !== ACESFilmicToneMapping) return 1;
  const target = luminance(displayed);
  let low = 0;
  let high = RADIANCE_SEARCH_MAX;
  for (let i = 0; i < RADIANCE_SEARCH_STEPS; i++) {
    const mid = (low + high) / 2;
    acesScratch.copy(displayed).multiplyScalar(mid);
    if (luminance(acesFilmic(acesScratch, renderer.toneMappingExposure)) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
