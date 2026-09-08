import {
  applySculpt,
  BAND_HEIGHT,
  buildFreshwaterMap,
  CHUNK_SIZE,
  NEIGHBOURHOOD_CELLS,
  cellX,
  cellY,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  clearColumns,
  RiverNetworkIndex,
  createChunkMask,
  createHeightmap,
  heightAt,
  isChunkUnlocked,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  SEA_LEVEL,
  setColumn,
  simMillisAtRealTime,
  SpringIndex,
  unlockChunk,
  type CellDiff,
  type ChunkPayload,
  type FreshwaterMap,
  type Heightmap,
  type RiverNetwork,
  type SculptOptions,
  type ServerMessage,
  type Span,
} from '@terrace/shared';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../config.ts';
import { NULL_SINK, type MessageSink } from '../net/message-sink.ts';
import type { Player } from '../player.ts';
import {
  FRESH_SEABED_HEIGHT,
  buildFreshGenesisTerrain,
  carveFallbackAbyss,
  drawGenesisSeed,
  freshGenesisHeightAt,
} from './genesis.ts';
import { applyInitialUnlock } from './initial-unlock.ts';
import { chunkPayloadOf, collectUnlockedChunkPayloads } from './mask-filter.ts';
import { generateWorldName } from './world-name.ts';

function normalizeDifficulty(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WORLD_DIFFICULTY;
  const rounded = Math.round(value);
  if (rounded < MIN_WORLD_DIFFICULTY) return MIN_WORLD_DIFFICULTY;
  if (rounded > MAX_WORLD_DIFFICULTY) return MAX_WORLD_DIFFICULTY;
  return rounded;
}

export const RIVER_RECOMPUTE_INTERVAL_MS = 250;

const MILLISECONDS_PER_SECOND = 1000;

export class World {
  readonly map: Heightmap;
  readonly mask: Uint8Array;

  readonly difficulty: number;

  simMillis = 0;

  private genesisMillisValue: number | null = null;

  get genesisMillis(): number {
    return this.genesisMillisValue ?? 0;
  }

  anchorClockToRealTime(realMillis: number = Date.now()): void {
    const accumulatedAge = this.simMillis;
    this.simMillis = simMillisAtRealTime(realMillis);
    if (this.genesisMillisValue === null) {
      this.genesisMillisValue = Math.max(0, this.simMillis - accumulatedAge);
    }
  }

  private worldName: string;

  get name(): string {
    return this.worldName;
  }

  rename(next: string): void {
    if (next === this.worldName) return;
    this.worldName = next;
    this.changedSinceSnapshot = true;
  }

  private sink: MessageSink = NULL_SINK;
  private readonly playersById = new Map<string, Player>();

  private readonly masksByToken = new Map<string, Uint8Array>();

  private changedSinceSnapshot = false;

  private riverNetworkCache: RiverNetwork | null = null;
  private riverNetworkComputedAtMs = Number.NEGATIVE_INFINITY;
  private riverNetworkStale = true;

  private freshwaterCache: FreshwaterMap | null = null;
  private freshwaterCacheNetwork: RiverNetwork | null = null;

  private readonly isCellUnlockedHere = (x: number, y: number): boolean => this.isCellUnlocked(x, y);

  private readonly springIndex: SpringIndex;

  private readonly riverIndex: RiverNetworkIndex;

  private constructor(
    map: Heightmap,
    mask: Uint8Array,
    difficulty: number,
    name: string,
    simMillis = 0,
  ) {
    this.map = map;
    this.mask = mask;
    this.difficulty = difficulty;
    this.worldName = name;
    this.simMillis = simMillis;
    this.springIndex = new SpringIndex(this.map, this.isCellUnlockedHere);
    this.riverIndex = new RiverNetworkIndex(this.map, this.isCellUnlockedHere);
  }

  advanceClock(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.simMillis += Math.round(dt * MILLISECONDS_PER_SECOND);
  }

