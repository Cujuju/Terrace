// Wires the mirror, the meshes and the network together: one object that owns
// "the world as this client knows it".
//
// CRITICAL CODE — the message → mirror → dirty chunks → patched meshes chain
// lives here, and it is the only path by which terrain changes.
//
// The world size is not known until the join snapshot arrives, and the mirror
// and mesh set are sized from it, so both are created lazily and replaced
// wholesale on a (re)join. Everything downstream reads them through accessors
// for that reason — a stale direct reference would silently keep drawing the
// previous session's terrain.

import { DEFAULT_WORLD_SIZE, quantizeToBand } from '@terrace/shared';
import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  SculptIntent,
  TerrainDiffMessage,
} from '@terrace/shared';
import type { Mesh } from 'three';
import {
  applyChunkUnlock,
  applySnapshot,
  applyTerrainDiff,
  createTerrainMirror,
  sampleHeight,
  type TerrainMirror,
} from './terrain/mirror.ts';
import { HEIGHT_WORLD_SCALE } from './config.ts';
import {
  createPredictionStore,
  type PredictionStore,
} from './terrain/prediction.ts';
import { createTerrainMeshes, type TerrainMeshes } from './render/terrainMeshes.ts';
import type { TerrainSink } from './net/connection.ts';
import type { Viewport } from './render/scene.ts';
import { createWater, type Water } from './render/water.ts';

export interface World extends TerrainSink {
  /**
   * Applies the local player's sculpt immediately, before the server has
   * answered (design §3.3 client-side prediction). Call this ONLY for an intent
   * that actually went out on the wire — see main.tsx.
   */
  predictSculpt(intent: SculptIntent): void;
  /** 0 until the first snapshot arrives. */
  worldSize(): number;
  pickables(): Mesh[];
  /**
   * World-space Y of the RENDERED terrain surface at cell (x, y): the
   * band-quantised height the terrain mesh actually draws, which is where
   * anything standing on the ground belongs. Cells in never-received chunks
   * read as band 0, exactly like the mesh renders them. Null before the first
   * snapshot. Consumed by the client plugin host (plugins/host.ts).
   */
  terrainHeightAt(x: number, y: number): number | null;
  dispose(): void;
}

/**
 * Monotonic clock for prediction deadlines. `performance.now()` rather than
 * `Date.now()`: these timestamps are only ever compared to each other, and a
 * wall-clock adjustment (NTP step, DST) must not be able to expire — or
 * indefinitely postpone — a pending prediction.
 */
const nowMs = (): number => performance.now();

