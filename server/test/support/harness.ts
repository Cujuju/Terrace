import { createChunkMask, createHeightmap, chunkIndex, unlockChunk } from '@terrace/shared';
import type { MessageSink } from '../../src/net/message-sink.ts';
import type {
  LoadedPlugin,
  SiblingModule,
  TerracePlugin,
  WorldApi,
} from '../../src/plugins/types.ts';
import { World } from '../../src/world/world.ts';

export interface RecordedMessage {
  readonly target: string;
  readonly type: string;
  readonly payload: unknown;
}

export class RecordingSink implements MessageSink {
  readonly messages: RecordedMessage[] = [];

  broadcast(type: string, payload: unknown): void {
    this.messages.push({ target: 'broadcast', type, payload });
  }

  sendTo(playerId: string, type: string, payload: unknown): void {
    this.messages.push({ target: playerId, type, payload });
  }

  ofType(type: string): RecordedMessage[] {
    return this.messages.filter((message) => message.type === type);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export const TEST_WORLD_NAME = 'Testfall';

export function worldWithUnlockedChunks(
  size: number,
  chunks: ReadonlyArray<readonly [number, number]>,
  difficulty?: number,
  fillHeight?: number,
): World {
  const mask = createChunkMask(size);
  for (const [cx, cy] of chunks) {
    unlockChunk(mask, chunkIndex(size, cx, cy));
  }
  const cells = createHeightmap(size).cells;
  if (fillHeight !== undefined) cells.fill(fillHeight);
  return World.restore(size, cells, mask, difficulty, TEST_WORLD_NAME);
}

export function asLoadedPlugin(plugin: TerracePlugin): LoadedPlugin {
  return {
    plugin,
    exports: {},
    directory: plugin.name,
    entryPath: `<test>/${plugin.name}/server/index.ts`,
    version: '0.0.0+test',
  };
}

export function asLoadedPluginExporting(
  plugin: TerracePlugin,
  exports: SiblingModule,
): LoadedPlugin {
  return { ...asLoadedPlugin(plugin), exports };
}

export function worldWithSibling(name: string, exports: SiblingModule | null): WorldApi {
  return new Proxy({} as WorldApi, {
    get(_target, property): unknown {
      if (property === 'sibling') {
        return (asked: string): SiblingModule | null => (asked === name ? exports : null);
      }
      throw new Error(
        `this test world answers only WorldApi.sibling, not WorldApi.${String(property)}`,
      );
    },
  });
}

export function grantTokenEveryUnlockedChunk(world: World, token: string): void {
  const edge = world.chunksPerEdge;
  for (let cy = 0; cy < edge; cy++) {
    for (let cx = 0; cx < edge; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) continue;
      world.unlockChunkForToken(token, cx, cy);
    }
  }
}

/** A span as schema 1 stored it: floor and ceiling both raw heights. */
export interface RawFloorSpan {
  readonly floor: number;
  readonly ceiling: number;
}

const V1_BYTES_PER_HEIGHT = 2;
const V1_BYTES_PER_RECORD_HEADER = 4 + 2;

/**
 * Packs a span table the way schema 1 wrote it, so a test can plant a genuine
 * v1 blob rather than trusting the current encoder to still emit one.
 */
export function packRawFloorColumnSpans(
  columns: ReadonlyMap<number, readonly RawFloorSpan[]>,
): Buffer {
  const indices = Array.from(columns.keys()).sort((a, b) => a - b);
  let totalBytes = 0;
  for (const i of indices) {
    totalBytes +=
      V1_BYTES_PER_RECORD_HEADER + columns.get(i)!.length * 2 * V1_BYTES_PER_HEIGHT;
  }
  const buffer = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const i of indices) {
    const spans = columns.get(i)!;
    buffer.writeInt32LE(i, offset);
    offset += 4;
    buffer.writeUInt16LE(spans.length, offset);
    offset += 2;
    for (const span of spans) {
      buffer.writeInt16LE(span.floor, offset);
      offset += V1_BYTES_PER_HEIGHT;
      buffer.writeInt16LE(span.ceiling, offset);
      offset += V1_BYTES_PER_HEIGHT;
    }
  }
  return buffer;
}
