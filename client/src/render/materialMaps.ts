// The texture slots of a three material, in ONE place.
//
// WHY THIS EXISTS. Every consumer of an authored model has to answer the same
// three questions about a material — which textures does it own (to free them),
// which uv sets does it sample (to keep those attributes through a merge), and
// which two materials are the same for shading purposes (to merge at all) — and
// every one of them used to answer it with a hand-written pair of fields, `map`
// and `emissiveMap`. That was correct only while every asset was a flat-colour
// or single-baseColor part. A real glTF PBR material carries a normal map, a
// metallic-roughness map, an occlusion map and often more; under the old
// hand-listed answers those textures leaked on dispose, their uv set was
// stripped before the draw, and two parts that differ ONLY in normal map merged
// into one surface shaded by whichever material happened to be first. The bug
// is not that any one callsite forgot a slot — it is that each callsite had to
// remember the list at all, so the list lives here and nowhere else.
//
// THE LIST IS NOT FROM MEMORY. `SHADING_MAP_SLOTS` below is exactly the set of
// slots three's own program builder assigns a uv channel to
// (client/node_modules/three/src/renderers/webgl/WebGLPrograms.js:272-302,
// `mapUv`…`alphaMapUv`). That is the right boundary by construction: a slot
// that three samples with a uv set is a slot whose uv attribute must survive
// baking and whose texture belongs to the surface; `envMap` is deliberately
// absent from that list in three (it is sampled by reflection vector, not by
// uv) and is deliberately absent here for the same reason — it is scene state
// the renderer or the scene owner supplies, not part geometry.

import { SRGBColorSpace, NoColorSpace, type Material, type Texture } from 'three';

/**
 * Every texture slot three samples with a uv set, in a fixed order.
 *
 * ORDER IS PART OF THE CONTRACT: `mapIdentitySignature` walks the list, so two
 * materials produce comparable signatures only because the order never depends
 * on which slots happen to be filled.
 *
 * DISPLACEMENT IS IN. `displacementMap` is sampled in the VERTEX stage rather
 * than the fragment stage, which is precisely why it cannot be left out: it
 * moves the vertices, so two parts with different displacement maps are two
 * different shapes and must never merge, and its uv set has to survive the bake
 * or the displacement samples garbage (WebGLPrograms.js:277 gives it a channel
 * exactly like the fragment maps).
 *
 * THE PHYSICAL-ONLY SLOTS ARE IN TOO — clearcoat, sheen, iridescence,
 * transmission, anisotropy, specular. Nothing in this repo authors a
 * MeshPhysicalMaterial today, and the temptation is to list only the
 * MeshStandardMaterial set; that is the failure this module exists to remove.
 * GLTFLoader promotes a material to MeshPhysicalMaterial the moment a file
 * carries the matching KHR extension (see its extension handlers,
 * GLTFLoader.js:921-1432), with no signal at the callsite, and a slot missing
 * from this list fails SILENTLY — a leaked texture, a stripped uv set, a wrong
 * merge. Listing them costs one line each and closes the class.
 */
export const SHADING_MAP_SLOTS = [
  'map',
  'emissiveMap',
  'lightMap',
  'aoMap',
  'bumpMap',
  'normalMap',
  'displacementMap',
  'roughnessMap',
  'metalnessMap',
  'alphaMap',
  'anisotropyMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularMap',
  'specularColorMap',
  'specularIntensityMap',
  'transmissionMap',
  'thicknessMap',
] as const;

/** One of the slots above. */
export type MapSlot = (typeof SHADING_MAP_SLOTS)[number];

/**
 * The slots whose texels are COLOURS, and so must be uploaded as sRGB.
 *
 * Read off GLTFLoader, not from taste: it passes `SRGBColorSpace` to
 * `assignTexture` for exactly four slots — map (GLTFLoader.js:3582),
 * emissiveMap (:3674), sheenColorMap (:1126) and specularColorMap (:1329) —
 * and leaves every other slot at the loader default, which is the texture
 * default `NoColorSpace` (Texture.js:48). `lightMap` joins them because glTF
 * has no lightmap at all, so the loader never speaks for it, and what it
 * carries IS colour: three adds its texel straight into `irradiance`
 * (ShaderChunk/lights_fragment_maps.glsl.js:6-9).
 *
 * The distinction is not cosmetic. A normal, roughness or occlusion map forced
 * to sRGB is decoded with a ~2.2 gamma on upload, so every value in it is
 * wrong — a normal map read that way tilts every normal, and the part looks
 * lit from somewhere else.
 */
