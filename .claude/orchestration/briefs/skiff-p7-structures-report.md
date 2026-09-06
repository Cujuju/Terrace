# Report: harbour zoning, structures half (GH #327)

**Commit** `83ed140` — `fix(structures): skiffs moor inshore, spaced two reaches apart, claimed once across villages (#327)`

```
 plugins/structures/client/placement.ts |  73 ++++++++++-
 plugins/structures/client/site.ts      | 217 +++++++++++++++++++++++++--------
 plugins/structures/client/skiffs.ts    |  64 ++++++++--
 plugins/structures/protocol.ts         |  34 ++++++
 plugins/structures/test/client.test.ts |  15 ++-
 5 files changed, 338 insertions(+), 65 deletions(-)
```

## Root causes, re-verified from executed code before building on them

1. **Skiff vs skiff.** `site.ts:359` (pre-change) `if (moorings.length < SURVEY_WATER_CELLS_RETAINED)`
   kept the first 3 moorable cells of the nearest-first disc with no pairwise test;
   `SURVEY_WATER_CELLS_RETAINED = SKIFF_MAX_PER_SETTLEMENT` at `site.ts:150`. Cross-settlement,
   `placement.ts:118` pushed `skiffsForSettlement(...)` per settlement with no shared state, and
   `skiffs.ts:169` rolls `hashStructureCell(cell.x, cell.y)` on the ANCHOR cell — so one mooring kept
   by two villages produced two *identical* orbits. Confirmed.
2. **Skiff vs war boat.** `plugins/boats/server/fleet.ts:1011-1052` `surveyedLaunch` walks
   `COASTAL_DISC` nearest-first about the same village cell, same radius, same `VILLAGE_MIN_TIER = 1`.
   Confirmed.

## What changed

- `protocol.ts` — new `HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.5`, with the derivation (2.7–3.2 cells of
  shore standoff + 1.84 cells of hull reach = 5.0, rounded to 6 cells) and a note that
  `plugins/boats/protocol.ts` restates it under the same name. Verified: the boats agent landed
  `plugins/boats/protocol.ts:281 = 1.5` in `70d7509`; the two agree.
- `skiffs.ts` — new `SKIFF_MOORING_SPACING_WORLD_UNITS = 2 * SKIFF_MOORING_CLEARANCE_WORLD_UNITS`
  with the one-line disjointness proof; banner rewritten to name the three guarantees and say each is
  enforced *elsewhere*; `skiffsForSettlement`'s doc rewritten (it now receives an unclaimed subset).
