# Drawn ground as a shared function — report

Branch `worktree-agent-a8d5177dccd773647` in
`E:\Development\Projects\Terrace\.claude\worktrees\agent-a8d5177dccd773647`.

## Commits

| commit | step | paths |
| --- | --- | --- |
| `e5b9c4f` | 1 | `shared/src/drawnGround.ts` (new), `shared/src/index.ts` |
| `01a04eb` | 2 | `contours.ts`, `contourSmoothing.ts`, `capEmission.ts`, `vertexGrid.ts`, `config.ts`, `brushPreview.ts`, `water/waterTread.ts`, `client/scripts/drawnGroundParity.mjs`, 3 test files |
| `ce62175` | 3 | `shared/src/drawnGround.ts` — `drawnSpanCapHeight` |
| `03dd1db` | 3 | `capEmission.ts`, `terrain/drawnGround.ts`, `terrain/picking.ts`, `test/drawnGround.test.ts`, `test/pickAgreesWithMesh.test.ts`, `test/picking.test.ts` |
| `c6fa2cd` | 3 | `shared/src/drawnGround.ts` — `drawnBandOfSpan`, `drawnSpanIndexCoveringBand` |
| `6f1187a` | 3 | `terrain/picking.ts`, `terrain/pickBand.ts`, `terrain/capEmission.ts` — riser attribution |

The first two were the previous agent's; the rest are this session's.

## The function as implemented

`shared/src/drawnGround.ts`

- `DRAWN_GROUND_COORD_DENOM = 1024` — :14
- `DRAWN_GROUND_BAND_BIAS = BAND_HEIGHT / 2` — :16
- `ISOLINE_SAMPLES_PER_CELL = 4` — :18
- `SHEER_WALL_SPREAD_CELLS = 1` — :20
- `drawnBandOfSample(height)` — :36
- `drawnBandOfSpan(span)` / `drawnSpanCapHeight(span)` — :40, :44
- `drawnSpanIndexCoveringBand(map, x, y, band)` — :48
- `drawnCrossingFraction(outside, inside, threshold)` — wall remap inside
- `drawnFieldNumerator(map, qx, qz, band)` — exact integer numerator
- `drawnIsolineAt(...)` — integer bisection on the field
- `drawnBandAt(map, x, z)` — layered-column branch inside
- `drawnHeightAt(map, x, z)`

Consumers:

- `client/src/terrain/drawnGround.ts` — `capYAt` and `bandAt` are the function; `capYOfBand`, `loopsAt`, `nearestOnContour` still read the chart.
- `client/src/terrain/picking.ts` — `drawnCapMet` (the drawn cap the ray meets inside a marched cell), `columnOwningBand` (which column supplies it).
- `client/src/terrain/capEmission.ts` — `drawnBandCapY(band, height)` is the single definition of which world Y a band's cap is drawn at, seabed sink included. `blockyCellCapY`, the oracle and picking all call it.
- `client/src/plugins/kit/groundFollow.ts` already routes through `ctx.drawnGroundYAt` → `world.ts` → `capYAt`, so it reads the function with no change.

## Gate

    node client/scripts/drawnGroundParity.mjs

    PASS relaxed real patch: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS stamped whole-band plateau with 4-cell treads: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS sheer multi-band wall in one cell: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS saddle: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS chunk seam: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS layered column: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks

All six fixtures the plan asks for are present in the script, and the gate still
holds after the `capEmission` change below.

## Budgets, before and after

Fixture: the 256-chunk world of `client/test/pickAgreesWithMesh.test.ts`, every
chunk planned by `planChunkCaps`. "Before" measured with
`git checkout 60027e4 -- client shared`, keeping `config.ts` at HEAD so the
script runs outside Vite.

| measure | before (`60027e4`) | after | change |
| --- | ---: | ---: | ---: |
| cap triangles | 27,766 | 17,568 | −36.7% |
| skirt triangles | 81,252 | 49,346 | −39.3% |
| total triangles | 109,018 | 66,914 | −38.6% |
| triangulation work | 1,423,804 | 630,616 | −55.7% |
| worst polygon work | 7,396 | 4,761 | −35.6% |
| worst chunk triangles | 1,090 | 686 | −37.1% |
| chunks over budget | 0 | 0 | — |

