# Writing a Terrace plugin

Everything gamey in Terrace is a plugin: mana, followers, territory reveal,
weather, wildlife. Core ships terrain, sync, persistence and the plugin host, and
nothing else. If you want a game, you write plugins — you should never have to
touch core.

## Your first plugin

A plugin is a folder under `plugins/` with a `server/index.ts` that exports a
`TerracePlugin` as `plugin`. That is the whole contract: no registration, no
manifest. The host scans `plugins/` at boot in alphabetical order, which is also
intent-interceptor order, so it is stable across machines.

Create `plugins/hello/server/index.ts`:

```ts
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';

let sculpts = 0;

export const plugin: TerracePlugin = {
  // Lowercase alphanumerics and dashes. Also your message namespace and your
  // key in the snapshot, so it must be unique and stable.
  name: 'hello',

  onWorldCreate(world: WorldApi) {
    // Replace state here, never add to it: this runs again on a rollback.
    console.log(`[hello] world is ${world.worldSize}x${world.worldSize} cells`);
  },

  onTerrainChanged(_world, diff) {
    sculpts++;
    console.log(`[hello] edit #${sculpts} changed ${diff.length} cells`);
  },

  persistence: {
    version: 1,
    save: () => ({ sculpts }),
    load: (data, fromVersion) => {
      if (fromVersion !== 1) return 'refuse'; // never overwrite bytes you can't read
      sculpts = (data as { sculpts?: number })?.sculpts ?? 0;
    },
  },
};
```

Run it:

```sh
docker compose up --build          # plugins/ is copied into the image
docker compose logs -f server
```

```
[terrace] loaded 1 plugin(s): hello
[hello] world is 2048x2048 cells
[hello] edit #1 changed 37 cells
```

Sculpt in the browser and watch the counter move; restart and watch it come back.
Nothing is compiled — Node 24 runs the TypeScript directly, and `.js` works too.

## The hooks

All optional. `server/src/plugins/types.ts` has the authoritative doc comments;
read them before relying on any subtlety here.

| Hook | When it fires |
|---|---|
| `onWorldCreate(world)` | Once per world session, after your slice is restored. Re-runs on a rollback or reopen, so assign fresh state, never append. |
| `onWorldClose(world)` | The world is unloading, after the final snapshot. Fires for every installed plugin, enabled or not. `world` is dead once it returns. |
| `onTick(world, dt)` | Every simulation tick; `dt` is the fixed tick period in seconds. |
| `onIntent(intent, ctx)` | Before a sculpt applies. Return `{kind:'deny', reason}`, `{kind:'modify', intent}`, or nothing. Verdict only — no side effects, because a later plugin can still deny. |
| `onIntentApplied(intent, ctx, diff)` | After every interceptor allowed and the edit landed. Charge here. `intent` is the effective one after any `modify`. |
| `onIntentDenied(intent, ctx)` | Once per refused intent. For re-asserting state to a client that predicted optimistically. Spend nothing. |
| `onTerrainChanged(world, diff, sculptorToken?)` | After any applied edit, with the full server-side diff. No token for plugin-initiated edits. |
| `onPlayerJoin` / `onPlayerLeave` | Presence. |
| `onChunkUnlockedForToken(world, token, cx, cy)` | A chunk opened for one player. Push static content already in it rather than waiting for your repair cadence. |
| `onWorldEvent(world, event, payload)` | Another plugin called `emitEvent`. Namespaced (`structures:changes`); validate the payload, the emitter may be a different version. |
| `messages` | `{ [type]: (world, player, payload) => void }`, received as `hello:<type>`. Validate the payload — it came from a browser. |
| `persistence` | `{ version, save(), load(data, fromVersion) }`. |
| `settings` | Per-world operator settings. |
| `actions` / `onAction(world, key, site)` | Operator buttons in the world panel ("erupt the nearest volcano"). Runs between ticks at the clicked cell; the returned one-line `detail` is shown verbatim. |

## WorldApi

Narrow on purpose.

- **Read:** `worldSize`, `chunksPerEdge`, `difficulty` (1–100; core attaches no
  meaning, your plugin decides what hard means), `simMillis` / `genesisMillis`
  (read via `shared/src/calendar.ts`, never keep your own day counter),
  `heightAt`, `isCellUnlocked`, `isChunkUnlocked`, `riverNetwork()`, `freshwater`,
  `players()`, `isChunkVisibleTo` / `isCellVisibleTo`.
- **Act:** `sculpt(x, y, radius, amount)`, `unlockChunk(cx, cy)`,
  `unlockChunkForToken(token, cx, cy)`.
- **Talk:** `broadcast`, `sendTo`, `broadcastVisible(type, items, positionOf,
  buildPayload, options?)` (per-recipient payloads filtered by each player's own
  mask — use it instead of looping `players()` by hand), `emitEvent`.
- **Configure:** `setting(key)`, `sibling(name)`.

There is no way to write a raw height. A plugin's edit goes through the same
brush, relaxation and mask filtering a player's does, so plugins can't desync
clients or bypass terrain rules. Every `WorldApi` is revoked at world close and a
stashed reference throws afterwards, so take it from the hook that is running.

Three behaviours worth knowing:

- **`onIntent` is a chain.** The first `deny` wins and stops it; a `modify` passes
  the replacement to the next plugin. Price in `onIntent`, charge in
  `onIntentApplied` — that is how an economy or a cooldown works without patching
  the sim.
- **A broken plugin can't take the world down.** Hooks are wrapped; a throw is
  logged, counted, and skipped. A throw in `onIntent` counts as *allow*, so a bug
  can't silently make the world unsculptable.
- **`onWorldEvent` and `messages` run synchronously**, with a cascade guard
  (`MAX_WORLD_EVENT_DEPTH` in `host.ts`).

## Persistence

`save()` returns JSON-serialisable data. The host stores it as `{ v, data }`
stamped with your `version` and hands `load()` the stored version as
`fromVersion` (slices written before envelopes existed arrive as `1`).

- **Bump `version`** when `save()`'s shape changes in a way `load()` can't read
  blind, and migrate every older version in `load()`. `plugins/monsters` is the
  reference pattern.
- **Return `'refuse'`** for bytes this build can't read. The host parks the slice:
  it is re-emitted verbatim by every snapshot and your plugin runs stateless. A
  version ahead of yours parks automatically. Returning empty state instead gets
  written over the real slice a minute later, which is the bug refusal prevents.
- **A throw is not a refusal.** It is logged and skipped, your plugin comes up
  empty, and the next snapshot overwrites the slice. Guard `load()`.
- **`load()` and `onWorldCreate()` re-run on a live process** (rollback, reopen).
  Both must replace state — one that appends doubles on every rollback.

## Per-world enablement and settings

Every plugin can be switched on or off per world from the world panel (admin
key). A plugin switched off gets no hooks except `onWorldClose`, and its
`sibling()` lookup answers `null`. Toggling reopens the world and carries
connected players across.

A plugin can declare a closed set of operator settings:

```ts
settings: [{ key: 'growth-model', values: ['life', 'populous'], defaultValue: 'life' }],
```

Read the value with `world.setting('growth-model')`, once in `onWorldCreate` —
changing it reopens the world anyway. `undefined` means the world has no row; the
default is yours to apply, not core's.

## Depending on another plugin

A self-hoster can delete any folder or disable it for one world, so a sibling is
never a package-manager dependency. Never `import` it — a missing folder fails
module resolution and aborts boot. Ask the host:

```ts
const mana = world.sibling('mana');           // module namespace, or null
if (mana && typeof mana.setManaPerk === 'function') { … }
```

It never throws for an absent sibling and answers synchronously whatever the load
order. Two things stay with you: **duck-type** the module (a folder can exist and
export an older API), and **buffer, don't drop** — record what you wanted to say
and replay it when the sibling appears, re-resolving in every `onWorldCreate`.
`plugins/relics/server/mana-bridge.ts` is the reference bridge. If you expose a
registration API to siblings, expose the unregister too, and have consumers call
it from `onWorldClose`.

## The client half

Lives at `plugins/<name>/client/index.ts`, exports a `TerraceClientPlugin` as
`clientPlugin` with the **same `name`**, and is compiled into the client bundle —
add one import to `client/src/plugins/registry.ts`. Its `attach(ctx)` gets a
`ClientPluginCtx` (`client/src/plugins/types.ts`): a private Three.js `layer`,
`onMessage` / `send`, `onFrame`, `registerHudPanel` (Solid components),
`registerTool`, terrain picking, `onLocalIntent` for a client-side gate mirroring
your server `onIntent`, plus mover poses and sky-rig hooks. Client halves need a
`package.json` with `solid-js` — see `plugins/mana`.

Because it is compiled in, changing client code always needs a new client build. A
server reload or restart rebinds the build identity, and browsers reload once on
their next join snapshot.

## Updating a running plugin

- **`serverRestart`** (world panel) — the recommended path. Snapshots, exits with
  a restart code, supervisor brings the new code up, players carry across.
- **`reloadPlugin`** (world panel, per plugin) — re-imports one plugin's server
  code in process and reopens the world over it. If the import, `onWorldCreate`,
  `load()` or the probe tick faults, the previous build goes back. A dev-loop
  convenience: each reload leaks ~0.66 MB (Node can't evict modules), and it can't
  update the client half.

## Gotchas

- **`MODULE_TYPELESS_PACKAGE_JSON` warning** for a bare `.ts` plugin is harmless.
  Silence it with `plugins/hello/package.json`:
  `{"name": "@terrace/plugin-hello", "version": "0.1.0", "private": true, "type": "module"}`.
  That `version` is the first half of the build stamp the world panel shows.
- **npm dependencies** need that `package.json` (the `plugins/*` glob makes it a
  workspace package) *and* one `pnpm install` to update `pnpm-lock.yaml`. The
  Docker build uses `--frozen-lockfile` and fails with
  `ERR_PNPM_OUTDATED_LOCKFILE` otherwise. Dependency-free plugins need no lockfile
  change.
- **A malformed plugin aborts boot** rather than starting a world quietly missing
  its economy. Duplicate names, a missing `plugin` export, or an ambiguous one are
  all fatal and say why.
- **A folder with only a `client/` half** is skipped with a log line, not an error.
- **Don't keep a `WorldApi` at module scope.** It is revoked at world close.
