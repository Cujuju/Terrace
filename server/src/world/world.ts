// The World — the single authoritative world object owned by the process
// (design §3.2, glossary §7). It owns exactly three things: the heightmap, the
// unlocked-chunk mask, and the connected players.
//
// It knows NOTHING about Colyseus. Outgoing traffic goes through a MessageSink,
// which the room installs. That is what makes "a rooms layer could be added
// later without rework" true, and it is what lets the whole intent pipeline be
// unit-tested with no network.

import {
  applySculpt,
  BAND_HEIGHT,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  heightAt,
  isChunkUnlocked,
  SEA_LEVEL,
  unlockChunk,
  type CellDiff,
  type Heightmap,
  type SculptOptions,
  type ServerMessage,
} from '@terrace/shared';
import { NULL_SINK, type MessageSink } from '../net/message-sink.ts';
import type { Player } from '../player.ts';
import { applyInitialUnlock } from './initial-unlock.ts';
import { chunkPayloadOf } from './mask-filter.ts';

/**
 * Depth of a FRESH world's seabed, in terrace bands below sea level.
 * Decided 2026-08-14 with the owner (see docs/DESIGN.md): a brand-new world is
 * an OCEAN, not a flat shoreline at exactly sea level.
 *
 * WHY THREE, AND WHY THIS EXACT NUMBER IS NOT ARBITRARY.
 *
 * `createHeightmap` allocates an all-zero grid, and SEA_LEVEL is 0, so before
 * this every cell of a fresh world sat EXACTLY at the waterline: the sea had
 * zero depth everywhere. Anything that classifies water by depth therefore had
 * nothing to classify — the wildlife plugin's deep-water habitat begins
 * `DEEP_WATER_BANDS_BELOW_SEA` (3) bands down, so whales and deep-sea creatures
 * had literally nowhere to exist until a player hand-dug a trench. That was the
 * defect this constant fixes, and the fix is only correct if the fresh seabed
 * REACHES that threshold, so three is chosen to satisfy:
 *
 *     FRESH_SEABED_BANDS_BELOW_SEA >= DEEP_WATER_BANDS_BELOW_SEA
 *
 * Core cannot import that plugin constant — plugins depend on core, never the
 * reverse — so the relation is asserted from the plugin side instead
 * (plugins/wildlife/test/wildlife.test.ts, "a fresh world is deep-water habitat
 * everywhere"). If either number moves, that test fails rather than the ocean
 * silently going shallow again.
 *
 * Three is also the shallowest depth that satisfies the relation, which is what
 * we want: every extra band is one more sculpt a player must spend to raise
 * their first island (see the note on createFresh).
 */
export const FRESH_SEABED_BANDS_BELOW_SEA = 3;

/**
 * The height every cell of a fresh world starts at: three bands of water
 * column above the seabed. Well inside MIN_HEIGHT (-1024 = 16 bands), so the
 * full sculpt range below the floor is still available for deeper trenches.
 */
export const FRESH_SEABED_HEIGHT = SEA_LEVEL - FRESH_SEABED_BANDS_BELOW_SEA * BAND_HEIGHT;

export class World {
  readonly map: Heightmap;
  readonly mask: Uint8Array;

  private sink: MessageSink = NULL_SINK;
  private readonly playersById = new Map<string, Player>();

  /**
   * Set whenever terrain or mask changes; cleared when a snapshot is written.
   * The snapshot scheduler writes ONLY when this is true (design open question
   * 4, decided: "snapshot every SNAPSHOT_INTERVAL_S only if the world changed"),
   * so an idle server does no disk I/O at all.
   */
  private changedSinceSnapshot = false;

  private constructor(map: Heightmap, mask: Uint8Array) {
    this.map = map;
    this.mask = mask;
  }

  /**
   * A brand-new world: an OPEN OCEAN whose floor lies FRESH_SEABED_BANDS_BELOW_SEA
   * bands under the waterline, with the provisional starter region unlocked (see
   * initial-unlock.ts). Used when no snapshot exists.
   *
   * The seabed is filled HERE, on the server, and deliberately not in
   * `createHeightmap`: shared/ is the determinism contract that client and
   * server both run, and world GENESIS is not part of it. The client never
   * generates terrain — it receives chunks — so a zero-filled allocator stays
   * the honest shared primitive and "what a new world looks like" stays a
   * server policy that a future world-gen plugin can replace.
   *
   * TWO CONSEQUENCES, BOTH INTENDED AND BOTH REAL:
   *
   *   1. Raising the first island now costs FRESH_SEABED_BANDS_BELOW_SEA more
   *      band-steps than it used to (four sculpts to break the surface instead
   *      of one, at DEFAULT_SCULPT_AMOUNT = one band per intent). That is the
   *      point — the ocean is a volume with a bottom, not a sheet of paper.
   *   2. A fresh world has NO land and NO shallow water at all: every cell is
   *      exactly at the deep-water threshold. Habitat-driven plugins see one
   *      habitat on day one (open sea) and gain the others as players sculpt.
   *
   * Only this path changes. `restore` rebuilds whatever a snapshot holds, so
   * existing worlds are untouched by the new floor.
   *
   * Not a cosmetic mismatch worth chasing on the client: the client boots its
   * local heightmap at band 0 and shows a flat sea until the first chunk
   * arrives, so for the one pre-connect frame it draws a shoreline where the
   * server has an abyss. The first `chunkUnlock` overwrites it. Left alone
   * on purpose — the fix belongs in the client's boot state, not here.
   */
  static createFresh(size: number): World {
    const map = createHeightmap(size);
    // Uniform floor: no world-gen, no noise. A flat abyssal plain trivially
    // satisfies the gradient limit (every 4-neighbour difference is 0), so a
    // fresh world needs no relaxation pass to be legal terrain.
    map.cells.fill(FRESH_SEABED_HEIGHT);

    const world = new World(map, createChunkMask(size));
    applyInitialUnlock(world);
    // The starter unlock is part of world creation, not a mutation of an
    // existing world: the first snapshot will be written by the normal dirty
    // path anyway, so start clean and let real edits mark it.
    world.changedSinceSnapshot = false;
    return world;
  }

