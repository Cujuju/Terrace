import {
  CHUNK_SIZE,
  chunksPerEdge,
  createChunkMask,
  spanAt,
  spanCount,
  type CellDiff,
  type ChunkPayload,
  type ChunkUnlockMessage,
  type Heightmap,
  type SculptAppliedMessage,
  type SculptDeniedMessage,
  type SculptDeniedReason,
  type Span,
  type TerrainDiffMessage,
} from '@terrace/shared';
import {
  buildGoldenWorld,
  GOLDEN_WORLD_SIZE,
  type GoldenWorldName,
} from '../../../shared/test/fixtures/worlds.ts';
import {
  handleSculptIntent,
  refuseFaultedSculpt,
  type IntentOutcome,
  type IntentPipelineDeps,
} from '../../src/intent/pipeline.ts';
import {
  containRoomMessage,
  LogThrottle,
  ROOM_FAILURE_LOG_INTERVAL_MS,
} from '../../src/net/contain-message.ts';
import type { MessageSink } from '../../src/net/message-sink.ts';
import { PluginHost } from '../../src/plugins/host.ts';
import type { TerracePlugin } from '../../src/plugins/types.ts';
import type { Player } from '../../src/player.ts';
import { World } from '../../src/world/world.ts';
import { asLoadedPlugin, RecordingSink, TEST_WORLD_NAME } from './harness.ts';

export type ChunkRef = readonly [number, number];

/** A flat world of the fixture grid size, for scenarios that need no terrain. */
export const FLAT_TERRAIN = 'flat';

export type ScenarioTerrain = GoldenWorldName | typeof FLAT_TERRAIN;

export const SCENARIO_WORLD_SIZE = GOLDEN_WORLD_SIZE;

const SCENARIO_CHUNKS_PER_EDGE = chunksPerEdge(SCENARIO_WORLD_SIZE);

export const EVERY_CHUNK: readonly ChunkRef[] = (() => {
  const chunks: ChunkRef[] = [];
  for (let cy = 0; cy < SCENARIO_CHUNKS_PER_EDGE; cy++) {
    for (let cx = 0; cx < SCENARIO_CHUNKS_PER_EDGE; cx++) chunks.push([cx, cy]);
  }
  return chunks;
})();

export interface ScenarioSpec {
  readonly terrain: ScenarioTerrain;
  /** Chunks in the world's union mask: what the server simulates. */
  readonly unlocked: readonly ChunkRef[];
  /** Chunks every player's token owns. Fewer than `unlocked` leaves frontier to open. */
  readonly owned: readonly ChunkRef[];
  readonly players: readonly Player[];
  readonly plugins?: readonly TerracePlugin[];
  readonly difficulty?: number;
}

export type TranscriptEntry =
  | { readonly kind: 'diff'; readonly to: string; readonly cells: readonly CellDiff[] }
  | {
      readonly kind: 'chunks';
      readonly to: string;
      readonly chunks: readonly ChunkRef[];
      readonly payloads: readonly ChunkPayload[];
    }
  | { readonly kind: 'ack'; readonly to: string; readonly seq: number }
  | {
      readonly kind: 'nack';
      readonly to: string;
      readonly seq: number;
      readonly reason?: SculptDeniedReason;
      readonly detail?: string;
    }
  | { readonly kind: 'plugin'; readonly to: string; readonly type: string; readonly payload: unknown };

/** What one message through the pipeline produced. `outcome` is null when the handler faulted. */
export interface ScenarioStep {
  readonly outcome: IntentOutcome | null;
  readonly faulted: boolean;
  readonly entries: readonly TranscriptEntry[];
}

/** A terrain-engine fault, optionally leaving a half-applied height behind it. */
export interface ScenarioFault {
  readonly message: string;
  readonly halfAppliedHeight?: number;
}

