# Terrace

Self-hostable multiplayer terrain sculpting in the browser — the terraced
god-game landscape of *Populous* and *Godus*, on a server you own.

Core is terrain simulation, real-time sync, persistence and a plugin host.
Everything gamey (mana, settlers, weather, monsters) is a plugin.

- The server is authoritative: clients send intents, never heights.
- Each world is one SQLite file. Restart the server and it comes back.

## Quickstart

Needs Node 24+ and pnpm (version pinned in `package.json`).

```sh
git clone https://github.com/Cujuju/Terrace.git
cd Terrace
pnpm install
pnpm --filter @terrace/client build
pnpm --filter @terrace/server start
```

When the log shows `[terrace] listening on ws://0.0.0.0:2567`, open
<http://localhost:2567>. The server hosts both the page and the world.

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

Ctrl-C stops the server. Worlds are saved in `server/data/worlds/` and come
back on the next start.

### Playing with friends

Open port `2567` and send friends `http://your-host:2567`. The page connects
back to whichever server it was loaded from, so there is nothing to rebuild.

There are no accounts. Anyone who can reach that port can sculpt your world,
so on the public internet put something in front of it that limits access.

## Configuration

Copy `.env.example` to `.env` and edit it, or set environment variables when
starting the server (they win over `.env`). Nothing is required; every value
has a default, and invalid values fail at boot naming the variable.

| Variable | Default | |
|---|---|---|
| `WORLD_SIZE` | `2048` | Cells per edge for new worlds. Multiple of 16, 448–4096. `512` suits a small VPS. |
| `WORLD_DIFFICULTY` | `50` | 1–100. Plugins decide what it means. |
| `PORT` | `2567` | Port for the page and the world server. |
| `ROLLBACK_KEY` | *(none)* | Protects the **Restore points** panel. Unset = no key needed. |
| `WORLD_ADMIN_KEY` | *(none)* | Protects the **Worlds** panel. Unset = no key needed. |
| `PLUGINS_ENABLED` | *(unset)* | Comma-separated plugin allow-list, or `none` for bare terrain. |
| `SNAPSHOT_INTERVAL_S` | `60` | How often a changed world is saved. |
| `SNAPSHOT_RETENTION` | `10` | Restore points kept per world. Pinned points don't count. |

`.env.example` documents the rest.

## Worlds and backups

- A restore point is saved every `SNAPSHOT_INTERVAL_S` when the world changed,
  and on clean shutdown. Pin one to keep it forever.
- The **Worlds** panel creates, loads, renames, duplicates and archives worlds.
  Archiving moves the file to `.trash`; only an explicit **Purge** deletes one.
- Import a world file: `pnpm --dir server import-world /path/to/world.db`
- Back up: stop the server, then copy `server/data/worlds/` (or your
  `WORLDS_DIR`). Copy only while stopped; the databases use WAL mode.

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

For live reload, run the server and the Vite dev client side by side:

```sh
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
