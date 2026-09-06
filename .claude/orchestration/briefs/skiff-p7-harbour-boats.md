# Brief: harbour zoning, boats half — war boats berth beyond the skiffs' inshore strip (GH #327 follow-up)

Repo: /mnt/e/Development/Projects/Terrace. Work ON MAIN in the shared checkout (owner: "patch that on main"). Other agents
share it: never `git add -A`, never a bare `git add`, never stash, never checkout/reset paths you did not edit. Stage and
commit ONLY the paths you edit. Do not push. Do not install dependencies. Never start the app. Comments are claims, not
evidence: verify from executed code and cite file:line. A parallel agent is editing plugins/structures/** — do not touch it.
TESTS (owner rule): do NOT add new `it(...)` cases. Edit existing tests only as far as the changed contract forces; list every
edit. Run only `timeout 180 npx vitest run` inside plugins/boats and `npx tsc --noEmit` there — never `pnpm -r test`.
Server code: shared/ and plugins run under Node 24 type stripping — erasable syntax only; terrain math stays integer/
deterministic (CLAUDE.md hard rules).

## Owner defect (2026-09-05, verbatim): skiffs "collide with each other and with the warboats".

## Root cause (verified by the orchestrator; cite the lines yourself)
plugins/boats/server/fleet.ts `surveyedLaunch` (1011-1052) berths war boats at the nearest hull-legal, manoeuvrable cells to
the village over the nearest-first COASTAL_DISC. plugins/structures/client/site.ts moors that same village's skiffs
(client-side presentation, 0.36-long hulls orbiting 0.12–0.28 world units round a mooring) at the nearest drawn-water cells
with 2 cells of clearance. Measured on the owner's world (15 coastal villages): nearest berth and nearest skiff mooring lie at
the same distance from the village (6.1–14.4 cells) to within a cell, every time. War boats at rest therefore sit inside the
skiffs' orbits. The server cannot know skiff moorings (they depend on the client's DRAWN ground), so the partition has to be a
rule both sides derive from the same input: the village cell and its nearest water.

## The contract (decided; do not redesign)
Harbours are zoned RELATIVE to each village's own shoreline: skiffs get the INSHORE strip past the nearest water; war boats
berth beyond it. The structures agent bounds every skiff's reach to `shore + HARBOUR_INSHORE_BAND_WORLD_UNITS` (1.5 world
units = 6 cells, measured from the village to the nearest confirmed water cell).
- plugins/boats/protocol.ts: `export const HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.5` — a DELIBERATE RESTATEMENT of
  plugins/structures/protocol.ts's constant of the same name, on the same footing as COASTAL_SEARCH_RADIUS_CELLS there
  (protocol.ts:223-240): comment names the twin and why the number is 1.5 (skiff moorings sit ~3 cells past the shore + 1.84
  cells of orbit-plus-hull reach, rounded up to 6 cells).
- fleet.ts: `BERTH_STANDOFF_CELLS` = cellsAcross(HARBOUR_INSHORE_BAND_WORLD_UNITS) + BOAT_HULL_LENGTH_CELLS / 2 +
  BOAT_PERSONAL_SPACE_CELLS — derived, never typed: the inshore strip, plus the half-hull a berthed boat sticks back toward
  the shore, plus one personal space of margin because the two plugins measure "nearest water" slightly differently
  (isSailable admits raw height 0; site.ts's confirmed water needs band ≤ -1, and the drawn contour can differ again).
  Comment the derivation and the number it comes to today (≈ 9.8 cells).
- `surveyedLaunch`: `shoreCells` = the distance (Math.sqrt(dx²+dy²)) of the first sailable cell (the `launch`). A cell is a
  berth candidate only if its distance ≥ shoreCells + BERTH_STANDOFF_CELLS, everything else about a berth (isManoeuvrablePose,
  clearOfTaken, MOORINGS_SURVEYED_PER_VILLAGE) unchanged.
- The berth walk needs a WIDER disc than the coastal verdict: at shore 12 cells the standoff puts berths at ~22, past the
  16-cell COASTAL_DISC. Add `BERTH_SEARCH_RADIUS_CELLS = COASTAL_SEARCH_RADIUS_CELLS + ceil(BERTH_STANDOFF_CELLS)` and a
  second nearest-first disc for the berth half (build it with the same tight-disc rule as COASTAL_DISC; cost note: walked on
  the survey cadence only, ~2x the cells). Keep the launch/coastal verdict on COASTAL_DISC exactly as it is. Also the
  hard-cap `isCellUnlocked` semantics — the wider disc must still respect them.
- FALLBACK, named and bounded: a village whose wider disc holds NO berth beyond the standoff (a pocket bay) keeps berthing at
  the nearest legal cells as today, so its boats still have berths to launch from and return to. Say in a comment that this
  is the one place war boats and skiffs can still share water, and under what condition. Count and report how many of the
  owner's villages hit it (offline check below).
- persistence.ts validates only Village's persisted fields — the shipyard is derived — so nothing on disk changes; confirm.

## Verification
tsc clean in plugins/boats; boats vitest green (paste the summary; fix only tests the contract forces, list them). Then adapt
the orchestrator's offline check /tmp/claude-1000/-mnt-e-Development-Projects-Terrace/32b43f92-2c0d-4a76-b57d-e0dcab180715/scratchpad/harbour-measure.mjs
(copy to your own scratch file; it approximates isSailable/isHullPose/sea room on the raw heightmap) to the new berth rule and
report per village: shore distance, nearest qualifying berth distance, berths found (of 6), fallback hit yes/no.
World: /mnt/e/Development/Projects/Terrace/.skiff-eyes-on/worlds/frostwick-hollows.db (read-only; node:sqlite).

## Commit (exact paths only)
`fix(boats): war boats berth beyond the skiffs' inshore strip (#327)`

## Report (short; write to .claude/orchestration/briefs/skiff-p7-boats-report.md and return it)
Commit hash; the offline table; test edits; the residual (transit routes may still cross the inshore strip — say so, and
whether findRoute could be told to avoid it cheaply, one line, no implementation); anything not verified.
