# Handoff 2026-09-18: shore mask geometry, band-0 contour

**Status:** SHIPPED+PUSHED. Tip `bd60109a`.
**Issue:** 487 closed (mask), shape unresolved.

## Shipped
- `2cab9ea5` mask sampled the water plane's xz, not the land under it. Grazing rays
  tested cells seaward of the land they covered; flat shore flooded behind a
  constant-height line. 2.17% -> 0.36% watered pixels on dry cap.
- `03ed5fac` shore-outline toggle + parallax reach clamp (uncapped shift punched
  rectangular holes in distant sea).
- `d9c353d6` mid-edge band-0 contour. **Reverted.**
- `2c265413` depth-driven band-0 contour. **Reverted.**
- `5504d507` reverted both. Kept: `writeBlockyFallback` now reloads raw samples —
  it reads the shared `samples` array, which a per-band `loadLevel` had already
  been leaving derived for layered chunks. Latent bug, pre-existing.
- `bd60109a` sea plane moved from `+WATER_SURFACE_CLEARANCE` to `-` it, so it sits
  under band 0's cap and the land polygon occludes it. Deleted the R32F shore
  field, `writeShoreFieldTexels`, `shoreFieldChunkRect`, `createShoreFieldBuffer`,
  `shoreCoverage`, parallax correction, outline toggle, `shoreField.test.ts`.

## Unresolved: band-0 contour shape
`drawnCrossingFraction` numerator is the floor->level gap. Band 0's gap is 0
(floor and level are both `DRAWN_SHORE_HEIGHT` = 1), so the crossing is
identically 1.0 at any depth and the shoreline pins to the cell lattice. Every
other band's gap is 8 -> ~0.5.

Measured widths: band 0 = 7 (heights 1..7), band -1 = 25, all others 16.
Drawn cap spacing is uniform (`BAND_WORLD_HEIGHT` 0.25) for all bands.

Two band-0-only fields were tried and both failed by introducing an asymmetry no
other band has: two-valued (rounded blob — no sub-cell information), and
dry-flattened-with-real-depth (still rounded — one side constant).

**Only fix:** regular band scheme, band k = `[16k+1, 16k+17)`, level `16k+9`.
Gives band 0 a gap of 8 and a 0.5 crossing. Needs a lossy migration
(`h -> 16*oldBand(h) + 9`) of every stored height; `h in [16k+1, 16k+9)` drops a
band otherwise. `bandLevelHeight(-1)` -16 -> -7 changes sculpt feel. Owner held it
twice. Written up in `docs/decisions/terrain-relief.md`.

## Facts
- `BAND_HEIGHT` 16, `BIAS` 8, `MAX_HEIGHT` 1024, `TERRACE_BAND_COUNT` 64,
  `MAX_STEP` 4, `CELL_WORLD_SIZE` 0.25, `HEIGHT_WORLD_SCALE` 0.015625,
  `BAND_WORLD_HEIGHT` 0.25 (= one cell).
- Frostwick Hollows: 173/1024 chunks coastal; 0 blocky chunks with mid-edge
  contours; `MAX_MERGED_POLYGON_VERTICES` 512 is the limit one-cell puddles push.
- Mid-edge coastal contour cost: 293 -> 1091 vertices, 128^2 synthetic coast.

## Traps
- **Vite serves a stale transform of edited files.** Hit 3x on `water.ts`; a
  reload shows old shader behaviour and probes measure the wrong build. Kill the
  dev server and `rm -rf client/node_modules/.vite`.
- `pickCell` uses `drawnBandAt`'s half-cell-shifted convention and raw heights, so
  it is not ground truth for where the mesh draws. Compare render to render.
- Top-down A/B hides grazing-angle mask bugs. The parallax bug was invisible from
  above.
- `plugins/mana` `mana.test.ts` zero-effect-stroke failure is pre-existing.
- `shared/src/bands.ts:3` comment budget: repo root lacks `.comment-budget.json`,
  so editing that file trips the pre-commit hook. Contract text now lives in
  `docs/decisions/terrain-relief.md`.

## Not done
- Performance A/B of the shipped tree. Never measured.
- Stencil/outline debug aid removed with the mask; re-add if wanted.

## Cross-refs
[[project_session_handoff_2026_09_16_sea-shore-isoline-mask]]
