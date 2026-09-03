# Brief — #301 mudslides take a plateau's top bands; they should take the rim

You are a fresh implementation agent. Work in your OWN worktree (the harness gives
you one: `EnterWorktree` with no path → new worktree off main). Commit to its branch
(conventional commits, first line < 72 chars, NO attribution footers, stage exact
paths only). Do NOT merge to main. Paths below are relative to the worktree root.

Read first (binding):
- `.claude/orchestration/briefs/mudslide-301-diagnosis.md` — the verified diagnosis.
  Its file:line claims were spot-checked by the orchestrator; re-verify anything you
  build on. Comments are claims, not evidence.
- Root `CLAUDE.md` hard rules: integer-only terrain math, fixed iteration order,
  server-authoritative, erasable TS.
- `docs/decisions/storms-and-mudslides.md` (do not append to it).
- `plugins/mudslides/protocol.ts:110-160`, `server/terrain.ts`, `server/slides.ts`
  (survey :570-620, startSlide :740-780, scourHead :800-815, sculptStep :914-945),
  `server/dev.ts:130-200`.

## Owner's ruling (2026-09-02, issue #301)
"Mudslides seem to only apply to the topmost bands in a plateau when it should be
applying to edges. Since it's a land slide, the edge falls off." A slide's scar
must be AT THE RIM: the cell where the ground actually steps down.

## Root cause (from the diagnosis, verified)
Steepness is qualified over an 8-cell span (`slopeAt`, terrain.ts:174-202 reads
only `here` and the ring `MUDSLIDE_SLOPE_SPAN_CELLS` out) while the cut is applied
at the sampled cell with a 6-cell brush (scourHead, slides.ts:803-809; head frozen
at slides.ts:396-397, 769-770). Every flat cell up to a span inside a rim passes,
outnumbers the rim cells in a uniform draw, and has its band cut out of the top.

## The fix — diagnosis's option A (contract level)
A cell qualifies as a site only when ITS OWN one-cell drop (max over the fixed
`NEIGHBOUR_OFFSETS` order, terrain.ts:30-39) is at least a named fraction of the
sim's max legal per-cell gradient (`MAX_STEP + RELAX_SLACK`), AND the existing span
drop still holds (there is relief to run into). Because the head IS the qualifying
cell, the measured point and the cut point become the same point: the rim.

Specifics:
- New protocol constant(s) in `plugins/mudslides/protocol.ts` beside
  `MUDSLIDE_TRIGGER_STEEPNESS`, each with the doc style that file uses (what it
  is, why this value). Nothing hard-coded in terrain.ts/slides.ts.
- `slopeAt` (or a sibling it calls) does the local test in the same fixed
  neighbour order. Keep the returned `dx/dy` (on the wire? check) and fix the
  terrain.ts:164-167 doc claim the diagnosis found false, or make it true — say
  which in the report.
- Fix the slides.ts:242-246 doc claim ("scarp deepens") so it describes what the
  code now does.
- `dev.ts` forced-slide site scan (scanForSite :170-200) scores by run length with
  steepness as tie-break and steps on a 4-cell grid, so the dev fixture actively
  prefers cells set back from the rim. Make the dev fixture site selection use the
  same qualification contract as the survey (no second definition of "steep"), so a
  forced slide lands on a rim too. Keep its search-grid step a named constant; if
  the 4-cell step can miss a rim, say how you handled it.
- Recalibrate: `MUDSLIDE_TRIGGER_STEEPNESS`'s doc measures "one unlocked cell in
  forty" on the default-seed world. Re-measure the qualifying fraction under the new
  contract on the same world with a throwaway node script in your worktree's
  `.verify-301/` (never in $HOME, never committed) and rewrite the doc with the new
  number. If the frequency tiers in protocol.ts:60-110 depend on that fraction,
  say what changes and adjust only with a stated reason.
- Don't change the head-scour geometry (brush radius, bands per step, three steps)
  or the deposit ledger (slides.ts:848-861) — the diagnosis rejected that and the
  orchestrator agrees.

## Proof (required, in the report)
The diagnosis §4 proof, run with a node script against the server sim (no browser):
force a slide on a known plateau with a rim; record `heightAt` before/after along a
21-cell transect perpendicular to the rim (10 top / rim / 10 face) and the flow
event. Show: event head == the transect cell with the maximal one-cell downhill
drop (±1); most-negative delta at that cell ±1; every transect cell more than
`MUDSLIDE_BRUSH_RADIUS_CELLS` inside the rim has delta 0; volumeMoved same order of
magnitude as before the fix (run the same transect on the pre-fix commit for the
"before" column). Same-seed twice → byte-identical `event.cells`.

## Constraints
- Tests: do NOT add or write tests (owner rule). Existing must pass:
  `pnpm --filter <mudslides pkg> test` with a timeout; `pnpm typecheck`.
  NEVER `pnpm -r test`. If an existing test pins the old contract, report — don't
  rewrite it.
- Never start the app; the node script drives the sim directly (see how
  `plugins/mudslides/test/*` constructs a world, and reuse that shape).
- No new dependencies. No magic numbers. Don't touch `docs/**`, `.claude/**` except
  your report.

## Report
`.claude/orchestration/briefs/mudslide-301-fix-report.md`: commits, file:line for
every change, the transect table before/after, the recalibrated fraction, test +
typecheck tails, the worktree path and branch, anything left undone. Then stop.
