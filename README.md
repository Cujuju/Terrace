# Terrace

Terrace is an open-source, **self-hostable multiplayer terrain-sculpting platform** —
the terraced god-game terrain of *Populous* and *Godus*, in a browser, on a server you
own.

It is deliberately **not a game**. The core ships four things: terrain simulation,
real-time sync, persistence, and a plugin host. Everything gamey — mana, followers,
progressive territory reveal, accounts — is a plugin. If you want a game, you write
plugins; you should never have to touch core.

- **Self-hosting is the point.** One command brings up your own world.
- **Authoritative server.** Clients send *intents* ("raise at cell x,y"), never heights.
- **Your world is one SQLite file.** Kill the process, restart, the world comes back.
- **License:** MIT.

Standing rules and architecture live in [`docs/DESIGN.md`](docs/DESIGN.md); dated decisions in [`docs/decisions/`](docs/decisions/README.md).

---

## Quickstart

Requirements: **Docker Engine 23+ with Compose v2** (`docker compose version`). Nothing
else — no Node, no pnpm, no database to install.

```sh
git clone https://github.com/Cujuju/Terrace.git
cd Terrace
docker compose up
```

The first build takes a few minutes. When the log shows

```
[terrace] listening on ws://0.0.0.0:2567 (room "world")
```

open **<http://localhost:8080>** and start sculpting:

| Input | Action (default — rebind under **Controls** in the HUD) |
|---|---|
| left click / drag | raise land |
| shift + left click / drag | lower land |
| right drag | orbit the camera |
| middle drag | pan |
| wheel | zoom |
| one-finger touch | sculpt (tap **Mode** to switch raise/lower) |
| two-finger touch | pinch zoom + pan (or orbit — configurable) |

Raise, lower, orbit and pan can each be rebound to any mouse button plus an
optional Shift/Ctrl/Alt modifier; the choice is saved in the browser.

### Inviting players on your LAN

Set `SHARE_URL` on the server to the address friends should open — e.g.
`SHARE_URL=http://my-pc.local:5173` (Windows and macOS answer
`<computer-name>.local` on the LAN out of the box) — and the HUD shows an
**Invite** line with a copy button on every client. Without it, players who
already joined over the network see their own address as the invite; only the
hosting player's `localhost` view has nothing shareable to show, which is
exactly why `SHARE_URL` exists. Web browsers cannot discover servers via
mDNS/DNS-SD, so a shareable, human-passable URL *is* the discovery story.

The status dot in the HUD shows the connection. If the server is not up yet, the client
retries quietly in the background until it is — there is no error dialog to dismiss.

Stop with `Ctrl-C`, or `docker compose down`. Your world survives both — it lives in a
Docker volume, not in the containers.

### Letting a friend join

The address the browser dials is compiled into the client bundle, so it has to be an
address *your friend's browser* can reach, not `localhost`:

```sh
cp .env.example .env
# in .env:
PUBLIC_WS_URL=ws://your-box.example:2567

docker compose up --build      # --build is required: the URL is baked into the bundle
```

Open **two** ports on the box/firewall: `8080` (the client page) and `2567` (the world
server). They are separate services on purpose — see *How the pieces fit*.

Terrace has no accounts and no authentication: players are anonymous, identified by a
display name and a durable browser-generated token. Accounts, if ever, will be a
plugin. Anyone who can reach those ports can sculpt your world. On the public internet,
put it behind something that limits who gets in.

---

## Configuration

Copy `.env.example` to `.env` and edit. Compose reads `.env` from the repo root
automatically. Everything has a working default; nothing here is a secret, and
nothing is required to boot a world.

