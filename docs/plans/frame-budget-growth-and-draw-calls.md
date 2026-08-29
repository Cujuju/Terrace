# Frame budget, next two levers: no growth in a stroke (#229), and a draw-call budget — plan

Status: PLAN v1, 2026-08-29. Follows `vertex-arena-no-tail-move.md` (shipped
64ce9cf). The arena met its contract on the real GPU (slow-frame upload 20–24
MB → 0.7–1.8 MB, splice 1.7 → 0.10 ms) and the bar (≥140 fps = every frame
< 7.1 ms, owner 2026-08-26) is still missed: at matched scene complexity
p95 ≈ 22–24 ms, p99 ≈ 75 ms. Two things remain that are already known, and
they are different problems:

- **A.** The stroke's first frames are capacity growths — the one upload the
  arena does not bound (`ensureSuperCapacity` → `bindGeometry` → a full
  `bufferData`), ~3 MB frames measured up to 505 ms at stroke start
  (issue #229). Also why streaming a 400-chunk world uploads 5.4 GB.
- **B.** The per-frame baseline scales with draw calls, and plugins add them
  freely: 196 → 342 calls drifted between two runs in one session, ~250 →
  ~330 over a day. Idle render is ~1.7 ms at ~330 calls; at ~1 000 it is
  the whole budget. This is the project's recurring defect
  (`terrace-draw-call-budget` memory) and it needs a contract, not a tune.

A third suspect — one blocking GL call charged ~115 ms for 1.8 MB — is NOT
planned here; it is unattributed (assumption: a write into a buffer the GPU
is still reading), and it gets one probe run after A lands, because A's
growth frames are the same size class and may be the whole story.

---

## Part A — a stroke never reallocates a super-mesh

### A1. Mechanism (verified from source)

`createSuperMesh` (terrainMeshes.ts:1030-1040) allocates
`createChunkGeometryBuffers()` at the default
`INITIAL_CHUNK_TRIANGLE_CAPACITY = 1 024` triangles = 3 072 vertices — a
**chunk**-sized default used for a **super-mesh** of up to 64 chunks whose
measured median chunk is 5 388 vertices. `ensureSuperCapacity` (:728-745)
then doubles: for the busiest super-mesh (1.25 M vertices) that is 9
doublings, each a fresh `BufferGeometry` whose attributes three uploads with
one `bufferData` of the WHOLE array — capacity, not live vertices
(`WebGLAttributes.createBuffer`, `gl.bufferData(type, array, usage)`). The
doubling series sums to ~2× the final capacity, and every super-mesh pays it
during the reveal: 5.4 GB / 3.7 s measured on the 400-chunk stream.

After the stream, capacity sits anywhere between 1× and 2× `liveEnd`. When
the slack is small, the first regrow of a stroke that finds no hole (§3b
case 5 of the arena plan) appends past capacity, `compact-before-grow` finds
nothing to reclaim, and the doubling lands **inside the stroke**: a
`bufferData` of the busiest super-mesh is 2.5 M × 19 B ≈ 47 MB.
`arenaStats().growths` counts exactly these.

### A2. Root cause, one sentence

Super-mesh capacity is decided by the chunk-sized default and by whatever
doubling the reveal happened to end on, so the amount of slack a stroke has
to work with is an accident of streaming order rather than a guarantee.

The contract that prevents recurrence: **a super-mesh always holds
`ARENA_STROKE_HEADROOM_VERTICES` of free capacity when the terrain is
settled, and capacity is only ever grown on a settled, idle frame.**

### A3. The fix — three rules

1. **Size the first allocation from what is known.** When the snapshot
   arrives, `update(dirty)` receives every received chunk of the world at
   once (400 here). `createSuperMesh` is called per super-mesh as its first
   chunk is spliced; at that moment `pending` already holds the super-mesh's
   other chunks. Initial capacity = `chunksQueuedFor(superIdx) ×
   SUPER_MESH_INITIAL_VERTICES_PER_CHUNK`, where the per-chunk prior is the
   **measured p90 run size, 39 k vertices, rounded to 40 960** (= 13 653
   triangles ×3; measured 2026-08-28 over the owner's 400 chunks: p50 5 388,
   p90 38 787, p99 104 850). Derivation: p90 makes ≥ 90 % of chunks fit
   without the sum of 64 of them (2.6 M vertices, 50 MB) blowing GPU memory
   at 16 super-meshes (800 MB worst case is too much — see A5); a super-mesh
   whose chunks are all p90-sized needs 0 growths, the busiest real one
   (1.25 M live over its chunk count) needs at most 1. Falls back to today's
   default when nothing is queued (tests, harnesses that splice one chunk).
2. **Headroom at settle.** `ARENA_STROKE_HEADROOM_VERTICES` = `2 ×
   the largest run in that super-mesh` (its `slots` — O(64)), floor
   `2 × p90 = 81 920`. A regrow appends at most one new run of roughly the
   old run's size; 2× covers a regrow of the largest run plus the brush's
   second chunk in the same step. On a frame where `drain` spliced nothing,
   `ready`/`inFlight`/`pending` are empty for that super-mesh, and
   `capacity − liveEnd < headroom`: grow once, to `liveEnd + headroom`
   rounded up to the next doubling of the *chunk-sized* unit (so the
   allocation series stays geometric and the slack is never below the
   floor). This is the only growth that happens outside streaming.
3. **Growth is never an emergency in a stroke.** Keep `ensureSuperCapacity`
   as the correctness backstop in the append branch — a stroke that grows
   past its headroom over many steps still works — but count it separately
   (`arenaStats().strokeGrowths`) so §A6 can assert it is zero on the bench
   and the probe can show it on the GPU.

Where: all in `render/terrainMeshes.ts`; the settle-time growth rides the
frame hook beside `drain`/`compact` (`drain(…); compact(…); ensureHeadroom()`),
under `ARENA_COMPACT_IDLE_BUDGET_MS`'s idle condition, so §3d of the arena
plan is the same seam. `flush()` ends with `ensureHeadroom()` too, so the
direct path matches.

### A4. Rejected alternatives

- **Paged super-meshes** (a full super-mesh starts a sibling `Mesh` instead of
  reallocating): removes the full re-upload entirely but adds draw calls
  (~11 pages of 512 k vertices over this world, plus up to 16 partials)
  and puts a page boundary inside the arena's free list and compactor. Right
  answer if A3 still leaves stroke growths; wrong first move against a bar
  that Part B exists to defend by *reducing* calls.
- **Allocate the GL buffer at capacity and upload only the live prefix.**
  three's `createBuffer` uploads `attribute.array` whole; doing better means
  bypassing `BufferAttribute` for the terrain (own `WebGLBuffer`, own
  `bufferSubData` on bind). A second upload path beside three's is more
  contract than the headroom rule and buys nothing the rule does not.
- **Size from p99 or the ceiling.** 64 × 105 k × 19 B = 128 MB per
  super-mesh, 2 GB for 16; `CHUNK_TRIANGLE_BUDGET` (393 k) is 480 MB per
  super-mesh. p90 is the largest prior that keeps the worst case (A5) under
  a named limit.
- **Grow during the stroke but on a worker.** A `bufferData` is a main-thread
  GL call; a worker cannot make it for this context (OffscreenCanvas is a
  different renderer).

### A5. Residuals, named

- **GPU memory prior.** 16 super-meshes × 64 chunks × 40 960 × 19 B =
  797 MB if every super-mesh were full and every chunk queued — an upper
  bound the 512² world does not reach (its 400 chunks over 16 super-meshes
  allocate ~311 MB before the first doubling, vs 5.27 M × 19 B = 100 MB
  live). Named as the cost of zero streaming growths; a 2048² world (16 384
  chunks, 256 super-meshes) would need the prior lowered or made
  per-world — decide when a 2048² world exists, not before.
- **One idle-frame hitch after streaming** per super-mesh that needs
  headroom (a `bufferData` of ≤ 47 MB, ~25–50 ms), paid once, off the
  stroke. Visible as one dropped frame right after a reveal.
- A stroke longer than its headroom still grows mid-stroke; counted, not
  prevented.

### A6. Tests and verification

Tests (write first): initial capacity equals queued-chunks × prior when the
snapshot update is pending, default otherwise; after `flush`, every
super-mesh has `capacity − liveEnd ≥ headroom(sm)`; an idle scheduled frame
grows a super-mesh whose slack is under headroom and no stroke frame does;
`strokeGrowths` stays 0 across the arena tests' stroke histories; growth on
the idle frame preserves the arena (equivalence oracle).

Verification: bench prints `growths` and `strokeGrowths` after the stream
and after 30 sculpts (expect `strokeGrowths` 0, `growths` ≤ 1 per
super-mesh); real GPU per `.gpu-perf/README.md`: the stroke's first frames
no longer carry ~3 MB uploads, `stroke.slow1pct.uploadMBMean` and `msMax`
before/after, plus **the total upload during the settle window** (the
probe's idle block runs after settle; add a `streamUploadMB` figure from
the accounting installed before settle — expect 5.4 GB → ≤ ~0.6 GB, i.e.
one allocation per super-mesh at the prior).

---

## Part B — the draw-call budget as a contract

### B1. Mechanism

Every plugin gets a `layer: Group` under the scene (plugins/host.ts:286-290)
and adds whatever it likes. Nothing counts. `renderer.info.render.calls` is
read only by the perf probe. Terrain has a `drawCallCount()` contract (16
calls on this world); nothing else does. Per-call cost in three is
per-object: `projectObject` → render list → `setProgram`/uniform upload →
`drawArrays`; at 330 calls the idle render is 1.7 ms; the self-profile taken
2026-08-28 shows `setProgram`, `updateMatrixWorld`, `markUniformsLightsNeedsUpdate`
as the per-object costs. Draw calls also carry the shader-program count
(107 programs at one point — every distinct material variant compiles one).

### B2. Root cause, one sentence

The drawing unit is whatever each plugin happens to author (one `Mesh` per
tree, per raindrop cloud, per lamp), and no contract turns "objects I made"
into "calls I am allowed", so the frame budget is spent by whoever adds a
feature last.

The contract that prevents recurrence: **each plugin declares its draw
budget, the host measures it every frame, and exceeding it is a failure the
developer sees in dev and the probe reports on the GPU.**

### B3. The fix

1. **Declare.** `TerraceClientPlugin` gains `readonly drawBudget: number` —
   the maximum *renderable objects* (Mesh/InstancedMesh/Points/Line/Sprite
   with `visible`) the plugin's layer may hold, i.e. its worst-case draw
   calls before frustum culling. Required, not optional: a plugin without a
   number has not thought about it. Counted by the host, not by the plugin.
2. **Measure.** The host walks each plugin's `layer` once per
   `DRAW_BUDGET_SAMPLE_INTERVAL_MS = 1000` (the fps meter's window,
   `FPS_SAMPLE_INTERVAL_MS`, so the two readouts update together) — a
   traversal of a few hundred objects is ~0.05 ms, per second — and
   publishes `{plugin, objects, budget}` to `hudState` beside `frameRate`.
   `renderer.info.render.calls` (actual, post-cull) is published alongside
   as the frame's total.
3. **Enforce.** Over budget → in dev (`import.meta.env.DEV`) a
   `console.error` naming the plugin, its count and its budget, once per
   breach (not per second); in the HUD the plugin's row turns red. Not a
   throw — a runtime kill of a plugin for a perf regression is worse than
   the regression. The total, `FRAME_DRAW_CALL_BUDGET`, is the sum of the
   declared budgets plus core's fixed calls (terrain `drawCallCount()`,
   water, rivers, fog, overlay — each named); the HUD shows
   `calls / budget`.