- `site.ts` — `SURVEY_WATER_CELLS_RETAINED` → `SURVEY_MOORINGS_RETAINED = 2 * SKIFF_MAX_PER_SETTLEMENT`
  (=6), comment rewritten with the `<= COASTAL_MIN_WATER_CELLS` note kept (6 <= 32). Three derived
  cell constants: `SKIFF_MOORING_REACH_CELLS` (1.84, unrounded — distinct from the ceiled
  `SKIFF_MOORING_CLEARANCE_CELLS`, which is a loop bound), `HARBOUR_INSHORE_BAND_CELLS` (6), and the
  exported `SKIFF_MOORING_SPACING_CELLS_SQUARED` (13.54). `surveySite` now tracks `shoreCells` (the
  first confirmed water cell's `Math.sqrt(dx²+dy²)`) and closes the mooring half when
  `distance + reach > shoreCells + band`, keeping only candidates spaced from those already kept. The
  coastal-count loop is untouched. Banner gained a "WHY A MOORING IS ALSO A ZONE AND A SPACING"
  section; the `moorings` field doc and the cost paragraph were rewritten.
- `placement.ts` — skiff assignment moved to a second pass over coastal settlements sorted by
  `structureKey`, with a global `claimed` list. Banner gained a "TWO PASSES, NOT ONE" section.

## Decisions the brief left open

- **`skiffsForSettlement` keeps its signature and is handed the filtered pool**, and the pass claims
  exactly the moorings it returned placements for (rather than pre-computing
  `min(SKIFF_MAX_PER_SETTLEMENT, tier)` itself). Reason: it keeps the tier→count rule in one place, so
  the claim can never disagree with the placement. Cost stated in the comment: worst case
  512 harbours × 6 moorings × 1 536 claims = **4 718 592** squared-distance tests.

## Offline check (`.skiff-eyes-on/worlds/frostwick-hollows.db`, 15 coastal villages)

Adapted from the orchestrator's `harbour-measure.mjs` — the skiff half now applies the inshore bound,
the intra-survey spacing, `SURVEY_MOORINGS_RETAINED = 6`, and placement.ts's structureKey-ordered
cross-settlement claiming.

| village | tier | shore | surveyed | skiffs | min pairwise | max (anchor+1.84) − shore |
|---|---|---|---|---|---|---|
| 433,255 | 2 | 4.2  | 3 | 2 | 5.39 | 4.67 |
| 443,259 | 4 | 4.1  | 2 | 2 | 4.47 | 5.78 |
| 437,260 | 4 | 8.6  | 4 | 2 | 4.00 | 5.89 |
| 450,265 | 2 | 3.6  | 1 | 1 | –    | 4.64 |
| 443,268 | 4 | 10.8 | 2 | 0 | –    | –    |
| 446,272 | 3 | 11.7 | 1 | 0 | –    | –    |
| 460,276 | 3 | 4.1  | 2 | 2 | 6.32 | 5.53 |
| 461,281 | 5 | 4.1  | 2 | 1 | –    | 4.72 |
| 457,286 | 5 | 8.9  | 2 | 1 | –    | 5.90 |
| 464,287 | 4 | 4.0  | 2 | 0 | –    | –    |
| 406,339 | 2 | 4.1  | 1 | 1 | –    | 4.79 |
| 413,340 | 3 | 6.3  | 2 | 2 | 4.12 | 5.57 |
| 434,341 | 4 | 5.8  | 1 | 1 | –    | 4.61 |
| 419,344 | 5 | 5.0  | 2 | 1 | –    | 5.90 |
| 428,344 | 5 | 5.4  | 2 | 2 | 4.47 | 5.45 |

**Both bounds hold.** Global min pairwise distance over all 18 claimed moorings world-wide
(not just within a village) = **4.00 ≥ 3.68**. Max `(anchor distance + 1.84) − shore` over every
village = **5.90 ≤ 6**.

Worth the owner's eye: three villages (443,268 / 446,272 / 464,287) now float **zero** skiffs — their
surveyed moorings were all claimed by a nearer-keyed neighbour on the same bay, and fleets elsewhere
are 1–2 rather than 3. That is the contract working as specified (better no skiff than two hulls in
one), not a defect, but the visible fleet is smaller than before.

## Verification

- `npx tsc --noEmit` in `plugins/structures` — clean.
- `npx tsc --noEmit` in `client` — clean.
- `timeout 300 npx vitest run` in `plugins/structures`:
  `Test Files 8 passed (8) / Tests 192 passed (192)`.
- Grepped every consumer of `SURVEY_WATER_CELLS_RETAINED`, `survey.moorings`, `skiffsForSettlement(`:
  no code reference to the old name survives (only historical briefs). `plugins/boats` was not touched.

## Test edits

**No `it(...)` case was added, removed, renamed, or had an assertion changed.** Two comments were
corrected because they named the renamed constant or an obsolete reason:

1. `test/client.test.ts:337-341` — the comment on `expect(survey.moorings.length).toBe(SKIFF_MAX_PER_SETTLEMENT)`
   cited `SURVEY_WATER_CELLS_RETAINED` as the reason for 3. That constant is gone and the retained
   count is now 6; on this fixture the count is 3 because the inshore band and the spacing run out
   first (moorable columns start at dx 5, the band closes past distance 7.16, and 3.68 cells of
   spacing admits exactly (5,0), (5,−4), (5,4)). Comment rewritten to say that. Assertion unchanged.
2. `test/client.test.ts:381-387` — the "moorings are sorted nearest first" comment claimed the survey
   returns "the first SKIFF_MAX_PER_SETTLEMENT" moorable cells; it now returns a thinned subset.
   Comment rewritten to note that spacing and the band only ever REJECT, never reorder. Assertions
   unchanged.

## Beyond the brief

- `skiffs.ts:99` and the `site.ts` banner referred to a function `isMoorable` that does not exist —
  the predicate is `mooringVerdict`. Both references corrected (comment-only, zero behaviour).
- `surveySite`'s `pending` is now `mooringUndrawn && moorings.length < SURVEY_MOORINGS_RETAINED`,
  applied on **both** coastal return paths rather than only the post-loop one. The brief did not ask
  for this and it is a real fix the zoning forced: the early-out previously returned `pending: false`
  unconditionally, which was sound only while it could fire *only* on a full pool. It can now also
  fire on the inshore band closing with a short pool, and returning `false` there would memoise a
  survey that undrawn ground had cost a usable mooring. The `< RETAINED` guard is what keeps a full
  pool memoisable (see `createSiteSurveyCache`).

## Not verified

- **No eyes-on.** The app was not started (brief and project rule). Everything here is offline
  measurement on the `frostwick-hollows.db` snapshot plus the unit suite; nobody has watched a skiff.
- **The offline check is a lattice approximation of the drawn test.** `moorable()` in the script is a
  5×5 square of raw height ≤ −1, inherited unchanged from the orchestrator's script; the real
  `mooringVerdict` samples the DRAWN cap at quarter-cell pitch. The zoning/spacing arithmetic it
  measures is exact; which cells qualify as moorable in the live client may differ slightly.
- **The skiff/war-boat separation is only half-verified here.** I verified the two plugins carry the
  same `HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.5`; whether the boats half's berth standoff actually
  clears the band is the boats agent's measurement, not mine.
- **`WORLD_UNIT_CELLS` is an unused import in `site.ts`** (pre-existing at `HEAD`, not introduced
  here). Left alone as out of scope; `tsc` does not flag it, the editor's linter does.
