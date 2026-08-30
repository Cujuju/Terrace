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

### The world re-terraced, and the Populous slump retired (2026-08-20)

Two owner decisions, taken together because the second falls out of the first.

**`BAND_HEIGHT` 64 → 16.** The world was too blocky: a band was drawn one full
cell tall, so every riser was a cube-sized step and the land read as stacked
blocks rather than as terraces. The client now draws a band at a QUARTER of a
cell and there are four times as many of them in the same height range, so the
world keeps exactly its relief while every step in it is four times finer.
`MAX_STEP` moved with it, from `BAND_HEIGHT/2` to `BAND_HEIGHT` — one cell of
run per band, the finest tread that still reads as a terrace. Hills therefore
spread twice as wide as they used to; a full-height mountain's foot moves from
32 cells out to 64.

**No more outward flow.** Because a click and the gradient limit are now the
same number, one click on flat ground satisfies the invariant at its own edge
and nothing spills. That is the Godus look the owner asked for, and it retires
the Populous signature recorded at the top of this document.

**The contract this bought, and why it is the real deliverable.** A band is a
RENDER quantum. Re-terracing the world must not move anything the world is
made OF. Every constant that meant a physical fact but was written as a band
count had to be restated in HEIGHT UNITS with its band count derived — the
strata stack, deep water, the snow line, genesis's coastal staircase and
trench, the noise field's amplitude, the client's own vertical scale. They
interlock, so getting one wrong was not cosmetic: left as "3 bands", a fresh
world's abyss would have been 48 units deep against a 192-unit deep-water line,
and no fresh world would have had deep water anywhere — or any sea monsters.

The same rule settled two rendering questions. The terrain palette became a
ramp GENERATED from height anchors instead of one hex literal per band (it
indexed off its end otherwise), and the owner chose to interpolate between the
anchors, so each of the four bands now standing where one stood gets its own
shade. And the chunk geometry guard had to change kind, not just size: a deep
dig crosses 94 band levels where it crossed 22, which pushed legitimate
triangulation work up into the adversarial population's range and closed a 2.2×
separation to 1.2%. Discrimination moved to the largest single merged polygon —
the quantity ear-clipping is actually quadratic in, and the one metric here that
does not move when the world is re-terraced.

**Costs, measured and accepted.** A fully explored 512² world goes from 1.69 M
triangles to 4.09 M and terrain vertex buffers from 279 MB to 673 MB. Reaching a
given height takes four times the clicks (digging to the world floor is ~96 held
clicks, about 12 s on the hold-repeat ramp, against ~24 before). The per-chunk
triangle ceiling quadrupled to 14.5 MB at the current 111 bytes per triangle,
which promotes vertex-format compression from an optimisation to load-bearing
work.

### Decisions made 2026-08-13 (Phase 0 kickoff, settled with owner)

