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

The first two were the previous agent's; the last two are this session's.

## The function as implemented

`shared/src/drawnGround.ts`

- `DRAWN_GROUND_COORD_DENOM = 1024` — :14
- `DRAWN_GROUND_BAND_BIAS = BAND_HEIGHT / 2` — :16
- `ISOLINE_SAMPLES_PER_CELL = 4` — :18
- `SHEER_WALL_SPREAD_CELLS = 1` — :20
- `drawnBandOfSample(height)` — :36
- `drawnSpanCapHeight(span)` — :40 (added this session)
- `drawnCrossingFraction(outside, inside, threshold)` — :52, wall remap at :60–64
- `drawnFieldNumerator(map, qx, qz, band)` — :98, exact integer numerator
- `drawnIsolineAt(...)` — :126, integer bisection on the field
- `drawnBandAt(map, x, z)` — :200, layered-column branch at :204–209
- `drawnHeightAt(map, x, z)` — :212

Consumers:

- `client/src/terrain/drawnGround.ts:53` `capYAt`, `:68` `bandAt` — both the function; `capYOfBand`, `loopsAt`, `nearestOnContour` still read the chart.
- `client/src/terrain/picking.ts:462` `drawnCapMet` — the drawn cap the ray meets inside a marched cell; used at `:480` `terrainHitInCell`.
- `client/src/terrain/capEmission.ts:320` `drawnBandCapY(band, height)` — the single definition of which world Y a band's cap is drawn at, including the band-0 seabed sink. `blockyCellCapY` (:325), the oracle and picking all call it.
- `client/src/plugins/kit/groundFollow.ts:34` already routes through `ctx.drawnGroundYAt` → `world.ts:357` → `capYAt`, so it reads the function with no change.

## Gate

    node client/scripts/drawnGroundParity.mjs

    PASS relaxed real patch: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS stamped whole-band plateau with 4-cell treads: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS sheer multi-band wall in one cell: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS saddle: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS chunk seam: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
    PASS layered column: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks

All six fixtures the plan asks for are present in the script.

## Budgets, before and after

Fixture: the 256-chunk world of `client/test/pickAgreesWithMesh.test.ts` (the
`terrainHeight` sin/cos field, 64 world units across), every chunk planned by
`planChunkCaps`. Script: `scratchpad/budget.mjs`. "Before" measured with
`git checkout 60027e4 -- client shared`, keeping `config.ts` at HEAD so the
script can run outside Vite.

| measure | before (`60027e4`) | after (`03dd1db`) | change |
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

1. `client/test/drawnGround.test.ts:107` — sample grid start `0.5` → `OFF_CONTOUR = 1/4`.
   The terraced fixture's heights are exact band multiples, so every contour lands
   exactly on a half-integer and the old grid put 189 of its 4,096 samples *on* a
   contour. `drawnBandAt` is inclusive there (`>= threshold`); the test's
   point-in-polygon oracle uses a half-open rule, so on a boundary it is a coin
   flip. Off the tie lattice the two agree everywhere
   (`scratchpad/diag2.mjs`: `disagreements: 0 of 4096`).
2. `client/test/picking.test.ts:156` — `quantizeToBand(raw)` → `drawnBandOfSample(raw)`;
   old value `BAND_HEIGHT * 3`, new value `BAND_HEIGHT * 4`, for `raw = 3.5` bands.
   The plan's `G = F + BAND_HEIGHT/2` makes the drawn cap the *nearest* band, and
   the test's own name — "reports the RENDERED surface" — is what now holds.
3. `client/test/pickAgreesWithMesh.test.ts:39,156` — the sweep rays aimed at
   `terrainHeight(tx, tz)`. With the cap at the nearest band, that aim point is
   *on* the cap plane whenever the height is a band multiple, so the ray is
   exactly tangent: three.js reports no hit, the marcher reports one. 24 of 3,744
   rays. Rays now aim at `aimInsideDrawnBand` — half a band below the drawn cap,
   the middle of the topmost drawn band — so they enter the solid as they did when
   the cap was the floor band. `disagreedOnHit` 24 → 0.

## Two real defects found and fixed in picking

- **Cap height.** `terrainHitInCell` used `spanCapHeight` (`quantizeToBand`, floor)
  while the mesher draws `drawnBandOfSample` (nearest). Exact cell agreement on the
  sweep was 0.4392 at `01a04eb`.
- **The band-0 seabed sink.** The mesher draws band 0's cap at `-SEABED_CAP_SINK`
  (`WATER_SURFACE_LIFT / 2`) so water renders over it; picking intersected the plane
  at 0. That 1/64 world unit is what produced the remaining 3-cell disagreements at
  grazing angles. `drawnBandCapY` is now the one place that rule lives; picking
  intersects the sunk plane but still *reports* `surfaceY`/`hitY` on the band plane,
  which is what the band arithmetic downstream (`bandOfPick`, carve) needs.

`pickAgreesWithMesh` sweep, exact-cell agreement (`scratchpad/aimvariants.mjs`):

| state | exact | worst | hit disagreements |
| --- | ---: | ---: | ---: |
| `60027e4` (before the mesher change) | 0.9623 | 2 | 0 |
| `01a04eb` (mesher only) | 0.4392 | 4 | 24 |
| `03dd1db` (this session) | 0.9896 | 2 | 0 |

Test limits: `MIN_EXACT_AGREEMENT` 0.95, `MAX_CELL_DISAGREEMENT` 2 cells.

