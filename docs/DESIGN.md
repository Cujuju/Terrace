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

- **A fresh world starts as an ocean with a coast, not a flat shoreline** (owner
  request, settled 2026-08-14, from the report "we need more wildlife, I don't
  see any deep sea creatures"). `World.createFresh`
  (`server/src/world/world.ts`) generates three concentric terraces by Chebyshev
  (square-ring) distance from the starter region's centre:

  | region | depth | constant | height |
  |---|---|---|---|
  | shelf — a centred square of `spanChunks / FRESH_SHELF_SPAN_DIVISOR` (= 2) chunks | 1 band | `FRESH_SHELF_BANDS_BELOW_SEA` | −64 |
  | slope ring — `FRESH_SLOPE_WIDTH_CELLS` (= `CHUNK_SIZE`, 16) cells wide | 2 bands | `FRESH_SLOPE_BANDS_BELOW_SEA` | −128 |
  | open sea — everything beyond | 3 bands | `FRESH_SEABED_BANDS_BELOW_SEA` | −192 |

  Deterministic and integer-only: no RNG anywhere in genesis, so a size always
  produces the same world and tests assert it cell by cell. The shelf is placed
  from `initialUnlockFootprint()` — the one definition of the starter square,
  which `applyInitialUnlock` also reads — rather than from a second copy of its
  centring rule.

  **Root cause this fixes.** `createHeightmap` allocates zeros and `SEA_LEVEL`
  is 0, so every cell of a fresh world sat *exactly* at the waterline: the sea
  had no depth anywhere. Nothing that classifies water by depth could ever fire
  — the wildlife plugin's deep-water habitat begins three bands down, so whales
  and deep-sea creatures had literally nowhere to exist unless a player hand-dug
  a trench. The ocean was a surface, not a volume.

  **Why these depths.** Three bands is the shallowest depth satisfying
  `FRESH_SEABED_BANDS_BELOW_SEA >= DEEP_WATER_BANDS_BELOW_SEA` — the open sea
  must qualify as deep habitat *by design*, and every band beyond that is one
  more sculpt a player spends raising land out there. One band for the shelf is
  the shallowest water that is still water: shallow habitat for coastal species,
  and only one band below the surface so an island where the game starts you
  costs two sculpts rather than four. Core cannot import a plugin constant, so
  both relations (open sea deep, shelf and ring shallow) are pinned by tests on
  the plugin side (`plugins/wildlife/test/wildlife.test.ts`).

  **Why the shelf is a quarter of the starter square.** The habitat census only
  counts *unlocked* cells, so the starter square's 16 384 cells (identical on
  every world size) are the entire day-one habitat budget, and
  `FRESH_SHELF_SPAN_DIVISOR` is what splits it. At 4 the split is 4 096 shallow
  / 12 288 deep — the coarsest setting that still buys 2 whales at 5 000 deep
  cells each. A larger shelf eats the open sea this change exists to create; a
  smaller one leaves no coast for fish.

  **Residual, named.** A one-band step is `BAND_HEIGHT` (64) against a gradient
  limit of `MAX_STEP` (32), so the two ring boundaries do not satisfy the
  relaxation invariant at genesis. Nothing enforces it at rest — the stamp tool
  violates it deliberately on every spire — but a `smooth` sculpt whose
  relaxation reaches a boundary will slump it once, with a larger-than-usual
  diff bounded by `SMOOTH_PASS_LIMIT`. Accepted: that is the smooth tool doing
  its job on a terrace edge, and a ramped coast would trade the terraced house
  style for it.

  **Where it lives, and why not in `shared/`.** The server fills the floor;
  `createHeightmap` stays zero-filled. `shared/` is the determinism contract
  that client and server both run, and world *genesis* is not part of it — the
  client never generates terrain, it receives chunks. This also keeps "what a
  new world looks like" a server policy a future world-gen plugin can replace.

  **Consequences, accepted:**
  - Raising land costs band-steps it did not before, and how many now varies by
    place: two sculpts to break the surface on the starter shelf, four out in
    the open sea. Intended — the ocean is a volume with a bottom.
  - A fresh world has **no land**. Land-habitat species (the wildlife plugin's
    grazers) have nowhere to be until a player raises an island; water species,
    coastal and open-sea alike, have somewhere from the first tick.
  - Snapshot-restored worlds are untouched: genesis applies to the no-snapshot
    path only, so existing self-hosted worlds do not silently gain a coastline.
  - The client boots its local heightmap at band 0, so for the single frame
    before the first chunk arrives it draws a flat shoreline where the server has
    a coast and an abyss. Cosmetic, pre-connect only, and **not fixed here** — it
    belongs in the client's boot state.

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
