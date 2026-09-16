// Five checked-in 64x64 worlds, one fixed stroke script each, replayed against
// `fixtures/<world>.golden.json`.

// Regenerate:
//   pnpm --filter @terrace/shared test golden-sculpt -u

// A pure refactor keeps every golden. An intended change rewrites them in the
// same commit.

import { describe, expect, test } from 'vitest';
import {
  buildGoldenWorld,
  GOLDEN_WORLD_NAMES,
  GOLDEN_WORLD_SIZE,
  type GoldenWorldName,
} from './fixtures/worlds.ts';
import { scriptFor } from './fixtures/strokes.ts';
import {
  goldenText,
  hashHeightmap,
  runStrokeScript,
  type StrokeOutcome,
} from './support/goldenCorpus.ts';

interface Golden {
  readonly world: GoldenWorldName;
  readonly size: number;
  readonly layeredColumnsBefore: number;
  readonly hashBefore: string;
  readonly strokes: readonly StrokeOutcome[];
  readonly layeredColumnsAfter: number;
  readonly hashAfter: string;
}

function replay(world: GoldenWorldName): Golden {
  const map = buildGoldenWorld(world);
  const layeredColumnsBefore = map.columnSpans.size;
  const hashBefore = hashHeightmap(map);
  const strokes = runStrokeScript(map, scriptFor(world));
  return {
    world,
    size: map.size,
    layeredColumnsBefore,
    hashBefore,
    strokes,
    layeredColumnsAfter: map.columnSpans.size,
    hashAfter: hashHeightmap(map),
  };
}

describe.each(GOLDEN_WORLD_NAMES)('golden world %s', (world) => {
  test('is a 64x64 world', () => {
    expect(buildGoldenWorld(world).size).toBe(GOLDEN_WORLD_SIZE);
  });

  test('replays its stroke script to the checked-in golden', async () => {
    await expect(goldenText(replay(world))).toMatchFileSnapshot(
      `./fixtures/${world}.golden.json`,
    );
  });

  test('replays identically twice in the same process', () => {
    expect(replay(world)).toEqual(replay(world));
  });

  // A stroke that stopped biting still matches its golden, so the corpus would
  // go on passing while covering nothing.
  test('moves at least one cell on every stroke', () => {
    const dead = replay(world).strokes.filter((stroke) => stroke.changed === 0);
    expect(dead.map((stroke) => stroke.name)).toEqual([]);
  });

  test('names each stroke once', () => {
    const names = scriptFor(world).map((step) => step.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

test('golden text is LF only, so a CRLF checkout cannot move a hash', () => {
  expect(goldenText(replay('arch'))).not.toContain('\r');
});
