# Sculpt tools

Relaxation: `relaxation.md`. Spans and carve: `overhangs.md`. Picking:
`picking.md`.

## Tools

- `stamp`, `smooth`, `nudge`, `drag`, `carve` (`SCULPT_TOOLS`, wire order).
  Modes raise / lower (`dir: 1 | -1`); smooth and carve have none
  (`TOOLS_WITHOUT_DIRECTION`).
- Edge `soft | hard | stepped`: stamp only. See "Brush redesign" below.
- Carve only lowers; mode chord ignored, HUD hides Mode.
- `settle` library-only, never on the wire.

## Selection

- Every tool acts on the picked band (`picking.md`). Lip proximity gates the
  highlight only, never the stroke.
- Drag grabs the clicked band; no seed layer.

## Chords

- `Sculpt` (Left): HUD way. `Sculpt, inverted` (Left+Shift): other way.
  `Sculpt, alt` (Left+Ctrl): one band, HUD way. Rebindable; the toggle names
  the direction, never the chord.
- Alt rides raise/lower: alt+raise one band HUD way, alt+lower one band other
  way (Ctrl+Shift default). Plain rows win ties; degenerate chords never fire.
  Wire flag `dragAlt`, live per leg.
- Mode icon shows `A` while alt is held on drag.

## Carve depth

- `depthBands` 1–10 validated (`CARVE_MAX_DEPTH_BANDS`), HUD slider. Clears
  `S … S + depthBands - 1` from grasped S.
- Default 1: two clicks = an overhang's two slabs.
- Displacement scales linearly with depth.

## Anchoring

- Wire anchor is `clicked` (drag: `band`). Only stamp targets the clicked
  cell: one press moves it one drawn band (`anchoredTargetHeight`). Smooth and
  nudge have no anchor target.
- `anchor: 'free'`, `spill: 'free'`: library only.

## Price (mana plugin)

- Price = displacement + unlock. Gate on nominal (`sculptIntentCost`), charge
  actual (`displacementOf`). Smooth pays both sides. Actual-without-nominal
  still denies.
- Stamp and drag are charged by drawn band (`columnBandUnits`): `BAND_HEIGHT`
  per band crossed per cell; edge encoding is free. A raise out of the sea pays
  a full band. Other tools charge raw height (`columnSolidUnits`).
- Drag leg = one capsule (`sweep.ts`) for wards, monster ground, reveal,
  unlock, nominal. Max `MAX_DRAG_LEGS_PER_MOVE`/move; tail drops silently.
- Unlock = `CHUNK_UNLOCK_MANA` per frontier chunk. Flat.
- Client quotes actual once reach is mirrored (dry run), else nominal as
  estimated. Gate reserves nominal; server balance push erases the debit.
- Zero-effect strokes apply, never deny.

## Edges

- Footprint fully at world floor: no-op.
- Bottom span always floored at `BEDROCK_BAND`.

## Edge-aware brushes — 2026-09-23

Plan: `docs/plans/edge-aware-brushes.md`.

- Stamp and drag (`EDGE_AWARE_TOOLS`) write each cell's in-band height as its
  distance to the nearest band edge, `EDGE_UNITS_PER_CELL` (8) units per cell
  (`shared/src/sculpt/edges.ts`). Drawn outlines follow the exact brush circle
  or capsule. Bands are unchanged by the encoding.
- Stroke reach grows by `EDGE_REGION_MARGIN_CELLS` (1) for these tools.
- `applyBrush` (settle) and relax do not encode: `applyBrush` keeps its
  footprint-only contract; encoding in relax broke its invariants (#108,
  gradient limit).
- Genesis heights are continuous, so its edges need no encoding (`genesis.md`,
  2026-09-24). Saved worlds use the band layout (`encodeSmoothedEdges`: 3×3
  binomial coverage, half level, at least half a cell per side).
- Worlds saved before this are migrated once by
  `server/scripts/encode-world-edges.ts`, run with the server stopped. Each
  world gets a new restore point; nothing is deleted. The game has no
  migration code.

## Brush redesign — signed off 2026-10-04

Commits 2026-09-23..26 (`06776661`, `52a10901`, `9ba4767e`, `b1d9b4f4`,
`c202e258`, smooth-outline fixes through `3bae0111`).

- Stamp: each press moves the clicked cell one band and fills the whole disc
  to it; ground already past the shape is untouched. Profile shapes the
  flanks, at most `MOUND_MAX_FLANK_BANDS` (8): hard none, stepped one band per
  `STEPPED_RING_WIDTH_CELLS` (2), soft a parabola with drawable treads
  (`MIN_DRAWN_TREAD_HALF_CELLS`). Rings are edge-encoded (`mound.ts`).
- Smooth: no direction, ignores amount. Traces each band outline in the
  brush and moves each point to the median of its neighbours' offsets, so
  kinks up to about twice `smoothKinkHalfCells` (1–8, default 2) go and wider
  arcs stay. Closed rings no wider than that drop. Vertices outside the brush
  stay pinned; only disc cells change; crossings keep a cell's own band.
  `smoothWalls` (alt) treats stacked walls as one line. Not volume-conserving
  (`outlineSmooth.ts`).
- Nudge: raise spreads bands apart, lower draws them together, stretching
  elevation about the brush centre up to 50% at `nudgeStrength` 100 (1–100,
  default 50), pressure `R² − d²`. Each cell stays within its 3×3
  neighbourhood's range; disc-only writes; priced graduated like smooth
  (`nudge.ts`).
- Smooth and nudge skip walls more than `SMOOTH_LAYER_BAND_REACH` (1) above
  the grasped span.
- Reach (`sculptReachCells`): smooth `r + OUTLINE_SMOOTH_READ_MARGIN_CELLS`;
  nudge understated at r 1–3 (#525).
- The Laplacian wire fields (`smoothLambda` and seven lab flags) are still
  validated but inert (#518).
