// The two parity metrics, as pure functions over decoded RGBA images, so the
// metric can be reviewed and exercised apart from the stack that captures the
// images. Driver: mesherParity.mjs.

// Band-ID encoding (perfProbe.ts swapBandMaterials): R = round(worldY /
// BAND_WORLD_HEIGHT) + 128, G = chunk index low byte, B = chunk index high
// byte. The background is exactly pure blue, which no terrain pixel can be:
// the band bias keeps R well away from 0 over the world's height range.
const BACKGROUND_RGB = [0, 0, 255];
const BAND_CHANNEL = 0;
const CHUNK_LOW_CHANNEL = 1;
const CHUNK_HIGH_CHANNEL = 2;
const CHUNK_INDEX_BYTE_SPAN = 256;
export const CHANNELS = 4;

// Gate 1's shaded metric, unchanged (bench/webgpu-mesher/run.mjs).
export const PIXEL_TOLERANCE = 8;
export const NEIGHBOURHOOD_RADIUS = 1;

const [DIFF_DIM_FACTOR, DIFF_MARK_RGB, DIFF_EXEMPT_RGB] = [0.35, [255, 32, 32], [40, 40, 80]];
const DIFF_BLOCKY_RGB = [90, 70, 20];
const OPAQUE = 255;

export const isBackground = (rgba, at) =>
  rgba[at] === BACKGROUND_RGB[0]
  && rgba[at + CHUNK_LOW_CHANNEL] === BACKGROUND_RGB[1]
  && rgba[at + CHUNK_HIGH_CHANNEL] === BACKGROUND_RGB[2];

export const chunkIndexAt = (rgba, at) =>
  rgba[at + CHUNK_LOW_CHANNEL] + rgba[at + CHUNK_HIGH_CHANNEL] * CHUNK_INDEX_BYTE_SPAN;

/**
 * Contour-adjacency exemption: a pixel whose 3x3 neighbourhood in the CPU image
 * is not all one band. Background counts as its own band, so silhouette edges
 * are exempt too.
 */
export function buildExemptMask(cpu, width, height) {
  const exempt = new Uint8Array(width * height);
  const bandOf = (x, y) => {
    const at = (y * width + x) * CHANNELS;
    return isBackground(cpu, at) ? -1 : cpu[at + BAND_CHANNEL];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = bandOf(x, y);
      let mixed = false;
      for (let dy = -NEIGHBOURHOOD_RADIUS; dy <= NEIGHBOURHOOD_RADIUS && !mixed; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -NEIGHBOURHOOD_RADIUS; dx <= NEIGHBOURHOOD_RADIUS; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (bandOf(nx, ny) !== here) { mixed = true; break; }
        }
      }
      exempt[y * width + x] = mixed ? 1 : 0;
    }
  }
  return exempt;
}

/**
 * Design §9.2: chunks the CPU drew blocky are excluded from the pixel
 * criterion. Dilated by the same 3x3 radius because a chunk-seam pixel's
 * antialiased G/B decodes to neither neighbour's index.
 */
export function buildBlockyMask(cpu, width, height, blockyChunks) {
  const mask = new Uint8Array(width * height);
  if (blockyChunks === null || blockyChunks.length === 0) return mask;
  const blocky = new Set(blockyChunks);
  const hit = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const at = p * CHANNELS;
    if (!isBackground(cpu, at) && blocky.has(chunkIndexAt(cpu, at))) hit[p] = 1;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let near = 0;
      for (let dy = -NEIGHBOURHOOD_RADIUS; dy <= NEIGHBOURHOOD_RADIUS && near === 0; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -NEIGHBOURHOOD_RADIUS; dx <= NEIGHBOURHOOD_RADIUS; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (hit[ny * width + nx] === 1) { near = 1; break; }
        }
      }
      mask[y * width + x] = near;
    }
  }
  return mask;
}

