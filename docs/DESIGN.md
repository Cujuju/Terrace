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
  `free` so plugin terraforms keep the unbounded relaxation they were tuned
  against, bit for bit. See SculptSpill in shared/src/heightmap.ts.

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
  reaches a whale's 5 000-cell need at all. The divisor itself was never
  retuned for this — 4 is still "coarse enough that a larger shelf would eat
  the open sea this whole change exists to create, and a smaller one would
  leave no coast for fish" — the starter square just got smaller out from under
  it, an accepted consequence named in full in the entry below.

  **Residual, named.** A one-band step is `BAND_HEIGHT` (64) against a gradient
  limit of `MAX_STEP` (32), so the shelf/slope/noise boundaries do not satisfy
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
  | grazer | 0 | 0 (unchanged — a fresh world still has no land) |

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
  client. It is also a good threshold on its own: `MAX_STEP` is `BAND_HEIGHT/2`,
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

  **The yeti's profile**, and each number stated against the two sea kinds:
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
  + `client/yeti.ts`, ~6 100 triangles against the kraken's 7 700): a hunched
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
