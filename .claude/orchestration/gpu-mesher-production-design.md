# GPU mesher production design (implementation level)

Issue #445. Revision 2 (2026-09-10, updated 2026-09-11 after the review fix
pass): owner asked for implementation, so this is no longer "document only".
Supersedes revision 1 and the 2026-09-10 orchestration draft in full. Every number is a
file:line citation or a measurement; estimates are marked **[estimate]**,
unverified facts **[unverified]**, assumptions **Assumption:**.

Completion criterion (owner, this session): the GPU mesher renders at
near-identical parity to the CPU mesher, and beats it on speed and efficiency.
§11 defines both measurably.

## 0. What revision 1 got wrong, and what changed

1. **Gate 1's headline numbers were stale.** `bench/webgpu-mesher/README.md`
   reports compute p50 0.173 ms / rebuild 360 ms (headless run); the tracked
   desktop record `results/desktop/results-visible.json` says p50 0.079 ms,
   rebuild 5 ms wall / 3.0 ms GPU, and both pass. The laptop record
   (`origin/gate2-laptop:.../laptop/notes.md`) says 3.5 ms wall / 3.3 ms GPU.
   The 938 ms CPU figure is the Node single-thread build; the shipped client
   builds on a 2-worker pool and takes 7.2 s wall to an empty queue at load
   (`.gpu-perf/results/2026-09-09-worker-mesher-baseline/SUMMARY.md` §0).
2. **The §5 "edit budget overrun" was a category error.** The 2.08 ms heaviest
   3×3 window is GPU time; `CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5`
   (`terrainMeshes.ts:33`) is main-thread time. They are different budgets on
   different timelines. §7 gives the GPU path its own GPU-time budget.
3. **`ChunkGpuAnswer` with `vertexBuffer + copyBufferToBuffer` into the
   existing arena cannot work.** The arena's three.js attributes carry CPU
   shadow arrays that three re-uploads on `needsUpdate`, and compaction moves
   bytes with `copyWithin` on those arrays (`terrainMeshes.ts:353-369`). A GPU
   write into the attribute's buffer is overwritten by the next CPU-side move.
   The storage layer under the arena has to be swappable (§3).
4. **The normal attribute is dead on both paths.** `flatShading: true`
   (`terrainMaterial.ts:39`) makes three derive the normal from position
   derivatives (`NodeBuilder.js:510`, `Normal.js:43`); the attribute is never
   read. The GPU vertex carries no normal.
5. **`drawnGroundStore` cannot be "decoupled" (rev 1 §8 Q2).** Its charts feed
   the layer-edge overlay (`layerEdgeOverlay.ts:298-300`, lips) and river
   surfaces (`riverRig.ts:692`, `capYOfBand`), and lips feed carve picking
   (`world.ts:175`). The GPU path emits lip segments itself (§5.6) so no CPU
   contour march remains on the hot path.
6. **Gate 1 skipped things the CPU mesher does that production cannot skip:**
   ceilings (README known difference 1), per-level layered inside tests
   (difference 4), the unreceived-chunk seam pull-back
   (`mirror.ts:82-101`), the shoreline level's no-refinement rule
   (`contours.ts:171`), the chunk-wide level range for layered chunks
   (`capEmission.ts:145-156, 470-491`). §5 ports each.

## 1. Facts this design stands on

| fact | source |
|---|---|
| Arena = one `Mesh` per 8×8 chunks, non-indexed, attributes `position` f32×3, `normal` i8×4 (normalized), `color` u8×4 (normalized) | `terrainMeshes.ts:63`, `terrainMaterial.ts:56-65`, `capEmission.ts:65-69` |
| `spliceChunk` decides slot capacity from `vertexCount`, first build zero slack, later builds `SLOT_SLACK_FACTOR = 1.25` | `terrainMeshes.ts:69-72, 433-515` |
| Byte movement inside the arena: `positions.set`, `copyWithin`, `fill(0)`, `addUpdateRange` + `needsUpdate` | `terrainMeshes.ts:290-296, 353-369, 497-510` |
| three r185 WebGPU: an attribute's GPU buffer lives at `backend.get(attribute).buffer`; `createAttribute` only allocates when that slot is empty; `updateAttribute` uploads from `attribute.array` only when `attribute.version` moves; `destroyAttribute` destroys the buffer on geometry dispose | `WebGPUAttributeUtils.js:69-180, 187-275, 396-405`, `Attributes.js:69-113` |
| three draws `min(drawRange, geometry.attributes.position.count)` vertices; only attributes the node graph references are bound; `BufferAttribute.count` is a plain field | `RenderObject.js:513-560, 590-660`, `BufferAttribute.js:89` |
| Vertex formats derive from the array type and `normalized`; `Int16Array` ×4 normalized → `snorm16x4`, `Uint8Array` ×4 normalized → `unorm8x4`; non-normalized 16-bit is rewritten to 32-bit (unusable for a packed layout) | `WebGPUAttributeUtils.js:12-38, 84-107, 296-300, _getVertexFormat` |
| An attribute wider than the shader input is fine: the arena already binds a ×4 normal to `attribute('normal','vec3')` | shipped today |
| `positionLocal` is a varying of `positionGeometry = attribute('position','vec3')`; `material.positionNode` is assigned over it | `Position.js:33-45`, `NodeMaterial.js:802-808` |
| `renderer.backend.device` is the `GPUDevice`; `backend.isWebGPUBackend` / `isWebGLBackend` flags | `WebGPUBackend.js:88, 292`, `webglInstanceUpload.ts:14-17` |
| No WebGPU types in TS 7.0.2's lib; `@webgpu/types` is not installed; `@types/three` references `GPUDevice` under `skipLibCheck` | `tsconfig.base.json`, pnpm store listing |
| Picking never raycasts the terrain mesh | `docs/decisions/picking.md` (2026-08-21), `world.ts:pickCell` |
| `chunksDirtiedByCell` dirties every chunk whose lattice reads the cell, including the owner | `mirror.ts:103-121` |
| A chunk's lattice is 17×17 samples; the 17th row/column belongs to the neighbour | `contours.ts:12, 63-75` |
| Layered columns: `columnSampleAtBand`, `columnCoversBand`, `spanLowestBandHeight`, `spanUndersideHeight` | `shared/src/columns.ts:365-380, 483-498` |
| Owner rulings: both renderer backends and both meshers stay supported; band parity passes at ≤ 0.5 % mismatched non-exempt samples | handoff `..._c_webgpu-two-mesher-tracks.md`, #465 |
| Desktop GPU mesh: 5,207,401 tris, 187.5 MB at 12 B/vertex; CPU mesh 3,917,911 tris | `results-visible.json` |
| Desktop edit: heaviest 3×3 window 466,860 verts, 2.08 ms GPU p50 → 4.5 ns/vertex; median 115,635 verts, 0.445 ms → 3.8 ns/vertex | `results-visible.json` `/sources/gpu/edit` |
| Client stroke today (CPU worker path, desktop): p50 7.2 / p95 10.5 / p99 14.1 / max 45 ms; load 7.2 s to queue empty | baseline SUMMARY.md §0-1 |

## 2. Architecture in one paragraph

