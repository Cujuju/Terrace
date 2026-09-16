import { CHUNK_SIZE, chunkHeightsAsCells, type ChunkPayload } from '@terrace/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Player } from '../src/player.ts';
import { MESH_SEAM_HALO_CHUNKS } from '../src/world/sculpt-service.ts';
import {
  chunkOfCell,
  entriesOfKind,
  EVERY_CHUNK,
  resyncChunksOfDiff,
  Scenario,
  sculptMessage,
  wireOrder,
} from './support/scenario.ts';

const SCULPTOR: Player = { id: 'session-1', token: 'token-1', name: 'Sculptor' };
const WATCHER: Player = { id: 'session-2', token: 'token-2', name: 'Watcher' };

const FAULT = 'terrain engine fault';
const SEQ = 9;
const HALF_APPLIED_HEIGHT = 77;

/** Well inside the world, so a resync footprint is not clipped by an edge. */
const BRUSH = { x: 20, y: 32 } as const;

function openTerrace(players: readonly Player[] = [SCULPTOR]): Scenario {
  return new Scenario({
    terrain: 'terrace',
    unlocked: EVERY_CHUNK,
    owned: EVERY_CHUNK,
    players,
  });
}

function silenceErrors(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a faulted sculpt is contained, nacked and resynced', () => {
  it('lets nothing escape the room handler, and acks nothing that never landed', () => {
    silenceErrors();
    const scenario = openTerrace();
    scenario.failNextSculpt({ message: FAULT });

    const step = scenario.sendContained(
      SCULPTOR,
      sculptMessage({ ...BRUSH, seq: SEQ }),
    );

    expect(step.faulted).toBe(true);
    expect(step.outcome).toBeNull();
    expect(entriesOfKind(step.entries, 'ack')).toHaveLength(0);
    expect(entriesOfKind(step.entries, 'diff')).toHaveLength(0);
    expect(wireOrder(step.entries)).toEqual([
      [SCULPTOR.id, 'nack'],
      [SCULPTOR.id, 'chunks'],
    ]);
    expect(entriesOfKind(step.entries, 'nack')[0]).toEqual({
      kind: 'nack',
      to: SCULPTOR.id,
      seq: SEQ,
      reason: 'server-fault',
    });
  });

  it('resends the authoritative heights a half-applied edit left behind', () => {
    silenceErrors();
    const scenario = openTerrace();
    scenario.failNextSculpt({ message: FAULT, halfAppliedHeight: HALF_APPLIED_HEIGHT });

    const step = scenario.sendContained(SCULPTOR, sculptMessage({ ...BRUSH, seq: SEQ }));

    expect(scenario.world.heightAt(BRUSH.x, BRUSH.y)).toBe(HALF_APPLIED_HEIGHT);
    const resync = entriesOfKind(step.entries, 'chunks')[0]!;
    expect(resync.chunks).toContainEqual([chunkOfCell(BRUSH.x), chunkOfCell(BRUSH.y)]);

    const payload = resync.payloads.find(
      (chunk) => chunk.cx === chunkOfCell(BRUSH.x) && chunk.cy === chunkOfCell(BRUSH.y),
    )!;
    expect(heightInChunk(payload, BRUSH.x, BRUSH.y)).toBe(HALF_APPLIED_HEIGHT);
  });

  it('stays silent when the faulted message carries no routable seq', () => {
    silenceErrors();
    const scenario = openTerrace();
    scenario.failNextSculpt({ message: FAULT });

    const step = scenario.sendContained(SCULPTOR, sculptMessage(BRUSH));

    expect(step.faulted).toBe(true);
    expect(entriesOfKind(step.entries, 'nack')).toHaveLength(0);
    expect(entriesOfKind(step.entries, 'chunks').length).toBeGreaterThan(0);
  });

  it('leaves the next stroke of the same session unharmed', () => {
    silenceErrors();
    const scenario = openTerrace();
    scenario.failNextSculpt({ message: FAULT });
    expect(scenario.sendContained(SCULPTOR, sculptMessage({ ...BRUSH, seq: SEQ })).faulted)
      .toBe(true);

    const next = scenario.sendContained(SCULPTOR, sculptMessage({ ...BRUSH, seq: SEQ + 1 }));

    expect(next.faulted).toBe(false);
    expect(next.outcome?.applied).toBe(true);
    expect(wireOrder(next.entries)).toEqual([
      [SCULPTOR.id, 'diff'],
      [SCULPTOR.id, 'ack'],
    ]);
  });
});

describe('a stranded diff is resynced to exactly the chunks the diff touched', () => {
  it('bounds the resync by the diff, not by the brush, and spares the other viewer', () => {
    silenceErrors();
    const scenario = openTerrace([SCULPTOR, WATCHER]);
    scenario.strandDiffsFor(SCULPTOR.id);

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({ ...BRUSH, radius: 4, tool: 'smooth', dir: -1, seq: SEQ }),
    );

    expect(step.outcome?.applied).toBe(true);
    const diff = step.outcome?.applied === true ? step.outcome.diff : [];
    const spannedChunks = new Set(
      diff.map((cell) => `${chunkOfCell(cell.x)},${chunkOfCell(cell.y)}`),
    );
    expect(spannedChunks.size).toBeGreaterThan(1);

    expect(entriesOfKind(step.entries, 'diff').map((entry) => entry.to)).toEqual([WATCHER.id]);

    const resyncs = entriesOfKind(step.entries, 'chunks');
    expect(resyncs.map((entry) => entry.to)).toEqual([SCULPTOR.id]);
    expect(resyncs[0]!.chunks).toEqual(
      resyncChunksOfDiff(scenario.world.size, diff, MESH_SEAM_HALO_CHUNKS),
    );
  });
});

function heightInChunk(payload: ChunkPayload, x: number, y: number): number {
  const heights = chunkHeightsAsCells(payload.heights);
  return heights[(y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE)]!;
}
