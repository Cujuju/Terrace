# Report: harbour zoning, boats half (#327 follow-up)

**Commit** `fad1530c7495a0448dafbd85519be0f9721bd758` —
`fix(boats): war boats berth beyond the skiffs' inshore strip (#327)`
Paths: `plugins/boats/protocol.ts`, `plugins/boats/server/fleet.ts`,
`plugins/boats/test/boats.test.ts`. Not pushed.

## What changed

- `plugins/boats/protocol.ts` — `HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.5`, the
  deliberate restatement of structures' twin, commented on the same footing as
  `COASTAL_SEARCH_RADIUS_CELLS` (protocol.ts:223-240): the twin is named, and
  1.5 is justified as ~3 cells of mooring offset + 1.84 cells of orbit-plus-half-hull
  reach, rounded up to six cells.
- `plugins/boats/server/fleet.ts` — `BERTH_STANDOFF_CELLS`, derived not typed:
  `cellsAcross(1.5) + BOAT_HULL_LENGTH_CELLS / 2 + BOAT_PERSONAL_SPACE_CELLS`
  = 6 + 1.8 + 2 = **9.8 cells**. `BERTH_SEARCH_RADIUS_CELLS = 16 + ceil(9.8) = 26`
  and a second nearest-first `BERTH_DISC` built with COASTAL_DISC's tight-disc
  rule (2 028 cells against 748, walked on the survey cadence only).
- `surveyedLaunch` is now two walks. The launch/coastal verdict walks
  COASTAL_DISC exactly as before (unchanged bar, unchanged early-out). The berth
  half walks BERTH_DISC; `shoreCells` is `Math.sqrt(dx²+dy²)` of the launch cell,
  and a cell is a berth candidate only at distance `>= shoreCells + BERTH_STANDOFF_CELLS`.
  `isManoeuvrablePose`, `clearOfTaken`/`HOME_BERTH_CLEARANCE_CELLS` and
  `MOORINGS_SURVEYED_PER_VILLAGE` are untouched. Both walks go through
  `isSailable`, so `isCellUnlocked`'s hard-cap semantics still gate the wider disc.
- **Fallback**, named and bounded in a comment: a POCKET BAY — a village whose
  whole BERTH_DISC holds no legal cell beyond the standoff — keeps berthing at
  the nearest legal cells as before, or its boats have nowhere to launch from and
  return to. The comment says this is the one place war boats and skiffs can
  still share water, and under exactly what condition.
- **Also fixed, same root cause**: `resurveyShipyardsNear` (fleet.ts:727-733)
  bounded its "did this sculpt touch me" box with `COASTAL_SEARCH_RADIUS_CELLS`.
  Now the survey walks to 26, a sculpt between 16 and 26 cells out changes a
  berth, so the box uses `BERTH_SEARCH_RADIUS_CELLS`. Left alone this would have
  been a stale-berth bug the standoff introduced.
- **Persistence: confirmed, nothing on disk changes.** `parseVillage`
  (persistence.ts:23-30) validates only `x`, `y`, `rebuildSeconds`; the shipyard
  (and its `moorings`) is derived state, never serialised.

## Offline check

`.skiff-eyes-on/worlds/frostwick-hollows.db`, latest snapshot, adapted from the
orchestrator's `harbour-measure.mjs` (same raw-heightmap approximations of
`isSailable` / hull pose / sea room; standoff, clearance and berth count taken
from the new constants). Script:
`…/0c49802f-f31c-4788-ae36-71fba05f877f/scratchpad/berth-check.mjs`.