The terrain arena keeps its slot, hole, slack, compaction and scheduling logic
unchanged, but moves every byte operation behind an `ArenaStore` contract with
two implementations: the existing CPU typed-array store, and a GPU store whose
super-mesh buffers are `GPUBuffer`s injected into three.js attributes. A
`ChunkBuildSource` for WebGPU runs gate 1's compute mesher, extended to full
CPU parity, in two passes per batch of dirty chunks: a count pass whose
per-chunk totals come back asynchronously, and an emit pass that writes
directly into the arena slot the store chose. Nothing about vertices crosses
the CPU. Lips (layer-edge overlay, carve picking) are appended by the count pass
and read back with the counts. Chunks the GPU cannot take (span-page or
triangle budget) go through the existing CPU worker source and are written
into the GPU store by a CPU upload of the packed format. Machines without a
WebGPU adapter run today's CPU path unchanged.

## 3. Arena storage contract

### 3.1 `ArenaStore` (new file `client/src/render/arenaStore.ts`)

```ts
export type ArenaFrame = 'world' | 'superLocal';

export interface ArenaSlotBounds {
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
}

export interface ArenaSuperBuffers {
  /** three attributes the geometry binds; `position` always present. */
  readonly geometry: BufferGeometry;
  readonly positionAttribute: BufferAttribute | InterleavedBufferAttribute;
  /** null when the layout carries colour as a palette key inside the position (§3.3). */
  readonly colorAttribute: BufferAttribute | null;
  readonly normalAttribute: BufferAttribute | null;
  readonly triangleCapacity: number;
}

export interface ArenaStore {
  readonly frame: ArenaFrame;
  /** Cost model for compaction budgets: ms per vertex moved, plus a per-move floor. */
  readonly transferMsPerVertex: number;
  readonly moveOverheadMs: number;
  readonly material: MeshStandardNodeMaterial;
  createSuper(superIdx: number, originX: number, originZ: number, triangleCapacity: number): ArenaSuperBuffers;
  grow(superIdx: number, triangleCapacity: number, liveEnd: number): ArenaSuperBuffers;
  /** Writes an answer at `vertexOffset`; returns the slot bounds in `frame`. */
  write(superIdx: number, vertexOffset: number, answer: ChunkAnswer): ArenaSlotBounds;
  copyWithin(superIdx: number, toVertex: number, fromVertex: number, vertexCount: number): void;
  zero(superIdx: number, startVertex: number, vertexCount: number): void;
  /** The arena's `addRange` (clamped, skipped after a reallocation) lands here. CPU: update ranges + needsUpdate. GPU: no-op. */
  markRange(superIdx: number, startVertex: number, vertexCount: number): void;
  /** Estimated GPU-time cost of `write(answer)`, charged by `drain` against `frameWriteBudgetMs`. CPU store: 0 / Infinity. */
  writeCostMs(answer: ChunkAnswer): number;
  readonly frameWriteBudgetMs: number;
  /** Called by the arena at the end of its frame callback and of `flush()`; GPU store submits its encoder. */
  commit(): void;
  dispose(superIdx: number): void;
  disposeAll(): void;
  /** Frees the material; called by whoever created the store. */
  destroy(): void;
}
```

The arena also calls `releaseAnswer(answer)` (`answer.kind === 'gpu' &&
answer.gpu.release()`) on every answer it discards: generation mismatch or
unreceived chunk in `receive()` (`terrainMeshes.ts:548-549`), `ready` answers
dropped by `clear()`, and on `dispose()`. The store releases after `write`.

Rules:
- `terrainMeshes.ts` never touches typed arrays or `needsUpdate` again; every
  such line moves into `createCpuArenaStore` (same file `arenaStore.ts`),
  byte-for-byte the code at `terrainMeshes.ts:189-227, 264-296, 353-369,
  497-510` so the existing `client/test/terrainMeshes.test.ts` (which reads
  the three attributes and their update ranges through `gpuShadow`) keeps
  passing with the CPU store.
- The CPU store's `transferMsPerVertex = ARENA_TRANSFER_MS_PER_VERTEX`
  (19e-6, `terrainMeshes.ts:38`) and `moveOverheadMs = 0`, unchanged.
- `frame` decides what `updateBounds` writes: `superLocal` stores set
  `mesh.position` to the super-mesh centre at `createSuper` and keep bounds
  local; `world` stores leave `mesh.position` at the origin.
- `commit()` is called once at the end of the arena's frame callback (after
  `drain`, `compact`, `settle`) and at the end of `flush()`, so one frame's
  emits, copies and clears go out in one `queue.submit`. The arena keeps its
  own `reallocatedThisPass`/`addRange` logic (`terrainMeshes.ts:280-288`) and
  forwards accepted ranges to `markRange`.
- `drain` charges `store.writeCostMs(answer)` per splice against
  `store.frameWriteBudgetMs` in addition to the wall-clock splice budget; when
  the GPU budget is spent the remaining `ready` answers wait for the next frame.
- The store owns its material for its whole life (`destroy()`), across world
  resets (`disposeAll()` per reset); `createTerrainMeshes` destroys the store
  only when it created the default one (today's `ownsMaterial` rule,
  `terrainMeshes.ts:172-173, 814`). `warmTerrainMaterial` (`world.ts:145`)
  takes the layout so the hidden warm-up mesh carries the same attribute set.

### 3.2 `createTerrainMeshes` signature

