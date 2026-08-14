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

import { DEFAULT_WORLD_SIZE } from '@terrace/shared';
import type {
  ChunkUnlockMessage,
  JoinSnapshotMessage,
  TerrainDiffMessage,
} from '@terrace/shared';
import type { Mesh } from 'three';
import {
  applyChunkUnlock,
  applySnapshot,
  applyTerrainDiff,
  createTerrainMirror,
  type TerrainMirror,
} from './terrain/mirror.ts';
import { createTerrainMeshes, type TerrainMeshes } from './render/terrainMeshes.ts';
import type { TerrainSink } from './net/connection.ts';
import type { Viewport } from './render/scene.ts';
import { createWater, type Water } from './render/water.ts';

export interface World extends TerrainSink {
  /** 0 until the first snapshot arrives. */
  worldSize(): number;
  pickables(): Mesh[];
  dispose(): void;
}

export function createWorld(viewport: Viewport): World {
  // A sea exists from the first frame, before any server contact, so the
  // "disconnected" boot state is a plausible empty ocean rather than a void.
  const water: Water = createWater(viewport.scene, DEFAULT_WORLD_SIZE);

  let mirror: TerrainMirror | null = null;
  let meshes: TerrainMeshes | null = null;
  /** World size the camera has already been framed for; 0 before the first. */
  let framedWorldSize = 0;

  /**
   * Rebuilds the local world for a newly reported size. Called on every
   * snapshot: a snapshot is by definition the authoritative starting state for
   * this session, so any terrain from a previous session must go, even if the
   * size is unchanged (a server restart can hand back a different world).
   */
  const resetWorld = (
    worldSize: number,
  ): { mirror: TerrainMirror; meshes: TerrainMeshes } => {
    meshes?.dispose();
    const nextMirror = createTerrainMirror(worldSize);
    const nextMeshes = createTerrainMeshes(viewport.terrainGroup, nextMirror);
    mirror = nextMirror;
    meshes = nextMeshes;
    water.setWorldSize(worldSize);

    // Frame the camera only for a world we have not framed before. A snapshot
    // also arrives on every reconnect, and re-framing there would yank the
    // camera out from under a player who had just lined up a shot.
    if (worldSize !== framedWorldSize) {
      viewport.focusWorld(worldSize);
      framedWorldSize = worldSize;
    }

    return { mirror: nextMirror, meshes: nextMeshes };
  };

  return {
    onSnapshot(msg: JoinSnapshotMessage): void {
      const fresh = resetWorld(msg.worldSize);
      fresh.meshes.update(applySnapshot(fresh.mirror, msg));
    },

    onChunkUnlock(msg: ChunkUnlockMessage): void {
      // A chunk unlock before the snapshot would mean the server sent messages
      // out of order; drop it rather than guess a world size.
      if (mirror === null || meshes === null) return;
      meshes.update(applyChunkUnlock(mirror, msg));
    },

    onTerrainDiff(msg: TerrainDiffMessage): void {
      if (mirror === null || meshes === null) return;
      // The hot path: write cells, then patch only the chunk meshes those
      // cells touch (including neighbours across a shared border).
      meshes.update(applyTerrainDiff(mirror, msg));
    },

    worldSize(): number {
      return mirror?.map.size ?? 0;
    },

    pickables(): Mesh[] {
      return meshes?.pickables() ?? [];
    },

    dispose(): void {
      meshes?.dispose();
      meshes = null;
      mirror = null;
      water.dispose();
    },
  };
}