- **Q1 — DECIDED:** `BAND_HEIGHT = 64` height units per terrace band, as a named,
  tunable config constant (~16 bands over the 1024-unit sculpt range). Provisional;
  feel-tune in Phase 2 with real rendering.
  — **RETUNED 2026-08-20 to `BAND_HEIGHT = 16`** (owner: "the world is too
  blocky and it's causing a lot of problems"). This is the Phase 2 feel-tune the
  decision reserved. Four times the terrace resolution, 64 bands of relief above
  sea level instead of 16. See "The world re-terraced" below.
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

### Decisions made 2026-08-14 (Phase 2, settled with owner)

- **Touch controls are v1 scope** (owner request, supersedes the §6 non-goal's
  "touch can come later"): one-finger sculpts in the HUD's sticky raise/lower
  mode, two-finger pinch zooms with the drag component configurable (pan
  default, orbit optional). Touch strokes arm after `TOUCH_STROKE_GRACE_MS`
  so a camera gesture's second finger cancels them before they sculpt.
- **Control bindings are user-configurable** (owner request): raise/lower/
  orbit/pan each bind to a mouse button + optional modifier, persisted in
  localStorage, edited in the HUD's Controls panel. One resolver
  (`client/src/state/controlPrefs.ts`) owns "who gets this press"; OrbitControls'
  `mouseButtons`/`touches` are derived from it per press.

- **Sculpting gains brush TOOLS and edge PROFILES; the stamp becomes the
  default brush** (owner request, settled 2026-08-14). Two orthogonal axes on
  every sculpt:

  | Axis | Values | Meaning |
  |---|---|---|
  | tool | `stamp` (player default) / `smooth` | `stamp` changes exactly the brush footprint — no relaxation pass, so repeated radius-1 raises build a true vertical spire and lowering digs a sheer pit. `smooth` is today's behaviour verbatim: brush **plus** the gradient-limit relaxation. |
  | profile | `soft` (default) / `hard` | `soft` is the original linear falloff from the centre. `hard` applies one flat delta across the whole footprint, edge cells included — plateaus and clean holes with sheer edges. |

  All four combinations are legal and meaningful (hard+smooth = stamp a plateau,
  let it slump).

  **AMENDED 2026-08-19 (owner report): the `hard` profile level-fills under
  BOTH tools.** hard+smooth now means "level-fill, then slump" — the flat
  delta it used to run lifted the *higher* neighbouring level's cells inside
  the footprint up a band, so clicking beside level 7 made level 7's contour
  retreat from the brush ("seven sometimes contracts like it's getting pushed
  away"). The `hard` profile never starts the next level anywhere; "fill this
  level FLAT and leave it standing" remains stamp+hard's promise alone, since
  smooth's relaxation still re-slopes the fill the instant the brush lifts.

  **AMENDED 2026-08-19 (owner-settled, later the same day): player sculpts are
  ANCHORED to the clicked cell's level.** "It should be locked at that layer
  that I'm clicking on": a raise computes one target — the floor of the band
  above the clicked cell's pre-stroke band — and no footprint cell may cross
  it (cells already past it are untouched; lowering mirrors with the band
  below). `soft` keeps its centre-out falloff under that ceiling, which is
  what stops the periphery from ever ending above the centre; `hard`'s level
  fill anchors to the clicked band instead of the footprint's surveyed
  minimum — the owner chose this knowing a hole under the brush edge no
  longer holds the fill back (superseding that clause of the 2026-08-14
  level-fill request). Plumbing mirrors `spill`: a resolved option
  (`anchor: 'clicked'` on the wire path, `'free'` for the library/plugins),
  never a wire field. Pricing deliberately ignores the ceiling, same rule as
  the clamping/level-fill exclusions.

  **AMENDED 2026-08-19 (owner-settled, same session): the brush footprint is a
  tight integer disc.** `dx² + dy² < r·(r−1)` (radius 1 = the centre cell) —
  1/5/21/37 cells at radii 1–4 — replacing `floor(sqrt) < r`, whose lattice
  fill made radius 2–3 literal squares. Chosen after reviewing Populous's own
  mechanic (single-point edits on an isometric diamond grid); the disc is the
  rounder, more organic footprint the owner asked for. Displacement volumes
  (and therefore mana prices) re-derive through the one shared footprint
  iterator: soft 64/192/652/1152, hard 64/320/1344/2368.

  **AMENDED 2026-08-19 (issue #26, owner-settled): player-facing smooth spill
  is band-contained.** "Today's behaviour verbatim" above now describes the
  LIBRARY path only. A PLAYER's smooth stroke still relaxes terrain outside the
  brush, but an outside cell may only move within the terrace band it occupied
  when the stroke touched it — the spill can slope ground, it can never create
  or erase a rendered level outside the brush ("area outside of the brush
  should never be raised or lowered ahead of the structure under the brush").
  Standing residual (measured 2026-08-19): where the cap binds, the MAX_STEP
  invariant stands exceeded at the brush ring — PERMANENTLY, as far as banded
  relaxation is concerned: the capped side cannot rise past its band and the
  coupled transfer rule then moves neither side, so further banded smooth
  strokes never lower the excess (verified over hundreds of strokes). The wall
  is removed only by deliberately lowering the high side (brush deltas are
  uncapped inside the footprint) or by a plugin's 'free' sculpt covering it —
  consistent with the stamp tool's precedent that sheer player-built walls are
  legal and permanent. Rejected alternative: slumping only the free side down
  to the cap + MAX_STEP — it erodes the built mound at its ring (~25k
  height-units on a measured slope scenario) and caps every smooth build at
  the ring's band + MAX_STEP. Plumbed as a third
  resolved option, `spill: 'banded' | 'free'` — never carried on the wire
  (fairness policy, not brush shape); wire default `banded`, library default
  `free`. The library default was ORIGINALLY justified as "plugin terraforms
  keep the unbounded relaxation they were tuned against, bit for bit"; that
  argument is retired twice over and is recorded here only so the next reader
  does not resurrect it. The 2026-08-20 re-terrace invalidated the tuning it
  appealed to; `WorldApi.sculpt` has passed EXPLICIT banded options for every
  plugin since (server/src/plugins/world-api.ts, `PLUGIN_SCULPT_OPTIONS`), so
  no plugin reaches the library default at all; and the 2026-08-29 conserving
  split (issue #108) then re-derived the plugin constants that tuning produced.
  The library default stays `free` because it is the bare arithmetic a direct
  `applySculpt` caller asks for, not because anything is tuned against it. See
  SculptSpill in shared/src/heightmap.ts.

  **This SUPERSEDES the §2 framing of gradient limiting as "the single most
  important element of the feel" — for the DEFAULT brush only.** Relaxation is
  no longer what happens on every edit; it is one of two tools, and the owner's
  new player-facing feel is the stamp. The mechanic itself is unchanged and
  fully available: nothing about §2's description of *how* relaxation works, or
  of why it matters when you want land to flow, is retracted.

  **Two different defaults, on purpose.** The wire default (an intent naming
  neither field) is **stamp + soft** — the new player-facing feel, so a client
  too old to send the fields still gets the new brush. The library default
  (`applySculpt` called with no options argument) stays **smooth + soft**,
  because every existing caller — above all the plugin `WorldApi.sculpt` path —
  was tuned against relaxation, and a silent re-tune of every installed plugin
  is not an acceptable side effect of a UI feature. `WorldApi.sculpt` keeps its
  signature and its smooth behaviour.

  **The normalisation is one function.** `sculptOptionsOf(intent)` in
  `shared/src/protocol.ts` is the only place "absent means what" is decided for
  an intent, and both the server's intent pipeline and the client's prediction
  store call it. Two copies of that default that agreed today would be a client
  predicting a spire where the server builds a mound tomorrow. The wire fields
  are additive and optional (same pattern as `seq`); a present value outside the
  known set fails validation with the whole intent rather than being defaulted,
  because silently reshaping an edit desyncs the sender's prediction.

  Anti-cheat is unaffected: tool and profile choose the SHAPE of an edit, never
  its power. The amount stays server-side.

- **A fresh world starts as an ocean with a coast, not a flat shoreline**
  (owner request, settled 2026-08-14, from the report "we need more wildlife,
  I don't see any deep sea creatures"). **Superseded in shape, not in intent,
  by two later passes on the same feature — 2026-08-18's seeded randomization
  and 2026-08-19's starter-square shrink, both folded into this entry rather
  than left as a stale description of code that no longer exists; the
  starter-square shrink's own wildlife consequences are broken out as their
  own entry immediately below.** `World.createFresh`
  (`server/src/world/world.ts`) still generates three concentric terraces by
  Chebyshev (square-ring) distance from the starter region's centre, but as of
  2026-08-18 that fixed profile is now scoped to the starter unlock square
  only:

  | region | depth | constant | height |
  |---|---|---|---|
  | shelf — a centred square of `spanChunks / FRESH_SHELF_SPAN_DIVISOR` (= 4, floored, never below one chunk) chunks | 1 band | `FRESH_SHELF_BANDS_BELOW_SEA` | −64 |
  | slope ring — `FRESH_SLOPE_WIDTH_CELLS` (= `CHUNK_SIZE`, 16) cells wide | 2 bands | `FRESH_SLOPE_BANDS_BELOW_SEA` | −128 |
  | open sea beyond the slope ring, still inside the starter square | 3 bands or deeper | `FRESH_SEABED_BANDS_BELOW_SEA`, a floor | ≤ −192, seed-varied |
  | open sea outside the starter square entirely | unconstrained | seeded value noise | seed-varied, any band |

  The shelf is placed from `initialUnlockFootprint()` — the one definition of
  the starter square, which `applyInitialUnlock` also reads — rather than from
  a second copy of its centring rule, so the 2026-08-19 span change below
  moves the shelf with it automatically.

  **No longer deterministic end to end — by design, and precisely scoped.**
  The original fix was integer-only with no RNG anywhere; the 2026-08-18 pass
  ("Doesn't look very creative; we need something more creative and maybe less
  deterministic… every world should have at least some fairly deep water. It's
  OK to create flat worlds, but the terrain should be randomized" — owner) adds
  exactly ONE random draw per world: a 32-bit seed (`drawGenesisSeed`, backed
  by `Math.random`), drawn once at `World.createFresh` and never re-derived —
  the same "this is the one place it's allowed" boundary `generateWorldName`
  already uses for the world's name. Every height in the map is then a PURE
  function of `(size, seed)` via `mulberry32Rng`, a small public-domain 32-bit
  PRNG — same seed, same world, byte for byte, which is what keeps client-side
  prediction and every test in `server/test/fresh-world.test.ts` reproducible
  by simply passing a seed explicitly. The shelf and slope ring stay BYTE-
  IDENTICAL across every seed at a given size — no noise reaches them at all —
  because the wildlife plugin's day-one census (`plugins/wildlife/test/
  wildlife.test.ts`) counts that exact region and asserts exact cell counts;
  changing plugin behaviour is out of this change's scope. Everything OUTSIDE
  the starter square is a seeded value-noise field (`buildOuterTerrainLattice`
  + bilinear `outerTerrainBandAt`, one lattice point per 4 chunks, integer
  arithmetic throughout) that can put a continent, an island chain, a basin,
  rolling hills, or — on a low `roughness` draw — something close to a flat
  sea wherever the noise lands; `roughness` and a per-world `baseline` are
  drawn together so a "calm" (low-roughness) world is flat at a height the
  SEED chose, not silently collapsed to the same sea-level plate every calm
  seed would otherwise share. The open-sea CELLS still inside the starter
  square (beyond the slope ring) also read this noise field, but are clamped
  to never come out SHALLOWER than `FRESH_SEABED_HEIGHT` — a one-way ratchet,
  deeper-only — so the wildlife census's deep-water classification there can
  never move even though the exact depth now varies by seed. Only the deep
  water GUARANTEE is enforced outside the seed's control: after generation,
  `World.createFresh` re-scans for the deepest cell and, on the documented
  valid size range, the starter-square clamp already proves one exists; on a
  world small enough that the shelf and its fixed-width slope ring cover every
  cell (below the shipped 128² minimum), a `carveFallbackAbyss` fallback
  forces the single farthest cell down to `FRESH_SEABED_HEIGHT` directly, and
  a boot-time throw backstops the (expected-unreachable) case where even that
  fails — the same "fail loudly at boot rather than serve a broken world"
  idiom `applyInitialUnlock` already uses.

  **Root cause this fixes.** `createHeightmap` allocates zeros and `SEA_LEVEL`
  is 0, so every cell of a fresh world sat *exactly* at the waterline: the sea
  had no depth anywhere. Nothing that classifies water by depth could ever fire
  — the wildlife plugin's deep-water habitat begins three bands down, so whales
  and deep-sea creatures had literally nowhere to exist unless a player hand-dug
  a trench. The ocean was a surface, not a volume. Still the diagnosis today —
  the 2026-08-18 pass changed HOW the fix varies, not why it exists.

  **Why these depths.** Three bands is the shallowest depth satisfying
  `FRESH_SEABED_BANDS_BELOW_SEA >= DEEP_WATER_BANDS_BELOW_SEA` — the open sea
  must qualify as deep habitat *by design*, and every band beyond that is one
  more sculpt a player spends raising land out there. One band for the shelf is
  the shallowest water that is still water: shallow habitat for coastal species,
  and only one band below the surface so an island where the game starts you
  costs two sculpts rather than four. Core cannot import a plugin constant, so
  both relations (open sea deep, shelf and ring shallow) are pinned by tests on
  the plugin side (`plugins/wildlife/test/wildlife.test.ts`).

  **Why the shelf is a quarter of the starter square, and why that quarter now
  buys fewer whales.** The habitat census only counts *unlocked* cells, so the
  starter square is the entire day-one habitat budget, and
  `FRESH_SHELF_SPAN_DIVISOR` (4, unchanged since 2026-08-14) is what splits it
  between coastal and open-sea species. The split's absolute numbers moved when
  the starter square itself shrank (2026-08-19, see the entry below): at the
  ORIGINAL 8-chunk / 16 384-cell square the split was 4 096 shallow / 12 288
  deep, comfortably buying 2 whales at 5 000 deep cells each; at the CURRENT
  5-chunk / 6 400-cell square it is 2 304 shallow / 4 096 deep, which no longer
  reaches a whale's 5 000-cell need at all (superseded 2026-08-21: that need is
  now 2 000, and the same 4 096 cells reach it twice over). The divisor itself was never
  retuned for this — 4 is still "coarse enough that a larger shelf would eat
  the open sea this whole change exists to create, and a smaller one would
  leave no coast for fish" — the starter square just got smaller out from under
  it, an accepted consequence named in full in the entry below.

  **Residual, named** (and worse since the 2026-08-20 re-terrace: a coastal
  step is 64 height units against a `MAX_STEP` of 16, so it overshoots the
  invariant by four times rather than two — the step did not grow, the limit
  shrank with the band). A coastal step is 64 height units against a gradient
  limit of `MAX_STEP`, so the shelf/slope/noise boundaries do not satisfy
  the relaxation invariant at genesis. Nothing enforces it at rest — the stamp
  tool violates it deliberately on every spire — but a `smooth` sculpt whose
  relaxation reaches a boundary will slump it once, with a larger-than-usual
  diff bounded by `SMOOTH_PASS_LIMIT`. Accepted: that is the smooth tool doing
  its job on a terrace edge, and a ramped coast would trade the terraced house
  style for it. (Re-decided 2026-08-18, issue #12: the cap's original
  travel-distance derivation, 64 passes, was exhausted by ordinary stamp-then-
  smooth play, silently violating the gradient invariant. It is now
  `SMOOTH_SPREAD_CELLS × SMOOTH_PASSES_PER_SPREAD_CELL` = 256, sized off the
  measured worst player-constructible strokes with 2× headroom and pinned by
  stress tests; `smooth` returns its pass count so truncation is observable.
  A fully clamped smooth stroke also now relaxes its footprint instead of
  no-opping.)

  **Where it lives, and why not in `shared/`.** The server fills the floor —
  and, since 2026-08-18, draws the one random seed and builds the noise field
  — while `createHeightmap` stays zero-filled. `shared/` is the determinism
  contract that client and server both run, and world *genesis*, seed draw
  included, is not part of it: the client never generates terrain, it receives
  chunks, so a non-deterministic server-only step here breaks nothing on that
  contract. This also keeps "what a new world looks like" a server policy a
  future world-gen plugin can replace.

  **Consequences, accepted:**
  - Raising land costs band-steps it did not before, and how many now varies by
    place AND by seed: two sculpts to break the surface on the starter shelf
    (fixed, every world), more out in the open sea where seeded noise can push
    the floor deeper than the old fixed abyss. Intended — the ocean is a volume
    with a bottom, and now a volume with a variable one.
  - A fresh world has **no land inside the starter square** — the wildlife
    plugin's day-one census depends on that (see above) — but land is possible,
    and expected, beyond it: the seeded noise field can and does place islands,
    coastlines and hills there, decided at genesis and not before. Land-habitat
    species (the wildlife plugin's grazers) still have nowhere to be on day one
    regardless; water species, coastal and open-sea alike, have somewhere from
    the first tick.
  - Every generated world still contains water at least as deep as
    `FRESH_SEABED_HEIGHT`, guaranteed by construction (the starter-square clamp
    can only push that region deeper, never shallower) and re-checked, loudly,
    right after generation.
  - Snapshot-restored worlds are untouched: genesis (fixed profile AND seeded
    noise alike) applies to the no-snapshot path only, so existing self-hosted
    worlds do not silently gain a coastline or a reroll on upgrade.
  - The client boots its local heightmap at band 0, so for the single frame
    before the first chunk arrives it draws a flat shoreline where the server
    has a coast and (now) seed-varied terrain beyond it. Cosmetic, pre-connect
    only, and **not fixed here** — it belongs in the client's boot state.

- **The starter unlock square shrinks from 8 chunks to 5** (owner decision
  2026-08-19, `server/src/world/initial-unlock.ts`). `INITIAL_UNLOCK_CHUNK_SPAN`
  moves from 8 to **5** — 80×80 = 6 400 cells, down from 128×128 = 16 384,
  ~39% of the old footprint. Distinct from, and not part of, the per-player
  creep/territory-mask redesign filed under issue #17 below: this is a change
  to the SIZE of the region genesis and the fallback unlock policy agree on,
  not to how or when territory unlocks. Deliberately small — the static
  genesis profile inside the starter square stops mattering as much once most
  of the world is earned by sculpting (per-player creep, issue #17), so a
  smaller guaranteed-safe starting point trades less day-one certainty for
  more of the map being "the seeded, varied kind" sooner.

  **Why 5 and not 4.** Five is the smallest span whose genesis geometry stays
  clean: the shelf (`spanChunks / FRESH_SHELF_SPAN_DIVISOR`, floored) comes out
  to exactly 1 chunk, the remaining 4 chunks split symmetrically around it, and
  the 16-cell slope ring sits strictly inside the square with a uniform
  one-chunk-deep frame beyond it on every side. Span 4 was rejected: it leaves
  an off-centre shelf and a slope ring touching the square's own edge, which
  both `freshGenesisProfile`'s concentricity assumption and the wildlife
  census's exact-cell-count assertions depend on not happening.

  **Wildlife day-one consequences, named rather than discovered later**
  (`plugins/wildlife/server/species.ts`'s own doc comment states the same
  numbers against the code):

  | species | old day-one (8-chunk square, 16 384 cells: 4 096 shallow / 12 288 deep) | new day-one (5-chunk square, 6 400 cells: 2 304 shallow / 4 096 deep) |
  |---|---|---|
  | fish | 10 (two schools of 5) | 5 (one school) |
  | deep-sea | 8 | 2 |
  | whale | 2 | **0** — a whale needs 5 000 deep cells; only 4 096 exist |
  |  |  | *(superseded 2026-08-21: the density dropped to 2 000, so the same 4 096 cells now buy **2**. See the whale-pod entry at the end of this file.)* |
  | grazer | 0 | 0 (unchanged — a fresh world still has no land) |

  **Superseded 2026-08-21** (whale density 5 000 → 2 000, at the owner's
  request). The paragraph below is kept as the record of why the situation
  arose; the fix, when it came, moved the density rather than the starter
  square, exactly as the last sentence here anticipated it would have to.

  Whales no longer fit on day one at all — the 4 096 deep cells inside the
  new, smaller starter square fall short of a whale's 5 000-cell habitat need
  regardless of how the shelf/deep split is tuned (see the "why the shelf is a
  quarter" paragraph above). This supersedes the 2026-08-14 wildlife-density
  tuning goal of "2–3 whales immediately"; whales now arrive once a player's
  own per-player creep (issue #17) grows their personal unlocked area past the
  threshold, which was already the intended long-run shape for every species
  as territory expands — day one just no longer includes them. Fish and
  deep-sea counts both roughly halve for the same reason (smaller day-one
  census, same per-individual densities) without ceasing to exist outright.
  `FRESH_SHELF_SPAN_DIVISOR` itself is unchanged (4) — see the entry above for
  why moving it was rejected as the fix.

- **Wildlife is denser, and its population is a living process rather than an
  inventory** (owner request, settled 2026-08-14, same report). Two parts:

  1. **Density retune.** Per-species `habitatCellsPerIndividual` roughly doubles
     the asked-for population overall. The two DEEP species move much further
     than the other two (whale 20 000 → 5 000, deepsea 6 000 → 1 500) because
     deep water stopped being a rare remote habitat and became three quarters of
     the ground every new server opens on. Fish moved again on the same day
     (1 000 → 400) for the schooling change below. Day one on any fresh world
     (4 096 shallow / 12 288 deep inside the starter square):

     | species | density | day-one target |
     |---|---|---|
     | fish | 400 shallow cells each | **10** (two full schools of 5) |
     | deep-sea | 1 500 deep cells each | **8** |
     | whale | 5 000 deep cells each | **2** |
     | grazer | 2 700 land cells each | **0** — a fresh world has no land |

     A fully revealed nominal 512² world asks for 246 (131 fish / 52 deep-sea /
     48 grazer / 15 whale); `WILDLIFE_POPULATION_CAP` (raised 100 → 150) scales
     that by 150/246 to **148** (79 / 31 / 29 / 9). Bandwidth at that cap, with
     the `size` field added below: 150 × 58 B ≈ 8.7 KB per full-state broadcast,
     43.5 KB/s ≈ 348 kbit/s per client at the 5 Hz cadence.
     Honest note, restated after the fish retune: a *fully* revealed 512² world
     now rides the cap hard, getting 60% of what the densities ask for, and fish
     are the majority species there (53%). Accepted — the cap is a bandwidth
     budget and scales species proportionally, so a capped world loses scale, not
     shape; and "enough fish to see schools" is arithmetically "a lot of fish".
  2. **Stochastic population.** Targets are a CEILING approached at random, never
     a quota filled at boot. Each pending spawn credit carries a constant hazard
     (`SPAWN_MEAN_WAIT_SECONDS = 20`), so the deficit decays exponentially and a
     world is ~95% stocked after a minute rather than in three seconds — and
     creatures also leave of their own accord (`NATURAL_LIFESPAN_SECONDS = 300`),
     so spawn events keep happening forever and the mix a player watches never
     repeats. Both are per-second rates converted with the host's `dt`; the
     equilibrium sits at `T / (1 + W/L)` ≈ 0.94 of target, deliberately never
     pinned to it. Tests assert bounds and statistics, never exact counts.

- **Fish school, and how strongly depends on their size** (owner request,
  settled 2026-08-14: "I see individual fish but I haven't seen any schools of
  fish", then "fish come in three sizes; smaller fish should be more likely to
  school"). Entirely inside `plugins/wildlife`; core is untouched.

  **Root cause.** A spawn group placed five fish together and then steered every
  one of them independently, so a school existed only at the instant it appeared
  and was gone within a minute — and per-individual turnover eroded whatever was
  left. Schools were a spawn-time coincidence, never a thing.

  **Four parts.**
  1. **School identity.** Every creature carries a `schoolId`, allocated once per
     spawn group and never changed. Solitary species and lone-remainder fish get
     a school of one, which makes every school rule degenerate to the old
     per-individual behaviour instead of needing a "does this school" branch.
     It is **never on the wire** — the client draws creatures where it is told
     they are and needs no concept of a school.
  2. **Boids-lite cohesion.** Each tick a creature's steering is `wander +
     attraction toward the rest of its school + mild alignment to its mean
     heading`, both school terms clamped to a turn rate and to the angle
     remaining, so they compose rather than override. Habitat/unlock steering and
     FLEE keep absolute priority: cohesion only proposes a desired heading, and
     the existing veto still rejects it, so a school straddling a new island is
     deflected member by member and a startled school scatters outright (and
     re-forms afterwards — measured: 25 cells apart during the panic, back inside
     2 cells a minute later). No separation term: attraction switches off inside
     the comfort radius, so members never converge to a point.
  3. **Turnover moves the school, not the fish.** The natural-departure roll is
     per school, and takes every member at once. **The mean does not change**:
     per-individual rolls lose `N·dt/L` fish per tick and per-school rolls lose
     `(N/k)·dt/L·k` — the same number, so `NATURAL_LIFESPAN_SECONDS` stays 300 and
     an individual's expected lifetime is unchanged. What changes is the *event*
     rate: departures happen `k` times less often and take `k` fish. A
     "correspondingly longer" mean would have cut fish turnover fivefold.
  4. **Three sizes.** `small | medium | large`, drawn once per spawn group at
     6 : 3 : 1, driving both the model scale (0.6 / 1 / 1.4) and how strongly the
     group schools: `SCHOOLING_PROBABILITY_BY_SIZE` is 0.9 / 0.5 / 0.1, and
     `SCHOOL_LOOSENESS_BY_SIZE` (1 / 1.5 / 2) widens the cohesion radii and
     softens the pull for bigger fish. Everything but fish has exactly one size,
     which is why no species needs a "varies in size" flag. Size **is** on the
     wire — the client cannot scale a model it has not been told about — as a
     one-byte class index, optional so that a payload from a server that predates
     it reads as ordinary medium creatures rather than being dropped.

  **Why fish density had to move with it.** A school is recognisable only when
  there is more than one of them; the old day-one shelf held four fish in total,
  less than one whole group. `FISH_SCHOOLS_ON_FRESH_SHELF = 2` × the group size
  of 5 is 10 fish, and 4 096 shelf cells / 10 gives the 400 in the table above.

  **Persistence.** `schoolId` and `size` are persisted as additive optional
  fields (no version bump). School membership is not recoverable from position,
  so dropping it would make a restart silently undo the whole behaviour; a slice
  written before this change restores as independent wanderers of default size,
  which is the honest reading of data that never had the information.

- **Bird flocks cross the world overhead, on their own spawner** (owner request,
  settled 2026-08-14: "we need random flocks of birds flying overhead").
  Entirely inside `plugins/wildlife`; core is untouched, and so is the census.

  **The split, and the trade-off it buys.** Birds are a *transient* — they
  arrive, cross, and leave — while `census.ts`/`population.ts` regulate a
  *standing* population toward a habitat-derived equilibrium. Every mechanism
  there is the wrong shape for a bird: `targetsFor` divides habitat *cells* by a
  density (birds occupy none), the per-tick `despawnInvalidHabitat` sweep deletes
  anything outside its habitat (a bird is outside every habitat by definition,
  so it would be culled the tick it appeared), and the respawn-credit loop exists
  to *heal* a count that dropped, which is precisely what a departing flock is
  not. So flocks get their own ~150-line spawner, `plugins/wildlife/server/
  flocks.ts`. **Named cost:** birds sit outside `WILDLIFE_POPULATION_CAP`, the
  equilibrium arithmetic, and the snapshot; their wire cost is bounded by a
  second ceiling (`MAX_BIRDS_ALOFT`) that must be kept in step with the first by
  hand. `BROADCAST_ENTITY_CEILING` in `server/index.ts` is the one place the two
  are added up.

  **What is reused, not re-implemented.** The boids-lite cohesion + alignment
  from `movement.ts`, unchanged — a flock *is* a school. `steerWithSchool` now
  takes a structural `SchoolMember` (x, y, heading) and a `looseness` parameter
  instead of a fish and a size-class lookup, which is what makes it species-
  agnostic geometry rather than fish code a bird borrows.

  **Loose cluster, not a V.** A V is a *formation*, not steering: it needs a
  leader, per-bird slot assignment behind-and-outboard, and a re-assignment rule
  when a slot's occupant is lost — a solver, not two more terms in a blend. And
  it would not read: a V is only legible from directly below or above, and this
  game's camera looks *down* from an 80+ cell orbit, at which angle a V projects
  to the same smear the existing steering already produces for free.
  `BIRD_FLOCK_LOOSENESS = 2` widens the shared cohesion radii to a 5-cell comfort
  / 10-cell full-pull skein, because birds hold wingspans of clearance where fish
  hold body lengths.

  **The crossing.** A flock is born on a circle that circumscribes the square
  world (`worldSize × √½`, plus a chunk of margin) so it is never seen popping
  into existence, aims at a random point inside the middle half of the map, and
  is removed once its centroid passes back out through that ring. Straightness is
  a `FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND = 1` pull back onto the course —
  net displacement over distance flown measures 1.00. That rate sits deliberately
  *between* the wander noise (0.5) and the *effective* cohesion pull (1.5 — the
  nominal 3 divided by the looseness), because the three terms share one heading:
  a course-hold at or above cohesion buys straightness by taking it out of a
  straggler's ability to rejoin, and the two would then fly perfectly straight
  parallel courses, which no straightness measurement can see. Measured over 40
  trials of a bird displaced 30 cells across the course, mean gap after 30 s:
  13.3 at rate 0.5, **13.8 at 1**, 18.4 at 2, 18.8 at 4 — 1 is the knee, and the
  ordering is pinned by test. A `FLOCK_LIFETIME_SLACK_FACTOR = 2` guard removes a flock that somehow
  fails to cross, so a wedged flock cannot permanently occupy one of the two
  concurrency slots and silently stop the sky.

  **Altitude is not on the wire.** Every bird flies at one world Y,
  `MAX_TERRAIN_WORLD_Y + BIRD_ALTITUDE_HEADROOM_WORLD_UNITS` = 16 + 8 = **24** —
  half the tallest possible mountain again in clear air above the tallest
  possible mountain, so "overhead" holds at the worst case and not just the
  typical one. The client already knows that constant, so the payload stays the
  same six keys as every other creature; wing flap is likewise derived from
  elapsed time and the entity id, client-side, like every other idle animation
  here. Adding birds *did* mean the client's "is this a walker" test — previously
  `SWIM_PROFILES[species] === null` — became a named three-way `PlacementKind`
  (`flyer | swimmer | walker`), because a two-valued test on a table with nothing
  to say about flight would have made birds walk.

  **Bandwidth, recomputed.** 150 habitat creatures + 18 birds (2 flocks × 9) =
  **168** entities × 58 B ≈ **9.7 KB** per full-state broadcast, **48.7 KB/s ≈
  390 kbit/s** per client at the unchanged 5 Hz cadence, ≈3.9 Mbit/s of server
  upstream at ~10 players. That is +12% over the 348 kbit/s before birds; an
  empty sky still costs exactly the old figure. `BIRD_CRUISE_SPEED_CELLS_PER_
  SECOND = 8` is chosen against that cadence: 1.6 cells between updates, just
  under the 1.8 a fleeing fish already interpolates smoothly, so the fastest
  thing in the world needs no cadence of its own.

  **Persistence: none, deliberately.** A flock's entire state is how far along a
  path it will have finished in a minute or two, so restoring one resumes a
  journey nobody was watching; the spawner puts a fresh flock up within a mean
  interval anyway. A snapshot *restore* also clears the sky, which is not
  tidiness — `replacePopulation` resets the shared entity-id counter, so an
  airborne bird would be holding an id about to be reissued.

  **Anti-cheat.** `flocks.ts` reads no terrain and no unlock mask; the only world
  property it touches is `worldSize`. A bird's position is a function of RNG
  alone, so the un-filtered broadcast leaks nothing about locked land — the same
  guarantee the habitat population gets from "creatures only exist in unlocked
  chunks", reached from the opposite direction. Accepted consequence: a flock is
  visible over ground the player has not revealed, and tells them nothing.

- **A world has a DIFFICULTY rating, and it is a neutral core scalar** (owner
  request, settled 2026-08-14: "maps get a difficulty rating 1–100; warm maps
  regenerate 200 mana/s, difficult maps 20/s").

  **What core owns.** `WORLD_DIFFICULTY` — an integer in `[1, 100]`, default
  **50**, where 1 is warm/forgiving and 100 is punishing. It is stored on the
  `World` and published to plugins as `WorldApi.difficulty` (readonly). Core
  attaches **no mechanics** to it: it reads the number in no simulation path and
  has no opinion about what a hard world does. That is what keeps it inside
  "nothing gamey in core" (§3.5) — core is publishing a *dial*, not a difficulty
  system, in the same way it publishes `worldSize`. It is deployment
  configuration, **not snapshot state**: re-rating a world is an env edit plus a
  restart, and an old snapshot never overrides today's setting.

  **Why a 1–100 scalar rather than named tiers.** Consumers interpolate against
  it, so a continuous scale lets each plugin choose its own two anchors and lerp
  without core knowing what any of them mean. Named tiers would put that
  vocabulary — and therefore the game design — in core.

  **Validation: it CLAMPS where the other settings refuse.** Out-of-range is
  clamped to the nearest end with a warning (`WORLD_DIFFICULTY=250` means "as
  hard as you can make it", and the ceiling delivers exactly that); non-integer
  text is still fatal, like every other integer variable. The rule that splits
  the two is whether the bad value states an intent the clamp can honour — it
  does for a scale, and it does not for `PORT=70000`. Safe only because a scale
  has no correctness cliff: no stored data, protocol, or other setting depends
  on where in the band it lands.

  **First consumer: mana.** Regen's DEFAULT is now interpolated linearly between
  `MANA_REGEN_AT_DIFFICULTY_1 = 200`/s and `MANA_REGEN_AT_DIFFICULTY_100 = 20`/s:

      regen(d) = 200 + (d − 1)/99 × (20 − 200)

  so difficulty 50 gives ≈**110.9**/s — up from the flat 20/s default this
  replaces, which is intended (it is the mid-scale answer to the owner's two
  anchors, not a retune of the old number). Linear because the dial is
  dimensionless and a plugin author reading "difficulty 25" should be able to
  predict the rate; any easing would hide a second tuning decision inside the
  first.

  **Precedence, one-way: an explicit `MANA_REGEN_PER_S` always wins.** A host who
  writes a number means that number — they are configuring the plugin directly,
  and a world-level dial silently overruling them would make the setting a lie.
  Difficulty supplies the *default*, i.e. the answer for a deployment that has
  said nothing about mana. The existing validation band still applies to
  whichever source won (200/s sits well inside `MAX_MANA_REGEN_PER_SECOND` =
  810), and a junk `MANA_REGEN_PER_S` degrades to the difficulty-derived rate
  with a warning rather than refusing to boot.

  **The wire is unchanged**: `regenPerSecond` already travels in the balance
  push, so the client HUD animates at the derived rate with no protocol work.

  **Future consumers read the SAME scalar** and pick their own anchors — monster
  aggression and relic counts are the expected next ones — so a host turns one
  dial and the whole installed plugin set moves together. A consumer should treat
  only the two ends as fixed points and interpolate; switching on particular
  values leaves ninety-eight settings undefined.

- **A world has a NAME, and the HUD states who the world is** (owner request,
  settled 2026-08-14). Two facts about world IDENTITY, shown together in a
  header above the mana gauge: the world's generated name, and its 1–100
  difficulty rating.

  **The name is minted once and persisted.** `server/src/world/world-name.ts`
  composes evocative names from curated word lists in four shapes (`Emberfall`,
  `Ashmoor Basin`, `The Sundered Reach`, `Isles of Gloamwatch`). It runs exactly
  once — at genesis, or on the first boot of a world created before names
  existed — and the result is stored in the snapshot beside the heightmap, so a
  restart returns the same world by the same name.

  **Where the randomness is allowed to live.** The generator draws from
  `Math.random` at generation time only; it is never re-derived, so a different
  draw is impossible rather than merely unlikely. It is server-side, in
  `server/`, and no part of it touches `shared/` — terrain math and world
  genesis both stay RNG-free.

  **Persistence, and why the schema version does NOT move.** `snapshots` gains a
  nullable `world_name TEXT` column, added to existing databases by an
  idempotent `ALTER TABLE` at open. The column is compatible in both directions
  — this build reads a row without one as unnamed, an older build ignores it —
  so `SNAPSHOT_SCHEMA_VERSION` stays 1; bumping it would turn an additive column
  into a refusal to boot. A world restored unnamed is marked DIRTY, because the
  snapshot scheduler writes only a changed world and an unwritten name would be
  re-drawn on every boot; a snapshot is additionally written at the end of boot
  so a crash in the first minute cannot re-name a world.

  **Name vs difficulty are persisted OPPOSITELY, on purpose.** The name is
  snapshot state (it is what the world IS, and must come back); the difficulty
  stays deployment configuration read from the environment (a host re-rates a
  world by editing it). The two sit side by side on `World` with that difference
  documented at each.

  **The wire is additive.** `JoinSnapshotMessage` gains optional `worldName` and
  `difficulty`, following the `seq` pattern: a snapshot from an older server is
  still valid, and absent means unknown rather than a default. This does not
  breach "nothing gamey in core" — core already publishes the difficulty dial to
  plugins and attaches no mechanic to it, and a name is identity, not gameplay.

  **The header is CORE client UI**, not a plugin panel: it is the first child of
  the `.hud-top-center` column in `client/src/ui/Hud.tsx`, so it stacks above any
  `top-center` plugin panel whatever plugins are installed. Core is not a plugin
  and does not compete for a placement slot. Identity arrives on the join
  snapshot, is normalised once in `state/hudState.ts` (blank name and unusable
  rating both become "unknown"), and is deliberately not persisted — it is
  re-sent on every join, and a rejoin may land on a different world.

- **The hard edge brush LEVEL-FILLS: one terrace at a time** (owner request,
  settled 2026-08-14: "I would also like the hard edge brush to only work at one
  level at a time until it fills out everything at that level. So if I'm at
  level 2 and I'm trying to fill out all the ground at a level 2, I don't want it
  to start building level 3 until everything within that brush edge is level 2").

  **What it does.** `stamp` + `hard` no longer adds one flat delta to every
  footprint cell. It surveys the footprint, finds the **lowest** terrace band
  present, and fills **that** level: cells already at or above the floor of the
  next band up are untouched; cells below it rise by the sculpt amount but stop
  AT that floor, never through it. Lowering is the same operation mirrored — the
  **highest** band present, the floor of the band below it, and only cells above
  it descend. Repeated strokes therefore flatten the lowest ground under the
  brush to one level, and only when the whole footprint has reached it does the
  next level start. The brush can no longer build a step inside its own
  footprint. Implemented as `applyLevelFillBrush` in `shared/src/heightmap.ts`,
  dispatched from `applySculpt`.

  **On flat ground nothing changed.** A footprint flat at band B goes uniformly
  to band B+1 — byte-identical to the flat delta it replaces, because
  `DEFAULT_SCULPT_AMOUNT` is exactly `BAND_HEIGHT`. Every world starts flat
  (genesis lays band-aligned terraces), so this change is invisible until a
  player has made the ground uneven, which is exactly when they asked for it.

  **One band per stroke, whatever the amount.** A plugin-raised amount of two
  bands still advances the footprint one level: the request is about levels, not
  about how hard a stroke hits. The amount still governs cells that are *below*
  the level being filled, which is where a partly-filled level lives.

  **Only `stamp` + `hard`.** `soft` is untouched, and `hard` + `smooth` keeps the
  flat delta and its documented meaning ("stamp a plateau, let it slump"):
  relaxation re-slopes the footprint the instant the brush lifts, so "fill this
  level flat" is a promise that tool cannot keep. The owner's phrase names the
  hard *edge brush* — the stamp, the player-facing default, and the only
  combination that leaves the footprint it edited standing.
  *SUPERSEDED 2026-08-19 (owner report — see the amendment under the Phase 2
  tool/profile decision): `hard` now level-fills under both tools. The
  paragraph above keeps the surviving half of its own argument: relaxation
  still re-slopes a just-filled level, so the flat-and-standing promise is
  still stamp+hard's alone.*

  **Raise and lower mirror exactly on band-aligned terrain**, which is all the
  stamp tool produces. Off the band grid — only `smooth`'s relaxation makes such
  heights — they differ by the half-open band convention `[B·H, (B+1)·H)` that
  `bandOf` (floor division) defines and terraced rendering draws: a cell at
  height 70 renders on band 1, so lowering must leave it rendering on band 0
  (→ 6), and raising must leave it rendering on band 2 (→ 128). A perfect
  negation mirror would instead drop it to 64 — still band 1, a stroke with no
  visible effect. The asymmetry is the correct one.

  **PRICING DOES NOT MOVE.** `sculptDisplacementUnits` stays the nominal
  flat-delta volume, so a level-fill stroke displaces less and costs the same.
  This is a fourth documented exclusion beside clamping, map edges and relaxation
  — and the first three are preferences where this one is a constraint: the mana
  plugin gates a stroke on the CLIENT before it is sent and the server charges
  the same number (`plugins/mana/pricing.ts`), so the price must be a pure
  function of `(radius, profile)`. A terrain-dependent price would be derived
  from heights the client holds only as base-plus-predictions, and not at all in
  a locked chunk; the local gate and the server would then disagree, which is
  precisely the phantom-stroke-and-clawback the shared price exists to remove.
  The softer argument is the `clamping` one: a stroke that moves less because the
  ground was already level is the same request landing on flatter ground, not a
  cheaper request.

  **Determinism is unaffected.** Integer-only throughout, two passes over the one
  fixed-order footprint iterator (min/max over a set is order-independent), and
  both sides reach it through the same `applySculpt`, so client prediction and
  the server cannot pick different branches. The footprint itself is now defined
  in exactly one function (`forEachFootprintOffset`) that `applyBrush`,
  `applyLevelFillBrush` and `sculptDisplacementUnits` all iterate — previously
  three verbatim copies of one loop, where a cell surveyed but not edited, or
  priced but not brushed, would each have been a real defect.

  **Consequence, named.** At radius 1 the two profiles are identical only on
  band-aligned ground: off it, `hard` snaps the cell to the band boundary while
  `soft` adds the full amount. That is the terraced answer and it is tested, but
  it does narrow the older "radius 1 makes the two profiles identical" claim.

- **A SNOW YETI lives on the high peaks, and monster slots become one per
  HABITAT** (owner request, settled 2026-08-14: "I would like to see a snow Yeti
  that spawns in the high Alps"). Entirely inside `plugins/monsters`; core is
  untouched.

  **Habitat stops meaning "deep water".** `plugins/monsters/server/habitat.ts`
  used to know exactly one thing about the world — how deep the sea was — and
  the connected-region flood fill, the minimum-area rule, the survey interval
  and the "arrive at the region's extreme cell" rule are all habitat-AGNOSTIC.
  So a kind now names a **HabitatRegime**: a direction (`inward`, ±1) and the
  band from sea level where the habitat begins. Every question the plugin asks
  about a height — is it habitat, is this cell further in than that one, is this
  region deep/high enough for this kind — is a comparison of two
  `habitatReachHeightUnits(regime, h)` values, so the land regime cannot
  disagree with itself about which way is up. A basin's extreme cell is its
  deepest; a massif's is its summit; the same twenty lines find both.

  | regime | inward | begins at | who lives there |
  |---|---|---|---|
  | water | down | `DEEP_WATER_BANDS_BELOW_SEA` = 3 | kraken, Cthulhu |
  | land | up | `SNOW_LINE_BANDS_ABOVE_SEA` = 9 | yeti |

  **The snow line is 9 bands, restated rather than imported.** The client's
  palette draws band 9+ as snow (`client/src/terrain/bandColors.ts`) — that is
  where a mountain turns white on screen, and the server may not import the
  client. It is also a good threshold on its own: `MAX_STEP` is `BAND_HEIGHT`
  since 2026-08-20 (it was `BAND_HEIGHT/2`, which doubled every cell-distance
  quoted below when the world's maximum slope halved),
  so a snow cell is at least **18 cells** from the nearest shoreline (three
  times what the deep-water line buys) and 9 of the 16 bands `MAX_HEIGHT`
  allows.

  **ONE LIVING MONSTER PER HABITAT, not per world** — the decision this feature
  turns on, and a deliberate revision of the earlier world-wide singleton. That
  rule was written when every kind lived in the sea, where two horrors in one
  ocean is a bestiary. A mountain yeti contends for none of that: the habitats
  are disjoint halves of the heightmap, and a world where digging a trench
  silently cost you the yeti on the peak you spent an hour building reads as a
  bug rather than as scarcity. Scarcity is kept exactly where it means
  something — one thing in the sea, one thing on the snow. The invariant stays
  STRUCTURAL (one nullable slot per regime, so two-in-one-habitat is
  unrepresentable) rather than counted; `MAX_LIVING_MONSTERS` is now derived as
  per-habitat × regimes. Everything downstream was verified against it: the
  summon pass, the collapse test and the cooldown are per habitat (banishing the
  yeti must not keep the kraken out of the water); the broadcast list is
  iterated in a fixed regime order; the client's reconcile and interpolation were
  already keyed by id and needed no change, which is what they were written for;
  the sculpt veto asks every living monster rather than "the" monster.

  **The persistence slice goes to version 2**, with version 1 read and migrated:
  its single monster keeps its slot and its one world-wide cooldown becomes the
  WATER cooldown — exact rather than guessed, because version 1 predates the land
  habitat and every kind it could name lives in the sea.

  **The yeti's profile**, and each number stated against the two sea kinds
  (AMENDED 2026-08-22 — he is a quarter of this size now, and the lair and the
  amble speed went with him; see that section):
  lair = a connected snowfield of **512 cells** (two chunks, ~23 across — the
  same 4.5 body-widths Cthulhu's threshold is justified by, for a 5-cell animal
  instead of a 7-cell one), **banishable by levelling** his peaks below the snow
  line (the collapse machinery pointed at the land predicate, with the same
  quarter-of-arrival hysteresis and a ten-minute absence), **does not block
  sculpting** (a banishable kind that vetoed raises would be half-vetoing its own
  counter), ambles at **0.45 cells/s** — between Cthulhu's brood and the kraken's
  hunt, and under a third of a wildlife grazer, because a monster that moves like
  livestock reads as livestock. He halts often and briefly where Cthulhu broods
  rarely and at length: a similar share of the time stationary, decomposed the
  opposite way, because beat length is what a player reads.

  **A fresh world cannot host him, and that is intended.** Genesis makes an
  ocean with no land at all, so every snow cell in the world is one a player
  raised nine bands out of the sea — roughly a couple of hundred level-fill
  strokes for the minimum lair. The sea monsters are what a new world has; the
  yeti is something a player builds the country for.

  **Client.** A per-kind model file like the other two (`client/yeti-anatomy.ts`
  + `client/yeti.ts`, ~6 100 triangles against the kraken's 7 700 — 15 600 as of
  the 2026-08-22 fidelity pass): a hunched
  white biped, mass in the shoulders, arms below the hips, a ruff of brighter fur
  at the neck because a white animal on white snow needs a broken silhouette
  edge rather than a colour change. He is the first WALKER — placement became a
  named kind (`swimmer | walker`) rather than the nullness of the lurk-depth
  table, the wildlife plugin's lesson — and stands on the highest band his FEET
  overlap. His gait rate is DERIVED from the server's amble speed over his
  stride length so his feet cannot skate, and its amplitude is chosen to read as
  a weight shift when he is standing still, because the wire deliberately
  carries no gait flag. **He wears no dread**: the mist and lightning are the
  SEA's weather, authored above the waterline, and on a peak nine bands up they
  would be a bug rather than atmosphere.

### Decisions made 2026-08-19 (settled with owner, issue #17)

- **Per-player territory: the reveal/frontier-pressure policy is REPLACED by
  instant per-player creep, and unlocks stop being world-wide** (owner
  decisions on issue #17: "Per-player territory: instant creep on spillover,
  browser-token identity"). Four parts.

  **1. Identity.** The client generates an opaque token
  (`crypto.randomUUID()`), persists it in `localStorage`, and resends it as a
  join option on every connection — first join, reconnect, or a later browser
  session. Pre-auth-plugin and §3.7-compatible: player identity was already an
  opaque string (the Colyseus sessionId), and this only adds a SECOND, DURABLE
  opaque string alongside it. The server sanitizes it exactly like
  `sanitizePlayerName` (length cap, closed charset, and ANY unusable value
  degrades to a session-scoped fallback identity rather than blocking the
  join — `server/src/player.ts`'s `sanitizePlayerToken`). `Player.id` stays
  the Colyseus sessionId (a connection); `Player.token` is the new durable
  identity attached to it.

  **2. Per-player masks in core.** The world-level unlocked-chunk mask
  (`World.mask`) is REDEFINED as the SIMULATION mask — the union of every
  player's own progress. Every existing reader (wildlife census, flora,
  monsters, the sculpt-permission check, and the ongoing `terrainDiff`
  broadcast filter) keeps reading it, with UNCHANGED semantics — see the
  "known residual" note below for why the latter two were deliberately left
  alone. A new per-token layer is added beside it: a chunk unlock happens FOR
  A TOKEN (`World.unlockChunkForToken`, published to plugins as
  `WorldApi.unlockChunkForToken`), and the union mask ORs in a chunk the
  instant its FIRST token earns it. The join snapshot sends only the joining
  token's OWN chunks (`World.chunkPayloadsForToken`), and a `chunkUnlock`
  message goes only to that token's live session(s) via `sendTo` — never a
  broadcast, so "one adventurous player must not expose the world to
  everyone" holds structurally, not by convention. The client needed NO new
  mask logic for this: it already infers unlocked-ness purely from which
  chunks it was sent, so per-player streaming is invisible to it — only the
  token plumbing (join options, `localStorage`) is client work.

  **Minimal API addition, and why this shape.** `WorldApi` gains exactly one
  write primitive, `unlockChunkForToken(token, cx, cy): boolean`, mirroring
  `unlockChunk`'s existing idempotent-boolean contract so the reveal plugin
  can call it unconditionally per touched cell with no separate read check.
  `onTerrainChanged` gains one additive optional parameter, `sculptorToken?:
  string` — WHO made this edit, when it was a player (an intent carries
  `player.token` through `sculpt-service.ts`); a plugin-initiated edit via
  the existing `WorldApi.sculpt` carries none, so a policy plugin has an
  explicit "nobody to credit" signal instead of an invented default. Two
  read primitives were added at the same time for a NAMED FOLLOW-UP
  (fog-of-war, filtering the global entity broadcasts below) rather than
  discovered later as a second contract change: `WorldApi.isChunkVisibleTo` /
  `isCellVisibleTo(playerId, …)`, answering from one connected player's own
  token mask. Nothing calls them yet.

  **3. Creep policy (reveal plugin).** The old "frontier pressure" counter —
  a locked chunk unlocked once it had absorbed `CHUNK_SIZE²` cumulative
  cell-changes from ANYONE, against the single world-wide mask that existed
  before this decision — is DELETED entirely, counter and persistence slice
  both. Replaced with: on terrain change, any changed cell landing in a chunk
  not yet in the SCULPTOR's own mask unlocks that chunk FOR THAT SCULPTOR,
  immediately — no threshold. The counter's reason to exist (resisting a
  single griefer forcing an unlock everyone else would then see for free)
  stopped applying the moment unlocking became per-player: that griefer now
  only ever unlocks the chunk for themselves. The plugin stays the policy
  owner (core still does not decide WHEN territory unlocks); it is now
  STATELESS, because the state it used to keep (pressure per chunk) is gone
  and the state it now acts through (per-token masks) lives in core.

  **4. Persistence: core's own table, not a reveal slice — decided, not
  defaulted.** Per-token masks are the SAME binary bitset shape as the
  existing union `mask`, and `unlockChunkForToken` is a `WorldApi` capability
  any plugin can reach, not reveal-plugin-private state — so they are stored
  beside `mask`, in a new `token_masks` SQLite table (one row per
  snapshot × token), the same way `world_name` was added: an additive
  `CREATE TABLE IF NOT EXISTS`, `SNAPSHOT_SCHEMA_VERSION` left UNCHANGED
  (an older build's `SELECT *` never sees the new table; this build reads a
  snapshot with no matching rows — exactly what every pre-#17 snapshot has —
  as "no per-token masks recorded"). **Legacy restore, stated loudly because
  it is a real, accepted regression:** an old snapshot's world-level mask
  becomes the new union/simulation mask (unchanged, since it was always the
  only mask); every per-token mask starts EMPTY. Concretely, a returning
  player on an upgraded server re-creeps their own view of territory the
  world already contains — even land they had personally opened before the
  upgrade — while the simulation (wildlife, flora, monsters) is unaffected,
  since it only ever read the union.

  **Known accepted residual, not fixed here — CLOSED by issue #18 (see the
  decisions block immediately below).** Global entity broadcasts (wildlife,
  flora, monsters, structures) still reference positions over
  chunks a given player has not personally unlocked — they were never
  filtered per-player before this change, and per-player masks existing in
  core does not by itself filter them. Tracked as a fog-of-war follow-up; the
  `isChunkVisibleTo`/`isCellVisibleTo` primitives above exist so that
  follow-up is a new caller, not another contract change. The same
  reasoning is why the intent pipeline's sculpt-permission check and the
  `terrainDiff` broadcast filter were deliberately left reading the UNION
  mask, unchanged: once a chunk is unlocked for anyone, the server itself no
  longer treats its terrain as secret, so a second player sculpting or
  seeing further edits there is shared-world behaviour, not the leak
  per-player masks exist to close — closing it is the SAME fog-of-war
  follow-up, not a gap in this one.

### Decisions made 2026-08-18 (issue #19) — the intent pipeline splits verdict from effect

- **A denied intent now costs a player nothing, structurally.** The residual
  named when the yeti/habitat-regime work landed (§3.5's interceptor chain,
  and monsters' `protection.ts`, both said so out loud): mana charged for a
  sculpt inside its own `onIntent`, before later interceptors in the chain
  got a chance to veto it, so a raise Cthulhu blocked still cost mana. Root
  cause, stated once, without naming either plugin: **`onIntent` conflated
  "would you allow this" with "it happened"**, so any plugin that answered
  the second question from inside the first was exposed the moment a LATER
  plugin answered the first question "no". Two plugins already exercise
  `onIntent` for real work (mana denies, monsters denies, relics modifies);
  mana was the one plugin doing so with a committed side effect, which is
  exactly the shape the bug needed.

  **Contract fix: TWO-PHASE intent processing, and it fits the existing
  `TerracePlugin` shape without breaking it.** `onIntent` keeps its exact
  signature and exact chain semantics (allow / deny / modify, first deny
  wins, a throw treated as allow) and becomes VERDICT-ONLY by contract — see
  its doc comment in `server/src/plugins/types.ts`, which states the rule a
  plugin author reads before writing one. A new, additive hook,
  `onIntentApplied(intent, ctx, diff)`, is the EFFECT phase: core
  (`PluginHost.notifyIntentApplied`, called from `intent/pipeline.ts` step 6)
  fires it exactly once per player intent, and ONLY on the path where every
  interceptor allowed AND the edit actually landed — never on a deny, never
  on a failed re-validation of a plugin's rewrite. This was flagged as the
  preferred shape by both plugins that hit the bug before this fix existed:
  mana's own `onIntent` doc comment named "the fix belongs in core (an
  `onIntentApplied(intent, ctx, diff)` hook)" as the identified fix, and
  `protection.ts` pointed at "a post-chain hook so a charge can be committed
  or refunded." This is that hook, under the exact name mana's comment
  proposed.

  **Why split the hook instead of a post-chain refund.** A refund hook was
  the task's documented fallback if two-phase could not fit the existing
  contract — it does not apply here: nothing about `TerracePlugin`,
  `IntentVerdict`, or the chain's first-deny-wins semantics needed to change
  to add a second, additive, optional hook. A refund model would have made
  every side-effecting plugin implement undo logic (mana would need to
  remember what it charged, in case it needs to hand it back) for a mutation
  that need not have happened at all; asking a plugin to answer "what did I
  commit that I might need to undo" is strictly harder than "here is what
  actually happened, act on it once." The chosen shape also composes: a
  THIRD plugin's future side effect (a cooldown, a resource other than mana)
  gets the same one-hook answer, with no new pattern to invent.

  **What `onIntentApplied` hands a plugin, and why.** `intent` is the
  EFFECTIVE intent — after any earlier plugin's `modify` — not the one this
  plugin's own `onIntent` saw, because the hook describes what HAPPENED, and
  what happened is the effective intent's edit (it matches `diff` exactly).
  `ctx` is the same `{ player, world }` shape `onIntent` already receives, so
  a plugin migrating a charge from one hook to the other changes nothing
  about how it reads the player or reaches `WorldApi`. `diff` is the full,
  unfiltered server-side diff, the same one `onTerrainChanged` receives —
  `onIntentApplied` is intent-scoped (fires only for a player's own sculpt,
  never for a plugin-initiated `WorldApi.sculpt`) where `onTerrainChanged`
  is diff-scoped (fires for every edit, whoever made it); a plugin that needs
  "an edit happened" already has `onTerrainChanged`, and this hook exists for
  "MY intent's own effects, now that it is certain to have applied."

  **Enforcement is by contract and by call-site placement, not by
  sandboxing `WorldApi`.** `onIntent` still receives the same full `WorldApi`
  it always has; core does not intercept or block `sculpt`/`unlockChunk`/
  `broadcast`/`sendTo` during the verdict phase. The considered, rejected
  alternative was a read-only `WorldApi` view for the verdict phase, which
  would make "cannot mutate" a runtime guarantee rather than a documented
  one. Rejected for this pass: every shipped plugin's `onIntent` is already
  read-only in practice (see the audit below), so the guard would protect
  against a violation nothing in this repo currently commits, at the cost of
  a second `WorldApi` shape to build, test, and keep in sync with the real
  one, and — because `sendTo` is deliberately still allowed for a plugin's
  own final deny (see below) — the guard could not even be a blanket
  denylist without becoming a special case anyway. What IS structural: the
  ORDER core calls things in. `intent/pipeline.ts` reaches
  `notifyIntentApplied` from exactly one place, on the one code path that
  runs after every earlier `return` (malformed, locked, plugin-denied,
  plugin-modified-invalid) was skipped — so "effects run only after
  unanimous allow" is a call-graph fact, not a policy plugin authors are
  merely asked to respect, and it is what `server/test/intent-pipeline.test.ts`
  and `server/test/plugin-host.test.ts` pin down. A sandboxed `WorldApi` for
  the verdict phase remains available as a stronger, later hardening step if
  a third-party plugin's `onIntent` is ever found mutating state; nothing
  about this design forecloses it.

  **The one allowed exception, and why it does not weaken the contract.** A
  plugin denying ITS OWN way (`world.sendTo` from inside its own `onIntent`,
  to explain that denial — mana's `mana:denied` push is the shipped example)
  is safe under two-phase for a reason specific to first-deny-wins: that
  denial can never be overturned by a later interceptor, so there is nothing
  for the message to become stale against. This is different in kind from a
  committed STATE mutation (mana's old in-place balance deduction), which
  needed undoing exactly because a later plugin's decision could invalidate
  it. The rule stated in `onIntent`'s doc comment is precise about this: no
  mutation that would need to be undone on a later veto, not no network
  traffic at all.

  **Per-plugin side-effect audit (every shipped `onIntent` implementation).**
  Three plugins implement it; `reveal` and `weather` do not.
  - **mana** — the one with a real side effect (a balance deduction). Split:
    `checkAffordability` (verdict; reads the pool, may send `mana:denied` on
    its own deny, never mutates) and `commitCharge` (effect; the deduction
    and the `mana:balance` push, now living in `onIntentApplied`).
  - **monsters** — `guardGround`/`reachesProtectedGround` only ever READS
    monster state to answer allow/deny; no `onIntentApplied` needed or added.
  - **relics** — Titan's Hand's `onIntent` only ever READS which skills a
    session holds to answer allow/modify; no `onIntentApplied` needed or
    added. See the NAMED CONSEQUENCE below.

  **Named consequence: Titan's Hand's brush widening is no longer free
  extra area.** Before this fix, mana charged during the verdict phase
  against the intent AS MANA SAW IT — before relics (which sorts after mana
  alphabetically) ever widened the brush — so the extra radius Titan's Hand
  grants cost nothing extra. `onIntentApplied` charges against the EFFECTIVE
  intent, which already includes that widening, so the skill is now priced
  like any other radius increase. This was foreseen, not incidental: relics'
  own `onIntent` doc comment already named "the post-apply hook core does not
  yet have" as the one thing that would change this, calling it "the same
  gap mana documents" — this is that hook, and closing it is accepted as the
  correct read of "proportional to the terrain volume its brush nominally
  displaces" (§3.5's mana pricing decision), not a scope-creep side effect.
  No test in this repo pinned the old "free extra area" number, so nothing
  broke; `plugins/relics/server/index.ts`'s doc comment states the new
  behaviour where the old one used to.
### Decisions made 2026-08-19 (settled with owner, issue #18)

- **Strict fog of war: one fan-out primitive, not per-plugin filtering.**
  `WorldApi` gains `broadcastVisible(type, items, positionOf, buildPayload,
  options?)` — the ONE place a plugin loops `players()` and filters by
  visibility. For every connected player (or, with `options.onlyPlayerId`,
  exactly one of them) it filters `items` down to the ones visible over that
  player's own token mask (`isCellVisibleTo`, via `positionOf`) and hands the
  filtered subset to `buildPayload` to build that recipient's own wire
  payload. `options.skipEmpty` (default `false`) picks the disappearance
  contract: `false` — used for a FULL-STATE replace message (wildlife's
  `entities`, monsters' `state`) — always sends, even an empty payload,
  because the only way a client learns something it could see has left its
  view is that the next full list omits it; `true` — used for an ADDITIVE
  delta or a snapshot of content that never moves once placed (flora's
  grown/felled, structures' founded/upgraded/demolished, either plugin's join
  snapshot and keepalive) — sends nothing at all to a recipient whose subset
  is empty, which is safe *because* per-token masks only ever grow (issue
  #17): a position invisible to a player now was equally invisible whenever
  that item last changed, so there is nothing an empty send could ever have
  corrected. The join-snapshot side of each such plugin uses the SAME flag
  for the SAME reason, so the two paths cannot disagree about what silence
  means.

- **Migrated:** wildlife's `entities` broadcast, monsters' `state` broadcast,
  flora's `forest`/`changes` broadcasts and join snapshot, structures'
  `all`/`changes` broadcasts and join snapshot. **Not migrated:** relics —
  its own global, unfiltered five-item broadcast was never named in issue
  #17's residual note or in #18 itself; flagged here as a follow-up, not
  silently left as an oversight.

- **Weather is EXEMPT, verified rather than assumed.** Its broadcast stays a
  single unfiltered `world.broadcast` to everyone. A weather system's
  position is a function of RNG and the shared wind alone; the one place the
  sim reads terrain at all (snow siting) already refuses to look at a locked
  cell (`SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA`'s guard, `isCellUnlocked`), so the
  payload carries no information about locked terrain shape to filter in the
  first place — weather's own file header already documented this
  reasoning before #18 and it was independently re-verified, not assumed,
  while implementing this issue. Wildlife's birds get the identical
  exemption for the identical reason: `flocks.ts` reads neither heights nor
  the mask, a flock's course is terrain-independent ambience exactly like a
  weather system's, and a bird legitimately spawns and despawns OFF the map
  — running one through `isCellVisibleTo` would throw (shared's `chunkIndex`
  bounds-checks by contract), so birds are spliced into every recipient's
  payload unfiltered rather than gated by position.

- **Appearance on creep.** Wildlife (5 Hz) and monsters (1 Hz) need no extra
  mechanism: `broadcastVisible` re-reads every connected player's own mask on
  every call, so a chunk a player just earned is reflected on the very next
  cadence tick regardless. Flora and structures cannot rely on their cadence
  — their periodic full resync is a 60 s REPAIR cadence, not a sync
  mechanism, and a delta only announces what just changed, not what has been
  standing there all along — so `TerracePlugin` gains one additive optional
  hook, `onChunkUnlockedForToken(world, token, cx, cy)`, fired by
  `WorldApi.unlockChunkForToken`'s wrapper after a REAL (non-idempotent) unlock,
  once per plugin. Flora and structures each push a targeted, ADDITIVE delta
  (never their "replace the whole list" message type, which would wipe out
  everything else the player already knows) containing whatever already
  stands in that one chunk.

- **Disappearance for a moving entity, verified client-side, no client
  change needed.** Both the wildlife and monsters clients already replace
  their whole entity map on every message and drop whatever id the newest
  message omits (`WildlifeInterpolator`/`MonsterInterpolator`'s own doc
  comments already say so) — fog-of-war's per-player, sometimes-smaller list
  is exactly the input that path was built for. Flora and structures never
  need an equivalent: their content is static and per-token masks are
  monotonic, so a position visible to a player now was visible to them at
  every earlier moment too — there is no "used to see it, now don't" case for
  a tree or a building to hit.

- **Perf, estimated at the shipped caps and ~10 players (the same anchor the
  bandwidth arithmetic elsewhere in this section uses).** `broadcastVisible`
  is O(players × items); at 10 players this is ≈1 680 `isCellVisibleTo` calls
  per wildlife broadcast (168 entities, 5 Hz ⇒ ≈8 400/s), ≈20/s for monsters
  (2 entities, 1 Hz), and for flora/structures — bounded by FLORA_TREE_CAP
  (3 000) / STRUCTURES_CAP (512) but almost never exercised at the cap on a
  keepalive (60 s) and typically single-digit item counts on a delta — a
  worst-case ≈30 000/500/s amortised on the keepalive and negligible on
  deltas. Every `isCellVisibleTo` call is O(1) (a couple of `Map`/typed-array
  lookups); one filtered array is allocated per recipient per call. All of
  this is rounding error next to the per-tick work these plugins already do
  (flora/structures each already scan thousands of cells a tick for their own
  survey/CA sweep).
### Decisions made 2026-08-19 (issue #21 — the frontier revert)

Owner report: "when I am moving land around it sometimes goes back and redraws
the outline and removes areas that I just sculpted."

**Root cause.** The client had no way to be TOLD that its intent was applied,
so it inferred acknowledgement by comparing the authoritative heights against
the ones its own prediction produced (`isConfirmed`). That inference only works
while the client can reproduce the server's arithmetic, and at a territory
frontier it provably cannot: the shared brush and relaxation math read cells in
chunks the client was never sent, and the mirror holds those at SEA_LEVEL as a
RENDERING choice (so revealed land slopes into the sea rather than ending in a
floating cliff). The prediction therefore never matched, was never retired, and
was replayed on top of the server's own copy of the same edit for a full
PREDICTION_TTL_MS — dragging just-sculpted ground down and then snapping it
back. Measured on the repro: the client rendered 181 where the server said 224,
and pulled its own frontier column to 149 from a starting 160.

Two changes, at the contract layer rather than at the call sites.

- **1. THE ANSWER CONTRACT (protocol, additive).** A new
  `SculptAppliedMessage { type, seq }`, sent to the ORIGINATING client only, is
  the twin of the existing `SculptDeniedMessage`: an intent carrying a `seq`
  now gets exactly one answer — applied or denied — and the client retires that
  prediction on the answer instead of guessing. **Ordering is the contract**:
  the ack is sent from `server/src/intent/pipeline.ts` only AFTER
  `applyServerSculpt` has returned, so it lands behind the terrainDiff and
  behind any `chunkUnlock` the same stroke earned. Verified from source
  (@colyseus/core 0.17.50 `Room.broadcastMessageType`, @colyseus/ws-transport
  0.17.13 `WebSocketClient.send`) that both funnel into the same per-client
  `enqueueRaw` synchronously, so call order is wire order. Retiring earlier
  would show pre-sculpt ground for a frame. Value agreement is kept as the
  fallback for a seq-less intent; the deadline stays as the safety net.
  The seq echoed is the CLIENT's, not a plugin-rewritten intent's — it
  identifies the prediction being held, not the edit the server made.
- **2. PREDICT ONLY WHAT YOU CAN COMPUTE (client).** `predict` already refused
  an intent whose brush CENTRE was in a chunk it had never received; that rule
  was right and merely too narrow — a brush is not one cell. It now refuses any
  intent whose footprint, plus the one-cell ring the relaxation compares
  against (`PREDICTION_HALO_CELLS`), reaches a chunk it has never received.
  The stroke is still sent and still applied; only the local preview is
  skipped, and only where it would have been wrong. This matters most for the
  level-fill brush (stamp + hard), which SURVEYS its whole footprint for the
  lowest terrace band: one unseen cell reading SEA_LEVEL drags the survey to
  band 0 and the entire stroke targets the wrong terrace.

**Not the cause, checked and recorded so it is not re-suspected.** The #17
union-vs-per-token asymmetry cannot produce a revert. Every per-token mask is
ORed into the union when it is granted, so the union is always a superset: a
client is never denied a diff cell for a chunk it holds. The asymmetry can only
send a client cells for a chunk it does NOT hold, which land in the mirror's
backing array, are in no mesh, and are overwritten whole by `writeChunkHeights`
if that chunk is ever unlocked for it. That is the fog-of-war leak already
tracked from #17, not this bug.

**"Redraws the outline" is a symptom, not a second defect.** The brush outline
follows the picked surface height and the terrace bands are a quantisation of
height (`bandColors.ts`), so both redraw whenever the heights under them move.
Nothing in the render layer was changed.

**Residual, stated rather than punted.** A stroke whose footprint is entirely
on known ground but whose relaxation cascade travels far enough to read past
the frontier anyway still predicts wrong — the halo bounds the brush's own
neighbour reads, not an arbitrarily long cascade. It is bounded to ONE ROUND
TRIP by the ack instead of to PREDICTION_TTL_MS, and it can no longer double.
Closing it exactly would mean having the shared math report its read set, which
is a change to `shared/` for a case the ack already makes invisible.

### Decisions made 2026-08-19 (Deep Strata — mechanics card 41, and the kraken bar)

**Deep Strata ships in core: the world gets a crust.** Below the sea column's
16 blue bands the range now continues through named strata — basalt (bands
−17..−20), obsidian (−21..−23), and one lava band at the new floor (−24,
MIN_HEIGHT = −1536). The strata are shared constants (`SEA_COLUMN_BANDS`,
`DEEP_BASALT_BANDS`, `DEEP_OBSIDIAN_BANDS`, `DEEP_LAVA_BANDS`) and MIN_HEIGHT
is DERIVED from the stack, never restated; the client palette and the monsters
plugin both derive from the same constants, pinned by tests on each side.

- **The sea column is unchanged on purpose.** 16 bands is the old floor,
  kept exactly: every stored world remains in contract (old MIN sits inside
  the new range), the blue depth ramp renders byte-identically, and "deep
  water" keeps meaning water.
- **Palette regimes.** The blue column's strict-darkening contract now ENDS
  at band −16; the first basalt stop is deliberately BRIGHTER than the blue
  floor (breaking through the seabed reads as a material change), the rock
  darkens strictly to the obsidian floor, and the lava band is the palette's
  one light source — rendered self-lit via the same per-vertex flag the
  seabed rims introduced (`isEmissivePaletteIndex` → cap self-lighting in
  capEmission.ts; contour and blocky-fallback paths share the predicate).
  Underwater riser/lip-border rules (2026-08-19 riser amendment) extend to
  the strata unchanged.
- **Derived budgets followed the range**: SMOOTH_SPREAD_CELLS 64 → 80,
  SMOOTH_PASS_LIMIT 256 → 320, both by existing derivation; stress suites
  converge under the scaled cap. Mana is untouched — pricing is volume per
  stroke (footprint × band), independent of world depth, and the mana suite
  passes unmodified.
- **Hazards are NOT core.** Heat, eruptions, anything gamey in the deep is a
  future plugin reading these same boundary constants (nothing-gamey-in-core
  rule). Punted explicitly, tracked as follow-up.

**The kraken bar moves to the natural ocean floor (owner-decided 2026-08-19).**
`KRAKEN_LAIR_MIN_DEPTH_BANDS` was "half the water column" (8 bands, −512) —
one band below the deepest floor worldgen naturally shows, so every world
demanded one mandatory manual dig before its first kraken; worse, Deep Strata
deepening the range would have silently dragged a column-anchored bar to 12
bands. New derivation (plugins/monsters/server/kinds.ts): genesis oceans
bottom out at band −8 (−512, band multiples by construction) and the first
relaxation to reach a floor's rim shaves up to MAX_STEP/2 = 16 off the extreme
cell — hence the live world's −496 floor. The bar is that relaxed natural
floor in whole bands: **7** (`NATURAL_OCEAN_FLOOR_MIN_DEPTH = 496`). A natural
−496 trench now summons the kraken with no digging; worlds whose noise never
reached band −8 still need a dig, unchanged. Pinned three ways in the monsters
suite: −496 passes admission, a natural-floor basin summons a kraken
behaviourally, and the bar is 7 independent of MIN_HEIGHT (a retune that moves
it fails the pin, not the players).

### Decisions made 2026-08-19 (the Cartographer — mechanics card 45)

**An in-game chart of the known world, client-only by construction.** The map
button (bottom-right, stacked above the gear so the phone-width strip gains no
width) opens a modal overlay that renders the player's revealed chunks as an
inked parchment chart, exportable as a PNG named after the world. Everything
is derived on the client from the terrain mirror through a narrow read-only
window (`World.chartSource()`): "revealed" is exactly the mirror's `received`
set — the renderer's own notion of what exists — so no reveal-plugin knowledge
and no protocol change is involved, and nothing new goes on the wire.

**The chart is a document, not a minimap.** Drawn once per open (dated the
moment it is made), sepia ink on parchment rather than the game palette: band
boundaries become contour lines, the waterline a heavy coast stroke, water a
depth-graded wash with wave-dash hatching, and the FOG BOUNDARY is the
parchment's own burnt edge — a singe gradient plus a jittered tear line — with
"here be krakens" set in the deepest unknown. The sheet crops to a padded
square window around revealed territory (`chartWindow`): at the live world's
~2% revealed, a world-scale sheet made the known world a stamp on an empty
page. All randomness (mottle, tear jitter) comes from a fixed integer hash of
cell coordinates, so identical knowledge charts identically on every client.

**Split for testability.** Classification, the frontier BFS/singe field, the
kraken anchor and the crop window are pure in `client/src/terrain/chart.ts`
(tested, `client/test/chart.test.ts` — including that unrevealed heights are
NEVER read); the canvas painting and the Solid overlay live in
`client/src/ui/Cartographer.tsx`. Chart-open state is deliberately not
persisted — reopening a modal on reload is a surprise, not a preference.

### Decisions made 2026-08-19 (world events & the Chronicle — mechanics card 46)

**World events & the Chronicle.** Core gains one neutral primitive:
`WorldApi.emitEvent(type, payload)` fans out to every plugin's `onWorldEvent`
in load order, server-side only, event name namespaced with the emitter's name
exactly like wire messages (unforgeable, collision-free), depth-guarded at 4
like terrain cascades. Consumers subscribe by emitter NAME and validate
payloads structurally — never by import; cross-plugin agreement travels as
documented copies pinned by shared golden vectors (chronicle ↔ structures race
derivation). Emitters: structures `changes` (cause generation/sculpt), relics
`collected`, monsters `arrived`/`departed` (queued at summon/banish, the
lifecycle's single entrance/exit; snapshot restores never announce). The
chronicle plugin is the first pure consumer: deterministic saga lines (no RNG;
integer-millisecond clock, 600 s = one "day"; hashed place names), coordinates
never on the wire so plain `broadcast` is fog-safe by construction; slice
persisted in the world snapshot, capped at 512 entries oldest-out. What earns a
line: placed seeds, world-first tiers above camp, ≥3 homes lost in one chunk in
one event (below = CA churn), collections, monster firsts/returns/departures.

### Decisions made 2026-08-19 (settler races & Pilgrim Routes — mechanics card 47)

**Settler races & Pilgrim Routes (owner decisions 2026-08-19).** Two settler
races: Rudys (little dog people) and Unos (cat people); ids `rudy`/`uno`,
plural Rudys/Unos. Race is derived, never stored: bit 24 of the structures
cell-hash over 16-cell district coordinates (`SETTLER_DISTRICT_CELLS`), one
race per district. Other plugins copy the derivation (plugin-isolation rule)
and pin the shared golden vectors: (0,0) rudy, (16,16) uno, (100,100) uno,
(511,511) rudy. Pilgrim routes (card 47): monster settled = 16-cell circle
held 120 s; catchment 64 cells; viewpoint = highest walkable cell on a 24-cell
ring (8 = measured largest protection aura 4.5 rounded up + drift margin,
deliberately not imported); walk 0.5 c/s, linger 30 s, cap 24; all constants
derived in `pilgrims/server/pilgrimage.ts`. Route blessing: structures waives
only `STRUCTURE_UPGRADE_MIN_NEIGHBORS` for blessed cells (age gate and B3/S23
untouched), replace-semantics total state, not persisted. Pilgrims plugin
reads monsters/structures via relics→mana-style dynamic bridges; difficulty
deliberately unread (monsters already scale with it).

### Decisions made 2026-08-19 (build-identity watermark, and two knobs closed)

**Version watermark (owner request).** Both halves of the stack stamp a build
identity `<commit count>.<short hash>` derived from git — server at boot
(`server/src/version.ts`, carried on the join snapshot as `serverVersion`),
client at Vite start (`define` in `client/vite.config.ts`). The HUD renders
both top-right (`ui/VersionWatermark.tsx`) and turns loud on mismatch. Why:
2026-08-19, a Vite-only restart after a shared/ commit served a client on
newer terrain math than the server — every stroke previewed one thing and
applied another. Derived-from-git means versions bump on every commit by
construction; `TERRACE_VERSION` overrides where .git is absent (docker, #8).
Operational rule that goes with it: **a stack restart restarts both halves
together, always.**

**Knobs closed with the owner (2026-08-19):** co-located sea-monster spawns
stay as they are — overlapping god-beasts shielding each other is emergent
flavor, not a bug (no spawn offset); the three #25 test towers and consumed
relics on Frostwick Hollows stay as landmarks. (The kraken reachability knob
was closed the same day — see the Deep Strata section above.)

### Decisions made 2026-08-19 (two owner bug reports: anchored smooth, and paying for nothing)

**Anchored smooth strokes contain their own relaxation.** Owner report on the
synced stack: "smooth, soft appears to be broken" / "it sometimes resets top
layers". Root cause in one sentence: the clicked-cell anchor bound only the
brush pass, so the smooth tool's relaxation — unrestricted inside the
footprint — immediately eroded the higher terrace the anchored brush had just
promised to leave alone, and lifted just-raised ground past the clicked
ceiling. Fix at the contract layer: an anchored smooth stroke hands the
relaxation a per-cell bound for every footprint cell, from pre-relaxation
heights — cells past the anchor target are FROZEN for the stroke; cells short
of it may move up to the target in the stroke's direction and freely against
it (slump stays physical; a wall may still shed into a dug ring). Where a
bound bites, the pair is left over-steep — the same accepted residual, for
the same reason, as issue #26's banded spill. The three anchored call sites
(brush ceiling, level-fill target, relaxation containment) now share ONE
target derivation (`anchoredTargetHeight`). `anchor: 'free'` and
`spill: 'free'` library paths are bit-identical to before.

**Charge follows effect.** Owner report: at the world floor, sculpting
"is not changing the landscape … but it's taking my mana". Root cause in one
sentence: the mana charge was the nominal brush volume and never consulted
the applied diff, so a stroke that changed zero cells (a footprint entirely
at the world floor, or a saturated ceiling) still cost full price. Fix in the
effect phase, where the authoritative diff is already in hand: an applied
intent whose diff is EMPTY charges nothing (and still pushes the balance, so
the client gate's optimistic debit is erased — the same standing-phantom
closure as the deny path). This deliberately does NOT reopen the 2026-08-14
pricing decision: the PRICE stays a pure, terrain-independent function of
(radius, profile) — client gate and server still agree on it without knowing
the terrain — and a stroke that moved even one cell still costs the full
nominal price. Only the degenerate all-or-nothing case changes, and it is
decided server-side at the charge site, not in the shared price function.
Consequence pinned in tests: zero-effect strokes are applied (not denied),
free, and balance-pushed, across every tool × profile; partially-clamped
strokes still pay in full. (The suite's own drain loops now alternate
raise/lower — pumping one cell forever is exactly the free-stroke case now.)

**Terrain at the floor was never the bug** (verified and pinned): widening a
pit at MIN_HEIGHT works — wall cells inside the footprint keep descending
toward the floor; a footprint entirely AT the floor is a true no-op with an
empty diff, under both tools and both profiles.

### Decisions made 2026-08-19 (flora × structures — buildings always win)

**Trees despawn under buildings, by two layers, not one.** Owner report: "if
buildings are going to spawn over trees, then the trees need to de-spawn."
structures' `changes` world-event (b47d09e) names `seeded`/`upgraded` cells,
but that list is deliberately narrower than "every new structure" — it
excludes ordinary B3/S23 births and stir sparks, which chronicle treats as
churn, not history. A consumer needing "every occupied cell" cannot get it
from the event alone. Fix: flora's onWorldEvent fells a tree the instant its
cell is named seeded/upgraded (instant, matches the event's own causes); its
existing periodic survey (~5 s cadence) additionally treats every
structure-occupied cell — read via a new read-only cross-plugin bridge,
flora/server/structures-bridge.ts, the established dynamic-import pattern
(relics→mana) — as unplantable, culling anything already standing there.
This second layer is load-bearing, not redundant: it is what actually
guarantees the invariant for ordinary births/stir sparks and for buildings
that predate this feature. Structure death does not replant; the cell
recolonizes on flora's ordinary schedule once it drops out of the occupied
set.

### Decisions made 2026-08-19 (kraken correctness pass, commit 268cf9a)

**Kraken depth bar — derivation corrected.** The bar stays at 7 bands (−448);
the reasoning recorded for it did not survive checking. Genesis never
smooths, so a fresh world's floor is always an exact band multiple and −496
is an *edited* floor, not a natural one; the relaxation shave is `ceil(e/2)`,
not a MAX_STEP/2 bound. Band −8 is a reference, not a maximum — the noise
lattice spans bands −10..+4. And because only unlocked cells count as
habitat, the "no mandatory dig" benefit lands in ~30% of fresh worlds
(measured over 400 seeds at both 128² and 512²), not all of them. Seven
remains the right number on the corrected facts: it is the deepest bar
admitting both an untouched band-8 floor and that floor after one one-band
shave, and going shallower would collapse onto the 3-band `FRESH_SEABED`
clamp — Cthulhu's own line — erasing the only thing that separates the two
sea kinds. Owner ratified the follow-through the same day: worldgen will
GUARANTEE one qualifying trench per fresh world (issue #42) rather than move
the bar.

**Monster aura geometry.** The no-raise disc bounds the brush by
`intent.radius`; since the tight-disc footprint (`dx²+dy² < r·(r−1)`,
2026-08-19) that is an upper bound, not an equality. Erring wide refuses a
raise that could not have touched the monster, which is the safe direction
and is deliberate; a contract test pins the containment against shared's own
footprint function for every legal radius.

### Decisions made 2026-08-19 (the banner is the chronicle's door)

**World-header action registry (owner move).** Core gains a world-header
action registry (`plugins/hudPanels.ts`): ONE plugin may claim the top-centre
world banner — core renders the claimant's icon right of the world name and
the whole banner becomes a button (aria-label from the action; the
name/rating tooltips survive as inner titles). First registration wins, the
`onCanvasPress` precedence rule; later claims warn and are ignored;
unclaimed = the inert title card. The chronicle claims it and its info-panel
row is gone; its reader mounts from a bare `top-center` host ('panel'
placement would unmount with a collapsed phone panel). Phone widths: the
banner's max-width is derived as `100vw − 2·120px` so a centred banner clears
the ~110px Info tab and watermark; long names ellipsize.

### Decisions made 2026-08-19 (touch-dolly guard — the two-finger camera reset)

**Touch-dolly guard.** OrbitControls' two-finger dolly divides each move's
finger separation by the last one it saw, unguarded; iOS touch coalescing can
collapse the reported separation to ~zero for one frame, which slams the
orbit distance to a zoom clamp (owner: "two-finger tap resets the camera to a
default location"; reproduced via CDP, 200px→1px → distance 80→900 — and at
distance 900 the distance-scaled pan explains the earlier "jumps across the
map"). Two independent layers sit in front of OrbitControls, which stays
unpatched: a pair born under `TOUCH_DOLLY_MIN_SEPARATION_PX` (24 px) is
treated as one coalesced contact and gets `touches.TWO: null` for its
gesture, and any move stepping separation beyond `TOUCH_DOLLY_MAX_STEP_RATIO`
(1.5×) in one event is swallowed at document capture. The guard's baseline
advances only on moves OrbitControls actually saw, so a swallowed artifact
costs nothing and honest pinches are untouched (verified live: 80→56.5
across a 120→170 px spread, exactly the theoretical ratio). Contract pinned
in `client/test/touchGuard.test.ts`.

### Decisions made 2026-08-19 (mesh budgets recalibrated — the blocky fallback, #38)

**Mesh budgets recalibrated for Deep Strata.** The blocky fallback fired on a
legitimate dig: a brush-4 hard pit from the coastal shelf to the lava floor
measures 10,575 triangles against the 10,240 budget calibrated 08-14 on land
fixtures — bordered underwater risers count double and Deep Strata added 8
bands, so floor-depth digs stack ~26 contour levels per chunk. New submerged
fixtures (wire-default anchored brush, provably bottoming at MIN_HEIGHT)
remeasured the table; heaviest legitimate chunk = 28,033 tris / 777k work.
Legitimate triangle counts now exceed adversarial pit-fields', so the
triangle budget stops discriminating and becomes purely the memory bound:
32,768 (one capacity doubling, 3.64 MB high-water). The work budget stays
1,000,000 as the sole discriminating guard (legit ≤ 777k, adversarial ≥
1,695k; depth adds levels — linear; adversarial shapes add holes —
quadratic). Counts report triangulationWork; the legitimate-sculpting
contract is pinned both ways in tests. Known cost: the worst legitimate chunk
builds in ~9 ms — an occasional dropped frame at the bottom of the world,
chosen over drawing the dig as blocks; the architectural remedy is
async/multi-frame meshing (#47, flagged, not built).

### Decisions made 2026-08-19 (every fresh world contains a kraken trench, #42)

**Every fresh world contains a kraken trench (owner-decided).** The kraken
bar moved to the natural ocean floor earlier the same day, but whether a
world HAD such a floor was a per-seed coin toss: over 48 seeds, a lair-sized
basin reaching 7 bands existed on 46% of 128² worlds and 58% of 512². The
rest owed their players a mandatory dig. Genesis now guarantees it. After the
noise field is drawn, `buildFreshGenesisTerrain` surveys the oceans it
produced and — only if none is both lair-sized (`KRAKEN_MIN_LAIR_DEEP_CELLS`,
restated core-side) and already deep enough — cuts a capsule trench to
`GENESIS_DEEP_OCEAN_REFERENCE_BAND` through the deepest ocean it has, along
one of eight seed-chosen integer axes. Integer-only, derived from
`(size, seed)`, no additional RNG draws, tie-broken by total orders rather
than traversal order. The load-bearing rule is that it only ever LOWERS cells
that are already open ocean: the set of deep-water cells is exactly what the
noise produced, so no classification moves, the wildlife day-one census is
untouched, and the chosen region keeps its area. It is a byte-for-byte no-op
on every world whose noise already qualified (verified: the no-op count
equals the already-qualifying count exactly), and it runs on the genesis path
only, so snapshot-restored worlds are unaffected. Trench walls descend one
band per `BAND_HEIGHT / MAX_STEP` cells — the steepest slope that still
satisfies the relaxation invariant — so a smooth stroke cannot slump the
floor the guarantee rests on. The guarantee is about terrain, not
progression: `isLairCell` still requires an unlocked cell, so day one remains
a mixture (33/48 and 29/48, up from 15/48 and 19/48) and a trench outside the
starter square arrives with territory creep. Rejected: stamping a fixed basin
(cuts through whatever the noise placed) and biasing a lattice point deeper
(a soft bowl, and not actually a guarantee).

### Decisions made 2026-08-19 (kraken eviction withdrawn; arrivals scatter)

**The kraken has no eviction (owner: "For now, no eviction. Later, if we do
boats, they can attack the kraken.").** The collapse rule is withdrawn rather
than retuned. It had never described what the code did — it counted cells of
the 3-band deep-water region, not of the 7-band trench, so refilling the
trench that summoned the kraken did nothing, genuinely draining it meant
raising ~87% of a fresh world's ocean, and the only cheap counter was an
undocumented trick, walling it into a sub-threshold pocket. Rather than pick
new numbers for a mechanic nobody had designed, the mechanic waits for a
fiction: boats fight the kraken (#43), terrain does not. What remains is
physics — raise the seabed under its own cell and it cannot stay, which
starts the usual ten-minute absence — and the cooldown machinery is kept
whole for the boats arc. The yeti's collapse rule is unaffected;
LAIR_COLLAPSE_HYSTERESIS_DIVISOR stands as the rule any future departure rule
must satisfy.

**Monsters no longer rise from one cell (owner-decided).** The summon point
was a region's single deepest cell, so after Deep Strata gave players 24
bands to dig through, one hand-sunk shaft owned every future arrival of every
kind — and made the permitted co-location of the two sea kinds structural
rather than incidental. Arrivals are now hash-picked uniformly among the
region's qualifying cells: the kind's own reach bar, so the kraken scatters
over trench cells and Cthulhu over any deep water and they remain different
animals. The pick is seeded from the persisted monster-id counter and mixed
with murmur3's fmix32 — integer-only, exactly repeatable, unique per summon,
and different for two kinds arriving on the same tick. Co-location remains
allowed; it is now a coincidence. Applied to all kinds, the yeti included,
because nothing else in this lifecycle special-cases a habitat.

### Decisions made 2026-08-19 (hi-res settler models)

**Hi-res settler models (owner decision).** Pilgrim folk are the one
deliberately smooth family of models in an otherwise flat-shaded blocky world
(approved concept: artifact d6cf5ca4). Construction: per race, all static
body parts merge into one vertex-colored Lambert geometry and the glossy
eyes/nose into one Phong geometry — 8 draw calls, ~7k triangles per pilgrim,
shared geometry across instances. Vertex colors are stored exactly as
`new Color(hex)` yields them — three r152+ already converts to working space;
converting again double-darkens (round-1 defect). No lighting/shadow changes:
smoothness comes from geometry and smooth normals under the existing
hemisphere+sun rig. The rig contract (`create(race)` → `{root,
animate(seconds, phase)}`, feet at y=0, +X forward, joint meshes) is
unchanged; animals, monsters and structures stay blocky pending a separate
owner decision.

### Decisions made 2026-08-19 (wanderers — ambient settlers, card 26)

**Wanderers.** A second walker kind on the pilgrims wire (`kind: 'pilgrim' |
'wanderer'`; absent kind parses as pilgrim, unknown kinds drop; one id
allocator across both sims). Deterministic dispatch: time cut into 60 s
epochs; each epoch every qualifying settlement rolls
`hashCell(hashCell(x,y)^epoch, epoch) % 4 === 0`; the roll's high bits pick
the destination. Qualifying = SENDER has survived ≥ 4 CA generations
(structures' own `age`, carried over the bridge since 2026-08-19;
wire-neutral; absent age = old build = qualifies); destination = ANY standing
settlement 8–48 cells away, walkable — the card demands "stood some while" of
the sender only, and the measured world (snapshot gen 3401: 14 cells, ages
mostly 0–2) has no established pairs. Journey: walk out, visit 10 s, walk
home, despawn; pilgrims' stuck rules verbatim. Purely cosmetic by contract —
no blessing, no mana, no monster reads. Cap 16 (< pilgrims' 24: events may
crowd, ambience may not). Visual: same race body/gait/palette, no staff — the
one at-a-glance kind difference. Tuning is sized to the MEASURED world and
recorded as such; a dense future world rides the cap.

### Decisions made 2026-08-19 (the kraken's body; dread derives per kind)

**The kraken's body, corrected (owner: "physically wrong").** The first
kraken stood its 6.4-cell mantle near-vertically on a floating head — ~90% of
the animal above the waterline, fins as a mid-air brim — which no soft-bodied
floating animal can do. The model now follows surfaced-cephalopod fact: a
humped back arching from the head to a fin-fluked tail riding at the
waterline, arms draped along the surface with tips just under, tentacles
rearing higher and hanging deeper. Eyes stay at the waterline (ratified
intent). The 7-cell footprint holds, with the mantle's swept SKIN (axis +
local radius, sampled off the real curve by test) inside the half-footprint
and the arm tip still the binding constraint; `KRAKEN_TOTAL_HEIGHT` is a
tested upper bound on the skin top. The kraken is now deliberately WIDER than
it is tall — the "spider on the water" its own design prose always claimed.

**Dread weather derives per kind (#44).** The authored effect was Cthulhu's
anatomy applied to every swimmer; each swimmer now gets mist ceiling,
flash-light height, bolt annulus, and bolt bottom derived from its own
anatomy (`dreadSpecOf`), with Cthulhu's spec reproducing the authored values
exactly. On the kraken — eyes 0.30 above water — the bank is by construction
a low film on the sea, never over the lamps.

### Decisions made 2026-08-19 (Rivers & Springs — mechanics card 27; Waterfalls — card 40)

**Card 27** — "Springs on high ground send water stepping down band edges to
the sea, pooling in basins. Deterministic flow from the heightmap alone —
sculpting a river's course becomes the game's most satisfying puzzle."
**Card 40** — "Where a river (card 27) crosses a band edge it falls — mist,
sound, and a small mana-regen aura at the plunge pool." Card 40 depends on
card 27 and was built on top of it in the same pass, owner-approved.

**Water is derived, never simulated — extended, not amended.** Q3 already
settled this for the sea (`height ≤ SEA_LEVEL` is water, computed identically
on both sides, nothing synced). A river is the same fact one level up: a
PURE FUNCTION of the heightmap — `computeRiverNetwork(map, options)` in the
new `shared/src/rivers.ts` — with no per-tick simulation and no river state
anywhere, ever, including in memory: server and client each hold only a
CACHE of the last computed answer, rebuilt from scratch whenever they choose
to recompute, and two rebuilds against the same heightmap are byte-identical
(pinned by `shared/test/rivers.test.ts`'s determinism test). **Nothing about
a river or a waterfall is on the wire.** Springs, courses, pools and
waterfalls are recomputed independently by the server (from its authoritative
`Heightmap`) and by every client (from its own `TerrainMirror`) and agree by
construction, the same way two clients' sea renders agree without either
being told where the coastline is.

**Where springs come from, and why it needs no seed.** A cell is a spring
when it is a STRICT local maximum among its in-bounds, active 4-neighbours
(no tie — a flat plateau seeds no spring) and sits at least
`SPRING_MIN_HEIGHT_ABOVE_SEA` (one terrace band, 64) above `SEA_LEVEL`. This
is a purely LOCAL, purely geometric test — no RNG, and deliberately no world
seed either, unlike fresh-world genesis noise. Two reasons, not one:

  1. **Stability under sculpting is the whole point of the card.** A spring
     must appear or vanish exactly when the terrain that makes it a peak
     appears or vanishes — that is what makes "sculpting a river's course"
     the puzzle the card asks for. A seed-anchored placement would have
     springs the player cannot move by sculpting, or springs that drift for
     reasons unrelated to what they just built.
  2. **The genesis seed is explicitly outside shared/'s determinism
     contract** (see the fresh-world entry above: "world genesis, seed draw
     included, is not part of it... the client never generates terrain").
     Reading it from `shared/` would need threading a server-only value into
     client-side prediction math for no benefit — the heightmap the player
     can see already carries every bit this mechanic needs.

**The flow algorithm: bounded steepest descent, then a bounded basin fill.**
(AMENDED 2026-08-21 — a tie between neighbours no longer picks one and drops
the rest; it SPLITS the river. See "rivers split, and are drawn as polylines"
below; everything else in this paragraph stands.)
From each spring, `traceRiver` walks to the strictly-lowest of its four
neighbours (fixed N, E, S, W scan order — part of the determinism contract,
exactly like `forEachFootprintOffset`'s fixed scan order in heightmap.ts),
recording a **waterfall** at any step whose two ends cross a `bandOf()`
boundary (this IS the "crosses a band edge" test card 40 asks for — no
separate detection pass). Reaching `SEA_LEVEL` ends the river. Reaching a
cell with **no** strictly-lower active neighbour is a closed basin, handled
by `fillBasin`: a textbook priority-flood (min-heap over the rim, `level`
rising to the highest cell absorbed so far), restricted to ONE basin rather
than run over the whole map, stopping the instant it finds a rim neighbour
BELOW the current water level — that cell is the spillway, and the pool's
surface height is `level` at that moment. **Every pooled point carries that
one flat `poolHeight`** (not each submerged cell's own, lower, ground
height), which is what lets a renderer draw a flat lake instead of a lumpy
wet patch — added to `RiverPoint` specifically for that reason. This is the
"classic answer" the pooling requirement asked for: a lake at the basin's
true spill height, not merely "stop and don't loop" — see the punt below for
where it is intentionally cheaper than a full watershed solve.

**Recompute strategy — the cost argument, in full.** A naive full recompute
on every terrain diff does not fit: `computeRiverNetwork` scans every active
cell for local maxima (O(active cells)) and then traces every spring found —
MEASURED on a 512² world with adversarially rough terrain (every cell a
pseudo-random height, the worst realistic case for "how many local maxima
exist"): **~15 ms**; on terrain shaped like actual sculpting (40 stamped
peaks on an otherwise flat 512² world): **~1.9 ms** (`shared/perf_rivers.ts`,
run ad hoc — not committed, the numbers are recorded here). A held brush
emits an intent every `SCULPT_REPEAT_INTERVAL_MS` (120 ms, client/src/
config.ts) ≈ 8.3/s, **per player** — recomputing inside every applied intent
would scale server CPU with `players × 8.3/s`, not with a fixed budget, and
at ~10 concurrent players sculpting at once that is 80+ recomputes/s ×
15 ms worst case ≈ 1.2 s of CPU per second of wall clock. That is the "will
not fit" failure mode named in the task brief, confirmed rather than assumed.

The fix, matching `plugins/wildlife/server/census.ts`'s own
`HABITAT_CENSUS_INTERVAL_SECONDS` precedent ("too expensive per tick, so it
runs on an interval"), with two refinements of its own:

  - **Chunk/mask-scoped, not whole-world.** Both the scan and every trace are
    bounded by an `isActive(x, y)` predicate — the server passes
    `isCellUnlocked` (nobody can see a river over land nobody has revealed,
    exactly the wildlife census's own "unlocked chunks only" scoping); the
    client's `TerrainMirror` is naturally bounded to received chunks (an
    unreceived cell reads flat at `SEA_LEVEL`, which can never be a spring or
    a mid-course cell above it), so it passes no predicate at all. Cost is
    therefore proportional to the REVEALED area, not to `WORLD_SIZE²` — cheap
    for the overwhelming majority of a game's lifetime, when most of a 512²
    allocation is still locked.
  - **A real-time throttle, decoupled from both player count and edit rate.**
    `World.riverNetwork()` (server/src/world/world.ts) caches its last
    answer and recomputes at most once every `RIVER_RECOMPUTE_INTERVAL_MS`
    (250 ms — 4 Hz), driven by a dirty flag `World.applySculpt` sets on every
    non-empty diff. Worst case, at the measured 15 ms adversarial figure:
    `15 ms × 4/s = 60 ms/s` — 6% of one core, REGARDLESS of how many players
    are sculpting or how fast, because the cost is now a function of the
    THROTTLE, not of the edit stream. 250 ms (not "once per tick") is
    deliberately independent of `TICK_HZ`, which an operator may configure up
    to `MAX_TICK_HZ` (60): "once per tick" at 60 Hz would let the same
    adversarial case cost `15 ms × 60/s = 900 ms/s`, i.e. potentially over
    budget — a wall-clock cap avoids that regardless of tick configuration.
    The client keeps its OWN, independent 500 ms (2 Hz) throttle in
    `client/src/render/riverRig.ts` — half the server's rate, argued there:
    it is one screen's redraw cost, not a shared multi-player CPU budget, so
    it is tuned for feel (a river visibly settles a beat after the last click
    of a held stroke) rather than for worst-case aggregate cost. Determinism
    does not require the two throttles to agree, or to fire at the same
    moment — only that a given heightmap always produces the same network,
    which both sides' pure `computeRiverNetwork` guarantees regardless of
    when either side chooses to call it.
  - **A bounded downstream re-trace.** Within one recompute, every spring's
    trace (flowing steps AND the cells a basin fill absorbs, SHARING one
    budget) is capped at `RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER ×
    worldSize` cells (2×, i.e. 1024 cells on a 512-edge world) — a river or a
    pool larger than that stops where its budget ran out (`truncated: true`,
    observable, tested) rather than ever running unbounded. Springs
    themselves are capped at `MAX_SPRINGS_PER_NETWORK` (24, the highest peaks
    kept — sorted by height descending before the cap is applied), which
    bounds the number of traces a rough revealed area can trigger. Together
    these turn "cost could scale with terrain roughness" into "cost is capped
    by two named constants, independent of terrain" — the same shape
    `SMOOTH_PASS_LIMIT` gives the relaxation pass in heightmap.ts.

**What is on the wire: nothing.** No river message, no waterfall message, no
spring list — re-stated because it is the one thing this whole design would
be wrong to get subtly incomplete. `WorldApi.riverNetwork()` is a new READ
primitive (server/src/plugins/types.ts), exactly the same shape as
`WorldApi.heightAt` or `WorldApi.difficulty`: a plugin queries core's own
derived cache; core publishes a neutral fact and knows nothing about what any
plugin does with it.

**The waterfall mana-regen aura is `plugins/mana`'s concern, not core's**
(constraint from the task brief, matching "nothing gamey in core"). It reads
`WorldApi.riverNetwork()` directly inside its own `regenerate()`/
`manaRegenFor()` — the SAME multiplier-composition shape mana already uses
for perks (`manaPerkOf(playerId).regenMultiplier`, see the PERK API section
of `plugins/mana/server/index.ts`) rather than a new cross-plugin seam: this
is mana reading one more fact about ITS OWN world, not a second plugin
touching mana the way relics touches it through `setManaPerk`. Because there
are no player avatars in this game (players are gods sculpting a world, never
embodied in it — design §3.1), "standing at the plunge pool" is read against
a player's own REVEALED TERRITORY (`WorldApi.isCellVisibleTo`, the existing
per-player fog-of-war primitive from issue #17) rather than spatial
proximity: a waterfall the player has personally unlocked grants
`WATERFALL_AURA_REGEN_BONUS_PER_WATERFALL` (0.15 — a SMALL bonus, the card's
own word, capped at `WATERFALL_AURA_MAX_COUNTED` = 3 waterfalls so the effect
cannot be farmed by revealing a jagged coastline) on top of the
difficulty-derived rate. Tested end-to-end through the real plugin host in
`plugins/mana/test/mana.test.ts`.

**Render: two derived-geometry layers plus a mist puff, no headless GL rig**
(design §8: client rendering is verified manually; this project ships none).
`client/src/render/riverRig.ts` follows the house rig pattern
(`plugins/weather/client/rig.ts`'s own header): geometry/materials built once
and mutated in place on each throttled recompute (never inside the frame
loop), one owner frees what it made, and the only animated element — the
mist's gentle vertical bob — freezes under `prefers-reduced-motion`, matching
weather's "the whole sky holds still" rule (there is no flashing-light
concern here at all; this is done purely for consistency with the house
standard). (AMENDED 2026-08-21: flowing water is no longer a tile per cell
but one smoothed ribbon per course — see "rivers split, and are drawn as
polylines" below. Pools are still tiles, as described here.) Every river point
becomes a small flat translucent tile at its
cell's rendered (band-quantised) height — narrower for flowing channel,
full-cell-width and flat-at-`poolHeight` for a pool, so adjacent pooled tiles
join into one continuous lake surface. Each waterfall gets a small ring of
mist particles at its plunge point. Wired into `client/src/world.ts`
alongside `water`/`fog` — same lifetime, same "one instance for the session"
shape — refreshed from every path that changes the mirror's terrain
(`applyDirty`, `onChunkUnlock`) and FORCE-refreshed (bypassing the throttle)
on `onSnapshot`, so a rejoin to a different world never shows the previous
session's rivers for up to the throttle window.

**Punts, named:**

  - **Sound.** Card 40 says "mist, sound, and a small mana-regen aura". This
    project has no audio system anywhere in the client — confirmed by reading
    the whole client tree — and this change does not add one. Deferred in
    full; the mist and the mana aura ship, the sound does not.
  - **Basins are filled to their true spill height, but a basin larger than
    the shared trace budget is not.** `fillBasin`'s priority-flood is the
    textbook-correct algorithm — no approximation in the ALGORITHM — but it
    shares its per-river cell budget with ordinary flowing steps
    (`RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize`, 1024 cells on a
    512-edge world). A basin larger than that stops where the budget ran out,
    `truncated: true`, drawn as a pool at whatever level it reached rather
    than at the true spill height. Accepted because a player-scale basin is
    bounded by the brush footprint that dug it (≤ 37 cells at
    `MAX_BRUSH_RADIUS`) unless many strokes compound into one huge pit, which
    is a rare, deliberate act rather than an ordinary outcome.
  - **A single spring's course, in the adversarial worst case, can be cut off
    by the SAME shared budget** before it reaches the sea (`truncated: true`,
    observable, tested in `rivers.test.ts`'s truncation coverage via the
    budget-exhaustion path in `fillBasin`). Not observed on any
    player-constructed terrain during this change's own testing; named as a
    residual the same way `SMOOTH_PASS_LIMIT`'s truncation is.
  - **No headless visual verification.** The render layer (`riverRig.ts`) was
    NOT run in a browser or screenshotted as part of this change — there was
    no running client/server pair available to drive it against. Its
    correctness rests on: (a) the underlying math being unit-tested
    end-to-end in `shared/test/rivers.test.ts`, (b) `pnpm typecheck` passing
    for the client package, and (c) manual code review against the house
    rendering rules (`plugins/weather/client/rig.ts`'s header). Visual
    correctness — tile placement, mist legibility, colour/opacity balance —
    is UNVERIFIED and should be checked against a running client before this
    is considered feel-tuned.

### Decisions made 2026-08-20 (movement is one contract; the walkers were frozen)

**The report.** Owner: "my little people seem to get stuck in the middle of
nowhere, and they also tend to run into each other and they tend to walk
through water, which they should not be able to do. They need to path around
the water." Then, on seeing the code: "it would be nice if this pathing code
was semi-generic so that we could add the ability to specify certain rules for
different objects as to what they should and should not go around … the Yeti
should easily be able to traverse water. Same with terrestrial monsters, though
the terrestrial monsters should only be able to traverse the rivers, not the
lakes. Boats should be able to go anywhere in the water. At the moment, they
just kind of spin on top of each other."

**Diagnosis, from the live world rather than from reading.** The real
`server/data/world.db` (snapshot #188, 512², 4557 dry cells) was replayed
through the real sims:

- **Every wanderer in the world froze within 60 s and never moved again** — 16
  of 16 alive at the cap, none ever completing a journey, for the whole 20
  minutes of replay. Traced to a two-tick cycle: the route follower advanced
  its waypoint index on a 0.75-cell proximity radius while orthogonal waypoints
  are 1.0 cell apart, so a walker standing ON a waypoint was already "arrived"
  at the next one and skipped it; it then validated a free-space line to the
  one after that — a segment A* never certified, crossing a 44-unit riser —
  which failed, triggering a replan whose first cell is the walker's OWN cell,
  sending it back where it stood. The give-up timer could not catch it because
  it measured straight-line distance to the goal, which the oscillation reduced
  every other tick.
- **A second, independent freeze in the planner.** A*'s corner-cutting guard
  tested that a diagonal's two flanking cells were walkable GROUND but not that
  they were climbable, so it emitted diagonals whose flanks were cliffs. Legal
  on a grid; impossible for anything that moves continuously, because a body
  crossing to a diagonal neighbour passes through a flank.
- **Nothing anywhere implemented separation.** No mover read another mover's
  position, in any plugin. Boats have the same hole and it is why they spin:
  every boat is sent to the same kraken and told to hold at the same range, so
  they converge on one point of one circle and turn in place together.
- **They were never in the water.** 0 of 95 854 sampled walker positions were
  on a water cell. What they walk on is BAND-0 DRY LAND (height 1 to
  BAND_HEIGHT−1), which `quantizeToBand` draws at exactly SEA_LEVEL while
  `render/water.ts` floats the sea plane just above it — so the fringe every
  shoreline is made of is drawn underneath the sea. 292 of the world's 4557
  dry cells at the time of measurement (BAND_HEIGHT was 64), all coastal, and
  routes hug coasts. `waterDepth.ts`'s claim that "the water plane fails the
  depth test over dry terrain" was false for exactly that band.

**THE ROOT CAUSE UNDER ALL OF IT, in one sentence: four plugins had each grown
their own copy of the same steer-and-veto movement loop, and three of them said
so in their own comments** — boats' `steerToWater` ("Monsters' sweep"),
monsters' `steerToValidHeading` ("this is the pattern, copied, not an import"),
pilgrims' `stepWalker` ("wildlife's veto-the-step shape"), and wildlife's
`movement.ts`. Duplicating the loop duplicated its gaps: only one of the four
ever gained route following, none of them knew any other mover existed, and the
shared `WalkerProfile` could express exactly one ground class plus a slope
limit — which is why every rule the owner asked for was unwriteable.

**The fix is the contract, not the call sites.**

- **`shared/src/traversal.ts` — `WalkerProfile` becomes `TraversalProfile`,**
  carrying four independent axes instead of two: a SET of ground classes, a
  minimum ground height, a freshwater rule, and the slope limit. The archetypes
  every mover uses are named there once — `LAND_WALKER_PROFILE`,
  `RIVER_FORDING_WALKER_PROFILE`, `AMPHIBIOUS_WALKER_PROFILE`,
  `OPEN_WATER_PROFILE`, `waterBandProfile` — and a plugin PICKS one rather than
  building a literal, because building literals is how pilgrims shipped
  wildlife's pre-fix rule the first time.
- **`shared/src/freshwater.ts` — the river network, transposed.** Traversal asks
  a per-cell question; `computeRiverNetwork` answers a per-river one. A cell
  carries `none` / `channel` / `pool`, and pool beats channel where a spillway
  is both. This is what makes "rivers but not lakes" sayable. Optional on
  `TerrainSampler`, defaulting to none, so the axis is additive.
- **`shared/src/steering.ts` — one movement loop.** `steerAvoiding` is the
  sweep, now also refusing headings that land inside another mover, with a
  `permits` hook for the rules that are genuinely a plugin's own (boats'
  unlocked territory, monsters' whole-body lair pose). `followRoute` is the
  route follower, rebuilt: the index advances by CELL CONTAINMENT, it aims at
  the NEXT cell, it validates exactly one certified route edge, and a replan
  never targets the mover's own cell. It reports `progressed` — did the mover
  enter a new route cell — which is what a give-up timer must run on, since
  goal distance can neither survive a real detour (routes on the live world run
  a mean 1.74× and up to 3.57× straight-line) nor detect an oscillation.
- **Separation never freezes anyone.** The sweep runs a second pass ignoring
  occupants if every candidate was crowded out. Terrain is not relaxed on that
  pass. A deadlocked knot of walkers would be the same bug in a new hat.

**Both sides of the water question, owner-chosen.** The render is fixed — the
sea plane is fully transparent over dry cells, so a band-0 flat reads as the
"buildable-looking flat" §4 of the acceptance criteria always claimed — AND
land walkers decline ground below band 1, so they path around anything that
still reads as water. Q3 is untouched: height ≤ 0 is still water. The walker
rule is the narrower true statement (that fringe is land; a land walker just
will not stand on it), and it is a walker rule rather than a ground rule
because the ground classes are shared with everything that swims.

**Per-mover rules as shipped.** Yeti: amphibious — water inside his range stops
being an obstacle. His snowfield confinement is UNCHANGED; that is the habitat
regime and the banishment rule, both settled, and levelling his peaks is still
how he goes. Sea kinds and boats: open water, the whole sea. Pilgrims,
wanderers and grazers: land walkers. A future terrestrial monster that is not
amphibious picks the river-fording archetype, which exists and is tested even
though no shipped kind is its subject — that is what the owner asked for.

**Monsters keep `isLairPose` as their movement constraint** and take only the
freshwater axis from the new profile. Letting the archetype's slope limit
through as well would quietly add a rule monsters have never had (a yeti
refusing a riser inside his own snowfield), which is a gameplay decision nobody
has made.

**Named residual.** Separation is chosen against a start-of-tick snapshot of
everyone's positions — that is what keeps a mover's path independent of where
it sits in the iteration order. Two movers closing on each other can therefore
end a tick up to their combined step closer than their combined radii: a tenth
of a cell on a 0.4-cell gap at walker speed. Closing it would need a second
resolution pass over the whole population and an order-dependent tie-break, for
a tenth of a cell that is invisible at the scale bodies are drawn.

**Measured after the fix, same world, same replay:** 14 of 20 walkers complete
a full round trip (the rest give up honestly on a world that is 1.7% land and
heavily fragmented); 0 frozen; 0 on band-0 ground; minimum observed separation
0.415 cells against a 0.4 target. Before: 0 of 16 completed anything, ever.

**Follow-up 2026-08-21 — the freshwater axis was inert; core now supplies it.**
The axis above shipped as a profile field and a `TerrainSampler.freshwater`
that nothing ever populated: its absent-default is `NO_FRESHWATER`, so every
mover in the running game was answering "no fresh water anywhere". "Terrestrial
monsters may cross the rivers but not the lakes", and land walkers going round
a lake at all, were expressible and not in effect.

Supplied at the CORE layer, not per plugin: `World.freshwaterMap()` transposes
`riverNetwork()` once per network recompute, and `WorldApi` exposes it as a
`freshwater` PROPERTY named to match `TerrainSampler` — so a plugin's own world
interface is still handed straight to `isWalkableCell` with no adapter, the
same structural-typing trick `worldSize` and `heightAt` already use. Rejected:
each plugin building its own map from `riverNetwork()` (four copies of a
transpose, which is the duplication this whole contract exists to end), and
passing a `RiverNetwork` into traversal directly (freshwater.ts's header has
the cost argument — a linear scan per `isWalkableCell`, eight times per A*
expansion against a 4096-node budget).

`WorldApi.freshwater` is the ONLY route by which the map reaches `shared/`'s
predicates, and deliberately so: a `World` publishes `size` where
`TerrainSampler` asks for `worldSize`, so it cannot be handed to
`isWalkableCell` at all — the compiler refuses. One supply route means one
place to check when asking whether the axis is live.

Cache invalidation is by IDENTITY, not a second staleness flag:
`riverNetwork()` already promises the same object between recomputes, so
`cachedFor === riverNetwork()` is the whole test, and there is no copy of the
recompute condition to drift. The map inherits the network's scoping — unlocked
territory only — so a cell nobody has revealed reads `none`, which is the same
answer it gave before rivers existed.

The three plugin world interfaces (`PilgrimWorld`, `LairWorld`,
`HabitatWorld`) now DECLARE `freshwater` even though the field is optional.
Omitting it would still work in the running server and silently not work in
every test that builds a stand-in world — the one place a rivers-vs-lakes
regression would be caught.

**Follow-up 2026-08-21 — wildlife is on the contract, and separation was
measured at the wrong distance.** Wildlife was the fourth copy of the sweep and
the one the other three cited when they wrote their own; it is now a thin
adapter over `steerAvoiding`, keeping only what is genuinely its own (the
species → archetype resolution, the unlocked-habitat veto as a `permits` hook,
body size, the school terms, the two-stage contour retry). Personal space is
HALF THE BODY LENGTH as the client draws it, a derived half-extent rather than
a dial, because a small fish is 0.42 cells long and a whale is 5 and one
constant would either let whales overlap or hold fish a whale's length apart.

Migrating it exposed a real defect in the shared contract. `steerAvoiding`
tested separation at the TERRAIN look-ahead point, so whether separation did
anything at all was an accident of the ratio between a mover's look-ahead and
its body. Pilgrims got that by luck — a 0.3-cell probe against a 0.4-cell gap,
so the probe never left the exclusion circle and the test read as "is anyone
near me". Wildlife did not: a 1.8-cell probe against a 0.42-cell gap only ever
fired on a creature almost exactly 1.8 cells dead ahead. Measured worst-case gap
inside a school of five small fish, 100 trials: **0.033 cells, i.e. nothing.**

The fix is a required `stepCells` on `SteerOptions`, and separation is now
judged where the mover will BE rather than where it can SEE. Terrain keeps the
look-ahead, which is a different question with a different right answer — a
mover must see a cliff while there is still room to turn. Same measurement after
the fix: **0.290 cells.** Required rather than optional-with-a-default because
the only available default is the look-ahead distance, which is the defect
itself; `followRoute` already carried the field, so pilgrims' routed walkers got
it for nothing, and monsters state their step even though they supply no
occupants (the day they do, it is one line, not a silent no-op).

**Boats do NOT separate while sailing, and that is a division of labour.** With
the contract fixed, boats' sail-phase separation began bending the radius they
were closing on: measured at 5.03 cells against a 5.00-cell station, past
`BOAT_ENGAGEMENT_RANGE_CELLS`, and the fleet stopped routing the kraken at the
predicted time. `makeRoom` is this fleet's one anti-crowding rule and its whole
design is that it moves TANGENTIALLY, preserving range exactly, for precisely
that reason. Sailing is the radial motion; a crowd term inside it can only
express itself by bending the radius. So closing on a station ignores other
boats and holding one ignores everything else. Named cost: two boats converging
from different villages may pass through one another on the way, resolved by
`makeRoom` the moment either arrives.

**A residual the arithmetic cannot remove.** The observable separation floor is
`selfRadius + theirRadius − 2 × stepCells`, which goes NEGATIVE for a mover
whose step exceeds its own radius. A pilgrim steps 0.05 against a 0.4-cell gap
(floor 0.3 — bodies genuinely never merge). A small fish steps 0.3 against 0.42,
so two fish closing head-on can pass through each other inside one tick whatever
either picks: at that speed the body is smaller than the distance it teleports.
Separation still measurably shapes where they swim, which is what it is for
here; the only cure for the crossing case is sub-stepping the movement, a
simulation-cost decision nobody has made.

**Monsters now separate too, and it was never as low-impact as "kinds are
singletons" suggested.** Each KIND has one slot, but a HABITAT may hold more
than one kind since the 2026-08-19 per-kind slots: the sea carries the kraken
and Cthulhu at once, both on `OPEN_WATER_PROFILE`, both free to occupy the same
basin — and two seven-cell bodies were swimming straight through one another. A
monster's personal space is `bodyRadiusCells` (half its footprint), the radius
`isLairPose` already uses, rather than a second figure the two rules could
drift apart on. The residual does not bite here: a monster ambles at most 0.6
cells/second, so one tick is 0.06 cells against radii measured in whole cells.

### Decisions made 2026-08-20 (boats fight the kraken; the mechanic settled)

**The arc parked on 2026-08-19 now has its fiction.** That entry withdrew the
kraken's collapse rule and said the mechanic "waits for a fiction: boats fight
the kraken (#43), terrain does not". Settled with the owner 2026-08-20 and
shipped as `plugins/boats`:

- **Villages dispatch; players do not command.** A coastal settlement that has
  survived its first tier-up keeps up to three boats and sends them at any
  kraken within its patrol range. There is deliberately no player verb — you
  fight krakens by growing coastline. A direct reinforcement verb was raised
  and explicitly deferred by the owner to its own card (#49).
- **Combat is attrition.** The kraken sinks one engaged boat every 12 s; each
  engaged boat wounds it 1/s; 54 wounds rout it. Every constant is derived from
  one sentence — *it takes a full fishing fleet, and not one boat less* — and
  the relation between them is pinned by test rather than the values being four
  independent dials.
- **`KRAKEN_ROUT_WOUNDS` is 54 and not 60.** 60 is reached at exactly the
  instant the kraken sinks its second boat, which made the outcome a
  floating-point tie-break between two accumulators. A win condition must never
  coincide with a loss event.
- **A rout goes through `banish`.** Boats emit `boats:defeated`; the monsters
  plugin decides what that means, so a routed kraken gets exactly the
  ten-minute cooldown a drained basin would have given it. This is what the
  2026-08-19 entry meant by keeping the cooldown machinery whole for the arc.
- **`structures` needed no change.** `VILLAGE_MIN_TIER` is 1 and reaching tier 1
  requires an upgrade, so every qualifying settlement already announces itself
  with its tier on structures' existing `changes` event. Coastal-ness is decided
  in the boats plugin (a settlement with no wet 4-neighbour has nowhere to
  launch from) rather than by teaching structures what a coastline is.

**A monster is a body, not a point, when it steers (#45's last finding).**
`protection.ts` had always treated a monster as a disc — a player may not raise
ground within 4.5 cells of the kraken — while `lurk.ts` treated the same animal
as a point, so it was free to swim its own 3.5-cell arm crown into ground that
already existed. The server forbade the world from moving into the monster's
body and permitted the monster to move its body into the world. Fixed at the
predicate (`isLairPose`), not at the three callsites, because the callsites all
asked the only question on offer. Filed under #44 as a render-only graphics
item; it was neither.

### Decisions made 2026-08-21 (rivers split, and are drawn as polylines)

Owner report: rivers "render as square blocks, but we need them path smoothed
so that they render like polylines, and anywhere that a river has multiple
paths, it should follow those multiple paths as well — like a split in the
river." Two defects, one in the math and one in the presentation, fixed
separately because they are separate.

**The math: a river is a set of courses, not a single path.** `traceRiver`
used to move to "the strictly-lowest neighbour, ties broken by
FLOW_DIRECTIONS' scan order" — so on a symmetric slope (exactly what a
player's radially-symmetric brush stroke makes) half the drainage was silently
discarded. It now takes EVERY active 4-neighbour tied for the lowest height
strictly below the current cell: the first continues the course it is on, the
rest are queued as new courses forking from that cell. `fillBasin` does the
same at a pool's rim — it returns every saddle at the spillway height, so a
brimming lake that overflows in two places drains in two places.
`River.points` is therefore replaced by `River.courses`, each an unbroken
polyline in flow order (with `riverPoints(river)` as the flat, derived view
the per-cell consumers — `buildFreshwaterMap`, the world tests — want).

  - **Exact ties only.** Heights are integers, so "equally downhill" is an
    exact, order-free test and both sides fork identically. A tolerance
    ("within N units") would be a tuning knob deciding how braided the whole
    world looks; rejected.
  - **Merges fall out of the same walk.** A branch that flows into a cell this
    river already owns stops there rather than re-tracing it, repeating that
    cell as its last point so the drawn ribbons meet. A branch course likewise
    repeats its junction cell as its FIRST point. Both repeats are geometry,
    not extra water: every per-cell consumer is set-based.
  - **Cost is unchanged.** A junction fans out to at most the four cells
    FLOW_DIRECTIONS names, and every cell a river reaches down any branch is
    claimed, pushed and charged exactly once against the SAME per-river budget
    (`RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize`). Branching spends
    that budget across more courses; it never spends more of it. Branches are
    traced breadth-first in queue order — fixed, and it spends the budget on
    reach rather than on the first branch's full descent.
  - **Waterfalls are deduplicated by cell** (largest drop wins), because two
    courses can now plunge into the same cell and a plunge point is a place,
    not an event. Without this the mana waterfall aura would double-count a
    confluence.

**The presentation: one ribbon per course.** `riverRig.ts` drew one
axis-aligned quad per flowing cell; since a course is a 4-connected cell walk,
every turn was a hard 90° and the result read as a staircase of separate
squares. Each unbroken run of flowing points in a course is now smoothed
(Chaikin corner-cutting, `RIVER_SMOOTHING_PASSES = 2`, endpoints pinned) and
extruded into ONE continuous triangle strip, `FLOW_HALF_WIDTH_CELLS` either
side of the local tangent. A fork is two ribbons that meet at the junction —
which is exactly what the junction-point repeat above is for.

  - **Chaikin, not Catmull-Rom.** An interpolating spline overshoots, putting
    water outside the cells that `freshwater.ts` calls wet. Chaikin's
    approximating cut cannot leave the walk's convex hull.
  - **XZ is smoothed; Y is not.** Height is resampled per sample from the
    band-quantised terrain, so the ribbon steps down the terraces it crosses
    instead of tunnelling through their lips.
  - **Lakes stay a field of full-cell quads.** A pool must tile edge to edge
    with no seam, which a ribbon cannot express; `pushQuad` is the one square
    primitive left, and it also covers the degenerate flowing run of a single
    cell (one point has no direction to extrude along).
    **SUPERSEDED the same day** (issue #62, see "a lake is drawn with the
    terrain's own outline" below): a lake is now marched and smoothed by the
    terrain's own pipeline. `pushQuad` survives only for the single-cell
    flowing run.

**Punts, named:**

  - **A terrace fall gets an explicit vertical curtain** (added the same day,
    after the first screenshots). Joining two samples in different bands
    directly produced a strip that was near-vertical and about a tenth of a
    cell long — effectively coincident with the terrace face it crossed, so it
    vanished inside the terrain and every course rendered as a DASHED line,
    one dash per tread, which is the very "square blocks" this work exists to
    abolish. A fall is now three pieces: the tread carried to the lip, a
    full-width vertical curtain, and the tread resuming below, with the
    curtain nudged `RIVER_FALL_CLEARANCE_WORLD_UNITS` downstream so it stands
    in front of the terrace face rather than inside it — the horizontal twin
    of `RIVER_SURFACE_LIFT_WORLD_UNITS`. Residual, named: seen from straight
    overhead a curtain is still edge-on, so a river down a very steep face
    still reads as treads. Every oblique angle — which is where the camera
    actually sits — shows a connected river.
  - **Overlapping translucent water still double-blends at a junction**, where
    two courses' ribbons cross the same cell. Pre-existing (two springs whose
    courses merged already did this) and unchanged by this work.
**Second round, after the owner looked (2026-08-21).** The dashed courses
above were only the first layer of the same defect, and the owner's report —
"disjointed sections where the river is not painting… I would like it to also
paint down the side of the layer" — sent the investigation to the bottom of
it. What was measured, in order, by raycasting the DRAWN terrain mesh under
the finished ribbon (a debug hook in the preview harness) rather than by
looking:

  1. **The ribbon's geometry was already unbroken.** Rendering the water with
     the terrain hidden showed one continuous strip end to end. Every "gap"
     was therefore terrain drawn OVER the water, not water missing.
  2. **The height rule was wrong, and by a whole band.** The ribbon took its
     height from `quantizeToBand(nearest cell)` — a per-cell block field. The
     terrain is nothing of the sort: it is marching squares over the cell
     lattice, and `crossingFraction` puts a band boundary a QUARTER of a cell
     inside the higher cell, not at the half-way mark. So for a quarter cell
     past every lip the water was a band below the cap it was still crossing,
     drawn inside the hillside. `renderedBandAt` now reproduces the terrain's
     own interpolation — importing `CONTOUR_SAMPLE_CLEARANCE` rather than
     restating it — and the raycast confirms the water sits exactly its own
     lift above the ground at every sample of the course.
  3. **A 2-D form of that rule was tried and rejected.** The clearance is
     defined per lattice edge; a separable (x, then z) extension applies it
     twice on the diagonal and lands a whole band out near a cell corner,
     which put the water UNDER the terrain in exactly the places it was meant
     to fix. A river runs cell centre to cell centre — along lattice edges —
     so the one-dimensional rule along the course is the case that is
     genuinely exact, and the ribbon carries a course parameter through the
     smoothing to use it.
  4. **The ribbon was wider than the channel the terrain draws.** That same
     quarter-cell offset means a one-cell channel renders as a groove only
     HALF a cell across, so a 0.6-cell ribbon had a sixth of its width buried
     under the banks. `FLOW_HALF_WIDTH_CELLS` is now derived from the terrain
     constant instead of chosen.
  5. **What is left is a genuine pinch.** Where a course steps down inside a
     carved channel, the terrain's band outline does not cross the channel
     square-on — it lags at the banks, so for about half a cell past the lip
     the lower terrace exists only along the middle of the channel. The
     ribbon necks in through that stretch (`FALL_TAPER_CELLS`) rather than
     being drawn inside the hillside, and the smoothing's corner cut is
     bounded (`MAX_SMOOTHING_DEVIATION_CELLS`) so a turn cannot walk the
     whole strip out of the channel. **Named residual:** in a one-cell-wide
     slot that turns ninety degrees every few cells — the adversarial
     `meander` fixture, not terrain a player is likely to build — the uphill
     edge is still under the bank for roughly a cell after each fall.
     Reproducing that outline per vertex means re-running marching squares
     for the water; that is the price of removing this last case, and it was
     not paid.

**Visually verified, and what it took.** Unlike the 2026-08-19 entry, this
one was checked with eyes on a running client — twice, and the second look is
what found the dashed-line defect above.

  - **In the live world**, driven over CDP (see the headless-screenshot
    recipe): rivers draw as continuous ribbons following their courses, and a
    probe of the flow mesh confirmed the smoothing is real rather than assumed
    — 89% of its vertices sit off the per-cell quad grid, at sub-cell sample
    spacing.
  - **`client/preview-rivers.html` + `previewRivers.ts`** is new, in the
    established throwaway-harness pattern (`preview-boats.html` and friends).
    It drives the REAL `createTerrainMeshes` and `createRiverRig` over a
    hand-built heightmap. It exists because the live world cannot show these
    two things on demand: its shape is whatever players sculpted, rivers only
    exist where somebody built a hill, and the daynight plugin rewrites the
    lighting rig ten times a second — which a screenshot driver on a ~1 fps
    software-GL page can never outvote, so half the captures came back at
    night. Three fixtures: `fork` (a square cone whose summit ties four ways —
    four courses radiate down four faces, which is the split, drawn),
    `meander` (a channel of hard 90° corners carved into a hillside — draws as
    one continuous ribbon with rounded corners, which is the smoothing,
    drawn), and `terrace` (a staircase, for the fall curtain).
  - **Fixture lessons worth keeping**, since each cost a round trip: a channel
    walled in with one tall constant is a canyon, not a river on a hill (bank
    the channel with a hillside that slopes the same way); a cone that is
    still above SEA_LEVEL at the map border makes its whole outer ring one
    enormous flat basin, which swallows every course; a spring needs its four
    neighbours strictly below it, which walls and ramps both break; and a
    fixture that drops a whole band per cell puts a plunge-pool effect on
    every cell, hiding the very water it is meant to show.

### Decisions made 2026-08-21 (a lake is drawn with the terrain's own outline, issue #62)

Owner report, after the ribbon work above: "the lakes and other areas still
need the edge smoothing". A pool was still a field of full-cell quads — the
one thing the rivers entry above explicitly left as a square — so a lake's
edge was the polyomino boundary of the flooded cells, hard 90° corners and
all, sitting inside a bank the terrain draws as a smooth rounded contour. The
two could never be reconciled by tuning a half-width, because they were not
the same kind of shape.

**Decision: march the lake with the code that marches the ground.**
`appendPoolSurface` (client/src/render/riverRig.ts) runs the exact sequence
`terrain/capEmission.ts` runs per band — `loadSampleField` → `marchLevel` →
`assembleLoops` → `smoothLoop` → `groupLoops`/`bridgeHole`/`earClip` — over
the lake instead of over a chunk. It is the same borrowing
`render/brushPreview.ts` already does for the brush outline, and for the same
reason: one marching-squares implementation, one saddle rule, one Chaikin
pass, so the water and the bank cannot speak different shape languages.

**The field it marches, which is where the shape decision lives:**

  - **The threshold is the floor of the band ABOVE the pool's surface** — the
    height at which the terrain starts drawing ground that stands above this
    water. Everything in the surface's own band is drawn AT that band's floor,
    at or under the waterline, so it belongs to the lake. Marching the real
    heights at a real band boundary means the lake's edge and the foot of the
    riser it meets are the same contour, solved by the same
    `crossingFraction`; they cannot disagree.
  - **Heights are negated**, because a lake is the region BELOW a threshold
    and `marchLevel` traces the region at or above one. This is exact, not an
    approximation: `crossingFraction` pushes both ends
    `CONTOUR_SAMPLE_CLEARANCE` clear of the threshold symmetrically, so the
    crossing solved on the negated pair is algebraically the same point on the
    same lattice edge.
  - **Membership is the flood's, not the heightmap's.** A cell outside
    `fillBasin`'s flooded set is lifted to the threshold plus
    `DRY_CELL_CLEARANCE_HEIGHT_UNITS` however low it really is — the ground
    below the spillway is lower than the lake and is not part of it. One
    height unit, so a cell genuinely at the waterline (the spillway is exactly
    that) is pushed only far enough to be excluded, and the outline still runs
    almost to its centre instead of stopping a cell short of the outflow.

**Tiled in chunk-sized steps.** The marching lattice is a chunk's 17×17 and a
lake is not bounded by one. Tiles share their border samples exactly as
neighbouring chunks do (seam contracts S1–S3) and `smoothLoop` pins border
points (S4), so two tiles' halves of one lake meet with neither gap nor
overlap — the same reason the terrain's caps tile seamlessly. Only tiles whose
lattice actually holds a flooded cell are marched, so cost is proportional to
the water rather than to the span between two unrelated puddles.

**A second, worse bug found on the way: the surface floated.** A pool was
drawn at its raw spill height (`poolHeight × HEIGHT_WORLD_SCALE`) while the
terrain under it is band-quantised like all the rest of the world. Measured in
the `basin` fixture by raycasting the drawn mesh: the floor of a pool at spill
height 109 rendered at **y = 1.5** (band 6's cap, 96 height units) while the
water sat at 109 × HEIGHT_WORLD_SCALE = **y = 1.703** — 0.203 world units, or
**four fifths of a band**, above the ground it was supposed to be resting on. The surface is now
quantised to the band the terrain draws the pool in, which is the same
correction the flowing ribbon already carried (`renderedBandAt`) and the same
plane the outline's threshold is derived from.

**Rejected alternatives:**

  - **A binary in/out field** (the brush preview's rule: membership is
    yes/no, crossing forced to the cell edge). Tried first and visibly wrong —
    it places the waterline half a cell out from every flooded cell regardless
    of where the terrain's riser actually is, so the lake sat inside a ragged
    margin of dry ground instead of meeting its bank. Marching the real
    heights is what makes the two outlines the same curve.
  - **Rounding each pool quad** (keep the tile field, soften its corners).
    Cannot express a shared boundary: adjacent tiles either overlap or leave
    holes, and the outline still would not know where the bank is.
  - **Flooding every cell below the pool surface** rather than only the
    basin's. That is the whole hillside below the spillway; membership has to
    come from `fillBasin`.

**Verified, both ways.** Eyes-on in the `basin` fixture (new — a channel into
a walled bowl with a lobe off its side, so the outline has convex arcs and a
concave neck; its size is bounded by the per-river trace budget, or
`fillBasin` stops mid-lake and leaves a straight budget-shaped cut). And as a
contract test rather than a wiring test — `client/test/poolSurface.test.ts`
asserts the surface covers every flooded cell centre, no dry one (the honesty
guard `CONTOUR_CELL_CENTRE_GUARD` gives), is one flat plane at the height it
was handed, leaves an island uncovered, and PARTITIONS its area across a tile
seam: every sampled point covered at least once and no point strictly inside
two triangles.

**Named residual.** Dry ground whose height is above the water but inside the
water's own band renders at the same band floor — coplanar with the lake, and
not covered by it. That is honest (it is dry land, and the terrain draws it
flat there), but it means a terraced shore gives no relief cue at the
waterline; only the colour change marks where the lake ends.

### Decisions made 2026-08-21 (a fall's curtain is placed on the drawn face, issue #63)

Owner report: "there are also still some step sections that are missing the
water drawing on the vertical edge face". They were not missing. Rendering the
water with the terrain hidden showed one unbroken ribbon, curtains and all —
the third time in this arc that "the water is not drawn" turned out to be "the
water is drawn inside the hill", and the reason the issue's own method note
says to hide the ground before judging anything.

**Root cause: the ribbon located a terrace face with a rule the terrain does
not draw it by.** `renderedBandAt` inverts `crossingFraction` along the
course's lattice edges and is exact about where the band boundary CROSSES —
but the mesh marches the whole 2-D lattice and then runs `smoothLoop` over the
result, which slides the face along the channel. Measured in the `meander`
fixture at the fall between cells (8,4) and (9,4): the unsmoothed crossing is
at **x = 8.40**, the drawn outline crosses the course at **x = 8.51**, and the
curtain — nudged `RIVER_FALL_CLEARANCE_WORLD_UNITS` (a 64th of a cell) past
8.40 — stood a tenth of a cell inside the hillside, behind the very cap it
falls from.

**Decision: read the lip off the outline the mesh builds its skirt from.**
`makeLipLocator` intersects the segment between two ribbon samples with
`chunkContourLoops(mirror, chunk, band floor)` — the same marched-and-smoothed
loops `capEmission.ts` emits caps and skirts from — and takes the crossing
nearest the bisected estimate. Whatever the smoothing did to that face, the
curtain goes with it, for any angle of course against face. The bisected
crossing survives as the FALLBACK when a segment does not cross the outline
inside the chunks it touches, so the geometry is never worse than it was.
Loops are cached per (chunk, threshold) for the life of one rebuild and thrown
away with it, so no cache can outlive the terrain it was read from.

**Rejected: enlarging `RIVER_FALL_CLEARANCE_WORLD_UNITS`** until the curtain
cleared the face. The displacement is whatever Chaikin did to that particular
loop — it is data, not a constant — so any value large enough for the worst
case detaches the water from the lip everywhere else.

**Verified by measurement, not by looking.** Walking the whole `meander`
course at 1/20-cell steps and raycasting the drawn meshes at each: **1280
samples, 0 with the water below the ground, 0 with no water at all.** Before
the change the same walk found the water a band low through every fall's first
tenth of a cell. The preview harness grew the probes that make this possible —
`__previewPickWaterY` (the water's drawn height, the twin of `__previewPickY`)
and `__previewContour` (the terrain's own smoothed band outline).

**Named punt: no unit test for the locator.** A test could only assert that
the lip lands on `chunkContourLoops`' output, which is what the locator reads
— tautological. The honest test is the one that catches the class of bug: a
headless "the ribbon agrees with the mesh" check in the spirit of
`pickAgreesWithMesh.test.ts`, comparing every ribbon vertex against the cap
triangles `chunkCapTriangles` emits. Not written; the in-world measurement
above is what stands behind this change today.

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

### Decisions made 2026-08-21 (picking marches the height field, issue #61)

**The symptom was "the frame rate drops when I pan the map".** The cause was
that picking answered "which cell is under the cursor" by brute-force
ray/triangle intersection against the chunk meshes, so its cost scaled with
TRIANGLES — which the `BAND_HEIGHT` 64 → 16 re-terrace had just quadrupled.
One centre-screen pick measured **29.5 ms across 214,786 triangles**: a whole
60 fps frame budget, spent before anything drew.

It ran every frame of a pan, and that part is not a bug. `hoverTarget`'s cache
key includes the camera pose because the owner asked (2026-08-14) for the brush
outline to track the cursor mid-pan, so a moving camera is a cache miss by
design. Counted in a live world with the pointer held still: 1 pick per 12
frames with the camera still, **11 per 12 while panning**.

**Decision: terrain is a height field, so pick it as one.** The client already
holds the whole authoritative heightmap (`terrain/mirror.ts`, 512 KB at 512²),
and the query has a closed form — walk the cells the ray crosses (Amanatides &
Woo) and stop at the first column it enters at or below the cap of. Cost is
bounded by CELLS CROSSED rather than triangles and, the point of the exercise,
**is independent of band count**, so re-terracing can never make picking slow
again. Measured on the same world and camera: **29.5 ms → 0.0063 ms**.

`plugins/host.ts` held a second, independent mesh raycast for plugin clicks.
Both now go through one `World.pickCell`, so a brush click and a plugin click
cannot disagree about which cell a ray means — before, they merely happened to
agree. Callers keep only the step that genuinely needs Three: unprojecting the
pointer into a world-space ray.

**Why it is exact, not an approximation.** `vertexGrid.ts` already states the
invariant this needs — marching squares classifies a sample as inside iff
`h ≥ k·BAND_HEIGHT`, which is `quantizeToBand`'s own test, and
`CONTOUR_CELL_CENTRE_GUARD` keeps every contour vertex clear of every cell
centre so no amount of Chaikin smoothing can reclassify one. A per-cell column
of height `quantizeToBand(h)` therefore *is* the rendered surface at the only
points picking cares about. Verified rather than argued: **1,600 of 1,600**
straight-down probes on a live world name the same cell as the mesh raycast.

**Clicking a cliff face now sculpts the cliff.** This is a real behaviour
change and it is deliberate. Over 1,000 oblique picks: 738 identical, 211 off
by one — and all 211 are rays that struck a riser. There the old rule was
arbitrary rather than correct: the mesh draws that face on the smoothed
contour, which wanders within the boundary cell, so rounding its hit point to
the nearest cell centre named the cliff 233 times and the ground at its FOOT
the other 8, decided by which side of a centre the contour happened to fall.
The march has no coin to flip — a face belongs to the column behind it. The
remaining 51 differ by more and are all shallow-pitch silhouette grazes (mean
0.23 cells above 35° of pitch, 2.05 below 20°); 70 of those the raycast cannot
answer stably either, since a 1.3-pixel nudge moves its own answer as far.
Ill-conditioned, not mis-picked.

**Rejected.** Skipping the pick during a camera drag contradicts the settled
2026-08-14 decision. Throttling to every Nth frame divides the cost instead of
removing it and makes the outline lag. `three-mesh-bvh` is a new dependency,
still far slower than closed form on a height field, and its BVH would need
rebuilding on every sculpt.

**Named residual, not fixed here.** One `Mesh` per 16×16 chunk means a
fully-revealed 512² world is ~1024 terrain draw calls with no LOD anywhere.
Frustum culling works, so it only bites zoomed out — which is also when players
pan most. It went unmeasured because software rendering in the dev environment
makes GPU cost unmeasurable; it needs its own issue if the pick fix does not
recover the frame rate on real hardware.

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

### Decisions made 2026-08-21 (world rollback — restore points, issue: Genesis overshoot)

**What prompted it.** The owner cast the Genesis relic expecting a modest
terraform and got a world-scale one: the snapshot written immediately after it
changed 11,673 cells (4.45% of a 512² map) with a max single-cell delta of
1,772, against 5–108 cells and deltas of 48–432 for every ordinary player
stroke around it. Recovering meant hand-editing SQLite. That is the gap this
feature closes — not the relic bug itself, which is separate.

1. **Restore points are core, not a plugin.** A restore point IS a snapshot,
   the thing core already writes every `SNAPSHOT_INTERVAL_S` (§3.6). Listing
   one and re-applying it is persistence housekeeping. Nothing attaches a rule,
   a cost or a reward to rolling back, so "nothing gamey in core" (§3.5) holds.
   *Rejected:* a `rollback` plugin — it would need privileged access to the
   snapshot store, the world's private masks and the plugin host's own restore
   path, i.e. everything the plugin boundary exists to withhold.

2. **The gate is a shared secret in the environment (`ROLLBACK_KEY`).** v1 has
   no accounts (§3.7), so the server cannot distinguish the self-hoster from
   anyone holding the invite link, and rolling the world back is the most
   destructive thing it can be asked to do. A chosen key must be at least 8
   characters, is refused at boot below that, is never logged, is compared in
   constant time, and five wrong keys locks that connection out for a minute.

   **AMENDED the same day (owner decision): the feature is ON by default.** An
   unset `ROLLBACK_KEY` now means the built-in `DEFAULT_ROLLBACK_KEY`
   (`terrace`), so a self-hoster can use their own safety net without first
   editing an environment file — which was the point of building it. The cost
   is stated plainly rather than hidden: that key is in the repository, so an
   unconfigured deployment can be rolled back by anyone who can reach it, and
   the server logs a WARNING naming the key on every such boot. `ROLLBACK_KEY=`
   (present but empty) is now the spelling that turns rollback off — absent and
   empty deliberately mean opposite things. The 8-character floor deliberately
   does NOT apply to the built-in default, which is shorter than it: a public
   default that announces itself and a secret someone chose are different kinds
   of thing, and a test pins that inequality so the exemption cannot rot.
   *Rejected:* letting any connected player do it with no key at all (one
   griefer erases everyone's world, and there would be nothing to raise the bar
   with on a server that IS exposed). *Rejected:* loopback-only (breaks LAN
   play and every Docker deployment, which is the canonical self-host path).

3. **A rollback saves the world it is rolling away from, first and
   unconditionally.** A mis-aimed rollback therefore costs a click, not a
   world, and the receipt names the undo point. Deliberately not "if dirty":
   a world that happens to be clean at that instant is exactly the case where
   the newest restore point may already be minutes old.

4. **Nothing is ever deleted.** A rollback appends; the state rolled away from
   ages out under `SNAPSHOT_RETENTION` like any other row.

5. **A rollback replays the boot sequence rather than inventing a second
   restore path.** `World.rewindTo` (terrain, union mask, per-token masks) then
   `host.restorePersistence` then `host.worldCreate` — the same two calls, in
   the same order, that `index.ts` makes at boot. It has to be both: flora,
   structures and chronicle stage their slice in `load` and consume it in
   `onWorldCreate`. This makes re-runnability a contract on `PersistenceSlice`
   (stated there): both calls must REPLACE a plugin's state, never add to it.
   Every plugin in the repo was checked against it on 2026-08-21 and each one
   already resets.
   *Rejected:* restarting the process — there is no supervisor guaranteed to
   bring it back (`run_server.py` restarts on file change, not on exit).

6. **Clients learn about it as a plain `snapshot`.** No new "you were rolled
   back" message: the client's `onSnapshot` was already the rejoin path and
   already resets mirror, meshes, fog, water and rivers wholesale. Sent
   per-token, after the plugin replay, so nobody re-renders rewound ground
   while the plugins still hold post-rollback forests and villages.

7. **The list shows how far the world moved, not just when.** Each restore
   point carries `cellsChanged` and `maxCellDelta` against its predecessor, and
   the panel flags rows above 8× the history's MEDIAN (median, not mean — the
   one big event would otherwise raise the bar it has to clear). Timestamps
   alone are useless here: the two snapshots either side of the Genesis cast
   are one minute apart and look identical in a list of times.

8. **Two surfaces, one implementation.** The in-game panel (bottom-right
   button, beside the chart and the gear) and `pnpm --dir server rollback`
   both go through `SnapshotStore`. The CLI exists because the cases that most
   need a rollback are the ones where the server or client will not run; it
   appends the chosen snapshot as the newest and lets an ordinary boot restore
   it, so it needs no terrain math at all.

9. **`SNAPSHOT_RETENTION` is now configurable (default unchanged at 10).** The
   Q4 decision stands as the default; what changed is that the history is now
   something a self-hoster can see and use, so its depth is theirs to set. The
   ceiling of 100 is set by the listing cost, not the disk: listing decodes and
   compares every retained heightmap. **At the default, the safety net is only
   ten minutes deep** — raise it if you want longer.

### Decisions made 2026-08-21 (whales pod, in mixed sizes — owner request)

**What prompted it.** Three sentences from the owner, after the three whale
bodies shipped: "Drop the number of unlocked cells required. Also add the
ability to spawn different size whales and allow them to school like whales in
real life with different sizes." The first is the day-one-whales problem this
file has been carrying as an accepted loss since 2026-08-19; the other two are
new capability for the species that had neither.

1. **Whale density 5 000 → 2 000 square world units per individual.** A fresh
   world's starter square holds 4 096 square units of open sea, so the old
   figure asked for zero whales and the new one asks for two. The number is not
   lower still because the same density decides a fully revealed world: at
   2 000 a nominal 512² asks for 39 whales against deep-sea's 52, and whales
   stay the rarest species; at the 1 365 that would fit a whole three-whale pod
   on day one they would be the second most common animal in the game. Day-one
   completeness lost to late-game shape, deliberately — the third pod member
   arrives with one small territory expansion. *Rejected:* growing the starter
   square back (it shrank for reveal-pacing reasons that have nothing to do
   with whales), and raising `WILDLIFE_POPULATION_CAP` (it is a bandwidth
   budget, not a tuning dial — see the 2026-08-14 entry).

2. **A whale group is a POD: three, mixed.** `groupSize` 1 → `WHALE_POD_SIZE`
   (3), the smallest group that reads as a family rather than as a pair that
   happened to meet. Sizes are `WHALE_SIZE_WEIGHTS` 3 : 5 : 2 calf : adult :
   bull — the opposite shape to a fish shoal, where the many are the small.

3. **Group size is drawn per member for whales, per group for fish** — the new
   `sizeDraw` field on `SpeciesProfile`. A shoal is size-graded (real ones sort
   themselves, and this is what fish shipped with); a pod is a family with a
   calf in it. Drawing one class for a whole pod would have made every pod
   uniform, which is the one thing a pod never is. The group still has ONE
   class for its school character, and for a mixed group that is its LARGEST
   member: three whales travelling with a bull are a bull's pod.

4. **Schooling probability moved onto the species profile.** It was a global
   table keyed by size class alone — 0.9 / 0.5 / 0.1 small to large — and those
   three numbers are *fish* ecology ("the small ones shoal, the big ones
   don't"). A pod obeys the opposite rule, so keying by size alone would have
   handed whales the solitary large-fish probability and quietly undone the
   pod. `WHALE_SCHOOLING_PROBABILITY_BY_SIZE` is 1 / 1 / 0.75: a pod holds
   together whatever is in it, and the lone full-grown bull is the one real
   exception.

5. **School spacing now scales with the species' body length.**
   `SCHOOL_COMFORT_RADIUS_CELLS` (2.5) and `SCHOOL_FULL_PULL_RADIUS_CELLS` (5)
   are absolute distances calibrated when the only schooling species was a
   0.7-unit fish. Separation (half a body length, per creature) and cohesion
   have always acted on disjoint distance ranges *because* the fish is small;
   put a five-unit whale on fish radii and its comfort distance sits inside its
   own personal space, with cohesion pulling in and separation pushing out for
   the first time in this plugin's life. `schoolLoosenessOf` multiplies the
   size-class looseness by the species' body length over the fish's, so the two
   terms scale together for any size of animal. The baseline is taken FROM the
   fish profile, so the fish's own multiplier is exactly 1 and the retune cannot
   move the one school those constants were ever measured against.

6. **Swim clearances scale with the size class** (`swimmerWorldY` takes the
   model scale as a REQUIRED argument). A clearance is the model's own
   half-height plus a little water, and the class scales the model but was
   scaling nothing in placement. CORRECTED 2026-08-22: this item originally
   blamed the fish, computing its half-height from `ellipsoid()`'s full height
   argument — 1.4 × 0.26 = 0.36 world units tall against a 0.3 minimum
   submergence, with `protocol.ts` calling 0.36 "comfortably inside" 0.3 — but
   `ellipsoid()` takes FULL extents, a fish's half-height is 0.13, and
   1.4 × 0.13 = 0.182 really is comfortably inside: there was never a fish bug.
   The conclusion stands on the whale instead: `WHALE_ENVELOPE`
   (whaleSpecies.ts) is a true half-extent envelope, and at the large class its
   crown reaches 1.4 × 0.670 = 0.938 and its belly 1.4 × 0.575 = 0.805 below
   the origin, against the whale profile's 0.7 minimum submergence and 0.7
   minimum clearance — unscaled, a bull's belly would have sat 0.1 units into
   the seabed and its dorsal 0.24 above the waterline. Required rather than
   defaulted because a default is exactly how the caller forgets.

**Day one and full reveal, restated against the code:**

| species | density (sq. world units) | day one (4 096 deep / 2 304 shallow) | full 512², capped |
|---|---|---|---|
| fish | 400 shallow | 5 (one school) | 72 |
| deep-sea | 1 500 deep | 2 | 28 |
| whale | 2 000 deep | **2** (a partial pod) | **21** |
| grazer | 2 700 land | 0 (no land yet) | 26 |

A fully revealed world now asks for 270 and the cap scales it to 147. Whales
cost more of that cap than they did (21 against 9) and every other species is
~9% smaller for it — accepted, because a pod is three whales by definition and
a world with room for only nine could hold three pods in total and would read
as a world of lone whales.

### Decisions made 2026-08-22 (the yeti shrinks to a quarter — owner request)

- **The yeti is a QUARTER of the size he was, and everything derived from his
  size goes with him** (owner request: "make the Yeti about 25% of its current
  size", and, asked how far the shrink should reach, "shrink gameplay too" and
  "slow his walk speed too").

  **One number owns it.** `YETI_SCALE = 0.25` in `client/yeti-anatomy.ts`, and
  every LENGTH in that file is written at its original full-size figure and
  passed through a local `scaled()`. The silhouette record therefore still reads
  in the proportions its prose argues for — 6.3 tall, 5 across, a hip at 39% of
  his height, hands below them — and the animal that comes out is 1.575 by 1.25
  world units. The amendment is the multiplier, not two hundred rewritten
  literals, which is what makes it reversible and what makes the next rescale a
  one-line change.

  **What does NOT pass through it, and why each is right.** Angles and fractions
  (the swings, the ~3° lean, the head scan, the eye bulge, the tuft variation,
  the ±22% shade mottle) are dimensionless — a scaled model turns through the
  same angles. The two spatial frequencies divide by it instead, so the same
  NUMBER of wrinkles crosses a body a quarter the size; because the carve is
  sampled at position × frequency, scaling the pair inversely reproduces the old
  surface EXACTLY, four times smaller. `YETI_AMBLE_HZ` and
  `YETI_LEG_SWING_RADIANS` are ratios of scaled quantities (speed over stride,
  stride over leg) and fall out unchanged on their own — which is the whole
  reason the gait survives this untouched.

  **The walk speed is cut with him**, 0.45 → 0.1125 cells/s, because a speed is
  a LENGTH per second: a quarter-size animal holding the old speed crosses its
  own body four times as fast as it used to, which is scurrying. What justified
  0.45 in the first place survives the cut and is now what the test pins — he
  covers his own width in the same eleven seconds, and is still under a third of
  a wildlife grazer, so he cannot read as livestock. What does NOT survive is
  the comparison to the two sea kinds' absolute speeds (Cthulhu's 0.25 brood,
  the kraken's 0.6 hunt): they are four to nine times his size now, so the
  faster one is merely the one with longer legs.

  **His country shrinks by the square.** `YETI_FOOTPRINT_CELLS` drops to 1.25
  world units, and the minimum lair — 2 730 cells — is now WRITTEN as the
  argument that always justified it rather than as a chunk count that happened
  to equal it: 4.5 body-widths across, squared, cut by the 2026-08-19
  reachability third. That formula reproduces the old number to within 1% at his
  old size (2 700 against 2 730) and, unlike a chunk count, follows the animal.
  At the new size it is **168 cells**, a ~13×13 patch, with collapse at 42. The
  consequence is deliberate and was put to the owner in those words: a yeti no
  longer costs a mega-project, and "a fresh world cannot host him" now means a
  modest hilltop rather than a couple of hundred level-fill strokes. He is no
  longer the biggest thing on the mountain and no longer asks for a mountain.

- **The model's tessellation is raised across the board** (same request: "smooth
  out the model a little bit by increasing its fidelity"). The yeti carried the
  LOWEST base counts of the three creatures and it showed on exactly the parts
  that carry this silhouette: two radial segments made an OCTAGONAL leg at
  `MONSTER_MODEL_DETAIL = 4`. The counts are raised per part by what its shape
  has to hold — radial segments for the swept limbs and the ruff tufts, both
  axes for the round masses, and the tufts' path count left alone because a
  straight taper buys nothing from rings along it. **15 600 triangles against
  6 024**, still under Cthulhu's 18 664 and affordable because
  `MAX_LIVING_MONSTERS` is 1.

  It is NOT compensation for the rescale, and the note in the file says so: a
  quarter-size model covers a sixteenth of the screen and would have needed
  fewer triangles, not more. The faceting was there at full size too. The global
  `MONSTER_MODEL_DETAIL` knob was deliberately left alone — it is one number for
  the whole plugin by design, and this was one creature's problem.

- **Two tests changed their basis rather than their numbers**, which is the part
  worth recording. The carve comparison ("he wears fur, not skin") compared
  ABSOLUTE wrinkle depths across three animals; at a quarter size that reads the
  opposite of the truth, so it now compares depth as a FRACTION of each
  creature's own height — the comparison it always meant. The amble test pinned
  an absolute 0.45 and would have passed unchanged through this rescale while
  the animal it described started scurrying; it now pins seconds per body-width.

### Decisions made 2026-08-22 (the walkers were probing a quarter of their feet)

- **Two walker footprints were stated in world units, named in cells, and
  consumed as cells** — `YETI_FOOT_GROUND_HALF_EXTENT_CELLS` (monsters) and
  `WALKER_FOOTPRINT_HALF_EXTENT_CELLS` (wildlife). Both are model dimensions,
  and a model dimension has been WORLD UNITS since the 2026-08-21 re-sample cut
  a cell to a quarter of one; both were handed straight to a function that adds
  them to a CELL coordinate. Every walker in the game therefore probed a quarter
  of the ground it stands on, and could stand a band below a riser its own body
  overhung — which is precisely the clipping bug `walkerGroundY` was written to
  prevent, reintroduced underneath it by a units change three months later.

  **Root cause, in one sentence that names no callsite:** a distance crossing
  the model↔board boundary skipped `cellsAcross`, the one conversion every
  physical distance in this codebase is supposed to go through, and its NAME
  asserted the wrong side of that boundary — so the value was wrong and the
  compiler, the reviewer and the tests all read it as right.

  **Fixed at the boundary, not at the callsites.** Each constant is renamed to
  drop the `_CELLS` it never earned and states world units; the single place it
  meets cell space converts once. The names now disagree loudly with a misuse
  instead of endorsing it.

  **The tests were part of the failure, so they changed shape.** Both plugins'
  fixtures pinned an OUTCOME on a hand-written height field, and both passed
  with the wrong number — the yeti's because 1.02 still reached the neighbouring
  cell, wildlife's because its "well clear of the boundary" case was only clear
  of a footprint a quarter of the true size (it moves from x = 9.0 to x = 8.0,
  and the move IS the bug). Each plugin now also pins the CONVERSION itself, and
  that the half-extent exceeds one cell — a walker that does not overhang its
  own cell is not a walker whose footprint needs sampling.

  **Found by the yeti rescale**, which is worth recording: at quarter size his
  wrong half-extent stopped reaching any cell but his own and the fixture
  finally failed. A four-times-too-small probe is invisible until the thing it
  measures gets small enough that a quarter of it is nothing.

  **Not changed:** the two plugins sample different extents on purpose — the
  yeti samples his FEET (a walker stands on what it steps on; his shoulders
  overhang bands his soles never touch), wildlife samples just inside the BODY.
  Both are stated in their own files and both are defensible; unifying them is a
  design decision, not a units fix. Nor does wildlife's half-extent scale with
  `WILDLIFE_SIZE_MODEL_SCALE`, so a large creature (1.4×) still probes a medium
  one's footprint — noted, not fixed, and the residual is one band of clipping
  on the biggest land animals at a riser's edge.


### Decisions made 2026-08-24 (overhangs, arches and caves — the column becomes a list of spans)

**The problem, in one sentence: a column stores one height, so no cell can be
empty below and solid above.** Everything an overhang, an arch or a cave is
depends on exactly that shape. `picking.ts` states the consequence outright —
"the column is treated as SOLID from its cap downward" — and that sentence, not
the renderer, is the whole obstacle. Raised by the owner (2026-08-24) after
trying to pull one layer out from under another with the Pull tool (#99) and
getting the levels below dragged out with it: the tool was not misbehaving, the
terrain model has no way to express what was being asked for.

**The renderer is already a stack of level sets, and that is what makes this
tractable.** `capEmission.ts` builds a chunk by looping bands, marching squares
over the set `{h ≥ k·BAND_HEIGHT}`, triangulating each contour loop into a cap
and extruding skirts down its edges. It never asks "what is the height here" in
order to make geometry — it asks **"is this cell solid at band k?"** That
question generalises to overhangs without the contour, smoothing or
triangulation machinery changing at all. The change is in what a COLUMN is, not
in how terrain is drawn.

#### The model: a layered heightfield

Each cell holds a short list of solid spans `[floor, ceiling)` instead of a
single height.

| Feature  | What it is in this model |
| -------- | ------------------------ |
| Overhang | a span whose floor is above its neighbour's ceiling |
| Arch     | a column with two spans; the gap between them is the opening |
| Cave     | a connected region of gaps between spans |
| Today    | every cell has exactly one span, `[MIN_HEIGHT, h)` |

That last row is the load-bearing one: **the world as it stands is a strict
special case of the new model**, so this is a widening rather than a
replacement, and it can be introduced with the one-span invariant held and
nothing changing on screen.

**What the renderer needs on top of what it already has: ceiling caps.** Every
cap today faces up. An overhang needs its underside drawn — the same
marching-squares pass, over "which cells have a span ENDING at band k", with
reversed winding and lit from below. That is most of the render work, and it is
new geometry rather than a new pipeline.

#### Rejected alternatives

- **Sparse voxels / marching cubes.** Fully general, and wrong here. Every
  module in `shared/` is 2D-indexed; the terraced band look is the game's visual
  identity and a voxel surface fights it; the wire format and the determinism
  contract (§3.1, §3.3) both get rebuilt from scratch. It buys topology nobody
  has asked for — floating islands, closed bubbles — at the cost of the parts of
  the codebase that currently work.
- **Signed distance field / dual contouring.** The best-looking caves, and the
  furthest from this game. It produces smooth organic surfaces, which is the
  opposite of the terracing that `bandColors`, the water renderer, the brush
  preview and the layer-edge overlay are all built around.
- **Keep the heightmap; add authored overhang props.** Arches and cave mouths as
  placed models with their own collision, terrain untouched. Genuinely the
  cheapest path and what many shipped games do. Rejected as the primary model
  because caves would become rooms entered through a portal rather than
  structure the sculpt tools can carve — but it remains the right answer if the
  goal ever narrows to visual variety alone.

#### Blast radius, measured rather than estimated

38 non-test modules read heights, which sounds fatal and is not: raw `cells[]`
access is concentrated in six files.

| File | direct `cells[]` accesses |
| ---- | ------------------------- |
| `shared/heightmap.ts` | 17 (it owns the type) |
| `client/terrain/mirror.ts` | 9 |
| `shared/rivers.ts` | 5 |
| `shared/chunks.ts`, `server/world/world.ts`, `client/render/brushPreview.ts` | 5 combined |

Everything else goes through `heightAt`/`sampleHeight`. **If those keep meaning
"the top of the topmost span" — the walkable surface — then rivers, pathing,
farmland, traversal, steering, flora, boats, water and fog keep working
untouched**, because the walkable surface stays well defined. The modules that
genuinely must change are the mesh builder, picking, the sculpt math and the
wire format.

#### What gets harder, stated plainly rather than discovered later

- **Picking.** The march must return WHICH SPAN the ray hit, because a ray can
  now enter a cave mouth and strike a floor beneath a ceiling. Structurally it
  is the same loop with a span test instead of a cap test, but every consumer of
  `TerrainRayPick` inherits a new question — which layer did I click? — and the
  sculpt tools all have to answer it.
- **The wire.** `ChunkPayload.heights: number[]` becomes variable-length per
  cell. Determinism survives (still integers, still fixed iteration order), but
  the encoding, the terrain diff and the prediction store's cell-indexed journal
  all assume one value per cell today.
- **Sculpting.** Every tool currently means "move the surface". With spans, each
  has to say which span it moves, and what happens when two merge or one splits.
  That is a design pass per tool, not a mechanical port — and it is deliberately
  NOT part of the first stages below.
- **Water, fog, rivers.** They ask for the height and get the topmost surface,
  which is right for them — until someone wants water inside a cave. Out of
  scope; noted so it is not mistaken for an oversight.

#### The staging (decided): render first, sculpt much later

The owner's ask was explicitly "not to build those things, but to be able to
render them at least", and the staging follows that literally. Each step is
independently verifiable, and the first two change nothing a player can see.

1. **Widen the type to spans, with an invariant that every cell has exactly
   one.** Nothing changes on screen and nothing else moves. Verified by the
   world rendering identically.
2. **Add ceiling caps to the mesh builder and span-aware picking, invariant
   still held.** Still nothing changes on screen — the ceiling pass has nothing
   to draw while every column is one span.
3. **Lift the invariant and hand-author a test chunk containing an arch.** This
   is the step that answers the real question: whether the terraced look, the
   band palette and the lighting hold up with a ceiling in the world. Nothing is
   sculptable yet.
4. **Only then decide what sculpting a second span means**, informed by
   something on screen rather than in the abstract.

   AMENDED 2026-08-27 (issue #224): the first of those decisions is made — see
   "Decisions made 2026-08-27 (a pulled band overhangs a carve; it never fills
   it)" at the end of this file, which overturns the drag's D4 "fill the
   opening" rule.

**Steps 1–3 are the answer to "render them at least."** Step 3 is the decision
point: if the aesthetic does not survive a ceiling, the authored-props
alternative above is the fallback and steps 1–2 are still worth having.

#### Invariants this must not break

- `shared/` stays the single source of truth for terrain math, and stays
  deterministic integer-only with fixed iteration order (§3.3). Spans are
  integers; nothing here needs floating point.
- Clients still send intents, never heights (§3.2). A span-aware sculpt names
  which span it means; the server re-derives what that span is.
- The unlocked-region mask still works by omission (§3.4) — a chunk not sent is
  still a chunk not sent, whatever a column contains.
- `heightAt` keeps meaning the walkable surface, which is what makes the blast
  radius above true. Any change to that meaning invalidates the estimate.

Tracked as #129 (this work), which supersedes #110 (overhangs) in scope.

### Decisions made 2026-08-24 (fire — things burn, owner request)

Owner: "I want the ability to set trees on fire. In fact, I want the ability to
set a lot of things on fire," plus a specific mechanic — lightning strikes a
tree, the tree burns, and nearby trees catch from it.

**Fire is its own plugin, and it knows nothing about trees.** The alternative
considered and rejected was a burn flag on flora: "a lot of things" means
crops, buildings and whatever comes next, and a flora-owned mechanic would be
copied into structures within a week, at which point two spread models exist
and disagree.

**The dependency is INVERTED relative to every other cross-plugin link here.**
`fire` publishes `registerFuel`; each flammable plugin bridges to `fire` and
declares what it owns, how long it burns and how tall it is
(`plugins/fire/server/fuel.ts`). The established pattern — a bridge per sibling
(`relics → mana`, `flora → structures`) — would mean a file and an edit inside
`fire` for every burnable thing ever added. Registering inward means `fire`
never changes. The cost, stated: a registration is a WRITE, so bridge rule 3
("buffer, don't drop") lands on the registrant, which is one slot's worth of
care in each registrant instead of a bridge here per registrant.

The one thing `fire` DOES bridge out to is weather (`currentWind`,
`precipitationAt`), because wind and rain are one fact from one named plugin
and there will never be a second source of either.

**A fire's whole state is its age.** No stage union, no per-stage timer:
fierceness is `fireIntensity(age, burn)` and burnout is `age >= burn`, computed
identically on both sides of the wire (`plugins/fire/protocol.ts`). So a fire
is SENT ONCE — cell, fuel height, age at send, total burn — and the client runs
it forward with its own clock, which is what lets a 400-cell wildfire animate
on a delta stream costing under a kbit/s. The 10 s keepalive is deliberately
shorter than the shortest fuel's burn: a repair cadence longer than the thing it
repairs never repairs anything.

**A WALKING fire's repair cadence is derived, not chosen** (2026-08-24, after
review). The 10 s constant above is a number picked against the fuels that
existed when it was written, and entity fuel broke it silently: a creature burns
for 8 s, so its one repair was scheduled for after it was dead. A cell fire can
be repaired by event — its visibility only changes when the PLAYER's view does,
which the server is told about — but a walking fire's visibility changes because
it walked, and nothing announces that. So the entity set is re-sent on a cadence
computed from the shortest burn currently alight
(`ENTITY_REPAIRS_PER_BURN`), and any future plugin's shorter-lived fuel gets a
faster repair without anyone remembering to retune a constant.

**A fire ends in one of three ways, and only one consumes the fuel.** Burned out
(the source destroys what was there), extinguished (rain, or the ground dug from
under it — the tree survives, scorched), cleared (rollback; nobody is told).
Collapsing the first two was the obvious simplification and it is wrong: it
makes "we saved the forest" and "the forest burned down" the same message.

**Spread is one rate and five multipliers** — intensity, wind, slope, diagonal,
wet (`plugins/fire/server/spread.ts`). Only the FRONT spreads
(`SPREAD_MIN_INTENSITY`), so a burn is a ring rather than a filled disc. Fire
runs uphill at 1.6× per terrace band, which is the term that makes the world's
own geometry the mechanic.

**The firebreak is not a feature.** A cell with no registered fuel simply fails
to ignite, so water, bare rock, a ploughed field and a dug trench all stop a
fire through one code path. Digging under a live fire puts it out on the same
diff that fells the tree.

**Lightning moved to the server** (`plugins/weather/server/lightning.ts`). Every
bolt used to be a client decision — each rig ran its own `LightningSchedule` on
its own RNG — which was right while lightning was decoration and became wrong
the moment a bolt could start a fire: a fire authorised under a bolt drawn
elsewhere is a wood alight under clear sky. The server now rolls strikes per
storm, aims at the tallest of six samples under it, broadcasts the cell for
clients to draw and emits it for `fire` to roll ignition against
(`LIGHTNING_IGNITION_CHANCE` 0.35, which lands at roughly one fire per three
storms crossing woodland). `LightningSchedule` keeps the flash curve and the
photosensitivity governor and gives up choosing when; a refused flash is still
DROPPED, never deferred, and reduced motion drops the bolt at the door while the
server's fire burns either way.

**Dry lightning, and what "exposed" means** (owner, 2026-08-24: "I would like it
to randomly fire even without a storm, and it needs to do so over exposed
land"). A world-wide Poisson process independent of any weather system, one bolt
every ~4 minutes, aimed at the most EXPOSED of 24 sampled cells — where exposure
is `height + 2 × prominence` and prominence is the cell's height minus the mean
of four samples one world unit out. Height alone picks the middle of the highest
plateau; prominence alone picks a one-cell pimple in a valley. Measured on a test
world whose ridge is 6% of its area: the ridge takes 74% of dry strikes, the
surrounding plateau 26%, low ground and sea none.

It carries `STRIKE_NO_SYSTEM` (0) as its system id, and the client draws it with
a single loose bolt rig positioned in world space rather than as an offset inside
a storm's rig — the same path now also covers a strike from a system the client
does not know about, which previously drew nothing at all.

**Lighting a fire is a plugin message, not a sculpt intent** — it moves no
ground and the client predicts nothing about it. Gated on the player's own
unlocked view; every reason it could fail is checked BEFORE the mana debit, so
there is no refund path to get wrong. `mana` gained `spendMana(world, playerId,
amount)`: the ledger takes an amount and never an opinion about what things
cost.

**The chronicle gets one line per WILDFIRE, not per tree.** `fire` accumulates
an episode — cells consumed since the world last stopped burning — and emits
`fire:burned` once, when the last fire goes out.

**The look is TWO of the four candidates, crossfaded by intensity** (owner,
2026-08-24; `plugins/fire/client/flames/ribbonsToPlume.ts`). The order asked for
was plume → ribbons; the renders inverted it, for a geometric reason worth
recording because it will recur for any future flame:

> A plume is a column standing at the tree's centre, and a crown is opaque. Its
> height is 1.4× the fuel's, scaled by intensity, so below intensity ≈0.56 the
> whole flame is shorter than the tree it stands in and is depth-culled by it. A
> catching fire drawn as a plume rendered as NOTHING.

Widening, brightening and raising its height floor were each tried and
photographed; they give a translucent smear over the crown or a wisp at its tip.
So the ribbons — which wrap the trunk and pool on the ground, outside the crown's
silhouette — own the low end, and the plume takes over at 0.55, exactly the
intensity at which its column starts to clear the tree. The handover is an
EQUAL-POWER crossfade (√share, not share): two looks at 0.5 opacity read as two
ghosts, because what must stay constant through a handover is energy, not sum.

**The LOOK is behind an interface** (`plugins/fire/client/flames/types.ts`)
because it is chosen from pictures and the sim had to ship first. Four
candidates were authored and rendered for selection; the budget rules any
candidate must keep are in that file's header — fixed small draw-call count
whatever the fire count, no external assets, no per-fire lights, allocation-free
steady state. Firelight is a fixed pool of four PointLights that move between
the fiercest fires, because adding or removing a light invalidates every
material's shader program.

### Decisions made 2026-08-24 (fire that walks — owner request)

Owner, after the first in-world session with fire: "We also need the ability to
set buildings, boats, grazers, peeps on fire. If it's on land, I should be able
to burn it," and — asked what a burning creature does, since fire is anchored to
a cell and a creature is not — "They catch fire and continued to burn until they
dropped dead."

**A building is cell fuel; anything that moves is not.** structures registers
into the existing `registerFuel` and nothing new was needed. A creature broke
the cell model in three places at once: its fire has to ask where it is every
tick, it must survive the thing being removed by something else entirely (an
animal dies of old age mid-burn), and what it consumes at the end is an
individual rather than a patch of ground. Bolting those onto `CellFuel` would
make every static source implement callbacks it can never use, so `fire` gained
a SECOND registry and a second burning set (`entityFuel.ts`, `entityBlaze.ts`)
sharing one clock, one intensity curve and one flame. A cell fire and a walking
fire look identical because they are the same fire; only where the position
comes from differs.

**The position is not on the wire, and that is the load-bearing decision.** The
plugin that owns the creature is already drawing it, interpolated its own way,
sixty times a second. Sending a position from the server would mean two
independent interpolations of one animal, and the flame would slide off the body
— the same defect as a river modelled beside its own valley instead of from it.
So the flame is drawn at the pose the OWNER publishes.

**That needed a client-side cross-plugin seam, which this repo had none of.**
Three options were put to the owner: a neutral primitive in core; `fire`
publishing a client registry that registrants import; or streaming positions and
interpolating them twice. The owner chose the neutral primitive, and it is the
one consistent with §"World events" ("cross-plugin agreement travels as
documented copies... never by import"): `ClientPluginCtx.publishMovers` /
`moverPose`, addressed BY PLUGIN NAME exactly as `WorldApi.emitEvent` is. Core
knows nothing about what is being drawn or why — it holds one lookup per plugin
and hands it to whoever asks.

**A boat needed no special case in the end.** It is the only flammable thing not
standing on the ground, and a "how far above the ground does this flame sit"
field was approved for the cell wire before it turned out to be unnecessary: an
entity flame sits at its owner's published pose, and boats draw hulls at the
waterline. The deck is where the fire lands, by construction.

**Aiming was the other half of the same request.** `pickTerrainCell` raycasts
the terrain surface only, so a tree's canopy — drawn above its own cell — sent
the ray past it onto ground several cells behind; torching a wood was luck.
`pickWorldCell` asks the declared objects first (`markPickable`, opt-in per
plugin so weather's sky dome and the frontier fog are never aimed at) and falls
back to the terrain. The torch — now labelled **Pyro** — uses it for both the
hover ring and the click, so the ring cannot promise a cell the click would not
light.

**Burn times, and what they are relative to.** A crop flashes in 4 s, a creature
or a peep dies in 8, a tree takes 22, a boat 16, a building 30. Creatures are
the shortest of the solid things on purpose: a creature on fire is a death, not
a bonfire, and the number is how long the player watches it run before it drops.
Peeps are deliberately NOT tuned apart from grazers — same size, same sort of
thing, and a player who has learned one has learned the other.

**What a fire does NOT do yet, named rather than discovered later:** a burning
creature does not set light to what it runs through. The machinery is all there
(`EntityBlaze.positions()` exists for exactly this), and it was left out of the
first cut because a panicking animal towing a spread front through a forest is a
balance question, not a plumbing one.

### Decisions made 2026-08-24 (fire review — owner: "fix every fire bug")

A multi-agent adversarial review of the whole fire implementation confirmed 12
defects. Three of them were one defect wearing different clothes, and the fixes
below are stated at the level the review put them, not at the callsites.

**A cell-addressed ignite resolves to the NEAREST candidate, across every
source.** `EntityFuelSource.entityAt` used to license "the first one it finds",
which is sound only while every source answers for exactly the cell that was
aimed at. Sources do not agree on that — a creature answers for half a cell, a
boat for two — so `entityAt` now returns the distance with the id and
`entityFuelAt` takes the global minimum. That fixes both halves of the same
hole: the torch that lit the boat beside the one the player clicked, and the
plugin FOLDER NAME deciding whether a berthed boat or the settler standing on
the cell caught. The reach itself stays each plugin's own decision; only the
arbitration is shared (`nearestWithinReach` in `shared/`).

**Anything that remembers a fire between frames holds its key, never the
instance.** The drawn list is rebuilt every frame, so a held instance object is
a snapshot of a fire as it was — which is why a fire's light lagged a fleeing
animal by over a world unit and went on lighting ground where a fire had already
been put out. `FireInstance.key` exists for this and nothing else.

**A plugin that publishes poses draws before the plugins that read them.** Frame
callbacks now run in two declared phases and the HOST assigns them: calling
`publishMovers` puts that plugin in the pose phase. The guarantee used to rest
on the order of an array in `registry.ts`.

**An id only means the same individual after a restore if its owner says so.**
`EntityFuelSource.idsSurviveRestore` — absent means no. Existence
(`positionOf(id) !== null`) cannot answer a question about identity, and a
rollback across a restart used to re-attach a fire to whoever now held that
number and kill them. Boats and wildlife persist their id spaces and declare it;
pilgrims deliberately do not.

**An episode closes where the burning set empties, not where the tick looks.**
Digging a firebreak through the last burning cell empties the set from outside
`onTick`, and the tick that followed took its quiet-world early-out above the
end-of-episode check — so beating a fire, the headline mechanic, was the one
ending that never got its chronicle line, and the next wildfire's cells were
added to the abandoned count.

**Banked time is carried, never clamped away.** The spread accumulator clamped
to one interval before testing against that same interval and then reset to
zero, so at any tick rate whose period does not sum exactly (the shipped 10 Hz
included) every step threw away its remainder: fires spread ~10% slower than
their stated rates, and by an amount that depended on `TICK_HZ`. Fixing it
shifts the shipped feel by about that much, accepted by the owner as the price
of the rates meaning what they say.

### Decisions made 2026-08-25 (fire spreads to everything)

Owner: *"fire should spread across wheat, grass, boats, buildings — anything
that gets close enough to another fire should catch fire."*

**Spread is a question about distance, not about registries.** `spreadOnce`
used to read `blaze.fires()` and light cells through `blaze.ignite`, so both
ends of every spread were cells. Fire therefore could not cross between the two
fuel registries in either direction — a wildfire burned up to a moored boat and
stopped, a burning boat sat in a reed bed and lit nothing, and a boat alight
beside its neighbour left that neighbour untouched. Nothing about a flame
justified any of it; what decided it was which registry the owning plugin
happened to register in. A step now takes SOURCES (everything alight, cell or
individual) and TARGETS (everything flammable in reach, cell or individual) and
applies the same one product to all four combinations.

**`spreadRate` is keyed on a fractional offset.** The flat 1/√2 diagonal factor
is gone, replaced by `1/d` floored at one cell (`SPREAD_MIN_DISTANCE_CELLS`),
which is the same number wherever the old one applied — 1 cardinally, 1/√2 at a
corner — and is defined for a boat standing at (12.4, 9.9). `SPREAD_REACH_CELLS`
is √2, the corner distance of the eight-neighbourhood the file always used, so
cell-to-cell spread is unchanged *by construction* rather than by assertion.
Verified: a cardinal step is still exactly `BASE_SPREAD_RATE_PER_SECOND`.

**`EntityFuelSource.flammable()` is a second query, not a reuse of `entityAt`.**
`entityAt` is the *torch's* question ("of yours, which did the player aim at?")
and the contract promises sources it is asked only at ignition — pilgrims
answers it by building three arrays and spreading them. Spread asks "what is
near a flame" of a world with up to `FIRE_CELL_CAP` cells alight, every
`SPREAD_INTERVAL_SECONDS`; routing that through `entityAt` would be
O(burning × individuals) and would allocate the whole walker list 400 times a
second. `flammable()` is swept ONCE per step, so the cost is O(individuals).
Absent, a source can still be lit by torch and by lightning but cannot catch
from a nearby fire — the same degradation an absent cell source takes.

**Reach is edge-to-centre.** `FlammableIndividual.radiusCells` lets a two-cell
hull catch from further out than a walker standing at a point; walkers and
creatures declare 0, which is deliberately NOT their torch reach (that is the
half-cell *box* a click covers, and reusing it would let a walker catch from
further away than the ground they stand on).

**A burning individual lights the cell it stands on**, which a burning cell
obviously does not need to. That is what makes a fire that walks interesting: a
burning animal crossing dry grass starts a wildfire behind it.

**Grass is fuel now**, reversing the 2026-08-24 decision. That decision's
reasoning was right about the consequence and wrong about the magnitude, and the
correction is measured rather than argued (256² bed, 20 trials per point,
2026-08-25):

- At the shipped thinning — `FLORA_GRASS_SHARE_OF_256`/256 ≈ **0.398** — a
  meadow fire stays a local scorch at EVERY burn time tested (2 s → 1 cell,
  22 s → 26 cells mean / 204 max) and in a full gale. 0.398 sits just under the
  ~0.407 site-percolation threshold of the eight-neighbour lattice, so a meadow
  has no spanning cluster and fire cannot cross it.
- A SOLID bed of the same fuel runs away above 5 s — tens of thousands of cells,
  never self-extinguishing. That is the firestorm the old comment feared; it is
  unreachable at the shipped density, and that is the whole reason grass could
  be registered.
- **The lever is therefore density, not burn time.** `GRASS_CELLS_PER_TUFT` is
  the number to change if meadow fires should run, and crossing 0.407 flips the
  world from local scorches to unstoppable ones with very little in between.

Two hypotheses were tested and **rejected** on the way, recorded so they are not
re-tried: that `FLORA_GRASS_BURN_SECONDS` is the meadow's brake (it is not —
density is), and that `SPREAD_INTERVAL_SECONDS = 1` under-samples short-lived
fuel (it does not — `happensWithin` is exponential and cadence-neutral, and a
3 s burn still spends 2.5 s above `SPREAD_MIN_INTENSITY`; measured at cadences
from 1 s down to 0.1 s with no material difference).

`FLORA_GRASS_BURN_SECONDS = 3`: a flash, ordered grass < crop (4) < tree (22),
and enough rolls to hand the fire to a neighbouring tuft or to the tree it grows
under. A stale comment in `grass.ts` claiming the thinning rejects ~71% of green
cells was corrected to ~60% — it was never true of the shipped threshold, and
the difference is load-bearing now that the number decides percolation.

### Decisions made 2026-08-25 (restart is one button; a slice carries its version)

Phase 1 of `docs/plans/plugin-hot-unload.md` — the operator path for "I have a
new version of a plugin's code and I want it live". Node's ESM module map has no
eviction, so the PROCESS is the unit of code identity and a restart is how new
code arrives; the whole of this work is making that restart cheap, honest and
safe rather than making it unnecessary.

**Restart is an admin action, not a terminal command.** `serverRestart` is a
world-admin message gated by the same key as everything else in that union,
announced and counted down whenever somebody other than the operator is
connected (`WORLD_SWITCH_COUNTDOWN_S`, shared with the world switch because it
is the same courtesy to the same people). The exit sequence has exactly one
correct order — `await gameServer.gracefullyShutdown(false)`, so the existing
`onBeforeShutdown` still stops the tick loop and writes the final snapshot, and
only then `process.exit(TERRACE_RESTART_EXIT_CODE)`. Passing `false` is
mandatory, not stylistic: the default form ends in its own
`process.exit(0|1)` and never returns, which would make the distinguished code
unreachable.

**The code is 75** (`EX_TEMPFAIL`, "temporary failure, retry me"). It has to be
in 1–255 and clear of every code a supervisor already reads: 0 clean exit, 1
boot failure, 2 shell misuse, 128+N a signalled death. Verified through
`pnpm start`, which propagates it unchanged.

**run_server.py gained a restart branch, not a reclassification.** It had no
restart-on-exit path for ANY code, so the in-game button would have taken the
whole dev stack down. On 75 it relaunches the server, re-takes the watch
snapshot first, and leaves Vite running — with a loop guard of 3 restarts inside
60 monotonic seconds, after which it gives up so a failure is visible instead of
spinning. It overlaps the existing `r` key deliberately: `r` restarts both
halves from the terminal, the button restarts the server only and is reachable
by an admin who is not at that terminal, warns connected players first, and
works in docker and systemd where there is no terminal at all.

**Per-plugin build stamps, derived from content.** Discovery stamps each plugin
`<package version>+<git tree hash of plugins/<name>>`, with a
`-dirty.<digest of its status + diff>` suffix when there are uncommitted
changes. The TREE hash, not "the last commit that touched the directory":
identical bytes must stamp identically and a revert must stamp as the bytes it
went back to. The dirty marker carries CONTENT rather than being a flag,
because a bare `-dirty` would make two different edits stamp the same and the
second edit would be invisible — which is the dev loop the stamp exists to
serve. Shown in the boot log, on `worldPluginListing`, and beside each toggle in
the world panel.

**The client's page reload keys on a build identity, never on `serverVersion`.**
`serverVersion` is a git-HEAD stamp: byte-identical across a restart that picked
up an uncommitted edit, and the constant `'unversioned'` wherever there is no
`.git`, so a reload keyed on it would fail to fire in both cases it exists for.
`JoinSnapshotMessage.buildIdentity` is a digest over core's stamp, every
plugin's stamp, and the served bundle's `index.html` (whose asset URLs carry
Vite's content hashes, so a core-client change — which belongs to no plugin —
moves it too). No per-boot nonce: that would reload after a restart that changed
nothing. The client reloads once, at most once per identity ever (remembered in
`sessionStorage`, so a browser that hands the reload a cached `index.html` gets
one warning instead of a loop).

**Docker must inject `TERRACE_VERSION` at image build** or both stamp families
are dead there — the image ships no `.git`. It is a server-stage build arg
written into the image environment, passed through by compose. Unset is safe but
conservative: the stamps fall back to a per-boot value, so every restart looks
like a new build and open pages reload. In docker a restart usually IS a
redeploy, so that is rarely a false alarm.

**A snapshot slice now carries its version, and the host owns it.** Nine of the
sixteen plugins have a slice; six had invented a version field of their own,
three had none at all, and NONE of them could tell a slice written by a NEWER
build. Every one of the six answered that case by returning its own empty state
— which the next snapshot then wrote over the real one, demolishing the town,
erasing the forest or losing the chronicle about a minute after a downgrade. So:
`PersistenceSlice.version` is required, the host wraps every save as
`{ v, data }`, and `load(data, fromVersion)` may return `'refuse'`.

- **A stored value with no envelope is version 1**, handed to `load(data, 1)`
  and rewritten in envelope form on the next save. This is 100 % of the bytes on
  every world file that exists, and it is PERMANENT rather than a one-boot
  migration: `restore_points` hold old `plugin_slices` rows forever, so a
  rollback reads through the same rule for as long as that point exists.
  **History is never rewritten.** A restore point is a record of a moment, and
  restamping its bytes into a shape the moment did not have would falsify it.
- **A stored version ahead of the code, or a refusal, PARKS the slice**: the
  bytes are re-emitted verbatim and the plugin runs stateless with a logged
  warning. Parking needed a host-side WRITE-SUPPRESS set, not just the existing
  dormant map: `collectPersistence` writes every enabled plugin's save over the
  record it seeds from that map, so a parked plugin's own empty save would
  overwrite the parked bytes at the next snapshot. The rule in one line: **a
  slice key has exactly one writer per session, and parking makes the host that
  writer.**
- **The six self-describing plugins prefer their OWN version field** when the
  data has one, and use `fromVersion` only as the fallback. This is a deliberate
  departure from the plan's "the envelope's `v` is the authority": a
  pre-envelope monsters slice reads as version 1 while its own data says 3, so
  trusting the envelope would run a v1 migration over v3 bytes on the first boot
  after this change. The envelope is authoritative for what the envelope wrote;
  the plugin's field is authoritative for what predates it.

**Press-to-playable, MEASURED (2026-08-25, not estimated).** On an isolated rig
(own port, own worlds directory, one real browser client, a 256² world), from the
restart notice appearing to the page having terrain again: **21.1 s** (5 runs,
min 21.06 s, median 21.08 s, max 21.27 s — remarkably tight). Decomposed:

- **~8.5 s** press → the listening socket closing. Colyseus's own
  `gracefullyShutdown`, after the final snapshot is written.
- **~9.3 s** of the boot importing the sixteen plugin server modules.
- **~7.5 s** more to world open and listen.

The plan's estimate was 2–5 s and was wrong by a factor of four, for one
reason: this checkout lives on `/mnt/e`, a WSL2 drvfs mount, and module import
off it is an order slower than a native filesystem. The number to quote for a
deployment on real storage is therefore NOT this one — but the number to quote
for the owner's dev loop is, and it is why the client's one-shot reload matters:
twenty seconds is long enough that a stale page would otherwise be noticed and
manually refreshed. Two things would move it if it ever needs moving: Colyseus's
shutdown wait, and where the repo lives.

### Decisions made 2026-08-26 (fire is reacted to: flee, and smoke)

Fire has been wired as a SOURCE of events since 2026-08-24 and not at all as
something other plugins react to (issue #184). Two owner decisions close that,
and one closes a balance question deferred twice.

**Everything near a fire panics, and a burning thing panics hardest.** Both
halves, not one: bystanders near a new ignition startle, and an individual that
is itself alight gets a SUSTAINED panic lasting as long as it burns — not the
2.5 s `FLEE_DURATION_SECONDS` burst that sculpting produces. The two arrive by
different channels on purpose. A bystander learns from the new `fire:ignited`
world event, batched per tick exactly as `weather:strikes` is; the plugin that
OWNS a burning creature learns from the fuel source's existing
`onIgnited?.([ids])` callback, which already tells it which of its own entities
caught. Matching a broadcast event against your own positions to discover that
one of them is yours would be re-deriving an answer the registry already has.

**The balance question is answered: let it spread — that is the drama.**
DESIGN.md § "(fire that walks)" deferred "a panicking animal towing a spread
front through a forest" on 2026-08-24, and 2026-08-25 made it sharper by having
a burning individual light the cell it stands on. A panicking burning animal is
therefore a FIRE VECTOR, deliberately and without mitigation: its ignition is
not suppressed while panicked, its speed is not reduced, its panic is not
shortened. A wood going up because one torched deer ran into it is the intended
outcome, not a bug to tune away.

**Peeps are in scope, so the seam ships with two subscribers.** Pilgrims have
no equivalent of `startleNear` and one is written for them. Peep movement is
goal-driven, so panic must interrupt that pathing and hand it back — the two
primitives mirror each other in shape only, since the plugins are forbidden
from importing each other.

**Smoke keeps its own decay and OUTLIVES the flame (#185).** It is the one fire
visual NOT derived from `fireIntensity(age, burn)`: a burned-out fire still
smokes, and that lasting signature — "a fire happened here" — is the whole
feature. #185 is about an ESTABLISHED fire reading at DISTANCE, distinct from
#135's catching fire reading close up. A ground scar was considered as the
after-the-fact signature instead and rejected: it is a separate concern, not a
substitute for smoke. Smoke's lifetime is client-owned, keyed by the fire's
stable `key` and never by holding a `FireInstance` across frames; the residual
is that a client joining after a fire died sees no smoke for it, which is
accepted rather than paid for with server state. The flame's budget rules in
`plugins/fire/client/flames/types.ts` bind smoke unchanged — a plume per fire
done naively breaks the draw-call rule and is disqualified however good it
looks.

### Decisions made 2026-08-26 (a plugin asks the host for its sibling)

Every cross-plugin bridge used to reach for its sibling with
`import('../../<name>/server/index.ts')` (the pattern relics→mana established,
16 files). That specifier binds to a MODULE URL, not to "the plugin running as
`<name>` in this session", and issue #196 closes the two things that follow
from it: a sibling reloaded under a new URL would leave every consumer feeding
the old module with nothing thrown and nothing logged, and a sibling the
operator DISABLED for a world went on answering, because its module is resident
either way.

**The host is now the only holder of module identity.** `WorldApi.sibling(name)`
hands back the server module of the plugin running as `name` here, or null. A
plugin that is not installed, and one that is installed but switched off for
this world, are the same null — which is what makes toggling `structures`
itself safe, and what Phase S's model selector depends on. Discovery keeps each
plugin's imported namespace on its `LoadedPlugin` and the host narrows the map
to the enabled set per session; the view is revoked with every other member
when the world closes.

**Two of the bridge pattern's four rules became host guarantees; two stayed
with the caller.** The host guarantees the lookup never throws for an absent
sibling and answers synchronously whatever the load order — so
`DEFAULT_*_MODULE_LOADER`, the loader test seams and the `*BridgeReady`
promises are gone, and `plugins/` contains no `import('../../…')` at all.
Buffer-don't-drop and duck-typing stay in each bridge: core cannot know what a
consumer wanted to say to a sibling, nor which members of it that consumer
needs. Each bridge re-resolves on every `onWorldCreate`, so a sibling enabled
between sessions is picked up on the reopen and the buffered desired state is
replayed into it — and a sibling that stopped running is cleared rather than
left reachable through a stale reference.

**This is also the npm-plugin step (§3.5).** The one line per bridge that used
to encode "plugins are folders on disk" is now a plugin NAME, so where a
sibling's code lives stopped being a bridge's business.

### Decisions made 2026-08-26 (one plugin's code reloads in place, #198)

`worldPluginReload` re-imports ONE plugin's server code into the running
process and rebuilds the live world over it, carrying every connected player
across exactly as an enablement change does. Admin-key gated, like every other
world-management action.

**Either the new module runs everywhere, or the old one still does.** Four
steps can reject a build — the import, the plugin's `onWorldCreate` (with the
slice restore before it), its own refusal of its saved data, and one real probe
tick — and any of them puts the previous `LoadedPlugin` back and opens the world
again over it, which replays that module's state from the slice. Two of those
four throws are swallowed by the host's `safely` (a broken plugin must not take
the world down), so the host now COUNTS its per-plugin faults: without a count
"it did not throw" would be read as "it works".

**The re-import is cache-busted by a generation carried in the URL.** Node's
module map has no eviction, so a stateless resolve hook copies the generation
tag from a parent URL onto every child it resolves INSIDE that plugin's own real
directory — the subtree comes back fresh, and core (which several plugins import
by relative path) is never re-imported alongside it.

**KNOWN RESIDUAL — the reload leaks, measured.** The previous generation's
module namespaces stay reachable through the module map and can never be
collected. On the rig (2026-08-26, `~/.terrace-plugtest-p4`, 20 reloads of
`structures`, the largest plugin, heap read after two forced GCs): **≈0.66 MB of
heapUsed and ≈3.3 MB of RSS per reload**. A two-file toy plugin cost 17–33 KB
per reload over two runs. That is dev-loop scale, not production scale — 100
reloads of the largest plugin is ~66 MB — and it is why `serverRestart` remains
the recommended way to update a plugin and this is the button beside it, not
instead of it.

**The client half still needs the page.** A plugin's client code is compiled
into the bundle, so a successful reload rebinds the build identity (the plugin
stamp it is derived from moves — with a `-reload.<n>` marker, because a
deployment with no git stamps every plugin identically for the life of the
process) and one more join snapshot per connected player carries it, firing the
client's existing one-shot page reload.

**The identity is rebound AFTER the probe, not before the reopen (#209,
2026-08-29).** The either/or has to hold on the wire too, and a client acts on
the first identity that differs from the one it joined under and ignores every
later one — so an identity announced by the probe's own reopen would page-reload
every browser for a build that the three checks after that reopen may still
reject, and the rollback could not take it back. The reopen therefore re-states
the identity the pages already joined under (which reloads nothing), and the new
one goes out by itself once the probe has passed. The rejected shape: probe in a
session whose join snapshots are withheld and send them after a pass — that
breaks the snapshot-before-`onPlayerJoin` ordering `openInto` STEP 7 shares with
`TerraceRoom.onJoin`, because a plugin's `onPlayerJoin` would then broadcast to
a client not yet sized for the rebuilt world.

### Decisions made 2026-08-25/26 (archipelago genesis, and MIN_WORLD_SIZE, #181)

**Supersedes:** the 2026-08-19 starter-profile decision (the fixed shelf/slope
inside the unlock square), the exact day-one habitat census the wildlife plugin
asserted against it, and — from 2026-08-26 — the promise that a fresh world's
starter square holds a whale pair. The 2026-08-19 kraken-basin guarantee
survives unchanged in its rule; only where it is enforced moved.

**The owner's report (2026-08-25).** "New worlds should not have just a single
starter square; they should have islands — not just a single island. They should
also have some random trenches, and the depth of the sea should vary."

**The owner's review of the first attempt (2026-08-26).** Not merge-ready: the
starter square rendered as a hard-edged rescaled rectangle with stamped disc
islands, and half the seed sample was near-landless at 1.4% land. Three things
came out of it, and they are the shape of what shipped: **drop the day-one
whale-pair guarantee**, make guaranteed islands **noise-shaped, not stamped**,
and put a floor under the **world-wide land fraction**.

**One noise field, edge to edge.** The fixed shelf/slope/abyss profile inside the
starter unlock square is gone, and with it the clamp that pinned that square to
deep water. Genesis is now five octaves of integer value noise at
256/128/64/32/16-cell lattice spacings, each at half the amplitude of the one
before it, summed (not averaged — averaging shrinks relief by the same factor it
shrinks any variance, and measured, it left land on 1.2% of a fresh world's
cells) and clamped to the amplitude limits. The wander is symmetric about the
baseline rather than drawn from the lopsided amplitude range, so the baseline is
the height the world actually averages. Everything is still integer band
offsets, exact band floors, fixed RNG draw order, pure in `(size, seed)`.

**Flat worlds retired, and this is a reversal.** "It's OK to create flat worlds"
(owner, 2026-08-18) does not survive the two whole-world guarantees below: land
and a kraken basin sit on opposite sides of the deep-water line, and a field with
less relief than that distance can keep neither — lifting it to make land removes
the basin, lowering it to make the basin removes the land. `roughness` therefore
has a floor, `GENESIS_MIN_ROUGHNESS`, derived as exactly that distance measured
in coarse-octave amplitude. The world at the floor is still very calm; it is no
longer featureless. Above the floor the draw is square-rooted, which keeps calm
worlds rare rather than a fifth of all worlds (measured over 200 seeds).

**Four passes, all on the 2026-08-19 trench-pass contract** — derived from
`(size, seed)` by integer arithmetic with no further RNG draws, fixed iteration
order, total-order tie-breaks, and a no-op where the noise already qualified:

1. **Land.** At least `GENESIS_MIN_LAND_PERCENT` (8%) of the map is dry, reached
   by a single whole-band LIFT of the noise baseline — the smallest that clears
   the floor. A monotone shift of the whole field: nothing is stamped, no shape
   is invented, every contour the seed drew is exactly where it was and the water
   is lower against it. Computed from a histogram of the unclamped band sums, so
   one pass answers the question for every candidate lift at once. Eight per cent
   because Earth is 29% and a world of islands belongs well below that, while a
   default 512-world-unit map at 8% carries ~200 islands' worth of land — land
   within sailing distance of wherever the reveal takes a player — and still
   leaves 92% ocean for the water mechanics.
2. **Basin.** The kraken needs one CONNECTED ocean of
   `GENESIS_TRENCH_MIN_BASIN_CELLS`, and the trench pass cannot supply it: a
   trench only lowers cells that are already deep, so it can deepen an ocean but
   never merge a fragmented one. An island-rich map is a map of small seas —
   measured, 22 of the monsters suite's 48 probe seeds. So where no ocean is
   lair-sized, the field is DROPPED around the world's lowest cell by the same
   terraced lift the islands use with its sign reversed. Its depth is provable
   rather than tuned, because the amplitude clamp sits between the noise and the
   passes: the field under the drop can be no higher than the amplitude ceiling.
   The anchor is held a full basin radius clear of the map edge — the world's
   lowest cell is very often on one, and a basin centred there is a half-disc.
   The land floor is then topped up, bounded, since the drop costs land.
3. **Islands.** The starter square holds `GENESIS_MIN_STARTER_LAND_CELLS` of land
   in landmasses of at least `GENESIS_MIN_ISLAND_CELLS` — restated from the
   wildlife plugin's `MIN_FOUNDING_HABITAT_CELLS`, so an island is by definition
   somewhere a founding population could live. Short of that, the field is LIFTED
   around the shallowest candidate site until it isn't. **Lifting, not stamping**,
   is the whole of the 2026-08-26 fix: taking the maximum of the terrain and a
   cone puts the cone's own contour on the map, so it renders as a disc with a
   halo however the cone is jittered; ADDING the lift to the field's band offset
   before the waterline moves the field's own contour lines, so the coast is the
   seed's terrain raised and comes out as ragged as everything around it. Sites
   are tried shallowest-ground-first, which is both the cheapest lift and where
   an island would naturally be.
   It counts LAND rather than landmasses, and that is a correction: a landmass
   COUNT is not something a lift can deliver — on a seed whose starter square is
   one continent, every extra lift joins that continent and the count never
   moves. Counting land terminates and asks the question that matters.
4. **Trenches.** The kraken trench where the noise fell short (rule unchanged),
   plus `GENESIS_EXTRA_TRENCH_MIN..MAX` (1–3) extras at seed-chosen basins,
   anchors and axes — the owner's "some random trenches".

**What was dropped, and what it costs.** The day-one habitat minima are gone:
genesis no longer promises the starter square any particular amount of shallow or
deep water. The arithmetic that killed them is worth recording — two whales want
64 000 of the square's 102 400 cells (62.5%) and a fish school 32 000 more, which
left 6 400 for land and forced a rescale of most of the square on most seeds. The
rescale is what drew the rectangle. So: **whales arrive with territory creep**,
the same answer the kraken has always had, and the wildlife densities that decide
them are untouched. A seed that draws an abyss in the starter square still opens
with whales; one that draws shallows opens with fish. What a fresh world always
has is land a founding population can live on, which it never had before.

**MIN_WORLD_SIZE, issue #181.** `WORLD_SIZE=256` booted an all-ocean world,
because the 20-chunk starter unlock footprint clamped to the whole map and
genesis had no outside left to draw. The floor was one CHUNK — true about masks,
silently false about terrain. It is now derived: the starter footprint span plus
one NEIGHBOURHOOD ring on every side, 320 + 2 × 64 = 448 cells (112 world units),
a whole number of chunks by construction. A ring of the COARSEST noise octave was
the first derivation and is wrong — that lattice is four neighbourhoods, so it
would have put the floor at 208 world units and forbidden the 128-world-unit map
this document calls the Populous-proven playable minimum. Below the floor the
boot fails through the existing config validation.

**Tests moved from geometry to guarantees.** `server/test/fresh-world.test.ts`,
`plugins/wildlife/test/wildlife.test.ts` and
`plugins/monsters/test/monsters.test.ts` no longer assert cell-for-cell shelf
positions or exact habitat totals; they assert the guarantees above, plus what
was always the point — every height an exact band floor inside
`[MIN_HEIGHT, MAX_HEIGHT]`, reproducible from a seed, different across seeds, and
never without deep water somewhere. Two are worth naming: **"lifts the terrain
rather than stamping a shape on it"** (islands raised by the same lift on
different ground must come out different sizes, which a stamp can never do) and
**"leaves no seam at the starter square edge"** — measured against columns a
whole coarse-lattice period away, because bilinear interpolation makes the height
gradient change at every lattice boundary and the footprint edge is one of those
columns, so the naive comparison fails on terrain that has no seam at all.
Wildlife's day-one census now expects land and grazers, which a fresh world has
never had.

**Rejected alternatives.**
* *Keep the fixed starter profile and put islands only outside it.* The starter
  square is the entire world a player can touch on day one, so an island the
  player cannot walk to is scenery. It also preserves precisely the "single
  starter square" the owner complained about.
* *Stamp a fixed archipelago template into every starter square.* Deterministic
  and two lines shorter, and every world would wear the same islands in the same
  places — the defect this change exists to fix.
* *Float simplex/Perlin noise.* Better-looking gradients, and it puts accumulated
  float error into the one part of the codebase whose whole contract is that
  identical inputs give identical outputs. Integer value noise with integer
  bilinear weights keeps genesis on the same footing as the rest of the terrain
  math.
* *Bias the baseline's draw range so land is likelier, instead of the land pass.*
  Cheaper, guarantees nothing, and it removes the low-baseline deep-ocean worlds
  the sea's depth variation comes from.
* *Let the land floor and the kraken basin share one dial.* The first attempt did
  — it walked the land lift back down until a basin appeared — and it cost the
  land floor on exactly the seeds that needed it. Two guarantees pulling in
  opposite directions cannot share a parameter; the basin got its own pass.

### Decisions made 2026-08-26 (the burn scar — the close-range half of smoke, #203)

Smoke's close-range falloff goes to ZERO inside `SMOKE_SILENT_DISTANCE` (9.6
world units), which is what fixed the grey-slab-in-the-face defect and left a
new one: at the closest zoom a wood that has finished burning shows nothing at
all — no flame, and now no smoke either. The record of 2026-08-26 above rejected
a ground scar as a SUBSTITUTE for smoke; the owner has now settled #203 by
shipping it as the thing that rejection left room for.

**One signature, two halves, and the crossover is the distance smoke goes
silent at.** The scar is at full strength where smoke is at nothing and fades
out as smoke comes up, so at every camera distance exactly one of the two is
carrying "a fire happened here". `SMOKE_SILENT_DISTANCE` is therefore not
copied into a second constant — it is the shared boundary, read once and used
by both, because two numbers that must agree are one number.

**The scar's LIFETIME is smoke's, not the world's.** It appears when the fire
does and retires on the same `SMOKE_AFTERLIFE_SECONDS` clock, keyed by the
fire's own stable key exactly as a smoke column is, with smoke's accepted
residual kept unchanged: a client that joins after a fire died sees neither
half of the signature. A PERSISTED burn record — a scar that survives a rejoin
— is a different feature and a question about world history, and it is
deliberately not being invented inside #203.

**The scar is drawn ON the terrain's own drawn surface, never modelled beside
it.** It is placed by querying `client/src/terrain/drawnGround.ts` for what the
terrain actually draws at that point, which is the rule the water work paid for
four rewrites to learn. It is a plugin-drawn decal in the fire plugin's own
client half and the terrain's colouring is not touched: tinting terrain
vertices would put a gameplay concern inside core, which §"nothing gamey in
core" forbids.

**The flame's budget rules bind the scar unchanged.** One instanced draw call,
constant in count, capped with the columns it accompanies — a quad per burned
cell done naively breaks the draw-call rule however good it looks, which is the
same bar smoke was held to.

### Decisions made 2026-08-26 (the sculpt-time water rebuild, three fixes)

**The measurement.** Every sculpt routes through `applyDirty` (client/src/
world.ts), which calls `rivers.refresh` — throttled to
`RIVER_RECOMPUTE_INTERVAL_MS` (500 ms), so a held stroke rebuilds the world's
water twice a second. Measured on a 512² world with 400 chunks revealed and a
network at its own design ceilings (`MAX_SPRINGS_PER_NETWORK` = 24 springs,
each traced to `RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize` cells,
i.e. ~24.5k wet cells): **235 ms per rebuild**, against the owner's ≥140 fps
bar — a 7.1 ms frame budget for everything. Three separate causes, three fixes,
all owner-approved.

**1. THE TERRAIN PUBLISHES ITS PLAN; NOTHING RE-DERIVES IT.** Commit 7e3332c
gave the world "the terrain publishes what it drew; water reads it", and the
reading half honoured it by RE-DERIVING: `createDrawnGround(mirror)` called
`planChunkCaps` again for every chunk any query touched, while
`writeChunkVertexData` had already planned exactly those chunks and thrown the
result away. Two costs, and the second is the worse one: a plan that is a
private memo of a mutable mirror "MUST NOT outlive a terrain edit", so FOUR
places in world.ts had to remember to null it and a fifth that forgot would
have placed decals on pre-edit contours. `terrain/drawnGroundStore.ts` is now
the handover: the mesh builder publishes each chunk's `ChunkDrawnCaps` as it
draws it, and `terrain/drawnGround.ts` is a pure reader with no cache and no
invalidation. **A chunk not yet drawn has no entry**, and that is a real state
rather than a gap — the mesh queue drains under a frame budget, so water asking
the store gets what is ON SCREEN, which is the side of that race water must be
on; the reader answers for such a chunk exactly as it answers for a blocky one,
from the cell's own height through the blocky fallback's Y rule.

Alongside the plan, each chunk's level polygons are RASTERISED ONCE into a band
grid at `BAND_GRID_CELLS` (a quarter cell — the curtain's own probe step, now
one constant read by both). `bandAt`/`topmostLevelAt` become an array read
instead of a point-in-polygon walk down the level stack, which the waterfall
curtain was calling four times per boundary segment for thousands of segments.
The grid samples sit ON the lattice, so every query at a cell centre, half cell
or quarter cell is exact; only the curtain's outward probe is quantised, and by
at most half a grid step, at a boundary where its own doc comment already
records that either adjacent band is a correct answer.

**2. WATER GEOMETRY IS RE-EMITTED PER REGION, NOT PER WORLD.** A region's
identity is its BAND — the rebuild groups every wet cell by the band its
surface is drawn at, so one band is one region by construction, and the same
terrain always produces the same bands. Each region owns a packed RUN in the
water buffer, spliced with `copyWithin` exactly as `terrainMeshes.ts` packs
chunks into a super-mesh, and re-emitted only when the chunks it stands over
can have changed: the dirty set `applyDirty` already computes, plus every chunk
holding a cell whose water entered, left or changed band, each grown by one
ring of chunks (a marching tile reads the border row it shares with its
neighbour, and a curtain probes up to a cell outside its own region). BOTH the
region's current tiles and the tiles it was last drawn with are tested — a
region that lost every cell it had in a chunk no longer lists that chunk, so
only the tiles it was drawn with can report that its old geometry there is
stale.

**3. THE NETWORK RECOMPUTE MOVED OFF THE MAIN THREAD.** `computeRiverNetwork`
is GLOBAL by nature — a scan of every active cell for local maxima, then a
trace from every spring — so unlike the geometry it cannot be scoped to a
stroke's chunks. Measured at 24–48 ms depending on how much river a world has,
it is over the whole frame budget on its own. It now runs in a Web Worker,
which the purity Q3 established is exactly what makes safe: same heightmap in,
same network out, no state to synchronise, so the answer does not depend on the
thread. The mirror's cells are TRANSFERRED as a copy (the worker never shares
memory with the thread that is sculpting), and `columnSpans` is not sent
because the river math never reads it. **What comes back is not the network.**
The tree is flattened worker-side to three typed arrays (wet cells, their
bands, the river head cells — `render/water/riverSurface.ts`), because posting
~24.5k point objects would put the structured-clone DESERIALISATION back on the
main thread, which is the thread the move exists to unload. Requests coalesce:
one compute in flight, a request made during it only marks "again when this
lands", and an answer whose mirror has since been replaced by a rejoin is
dropped. Where no worker can be started the source falls back to this thread —
slower, never wrong. Tests and previews use that direct source, so there is one
rebuild path rather than a fast one and a test one.

**Result, same fixture:** 235 ms → **3.4 ms** of main-thread work per refresh,
with 48 ms of network recompute off-thread. What remains is the O(wet cells)
walk that stamps the surface into a per-cell table and groups it into regions —
bounded by rivers.ts's own two constants rather than by terrain roughness.

### Decisions made 2026-08-27 (a pulled band overhangs a carve; it never fills it)

Owner report (#224): "if I carve and I try to pull the layers above, it
instantly fills the carve." Reproduced on a carved column — a floor span, an
opening, a roof span — by pulling a band that lies in the opening.

**This overturns D4's "fill the opening" rule, which is kept below as the
record of what it used to be.** D4 (issue #129, step 4.5) said the receiving
span for a fill to band k is "the highest span whose ceiling lies below k"
(`spanIndexBelowBand`, columns.ts): raising that span's ceiling to the band
"puts material in the opening, and if that reaches the span above the two weld,
which is a sealed cave rather than a deleted one." The reasoning was that a
drag adds material and a sealed cave is at least not a deleted one. In the hand
it is the opposite of what the gesture means: the player who just cut an
opening and grabbed the roof gets the opening filled from the floor up and the
carve destroyed in one click.

**Decision (owner, 2026-08-27): the roof extends as an OVERHANG. The floor span
never rises.** Pulling a band that lies in a gap under the cell's own roof lays
that band's own slab — which welds to the roof above it wherever the join is
too thin to draw — and leaves the span below byte-untouched.

**The rule, stated once, in `columns.ts` `bandFillAt`.** For a cell open at band
k, the fill is `extend` (the ground below rises to the band — the terrace step
the drag has always built) when the column has OPEN SKY above the band, and
`overhang` (the band's own slab) when the column has any span above it. Both
the drag's own fill and `pushLowerLayers`' cascade go through it, so neither
can seal a carve; the cascade additionally refuses `overhang` outright, because
it exists to carry an existing staircase and must never author new roofs.

- **Why the cell's own column decides and not a survey of its neighbours.** The
  neighbour is what ADMITS the fill (`canSpreadBandToSpan` — the anti-cheat that
  keeps "clients send intents, never heights" true of a message naming a band);
  what the cell then looks like is a question its own spans answer completely.
  Neighbours that disagree would need a tie-break, and a tie-break is a rule two
  replicas can drift on.
- **Why no new field on the wire.** The grasped span already travels: a drag
  carries `targetBand`, one column covers a band with at most one span, and both
  replicas resolve the band against their own map. A `spanBand` on a drag intent
  would be the same number twice — and it could not be derived correctly anyway,
  because a pull's `x`/`y` is the CURSOR cell, not the cell whose lip is in the
  player's hand. This is what `sculptInput.ts` `emitDrag` deferred to "plan step
  4.5, D5", now resolved: the span-aware form of the pull is the per-cell rule
  inside `applyDragRegion`, not a wire field.
- **Unlayered worlds cannot reach the new branch, by construction.** A one-span
  column floors at `BEDROCK_FLOOR` and every band of a valid world is at or
  above it, so the span either covers the band or lies below it and there is
  never a span above. Verified: a hard drag pulling a band-4 terrace across a
  disc produces a byte-identical height field before and after this change.
- **The slab is floored one height unit above the boundary below it**, not on
  it, because `spanUndersideHeight` hangs a span one band below its lowest
  FILLED band: a slab floored on the boundary would fill the band under it too,
  be drawn two bands deep, and weld to ground one band down — the floor-to-roof
  weld this decision exists to prevent. Same reconciliation and the same single
  height unit as `BEDROCK_REMNANT`.
- **An opening too thin to hold an overhang still welds, and that is the model
  speaking, not this rule.** `isGapDrawn` says a one-band gap is not drawn;
  a slab laid with less than that clearance merges into what it touches. A
  carve deep enough to see is deep enough to overhang.

**Rejected alternatives.**

- *Keep D4 and refuse the pull under a roof.* Honest, and useless: the owner's
  gesture would do nothing rather than the wrong thing, and there would still be
  no way to extend a roof.
- *Ask the neighbour that holds the band whether it holds it as a roof
  (`spanIndexCoveringBand > 0`) and mirror that.* Closer to the words of the
  report and strictly worse to implement: several neighbours can hold the band
  in different shapes, so it needs a tie-break, and the answer would then depend
  on scan order rather than on the terrain.
- *Carry the grasped span on the drag intent.* See "why no new field" above —
  the cursor cell is not the grabbed cell, so the field would be wrong exactly
  where it mattered.

### Decisions made 2026-08-29 (relaxation conserves height; the steepest legal slope is MAX_STEP + 1, #108)

**The defect.** Gradient relaxation is CLOSED over the map: the only thing it is
allowed to do is move height between two neighbouring cells. It was not closed.
`movePair` took the excess `e` a pair had over `MAX_STEP` and gave the high cell
`e >> 1` while giving the low cell `e - (e >> 1)` — one unit more than the high
cell lost, on every odd excess, taken from nobody. One bare smooth of a 401-unit
cliff on a 128² map invented 1,666,592 height units, 50.7% of the map's own
total, and a player roaming with the smooth brush was a height pump. Issue #239
(a mudslide's head scour measuring a net GAIN and abandoning the slide) was this
defect seen from a plugin.

**The fix, and its price.** The split is exact: `drop = rise = e >> 1`. That
makes a pass sum-preserving by construction on every path through the function,
including the coupled band clamp. An even split of an excess of 1 moves nobody,
so the trigger had to move with it — a pair is relaxed only when it exceeds
`MAX_STEP + RELAX_SLACK`, with `RELAX_SLACK = 1`, which keeps `e >= 2` for every
pair the sweep touches and so keeps "every counted move is progress", the
sweep's termination argument.

**THE STEEPEST LEGAL SLOPE IS THEREFORE `MAX_STEP + 1` (= 5), NOT `MAX_STEP`.**
A pair sitting one unit over the gradient limit is AT REST. Every reader of the
gradient invariant must allow it: `shared/test/heightmap.test.ts`'s
`expectGradientLimitHolds`, mudslides' `MUDSLIDE_MAX_DROP_OVER_SPAN` (now
`(MAX_STEP + RELAX_SLACK) × span`), and any future consumer that wants to know
what the terrain can hold. The walker rule
(`LAND_WALKER_MAX_GRADIENT_PER_CELL`) deliberately stays at `MAX_STEP / 2`:
half of 5 is not a height, and the tie is broken downward so the walker refuses
slightly more than half the legally-possible slopes rather than fewer.

**Saved worlds re-grade on their next smooth stroke.** Nothing migrates a
persisted heightmap. A world saved under the old rule may hold pairs at
gradients the new rule would not have produced; those are simply terrain the
next relaxation that reaches them will pull in, one stroke at a time, and until
then they render and walk exactly as they did. This is the same incremental
repair the pass-cap residual below relies on, and it is why no version bump or
save migration is part of this decision.

**`SMOOTH_PASS_LIMIT` stays 2560 — owner decision, with the residual named.**
Conservation costs passes on sheer ground: the fill on the low side of a cliff
is no longer invented, so every unit of the ramp is walked down off the plateau.
Measured by bisection on a bare cliff over 128² (`.sim-108/passes.mjs`), walls
of 593 height units and up no longer converge inside the cap; a 592-unit cliff
finishes in 2,524 passes, a 593-unit one truncates at 2,560, and a 1000-unit one
wants ~7,205. A truncated sweep leaves the gradient invariant locally violated —
worst local gradient 6 at the threshold, 7 at 1000 units, against the 5 it
guarantees elsewhere — deterministically on both sides, visibly (`smooth`
returns its pass count, and a count equal to the cap means exactly this), and
repairably: the next smooth stroke over that ground resumes the cascade.

Such a wall is not player-constructible. A 593-unit sheer face is ~37 stamped
bands with no tread between them: legacy or synthetic terrain. The worst strokes
a player CAN make converge in 108–118 passes, 4% of the cap. Raising the cap
would raise the worst-case CPU of every intent on every world to buy convergence
on those; the price of leaving it is that a legacy over-steep world re-grades
over several strokes instead of one, plus wall-clock on such worlds — a relic
cast landing on genesis-steep ground was measured at 888 ms before and 1,271 ms
after (issue #108's review).

**Plugin constants were re-derived against the new rule, not assumed.** Every
plugin that reaches the ground does so through `WorldApi.sculpt`, so each of the
constants tuned against the manufacturing rule was re-measured old-vs-new on a
512² genesis world (`.sim-108/plugins.mjs`):

- **volcanoes `CONE_GROWTH_BANDS_PER_ERUPTION` 1 → 2**, and rewritten as the
  derivation it is: `CONE_PEAK_BANDS_PER_ERUPTION ×
  CONE_BRUSH_BANDS_PER_PEAK_BAND`. The intent — one band of PEAK per eruption —
  is unchanged; what changed is that a cone's flanks are at the gradient limit,
  so half of what the brush puts on the apex now really leaves it. Mean peak
  gain per eruption: 16.0 old, 9.0 at one band, 15.1 at two.
- **mudslides `MUDSLIDE_MAX_DROP_OVER_SPAN` 32 → 40**, written as
  `(MAX_STEP + RELAX_SLACK) × MUDSLIDE_SLOPE_SPAN_CELLS` — the constant claims
  to be "the steepest the sim permits", and that is now 5 per cell.
- **volcanoes `FLOW_THICKNESS`, storms `SURGE_BRUSH_RADIUS_CELLS`, mudslides
  `MUDSLIDE_TRACK_DEPOSIT_FRACTION` / `MUDSLIDE_TOE_DUMP_STEPS` /
  `MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS` / `MUDSLIDE_MEASURE_MARGIN_CELLS`:
  re-measured, deliberately NOT retuned**, each with the numbers recorded in its
  own doc comment. The headline: a single flow cell still settles at exactly 8
  units under both rules (only the pooled crust changed, and by shedding
  manufactured height); one surge removes 1.09× what it used to on a genesis
  shoreline and still drops the shore less than one band; and a slide now
  deposits 1,828 units against 1,848 excavated (1.1% residual) where the old
  rule "cleared" its ledger by depositing 1,811 units it had measured as 675.
  The mudslide measurement window did not need widening either — the widest
  single sculpt diff FELL from 502 cells to 229, because the manufacturing rule
  had been feeding its own cascade.