4. **Ratchet, then reduce.** The initial numbers are **measured, not
   chosen**: step 0 of the implementation runs the probe with per-plugin
   attribution (one scene traversal per sample — `.gpu-perf/perf-probe.patch`
   already walks the scene) on the owner's world with every plugin live, and
   each plugin's budget is set to its measured count. From then on a budget
   only goes down, and raising one is a reviewed decision in the plugin's
   commit. The three largest contributors get batching tickets (B5).
5. **Cost model, measured once.** A `.gpu-perf` run with N extra trivial
   meshes (N = 0, 250, 500, 1 000) gives ms-per-call on the owner's machine;
   that number, dated, becomes the derivation of `FRAME_DRAW_CALL_BUDGET`'s
   ceiling: `(7.1 ms − measured idle render at 0 extra) / ms-per-call`.
   Until measured, the ceiling is the ratchet's sum.

Where: `plugins/types.ts` (the field), `plugins/host.ts` (the sampler,
beside `mountPlugin`'s layer), `state/hudState.ts` + `ui/VersionWatermark.tsx`
(the readout — the fps span already lives there), `render/frameRate.ts`
(export the interval; do not add a second timer), every plugin under
`plugins/*/client` (one field each, with the measured number).

### B4. Rejected alternatives

- **A global cap only.** Tells you the frame is over without telling you who;
  the drift 196 → 342 came from one session's plugins and nobody could say
  which.
- **Enforce in tests.** Plugins' client halves build Three objects; a node
  test can count objects after `attach` for the static ones, but the
  offenders are dynamic (spawned creatures, weather) and grow at runtime.
  The host's live count is the only honest measure; a per-plugin static
  test is optional wiring, not the contract.
- **Auto-batch in the host** (merge a plugin's meshes into instanced draws
  behind its back). Instancing needs the plugin's cooperation (per-instance
  transforms and materials); a host-side merge would silently break
  per-object animation. Batching is the plugin's job under its budget.
