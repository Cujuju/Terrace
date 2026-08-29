# Vertex arena: a splice never moves the tail — plan

Status: PLAN v2, 2026-08-28. Follow-on to `sculpt-chunk-patch-140hz.md` §7,
which measured the five chunk-patch pieces on the real GPU and found the bar
(≥140 fps, i.e. every frame under 7.1 ms, owner 2026-08-26) still missed at
p95/p99 during a held stroke.

v1 was reviewed by three independent lenses (correctness, performance, design
fit) with every finding adversarially verified against source: 26 held, 7
refuted. v2 folds them in; where v2 contradicts v1, the review was right.

## 1. The measured defect

`.gpu-perf/results/` (RTX 3090, owner's world, radius-4 stroke held 5 s at
`CAMERA_MIN_DISTANCE × 1.05`), per-frame attribution over the slowest 1 %:

| | value |
|---|---|
| stroke msMean / p95 / p99 | 2.2 / 9.2 / 22.5 ms |
| upload on a slow frame | 19–21 MB (`bufferSubData`, all four attributes) |
| upload on the frame before it | ~18.8 MB |
| JS on a slow frame that still lasts 22–46 ms | ~3 ms |
| draw calls / triangles (slow vs normal) | flat: 251 / 3.06 M |

The slow frames are transfers, and the frames after them are the main thread
stalled while the GPU process copies the previous transfer. No JS timer sees
the second half; only the frame interval does.

**The buffers are 19 B/vertex** (`createChunkGeometryBuffers`,
capEmission.ts:585-593: Float32×3 positions, Int8×3 normals, Uint8×3 colors,
Uint8 selfLit — "57 B per triangle since the 2026-08-20 vertex-format
compression"). 19–21 MB is therefore ~1 M vertices — essentially the whole
1.25 M-vertex super-mesh, twice per step for a two-chunk brush. v1 said 37 B
and "500 k from the end"; both wrong.

**Run sizes on the owner's world** (measured 2026-08-28 over all 400 received
chunks with the direct build source): min 6, **p50 5 388, p90 38 787, p99
104 850, max 141 954** vertices; 5.27 M total. The hard ceiling is
`CHUNK_TRIANGLE_BUDGET = 131 072` triangles = 393 216 vertices = 7.5 MB
(capEmission.ts:310). These numbers drive every constant below.

## 2. Root cause, one sentence

`spliceChunk` (render/terrainMeshes.ts:723) keeps a super-mesh's chunk runs
**packed in chunk-index order**, so a chunk whose vertex count changes moves
every run after it (`copyWithin`, :757-760) and the ranged upload has to
cover `[slot.offset, liveVertices)` (:803) — ~1 M vertices × 19 B per stroke
step on this world's busiest super-mesh.

The contract that prevents recurrence: **a splice's upload is bounded by the
chunk it splices (and, during compaction, by one moved run), never by the
super-mesh** — no chunk's splice relocates another chunk's run.

## 3. The fix — the super-mesh becomes an arena

The buffers keep one draw range `[0, liveEnd)`, one draw call per super-mesh
(the draw-call budget stays exactly where b09218f/3f49fdb left it), and one
material. What changes is the placement rule and who owns the dead space.

### 3a. Two quantities, two names (this is a rename, not an addition)

`SuperMesh.liveVertices` today means three things at once: the sum of slot
counts, the arena extent and the draw range. Under the arena the first splits
from the other two. **Rename the field to `liveEnd`** — the extent: what
`bindGeometry`'s `setDrawRange(0, …)` (:573), `ensureSuperCapacity`'s four
preserving copies (:609-612) and `spliceChunk`'s `setDrawRange` (:812) all
want. The sum of counts becomes `liveCount(sm)`, a derived value used by
`arenaStats()` and the tests only. Adding `liveEnd` *beside* `liveVertices`
would leave :573 and :609 silently truncating the arena at the count sum —
that is why it is a rename.

### 3b. Placement — decided first, capacity second

For a splice of `count` vertices into a chunk whose run is `[offset, offset+old)`:

1. **Same count** (`count === old`): overwrite in place. Upload = the run.
2. **Shrink** (`count < old`): overwrite in place; `[offset+count,
   offset+old)` becomes a hole (§3c). Upload = the run + the hole.
