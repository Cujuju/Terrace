# GPU terrain

Decisions taken on branch `gpu-terrain` (off main `60027e4`), 2026-09-07/08.
Settled with the owner; do not relitigate without new information. The arc was
still in flight when this was written — the facts below were checked against the
tree at `2f71433`, and the "still open" section says what had not landed.

Supersedes the design in `.claude/orchestration/HANDOFF-gpu-terrain.md` wherever
the two disagree. That file is research, and three of its load-bearing claims
turned out to be false; they are named below so the handoff cannot mislead a
later reader.

## Decisions made 2026-09-07 (the drawn surface becomes a pure function of the heightmap, #423/#424/#425)

**The problem, in one sentence: the surface the player saw was a CPU artefact
that nothing else could evaluate.** The mesher built it by marching squares over
each band, smoothing the contour with Chaikin, and ear-clipping the result. That
is a pipeline, not a formula — there is no way to ask it "how high is the drawn
ground at (x, y)?" without running it, and the sim does not run it. So the sim
reasoned on the lattice while the renderer drew somewhere else, and every
consumer that needed the drawn surface got an approximation of its own: movers
floating or sunk (#425 — half a cell off the terrain frame), static placements
reading `terrainHeightAt` for a drawn Y (#424), the `drawnGroundYAt` oracle and
the climb-riser shift as client-side patches. #423 is the decision issue for the
class.

A surface that is a **pure function of the heightmap** ends the class outright:
one definition in `shared/`, evaluated by the sim, by the placement code and by
the shader, with a test that the shader agrees.

### The contract

`shared/src/drawnGround.ts` exports exactly two entry points.

- `drawnGroundHeight(map, x, y)` — the height of the drawn surface at a
  continuous cell coordinate.
- `drawnGroundCoversBand(map, x, y, band)` — whether band `k`'s cap is drawn
  there.

Both work on a sub-cell lattice of `TERRAIN_LOD_NEAR_N = 4` per cell. The input
coordinate is snapped to the containing sub-cell's centre
(`latticeOffset` = `2·floor(coord·N) + 1 − N`, in half-sub-cell units), the four
enclosing cell centres are blended with **integer** weights over a denominator of
`(2N)² · BAND_HEIGHT`, and the quotient is floored **toward minus infinity** —
never truncated, because heights are negative over most of the world.

The sentence a shader author has to reproduce:

> Band *k*'s cap is drawn at *p* exactly when the bilinear blend at *p* of the
> four corner columns' band-*k* samples is at least *k*·`BAND_HEIGHT`, and the
> surface at *p* is the highest such *k*.

Layered columns make "the band-*k* sample" depend on *k*, so the height is a
fixpoint rather than one blend: seed with the blend of the top surface
(`map.cells`), re-blend `columnSampleAtBand` at the band you just got, and stop
when the band stops moving. The iteration is bounded by
`DRAWN_GROUND_FIXPOINT_STEPS = 4 × MAX_SPANS_PER_COLUMN`, so it terminates on a
corrupt column instead of spinning. A footprint whose four corners are all
single-span skips the loop entirely — that is the whole world today except
carved cells, and it is the reason the function is cheap enough for the sim to
call per mover per tick.

Two robustness rules are part of the contract, not incidental
(`99722a5`): non-drawn spans are ignored, so a sub-band sliver never reports a
cap the renderer does not draw; and the coordinate clamp is ordered so that
`NaN`, which fails every comparison, lands on the low border rather than
propagating.

### Three research claims that were wrong

Each was believed when the work was planned, and each was disproved from primary
source before it could be built on.

**1. There is no partially-open corner, so the nearest-corner fallback was dead
code.** The design assumed `columnSampleAtBand` could return
`OPEN_COLUMN_SAMPLE` for some corners of a footprint and a real height for
others, so `drawnGroundHeightAtBand` was specified to abandon the blend and take
the nearest corner (ties: lower x, then lower y). It cannot happen. `setColumn`
and `parsePackedSpans` both require `spans[0].floor === BEDROCK_FLOOR`, and
`BEDROCK_FLOOR = MIN_HEIGHT = −1536 = −96 × BAND_HEIGHT` is exactly band-aligned,
so `isSpanDrawn(spans[0])` is unconditionally true and span 0 always answers for
any band at or above bedrock. The sentinel survives only for bands *below*
bedrock, where all four corners return it together. A fallback that fires only
when all four corners agree is not a fallback. It was deleted rather than
implemented.

**2. A band-parameterised *height* was the wrong type.** The specified
`drawnGroundHeightAtBand(map, x, y, band)` returns the top of the sub-stack you
would get if every level of the surface used one band's sample field — which is
not the stack anything builds, because the real surface reloads the sample band
at each level. At a cave mouth it returned 240 where the topmost drawn cap was
336. It had zero legitimate callers. `a376c64` replaced it with the predicate
`drawnGroundCoversBand`, which is the question the level-set renderer actually
asks, and made the height the fixpoint described above.

**3. "Sheer walls become true vertical faces at the cell edge" is false.**
The handoff justified the whole approach partly on this: today's mesher spreads a
30-band wall over ¾ of a cell as ~31 treads, and bilinear-then-floor was supposed
to collapse that to one face. It does not. Bilinear interpolation at `N = 4`
turns any drop into a staircase up to four sub-cells wide, straddling the cell
boundary with two treads on each side. Measured on a map with cells `x ≤ 3` at
height 80 and `x ≥ 4` at 0, the sub-cell centre heights running across the seam
are **80, 80, 64, 48, 16, 0**. The mesher's 31-tread smear is gone and the result
is far crisper, but a single vertical face is not what replaced it. The owner
accepted vertical faces; what shipped is a four-step stair, and anyone measuring
against "one face" will find a discrepancy that is not a bug.

### The world frame did not change — the renderer moved

Cell *i*'s **centre** is at world `i · CELL_WORLD_SIZE`, and its continuous cell
coordinate is `i + 0.5`. That was already true and stays true; `shared/` owns it
as `cellCoordToWorld` / `worldToCellCoord` with `CELL_CENTRE_OFFSET_CELLS`.

The GPU prototype placed cell *i* over the span `[i, i+1]`, i.e. half a cell off,
and that leaked into shipped code twice from two different directions — the
terrain instance origins and vertex positions (`c146117`), and then the water
tile emitter (`c9bc50e`). Two independent half-cell bugs with one cause is the
signature of a convention living in more than one place, so the conversion now
exists once in `shared/src/constants.ts` and the GLSL mirrors that one function
rather than open-coding a multiply. **Rejected:** moving the world to the
prototype's `[i, i+1]` frame, which would have been a smaller shader diff and a
change to every stored world, every plugin placement and the wire format.

### Hardware filtering is forbidden in the geometry path

Heights upload as **R16I** and are read through an `isampler2D` with four
`texelFetch` calls; the shader then does the same integer arithmetic as
`drawnGround.ts`, including its own floor-toward-minus-infinity divide. Hardware
bilinear filtering carries roughly 8 bits of sub-texel precision, which is not
enough to reproduce an exact integer blend, so it is barred from anything that
decides geometry. It remains fine for the fragment-shader isoline colouring,
which is where `smoothHeight` uses it.

The negative control that proves the parity gate is not vacuous: replacing GLSL
`floorDivPositive` with plain `a / b` produces **87,915 mismatches**, 38 of them
on an all-positive map — the low-edge lattice offsets go negative
(`latticeOffset` is `−3` in the first quarter-cell) even when no height is, so
truncation and flooring diverge at the world border regardless of sign.

### The span cap is a shader budget, and enforcing it cost two bugs

`MAX_SPANS_PER_COLUMN = 8` exists for one reason: a shader has to loop a fixed
number of times. It is a **write-path** limit, and `4d3a736` fixed two ways the
first enforcement broke things that were not writes.

- Enforcing it on the **decode** path made any world saved with 9+ spans
  unloadable — `parsePackedSpans` returned `null` and the column was dropped.
  It now merges an over-cap column down via `fitColumnToSpanCap` (undrawn gaps
  first, then the smallest drawn gaps, lowest index breaking ties), so an old
  save loads with a surface a player would struggle to distinguish.
- Refusing a carve on **span count alone** froze a capped column against the very
  carve that would have shrunk it. `carveKeepsSpanCap` now asks `carveRange`'s
  own result what the column would become, rather than guessing from the count.

### Unreceived chunks are fixed at the mirror, not in `shared/`

The client stores never-received cells as 0, so a bilinear blend at the frontier
pulled the drawn surface toward sea level against ground that has not arrived —
and the GPU path had lost the mesher's received-chunk guard entirely, so it drew
those chunks. Two fixes:

- `13068c7` restored the guard: a chunk is not built or uploaded until
  `mirror.received` has it.
- `TerrainMirror` gained a **`renderMap`** — `map`, except that cells in
  unreceived chunks carry their nearest received neighbour's height, probed
  orthogonally before diagonally out to `RENDER_HALO_CELLS = 2` (one cell for the
  coarsest skirt step, one for the blend), falling back to `SEA_LEVEL` when
  nothing within reach has arrived. The GPU renderer samples `renderMap`, and
  upload rectangles are grown by the halo so a chunk's arrival also repairs its
  neighbours' borrowed cells.

**This is deliberately not in `shared/`.** The parity gate only means something
if the shader and the TypeScript read literally the same bytes; a
"received-ness" notion inside `drawnGround.ts` would be a client concept the
server has no counterpart for, and it would have to be uploaded and branched on
in the shader. Fixing it at the mirror keeps `drawnGround.ts` a pure function of
a `Heightmap` and makes the frontier a question of *which heightmap you hand it*.

### The parity gate

`client/scripts/gpuTerrainParity.mjs` renders the shader's height field into an
`RGBA32I` target and compares **every texel** to `drawnGroundHeight`. **Zero
mismatches is the bar**, and it is the thing that must keep passing: it is the
only mechanism that stops the shader and `shared/` drifting apart, and
`gpuTerrainField.ts` says so at the top of the GLSL.

It covers the frostwick patch at `N = 4` and `N = 1`, the same patch shifted by
−400 and −1400 so the sub-sea-level cases exercise floor-versus-truncate, a
pseudo-random full-range sweep, and one `texSubImage2D` rectangle upload so the
sculpt path is checked and not just the initial load. It runs headless Chrome on
ANGLE/SwiftShader, so it needs no GPU and can run in CI.

### Why this is worth the rewrite (measured, RTX 3090, ANGLE/D3D11, 1200×900)

| Config | Triangles | Draw calls | GPU p99 |
| --- | --- | --- | --- |
| Shipped client 512², whole scene | 3.49 M | 151 | 3.15 ms |
| GPU blocks N=1, 512² | 1.57 M | 1 | 0.23 ms |
| GPU N=4, 512² | 25.2 M | 1 | 2.80 ms |
| GPU blocks N=1, 2048² | 25.2 M | 1 | 2.92 ms |
| GPU N=4, 2048², no LOD | 403 M | 1 | 38 ms |

Sculpt is the larger win: a 16×16 texture upload is ≈1.2 µs amortised against
≈1.87 ms per chunk to rebuild a mesh. Memory goes from ~57 B per triangle of
vertex attributes (199 MB at 3.49 M triangles) to an 8.4 MB height texture at
2048². The last row is why LOD is not optional at 2048²: `TERRAIN_LOD_NEAR_N = 4`
inside `TERRAIN_LOD_NEAR_RADIUS_CHUNKS`, `TERRAIN_LOD_FAR_N = 1` beyond it, both
single named constants so the near/far split is a one-line retune.

Caveat on the baseline, recorded so it is not over-claimed: 3.15 ms is the whole
scene, not terrain alone, and the 2048² figures came from a 48×48 patch tiled,
which is denser in sheer faces than a real world.

### Still open

- **Spans in the shader (Phase 2f) was not done.** `drawnGround.ts` is
  span-aware; `gpuTerrainField.ts` is not — it reads one height per cell, and the
  parity harness only builds single-span maps. Until the indirection texture and
  packed span buffer land, the GPU renderer draws a carved world as if it were
  unlayered, and the parity gate does not cover the layered path. This is the
  one place where the shader and `shared/` are knowingly not the same function.
- The GPU renderer is behind `?gpuTerrain=1`; the CPU mesher still ships, and the
  deletions the handoff lists have not happened.
