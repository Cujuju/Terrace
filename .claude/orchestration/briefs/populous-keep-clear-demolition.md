# Brief: populous — a building's ground is cleared, not merely refused

Owner report 2026-09-02 (screenshot): a house and a hut each standing on top of
a teepee. Owner rule, restated today: "It's okay if teepees spawn on top of each
other, but nothing else should share a space."

## Verified diagnosis (primary source, this session)

- The owner's world (`server/data/worlds/frostwick-hollows.db`, plugin_settings
  `structures.model = populous`) has 3 buildings and 6 live cells inside their
  keep-clear discs — e.g. `{x:405,y:273,tier:2}` with tier-0 camps at
  (406,273), (405,274), (406,274). Scan script:
  `/tmp/claude-1000/-mnt-e-Development-Projects-Terrace/2787c1e5-66cf-4fdc-9bfa-0a0758ee2f3d/scratchpad/scan.mjs`
  (runs `node scan.mjs <db>`; separation squared = 25 cells²).
- `plugins/populous/server/model.ts` `stepPopulous`, pass two: an obstructed
  cell is HELD at `CLEARANCE_REFUSED_TIER = 0` and kept on the board. The
  Conway model (`plugins/structures/server/life.ts`, `clearKeepClearSquare`)
  DEMOLISHES every non-building cell within the disc when a cell steps
  0 → building. Populous never demolishes, so camps stay standing inside the
  building's footprint forever. GH #183 documents the same mechanism from the
  other side (camps held at 0 keep emitting settlers).
- `plugins/structures/server/index.ts` `canFoundStructure` already refuses a
  NEW founding inside a building's disc, so the only camps inside a disc are
  ones that pre-date the promotion (or an older save).

## Root cause, one sentence

The keep-clear rule's second half — "a building's ground is emptied of
everything but the building" — is enforced only inside the Conway CA's sweep,
so the populous model satisfies the predicate ("no OTHER building within
separation") while leaving camps standing under the building.

## The change (populous only; structures' seam is unchanged)

In `stepPopulous` pass two: an obstructed cell DIES this step (pushed to
`died`, absent from `nextLive`) instead of being held at tier 0.

- Applies every step, to every obstructed cell, regardless of its own tier:
  a camp in a standing building's disc (the owner's saved world) is demolished
  on the next generation; an older save's overlapping building pair collapses
  to one building. Under populous the tier pass is already re-evaluated every
  step against the whole board, so this is not a new retroactivity — it is the
  same question with a different answer. (The Conway model's "never reconcile
  old saves" decision belongs to its survival rule, which never consults
  clearance; do not touch life.ts.)
- Tie-break stays the ascending-key walk: the obstruction is asked of
  `nextLive` (already decided, new tiers) and `undecided` (not yet reached, old
  tiers), exactly as today. Document honestly in the doc comment that when two
  BUILDINGS arrive overlapping, the higher key survives (the lower is reached
  first and sees the higher one still standing), whereas among CAMPS climbing
  together the lower key is promoted first and the rest die. Residual: in a
  three-deep old-save pile, a cell can die to an obstruction that itself dies
  later in the same step; the board still ends with no overlap, at the cost of
  one extra demolition. State this in the comment.
- Delete `CLEARANCE_REFUSED_TIER`. Rewrite the "HELD AT 0, NOT DEMOLISHED"
  block and the header's "A HOUSE DIES ONLY FROM THE TERRAIN" bullet: there are
  now two deaths — the ground stops being ground, or the ground is claimed by a
  building's keep-clear disc. Cite the owner's 2026-09-02 rule. Also fix
  `plugins/structures/server/growth-model.ts`'s `hasBuildingWithinSeparation`
  doc if it describes the held-at-0 behaviour (read it; only change what is
  now false).
- Deaths must keep DETERMINISTIC, integer-only, fixed order (CLAUDE.md).
- `died` for these cells goes out through the existing
  `broadcastChanges` / `changes` event path in structures' `advanceGrowthModel`
  — verify (read `plugins/structures/server/index.ts` ~lines 395–440 and
  `plugins/populous/server/index.ts`) that nothing downstream assumes populous
  deaths are terrain-only. Report what you found with file:line.

## Tests — permission scope

The owner grants NO new tests. Existing tests in
`plugins/populous/test/populous.test.ts` ("buildings never stand within the
separation of one another", ~line 393 on) encode the held-at-0 behaviour and
must be updated to assert the new rule (one building, the other three
demolished; the "still fills and emits from the cells it held at tier 0" case
no longer describes a real state — rewrite it to assert the demolished cell is
in `died`, do not add a new `it`). Keep the count of `it` blocks the same or
lower. Update comments in those tests to match.

## Verify (all with a timeout, never the whole workspace)

1. `timeout 120 pnpm --filter ./plugins/populous test` and
   `timeout 120 pnpm --filter ./plugins/structures test` (structures has a
   growth-model seam test; it must still pass).
2. `timeout 300 pnpm typecheck`.
3. Primary-source check: a scratch script (put it in the scratchpad dir above,
   NOT in the repo, NOT in $HOME) that loads the latest `structures` slice from
   `frostwick-hollows.db` (better-sqlite3 from `server/node_modules`;
   slice JSON is `{v, data:{live:[{x,y,age,tier,population}]}}`), runs
   `stepPopulous` once with a context whose `isBuildable` is always true,
   `maxTier` 5 and `hasBuildingWithinSeparation` = structures'
   `clearance.ts` implementation (import it from the worktree via
   `node --experimental-strip-types` or tsx, whichever the repo already runs
   tests with), and asserts the scan's violation count on `nextLive` is 0
   while the 3 buildings survive. Paste the script's output in your report.

## Constraints

- Work only in your worktree. Commit there with a conventional-commit message,
  first line < 72 chars, NO Claude attribution and NO "Generated with" footer.
  Stage exact paths only. Then `ExitWorktree` with `action: "keep"`.
- Do not edit `docs/DESIGN.md` or `docs/decisions/*`.
- Do not start or stop the server or client.
- Comments are claims, not evidence: every claim in your report carries a
  file:line you read this session.
- Report: the diff summary, test output, typecheck output, the step-3 script
  output, and the branch name.