function columnSpansOf(map: Heightmap): Map<number, Span[]> {
  const columns = new Map<number, Span[]>();
  for (const index of map.columnSpans.keys()) {
    const x = index % map.size;
    const y = (index - x) / map.size;
    const spans: Span[] = [];
    for (let k = 0; k < spanCount(map, x, y); k++) spans.push(spanAt(map, x, y, k));
    columns.set(index, spans);
  }
  return columns;
}

function terrainOf(terrain: ScenarioTerrain): Heightmap | null {
  return terrain === FLAT_TERRAIN ? null : buildGoldenWorld(terrain);
}

export function chunkOfCell(cell: number): number {
  return Math.floor(cell / CHUNK_SIZE);
}

function chunkRefsOf(message: ChunkUnlockMessage): ChunkRef[] {
  return message.chunks.map((chunk) => [chunk.cx, chunk.cy] as ChunkRef);
}

function entryOf(target: string, type: string, payload: unknown): TranscriptEntry {
  switch (type) {
    case 'terrainDiff':
      return { kind: 'diff', to: target, cells: (payload as TerrainDiffMessage).cells };
    case 'chunkUnlock': {
      const unlock = payload as ChunkUnlockMessage;
      return { kind: 'chunks', to: target, chunks: chunkRefsOf(unlock), payloads: unlock.chunks };
    }
    case 'sculptApplied':
      return { kind: 'ack', to: target, seq: (payload as SculptAppliedMessage).seq };
    case 'sculptDenied': {
      const denial = payload as SculptDeniedMessage;
      return {
        kind: 'nack',
        to: target,
        seq: denial.seq,
        ...(denial.reason !== undefined ? { reason: denial.reason } : {}),
        ...(denial.detail !== undefined ? { detail: denial.detail } : {}),
      };
    }
    default:
      return { kind: 'plugin', to: target, type, payload };
  }
}

const NO_FAULT = null;

/**
 * One headless world, plugin chain and player set, driving real sculpt intents
 * through the real pipeline and recording what the wire carried.
 */
export class Scenario {
  readonly world: World;

  readonly host: PluginHost;

  readonly sink: RecordingSink;

  /** Every entry this scenario has produced, in send order. */
  readonly transcript: TranscriptEntry[] = [];

