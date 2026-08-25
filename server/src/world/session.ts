// A WORLD SESSION — one loaded world and everything that belongs to it.
//
// A session is the unit that gets swapped when an operator loads a different
// world: its store, its World, its plugin host and its rollback service are
// created together, live exactly as long as that world is loaded, and are
// thrown away together. Nothing outside holds a reference to any of them
// directly — see world-manager.ts, which owns the current session and hands
// out access through getters.
//
// WHY THE HOST IS PART OF THE SESSION AND NOT THE PROCESS. `createWorldApi`
// closes over a specific World instance, so a PluginHost is permanently bound
// to the world it was built for. Rebuilding the host per session is therefore
// not a choice but a consequence — and it is the SAFE consequence: the
// alternative (a mutable world reference inside the API) would let a plugin
// observe the world changing underneath it in the middle of a tick.
//
// PLUGIN MODULES ARE STILL PROCESS-WIDE, AND THAT IS THE CONSTRAINT THIS WHOLE
// DESIGN IS SHAPED BY. Every server plugin keeps its state at module scope
// (`let entries` in chronicle, `const forest` in flora, ...). A new host over
// the same modules does NOT get fresh plugin state; what resets that state is
// `restorePersistence` followed by `worldCreate`, the same pair the boot path
// and a rollback both run, because every `onWorldCreate` in this repo assigns
// or zeroes rather than accumulating. That contract is why one world can be
// closed and another opened in a live process at all — and why two worlds
// cannot be open AT ONCE (issue #78).

import { logInfo } from '../log.ts';
import type { ServerConfig } from '../config.ts';
import type { SnapshotStore } from '../persistence/snapshot-store.ts';
import { buildThumbnail } from '../persistence/thumbnail.ts';
import type { WorldRegistry } from '../persistence/world-registry.ts';
import { PluginHost } from '../plugins/host.ts';
import type { LoadedPlugin } from '../plugins/types.ts';
import { archFixtureRequested, carveArchFixture } from './arch-fixture.ts';
import { RollbackService } from './rollback.ts';
import { World } from './world.ts';

const MILLISECONDS_PER_SECOND = 1000;

/** One loaded world: everything that lives and dies with it. */
export interface WorldSession {
  /** The registry id — i.e. the basename of the file this world lives in. */
  readonly id: string;
  readonly store: SnapshotStore;
  readonly world: World;
  readonly host: PluginHost;
  readonly rollback: RollbackService;
}

/** What opening a session needs from the process. */
export interface SessionDeps {
  readonly config: ServerConfig;
  readonly registry: WorldRegistry;
  readonly plugins: readonly LoadedPlugin[];
}

/**
 * Writes a snapshot if the world changed. Returns true when one was written.
 *
 * The one place the whole process turns "the world moved" into a row, so the
 * set of things a snapshot contains is stated exactly once. Used by the boot
 * path, the periodic scheduler, the shutdown hook and — critically — by
 * `closeSession`, so a world being closed is saved by the same code that saves
 * a world being left running.
 */
export function snapshotIfDirty(session: WorldSession): boolean {
  const { world, host, store } = session;
  if (!world.dirty) return false;
  store.saveSnapshot({
    worldSize: world.size,
    name: world.name,
    cells: world.heightsForPersistence(),
    // The layered columns ride along with the heights they complete: without
    // them a carved world's snapshot would be unwritable (or worse, silently
    // flattened on restore). See World.spansForPersistence.
    columnSpans: world.spansForPersistence(),
    mask: world.mask,
    pluginSlices: host.collectPersistence(),
    tokenMasks: world.tokenMasks(),
    // The world clock rides along with whatever else made this world dirty —
    // it never dirties the world itself (World.advanceClock's doc comment).
    simMillis: world.simMillis,
    // The world's birthday, by contrast, never changes after the first write;
    // it rides along for the same reason and costs nothing to restate.
    genesisMillis: world.genesisMillis,
    // The heightmap is already in memory here, so the picture costs only the
    // averaging pass — the reason thumbnails are written rather than computed
    // when somebody opens the worlds panel (persistence/thumbnail.ts).
    thumbnail: buildThumbnail(world.map.cells, world.size),
  });
  world.markSnapshotted();
  return true;
}

/**
 * Opens a world that already has a file, and brings its plugins up to the
 * state they were in when it was last closed.
 *
 * REPLAYS THE BOOT SEQUENCE — `restorePersistence` then `worldCreate`, in that
 * order — because several plugins split their restore across the pair (`load`
 * stages a slice into a module-level buffer, `onWorldCreate` consumes it).
 * Calling only the first would leave those plugins holding a slice they never
 * applied. This is the same sequence, for the same reason, as the one
 * documented at the head of rollback.ts.
 *
 * Throws when the file cannot be read, when it holds a schema version this
 * build does not understand, or when it has no snapshot at all. A world file
 * with no snapshots is a broken world, not an empty one: `createWorld` writes
 * a genesis snapshot before the file is ever considered a world, so a file
 * without one has lost something, and inventing fresh terrain to fill the gap
 * is exactly the behaviour that costs people their maps.
 */