  static createFresh(
    size: number,
    difficulty: number = DEFAULT_WORLD_DIFFICULTY,
    name: string = generateWorldName(),
    seed: number = drawGenesisSeed(),
  ): World {
    const map = createHeightmap(size);
    const terrain = buildFreshGenesisTerrain(size, seed);

    let deepestHeight = MAX_HEIGHT;
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const height = freshGenesisHeightAt(terrain, x, y);
        map.cells[row + x] = height;
        if (height < deepestHeight) deepestHeight = height;
      }
    }

    if (deepestHeight > FRESH_SEABED_HEIGHT) {
      deepestHeight = carveFallbackAbyss(map, size);
    }

    if (deepestHeight > FRESH_SEABED_HEIGHT) {
      throw new Error(
        `fresh genesis produced no water at or below FRESH_SEABED_HEIGHT ` +
          `(deepest cell was ${deepestHeight}) — deep-water guarantee violated`,
      );
    }

    const world = new World(
      map,
      createChunkMask(size),
      normalizeDifficulty(difficulty),
      name,
    );
    applyInitialUnlock(world);
    world.changedSinceSnapshot = false;
    return world;
  }

  static restore(
    size: number,
    cells: Int16Array,
    mask: Uint8Array,
    difficulty: number = DEFAULT_WORLD_DIFFICULTY,
    name: string | null = null,
    tokenMasks: ReadonlyMap<string, Uint8Array> = new Map(),
    simMillis = 0,
    genesisMillis: number | null = null,
    columnSpans: ReadonlyMap<number, Span[]> = new Map(),
  ): World {
    const map = createHeightmap(size);
    if (cells.length !== map.cells.length) {
      throw new RangeError(
        `snapshot heightmap has ${cells.length} cells, world size ${size} needs ${map.cells.length}`,
      );
    }
    const expectedMask = createChunkMask(size);
    if (mask.length !== expectedMask.length) {
      throw new RangeError(
        `snapshot mask has ${mask.length} bytes, world size ${size} needs ${expectedMask.length}`,
      );
    }
    map.cells.set(cells);
    clearColumns(map);
    for (const [i, spans] of columnSpans) {
      setColumn(map, cellX(size, i), cellY(size, i), spans);
    }
    expectedMask.set(mask);

    const stored = name?.trim() ?? '';
    const mintedName = stored === '' ? generateWorldName() : null;
    const world = new World(
      map,
      expectedMask,
      normalizeDifficulty(difficulty),
      mintedName ?? stored,
      Number.isInteger(simMillis) && simMillis >= 0 ? simMillis : 0,
    );
    if (genesisMillis !== null && Number.isInteger(genesisMillis) && genesisMillis >= 0) {
      world.genesisMillisValue = genesisMillis;
    }

    for (const [token, tokenMask] of tokenMasks) {
      if (tokenMask.length !== expectedMask.length) continue;
      const copy = createChunkMask(size);
      copy.set(tokenMask);
      world.masksByToken.set(token, copy);
    }

    if (mintedName !== null) world.changedSinceSnapshot = true;
    return world;
  }

  get size(): number {
    return this.map.size;
  }

  get chunksPerEdge(): number {
    return chunksPerEdge(this.map.size);
  }

  get dirty(): boolean {
    return this.changedSinceSnapshot;
  }

  markSnapshotted(): void {
    this.changedSinceSnapshot = false;
  }

  markSnapshotFailed(): void {
    this.changedSinceSnapshot = true;
  }

  rewindTo(
    cells: Int16Array,
    mask: Uint8Array,
    tokenMasks: ReadonlyMap<string, Uint8Array> = new Map(),
    columnSpans: ReadonlyMap<number, Span[]> = new Map(),
  ): void {
    if (cells.length !== this.map.cells.length) {
      throw new RangeError(
        `restore point holds ${cells.length} cells, this ${this.size}² world needs ` +
          `${this.map.cells.length}`,
      );
    }
    if (mask.length !== this.mask.length) {
      throw new RangeError(
        `restore point holds a ${mask.length}-byte mask, this ${this.size}² world needs ` +
          `${this.mask.length}`,
      );
    }

    this.map.cells.set(cells);
    clearColumns(this.map);
    for (const [i, spans] of columnSpans) {
      setColumn(this.map, cellX(this.size, i), cellY(this.size, i), spans);
    }
    this.mask.set(mask);

    this.masksByToken.clear();
    for (const [token, tokenMask] of tokenMasks) {
      if (tokenMask.length !== this.mask.length) continue;
      const copy = createChunkMask(this.size);
      copy.set(tokenMask);
      this.masksByToken.set(token, copy);
    }

    this.riverNetworkCache = null;
    this.riverNetworkComputedAtMs = Number.NEGATIVE_INFINITY;
    this.riverNetworkStale = true;
    this.springIndex.markStale();
    this.riverIndex.markStale();
    this.freshwaterCache = null;
    this.freshwaterCacheNetwork = null;

    this.changedSinceSnapshot = true;
  }

  setSink(sink: MessageSink): void {
    this.sink = sink;
  }

  broadcast(message: ServerMessage): void {
    this.sink.broadcast(message.type, message);
  }

  sendTo(playerId: string, message: ServerMessage): void {
    this.sink.sendTo(playerId, message.type, message);
  }

  broadcastRaw(type: string, payload: unknown): void {
    this.sink.broadcast(type, payload);
  }

  sendRawTo(playerId: string, type: string, payload: unknown): void {
    this.sink.sendTo(playerId, type, payload);
  }

  heightAt(x: number, y: number): number {
    return heightAt(this.map, x, y);
  }

  isChunkUnlocked(cx: number, cy: number): boolean {
    return isChunkUnlocked(this.mask, chunkIndex(this.map.size, cx, cy));
  }

  isCellUnlocked(x: number, y: number): boolean {
    return isChunkUnlocked(this.mask, chunkIndexOfCell(this.map.size, x, y));
  }

  unlockChunk(cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    if (isChunkUnlocked(this.mask, index)) return false;

    unlockChunk(this.mask, index);
    this.changedSinceSnapshot = true;
    this.noteChunkBecameActive(cx, cy);
    this.broadcast({ type: 'chunkUnlock', chunks: [chunkPayloadOf(this, cx, cy)] });
    return true;
  }

  private noteChunkBecameActive(cx: number, cy: number): void {
    const minX = cx * CHUNK_SIZE;
    const minY = cy * CHUNK_SIZE;
    this.springIndex.noteRegionChanged(minX, minY, minX + CHUNK_SIZE - 1, minY + CHUNK_SIZE - 1);
    this.riverIndex.noteRegionChanged(minX, minY, minX + CHUNK_SIZE - 1, minY + CHUNK_SIZE - 1);
    this.riverNetworkStale = true;
  }

  private maskForToken(token: string): Uint8Array {
    let tokenMask = this.masksByToken.get(token);
    if (tokenMask === undefined) {
      tokenMask = createChunkMask(this.map.size);
      this.masksByToken.set(token, tokenMask);
    }
    return tokenMask;
  }

  private grantChunkToToken(token: string, cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    const tokenMask = this.maskForToken(token);
    if (isChunkUnlocked(tokenMask, index)) return false;

    unlockChunk(tokenMask, index);
    this.changedSinceSnapshot = true;
    const wasUnionLocked = !isChunkUnlocked(this.mask, index);
    unlockChunk(this.mask, index);
    if (wasUnionLocked) this.noteChunkBecameActive(cx, cy);
    return true;
  }

  seedChunkForToken(token: string, cx: number, cy: number): boolean {
    return this.grantChunkToToken(token, cx, cy);
  }

  unlockChunkForToken(token: string, cx: number, cy: number): boolean {
    if (!this.grantChunkToToken(token, cx, cy)) return false;

    const message: ServerMessage = {
      type: 'chunkUnlock',
      chunks: [chunkPayloadOf(this, cx, cy)],
    };
    for (const player of this.players()) {
      if (player.token === token) this.sendTo(player.id, message);
    }
    return true;
  }

  isChunkUnlockedForToken(token: string, cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    const tokenMask = this.masksByToken.get(token);
    return tokenMask !== undefined && isChunkUnlocked(tokenMask, index);
  }

  isChunkVisibleTo(playerId: string, cx: number, cy: number): boolean {
    const player = this.getPlayer(playerId);
    return player !== undefined && this.isChunkUnlockedForToken(player.token, cx, cy);
  }

  isCellVisibleTo(playerId: string, x: number, y: number): boolean {
    return this.isChunkVisibleTo(
      playerId,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
    );
  }

  chunkPayloadsForToken(token: string): ChunkPayload[] {
    const tokenMask = this.masksByToken.get(token) ?? createChunkMask(this.map.size);
    return collectUnlockedChunkPayloads({ map: this.map, mask: tokenMask });
  }

  tokenMasks(): ReadonlyMap<string, Uint8Array> {
    return this.masksByToken;
  }

  heightsForPersistence(): Int16Array {
    return this.map.cells;
  }

  spansForPersistence(): ReadonlyMap<number, Int16Array> {
    return this.map.columnSpans;
  }

  applySculpt(
    x: number,
    y: number,
    radius: number,
    amount: number,
    options?: SculptOptions,
  ): CellDiff[] {
    const diff = applySculpt(this.map, x, y, radius, amount, options);
    if (diff.length > 0) {
      this.changedSinceSnapshot = true;
      this.springIndex.noteCellsChanged(diff);
      this.riverIndex.noteCellsChanged(diff);
      this.riverNetworkStale = true;
    }
    return diff;
  }

  riverNetwork(): RiverNetwork {
    const now = Date.now();
    if (
      this.riverNetworkCache === null ||
      (this.riverNetworkStale && now - this.riverNetworkComputedAtMs >= RIVER_RECOMPUTE_INTERVAL_MS)
    ) {
      this.riverNetworkCache = this.riverIndex.networkFrom(this.springIndex.springs());
      this.riverNetworkComputedAtMs = now;
      this.riverNetworkStale = false;
    }
    return this.riverNetworkCache;
  }

  freshwaterMap(): FreshwaterMap {
    const network = this.riverNetwork();
    if (this.freshwaterCache === null || this.freshwaterCacheNetwork !== network) {
      this.freshwaterCache = buildFreshwaterMap(network, this.size);
      this.freshwaterCacheNetwork = network;
    }
    return this.freshwaterCache;
  }

  addPlayer(player: Player): void {
    this.playersById.set(player.id, player);
  }

  removePlayer(playerId: string): Player | undefined {
    const player = this.playersById.get(playerId);
    this.playersById.delete(playerId);
    return player;
  }

  getPlayer(playerId: string): Player | undefined {
    return this.playersById.get(playerId);
  }

  players(): readonly Player[] {
    return Array.from(this.playersById.values());
  }
}
