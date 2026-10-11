import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, chunkIndex, chunksPerEdge } from '@terrace/shared';
import { createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  REVEAL_MASK_RECEIVED_BYTE,
  createRevealMask,
  revealedAtCell,
} from '../src/render/revealMask.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;

function mirrorWithChunks(...chunks: readonly number[]) {
  const mirror = createTerrainMirror(WORLD_SIZE);
  for (const chunk of chunks) mirror.received.add(chunk);
  return mirror;
}

describe('revealedAtCell — the CPU predicate', () => {
  it('is true exactly for cells whose owning chunk was received', () => {
    const mirror = mirrorWithChunks(chunkIndex(WORLD_SIZE, 1, 2));
    expect(revealedAtCell(mirror, CHUNK_SIZE, CHUNK_SIZE * 2)).toBe(true);
    expect(revealedAtCell(mirror, CHUNK_SIZE * 2 - 1, CHUNK_SIZE * 3 - 1)).toBe(true);
    expect(revealedAtCell(mirror, CHUNK_SIZE - 1, CHUNK_SIZE * 2)).toBe(false);
    expect(revealedAtCell(mirror, CHUNK_SIZE, CHUNK_SIZE * 3)).toBe(false);
  });

  it('is false outside the world, on every side, rather than clamping', () => {
    const mirror = mirrorWithChunks(
      chunkIndex(WORLD_SIZE, 0, 0),
      chunkIndex(WORLD_SIZE, 3, 3),
    );
    expect(revealedAtCell(mirror, 0, 0)).toBe(true);
    expect(revealedAtCell(mirror, -1, 0)).toBe(false);
    expect(revealedAtCell(mirror, 0, -1)).toBe(false);
    expect(revealedAtCell(mirror, WORLD_SIZE, WORLD_SIZE - 1)).toBe(false);
    expect(revealedAtCell(mirror, WORLD_SIZE - 1, WORLD_SIZE)).toBe(false);
    expect(revealedAtCell(mirror, WORLD_SIZE - 1, WORLD_SIZE - 1)).toBe(true);
  });

  it('is false for a fractional cell that rounds into an unreceived chunk', () => {
    const mirror = mirrorWithChunks(chunkIndex(WORLD_SIZE, 0, 0));
    expect(revealedAtCell(mirror, CHUNK_SIZE - 0.5, 0)).toBe(true);
    expect(revealedAtCell(mirror, CHUNK_SIZE + 0.5, 0)).toBe(false);
  });
});

describe('the reveal mask texture', () => {
  it('carries one texel per chunk, set exactly for the received set', () => {
    const received = chunkIndex(WORLD_SIZE, 2, 1);
    const mask = createRevealMask(WORLD_SIZE);
    mask.sync(mirrorWithChunks(received));

    const texture = mask.uniforms().uRevealMask.value;
    const data = texture.image.data as Uint8Array;
    const edge = chunksPerEdge(WORLD_SIZE);
    expect(data.length).toBe(edge * edge);
    for (let i = 0; i < data.length; i++) {
      expect(data[i]).toBe(i === received ? REVEAL_MASK_RECEIVED_BYTE : 0);
    }
    mask.dispose();
  });

  it('reports the chunk grid and the world units one chunk covers', () => {
    const mask = createRevealMask(WORLD_SIZE);
    const uniforms = mask.uniforms();
    expect(uniforms.uRevealChunksPerEdge.value).toBe(chunksPerEdge(WORLD_SIZE));
    expect(
      uniforms.uRevealChunksPerEdge.value * uniforms.uWorldUnitsPerChunk.value,
    ).toBeCloseTo(WORLD_SIZE / 4, 10);
    mask.dispose();
  });

  it('uploads only when a sync actually changed a texel', () => {
    const mask = createRevealMask(WORLD_SIZE);
    const texture = mask.uniforms().uRevealMask.value;
    const mirror = mirrorWithChunks(0);

    const built = texture.version;
    mask.sync(mirror);
    expect(texture.version).toBeGreaterThan(built);

    const uploaded = texture.version;
    mask.sync(mirror);
    expect(texture.version).toBe(uploaded);

    mirror.received.add(1);
    mask.sync(mirror);
    expect(texture.version).toBeGreaterThan(uploaded);
    mask.dispose();
  });

  it('reallocates for a world of a different size and keeps the shared uniforms', () => {
    const mask = createRevealMask(WORLD_SIZE);
    const uniforms = mask.uniforms();
    const bigger = CHUNK_SIZE * 8;
    mask.sync(mirrorWithChunks(0));
    mask.sync(createTerrainMirror(bigger));

    expect(mask.uniforms()).toBe(uniforms);
    expect(uniforms.uRevealChunksPerEdge.value).toBe(chunksPerEdge(bigger));
    expect((uniforms.uRevealMask.value.image.data as Uint8Array).length).toBe(
      chunksPerEdge(bigger) ** 2,
    );
    mask.dispose();
  });
});