/**
 * Band-ID parity. Samples are pixels covered by terrain in either image; a
 * covered pixel under the contour exemption is counted as exempt, not judged.
 * Holes are reported both over judged samples and over every pixel.
 */
export function compareBands(gpuImage, cpuImage, blockyChunks = null) {
  const { width, height } = cpuImage;
  const gpu = gpuImage.rgba;
  const cpu = cpuImage.rgba;
  const exempt = buildExemptMask(cpu, width, height);
  const blockyMask = buildBlockyMask(cpu, width, height, blockyChunks);
  const diff = new Uint8Array(width * height * CHANNELS);

  let considered = 0;
  let mismatched = 0;
  let exemptCovered = 0;
  let blockyCovered = 0;
  let holes = 0;
  let holesAllPixels = 0;
  for (let p = 0; p < width * height; p++) {
    const at = p * CHANNELS;
    const cpuBackground = isBackground(cpu, at);
    const gpuBackground = isBackground(gpu, at);
    const covered = !cpuBackground || !gpuBackground;
    if (gpuBackground && !cpuBackground) holesAllPixels++;

    let mark = null;
    if (covered && (exempt[p] === 1 || blockyMask[p] === 1)) {
      exemptCovered++;
      if (blockyMask[p] === 1) blockyCovered++;
      mark = blockyMask[p] === 1 ? DIFF_BLOCKY_RGB : DIFF_EXEMPT_RGB;
    } else if (covered) {
      considered++;
      const bad = cpuBackground !== gpuBackground
        || cpu[at + BAND_CHANNEL] !== gpu[at + BAND_CHANNEL];
      if (bad) {
        mismatched++;
        mark = DIFF_MARK_RGB;
      }
      if (gpuBackground && !cpuBackground) holes++;
    }
    for (let c = 0; c < 3; c++) {
      diff[at + c] = mark === null ? cpu[at + c] * DIFF_DIM_FACTOR : mark[c];
    }
    diff[at + 3] = OPAQUE;
  }

  return {
    width, height, pixels: width * height,
    consideredSamples: considered, exemptSamples: exemptCovered,
    blockyExemptSamples: blockyCovered,
    mismatched, mismatchFraction: considered === 0 ? null : mismatched / considered,
    holes, holesAllPixels,
    diff,
  };
}

// A pixel matches if ANY pixel in the other image's 3x3 neighbourhood is within
// PIXEL_TOLERANCE on every channel. The window absorbs one-pixel contour
// rasterization differences and nothing wider.
const matchesNear = (a, b, width, height, x, y) => {
  const base = (y * width + x) * CHANNELS;
  for (let dy = -NEIGHBOURHOOD_RADIUS; dy <= NEIGHBOURHOOD_RADIUS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -NEIGHBOURHOOD_RADIUS; dx <= NEIGHBOURHOOD_RADIUS; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      const other = (ny * width + nx) * CHANNELS;
      if (Math.abs(a[base] - b[other]) <= PIXEL_TOLERANCE
        && Math.abs(a[base + 1] - b[other + 1]) <= PIXEL_TOLERANCE
        && Math.abs(a[base + 2] - b[other + 2]) <= PIXEL_TOLERANCE) return true;
    }
  }
  return false;
};

/** Gate 1's shaded compare, both directions, over every pixel. */
export function compareShaded(a, b, paint) {
  const { width, height } = a;
  let mismatched = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * CHANNELS;
      const ok = matchesNear(a.rgba, b.rgba, width, height, x, y)
        && matchesNear(b.rgba, a.rgba, width, height, x, y);
      if (!ok) mismatched++;
      if (paint === undefined) continue;
      for (let c = 0; c < 3; c++) {
        paint[at + c] = ok ? a.rgba[at + c] * DIFF_DIM_FACTOR : DIFF_MARK_RGB[c];
      }
      paint[at + 3] = OPAQUE;
    }
  }
  return { mismatched, fraction: mismatched / (width * height), pixels: width * height };
}
