# GPU mesher: production design (document only)

Issue #445, arc `arc/gpu-mesher-gates`. Written 2026-09-10 from the gate 1 page
(`bench/webgpu-mesher/`), its desktop results (`bench/webgpu-mesher/results.json`,
`results/desktop/results-visible.json`), the shipped mesher
(`client/src/terrain/capEmission.ts`) and the drawn-ground store
(`client/src/terrain/drawnGroundStore.ts`). No client code. Gate 4 does not start
before gate 2 (#447) and the stroke-tail tracing report.

Every number below is from a primary source named in place, or is labelled
*estimate* / *unverified*.

## 1. What the gate page is and is not

The page (`mesher.html`) runs the shipped mesher's algorithm per cell square in
WGSL: one count pass at startup, a host prefix sum over 262,144 squares, then
emit passes writing each square at its exact precomputed offset. Vertex 12 bytes
(`qx|qz` u32, `qy` u32, `rgba` u32); flat normals from screen-space derivatives
in the fragment shader, no normal attribute (`mesher.html` `fs`).

Measured on the RTX 3090 with the owner's stack on the same GPU
(`results-visible.json`): 15,622,203 vertices, 187.5 MB vertex bytes, draw p50
0.69 ms, full-world emit 3.0 ms GPU, heaviest 3×3-chunk edit window 466,860
vertices at 2.08 / 2.74 / 2.84 ms GPU (p50 / p95 / max), median window 115,635
vertices at 0.44 / 0.70 / 1.10 ms. Startup count pass plus host prefix sum:
695 ms wall (`countPassMs`).

Missing for production (README "Known differences"): overhang undersides
(`marchCeiling`), the over-budget fallback, per-level solid test on layered
columns (difference 4), and any way to grow a chunk after an edit without
re-counting the world.

## 2. Contract

1. **The mesh draws the shared drawn-ground function.** Vertex positions are the
   function's own quantized coordinates (`DRAWN_GROUND_COORD_DENOM` = 1024 per
   cell); parity against `drawnBandAt` is the repo gate
   (`client/scripts/drawnGroundParity.mjs`), and the 157 exact-cell-centre
   mismatches are the function's zero-area regions, exempt there and shared with
   the CPU mesher (573 under the same pass).
2. **An edit runs one emit dispatch per dirty chunk and nothing else.** No count
   pass, no readback on the critical path, no host prefix sum. The only count
   pass is at world load.
3. **Consumers never read vertex buffers.** Movers, picking, rivers and the
   brush preview query the drawn-ground function plus one per-chunk flag
   (§6). The CPU no longer builds contour loops for rendering.
4. **Memory and edit budgets are stated (§7, §8) and enforced by the allocator,
   not by hope.**

## 3. Vertex format: 8 bytes

| word | bits | field | range / rule |
|---|---|---|---|
| 0 | 0–15 | `x` chunk-local, cell/1024 | 0 … 16·1024 = 16,384 (u16) |
| 0 | 16–31 | `z` chunk-local, cell/1024 | same |
| 1 | 0–15 | `y` height units × 4 (i16) | `MIN_HEIGHT`·4 … `MAX_HEIGHT`·4 = −6,144 … 4,096; the seabed cap sink and riser border (1/64 world unit = 1 height unit) are exact |
| 1 | 16–23 | palette index (u8) | index into the bound `lut` (`palettes.top` / `.cliff`), replaces the literal rgba |
| 1 | 24–31 | flags (u8) | bit 0 self-lit (`SELF_LIT`), bit 1 ceiling (winding hint for the drawn-ground/picking helpers, not used by the draw) |

Why chunk-local: the gate's world-quantized u16 at 1/512 world unit
(`positionScale` 511.96) only fits a 128-world-unit world; the server default is
`DEFAULT_WORLD_SIZE` = 2,048 cells = 512 world units (`shared/src/constants.ts`).
Chunk-local at the function's own denominator is exact at every world size and
strictly finer than the gate's grid (1/1024 cell vs 1/128 cell). The chunk
origin reaches the vertex shader as a per-draw uniform (§5).

