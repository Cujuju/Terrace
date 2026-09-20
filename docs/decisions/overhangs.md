# Overhangs

Span columns; what drag and carve do. Tools: `sculpt-tools.md`. Picking:
`picking.md`.

## The model

- Cell = column of solid spans; empty below, solid above. Overhang: span
  floored above neighbour ceiling. Arch: two spans. Cave: connected gaps.
- `heightAt` = topmost span top. Read by rivers, pathing, farmland, traversal,
  flora, boats, water, fog; redefining it reopens all eight.
- Mesher asks "solid at band k?": contouring, triangulation, skirts unchanged.
  Addition: ceiling cap — spans ENDING at k, reversed, lit below.

2026-08-24 (#129): spans over sparse voxels, SDF / dual contouring, authored
overhang props.

## Span shape

`Span { floorBand, ceiling }` (`columns/span.ts`): band floor, raw-height
ceiling. Packed `[floorBand, ceiling]`, `SPAN_STRIDE = 2`.

- `spanCapBand` = `drawnBandOfSample(ceiling)`: the only rounding. Floors are
  bands already.
- `spanUndersideLevel` = `bandLevelHeight(floorBand - 1)`: exact, no tolerance.
- Drawn iff `floorBand <= spanCapBand`. Covers k iff
  `floorBand <= k <= spanCapBand`.
- Gap iff `upper.floorBand > spanCapBand(lower) + 1`.
- `BEDROCK_BAND` floors every canonical bottom span.
- `canonicaliseColumn`: drop undrawn, merge non-gaps, floor at bedrock. Throws
  non-ascending; repairs in place, never sorts.
- Overhang needs two slabs of air: its own, one to see under.

## Storage

No migration. Load reinterprets: `floorBand` = lowest slab floored at/above
the stored floor. Next save bumps `SNAPSHOT_SCHEMA_VERSION`.

## The drag writes the run down from the band it grabbed

Slab = dragged band down through like material to the first boundary: solid
to its span's `floorBand`, air to its void's floor. Every swept cell gets it.

- `runFloorBandAt` reads, `fillBandRun` writes (`columns/bandQueries.ts`).
  Landed slab merges via `canonicaliseColumn`; nothing reads overhead.
- Raise refuses only the already-solid run. No adjacency gate, no depth limit.
- Shielding is free: the run starts at its own floor (`expectGapsBelowRunSurvive`).
- `floorBand` rides the intent — the swept cell can't derive it. Plain
  integer, never a span index.
- Alt (`dragAlt`): raise writes the band alone; lower carves it alone, roof
  intact, retreat gate kept, bedrock refused.

2026-09-17, superseding #224's "the drag lays a roof; it never fills the carve
beneath one", which left 215 of 317 swept cells dead on a cliff and could never
fill a one-band void. #224 also rejected carrying the grasped span on the wire
as underivable — true of a span index, not of a floor band. Still rejected:
deriving the run in the swept cell (kills the hollow); refusing the drag under
a roof (leaves no way to extend one); mirroring whichever neighbour holds the
band (scan order would decide).

Deleted by this rule: `BandFill`'s `extend`/`overhang` variants, its `null`
refusal, both `isGapDrawn` gates in the write path, and `pushLowerLayers` —
the run IS the descent.

## The carve opens the band it is grasped at

- Grasped S clears `S … S + depthBands - 1`, each via `canCarveBandAt`
  (`sculpt/carve.ts`). Depth on intent, default one.
- Cut leaves the band the next inside pick names: tunnels walk one cell per
  intent, unbounded.
- `bandOfPick` shared with drag: riser pick names the band whose drawn slab
  holds the struck height.
- Refuses at world bottom.

2026-09-02, from "it will just stop … it only goes so far": the cut and the
next pick were one band out of alignment, so every cut after the first was
refused. Rejected: naming the band below the struck slab; asking
`canCarveBandAt` of the grasped band as well as the opened one.