```ts
createTerrainMeshes(group, mirror, scheduling?, buildSource = createDirectChunkBuildSource(),
                    store: ArenaStore = createCpuArenaStore())
```
`createCpuArenaStore(material = createTerrainMaterial('float32'))`.
`sharedMaterial` (today's 5th parameter, `terrainMeshes.ts:167`) moves into
the store: the material belongs to the vertex layout. `world.ts:229-235`
passes the store it built for the chosen mesher.

### 3.3 The GPU store (`client/src/render/gpuMesher/gpuArenaStore.ts`)

Per super-mesh: one `GPUBuffer`, usage `VERTEX | STORAGE | COPY_SRC |
COPY_DST`, holding the whole vertex.

| per vertex | three attributes | WGSL view |
|---|---|---|
| 8 B: `i16 x, i16 y, i16 z, i16 key` | one `InterleavedBuffer(new Int16Array(0), 4)`; `position` = `InterleavedBufferAttribute(buffer, 2, 0, true)` → `snorm16x2` at byte 0, `terrainKey` = `(buffer, 2, 2, true)` → `snorm16x2` at byte 4 | `array<u32>` 2 words/vertex: `x \| y<<16`, `z \| key<<16` |

8 B/vertex. No normal attribute (§0 item 4) and no colour attribute: `key` is a
slot in the band LUT (`bandLut.ts`, `LUT_VEC4_COUNT` = 1282), which the material
samples for both the colour and the self-lit flag (measured 2026-09-11, §8).
`position` is declared `vec3` in the shader against a two-component format,
which WebGPU fills with the format's defaults; the third component is unused
because `terrainKey.x` carries z. The two attributes share one `arrayStride` of
8 with offsets 0 and 4 (`WebGPUAttributeUtils.createShaderVertexBuffers`).

Injection: after constructing the interleaved buffer,
`backend.get(interleavedBuffer).buffer = gpuBuffer` and
`interleavedBuffer.count = triangleCapacity * 3`; the backing array stays empty
so no CPU shadow exists. The injection target is the `InterleavedBuffer`, not
either attribute, because that is what `_getBufferAttribute` resolves an
interleaved attribute to. `createAttribute` then finds the buffer and allocates
nothing (`WebGPUAttributeUtils.js:76-78`); `needsUpdate` is never set so
`updateAttribute` never runs; geometry dispose destroys the buffer through
three's own `destroyAttribute`, which is why `grow` copies old → new **before**
disposing the old geometry.

Guard (belt and braces): at the first `commit()` after `createSuper`, the store
asserts `backend.get(interleavedBuffer).buffer === gpuBuffer`; on
mismatch it throws `GpuArenaInjectionError`, which `world.ts` catches once at
mesher construction to fall back to the CPU store (§9.1). This pins the
private-API dependency to a single checked line.

Operations:
- `write(answer: ChunkGpuAnswer)`: records `answer.gpu.emit(encoder, target,
  vertexOffset)` (§6.4) into the frame encoder, then `answer.gpu.release()`;
  bounds = chunk footprint in the local frame × `[answer.gpu.minY,
  answer.gpu.maxY]` where the source sets `minY = capYOfBand(chunkLowestBand)`,
  `maxY = capYOfBand(highestBand)` (§5.2): every cap, riser bottom, rim and
  ceiling lies in that range, so the box is at most one band looser than the
  CPU's measured bounds.
- `write(answer: ChunkJobAnswer)` (CPU fallback chunk): packs positions →
  local snorm16 units and colours → LUT slots on the CPU (`packCpuAnswer`, ≤
  `FALLBACK_MAX_TRIANGLES` × 3 vertices for blocky chunks, a full chunk
  otherwise), one `queue.writeBuffer`; bounds from `answer.bounds`
  shifted into the local frame.
- `copyWithin`: WebGPU forbids overlapping `copyBufferToBuffer` within one
  buffer, so moves bounce through a scratch buffer (`GPU_ARENA_SCRATCH`, grown
  to the largest run moved): two copies per move.
- `zero`: `encoder.clearBuffer(buffer, byteOffset, byteLength)`.
- `grow`: create a new buffer at the doubled capacity, `copyBufferToBuffer` the
  first `liveEnd` vertices, build new attributes + geometry, inject, return;
  the arena disposes the previous geometry (`bindGeometry`, `terrainMeshes.ts:195-197`).
- `transferMsPerVertex = GPU_ARENA_COPY_MS_PER_VERTEX = 1e-6` (8 B at a
  conservative 12 GB/s is under a nanosecond; measured desktop/laptop bandwidth
  is ≥ 8× that **[estimate]**), `moveOverheadMs = GPU_ARENA_MOVE_OVERHEAD_MS =
  0.005` (one copy pair + JS; **[estimate]**, revisit with §11 numbers).

Position frame: `superLocal`. Local origin = super-mesh centre
`(originX + SUPER_HALF_EXTENT, 0, originZ + SUPER_HALF_EXTENT)`,
`SUPER_HALF_EXTENT = SUPER_MESH_SPAN_CHUNKS * CHUNK_SIZE * CELL_WORLD_SIZE / 2`
= 16 world units. Quantization:

| axis | unit | constant | range used |
|---|---|---|---|
| x, z | 1/1024 wu = 1/256 cell | `POSITION_XZ_UNITS_PER_WORLD_UNIT = 1024` | ±16384 of ±32767 |
| y | 1/64 wu = `BAND_WORLD_HEIGHT / 16` | `POSITION_Y_UNITS_PER_WORLD_UNIT = 64` | [-1536, 1024] |

Why these: every y the mesher emits is a multiple of `BAND_WORLD_HEIGHT/16`
(caps `k·BWH`, seabed sink `1/64`, rim `capY − 1/64`, shore 0), so y is exact;
x/z at 1/256 cell keeps the same world point rounding identically in two
neighbouring super-meshes because chunk origins are whole multiples of the
step; 1/2048 wu would need 65537 values across the 32 wu extent and does not
fit i16. 1/256 cell against the contour's 1/1024-cell corner clearance means
the thinnest tread collapses to a zero-width sliver, which is 0.07 px at the
closest camera (`CAMERA_CLOSEST_VIEW_WORLD_UNITS = 10`, 55° FOV, 1200 px →
0.0035 wu/px).

Material (`createTerrainMaterial('snorm16')`): `compose(material, 'position',
() => vec3(position.x, position.y, terrainKey.x).mul(SNORM16_MAX).round()
.mul(vec3(1/1024, 1/64, 1/1024)))` with `SNORM16_MAX = 32767`; `round` recovers
the integer exactly since the hardware returns `n / 32767` in f32. Colour and
self-lit alpha come from an RGBA8 `DataTexture` of `LUT_VEC4_COUNT` × 1 texels,
`NearestFilter`, no colour space, sampled at
`(round(terrainKey.y · SNORM16_MAX) + 0.5) / LUT_VEC4_COUNT`: rgb replaces
`vertexColor().rgb` and alpha replaces `vertexColor().a` for this layout only,
so ground shade and reveal clip compose exactly as today. Its bytes are
`quantizeChannel` of the palette floats, which is the CPU path's own rule, so a
slot decodes to the byte triple the CPU mesher would have written. A triangle's
three vertices always carry the same key, and the `round` absorbs any
interpolation error before the texel is picked. `packCpuAnswer` maps a CPU
vertex's RGBA bytes back to a slot through a reverse map built once from those
bytes; a quadruple the map does not hold is a programming error and throws.

## 4. Build-source contract

### 4.1 `chunkBuildSource.ts` changes

```ts
export interface ChunkBuildSource {
  build(mirror, chunkIdx, generation): ChunkAnswer | null | Promise<ChunkAnswer | null>;
  readonly concurrency: number;
  /** Answers held (in flight + ready) before the arena stops submitting. */
  readonly backlogCap: number;
  dispose(): void;
}
export type ChunkAnswer = ChunkJobAnswer | ChunkGpuAnswer;
```
Existing sources set `backlogCap = CHUNK_ANSWER_BACKLOG_CAP` (8, `terrainMeshes.ts:36`,
the constant moves to `chunkBuildSource.ts`). The arena reads
`buildSource.backlogCap` at `terrainMeshes.ts:607`.

### 4.2 `ChunkGpuAnswer` (`client/src/render/gpuMesher/gpuChunkAnswer.ts`)

```ts
export interface GpuEmitTarget {
  readonly positions: GPUBuffer; readonly colors: GPUBuffer;
  readonly localOriginX: number; readonly localOriginZ: number; // world units, super-mesh centre
}
export interface GpuEmitHandle {
  readonly minY: number; readonly maxY: number;                 // world units, from the level range
  emit(encoder: GPUCommandEncoder, target: GpuEmitTarget, vertexOffset: number): void;
  /** Returns the batch window entry to the pool. Idempotent; emit() releases implicitly. */
  release(): void;
}
export interface ChunkGpuAnswer {
  readonly kind: 'gpu';
  readonly generation: number; readonly chunkIdx: number;
  readonly vertexCount: number;
  readonly plan: FlatCapPlan;          // levels only, no polygons (§5.6)
  readonly topLevel: Int8Array;        // empty; `topLevelIndexAt` has no consumer
  readonly lips: ChunkLipSegments;     // from the count-pass readback
  readonly gpu: GpuEmitHandle;
}
```
`ChunkJobAnswer` gains `readonly kind: 'cpu'` (set in `buildChunkAnswer`,
`chunkJob.ts:226`). `spliceAnswer` (`terrainMeshes.ts:561-581`) is unchanged
apart from the type: it publishes `plan/topLevel/lips` and calls
`spliceChunk`, which calls `store.write`.

### 4.3 Batching

`build()` is called once per chunk inside `drain()`'s submit loop
(`terrainMeshes.ts:605-613`). The GPU source appends to `pendingBatch` and
schedules `queueMicrotask(flushBatch)` once; all `build()` calls of one drain
therefore share one count dispatch. `concurrency = backlogCap =
GPU_BATCH_CHUNKS = 64`: at load this is 16 batches for a 512² world; a 3×3
stroke window (9 chunks) is one batch. Justification for 64: count-pass GPU
cost is ~4.5 ns/vertex (§1) and the world's mean chunk is ~15,000 vertices
(15.6 M / 1,024), so a full batch counts in ~4.5 ms GPU — one frame of GPU
time at load, where the CPU path already hitches (max splice 6.2 ms).

## 5. The kernel: gate 1 plus parity

Source: gate 1's `MESH_WGSL` (`mesher.html:158-622`) transliterated into
`client/src/render/gpuMesher/mesherWgsl.ts` as a template over the shared
constants (`BAND_HEIGHT`, `DRAWN_GROUND_BAND_BIAS`, `CELL_WORLD_SIZE`,
`BAND_WORLD_HEIGHT`, `SEABED_CAP_SINK`, `SEABED_RISER_BORDER_WORLD_HEIGHT`,
`SHEER_RISE_HEIGHT_UNITS_PER_CELL`, `SHEER_WALL_SPREAD_CELLS`,
`ISOLINE_SAMPLES_PER_CELL`, `DRAWN_GROUND_COORD_DENOM`, `BEDROCK_FLOOR`,
`OPEN_COLUMN_SAMPLE`, `SEA_LEVEL`, `CHUNK_SIZE`, `SUPER_MESH_SPAN_CHUNKS`).
`bench/webgpu-mesher/` stays untouched. The marching table
(`marching.mjs`) is ported to `marchingTable.ts`; the band LUTs
(`dump.mjs:167-190`) to `bandLut.ts`, built from `TERRAIN_PALETTE`,
`CLIFF_PALETTE`, `bandPaletteIndex`, `isSeabedPaletteIndex`,
`isEmissivePaletteIndex` (`bandColors.ts`).

Changes from gate 1, each one a parity item:

### 5.1 Inputs: one resolved lattice per chunk, per batch

The kernel reads no world-sized buffer. For every chunk in a batch the CPU
extracts the 17×17 lattice the CPU mesher would march — `sampleRenderHeight`
and the resolved cell's spans through `renderSampleCell` (`mirror.ts:57-101`,
the unreceived-neighbour seam pull-back included) — plus the chunk-level
values `makeLevels`/`planChunkCaps` derive (`capEmission.ts:145-156,
470-491, 535-546`): `layered`, `floorBand`, `chunkLowestBand`, `highestBand`.
Those are computed with the CPU's own functions on the main thread (289
samples, ≈ 20 µs **[estimate]**) and uploaded into a **window entry**:

| region (per entry) | size | content |
|---|---|---|
| `lattice` | 289 × i32 | resolved sample heights |
| `latticeDesc` | 289 × u32 | `spanCount << 16 \| pairOffset` within the entry's pairs; 0 = single implicit span `[BEDROCK_FLOOR, height)` |
| `spanPairs` | `WINDOW_SPAN_PAIRS = 2048` × 2 i32 | `(floor, ceiling)` of layered samples; a window needing more is over budget (§9.2) |
| `entry` header | 16 × i32 | `chunkIdx, layered, chunkLowestBand, highestBand, originXCells, originZCells, localOriginXUnits, localOriginZUnits, vertexBase, …` |
| `squareBase` | 256 × u32 | count pass writes per-square vertex counts; emit pass reads bases |
| `chunkStats` | 4 × atomic u32 | `vertexCount, lipCount` |

Entries live in a pool of `GPU_WINDOW_POOL = 2 × GPU_BATCH_CHUNKS` (128,
≈ 2.6 MB) and are held from the count dispatch until `release()`, so the emit
pass reads exactly the inputs the count pass counted, whatever later batches
upload. This closes the race where a chunk dirtied again between count and
emit would be re-marched on newer heights against stale per-square counts
(a slot overrun). Belt and braces in the kernel regardless: the emit pass
never writes past a square's counted range and zero-fills any unused
remainder, so a mismatch can only ever produce degenerate triangles.

Bindings (group 0): `0 lattice`, `1 latticeDesc`, `2 spanPairs`, `3 entries`,
`4 squareBase`, `5 chunkStats`, `6 marchTable`, `7 lut`, `8 params`
(`mode`), `9 lips` (append: `entry, band, ax, az, bx, bz`), `10 lipCounter`.
Group 1 (emit only): `positions`, `colors` of the destination super-mesh.
Gate 1's `clampCell`, `globalLayered`, `chunkLayered` atomics and
`BORDER_EPSILON` are gone: the CPU resolved the lattice, and the world's far
edge needs no nudge in a local frame with i16 headroom (the nudge served the
bench page's world-frame clamp and its band pass).

### 5.2 Level range and inside test (README differences 4 + chunk range)

Chunk-level values come from the entry header (§5.1): `layered =
buriedFloorBand(...) !== null`, `chunkLowestBand = min(lowest sample band,
floorBand)` when layered else the lowest sample band, `highestBand` — exactly
`makeLevels`' `lowestBand`/`highestBand` (`capEmission.ts:145-153`), computed
by calling those same CPU functions.

Per square: `lo = layered ? chunkLowestBand : min corner bands`,
`hi = max corner bands`. Levels `lo..hi`, shore after level 0. Inside test
for every level: `levelHeight(corner, level) + bias >= threshold` where
`levelHeight` is `cellHeight` for unlayered chunks and `columnSampleAtBand`
for layered ones, `bias = BAND_BIAS` (0 for shore) — the CPU's
`marchLevel` inside test (`contours.ts:158-159`) on the CPU's per-level field
(`capEmission.ts:539-544, 557`). Gate 1's `bands[c] >= level` is removed;
`drawnBandAtCell` is no longer needed.

Why an interior square can keep `lo = min corner band` when unlayered: every
level below a square's minimum corner band covers the square entirely and
the CPU emits that full cap too, with no risers since a fully-inside square
has no contour. Such a cap is seen only where drawn terrain ends: in
perspective the stack of lower caps projects clear of the top cap, and the
missing stack showed as background at the rim of the received region
(10,237 pixels, 2026-09-11). Ray-casting those pixels against the CPU
triangles showed the exposure is a property of the chunk, not of a chunk
side: the leak runs toward the undrawn diagonal the camera looks from, and
reaches two to four squares in, a view-angle function no lattice inset
bounds. So a chunk with any of its eight neighbours unreceived or off-world
(`ENTRY_EXPOSED`, `exposedChunk` in `terrainGpuInputs.ts`, from
`mirror.received`) marches every square from `chunkLowestBand`, like a
layered chunk; every other square keeps its own minimum. Cost is the drawn
region's perimeter (264 MB against 226 MB with no rule and 396 MB marching
every chunk from its floor, bench world at the default pose), and only the
world-edge ring pays once a world is fully revealed. Known slack: when a
neighbour unlocks later, chunks east and south of it are not dirtied
(`mirror.ts:192-197` dirties west/north readers only), so they keep their
stack, hidden and harmless, until their next rebuild.

