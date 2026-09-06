# Brief: harbour zoning, structures half — skiffs keep clear of each other and stay inshore (GH #327 follow-up)

Repo: /mnt/e/Development/Projects/Terrace. Work ON MAIN in the shared checkout (owner: "patch that on main"). Other agents
share it: never `git add -A`, never a bare `git add`, never stash, never checkout/reset paths you did not edit. Stage and
commit ONLY the paths you edit. Do not push. Do not install dependencies. Never start the app. Comments are claims, not
evidence: verify from executed code and cite file:line. A parallel agent is editing plugins/boats/** — do not touch it.
TESTS (owner rule): do NOT add new `it(...)` cases. Edit existing tests only as far as the changed contract forces
(fixtures, renamed fields, counts); list every edit in the report. Run only `timeout 180 npx vitest run` inside
plugins/structures and `npx tsc --noEmit` inside plugins/structures and client — never `pnpm -r test`.

## Owner defect (2026-09-05, verbatim): skiffs "collide with each other and with the warboats".

## Root causes (verified this session by the orchestrator — cite the lines yourself before building on them)
1. SKIFF vs SKIFF. site.ts `surveySite` keeps the first SURVEY_WATER_CELLS_RETAINED (=3) moorable cells nearest-first;
   moorable cells are adjacent (0.25 world units apart) while each skiff reaches SKIFF_MOORING_CLEARANCE_WORLD_UNITS
   (0.46) from its anchor — three orbits over one patch. Across settlements the same mooring can be kept by two
   neighbouring villages, which hashStructureCell then gives the IDENTICAL orbit (same cell → same roll → two hulls drawn
   through each other). There is no spacing rule anywhere.
2. SKIFF vs WAR BOAT. plugins/boats/server/fleet.ts `surveyedLaunch` (1011-1052) berths war boats at the nearest hull-legal
   cells to the same village cell, over the same nearest-first coastal disc (VILLAGE_MIN_TIER 1 = SKIFF_MIN_TIER). Measured
   on the owner's world (15 coastal villages): nearest skiff mooring and nearest berth are at the same distance from the
   village (6.1–14.4 cells) to within a cell, every time. The two fleets are placed by the same rule on the same spot.

## The contract (decided; do not redesign)
Harbours are zoned RELATIVE to each village's own shoreline: skiffs get the INSHORE strip past the nearest water, war boats
berth beyond it (the boats agent implements the outer half). Both plugins carry their own copy of the band width — the
repo's per-plugin-copy convention (plugins/structures/protocol.ts header; plugins/boats/protocol.ts:223-240 already restates
site.ts's constants the same way).
- plugins/structures/protocol.ts: `export const HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.5` — the strip past a village's nearest
  confirmed water that belongs to its skiffs. Comment: derivation (skiff moorings sit 2.7–3.2 cells past the shore on the
  owner's world because the mooring square needs 2 cells of drawn water; plus SKIFF_MOORING_CLEARANCE 1.84 cells of reach
  = 5.0 cells, rounded up to 6 = 1.5 world units), and that plugins/boats/protocol.ts restates it (name the twin constant
  `HARBOUR_INSHORE_BAND_WORLD_UNITS` there too) with its berth standoff derived from it.
- skiffs.ts: `SKIFF_MOORING_SPACING_WORLD_UNITS = 2 * SKIFF_MOORING_CLEARANCE_WORLD_UNITS` (two reach discs disjoint; derived,
  with the one-line proof).
- site.ts `surveySite`:
  a. `shoreCells` = the distance (Math.sqrt of dx²+dy², cells) of the FIRST confirmed water cell in the nearest-first scan.
  b. A candidate is a mooring only if `distance + SKIFF_MOORING_CLEARANCE_WORLD_UNITS / CELL_WORLD_SIZE <= shoreCells +
     HARBOUR_INSHORE_BAND_WORLD_UNITS / CELL_WORLD_SIZE` (name the two derived cell constants) — the whole reach stays
     inshore. Since the scan is nearest-first, once a candidate exceeds the bound no later one can qualify: stop testing
     moorings (the coastal COUNT still needs the disc; keep that loop exactly as it is).
  c. AND at least SKIFF_MOORING_SPACING from every mooring already kept in THIS survey (world units; compare squared).
  d. Retain up to `SURVEY_MOORINGS_RETAINED = 2 * SKIFF_MAX_PER_SETTLEMENT` (=6) so the cross-settlement pass below has
     spares — same reasoning fleet.ts:455-465 gives for MOORINGS_SURVEYED_PER_VILLAGE; keep the `<= COASTAL_MIN_WATER_CELLS`
     requirement note. Rename SURVEY_WATER_CELLS_RETAINED accordingly and fix its comment.
- placement.ts `placementsFor`: skiff assignment becomes a SECOND PASS after the placement loop, over coastal settlements
  sorted by structureKey (deterministic and stable across rebuilds — Map insertion order is delta-arrival order and must not
  decide who gets which mooring). A global `claimed` list of mooring cells: for each settlement, walk its survey.moorings
  nearest-first and take the first ones at least SKIFF_MOORING_SPACING from every claimed mooring (any settlement's), up to
  min(SKIFF_MAX_PER_SETTLEMENT, tier). Move the count/tier logic accordingly: `skiffsForSettlement(tier, moorings)` may keep
  its signature and be handed the already-claimed subset — decide and say why. Claimed list is ≤ STRUCTURES_CAP x 3 entries
  and the pass is O(settlements x 6 x claimed) — state the worst-case number in the comment.
- Update the file banners / residual paragraphs that describe the old "nearest three" behaviour (skiffs.ts 23-30 and
  71-85, site.ts's mooring section) to describe the zoning and spacing guarantees and where each is enforced.

## Verification
tsc clean (structures, client); structures vitest green (paste the summary); `git diff --stat`. Grep for every consumer of
`SURVEY_WATER_CELLS_RETAINED`, `survey.moorings`, `skiffsForSettlement(` and confirm none missed. Then run the orchestrator's
offline check adapted to the new rules and paste its table: copy
/tmp/claude-1000/-mnt-e-Development-Projects-Terrace/32b43f92-2c0d-4a76-b57d-e0dcab180715/scratchpad/harbour-measure.mjs
to your own scratch file, add the inshore bound + spacing to its skiff half, and report per village: shore distance, number
of moorings kept, min pairwise mooring distance (must be ≥ 3.68 cells), max (anchor distance + 1.84) − shore (must be ≤ 6).
World: /mnt/e/Development/Projects/Terrace/.skiff-eyes-on/worlds/frostwick-hollows.db (read-only; node:sqlite).

## Commit (exact paths only)
`fix(structures): skiffs moor inshore, spaced two reaches apart, claimed once across villages (#327)`

## Report (short; write to .claude/orchestration/briefs/skiff-p7-structures-report.md and return it)
Commit hash; the offline table; test edits; anything beyond the brief and why; anything not verified.
