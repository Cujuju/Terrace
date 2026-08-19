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

Design decisions and their rationale live in [`docs/DESIGN.md`](docs/DESIGN.md).

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

Terrace v1 has no accounts and no authentication (deliberately — see `docs/DESIGN.md`
§3.7). Anyone who can reach those ports can sculpt your world. On the public internet,
put it behind something that limits who gets in.

---

## Configuration

Copy `.env.example` to `.env` and edit. Compose reads `.env` from the repo root
automatically. Everything has a working default; nothing here is a secret, and
nothing is required to boot a world.

| Variable | Default | What it does |
|---|---|---|
| `WORLD_SIZE` | `512` | Cells per world edge. Must be a multiple of 16 (the chunk size), max 4096. `128` is Populous-proven playable and comfortable on a small VPS; `512` wants a mid-size box. **Cannot be changed on an existing world** — the server refuses to boot rather than reinterpret your heightmap. |
| `PORT` | `2567` | Port the world server listens on. Compose maps the same number on the host, so host and container never disagree. Change it and you must update `PUBLIC_WS_URL` too. |
| `DB_PATH` | `/data/world.db` | SQLite world database, as a path *inside* the container. Both `/data/world.db` and `./data/world.db` are mounted from the world volume, so either persists; any other path is lost on the next rebuild. |
| `TICK_HZ` | `10` | Fixed simulation tick rate, 1–60. Rendering interpolates, so raising this mostly buys CPU load. |
| `SNAPSHOT_INTERVAL_S` | `60` | How often a changed world is written to SQLite, 1–3600. An idle world writes nothing at all. |
| `PLUGINS_DIR` | `<repo>/plugins` | Directory scanned for plugins at boot. Inside the image that is `/app/plugins`; leave it alone unless you are mounting plugins from elsewhere. |
| `PUBLIC_WS_URL` | `ws://localhost:2567` | *Compose only.* The WebSocket address the browser dials, **baked into the client bundle at build time** — changing it requires `docker compose up --build`. |
| `CLIENT_PORT` | `8080` | *Compose only.* Host port that serves the client page. |

Invalid values fail fast at boot with a message naming the variable, rather than
corrupting a world hours later.

---

## How the pieces fit

```
browser ──HTTP:8080──▶ client   (nginx serving the Vite-built bundle)
   └─────WS:2567─────▶ server   (Colyseus, authoritative world, SQLite) ──▶ volume terrace_world-data
```

Two containers, because the core server speaks Colyseus and nothing else — it serves no
static files, by design (core stays a substrate, not a web framework). The `client`
service is a plain nginx layer holding the built bundle; the browser talks to the
server directly over WebSocket. Both are built from the one root `Dockerfile`
(`--target client` / `--target server`).

If you front this with a reverse proxy for TLS, the server side needs both the
`/matchmake/*` HTTP routes and the WebSocket upgrade proxied to port 2567, and
`PUBLIC_WS_URL` set to `wss://…`. That path is documented but untested here.

---

## Your data, and how to back it up

Everything — heightmap, unlock mask, and every plugin's persisted slice — lives in one
SQLite database in the Docker volume **`terrace_world-data`**.

The server writes a snapshot every `SNAPSHOT_INTERVAL_S` **only if the world changed**,
keeps the **last 10**, and writes one final snapshot on clean shutdown. So
`docker compose stop` / `Ctrl-C` never loses work, and a crash costs at most one
interval. The rolling ten are your undo-by-hand if someone flattens a mountain you
liked.

**Back up (safe method — stop first).** The database runs in WAL mode, so copying it
while the server is live can capture a torn state:

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

**Start over:** `docker compose down -v` deletes the volume and the world with it.

**Upgrading:** `git pull && docker compose up --build`. Snapshots are versioned; a
database this build cannot read is refused loudly instead of half-applied.

---

## Write your first plugin

