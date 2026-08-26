// The monster workshop: the geometry toolkit every kind is built with, and the
// pool that owns what it builds.
//
// WHY THIS IS ITS OWN FILE. The rules below were written for Cthulhu and are
// not about Cthulhu — they are how this plugin makes a creature, and the second
// kind (./kraken.ts) needs every one of them. Leaving them inside the Cthulhu
// builder would have meant either a second copy or a 1 400-line file where the
// two animals are interleaved with the tools that make them.
//
// Rules this file keeps (the wildlife plugin's, for the same reasons):
//   * NO EXTERNAL ASSETS and no per-model lights. Everything is generated here;
//     the scene's hemisphere + sun light (render/scene.ts) does the lighting.
//     Surface interest comes from GEOMETRY (a deterministic wrinkle carved into
//     the skin), from PER-VERTEX SHADE, and — since 2026-08-24 — from ONE
//     generated texture. Emissive eyes emit rather than being lit.
//
//     THE TEXTURE RULE USED TO SAY "NO TEXTURES", and it was wrong about fur.
//     Owner, on the yeti's renders: "I think you need to add a texture for the
//     fur, not geometry." He is right, and the reason is a budget one. Fur is
//     hair-width detail; carving it needs a vertex per strand, which is tens of
//     thousands of triangles for one animal's coat and still comes out as
//     lumps, because carveWrinkles can only dent a surface it already has. A
//     texel costs nothing and there are a million of them. See furShadeTexture()
//     below — it is COMPUTED, from the same deterministic reasoning as the
//     noise field, so "no asset files, same creature on every client" survives
//     intact. What is banned is a texture that arrives over the network.
//   * NO Math.random anywhere in the geometry. Every irregularity — the
//     wrinkles, the mottle, the uneven curl of a tentacle fan — comes out of
//     one deterministic noise field with a constant seed, so every client in the
//     world builds the same creature down to the same dent.
//   * GEOMETRIES AND MATERIALS ARE SHARED and built exactly once, and the
//     workshop's `dispose()` frees them exactly once.
//
// WHERE THE NUMBERS LIVE. ./anatomy.ts and ./kraken-anatomy.ts own the
// creatures: every dimension, colour, slack and rate. This file owns only the
// RESOLUTION those shapes are tessellated at — the MONSTER_MODEL_DETAIL
// multiplier and the weld tolerance. If you want to change how a monster LOOKS,
// open its anatomy file; if you want to change how FINE it is, change the knob
// here.

import {
  BufferGeometry,
  CatmullRomCurve3,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshLambertMaterial,
  RGBAFormat,
  RepeatWrapping,
  SphereGeometry,
  Texture,
  Vector3,
  type Material,
  type MeshLambertMaterialParameters,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
// Render kit, reached the same way client/src/plugins/registry.ts reaches this
// plugin — by path. See that module's header for why it lives there.
import type { RigBlueprint } from '../../../client/src/render/rigSkin.ts';

/**
 * THE RESOLUTION KNOB. Every tessellation in a builder is a base count times
 * this.
 *
 * Deliberately not kind-specific: "render monsters at higher resolution" is one
 * number for the whole plugin rather than a hunt through per-part constants.
 *
 * 4 puts the one Cthulhu at roughly 17k triangles and the kraken at ~7k. The
 * budget is generous because MAX_LIVING_MONSTERS is 1 — these are hero models,
 * not a crowd — but the knob is what makes the trade explicit if that ever
 * stops being true.
 */
export const MONSTER_MODEL_DETAIL = 4;

/**
 * How close two vertices must be to be welded into one, in cells.
 *
 * Welding runs before the normals are computed and it is the whole reason the
 * smooth shading has no visible seam: a UV sphere carries a duplicate column of
 * vertices where it wraps and a fan of duplicates at each pole, and normals
 * averaged per-duplicate would light those two lines differently from the skin
 * either side of them. A thousandth of a cell is far below any feature here and
 * far above the float noise in a wrap-around cosine.
 */
export const WELD_TOLERANCE = 1e-3;

export const TWO_PI = Math.PI * 2;
/** Consecutive multiples land as far apart on a cycle as it is possible to be. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// ── The noise field ──────────────────────────────────────────────────────────

/**
 * The seed. A constant, and the point of the exercise: two clients looking at
 * the same monster must see the same wrinkles, so nothing here may come from
 * Math.random, from a Date, or from anything else that differs between tabs.
 */
const NOISE_SEED = 0.6180339887;
/** Octaves of the field, and how the frequency climbs and the amplitude falls. */
const NOISE_OCTAVES = 3;
const NOISE_LACUNARITY = 2.17;
const NOISE_GAIN = 0.5;
/**
 * Per-axis frequency ratios. Deliberately not 1:1:1 and not rational multiples
 * of each other — equal ratios make the field's zero surfaces line up into a
 * visible grid, which is exactly what a hand-made wrinkle must not look like.
 */
const NOISE_AXIS_RATIO_Y = 1.31;
const NOISE_AXIS_RATIO_Z = 0.83;

/**
 * Each use of the field gets its own channel, so the mottle does not simply
 * shade the dents the wrinkle carved (which would read as a printed texture
 * rather than as a surface).
 */
export const NOISE_CHANNEL_WRINKLE = 0;
export const NOISE_CHANNEL_SHADE = 1;
export const NOISE_CHANNEL_TENTACLE = 2;

/**
 * A smooth deterministic field over space, in [-1, 1].
 *
 * A trig lattice rather than a hashed value noise: three octaves of a product of
 * sines is a few lines, is continuous in every derivative (so a carve leaves no
 * facet), and is a pure function of position — which is what makes duplicate
 * vertices on a seam move identically and leaves no crack to weld shut.
 *
 * HONEST RESIDUAL: Math.sin is not required by IEEE-754 to be bit-identical
 * across engines, so two clients on different browsers could in principle differ
 * in the last bits of a vertex. Nothing depends on the value — no simulation
 * state, no collision, no protocol — so the consequence of that is nothing.
 */
export function organicNoise(x: number, y: number, z: number, channel: number): number {
  const seed = NOISE_SEED + channel * GOLDEN_ANGLE;
  let value = 0;
  let amplitude = 1;
  let weight = 0;
  let frequency = 1;
  for (let octave = 0; octave < NOISE_OCTAVES; octave++) {
    const phase = seed * (octave + 1);
    value +=
      amplitude *
      Math.sin(frequency * x + phase) *
      Math.sin(frequency * y * NOISE_AXIS_RATIO_Y + phase * 2) *
      Math.sin(frequency * z * NOISE_AXIS_RATIO_Z + phase * 3);
    weight += amplitude;
    amplitude *= NOISE_GAIN;
    frequency *= NOISE_LACUNARITY;
  }
  return value / weight;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Reduces a geometry to positions and an index.
 *
 * Two jobs. Merging demands that every input carry the same attributes, and a
 * sphere arrives with normals and UVs that a hand-built patch does not; and the
 * weld hashes every attribute, so leaving the UVs on would refuse to weld the
 * seam column that has the same position and two different UVs — which is the
 * one weld that matters. Nothing here samples a texture, so the UVs are dead
 * weight in the first place.
 */
export function positionsOnly(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  return geometry;
}

/**
 * Dents a surface INWARD along its own normals, by up to `depth` cells.
 *
 * Inward-only, never outward: an anatomy file's extents (and the lurk depths
 * derived from them) are stated as the box the model lives in, and a bump that
 * pushed a vertex out would make that box a lie. Carving can only leave the
 * creature inside it.
 *
 * Requires normals to already be present — call after computeVertexNormals.
 */
export function carveWrinkles(geometry: BufferGeometry, depth: number, frequency: number): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    // (0.5 + 0.5·n) maps the field to [0, 1]: every vertex moves in a little,
    // the deepest by `depth`. A signed carve would only dent half the surface
    // and leave the other half exactly on the ellipsoid, which reads as a ball
    // with bites out of it rather than as skin.
    const bite =
      depth * (0.5 + 0.5 * organicNoise(x * frequency, y * frequency, z * frequency, NOISE_CHANNEL_WRINKLE));
    position.setXYZ(
      index,
      x - normal.getX(index) * bite,
      y - normal.getY(index) * bite,
      z - normal.getZ(index) * bite,
    );
  }
  position.needsUpdate = true;
}

