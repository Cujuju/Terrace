# Drag fill — the run contract

## Status

DONE. Typecheck clean workspace-wide. `shared` 531/531 green. `client`
2 failed / 774 passed — same two as before this work, and better than the
4 fail / 772 pass baseline the last handoff recorded. `overhangs.md` rewritten,
goldens re-recorded with the owner's approval.

Commits: 66fd1858 (code) · e414e23b, 7a58e3be, 9e50df5e (tests + goldens) ·
7e0a53e6 (doc).

## The rule (unchanged from the spec)

From the dragged band, run down through like material to the first boundary.
That slab is what the stroke writes into every swept cell. Solid runs to its
span's floor; air runs to its void's floor. Welding is not a decision —
`canonicaliseColumn` merges whatever the slab touches. The only refusal is
"already solid through the whole run".

Spec artifact: https://claude.ai/artifact/HUr9vxiorBCBLJmY3HHymM

## What changed in code

`shared/src/columns/bandQueries.ts`
- DELETED `BandFill`, `overhangSlabAtBand`, `bandFillAt`, `applyBandFill`.
- ADDED `runFloorBandAt(map,x,y,band)` — the run's floor. Read in the GRABBED
  column only.
- ADDED `columnHoldsRun(map,x,y,floorBand,band)` — the one refusal.
- ADDED `fillBandRun(map,x,y,floorBand,band,ceiling)` — writes the slab,
  returns whether the column changed.
- ADDED private `weldSlab(spans, slab)` — absorbs every span the slab overlaps
  or abuts, in one ordered pass, so the result ascends without sorting
  (`canonicaliseColumn` throws on a non-ascending column).

`shared/src/sculpt/drag.ts`
- DELETED `pushLowerLayers`, `DRAG_TREAD_TOLERANCE_CELLS`, the `priorSpans` /
  `record` / `hadCapAtBandBefore` bookkeeping, and the `canSpreadBandTo` gate
  on the raise path.
- `applyDragRegion` gained a `runFloorBand` parameter (after `targetBand`).
- The raise path is now one plain loop over the disc; nothing cascades off a
  neighbour, so `settleEachCellOnce` is used by the LOWER path only.

Wire — the run's floor travels on the intent as `floorBand`:
- `shared/src/protocol/sculpt.ts`: `SculptIntent.floorBand?`, validated to ride
  with a drag and only a drag, `MIN_BAND <= floorBand <= targetBand`; resolves
  to `ResolvedSculptOptions.runFloorBand`.
- `shared/src/sculpt/options.ts`: `runFloorBand` on `SculptOptions` (optional)
  and `ResolvedSculptOptions` (nullable); library default `null`.
- `shared/src/heightmap.ts`: passes it through; `null` falls back to
  `targetBand` (the slab is the band alone — no grabbed column spoke).
- `client`: `world.runFloorBandAt` → `SculptInputOptions.runFloorBandAt` →
  `StrokeState.strokeGrabFloor`, read once in `takeHold` and sent on every leg.

## Verified

All ten bands of the spec specimen, grabbed column AND swept neighbour, match
the artifact exactly — including the owner's rulings on bands 4, 5, 6, 7, 8.
(Throwaway script, already deleted.)

Client tests before the test-block rewrite: 2 failed / 774 passed.
Handoff baseline was 4 fail / 772 pass, so no regression.

## What changed in tests

- `shared/test/columns.test.ts`: the `bandFillAt` block is replaced by
  `runFloorBandAt` and `fillBandRun` cases built on the spec specimen.
- `shared/test/support/invariants.ts`: `expectGapsSurvive` →
  `expectGapsBelowRunSurvive(map, before, runFloorBand, context)`. Gaps ABOVE
  the run's floor may now close; below it they must survive. The fuzzer's
  drags carry `floorBand`, and all 7 worlds pass.
- `heightmap-carve.test.ts`: #224's "never fills the carve under it" is now
  "never reaches below its run's floor", plus a case asserting the tunnel DOES
  fill when the run is its own air.
- `heightmap-drag.test.ts`: the staircase pull asserts whole-step raising (a
  ground grab runs to bedrock), not `pushLowerLayers`' one-step descent; the
  point disc asserts its own footprint, not a refusal.
- `protocol` / `heightmap-dispatch` / 4 client files: fixture wiring only.

## Assumption to flag

The raise path no longer consults `canSpreadBandTo`. The spec's codebox is
"the whole of it, per swept cell" and names no adjacency gate, and keeping one
would have broken the air-grab cases (a hollow's neighbour holds no material
at the dragged band, so nothing could ever start). `canSpreadBandTo` is
untouched for stamp and `anchor: 'band'`.

## Pending

1. Server suite not re-run this session. Prior-session baseline: 29 fail /
   441 pass, other agents' in-flight work. `pnpm test` bails at the first
   failing package — run `shared`, `client`, `server` separately.
2. Untracked diagnostics in `server/` still call the deleted `bandFillAt`
   (`scratch-cliff-sim.ts`, `scratch-drag-hole.ts`, `scratch-void-mint.ts`,
   `scratch-drag-dead6.ts`). Not typechecked, safe to delete.
3. A pre-commit hook caps comments at 30 words and flags PRE-EXISTING ones in
   `client/src/input/sculpt/contract.ts` (lines 6 and 26). Touching that file
   needs `SKIP_COMMENT_BUDGET=1` until someone trims them.

## Cross-refs

[[project_session_handoff_2026_09_16_carve-overhang-pick-gate]] ·
[[project_session_handoff_2026_09_16_sculpt-owner-decisions-walk]] ·
[[project_session_handoff_2026_09_11_d_band0-shoreline-contract]]
