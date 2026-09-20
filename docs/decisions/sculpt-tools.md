# Sculpt tools

Relaxation: `relaxation.md`. Spans and carve: `overhangs.md`. Picking:
`picking.md`.

## Tools

- `stamp`, `smooth`, `drag`, `carve`. Modes raise / lower (`dir: 1 | -1`).
- Edge `soft | hard`: stamp only.
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
  band, onto its canonical level.
- All anchored call sites use `anchoredTargetHeight`.
- Anchored smooth: past-target cells freeze; rest stay within ~one band of
  start, capped at target. No pin without a guarding deposit; over-steep pairs
  heal next stroke.
- `anchor: 'free'`, `spill: 'free'`: library only.

## Price (mana plugin)

- Price = displacement + unlock. Gate on nominal (`sculptIntentCost`), charge
  actual (`displacementOf`). Smooth pays both sides. Actual-without-nominal
  still denies.
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
