# Overhangs

Facts about the span column: how a cell holds solid material, and what the drag and the carve do to it. Sculpt tools: `sculpt-tools.md`. Picking: `picking.md`. Relaxation: `relaxation.md`.

## The model

- A cell is a column of solid spans rather than one height, so it can be empty below and solid above. An overhang is a span whose floor is above its neighbour's ceiling; an arch is a column with two spans; a cave is a connected region of gaps.
- `heightAt` means the top of the topmost span — the walkable surface. Rivers, pathing, farmland, traversal, flora, boats, water and fog read it and were untouched by spans; changing its meaning reopens all of them. Water inside a cave is out of scope.
- The mesher already asks "is this cell solid at band k?", so contouring, triangulation and skirts are unchanged by spans. The one addition is the ceiling cap: the same pass over spans ENDING at band k, wound in reverse and lit from below.
- Decided 2026-08-24 (#129) over sparse voxels and SDF / dual contouring (both rebuild `shared/`'s 2D indexing and the determinism contract, and fight the terraced look), and over authored overhang props (still the fallback if the goal ever narrows to visual variety alone).

## Span shape

- `Span { floorBand, ceiling }` (`shared/src/columns/span.ts`): the floor is a band index, the ceiling a raw height. Packed as `[floorBand, ceiling]`, `SPAN_STRIDE = 2`.
- One rounding rule in the whole model: `spanCapBand(span)` is `drawnBandOfSample(span.ceiling)`, the ground's own rule, and `spanCapHeight(span)` is that band's level height. Floors are bands already, so nothing rounds them.
- Undersides are exact: `spanUndersideLevel(span)` is `bandLevelHeight(span.floorBand - 1)`. No clearance, no tolerance, no one-unit offset anywhere — a slab's underside is a band boundary by construction.
- Drawn: `isSpanDrawn(span)` iff `floorBand <= spanCapBand(span)`. Coverage: a span covers band k iff `floorBand <= k <= spanCapBand(span)`.
- Stacking: `spansAdjacent(lower, upper)` iff `upper.floorBand === spanCapBand(lower) + 1`; `isGapDrawn(lower, upper)` iff `upper.floorBand > spanCapBand(lower) + 1`. The highest ceiling that fits under a span is `bandFloorHeight(upper.floorBand) - 1`.
- `BEDROCK_BAND` is `drawnBandOfSample(BEDROCK_FLOOR)`, and is the `floorBand` of every canonical column's bottom span.
- `canonicaliseColumn(spans)`: drop undrawn spans, merge adjacent ones, floor the bottom span at `BEDROCK_BAND`.
- An overhang needs two slabs of air: its own, plus one more to see under it. Two one-band carves give it. That is the model speaking, not a defect.

## Storage

- Nothing migrates. An old snapshot is interpreted under the current rule at load: `floorBand` is the lowest slab whose bottom level is at or above the raw stored floor. The next save writes the new format under a bumped `SNAPSHOT_SCHEMA_VERSION`, and no world is rewritten in place.

## The drag lays a roof; it never fills the carve beneath one

- For a cell open at band k, `bandFillAt` (`shared/src/columns/bandQueries.ts`) answers `extend` when the column has open sky above the band — the ground below rises to it, the terrace step the drag has always built — and `overhang` when the column holds any span above it.
- An `overhang` fill lays that band's own slab, `{ floorBand: k, ceiling: bandLevelHeight(k) }`, and leaves the span below byte-untouched. The floor span never rises into the opening.
- Both the drag's own fill and `pushLowerLayers`' cascade (`shared/src/sculpt/drag.ts`) go through `bandFillAt`, so neither can seal a carve. The cascade additionally refuses `overhang`: it carries an existing staircase and must never author a new roof.
- The cell's own column decides, never a survey of its neighbours. A neighbour only ADMITS the fill (`canSpreadBandToSpan`, the anti-cheat that keeps "intents, never heights" true of a message naming a band); disagreeing neighbours would need a tie-break, and two replicas can drift on one.
- No span field on the wire. A drag carries `targetBand`, one column covers a band with at most one span, and both replicas resolve it against their own map. A grasped-span field could not be derived correctly anyway: a drag's `x`/`y` is the cursor cell, not the cell whose lip is in the player's hand.
- Decided 2026-08-27 (#224), overturning D4's "fill the opening", which raised the floor span into a fresh carve and welded a sealed cave. Rejected then: refusing the drag under a roof (leaves no way to extend one); mirroring whichever neighbour holds the band as a roof (several can disagree, so scan order would decide); carrying the grasped span on the intent.

## The carve opens the band it is grasped at

- A carve grasped at band S clears slabs `S … S + depthBands - 1` and asks `canCarveBandAt` of each (`shared/src/sculpt/carve.ts`). Depth comes from the intent and defaults to one band (`sculpt-tools.md`).
- The opening a cut leaves is exactly the band the next pick inside it names, so a tunnel walks inward one cell per intent without limit, and a cut grasped at a face's lowest lip floors level with the ground outside it.
- `bandOfPick` is shared with the drag and does not change: a riser pick names the band whose drawn slab contains the struck height.
- `applyCarve` refuses at the bottom of the world, including a grasp whose lower piece the storage could not encode.
- Decided 2026-09-02 from "it will just stop … it only goes so far": the cut and the next pick were one band out of alignment, so every cut after the first was refused. Rejected then: naming the band below the struck slab (the carve would read a face differently from the drag); asking `canCarveBandAt` of the grasped band as well as the opened one (widens admission without moving the opening).
