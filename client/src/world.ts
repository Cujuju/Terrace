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

import {
  CHUNK_SIZE,
  DEFAULT_WORLD_SIZE,
  cellIndex,
  chunkIndex,
  quantizeToBand,
} from '@terrace/shared';
import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  SculptAppliedMessage,
  SculptDeniedMessage,
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
import { setServerVersion, setWorldIdentity } from './state/hudState.ts';
import {
  createPredictionStore,
  type PredictionStore,
} from './terrain/prediction.ts';
import { createTerrainMeshes, type TerrainMeshes } from './render/terrainMeshes.ts';
import { createFrontierFog, type FrontierFog } from './render/frontierFog.ts';
import { createRiverRig, type RiverRig } from './render/riverRig.ts';
import type { TerrainSink } from './net/connection.ts';
import type { Viewport } from './render/scene.ts';
import { createWater, type Water } from './render/water.ts';
import type { ChartSource } from './terrain/chart.ts';

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
  /**
   * A read-only window onto the mirror for the Cartographer (ui/Cartographer):
   * the world size, raw heights, and which cells sit in received chunks. Null
   * before the first snapshot. The returned source closes over the CURRENT
   * mirror, so a chart being drawn stays internally consistent even if a
   * rejoin replaces the world mid-draw — it charts the world it was opened on.
   */
  chartSource(): ChartSource | null;
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
  // One fog curtain for the whole session, like water — its segments are
  // synced (added/disposed) against whatever mirror currently exists rather
  // than being torn down and recreated on every rejoin.
  const fog: FrontierFog = createFrontierFog(viewport.scene, viewport.onFrame);
  // Rivers, pools and waterfalls (mechanics cards 27 & 40) — a third derived
  // layer alongside water and fog, same lifetime, same "one instance for the
  // whole session" shape. Its own refresh() is throttled internally, so
  // calling it from applyDirty below (the one place terrain changes) is free
  // on every call that lands inside the throttle window.
  const rivers: RiverRig = createRiverRig(viewport.scene, viewport.onFrame);

  let mirror: TerrainMirror | null = null;
  let meshes: TerrainMeshes | null = null;
  let predictions: PredictionStore | null = null;
  /**
   * World size the camera has already been aimed at — framed OR restored from
   * a saved pose; 0 before the first snapshot.
   */
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
  /**
   * The one door every HEIGHT change goes through on its way to the screen:
   * patches the dirty chunks' terrain meshes, rewrites the frontier-fog
   * segments standing on them, rewrites the sea's depth-alpha texels over
   * them (render/water.ts — a sculpt that breaks the surface or digs deeper
   * must be visible through the water the same frame it lands, not only
   * after the next rejoin), and refreshes rivers. Events that change
   * `received` (snapshot, chunkUnlock) call fog.sync afterwards as well;
   * that is about WHICH segments exist, not their heights.
   */
  const applyDirty = (dirty: Set<number>): void => {
    meshes?.update(dirty);
    if (mirror !== null) {
      fog.refresh(mirror, dirty);
      water.refresh(mirror, dirty);
      rivers.refresh(mirror);
    }
  };

  const armExpiryTimer = (): void => {
    clearExpiryTimer();
    const dueAt = predictions?.nextExpiryAtMs();
    if (dueAt === null || dueAt === undefined) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        if (meshes === null || predictions === null) return;
        applyDirty(predictions.expire(nowMs()));
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

    // Point the camera only at a world we have not pointed it at before. A
    // snapshot also arrives on every reconnect, and re-aiming there would yank
    // the camera out from under a player who had just lined up a shot.
    //
    // "Pointed at" covers both outcomes of restoreOrFocus: restoring the pose
    // saved for this server + world size, and framing the world from scratch
    // when there is no usable saved pose. A restored pose therefore counts as
    // framed — a rejoin at the same size leaves it alone, exactly as it leaves
    // a framed camera alone, and a rejoin at a NEW size runs the same restore
    // path afresh against that size's own key.
    if (worldSize !== framedWorldSize) {
      viewport.restoreOrFocus(worldSize);
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
      // World identity (name + difficulty) travels on the snapshot and only on
      // the snapshot, so it is published to the HUD here — on a REJOIN too,
      // which matters: the client may have been pointed at a different world
      // while it was away, and the header must follow the terrain it is over.
      // Writing hudState from the imperative layer is the documented pattern
      // (see state/hudState.ts's header), not a shortcut around Solid.
      setWorldIdentity({
        name: msg.worldName ?? null,
        difficulty: msg.difficulty ?? null,
      });
      // Build identity travels with world identity, and matters on a REJOIN
      // for the same reason: the server may have been restarted onto a new
      // commit while this client's bundle stayed put — which is exactly the
      // skew the watermark exists to expose.
      setServerVersion(msg.serverVersion);

      const fresh = resetWorld(msg.worldSize);
      // Through the prediction store like every authoritative message, so the
      // store's authoritative copy is seeded from the snapshot rather than from
      // the empty map the mirror was allocated with.
      const snapshotDirty = fresh.predictions.applyAuthoritative(
        (m) => applySnapshot(m, msg),
        nowMs(),
      );
      fresh.meshes.update(snapshotDirty);
      // The frontier is a fact about `received`, which the snapshot just
      // changed — sync unconditionally, whether this is a first join (empty
      // -> starter footprint) or a rejoin (old world's segments dropped, this
      // session's rebuilt).
      fog.sync(fresh.mirror);
      // The depth-alpha texture water.setWorldSize just reallocated (inside
      // resetWorld) is baseline-filled but otherwise empty — this is what
      // actually paints in every texel the newly-unlocked chunks need, same
      // dirty set the meshes above were just built from.
      water.refresh(fresh.mirror, snapshotDirty);
      // Same reasoning as fog.sync above, and forceRefresh rather than
      // refresh for the same reason `meshes`/`mirror` are replaced wholesale
      // on every snapshot rather than patched: a rejoin's mirror belongs to a
      // possibly brand-new world, and rivers.refresh's own throttle (tuned
      // for coalescing a HELD STROKE's terrainDiff bursts — see riverRig.ts)
      // would otherwise leave the PREVIOUS session's tiles on screen for up
      // to RIVER_RECOMPUTE_INTERVAL_MS after a rejoin that happens to land
      // inside its window.
      rivers.forceRefresh(fresh.mirror);
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
      if (meshes === null || predictions === null || mirror === null) return;
      const unlockDirty = predictions.applyAuthoritative(
        (m) => applyChunkUnlock(m, msg),
        nowMs(),
      );
      meshes.update(unlockDirty);
      // Territory just crept outward — move the mist with it. `received`
      // changed, which is the only thing the frontier is defined from.
      fog.sync(mirror);
      // Newly-unlocked chunks need their depth-alpha texels painted in too —
      // the texture only holds WATER_DEPTH_ALPHA_DEFAULT_BYTE for a chunk
      // until something writes real depths into it, same as the snapshot
      // path above.
      water.refresh(mirror, unlockDirty);
      // Newly unlocked ground can carry its own springs/rivers that were
      // never active before (rivers.ts's isActive bound follows `received`
      // exactly like this — see riverRig.ts). The ordinary throttle is right
      // here (unlike the snapshot path below): this is the SAME session's
      // world growing, not a different one replacing it, so there is no
      // stale "previous world" tile to worry about outliving.
      rivers.refresh(mirror);
      armExpiryTimer();
    },

    onTerrainDiff(msg: TerrainDiffMessage): void {
      if (meshes === null || predictions === null) return;
      // The hot path: write cells (against authoritative state, with local
      // predictions rolled off and any the server has now confirmed retired),
      // then patch only the chunk meshes those cells touch — including
      // neighbours across a shared border.
      applyDirty(
        predictions.applyAuthoritative((m) => applyTerrainDiff(m, msg), nowMs()),
      );
      armExpiryTimer();
    },

    predictSculpt(intent: SculptIntent): void {
      if (meshes === null || predictions === null) return;
      applyDirty(predictions.predict(intent, nowMs()));
      armExpiryTimer();
    },

    onSculptDenied(msg: SculptDeniedMessage): void {
      if (meshes === null || predictions === null) return;
      // The denied stroke comes off the screen the moment the nack lands —
      // one round trip — instead of at the prediction deadline.
      applyDirty(predictions.resolveSeq(msg.seq));
      armExpiryTimer();
    },

    onSculptApplied(msg: SculptAppliedMessage): void {
      if (meshes === null || predictions === null) return;
      // The ack arrives AFTER the terrainDiff it acknowledges (the ordering
      // contract on SculptAppliedMessage), so the authoritative map already
      // holds the server's version of this edit and dropping our own copy of
      // it changes nothing on screen — which is exactly the point: keeping it
      // would draw the same edit twice until the deadline (issue #21).
      applyDirty(predictions.resolveSeq(msg.seq));
      armExpiryTimer();
    },

    worldSize(): number {
      return mirror?.map.size ?? 0;
    },

    terrainHeightAt(x: number, y: number): number | null {
      if (mirror === null) return null;
      return quantizeToBand(sampleHeight(mirror, x, y)) * HEIGHT_WORLD_SCALE;
    },

    chartSource(): ChartSource | null {
      const m = mirror;
      if (m === null) return null;
      return {
        size: m.map.size,
        heightAt: (x: number, y: number): number =>
          m.map.cells[cellIndex(m.map, x, y)],
        // "Revealed" for the chart is exactly the renderer's own notion of
        // what exists: the cell's owning chunk is in `received` (mirror.ts
        // invariant 1). No reveal-plugin knowledge leaks in here.
        revealedAt: (x: number, y: number): boolean =>
          m.received.has(
            chunkIndex(
              m.map.size,
              Math.floor(x / CHUNK_SIZE),
              Math.floor(y / CHUNK_SIZE),
            ),
          ),
      };
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
      fog.dispose();
      rivers.dispose();
    },
  };
}
