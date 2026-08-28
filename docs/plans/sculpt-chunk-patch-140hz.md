# Sculpt chunk patch at 140 Hz — plan

Status: PLAN v2, 2026-08-27. Third of three sculpt-performance fixes (the
first two shipped as 6a885c5 monsters survey and b09218f river rig). Measured
against `main` at b09218f on the owner's active world (frostwick-hollows,
512², 400 chunks revealed) with `client/test/zz-perf-sculpt.bench.test.ts`.

v1 was reviewed by three independent lenses (correctness, performance,
design fit) with every finding adversarially verified against source; 28 of
33 held. v2 folds them in. Where v2 contradicts v1 the review was right and
the citation is given.

The bar (owner, 2026-08-26): **≥140 fps on the owner's machine**, i.e. a
7.1 ms frame for everything — render, controls, plugin frame hooks, and any
work a sculpt triggers.

## 1. What a sculpt costs the main thread today

Per sculpt, medians over 30 sculpts (radius 4, ~37 cells, 1–2 chunks):

| stage | ms | where |
|---|---|---|
| `predictions.predict` | 0.2 | terrain/prediction.ts |
| `meshes.update` (prediction) | 18.4 | render/terrainMeshes.ts → capEmission `writeChunkVertexData` |
| `layerEdges.update` | 9.6 | render/layerEdgeOverlay.ts `rebuild` → `chunkBandContourLoops` |
| fog / water refresh (CPU) | 0.2 | — but see §3e: water re-uploads three world-sized textures per call |
| rivers refresh | 0.9 | fixed in b09218f |
| **authoritative echo** (`applyAuthoritative` + `meshes.update`) | 26.6 | the same chunks built AGAIN |

≈ 55 ms of CPU per sculpt, 8 sculpts/s during a hold. The drain queue in
terrainMeshes spreads mesh builds under `CHUNK_BUILD_FRAME_BUDGET_MS = 4`, but
"always builds at least one" means a ~10 ms chunk is a ~10 ms frame whatever
the budget says — the constant is a floor on progress, not a ceiling on cost.

Inside `meshes.update` (profile, 60 builds): `recomputeBounds` 828 ms
(**~14 ms per splice on a developed super-mesh** — it scans every live vertex
of the super-mesh, ~1.25 M on this world's busiest one; ~0.03 ms on a
barely-revealed one), then `writeChunkVertexData` 596 ms (~10 ms per chunk on
this terraced world) spread across `smoothLoop`, `loadSampleField`,
`marchLevel`, `earClip`, `chaikinPass` — no single hot spot; it is the
contour pipeline doing its job. The `spliceChunk` residual (~1 ms) is four
`copyWithin` calls moving the super-mesh tail at 19 B/vertex; it scales with
live vertices *ahead of* the edited chunk in its super-mesh, not with the
brush.

Not visible in the node bench (no renderer), named by the review:

- **Every splice re-uploads the whole super-mesh buffer.** `needsUpdate`
  without `addUpdateRange` means Three uploads the full attribute (tens of
  MB on a developed super-mesh) per splice. This is the next hot spot once
  the CPU cost is gone (§3b).
- **`water.refresh` uploads three world-sized textures per call** —
  `render/water.ts:546-548` sets `needsUpdate` on the depth-alpha, specular and
  third texture with no update range and no empty-set guard; a matching echo
  with an empty dirty set still pays it (§3e).

## 2. Root cause

A sculpt's chunk cost is **paid twice** (prediction, then the server's echo
of the same heights), **re-marches contours the chunk build already
published**, **scans and re-uploads the whole super-mesh** on every splice,
and **runs synchronously** on a thread that has ~1–2 ms to spare at 140 Hz.

## 3. The fix — five pieces

Order: e, a, b, c, d. One commit per piece; bench after each so the ledger
says what each piece bought. (e) goes first because it is three lines and
without it (a)'s win is paid straight back in texture uploads.

### e. Empty dirty sets do nothing; texture uploads are ranged (world.ts, water.ts)

- `applyDirty` returns immediately on `dirty.size === 0` (check every callee
  tolerates the skip — `frontierFog.refresh` and `water.refresh` do; rivers'
  throttle is time-based and must not be starved by the skip, so call
  `rivers.refresh` with an empty set only if its contract wants it — read it).
