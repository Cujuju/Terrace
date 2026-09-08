import { SRGBColorSpace, NoColorSpace, type Material, type Texture } from 'three';

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

export type MapSlot = (typeof SHADING_MAP_SLOTS)[number];

export const COLOUR_MAP_SLOTS: ReadonlySet<MapSlot> = new Set<MapSlot>([
  'map',
  'emissiveMap',
  'lightMap',
  'sheenColorMap',
  'specularColorMap',
]);

export function isTexture(value: unknown): value is Texture {
  return value !== undefined && value !== null && (value as Texture).isTexture === true;
}

export function textureOfSlot(material: Material, slot: MapSlot): Texture | null {
  const value = (material as Material & Partial<Record<MapSlot, unknown>>)[slot];
  return isTexture(value) ? value : null;
}

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

export function uvChannelsUsed(material: Material): Set<number> {
  const channels = new Set<number>();
  for (const slot of SHADING_MAP_SLOTS) {
    const texture = textureOfSlot(material, slot);
    if (texture !== null) channels.add(texture.channel);
  }
  return channels;
}

export function uvAttributeName(channel: number): string {
  return channel === 0 ? 'uv' : `uv${channel}`;
}

export function mapIdentitySignature(material: Material): string {
  const parts: string[] = [];
  for (const slot of SHADING_MAP_SLOTS) {
    const texture = textureOfSlot(material, slot);
    parts.push(texture === null ? '-' : `${texture.uuid}@${texture.channel}`);
  }
  return parts.join(',');
}

export function applyMapColourSpaces(material: Material): void {
  for (const slot of SHADING_MAP_SLOTS) {
    const texture = textureOfSlot(material, slot);
    if (texture === null) continue;
    const isColour = COLOUR_MAP_SLOTS.has(slot);
    const wrong = isColour
      ? texture.colorSpace !== SRGBColorSpace
      : texture.colorSpace === SRGBColorSpace;
    if (wrong) texture.colorSpace = isColour ? SRGBColorSpace : NoColorSpace;
  }
}
