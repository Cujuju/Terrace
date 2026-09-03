# Report — #299 (part 1 of 2): a cyclone has consequences on land

## Worktree and commits

- Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/cyclone-consequences-299`
- Branch: `worktree-cyclone-consequences-299` (branched off `main` at `5a5b981`). **Not merged.**

| SHA | Subject |
| --- | --- |
| `c8416ab` | `feat(kit): a consumer-side parser and severity model for storm damage` |
| `977907b` | `feat(flora): a cyclone fells trees and lays crops flat` |
| `0677659` | `feat(structures): a cyclone takes buildings, flimsiest first` |
| `7f59888` | `feat(boats): a cyclone carries a fleet round with the spin` |
| `b35aace` | `feat(cyclone): the wind scours the land it crosses, and a true header` |

Nothing under `docs/**`, `.claude/**` (except this report) or `plugins/cyclone/client/**` was
touched. No new dependencies. No tests added (owner rule).

## One deviation from the brief, stated up front

The brief asks each consumer to parse the payload structurally "in its own
`cyclone-event.ts` (mirror wildlife's `fire-event.ts`)". Each consumer **does** have its own
`cyclone-event.ts`, and it holds the whole of the by-name coupling (the event-name string) plus
that plugin's own tuning constants. What those three files do **not** each contain is a third
copy of the field-by-field parse.

Reason: the payload shape is `RotatingStormDamage`, declared in **core's plugin kit**
(`server/src/plugins/kit/rotatingStorms.ts:273-296`), not in a neighbouring plugin. The
copy-don't-import rule is explicitly about depending on a NEIGHBOUR —
`plugins/structures/server/rng.ts:6-11` states exactly that ("the 'own copy per plugin' rule is
about a plugin depending on a NEIGHBOUR; shared/ is core"). Restating core's own type in three
plugins would be the same eleven fields drifting in four places, for a decoupling nobody gains.
So the parse and the severity model live at
`server/src/plugins/kit/rotatingStormDamage.ts`, and every consumer still builds, tests and runs
with cyclone deleted. If you would rather have the triplication, it is a mechanical change.

## Per-consumer: what was built, and where

### 1. Flora — flatten

| What | Where |
| --- | --- |
| Seam (event name + constants) | `plugins/flora/server/cyclone-event.ts` |
| Subscription | `plugins/flora/server/index.ts:1689` |
| Handler | `plugins/flora/server/index.ts:1508` (`reactToCycloneDamage`) |
| Shared removal path | `plugins/flora/server/index.ts:1414` (`removeStanding`) |
| `floraBurnedOut`, now a one-line caller | `plugins/flora/server/index.ts:1376` |

`floraBurnedOut`'s body was extracted verbatim into `removeStanding(cells, cause)`; a burn is
`cause: 'fire'` and behaves exactly as before. The wind path is the same function with
`cause: 'wind'`, which gates the only two lines that are genuinely about fire — the grass tuft
(`index.ts:1449`) and the scorch stamp (`index.ts:1472`). Stumps are NOT gated: a wind-felled
tree leaves the same stump a burned one does, on the same clock, because the residue is the
tree's and not the fire's.

Reads the **whole disc**, not the event's twelve-cell sample: the sample is documented as being
"for consumers with no spatial index" (`rotatingStorms.ts:226-231`) and flora owns two, both
capped (`FLORA_TREE_CAP` 4096, `FLORA_CROP_CAP` 2048). Rolls use flora's own persisted generator
(`index.ts:229`), never `Math.random`.

**What the client sees**, and the existing broadcasts that carry it — all four already existed:

- felled trees → `broadcastChanges(world, [], felled)`, `plugins/flora/server/index.ts:386`,
  wire type `flora:changes`, `felled` list.
- flattened crops → `broadcastCropChanges(world, [], withered)`, `index.ts:438`, wire type
  `flora:cropChanges`, `withered` list.
- new stumps → `broadcastStumpChanges(world, stumps, [])`, wire type `flora:stumpChanges`.
- grass is deliberately untouched by wind, so nothing goes out on `flora:grassChanges`.

### 2. Structures — damage

| What | Where |
| --- | --- |
| Seam | `plugins/structures/server/cyclone-event.ts` |
| Subscription (hook is new; the plugin had no `onWorldEvent`) | `plugins/structures/server/index.ts:906` |
| Handler | `plugins/structures/server/index.ts:593` (`reactToCycloneDamage`) |
| The demolition path it copies | `plugins/structures/server/index.ts:540` (`structuresBurnedOut`) |

Same removal as every other loss: `live.delete`, `survey.evict` (or an in-flight generation
sweep carries a flattened house into the next generation — `life.ts`'s `GenerationSurvey`
snapshot), the same `broadcastChanges` delta, and `world.emitEvent('changes', { cause: 'wind',
died })`.

**Tiers resist**: the demolition chance is multiplied by `STRUCTURES_WIND_TIER_RESISTANCE ^ tier`
(`cyclone-event.ts`'s `windDemolishChance`). No new health model — the plugin has never had one,
and tier is the durability it already tracks and persists.

Rolls use structures' own persisted generator (`index.ts:181`).

### 3. Boats — push

| What | Where |
| --- | --- |
| Seam | `plugins/boats/server/cyclone-event.ts` |
| Subscription | `plugins/boats/server/index.ts:284` |
| Pending-wind latch | `plugins/boats/server/fleet.ts:303` (`pendingWind`), set by `noteStormWind` at `fleet.ts:797` |
| Push, applied in `advanceFleet`'s own frame | `plugins/boats/server/fleet.ts:822` (`applyStormWind`), called at `fleet.ts:880` |

**Dispatch order, as found.** `PluginHost.emit` (`server/src/plugins/host.ts:490-511`) fans an
emit out **synchronously**, inside the emitting plugin's `onTick`. Plugins tick in load order,
which is alphabetical by directory, so `boats` has already advanced its whole fleet by the time
`cyclone` emits. Pushing from the handler would move hulls mid-tick, after this plugin's own
step, separation and station-keeping had all been resolved against the old positions. So the
event is latched and consumed at the top of the next `advanceFleet` — the push is where each
hull actually is when the frame starts.

It is a **queue of one, not a per-tick latch** (unlike `krakenThisTick`): a damage event is a
discrete quantum of storm that must be applied exactly once, where a kraken position is a
standing fact re-announced every tick.

**Rotation sense** is `(-dy, dx)` about the eye, derived from what the client draws and written
out at `server/src/plugins/kit/rotatingStormDamage.ts`'s `tangentialWindAt`: a spiral arm's
angle increases with time (`plugins/cyclone/client/spiral.ts:272-275`), a puff at angle θ sits at
`(cos θ·r, height, sin θ·r)`, and world `z` is fed from the cell's `y`
(`plugins/cyclone/client/index.ts:97`) — so increasing angle carries cloud from +x toward +y, and
d/dθ (cos θ, sin θ) at offset (dx, dy) is (-dy, dx).

**Clamped to water** by walking the push in `BOAT_WIND_PUSH_STEP_CELLS` hops through
`moveIfSailable`, stopping at the first cell a hull may not occupy — a single long jump would
test the destination and nothing in between, and teleport a boat through a spit of land.

No randomness at all; the displacement is a pure function of position and event.

### 4. Land — disrupt (inside the cyclone plugin)

| What | Where |
| --- | --- |
| The mechanic | `plugins/cyclone/server/wind-scour.ts` |
| Call site | `plugins/cyclone/server/index.ts:236` (in `simulate`, after the events go out) |

It uses the damage event's **sample**, and that is the one right source here: this consumer's
subject is the ground, of which there are tens of thousands of cells under one cyclone, and
answering exactly would be a re-terraform rather than a storm. It does **not** round-trip its own
event through `onWorldEvent` — the plugin holds the damage in hand where it emits it, the
by-name rule is about reaching a neighbour, and `onWorldEvent`'s own doc warns an emitter must
filter itself back out.

Guarded by `footprintUnlocked` over the whole brush (the shared helper the surge already uses),
so unrevealed ground is never rewritten. The sculpt amount is rounded to a whole height unit and
skipped if it rounds to zero — the exact failure mode `surge.ts` documents, where every surge
this plugin ever attempted threw a `RangeError` and moved no ground.

Landfall (`cyclone:landfall`) stays informational; nothing consumes it.

#### Why it shares `cyclone-surge` rather than getting a sibling setting

The question the setting asks an operator is not "do you want surges". It is **may weather
permanently rewrite my map** — the only part of a cyclone that is not transient and the only part
there is no undo for. A wind scour is the same `sculpt`, through the same authoritative path,
with the same absence of an undo, under the same `footprintUnlocked` condition the owner attached
to defaulting it on (`docs/decisions/storms-and-mudslides.md`, #230). Splitting it would offer a
world in which the sea may take the coast but the wind may not take the hill behind it — a
distinction nobody has asked for — in exchange for a second row in the world panel, a second
thing to reason about in every "is this world's terrain stable" conversation, and a second
default to get wrong. The key is left spelled `cyclone-surge` **deliberately**: it is persisted
per world, and renaming it would silently reset every world that has ever turned it off — the
exact worlds whose owners care most — back to the shipped default of `on`. The prose at
`plugins/cyclone/protocol.ts:150` now says what the switch decides; the key stays historical.

### 5. Header

`plugins/cyclone/server/index.ts:4-48` rewritten. It said "Nothing, yet, and deliberately";
it now names flora, structures and boats with the file each one's tuning lives in, says the land
is this plugin's own consequence, states that wildlife and fire from #213 are still unclaimed,
and corrects the tick shape (it now writes ground in two places, not one).

## Constants

| Constant | Value | Reason (short) |
| --- | --- | --- |
| `MAX_DAMAGE_SAMPLE_CELLS_PER_EVENT` (kit) | `ROTATING_STORM_DAMAGE_SAMPLE_CELLS × 100` = 1200 | Defensive bound, derived from the engine's own sample so it tracks it; generous enough that raising the sample never silently truncates an honest payload. |
| `FLORA_WIND_MIN_SEVERITY` | 0.15 | Below it a tree bends rather than uproots. Also stops a cyclone that land has beaten down from felling single trees at a vanishing rate for the whole minute it takes to die. |
| `FLORA_WIND_TREE_FELL_CHANCE_PER_SEVERITY_SECOND` | 0.5 | Read off the outcome at the one place severity reaches 1: a stand under the eyewall is 97% gone in 5 s. Not 1.0, which would leave nothing for severity to modulate and give the player no second in which to watch it. |
| `FLORA_WIND_CROP_MIN_SEVERITY` | `FLORA_WIND_MIN_SEVERITY / 3` = 0.05 | A crop is flattened by wind a tree stands up to; the ratio is the reason, the number its consequence. |
| `FLORA_WIND_CROP_FLATTEN_CHANCE_PER_SEVERITY_SECOND` | 1 | Grain has no strategy against a hurricane. The severity ramp still makes it a gradient. |
| `STRUCTURES_WIND_MIN_SEVERITY` | 0.35 | More than double flora's, so a storm takes the wood around a settlement before it takes a roof (inner ~69% of the disc against a tree's ~87%). |
| `STRUCTURES_WIND_DEMOLISH_CHANCE_PER_SEVERITY_SECOND` | 0.08 | A sixth of a tree's. A tier-0 teepee's survival over a minute of eyewall is 0.92^60 ≈ 0.7% — gone reliably, but any one second is an 8% event. |
| `STRUCTURES_WIND_TIER_RESISTANCE` | 0.6 | Geometric, matching the tier ladder's own equal-cost steps. Over a minute of eyewall: tier 0 ~99% lost, tier 3 ~65%, tier 5 ~31%. 0.5 puts tier 5 at ~1 in 6 (near-immune), 0.667 at ~2 in 5. |
| `BOAT_WIND_PUSH_FRACTION_OF_TOP_SPEED` | 1.5 | Fixes the severity at which wind out-pulls oars: the reciprocal, 2/3. Below 1 the mechanic does not exist — measured (see below). At 3 most of the disc becomes water no boat may row in. |
| `BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND` | `BOAT_SPEED_CELLS_PER_SECOND × 1.5` = 5.4 | Derived, so retuning the hull's speed keeps the storm's grip meaningful. |
| `BOAT_WIND_PUSH_STEP_CELLS` | 1 | The sampling grid's resolution — the only value that makes "a pushed boat never lands on ground" true rather than probable. |
| `WIND_SCOUR_HEIGHT_UNITS` | `BAND_HEIGHT / 4` = 4 | Half the surge's, on the surge's own reasoning ("less than one visible step of terracing"). Shallower because wind does less work than the sea, in more places at once. |
| `WIND_SCOUR_BRUSH_RADIUS_CELLS` | 2 | Half the surge's. Wind strips a patch of hillside; the sea re-cuts a bay. |
| `WIND_SCOUR_MIN_SEVERITY` | 0.5 | The same bar `SURGE_MIN_INTENSITY` sets, because both answer "is this storm strong enough to rewrite terrain". Also keeps the sculpt amount off zero: the shallowest cut is `round(4 × 0.5)` = 2. |
| `WIND_SCOUR_MAX_CELLS_PER_EVENT` | 3 | Caps a whole storm at roughly 1400 sculpts spread along its track instead of ~5700 queued, and in practice far fewer. Enough that a landfall visibly works the ground over. |

## Proof

Two node scripts, no browser, no app start. Both are in the worktree's `.verify-299/` and are
**not committed** (`git status` shows `?? .verify-299/`).

- `.verify-299/fixture.mts` — the whole world: a real `PluginHost` over the real cyclone, flora,
  structures and boats plugins, on a 512² world with a wooded island carrying a village and a
  fleet, storm forced with `CYCLONE_DEV_FORCE=1`. Built with the same `worldWithTerrain` /
  `asLoadedPluginExporting` / `grantTokenEveryUnlockedChunk` shape the plugins' own suites use.
- `.verify-299/push.mts` — the boat push in isolation (no host, all water), because the fixture
  cannot separate a push from the rowing that answers it.

```
CYCLONE_DEV_FORCE=1 node --experimental-strip-types .verify-299/fixture.mts
node --experimental-strip-types .verify-299/push.mts
```

### Whole-world fixture, ground-changing `on`

```
storm: eye (256, 256) radius 120.0 peakIntensity 0.7454 envelope 1
island: centre (256, 309) radius 20, distance to eye 53.0 cells
storm seconds: 60

FLORA   trees  417 -> 2   (planted 422)
FLORA   crops  144 -> 70   (the survey re-sows, see below)
FLORA   stumps 0 -> 414
FLORA   on the wire during the storm: 431 trees felled, 968 crop cells laid flat

STRUCTURES before: (256,299) tier 1, (256,305) tier 2, (256,311) tier 3, (256,317) tier 4
STRUCTURES after:  (256,317) tier 4

BOATS (the spin the client draws is the tangent (-dy, dx) about the eye)
  boat 1: (257.02, 329.24) -> (257.02, 329.24)  moved 0.00 cells, 0.00 of it along the spin
  boat 2: (256.64, 330.01) -> (258.77, 329.88)  moved 2.13 cells, -2.12 of it along the spin
  boat 3: (260.41, 337.07) -> (247.60, 328.38)  moved 15.48 cells, 12.32 of it along the spin

LAND  ground-changing setting: on. Island cells whose height changed: 52
      (21 inland — the wind scour; 31 within a surge brush of the waterline)
  wind  (249,299) delta -2  [43.6 cells from the eye]
  wind  (256,302) delta -2  [46.0 cells from the eye]
  wind  (264,297) delta -2  [41.8 cells from the eye]
  wind  (264,298) delta -2  [42.8 cells from the eye]
  wind  (268,304) delta -2  [49.5 cells from the eye]
  … 16 more inland cells at delta -1 (the relaxation skirt of the five cuts above)
  shore (243,294) delta -104 … (244,294) delta -99   ← the SURGE, not this change
```

Reading it:

- **Flora.** 417 standing trees → 2, and 414 stumps where they stood; 431 felled cells crossed
  the wire (more than 417 because flora's survey regrows a handful mid-storm and the wind takes
  those too). 968 crop cells laid flat. Net crop count is a poor measure — flora re-sows every
  `CROP_SURVEY_INTERVAL_SECONDS` (5 s) — which is why the wire is counted; see the residual below.
- **Structures.** Four buildings standing when the storm began (the tier-0 teepee had already
  died of loneliness to B3/S23 during the calm phase, which is the CA doing its own job). Tiers
  1, 2 and 3 went; the tier-4 building rode it out. That is the resistance ladder, in one run.
- **Boats.** Boat 1 was pushed into the island's shore and did not move at all — the clamp
  working: it never landed on ground. Boat 3 was carried 15.5 cells, 12.3 of them along the spin.
  Boat 2's −2.12 is the hull rowing back home after the wind let go, which is what a fleet
  outside the crossover contour does.
- **Land.** 21 inland cells changed. The five `-2` cells are wind-scour brush centres
  (`round(WIND_SCOUR_HEIGHT_UNITS × severity)` = `round(4 × 0.54)` = 2) and the sixteen `-1`
  cells are the conserving relaxation's skirt around them. The `-104`/`-99` shoreline cells are
  the **surge**, not this change — that is `surge.ts`'s own documented residual (many surges
  landing on the same cell take the shore down far more than "a band or two"), unchanged by this
  work and reported rather than rewritten.

### The gate

Same fixture, `CYCLONE_SURGE=off`:

```
LAND  ground-changing setting: off. Island cells whose height changed: 0 (0 inland; 0 shore)
```

Flora, structures and boats are unaffected by the setting, as they should be — the setting is
about terrain, and the other three consequences are transient.

### Determinism

Two runs of the fixture, same seed, byte-identical:

```
$ diff run1.txt run2.txt && echo IDENTICAL
IDENTICAL
$ md5sum run1.txt run2.txt
cfe02c99ed9dc09e506c82ba790d30ee  run1.txt
cfe02c99ed9dc09e506c82ba790d30ee  run2.txt
```

### The push, isolated

```
push 5.40 cells per severity-second (1.5× the hull's own speed)
crossover: severity 0.667, i.e. 32.0 cells from the eye of a full-strength storm

ONE EVENT, ONE FRAME — the push in isolation
  boat 2 at (134.73, 155.80), range 28.6, severity 0.717
    wind unit (-0.972, 0.235)  step (-3.429, 1.041)
    along the spin 3.577 cells, against an expected push of 3.873
  boat 3 at (132.64, 173.91), range 46.1, severity 0.456
    wind unit (-0.995, 0.101)  step (-2.784, 0.112)
    along the spin 2.781 cells, against an expected push of 2.463

A 30s STORM over a village 15 cells from the eye — severity there is ABOVE the crossover
  boat 1: moved 27.15 cells,  9.11 along the spin
  boat 2: moved 19.41 cells, 14.54 along the spin
  boat 3: moved 18.13 cells, 17.80 along the spin
```

The per-event displacement matches `severity × BOAT_WIND_PUSH_CELLS_PER_SEVERITY_SECOND` to
within one frame of the boat's own rowing, and it is along the tangent, not against it.

## Tests and typecheck

No tests were added. Every touched package's existing suite passes, run per package with a
timeout (never `pnpm -r test`):

| Command | Result |
| --- | --- |
| `pnpm --filter ./plugins/cyclone test --run` | `Test Files 1 passed (1) / Tests 3 passed (3)` |
| `pnpm --filter ./plugins/flora test --run` | `Test Files 2 passed (2) / Tests 70 passed (70)` |
| `pnpm --filter ./plugins/structures test --run` | `Test Files 8 passed (8) / Tests 188 passed (188)` |
| `pnpm --filter ./plugins/boats test --run` | `Test Files 5 passed (5) / Tests 52 passed (52)` |
| `pnpm --filter ./server test --run` | `Test Files 29 passed (29) / Tests 342 passed (342)` |
| `pnpm typecheck` | all 27 workspace projects `Done`, no `error TS` lines |

(The worktree had no `node_modules`; `pnpm install --frozen-lockfile --prefer-offline` was run
once to restore the lockfile's existing dependencies. Nothing was added and `pnpm-lock.yaml` is
unchanged.)

## Pinned old contracts found, reported not rewritten

1. **The chronicle ignores a `wind` loss.** `plugins/chronicle/server/saga.ts:107` accepts only
   `cause === 'generation'` and `cause === 'sculpt'` from `structures:changes`, so a
   wind-demolished building is unchronicled — exactly as a **fire**-demolished one already is
   (`structuresBurnedOut` has emitted `cause: 'fire'` since before this change, and the chronicle
   has always dropped it). Widening that set is the chronicle's call and is out of this brief.
   Noted in the handler's doc comment.
2. **`surge.ts`'s stacking residual.** Many surges landing on the same shoreline cell take the
   shore down far more than the header's "a band or two" — the `-104` in the proof output. That
   is documented in `SURGE_BRUSH_RADIUS_CELLS` already, is not this change's doing, and is not
   touched.
3. **An unused import in flora.** `stumpKey` at `plugins/flora/server/index.ts:119` is imported
   and never used, on `main`, before this change. Left alone to keep the diff focused.

## Left undone, and why

1. **Wildlife and fire** — issue #213 lists both as consumers of wind damage. Out of this brief's
   scope (it names four consumers), and now called out explicitly in the cyclone header so the
   next reader is not told "no consumer exists".
2. **A flattened crop field re-sows within 5 seconds.** Flora's crop survey runs every
   `CROP_SURVEY_INTERVAL_SECONDS`, and the wind path deliberately does not stamp the scorch
   record (the brief: "the SAME code path a burned-out tree takes **minus the scorch**"), so
   there is nothing barring the field. The visible outcome: 968 crop cells were laid flat and the
   field is most of the way back by the time the storm has passed. **Decision: no change.** The
   fix would be a wind-specific regrow bar, which is a new mechanic and a new constant the owner
   has not asked for, and reusing the scorch record would also stop the *wood* growing back —
   turning a storm into a fire. Flagging it as the owner's call. Trees do not have this problem:
   the stump is a real residue and it outlives the regrowth clock.
3. **Grass is untouched by wind.** A cyclone does not take a tuft at the foot of a trunk it
   snapped. Deliberate, documented at `FloraRemovalCause`; say the word if the meadow should go
   over too.
4. **No client work.** `plugins/cyclone/client/**` untouched, per the brief. Everything a player
   sees arrives through each consuming plugin's existing broadcasts, listed above with file:line.
5. **The severity model is a straight ramp.** It is the coarsest curve consistent with the four
   things the payload guarantees, and it happens to be *exactly* the shipped cyclone profile
   (`(1 - r) / (1 - eye)`, `sim.ts:88-92`) — so today it is not an approximation at all. For a
   future kit owner with a different falloff it stays bounded by those guarantees, and the error
   would be in how hard a consumer reacts, never in where. Reasoned out in
   `rotatingStormDamage.ts`'s header; the alternative (publishing the emitter's profile function
   on the wire) is the import coupling the whole contract exists to avoid.
