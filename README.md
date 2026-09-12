# Terrace

Self-hostable multiplayer terrain sculpting: the terraced god-game landscape of
*Populous* and *Godus*, in a browser, on a server you own.

Terrace is not a game. Core ships four things — terrain simulation, real-time
sync, persistence, and a plugin host. Everything gamey (mana, followers,
territory reveal, weather) is a plugin, and you should never have to touch core
to build one.

- Clients send intents ("raise at cell x,y"), never heights. The server decides.
- A world is one SQLite file. Kill the process, restart, it comes back.
- MIT licensed.

Architecture and standing rules are in [`docs/DESIGN.md`](docs/DESIGN.md); dated
decisions in [`docs/decisions/`](docs/decisions/README.md).

## Quickstart

You need Docker Engine 23+ with Compose v2. Nothing else — no Node, no pnpm, no
database.

```sh
git clone https://github.com/Cujuju/Terrace.git
cd Terrace
docker compose up
```

The first build takes a few minutes. When the log says

```
[terrace] listening on ws://0.0.0.0:2567 (room "world")
```

open <http://localhost:8080> and start sculpting.

| Input | Action |
|---|---|
| left click / drag | raise land |
| shift + left click / drag | lower land |
| right drag | orbit |
| middle drag | pan |
| wheel | zoom |
| one-finger touch | sculpt (tap **Mode** for raise/lower) |
| two-finger touch | pinch zoom + pan, or orbit |

Raise, lower, orbit and pan rebind to any mouse button plus an optional modifier,
under **Controls** in the HUD. The choice is saved in the browser.

Stop with `Ctrl-C` or `docker compose down`. Your world survives both — it lives
in a Docker volume, not in the containers.

### Playing with other people

The address the browser dials is baked into the client bundle at build time, so
it has to be one your friend's browser can reach:

```sh
cp .env.example .env
# in .env:
PUBLIC_WS_URL=ws://your-box.example:2567

docker compose up --build      # --build is required, the URL is compiled in
```

Open both `8080` (the page) and `2567` (the world server) on the firewall.

Set `SHARE_URL` to the address friends should open and every client's HUD grows
an **Invite** line with a copy button. Without it, players who joined over the
network see their own address, and only the host's `localhost` view has nothing
to share — which is the whole reason `SHARE_URL` exists. Browsers can't discover
servers over mDNS, so a URL you can paste to someone *is* the discovery story.

There are no accounts and no authentication. Players are anonymous, identified by
a display name and a browser-generated token, and anyone who can reach those
ports can sculpt your world. On the public internet, put something in front of it
that limits who gets in.

## Configuration

Copy `.env.example` to `.env` and edit; Compose reads it from the repo root.
Everything has a working default and nothing is required to boot a world. Invalid
values fail at boot with a message naming the variable, rather than corrupting a
world hours later.

