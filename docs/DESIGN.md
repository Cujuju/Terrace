# Terrace — Design & Decision Record

**Status:** Standing rules and architecture, settled with the project owner (Cujuju) —
do not relitigate without new information. Dated decision records are in
`docs/decisions/` (see section 10). Do not append decisions to this file.

---

## 1. Vision

Terrace is an **open-source, self-hostable, multiplayer terrain-sculpting platform**
inspired by the god-game terrain of *Populous* (1989) and *Godus* (2013). 

- The core ships terrain simulation, real-time sync, persistence, and a plugin host.
- Everything "gamey" (mana, followers, combat, win conditions, accounts) is a plugin.
- The success criterion for the architecture: reveal-of-territory, a mana economy, and
  a follower stub can each be built as plugins **without touching core**. If they can't,
  the plugin API is wrong.

Repo: `github.com/Cujuju/Terrace` (created, currently empty). License: **MIT**.

---

## 2. Domain background (why the terrain design looks like this)

Terrace targets the **Godus** look — terraced land built from discrete contour
bands — on an integer terrain model whose relaxation routine descends from
**Populous**. Everything below is the current model; constants are in
`shared/src/constants.ts`, the math in `shared/src/heightmap.ts` and
`shared/src/columns.ts`.

### The terrain model
- A cell is a **column: an ascending list of solid spans** `[floor, ceiling)`.
  `map.cells[i]` holds the ceiling of the topmost span (the walkable surface);
  columns with more than one span (overhangs, arches, caves) live in a sparse
  side table. Heights are integers in `[MIN_HEIGHT, MAX_HEIGHT]`.
- **Bands.** Rendered terraces are `BAND_HEIGHT` tall. A player click moves
  one band (`DEFAULT_SCULPT_AMOUNT = BAND_HEIGHT`); a terrace tread is one
  world unit wide (`MAX_STEP = BAND_HEIGHT / WORLD_UNIT_CELLS`).
- **Sea.** `SEA_LEVEL = 0`; a column is under sea water where the solid at the
  waterline sits at or below it. Sea is derived from the terrain, never
  simulated. Below the seabed the world continues through named **deep
  strata** (basalt, obsidian, lava) down to `MIN_HEIGHT`.
- **Freshwater.** Rivers, lakes and falls are derived from the terrain by
  `shared/src/rivers.ts` and rebuilt when the terrain changes; they are not
  simulated state either.

### Sculpting
- Four tools (`SCULPT_TOOLS`): **stamp** edits exactly its footprint and runs
  no relaxation — a spire stays a spire; **smooth** edits the footprint, then
  runs gradient-limit relaxation; **drag** levels cells to the band whose lip
  the player grabbed, in one intent; **carve** removes material from a grasped
  span. Two edge profiles: **soft** (linear falloff) and **hard** (level fill).
- The **player default is stamp + soft**; the library default for plugins
  calling `applySculpt` directly is smooth + soft. Player strokes are
  band-contained: relaxation spill may slope terrain outside the brush but
  never creates or erases a rendered level there.
- **Relaxation** (smooth tool only). Any 4-neighbour pair differing by more
  than `MAX_STEP + RELAX_SLACK` is pulled together by equal and opposite
  amounts, so the pass moves height and never creates it; it sweeps a bounding
  box that grows one cell per pass, stops when a pass changes nothing, and is
  capped at `SMOOTH_PASS_LIMIT`. Because the stamp does not relax, the gradient
  limit is a property the smooth tool enforces where it runs, not a world-wide
  invariant.

### World extent
- A world is `DEFAULT_WORLD_SPAN` world units square, streamed in chunks.
  Chunks unlock **per player**; the simulation runs on the union of every
  player's unlocked chunks. Core knows how to unlock a chunk for a player;
  **when** to unlock is a plugin's decision (`plugins/reveal`: instant creep
  when a player's own edit reaches a locked chunk).
- Godus has no canonical grid size. Do not invent one.

---

## 3. Architecture

### 3.1 Client — Vite + SolidJS + TypeScript + Three.js
- Three.js renders the terrain as per-chunk meshes under a 3D orbit camera.
  The render loop is plain TypeScript; Solid never owns the canvas.