Budgets themselves are unchanged: `CHUNK_TRIANGLE_BUDGET` 131,072,
`CHUNK_TRIANGULATION_WORK_BUDGET` 4,194,304, `CHUNK_POLYGON_WORK_BUDGET`
262,144. Nothing was loosened. Deleting Chaikin more than pays for the three
isoline points per contour segment.

## Test expectations changed, and why

1. `client/test/drawnGround.test.ts` — sample grid start `0.5` → `OFF_CONTOUR = 1/4`.
   The terraced fixture's heights are exact band multiples, so every contour lands
   on a half-integer and the old grid put 189 of its 4,096 samples *on* a contour.
   `drawnBandAt` is inclusive there; the test's point-in-polygon oracle uses a
   half-open rule, so on a boundary it is a coin flip. Off the tie lattice the two
   agree everywhere (`disagreements: 0 of 4096`).
2. `client/test/picking.test.ts` — `quantizeToBand(raw)` → `drawnBandOfSample(raw)`;
   old value `BAND_HEIGHT * 3`, new value `BAND_HEIGHT * 4`, for `raw = 3.5` bands.
   `G = F + BAND_HEIGHT/2` makes the drawn cap the *nearest* band, and the test's
   own name — "reports the RENDERED surface" — is what now holds.
3. `client/test/pickAgreesWithMesh.test.ts` — the sweep rays aimed at
   `terrainHeight(tx, tz)`. With the cap at the nearest band that aim point is *on*
   the cap plane whenever the height is a band multiple, so the ray is exactly
   tangent: three.js reports no hit, the marcher reports one. 24 of 3,744 rays.
   Rays now aim at `aimInsideDrawnBand` — half a band below the drawn cap, the
   middle of the topmost drawn band. `disagreedOnHit` 24 → 0.

## Two defects found and fixed in picking

- **Cap height.** `terrainHitInCell` used `spanCapHeight` (`quantizeToBand`, floor)
  while the mesher draws `drawnBandOfSample` (nearest). Exact cell agreement on the
  sweep was 0.4392 at `01a04eb`.
- **The band-0 seabed sink.** The mesher draws band 0's cap at `-SEABED_CAP_SINK`
  (`WATER_SURFACE_LIFT / 2`) so water renders over it; picking intersected the
  plane at 0. That 1/64 world unit produced the 3-cell disagreements at grazing
  angles. `drawnBandCapY` is now the one place the rule lives; picking intersects
  the sunk plane but reports `surfaceY`/`hitY` on the band plane, which is what the
  band arithmetic downstream needs.

`DRAWN_CAP_SAMPLES_PER_CELL = 2 * ISOLINE_SAMPLES_PER_CELL`: a cell holds at most
two contour segments and the mesher draws each with `ISOLINE_SAMPLES_PER_CELL`
sub-intervals, so this is the pitch of the finest cap feature the mesher can put
inside one cell. Measured: 4 samples → worst 3 (fails the bar), 8 → worst 2,
16 → worst 1. 8 is the smallest that meets the stated bar.

## Riser attribution — fixed

The seven failures I first reported as stale expectations were not. Four were a
regression I introduced, and chasing it turned up a second, larger one that has
nothing to do with cliffs.

**Root cause, one sentence.** Two rules answered "which band is the drawn surface
here" — `spanCapHeight`/`bandOf` (floor) in the simulation and `drawnBandOfSample`
(nearest) in what is drawn — and every client site that asked a drawn-surface
question through the floor rule disagreed with the mesh by up to one band.

Three sites were on the wrong rule:

1. **`pickBand.ts`** bounded a pick with `spanCapHeight`. On *flat ground* whose
   height sat in the upper half of a band — half of all heights — the drawn cap was
   one band above that bound, so `resolvePick` rejected the pick outright: no band,
   no carve, no hover. Measured before the fix, cells at `3 bands + 8..15`:
   `resolvePick` → `null`. After: `{face: 'tread', band: 3}` at every offset. The
   returned band is unchanged — it is the *simulation* band, which is what a carve
   intent addresses and what the server validates.