/**
 * Writes a per-vertex shade multiplier into the geometry's colour attribute.
 *
 * The material keeps its own colour from the anatomy; this multiplies it by
 * something within ±`variation` of 1, which is enough to stop a broad mass of
 * one colour reading as plastic and far too little to look like camouflage.
 * Every geometry drawn with a vertexColors material must have this attribute, so
 * it is applied by the same finishing pass that computes normals.
 */
export function applyShadeVariation(
  geometry: BufferGeometry,
  variation: number,
  frequency: number,
): void {
  const position = geometry.getAttribute('position');
  const shades = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const shade =
      1 +
      variation *
        organicNoise(
          position.getX(index) * frequency,
          position.getY(index) * frequency,
          position.getZ(index) * frequency,
          NOISE_CHANNEL_SHADE,
        );
    shades[index * 3] = shade;
    shades[index * 3 + 1] = shade;
    shades[index * 3 + 2] = shade;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(shades, 3));
}

// ── The fur ──────────────────────────────────────────────────────────────────

/**
 * The fur tile, in texels on a side.
 *
 * One tile carries FUR_STRAND_COUNT strands across it, so this is about five
 * texels per strand — enough to describe a lit body and a dark parting either
 * side of it. Doubling it buys nothing a mipmap does not immediately throw away
 * at any distance the animal is actually seen from; halving it takes the strand
 * below three texels and aliases it into moire.
 */
export const FUR_TEXTURE_SIZE = 128;

/**
 * THE STRANDS.
 *
 * WHY EVERYTHING HERE IS PERIODIC ON THE TILE. The tile repeats every
 * FUR_TEXTURE_SIZE texels, and a pattern that does not come back to the same
 * value at the far edge lays a visible grid over the animal. Every frequency
 * below is an INTEGER number of cycles per tile, so the tile is seamless as a
 * matter of arithmetic rather than of tuning — and it is still one deterministic
 * function of position, with no Math.random in it.
 *
 * WHY IT IS NOT JUST A COMB. The first attempt was: sum four cosines across the
 * tile, map to a shade. It rendered as CORDUROY, and the reason is that parallel
 * ribs of constant width and constant tone are what corduroy IS. Three things
 * separate hair from cloth, and the tile does all three:
 *
 *   1. THE STRANDS WANDER. The across-coordinate is warped by a slow wave before
 *      the strands are cut out of it (FUR_WARP_*), so no two run parallel for
 *      their whole length and the spacing between them opens and closes.
 *   2. THE PARTINGS ARE NARROW AND THE LOCKS ARE WIDE. A cosine spends half its
 *      range dark, which is a rib. Fur is mostly lit surface with a thin dark
 *      line where two locks part, so the dark is raised to a power
 *      (FUR_PARTING_SHARPNESS) that keeps it near zero except right at the
 *      parting.
 *   3. NO TWO STRANDS ARE THE SAME TONE. A slow variation over the warped
 *      coordinate (FUR_TONE_SPREAD) makes neighbouring locks differ in
 *      lightness, which is what stops the eye reading the whole field as one
 *      machined surface.
 *
 * On top of that the strands BREAK along their length (FUR_BREAK_*): a lock that
 * runs the full height of the tile at constant depth is a groove, and a real one
 * is interrupted every few strand-widths by another lock crossing over it.
 */

