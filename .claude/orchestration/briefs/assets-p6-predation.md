# Brief 6A: wolves hunt the deer (#337)

Repo: /mnt/e/Development/Projects/Terrace. You run in your own git worktree (harness-created;
`pwd` and `git branch --show-current` first; use that root for EVERY command — never `cd` to
the main checkout, never edit it). Commit on the branch; do not merge or push.
GitHub issue: Cujuju/Terrace#337. Time box: 90 minutes wall clock; if you are not at D4 by
60 minutes, commit what compiles and report where you are.

Owner, 2026-09-05: "wolves should hunt the deer." The wolf shipped in 95aa817 with no
predation; plugins/wildlife/server/species/wolf.ts L10–15 records that as decided-then and
must now be rewritten to record this decision instead (do not delete the history — restate
it: "decided 2026-09-04 not to; owner asked for it 2026-09-05").

## The design — decided by the orchestrator, argued below; implement it, do not redesign it.
Where a number below says "argue", pick it and write the argument at the constant.
If a decision below is contradicted by something you read in the code, STOP and say so in the
report rather than silently choosing.

1. **Base: the existing `Predation` contract** (server/species/profile.ts ~L640–672,
   consumed by movement.ts `applyPredatorAlarms` ~L860–870). The wolf declares
   `hunts: { preySpecies: ['grazer'], alarmRadiusCells: WOLF_ALARM_RADIUS_CELLS }`. That alone
   makes deer bolt directly away from a wolf at FLEE_SPEED_MULTIPLIER × 0.8 = 2.4 cells/s
   for FLEE_DURATION_SECONDS, re-armed every tick they remain inside the radius (startleNear
   never shortens a panic — verify at movement.ts ~L903–960). Prey list is the grazer ONLY:
   the bison is a herd animal with a group startle and the ibex lives where a plain walker
   cannot follow; both are named punts, not omissions.

2. **Extension: pursuit, opt-in per hunter.** Add an optional `pursuit?: Pursuit` field to
   `Predation` (NOT a second field on SpeciesProfile — a hunter has one predation rule).
   `Pursuit` = `{ detectRadiusCells, speedMultiplier, catchRadiusCells, maxSeconds,
   restAfterMissSeconds, restAfterKillSeconds }`. The shark declares no `pursuit` and must
   behave bit-for-bit as today; that is what makes the field optional rather than defaulted.

3. **Numbers** (state each as a named constant in species/wolf.ts with its argument):
   - `WOLF_DETECT_RADIUS_CELLS = cellsAcross(6)` — six wolf body lengths; the animal that
     "covers ground" sees far. Twice the alarm radius (below), and the gap is the mechanic:
     the wolf closes at cruise-vs-cruise (1.0 vs 0.8) before the deer notices.
   - `WOLF_ALARM_RADIUS_CELLS = cellsAcross(3)` — the shark's figure (species/shark.ts
     SHARK_ALARM_RADIUS_CELLS) for the same reason it gives: a grazing head is down. Do NOT
     import the shark's constant; the two are the same number for the same argument, not one
     number shared, and a shark retune must not move the deer.
   - `speedMultiplier = FLEE_SPEED_MULTIPLIER` (3, imported from movement.ts) — a hunting
     wolf is at burst exactly as a fleeing deer is: same physics, one constant, argued at the
     use site. Burst 3.0 vs the deer's 2.4 closes at 0.6 cells/s. The ibex (1.2) stays the
     fastest CRUISING land animal; the burst is a state, not the row's speed.
   - `catchRadiusCells = cellsAcross(1.0)` — one wolf body length (its bodyLengthCells).
   - `maxSeconds` — ARGUE between 4 and 6 s. From 6 cells the wolf reaches the 3-cell alarm
     line in ~1.4 s (closing ≥2.2 with the deer walking) and then needs ~3.3 s more to close
     the last 2 cells at 0.6/s; ~4.7 s in open ground. Pick a value that makes a deer detected
     at the EDGE of the detect radius a coin flip and a deer at 4 cells a kill, and show the
     arithmetic. A hunt that never fails is a magnet, not a hunt; one that never succeeds is
     the shark.
   - `restAfterKillSeconds = 120` — SATIETY, and it is the population governor: one kill per
     wolf per two minutes at most. Argue against population.ts SPAWN_MEAN_WAIT_SECONDS (20),
     HABITAT_LOSS_RESPAWN_DELAY_SECONDS (8) and NATURAL_LIFESPAN_SECONDS (300): the deer's
     respawn credit hatches long before the wolf hunts again, so the deer population sits at
     target minus at most (wolves × 1) in steady state. Also state the cost on the smallest
     real island (FOUNDING_POPULATION wolves vs the island's deer target — census.ts
     targetsFor; compute it).
   - `restAfterMissSeconds` — ARGUE, ~20 s: winded, and long enough for the deer that
     escaped to leave the detect radius at cruise. A wolf that re-locks the same deer the tick
     after missing it is a dog on a lead.

