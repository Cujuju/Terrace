# Drag fill — the run contract, the tread grab, and the honest carve outline

## Status

DONE. Typecheck clean workspace-wide. `shared` 533/533. `client` green but for
two failures that are not this work (see Known-failing below).

Commits, oldest first:

| commit | what |
|---|---|
| `66fd1858` | the run contract in `shared/` + the wire field |
| `e414e23b` | run-contract tests; shielding invariant replaces gap-survival |
| `7a58e3be` | retire the assertions the run contract supersedes |
| `9e50df5e` | re-record the five sculpt goldens |
| `7e0a53e6` | `overhangs.md` rewritten against the run contract |
| `2bdf1d24` | tread grab + `carveAdmittedCells` + live carve outline |
| `8c7b6afd` | carve outline on riser aims too |
| `12a82689` | disconnected carve outlines + tests |
| `4ff8a8f1` | this handoff |
| (below) | drop the unreachable tread fallback |

## The drag: the run contract

From the dragged band, run down through like material to the first boundary.
That slab is what the stroke writes into every swept cell. Solid runs to its
span's floor; air runs to its void's floor. Welding is not a decision —
`canonicaliseColumn` merges whatever the slab touches. The only refusal is
"already solid through the whole run".

Spec artifact: https://claude.ai/artifact/HUr9vxiorBCBLJmY3HHymM

- `shared/src/columns/bandQueries.ts`: `runFloorBandAt`, `columnHoldsRun`,
  `fillBandRun`, private `weldSlab`. `BandFill`, `overhangSlabAtBand`,
  `bandFillAt`, `applyBandFill` are gone.
- `shared/src/sculpt/drag.ts`: `pushLowerLayers` gone — the run IS the descent.
  The raise path is one plain loop; `settleEachCellOnce` serves the LOWER path
  only. `applyDragRegion` takes `runFloorBand` after `targetBand`.
- The run's floor rides the intent as `floorBand`, because a swept cell cannot
  derive it: in a neighbour the same band sits in a different run.
- Verified: all ten bands of the spec specimen, grabbed column AND swept
  neighbour, match the artifact exactly.

## The drag: pressing on a tread

A press grabs the band under the aim and sends no seed — which is what
`sculpt-tools.md` always said ("A drag press grabs the clicked band — no seed
layer first"); the code had diverged.

`riserBand` used to answer only on a riser, so once the seed was removed a
tread press refused outright. terrace-fd's `1e53edc5 feat(sculpt): select the
band under the aim, whatever the brush` fixed that at the source:
`world.highlightLayerEdge` is now `light.heldBand ?? bandOfPick(pick)` — no
tool or face branching, and `lipNear` decides only what the overlay draws.

So `takeHold` needs no fallback: `riserBand` names the band on every face.
An `aimBand` member was briefly added to `SculptInputOptions` and then removed
once terrace-fd pointed out the branch under it was unreachable — both paths
bottom out in `resolvePick`, so it returned an identical number. Do NOT
reintroduce face branching here; that is the bug 1e53edc5 removed.

This is what lets a drag start anywhere on a flat surface and heal a hollow
without hunting for its edge. Verified by simulation: grabbing flat ground at
band 5 runs to bedrock and fills a pit from band 2 up to band 5.

## The carve outline tells the truth

`shared/src/sculpt/carve.ts` now exports `carveAdmittedCells`, and `applyCarve`
consumes it — one admission, two readers, so the preview cannot promise a cut
the stroke will not make. Tested: they agree cell for cell at radii 1-3.

`client/src/render/brushPreview.ts` outlines those cells instead of borrowing
the stamp's reach disc, on tread AND riser aims, and shows the refusal mark
when nothing is admitted. It reads the band the carve itself reads
(`world.carveBand`), not the band the lip highlight lit.

Disconnected admitted sets are ordinary, not a corner case — measured on a
ridged world, **27% of drawable aims at radius 4** admit two or more
components. So `markOutlineLoops` returns every loop largest-first; the ring
strip keeps the dominant one and a new `LineSegments` object (`stage.extra`,
sharing the outline material) draws the rest. `BRUSH_PREVIEW_DRAW_OBJECTS` is
now 5. A footprint past the fixed buffers still falls back to the reach disc.

## Known-failing, NOT this work

Confirmed by terrace-fd at HEAD with their changes stashed:

- `client/test/predictionGhost.test.ts` — "ghost-marks a grabbed drag sweep
  into a chunk never received".
- the untracked `zz-perf-snapshot.gen` test, which wants a `~/.terrace-perf`
  directory.

## Coordination with terrace-fd [2cf41c]

They hold none of the brush/render files. Their ports: **server 2571, vite
5190** — take anything else.

Their `25263633 refactor(pick): decide the band once, where the hit is decided`
lands under this work:

- `TerrainRayPick` now carries a REQUIRED `band`. Any pick literal in a test or
  fixture needs it.
- Nothing downstream may re-derive a band from `hitY`/`surfaceY`/`spanIndex`;
  read `pick.band`. The rule is `drawnBandAtY(worldY)` in `capEmission.ts`.
  This work stays on the sanctioned path — `world.carveBand` and
  `world.aimBand` — and re-derives nothing.
- Behaviour change they flagged to the owner: a pick re-homed to a neighbouring
  column now names that cell and surface but NOT its band.

Two dev-server traps they hit: `localhost:5174` silently reaches MoManga's
Electron and returns plain-text "Not found"; and a vite on 5175 served a STALE
transform — a page ran the old module while `curl` returned the new text. If
you verify in a browser, confirm the live rule from inside the page.

## Pending

1. **Nothing here has been seen in the running app.** Every claim above is from
   tests and simulation. The tread-grab heal and the carve outline both want
   eyes on them.
2. `docs/decisions/overhangs.md` describes the run contract but not the tread
   grab or the carve outline. Owner permission needed to touch it again.
3. Issue #499 — `canCarveBandAt` tests lateral exposure but is used as an
   access rule. Four decisions wait there: what the predicate means (extend vs.
   grant access), contiguous vs. atomic depth, diagonals, and the OOB rule.
   The pit-floor case (open sky above, one cell wide, cannot be deepened) is
   the sharpest argument that it is wrong as written.
4. Untracked `server/scratch-*.ts` diagnostics still call the deleted
   `bandFillAt`. Not typechecked, safe to delete.

## Cross-refs

[[project_session_handoff_2026_09_16_carve-overhang-pick-gate]] ·
[[project_session_handoff_2026_09_16_sculpt-owner-decisions-walk]] ·
[[project_session_handoff_2026_09_11_d_band0-shoreline-contract]]