/** Strands across one tile. About five texels each at FUR_TEXTURE_SIZE, which
 *  is the least that can carry a lit body and a dark edge without aliasing. */
const FUR_STRAND_COUNT = 26;
/** Locks across one tile: the coarse gathering the strands fall into. Chosen
 *  well away from a divisor of FUR_STRAND_COUNT so the two never line up. */
const FUR_LOCK_COUNT = 7;

/**
 * The wander, in tile widths, and the two waves that make it.
 *
 * The amplitude is stated against the strand pitch it disturbs: 1/26 of a tile
 * is one strand, so 0.030 is about three-quarters of a strand of sideways drift
 * from the slow wave and a quarter from the fast one. Less and the field is
 * visibly combed; much more and the strands cross each other, which reads as
 * matting rather than as a coat.
 *
 * `along` is cycles down the strand, `across` cycles perpendicular to it. Both
 * are low: the warp must be much coarser than what it warps, or it stops being a
 * wander and becomes a second, finer set of strands running crosswise.
 */
const FUR_WARP_WAVES = [
  { across: 7, along: 2, amplitude: 0.012, phase: 0.7 },
  { across: 13, along: 5, amplitude: 0.005, phase: 2.9 },
] as const;

/**
 * How dark a parting between two strands goes, as a fraction taken off the
 * surface's own colour, and how narrow it is.
 *
 * The sharpness is an exponent on a value that is 1 exactly at the parting and 0
 * at the middle of a strand, so raising it squeezes the dark into the parting
 * and leaves the strand itself lit. At 1 (no sharpening) this is a cosine and
 * the result is a rib.
 */
const FUR_PARTING_DEPTH = 0.3;
const FUR_PARTING_SHARPNESS = 2.6;
/** The same pair for the coarse partings BETWEEN locks — deeper, because a lock
 *  boundary is a real gap in the pile, and broader, because it is. */
const FUR_LOCK_PARTING_DEPTH = 0.07;
const FUR_LOCK_PARTING_SHARPNESS = 3;

/**
 * How much a strand's depth varies down its own length: 0 is a groove of
 * constant depth running the height of the tile, 1 lets it close up entirely.
 *
 * This is what makes a strand END. The frequency is deliberately not a multiple
 * of anything else here, so the breaks of neighbouring strands do not line up
 * into a seam running across the coat.
 */
const FUR_BREAK_SPREAD = 0.45;
const FUR_BREAK_ALONG = 3;
const FUR_BREAK_ACROSS = 11;

/**
 * Lightness spread between neighbouring locks, as a fraction either side of 1.
 *
 * Small, because this is fur of one colour and not a piebald coat — but not
 * zero, which is the machined look the first tile had.
 */
const FUR_TONE_SPREAD = 0.05;
const FUR_TONE_COUNT = 9;

/**
 * The floor: how dark the deepest parting is allowed to get, as a fraction of
 * the surface's own colour.
 *
 * This multiplies the diffuse colour, so 0 would put pure black lines through
 * white fur. What is actually down there is the same coat in shadow, and a coat
 * in the open loses roughly a third of its light to self-shadowing at the bottom
 * of the pile.
 */
const FUR_SHADE_FLOOR = 0.6;

/** Bytes per texel of an RGBA texture. */
const FUR_TEXEL_BYTES = 4;
/** The largest value a byte channel can hold. */
const FUR_CHANNEL_MAX = 255;

/**
 * How sharply the three triplanar projections cut over at an edge.
 *
 * The weights are the object-space normal's components raised to this power and
 * renormalised. At 1 the three planes cross-fade over the whole quarter-turn and
 * every surface not facing an axis is a wash of all three, which blurs the
 * strands away exactly on the rounded masses this animal is made of. Higher
 * makes each projection dominate its own octant and the blend a narrow band; too
 * high and that band becomes a visible seam. 4 puts the cross-fade at roughly
 * the width of a lock.
 */
const FUR_BLEND_SHARPNESS = 4;

/**
 * Builds the shared fur tile: a seamless greyscale MULTIPLIER, not a colour.
 *
 * Every fur surface on the model is a different tone (see the yeti's fur,
 * underfur and mantle colours) and they all want the same hair. Storing a shade
 * rather than a colour is what lets one texture serve all three: the shader
 * multiplies it into whatever diffuse colour the surface already has, so the
 * tone stays the anatomy file's decision and the STRUCTURE stays this one's.
 *
 * Written to all three channels because the sampler is read as `.r` and a
 * greyscale one-channel format is not worth a second code path for 64 KB.
 */