### 5.3 Shoreline level

`buildPolyline` skips isoline refinement when `level == SHORE_LEVEL`
(`contours.ts:171` returns before tracing when `crossingOverride !== null`).
Gate 1 refined the shore contour — a visible deviation from the CPU's
midpoint shoreline that the pixel diff paid for.

### 5.4 Crossings in canonical direction

Gate 1 computes each square's crossing from its own traversal direction
(`mesher.html:521-534`); the neighbour computes the same edge reversed, so
`mix(a,b,t)` and `mix(b,a,1-t)` can differ in the last f32 bit and round to
different quantization steps. Production computes every crossing from the
lower-index corner of the edge (north→south, west→east), identically in both
squares, so shared crossings are bit-identical before quantization.
Watertight by construction, not by luck.

### 5.5 Ceilings (`marchCeiling`, `capEmission.ts:493-513, 589-602, 669-676`)

Only when `chunkLayered` and only at levels with `threshold == band ·
BAND_HEIGHT` (never shore). Ceiling field per corner:
`coversBand(k) && !coversBand(k-1)` (port of `columnCoversBand`,
`columns.ts:483-485`) as 1/0; marched with `CEILING_EDGE_CROSSING = 0.5`,
no refinement, bias 0, saddles read from the mean of the 0/1 samples (always
split, `contours.ts:256-272` with samples in {0,1}). Polygon emitted at
`undersideY = k == chunkLowestBand ? capY(k) : capY(k-1)`, reversed winding
(`emitCeilingTriangle`, `capEmission.ts:274-285`), no risers, colour
`cliff[ceilingIndex]` with `ceilingIndex = isSeabed(undersideIndex) ?
undersideIndex : paletteIndex`, `undersideIndex = bandPaletteIndex((k ==
chunkLowestBand ? k : k-1) · BAND_HEIGHT)`, self-lit `selfLitFor(ceilingIndex)`
(`capEmission.ts:164-168, 181-183`). LUT gains a `ceiling` table indexed by
`(band, isLowest)`.

Level range for ceilings: the same `lo..hi` as §5.2 with `lo =
chunkLowestBand`; a level whose four ceiling corners are all 0 costs four span
walks and nothing else. `isLowest` for the LUT is `k == chunkLowestBand`.

### 5.6 Lips

In the count pass (`mode == COUNT`), every riser sub-segment of a non-shore
level (`lineIsContour[v]` edges, `mesher.html:498-501`) appends
`{slot, band, ax, az, bx, bz}` to `lips` via `atomicAdd(&lipCounter, 1)`; the
CPU regroups per chunk and band and sorts within a band by `(ax, az, bx, bz)`
so `ChunkLipSegments` is deterministic. This is `emitLipSegments`
(`capPlanFlat.ts:318-361`): every loop edge that is not a seam segment, at
`y = band · BAND_HEIGHT · HEIGHT_WORLD_SCALE + LIP_LIFT_WORLD_UNITS`. The
GPU's contour edges are never seam segments (a seam edge has at least one
corner endpoint). Capacity: `LIP_APPEND_CAPACITY = 262_144` segments
(6.3 MB); if `lipCounter` exceeds it the batch is re-counted after doubling
the buffer (rare: the heaviest desktop 3×3 window has 466,860 vertices, at
most one lip per riser quad → ≤ 78 k).

`plan` for a GPU answer = `flattenCapPlan` of the level list only
(`levelThreshold/SampleBand/CapY` from `chunkLowestBand..highestBand` with
the shore level, known before dispatch from the entry header; polygon arrays
empty). `capYOfBand` (`drawnGround.ts:721-730`) then answers exactly
as today, including the shore level at band 0.

### 5.7 Positions

`writeVertex` quantizes into the super-mesh local frame (§3.3):
`units = round((world - localOrigin) · 1024)` for x/z, `round(y · 64)` for y,
clamped to i16, packed two per word. No far-edge nudge (§5.1).

### 5.8 What stays as gate 1, and accepted divergences from the CPU mesher

Isoline port (`ISOLINE_FNS`, proven bit-exact by 4,096 cases), crossing
fraction, saddle rule, refinement and `dropCollinear`, convex/centroid fan,
riser and rim quads, shore level slotting, count-then-emit with per-square
bases, 64-thread workgroups × `WORKGROUPS_PER_CHUNK = 4`, lattice in
workgroup memory. `SKIRT_PICK_INSET` (`capEmission.ts:49`) is not applied:
its purpose was mesh raycast picking, which no longer exists (§1).

Accepted divergences, raised by the two adversarial reviews (2026-09-10/11)
and kept deliberately:

- **Per-square fans instead of ear clipping.** A square clipped by one contour
  is convex, so a fan is correct; an inward bulge from isoline refinement is
  fanned from the centroid. Same surface, more triangles (§8).
- **`dropCollinear` over refined points only.** The CPU also thins shared edge
  crossings from the assembled loop. Dropping a crossing on the GPU would open
  an ε-crack between squares, which have no shared assembly step to close it.
- **Work-budget blocky chunks drawn at full resolution.** The CPU's
  triangulation work budgets have no GPU analogue; only the triangle budget
  hands a chunk to the CPU path (§9.2).
- **Refined points on a square edge are skipped** (`fixedUnits` 0 or
  `COORD_DENOM`), a strict subset of `pushIsoline`'s chunk-rect filter.

## 6. The GPU build source (`gpuChunkBuildSource.ts`)

### 6.1 Construction

```ts
createGpuChunkBuildSource(renderer: Renderer, store: GpuArenaStore, fallback: ChunkBuildSource): ChunkBuildSource | null
```
Returns `null` unless `renderer.backend.isWebGPUBackend === true`. Compiles
the module once; `getCompilationInfo()` errors throw at construction (so
`world.ts` falls back, §9.1).

### 6.2 Window extraction (`terrainGpuInputs.ts`)

`extractWindowEntry(mirror, chunkIdx) → WindowEntryData | 'overBudget'`:
resolves the 17×17 lattice with `renderSampleCell` semantics, gathers each
resolved cell's packed spans (`map.columnSpans`), packs `latticeDesc` and
`spanPairs` (returns `'overBudget'` past `WINDOW_SPAN_PAIRS`), and computes
the header with `buriedFloorBand`'s rule and `makeLevels`' range. To keep
one source of truth these CPU helpers are exported from `capEmission.ts`
(`buriedFloorBand` already exists; the lowest/highest band scan is lifted out
of `makeLevels` into `sampleBandRange(samples)`); no math is duplicated. Per
batch: `queue.writeBuffer` per region for the batch's entries (contiguous
entry indices when possible; otherwise one write per entry, ≤ 64 × 4 writes).

### 6.3 Count pass and readback

