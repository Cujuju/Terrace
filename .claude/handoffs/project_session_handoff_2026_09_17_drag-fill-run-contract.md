# Drag fill — the run contract

## Status

IMPLEMENTED. Code + tests written this session. Typecheck clean across the
whole workspace. Tests not yet fully re-run; `overhangs.md` not yet rewritten.

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

## Owner decisions this session

- Stale `bandFillAt` test block: replace with run-contract cases. DONE —
  `shared/test/columns.test.ts` now has `describe('runFloorBandAt …')` and
  `describe('fillBandRun …')` in its place.
- `docs/decisions/overhangs.md`: rewrite, "rip it down to its bare minimum,
  facts only, terse, the smaller the better." NOT DONE YET.

## Assumption to flag

The raise path no longer consults `canSpreadBandTo`. The spec's codebox is
"the whole of it, per swept cell" and names no adjacency gate, and keeping one
would have broken the air-grab cases (a hollow's neighbour holds no material
at the dragged band, so nothing could ever start). `canSpreadBandTo` is
untouched for stamp and `anchor: 'band'`.

## Pending

1. Re-run `pnpm --filter shared test` and `pnpm --filter client test`.
   NOTE: `pnpm test` bails at the first failing package — run separately.
   Server baseline from the prior session: 29 fail / 441 pass (other agents').
2. Regenerate the two `golden-sculpt` file snapshots — they WILL move.
   ASK THE OWNER FIRST.
3. Rewrite `docs/decisions/overhangs.md` (permission granted, see above).
   Its "The drag lays a roof; it never fills the carve beneath one" section
   and #224's no-span-field-on-the-wire ruling are both superseded.
4. Untracked diagnostics in `server/` still reference the deleted `bandFillAt`
   (`scratch-cliff-sim.ts`, `scratch-drag-hole.ts`, `scratch-void-mint.ts`,
   `scratch-drag-dead6.ts`). Not typechecked, safe to delete.

## Cross-refs

[[project_session_handoff_2026_09_16_carve-overhang-pick-gate]] ·
[[project_session_handoff_2026_09_16_sculpt-owner-decisions-walk]] ·
[[project_session_handoff_2026_09_11_d_band0-shoreline-contract]]
