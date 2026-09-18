# Sculpt tools

Relaxation: `relaxation.md`. Spans and carve: `overhangs.md`. Picking:
`picking.md`.

## Tools

- `stamp`, `smooth`, `drag`, `carve`. Modes raise / lower (`dir: 1 | -1`).
- Edge profile `soft | hard`: stamp only.
- Smooth carries `smoothLambda` (1–100, default 50), scaling the Laplacian move
  per pass. Lower melts toward one band above the click; Raise fills toward one
  band below it.
- Carve only lowers; the mode chord is ignored and the HUD hides Mode.
- `settle` is library-only. Players never send it.

## Selection

- A stroke acts on the band under the aim, `bandOfPick`. Same rule for every
  tool. Lip proximity never vetoes it; it only gates the overlay highlight.
- A drag press grabs the clicked band — no seed layer first.

## Carve depth

- `depthBands`, validated `1 … CARVE_MAX_DEPTH_BANDS` (10), set by a HUD
  slider. Clears slabs `S … S + depthBands - 1` from the grasped band S.
- Default 1: two clicks give an overhang its two slabs.
- Displacement scales linearly with depth.

## Anchoring

- Strokes anchor to the clicked cell's drawn band. One press moves a cell at
  most one drawn band, onto that band's canonical level.
- Every anchored call site uses `anchoredTargetHeight`.
- Anchored smooth: a cell past the target freezes for the stroke; the rest stay
  within about one band of their start, capped at the target. No cell is pinned
  without a deposit to guard. A bound that bites leaves the pair over-steep; the
  next stroke repairs it.
- `anchor: 'free'` and `spill: 'free'` are library paths only.

## Price (mana plugin)

- Price = displacement + unlock. Admission denies on the nominal
  (`sculptIntentCost`); the charge is the actual, from `displacementOf`. Smooth
  pays both sides of every exchange. Affording the actual but not the nominal is
  a denial.
- A drag leg is one capsule (`sweep.ts`): wards, monster ground, reveal, unlock
  and the nominal read the same shape. At most `MAX_DRAG_LEGS_PER_MOVE` legs per
  move; the rest drop silently.
- Unlock = `CHUNK_UNLOCK_MANA` per chunk of frontier opened. Flat.
- The client quotes the actual by dry-running on its mirror once the whole reach
  is received, else the nominal labelled estimated; the gate reserves the
  nominal. The server's balance push erases the optimistic debit.
- Zero-effect strokes are applied, not denied.

## Edges

- A footprint entirely at the world floor is a no-op. Filling a pit at the floor
  works: pit cells rise toward the melt target, the wall above it stands.
- Every column keeps a bottom span floored at `BEDROCK_BAND`.
