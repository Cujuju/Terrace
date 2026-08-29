# Vertex arena: a splice never moves the tail — plan

Status: PLAN v1, 2026-08-28. Follow-on to `sculpt-chunk-patch-140hz.md` §7,
which measured the five chunk-patch pieces on the real GPU and found the bar
(≥140 fps, i.e. every frame under 7.1 ms, owner 2026-08-26) still missed at
p95/p99 during a held stroke.

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

## 2. Root cause, one sentence

`spliceChunk` (render/terrainMeshes.ts:723) keeps a super-mesh's chunk runs
**packed in chunk-index order**, so a chunk whose vertex count changes moves
every run after it (`copyWithin`, :757-760) and the ranged upload has to
cover `[slot.offset, liveVertices)` (:803) — on this world's busiest
super-mesh (1.25 M vertices, 37 B each) a chunk 500 k vertices from the end
re-uploads ~19 MB per stroke step, and a brush straddling two chunks does it
twice.

The contract that prevents recurrence: **a splice's upload is bounded by the
chunk it splices, never by the super-mesh** — runs are never relocated by
another chunk's splice.

## 3. The fix — the super-mesh becomes an arena

The buffers keep one draw range `[0, liveEnd)`, one draw call per super-mesh
(the draw-call budget stays exactly where b09218f/3f49fdb left it), and one
material. What changes is the placement rule.

### 3a. Placement

- **Same count** (`delta === 0`): overwrite in place. Upload = the run.
- **Shrink** (`delta < 0`): overwrite in place; the freed `-delta` vertices at
  the run's end become a **hole**. Upload = the run + the hole.
- **Grow** (`delta > 0`): the run does not fit where it is. Look for a hole of
  at least `count` vertices (**first-fit** over the free list, ≤64 entries);
  if none, **append at `liveEnd`** (growing capacity through
  `ensureSuperCapacity` as today). The old run becomes a hole. Upload = the
  new run + the old run.
- A chunk arriving for the first time appends at `liveEnd` (or takes a hole).
  `order` — the chunk-index-sorted array whose only purpose was "the runs that
  follow" (:387-393) — goes away; nothing else reads it (grep: no reader
  outside terrainMeshes.ts).

### 3b. Holes draw nothing

A hole is zeroed: `positions` all 0 → every triangle in it is a point at the
world origin, zero area, no fragments; normals/colors/selfLit zeroed too so a
hole is one identifiable byte pattern. The draw range still spans the arena
because holes are inside it; the vertex shader runs over hole vertices, which
is the cost §3d bounds. Raycasts cannot hit a zero-area triangle
(`Ray.intersectTriangle` rejects `DdN === 0`), and the only terrain raycast
consumers pick by marching the mirror anyway (plugins/host.ts:165,
world.pickCell). Bounds are unaffected: `updateBounds` unions slot boxes,
never reads positions, and an origin point outside the sphere draws nothing.

### 3c. Free list

`holes: Hole[]` per super-mesh, `{ offset, length }`, kept sorted by offset
and **coalesced** on insert (a hole adjacent to another merges; a hole that
ends at `liveEnd` is not a hole — `liveEnd` retreats instead, with no
upload). Bounded: at most one hole per chunk plus one per shrink, coalescing
keeps it ≤ number of runs + 1 ≤ 65.

### 3d. Incremental compaction under the splice budget

Holes are transient. Each `drain` pass, after the splices and while
`now() - startedMs < budgetMs`, **close one hole**: take the lowest hole, move
the run that starts at `hole.offset + hole.length` down to `hole.offset`
(`copyWithin`), zero the vacated tail, update that one slot's offset, merge
the hole forward. Upload = that run + the hole, the same O(chunk) bound as a
splice; a move of the largest run on this world is ~0.5 MB, ≈0.2 ms. One
move per pass; strokes open at most two holes per step at ≤8 steps/s and
the compactor closes ≥1 per frame at 140 Hz, so holes never accumulate past
a handful and the vertex-shader cost of §3b is bounded by `ARENA_MAX_HOLE_VERTICES`
— named, derived in the comment as `2 × the largest run seen`, and asserted
in a test (a super-mesh with more hole vertices than that after a settled
drain is a bug).

Compaction runs only when `pending`, `inFlight` and `ready` are empty for
that super-mesh's chunks? **No** — it runs every pass regardless, because a
hole is cheapest to close while the buffers are already dirty, and the only
thing a mid-stroke move can race is a splice to the *moved* chunk, which is
sequenced by the same single thread: a move updates `slot.offset` before
returning, and the next splice reads it. Say this in the comment; it is the
question every reader will ask.

### 3e. What stays exactly as it is

- `ChunkSlot` bounds and `updateBounds` (b: exact union of ≤64 boxes).
- `addVertexRange`, element/vertex unit handling, the growth path's full
  `bufferData` exemption (a regrow that appends past capacity still pays a
  full upload — see §5).
- The job/worker pipeline, `receive`/`submit`/`drain`/`flush`/`retry`
  (3f49fdb, 93178b5, 470e7c3), `onChunkDrawn`, `publishRastered`.
- `drawCallCount()` and the one-draw-call-per-super-mesh contract.

## 4. Rejected alternatives