Effect: 15.6 M vertices × 8 B = **125 MB** exact for Frostwick (from
`vertices` in results.json), against 187.5 MB at 12 B. Draw time can only fall
(vertex fetch is the draw's bandwidth term; triangles unchanged).

## 4. Per-chunk capacity: slot classes, single-walk atomic allocation

### 4.1 Slots

Each chunk owns one slot in a class buffer. Classes are power-of-two vertex
counts:

| constant | value | reason |
|---|---|---|
| `SLOT_CLASS_MIN_VERTICES` | 2¹³ = 8,192 | the blocky fallback needs ≤ 7,680 (§6), so the smallest class always holds it |
| `SLOT_CLASS_MAX_VERTICES` | 2¹⁸ = 262,144 | 2.5× the heaviest Frostwick chunk, *estimate* from 466,860 verts / 9 chunks in the heaviest window ≈ 52 k mean, ≤ ~105 k max (per-chunk counts were not dumped by the page; measure, §10) |
| classes | 6 (2¹³ … 2¹⁸) | |

One `GPUBuffer` per class, `slots × class × 8 B`, `STORAGE | VERTEX`. A chunk's
slot is `(class, index)`. Class buffers grow by doubling their slot count
(`copyBufferToBuffer`, off the stroke path — triggered at the first overflow
into a full class, so at most once per class per session in practice;
*unverified*, measure).

There is no slack constant. The slack is the unused part of the power-of-two
slot: 0–50 %, mean 25 % if counts are uniform in log space (*estimate*; §7
carries the resulting memory figure and its verification).

### 4.2 Emit is one walk with a chunk-local bump allocator

Per chunk, one workgroup of 256 threads, one thread per cell square (the page
uses four workgroups of 64; the change is so the allocator is workgroup-local).
Each thread marches its square's levels and, per polygon or riser run, reserves
`n` vertices with `atomicAdd` on a workgroup-shared counter, then writes them at
`slotBase + reserved`. If `reserved + n > capacity` it writes nothing and keeps
counting. After the workgroup barrier, thread 0 writes the chunk record:

```
struct ChunkRecord { vertexCount: u32, needed: u32, minY: i32, maxY: i32 }
```

`needed` is the exact count; `vertexCount` = `needed` if it fit, else the
**previous** record's `vertexCount` (the slot still holds the previous emit,
which is complete and consistent). The host's status readback (§4.3) sees
`needed > capacity` and reacts. The count is exact and computed in the same
walk that emits; nothing is re-counted.

Vertex order within a slot is allocation order, so it differs run to run. That
is not a contract: the draw is order-independent (opaque, depth-tested, no
coplanar overlaps in a watertight terrace mesh), and verification hashes the
sorted triangle set instead of the raw buffer. Terrain determinism
(`docs/DESIGN.md`) is about heights and the function, which are untouched.

**Rejected: two walks (count, workgroup prefix scan, emit) for a deterministic
layout.** It doubles the marching cost, which is the whole emit cost: the
heaviest window would go from 2.08 ms toward ~4 ms GPU (*estimate*), and the
deterministic order buys nothing a sorted hash does not.

**Rejected: exact count pass + host prefix sum per edit (the page's startup
path).** 695 ms wall at world load; per-edit it would also move every later
chunk's offset, i.e. re-emit the world.

### 4.3 Overflow and growth

The host reads the chunk records for the dirty chunks after each stroke step
(`mapAsync` on a copy of ≤ 9 × 16 B; the gate measured the submit-to-completion
round trip at ~3 ms wall, `edit.heaviest.wallMs.p50` 3.3 minus `gpuMs` 2.1).
For a chunk with `needed > capacity`:

1. `needed ≤ SLOT_CLASS_MAX_VERTICES`: allocate a slot in the smallest class
   that fits, re-dispatch emit for that chunk only, free the old slot, update
   the draw record (§5). The chunk shows its previous shape for one round trip.
2. `needed > SLOT_CLASS_MAX_VERTICES`: over budget → §6.

Shrink only at idle: when a chunk's `needed` has been below half its class for
`SLOT_SHRINK_IDLE_MS` (proposal: 2,000 ms — long enough that a stroke never
thrashes across a class boundary; the value is a design choice to confirm with
the owner, not a measurement), move it down one class. Never shrink during a
stroke.

Residual, stated: during a stroke that crosses a class boundary the chunk is
stale for one readback round trip (~3 ms wall, desktop), once per crossing.

### 4.4 World load

Count-only dispatch for all chunks (mode `MODE_COUNT_ONLY` exists in the page,
3 ms GPU for the world), readback of 1,024 records (16 KB), class assignment,
then one emit dispatch for the world. This is the only count pass and the only
host-side allocation sweep. *Estimate*: ≤ 20 ms wall end to end, against the
shipped 938 ms single-threaded build.

## 5. Draw: one indirect draw per chunk in a render bundle

Slots are not contiguous, so the world is not one draw. Per chunk:
`drawIndirect(args, chunk * 16)` with `firstVertex = slotBase`, `vertexCount`
from the chunk record. All 1,024 draws are recorded once into a
`GPURenderBundle` grouped by class (one `setVertexBuffer` per class, one
`setBindGroup` with a dynamic offset per chunk for its origin uniform);
re-recorded only when a chunk changes class. Per frame the host executes the
bundle: one call.