export function openSession(deps: SessionDeps, id: string): WorldSession {
  const { config, registry, plugins } = deps;
  const store = registry.openStore(id, config.snapshotRetention);

  let world: World;
  let pluginSlices: Record<string, unknown>;
  try {
    const snapshot = store.loadLatest();
    if (snapshot === null) {
      throw new Error(
        `world "${id}" has a database but no snapshot in it; refusing to replace it ` +
          'with fresh terrain',
      );
    }

    const age = Math.round((Date.now() - snapshot.createdAt) / MILLISECONDS_PER_SECOND);
    logInfo(
      `loading world "${id}": snapshot #${snapshot.id} (${snapshot.worldSize}², ${age}s old)`,
    );

    // Difficulty comes from the environment, the NAME comes from the snapshot
    // — see World.restore for why the two are opposite.
    world = World.restore(
      snapshot.worldSize,
      snapshot.cells,
      snapshot.mask,
      config.difficulty,
      snapshot.name,
      snapshot.tokenMasks,
      snapshot.simMillis,
      snapshot.genesisMillis,
      snapshot.columnSpans,
    );
    // THE CLOCK MEETS REAL TIME HERE, before any plugin has run: world time is
    // an offset against the wall clock (shared/src/calendar.ts), so a restored
    // world resumes at the hour and weekday real time says it should be rather
    // than where its last tick left it. Also the moment a world snapshotted
    // before this existed gets its birthday, reconstructed from the age its
    // row stored — see World.anchorClockToRealTime for all three cases.
    world.anchorClockToRealTime();
    pluginSlices = snapshot.pluginSlices;
  } catch (error) {
    // Do not leak the file handle when the world inside it turns out to be
    // unreadable: this path runs while the server is live, and an operator who
    // tries three broken worlds must not end up with three open databases.
    store.close();
    throw error;
  }

  const host = new PluginHost(world, plugins);
  // Restore first, then announce — see this function's doc comment.
  host.restorePersistence(pluginSlices);
  host.worldCreate();

  const rollback = new RollbackService({
    world,
    host,
    store,
    key: config.rollbackKey,
    retention: config.snapshotRetention,
    intervalS: config.snapshotIntervalS,
  });

  return { id, store, world, host, rollback };
}

/**
 * Saves and closes a session.
 *
 * SAVE FIRST, ALWAYS, and unconditionally attempt it: this is the last moment
 * the world exists in memory. A failure to write is logged by the caller and
 * must not stop the close — a file handle left open would keep a WAL alive on
 * a world nobody is looking at any more — but it is reported, because it means
 * whatever happened since the last snapshot is gone.
 */
export function closeSession(session: WorldSession): boolean {
  let saved = false;
  try {
    saved = snapshotIfDirty(session);
  } finally {
    session.store.close();
  }
  return saved;
}

/**
 * Creates a brand-new world: its file, its genesis terrain, and the first
 * snapshot that makes it a world rather than an empty database.
 *
 * WRITES THE GENESIS SNAPSHOT BEFORE RETURNING, so a world exists on disk from
 * the instant it is created. The alternative — create the file, wait for the
 * periodic scheduler — leaves a window in which a crash produces a world file
 * with no world in it, which `openSession` (correctly) refuses to open.
 *
 * Plugin slices are deliberately empty: a new world has no forests, no
 * chronicle and no villages, and every plugin's `onWorldCreate` produces
 * exactly that from an absent slice when the world is first loaded.
 */
export function createWorldFile(
  deps: SessionDeps,
  id: string,
  name: string,
  worldSize: number,
  difficulty: number,
): void {
  const store = deps.registry.createStore(id, deps.config.snapshotRetention);
  try {
    const world = World.createFresh(worldSize, difficulty, name);
    // THE ARCH FIXTURE, if this server was asked for it (ARCH_FIXTURE=1). It
    // is authored HERE — into genesis terrain, before the first snapshot —
    // rather than into a running world, so the mound reaches clients by the
    // ordinary path (chunk payload, snapshot blob, restore) and every one of
    // those is exercised for real. A world that already exists is loaded from
    // its snapshot and never re-carved, so the flag only ever affects a NEW
    // world. See arch-fixture.ts.
    if (archFixtureRequested()) {
      const layered = carveArchFixture(world.map);
      logInfo(
        `arch fixture: carved into world "${id}" — ${layered} layered column(s)` +
          (layered === 0 ? ' (nothing opened under the mound; this is a bug)' : ''),
      );
    }
    // Genesis is NOW, and it is stamped before the genesis snapshot is written
    // so the world's birthday is on disk from its first row — a world whose
    // first snapshot carried no genesis would have one reconstructed at its
    // next boot instead, dating it to whenever that boot happened.
    world.anchorClockToRealTime();
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.heightsForPersistence(),
      columnSpans: world.spansForPersistence(),
      mask: world.mask,
      pluginSlices: {},
      tokenMasks: world.tokenMasks(),
      simMillis: world.simMillis,
      genesisMillis: world.genesisMillis,
      thumbnail: buildThumbnail(world.map.cells, world.size),
    });
    logInfo(`created world "${id}" ("${name}", ${worldSize}²)`);
  } finally {
    store.close();
  }
}
