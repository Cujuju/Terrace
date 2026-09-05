# Brief 6A report: wolves hunt the deer (#337)

Branch `worktree-agent-a2bb7ef68d61c3036`. `pnpm typecheck` clean across the
workspace; `pnpm --filter @terrace/plugin-wildlife test` 48/48 in 5 files,
before and after (no test was added — see "Test edits" below).

## The constants, and the argument for each

All stated in WORLD UNITS (`cellsAcross` converts; `WORLD_UNIT_CELLS = 4`), which
is how the rest of the species table is written. The two facts everything derives
from: a deer cruises 0.8 and bolts at 0.8 × 3 = 2.4; a wolf cruises 1.0 and bursts
at 3.0. The hunt is that 0.6 u/s gap.

| Constant | Value | Argument |
| --- | --- | --- |
| `WOLF_DETECT_RADIUS_CELLS` | `cellsAcross(6)` | Six body lengths; the animal that covers ground sees over it. Twice the alarm radius, and the gap IS the mechanic: 6 → 3 the deer has not noticed and the wolf closes at 2.2–3.8 u/s, so the first half of every hunt is a visible stalk. |
| `WOLF_ALARM_RADIUS_CELLS` | `cellsAcross(3)` | The shark's figure for the reason the shark gives — a grazing head is down. Typed out, NOT imported from `shark.ts`: same number, same argument, not one shared number; a shark retune must not move when a deer notices a wolf. |
| `speedMultiplier` | `FLEE_SPEED_MULTIPLIER` (3) | A hunting wolf is at burst exactly as a fleeing deer is: same physics, one constant. 3.0 vs 2.4 = the 0.6 u/s closing rate. The ibex (1.2) remains the fastest CRUISING land animal — a burst is a state, not a row value. |
| `WOLF_CATCH_RADIUS_CELLS` | `cellsAcross(1.0)` | One wolf body length — the `bodyLengthCells` this row declares. The animals are touching; the kill lands where a watcher would already have called it. |
| `WOLF_CHASE_MAX_SECONDS` | **4.0** | See below — the one number I measured rather than derived. |
| `WOLF_REST_AFTER_KILL_SECONDS` | 120 | Satiety, and the population governor. |
| `WOLF_REST_AFTER_MISS_SECONDS` | 20 | Winded, and the duty cycle. |
| `PURSUIT_LOSE_RADIUS_SLACK` (movement.ts) | 1.5 | Hysteresis: a target on the detect line would otherwise unlock and re-lock every tick. Ends the chases the terrain already decided; `maxSeconds` is what ends the rest. |

### `maxSeconds` = 4.0 — argued in the 4–6 range, then measured

Model, from the speeds above. **Stalk** 6 → 3 units: deer at 0.8 in whatever
direction it was already going, so closing is 3.8 head-on / 2.2 straight away /
3.0 mean → 0.8–1.4 s. **Run** 3 → 1 unit: deer bolting directly away at 2.4, so
closing is 0.6 → 2 / 0.6 = 3.33 s. From the edge: **4.1 s best, 4.7 s worst**.
From 4 units: 3.6–3.8 s. The model therefore says ~4.5 makes the edge a coin flip
and 4 units a kill.

**The model is a floor, not the answer.** It gives the deer an unobstructed
straight line away; a real deer is deflected by the ground and by the other deer
whose personal space it has to respect, so its escape speed is under 2.4 and real
chases close faster. Measured on the D3 world (below), 600 s, ~25 wolves, ~515
deer, kill rate by lock distance:

| lock distance | at `maxSeconds` 4.5 | at 4.0 (shipped) |
| --- | --- | --- |
| 3–4 units | 87% | 92% |
| 4–5 units | 75% | 65% |
| 5–6 units (the edge) | **82%** | **51%** |
| totals | 125 kills / 26 misses | 117 kills / 53 misses |

4.5 is a magnet — a deer inside the detect radius is 82% dead even at the limit.
4.0 gives exactly the shape the brief specifies: a coin flip at the edge, a kill
well inside. Shipped 4.0. **This is the first number to move if eyes-on disagrees,
and it should be moved against a measured rate, not by feel.**

### `restAfterKillSeconds` = 120 against the census's clocks

A caught deer leaves through `despawnWithCredit`, so its credit ripens after
`HABITAT_LOSS_RESPAWN_DELAY_SECONDS` (8) and hatches at the
`SPAWN_MEAN_WAIT_SECONDS` (20) hazard: **~28 s back on average**, less than a
quarter of the rest. The replacement always arrives long before the wolf that took
it hunts again, so in steady state the deer sit at target minus at most
(wolves × 1) and never decline. D3 confirms: target 526, mean 512.2, min 491, with
~25 wolves — a deficit of ~14 against a bound of 25. Against
`NATURAL_LIFESPAN_SECONDS` (300), predation is by a wide margin the smaller force
on any deer's life.

