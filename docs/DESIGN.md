# Terrace — Design & Decision Record

**Status:** Standing rules and architecture, settled with the project owner (Cujuju) —
do not relitigate without new information. Dated decision records are in
`docs/decisions/` (see section 10). Do not append decisions to this file.

---

## 1. Vision

Terrace is an **open-source, self-hostable, multiplayer terrain-sculpting platform**
inspired by the god-game terrain of *Populous* (1989) and *Godus* (2013). It is
deliberately **not a game** — it is the substrate others build games on:

- The core ships only terrain simulation, real-time sync, persistence, and a plugin host.
- Everything "gamey" (mana, followers, combat, win conditions, accounts) is a plugin.
- The success criterion for the architecture: reveal-of-territory, a mana economy, and
  a follower stub can each be built as plugins **without touching core**. If they can't,
  the plugin API is wrong.
- Self-hosting must be one command (`docker compose up`). The README is written for
  self-hosters first.

Repo: `github.com/Cujuju/Terrace` (created, currently empty). License: **MIT** —
chosen over AGPL to maximize adoption; people may build closed-source games on top.

---

## 2. Domain background (why the terrain design looks like this)

### Populous (1989)
- Terrain was a **128×128 integer heightmap**. The whole series stayed on 128×128
  (Populous II, and Populous: The Beginning wrapped 128×128 onto a globe).
  Community tools export Populous maps as literal 128×128 images, one pixel per tile.