Culling comes free: a 1,024-thread compute pass per frame tests each chunk's
`(originXZ, minY, maxY)` box against the frustum and writes `vertexCount` or 0
into the indirect args. Chunks off screen cost nothing; this is the draw-power
lever for the laptop (gate 2) that a single world-sized draw cannot offer.

**Rejected: single draw with degenerate-filled slack.** Fetches the slack every
frame (~25 % of vertex bandwidth, *estimate*) and cannot cull.

**Rejected: `multiDrawIndirect`.** Not core WebGPU
(`chromium-experimental-multi-draw-indirect`); the bundle gives the same
per-frame CPU cost without the dependency.

## 6. Over-budget fallback: blocky, decided on the GPU

The shipped mesher's three budgets (`CHUNK_TRIANGLE_BUDGET` 131,072,
`CHUNK_TRIANGULATION_WORK_BUDGET` 4,194,304, `CHUNK_POLYGON_WORK_BUDGET` 512²,
`capEmission.ts:57-63`) guard ear-clipping cost, which is quadratic in polygon
size. The GPU emits per-square fans, so the quadratic term does not exist;
the six Frostwick chunks the CPU dropped to blocky (`meta.json`
`cpuFallbackChunks`) have 300–756 square-levels each, low by this world's
standard (p50 439, max 2,458; computed from `expected.bin` cell-centre bands,
2026-09-10), and the page draws them terraced.

The only GPU budget is memory: `needed > SLOT_CLASS_MAX_VERTICES`. Then the
emit dispatch itself switches the chunk to the blocky path in the same
dispatch (all threads read the counter after the barrier; if over, the slot is
rewritten blocky): per cell one cap quad at `blockyCellCapY` and up to four
curtains where a neighbour is lower — ≤ 256 × (6 + 4 × 6) = 7,680 vertices,
always fits, no round trip for the visual. The record carries a `blocky` bit.

The drawn-ground store keeps exactly one thing the function cannot give: this
per-chunk flag (`ChunkChart.plan.blocky` today,
`client/src/terrain/drawnGround.ts:42`). It is fed from the same status
readback as §4.3, so consumers switch to the blocky query one round trip after
the draw does.

Residual, stated: on an adversarial chunk, movers and picking query terraced
ground for ~3 ms while the chunk already draws blocky. Only adversarial
sculpting reaches this path (`docs/decisions/mesh-budgets.md`: legitimate
chunks are far below the budget).

**Rejected: a CPU-side predicate (Σ square-levels × a per-square-level vertex
bound) so the flag is known before the emit.** The bound is loose (~96 verts per
square-level against ~30–45 measured on Frostwick: 115,635 / (9 × 435) and
466,860 / (9 × 1,249)), so it would blocky-ify a chunk-wide sheer wall that
actually fits, and it is a second implementation of the counter that must be
kept in lockstep. Exact-on-GPU plus a bounded stale window is the smaller
contract.

**Rejected: a "coarse" intermediate look (no isoline refinement) before
blocky.** A third terrain look for a case that only adversarial input reaches.

## 7. Memory budget

Budget: `TERRAIN_RESIDENT_BUDGET_BYTES` = **207 MB** on the desktop — the
shipped client's terrain vertex residency
(`.claude/handoffs/terrain-renderer-options.md`, 2026-09-09). The laptop budget
is gate 2's to set.

Ledger, Frostwick 512², from results.json counts:

| item | bytes |
|---|---|
| vertices, exact, 8 B | 125 MB |
| vertices, slotted | **≈ 167 MB** (*estimate*: 125 / 0.75; verify from per-chunk counts, §10) |
| heights (i32 per cell, as the page) | 1.0 MB |
| span descriptors + span data | 1.1 MB |
| chunk records, indirect args, origins | < 0.1 MB |
| total | ≈ 169 MB (≤ 207) |

Enforcement: a class growth that would push the slotted total over the budget is
refused; the requesting chunk goes blocky instead (§6) and the refusal is
logged with the chunk index. This is the only path by which memory can fail,
and it fails to a drawn chunk, not a hole.