| Variable | Default | What it does |
|---|---|---|
| `WORLD_SIZE` | `512` under Compose, `2048` otherwise | Cells per world edge. **Cells are not world units**: four cells make one world unit, so `512` cells is the 128-unit Populous-proven minimum that fits a small VPS and `2048` cells (512 units) is the server's own default. Must be a multiple of 16 (the chunk size), at least 448 and at most 4096. This is the size **new** worlds are created at; an existing world keeps the size it was made with, and worlds of different sizes coexist happily. |
| `WORLD_DIFFICULTY` | `50` | How hard this world is meant to be, 1 (warm) to 100 (punishing). Core stores it and attaches no mechanics; plugins read it (today: mana's default regen rate). Out-of-range values clamp with a warning. |
| `PORT` | `2567` | Port the world server listens on. Compose maps the same number on the host, so host and container never disagree. Change it and you must update `PUBLIC_WS_URL` too. |
| `WORLDS_DIR` | `/data/worlds` | Where your worlds live — **one SQLite file per world**, plus `.trash/` for archived ones and `.active` naming the one to load at boot. Must be under the mounted volume or it is lost on the next rebuild. |
| `DB_PATH` | `/data/world.db` | The **legacy** single-world database, from before worlds were files. Copied into `WORLDS_DIR` on the next boot — copied, never moved — and then ignored forever. |
| `ROLLBACK_KEY` | `terrace` *(public!)* | Unlocks the in-game **Restore points** panel and the offline `pnpm --dir server rollback` script. Unset means the built-in key, which is in the source, so the server warns at every boot. Set your own (8+ characters), or `ROLLBACK_KEY=` to turn rollback off. |
| `WORLD_ADMIN_KEY` | `terrace` *(public!)* | Unlocks the in-game **Worlds** panel: create, load, rename, duplicate, archive, plugin enablement and plugin actions. Separate from `ROLLBACK_KEY` because it has a bigger blast radius. Same rules: 8+ characters, or `WORLD_ADMIN_KEY=` to turn it off. |
| `WORLD_SWITCH_COUNTDOWN_S` | `10` | Seconds a world switch is announced for when somebody other than the operator is connected. Skipped when the operator is alone; `0` makes every switch immediate. |
| `TICK_HZ` | `10` | Fixed simulation tick rate, 1–60. Rendering interpolates, so raising this mostly buys CPU load. |
| `SNAPSHOT_INTERVAL_S` | `60` | How often a changed world is written to SQLite, 1–3600. An idle world writes nothing at all. |
| `SNAPSHOT_RETENTION` | `10` | How many restore points a world keeps, 1–100. With the cadence above this is your undo depth: 10 × 60 s is ten minutes of history. Pinned points do not count. |
| `PLUGINS_DIR` | `<repo>/plugins` | Directory scanned for plugins at boot. Inside the image that is `/app/plugins`; leave it alone unless you are mounting plugins from elsewhere. |
| `PUBLIC_WS_URL` | `ws://localhost:2567` | *Compose only.* The WebSocket address the browser dials, **baked into the client bundle at build time** — changing it requires `docker compose up --build`. |
| `CLIENT_PORT` | `8080` | *Compose only.* Host port that serves the client page. |
| `TERRACE_VERSION` | *(unset)* | *Compose only.* Build stamp baked into the server image, e.g. `TERRACE_VERSION=$(git rev-parse --short HEAD) docker compose up --build`. Open pages compare it across a restart to decide whether to reload for a new client bundle. Unset, every restart looks like a new build and pages reload once. |

Plugins read their own variables from the same `.env` (`MANA_REGEN_PER_S`, for one);
`.env.example` documents each with its default.

Invalid values fail fast at boot with a message naming the variable, rather than
corrupting a world hours later.

---

## How the pieces fit

```
browser ──HTTP:8080──▶ client   (nginx serving the Vite-built bundle)
   └─────WS:2567─────▶ server   (Colyseus, authoritative world, SQLite) ──▶ volume terrace_world-data
```

Compose runs two containers: the `client` service is a plain nginx layer holding the
built bundle, and the browser talks to the server directly over WebSocket. Both are
built from the one root `Dockerfile` (`--target client` / `--target server`).

Outside Compose, **one process is one playable URL**: when a built client exists at
`CLIENT_DIST_PATH` (default `client/dist`), the game server serves it over its own
port with SPA fallback, and the client dials `ws://<its own host>` unless
`VITE_SERVER_URL` / `PUBLIC_WS_URL` override it. `http://host:PORT` is then the
whole game.

If you front this with a reverse proxy for TLS, the server side needs both the
`/matchmake/*` HTTP routes and the WebSocket upgrade proxied to port 2567, and
`PUBLIC_WS_URL` set to `wss://…`. That path is documented but untested here.

---

## Your worlds, and how to back them up

**A world is a file.** Each one is its own SQLite database under `WORLDS_DIR`
(the Docker volume **`terrace_world-data`**), holding that world's heightmap,
unlock masks, and every plugin's persisted slice. One world is loaded and
simulating at a time; the rest sit on disk until you load them.

This layout is deliberate and it is load-bearing. Worlds used to share a single
database, with retention keeping "the newest 10 snapshots" **across all of
them** — so a world you stopped playing could have its history evicted by a
world you started. That is not possible now: retention runs inside one world's
file and cannot reach another's.

**Restore points.** The server writes a snapshot every `SNAPSHOT_INTERVAL_S`
**only if the world changed**, keeps the last `SNAPSHOT_RETENTION` (default 10),
and writes one final snapshot on clean shutdown. So `docker compose stop` /
`Ctrl-C` never loses work, and a crash costs at most one interval. **Pin** a
restore point to exempt it from retention entirely — pinned points survive any
amount of later play, and do not count against your undo depth. Rolling back
is done from the in-game **Restore points** panel (`ROLLBACK_KEY`) or offline
with `pnpm --dir server rollback`.

**Managing worlds** (in-game, with `WORLD_ADMIN_KEY`): the Worlds panel lists
every world with its size, restore points, disk use and when you last played it.
From there you can create, load, rename, duplicate (with its whole history) and
archive.

**Nothing deletes a world by accident.** Archiving *moves* a world's file to
`WORLDS_DIR/.trash` and tells you where it went. The only thing that ever
unlinks a world is **Purge**, on the Trash tab, on a world that is already
archived, after you type its name back. Boot never replaces a missing world with
a fresh one either — it loads nothing and logs which world it could not open.

**Importing a world from elsewhere** — a backup, another checkout, a stray
`.db` you found:

```sh
pnpm --dir server import-world /path/to/some-world.db
```

It copies; your original file is not touched.

**Recovering history from an old backup.** Retention is a rolling window, so a
backup taken last week holds restore points this week's play has since pruned —
and the live world holds everything since. Neither is a superset. Make the
union:

```sh
pnpm --dir server merge-world-history old-backup.db worlds/your-world.db --pin
```

It copies only the snapshots the target is missing, refuses two files that are
not the same world, and never writes to the source. `--pin` exempts what it
recovers from retention, which you almost always want — recovered points are old
by definition, so without it the next write prunes them straight back out.

**Back up (safe method — stop first).** The databases run in WAL mode, so copying
them while the server is live can capture a torn state:

```sh
docker compose stop server                      # writes a final snapshot, closes the DB
docker run --rm -v terrace_world-data:/data -v "$PWD:/backup" busybox \
  tar czf /backup/terrace-backup.tar.gz -C /data .
docker compose start server
```

**Restore:**

```sh
docker compose down
docker run --rm -v terrace_world-data:/data -v "$PWD:/backup" busybox \
  sh -c "rm -rf /data/* && tar xzf /backup/terrace-backup.tar.gz -C /data"
docker compose up
```

**Start over:** `docker compose down -v` deletes the volume and **every world in
it**. There is no undo for that one.

**Upgrading:** `git pull && docker compose up --build`. Snapshots are versioned; a
database this build cannot read is refused loudly instead of half-applied.

---

## Write your first plugin

A plugin is a folder under `plugins/` with a `server/index.ts` that exports a
`TerracePlugin` as `plugin`. That is the entire contract — no registration, no
manifest. The host scans `plugins/` at boot, in alphabetical directory order (which is
also intent interceptor order, so it is stable across machines). Each world then
chooses which installed plugins run in it — see [Per-world enablement](#per-world-enablement-and-settings).

Create `plugins/hello/server/index.ts`:

```ts
// A hello-world Terrace plugin: log the world it joined, count edits, and
// remember the count across restarts.
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';

let sculpts = 0;

export const plugin: TerracePlugin = {
  // Lowercase alphanumerics and dashes. It is also this plugin's message
  // namespace and its key in the snapshot, so it must be unique and stable.
  name: 'hello',

  onWorldCreate(world: WorldApi) {
    // REPLACE state here, never add to it: this pair (load → onWorldCreate)
    // runs again on the same process for a world rollback or a reopen.
    console.log(`[hello] world is ${world.worldSize}x${world.worldSize} cells`);
  },

  onTerrainChanged(_world, diff) {
    sculpts++;
    console.log(`[hello] edit #${sculpts} changed ${diff.length} cells`);
  },

  // Plugin-owned snapshot data: saved with the world, handed back on boot.
  persistence: {
    version: 1,
    save: () => ({ sculpts }),
    load: (data, fromVersion) => {
      if (fromVersion !== 1) return 'refuse'; // never overwrite bytes you can't read
      sculpts = (data as { sculpts?: number })?.sculpts ?? 0;
      console.log(`[hello] restored counter at ${sculpts}`);
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
[hello] world is 512x512 cells
[hello] edit #1 changed 37 cells
```

Sculpt in the browser and watch the counter move. Restart the stack and watch
`[hello] restored counter at …` come back.

Nothing here is compiled: Node 24 runs the TypeScript directly (`.js` works too, for a
pre-built plugin). The `import type` line is erased at runtime, so this plugin has zero
dependencies.

### The rest of the interface

Every hook is optional. From `server/src/plugins/types.ts` (its doc comments are the
authoritative contract — read them before relying on any subtlety below):

| Hook | When it fires |
|---|---|
| `onWorldCreate(world)` | Once per world session, after the snapshot (and your slice) has been restored. Also re-run on a rollback or a reopen — assign fresh state, never append. |
| `onWorldClose(world)` | The world is being unloaded, after the final snapshot. Fires for **every installed plugin, enabled for this world or not** — tolerate having nothing to release. `world` is dead the moment this returns. |
| `onTick(world, dt)` | Every simulation tick; `dt` is the fixed tick period in seconds. |
| `onIntent(intent, ctx)` | Before a sculpt is applied. Return `{kind:'deny', reason}` to veto, `{kind:'modify', intent}` to rewrite it, or nothing to allow. **Verdict only — no side effects**: a later plugin can still deny. |
| `onIntentApplied(intent, ctx, diff)` | Once, after every interceptor allowed and the edit landed. Charge currencies and spend resources here. `intent` is the *effective* one after any `modify`. |
| `onIntentDenied(intent, ctx)` | Once per intent an interceptor refused. For re-asserting authoritative state to a client that predicted optimistically; spend nothing. |
| `onTerrainChanged(world, diff, sculptorToken?)` | After any applied edit, player or plugin, with the full server-side diff. `sculptorToken` is absent for plugin-initiated edits. |
| `onPlayerJoin(world, player)` / `onPlayerLeave(world, player)` | Presence. |
| `onChunkUnlockedForToken(world, token, cx, cy)` | A chunk was unlocked for one player. Push static content already sitting in that chunk (trees, buildings) rather than waiting for your repair cadence. |
| `onWorldEvent(world, event, payload)` | Another plugin called `emitEvent`. `event` is namespaced (`structures:changes`); validate `payload` structurally — the emitter may be a different version or absent. |
| `messages` | `{ [type]: (world, player, payload) => void }` — client→server handlers, received on the wire as `hello:<type>`. Validate `payload`; it came from a browser. |
| `persistence` | `{ version, save(), load(data, fromVersion) }` — your slice of the world snapshot (below). |
| `settings` | Per-world operator settings this plugin offers (below). |
| `actions` / `onAction(world, key, site)` | On-demand operator actions (`{ key, label, description }`) rendered as buttons in the world panel behind the admin key — "erupt the nearest volcano". `onAction` runs between ticks at the clicked cell and returns `{ ok, detail }`; the one-line `detail` is shown to the operator verbatim. |

The `world: WorldApi` you are handed is narrow on purpose:

- **Read:** `worldSize`, `chunksPerEdge`, `difficulty` (1–100, core attaches no
  meaning — your plugin decides what "hard" means), `simMillis` / `genesisMillis` (the
  world clock — read it through `shared/src/calendar.ts` helpers, never keep your own
  day counter), `heightAt`, `isCellUnlocked`, `isChunkUnlocked`, `riverNetwork()`,
  `freshwater`, `players()`, `isChunkVisibleTo` / `isCellVisibleTo` (one player's own
  fog-of-war mask).
- **Act:** `sculpt(x, y, radius, amount)`, `unlockChunk(cx, cy)` (whole world),
  `unlockChunkForToken(token, cx, cy)` (one player — the per-player creep primitive).
- **Talk:** `broadcast(type, payload)`, `sendTo(playerId, type, payload)`,
  `broadcastVisible(type, items, positionOf, buildPayload, options?)` (per-recipient
  payloads filtered by each player's own unlock mask — use this instead of looping
  `players()` and filtering by hand), `emitEvent(type, payload)` (server-side, to other
  plugins).
- **Configure / depend:** `setting(key)`, `sibling(name)` (below).

There is no way to write a raw height — a plugin's edit goes through the same brush,
gradient relaxation and mask filtering a player's does, so plugins cannot desync clients
or bypass the terrain rules. Every `WorldApi` is revoked when the world closes; a
reference stashed at module scope throws after that, so re-acquire it from each hook.

Behaviours worth knowing:

- **`onIntent` is an interceptor chain.** The first `deny` wins and stops the chain; a
  `modify` passes the *replacement* intent to the next plugin. This is how a mana
  economy or a cooldown is built without patching the sim — price in `onIntent`,
  charge in `onIntentApplied`.
- **A broken plugin must not take the world down.** Every hook is wrapped: a throw is
  logged, counted against the plugin, and skipped for that call. A plugin that throws in
  `onIntent` is treated as *allow*, so a buggy extension cannot silently make the world
  unsculptable.
- **`onWorldEvent` and `messages` run synchronously.** An event handler that emits is
  guarded against runaway cascades (`MAX_WORLD_EVENT_DEPTH` in `host.ts`).

### Persistence: versions, refusal, rollback

`save()` must return JSON-serialisable data. The host stores it in an envelope
`{ v, data }` stamped with your `persistence.version`, and hands `load()` the stored
version as `fromVersion` (a slice written before envelopes existed arrives as `1`).

- **Bump `version` when `save()`'s shape changes** in a way `load()` cannot read blind,
  and teach `load()` to migrate every older version (see `plugins/monsters` for the
  reference pattern).
- **Return `'refuse'` from `load()` for bytes this build cannot read.** The host then
  *parks* the slice: it is re-emitted verbatim by every snapshot for the rest of the
  session and your plugin runs stateless. A stored version *ahead* of yours (an operator
  downgraded) is parked automatically. Returning your own empty state instead would be
  written over the real slice about a minute later — that is the bug refusal exists to
  prevent.
- **`load()` + `onWorldCreate()` are re-runnable on a live process** (rollback to a
  restore point, reopen after an enablement change). Both must *replace* state; a load
  that appends or a create that spawns would double on every rollback.

### Per-world enablement and settings

Every installed plugin can be switched on or off **per world** from the world panel
(admin key). A plugin switched off for a world gets no hooks except `onWorldClose`, and
its `sibling()` lookup answers `null` to everyone. Toggling reopens the world, which
replays restore + `onWorldCreate` for every enabled plugin and carries connected
players across.

A plugin can also declare a closed set of operator settings:

```ts
settings: [{ key: 'growth-model', values: ['life', 'populous'], defaultValue: 'life' }],
```

The panel renders a control for each; the value reaches you via
`world.setting('growth-model')` — read it **once in `onWorldCreate`**, because changing
it reopens the world. `undefined` means the world has no row; the default is yours to
apply, not core's.

### Depending on another plugin

A self-hoster may delete any folder, or disable it for one world, so a sibling is never
a package-manager dependency. Never `import` it — a missing folder would fail module
resolution and abort boot. Ask the host instead:

```ts
const mana = world.sibling('mana');           // module namespace, or null
if (mana && typeof mana.setManaPerk === 'function') { … }
```

The host guarantees it never throws for an absent sibling and answers synchronously
whatever the load order. What stays with you: **duck-type** the module (a folder can
exist and export an older API), and **buffer, don't drop** — record what you wanted to
tell the sibling and replay it when it appears, re-resolving in every `onWorldCreate`.
`plugins/relics/server/mana-bridge.ts` is the reference bridge; read its header before
writing another. If your plugin exposes a registration API to siblings (fire's fuel
registry does), also expose the unregister, and have consumers call it from
`onWorldClose`.

### The client half

A plugin's client half lives at `plugins/<name>/client/index.ts`, exports a
`TerraceClientPlugin` as `clientPlugin` with the **same `name`**, and is compiled into
the client bundle — add one import line to `client/src/plugins/registry.ts`. Its
`attach(ctx)` receives a `ClientPluginCtx` (`client/src/plugins/types.ts`): a private
Three.js `layer`, `onMessage` / `send` for your namespaced messages, `onFrame`,
`registerHudPanel` (Solid components), `registerTool`, terrain picking,
`onLocalIntent` for a client-side gate that mirrors your server `onIntent`, plus
mover poses and sky-rig hooks — the file's doc comments are the contract. Client
halves need a `package.json` with `solid-js` (see `plugins/mana`).

Because the client half is compiled in, **updating a plugin's client code always needs
a new client build**. A successful server-side reload or restart rebinds the build
identity; browsers notice on their next join snapshot and reload the page once.

### Updating a running plugin

- **`serverRestart`** (world panel) — the recommended path for any update. Snapshots,
  exits with a restart code, the supervisor brings the new code up, players are carried
  across.
- **`reloadPlugin`** (world panel, per plugin) — re-imports *one* plugin's server code in
  process and reopens the world over it. If the import, `onWorldCreate`, `load()` or one
  probe tick faults, the previous build is put back. A dev-loop convenience: each reload
  leaks ≈0.66 MB (Node cannot evict modules), and it cannot update the client half.

### Plugin gotchas

- **Node prints a `MODULE_TYPELESS_PACKAGE_JSON` warning** for a bare `.ts` plugin. It
  is harmless. Silence it by adding `plugins/hello/package.json`:
  `{"name": "@terrace/plugin-hello", "version": "0.1.0", "private": true, "type": "module"}`.
  The `version` there is also the first half of the stamp the world panel shows for your
  plugin, so an operator can see which build is live.
- **If your plugin has npm dependencies**, it needs that `package.json` (it becomes a
  workspace package via the `plugins/*` glob) *and* you must run `pnpm install` once to
  update `pnpm-lock.yaml`. The Docker build installs with `--frozen-lockfile` and will
  fail with `ERR_PNPM_OUTDATED_LOCKFILE` otherwise. A dependency-free plugin package
  needs no lockfile change.
- **A malformed plugin aborts boot** rather than starting a world quietly missing its
  economy. Duplicate plugin names, a missing `plugin` export, or an ambiguous one are
  all fatal and say why.
- **A folder with only a `client/` half** is skipped by the server host with a log
  line, not an error.
- **Don't keep a `WorldApi` at module scope.** It is revoked at world close; take it
  from the hook that is running.
- **`load()` that throws is not the same as `'refuse'`.** A throw is logged and skipped,
  your plugin comes up empty, and the next snapshot writes that empty state over the
  slice. Guard `load()` and return `'refuse'` on anything you cannot read.

---

## Development setup

You need **Node 24+** (the server runs `.ts` directly via Node's type stripping — no
build step) and **pnpm 10** (`corepack enable` gets you the pinned version). **Python
3** is only needed for the `run_server.py` convenience launcher below — skip it and run
the two `pnpm` commands yourself if you don't have it.

```sh
pnpm install            # a warning about ignored build scripts for better-sqlite3
                        # and msgpackr-extract is expected — both ship prebuilt
                        # binaries, nothing needs compiling
```

Then start the dev stack. `run_server.py` is one command for both halves:

```sh
python3 run_server.py   # world server on :2567 + Vite dev client on :5173;
                        # Ctrl-C stops both cleanly (each runs in its own
                        # process group so neither is orphaned)
```

or run them yourself in two terminals:

```sh
pnpm --filter @terrace/server start     # world server on :2567
pnpm --filter @terrace/client dev       # Vite dev server on :5173
```

Open <http://localhost:5173>. The dev client defaults to `ws://localhost:2567`;
`VITE_SERVER_URL` and `VITE_ROOM_NAME` override it.

`run_server.py`'s `CONFIG` dict at the top mirrors the server's own env vars (`PORT`,
`WORLD_SIZE`, `WORLD_DIFFICULTY`, `DB_PATH`, `TICK_HZ`, `SNAPSHOT_INTERVAL_S`,
`PLUGINS_DIR`, `CLIENT_DIST_PATH`) — edit a value there, set it to `None` to fall back
to the server's built-in default, or export it in the shell for a one-off override
(`PORT=2599 python3 run_server.py`). Its `CLIENT_MODE` switches between `"dev"`
(default — spawns the Vite dev server, always current, nothing to rebuild), `"static"`
(builds `client/dist` once if missing and lets the game server serve it on `:PORT`,
but does **not** rebuild on source changes) and `"none"` (server only).

```sh
pnpm typecheck          # every workspace package
pnpm test               # Vitest across the workspace
```

Both must pass before any commit that touches `shared/`.

### LAN play from WSL2

If the server runs inside WSL2 (Windows), phones and other PCs on the LAN can't reach
it directly — WSL2 sits behind its own NAT'd address. In an **elevated** PowerShell on
Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1
```

This forwards ports `5173` (Vite dev client) and `2567` (game server / WebSocket
protocol, and the built client in `"static"` mode) from Windows to the current WSL IP
via `netsh interface portproxy`, opens matching inbound firewall rules, and prints the
LAN IP to hand out. The WSL IP drifts across reboots, so **re-run this after every
reboot** if phones stop connecting.

**Use the raw IP the script prints, not a `<hostname>.local` name.** A `.local` mDNS
name answers with several addresses at once (an IPv6 link-local plus every virtual
adapter), and a device that picks the wrong one — iPhones prefer IPv6 — fails to
connect, apparently at random. The raw IPv4 address is deterministic.

One LAN-specific gotcha already fixed: `crypto.randomUUID()`, used to mint a player's
identity token, only works in a browser
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
(HTTPS or `localhost`) — a phone opening `http://<lan-ip>:5173` is neither, and calling
it threw, which the join code misread as "server not up" and retried forever (silent,
permanent "Offline"). The client now falls back to building the same UUID shape from
`crypto.getRandomValues` (no secure-context restriction) when `randomUUID` is missing,
so plain-HTTP LAN play works — see `client/src/state/playerToken.ts`.

### Workspace layout

```
shared/     terrain math + protocol types — imported by BOTH client and server,
            and the single source of truth for both. Never duplicate its math.
            Deterministic (integer-only, fixed iteration order) so client-side
            prediction and the server agree exactly.
client/     Vite + SolidJS + Three.js. Solid owns the HUD; a plain imperative
            render loop owns the canvas.
server/     Colyseus room, tick loop, intent pipeline, unlock mask, SQLite
            snapshots, plugin host. One process = one world.
plugins/    auto-discovered at boot, alphabetical directory order:
              boats       a coastal settlement's fleet, which fights the kraken
              chronicle   the world's history, written from other plugins' events
              daynight    a slow server-authoritative day/night clock and sky
              fire        cells that burn, consuming fuel other plugins register
              flora       trees grow in on green ground left undisturbed
              invite      hands joining players a shareable URL for their friends
              mana        a regenerating resource pool that vetoes/charges sculpts
              monsters    a singleton habitat creature that guards its territory
              mudslides   saturated steep ground gives way and flows downhill
              pilgrims    settlers who walk from the temple and found homes
              populous    the Bullfrog growth rule, selectable in structures (server-only)
              relics      collectible skill gems (passive and active) players find
              reveal      per-player progressive territory unlock
              storms      tornadoes, hurricanes, typhoons and cyclones
              structures  settlements as Conway's Game of Life over buildable land
              temples     the one player-placed building
              volcanoes   cones, eruptions and lava flows
              weather     ambient rain/storm/snow/fog — reads terrain, never writes it
              wildlife    ambient/reactive fauna population sim
```

Conventions that matter if you send a patch: TypeScript strict, named exports,
conventional commits, verbose comments on the critical paths (terrain math, intent
validation, sync and persistence). `shared/` sticks to erasable TypeScript syntax — no
enums, no namespaces — because Node runs it without a compiler.
