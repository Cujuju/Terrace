# Overhangs

The span column, and what the drag and the carve do to it.
Tools: `sculpt-tools.md`. Picking: `picking.md`.

## The model

A cell is a column of solid spans, not one height: empty below, solid above.
Overhang = a span floored above its neighbour's ceiling. Arch = two spans.
Cave = a connected region of gaps.

`heightAt` is the top of the topmost span. Rivers, pathing, farmland,
traversal, flora, boats, water and fog read it; changing its meaning reopens
all of them.

The mesher already asks "solid at band k?", so contouring, triangulation and
skirts are unchanged. The one addition is the ceiling cap: the same pass over
spans ENDING at band k, wound in reverse and lit from below.

2026-08-24 (#129), over sparse voxels, SDF / dual contouring and authored
overhang props.

## Span shape

`Span { floorBand, ceiling }` — `shared/src/columns/span.ts`. Floor is a band
index, ceiling a raw height. Packed `[floorBand, ceiling]`, `SPAN_STRIDE = 2`.

- `spanCapBand` = `drawnBandOfSample(ceiling)`, the ground's own rule and the
  only rounding in the model. Floors are bands already.
- `spanUndersideLevel` = `bandLevelHeight(floorBand - 1)`. Exact: no
  clearance, no tolerance, no offset.
- Drawn iff `floorBand <= spanCapBand`. Covers k iff
  `floorBand <= k <= spanCapBand`.
- `isGapDrawn(lower, upper)` iff `upper.floorBand > spanCapBand(lower) + 1`.
- `BEDROCK_BAND` floors every canonical column's bottom span.
- `canonicaliseColumn`: drop undrawn, merge what is not gap-separated, floor
  at bedrock. Throws on a column that does not ascend — it repairs in place,
  never sorts.
- An overhang needs two slabs of air: its own, plus one to see under it.

## Storage

Nothing migrates. An old snapshot is reinterpreted at load: `floorBand` is the
lowest slab whose bottom level is at or above the raw stored floor. The next
save bumps `SNAPSHOT_SCHEMA_VERSION`.

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

- Grasped at band S, it clears `S … S + depthBands - 1`, asking
  `canCarveBandAt` of each (`shared/src/sculpt/carve.ts`). Depth from the
  intent, default one band.
- The opening a cut leaves is exactly the band the next pick inside it names,
  so a tunnel walks inward one cell per intent without limit.
- `bandOfPick` is shared with the drag: a riser pick names the band whose
  drawn slab contains the struck height.
- `applyCarve` refuses at the bottom of the world.

2026-09-02, from "it will just stop … it only goes so far": the cut and the
next pick were one band out of alignment, so every cut after the first was
refused. Rejected: naming the band below the struck slab; asking
`canCarveBandAt` of the grasped band as well as the opened one.