export function furShadeTexture(): DataTexture {
  const data = new Uint8Array(FUR_TEXTURE_SIZE * FUR_TEXTURE_SIZE * FUR_TEXEL_BYTES);
  for (let row = 0; row < FUR_TEXTURE_SIZE; row++) {
    const along = row / FUR_TEXTURE_SIZE;
    for (let column = 0; column < FUR_TEXTURE_SIZE; column++) {
      const across = column / FUR_TEXTURE_SIZE;

      // 1. The wander. Every strand below is cut out of THIS coordinate rather
      //    than out of `across`, which is what stops them running parallel.
      let wander = across;
      for (const wave of FUR_WARP_WAVES) {
        wander +=
          wave.amplitude *
          Math.cos(TWO_PI * (wave.across * across + wave.along * along) + wave.phase);
      }

      // 2. The partings. `parted` is 1 at a parting and 0 at the middle of a
      //    strand; the power is what keeps it near 0 for most of the strand.
      const parted = 0.5 - 0.5 * Math.cos(TWO_PI * FUR_STRAND_COUNT * wander);
      const lockParted = 0.5 - 0.5 * Math.cos(TWO_PI * FUR_LOCK_COUNT * wander);

      // 3. The break down the strand's length, which is what gives it an end.
      const broken =
        1 -
        FUR_BREAK_SPREAD *
          (0.5 - 0.5 * Math.cos(TWO_PI * (FUR_BREAK_ALONG * along + FUR_BREAK_ACROSS * across)));

      // 4. The tone this lock happens to be, over the warped coordinate so it
      //    follows the strands rather than cutting across them.
      const tone = 1 + FUR_TONE_SPREAD * Math.cos(TWO_PI * FUR_TONE_COUNT * wander);

      const shade =
        tone *
        (1 -
          FUR_PARTING_DEPTH * Math.pow(parted, FUR_PARTING_SHARPNESS) * broken -
          FUR_LOCK_PARTING_DEPTH * Math.pow(lockParted, FUR_LOCK_PARTING_SHARPNESS));
      const byte = Math.round(Math.min(1, Math.max(FUR_SHADE_FLOOR, shade)) * FUR_CHANNEL_MAX);
      const texel = (row * FUR_TEXTURE_SIZE + column) * FUR_TEXEL_BYTES;
      data[texel] = byte;
      data[texel + 1] = byte;
      data[texel + 2] = byte;
      data[texel + 3] = FUR_CHANNEL_MAX;
    }
  }
  const texture = new DataTexture(data, FUR_TEXTURE_SIZE, FUR_TEXTURE_SIZE, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // NOT sRGB, and this is the whole reason the tile is a shade and not a colour:
  // an sRGB decode would be applied to a number that is already a linear
  // multiplier and darken the coat by the gamma curve. DataTexture defaults to
  // no colour space; it is stated here so nobody "fixes" it later.
  texture.needsUpdate = true;
  return texture;
}

/**
 * The name the fur injection goes by in three's program cache.
 *
 * A material's compiled program is cached by its parameters, and onBeforeCompile
 * is invisible to that cache — two materials identical in every parameter but
 * differing in their injected source would otherwise share one program and one
 * of them would render as the other. customProgramCacheKey is three's answer,
 * and client/src/render/rigSkin.ts reads the same key when it decides which
 * parts may be merged into one draw call.
 */
const FUR_PROGRAM_KEY = 'monster-fur-triplanar';

/**
 * Makes a material sample the fur tile TRIPLANAR, in the surface's own object
 * space.
 *
 * WHY TRIPLANAR AND NOT UVs. There are no UVs to use. `positionsOnly` strips
 * them from every primitive on the way in and `organicSurface` merges a dozen
 * ellipsoids and swept tubes into one surface — a sphere's own UVs pinch to
 * nothing at its poles and stop dead at its seam, and a dozen of those merged is
 * a dozen pinches and a dozen seams down the middle of the animal. Projecting
 * from the three axis planes and blending by the normal needs no UVs at all, has
 * no poles, and is continuous across a merge because it is a function of
 * POSITION, which the merge preserves exactly.
 *
 * WHY BIND-POSE POSITION. The varying is taken at `begin_vertex`, before
 * `skinning_vertex` moves the vertex. Sampling after skinning would fix the fur
 * to the WORLD and let the coat swim over the animal as he walks; sampling
 * before fixes it to the animal, which is where fur is attached.
 *
 * The strand direction is the tile's second axis, so on the two upright
 * projections (ZY and XY) the hair hangs DOWN — the direction it hangs on a real
 * animal. The third projection is the top-down one, where "down" has no meaning
 * on the surface; it runs the strands along Z, and it only ever covers the tops
 * of the shoulders and the skull.
 */
/**
 * The triplanar sampler, as GLSL, shared by the two injections below.
 *
 * Both of them ask the same question of the same kind of tile — "what is under
 * this fragment, in the surface's own object space?" — and differ only in what
 * they DO with the answer: the shade tile multiplies it into the colour, the
 * strand tile tests it against a threshold and throws the fragment away. Written
 * once here so the two can never disagree about where a strand is, which is the
 * whole reason a shell sits over the coat it belongs to rather than beside it.
 */
const TRIPLANAR_VERTEX_DECLARATIONS = `
varying vec3 vFurPosition;
varying vec3 vFurNormal;`;
const TRIPLANAR_VERTEX_ASSIGNMENTS = `
vFurPosition = transformed;
vFurNormal = objectNormal;`;
const TRIPLANAR_FRAGMENT_DECLARATIONS = `
uniform sampler2D furMap;
uniform float furFrequency;
varying vec3 vFurPosition;
varying vec3 vFurNormal;`;
/** Leaves the tile's red channel in `furSample`, blended over the three planes. */
const TRIPLANAR_FRAGMENT_SAMPLE = `
  vec3 furAxis = pow(abs(normalize(vFurNormal)), vec3(${FUR_BLEND_SHARPNESS}.0));
  furAxis /= max(furAxis.x + furAxis.y + furAxis.z, 1e-5);
  vec3 furAt = vFurPosition * furFrequency;
  float furSample =
      texture2D(furMap, vec2(furAt.z, furAt.y)).r * furAxis.x
    + texture2D(furMap, vec2(furAt.x, furAt.z)).r * furAxis.y
    + texture2D(furMap, vec2(furAt.x, furAt.y)).r * furAxis.z;`;

/** Injects the varyings both fur programs read. */
function injectTriplanarVaryings(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>${TRIPLANAR_VERTEX_DECLARATIONS}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>${TRIPLANAR_VERTEX_ASSIGNMENTS}`);
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>${TRIPLANAR_FRAGMENT_DECLARATIONS}`,
  );
}

