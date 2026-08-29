# Frame budget, next two levers: no growth in a stroke (#229), and a draw-call budget — plan

Status: PLAN v2, 2026-08-29. Follows `vertex-arena-no-tail-move.md` (shipped
64ce9cf). v1 was reviewed by three independent lenses with every finding
adversarially verified: 25 held, 7 refuted. v2 folds them in; where v2
contradicts v1, the review was right and the measurement that decided it is
quoted.

The arena met its contract on the real GPU (slow-frame upload 20–24 MB →
0.7–1.8 MB, splice 1.7 → 0.10 ms) and the bar (≥140 fps = every frame
< 7.1 ms, owner 2026-08-26) is still missed at matched scene complexity
(p95 ≈ 22–24 ms, p99 ≈ 75 ms). Two known things remain, and they are
different problems:

- **A.** A super-mesh can reallocate (`ensureSuperCapacity` → `bindGeometry`
  → one full `bufferData`) **inside a stroke**, because how much slack it
  has after streaming is an accident of the doubling ladder (issue #229).
- **B.** The per-frame baseline scales with draw calls and nothing budgets
  them. Measured on the shipped arena build (`.gpu-perf/results/arena-sink.jsonl`,
  client 688.64ce9cf, same world, same camera): 197 calls → idle
  `renderer.render` 1.55 ms; **340 calls → 3.10 ms, 44 % of the 7.1 ms
  budget at idle**, programs 60 → 90. The two runs differ only in live
  scene state (creatures, storm rigs) — plugin counts are dynamic by design.

A third suspect — one blocking GL call charged ~115 ms for 1.8 MB — is NOT
planned here. Unattributed (assumption: a write into a buffer the GPU is
still reading, or the allocation cost of a fresh GL buffer); it gets one
probe run after A lands, because A's growth frames are in the same size
class and may be the whole story.

---

## Part A — a stroke never reallocates a super-mesh

### A1. Mechanism, measured (owner's world, 400 chunks, 2026-08-29)

`createSuperMesh` (terrainMeshes.ts:1030-1040) allocates the chunk-sized
default (`INITIAL_CHUNK_TRIANGLE_CAPACITY` = 1 024 triangles = 3 072
vertices) and `ensureSuperCapacity` (:730-745) doubles **from the current
capacity** until the append fits; three's `createBuffer` then uploads the
whole capacity array. Per super-mesh after the stream (`arenaLayout()` /
`arenaStats()`):

| sm | chunks | liveEnd | capacity | slack | growths | max run |
|---|---|---|---|---|---|---|
| #5 | 64 | 1 031 550 | 1 572 864 | 541 314 | 9 | 122 385 |
| #6 | 64 | 1 183 338 | 1 572 864 | 389 526 | 7 | 141 954 |
| #9 | 64 | 915 699 | 1 572 864 | 657 165 | 7 | 75 567 |
| #10 | 64 | 1 248 378 | 1 572 864 | 324 486 | 6 | 72 114 |
| #8 / #11 | 16 | 246 k / 269 k | 393 216 | 147 k / 125 k | 7 | 47 k / 48 k |
| #4 | 16 | 109 665 | 196 608 | 86 943 | 5 | 16 263 |
| #0 | 4 | 19 536 | 24 576 | **5 040** | 3 | 5 580 |
| #1, #7, #13 | 16 | 34–43 k | 49 152 | 6–15 k | 3–4 | 5–8 k |
| others | 4–16 | ≤ 64 k | ≤ 98 k | 2–35 k | 1–4 | ≤ 9 k |

Summing every capacity the doubling ladder ever bound: **the stream uploads
≈ 289 MB in total** (19 B/vertex), over a reveal, off the stroke. v1's
"5.4 GB" was `idle.uploadMBTotal` on the pre-arena client 672.924c4a0 — a
different quantity on a different build; the same field on 688.64ce9cf is
9–17 MB. Streaming is not the problem.

The problem is the last row and the ones like it: slack is whatever the
ladder left, and where it is smaller than a regrow (sm#0: 5 040 slack, 5 580
max run), the first stroke that finds no hole appends past capacity and the
doubling lands inside the stroke — measured as ~3 MB `bufferData` frames at
stroke start, up to 505 ms (the byte count does not explain 505 ms; see the
third suspect above).

### A2. Root cause, one sentence

Slack after streaming is an accident of where the doubling ladder stopped,
so whether a stroke reallocates is decided by streaming order rather than
guaranteed.

The contract that prevents recurrence: **when the terrain is quiet, every
super-mesh holds at least `headroom(sm)` of free capacity, and capacity is
only ever grown while the terrain is quiet** (plus the correctness backstop
in the append branch, counted separately).

### A3. The fix — one rule, one seam

**Headroom.** `headroom(sm) = max(2 × largest run in sm.slots,
ARENA_HEADROOM_FLOOR_TRIANGLES × 3)`, with
`ARENA_HEADROOM_FLOOR_TRIANGLES = 2 × 13 653 = 27 306` (13 653 triangles =
40 959 vertices, the measured p90 run rounded up to whole triangles —
constants are in TRIANGLES because `createChunkGeometryBuffers` and
`ensureSuperCapacity` take triangles and every arena offset/length is a
multiple of `VERTICES_PER_TRIANGLE`). Derivation of 2×: a regrow appends at
most one new run of about the old run's size while the old run is still
live until the splice returns, and a brush straddles two chunks per step.
On the table above, every 64-chunk super-mesh already has it (slack ≥
324 k vs 2 × 142 k = 284 k); sm#0, #1, #7, #13 and the 4-chunk ones do not
and grow once — at settle, not in the stroke.

**Quiet.** The terrain is quiet for a super-mesh when (a) no `update(dirty)`
has been called for `TERRAIN_QUIET_MS = 2 × SCULPT_REPEAT_DELAY_MS =
800 ms` (a hold's slowest inter-intent gap is the first repeat, 400 ms,
config.ts; 2× keeps a slow first repeat from reading as a lifted brush) —
a timestamp `update` maintains; and (b) no chunk of that super-mesh is in
`pending`, `inFlight`, `ready` or `retry` (all four are global sets; map
each `chunkIdx` through `superIndexOf`, O(queue) per pass and the queues are
empty when it matters). `drain` returning 0 is NOT quiet — on the worker
source most reveal frames splice nothing while jobs are out, and during a
hold ~16 of every 17 frames splice nothing between intents.

**Grow.** `ensureHeadroom(sm)`: if quiet and `capacity − liveEnd <
headroom(sm)`, call `ensureSuperCapacity(sm, sm.liveEnd + headroom(sm))` and
accept its existing doubling-from-current rule — no second rounding ladder.
One super-mesh per frame at most (each is one `bufferData`; on this world
≤ 30 MB ≈ 30 ms all-in, once).

**Seam.** The frame hook becomes `drain(…); compact(…); settle()`, where
`settle()` runs `ensureHeadroom` over super-meshes with the quiet test and
the one-per-frame cap. `settle()` is public on `TerrainMeshes`; `flush()`
does **not** call it (on the no-scheduler path `update` → `flush` runs on
every sculpt step — a headroom pass there would be growth inside the stroke
and would count against the bench's `meshes` row). The bench and the
harnesses call `settle()` once after the world build; tests call it
explicitly.

**Backstop, counted.** `ensureSuperCapacity` stays in the append branch. A
growth it performs there increments `strokeGrowths` (new field on
`ArenaStats`); `growths` keeps counting all reallocations. A6 asserts
`strokeGrowths === 0` on the bench and the probe shows it on the GPU.

**Reveal path.** Chunks unlocked by reveal arrive a few per `update`
(world.ts:688); their super-meshes climb the same ladder during streaming
and get headroom at the next quiet frame. Doublings during a reveal are
streaming cost, accepted (289 MB total today).

### A4. Rejected alternatives

- **Pre-size the first allocation from the queued chunk count × a per-chunk
  prior (v1 rule 1).** Measured against the table: a p90 prior gives the
  64-chunk super-meshes 2.62 M vertices each (1.7× what they ended with)
  and the 4-chunk ones 164 k (8–40× their live size) — ≈ 320 MB of GPU
  memory and ≈ 320 MB of zeros uploaded once, to save a 289 MB doubling
  series that happens off the stroke. It also could not count the queue
  correctly (`createSuperMesh` runs from `spliceAnswer`, after `drain` has
  moved up to `concurrency` chunks out of `pending`), and it does nothing
  for reveal-streamed super-meshes. The headroom rule is what the bar
  actually needs.
- **Paged super-meshes** (a full super-mesh starts a sibling `Mesh`):
  removes the re-upload entirely but adds draw calls (~11 pages of 512 k on
  this world plus partials) and a page boundary inside the free list and
  compactor. Right answer if A3 still leaves stroke growths; wrong first
  move against a bar Part B defends by *reducing* calls.
- **Own `WebGLBuffer` at capacity, upload only the live prefix.** GPU memory
  is still capacity; a second upload path beside three's is more contract
  than the headroom rule.
- **Grow on a worker.** `bufferData` is a main-thread GL call on this
  context.

### A5. Residuals, named

- One quiet-frame hitch per super-mesh that needs headroom after a reveal
  (a `bufferData` of ≤ 30 MB on this world, ≈ 30 ms all-in at the measured
  ~1 ms/MB), paid once, off the stroke.
- A stroke longer than its headroom still grows mid-stroke; counted
  (`strokeGrowths`), not prevented.
- Capacity is never shrunk; the 64-chunk super-meshes keep 1.57 M
  (30 MB) each. Fine at 16 super-meshes; a 2048² world (256 super-meshes)
  revisits this together with paging.

### A6. Tests and verification

Tests (write first): `headroom(sm)` and its floor; a quiet super-mesh under
headroom grows on `settle()` and one over it does not; `settle()` grows at
most one super-mesh per call; a super-mesh with a chunk in `retry` or
`inFlight` is not quiet; `update` within `TERRAIN_QUIET_MS` is not quiet
(fake clock); `strokeGrowths` counts an append-branch growth and `settle`'s
does not; growth on `settle` preserves the arena (the per-slot equivalence
oracle from the arena suite). **The existing arena fixtures** (`arenaSetup`
in terrainMeshes.test.ts, e.g. "sizes an append from the run's COUNT", which
fills to `liveEnd = 3000` and asserts `growths`) keep their 3 072-vertex
default — nothing in A3 changes the initial allocation, so they stay as
they are; say so in the commit.

Verification: bench prints `growths` / `strokeGrowths` after the stream,
after `settle()`, and after 30 sculpts (expect `strokeGrowths` 0); real GPU
per `.gpu-perf/README.md`, before = 64ce9cf, after = the arc: the stroke's
first frames no longer carry the growth upload (`stroke.slow1pct.uploadMBMean`,
`msMax`, and the probe's per-frame `gl linkProgram`/upload rows), plus
`strokeGrowths` from `arenaStats` exposed through `__terraceMeshes`.

---

## Part B — the draw-call budget as a contract

### B1. Mechanism

Every plugin gets a `layer: Group` under the scene (plugins/host.ts:286-290)
and adds whatever it likes; nothing counts. Core adds objects too: terrain
(`drawCallCount()`, 16 here), frontier fog (`drawCallCount()`), water,
rivers, the layer-edge overlay, brush preview (four `scene.add`s,
brushPreview.ts:814-884), pick-debug overlay (one). The per-object cost is
`projectObject` → render list → `setProgram` → uniforms → `drawArrays`; the
arena runs above put it at 1.55 ms for 197 calls and 3.10 ms for 340 (the
spread across all runs is 0.9–10.8 µs/call — it depends on what the objects
are, and programs moved 60 → 90 between those two runs).

### B2. Root cause, one sentence

The drawing unit is whatever each plugin authors (one `Mesh` per creature,
per lamp, per rig), and no contract turns "objects I made" into "calls I am
allowed", so the frame budget is spent by whichever population is largest
at the moment.

The contract that prevents recurrence: **each plugin declares its draw
budget from its own spawn caps, the host samples every plugin's layer
against it, and a breach is a failure the developer sees in dev and the
probe reports on the GPU.**

### B3. The fix

1. **Declare.** `TerraceClientPlugin` gains `readonly drawBudget: number`:
   the maximum renderable objects its layer may hold, **derived from the
   plugin's own caps** (fire `SCAR_CAP`/`SMOKE_COLUMN_CAP`, storms
   `MAX_FUNNELS`, volcanoes `MAX_PLUMES`, mudslides `MAX_DEBRIS_INSTANCES`,
   structures `STRUCTURES_CAP`, …) plus its fixed rigs, written as an
   expression of those constants so the two cannot drift. A plugin with no
   cap for a population that grows (flora, wildlife, pilgrims, relics,
   temples, chronicle, invite, monsters' creatures) gets the cap first —
   that is the finding, and its ticket (B7). Required at the type level;
   at runtime a missing or non-finite budget is itself a breach (a
   runtime-loaded plugin, DESIGN Q6, supplies `undefined`).
2. **Count exactly what three draws, before culling.** The walk is
   `projectObject`'s rule: descend a node only while `visible !== false`
   (visibility is inherited — plugins hide subtree roots: pilgrims'
   `model.root`, temples' `standing`/`ghost`, monsters' atmosphere), count a
   node when `isMesh || isLine || isPoints || isSprite`, InstancedMesh as 1
   **only if `count > 0`** (three skips `primcount === 0`; flora, fire,
   storms, mudslides park pools at 0), and 0 for a geometry with
   `drawRange.count === 0`. Implemented once in the host as
   `countDrawObjects(root)`, used by the sampler, the test and the probe.
   Frustum culling is the only difference from `renderer.info.render.calls`;
   the HUD shows both and says which is which.
3. **Sample.** One host `onFrame` handler with its own window of
   `FPS_SAMPLE_INTERVAL_MS` (500, `client/src/config.ts:530` — reused, not
   re-exported; the fps meter's closure has no seam to share and does not
   need one). Per window: walk each mounted plugin's layer and core's named
   contributors, publish `{plugin, objects, budget}` rows to the
   plugin-keyed HUD state (`plugins/hudPanels.ts`, beside the other
   per-plugin entries; removed on `unmountPlugin` like its panels and tools)
   and the frame total `{calls: renderer.info.render.calls, objects,
   budget}` to `hudState` beside `frameRate`. A traversal of ~1 000
   objects is ~0.05 ms, twice a second.
4. **Enforce with hysteresis.** A breach is reported on the first sample
   with `objects ≥ budget` (dev: `console.error` naming plugin, count,
   budget; HUD: row red) and cleared only after `DRAW_BUDGET_CLEAR_SAMPLES
   = 2` consecutive samples below `budget × (1 − DRAW_BUDGET_CLEAR_MARGIN)`,
   `DRAW_BUDGET_CLEAR_MARGIN = 0.1` (one sample of population noise must
   not clear it; 10 % is one creature in ten). Not a throw — killing a
   plugin for a perf regression is worse than the regression.
5. **The frame total** `frameDrawBudget = Σ mounted plugins' drawBudget +
   core's named calls`, recomputed on `syncLivePlugins` (mounted ≠
   registered). Core's contributors each get a `drawCallCount()` or a named
   constant (`BRUSH_PREVIEW_DRAW_OBJECTS = 4`, …) — the same ratchet, no
   pass for core.
6. **Cost model, measured once.** A `.gpu-perf` run with N extra trivial
   meshes (N = 0, 250, 500, 1 000) at fixed scene state gives µs/call on the
   owner's machine; `FRAME_DRAW_CALL_CEILING = current calls + (7.1 ms −
   idle render at N=0) / µs-per-call` — additional calls, since the idle
   render already includes today's. Until measured, the ceiling is the sum
   of budgets.

Where: `plugins/types.ts` (field), `plugins/host.ts` (`countDrawObjects`,
sampler, hysteresis, total), `plugins/hudPanels.ts` (rows),
`state/hudState.ts` + `ui/VersionWatermark.tsx` (total beside fps),
`render/brushPreview.ts`, `render/water.ts`, `render/riverRig.ts`,
`render/layerEdgeOverlay.ts`, `render/pickDebugOverlay.ts` (named counts),
every `plugins/*/client` (one field each), `.gpu-perf/perf-probe.patch`
(the per-layer walk — it does **not** exist there yet; writing it is step 0).

### B4. Rejected alternatives

- **A global cap only.** Names the frame, not the population.
- **Budgets from one measured sample (v1's ratchet).** The 196 → 342 drift
  was the same build; a budget set from one instant breaches by
  construction the next time a population is larger. Caps are the honest
  maximum; where a plugin has none, the missing cap is the defect.
- **Enforce in tests only.** Static counts after `attach` miss every
  dynamic population; the host's live sample is the measure. A per-plugin
  static test is optional wiring.
- **Auto-batch in the host.** Instancing needs the plugin's cooperation
  (per-instance transforms/materials); batching is the plugin's job under
  its budget.
- **Kill the plugin on breach.** See B3.4.

### B5. Residuals, named

- Budgets are objects before culling; actual calls are lower when much is
  out of view. Objects are the deterministic, camera-independent unit; the
  HUD's actual-calls figure is the check, and the two are never shown as
  one ratio.
- Programs (shader variants; 60 → 90 between two runs) are not budgeted;
  observed via `renderer.info.programs`, not enforced.
- Batching for the largest populations is follow-up tickets from step 0's
  numbers (B7), not this plan's scope.

### B6. Tests and verification

Tests: `countDrawObjects` on a fixture with a visible Mesh under an
invisible Group (0), an InstancedMesh with `count 0` (0) and `count 5` (1),
Points/Line/Sprite (1 each), a `drawRange.count 0` mesh (0), nested visible
groups (walked); hysteresis (breach on the first ≥ sample; no clear after
one low sample; clear after two below the margin); the frame total follows
`syncLivePlugins`; a missing budget is a breach; every registered plugin's
`drawBudget` is finite (a registry-driven test — the type already requires
the field, so this pins the runtime shape, not the compile-time one).

Verification: HUD shows `objects / budget` and `calls`, with per-plugin
rows, in dev; the probe reports per-layer counts per run; step 0's table
(per plugin: objects at the reference scene = the owner's world with every
plugin live, at stroke zoom and at full-world view) is committed as B7.

### B7. Step 0 output (filled by the implementer)

Per plugin: measured objects (reference scene), the caps it declares, the
`drawBudget` expression adopted, and the ticket filed where a cap is
missing.

---

## Order and NOT-list

Order: **B step 0 (add the per-layer walk to the probe patch, measure,
fill B7) → A (tests, `settle()`, bench, GPU) → B (contract, `countDrawObjects`,
sampler, HUD, budgets from caps) → B step 6 (cost model) → one GPU run to
attribute the 115 ms GL stall with A's growth frames gone.** One commit per
piece.

NOT: no initial-allocation prior (A4); no paging (A4); no host-side
batching (B4); no `shared/` change; no touching the job/worker pipeline or
`flush()`'s behaviour; no plugin behaviour change beyond adding its budget
field (and a cap where one is missing, as its own commit); no new constant
without a derivation and, for the measured ones, the date and the run it
came from.