- Three rules produce the entire mechanic:
  1. **Raise/lower** — add/subtract height at a point.
  2. **Gradient limiting** — no slope may exceed a max step; after an edit, an
     iterative relaxation pass pulls neighbors toward each other. This is what makes
     land "flow" outward and is **the single most important element of the feel**.
     — PARTLY SUPERSEDED 2026-08-14: still true of the `smooth` tool, but
     relaxation is no longer what the DEFAULT brush does. See the Phase 2
     decision "Sculpting gains brush TOOLS and edge PROFILES" below.
     — **SUPERSEDED OUTRIGHT 2026-08-20** (owner: "I don't want populace
     anymore. I want godus"). The Populous signature is retired as the feel of
     this game. `DEFAULT_SCULPT_AMOUNT` is one BAND and `MAX_STEP` is one band
     per WORLD UNIT (`BAND_HEIGHT / WORLD_UNIT_CELLS`), so a click lands exactly
     ON the gradient limit and there is no excess to push outward: **one click,
     one crisp terrace, no outward slump.** (Both were literally `BAND_HEIGHT`
     between the 2026-08-20 re-terrace and the 2026-08-21 re-sample, which is
     what this line used to say; the RATIO is what the claim rests on and the
     re-sample kept it — see `DEFAULT_SCULPT_AMOUNT` in shared/src/constants.ts.
     The gradient limit a pair actually comes to REST at is one unit looser
     still, `MAX_STEP + RELAX_SLACK`, since 2026-08-29 — issue #108, below.)
     Relaxation still exists and still does its job — it is what keeps the
     invariant when terrain that ALREADY violates it is disturbed, and what the
     `smooth` tool is for — but it is no longer the signature. See "The world
     re-terraced" below.
  3. **Sea level** — height ≤ 0 is water; flat land above water is buildable.
- The signature relaxation loop, roughly:

  ```
  raise(x, y, amount):
      height[x][y] += amount
      repeat N smoothing passes:
          for each cell, for each neighbor:
              if |height diff| > MAX_STEP + RELAX_SLACK:
                  e = |height diff| - MAX_STEP
                  high -= e >> 1 ; low += e >> 1     # EXACTLY half each way
  ```

  Tuning this (pass count, MAX_STEP, brush falloff) is feel-critical. Bad tuning reads
  as "gummy" or "jittery".

### Godus (2013)
- **No canonical grid size exists** — 22Cans never published one and the
  wiki/modding community documents worlds in "plots" and regions, not N×N. We
  searched; do not invent a number.
- Its terrain is **discrete stacked layers** (contour bands) — you drag whole layers
  out/in, producing the terraced look. Under the hood it is still a heightmap,
  quantized into bands.
- Its world model: start small on a "Homeworld", territory **reveals/unlocks
  progressively** as the player advances. The world felt huge but was streamed in
  chunks gated by progression.
- **The takeaway we adopted is the pattern, not a number**: modest active area, large
  potential area, revealed over time.

---

## 3. Architecture decisions (with rationale and rejected alternatives)

### 3.1 Client: Vite + SolidJS + TypeScript + Three.js
- **Three.js** renders the heightmap as a mesh whose vertices are updated imperatively
  per frame. A real 3D orbit camera is essential for the terraced look.
- **SolidJS** (owner preference; explicitly *not* React) handles HUD/UI. Solid's
  fine-grained reactivity coexists with an imperative render loop without a virtual-DOM
  re-render fighting it every frame. The render loop is plain TS; Solid never owns the
  canvas.
- **Rejected:**
  - *React / React Three Fiber* — owner dislikes React; R3F's declarative layer fights
    per-frame vertex updates.
  - *Canvas 2D isometric* — most retro-faithful but no real camera, fiddly sorting,
    hard to look modern.
  - *Godot / Unity / Bevy (native engines, WASM export)* — all can be web-hosted, but
    a WASM blob is unreadable to contributors; with the web stack the readable source
    IS the running app, which is the best open-source contribution story. Unity is
    additionally closed-source and ships 10–30 MB+ bundles. Revisit only if this
    becomes a content-heavy shipped game.

### 3.2 Server: Node + Colyseus, authoritative, one world LIVE per process
- **Colyseus** (owner choice) provides rooms, schema sync, and reconnection handling.
- **Node over Bun** because Colyseus officially targets Node (Bun was considered and
  dropped for support reasons).
- **One world LIVE per process** (owner decision, crash isolation; amended
  2026-08-22): a crash takes down exactly one world. Scaling = run more processes.
  There is no lobby layer in core. The server is structured around a single live
  `World` so a rooms layer could be added later without rework.
- **A world is a FILE, and a server may hold many** (owner decision, 2026-08-22,
  after an incident). One SQLite database per world under `WORLDS_DIR`; the
  operator creates, loads, renames, duplicates and archives them from an in-game
  panel gated by `WORLD_ADMIN_KEY`. Exactly one is loaded and simulating at a
  time — loading another saves and closes the current one first.
  - *Why it changed.* A world used to be a ROW: every world a deployment had ever
    run shared one `snapshots` table, distinguished only by a `world_name`
    column, while retention kept "the newest N rows" **across the whole table**.
    A world that stopped being written to was therefore evicted by whichever
    world was written to next. This was not hypothetical: a world called
    Frostwick Hollows lost 298 of its 308 snapshots exactly this way. With one
    file per world, retention runs inside a file and cannot reach another's
    history — a structural guarantee rather than a maintained one.
  - *Nothing deletes a world implicitly.* Archiving MOVES a world's file to
    `WORLDS_DIR/.trash`; the only code path that unlinks one is an explicit
    purge of an already-archived world whose name the operator has typed back.
    Boot never treats "I cannot find the world I expected" as "make a new one" —
    it loads nothing and says which world it could not open.
  - *Restore points can be PINNED*, exempting them from retention entirely, so a
    moment worth keeping is not on a conveyor belt towards deletion.
  - *One live world, not many, because plugin state is module-scoped.* Every
    server plugin keeps its state in module variables, so two simultaneous worlds
    would share forests, chronicles and mana pools. Switching works because
    `restorePersistence` + `onWorldCreate` reset that state — the same replay a
    rollback already relies on. Running several worlds at once is issue #78.
- **Authoritative server is non-negotiable**: clients send *intents* ("raise at cell
  x,y"), never raw heightmap values. The server validates (bounds, unlock mask, and —
  via plugins — mana/cooldowns), applies the edit, runs the smoothing pass, and
  broadcasts **cell diffs** `[{x, y, h}, ...]`. This is both the anti-cheat model and
  the sync model.
- **Fixed tick loop (~10 Hz)** runs ongoing sim (water settling, later erosion) so all
  clients see identical physics. Rendering interpolates; simulation never runs
  client-side as truth.
- **Bandwidth reality check** (why this design is comfortably cheap): edits are local,
  so diffs are a few hundred bytes; a full 512² heightmap snapshot is 512 KB of
  Int16 — sent once on join, chunked by unlock mask so early-game joins are far smaller.

### 3.3 `shared/` package — the contract
- A workspace package imported by **both** client and server containing:
  - the heightmap type and all terrain math (raise/lower, gradient-limit smoothing,
    water/sea-level logic, terrace quantization);
  - the protocol/message types (intents, diffs, snapshots, join).
- Single source of truth: no drift between client and server math. This enables
  **client-side prediction** — the client runs the same smoothing locally for instant
  feedback, then reconciles against the server's authoritative diff.
- Phase-0-gated: this package is written and reviewed FIRST; nothing fans out until
  it is locked, because both sides compile against it.

### 3.4 Terrain model
- **512×512 `Int16Array`, allocated up front** (512 KB — trivial). `WORLD_SIZE` is
  server config; self-hosters on small VPSes can run 128² (Populous-proven playable),
  big boxes 512². No live resizing/reallocation ever.
- **Server-side-only unlocked-region mask.** Chosen explicitly for anti-cheat (owner
  raised this): locked chunks are **never sent to clients at all** — anti-cheat by
  omission. A hacked client cannot render or peek at terrain it never received; sculpt
  intents on locked cells are rejected server-side. Reveal = server flips mask bits and
  streams the newly unlocked chunk. Clients hold no full-map data to protect.
- **Terraced (Godus) rendering first** — it is the app's namesake and the distinctive
  look. Heights quantize into discrete bands for rendering. Smooth-Populous rendering
  becomes a later toggle (the underlying heightmap is smooth either way; terracing is
  a render/interaction mode).
- **One height per cell — superseded in principle, not yet in code (2026-08-24).**
  A single height cannot express a cell that is empty below and solid above, so
  overhangs, arches and caves are unrepresentable. The agreed replacement is a
  list of solid spans per column, of which today's world is the one-span special
  case; see "Decisions made 2026-08-24 (overhangs, arches and caves)" at the end
  of this document for the model, the rejected alternatives, the measured blast
  radius and the staging. Nothing below changes until that work starts.

### 3.5 Plugin platform (the core product)
- **Core = terrain sim + sync + persistence + plugin host. Nothing else.**
- Server plugin interface (shape agreed; exact types are Phase 0 work):

  ```ts
  interface TerracePlugin {
    name: string;
    onWorldCreate?(world: WorldApi): void;
    onTick?(world: WorldApi, dt: number): void;
    onIntent?(intent: SculptIntent, ctx: IntentCtx): IntentVerdict; // allow/deny/modify
    onTerrainChanged?(diff: CellDiff[]): void;
    onPlayerJoin?(player: Player): void;
    onPlayerLeave?(player: Player): void;
    messages?: Record<string, MessageHandler>;  // namespaced client<->server messages
    state?: SchemaSlice;                        // plugin-owned synced Colyseus state
    persistence?: PersistenceSlice;             // plugin-owned snapshot data
  }
  ```

- The two hooks that make it a real platform:
  - **`onIntent` as an interceptor chain** — a mana plugin vetoes/modifies intents
    rather than patching the sim (exactly how Populous's spell economy worked);
  - **plugin-owned synced state + namespaced messages** — a followers plugin ships its
    own entities to clients without touching core protocol.
- Client-side plugins register **HUD panels (Solid components)** and **Three.js scene
  layers**.
- **Distribution:** `plugins/` folder, auto-discovered at boot (v1, friendliest for
  self-hosters — mirrors the StockApp plugin host the owner already runs). npm
  packages (`terrace-plugin-*`) later; design the loader so both coexist.
- **The reveal mechanic ships as the flagship example plugin, not core.** Core knows
  about the mask; a plugin decides *when* territory unlocks. Reveal + mana + follower
  stub are the three validation plugins for the API.

### 3.6 Persistence & self-hosting
- **SQLite** via better-sqlite3: periodic world snapshots + plugin persistence slices.
  Zero-config for self-hosters; the owner already runs this stack in StockApp.
- **Docker Compose** as the canonical self-host path: clone → `docker compose up` →
  your own world. Dockerfile + compose in repo root. Still two containers today
  (nginx `client` + `server`) — the item below is the first step of the release
  track toward collapsing that, not the collapse itself.
- **One process = one playable URL (issue #20, 2026-08-18):** when a `vite build`
  of the client exists (`CLIENT_DIST_PATH`, default `client/dist` next to
  `server/`), the game server serves it over its own HTTP port with SPA
  index-fallback — `http://host:PORT` is then the whole game, no separate static
  server. Absent a build, the server logs that it is unbuilt and does nothing
  else; `pnpm --dir client dev` (Vite) remains the dev path, unchanged. Built on
  Colyseus's `ServerOptions.express` hook rather than a new `express`
  dependency — `express` is only ever a peer of `@colyseus/core`/`@colyseus/
  ws-transport`, never a declared dependency of `@terrace/server`, so the hook
  is used the way Colyseus itself constructs and hands over the app, never via
  a direct `import express` from this codebase. The client resolves its own
  WebSocket endpoint the same way: `ws://<page's own host>` when running from a
  built bundle (any origin, any port), the pre-#20 `ws://<page hostname>:2567`
  only in Vite's own dev server. `VITE_SERVER_URL`/`PUBLIC_WS_URL` still
  override this outright, which is what keeps Docker Compose's two-container
  path (client and server on different ports) working unchanged.
- **pnpm workspaces** (owner choice) for the monorepo.

### 3.7 Players & accounts
- **Deferred** (owner decision, to keep scope tight): v1 is anonymous players with
  display names. The `Player` object must be designed so an **auth plugin** can slot
  in later — accounts will likely be a plugin, not core.

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