function applyFurShader(material: MeshLambertMaterial, texture: Texture, frequency: number): void {
  material.customProgramCacheKey = () => FUR_PROGRAM_KEY;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.furMap = { value: texture };
    shader.uniforms.furFrequency = { value: frequency };
    injectTriplanarVaryings(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
{
${TRIPLANAR_FRAGMENT_SAMPLE}
  diffuseColor.rgb *= furSample;
}`,
    );
  };
}

// ── The fur shells ───────────────────────────────────────────────────────────
//
// WHAT A SHELL IS FOR, and why the shade tile above cannot do it. The tile
// paints hair ONTO a surface; it leaves the surface where it was, so the animal
// still ends at a smooth ellipsoid edge and every silhouette — the one thing a
// white animal on white snow is read by — is a clean curve with hair drawn
// inside it. Owner, 2026-08-26, on the model that had only the tile: the coat
// has to break the OUTLINE. A shell does that the way every real-time coat since
// Lengyel has: the furred mass is drawn again a few times, each copy pushed
// outward about its own centre, each with more of the strand tile cut away, so
// what stands proud of the body is a field of tapering tufts rather than a
// bigger ellipsoid.
//
// THE COST IS ONE DRAW CALL PER LAYER and it is bought deliberately: the layers
// differ in a shader constant, so they cannot merge with each other or with the
// coat (client/src/render/rigSkin.ts keys a merge on customProgramCacheKey), and
// the monster budget can afford it for exactly one reason —
// MAX_LIVING_MONSTERS_PER_KIND is 1.

/**
 * How sharply a strand's core stands out of the tile.
 *
 * The tile stores a strand's STRENGTH, not its colour: 1 down the middle of a
 * hair, 0 in the parting beside it. Each shell keeps only what is stronger than
 * its own threshold, so a high exponent here — a narrow core — is what makes the
 * outer shells keep a few thin tips where the inner ones keep a nearly solid
 * sheet. At 1 the field is a cosine and every layer is the same striped sheet at
 * a different size, which reads as a stack of shrink-wraps.
 */
const FUR_STRAND_SHARPNESS = 2.2;
/**
 * How much strands differ in LENGTH, and the two frequencies that decide which
 * ones are long.
 *
 * Without it every hair in the coat dies at the same shell and the coat has a
 * hard, flat top edge — a crew cut. The frequencies are deliberately not
 * multiples of the strand count, so the long hairs scatter over the tile instead
 * of falling into stripes of their own.
 */
const FUR_STRAND_LENGTH_SPREAD = 0.55;
const FUR_STRAND_LENGTH_ALONG = 5;
const FUR_STRAND_LENGTH_ACROSS = 3;

/**
 * The strand tile: an ALPHA field over the same strand pitch the shade tile
 * uses, so a shell's hairs stand exactly where the coat's partings say they do.
 *
 * Periodic on the tile for the reason furShadeTexture() gives — every frequency
 * is a whole number of cycles across it — and, like that one, computed rather
 * than loaded and free of Math.random.
 */
export function furStrandAlphaTexture(): DataTexture {
  const data = new Uint8Array(FUR_TEXTURE_SIZE * FUR_TEXTURE_SIZE * FUR_TEXEL_BYTES);
  for (let row = 0; row < FUR_TEXTURE_SIZE; row++) {
    const along = row / FUR_TEXTURE_SIZE;
    for (let column = 0; column < FUR_TEXTURE_SIZE; column++) {
      const across = column / FUR_TEXTURE_SIZE;
      let wander = across;
      for (const wave of FUR_WARP_WAVES) {
        wander +=
          wave.amplitude *
          Math.cos(TWO_PI * (wave.across * across + wave.along * along) + wave.phase);
      }
      // 1 down the centre of a strand, 0 in the parting between two.
      const core = 0.5 + 0.5 * Math.cos(TWO_PI * FUR_STRAND_COUNT * wander);
      // How far out this particular strand reaches, which is what stops the
      // whole coat ending at one height.
      const length =
        1 -
        FUR_STRAND_LENGTH_SPREAD *
          (0.5 -
            0.5 *
              Math.cos(
                TWO_PI * (FUR_STRAND_LENGTH_ALONG * along + FUR_STRAND_LENGTH_ACROSS * across),
              ));
      const strength = Math.pow(core, FUR_STRAND_SHARPNESS) * length;
      const byte = Math.round(Math.min(1, Math.max(0, strength)) * FUR_CHANNEL_MAX);
      const texel = (row * FUR_TEXTURE_SIZE + column) * FUR_TEXEL_BYTES;
      data[texel] = byte;
      data[texel + 1] = byte;
      data[texel + 2] = byte;
      data[texel + 3] = FUR_CHANNEL_MAX;
    }
  }
  const texture = new DataTexture(data, FUR_TEXTURE_SIZE, FUR_TEXTURE_SIZE, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  // NO MIPMAPS, unlike the shade tile, and the difference is what the two are
  // for. A mipmap averages a strand and its parting together; on a value that is
  // then THRESHOLDED that average is a coat that dissolves with distance —
  // every shell vanishing at once as the mip level rises. Linear minification
  // keeps the test meaningful at every range.
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The lowest and the widest strand strength a shell will keep.
 *
 * The innermost layer sits just off the skin and keeps nearly everything, so it
 * reads as a dense pile; the outermost keeps only the strongest cores of the
 * longest strands, which is a scatter of tips. Between them the coat thins out
 * the way a real one does.
 */
const SHELL_ALPHA_THRESHOLD_BASE = 0.16;
const SHELL_ALPHA_THRESHOLD_RANGE = 0.52;

/** The program key prefix; the layer is appended — see applyShellShader. */
const SHELL_PROGRAM_KEY = 'monster-fur-shell';

/**
 * Makes a material draw one shell layer: the strand tile, sampled triplanar,
 * thresholded, and the fragment thrown away below it.
 *
 * THE THRESHOLD IS A SHADER CONSTANT, not `material.alphaTest`, for a reason
 * that is not style: three's alpha test reads `diffuseColor.a`, which is fed by
 * an `alphaMap` sampled through UVs, and there are no UVs here — `positionsOnly`
 * strips them and `organicSurface` merges a dozen primitives whose UVs would not
 * agree anyway (see applyFurShader for the same argument). The test therefore
 * has to happen where the triplanar sample is, which is in the injected source.
 *
 * IT IS ALSO WHAT KEEPS THE LAYERS APART. Baking merges two parts whose
 * materials are interchangeable, and colour is carried per vertex — so three
 * shells identical but for a threshold would otherwise become ONE surface drawn
 * at one threshold. The layer goes into customProgramCacheKey, which is the
 * declaration three itself uses for "this material is a different program", and
 * which rigSkin.ts reads when it decides what may share a draw call.
 *
 * DISCARD, NOT TRANSPARENCY. An alpha-tested shell writes depth and needs no
 * sorting; three transparent layers at the same distance from the camera have no
 * correct order, and the one they get is an accident of scene-graph order.
 */
function applyShellShader(
  material: MeshLambertMaterial,
  texture: Texture,
  frequency: number,
  threshold: number,
  layer: number,
  layers: number,
): void {
  const key = `${SHELL_PROGRAM_KEY}-${layer}-of-${layers}`;
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.furMap = { value: texture };
    shader.uniforms.furFrequency = { value: frequency };
    injectTriplanarVaryings(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
{
${TRIPLANAR_FRAGMENT_SAMPLE}
  if (furSample < ${threshold.toFixed(4)}) discard;
}`,
    );
  };
}