export const COLOUR_MAP_SLOTS: ReadonlySet<MapSlot> = new Set<MapSlot>([
  'map',
  'emissiveMap',
  'lightMap',
  'sheenColorMap',
  'specularColorMap',
]);

/** A texture object, as opposed to an absent (null/undefined) map slot. */
export function isTexture(value: unknown): value is Texture {
  return value !== undefined && value !== null && (value as Texture).isTexture === true;
}

/** The texture in one slot of a material, or null when the slot is empty. */
export function textureOfSlot(material: Material, slot: MapSlot): Texture | null {
  const value = (material as Material & Partial<Record<MapSlot, unknown>>)[slot];
  return isTexture(value) ? value : null;
}

/**
 * Every texture this material samples through a uv set, deduplicated.
 *
 * Deduplicated because one texture routinely fills two slots — GLTFLoader
 * assigns the SAME metallicRoughness image to both `metalnessMap` and
 * `roughnessMap` (GLTFLoader.js:3591-3592) — and a caller disposing the list
 * would otherwise free it twice.
 */
export function texturesOf(material: Material): Texture[] {
  const textures: Texture[] = [];
  const seen = new Set<Texture>();
  for (const slot of SHADING_MAP_SLOTS) {
    const texture = textureOfSlot(material, slot);
    if (texture === null || seen.has(texture)) continue;
    seen.add(texture);
    textures.push(texture);
  }
  return textures;
}

/**
 * The uv channels this material's textures read, as channel numbers.
 *
 * Channel N is the geometry attribute `uv` for 0 and `uv${N}` for the rest —
 * three's own naming (WebGLPrograms.js:388-390 and :519-523 turn the active
 * channels into `vertexUv1s`…`vertexUv3s`). A texture's channel defaults to 0
 * (Texture.js:118); GLTFLoader sets it from the glTF `texCoord` index
 * (GLTFLoader.js:3397), which is how an occlusion map ends up on the second uv
 * set in files that author it that way.
 */
export function uvChannelsUsed(material: Material): Set<number> {
  const channels = new Set<number>();
  for (const slot of SHADING_MAP_SLOTS) {
    const texture = textureOfSlot(material, slot);
    if (texture !== null) channels.add(texture.channel);
  }
  return channels;
}

/** The geometry attribute name three reads uv channel `n` from. */
export function uvAttributeName(channel: number): string {
  return channel === 0 ? 'uv' : `uv${channel}`;
}

/**
 * The identity of every texture slot, as one comparable string.
 *
 * IDENTITY, NOT PRESENCE, so two parts sampling the same atlas still merge
 * while two parts with different maps never do. Slots are walked in
 * SHADING_MAP_SLOTS order and empty ones are still written, because a
 * signature that skipped them could not tell `{map: A}` from `{normalMap: A}`.
 * The channel rides along: the same texture read through a different uv set is
 * a different shading result, and two such parts cannot share a surface.
 */
export function mapIdentitySignature(material: Material): string {
  const parts: string[] = [];
  for (const slot of SHADING_MAP_SLOTS) {
    const texture = textureOfSlot(material, slot);
    parts.push(texture === null ? '-' : `${texture.uuid}@${texture.channel}`);
  }
  return parts.join(',');
}

/**
 * Puts every filled slot in the colour space its data means.
 *
 * A FIX-UP, NOT AN ASSUMPTION. GLTFLoader gets this right for the files it
 * writes itself, but a hand-edited file, a different exporter, or a texture
 * re-used across slots by an authoring tool can arrive either way round, and
 * neither mistake is visible as anything but "the art looks wrong": a colour
 * map left linear renders every texel too dark, a data map forced to sRGB has
 * every value gamma-decoded before it is used as a number.
 *
 * Data slots are set to `NoColorSpace` rather than `LinearSRGBColorSpace`
 * because that is three's own default for a texture (Texture.js:48) and both
 * mean the same thing to the uploader — `ColorManagement.getTransfer` returns
 * the linear transfer for everything that is not `SRGBColorSpace`.
 */
export function applyMapColourSpaces(material: Material): void {
  for (const slot of SHADING_MAP_SLOTS) {
    const texture = textureOfSlot(material, slot);
    if (texture === null) continue;
    const isColour = COLOUR_MAP_SLOTS.has(slot);
    // A data slot is only WRONG when it says sRGB; NoColorSpace and
    // LinearSRGBColorSpace both upload unconverted, so neither is touched.
    const wrong = isColour
      ? texture.colorSpace !== SRGBColorSpace
      : texture.colorSpace === SRGBColorSpace;
    if (wrong) texture.colorSpace = isColour ? SRGBColorSpace : NoColorSpace;
  }
}
