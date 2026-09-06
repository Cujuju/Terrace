# Brief: river rebuild under the frame budget (#343)

You are implementing, in a git worktree, the plan at
`/mnt/e/Development/Projects/Terrace/.claude/plans/river-rebuild-frame-budget.md`.
Read it first, in full. Then read, in full, before editing anything:

- `docs/decisions/rivers-and-water.md` (section "Decisions made 2026-08-26")
- `client/src/render/riverRig.ts` L543–L900 (buffer/run bookkeeping,
  `regionNeedsReemit`) and L1229–L1599 (`rebuild`, `startCompute`, `refresh`)
- `client/src/render/water/waterTread.ts` (all)
- `client/src/render/water/waterCurtain.ts` L180–end
- `client/src/render/terrainMeshes.ts` L170–L232, L596–L620, L1526–L1560,
  L1680–L1730 (the drain/budget/clock pattern you are matching)
- `client/src/terrain/contours.ts` L200–L330 (scratch precondition)

## Where you work

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/river-rebuild-frame-budget`
(branch `river-rebuild-frame-budget`, off main at 023c19f). Every command
runs against that path (`git -C <worktree> …`, `pnpm --filter client …` from
inside it). Never touch `/mnt/e/Development/Projects/Terrace` itself except
to read the plan and the profile files named in it.

## Rules (binding)

- Comments are claims, not evidence. Every cost or behaviour claim in the
  plan and in code comments must be verified by you against file:line before
  you act on it; your report cites file:line for each verification.
- Do NOT write or add tests. Test permission is granted per session by the
  owner and has not yet been granted for this session; the plan's "Contract
  tests" section is for a later phase. Run the EXISTING tests only.
- Do NOT edit anything under `docs/`. Do not relitigate `docs/DESIGN.md` or
  `docs/decisions/rivers-and-water.md`.
- No `any`, no magic numbers (every literal is a named constant with a doc
  comment giving the arithmetic), no new dependencies, no comments longer
  than 30 words except where you are replacing an existing longer one that
  is now false.
- Never delete existing comments; update ones that become false (the
  SCRATCH DISCIPLINE paragraph on `appendRegionSurface`, the PASS THREE and
  "vanished regions" comments in `rebuild`, the `regionNeedsReemit` doc if
  it is deleted).
- `shared/` is untouched. Nothing on the wire changes.
- Do not start or stop the app or the rig. Do not run `pnpm -r test` or the
  whole workspace; run only
  `pnpm --filter client exec vitest run test/waterTread.test.ts test/waterCurtain.test.ts test/waterFallIntegration.test.ts`
  (with `timeout 300`) and `pnpm --filter client typecheck` (or the
  workspace script `pnpm typecheck` if the client has none).

## Deliverables, in order

1. Section A of the plan (per-(band, tile) runs; only affected tiles re-emit).
   Commit: `perf(water): re-emit water per tile, not per band`.
2. Section B (queue drained under `WATER_TILE_FRAME_BUDGET_MS` with injected
   `now`, carry-over on a mid-drain answer). Commit:
   `perf(water): drain water tiles under a per-frame budget`.
3. Section C: measure PASS ONE/PASS TWO/splice separately. The owner's world
   snapshot for the bench may not exist on this machine
   (`~/.terrace-perf/snapshot.owner.json`); if it does not, measure on the
   cone fixture scaled to a 512² world with `MAX_SPRINGS_PER_NETWORK` springs
   and say so. Apply the plan's decision rule; commit only if you slice PASS
   TWO. Record the numbers in your report either way.
4. Commit each step separately on the worktree branch, staging only the
   exact paths you changed. No attribution trailers, conventional commits,
   first line < 72 chars.

## Report (final message)

- For each cost/behaviour claim in the plan you relied on: verified at
  file:line, or "found different: …".
- The `appendCurtains` per-tile check result (plan §A bullet 3).
- Measured numbers from step 3 and the decision taken.
- Typecheck and test output (verbatim pass/fail lines).
- Commit hashes on the branch.
- Anything left undone, with the reason.