`DRAWN_CAP_SAMPLES_PER_CELL = 2 * ISOLINE_SAMPLES_PER_CELL` (picking.ts:447): a
cell holds at most two contour segments and the mesher draws each with
`ISOLINE_SAMPLES_PER_CELL` sub-intervals, so this is the pitch of the finest cap
feature the mesher can put inside one cell. Measured: 4 samples → worst 3 (fails
the bar), 8 → worst 2, 16 → worst 1. 8 is the smallest that meets the stated bar.

## What could not be done

### 1. Seven client tests fail, and the reason is a design decision, not a bug

    cd client && npx vitest run
    Test Files  2 failed | 39 passed (41)
         Tests  7 failed | 593 passed (600)

- `picking.test.ts` — "picks the tall cell when a shallow ray strikes its riser",
  "walks over a lower plateau to land on the higher ground behind it",
  "lands on revealed terrain BEHIND an unrevealed gap"
- `hoverPick.test.ts` — the four #324 / #349 carve tests

All seven are one root cause. Deleting the centre guard and the clearance
crossing formula (plan, Mesher §1) means a sheer wall's riser bands no longer sit
on the cell boundary; they spread across the neighbouring low cell. For a
10-band wall at `x >= 32`, band k's contour sits at `x = 31 + (k*16 - 8)/160`, so
bands 1..5 are drawn over cell 31, not 32.

Verified against the mesh, not inferred (`scratchpad/wallcheck.mjs`): a
horizontal ray at band-5 height hits the three.js mesh at cell x = 31.451,
y = 1.25; picking now reports cell 31, hitX 31.5, hitY 1.25. Picking agrees with
what is drawn. The tests encode the older blocky semantics — clicking a cliff
face selects the tall cell, and a held carve keeps cutting the same band along
the wall (#349).

I did not rewrite those expectations. Doing so asserts the opposite of two closed
issues and changes what clicking a cliff face selects. The options:

- Accept it: update the seven expectations to the drawn geometry.
- Pull the wall back to the cell edge: this is what `SHEER_WALL_SPREAD_CELLS`
  exists for — but as implemented it cannot do it. See item 2.

### 2. `SHEER_WALL_SPREAD_CELLS` is implemented, inert at 1, and unusable below 1

The remap is real (`drawnGround.ts:60–64`) and at 1 it reduces to `s = exact`, so
it is inert as the plan requires. It is not, however, usable. It lives in
`drawnCrossingFraction`, which only the mesher's marching calls to place contour
vertices; `drawnBandAt` reads the raw bilinear field. Setting the constant below
1 moves the drawn wall without moving the function, so the mesh and the function
stop agreeing and the parity gate no longer holds. Measured at 0.1: the seven
tests fail identically, because picking follows the function.

For the dial to work the remap has to be inside the field — the function must
warp the same way near a sheer pair — not applied at the crossing. That is a
change to the function the plan defines, so I left it alone.

### 3. `climbRiser.ts` still walks a probe

`client/src/plugins/kit/climbRiser.ts:45–55` steps forward in `BAND_GRID_CELLS`
increments until the drawn ground rises above the feet. Every probe is already a
query of the shared function (`drawnGroundYAt` → `capYAt` → `drawnBandAt`), so
nothing there reads a chart any more. One query cannot replace it: the loop
answers "how far along this heading is the next riser", which is the position of
an isoline along a line, not a value at a point. `shared/` exposes
`drawnIsolineAt`, but it solves along a cell edge with one coordinate fixed, not
along an arbitrary heading. Adding a directional solver to `shared/` is beyond
what the plan sanctions.

### 4. Pre-existing, not mine

`plugins/mana typecheck: test/mana.test.ts(940,74): error TS2554: Expected 2
arguments, but got 3` — `sculptDisplacementUnits` takes 2. Present at base
`60027e4`; another agent's in-flight work. Everything else typechecks;
`shared` is 320/320 green.

## Step 4 — layered columns

Expressible, and already implemented in `drawnBandAt:204–209`: when any cell in
the sampled 2×2 carries spans, the function walks down from the top band and
takes the first band whose `columnSampleAtBand` field still covers it, floored at
the lowest drawn span nearby. Verified (`scratchpad/layered.mjs`) on the plan's
layered fixture — a 9×9 slab with spans `[bedrock, 2 bands]` and `[5 bands, 7
bands]` over ground at band 2:

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
| `shared/test/drawnGround.test.ts` | the wall remap is inert at 1 | `drawnCrossingFraction(a, b, T)` equals the clamped exact fraction for rises both above and below `SHEER_RISE_HEIGHT_UNITS_PER_CELL` |
| `shared/test/drawnGround.test.ts` | a layered column reports its topmost drawn span | the plan's layered fixture: band 7 over the slab, band 2 one cell outside |
| `client/test/drawnGround.test.ts` | the drawn cap Y has one definition | `blockyCellCapY(h) === drawnBandCapY(drawnBandOfSample(h), h)` across the band-0 seabed/shore boundary |
| `client/test/picking.test.ts` | picking and the mesher agree on the seabed cap | for `h <= SEA_LEVEL` in band 0, a vertical pick intersects at `-SEABED_CAP_SINK` while `surfaceY` stays 0 |
| `client/test/pickAgreesWithMesh.test.ts` | a ray tangent to a cap is not a disagreement | the sweep asserted with `aimInsideDrawnBand`, as it now is |
