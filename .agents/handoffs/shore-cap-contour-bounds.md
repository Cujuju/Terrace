# Shore cap: bound it by its contour, not the water plane

Agent brief. Facts only; read the cited lines before changing anything.

## Symptom
At every coast a straight-edged, lip-less "slab" draws at world y 0, level with the
water plane, with the wavy band-1 terraces starting behind it (owner screenshots
2026-09-11). Live probe on the owner's world: 0 cap triangles over air on the GPU
mesher, so the slab is drawn data, not a mesher fault.

## What the slab is
Both meshers add a **shoreline level** to every chunk that holds band 0:
- CPU: `client/src/terrain/capEmission.ts` `makeLevels`, the `if (k === 0)` push:
  threshold `SEA_LEVEL + 1`, sampleBand 0, capY 0, undersideY 0, skirtDrop
  `SEABED_CAP_SINK`, `crossingOverride: SHORE_EDGE_CROSSING`.
- GPU: `client/src/render/gpuMesher/mesherWgsl.ts` `emitLevel` with `isShore`:
  threshold `SHORE_THRESHOLD` (`bandLut.ts`, = SEA_LEVEL + 1), bias 0,
  `computeCrossings(mask, true, SHORE_EDGE_CROSSING, …)`, `buildPolyline(…, refine = false)`,
  `appendLips` skipped. Level list mirrored in `gpuChunkBuildSource.ts` `gpuCapPlan`
  (`if (k === 0)`), `levelRangeMaxY`.
- `SHORE_EDGE_CROSSING = 0.5` (`client/src/terrain/contours.ts`); `levelBandBias`
  returns 0 for an override, so the shore region is exactly {h ≥ 1}.
- Heights: cap of band k is `k * BAND_WORLD_HEIGHT` (0.25 wu); band 0's cap is
  `-SEABED_CAP_SINK` (= `WATER_SURFACE_LIFT / 2` = 1/64); water plane at
  `SEA_LEVEL * scale + WATER_SURFACE_LIFT` (1/32); shore cap at 0.
- Drawn band of a sample is `floor((h + BAND_HEIGHT/2) / BAND_HEIGHT)`
  (`shared/src/drawnGround.ts` `drawnBandOfSample`), so cells with 8 ≤ h ≤ 15 are
  band 1 (wavy, refined cap at 0.25) and cells with 1 ≤ h ≤ 7 are band 0. The
  visible slab is exactly the cells 1 ≤ h ≤ 7: shore cap at y 0, midpoint
  crossings, no refinement, no lip lines.
- Every other level refines its contour to the isoline
  (`ISOLINE_SAMPLES_PER_CELL`, `contourSmoothing.ts` dropCollinear; same in WGSL
  `buildPolyline`) and appends lips.

## Why it exists (recorded)
`docs/decisions/movement.md` "They were never in the water": band-0 dry land
(height 1 to BAND_HEIGHT−1) is drawn at SEA_LEVEL and the water plane floats just
above it, so the coastal fringe was underneath the sea; the shore level draws that
fringe at 0, above band 0's sunken cap. `docs/DESIGN.md` and `docs/decisions/` hold
no rule that the shore contour must be unrefined; the midpoint crossing is a
constant, not a decision entry.

## Owner's ask (verbatim)
"There's no reason that in this picture that ground slab should be drawing at the
same level as the water slab. It should be bounded by its contour lines."

## Constraints
- `shared/` is the single source of truth for terrain math; CPU and GPU meshers must
  stay in parity (`mesherDump` harness, `?mesher=gpu|cpu`).
- Picking oracle: `shared/src/drawnGround.ts` / `client/src/terrain/pickBand.ts`
  reason about band 0 and the shore; a change to where the shore cap sits or how
  its edge runs must keep `pickCell` and `drawnGroundYAt` agreeing with the mesh.
- `render/water.ts` draws the sea plane per cell over `isWater(h) = h <= SEA_LEVEL`;
  a refined shore edge no longer coincides with cell centres.
- Tests are not to be written without the owner's per-session permission.