4. **Outcome: a KILL removes the deer through `despawnWithCredit`** (population.ts ~L698).
   This is the machinery habitat loss uses, so the removal is regulated by the census: the
   credit ripens after HABITAT_LOSS_RESPAWN_DELAY_SECONDS and hatches at the
   SPAWN_MEAN_WAIT_SECONDS hazard. That answers the "second, unregulated drain" argument in
   the `Predation` doc comment (profile.ts ~L650–655) — REWRITE that comment: the alarm is the
   base every hunter has; pursuit is the opt-in extension; a kill is a credited despawn, not a
   drain; the shark still kills nothing. Keep every fact in the current comment that is still
   true.
   Wire: NOTHING CHANGES. WildlifeEntityState (protocol.ts L177–200) is untouched; the deer is
   absent from the next push and the client drops it (client/interpolation.ts ~L82 — cite the
   line after reading it), exactly as natural turnover has always looked. No carcass, no death
   animation, no `hunting` flag on the wire — named punts; the payload stays 58 B.

5. **Engine state** on `WildlifeEntity` (population.ts L99–165): whatever the pursuit needs
   (target id, seconds remaining in the chase, rest seconds remaining) follows the `idle`
   field's three rules — ALWAYS PRESENT (initialised at spawn for every species), NEVER ON THE
   WIRE, NOT PERSISTED (persistence.ts: restored wolves start calm; say so in a ≤30-word
   comment, and check the persistence round-trip test still passes). Prefer one nullable
   sub-object over three loose fields if it reads cleaner — your call, argued in one line.

6. **Determinism and tick order** (project CLAUDE.md; movement.ts `advanceMovement`,
   `advanceEntity` ~L690–800):
   - Target selection: the nearest living prey inside detectRadius by squared distance, ties
     broken by LOWER entity id, chosen from the START-of-tick snapshot (the same discipline
     `occupants` and `applyPredatorAlarms` keep and explain). A locked target is kept until it
     dies, leaves detectRadius × some named slack, or maxSeconds expires — no re-targeting
     mid-chase to a nearer deer.
   - Steering: the pursuing wolf's `desired` heading is the bearing to the target's snapshot
     position, in place of `wander`, and it then goes through the SAME ladder (steerThisTick,
     turnToward, the destination re-check) — a wolf cannot cross a slope or leave land to
     catch a deer, and the turning circle still applies. `speedOf` returns burst while
     pursuing. Flee wins over hunt: a wolf with fleeSecondsRemaining > 0 (fire) drops the
     chase. Idle is cancelled by a chase the way flee cancels it (advanceIdleState).
   - Catch: resolved AFTER all movement, from END-of-tick positions, in the same pass as
     `applyPredatorAlarms` (or immediately adjacent to it — argue the order between alarm and
     catch in one line). Collect kills first, then despawn by descending index so splices
     cannot shift a pending index. Two wolves on one deer: the deer dies once; both wolves
     become sated (a pair shares the kill).
   - No `shared/` edits. If you think you need one, stop and say why in the report.

7. **Pack**: unchanged — groupSize 2, solitary schooling odds (species/wolf.ts). A pair that
   locks the same deer is the whole pack behaviour; anything more is a named punt.

