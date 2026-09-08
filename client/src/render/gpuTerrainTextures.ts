import {
  Box2,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  RedIntegerFormat,
  SRGBColorSpace,
  ShortType,
  Vector2,
  type WebGLRenderer,
} from 'three';
import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, bandOf, type Heightmap } from '@terrace/shared';
import {
  CLIFF_PALETTE,
  TERRAIN_PALETTE,
  bandPaletteIndex,
  type Rgb,
} from '../terrain/bandColors.ts';

export const BAND_LUT_MIN_BAND = bandOf(MIN_HEIGHT);

export const BAND_LUT_WIDTH = bandOf(MAX_HEIGHT) - BAND_LUT_MIN_BAND + 1;

export const BAND_LUT_TERRAIN_ROW = 0.25;

export const BAND_LUT_CLIFF_ROW = 0.75;

const BAND_LUT_ROWS = 2;

const RGBA_CHANNELS = 4;

const HEIGHT_TEXTURE_INTERNAL_FORMAT = 'R16I';

function writeLinear(target: Float32Array, offset: number, srgb: Rgb, scratch: Color): void {
  scratch.setRGB(srgb[0], srgb[1], srgb[2], SRGBColorSpace);
  target[offset] = scratch.r;
  target[offset + 1] = scratch.g;
  target[offset + 2] = scratch.b;
  target[offset + 3] = 1;
}

export function createBandPaletteTexture(): DataTexture {
  const data = new Float32Array(BAND_LUT_WIDTH * BAND_LUT_ROWS * RGBA_CHANNELS);
  const scratch = new Color();
  for (let i = 0; i < BAND_LUT_WIDTH; i++) {
    const height = (BAND_LUT_MIN_BAND + i) * BAND_HEIGHT;
    const stop = bandPaletteIndex(height);
    writeLinear(data, i * RGBA_CHANNELS, TERRAIN_PALETTE[stop], scratch);
    writeLinear(data, (BAND_LUT_WIDTH + i) * RGBA_CHANNELS, CLIFF_PALETTE[stop], scratch);
  }
  const texture = new DataTexture(data, BAND_LUT_WIDTH, BAND_LUT_ROWS, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function heightDataTexture(map: Heightmap): DataTexture {
  const texture = new DataTexture(
    map.cells,
    map.size,
    map.size,
    RedIntegerFormat,
    ShortType,
  );
  texture.internalFormat = HEIGHT_TEXTURE_INTERNAL_FORMAT;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export interface HeightTexture {
  readonly texture: DataTexture;
  uploadRect(renderer: WebGLRenderer, x: number, y: number, w: number, h: number): void;
  dispose(): void;
}

/** The staging twin is never sampled, so three uploads rects by texSubImage2D. */
export function createHeightTexture(map: Heightmap): HeightTexture {
  const texture = heightDataTexture(map);
  const staging = heightDataTexture(map);
  const region = new Box2();
  const destination = new Vector2();
  return {
    texture,
    uploadRect(renderer, x, y, w, h) {
      region.min.set(x, y);
      region.max.set(x + w, y + h);
      destination.set(x, y);
      renderer.copyTextureToTexture(staging, texture, region, destination);
    },
    dispose() {
      texture.dispose();
      staging.dispose();
    },
  };
}
