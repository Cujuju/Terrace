import {
  Box2,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  FloatType,
  IntType,
  NearestFilter,
  RGBAFormat,
  RGIntegerFormat,
  RedIntegerFormat,
  SRGBColorSpace,
  ShortType,
  Vector2,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MAX_SPANS_PER_COLUMN,
  MIN_HEIGHT,
  anyColumnLayered,
  bandOf,
  cellIndex,
  chunksPerEdge,
  type Heightmap,
} from '@terrace/shared';
import {
  CHUNK_SPAN_BLOCK_SAMPLER_UNIFORM,
  COLUMN_SPAN_SAMPLER_UNIFORM,
  WORLD_HAS_SPANS_UNIFORM,
} from './gpuTerrainField.ts';
import {
  CLIFF_PALETTE,
  TERRAIN_PALETTE,
  bandPaletteIndex,
  isEmissivePaletteIndex,
  isSeabedPaletteIndex,
  type Rgb,
} from '../terrain/bandColors.ts';

export const BAND_LUT_MIN_BAND = bandOf(MIN_HEIGHT);

export const BAND_LUT_WIDTH = bandOf(MAX_HEIGHT) - BAND_LUT_MIN_BAND + 1;

export const BAND_LUT_TERRAIN_ROW = 0.25;

export const BAND_LUT_CLIFF_ROW = 0.75;

/** Alpha carries self-lit-ness: that row's use of the band ignores scene light. */
const BAND_LUT_SELF_LIT = 1;

const BAND_LUT_LIT_BY_SCENE = 0;

const BAND_LUT_ROWS = 2;

const RGBA_CHANNELS = 4;

const HEIGHT_TEXTURE_INTERNAL_FORMAT = 'R16I';

const CHUNK_BLOCK_TEXTURE_INTERNAL_FORMAT = 'R32I';

const SPAN_TEXTURE_INTERNAL_FORMAT = 'RG16I';

/** A span texel is (floor, ceiling), the packing `columnSpans` already uses. */
const SPAN_COMPONENTS = 2;

/** One row per layered chunk: every cell's span list at a fixed stride. */
const SPAN_ROW_TEXELS = CHUNK_SIZE * CHUNK_SIZE * MAX_SPANS_PER_COLUMN;

/** A world with no layered chunk still needs a bindable sampler. */
const INITIAL_SPAN_ROWS = 1;

const SPAN_ROW_GROWTH = 2;

function writeEntry(
  target: Float32Array,
  offset: number,
  srgb: Rgb,
  selfLit: boolean,
  scratch: Color,
): void {
  scratch.setRGB(srgb[0], srgb[1], srgb[2], SRGBColorSpace);
  target[offset] = scratch.r;
  target[offset + 1] = scratch.g;
  target[offset + 2] = scratch.b;
  target[offset + 3] = selfLit ? BAND_LUT_SELF_LIT : BAND_LUT_LIT_BY_SCENE;
}