## Read first — verify against code, cite file:line in your report. Comments are claims.

1. server/species/profile.ts (`SpeciesProfile`, `Predation`, `IdleBouts`), species/shark.ts
   (the worked predation row), species/wolf.ts (every existing argued number), species.ts
   grazer row ~L175–238 (speeds, FLEE relations, the population-cap paragraph).
2. server/movement.ts whole file — `speedOf`, `advanceIdleState`, `advanceEntity`,
   `advanceMovement`, `applyPredatorAlarms`, `startleNear`, `StartleOptions`; how `occupants`
   snapshots are built; `rollEvent`/`randomSigned` in rng.ts (use the plugin's RNG, never
   Math.random).
3. server/population.ts L1–60 (design header), L99–230 (entity + credit constants),
   `reconcileToTargets`, `despawnWithCredit`, `despawnInvalidHabitat`, `spawnGroup` (where
   the entity is initialised — your new field goes there), persistence.ts (what is and is not
   serialized, and why).
4. server/index.ts `simulate` ~L232 (tick order) and the header's bandwidth paragraph
   (why nothing goes on the wire); census.ts `targetsFor`, FOUNDING_POPULATION,
   MIN_FOUNDING_HABITAT_CELLS.
5. test/wildlife.test.ts — grep `shark`, `startle`, `flee`, `persist`, `idle` to know which
   existing tests pin the behaviour you are extending. DO NOT ADD TESTS (no permission this
   session). If an existing table-driven test needs the wolf's new field to typecheck, that
   edit is allowed — say so.
6. client/interpolation.ts ~L40–90 — confirm how an entity absent from a push is handled.

## Deliverables

D1. `Pursuit` on `Predation` (profile.ts), engine state on `WildlifeEntity`, pursuit +
    catch in movement.ts, initialisation at spawn, persistence untouched but re-verified.
D2. species/wolf.ts: header rewritten, `hunts` declared with the constants in §3, every
    number argued. profile.ts `Predation` comment rewritten per §4.
D3. **Behaviour proof, headless** — the preview harness cannot show a hunt and in-game
    eyes-on is #322's. Write a scratch script (NOT committed, NOT a test; put it in the
    worktree's `.scratch/` or /tmp) that builds the test world the way test/wildlife.test.ts
    does (reuse its support/ helpers), seeds wolves and grazers on open land, runs `simulate`
    for 600 simulated seconds at the shipped dt, and prints: pursuits started, kills, misses,
    mean chase length, min/mean grazer count over the run vs its target, and the shark's
    per-tick behaviour unchanged (fish startled count with and without your change on the same
    seed — same number). Paste the output in the report. If kills are 0 or misses are 0,
    the numbers in §3 are wrong for this world — tune `maxSeconds` within its range first,
    then report what you found rather than widening other constants.
D4. `pnpm typecheck` clean; run ONLY `pnpm --filter @terrace/plugin-wildlife test` under
    `timeout 300`. Never `pnpm -r test`. Report counts before and after.
D5. Report at .claude/orchestration/briefs/assets-p6-report.md: every constant with its
    argument; file:line for every hook (target select, steer, speed, catch, despawn, spawn
    init, persistence); the D3 output; tests run and counts; the punts (bison/ibex prey,
    carcass/animation, wire flag, pack behaviour, docs/decisions/wildlife.md entry — the
    orchestrator writes that with the owner); anything assumed labelled "Assumption:"; and
    the one decision the owner may want to reverse (kill vs chase-only) with the exact
    one-line change that reverts it.

## Rules

- Never start or stop the game server/client.
- `git add` exact paths only. Conventional commits, no attribution lines. No new
  dependencies. Comments ≤30 words unless they replace an existing longer argued comment
  (profile.ts/wolf.ts headers keep their style: argued, not chatty). Constants named and
  argued; no magic numbers.
- Do not touch docs/DESIGN.md or docs/decisions/. Do not touch client/ except to READ.
- Another session appends species to protocol.ts / species.ts / previewSpecies.ts — you
  should not need to edit those files at all; if you do, keep it additive.
- Do not delete existing comment lines to make room; restate them.
