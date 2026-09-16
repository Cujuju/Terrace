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
  type SculptIntent,
  type Span,
  type TerrainDiffMessage,
} from '@terrace/shared';
import {
  buildGoldenWorld,
  GOLDEN_WORLD_SIZE,
  type GoldenWorldName,
} from '../../../shared/test/fixtures/worlds.ts';
import type { IntentOutcome } from '../../src/intent/pipeline.ts';
import {
  containRoomMessage,
  LogThrottle,
  ROOM_FAILURE_LOG_INTERVAL_MS,
} from '../../src/net/contain-message.ts';
import type { MessageSink } from '../../src/net/message-sink.ts';
import type { TerraceClient } from '../../src/net/room-contract.ts';
import {
  handleSculptMessage,
  refuseSculptMessage,
  type SculptHandlerDeps,
} from '../../src/net/room-sculpt-handler.ts';
import { SculptRateLimiter } from '../../src/net/sculpt-rate-limit.ts';
import { PluginHost } from '../../src/plugins/host.ts';
import type { TerracePlugin } from '../../src/plugins/types.ts';
import type { Player } from '../../src/player.ts';
import type { WorldSession } from '../../src/world/session.ts';
import { World } from '../../src/world/world.ts';
import type { WorldManager } from '../../src/world/world-manager.ts';
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
  /** The room's own gate. Omit for one that never fires; pass one to assert it. */
  readonly rate?: SculptRateLimiter;
}

/** One second between sends refills the room's token bucket, so the gate never fires. */
const SCENARIO_SEND_SPACING_MS = 1000;