Per batch: upload the batch's entries (§6.2) and a `batchList` of entry
indices, `params.mode = COUNT`, zero the entries' `chunkStats` and
`lipCounter`, dispatch `batchChunks · WORKGROUPS_PER_CHUNK`, copy the
entries' `squareBase` and `chunkStats`, `lipCounter` and `lips[0..cap)` into a
readback buffer from a pool (`GPU_READBACK_POOL_MIN = 2`, grown on demand up
to `GPU_READBACK_POOL_MAX = 8`), `submit`, `mapAsync`. On resolve: per chunk,
`vertexCount = chunkStats.vertexCount`; if `vertexCount > GPU_CHUNK_VERTEX_BUDGET
= CHUNK_TRIANGLE_BUDGET · 3` (393,216, `capEmission.ts:57`) the chunk is
handed to `fallback.build(mirror, chunkIdx, generation)` and that promise is
returned instead; otherwise resolve `ChunkGpuAnswer` with the per-square
counts kept for `emit`. Generation and `mirror.received` checks stay in
`receive()` (`terrainMeshes.ts:542-551`).

### 6.4 Emit

`GpuEmitHandle.emit(encoder, target, vertexOffset)`: exclusive prefix over the
256 per-square counts plus `vertexOffset` → `writeBuffer(squareBase[entry])`
(1 KB), patch the entry header (`vertexBase`, local origin from `target`),
`params.mode = EMIT`, bind group 1 = `target` buffers (cached per buffer
pair), dispatch `WORKGROUPS_PER_CHUNK` for that entry, then release the
entry. Params/mode per dispatch use a dynamic-offset uniform so count and
emit dispatches can share one command encoder. Emits for one frame share the
store's encoder and go out in `store.commit()`, ahead of three's render
submit on the same queue, so the render pass reads finished vertices.

### 6.5 Timing

When the device has `timestamp-query` (three requests it when
`trackTimestamp`, `scene.ts:91`), count and emit passes carry
`timestampWrites`; resolved every `GPU_MESHER_RESOLVE_EVERY_BATCHES = 8`
batches into `gpuMesherStats(): { countMs, emitMs, batches, chunks }`
exposed on the perf handle (DEV) and the probe report (§11).

## 7. Budgets

| budget | value | where it applies |
|---|---|---|
| `CHUNK_SPLICE_FRAME_BUDGET_MS` | 1.5, unchanged | main-thread splice loop; a GPU splice is bookkeeping + 1 KB upload + one dispatch record (~0.02 ms **[estimate]**) |
| `GPU_MESH_FRAME_BUDGET_MS` | 3.0 | GPU time the arena may schedule per frame for emits: `drain` charges each GPU answer `vertexCount · GPU_EMIT_MS_PER_VERTEX` and defers the rest to the next frame |
| `GPU_EMIT_MS_PER_VERTEX` | 4.5e-6 | heaviest window measured 2.08 ms / 466,860 vertices (desktop); laptop 1.3× |
| `GPU_BATCH_CHUNKS` | 64 | count-pass batch and backlog cap (§4.3) |

Why 3.0 ms: the standing rule is ≥ 140 fps ≈ 7 ms; render GPU p50 is 2.57 ms
at the default pose (`terrain-renderer-options.md`); 7 − 2.57 − 3.0 leaves
1.4 ms for the count pass of the next batch and jitter. The heaviest desktop
3×3 window (2.08 ms) fits in one frame; on the laptop (2.7 ms) it fits with
0.3 ms to spare. Both are strictly better than the CPU path's 10.5 ms p95
stroke frames, whose cost is main-thread splice + upload.

Slack: `SLOT_SLACK_FACTOR = 1.25` stays. The `2026-09-10-slot-slack`
measurement directory exists (`.gpu-perf/results/`); the GPU path changes
nothing about growth statistics because counts are the same function of the
same heights. Worst-case resident vertex bytes = live × 1.25 during a stroke,
reclaimed by `settle()` (`terrainMeshes.ts:686-710`) when quiet.

## 8. Memory

Desktop, bench world (`frostwick-gate.db`, default pose), resident. The arena
row is measured, not derived: `terrainResidentBytes` from the probe report,
which is the arena's buffers plus its compaction scratch.

| buffer | bytes | basis |
|---|---|---|
| arena vertices | **176,160,768** (2026-09-11, run under `2026-09-11-gpu-mesher-vertex`) | 22.02 M vertices of capacity × 8 B |
| window entry pool | 2.6 MB | 128 entries × (lattice 1.2 KB + desc 1.2 KB + pairs 16 KB + bases 1 KB) |
| lips append | 6.3 MB | `LIP_APPEND_CAPACITY` |
| readback pool | 2 × 6.6 MB | copies of the above |
| band LUT texture | 5.1 KB | `LUT_VEC4_COUNT` × 1 RGBA8 texels |
| **total** | **≈ 198 MB** at the capacity that run reached | |

Measured, same world and pose, same probe field:

| path | arena resident | per vertex |
|---|---|---|
| CPU workers | 212,336,640 | 20 B (`f32` × 3 + `i8` × 4 + `u8` × 4) |
| GPU, positions + colours (run 6, 2026-09-10) | 264,241,152 | 12 B |
| GPU, palette key in the position (this design) | 176,160,768 | 8 B |

The vertex capacity is identical across the two GPU runs, so the drop is
exactly the colour buffer: the GPU path goes from 24 % above the CPU arena to
17 % below it, while the parity numbers stay put (band 1 mismatched sample of
494,245 either way, shaded raw 0.6252 % → 0.6269 %). The 207 MB gate-1 limit
was set for the bench page; production's bound is "no worse than the CPU path",
which now holds with room. Reducing the GPU triangle count (per-chunk polygon
triangulation instead of per-square fans) is a later optimisation, not part of
parity.

## 9. Fallbacks

### 9.1 Whole-session

`world.ts`: `terrainMesher()` preference (§10) → if `'cpu'` or the renderer
backend is WebGL2 or `createGpuChunkBuildSource` returns null/throws
(compile error, injection guard) → today's `createWorkerChunkBuildSource()`
+ `createCpuArenaStore`. Logged once with the reason.

### 9.2 Per-chunk

Inside the GPU source, transparently: vertex count over
`GPU_CHUNK_VERTEX_BUDGET`, a window over `WINDOW_SPAN_PAIRS`, or a lost
device → `fallback.build()` (the worker pool, which applies the CPU's own
budgets and blocky fallback) and the CPU answer is written into the GPU store
by `packCpuAnswer` (§3.3). Because every chunk carries its own resolved
lattice, a fallback chunk's neighbours are unaffected.