3. **Grow, and the run ends at `liveEnd`** (`offset + old === liveEnd`):
   extend in place, `liveEnd += count − old`. No hole. Upload = the run. This
   is the common case for a one-chunk super-mesh (every `setup()` in
   terrainMeshes.test.ts, every `preview-*` harness) and it is what keeps
   those hole-free; v1 lacked it and would have re-appended the only run on
   every step.
4. **Grow, first-fit**: the lowest hole with `length ≥ count`. The run moves
   there; the hole is **split**: `{offset: h.offset+count, length:
   h.length−count}` replaces it (dropped at length 0); the old run
   `[offset, offset+old)` becomes a hole. Upload = new run + zeroed surplus +
   zeroed old run (three ranges; three merges only adjacent ones —
   WebGLAttributes.js:119 `range.start <= prev.start + prev.count + 1` — so
   disjoint ranges stay separate `bufferSubData` calls and the bound holds).
5. **Grow, append**: no hole fits. **Only here** does capacity matter:
   `ensureSuperCapacity(sm, sm.liveEnd + count)` — `count`, never `delta`;
   `delta` is what the packed layout needed and it under-requests by `old`
   (a 4 500 → 4 800 regrow would `set()` past the buffer and throw
   `RangeError` inside the frame hook). Before doubling, **compact first**:
   if holes exist, run the compactor to exhaustion (§3d, no budget — this is
   the one place a full sweep is cheaper than the alternative, a full
   `bufferData`), then re-test capacity. Then place at `liveEnd`,
   `liveEnd += count`, old run → hole. Upload = new run + zeroed old run.
   `grew` = "the buffers were reallocated", i.e. that call's return value.

A chunk arriving for the first time is case 4 or 5 with `old = 0`.

`order` — the chunk-index-sorted array whose only purpose was "the runs that
follow" (:387-393) — goes away. "The run that starts at X" is an O(64) scan
over `sm.slots`, the same shape `updateBounds` already uses; nothing outside
terrainMeshes.ts reads `order` (grep).

### 3c. Holes and the free list

