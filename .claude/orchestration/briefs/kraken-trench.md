# Brief — the kraken is confined to its trench (arc `kraken-trench`)

You are a fresh Opus implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/kraken-trench`
(branch `kraken-trench`, forked from main). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/kraken-trench" })`.
If `node_modules` is missing in the worktree, run `pnpm install --offline`
there (it can take several minutes on this drive; run it in the background
and poll). Paths below are relative to the worktree root. Commit to the
worktree branch as you go (conventional commits, first line < 72 chars, no
attribution footers, stage exact paths only). Do NOT merge to main. Do NOT
start or stop any app stack. Do NOT touch `docs/**`, `shared/**`,
`.claude/**` (except your report), or any plugin other than `plugins/monsters`.

## The owner's ask (verbatim)

> The kraken should not be allowed to roam the map. It needs to be confined
> to deep trench areas. It can move anywhere inside of that deep trench, but
> cannot move beyond it.

## The mechanism, verified from source this session (re-verify yourself, cite file:line)

- `plugins/monsters/server/kinds.ts` — `MonsterProfile.habitat` is
  `WATER_HABITAT` for both sea kinds (threshold `DEEP_WATER_BANDS_BELOW_SEA`
  = 3 bands). The kraken's row also carries `minLairReachBands:
  KRAKEN_LAIR_MIN_DEPTH_BANDS` (7 bands), and the doc on
  `minLairReachBands` says the habitat threshold "is the floor for every
  kind; a kind may demand more, and the kraken does."
- That demand is applied ONLY at admission: lair survey / summoning
  (`summoning.ts`, `habitat.ts` `reachesIntoHabitat`, the "arrivals scatter
  over qualifying cells" rule of 2026-08-19).
- Movement reads the FLOOR: `plugins/monsters/server/lurk.ts`
  `advanceMonster` / `isStranded` / `steerToValidHeading` all test
  `profile.habitat` via `isLairPose` / `isLairCell` (habitat.ts:308-400). So
  once summoned in a 7-band trench the kraken may swim out over any 3-band
  water — the whole open sea. That is the bug.

One-sentence root cause: a kind has two depth bars (the habitat floor and
its own reach demand) and the movement code only knows about the floor.

## The contract fix (do this, not a callsite patch)

- Give every kind ONE regime that answers "where may this animal BE":
  derive it on the profile from its own reach, e.g. a `range: HabitatRegime`
  (or your better name) built as `{ id: habitat.id, inward: habitat.inward,
  thresholdBands: minLairReachBands }`, computed in ONE place (a helper in
  kinds.ts) so a row cannot state the two inconsistently. For Cthulhu and
  the yeti `minLairReachBands` equals the habitat threshold, so their range
  is behaviourally identical to today — state that in a comment and make
  sure it is true from source (yeti: `YETI_LAIR_MIN_HEIGHT_BANDS` vs
  `SNOW_LINE_BANDS_ABOVE_SEA`).
- `lurk.ts` steers, strands and destination-checks against the kind's
  range, never the habitat floor. Review every `isLairPose` / `isLairCell`
  call in `lurk.ts` and decide each one on the range/floor question; write
  the reason in a comment at the callsite.
- CHECK identity uses of `HabitatRegime`: `kinds.ts` `KINDS_BY_HABITAT` and
  `LAIR_FIT_RULES_BY_HABITAT` are `Map`s keyed by the regime OBJECT, and
  `habitat-index.ts` holds one `RegimeIndex` per regime id. A derived range
  object must never be handed to something that looks a regime up by
  identity or by id-as-canonical. Keep `profile.habitat` for survey /
  summon / protection / index; use `profile.range` for movement.
- FIT RULES: `habitat-index.ts` / `habitat.ts` compute `fittingCells`
  (`isLairPose` per fit rule) — determine from source whether a fit rule
  tests the pose against the habitat floor or against the kind's reach. If
  it is the floor, a trench can admit a kraken whose 7-cell body never fits
  at 7-band depth, and the animal would spend its life in the pinched
  fallback (lurk.ts `clearance = 0`). Report what you find; if the fit rule
  is the floor, make the fit rule use the range too (it is the same
  question: "can this body be here") and say what that does to
  `KRAKEN_MIN_LAIR_FITTING_CELLS` admissions on a genesis trench (trench
  walls fall one band per cell — `docs/decisions/kraken.md` — so the 7-band
  floor of a capsule trench is the capsule minus a 4-cell rim). Do not
  retune constants without saying why in the report.
- Persistence (`persistence.ts`): a restored kraken that is outside its
  range must follow the existing stranded/absence path, not crash. Verify.
- Boats (`plugins/boats`) find the kraken by position; confinement does not
  change that. Do not edit boats.

## Tests

NO new test files and NO new test cases — the owner has not granted test
permission this session. Existing tests in `plugins/monsters/test` that pin
the old behaviour (kraken free in 3-band water) may be UPDATED to the new
contract; list every test you changed and why. Your report must name the
behaviours that are now UNTESTED because of the no-new-tests rule, so the
owner can grant permission for them.

## Verification (required before you report)

- `pnpm --filter @terrace/plugin-monsters typecheck` and
  `pnpm --filter @terrace/plugin-monsters test` green (scope to the package;
  root `vitest run` picks up other worktrees).
- `pnpm typecheck` at the worktree root green.
- A concrete demonstration in a Node script (not a test file; put it under
  `.claude/orchestration/briefs/kraken-trench-verify.mjs` or similar and
  delete it before your final commit): build a stand-in `LairWorld` with a
  3-band sea containing a 7-band basin, place a kraken inside, advance
  `advanceLurking` for 20 simulated minutes at 10 Hz with the plugin's RNG,
  and assert the kraken's centre never leaves the 7-band set; repeat with
  Cthulhu and confirm it still roams the 3-band sea. Paste the script's
  output in the report.

## Report

Write `.claude/orchestration/briefs/kraken-trench-report.md` in the
worktree and commit it: what changed (file:line), the fit-rule finding,
tests updated, behaviours left untested, the verification output, and any
constant you believe should move (with the argument, not the number).
Comments are claims, not evidence — every mechanism claim in the report
cites the line you read.