A plugin is a folder under `plugins/` with a `server/index.ts` that exports a
`TerracePlugin`. That is the entire contract — no registration, no manifest. The host
scans `plugins/` at boot, in alphabetical directory order (which is also intent
interceptor order, so it is stable across machines).

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
    console.log(`[hello] world is ${world.worldSize}x${world.worldSize} cells`);
  },

  onTerrainChanged(diff) {
    sculpts++;
    console.log(`[hello] edit #${sculpts} changed ${diff.length} cells`);
  },

  // Plugin-owned snapshot data: saved with the world, handed back on boot.
  persistence: {
    save: () => ({ sculpts }),
    load: (data) => {
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

Every hook is optional. From `server/src/plugins/types.ts`:

| Hook | When it fires |
|---|---|
| `onWorldCreate(world)` | Once at boot, after any snapshot has been restored. |
| `onTick(world, dt)` | Every simulation tick; `dt` is the fixed tick period in seconds. |
| `onIntent(intent, ctx)` | Before a sculpt is applied. Return `{kind:'deny', reason}` to veto, `{kind:'modify', intent}` to rewrite it, or nothing to allow. |
| `onTerrainChanged(diff)` | After any applied edit, with the full server-side diff. |
| `onPlayerJoin(player)` / `onPlayerLeave(player)` | Presence. |
| `messages` | `{ [type]: (world, player, payload) => void }` — client→server handlers, received on the wire as `hello:<type>`. |
| `persistence` | `{ save(), load(data) }` — your slice of the world snapshot. |

The `world: WorldApi` you are handed is narrow on purpose: `heightAt`,
`isCellUnlocked`, `isChunkUnlocked`, `sculpt(x, y, radius, amount)`,
`unlockChunk(cx, cy)`, `players()`, `broadcast(type, payload)`,
`sendTo(playerId, type, payload)`. There is no way to write a raw height — a plugin's
edit goes through the same brush, gradient relaxation and mask filtering a player's
does, so plugins cannot desync clients or bypass the terrain rules.

Two behaviours worth knowing:

- **`onIntent` is an interceptor chain.** The first `deny` wins and stops the chain; a
  `modify` passes the *replacement* intent to the next plugin. This is how a mana
  economy or a cooldown is built without patching the sim.
- **A broken plugin must not take the world down.** Every hook is wrapped: a throw is
  logged and skipped for that call. A plugin that throws in `onIntent` is treated as
  *allow*, so a buggy extension cannot silently make the world unsculptable.

### Plugin gotchas

- **Node prints a `MODULE_TYPELESS_PACKAGE_JSON` warning** for a bare `.ts` plugin. It
  is harmless. Silence it by adding `plugins/hello/package.json`:
  `{"name": "@terrace/plugin-hello", "version": "0.1.0", "private": true, "type": "module"}`.
- **If your plugin has npm dependencies**, it needs that `package.json` (it becomes a
  workspace package via the `plugins/*` glob) *and* you must run `pnpm install` once to
  update `pnpm-lock.yaml`. The Docker build installs with `--frozen-lockfile` and will
  fail with `ERR_PNPM_OUTDATED_LOCKFILE` otherwise. A dependency-free plugin package
  needs no lockfile change.
- **A malformed plugin aborts boot** rather than starting a world quietly missing its
  economy. Duplicate plugin names, a missing `plugin` export, or an ambiguous one are
  all fatal and say why.
- **Client-side plugin halves** (HUD panels, scene layers) are compiled into the client
  bundle at build time; a folder with only a `client/` half is skipped by the server
  host with a log line, not an error.

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
              flora       trees grow in on green ground left undisturbed
              invite      hands joining players a shareable URL for their friends
              mana        a regenerating resource pool that vetoes/charges sculpts
              monsters    a singleton habitat creature that guards its territory
              relics      collectible skill gems (passive and active) players find
              reveal      per-player progressive territory unlock
              structures  settlements as Conway's Game of Life over buildable land
              weather     ambient rain/storm/snow/fog — reads terrain, never writes it
              wildlife    ambient/reactive fauna population sim
```

Conventions that matter if you send a patch: TypeScript strict, named exports,
conventional commits, verbose comments on the critical paths (terrain math, intent
validation, sync and persistence). `shared/` sticks to erasable TypeScript syntax — no
enums, no namespaces — because Node runs it without a compiler.
