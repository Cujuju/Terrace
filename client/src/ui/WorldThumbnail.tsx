// A world, small enough to recognise in a list row (multi-world, 2026-08-22).
//
// The server ships a WORLD_THUMBNAIL_SIZE² grid of BAND numbers — not colours
// (server/src/persistence/thumbnail.ts explains why) — so the palette applied
// here is the live one from terrain/bandColors.ts. Recolour the terrain and
// every world in the list recolours with it; no stored picture goes stale.
//
// WHY IT IS SLOPE-SHADED. Band colour alone is flat, and a flat 64px world
// reads as a stain rather than a landscape: the whole job of this component is
// "which of these is the one I want", and shape is what answers it. Comparing
// each pixel with its up-slope neighbour and nudging brightness is a few lines
// and does most of the work a real renderer's lighting would.
//
// PIXELATED ON PURPOSE. The source is 64², and smoothing it would sell a
// blurry lie about how much detail is there. Nearest-neighbour reads as "a
// small picture", which is what it is.

import { createEffect, type JSX } from 'solid-js';
import { BAND_HEIGHT, WORLD_THUMBNAIL_SIZE } from '@terrace/shared';
import { bandColorOf } from '../terrain/bandColors.ts';

/**
 * How steeply brightness responds to a slope, in bands.
 *
 * A drop of this many bands against the neighbour reaches the darkest shade.
 * Three, because terraced terrain moves a band at a time: at 1 every terrace
 * edge would slam to the limit and the picture would be all edges, and past
 * ~6 the shading fades to nothing on the gentle coastal slopes that make one
 * island tell from another.
 */
const SHADE_BANDS = 3;

/** Brightness bounds, so a slope shades the colour without crushing it. */
const SHADE_MIN = 0.62;
const SHADE_MAX = 1.3;

/** Decodes the base64 the listing carries into the signed bands it holds. */
function decodeBands(base64: string): Int8Array | null {
  try {
    const binary = atob(base64);
    if (binary.length !== WORLD_THUMBNAIL_SIZE * WORLD_THUMBNAIL_SIZE) return null;
    const bands = new Int8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      // charCodeAt gives 0..255; Int8Array assignment reinterprets the high
      // half as negative, which is exactly the signed band the server wrote.
      bands[i] = binary.charCodeAt(i);
    }
    return bands;
  } catch {
    // Malformed base64 from a server this client does not fully understand.
    // A missing picture is a placeholder, never a broken row.
    return null;
  }
}

export function WorldThumbnail(props: {
  /** base64 bands from WorldSummary.thumbnail, or undefined when undrawn. */
  data: string | undefined;
  /** Accessible label — the world's name; the picture is decoration beside it. */
  name: string;
}): JSX.Element {
  let canvas: HTMLCanvasElement | undefined;

  createEffect(() => {
    // Read BOTH reactive inputs before any early return, so this effect
    // re-runs when a listing arrives with a picture that was absent before.
    const encoded = props.data;
    const element = canvas;
    if (element === undefined) return;

    const context = element.getContext('2d');
    if (context === null) return;

    const bands = encoded === undefined ? null : decodeBands(encoded);
    if (bands === null) {
      context.clearRect(0, 0, WORLD_THUMBNAIL_SIZE, WORLD_THUMBNAIL_SIZE);
      return;
    }

    const image = context.createImageData(WORLD_THUMBNAIL_SIZE, WORLD_THUMBNAIL_SIZE);
    for (let y = 0; y < WORLD_THUMBNAIL_SIZE; y++) {
      for (let x = 0; x < WORLD_THUMBNAIL_SIZE; x++) {
        const index = y * WORLD_THUMBNAIL_SIZE + x;
        const band = bands[index];
        // A band back to the height its own palette expects. bandColorOf takes
        // a raw height and quantises it itself, so multiplying back is exact.
        const [r, g, b] = bandColorOf(band * BAND_HEIGHT);

        // Up-LEFT neighbour, the conventional light direction for a relief
        // map. Edge pixels compare with themselves and so shade flat, which
        // is correct: there is no slope data past the edge to invent one from.
        const up = bands[Math.max(0, y - 1) * WORLD_THUMBNAIL_SIZE + Math.max(0, x - 1)];
        const raw = 1 + (band - up) / SHADE_BANDS;
        const shade = raw < SHADE_MIN ? SHADE_MIN : raw > SHADE_MAX ? SHADE_MAX : raw;

        const at = index * 4;
        image.data[at] = Math.min(255, r * 255 * shade);
        image.data[at + 1] = Math.min(255, g * 255 * shade);
        image.data[at + 2] = Math.min(255, b * 255 * shade);
        image.data[at + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  });

  return (
    <canvas
      ref={canvas}
      class="world-thumb"
      classList={{ 'world-thumb--empty': props.data === undefined }}
      width={WORLD_THUMBNAIL_SIZE}
      height={WORLD_THUMBNAIL_SIZE}
      role="img"
      aria-label={`${props.name}, seen from above`}
    />
  );
}