- **Kill the plugin on breach.** See B3.3.

### B5. Residuals, named

- Budgets are in objects, calls are post-cull; a plugin can be under budget
  and still cost when everything is in view, or over budget with everything
  culled. Objects are the deterministic, camera-independent unit and that
  is why they are the contract; the HUD's actual-calls total is the check.
- Programs (shader variants) are not budgeted here; they cost compile time
  on first use, not per frame. Observed, via `renderer.info.programs`, not
  enforced.
- The batching tickets for the largest contributors are follow-ups filed
  from step 0's numbers, not this plan's scope.

### B6. Tests and verification

Tests: the host's sampler counts renderable objects under a layer (Mesh,
InstancedMesh as 1, Points, Line, Sprite; invisible excluded; nested
groups walked); over-budget publishes the breach once and clears when
under; `FRAME_DRAW_CALL_BUDGET` equals the sum of declared budgets + core's
named calls (a test that fails when a plugin is added without a budget —
the registry is the fixture).

Verification: HUD shows `calls / budget` and per-plugin rows in dev; the
probe reports per-plugin object counts and `renderer.info.render.calls`
per run; step 0's measured table is committed into this doc as B7.

---

## Order and NOT-list

Order: **B step 0 (measure) → A (tests, fix, bench, GPU) → B (contract,
HUD, budgets from step 0) → B step 5 (cost model) → one GPU run to
attribute the 115 ms GL stall with A's growth frames gone.** One commit per
piece.

NOT: no paging (A4); no host-side batching (B4); no `shared/` change; no
touching the job/worker pipeline; no plugin behaviour change beyond adding
its budget field; no new constant without a derivation and, for the
measured ones, the date and the run it came from.