| Variable | Default | What it does |
|---|---|---|
| `WORLD_SIZE` | `2048` | Cells per world edge, for **new** worlds. Four cells make one world unit, so the default is a 512-unit world and wants a mid-size box; `512` cells is the 128-unit Populous-proven minimum that fits a small VPS. Multiple of 16, from 448 to 4096. Existing worlds keep the size they were made with, and sizes can coexist. |
| `WORLD_DIFFICULTY` | `50` | 1 (warm) to 100 (punishing). Core just stores it; plugins decide what it means (today, mana's regen rate). Out-of-range clamps with a warning. |
| `PORT` | `2567` | World server port. Compose maps the same number on the host. Change it and update `PUBLIC_WS_URL` too. |
| `WORLDS_DIR` | `/data/worlds` | Where worlds live — one SQLite file each, plus `.trash/` and `.active`. Must be under the mounted volume or it's lost on the next rebuild. |
| `DB_PATH` | `/data/world.db` | Legacy single-world database from before worlds were files. Copied into `WORLDS_DIR` once, then ignored. |
| `ROLLBACK_KEY` | `terrace` *(public!)* | Unlocks the **Restore points** panel and `pnpm --dir server rollback`. The default is in the source, so the server warns at boot. Set your own (8+ chars), or `ROLLBACK_KEY=` to disable. |
| `WORLD_ADMIN_KEY` | `terrace` *(public!)* | Unlocks the **Worlds** panel: create, load, rename, duplicate, archive, plugin enablement and actions. Separate from `ROLLBACK_KEY` because the blast radius is bigger. |
| `WORLD_SWITCH_COUNTDOWN_S` | `10` | How long a world switch is announced when someone else is connected. Skipped when the operator is alone; `0` switches immediately. |
| `TICK_HZ` | `10` | Fixed simulation tick, 1–60. Rendering interpolates, so raising this mostly buys CPU load. |
| `SNAPSHOT_INTERVAL_S` | `60` | How often a changed world is written, 1–3600. An idle world writes nothing. |
| `SNAPSHOT_RETENTION` | `10` | Restore points kept per world, 1–100. With the default cadence that's ten minutes of undo. Pinned points don't count. |
| `PLUGINS_DIR` | `<repo>/plugins` | Scanned at boot. `/app/plugins` in the image; leave it unless you mount plugins from elsewhere. |
| `PLUGINS_ENABLED` | *(unset)* | Overrides every world's plugin enablement for this run: a comma-separated allow-list of plugin names, or `none` for a core-only world (terrain, water, sky). Unset, each world's own settings apply. Plugins stay installed either way, so their saved slices are kept. |
| `PUBLIC_WS_URL` | `ws://localhost:2567` | *Compose only.* Baked into the client bundle, so changing it needs `--build`. |
| `CLIENT_PORT` | `8080` | *Compose only.* Host port serving the client page. |
| `TERRACE_VERSION` | *(unset)* | *Compose only.* Build stamp, e.g. `TERRACE_VERSION=$(git rev-parse --short HEAD) docker compose up --build`. Open pages compare it across a restart to decide whether to reload. Unset, every restart looks new and pages reload once. |

Plugins read their own variables from the same `.env`; `.env.example` documents
each one.

## How the pieces fit

```
browser ──HTTP:8080──▶ client   (nginx serving the Vite-built bundle)
   └─────WS:2567─────▶ server   (Colyseus, authoritative world, SQLite) ──▶ volume terrace_world-data
```

Compose runs two containers from the one root `Dockerfile` (`--target client` /
`--target server`), and the browser talks to the server directly over WebSocket.

Outside Compose, one process is one playable URL: if a built client exists at
`CLIENT_DIST_PATH` (default `client/dist`), the game server serves it on its own
port with SPA fallback, and the client dials `ws://<its own host>` unless
`VITE_SERVER_URL` / `PUBLIC_WS_URL` say otherwise. `http://host:PORT` is then the
whole game.

Behind a reverse proxy for TLS you need the `/matchmake/*` HTTP routes *and* the
WebSocket upgrade proxied to 2567, with `PUBLIC_WS_URL` set to `wss://…`. That
path is documented but untested here.

## Worlds and backups

Each world is its own SQLite database under `WORLDS_DIR` (Docker volume
`terrace_world-data`) holding its heightmap, unlock masks and every plugin's
persisted slice. One world simulates at a time; the rest sit on disk.

That layout is load-bearing. Worlds used to share a database, with retention
keeping the newest 10 snapshots *across all of them* — so a world you'd stopped
playing could have its history evicted by one you were playing. Retention now
runs inside a single world's file and can't reach another's.

**Restore points.** A snapshot is written every `SNAPSHOT_INTERVAL_S` if the
world changed, plus one on clean shutdown, keeping the last
`SNAPSHOT_RETENTION`. So `Ctrl-C` never loses work and a crash costs at most one
interval. Pin a point to exempt it from retention — pinned points survive any
amount of later play and don't count against your undo depth. Roll back from the
**Restore points** panel or offline with `pnpm --dir server rollback`.

**Managing worlds** (Worlds panel, admin key): every world with its size, restore
points, disk use and when you last played it; create, load, rename, duplicate
with its history, archive.

**Nothing deletes a world by accident.** Archiving *moves* the file to
`WORLDS_DIR/.trash` and tells you where it went. Only **Purge** — on the Trash
tab, on an already-archived world, after you type its name back — ever unlinks
one. Boot never replaces a missing world with a fresh one; it loads nothing and
logs what it couldn't open.

Import a world from a backup or another checkout:

```sh
pnpm --dir server import-world /path/to/some-world.db
```

It copies; your original isn't touched.

Recover history from an old backup. Retention is a rolling window, so last week's
backup holds points this week's play has pruned, and the live world holds
everything since — neither is a superset. Make the union:

```sh
pnpm --dir server merge-world-history old-backup.db worlds/your-world.db --pin
```

It copies only the snapshots the target lacks, refuses two files that aren't the
same world, and never writes to the source. `--pin` exempts what it recovers from
retention, which you almost always want: recovered points are old by definition,
so without it the next write prunes them straight back out.

**Back up.** The databases run in WAL mode, so copying them live can capture a
torn state. Stop first:

```sh
docker compose stop server                      # final snapshot, closes the DB
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

**Start over:** `docker compose down -v` deletes the volume and every world in
it. No undo for that one.

**Upgrade:** `git pull && docker compose up --build`. Snapshots are versioned; a
database this build can't read is refused loudly instead of half-applied.

## Plugins

A plugin is a folder under `plugins/` with a `server/index.ts` exporting a
`TerracePlugin`. The host finds it at boot — no registration, no manifest — and
each world chooses which installed plugins run in it.

**[How to write one →](docs/plugins.md)** covers the hello-world plugin, every
hook, `WorldApi`, persistence and versioning, per-world settings, depending on
another plugin, the client half, and the gotchas.

What ships in `plugins/`:

| | |
|---|---|
| `boats` | a coastal settlement's fleet, which fights the kraken |
| `chronicle` | the world's history, written from other plugins' events |
| `daynight` | a slow server-authoritative day/night clock and sky |
| `fire` | cells that burn, consuming fuel other plugins register |
| `flora` | trees grow in on green ground left undisturbed |
| `invite` | hands joining players a shareable URL for their friends |
| `mana` | a regenerating pool that vetoes and charges for sculpts |
| `monsters` | a singleton habitat creature that guards its territory |
| `mudslides` | saturated steep ground gives way and flows downhill |
| `pilgrims` | settlers who walk from the temple and found homes |
| `populous` | the Bullfrog growth rule, selectable in structures |
| `relics` | collectible passive and active skill gems |
| `reveal` | per-player progressive territory unlock |
| `storms` | tornadoes, hurricanes, typhoons and cyclones |
| `structures` | settlements as Conway's Game of Life over buildable land |
| `temples` | the one player-placed building |
| `volcanoes` | cones, eruptions and lava flows |
| `weather` | ambient rain, storm, snow and fog — reads terrain, never writes |
| `wildlife` | ambient and reactive fauna population sim |

## Development

You need Node 24+ (the server runs `.ts` directly via type stripping, no build
step) and pnpm 10 (`corepack enable`). Python 3 is only for the `run_server.py`
launcher.

```sh
pnpm install     # the ignored-build-scripts warning for better-sqlite3 and
                 # msgpackr-extract is expected; both ship prebuilt binaries
```

Then either one command for both halves:

```sh
python3 run_server.py   # server on :2567, Vite client on :5173, Ctrl-C stops both
```

or run them yourself:

```sh
pnpm --filter @terrace/server start
pnpm --filter @terrace/client dev
```

Open <http://localhost:5173>. The dev client defaults to `ws://localhost:2567`;
`VITE_SERVER_URL` and `VITE_ROOM_NAME` override it.

`run_server.py`'s `CONFIG` dict mirrors the server's env vars — edit a value, set
it to `None` for the server's own default, or export it for a one-off
(`PORT=2599 python3 run_server.py`). `CLIENT_MODE` picks `"dev"` (spawns Vite,
always current), `"static"` (builds `client/dist` once if missing and serves it
on `:PORT`, without rebuilding on change) or `"none"`.

```sh
pnpm typecheck
pnpm test
```

Both must pass before any commit touching `shared/`.

### LAN play from WSL2

WSL2 sits behind its own NAT, so phones and other PCs can't reach it directly. In
an elevated PowerShell on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1
```

That forwards `5173` and `2567` to the current WSL IP via `netsh interface
portproxy`, opens the firewall rules, and prints the LAN IP. The WSL IP drifts
across reboots, so re-run it when phones stop connecting.

Use the raw IP it prints, not a `<hostname>.local` name: mDNS answers with
several addresses at once (IPv6 link-local plus every virtual adapter), and a
device that picks the wrong one — iPhones prefer IPv6 — fails seemingly at
random.

One LAN gotcha already fixed: `crypto.randomUUID()` only exists in a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
and a phone on `http://<lan-ip>:5173` is not one. Calling it threw, the join code
read that as "server not up", and retried forever behind a silent "Offline". The
client now falls back to `crypto.getRandomValues` — see
`client/src/state/playerToken.ts`.

### Layout

```
shared/     terrain math + protocol types, imported by BOTH halves and the single
            source of truth for both. Deterministic (integer-only, fixed
            iteration order) so prediction and the server agree exactly.
client/     Vite + SolidJS + Three.js. Solid owns the HUD; a plain imperative
            render loop owns the canvas.
server/     Colyseus room, tick loop, intent pipeline, unlock mask, SQLite
            snapshots, plugin host. One process = one world.
plugins/    auto-discovered at boot, in alphabetical order.
```

If you send a patch: TypeScript strict, named exports, conventional commits, and
verbose comments on the critical paths (terrain math, intent validation, sync,
persistence). `shared/` sticks to erasable TypeScript — no enums, no namespaces —
because Node runs it without a compiler.
