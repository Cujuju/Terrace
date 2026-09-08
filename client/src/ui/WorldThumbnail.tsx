import { createEffect, type JSX } from 'solid-js';
import { BAND_HEIGHT, WORLD_THUMBNAIL_SIZE } from '@terrace/shared';
import { bandColorOf } from '../terrain/bandColors.ts';

const SHADE_BANDS = 3;

const SHADE_MIN = 0.62;
const SHADE_MAX = 1.3;

function decodeBands(base64: string): Int8Array | null {
  try {
    const binary = atob(base64);
    if (binary.length !== WORLD_THUMBNAIL_SIZE * WORLD_THUMBNAIL_SIZE) return null;
    const bands = new Int8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bands[i] = binary.charCodeAt(i);
    }
    return bands;
  } catch {
    return null;
  }
}

export function WorldThumbnail(props: {
  data: string | undefined;
  name: string;
}): JSX.Element {
  let canvas: HTMLCanvasElement | undefined;

  createEffect(() => {
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
        const [r, g, b] = bandColorOf(band * BAND_HEIGHT);

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