- **Fixed-capacity slot per chunk.** The comment at :705-717 already rejects
  it: at `INITIAL_CHUNK_TRIANGLE_CAPACITY` a revealed world submits ~16.8 M
  triangles to draw ~4 M. The arena's dead space is bounded by §3d, not by the
  worst chunk × 64.
- **`geometry.groups` per live run, holes skipped by the GPU.** Needs a
  material *array* (`[material]`) before three honours groups
  (three.module.js:17904, `Array.isArray(material)`), turns one draw call per
  super-mesh into one per run-between-holes, changes what `drawCallCount()`
  and every plugin that sees `mesh.material` gets, and buys back only the
  hole vertex-shader work that §3d already bounds. More contract for less.
- **Upload the moved tail in ranged pieces across frames.** Same bytes,
  spread; the stall moves, it does not go.
- **Move the regrown chunk to the end and never compact.** `liveEnd` walks
  toward capacity by one chunk per regrow; holes accumulate to the packed
  size, doubling vertex-shader work and forcing a full-buffer growth upload
  mid-stroke. Compaction is what keeps the arena a bounded, not a leaking,
  structure.
- **Keep packing but reduce the tail with smarter chunk ordering** (e.g. put
  frequently-edited chunks last). The player edits where they look; there is
  no stable order.

## 5. Residuals, named

- **Capacity growth is still a full `bufferData`** (`ensureSuperCapacity` →
  `bindGeometry`): ~46 MB on the busiest super-mesh, one stall, doubling so
  it happens ≤ ~10 times per super-mesh over a world's life, and only when
  an append passes capacity. Not fixed here. The same path is why streaming
  a 400-chunk world uploads 5.4 GB in 3.7 s (§7 of the previous plan). Its
  own ticket: pre-size from the chunk count + a measured triangles-per-chunk
  prior, or grow by a fixed fraction of the world estimate.
- **Hole vertex-shader work** ≤ `ARENA_MAX_HOLE_VERTICES` per super-mesh
  between compaction passes. Bounded and asserted, not zero.
- A move may leave the compactor holding the same hole for several passes if
  the run after it is the one being spliced every step (the stroke's own
  chunk). Fine: that run's splice keeps it in place when the count is
  unchanged, and a regrow moves it elsewhere — which is exactly when the hole
  closes.

## 6. Tests — the contract, not the callsites

`client/test/terrainMeshes.test.ts` pins the packed layout in three places
that are now the *old* contract and must be rewritten, not deleted:

- `patches one chunk without disturbing the others packed beside it` (:162)
  → "a splice uploads only its own run (+ the hole it vacates)": assert over
  `attribute.updateRanges` before three clears them that the union of ranges
  ≤ `count + oldCount` vertices, for a regrow of a chunk that has 60
  neighbours after it.
- `grows and shrinks the draw range as sculpting adds and removes terraces`
  (:222) → the draw range covers every live vertex, and after a settled
  drain (flush + N idle drain passes) equals the sum of slot counts (holes
  compacted away).
- `draws only the emitted prefix of the buffers` (:209) → unchanged in
  spirit; the prefix is `liveEnd`.

New, contract-level:

- Hole invariant: after any sequence of splices, every vertex not inside a
  slot run is zero (positions), and holes are sorted, coalesced, never past
  `liveEnd`.
- Compaction bound: after a settled drain, hole vertices ≤
  `ARENA_MAX_HOLE_VERTICES`; after enough passes, zero.
- First-fit reuse: a regrow that fits an existing hole takes it and `liveEnd`
  does not move.
- Existing bounds tests (:273, :290) and `pickAgreesWithMesh` unchanged and
  green — holes must not disturb picking.

Write these FIRST (owner rule), then make the arena pass them.

## 7. Verification (the agent reports numbers)

1. `pnpm typecheck`; `cd client && npx vitest run` (447 + the new tests).
2. Bench `client/test/zz-perf-sculpt.bench.test.ts` (reads
   `~/.terrace-perf/snapshot.owner.json`): `meshes` row should not regress
   (≈5–6 ms direct path); add a print of hole vertices per super-mesh after
   the 30 sculpts and after 200 idle drain passes (expect 0).
3. **Real GPU** — `.gpu-perf/README.md` recipe: apply `perf-probe.patch`,
   run `gpu-probe.sh` before (HEAD^ of the arc) and after. The numbers the
   fix is judged on: `stroke.slow1pct.uploadMBMean` (was ~11–20 MB; expect
   < 1 MB), `stroke.msP95`/`msP99` (were 9.2 / 22.5 ms; target both < 7.1),
   `stroke.fps1pctLow` (was 44–119; target ≥ 140), draw calls unchanged
   (~250 with plugins). Repeat until the run reports `ANGLE (NVIDIA …)`.
4. Eyes-on: `preview-arch.html` (+ `?edges=1`, `?edges=1&view=cave&zoom=2`)
   byte-identical before/after via the headless CDP recipe — holes must be
   invisible.

## 8. NOT-list

- Do not touch the job/worker pipeline, the drain scheduling, or
  `chunkBuildSource.ts`.
- Do not introduce a material array or geometry groups.
- Do not change `ChunkJobAnswer` or anything in `shared/`.
- Do not "fix" the capacity-growth upload here (§5, its own ticket).
- No new constants without a derivation in the comment.
