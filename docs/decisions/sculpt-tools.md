# Sculpt tools

Relaxation: `relaxation.md`. Spans and carve: `overhangs.md`. Picking:
`picking.md`.

## Tools

- `stamp`, `smooth`, `drag`, `carve`. Modes raise / lower (`dir: 1 | -1`).
- Edge `soft | hard | stepped`: stamp only. Stepped drops one band per
  `STEPPED_RING_WIDTH_CELLS` (2) cells past the core, up to `STEPPED_MAX_RINGS`.
- `smoothLambda` 1–100, default 50: per-pass Laplacian scale. Lower melts
  toward one band above click; Raise fills toward one below.
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

- Anchor = clicked cell's drawn band; one press moves a cell at most one drawn
  band. A cell is done once its drawn band reaches the target band
  (`hasReachedBand`); its in-band height is not re-snapped.
- All anchored call sites use `anchoredTargetHeight`.
- Anchored smooth: past-target cells freeze; rest stay within ~one band of
  start, capped at target. No pin without a guarding deposit; over-steep pairs
  heal next stroke.
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

- Footprint fully at world floor: no-op. Pit fill works: pit rises to melt
  target, wall stands.
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
- Genesis encodes edges from its continuous field (`encodeLevelEdges`;
  `genesis.md`, 2026-09-23). Saved worlds use the band layout
  (`encodeSmoothedEdges`: 3×3 binomial coverage, half level, at least half a
  cell per side).
- Worlds saved before this are migrated once by
  `server/scripts/encode-world-edges.ts`, run with the server stopped. Each
  world gets a new restore point; nothing is deleted. The game has no
  migration code.