/**
 * A sphere pre-scaled into an ellipsoid and moved into rig space.
 *
 * Positions only — every caller either merges it with something else or runs it
 * through the finishing pass, and both recompute what this strips.
 */
export function ellipsoid(
  length: number,
  height: number,
  width: number,
  segments: number,
  rings: number,
  center?: Vector3,
): BufferGeometry {
  const geometry = new SphereGeometry(0.5, segments, rings);
  geometry.scale(length, height, width);
  if (center !== undefined) geometry.translate(center.x, center.y, center.z);
  return positionsOnly(geometry);
}

/** Control points sampled off an arc before it is handed to a CatmullRom. */
export const ARC_CONTROL_POINTS = 5;

/**
 * A circular arc of the given length that turns through `turnRadians` in total,
 * hanging from the origin down -Y and curling toward -X, with a sideways bulge
 * of `drift` at its midpoint.
 *
 * Stating a curl as an ARC rather than as control-point offsets is what keeps
 * this shape describable in an anatomy file: the radius is length / turn, so the
 * whole curve falls out of two numbers that mean something ("this long, bent
 * this far") instead of a pile of hand-placed points that mean nothing.
 *
 * `minTurnRadians` is the floor a per-limb variation may not push the turn
 * below; it is a number from the caller's anatomy rather than one invented here,
 * because "how straight is straight enough for this creature" is a fact about
 * the creature. Without it the radius (length / turn) divides by zero.
 */
export function curlArc(
  length: number,
  turnRadians: number,
  drift: number,
  minTurnRadians: number,
): CatmullRomCurve3 {
  const turn = Math.max(minTurnRadians, turnRadians);
  const radius = length / turn;
  const points: Vector3[] = [];
  for (let step = 0; step <= ARC_CONTROL_POINTS; step++) {
    const along = step / ARC_CONTROL_POINTS;
    const angle = along * turn;
    points.push(
      new Vector3(
        -radius * (1 - Math.cos(angle)),
        -radius * Math.sin(angle),
        drift * Math.sin(Math.PI * along),
      ),
    );
  }
  return new CatmullRomCurve3(points);
}

/**
 * A tube swept along a curve whose radius is a function of how far along it is —
 * which is the whole reason this is here rather than three's TubeGeometry, since
 * that one takes a single radius and a tentacle that does not taper is a hose.
 *
 * The ring is closed by INDEX WRAP rather than by a duplicated seam column, so
 * there is no seam to weld and no crease down the length of every tentacle. The
 * far end is capped with a fan; the near end is left open because every caller
 * buries it inside the mass it grows out of.
 */
export function taperedTube(
  curve: CatmullRomCurve3,
  radiusAt: (along: number) => number,
  pathSegments: number,
  radialSegments: number,
): BufferGeometry {
  const frames = curve.computeFrenetFrames(pathSegments, false);
  const positions: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();

  for (let ring = 0; ring <= pathSegments; ring++) {
    const along = ring / pathSegments;
    curve.getPointAt(along, point);
    const normal = frames.normals[ring]!;
    const binormal = frames.binormals[ring]!;
    const radius = radiusAt(along);
    for (let side = 0; side < radialSegments; side++) {
      const angle = (side / radialSegments) * TWO_PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(
        point.x + radius * (cos * normal.x + sin * binormal.x),
        point.y + radius * (cos * normal.y + sin * binormal.y),
        point.z + radius * (cos * normal.z + sin * binormal.z),
      );
    }
  }

  for (let ring = 0; ring < pathSegments; ring++) {
    for (let side = 0; side < radialSegments; side++) {
      const here = ring * radialSegments + side;
      const next = ring * radialSegments + ((side + 1) % radialSegments);
      indices.push(here, next, next + radialSegments);
      indices.push(here, next + radialSegments, here + radialSegments);
    }
  }

  // THE CAPS: one vertex on each end of the curve and a fan of triangles back to
  // the ring there. Not a ring of radius zero — that collapses a whole row of
  // triangles to nothing and pinches the shading at the end.
  //
  // BOTH ENDS, since 2026-08-24. This used to cap the tip only, on the reasoning
  // that every root is buried in the mass the limb grows out of — and the owner
  // found the case where it was not: "the legs do not bind correctly to the
  // body, the geometry is still open." A leg is thicker than the hips are wide
  // at the stance, so the outer half of its root ring stood clear of them and
  // you could see up inside the tube. The burial is fixed where it belongs (the
  // haunch, in yeti.ts), and this is the other half of the belt: a tube that
  // cannot show its inside CANNOT produce that defect again, in this plugin or
  // the next one, however a caller places it. Two triangle fans is a rounding
  // error against the tube itself.
  const tipIndex = positions.length / 3;
  curve.getPointAt(1, point);
  positions.push(point.x, point.y, point.z);
  const lastRing = pathSegments * radialSegments;
  for (let side = 0; side < radialSegments; side++) {
    indices.push(lastRing + side, lastRing + ((side + 1) % radialSegments), tipIndex);
  }

  // The root fan winds the other way round: the ring is seen from OUTSIDE the
  // tube here, where the tip's was seen from behind, and a fan wound the same
  // way at both ends leaves one of them facing inward and invisible.
  const rootIndex = positions.length / 3;
  curve.getPointAt(0, point);
  positions.push(point.x, point.y, point.z);
  for (let side = 0; side < radialSegments; side++) {
    indices.push(((side + 1) % radialSegments), side, rootIndex);
  }

  const tube = new BufferGeometry();
  tube.setAttribute('position', new Float32BufferAttribute(positions, 3));
  tube.setIndex(indices);
  return tube;
}