Worlds larger than 512²: the 2,048-cell server default is 16× the cells; at the
same relief density that is ≈ 2 GB of vertices (*estimate*), outside any budget.
The slot allocator already makes "not resident" a chunk state (no slot → not
drawn, not counted), so a residency window (slots only for chunks within
`RESIDENT_RADIUS_CHUNKS` of the camera target; option 3's idea) is an allocation
policy on top of this design, not a new mechanism. **Not designed here**:
decision yes/no deferred until the owner picks the shipped world size; the
gate world is 512² and the budget above is for it.

## 8. Edit budget

`STROKE_EMIT_BUDGET_MS` = **3 ms GPU per stroke step** for the dirty window.

Basis: heaviest legitimate 3×3 window measured 2.08 / 2.74 / 2.84 ms
(p50 / p95 / max) emit-only with 12 B writes and no ceilings. Production
changes: single-walk atomics (same marching, one atomic per polygon or riser
run — *estimate* ≤ +10 %), 8 B writes (−33 % write bandwidth), ceilings only in
layered chunks (§9). The budget holds the measured max with margin; it is
verified by re-running the gate's edit benchmark against the production
kernel, same window, same iterations.

Frame interplay: the GPU queue is shared with rendering (app GPU p50 2.57 ms,
options handoff). Worst case 3 + 2.6 ≈ 5.6 ms leaves the 7 ms line
(`docs/DESIGN.md` ≥ 140 fps) intact on the heaviest window.

Dirty rule: a chunk is dirty for a frame iff a cell in its 17×17 footprint
changed in the height or span upload since its last emit. One emit per dirty
chunk per frame; predicted and confirmed edits that upload identical bytes do
not dirty twice. This is the "dirty-footprint coalescing" decision the owner
still holds (upload-stall summary §2) — the design assumes it lands; if it does
not, the budget is per emit and a stroke step may cost two.

Upload: the gate uploaded 100,352 B per 3×3 window (`edit.heaviest.uploadBytes`,
whole rows). Production uploads the changed cells' rows within the footprint
only (`writeBuffer` per row, ≤ 48 rows × 192 B ≈ 9 KB; *estimate*).

## 9. Overhang undersides and layered columns

Layered chunks (any cell with `spanDesc != 0`; Frostwick has 1,134 layered
cells of 262,144) take the shipped per-level solid test for caps:
inside(k) ⇔ the column has a span covering band k (`sampleRenderBandSolid`
semantics), instead of the page's `drawnBandAt(cell) >= k` (README difference
4). Non-layered chunks keep the cheaper test; the results are identical there
by construction (one span `[BEDROCK_FLOOR, h)`).

Ceilings, per level k in a layered chunk whose threshold is `k · BAND_HEIGHT`
(the shoreline level is excluded, `capEmission.ts:587`): field per cell =
solid(k) ∧ ¬solid(k−1); marched with `CEILING_EDGE_CROSSING` 0.5 on the binary
field, no isoline refinement (as `marchCeiling`, `capEmission.ts:490-510`);
emitted at `undersideY` = (k−1) · `BAND_WORLD_HEIGHT` (the lowest level uses its
own `capY`), colour `palettes.cliff[ceilingIndex]` with the seabed rule at
`capEmission.ts:161-165`, winding reversed. Lighting needs no normal
attribute: the derivative normal is the face normal; the TSL ground material
(#446) takes it from `positionView` derivatives, so undersides light from
below as the shipped mesh does.

Cost: bounded by the number of layered chunks × their level count; zero for
non-layered chunks. Frostwick: *unverified* count of layered chunks — dump it
with the per-chunk counts (§10).

Parity: the gate's band pass is top-down and cannot see undersides. Add a
ceiling parity pass to the page (same lattice, sample "is there a ceiling at
band k above this sample" from the span list) before the production kernel is
accepted.

## 10. Measurements owed before implementation

1. Per-chunk `needed` for all 1,024 Frostwick chunks (add a dump of the page's
   `squareBase` differences). Sets `SLOT_CLASS_MAX_VERTICES` from data and
   turns the 167 MB slotted figure from an estimate into a number.
2. Number of layered chunks in Frostwick and in the owner's other worlds.
3. Gate 2 (#447): laptop draw and emit power; sets the laptop memory and edit
   budgets and decides whether the frustum cull pass is day-one.
4. Tracing report on the stroke tail (worker-mesher agent): gate 4 precondition.

## 11. Dependencies on the client

- The drawn-ground store loses `FlatCapPlan`, level polygons, `topLevel` and
  lips as inputs; `loopsAt` / `nearestOnContour` on `DrawnGround` have no
  consumer outside `client/src/terrain/drawnGround.ts` today (grep 2026-09-10:
  only `riverRig.ts:696` uses `capYOfBand`), and `capYAt` / `bandAt` /
  `capYOfBand` / `isDrawnAt` are answerable from the function plus the blocky
  flag. If a consumer for loops appears, it marches the function on the CPU on
  demand for that chunk; the mesher no longer produces loops.
- The client must be on the WebGPU renderer (compute passes, storage vertex
  buffers, render bundles with `drawIndirect`). That is #446's migration.
- Timestamp queries (owner's adapter has them; gate 2 tells for the laptop)
  are wanted for the edit budget check in the perf probe, not required.

## 12. Open owner decisions this design assumes

1. Dirty-footprint coalescing lands (§8). Otherwise state the budget per emit.
2. `SLOT_SHRINK_IDLE_MS` = 2,000 ms (§4.3) — design choice, confirm.
3. World size for the shipped product (§7) — decides whether the residency
   window is in scope.