| village | tier | shore | berth floor | nearest berth | berths | fallback |
|---|---|---|---|---|---|---|
| 433,255 | 2 | 4.2 | 14.0 | 14.1 | 6/6 | no |
| 443,259 | 4 | 4.1 | 13.9 | 13.9 | 6/6 | no |
| 437,260 | 4 | 8.6 | 18.4 | 18.4 | 6/6 | no |
| 450,265 | 2 | 3.6 | 13.4 | 13.4 | 6/6 | no |
| 443,268 | 4 | 10.8 | 20.6 | 20.8 | 6/6 | no |
| 446,272 | 3 | 11.7 | 21.5 | 21.5 | 6/6 | no |
| 460,276 | 3 | 4.1 | 13.9 | 13.9 | 6/6 | no |
| 461,281 | 5 | 4.1 | 13.9 | 13.9 | 6/6 | no |
| 457,286 | 5 | 8.9 | 18.7 | 18.8 | 6/6 | no |
| 464,287 | 4 | 4.0 | 13.8 | 13.9 | 6/6 | no |
| 406,339 | 2 | 4.1 | 13.9 | 13.9 | 6/6 | no |
| 413,340 | 3 | 6.3 | 16.1 | 16.2 | 6/6 | no |
| 434,341 | 4 | 5.8 | 15.6 | 15.7 | 6/6 | no |
| 419,344 | 5 | 5.0 | 14.8 | 14.9 | 6/6 | no |
| 428,344 | 5 | 5.4 | 15.2 | 15.2 | 6/6 | no |

**15 of 15 villages fill all six berths beyond the standoff. Zero fallback hits.**
Two villages (443,268 and 446,272) berth at 20.8 and 21.5 cells — past the
16-cell COASTAL_DISC, which is the direct evidence the wider disc was required
rather than merely tidy.

## Verification

- `npx tsc --noEmit` in `plugins/boats` — clean.
- `timeout 180 npx vitest run` in `plugins/boats` — **Test Files 5 passed (5),
  Tests 54 passed (54)**, 7.54s.

### Test edits (one; no new `it(...)`)

`test/boats.test.ts`, "keeps every spread boat inside engagement range": the
station-keeping window went from 50 ticks (5 s) to 110 (11 s), plus a comment
saying why. Forced by the contract, not by the assertion: berths now stand off
the shore, so in that fixture the fleet berths at 10.8 cells from the village
and the two far-side boats start ~27-29 cells from a kraken they must close to
20 — a coming-about plus about four seconds of sailing. Measured before the
edit: at 5 s they were still at 23.4 cells and closing at ~2.3 cells/s, so the
old window ended mid-approach and `everEngaged.size` was 1 of 3. 11 s is still
inside `KRAKEN_SINKS_BOAT_EVERY_SECONDS` (12), so nothing sinks and the final
`everEngaged.size === livingBoats().length` still compares like with like.
No assertion was weakened or removed.

## Residual

**Transit routes may still cross the inshore strip.** The standoff zones where
war boats *rest*; a boat sailing out to a kraken or home from one is routed by
`findRoute` over open water and can cut straight through a village's skiff band.
Could `findRoute` be told to avoid it cheaply? **No** — it takes a
`TerrainSampler` + `TraversalProfile` and a node budget (shared/src/pathing.ts:409-414)
with no per-cell cost or penalty hook, so the only lever is a wrapped sampler
that calls the strip unwalkable, which would strand every boat at its own launch
cell (the launch cell is *inside* the strip by construction).

## Not verified

- Eyes-on in the running app: never started the app (owner's standing rule).
- Live behaviour of the two halves together. The structures side landed while
  this was being written: `plugins/structures/protocol.ts:518` now exports
  `HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.5` with the mirrored comment, and its
  derivation (2.7-3.2 cells of mooring offset + 1.84 cells of hull reach, rounded
  up to 6) agrees term for term with this one — **the two constants are checked
  against each other and match**. What is still unverified is the pair running
  in the app.

- NOTE ON THE COMMIT: this report file was swept into another agent's commit
  `f9e7edf` (a broad `git add` on the shared checkout) rather than committed
  under its own message. The file is in the tree; only the commit it rode in on
  is wrong.
- The offline check uses the raw heightmap. It approximates `isSailable`
  (band <= -1 vs. `sharedIsWalkableCell` over `OPEN_WATER_PROFILE`, which admits
  raw height 0) and `isManoeuvrablePose` (five hull probes on a 1-cell-eroded
  draft-7 field). That mismatch is precisely why `BERTH_STANDOFF_CELLS` carries
  a `BOAT_PERSONAL_SPACE_CELLS` margin; it is not a substitute for the real
  predicate.