Known accepted difference: the CPU also falls back on its triangulation work
budgets (`capEmission.ts:59-63, 603-607`); the GPU has no ear-clipping cost so
it draws those chunks at full resolution. The parity harness reports these
chunk indices (as gate 1's `report.md` does) and excludes them from the pixel
criterion.

## 10. Selection and settings

`client/src/state/terrainMesherPrefs.ts`, same shape as `frameRatePrefs.ts`:
`TerrainMesher = 'auto' | 'gpu' | 'cpu'`, default `'auto'` (GPU when the
renderer runs WebGPU), storage key `terrace.terrainMesher.v1`. ControlsPanel
row "Terrain mesher" next to "Frame rate" (`ControlsPanel.tsx:283-297`). A
change rebuilds the terrain meshes from the current mirror (`world.ts`
`resetWorld`-style: dispose meshes + layer edges, recreate with the new
source/store, `update(all received)`), so it applies live. DEV URL override
`?mesher=cpu|gpu` for the harness, read where `?perfprobe` is
(`perfProbe.ts:1097`).

## 11. Verification (the completion criterion)

### 11.1 Static
- `pnpm typecheck`, `pnpm test`: all existing tests pass with the CPU store
  (no new tests: permission not granted this session).
- `node client/scripts/drawnGroundParity.mjs`: unchanged, CPU oracle.

### 11.2 Parity harness `client/scripts/mesherParity.mjs`
Isolated stack (recipe in `.claude/orchestration/bench-rules-parallel-agents.md`;
never the owner's ports; GPU lock), world `bench/webgpu-mesher/frostwick-gate.db`.
Drives real Chrome over CDP, `?perfprobe=bandParity&mesher=cpu` then
`mesher=gpu`. The `bandParity` probe scenario (DEV): parks at the default
pose, hides every scene object except the terrain group, swaps the terrain
material's colour for `round(positionWorld.y / BAND_WORLD_HEIGHT)` encoded in
RGB with a distinct background, renders one frame, and the driver screenshots
it. Also `?perfprobe=overview` screenshots under normal shading with plugins
frozen (`ctx.freeze(true)`, `perfProbe.ts:891`).

Criteria (owner's rulings applied):

| criterion | limit |
|---|---|
| band-ID image mismatch fraction, gpu vs cpu, outside CPU-blocky chunks and outside a 1-px contour exemption | ≤ 0.5 % |
| band-ID holes (background where the cpu image has terrain) | 0 |
| shaded pixel mismatch fraction above the metric floor, 3×3 window, tolerance 8 (gate 1's compare, `run.mjs:277-315`), floor = cpu vs cpu moved a rigid half position step (gate 1's shift floor; owner ruling 2026-09-11, §14 item 5) | ≤ 0.1 % |
| locked-neighbour fixture (a world with one chunk not received): same two criteria | same |

### 11.3 Speed and efficiency
Same stack, `?perfprobe=sculpt&settle=45000&mesher=…`, three runs each, and
`?perfprobe=overview` for load. Pass means the GPU path beats the CPU path on
every row:

| metric | CPU today (desktop) | GPU must |
|---|---|---|
| stroke frame p95 / p99 / max | 10.5 / 14.1 / 45 ms | lower on all three |
| load: first update → queue empty | 7.2 s | lower |
| main-thread ms/frame in terrain path during a stroke | (profile) | lower |
| GPU ms/frame during a stroke (renderer timestamps + `gpuMesherStats`) | render only | render + mesher ≤ 7 ms p95 |
| resident arena bytes | 235 MB + slack | ≤ CPU path's |

Laptop numbers are collected by the owner's laptop session with the same
script (`gate2-laptop.md` conditions); desktop numbers gate the merge.

## 12. File map and ownership (four Opus agents, own worktrees)

Contract files written by the orchestrator before the agents start, so every
worktree compiles against the same interfaces: `client/src/render/arenaStore.ts`
(interface + CPU store extracted verbatim), `client/src/render/chunkBuildSource.ts`
(`backlogCap`, `ChunkAnswer`), `client/src/render/gpuMesher/gpuChunkAnswer.ts`,
`client/src/render/gpuMesher/webgpu.d.ts` (ambient WebGPU API subset used —
`GPUDevice, GPUBuffer, GPUQueue, GPUCommandEncoder, GPUComputePassEncoder,
GPUBindGroup(Layout), GPUComputePipeline, GPUShaderModule, GPUQuerySet,
GPUBufferUsage, GPUShaderStage, GPUMapMode`; swap for `@webgpu/types` when
the owner approves that dev dependency).

| agent | owns | verifies with |
|---|---|---|
| K (kernel + inputs + source) | `gpuMesher/mesherWgsl.ts`, `marchingTable.ts`, `bandLut.ts`, `terrainGpuInputs.ts`, `gpuChunkBuildSource.ts`; exports `buriedFloorBand`/`sampleBandRange` from `capEmission.ts` | typecheck; a DEV self-check that compiles the module on the live renderer and runs the isoline cases (port of `__isolineSelfCheck`) |
| A (arena + store + material) | `terrainMeshes.ts` refactor onto `ArenaStore`, `gpuMesher/gpuArenaStore.ts`, `terrainMaterial.ts` layouts | `pnpm test` (existing arena tests, CPU store), typecheck |
| W (wiring + prefs + probe) | `world.ts`, `state/terrainMesherPrefs.ts`, `ui/ControlsPanel.tsx`, `perfProbe.ts` (`?mesher=`, `bandParity`, `gpuMesherStats`), `main.tsx` | typecheck, `pnpm test` |
| H (harness + measurement) | `client/scripts/mesherParity.mjs`, `client/scripts/mesherBench.mjs` (sculpt/overview driver reusing `probe-run-win.mjs`), results under `.gpu-perf/results/2026-09-10-gpu-mesher/` | runs §11.2 and §11.3 after K/A/W merge; cpu-vs-cpu first as the zero baseline |

Merge order: contracts → A and K in parallel → W → H. Then two Opus reviewers
(kernel parity vs `capEmission.ts`/`contours.ts`; arena/store/three
integration) and fixes.

## 13. Rejected alternatives

- **Copy from a mesher-owned buffer into three-managed attributes** (rev 1
  §1.3): rejected, §0 item 3.
- **`StorageBufferAttribute` + TSL `wgslFn` compute through
  `renderer.compute()`**: keeps three in charge of buffers but still allocates
  from a CPU array (`WebGPUAttributeUtils.js:113-178`), and wrapping ~600
  lines of integer-exact WGSL in TSL adds a translation layer to verify for no
  gain. Raw WebGPU on `backend.device` is the direct route.
- **Packed 12-B interleaved vertex (u16 xz, i16 y, rgba) decoded from one
  attribute**: three's node material always reads `position` as `vec3<f32>`
  and rewrites non-normalized 16-bit formats (§1); `snorm16x4` + `unorm8x4` in
  two buffers is the same 12 B with no private-API surface beyond injection.
- **Float32 positions (16 B)**: 250 MB on the bench world, over the CPU
  baseline; the 4 B saved per vertex is 62 MB.
- **World-frame quantization** (gate 1): 1/32 cell on a 2048² world; local
  frame keeps 1/256 cell at any world size for the price of one
  `mesh.position` per super-mesh.
- **Indirect draw, no count readback**: needs GPU-side slot allocation and
  hole management; the async readback costs one frame of latency and no
  stall, and keeps the arena's proven bookkeeping. Deferred, not ruled out.
- **Single emit pass into staging + copy**: same readback dependency for slot
  placement, plus a staging buffer sized at the per-chunk budget × batch (up
  to 300 MB for 64 chunks) or a second sync; two passes cost ~2× compute of
  one pass (still ≤ 3 ms for the heaviest window) and no staging.
- **CPU planning for lips, GPU for triangles**: leaves the contour march (the
  larger half of `writeChunkVertexData` **[estimate]**) on the worker; the
  GPU already walks every contour edge, so lips are free there.
- **World-sized height/span buffers on the GPU with per-edit row uploads and
  a span page pool** (revision 2 draft): a chunk re-dirtied between its count
  and emit would be emitted from newer inputs against stale counts, and halo
  cells needed a page-ownership protocol; per-batch resolved windows remove
  both and let the CPU's own seam/lowest-band functions do the resolving.
- **Drawing nothing / whole-session demotion on an over-budget chunk**: rev 1
  §7, still rejected.

## 14. Open items for the owner (non-blocking; defaults stated)

1. `@webgpu/types` as a dev dependency instead of the local ambient
   declaration. **Ruled 2026-09-11: add the package.** `@webgpu/types`
   ^0.1.72 is a client dev dependency wired through `tsconfig` `types`; the
   local `gpuMesher/webgpu.d.ts` is deleted.
2. Whether GPU chunks that the CPU would draw blocky (work-budget fallback)
   may stay full-resolution (default: yes; reported, excluded from parity).
3. `GPU_MESH_FRAME_BUDGET_MS = 3.0` (default stands; §7 reasoning).
4. Dropping the dead normal attribute from the CPU arena (42.5 MB: 4 of the
   20 B/vertex of the measured 212,336,640 B resident; JS heap only, three
   never uploads an attribute the shader graph does not reference) is a separate
   change; not done here. **Ruled 2026-09-11: leave it** (fallback-path-only
   benefit; revisit if the CPU path's memory matters).
5. Shaded parity floor: gate 1's rigid half-step shift (passes at 0.076 %
   without MSAA) or the snap-to-grid floor (0.114 %); see §15.1.
   **Ruled 2026-09-11: the shift floor.** The criterion in §11.2 is judged
   above it; the GPU mesher passes.

## 15. Results (2026-09-11, desktop RTX 3090, Frostwick Hollows bench world, default pose, 1404×1205)

Tip measured: `3d847e9`. Harness: `client/scripts/mesherParity.mjs`,
`client/scripts/mesherBench.mjs` (isolated stack, fresh world per capture,
GPU lock). Raw records under `.gpu-perf/results/2026-09-10-gpu-mesher/`
(`-noaa/` for the MSAA-off run), `RUN_LOG.md` in each.

### 15.1 Parity

Band-ID image (geometry): gpu vs cpu **1 mismatched pixel of 494,245
judged, 0 holes**, coverage asymmetry 1 px (an edge-blend artefact). The
CPU mesh scores exactly the same against itself moved half a position step
(shift floor) and against itself snapped to the GPU grid (quant floor). The
GPU geometry is at the measurement floor.

Shaded image (the look), 3×3 window, tolerance 8/255:

| configuration | gpu vs cpu | shift floor | quant floor | above shift | above quant |
|---|---|---|---|---|---|
| MSAA on (shipped) | 0.6270 % | 0.3527 % | 0.2172 % | 0.2743 % | 0.4097 % |
| MSAA off (`?antialias=0`) | 0.1906 % | 0.1150 % | 0.0761 % | **0.0756 %** | 0.1144 % |

Reading: MSAA turns every sub-pixel tread flip into a blend outside the
tolerance and lifts measurement and floor together (gate 1 README recorded
the same 3.4× effect and reverted MSAA for its own criterion). Without MSAA
the GPU sits 0.076 % above gate 1's floor definition (a rigid half-step
shift, the metric's own noise) and 0.114 % above the stricter quant floor,
which isolates the storage format but not retessellation (per-square fans vs
ear-clipped polygons, §5.8). The residual is single-pixel speckle on cliff
faces; the two shaded captures are indistinguishable by eye.

**Owner decision (§14 item 5):** which floor the 0.1 % shaded criterion is
judged above. Gate 1's precedent is the shift floor (pass, 0.076 %).

### 15.2 Speed and efficiency (bench, 5 runs each, medians; min–max in RUN_LOG)

| metric | CPU workers | GPU compute | |
|---|---|---|---|
| stroke frame p50 / p95 / p99 (ms) | 6.90 / 9.20 / 13.10 | 6.90 / 9.00 / 13.00 | GPU ≤ on all |
| stroke frame max (ms) | 50.5 (39.7–63.1) | 57.3 (44.0–59.9) | overlapping ranges, noise |
| idle p50 (ms) / fps | 6.90 / 140.9 | 6.90 / 141.3 | tie |
| load: first update → queue empty (ms) | 6153 | **4664** | −24 % |
| median / max splice (ms) | 0.20 / 0.30 | **0.10 / 0.20** | |
| renderer GPU p50 / p99 (ms) | 5.70 / 6.68 | **4.26 / 5.31** | −25 % / −20 % |
| triangles drawn | 5.37 M | 6.50 M | +21 % (fans, stacked rim caps) |
| terrain resident bytes | 212.3 MB | **177.5 MB** | −16 % (8 B/vertex) |
| mesher GPU time per batch | n/a | count 0.7–1.1 ms, emit 1.9 ms | ~100 batches per 5 s stroke |

Overview scenario: load 6026 → 4626 ms, max splice 2.90 → 0.20 ms, renderer
GPU p99 7.86 → 5.24 ms, resident 212.3 → 176.2 MB.

### 15.3 What changed from revision 2 during implementation

- Bind groups folded to 3 storage + 2 uniform (default device limit is 8,
  the draft needed 11).
- The build source is created asynchronously once per session in
  `main.tsx`; any WebGPU validation failure demotes to the CPU pair before
  the first frame; a failed injection or lost device demotes the live world.
- Exposure rule for stacked caps (§5.2) and the 8-byte vertex (§3.3).
- The LUT bytes are quantized from f64 palette values (an f32 round trip
  shifted a channel by one).
- DEV probe scenarios `bandParity`/`terrainStill` and flags `mesher`,
  `parityShift`, `parityQuantize`, `antialias`; DEV `__terraceMesherDump`.

## Pre-Check checklist

| item | answer |
|---|---|
| 1 Magic numbers | Every literal is a named constant with its derivation in §3.3, §4.3, §5.6, §6, §7 |
| 2 Duplication = wrong contract | Byte movement was duplicated across splice/compact/zero; it moves behind `ArenaStore` once |
| 3 Symptom vs root cause | Root cause: the arena owned its bytes as CPU arrays; the contract change makes storage a swappable store |
| 4 Diagnosis from primary source | Every mechanism re-read this session: three r185 attribute utils, arena, mesher, gate 1 page and records |
| 5 "More than one" signal | Owner asked for full parity + beating CPU; the design elevates from "copy into the arena" to a storage contract and a full kernel port |
| 6 Rejected alternatives | §13, nine alternatives with reasons |
| 7 Punts named | §14 lists four with defaults; indirect draw deferred with reason in §13 |
| 8 Defaults reasoned | Quantization, budgets, batch size, page classes each derived from a measurement or a hardware bound (§3.3, §4.3, §6.2, §7) |
| 9 Tests cover the contract | Existing arena tests run through the CPU store (contract preserved); GPU store verified by the parity harness at the render level; no new unit tests (permission not granted) |
| 10 One-sentence framing | The arena's storage was its own CPU arrays, so no GPU producer could feed it; an `ArenaStore` contract with a GPU implementation lets the compute mesher write vertices in place, and the kernel is ported to full CPU parity |
