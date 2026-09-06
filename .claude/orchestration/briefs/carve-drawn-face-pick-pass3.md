# Brief: drawn-face pick — pass 3 (finish, verify, commit)

Continues `.claude/orchestration/briefs/carve-drawn-face-pick.md` (read it
first: root cause, contract, rules of evidence). Two passes are committed on
branch `worktree-agent-a42f5a7333fa2da14` in worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a42f5a7333fa2da14`:

- `952a868` riser picks resolve against the overlay's drawn lip segments
  (`client/src/terrain/drawnFace.ts`, `picking.ts:refineRiserToDrawnFace`,
  `DrawnRisers` provider satisfied by `layerEdgeOverlay.ts:segmentsOf`, wired
  in `world.ts`).
- `761df5f` ledge events for multi-band staircases; no-segments ⇒ box hit;
  neighbour-tread fallback ordered against the foot contour (`footT`).

A third pass was in flight when the previous agent was stopped. Its
UNCOMMITTED edits are in that worktree (`git -C <wt> status`): `contours.ts`,
`capEmission.ts`, `capPlanFlat.ts`, `picking.ts`. Read the diff
(`git -C <wt> diff`) before writing anything: keep what is correct, finish
what is not. Do not start a new worktree. All git commands: `git -C <wt> …`.
Work only in that worktree; never touch the main checkout's files.

## Rules of evidence
Comments are claims. Cite file:line you verified this session for every
fact. No new tests (owner permission not granted). Do not touch `shared/` or
`docs/`. No screenshots (owner: skip eyes-on). Report failures faithfully.

## The three pass-3 defects (from the orchestrator's review of 761df5f)

1. **Cap-hit parity gate.** `refineRiserToDrawnFace` also runs for a
   horizontal box-cap hit (`terrainHitInCell`: `refinable = hit.hitRiser ||
   hit.hitY === hit.surfaceY`). Without deciding whether the box cap point is
   on the DRAWN cap, a true tread hit continues underground and any
   `highestBand` contour inside the ±0.5-cell window crossed at a height in
   [(b−1)·slab, b·slab] becomes a bogus riser hit behind the surface (narrow
   ridge, mesa corner, notch). Fix: for a cap hit, before walking events,
   count intersections of the 2D segment from the cell's own centre to
   (hitX, hitZ) with every `highestBand` segment in the window. The centre is
   inside by construction (marching squares classifies it by the cell's own
   quantised height; `CONTOUR_CELL_CENTRE_GUARD` keeps vertices off it — cite
   `contours.ts`). Verify the centre's world coordinate against
   `scaleRayToCellSpace`'s +0.5 convention (cite the line). Even ⇒ true
   tread ⇒ return the box hit unchanged. Odd ⇒ strip ⇒ walk events.
2. **Fallback for strip cap hits.** Remove `if (!hit.hitRiser) return hit;`
   before `treadOfEnteredNeighbour`; keep the `footT` bound and the
   `footT === Infinity ⇒ box` guard. A strip cap hit with no event at steep
   pitch (ray reaches the lower neighbour's cap plane before the band's
   contour) resolves as that neighbour's tread.
3. **One seam predicate.** `capPlanFlat.ts` (lip store) skipped a segment
   when both endpoints touched the chunk rect at all; `capEmission.ts` (skirts)
   skips only when both endpoints share the SAME edge (`(a.rect & b.rect) !==
   0`). A straight wall crossing a chunk was drawn but had no lip. Fix: one
   exported predicate in `contours.ts`, used by both. The previous agent
   started this — check the diff, finish or correct it.

## Verify (headless only)
Probe file: `/mnt/e/Development/Projects/Terrace/.agent-stack/carve-verify/probe/carveProbe3.test.ts`
(run from `<wt>/client` with `timeout 400 npx vitest run --dir
/mnt/e/Development/Projects/Terrace/.agent-stack/carve-verify/probe`; it
writes `probe.txt` beside itself). Its imports must point at the WORKTREE's
`client/src` — check and fix the absolute paths at the top. Add:
- (a) 2-cell-wide ridge at band 8 on band-5 ground; aim at the true tread
  just past the near contour, pitches 45/60/75, azimuths 0/30/60: pick must
  be the cell's tread, `hitRiser=false`, `hitY = cap`, identical to the box
  result. Show it FAILS on 761df5f (stash or `git stash` is fine inside the
  worktree — restore after) and passes after.
- (b) 1-band step: aim in the 0.375-cell strip at pitch 75/80: expect the
  lower neighbour's tread.
- (c) straight wall crossing a whole chunk: segments built the way
  `layerEdgeOverlay.rebuild` builds them (via `drawnGround.chartOf` or
  `capPlanFlat`'s emitter) contain the wall after fix 3, not before.
Paste every section summary line (A–H plus the new ones).

`cd <wt>/client && timeout 400 npx vitest run` counts (was 38 files / 580
tests passing). `pnpm typecheck` from `<wt>`.

Commit on the worktree branch (conventional commit, no attribution
trailers). Do not merge. Report: root cause in one sentence; diff summary;
probe summary lines; test/typecheck results; residuals (chunks without
segments ⇒ box; `hitY` exactly on a band boundary; the lower-cell cap plane
case from the pass-2 report, unchanged); assumptions labelled.