  private readonly faultThrottle = new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS);

  private pendingFault: ScenarioFault | null = NO_FAULT;

  private readonly strandedDiffPlayers = new Set<string>();

  constructor(spec: ScenarioSpec) {
    const map = terrainOf(spec.terrain);
    const size = map?.size ?? SCENARIO_WORLD_SIZE;
    this.world = World.restore(
      size,
      map?.cells ?? new Int16Array(size * size),
      createChunkMask(size),
      spec.difficulty,
      TEST_WORLD_NAME,
      new Map(),
      0,
      null,
      map === null ? new Map() : columnSpansOf(map),
    );

    this.sink = new RecordingSink();
    this.world.setSink(this.wrapSink(this.sink));
    for (const [cx, cy] of spec.unlocked) this.world.unlockChunk(cx, cy);

    this.host = new PluginHost(this.world, (spec.plugins ?? []).map(asLoadedPlugin));
    this.host.worldCreate();

    for (const player of spec.players) {
      this.world.addPlayer(player);
      for (const [cx, cy] of spec.owned) this.world.seedChunkForToken(player.token, cx, cy);
      this.host.playerJoined(player);
    }
    // Setup dirtied the world; from here `dirty` means a sent intent changed it.
    this.world.markSnapshotted();
    this.sink.clear();
  }

  /** Fails `World.applySculpt` once, the way a terrain-engine fault does. */
  failNextSculpt(fault: ScenarioFault): void {
    this.pendingFault = fault;
  }

  /** Makes this player's terrainDiff sends throw, so only a resync can reach them. */
  strandDiffsFor(playerId: string): void {
    this.strandedDiffPlayers.add(playerId);
  }

  tick(dt: number): void {
    this.host.tick(dt);
  }

  /** Sends one sculpt message and returns what it produced. A fault escapes. */
  send(player: Player, message: unknown): ScenarioStep {
    this.sink.clear();
    const outcome = handleSculptIntent(this.deps(), player, message);
    return { outcome, faulted: false, entries: this.collect() };
  }

  /**
   * Sends one sculpt message the way the room does: contained, and refused with
   * a server-fault nack plus a footprint resync when the handler throws.
   */
  sendContained(player: Player, message: unknown): ScenarioStep {
    this.sink.clear();
    let outcome: IntentOutcome | null = null;
    let faulted = true;
    containRoomMessage(
      'sculpt',
      this.faultThrottle,
      () => {
        outcome = handleSculptIntent(this.deps(), player, message);
        faulted = false;
      },
      () => {
        refuseFaultedSculpt(this.world, message, (denial) => {
          this.world.sendTo(player.id, denial);
        });
      },
    );
    return { outcome, faulted, entries: this.collect() };
  }

  private collect(): TranscriptEntry[] {
    const entries = this.sink.messages.map((message) =>
      entryOf(message.target, message.type, message.payload),
    );
    this.transcript.push(...entries);
    this.sink.clear();
    return entries;
  }

  private deps(): IntentPipelineDeps {
    return { world: this.faultingWorld(), interceptors: this.host };
  }

  private faultingWorld(): World {
    if (this.pendingFault === NO_FAULT) return this.world;
    const fault = this.pendingFault;
    this.pendingFault = NO_FAULT;
    const world = this.world;
    return new Proxy(world, {
      get(target, property, receiver): unknown {
        if (property === 'applySculpt') {
          return (x: number, y: number): never => {
            if (fault.halfAppliedHeight !== undefined) {
              target.map.cells[y * target.size + x] = fault.halfAppliedHeight;
            }
            throw new Error(fault.message);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private wrapSink(sink: RecordingSink): MessageSink {
    const stranded = this.strandedDiffPlayers;
    return {
      broadcast: (type, payload) => sink.broadcast(type, payload),
      sendTo: (target, type, payload) => {
        if (type === 'terrainDiff' && stranded.has(target)) {
          throw new Error(`socket for ${target} is already closed`);
        }
        sink.sendTo(target, type, payload);
      },
    };
  }
}

export function entriesOfKind<K extends TranscriptEntry['kind']>(
  entries: readonly TranscriptEntry[],
  kind: K,
): Extract<TranscriptEntry, { kind: K }>[] {
  return entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: K }> => entry.kind === kind,
  );
}

export function pluginEntries(
  entries: readonly TranscriptEntry[],
  type: string,
): Extract<TranscriptEntry, { kind: 'plugin' }>[] {
  return entriesOfKind(entries, 'plugin').filter((entry) => entry.type === type);
}

/** The wire shape a scenario asserts on: who got what, in order. */
export function wireOrder(entries: readonly TranscriptEntry[]): [string, string][] {
  return entries.map((entry) => [
    entry.to,
    entry.kind === 'plugin' ? entry.type : entry.kind,
  ]);
}

/** An independent oracle for the resync bound: the diff's chunks, dilated by the halo. */
export function resyncChunksOfDiff(
  worldSize: number,
  diff: readonly CellDiff[],
  halo: number,
): ChunkRef[] {
  const edge = chunksPerEdge(worldSize);
  const keys = new Set<number>();
  for (const cell of diff) {
    const cx = chunkOfCell(cell.x);
    const cy = chunkOfCell(cell.y);
    for (let hy = -halo; hy <= halo; hy++) {
      for (let hx = -halo; hx <= halo; hx++) {
        const nx = cx + hx;
        const ny = cy + hy;
        if (nx < 0 || ny < 0 || nx >= edge || ny >= edge) continue;
        keys.add(ny * edge + nx);
      }
    }
  }
  return [...keys]
    .sort((a, b) => a - b)
    .map((key) => [key % edge, (key - (key % edge)) / edge] as ChunkRef);
}

/** Untyped on purpose: these messages feed a validator whose input is `unknown`. */
export function sculptMessage(overrides: Record<string, unknown>): unknown {
  return { type: 'sculpt', radius: 1, dir: 1, ...overrides };
}
