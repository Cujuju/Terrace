# Terrace

Self-hostable multiplayer terrain sculpting in the browser — the terraced
god-game landscape of *Populous* and *Godus*, on a server you own.

Core is terrain simulation, real-time sync, persistence and a plugin host.
Everything gamey (mana, settlers, weather, monsters) is a plugin.

- The server is authoritative: clients send intents, never heights.
- Each world is one SQLite file. Restart the server and it comes back.

## Quickstart

Needs Docker Engine 23+ with Compose v2.

```sh
git clone https://github.com/Cujuju/Terrace.git
cd Terrace
docker compose up
```

The first build takes a few minutes. When the log shows
`[terrace] listening on ws://0.0.0.0:2567`, open <http://localhost:8080>.

| Input | Action |
|---|---|
| left drag | raise land |
| shift + left drag | lower land |
| right drag | orbit |
| middle drag | pan |
| wheel | zoom |
| one-finger touch | sculpt (tap **Mode** for raise/lower) |
| two-finger touch | pinch zoom + pan, or orbit |

Bindings can be changed under **Controls** in the HUD.

`docker compose down` stops it; worlds live in the `terrace_world-data` volume
and survive. `docker compose down -v` deletes them.

### Playing with friends

The server address is compiled into the client, so set it to one your friends
can reach and rebuild:

```sh
cp .env.example .env
# in .env:  PUBLIC_WS_URL=ws://your-host:2567
docker compose up --build
```

Open ports `8080` (page) and `2567` (world server).

There are no accounts. Anyone who can reach those ports can sculpt your world,
so on the public internet put something in front of it that limits access.

## Configuration

Copy `.env.example` to `.env`. Nothing is required; every value has a default,
and invalid values fail at boot naming the variable.

| Variable | Default | |
|---|---|---|
| `WORLD_SIZE` | `2048` | Cells per edge for new worlds. Multiple of 16, 448–4096. `512` suits a small VPS. |
| `WORLD_DIFFICULTY` | `50` | 1–100. Plugins decide what it means. |
| `PORT` | `2567` | World server port. Update `PUBLIC_WS_URL` to match. |
| `CLIENT_PORT` | `8080` | Port serving the page. |
| `ROLLBACK_KEY` | *(none)* | Protects the **Restore points** panel. Unset = no key needed. |
| `WORLD_ADMIN_KEY` | *(none)* | Protects the **Worlds** panel. Unset = no key needed. |
| `PLUGINS_ENABLED` | *(unset)* | Comma-separated plugin allow-list, or `none` for bare terrain. |
| `SNAPSHOT_INTERVAL_S` | `60` | How often a changed world is saved. |
| `SNAPSHOT_RETENTION` | `10` | Restore points kept per world. Pinned points don't count. |

`.env.example` lists the rest.

## Worlds and backups

- A restore point is saved every `SNAPSHOT_INTERVAL_S` when the world changed,
  and on clean shutdown. Pin one to keep it forever.
- The **Worlds** panel creates, loads, renames, duplicates and archives worlds.
  Archiving moves the file to `.trash`; only an explicit **Purge** deletes one.
- Import a world file: `pnpm --dir server import-world /path/to/world.db`

Back up (stop first; the databases use WAL mode):

```sh
docker compose stop server
docker run --rm -v terrace_world-data:/data -v "$PWD:/backup" busybox \
  tar czf /backup/terrace-backup.tar.gz -C /data .
docker compose start server
```

## Plugins

A plugin is a folder under `plugins/` with a `server/index.ts`, found
automatically at boot. Each world picks which plugins run.
[Writing a plugin →](docs/plugins.md)

Included: `apache`, `boats`, `chronicle`, `cyclone`, `daynight`, `fire`,
`flora`, `fog`, `hydro`, `invite`, `mana`, `monsters`, `mudslides`, `music`,
`pilgrims`, `populous`, `rain`, `relics`, `reveal`, `saucers`, `snow`,
`structures`, `temples`, `thunderstorm`, `tornado`, `volcanoes`, `weather`,
`wildlife`.

## Development

Needs Node 24+ and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm --filter @terrace/server start   # world server on :2567
pnpm --filter @terrace/client dev     # client on :5173
```

```sh
pnpm typecheck
pnpm test
```

A desktop build (Electron) is also available: `pnpm electron:dev`, or
`pnpm dist` for a Windows installer.

| Folder | |
|---|---|
| `shared/` | Deterministic terrain math and protocol types, used by both client and server |
| `client/` | Vite + SolidJS + Three.js |
| `server/` | Colyseus room, tick loop, SQLite persistence, plugin host |
| `plugins/` | Auto-discovered at boot |

Architecture: [`docs/DESIGN.md`](docs/DESIGN.md).

## License

Free for noncommercial use under [PolyForm Noncommercial 1.0.0](LICENSE).
Commercial use needs a separate license:
[open an issue](https://github.com/Cujuju/Terrace/issues) to ask. Third-party
models keep their own terms (see each `LICENSES.md`).