**Cost on the smallest island that has animals at all**, computed:
`MIN_FOUNDING_HABITAT_CELLS` = `cellsOverArea(64)` = 1 024 cells is below both
densities (a deer wants `cellsOverArea(100)` = 1 600 cells, a wolf 32 000), so
`targetsFor` hands each species its `FOUNDING_POPULATION` of 2 — **two wolves and
two deer**. Two wolves take at most one deer per 60 s, each absent ~28 s, so the
island carries ~1.5 of its 2 deer and is briefly down to one. That is why the
number is 120 and not 30: at 30 the same island would sit near 1 and read as a
place deer cannot live.

### `restAfterMissSeconds` = 20

The deer that escaped is inside the detect radius at the instant the chase times
out, by construction, so a short rest re-locks it immediately — a dog on a lead.
In 20 s the deer covers the rest of its `FLEE_DURATION_SECONDS` at 2.4 and then 16
units at cruise: several detect radii from a wolf wandering at 1.0, so the pair
have to meet again by chance rather than by momentum. It is also the duty cycle —
4 s of chase against 20 s of rest is at most 17% of a wolf's life at burst, so the
burst still reads as an event. A quarter of the kill rest, which is the right
ordering: a full wolf has a reason not to hunt, a winded one only needs its breath.

## Every hook, file:line (post-change)

| Hook | Where |
| --- | --- |
| `Pursuit` contract + `pursuit?` on `Predation` | `plugins/wildlife/server/species/profile.ts:699` (`Predation`), `:734` (`Pursuit`) |
| `Predation` doc rewritten (§4) | `plugins/wildlife/server/species/profile.ts:664-698` |
| `FLEE_SPEED_MULTIPLIER` relocated | `plugins/wildlife/server/species/profile.ts:189-203`; re-exported `movement.ts:115` |
| Engine state on `WildlifeEntity` | `plugins/wildlife/server/population.ts:155-190` |
| Spawn init | `plugins/wildlife/server/population.ts:606-609` (`spawnGroup`) |
| Persistence init + doc | `plugins/wildlife/server/persistence.ts:34-37`, `:163-169` |
| Speed (burst while chasing) | `plugins/wildlife/server/movement.ts:246` (`speedOf`) |
| Idle cancelled by a chase | `plugins/wildlife/server/movement.ts:680` (`advanceIdleState`) |
| Steer (bearing replaces wander) | `plugins/wildlife/server/movement.ts:757-767` (`advanceEntity`) |
| Target selection | `plugins/wildlife/server/movement.ts:1013` (`nearestPrey`), `:1059` (`resolvePursuits`) |
| Separation exemption for the target | `plugins/wildlife/server/movement.ts:980` (`huntingOccupants`) |
| Catch + despawn | `plugins/wildlife/server/movement.ts:1125` (`resolveCatches`) |
| Tick wiring, alarm-then-catch | `plugins/wildlife/server/movement.ts:880-902` (`advanceMovement`) |
| Wolf row | `plugins/wildlife/server/species/wolf.ts:82-264` (the hunt section), `:249` (`WOLF_PREDATION`), `hunts:` at `:307` |
| Client drops an absent entity (unchanged) | `plugins/wildlife/client/interpolation.ts:82` |

Determinism: target selection is nearest-by-SQUARED-distance with ties broken by
the LOWER id, from the start-of-tick snapshot `advanceMovement` already builds for
schools and occupants; kills are collected first and despawned by DESCENDING index
so a splice cannot shift a pending one; two wolves on one deer kill it once and
both are sated. No `shared/` edit was needed.

## The one deviation from the brief, and why

**§3 says `speedMultiplier = FLEE_SPEED_MULTIPLIER` "imported from movement.ts".
It is imported from `species/profile.ts` instead, and the constant was moved
there; `movement.ts` re-exports it under the same name so every existing call
site and test is untouched.**

The brief's version is a module cycle: `movement.ts` → `census.ts`/`species.ts` →
`species/wolf.ts` → `movement.ts`. Whether it crashes depends on which module the
process reaches first — enter through `movement.ts` and `wolf.ts` reads
`FLEE_SPEED_MULTIPLIER` in its temporal dead zone and throws at import time.
`species/profile.ts`'s own header names this exact hazard ("A per-name file cannot
import its shared vocabulary from the module that imports IT: that is a module
cycle, and the constants below would be in their temporal dead zone at the moment
the row is built"), and `TURN_RADIUS_BODY_LENGTHS` was moved from `movement.ts` to
`profile.ts` on 2026-09-02 for precisely this reason, with `movement.ts`
re-exporting it. I followed that precedent rather than inventing a third answer.
`FLEE_DURATION_SECONDS` stayed in `movement.ts`: nothing but the engine reads it.

## The other change the brief did not anticipate: `huntingOccupants`