function permissiveRateLimiter(): SculptRateLimiter {
  let nowMs = 0;
  return new SculptRateLimiter({
    now: () => {
      nowMs += SCENARIO_SEND_SPACING_MS;
      return nowMs;
    },
  });
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

/**
 * How far one message got: refused by the room adapter, handed to the pipeline,
 * or thrown out of the handler.
 */
export type ScenarioReach = 'dropped' | 'pipeline' | 'faulted';

/**
 * What one message produced. `outcome` is null whenever production left no
 * evidence: a drop, a fault, or a refusal whose seq was unroutable.
 */
export interface ScenarioStep {
  readonly outcome: IntentOutcome | null;
  readonly reached: ScenarioReach;
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

/** What the pipeline handed the plugin chain, so a step reports its outcome verbatim. */
interface AppliedIntent {
  readonly intent: SculptIntent;
  readonly diff: CellDiff[];
}

class WatchingPluginHost extends PluginHost {
  private applied: AppliedIntent | null = null;

  override notifyIntentApplied(
    intent: SculptIntent,
    player: Player,
    diff: readonly CellDiff[],
  ): void {
    this.applied = { intent, diff: [...diff] };
    super.notifyIntentApplied(intent, player, diff);
  }

  forgetApplied(): void {
    this.applied = null;
  }

  appliedIntent(): AppliedIntent | null {
    return this.applied;
  }
}

/** The room's sculpt adapter reads only `manager.current`; nothing else is reachable. */
function scenarioManager(current: () => WorldSession): WorldManager {
  return new Proxy({} as WorldManager, {
    get(_target, property): unknown {
      if (property === 'current') return current();
      throw new Error(`this scenario manager answers only current, not ${String(property)}`);
    },
  });
}

function scenarioSession(world: () => World, host: PluginHost): WorldSession {
  return new Proxy({} as WorldSession, {
    get(_target, property): unknown {
      if (property === 'world') return world();
      if (property === 'host') return host;
      throw new Error(`this scenario session answers only world and host, not ${String(property)}`);
    },
  });
}

function scenarioClient(
  player: Player,
  send: (type: string, payload: unknown) => void,
): TerraceClient {
  return new Proxy({} as TerraceClient, {
    get(_target, property): unknown {
      if (property === 'sessionId') return player.id;
      if (property === 'userData') return { player };
      if (property === 'send') return send;
      throw new Error(
        `this scenario client answers only sessionId, userData and send, not ${String(property)}`,
      );
    },
  });
}

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

  private readonly watchingHost: WatchingPluginHost;

  private readonly sculptDeps: SculptHandlerDeps;

  private readonly faultThrottle = new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS);

  private pendingFault: ScenarioFault | null = NO_FAULT;

  private readonly strandedDiffPlayers = new Set<string>();

  /** Set when the adapter hands the pipeline a world, so a drop upstream is visible. */
  private pipelineEntered = false;

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

    this.watchingHost = new WatchingPluginHost(this.world, (spec.plugins ?? []).map(asLoadedPlugin));
    this.host = this.watchingHost;
    this.host.worldCreate();

    const session = scenarioSession(() => {
      this.pipelineEntered = true;
      return this.faultingWorld();
    }, this.watchingHost);
    this.sculptDeps = {
      manager: scenarioManager(() => session),
      rate: spec.rate ?? permissiveRateLimiter(),
      rewriteLog: new LogThrottle(ROOM_FAILURE_LOG_INTERVAL_MS),
    };

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

  /** Sends one sculpt message through the room's own adapter. A fault escapes. */
  send(player: Player, message: unknown): ScenarioStep {
    this.armSend();
    handleSculptMessage(this.sculptDeps, this.clientFor(player), message);
    const entries = this.collect();
    return {
      outcome: this.outcomeOf(entries),
      reached: this.reach(false),
      faulted: false,
      entries,
    };
  }

  /**
   * Sends one sculpt message the way the room does: contained, and refused with
   * a server-fault nack plus a footprint resync when the handler throws.
   */
  sendContained(player: Player, message: unknown): ScenarioStep {
    this.armSend();
    const client = this.clientFor(player);
    let faulted = true;
    containRoomMessage(
      'sculpt',
      this.faultThrottle,
      () => {
        handleSculptMessage(this.sculptDeps, client, message);
        faulted = false;
      },
      () => {
        refuseSculptMessage(this.sculptDeps, client, message);
      },
    );
    const entries = this.collect();
    return {
      outcome: faulted ? null : this.outcomeOf(entries),
      reached: this.reach(faulted),
      faulted,
      entries,
    };
  }

  private reach(faulted: boolean): ScenarioReach {
    if (faulted) return 'faulted';
    return this.pipelineEntered ? 'pipeline' : 'dropped';
  }

  private armSend(): void {
    this.sink.clear();
    this.watchingHost.forgetApplied();
    this.pipelineEntered = false;
  }

  private clientFor(player: Player): TerraceClient {
    return scenarioClient(player, (type, payload) => {
      this.sink.sendTo(player.id, type, payload);
    });
  }

  /**
   * The verdict, read back from what production exposed: the applied intent the
   * plugin chain was handed, else the nack on the wire.
   */
  private outcomeOf(entries: readonly TranscriptEntry[]): IntentOutcome | null {
    const applied = this.watchingHost.appliedIntent();
    if (applied !== null) return { applied: true, intent: applied.intent, diff: applied.diff };

    const nack = entriesOfKind(entries, 'nack').at(-1);
    if (nack?.reason === undefined) return null;
    return nack.detail === undefined
      ? { applied: false, reason: nack.reason }
      : { applied: false, reason: nack.reason, detail: nack.detail };
  }

  private collect(): TranscriptEntry[] {
    const entries = this.sink.messages.map((message) =>
      entryOf(message.target, message.type, message.payload),
    );
    this.transcript.push(...entries);
    this.sink.clear();
    return entries;
  }

  private faultingWorld(): World {
    if (this.pendingFault === NO_FAULT) return this.world;
    const fault = this.pendingFault;
    const spend = (): void => {
      this.pendingFault = NO_FAULT;
    };
    const world = this.world;
    return new Proxy(world, {
      get(target, property, receiver): unknown {
        if (property === 'applySculpt') {
          return (x: number, y: number): never => {
            spend();
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