- SolidJS (not React) owns the HUD. Its fine-grained reactivity does not
  re-render against the imperative frame loop.

### 3.2 Server — Node + Colyseus, authoritative
- `@colyseus/core` + `@colyseus/ws-transport` for rooms, transport and
  reconnection. State is synced by messages, not Colyseus schema. Node, not
  Bun: Colyseus targets Node.
- **Clients send intents, never heights.** The server validates (bounds,
  unlock mask, plugin verdicts), applies the edit via `shared/`, and broadcasts
  `CellDiff[]` (`{x, y, h, spans?}`). The client predicts with the same
  `shared/` math and reconciles against the diff.
- **Fixed tick loop** (`TICK_HZ`, default 10). Core has no ongoing simulation
  of its own; plugin `onTick` is where simulation lives.
- **One world live per process.** A crash takes down one world; scaling is
  more processes. No lobby layer in core. Plugin state is module-scoped, so
  running several worlds at once in one process is not supported (issue #78).
- **A world is a file.** One SQLite database per world under `WORLDS_DIR`.
  An in-game panel gated by `WORLD_ADMIN_KEY` creates, loads, renames,
  duplicates and archives worlds; loading one saves and closes the current
  one. Retention runs inside a file and cannot touch another world's history.
  Archiving moves the file to `WORLDS_DIR/.trash`; only an explicit purge of an
  archived world unlinks it. Boot never replaces a missing world with a new
  one. Restore points can be pinned, exempting them from retention.

### 3.3 `shared/` — the contract
- One workspace package imported by client and server: terrain math (columns,
  sculpting, relaxation, sea and freshwater, band quantization) and the
  protocol types (intents, diffs, snapshots, join). Never duplicate its math;
  see the determinism rules in the project `CLAUDE.md`.

### 3.4 Terrain storage and visibility
- `createHeightmap(size)` allocates the whole world up front; no live
  resizing. `WORLD_SIZE` is server config, clamped to
  `[MIN_WORLD_SIZE, MAX_WORLD_SIZE]`.
- **Locked chunks are never sent.** The join snapshot carries only the joining
  player's own unlocked chunks; sculpt intents on locked cells are rejected
  server-side. A client holds no full-map data to protect.
- Rendering is terraced: heights quantize into `BAND_HEIGHT` bands.

### 3.5 Plugin platform (the core product)
- **Core = terrain sim + sync + persistence + plugin host. Nothing else.**
- Server plugins are discovered at boot from `plugins/<name>/server/index.ts`
  and implement `TerracePlugin` (`server/src/plugins/types.ts`): world
  lifecycle, `onTick`, an `onIntent` interceptor chain (allow / deny /
  modify), post-apply and terrain-change hooks, player join/leave, per-token
  chunk unlock, namespaced messages, a persistence slice, and operator-facing
  settings and actions. Load order is interceptor and tick order.
- Client plugins implement `TerraceClientPlugin` (`client/src/plugins/types.ts`):
  `attach(ctx)` with a Three.js layer, terrain queries and message routing,
  plus HUD panels (Solid components) and a draw budget.
- Reveal policy lives in `plugins/reveal`, not core (§2).

### 3.6 Persistence & self-hosting
- SQLite via `better-sqlite3`: periodic world snapshots plus plugin
  persistence slices. pnpm workspaces for the monorepo.
- **One process, one URL.** With a built client at `CLIENT_DIST_PATH`
  (default `client/dist`), the server serves it with SPA fallback on its own
  port, via Colyseus's `express` hook (no direct `express` dependency). The
  client connects to its own page host unless `VITE_SERVER_URL` /
  `PUBLIC_WS_URL` override it. `pnpm --dir client dev` remains the dev path.
- Docker Compose still runs two containers (nginx `client` + `server`).

### 3.7 Players & accounts
- Anonymous players with display names and a durable client-generated token
  (`Player.token`) used for per-player chunk ownership. Accounts, if ever,
  are an auth plugin; `Player` is designed to allow it.

---

## 4. Repository layout (agreed)

```
terrace/
├── shared/            # terrain math + protocol types (imported by client AND server)
│   ├── heightmap.ts   #   grid type, raise/lower, gradient smoothing, water, terracing
│   └── protocol.ts    #   intents, diffs, snapshots, join messages
├── client/            # Vite + Solid + TS + Three.js
├── server/            # Node + Colyseus; one live World per process; tick loop;
│                     one SQLite file per world under WORLDS_DIR
├── plugins/           # auto-discovered at boot; ships with example plugins
│   └── reveal/        #   flagship example: progressive territory unlock
├── Dockerfile
├── docker-compose.yml
└── README.md          # written for self-hosters: docker compose up = your instance
```

---

## 5. Development process (agreed with owner)

- **The session assistant orchestrates and reviews; background Opus subagents
  implement.** No agent output lands unreviewed.
- **Phase 0 (sequential, gated):** monorepo scaffold + the complete `shared/` package.
  Reviewed hardest; locked before any fan-out.
- **Phase 1 (parallel, two background agents):**
  - Agent A — server: Colyseus room/World, tick loop, intent pipeline, mask, SQLite
    snapshots, plugin host, `WORLD_SIZE` config.
  - Agent B — client: Vite+Solid+Three.js, mesh from heightmap, orbit camera, sculpt
    input, Colyseus client, terraced rendering.
- **Phase 2 (integration):** end-to-end wiring, client-side prediction/reconciliation
  reusing `shared/` math, reveal example plugin, Docker Compose, README.
- Between phases: orchestrator reviews diffs, runs typecheck/build, reports to owner.
  Owner stays in the loop at phase boundaries.
- **Do not start building until the owner explicitly says go.**

### Code style (owner's standing conventions, from their CLAUDE.md)
- TypeScript strict everywhere; no `any` without an explanatory comment.
- Functional components only; **named exports** over default exports.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`).
- Verbose comments on critical code — for Terrace, the terrain math, intent
  validation, and sync/persistence paths count as critical. Moderate comments on UI.
- Keep files focused; consider splitting past ~300 lines.

---

## 6. Non-goals for v1 (explicitly out of scope — do not build)

- Accounts/auth (deferred; future plugin — see 3.7)
- Lobbies, matchmaking, or multi-world routing in core (one process = one world)
- Any game mechanics in core: mana, followers, combat, win conditions (plugins only)
- Mobile/touch-first UI **redesign** (desktop browser first). ~~touch can come
  later~~ — SUPERSEDED 2026-08-14: smooth touch *input* (one-finger sculpt,
  two-finger camera) is in scope for v1 by owner request; only a touch-first
  UI layout remains out of scope. See the Phase 2 decisions below.
- npm plugin distribution (folder-based first; design the loader so npm can be added)
- Erosion or advanced fluid sim (static/simple water first — see open question 3)
- Horizontal scaling infrastructure, k8s, etc. (docker compose is the deployment story)
- Spectator/replay systems

## 7. Glossary (use these terms consistently in code and docs)

| Term | Meaning |
|---|---|
| **cell** | One entry in the heightmap grid; integer height (Int16) |
| **chunk** | Square group of cells (size TBD, open question 5); unit of unlock/streaming |
| **mask** | Server-side-only bitset of which chunks are unlocked |
| **band** | One discrete terrace level in quantized rendering |
| **intent** | Client → server request to sculpt ("raise at x,y"); never raw heights |
| **diff** | Server → clients list of changed cells `[{x, y, h}]` after an applied edit |
| **snapshot** | Full serialized world state (heightmap + plugin slices) for join/persistence |
| **World** | The single authoritative world object owned by the room/process |
| **tick** | One fixed-rate sim step (~10 Hz) on the server |

## 8. Engineering conventions

### Testing
- **Vitest everywhere** (owner's standing convention). The `shared/` terrain math is
  the highest-value test target: it is pure and deterministic — unit-test raise/lower,
  gradient smoothing (converges, respects MAX_STEP, is symmetric), terrace
  quantization, and protocol encode/decode round-trips. Phase 0 is not "locked" until
  `shared/` has passing tests.
- Server: test the intent pipeline (validation → apply → diff) and the plugin
  interceptor chain with an in-memory world. Client rendering is verified manually in
  v1; don't build a headless GL test rig.
- **Determinism rule:** terrain math must be integer-only or fixed-order float ops —
  identical inputs must give identical outputs on server and client, or prediction
  reconciliation will drift.

### Configuration
- Server config via environment variables with sane defaults, `.env.example` in repo:
  `WORLD_SIZE` (default 512), `PORT` (default 2567 — Colyseus convention),
  `DB_PATH` (default `./data/world.db`), `TICK_HZ` (default 10),
  `SNAPSHOT_INTERVAL_S` (default: open question 4), `WORLD_DIFFICULTY`
  (default 50 — added 2026-08-14; the one setting that clamps rather than
  refusing, see the decision entry).
- No secrets exist in v1 (no accounts); keep it that way — nothing sensitive should
  ever be required to boot a world.

### Dependencies & versions
- Pin **latest stable at scaffold time** and record exact versions in the Phase 0
  commit: Node LTS, Colyseus (check current major — 0.15 vs 0.16 APIs differ
  significantly; verify against current docs before writing room code), Three.js,
  SolidJS, Vite, Tailwind (v4 if used for HUD), better-sqlite3, pnpm.
- Prefer few dependencies; every dep is a cost for self-hosters and contributors.

### Git & CI
- Feature-branch workflow; conventional commits; the repo's default branch starts
  empty — Phase 0 initializes it (this doc as `docs/DESIGN.md`, plus scaffold).
- Add a minimal GitHub Actions workflow in Phase 0: `pnpm install`, typecheck, and
  Vitest across the workspace on PR/push. Keep CI under a minute; no deploy jobs.

### Performance targets (sanity bounds, not hard SLAs)
- Client: 60 fps orbit/sculpt on a mid-range laptop at 512² (mesh updates must patch
  vertex buffers in place — never rebuild geometry per edit).
- Server: a sculpt intent should validate→apply→broadcast in well under one tick;
  diffs after smoothing should stay in the hundreds of cells, not thousands.
- Join: snapshot of a typical early world (few chunks unlocked) should be tens of KB.

## 9. MVP acceptance criteria ("Phase 2 done" means all of these)

1. Two browsers connected to one server see each other's sculpts within ~100 ms.
2. Sculpting feels immediate locally (prediction) with no visible snap on
   reconciliation in the common case.
3. Terraced rendering with orbit/zoom camera at 60 fps.
4. Water renders at sea level; raising land out of water creates buildable-looking flats.
5. Locked chunks are invisible and unsculptable; the reveal **plugin** (not core)
   unlocks territory and clients see new chunks stream in.
6. Kill the server process; restart; the world comes back from SQLite intact.
7. `docker compose up` from a fresh clone yields a working instance a friend can join.
8. A second example plugin (mana or follower stub) exists to prove the API generalizes
   beyond reveal.
9. README enables a stranger to self-host and to write a hello-world plugin.

---

## 10. Decisions

Dated decision records live in `docs/decisions/`, one file per arc (index in
`docs/decisions/README.md`). They are settled with the owner. This file holds standing
rules and architecture only; do not append decisions here.

### Decisions made 2026-09-01 (sky coverage stays 0.18; lightning is a world budget, #232)

- **`TARGET_SKY_COVERAGE_FRACTION` stays 0.18.** It is the sky the owner signed
  off on. The 14-system ceiling binding on a 2048 world with no headroom, and a
  4096 world getting ~5%, is a ceiling question to be settled by a measurement
  on a developed world, not by lowering the target.
- **Lightning is a world-wide budget, not a per-storm rate.** `rollStrikes`
  shares `STRIKE_BUDGET_PER_SECOND` (0.06/s, the old per-storm value) across
  living storms as `budget × intensity_i / max(1, Σ intensity)`. A lone storm is
  therefore unchanged — a dozen bolts over its life — and stacked storms split
  the budget instead of multiplying it, so `fire`'s ignition cadence no longer
  follows the system cap or the spawner tuning. Rejected: lowering the per-storm
  rate to restore the old world total (a lone storm would throw ~6 bolts and stop
  reading as dangerous); a budget without the `max(1, ·)` floor (a single
  half-strength storm would be handed the whole budget). Residual, named: a lone
  storm throws every bolt, so one storm alone feels fiercer than one of three.