A hole is zeroed in all four attributes: `positions` all 0 → every triangle
is a point at the world origin, zero area, no fragments
(`Ray.intersectTriangle` rejects `DdN === 0`, so raycasts cannot hit one
either; the terrain's pickers march the mirror anyway — plugins/host.ts:165).
Zeroing the other three attributes too costs 7 of 19 B per hole vertex and
makes a hole one recognisable byte pattern; a deliberate trade.

`holes: Hole[]` per super-mesh, `{offset, length}`. **Invariants, enforced
by one `insertHole`/`takeHole` pair and asserted in tests:**

- sorted by offset; **coalesced** — adjacent holes merge on insert;
- **aligned** — every `offset`, `count` and `length` is a multiple of
  `VERTICES_PER_TRIANGLE`, which is what makes the degenerate-triangle
  argument true (a hole that split a triangle would draw a sliver);
- **the retreat rule is an invariant of the list, not of insertion**: after
  ANY mutation (insert, split, merge, compaction move), if the highest hole
  ends at `liveEnd`, drop it, `liveEnd = hole.offset`, `setDrawRange(0,
  liveEnd)`. No upload — those vertices leave the draw range instead;
- dead space is **defined** as `liveEnd − liveCount(sm)`, and a test compares
  it to the free list's total so a leaked remainder fails instead of hiding;
- bounded: ≤ one hole per run + 1 ≤ 65 entries.

### 3d. Compaction — its own seam, its own budget

**Where.** Not inside `drain`: `drain` returns at :970 when `pending` and
`ready` are empty and again at :993/:995 — a settled frame never reaches
anything placed "after the splices", and a stroke frame's first splice
(medianSpliceMs 1.4–1.7 vs `CHUNK_SPLICE_FRAME_BUDGET_MS` 1.5) already spends
the splice budget. The frame hook (:1046) becomes
`drain(CHUNK_SPLICE_FRAME_BUDGET_MS); compact(budgetForThisFrame)`. `flush()`
ends with `compact(Infinity)` — "build everything now" means "and leave no
holes", which is what the tests, the bench and the six preview harnesses
(all on the no-scheduler path, where `update` → `flush`, :1057) get. §8 is
amended accordingly: the frame hook and `flush` are touched for exactly this.

**What one move is.** Take the lowest hole `h`. Find the run starting at
`h.offset + h.length` (O(64) scan). If there is none, the hole is the highest
one and ends at `liveEnd` — the retreat rule already removed it; `compact`
re-reads the list. Otherwise `copyWithin` the run down to `h.offset` (source
and destination may overlap; `copyWithin` is specified for that), set that
slot's `offset`, zero the vacated `[h.offset+run.count, oldRunEnd)`, replace
`h` with a hole there (merging forward into the next hole if adjacent), apply
the retreat rule, `needsUpdate` + `addVertexRange` over `[h.offset,
oldRunEnd)` on all four attributes, `setDrawRange`. Upload = one run + one
hole. Slot bounds are untouched (a move changes where a run lives, not what
it contains).

**Budget.** A transfer costs ≈ 1 ms per MB all-in on the owner's machine
(§1: 19–21 MB frames spend 3.5–12 ms in `bufferSubData` and roughly as much
again in GPU-process backpressure on the next frame). At 19 B/vertex that is
**`ARENA_TRANSFER_MS_PER_VERTEX = 19 / 1e6`** — a measured constant, named
with its provenance and the date. `compact(budgetMs)` moves runs in
free-list order while `estimatedMs(run) = run.count ×
ARENA_TRANSFER_MS_PER_VERTEX ≤ budgetMs − spent`, skipping (not splitting —
a half-moved live run draws garbage) any run that does not fit and trying the
next hole; a skipped run waits for a frame with more budget:

- `ARENA_COMPACT_STROKE_BUDGET_MS = 1.0` on a frame that spliced: the
  7.1 ms frame minus the measured idle render (~1.7 ms), the splice budget
  (1.5), plugins (~0.5) and the same again held back for the next frame's
  backpressure. Moves runs ≤ ~52 k vertices (above p90).
- `ARENA_COMPACT_IDLE_BUDGET_MS = 3.0` on a frame that did not splice: the
  same arithmetic without the splice. Moves any run on this world (max
  142 k ≈ 2.7 ms); the `CHUNK_TRIANGLE_BUDGET` ceiling (393 k ≈ 7.5 ms)
  would never fit and is the named residual in §5.

**Convergence, not a hole constant.** v1's `ARENA_MAX_HOLE_VERTICES = 2 ×
the largest run seen` was a runtime quantity, not a bound. The honest
statements: the dead space after any splice history is ≤ Σ over slots of
that slot's previous count (each run leaves at most its old self behind, and
coalescing never grows the total); one full sweep of ≤ 63 moves retires every
hole (the lowest hole is carried past one run per move and absorbs each hole
it meets); a stroke opens ≤ 2 holes per step at ≤ 8 steps/s while the
compactor closes ≥ 1 per frame whenever a fitting run exists. What the tests
assert is convergence (§6), and what the bench/probe report is the dead
fraction (`arenaStats`), so the vertex-shader cost of holes — proportional
to dead vertices, ~1.4 ms of idle render for 3 M triangles today — is
observed rather than assumed.

### 3e. Ranged uploads on a regrow frame

`bindGeometry` installs new `BufferAttribute`s on a regrow, and three's
`createBuffer` path (`WebGLAttributes.update`, `data === undefined`) does a
full `bufferData` **without** clearing `updateRanges` — only `updateBuffer`
clears them. Any range added on that super-mesh in the same frame is
uploaded again next frame. Today's `if (!grew)` covers the one splice that
grew; the arena has two range producers per frame (splices and compaction),
so **a super-mesh that reallocated this frame adds no ranges for the rest of
the pass** — track it on the `SuperMesh` (`reallocatedThisPass`), reset by
the frame hook.

### 3f. What stays exactly as it is

- `ChunkSlot` bounds and `updateBounds` (exact union of ≤64 boxes).
- `addVertexRange`'s element/vertex unit handling; the growth path's full
  `bufferData` exemption (its frequency is now governed by compact-before-grow).
- The job/worker pipeline, `receive`/`submit`/`drain` internals/`retry`
  (3f49fdb, 93178b5, 470e7c3), `onChunkDrawn`, `publishRastered`.
- `drawCallCount()` and one draw call per super-mesh.

## 4. Rejected alternatives

- **Fixed-capacity slot per chunk.** Sized for the worst chunk
  (`CHUNK_TRIANGLE_BUDGET` = 393 k vertices) it is 64 × 7.5 MB ≈ 480 MB of
  buffer and ~8.4 M submitted triangles *per super-mesh*; sized for
  `INITIAL_CHUNK_TRIANGLE_CAPACITY` (1 024 triangles) it cannot hold the p50
  chunk (5.4 k vertices = 1.8 k triangles). The comment at
  terrainMeshes.ts:705-717 argues this with pre-2026-08-21 numbers (a 4-cell
  `CHUNK_SIZE`); the implementer rewrites it with the current constants in
  the same commit.
- **`geometry.groups` per live run, holes skipped by the GPU.** Needs a
  material *array* before three honours groups (three.module.js:17904,
  `Array.isArray(material)`), turns one draw call per super-mesh into one per
  run-between-holes, changes what `drawCallCount()` and every plugin that
  reads `mesh.material` sees, and buys back only the hole vertex-shader work
  that compaction already drives to zero. More contract for less.
- **Upload the moved tail in ranged pieces across frames.** Same bytes,
  spread; the stall moves, it does not go.
- **Move the regrown chunk to the end and never compact.** `liveEnd` walks
  toward capacity by one run per regrow; dead space grows to the live size;
  the full-buffer growth upload lands mid-stroke. Compaction is what keeps
  the arena bounded.
- **A fixed hole constant** (v1). Either a runtime maximum that cannot fail
  or a number with no derivation; replaced by convergence + observation.
- **Splitting a large compaction move across frames.** A partially moved
  live run draws garbage between the pieces; skipping the run until an idle
  frame is the correct shape.

## 5. Residuals, named

- **Capacity growth is still one full `bufferData`** (`ensureSuperCapacity`
  → `bindGeometry`): 1.25 M × 19 B ≈ 24 MB on the busiest super-mesh, one
  stall. With extend-in-place, first-fit and compact-before-grow it happens
  only when the live geometry genuinely outgrows the buffer; how often is
  not derivable in advance and is reported by `arenaStats` (growth count).
  The same path is why streaming a 400-chunk world uploads 5.4 GB in 3.7 s;
  its own ticket (pre-size from the chunk count and the measured p50).
- **Runs above ~150 k vertices are never compacted past** (the idle budget
  moves ≤ ~157 k); the hole before such a run persists until that run
  itself regrows or shrinks. Bounded by that run's own previous size; none
  exist on the owner's world today (max 142 k).
- **Large chunks are still large splices.** A p99 chunk's own regrow uploads
  (105 k + old) × 19 B ≈ 4 MB ≈ 4 ms. The arena bounds the upload by the
  chunk; it does not make the chunk smaller. If p99 chunks still miss the
  bar, the next lever is the chunk's geometry, not its placement.
- Dead vertices between compaction passes still run the vertex shader;
  bounded by Σ previous counts, observed via `arenaStats`, not asserted as
  a number.

## 6. Tests — the contract, not the callsites

**Introspection seam, decided here:** `TerrainMeshes.arenaStats(): {
liveEnd, liveCount, deadVertices, holeCount, growths }[]` per super-mesh
(test/bench/probe seam; `deadVertices = liveEnd − liveCount`), plus a
test-only `arenaLayout()` returning `{slots: {chunkIdx, offset, count}[],
holes: {offset, length}[]}` so the invariants below are checkable without a
cast into the module.

`client/test/terrainMeshes.test.ts` pins the packed layout in three places
that are now the *old* contract and must be rewritten, not deleted:

- `patches one chunk without disturbing the others packed beside it` (:162)
  **keeps its equivalence oracle**, restated for an unordered arena: after a
  history containing at least one shrink, one first-fit reuse and one
  compaction move, for every slot the run `[offset, offset+count)` of all
  four attributes equals that chunk's run in a from-scratch build of the
  same heights (compare per slot, not by buffer position). This is the test
  that catches a bad `copyWithin` length, a ×3/×1 unit slip on `selfLit`, or
  zeroing one vertex too many; the upload-size test below cannot.
- `grows and shrinks the draw range …` (:222) → the draw range covers every
  live vertex (`drawRange.count === liveEnd ≥ liveCount`). The compaction
  half of the old assertion moves to the **scheduled** block
  (`scheduledSetup` + `clock.frame()`), which is the only block with a frame
  hook: after N idle frames, `deadVertices === 0` and `liveEnd === liveCount`.
- `draws only the emitted prefix of the buffers` (:209) → unchanged in
  spirit; the prefix is `liveEnd`.

New, contract-level (write FIRST — owner rule — then make the arena pass):

- **Upload bound.** Call `clearUpdateRanges()` on all four attributes, then
  splice a regrow of a chunk with 60 runs after it; assert exactly two
  disjoint ranges per attribute (new run, old run; ×3 elements for
  position/normal/color, ×1 for selfLit) and no range reaching past
  `offset+count` of either. (The headless suite has no renderer, so nothing
  else clears ranges — the explicit clear is what makes the assertion
  observable.)
- **Hole invariants** after an arbitrary splice history: every vertex not
  inside a slot run is zero; holes sorted, coalesced, aligned to
  `VERTICES_PER_TRIANGLE`, none reaching `liveEnd`; `Σ holes.length ===
  deadVertices`.
- **Placement cases**: extend-in-place leaves no hole and moves `liveEnd` by
  `delta`; first-fit takes the lowest fitting hole, splits the surplus, and
  does not move `liveEnd`; append computes capacity from `count` (fixture: a
  super-mesh filled to just under capacity, then a regrow whose `count`
  exceeds the slack but whose `delta` does not — must not throw); append
  compacts before it grows (fixture with a hole large enough that no growth
  is needed → `growths` stays 0).
- **Compaction convergence** (scheduled block): after a stroke history,
  ≤ 63 idle frames reach `deadVertices === 0`; a run whose estimated cost
  exceeds the stroke budget is not moved on a spliced frame and is moved on
  an idle one; `compact` never touches a slot's bounds.
- **Picking with holes**: extend `pickAgreesWithMesh` with a second pass
  that sculpts a few chunks (a raise then a level, so a grow and a shrink
  both land) before the ray sweep — as it stands it never creates a hole and
  passes by construction.
- Existing bounds tests (:273, :290) unchanged and green.

## 7. Verification (the agent reports numbers)

1. `pnpm typecheck`; `cd client && npx vitest run` (447 + the new tests).
2. Bench `client/test/zz-perf-sculpt.bench.test.ts` (reads
   `~/.terrace-perf/snapshot.owner.json`): `meshes` row must not regress
   (≈5–6 ms direct path); print `arenaStats` after the 30 sculpts and after
   `flush` (expect `deadVertices` 0, `growths` 0).
3. **Real GPU** — `.gpu-perf/README.md` recipe: apply `perf-probe.patch`,
   run `gpu-probe.sh` before (the arc's base commit) and after. The numbers
   the fix is judged on: `stroke.slow1pct.uploadMBMean` (was 11–20 MB;
   expect ≈ (count+old)×19 B per touched chunk + one move — under 1 MB for
   p50 chunks, up to ~4 MB at the p99 stroke site, so report the stroke
   cell's run size alongside), `stroke.msP95`/`msP99` (were 9.2 / 22.5 ms;
   target both < 7.1), `stroke.fps1pctLow` (was 44–119; target ≥ 140),
   **`renderer.info.render.triangles`** on the stroke block (the metric dead
   vertices actually move; draw calls cannot), draw calls unchanged (~250
   with plugins). Repeat until a run reports `ANGLE (NVIDIA …)`.
4. Eyes-on: `preview-arch.html` (+ `?edges=1`, `?edges=1&view=cave&zoom=2`)
   byte-identical before/after via the headless CDP recipe.

## 8. NOT-list

- Do not touch the job/worker pipeline internals (`submit`/`receive`/
  `retry`, `chunkBuildSource.ts`). The frame hook and `flush` ARE touched,
  exactly as §3d says, and nothing more.
- Do not introduce a material array or geometry groups.
- Do not change `ChunkJobAnswer` or anything in `shared/`.
- Do not "fix" the capacity-growth upload here (§5, its own ticket).
- Do not split a compaction move across frames.
- No new constants without a derivation in the comment; the three named here
  (`ARENA_TRANSFER_MS_PER_VERTEX`, `ARENA_COMPACT_STROKE_BUDGET_MS`,
  `ARENA_COMPACT_IDLE_BUDGET_MS`) carry §3d's arithmetic and the measurement
  date.