2. **`capEmission.ts`** took the buried floor level from `bandOf(spanCapHeight(span))`.
   That level is a drawn level.
3. **`picking.ts`** named the cell whose territory the ray landed in, with no regard
   for which column supplies the material there.

### The attribution rule

A pick answers two questions that used to share one field: *where did the ray
land* and *what did it land on*. On a cliff they differ — the lower half of a tall
wall's face is drawn over the low cell's territory but made of the tall cell's
rock. Picking now keeps the hit point where the face is drawn and names the column
that supplies the struck band:

- `drawnCapMet` reports the band it met and where it met it.
- If the marched cell's own column supplies that band (`drawnSpanIndexCoveringBand`),
  the pick stays put and only its `spanIndex` is corrected.
- Otherwise `columnOwningBand` hands the hit to an **edge neighbour** whose span
  both covers the band and contains the strike height. Edge neighbours only: the
  face the ray struck lies on a boundary the ray crossed, so a diagonal jump would
  name a cell the ray never passed.
- `surfaceY` is one rule everywhere — the drawn cap of the resolved span.

Two guards earn their place. `spanStruckAt` requires the strike to sit between the
span's underside and its drawn cap, so a ray travelling through a carved notch is
not captured by the overhang whose face is drawn above it. And `pickTerrainInColumn`
now marches and keeps the first hit naming the asked-for cell, instead of clipping
to that cell's box — after attribution the named column is not always the cell the
ray crossed, and clipping produced a different hit than the march it is defined to
agree with.

### Measured — ten ray heights at a ten-band wall

Horizontal rays at each band's cap height, wall at `x >= 32`. "Before" is base
`60027e4`.

| ray band | mesh hits x | mesh cell | picked cell before | after | resolves before | after |
| ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 31.051 | 31 | 32 | 32 | riser 1 | riser 1 |
| 2 | 31.151 | 31 | 32 | 32 | riser 2 | riser 2 |
| 3 | 31.251 | 31 | 32 | 32 | riser 3 | riser 3 |
| 4 | 31.351 | 31 | 32 | 32 | riser 4 | riser 4 |
| 5 | 31.451 | 31 | 32 | 32 | riser 5 | riser 5 |
| 6–10 | 31.55–31.95 | 32 | 32 | 32 | riser 6–10 | riser 6–10 |

The hit point moved onto the face — `hitX` runs 31.125 to 32.0 across the ten
instead of sitting at 31.5 for all of them — while the cell stayed the column that
owns the rock. `surfaceY` is 2.5 for all ten.

Between those two states, at `03dd1db`, the pick named cell 31 for bands 1–5 and
resolved to nothing at all.

`pickAgreesWithMesh` sweep, exact-cell agreement: **0.9872**, worst disagreement
**2**, hit disagreements **0** — inside `MIN_EXACT_AGREEMENT` 0.95 and
`MAX_CELL_DISAGREEMENT` 2.

### Test state

    cd client && npx vitest run
    Test Files  41 passed (41)
         Tests  600 passed (600)

`shared` 320/320. Parity gate 6/6 with zero mismatches. Budgets unchanged from the
table above. Lint clean on every file touched.

## What could not be done

### 1. `SHEER_WALL_SPREAD_CELLS` is implemented, inert at 1, and unusable below 1

The remap is real and at 1 it reduces to `s = exact`, so it is inert as the plan
requires. It is not, however, usable. It lives in `drawnCrossingFraction`, which
only the mesher's marching calls to place contour vertices; `drawnBandAt` reads the
raw bilinear field. Setting the constant below 1 moves the drawn wall without
moving the function, so the mesh and the function stop agreeing and the parity gate
no longer holds. Measured at 0.1: the wall tests failed identically, because
picking follows the function.

For the dial to work the remap has to be inside the field — the function must warp
the same way near a sheer pair — not applied at the crossing. That is a change to
the function the plan defines, so I left it alone.

### 2. `climbRiser.ts` still walks a probe

