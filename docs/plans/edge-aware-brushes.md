# Edge-aware brushes

Status: planned; no production code written. Owner direction 2026-09-23.
Goal: smooth, round band outlines from the stored terrain itself, without a
render-time smoothing filter or the Smooth brush.

## Facts

- Band `b` is solid where the interpolated height ≥ `bandFloorHeight(b)`
  (`shared/src/bands.ts`: inside iff `h + DRAWN_GROUND_BAND_BIAS ≥ drawnLevelThreshold(b)`).
  A band spans `BAND_HEIGHT` = 16 height units.
- Brushes write every cell at its band's midpoint, `bandLevelHeight` = floor + 8
  (`stepTowardBand`, `anchoredTargetHeight`, `fillTowardTarget`, `applySoftApron`,
  `pressDelta` in `shared/src/sculpt/`). Every edge between two cells therefore
  crosses at the midpoint and outlines follow the grid.
- Footprints are grid discs: `isFootprintOffset` is `dx² + dy² < r(r − 1)`;
  radius 1 is one cell (`shared/src/sculpt/footprint.ts`).
- Between two cells N bands apart, the renderer spreads N edges linearly by
  height (e.g. ⅙, ½, ⅚ for three bands). One height per cell cannot place
  several edges between the same two cells independently.
- Server and client prediction share `applySculpt`; brush changes apply to both.

## Encoding (used by every step)

A cell keeps its band. Its in-band height encodes distance `d` (cells) to its
nearest band edge:

- nearer its own lower edge: `bandFloorHeight(B) + min(8, round(8·d))`
- nearer the next band's edge: `bandFloorHeight(B + 1) − min(8, max(1, round(8·d)))`

Precision ⅛ cell. A cell ≥ 1 cell from any edge stays at the midpoint.
Production math must be integer (`Math.sqrt` with immediate floor is allowed).

## Prototype

- `scratch-band-investigation/build-brush-data.mjs` (`fb0a056e`, `9642d44c`).
  Models Stamp in band units on an 8× fine grid, then encodes as above.
  Floats are used for distance; not production math.
- Viewer: `node scratch-band-investigation/build-brush-data.mjs` writes
  `brush-preview.html`; pick the variant in "Prototype brush".
- Every prototype cell's band equals the current brush's in all brushed scenes.
- Total contour turning (radians, lower is smoother):

  | Scene | Current | + filter | Round | Round, vertical walls |
  |---|---:|---:|---:|---:|
  | Hard stamps | 128 | 56 | 108 | 69 |
  | Six clicks, one spot | 122 | 69 | 117 | 44 |
  | Archived stamp sequence | 614 | 240 | 509 | 323 |
  | Generated terrain | 2977 | 1361 | 2977 | 3964 |

## Owner decisions

- Round outlines. Noise-varied ("natural") stamps rejected for now; a
  low-variation natural stamp may be wanted after round works.
- Updating world generation is acceptable.
- Render-filter variants, local feature protection and band clamping are rejected
  (`docs/decisions/band-smoothing.md`, `docs/plans/terrain-band-smoothing.md`).

## Steps

Smallest first. Each ships alone; later steps may build on earlier ones.

### 1. Edge-aware Stamp — small

- `shared/src/sculpt/stamp.ts`: level fill and soft apron write encoded in-band
  heights from the exact circle distance. Bands unchanged.
- No renderer, picking, grounding or protocol change.
- Verify: every cell's band equals the current brush's; edge within ⅛ cell of
  the circle; live stamp in CPU and GPU meshers.
- Measure: sculpt price (`columnSolidUnits` counts displaced units), cells per
  diff (`diffOf` includes cells whose height changed), raw-height readers
  (mudslides, relax `MAX_STEP`, river routing).
- Limit: tall walls unchanged; other brushes re-snap edges they touch.

### 2. Stepped Hard stamp option — small

- Ring profile: each band below the target reaches one ring (`w` cells) further
  out. Every edge is one band, so no renderer change.
- Prototype: `w = 2` gives clean rings; `w = 1` wobbles on outer rings (a cell
  between two edges stores one distance).
- Owner decides: `w`, and whether it replaces Hard or is a new HUD option
  (protocol field + HUD).

### 3. Edge-aware Raise/Lower and Drag — medium

- Same encoding from each brush's disc geometry (`stamp.ts` `applyBrush`,
  `drag.ts`, `dragDisc.ts`). Each brush ships separately.

### 4. Retire the smoothing filter — small–medium

- Gate: owner judges steps 1–3 in game.
- Remove `shared/src/drawnFieldFilter.ts`, `client/src/terrain/drawnSurface.ts`,
  the setting (`terrainSurfacePrefs.ts`, `ControlsPanel.tsx`) and smoothed-only
  paths in `capEmission.ts`, `terrainGpuInputs.ts`, `mesherWgsl.ts`,
  `pick/filteredCellHit.ts`, `pick/bandOwner.ts`, `mirror.ts`.

### 5. Vertical walls for new worlds (B) — large

Ships as one unit; the wall rule alone makes generated slopes jagged.

- Wall rule: for band `b`, a cell's value is
  `h − bandFloorHeight(band(h)) − BAND_HEIGHT·[band(h) < b]`; the edge is where
  the interpolated value crosses 0. Identical to today for one-band steps.
  Implement in `shared/src/drawnGround.ts` (queries), `client/src/terrain/contours.ts`
  and `capEmission.ts` (CPU), `mesherWgsl.ts` and `terrainGpuInputs.ts` (GPU).
  Per-band values use the existing layered per-band path. CPU/GPU parity required.
- Shared in-band recompute from the band layout for writers without exact shapes:
  `shared/src/sculpt/relax.ts` (Smooth, settle), `plugins/cyclone/server/surge.ts`,
  `plugins/cyclone/server/wind-scour.ts`, `plugins/mudslides/server/terrain.ts`,
  `plugins/relics/server/terraform.ts`, `plugins/saucers/server/encounter.ts`,
  `plugins/volcanoes/server/vents.ts`. `plugins/mana/client/quote.ts` replays
  brushes on a scratch map for pricing; it follows the shared brush code.
- `server/src/world/genesis.ts` writes encoded heights (steep slopes become
  cliffs with smooth outlines).
- Per-world flag: existing worlds keep today's rule.

### 6. Vertical walls for saved worlds — medium

- One-time in-band recompute on load, then set the flag.
- Gate: overrides "saved worlds are never migrated" (`docs/decisions/relaxation.md`).

### 7. ¼-cell fan-out (B+) — large; needs step 5

- Tall steps fan bands around the wall at a fixed spacing instead of stacking
  vertically. Crossing rule uses both neighbouring cells (CPU and GPU).
- At ¼ cell only 4 bands fit between two cells; owner decides compress vs stack.
- Ground/pick queries no longer fit the four-corner blend; they must rebuild
  the cell's edges and match drawn geometry exactly (picking, flora and entity
  grounding).
- Spacing along grid lines is up to 1.4× wider on diagonal walls unless corrected.

### Parked / excluded

- Low-variation natural stamp: parked until round works.
- Overhang undersides stay blocky: span floors are whole bands.

## Constraints

- `CLAUDE.md` rules apply: deterministic integer terrain math in `shared/`;
  typecheck and tests pass before `shared/` commits; new tests and app start/stop
  need owner permission in the current session; no appends to `docs/DESIGN.md` or
  `docs/decisions/` without permission.
- Live verification harness: `scratch-band-investigation/pick-probe/`.