export function createWorld(viewport: Viewport): World {
  // A sea exists from the first frame, before any server contact, so the
  // "disconnected" boot state is a plausible empty ocean rather than a void.
  const water: Water = createWater(viewport.scene, DEFAULT_WORLD_SIZE);

  let mirror: TerrainMirror | null = null;
  let meshes: TerrainMeshes | null = null;
  let predictions: PredictionStore | null = null;
  /** World size the camera has already been framed for; 0 before the first. */
  let framedWorldSize = 0;
  /** One-shot timer armed for the moment the oldest prediction expires. */
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearExpiryTimer = (): void => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };

  /**
   * Schedules the prediction sweep for the exact moment the oldest outstanding
   * prediction times out — no polling interval, and therefore no timer at all
   * while nothing is pending.
   *
   * The sweep is what covers the intents the server answers with SILENCE: an
   * intent rejected by the unlock mask or vetoed by a plugin produces no diff
   * by design (see the server's intent pipeline), so nothing else would ever
   * take that prediction back off the screen.
   */
  const armExpiryTimer = (): void => {
    clearExpiryTimer();
    const dueAt = predictions?.nextExpiryAtMs();
    if (dueAt === null || dueAt === undefined) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        if (meshes === null || predictions === null) return;
        meshes.update(predictions.expire(nowMs()));
        armExpiryTimer(); // predictions may remain that expire later
      },
      Math.max(0, dueAt - nowMs()),
    );
  };

  /**
   * Rebuilds the local world for a newly reported size. Called on every
   * snapshot: a snapshot is by definition the authoritative starting state for
   * this session, so any terrain from a previous session must go, even if the
   * size is unchanged (a server restart can hand back a different world).
   */
  const resetWorld = (
    worldSize: number,
  ): {
    mirror: TerrainMirror;
    meshes: TerrainMeshes;
    predictions: PredictionStore;
  } => {
    meshes?.dispose();
    const nextMirror = createTerrainMirror(worldSize);
    const nextMeshes = createTerrainMeshes(viewport.terrainGroup, nextMirror);
    // A new session's snapshot is the authoritative starting state, so any
    // prediction still outstanding against the OLD session is meaningless: the
    // store is replaced along with the mirror it shadows, which drops them.
    const nextPredictions = createPredictionStore(nextMirror);
    mirror = nextMirror;
    meshes = nextMeshes;
    predictions = nextPredictions;
    clearExpiryTimer();
    water.setWorldSize(worldSize);

    // Frame the camera only for a world we have not framed before. A snapshot
    // also arrives on every reconnect, and re-framing there would yank the
    // camera out from under a player who had just lined up a shot.
    if (worldSize !== framedWorldSize) {
      viewport.focusWorld(worldSize);
      framedWorldSize = worldSize;
    }

    return {
      mirror: nextMirror,
      meshes: nextMeshes,
      predictions: nextPredictions,
    };
  };

  return {
    onSnapshot(msg: JoinSnapshotMessage): void {
      const fresh = resetWorld(msg.worldSize);
      // Through the prediction store like every authoritative message, so the
      // store's authoritative copy is seeded from the snapshot rather than from
      // the empty map the mirror was allocated with.
      fresh.meshes.update(
        fresh.predictions.applyAuthoritative(
          (m) => applySnapshot(m, msg),
          nowMs(),
        ),
      );
    },

    onChunkUnlock(msg: ChunkUnlockMessage): void {
      // Guard, not an expected path: the snapshot always arrives first, so
      // this can only fire if that ordering contract is broken.
      //
      // The contract is real and was worth pinning down, because Colyseus
      // makes it easy to violate: `Room._onJoin` pushes the client into
      // `this.clients` BEFORE awaiting the room's `onJoin`, so a client is
      // broadcast-reachable before its snapshot has been sent, and the tick
      // loop (which may carry a plugin's chunkUnlock) is a separate
      // macrotask. Verified with the Phase 1 server agent against a running
      // server: their `onJoin` sends the snapshot with nothing awaited before
      // it, and its `: void` return type now makes marking it `async` a
      // compile error — so the ordering is enforced at the source rather than
      // merely observed.
      //
      // We still drop rather than guess: without a snapshot there is no world
      // size, so the mirror cannot be allocated and the chunk has nowhere to
      // go. Dropping loses one reveal; guessing would render the world at the
      // wrong scale.
      if (meshes === null || predictions === null) return;
      meshes.update(
        predictions.applyAuthoritative((m) => applyChunkUnlock(m, msg), nowMs()),
      );
      armExpiryTimer();
    },

    onTerrainDiff(msg: TerrainDiffMessage): void {
      if (meshes === null || predictions === null) return;
      // The hot path: write cells (against authoritative state, with local
      // predictions rolled off and any the server has now confirmed retired),
      // then patch only the chunk meshes those cells touch — including
      // neighbours across a shared border.
      meshes.update(
        predictions.applyAuthoritative((m) => applyTerrainDiff(m, msg), nowMs()),
      );
      armExpiryTimer();
    },

    predictSculpt(intent: SculptIntent): void {
      if (meshes === null || predictions === null) return;
      meshes.update(predictions.predict(intent, nowMs()));
      armExpiryTimer();
    },

    worldSize(): number {
      return mirror?.map.size ?? 0;
    },

    terrainHeightAt(x: number, y: number): number | null {
      if (mirror === null) return null;
      return quantizeToBand(sampleHeight(mirror, x, y)) * HEIGHT_WORLD_SCALE;
    },

    pickables(): Mesh[] {
      return meshes?.pickables() ?? [];
    },

    dispose(): void {
      clearExpiryTimer();
      meshes?.dispose();
      meshes = null;
      mirror = null;
      predictions = null;
      water.dispose();
    },
  };
}