`client/src/plugins/kit/climbRiser.ts` steps forward in `BAND_GRID_CELLS`
increments until the drawn ground rises above the feet. Every probe is already a
query of the shared function (`drawnGroundYAt` → `capYAt` → `drawnBandAt`), so
nothing there reads a chart any more. One query cannot replace it: the loop answers
"how far along this heading is the next riser", which is the position of an isoline
along a line, not a value at a point. `shared/` exposes `drawnIsolineAt`, but it
solves along a cell edge with one coordinate fixed, not along an arbitrary heading.
Adding a directional solver is beyond what the plan sanctions.

### 3. A residual failure mode worth knowing about

Where a column is notched or overhung, the drawn surface and the material can
disagree *within* a cell: the mesher draws the top surface from a field over cell
samples, so an overhang's face is smeared across the cell edge even where the
neighbouring column has been carved away. Picking now refuses those strikes (the
hit must lie inside the owning span), which is right, but it means a pick and the
mesh can differ by a cell right at a notch mouth. It did not fire on any fixture or
test; recording it rather than claiming it cannot happen.

### 4. Pre-existing, not mine

`plugins/mana typecheck: test/mana.test.ts(940,74): error TS2554: Expected 2
arguments, but got 3` — `sculptDisplacementUnits` takes 2. Present at base
`60027e4`; another agent's in-flight work. Everything else typechecks.

## Step 4 — layered columns

Expressible, and already implemented in `drawnBandAt`: when any cell in the sampled
2×2 carries spans, the function walks down from the top band and takes the first
band whose `columnSampleAtBand` field still covers it, floored at the lowest drawn
span nearby. Verified on the plan's layered fixture — a 9×9 slab with spans
`[bedrock, 2 bands]` and `[5 bands, 7 bands]` over ground at band 2:

    under the slab centre (24,24): drawnBand=7 drawnHeight=112
    slab edge            (28,24): drawnBand=7 drawnHeight=112
    just outside         (29,24): drawnBand=2 drawnHeight=32
    open ground          (32,24): drawnBand=2 drawnHeight=32

The gate's "layered column" fixture passes with 0 mismatches.

## Proposed contract tests (not written — no permission)

| file | name | assertion |
| --- | --- | --- |
| `shared/test/drawnGround.test.ts` | the band is the nearest band, not the floor band | `drawnBandOfSample(k*BAND_HEIGHT + BAND_HEIGHT/2) === k + 1` and `drawnBandOfSample(k*BAND_HEIGHT + BAND_HEIGHT/2 - 1) === k`, k in −3..3 |
| `shared/test/drawnGround.test.ts` | the field is exact — no float decides a band | over a random integer heightmap, `drawnBandAt` at 1/1024 steps equals the numerator recomputed in BigInt |
| `shared/test/drawnGround.test.ts` | a cell centre always reports its own band | for every cell, `drawnBandAt(map, i+0.5, j+0.5) === drawnBandOfSample(cells[i,j])` |
| `shared/test/drawnGround.test.ts` | the drawn span lookup follows the drawn cap | for a cell at `k*BAND_HEIGHT + BAND_HEIGHT/2`, `drawnSpanIndexCoveringBand(..., k+1)` finds the span and `spanIndexCoveringBand(..., k+1)` does not |
| `shared/test/drawnGround.test.ts` | the wall remap is inert at 1 | `drawnCrossingFraction(a, b, T)` equals the clamped exact fraction for rises both above and below `SHEER_RISE_HEIGHT_UNITS_PER_CELL` |
| `client/test/pickBand.test.ts` | a pick resolves at every height in a band | flat worlds at `k*BAND_HEIGHT + 0..BAND_HEIGHT-1` all resolve to `{face:'tread', band:k}` |
| `client/test/picking.test.ts` | a struck face names the column that supplies it | ten ray heights at a ten-band wall all name the tall cell and resolve to `riser k`, with `hitX` on the drawn face |
| `client/test/picking.test.ts` | a ray through a notch is not caught by the overhang above it | after carving one band out of the wall, the pick lands beyond the wall cell |
| `client/test/drawnGround.test.ts` | the drawn cap Y has one definition | `blockyCellCapY(h) === drawnBandCapY(drawnBandOfSample(h), h)` across the band-0 seabed/shore boundary |