- `water.refresh` derives the dirty texel rows from the dirty chunk rects
  (`writeWaterDepthTexels` already walks contiguous `CHUNK_SIZE` runs,
  waterDepth.ts:587-600) and calls `texture.addUpdateRange(start, count)` on
  each of the three textures before `needsUpdate`. Gotcha from the review:
  `WebGLTextures.js:799` hard-codes `componentStride = 4` (RGBA only) —
  check the three textures' formats before relying on ranged upload; if one
  is single-channel, ranged upload silently degrades to full and the plan
  must say so.

### a. Rebuild only chunks whose rendered state changed (prediction.ts, mirror.ts)

**Contract, per source, not one filter over the returned set:**

1. Chunks contributed by cell-level writers — the prediction journal
   (`restoreToBase` / `replayPending` / `applyPrediction`) and
   `applyTerrainDiff` — are reported only if some cell's rendered state
   changed net of the call.
2. Every index `applyChunkPayload` returns (snapshot, chunkUnlock: the chunk
   AND its −x/−y/−xy back-neighbours) passes through **unfiltered**: a
   `received` transition changes what `renderSampleCell` resolves to for the
   neighbours (mirror.ts:163-190) even when no cell value changes.

**"Changed" = height OR span list.** A carve rewrites `map.columnSpans` on a
cell whose `cells[i]` is unchanged (mirror.ts:358-375); the mesh reads spans
(`sampleRenderBandSolid`, mirror.ts:150-158; capEmission.ts:1199-1213,
:1318). A heights-only compare leaves the cave mouth undrawn. prediction.ts's
own `touchedLayeredColumn` note (~426-462) is about exactly this.

**Cell granularity, mapped through `chunksDirtiedByCell`.** Never filter a
chunk by its own cells: a chunk's border wall reads the first row/column of
the next chunk, so `chunksDirtiedByCell` (mirror.ts:191-229) deliberately
marks the −x/−y/−xy neighbours of a changed cell — chunks that own no
changed cell. Its own comment: "Missing this is precisely how seam cracks
appear after an edit." The returned set is
`∪ chunksDirtiedByCell(cell)` over changed cells.

**Mechanism — net before/after over a bounded candidate set, one pass:**

- Candidate cells = the union of the pending predictions' journal indices
  (captured at entry, before `restoreToBase`) ∪ the cells the mutation
  writes. `rendered` differs from `base` only at journal cells, so this is
  complete; it is bounded by the journals and the diff, never by the map.