  /**
   * Rebuilds a world from a snapshot. Both buffers are validated against the
   * configured size — a mismatch means the DB was written by a differently
   * configured server, and silently continuing would produce a corrupt world.
   */
  static restore(size: number, cells: Int16Array, mask: Uint8Array): World {
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
    expectedMask.set(mask);
    return new World(map, expectedMask);
  }

  get size(): number {
    return this.map.size;
  }

  get chunksPerEdge(): number {
    return chunksPerEdge(this.map.size);
  }

  /** True when terrain or mask changed since the last successful snapshot. */
  get dirty(): boolean {
    return this.changedSinceSnapshot;
  }

  /** Called by the snapshot store after a snapshot is committed. */
  markSnapshotted(): void {
    this.changedSinceSnapshot = false;
  }

  /** Installs the network sink (room create) or removes it (room dispose). */
  setSink(sink: MessageSink): void {
    this.sink = sink;
  }

  /**
   * Sends a core protocol message to everyone. The Colyseus message type is the
   * payload's own `type` literal and the payload is the whole protocol object —
   * so what goes on the wire is exactly a `ServerMessage` from
   * shared/src/protocol.ts, with no server-only re-shaping to drift from.
   */
  broadcast(message: ServerMessage): void {
    this.sink.broadcast(message.type, message);
  }

  /** Same contract as broadcast(), to a single player. */
  sendTo(playerId: string, message: ServerMessage): void {
    this.sink.sendTo(playerId, message.type, message);
  }

  /** Plugin-namespaced traffic; the namespace is applied by the WorldApi. */
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

  /**
   * ANTI-CHEAT: the check the intent pipeline runs on a brush centre. Callers
   * must have bounds-checked (x,y) first — chunkIndexOfCell throws otherwise.
   */
  isCellUnlocked(x: number, y: number): boolean {
    return isChunkUnlocked(this.mask, chunkIndexOfCell(this.map.size, x, y));
  }

  /**
   * Flips a chunk's mask bit and streams it to every client.
   *
   * Returns false when the chunk was already unlocked, so callers (a reveal
   * plugin, typically) can unlock idempotently without re-sending 512 B of
   * heights. Streaming here — rather than at the call site — guarantees that a
   * chunk becoming visible and clients learning about it cannot drift apart.
   */
  unlockChunk(cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    if (isChunkUnlocked(this.mask, index)) return false;

    unlockChunk(this.mask, index);
    this.changedSinceSnapshot = true;
    this.broadcast({ type: 'chunkUnlock', chunks: [chunkPayloadOf(this, cx, cy)] });
    return true;
  }

  /**
   * Applies an authoritative sculpt from the shared math (never re-implemented
   * here — design §3.3). `options` selects the brush tool and edge profile;
   * omitting it means smooth+soft, the shared library's compatibility default
   * (LIBRARY_DEFAULT_SCULPT_OPTIONS). Player intents never omit it: the intent
   * pipeline resolves them through `sculptOptionsOf` first.
   *
   * Returns the FULL diff, including cells inside locked chunks that the
   * relaxation legitimately touched (with the stamp tool there is no relaxation
   * and so no spill at all). Filtering for the wire happens in mask-filter.ts;
   * this method deliberately does not broadcast, so that the one place which
   * does (sculpt-service.ts) is the only place to audit.
   */
  applySculpt(
    x: number,
    y: number,
    radius: number,
    amount: number,
    options?: SculptOptions,
  ): CellDiff[] {
    const diff = applySculpt(this.map, x, y, radius, amount, options);
    if (diff.length > 0) this.changedSinceSnapshot = true;
    return diff;
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

  /** Snapshot of the connected players; safe for plugins to hold briefly. */
  players(): readonly Player[] {
    return Array.from(this.playersById.values());
  }
}
