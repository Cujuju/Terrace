# Terrace — Design & Decision Record

**Status:** Pre-implementation. All decisions below are settled with the project owner
(Cujuju) — do not relitigate them without new information. Open questions are listed
at the end. This document is the handoff context for the implementation session and
should be committed to the repo as `docs/DESIGN.md` early in Phase 0.

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
  3. **Sea level** — height ≤ 0 is water; flat land above water is buildable.
- The signature relaxation loop, roughly:

  ```
  raise(x, y, amount):
      height[x][y] += amount
      repeat N smoothing passes:
          for each cell, for each neighbor:
              if |height diff| > MAX_STEP:
                  move both toward each other by half the excess
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

### 3.2 Server: Node + Colyseus, authoritative, one world per process
- **Colyseus** (owner choice) provides rooms, schema sync, and reconnection handling.
- **Node over Bun** because Colyseus officially targets Node (Bun was considered and
  dropped for support reasons).
- **One world per process** (owner decision, crash isolation): a crash takes down
  exactly one world. Scaling = run more processes. There is no lobby layer in core;
  one deployment = one world. The server is structured around a single `World` object
  so a rooms layer could be added later without rework.
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
  your own world. Dockerfile + compose in repo root.
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
├── server/            # Node + Colyseus; one World per process; tick loop; SQLite
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
- Mobile/touch-first UI (desktop browser first; touch can come later)
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
  `SNAPSHOT_INTERVAL_S` (default: open question 4).
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

## 10. Open questions (not yet decided — raise before building the affected part)

1. **Terrace band height / number of bands** for the quantized look (feel-tuning).
2. **Brush shapes and sizes** for sculpting (point vs radius, falloff curves).
3. **Water model depth**: static sea level first, or settle/flow sim in v1's tick loop.
4. **Snapshot cadence and retention** (every N seconds? keep how many?).
5. **Chunk size** for mask/streaming granularity (16×16? 32×32?).
6. **Client plugin loading mechanics** — build-time (compiled in) vs runtime; v1 can
   compile example plugins in and defer dynamic loading.
7. **Colyseus schema vs manual binary messages** for terrain diffs (schema is easier;
   binary is leaner — measure before optimizing).

### Decisions made 2026-08-13 (Phase 0 kickoff, settled with owner)

- **Q1 — DECIDED:** `BAND_HEIGHT = 64` height units per terrace band, as a named,
  tunable config constant (~16 bands over the 1024-unit sculpt range). Provisional;
  feel-tune in Phase 2 with real rendering.
- **Q2 — DECIDED:** radius brush, radius 1–4 cells, linear falloff from center;
  radius 1 degenerates to the Populous point brush.
- **Q3 — DECIDED:** static sea level (`height ≤ 0` is water); water is a derived
  fact of the heightmap, never simulated state. All water visuals (waves, shimmer)
  are client-side rendering only.
- **Q5 — DECIDED:** chunk size **16×16** cells (512 B of Int16 per chunk; fine
  reveal granularity at both 128² and 512² worlds).
- Q4, Q6, Q7 remain open; none block Phase 0. Q4 affects the Phase 1 server
  (`SNAPSHOT_INTERVAL_S` in `.env.example` carries a provisional 60 s default).

### Decisions made 2026-08-13 (Phase 1 kickoff, settled with owner)

- **Q4 — DECIDED** (owner accepted recommended default): snapshot every
  `SNAPSHOT_INTERVAL_S` (60 s) **only if the world changed** since the last
  snapshot, keep a rolling history of the last 10, plus one snapshot on clean
  shutdown.
- **Q6 — DECIDED:** client plugin halves are **compiled in** at build time.
  The loader consumes a stable module signature so runtime loading can be
  added later without changing plugins. (Runtime loading was costed: the hard
  part is sharing Solid/Three/shared across bundle boundaries — deferred.)
- **Q7 — DECIDED:** terrain diffs and chunks travel as **plain Colyseus
  messages** (msgpack), exactly the shapes in `shared/src/protocol.ts`.
  Colyseus schema state is never used for terrain (262k tracked cells fights
  the change-tracking layer; the math already emits exact diffs; locked-chunk
  omission needs per-client sends anyway). Schema may still carry
  player/presence state.
- **Colyseus pairing — RESOLVED:** the 0.17 browser client exists — the
  package was renamed `colyseus.js` → `@colyseus/sdk` (0.17.43). Phase 1 pins
  **colyseus 0.17.x server + @colyseus/sdk 0.17.x client**. Note 0.17's
  `Client<{ userData, auth, messages }>` generic shape and multi-handler
  `onMessage()`.

### Version facts recorded at scaffold time (2026-08-13)

- Latest stable: colyseus **0.17.10** (server), but `colyseus.js` (browser client)
  latest is **0.16.22** — no 0.17 client is published. **Phase 1 must verify
  client/server compatibility against current Colyseus docs before writing room
  code**, and pick either matched 0.16 both sides or 0.17 server + whatever client
  path 0.17 documents.
- Other pins at scaffold: TypeScript 7.0.2 (new native compiler — verified working
  for typecheck in Phase 0), Vitest 4.x, Node 24 (runs `.ts` directly via type
  stripping — `shared/` uses only erasable syntax: no enums, no namespaces),
  pnpm 10.33.0, Three.js 0.185.x, SolidJS 1.9.x, Vite 8.x, better-sqlite3 13.x.

---

## 11. Session logistics (for the new dedicated Terrace session)

- The prior session was bound to `Cujuju/StockApp`; its `add_repo` approval relay was
  broken (approvals never reached the tool), which is why a dedicated session was
  created. Verified: `Terrace` exists, is reachable, and is empty (no refs).
- No code or commits exist yet anywhere — this document is the entire project state.
- First actions on "go": scaffold Phase 0 on a feature branch, commit this file as
  `docs/DESIGN.md`, push to the repo.
- **Update 2026-08-13:** the repo is no longer empty — `main` has one commit
  (`3dee6d5`, README only). Owner said "go"; Phase 0 is being built on branch
  `feat/phase0-scaffold`.
