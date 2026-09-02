# Phase 0 1 kickoff

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

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

## Decisions made 2026-08-13 (Phase 0 kickoff, settled with owner)

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

## Decisions made 2026-08-13 (Phase 1 kickoff, settled with owner)

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

## Version facts recorded at scaffold time (2026-08-13)

- Latest stable: colyseus **0.17.10** (server), but `colyseus.js` (browser client)
  latest is **0.16.22** — no 0.17 client is published. **Phase 1 must verify
  client/server compatibility against current Colyseus docs before writing room
  code**, and pick either matched 0.16 both sides or 0.17 server + whatever client
  path 0.17 documents.
- Other pins at scaffold: TypeScript 7.0.2 (new native compiler — verified working
  for typecheck in Phase 0), Vitest 4.x, Node 24 (runs `.ts` directly via type
  stripping — `shared/` uses only erasable syntax: no enums, no namespaces),
  pnpm 10.33.0, Three.js 0.185.x, SolidJS 1.9.x, Vite 8.x, better-sqlite3 13.x.

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