`personalSpaceCellsOf` is half a body length, so separation holds a wolf and a
deer 2 + 2.2 = **4.2 cells apart — further than the wolf's catch radius of one
body length (4 cells)**. The catch was therefore geometrically unreachable: the
steering sweep vetoed the very step that closes the last cell, and a kill could
only land through the one-tick staleness of the occupant snapshot. Measured with
`maxSeconds` 4.5 before the fix: **41 kills against 367 misses**; after:
125 / 26 on the identical build.

The fix is one-sided and one function: a pursuing hunter does not treat ITS OWN
TARGET as an obstacle. Prey still avoids the hunter; the hunter still avoids every
other creature. This is a mechanism defect, not a constant, so I fixed it rather
than widening `catchRadiusCells` (which the brief fixes at one body length) — but
flagging it, because it is the one place the chase touches a steering rule instead
of merely feeding it a heading.

## D3 output, verbatim

Script: `.scratch/predation-proof.mts` (not committed, not a test). Part A is an
isolated `advanceMovement` loop over a hand-restored fish+shark population with
**no wolves anywhere**, on a seeded `Math.random`, so the RNG stream is identical
before and after the change by construction; part B is the real `PluginHost.tick`
on the test suite's ramp world. The shark baseline was captured on the unmodified
worktree before any edit: **1688**.

```
shark A/B: fish-startled entity-ticks over 60 s, seeded = 1688
[wildlife] fire plugin not available — animals will not burn
world: 1024^2 cells, ramp shoreline row 200, 600 s
targets: grazer 526, wolf 26
mean living wolves 24.7
pursuits started 172, kills 117, misses 53, dropped-by-flee 0
mean chase length 3.36 s
grazers: min 491, mean 512.2, target 526
  locked at 1-2 world units: 4/5 kills (80%)
  locked at 2-3 world units: 18/19 kills (95%)
  locked at 3-4 world units: 35/38 kills (92%)
  locked at 4-5 world units: 20/31 kills (65%)
  locked at 5-6 world units: 39/76 kills (51%)
  locked at 6-7 world units: 1/1 kills (100%)
```

Shark: **1688 before, 1688 after** — bit-identical on the same seed.

## Tests

`pnpm --filter @terrace/plugin-wildlife test` under `timeout 300`: **5 files,
48 tests, all passing** — the same 5/48 as before the change. Never
`pnpm -r test`.

**Test edits (allowed by the brief, §"Read first" 5):** four object literals that
construct a `WildlifeEntity` by hand needed the three new always-present fields to
typecheck — `test/gradient.test.ts` (2), `test/session-lifecycle.test.ts` (1),
`test/wildlife.test.ts` (1). No assertion changed and no test was added. The
persistence round-trip test (`persistedShapeOf`, `expectRestoredAtRest`) passes
unchanged and still asserts that a restored creature is at rest.

## Punts, named

- **Bison and ibex as prey.** The bison is the only row with `groupStartle`, so
  hunting it means designing what a herd does when one is taken — a bigger
  question, and the wrong one to answer by side effect. The ibex lives on broken
  ground a plain land walker cannot follow onto, so a wolf would run at a ledge.
- **No carcass, no death animation.** The deer is simply absent from the next
  broadcast and the interpolator drops it, exactly as natural turnover has always
  looked (`client/interpolation.ts:82`).
- **No `hunting` flag on the wire.** `WildlifeEntityState` is untouched; the
  payload stays 58 B. A chase is visible as an animal running at another one.
- **Pack behaviour.** A pair that locks the same deer both close and both are
  sated. Flanking, a shared target, or one wolf calling another in: not done.
- **`docs/decisions/wildlife.md`.** Not written — the orchestrator writes that
  with the owner, and this brief forbids touching `docs/`.

## Assumptions

- **Assumption:** the D3 ramp world's deer density (~515 deer over 52 672 sq world
  units) is representative enough of a real world for the kill-rate table to
  transfer. It is the fixture the test suite already reasons about, but it is much
  deer-denser than any island a player has actually built; on a sparse world locks
  will happen nearer the detect edge more often, which biases toward MORE misses,
  not fewer. Confirmed only by eyes-on (#322).
- **Assumption:** the plugin's RNG is `Math.random` and deliberately unseeded
  (`rng.ts` says so), so "deterministic" here means fixed iteration order and
  snapshot discipline, not reproducibility. Every ordering rule in the brief is
  implemented; nothing in this change can be pinned by a seeded replay in-tree.

## The decision the owner may want to reverse

**A kill removes the deer.** If the owner wants the chase without the death — a
wolf that runs deer down and then lets them go — the one-line revert is in
`plugins/wildlife/server/movement.ts`, in `resolveCatches`: replace the despawn
loop's body with nothing, i.e. delete

```ts
  for (let index = population.length - 1; index >= 0; index--) {
    if (doomed.has(population[index].id)) despawnWithCredit(index);
  }
```

The hunters still go sated, the deer still bolts, the chase still ends at the
catch radius, and no population number moves. Nothing else in the change depends
on the removal.
