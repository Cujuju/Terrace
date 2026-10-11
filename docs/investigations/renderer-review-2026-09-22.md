# Renderer reviews — September 22, 2026

The owner requested three separate background reviews of picking/rebuild
checks, flora grounding, and fractional entity grounding. All three completed
read-only. These are code findings, not measured attribution of an FPS loss.
No flora or entity-grounding code was changed by the filter-removal work.

## Picking and rebuild checks

- High priority: `client/src/render/terrainMeshes.ts` removes a dirty chunk's
  published chart before the replacement is ready, while old geometry remains
  visible. `client/src/terrain/pick/rayMarch.ts` checks publication availability,
  so the whole chunk becomes temporarily unpickable in raw mode too. This can
  interrupt a continuous brush stroke. It is not proof of the reported tiny-hole
  failure. Keeping a chart requires keeping its field/mesh snapshot coherent;
  simply bypassing the check risks picking different geometry from the display.
- Raw-path duplicated work: `terrainHitInCell` and its private legacy helper both
  call `cellRevealed`. `drawnCapMet` also resolves the surface adapter per sample
  instead of once per query. These are bounded opportunities, not measured FPS
  regressions.
- Filtered-only work: ray cells scan crossed bands and neighboring published
  wall segments. Owner lookup also searches a neighborhood (now reduced from
  49 to 25 candidate offsets with the smaller kernel reach).
- Generation/revision/disposal rejection and publication after geometry upload
  are necessary. Removing those checks would admit stale render/query state.

Resolution (#504, 2026-09-22): charts stay published through rebuilds; queries
read live terrain, no snapshot (owner decision). Revision rejection now drops
only answers older than the displayed geometry. Duplicate `cellRevealed` and
per-sample adapter lookup removed. Traversal cost measured, left as is. The
tiny-hole failure had a separate cause, smoothed pick ownership; see
`docs/decisions/band-smoothing.md`.

## Flora grounding

- `plugins/flora/client/index.ts` retries all pending ground placements after
  every terrain event. Permanently unsupported plants remain pending, so edits
  to unrelated chunks repeatedly resample them. The existing dependency index
  could bound these retries, with unresolved support tracked separately.
- Tree/crop/stump deltas rebuild populations rather than only changed entries.
  This pattern predates the grounding change; the five-point support sampling
  and dependency rebuild amplify it.
- `groundChanges.ts` samples to decide whether an update is needed, then
  placement samples again. Multiple terrain-change/publication events can
  multiply the work. Carrying the resolved support through the update would
  avoid duplicate samples.
- Tree occupancy checks sample support before the distance test. Reusing
  validated placement/support would avoid that work for distant candidates.
- No new per-frame loop or timer was found. This is event-driven overhead,
  independent of smoothing/display toggles. No proven placement correctness
  defect or measured FPS impact was established in this review.

## Fractional entity grounding

- High-confidence coordinate mismatch: the fractional client helper sends
  world-cell coordinates directly into shared `drawnBandAt`, whose quantizer
  subtracts half a cell. Geometry uses integer lattice positions and picking
  adds the half-cell conversion. The previous cap helper canceled the offset.
  This shifts the queried location west/north by half a cell. Runtime visual
  severity remains unverified; sampling and availability gates must use one
  consistent conversion. The movement decision record already notes this issue.
- Pilgrim, wildlife and monster climbers floor continuous climb height to whole
  bands. This can produce held targets followed by jumps despite continuous
  server progress. Runtime severity remains unmeasured.
- Swimmers now query hull center rather than their prior clearance footprint.
  Shore/edge clipping is plausible but unverified; heading and hull dimensions
  no longer affect this support query.
- Several wildlife/monster walking and swimming paths dropped from five ground
  queries to one. Pilgrims use one; distant wildlife still skips held frames.
  No lost position cache was found. Raw bilinear field queries and layered
  scans predate this change. This is not evidence that fractional grounding
  caused the observed FPS reduction.

## Why the meshing inputs grew, and what changed

A chunk has 16×16 contour squares and therefore 17×17 corner samples. Plain
3×3 filtering needs one sample beyond each side: 19×19. The old protection
checks examined a radius-two stencil: 21×21. Enlarging inputs did not increase
mesh resolution. The original CPU worker additionally included a west/north
sample for render-sample pull-back at streaming boundaries, yielding 18×18 raw.

Uploading the protected halo in raw mode was unnecessary. The revised code
restores raw CPU/GPU inputs to 18×18/17×17 and uses 19×19 only with filtering.
GPU resident slots/workgroup arrays still reserve maximum capacity and its
extra barrier remains unconditional; full raw-mode performance equivalence to
historical HEAD is not claimed. The old larger-input choice was convenient for
a shared layout, but it imposed avoidable raw-mode work.
