import {
  drawnBandOfSample,
  MAX_BAND,
  MIN_BAND,
  runFloorBandAt,
  SCULPT_TOOLS,
} from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { scriptFor } from '../../shared/test/fixtures/strokes.ts';
import { GOLDEN_WORLD_NAMES, type GoldenWorldName } from '../../shared/test/fixtures/worlds.ts';
import type { ScriptBand, StrokeScriptStep } from '../../shared/test/support/goldenCorpus.ts';
import type { Player } from '../src/player.ts';
import {
  entriesOfKind,
  EVERY_CHUNK,
  Scenario,
  sculptMessage,
} from './support/scenario.ts';

const SCULPTOR: Player = { id: 'session-1', token: 'token-1', name: 'Sculptor' };

const RAISING = 1;
const LOWERING = -1;

/** Cells each world's wire-legal script writes; an ack without terrain fails here. */
const CELLS_WRITTEN: Record<GoldenWorldName, number> = {
  'genesis-noise': 1370,
  arch: 868,
  terrace: 958,
  shoreline: 867,
  played: 790,
};

/** `anchor: 'free'` and `spill: 'free'` are library paths; no intent can ask for them. */
function isWireLegal(step: StrokeScriptStep): boolean {
  if (!SCULPT_TOOLS.includes(step.tool as (typeof SCULPT_TOOLS)[number])) return false;
  return step.anchor !== 'free' && step.spill !== 'free';
}

function resolveBand(scenario: Scenario, step: StrokeScriptStep, band: ScriptBand): number | null {
  if (band === null || band === undefined) return null;
  if (typeof band === 'number') return band;
  return drawnBandOfSample(scenario.world.heightAt(step.cx, step.cy)) + band.fromClick;
}

function inBandRange(band: number | null): boolean {
  return band !== null && band >= MIN_BAND && band <= MAX_BAND;
}

function intentFor(
  scenario: Scenario,
  step: StrokeScriptStep,
  seq: number,
): Record<string, unknown> | null {
  const dir = step.tool === 'carve' ? LOWERING : step.amount < 0 ? LOWERING : RAISING;
  const targetBand = step.tool === 'drag' ? resolveBand(scenario, step, step.targetBand ?? null) : null;
  const spanBand = step.tool === 'carve' ? resolveBand(scenario, step, step.spanBand ?? null) : null;

  if (step.tool === 'drag' && !inBandRange(targetBand)) return null;
  if (step.tool === 'carve' && !inBandRange(spanBand)) return null;

  return {
    x: step.cx,
    y: step.cy,
    radius: step.radius,
    dir,
    tool: step.tool,
    seq,
    ...(step.profile !== undefined && step.tool === 'stamp' ? { profile: step.profile } : {}),
    ...(targetBand !== null
      ? { targetBand, floorBand: runFloorBandAt(scenario.world.map, step.cx, step.cy, targetBand) }
      : {}),
    ...(spanBand !== null ? { spanBand } : {}),
    ...(step.sweepFrom != null && step.tool === 'drag'
      ? { fromX: step.sweepFrom.x, fromY: step.sweepFrom.y }
      : {}),
  };
}

describe.each(GOLDEN_WORLD_NAMES)('the golden stroke script replays through the pipeline on %s', (
  world: GoldenWorldName,
) => {
  it('applies and acks every wire-legal stroke, with no refusal and no fault', () => {
    const scenario = new Scenario({
      terrain: world,
      unlocked: EVERY_CHUNK,
      owned: EVERY_CHUNK,
      players: [SCULPTOR],
    });

    const refused: string[] = [];
    const applied: string[] = [];
    let seq = 0;
    let cells = 0;

    for (const step of scriptFor(world)) {
      if (!isWireLegal(step)) continue;
      const message = intentFor(scenario, step, ++seq);
      if (message === null) continue;

      const outcome = scenario.sendContained(SCULPTOR, sculptMessage(message));
      expect(outcome.faulted).toBe(false);
      if (outcome.outcome?.applied === true) {
        applied.push(step.name);
        cells += outcome.outcome.diff.length;
        expect(entriesOfKind(outcome.entries, 'ack')).toEqual([
          { kind: 'ack', to: SCULPTOR.id, seq },
        ]);
      } else {
        refused.push(step.name);
      }
    }

    expect(refused).toEqual([]);
    expect(applied.length).toBeGreaterThan(0);
    expect(cells).toBe(CELLS_WRITTEN[world]);
    expect(scenario.world.dirty).toBe(true);
  });
});
