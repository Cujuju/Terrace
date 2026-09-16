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
import { STROKE_SCRIPTS } from './fixtures/strokes.ts';
import {
  goldenText,
  hashHeightmap,
  runStrokeScript,
  type StrokeOutcome,
  type StrokeScriptStep,
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

const COMMON_SCRIPT_KEY = 'common';

function scriptFor(world: GoldenWorldName): StrokeScriptStep[] {
  return [...STROKE_SCRIPTS[COMMON_SCRIPT_KEY]!, ...(STROKE_SCRIPTS[world] ?? [])];
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
});

test('every stroke in the script is named once', () => {
  for (const world of GOLDEN_WORLD_NAMES) {
    const names = scriptFor(world).map((step) => step.name);
    expect(new Set(names).size).toBe(names.length);
  }
});

test('golden text is LF only, so a CRLF checkout cannot move a hash', () => {
  expect(goldenText(replay('arch'))).not.toContain('\r');
});