- At entry, snapshot the candidates' `rendered` values and (only if
  `columnSpans.size > 0`, mirroring `snapshotBaseSpans`' reasoning) their
  span lists into reused scratch. Run restore → mutate → replay unchanged
  (keep `restoreToBase`'s bulk `rendered.set(base)`). Then compare each
  candidate; changed cells go through `chunksDirtiedByCell`.
- A *per-write* compare cannot express this: a matching echo writes the cell
  twice (roll-off to base, then the server's identical value) and would mark
  it changed both times. The compare is net-of-call or it does not deliver
  "diffApply ≈ 0".
- `applyTerrainDiff` writes cells inside mirror.ts, so mirror.ts's writer
  reports its changed cells (height or spans) — the filter is a property of
  each writer, not a post-pass in `applyAuthoritative`.
- Do **not** thread a changed-flag through `setColumn` / `applyPackedSpans`
  in `shared/src/columns.ts` — they are called from inside `applySculpt` on
  the server too; a client render optimisation must not change the shared
  terrain-math API.

**Tests.** Only over-reporting caused by *unchanged* cells may be tightened;
the −x/−y/−xy neighbours of a changed cell are the seam contract and stay
asserted. No current prediction test asserts a seam neighbour
(prediction.test.ts:120, :335, :397 assert membership / `size > 0` only;
mirror.test.ts:279-310 pins `chunksDirtiedByCell` itself) — add two
prediction-level tests: (1) a stroke changing a cell on a chunk's first
row/column yields a dirty set containing the −x/−y neighbour, and a matching
authoritative echo yields an empty set; (2) unlocking an all-`SEA_LEVEL`
chunk beside a drawn neighbour dirties the chunk and its three
back-neighbours.

### b. Exact per-chunk bounds, ranged uploads (terrainMeshes.ts)

**Bounds.** Track min/max XYZ per chunk over the scratch's first `count`
vertices in `spliceChunk` (one pass over ~4.5 k, not ~1.25 M), store it on
`ChunkSlot`, union the ≤64 slots of the super-mesh into an AABB, sphere =
centre + half-diagonal. Set it at the end of `bindGeometry` — a regrow
(`ensureSuperCapacity`) installs a fresh `BufferGeometry` whose sphere is
null, and Three would compute one over the whole attribute including the dead
tail; say so in the doc comment so nobody moves it back. Delete
`recomputeBounds` and its `liveVertices === 0` branch. Under (d) the worker
returns the six floats alongside the vertex count and the main thread does
not touch the vertices at all — an optimisation of an already-correct (b),
not a prerequisite.

The sphere is marginally looser than today's max-distance-over-vertices
radius; name that in the comment. Both existing bound tests still pass
(terrainMeshes.test.ts:273-288 "radius grew after a raise" and :290-305), but
read them: they encode the tight-bounds contract and are the check that the
union is exact.

*Rejected — static conservative box (v1).* Its XZ term is wrong for every
partially revealed super-mesh (most of them during exploration), it fails
the two tests above by construction, and it trades a scan for a cross-file
Y-range invariant that the review found stated wrongly twice (skirt/lift
offsets; `MIN_HEIGHT` band divisibility). The union is exact and O(64).

**Ranged uploads.** After the `set()` calls, `addUpdateRange` on all four
attributes over `[slot.offset, liveVertices)` using the *post-update*
`liveVertices` (so a shrink excludes the dead tail and a growth stops at the
capacity slack). Ranges are in **array elements**: `×3` for
position/normal/color, `×1` for `selfLit` (itemSize 1, capEmission.ts:593) —
write one `addRange(attr, startVertex, vertexCount, itemSize)` helper. The
growth path (`ensureSuperCapacity` → `bindGeometry`) creates new attributes
with no GL buffer and takes a full `bufferData` regardless — name it as
exempt. Clear ranges after render (`clearUpdateRanges`) per Three's contract.

### c. The lip overlay reads the published plan (layerEdgeOverlay.ts)

v1 said the overlay could not read the cap plan because it marches a
different field. **Wrong, verified:** the levels `b09218f` publishes
(`drawnGroundStore.chartOf(cx, cz).caps.levels[i].polygons`) are the marched
band set the overlay wants, a superset of its own `bandRange`. So:

- The overlay becomes a reader: per chunk, per published level, emit
  segments from the level's polygons, skipping a segment whose both
  endpoints are on the border (`rect !== RECT_NONE` — the published
  `ContourPoint.rect` carries what `onBorder` carried). Delete `bandRange`
  and `chunkBandContourLoops`' call from the overlay; the marcher keeps its
  one remaining consumer (the chunk build).
- **Lifecycle, the part that bites.** Charts are published when a chunk is
  *built* (terrainMeshes.ts:730), and builds are queued under a frame budget
  — `meshes.update(dirty)` does not build synchronously. A reader driven by
  the dirty set reads an absent or pre-edit chart for every deferred chunk.
  The overlay refresh is driven **per chunk by build completion** (the same
  seam (d) uses), plus a drop on `drawnGroundStore.clear()` / world reset.
  This lands with (c), not (d): (c) is wrong on its own without it.
- `neighboursKnown` (the frontier guard) stays; it reads `received`, which
  is main-thread state.
- **The grab path is synchronous and must stay so.** `sculptInput.ts:677-685`
  calls `grabbableLip(hoverTarget())` immediately after `seedLayer(...)` and
  relies on the overlay having re-marched inside that same call; a null
  `strokeGrab` aborts the gesture (:437). Decision: **derive the seeded band
  from the intent** (`targetBand`/`spanBand` are already in hand at that
  site) rather than re-querying the overlay — the intent is the source the
  overlay would have been derived from. The ordinary hover `grabbableLip`
  keeps reading the overlay's segments; it is a hover, one build late is
  invisible. If the implementer finds the intent does not carry enough to
  seed from, the fallback is a synchronous march over the 3×3 `nearbyChunks`
  neighbourhood *for the grab only* — state the cost (≤9 chunk-band marches)
  in the commit.

### d. Chunk jobs run in a worker; the main thread only splices

The chunk job = `writeChunkVertexData` + cap plan + band raster + bounds. Its
inputs are **heights, `columnSpans`, and `received`** over the chunk's
neighbourhood — not "the mirror's cells" alone (`buriedFloorBand`
capEmission.ts:1198-1213 and the per-band reload at :1318 read spans).

**Stateless jobs — no worker-side mirror.** v1's worker mirror fed by cell
writes would diverge (spans travel on the wire and in predictions; rollback
and rejoin have no clean feed) and is unnecessary. Each job message carries
its own window:

- heights: `Int16Array` over `[originX−1 .. originX+CHUNK_SIZE+1]²` — an
  18×18 window (648 B) anchored one cell before the origin. The extra ring
  is **not** margin: at the NE lattice corner the double-seam branch of
  `renderSampleCell` (mirror.ts:178-182) can pull back one row *above* the
  17×17 box when chunk (cx+1, cy−1) is received and (cx+1, cy) is not.
  Clamp to the world.
- spans: entries of `map.columnSpans` whose index falls in the window, as
  the packed layout `applyPackedSpans` already speaks; free in an uncarved
  world (`columnSpans.size === 0` short-circuit).
- received: a 3×3 bitmask of the chunk neighbourhood's `received`
  membership.
- a generation stamp (bumped on `resetWorld`).

The worker rebuilds a `TerrainMirror`-shaped view over the window (the
sampling functions take a mirror; give them a window-backed one — read
`renderSampleCell` and the sampler signatures and decide the smallest
adapter; do not fork the math).

**Answer** (typed arrays only; nothing crosses by structured clone):

- vertices: exact-size `slice`s of the worker's long-lived scratch
  (positions/normals/colors ×3, selfLit ×1), their buffers in the transfer
  list. The worker keeps its scratch for the same amortisation reason
  terrainMeshes.ts:472-485 does; transferring the scratch would detach it and
  move the doubled capacity, not the live vertices. This copy is the same
  `count`-length copy the main thread does today at :686-690, moved.
- bounds: six floats.
- band raster: `Int8Array` (transfer). `rasterizeLevels` moves out of
  `publishPlannedChunk` (terrain/drawnGroundStore.ts:204) into the job — **export it from
  drawnGroundStore.ts and import it in the worker** so fill and lookup share
  one grid geometry (the store header's contract). The store gains
  `publishRastered(chunkIdx, caps, topLevel)`; `publishPlannedChunk` stays for the
  direct path and the harnesses. Update the `rowCrossings` scratch note
  (:256-263): the invariant is per-realm, not per-`publish`.
- cap plan, flat: per level `threshold/sampleBand/capY`, then **`Float64Array`
  points** (x,z interleaved — `ContourPoint.x/z` are double-precision
  marching interpolants and the published contract, capEmission.ts:432-455,
  is "the very polygons handed to the ear clipper"; a Float32 round-trip
  makes the published polygon a different polygon and reintroduces the
  producer/consumer disagreement four water rewrites died on),
  `Uint8Array` rect flags per point, `Int32Array` loop offsets, `Int32Array`
  polygon (outer/holes) boundaries.
- lip segments: the overlay's finished `Float32Array` positions plus per-band
  ranges — the job emits what the overlay draws, so no lip point object
  exists on the main thread.

**Readers consume the flat form.** Rehydrating on splice puts the clone cost
back. The consumers to convert: `drawnGround.ts:237, :254, :264-271`
(`polygonsOfThreshold` and the outline queries), `rasterizeLevels`
(worker-side now), and the overlay. Rehydrate lazily per chunk only where a
query genuinely needs point objects, and say which.

**Scheduling.**

- At most one job per chunk in flight; a chunk re-dirtied while in flight is
  re-queued once (the in-flight answer is a correct earlier picture, same as
  today's queue). With stateless jobs there is no cross-worker ordering
  problem — a job carries its own inputs — but two answers for one chunk on
  two workers could splice out of order and the *older* one would stand: the
  one-in-flight rule is what prevents that; make it the enforced invariant,
  not an implication.
- Answers stamped with a stale generation (rejoin, world switch) are dropped.
- Pool of 2: one for the stroke's chunk, one for the neighbour a radius-4
  brush straddles. No mirrors, so pool size costs nothing but threads.
- **Main thread per answer ≈ 1 ms, not 0.3**: `spliceChunk` (the
  `copyWithin` tail move, scaling with super-mesh occupancy ahead of the
  chunk) + `publishRastered` + overlay reader refresh. Under (b) the tail
  move remains; only the bounds scan and the full upload go.
- `CHUNK_BUILD_FRAME_BUDGET_MS` → `CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5`
  (≈20 % of 7.1 ms, derived in the comment). At ~1 ms per splice that is
  roughly **one** splice per frame; "always splices at least one" keeps the
  no-starvation property and means the constant is a floor on progress, not
  a ceiling — same as today's comment says. A radius-4 brush straddling two
  chunks therefore lands over two frames; accepted and named.
- The `scheduling`/direct seam: `createTerrainMeshes` takes a build strategy
  the way the river rig takes a network source (b09218f's
  `riverNetworkSource.ts` is the pattern: direct source when no `Worker`
  global, coalescing, stale-answer drop, `dispose()` terminates). Tests,
  bench and the six `preview-*` harnesses use the direct path unchanged.
- Latency: a prediction appears one job later (~10 ms). `hoverTarget`'s
  `terrainHeightAt` reads the mirror, so the brush outline leads the mesh by
  that much. Picking marches the mirror (`terrain/picking.ts`); unaffected.
  `pickAgreesWithMesh` still pins the mesh against the march.

Rejected alternatives:
- *Micro-optimise the contour pipeline.* No hot spot (§1); a 2× win leaves a
  5 ms synchronous job in a 7.1 ms frame.
- *Lower the budget constant only.* Cannot beat "at least one chunk per
  frame".
- *`requestIdleCallback` slices.* Still main-thread; the pipeline is not
  resumable mid-chunk.
- *Worker-side mirror (v1).* See above.
- *Ping-pong the scratch buffers instead of slicing.* `ensureCapacity`
  replaces the arrays in place, so what comes back is not what was sent; a
  2-worker pool would need per-worker buffer sets and a return path for
  dropped answers — machinery for an allocation the slice already avoids.

## 4. Verification (the agent reports numbers)

1. **Bench** — `client/test/zz-perf-sculpt.bench.test.ts` (the copy under
   `~/.terrace-perf/` predates b09218f and no longer typechecks; do not copy
   it in). Against the real snapshot `~/.terrace-perf/snapshot.json` (re-dump
   from the frostwick copy if in doubt — an agent overwrote it once with a
   generated world). Extend the bench to print the super-mesh index its
   sculpt site lands in and that super-mesh's live vertex count, because
   (b)'s saving is proportional to it (0.03 ms → 13 ms across this world's
   16 super-meshes). After each piece:
   - after (e): unchanged CPU rows; the texture rows are browser-only (below).
   - after (a): `diffApply` ≈ 0.1 ms for a matching echo (was 26.6); a
     mismatching echo still rebuilds exactly the differing chunks.
   - after (b): `meshes` − the bounds scan (≈14 ms on a developed
     super-mesh).
   - after (c): `layerEdges` ≈ 0 on the bench (its CPU is the march).
   - after (d): the bench runs the **direct** path in node and can only
     report the direct-path total; the ≤1.5 ms main-thread claim is reported
     **from the browser** — add a per-answer timing counter around splice +
     publishRastered + overlay refresh, exposed the way the in-page probe
     reports `fpsMean`, so §4.4 emits a median splice ms alongside fps.
2. **Tests** green: `terrainMeshes`, `pickAgreesWithMesh`, `prediction` (+
   the two new seam/unlock tests), `vertexGrid`, `drawnGround`,
   `waterCurtain`, `waterFallIntegration`, layer-edge tests; `pnpm typecheck`
   clean; `npx vite build` emits the chunk worker as its own chunk.
3. **Eyes-on**: `preview-*` fixtures before/after (headless CDP recipe);
   terrain, lips and water unchanged.
4. **Real-GPU run** (`~/.claude/terrace-gpu-probe.sh`, Windows Chrome, vsync
   off) at **stroke zoom near `CAMERA_MIN_DISTANCE`** (at full-world view
   nothing is culled and (b)'s cull delta is identically zero): fps mean and
   1 % low during a 5 s held stroke on the owner's world, before and after,
   plus `renderer.info.render.calls` / `.triangles` after (b). This is the
   number the bar is written in; the bench is attribution only. The rig is
   flaky on window focus — repeat until a run reports
   `ANGLE (NVIDIA … Direct3D11)` and an `fpsMean` line.

## 5. Residuals, named

- If the GPU run still misses 140 during a stroke, the next step is to read
  `renderer.info` (calls AND triangles) with the plugins live and attribute
  from there. Terrain is 16 calls / 1.76 M triangles on this world (~110 k
  per call, already past the draw-call-budget tell); water, rivers, the
  overlay and every plugin's objects are not covered by `drawCallCount()`.
  Do not pre-name a suspect.
- A chunk whose job is in flight draws its previous geometry for ~10 ms; the
  brush outline leads the mesh by that much. Accepted.
- A two-chunk brush lands over two frames at the 1.5 ms splice budget.
  Accepted; the alternative is a heavier frame.
- Ranged texture upload silently degrades to full for non-RGBA textures
  (§3e) — the implementer reports which of the three it applies to.

## 6. What this plan must NOT do

- Re-march band contours anywhere off the chunk job.
- Post plan/loops as plain objects across the worker boundary.
- Change `shared/` APIs for a client render optimisation.
- Filter `applyChunkPayload`'s dirty chunks.
- Make the lip-grab seed path asynchronous.
