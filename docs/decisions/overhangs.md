# Overhangs

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-24 (the column is a list of spans, #129)

**A column that stores one height cannot be empty below and solid above.** That
sentence is the whole obstacle; raised by the owner after dragging a layer out
from under another (#99) and getting everything below it dragged too. A cell is
therefore a short list of solid spans: an overhang is a span whose floor is above
its neighbour's ceiling, an arch a column with two spans, a cave a gap region.

**The renderer already asks "is this cell solid at band k?", never "what is the
height here"**, so contouring, triangulation and skirts generalise unchanged.
The only new geometry is the ceiling cap: the same pass over spans ENDING at
band k, wound in reverse and lit from below.

**`heightAt` keeps meaning the top of the topmost span — the walkable surface**,
which is what kept rivers, pathing, farmland, traversal, flora, boats, water and
fog untouched; changing it reopens all of them. Cave water is out of scope.

Rejected 2026-08-24: sparse voxels and SDF / dual contouring (both rebuild
`shared/`'s 2D indexing and the determinism contract, and fight the terraced
identity); authored props (cheapest, still the fallback for visual variety
alone, but caves become rooms behind a portal, not carvable structure).

## Decisions made 2026-09-15 (spans record floors in bands, ceilings raw)

```ts
export interface Span { readonly floorBand: number; readonly ceiling: number; }
export const SPAN_STRIDE = 2; // packed [floorBand, ceiling]
```

- **One rounding rule in the whole model**: `spanCapBand(span)` is
  `drawnBandOfSample(span.ceiling)`, the ground's own rule. Floors are already
  bands. `spanCapHeight` is that cap band's level height.
- **Undersides are exact**: `spanUndersideLevel(span)` is the level height of
  band `floorBand - 1`. No clearance, no tolerance, no one-unit offset anywhere.
- **Drawn**: `isSpanDrawn(span)` iff `floorBand <= spanCapBand(span)`.
- **Coverage**: a span covers band k iff `floorBand <= k <= spanCapBand(span)`.
- **Stacking**: `spansAdjacent(lower, upper)` iff
  `upper.floorBand === spanCapBand(lower) + 1`; `isGapDrawn(lower, upper)` iff
  `upper.floorBand > spanCapBand(lower) + 1`. The highest ceiling that fits
  under a span is `bandFloorHeight(upper.floorBand) - 1`.
- **`BEDROCK_BAND`** is `drawnBandOfSample(BEDROCK_FLOOR)`: the `floorBand` of
  every canonical column's bottom span.
- **`canonicaliseColumn(spans)`**: drop undrawn spans, merge adjacent ones, floor
  the bottom span at `BEDROCK_BAND`.

**An overhang needs two slabs of air** — its own, plus one to see under it. Two
one-band carves provide it: deep enough to see is deep enough to overhang.

**No migration, ever.** An old snapshot is interpreted under the new rule at
load: `floorBand` is the lowest slab whose bottom level is at or above the raw
stored floor. The next save writes the new format under a bumped
`SNAPSHOT_SCHEMA_VERSION`.

## Decisions made 2026-08-27 (a dragged band overhangs a carve; it never fills it)

Owner report (#224): "if I carve and I try to drag the layers above, it
instantly fills the carve." Reproduced by dragging a band in a carve's opening.

**Decision: the roof extends as an OVERHANG; the floor span never rises.**
Dragging a band in a gap under the cell's own roof lays that band's own slab,
`{ floorBand: k, ceiling: bandLevelHeight(k) }`, and leaves the span below
byte-untouched. **The rule is stated once, in `columns.ts` `bandFillAt`**: for a
cell open at band k the fill is `extend` (the ground below rises to the band —
the terrace step the drag has always built) when there is OPEN SKY above it, and
`overhang` when the column has any span above. Both the drag's own fill and
`pushLowerLayers`' cascade go through it, so neither can seal a carve; the
cascade also refuses `overhang` outright, because it carries an existing
staircase and must never author new roofs.

- **The cell's own column decides, not a survey of its neighbours.** A neighbour
  only ADMITS the fill (`canSpreadBandToSpan`, the anti-cheat that keeps
  "clients send intents, never heights" true of a message naming a band).
  Disagreeing neighbours need a tie-break, and two replicas can drift on one.
- **No new field on the wire.** The drag carries `targetBand` and one column
  covers a band with at most one span, so both replicas resolve it themselves. A
  grasped-span field could not be derived correctly anyway: a drag's `x`/`y` is
  the CURSOR cell, not the cell whose lip is in the player's hand.
- **Unlayered worlds cannot reach the new branch**, by construction: a one-span
  column floors at `BEDROCK_BAND`, so there is never a span above.

This overturned D4 (2026-08-24, #129 step 4.5), which filled the opening from
the floor up and sealed the cave the player had just cut. Rejected 2026-08-27:
refusing the drag under a roof (leaves no way to extend one); mirroring whichever
neighbour holds the band as a roof (several can disagree, so scan order decides);
carrying the grasped span on the intent (see "no new field").

## Decisions made 2026-09-02 (the carve opens the band the player points at)

Owner report: carving "will just stop … it only goes so far." The cause was an
alignment mismatch between the pick and the cut, not the anti-cheat rule: the cut
left band `spanBand + 1` open, the next pick inside the opening named it, and
that cut wanted to open a band no neighbour was open at.

**Decision: the cut OPENS the grasped band.** A carve grasped at band S clears
slabs `S … S + depthBands - 1` (see `sculpt-tools.md`, 2026-09-15) and asks
`canCarveBandAt` of them. The opening a cut leaves is exactly the band the next
pick inside it names, so a tunnel walks inward one cell per intent without limit,
and a cut grasped at a face's lowest lip floors level with the ground outside.

**A carve lowers by default, and only ever lowers.** A plain click carves, the
modifier is ignored, the direction is never re-resolved mid-stroke, and a carve
never writes the sticky HUD mode; the wire is unchanged (`dir: -1`, and the
validator still rejects `dir: 1`). **The HUD hides the Mode row for it**, as it
hides the Edge row for tools with no edge (#225) — a control that cannot change
the stroke is removed, not disabled — from one shared list beside
`TOOLS_WITHOUT_EDGE_PROFILE`, read by both the HUD and the input.

**What does not change.** `bandOfPick`: the drag shares it, and a riser pick
names the band whose drawn slab contains the struck height (owner, 2026-08-26).
The bottom-of-world refusal in `applyCarve`, which also refuses a grasp whose
lower piece the storage could not encode.

Rejected 2026-09-02: naming the band below the struck slab (makes carve the one
tool that reads a face differently from the drag, undoing 2026-08-26); asking
`canCarveBandAt` of the grasped band too (widens admission without moving the
opening, so the next pick still names a band the cut never opened).