/**
 * One panel of membrane, spanning from ridge `left` to ridge `right`.
 *
 * Both ridges start at `hub`, so a panel is a fan out of it. The free edge
 * between the two ridges is scalloped back toward the hub and the sheet is
 * sagged, which between them are what make a membrane look like skin hanging
 * off bones rather than like a sail sheeted in.
 *
 * The panel's edges lie EXACTLY on the ridge curves — both slack terms vanish at
 * span 0 and span 1 — which is what lets the ribs be swept along the same curves
 * and land on the seam instead of near it.
 */
export function membranePanel(
  left: CatmullRomCurve3,
  right: CatmullRomCurve3,
  hub: Vector3,
  sagDirection: Vector3,
  scallop: number,
  sag: number,
  spanSegments: number,
  ridgeSegments: number,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const leftPoint = new Vector3();
  const rightPoint = new Vector3();
  const vertex = new Vector3();

  for (let spanStep = 0; spanStep <= spanSegments; spanStep++) {
    const span = spanStep / spanSegments;
    // Zero at both ridges, one in the middle of the panel.
    const slack = Math.sin(Math.PI * span);
    for (let ridgeStep = 0; ridgeStep <= ridgeSegments; ridgeStep++) {
      const along = ridgeStep / ridgeSegments;
      left.getPointAt(along, leftPoint);
      right.getPointAt(along, rightPoint);
      vertex.copy(leftPoint).lerp(rightPoint, span);
      // Scallop: pull the free edge back toward the hub, proportionally to how
      // far out it already is, so the notch grows with the panel.
      vertex.sub(hub).multiplyScalar(1 - scallop * slack).add(hub);
      // Sag: heaviest at the panel's middle and at its outer end, because that
      // is where an unsupported sheet of skin has the most of itself to carry.
      vertex.addScaledVector(sagDirection, sag * slack * along);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }

  const stride = ridgeSegments + 1;
  for (let spanStep = 0; spanStep < spanSegments; spanStep++) {
    for (let ridgeStep = 0; ridgeStep < ridgeSegments; ridgeStep++) {
      const corner = spanStep * stride + ridgeStep;
      indices.push(corner, corner + 1, corner + stride + 1);
      indices.push(corner, corner + stride + 1, corner + stride);
    }
  }

  const panel = new BufferGeometry();
  panel.setAttribute('position', new Float32BufferAttribute(positions, 3));
  panel.setIndex(indices);
  return panel;
}

// ── The workshop ─────────────────────────────────────────────────────────────

/** One monster's scene object plus its idle animation. */
export interface MonsterModel {
  /** Positioned and yawed by the caller; never touched by `animate`. */
  readonly root: Group;
  /** `seconds` is elapsed time; `phase` is a per-monster offset in radians. */
  animate(seconds: number, phase: number): void;
}

/**
 * How a kind's skin is finished: the carve, and the mottle over it. Stated as
 * one value per KIND rather than as arguments at each callsite, so a creature
 * cannot end up with two different skins on two of its parts by accident.
 */
export interface SkinFinish {
  /** Cells of inward carve. 0 for a surface that must stay exact. */
  readonly wrinkleDepth: number;
  /** Spatial frequency of the wrinkle field, cycles per cell. */
  readonly wrinkleFrequency: number;
  /** Per-vertex shade variation, as a fraction either side of the colour. */
  readonly shadeVariation: number;
  /** Spatial frequency of the mottle, cycles per cell. */
  readonly shadeFrequency: number;
}

/** Options for a lambert material built by the workshop. */
export interface LambertOptions {
  readonly emissive?: number;
  readonly doubleSided?: boolean;
  /** False for a surface with no vertex-colour attribute (eyes, not skin). */
  readonly shaded?: boolean;
  /**
   * Spatial frequency of the fur tile on this surface, in tiles per world unit.
   * Omitted for anything that is not fur — hide, horn, ivory, eye.
   *
   * A frequency rather than a boolean because a coat's strand size belongs to
   * the CREATURE, not to the workshop: it scales with the animal exactly the way
   * the wrinkle frequency does, so a yeti at a fifth of his original size keeps
   * the same number of strands rather than shrinking to velvet.
   */
  readonly furFrequency?: number;
}

/**
 * The shared pool: everything a kind's builder makes goes through it, and it is
 * what `dispose()` frees. One instance per client plugin attach.
 */
export interface ModelWorkshop {
  /** Scales a base segment count by the resolution knob. A triangle needs 3. */
  segments(base: number): number;
  /** Registers a geometry for disposal and returns it. */
  keepGeometry<T extends BufferGeometry>(geometry: T): T;
  /** Registers a material for disposal and returns it. */
  keepMaterial<T extends Material>(material: T): T;
  /**
   * Registers a baked rig for disposal and returns it.
   *
   * A rig owns buffers the two calls above never see — the merged geometry and
   * the vertex-coloured material `bakeRig` produces per surface — so it needs
   * its own line in the pool rather than being folded into either.
   */
  keepRig<T extends RigBlueprint>(blueprint: T): T;
  lambert(color: number, options?: LambertOptions): MeshLambertMaterial;
  /**
   * One layer of a fur shell — the coat's OUTLINE, where `lambert`'s
   * furFrequency is the coat's shading. See applyShellShader.
   *
   * `layer` runs 1..`layers`, outward: layer 1 sits closest to the skin and
   * keeps the most hair. The caller owns the two things this cannot know — how
   * far out to push the copy, and what colour a hair at that depth is (an inner
   * layer is in the pile's own shadow) — because both are properties of the
   * ANIMAL, not of the toolkit.
   *
   * The frequency is a parameter for exactly the reason LambertOptions.
   * furFrequency is: a strand's size belongs to the creature, and this one must
   * match the shade tile's on the same body or the shells stand off the
   * partings.
   */
  shellMaterial(
    color: number,
    layer: number,
    layers: number,
    furFrequency: number,
  ): MeshLambertMaterial;
  /**
   * THE FINISHING PASS, and the reason a model reads as one creature.
   *
   * Merge the parts into a single geometry, weld the coincident vertices the
   * primitives arrived with, take normals over the WHOLE merged surface (which
   * is what smooth-shades it), carve the wrinkles, take the normals again over
   * the carved surface, then shade the vertices. One draw call comes out.
   *
   * Every input must be positions-only and indexed; everything this file builds
   * is, so the merge cannot fail on mismatched attributes.
   */
  organicSurface(parts: BufferGeometry[], skin: SkinFinish): BufferGeometry;
  /** Frees every kept geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

export function createWorkshop(): ModelWorkshop {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const rigs: RigBlueprint[] = [];
  /**
   * The one fur tile, shared by every furred surface of every kind and built the
   * first time one is asked for.
   *
   * Lazy rather than eager because most of what this workshop makes is not
   * furred, and a plugin attach that never builds a yeti should not pay for
   * 64 KB it will not sample. Shared rather than per-material because
   * rigSkin.ts's merge keys on texture IDENTITY: two surfaces sampling one
   * texture can be drawn together, two sampling identical copies cannot.
   */
  let furTexture: DataTexture | undefined;
  /**
   * The one strand tile every shell layer of every kind samples. Lazy and
   * shared for the same two reasons the shade tile above is — nothing but a
   * furred creature pays for it, and a merge keys on texture IDENTITY.
   */
  let strandTexture: DataTexture | undefined;

  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function keepMaterial<T extends Material>(material: T): T {
    materials.push(material);
    return material;
  }

  function keepRig<T extends RigBlueprint>(blueprint: T): T {
    rigs.push(blueprint);
    return blueprint;
  }

  return {
    segments(base: number): number {
      return Math.max(3, Math.round(base * MONSTER_MODEL_DETAIL));
    },

    keepGeometry,
    keepMaterial,
    keepRig,

    lambert(color: number, options: LambertOptions = {}): MeshLambertMaterial {
      // Built key by key rather than as one literal with undefineds in it: three
      // warns on a parameter that is present and undefined, because that is
      // usually a typo rather than a default.
      const parameters: MeshLambertMaterialParameters = {
        color,
        // Smooth, not flat: at this tessellation flat shading would show every
        // one of the facets around a skull as a plate. The faceted look was a
        // consequence of six segments, not a style to preserve at forty-eight.
        flatShading: false,
        vertexColors: options.shaded !== false,
      };
      if (options.emissive !== undefined) parameters.emissive = options.emissive;
      if (options.doubleSided === true) parameters.side = DoubleSide;
      const material = new MeshLambertMaterial(parameters);
      if (options.furFrequency !== undefined) {
        if (furTexture === undefined) furTexture = furShadeTexture();
        applyFurShader(material, furTexture, options.furFrequency);
      }
      return keepMaterial(material);
    },

    shellMaterial(
      color: number,
      layer: number,
      layers: number,
      furFrequency: number,
    ): MeshLambertMaterial {
      if (strandTexture === undefined) strandTexture = furStrandAlphaTexture();
      const material = new MeshLambertMaterial({
        color,
        flatShading: false,
        vertexColors: true,
      });
      applyShellShader(
        material,
        strandTexture,
        furFrequency,
        SHELL_ALPHA_THRESHOLD_BASE + (layer / layers) * SHELL_ALPHA_THRESHOLD_RANGE,
        layer,
        layers,
      );
      return keepMaterial(material);
    },

    organicSurface(parts: BufferGeometry[], skin: SkinFinish): BufferGeometry {
      const merged = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      const welded = mergeVertices(merged, WELD_TOLERANCE);
      merged.dispose();
      welded.computeVertexNormals();
      if (skin.wrinkleDepth > 0) {
        carveWrinkles(welded, skin.wrinkleDepth, skin.wrinkleFrequency);
        welded.computeVertexNormals();
      }
      applyShadeVariation(welded, skin.shadeVariation, skin.shadeFrequency);
      return keepGeometry(welded);
    },

    dispose(): void {
      for (const rig of rigs) rig.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      // The tile outlives every material that sampled it — it is shared, so no
      // one of them may free it — and dies here with the workshop that made it.
      furTexture?.dispose();
      furTexture = undefined;
      strandTexture?.dispose();
      strandTexture = undefined;
      rigs.length = 0;
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
