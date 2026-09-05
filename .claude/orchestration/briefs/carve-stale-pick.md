# Brief: a carve digs the band below on the second press (stale hover pick)

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/carve-stale-pick`
(branch `carve-stale-pick`). Work ONLY there. Commit to that branch. Do not
touch the shared checkout.

## Symptom (owner, 2026-09-04)
Carve tool, pointer on the riser of band k. First press carves band k. Second
press, MOUSE NOT MOVED, carves band k−1 instead of continuing forward through
band k. Same thing happens across a held stroke's repeats.

## Root cause (verified from source this session — re-verify file:line yourself)
`hoverTarget` in `client/src/input/sculptInput.ts` (~line 409) caches the pick
on pointer+camera only. When the ground under a still pointer changes, its
refresh branch (~line 441–471) re-reads the cap of `hoverCache.spanIndex` and
keeps `spanIndex`, `hitRiser`, `hitY` as "facts about the ray".

After a carve the column is SPLIT: span 0 is now the lower piece capped at
`(k−1)·BAND_HEIGHT`, span 1 the roof. The cached riser hit still says
`spanIndex: 0, hitY ∈ [(k−1)·BH, k·BH]`. `bandOfPick` (`client/src/world.ts`
~line 459) then takes `spanAt(…, 0)` = the lower piece, computes
`struck = ceil(hitY/…) = k`, and CLAMPS to that span's drawn range whose
`highestDrawn = k−1`. So `carveBand` answers k−1 and the next intent opens the
band below. One sentence: the hover cache refreshes a pick's height but keeps a
`spanIndex` that no longer names the span the ray struck, and the clamp in
`bandOfPick` silently converts that dead claim into the band below.

`spanIndex` is exactly the kind of value `shared/src/columns.ts` (~line 379)
warns about: an index into a list whose length is state.

## Fix (contract level, in `hoverTarget`)
A cached pick whose named span no longer contains what the ray struck is not
refreshable — it must be RE-PICKED (`hoverCache = pickCell()`), the same path
already taken when `spanCapAt` returns null. Concretely, in the refresh branch:
- For a riser hit (`hitRiser`), the cached pick is still valid only if the span
  at `spanIndex` still spans `hitY` — its drawn slab range (use the same
  `spanUndersideHeight`/`spanCapHeight`-derived bounds `bandOfPick` uses, via a
  World method if the input layer cannot read the map directly; sculptInput
  only sees World through its deps object, so add a small World method if
  needed, e.g. `spanContainsHeight(x, y, spanIndex, worldY)` or fold the check
  into `spanCapAt`'s neighbour). If not, re-pick.
- Also re-pick if the column's span COUNT differs from when the pick was taken
  (store it on the cache entry, or expose `spanCount` through World) — a split
  or a weld invalidates every index in that column, tread hits included.
- A tread hit whose span merely moved up/down keeps today's refresh (that is
  the issue-#25 / 2026-08-22 behaviour and must NOT regress: a held raise must
  not march uphill, a lowered ring must follow the ground).

Keep the change minimal: no new features, no re-picking on every terrain
change. Do NOT change `bandOfPick`'s clamp (it is still right for a boundary
hit) and do not touch `applyCarve` in shared/.

Update the comment blocks you invalidate in `hoverTarget` (the "hitRiser,
spanIndex and the hit POINT ride along" paragraph is now only half true) —
precise, no essays. Never delete existing lines/comments except where the
statement is now false; rewrite those.

## Rules
- No new tests (owner rule, per session). No new dependencies.
- `pnpm typecheck` from the worktree root must pass. Run `cd client && timeout
  240 npx vitest run` and report results (expect pre-existing failures in
  packages you did not touch; say which).
- Conventional commit, e.g. `fix(carve): re-pick when the struck span no longer
  contains the hit`. No attribution trailers.
- Report: file:line of the change, the exact rule you implemented, typecheck
  and vitest output summary, and any residual failure mode you see (in
  particular: after a correct re-pick, a fresh ray that lands on the TUNNEL
  FLOOR (tread of the lower piece) names band k−1 via `bandOf(spanCapHeight)`
  — say whether that can happen from the isometric camera, do not fix it).