export function createBandPaletteTexture(): DataTexture {
  const data = new Float32Array(BAND_LUT_WIDTH * BAND_LUT_ROWS * RGBA_CHANNELS);
  const scratch = new Color();
  for (let i = 0; i < BAND_LUT_WIDTH; i++) {
    const height = (BAND_LUT_MIN_BAND + i) * BAND_HEIGHT;
    const stop = bandPaletteIndex(height);
    writeEntry(
      data,
      i * RGBA_CHANNELS,
      TERRAIN_PALETTE[stop],
      isEmissivePaletteIndex(stop),
      scratch,
    );
    writeEntry(
      data,
      (BAND_LUT_WIDTH + i) * RGBA_CHANNELS,
      CLIFF_PALETTE[stop],
      isSeabedPaletteIndex(stop),
      scratch,
    );
  }
  const texture = new DataTexture(data, BAND_LUT_WIDTH, BAND_LUT_ROWS, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function lookupTexture(
  texture: DataTexture,
  internalFormat: DataTexture['internalFormat'],
): DataTexture {
  texture.internalFormat = internalFormat;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export interface StagedTexture {
  readonly texture: DataTexture;
  uploadRect(renderer: WebGLRenderer, x: number, y: number, w: number, h: number): void;
  dispose(): void;
}

/** The staging twin is never sampled, so three uploads rects by texSubImage2D. */
function createStagedTexture(make: () => DataTexture): StagedTexture {
  const texture = make();
  const staging = make();
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

export type HeightTexture = StagedTexture;

export function createHeightTexture(map: Heightmap): HeightTexture {
  return createStagedTexture(() =>
    lookupTexture(
      new DataTexture(map.cells, map.size, map.size, RedIntegerFormat, ShortType),
      HEIGHT_TEXTURE_INTERNAL_FORMAT,
    ),
  );
}

export interface ColumnSpanTextures {
  readonly uniforms: Record<string, IUniform>;
  uploadChunk(renderer: WebGLRenderer, cx: number, cy: number): void;
  dispose(): void;
}

/** Chunk-resolution block index (0 = no layered column) into one span row per block. */
export function createColumnSpanTextures(map: Heightmap): ColumnSpanTextures {
  const perEdge = chunksPerEdge(map.size);
  const blocks = new Int32Array(perEdge * perEdge);
  const blockTexture = createStagedTexture(() =>
    lookupTexture(
      new DataTexture(blocks, perEdge, perEdge, RedIntegerFormat, IntType),
      CHUNK_BLOCK_TEXTURE_INTERNAL_FORMAT,
    ),
  );
  const freeRows: number[] = [];
  let rows = INITIAL_SPAN_ROWS;
  let spanData = new Int16Array(SPAN_ROW_TEXELS * SPAN_COMPONENTS * rows);
  const makeSpanTexture = (): StagedTexture =>
    createStagedTexture(() =>
      lookupTexture(
        new DataTexture(spanData, SPAN_ROW_TEXELS, rows, RGIntegerFormat, ShortType),
        SPAN_TEXTURE_INTERNAL_FORMAT,
      ),
    );
  let spanTexture = makeSpanTexture();
  let usedRows = 0;

  const uniforms: Record<string, IUniform> = {
    [CHUNK_SPAN_BLOCK_SAMPLER_UNIFORM]: { value: blockTexture.texture },
    [COLUMN_SPAN_SAMPLER_UNIFORM]: { value: spanTexture.texture },
    [WORLD_HAS_SPANS_UNIFORM]: { value: 0 },
  };

  const takeRow = (): number => {
    const reused = freeRows.pop();
    if (reused !== undefined) return reused;
    if (usedRows === rows) {
      const grown = new Int16Array(SPAN_ROW_TEXELS * SPAN_COMPONENTS * rows * SPAN_ROW_GROWTH);
      grown.set(spanData);
      spanTexture.dispose();
      rows *= SPAN_ROW_GROWTH;
      spanData = grown;
      spanTexture = makeSpanTexture();
      uniforms[COLUMN_SPAN_SAMPLER_UNIFORM]!.value = spanTexture.texture;
    }
    return usedRows++;
  };

  const writeRow = (cx: number, cy: number, row: number): void => {
    const base = row * SPAN_ROW_TEXELS * SPAN_COMPONENTS;
    spanData.fill(0, base, base + SPAN_ROW_TEXELS * SPAN_COMPONENTS);
    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const packed = map.columnSpans.get(cellIndex(map, x0 + x, y0 + y));
        if (packed === undefined) continue;
        spanData.set(packed, base + (y * CHUNK_SIZE + x) * MAX_SPANS_PER_COLUMN * SPAN_COMPONENTS);
      }
    }
  };

  return {
    uniforms,
    uploadChunk(renderer, cx, cy) {
      uniforms[WORLD_HAS_SPANS_UNIFORM]!.value = map.columnSpans.size > 0 ? 1 : 0;
      const chunk = cy * perEdge + cx;
      const held = blocks[chunk]!;
      if (!anyColumnLayered(map, cx * CHUNK_SIZE, cy * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE)) {
        if (held === 0) return;
        freeRows.push(held - 1);
        blocks[chunk] = 0;
        blockTexture.uploadRect(renderer, cx, cy, 1, 1);
        return;
      }
      const row = held === 0 ? takeRow() : held - 1;
      writeRow(cx, cy, row);
      spanTexture.uploadRect(renderer, 0, row, SPAN_ROW_TEXELS, 1);
      if (held !== 0) return;
      blocks[chunk] = row + 1;
      blockTexture.uploadRect(renderer, cx, cy, 1, 1);
    },
    dispose() {
      blockTexture.dispose();
      spanTexture.dispose();
    },
  };
}
