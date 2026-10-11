# wildlife-species — server side, report

Branch `wildlife-species`. Four new species (`ibex`, `bison`, `ray`, `shark`),
the profile contract they need, and the grazer speed halving. No merge to main.
Nothing outside `plugins/wildlife` (plus this report) was touched; no model
geometry was written; no app was started or stopped.

Line numbers below are the state of the branch at the report commit. Every
claim about behaviour is a line, not a comment.

---

## 1. The final field shapes on `SpeciesProfile`

All of it lives in **`plugins/wildlife/server/species/profile.ts`** — the
vocabulary a row is written in. It was split out of `server/species.ts` because
a per-name species file cannot import its shared constants from the module that
imports it (a module cycle: the constants would be in their temporal dead zone
at the moment the row is built). `species.ts` `export *`s the whole file, so
every existing importer is unchanged.

**New / changed fields** (`profile.ts`):

| field | line | shape |
|---|---|---|
| `maxGradientPerCell` | 536 | unchanged shape; now actually read (see §3) |
| `turnRadiusBodyLengths` | 561 | `number`, **required** — no default |
| `idle?` | 570 | `IdleBouts \| undefined` |
| `groupStartle` | 587 | `boolean`, required |
| `hunts?` | 593 | `Predation \| undefined` |
| `spawnGround` | 602 | `SpawnGround` — replaces `spawnOpenDirectionsRequired` |

**New types** (`profile.ts`):

```ts
// 627
export interface IdleBouts {
  readonly onsetPerSecond: number;   // rate of entering a bout while moving
  readonly endPerSecond: number;     // rate of leaving one
}

// 654
export interface Predation {
  readonly preySpecies: readonly WildlifeHabitatSpecies[];
  readonly alarmRadiusCells: number;
}

// 682
export type SpawnGround =
  | { readonly kind: 'open';   readonly minOpenDirections: number }
  | { readonly kind: 'broken'; readonly minSteepDirections: number };

// 687 — the vacuous rule every swimmer states
export const NO_SPAWN_GROUND_RULE: SpawnGround = { kind: 'open', minOpenDirections: 0 };

// 702 — read by canSettleAt and despawnWedged
export function spawnGroundConstrains(rule: SpawnGround): boolean;
```

`TURN_RADIUS_BODY_LENGTHS` (0.5) moved here (`profile.ts:184`) and is
re-exported from `movement.ts:97`, so boats' citation of it still resolves.

**What the wiring phase and the model files consume**: `SPECIES_PROFILES.<name>`
gives `bodyLengthCells` (the client's scale reference), `habitat`, and — new —
`idle` (whether a model needs a stationary pose at all) and
`turnRadiusBodyLengths`. Nothing else on the profile is client-visible; the wire
payload per entity is byte-identical to before (`population.ts:entityStates`
unchanged — id, species, x, y, heading, size index).

---

## 2. file:line for every engine change

### Wire vocabulary
- `plugins/wildlife/protocol.ts:35-48` — `WILDLIFE_HABITAT_SPECIES` gains the
  four names, **appended**, because this order is the order spawning considers
  species in. `WILDLIFE_SPECIES`, `isWildlifeSpecies` and
  `isWildlifeHabitatSpecies` derive from it and needed no edit; persistence
  round-trips the new species through the existing
  `isWildlifeHabitatSpecies` guard (`persistence.ts:131`).

### `server/species/profile.ts` (the contract)
- `184` `TURN_RADIUS_BODY_LENGTHS`, moved.
- `536-602` the new/changed profile fields.
- `627, 654, 682, 687, 702` the new types and the rule helper.
- `SINGLE_SIZE_WEIGHTS` exported (`169`) so a per-name row can state it.

### `server/species.ts` (the table)
- `109` grazer `cruiseSpeedCellsPerSecond: cellsAcross(0.8)` — the halving,
  with the owner's sentence as the comment.
- `227-230` `ibex / bison / ray / shark` rows pulled in from their files.
- `274` `SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND` — a minimum over the
  land rows, in `WILDLIFE_HABITAT_SPECIES` order.
- Every original row states `turnRadiusBodyLengths`, `groupStartle` and
  `spawnGround` explicitly.

### `server/census.ts`
- `51-53 / 78 / 88-91` `walkerProfileOf` now returns a per-species profile built
  once at module load, with the **row's** `maxGradientPerCell` written over the
  archetype's. The other three traversal axes stay the archetype's.
- `289` `steepDirectionCount` — of the same eight directions, how many are steps
  a plain `LAND_WALKER_PROFILE` could not take but this species can.
- `324` `satisfiesSpawnGround` — the one place a `SpawnGround` rule is
  interpreted.
- `440` `emptySpeciesCounts` built from `WILDLIFE_HABITAT_SPECIES`.

### `server/movement.ts`
- `97` `TURN_RADIUS_BODY_LENGTHS` re-export.
- `297-302` `maxTurnRadiansPerSecondOf` divides by the **species'**
  `turnRadiusBodyLengths`.
- `640` `advanceIdleState(entity, dt)` — the Poisson beat; fleeing sets
  `idle = false` and returns; a species with no `idle` can never enter one.
- `705-707` `advanceEntity` resolves the bout first and **returns** while idle,
  so the creature neither translates nor turn-noise wanders.
- `842 / 865` `advanceMovement` runs `applyPredatorAlarms()` after the movement
  loop; each hunter calls `startleNear` from its own end-of-tick position with
  its prey list as the filter.
- `884` `StartleOptions` (`{ species? }`), `903` `startleNear` takes it. Both
  existing callers (`index.ts:281` sculpt, `index.ts:399` fire) pass nothing.
- `startleNear` is two passes: pass 1 records who the disturbance reaches and
  which `groupStartle` schools it touched; pass 2 applies the startle to those
  plus every member of a touched herd, **from the same origin**, and never
  shortens `fleeSecondsRemaining` (`Math.max`, unchanged).

### `server/population.ts`
- `154` `idle: boolean` on `WildlifeEntity` — always present, never on the wire,
  not persisted (reasoning on the field).
- `439` `canSettleAt` delegates to `satisfiesSpawnGround`.
- `570` spawned creatures are born moving.
- `767` `despawnWedged` exempts species whose rule constrains nothing (every
  swimmer); the ibex is **not** exempt.

### `server/rng.ts`
- `49` `rollEvent(ratePerSecond, dt)` over shared's exact Poisson form. The
  idle bouts are the only caller; the spawn hazard and the turnover roll keep
  the linear form their constants were calibrated against.

### `server/persistence.ts`
- `29-34` the persisted shape omits `idle`, argued.
- `156-160` a restored creature starts moving.

### `server/index.ts`
- `112 / 201` `FIRE_STARTLE_RADIUS_CELLS` derives from
  `SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND` instead of citing the grazer.
  **48 cells → 18** (bison 2.4 cells/s × 3 × 2.5 s). This is a real behaviour
  change and it is the one the constant's own invariant demands: the animals it
  is sized against got slower. It no longer coincides with `FLEE_RADIUS_CELLS`
  (48) — the two were never related.

### Client (interim stubs, wiring phase replaces them)
- `client/placement.ts:116-117` ibex/bison `null`; `128-142` ray and shark swim
  profiles at the brief's envelope figures; `221-224` all four `null` in
  `FLIGHT_ALTITUDES`.
- `client/models.ts:619-625` `drawableOf` maps ibex/bison → `grazerDrawable`,
  ray/shark → `fishDrawable`, commented as interim.
  `WILDLIFE_SPECIES_DRAW_OBJECTS` untouched.

---

## 3. Two latent defects found and fixed

1. **`walkerProfileOf` discarded the row's gradient limit** and handed on the
   archetype's (`census.ts`, pre-change). Invisible because all four original
   rows happened to state exactly the limit their archetype already carried, so
   `SpeciesProfile.maxGradientPerCell` was declared by every row and read by
   nothing — and `canTraverse`'s own doc claimed the opposite. A climber would
   have been silently ignored. Fixed at the contract: the row wins on that one
   axis, and the four original species get a byte-identical profile.
2. **`emptySpeciesCounts` was a hand-written four-name literal.** Type-checked,
   but the failure it produces is errors in a file the new species does not
   otherwise touch. Now derived.

Both are cited in the feature commit.

---

## 4. Density table — day one and full reveal

Restated from `docs/decisions/wildlife.md` with the new rows.
`WILDLIFE_POPULATION_CAP` is **unchanged at 850** (it is a bandwidth budget).

| species | density (sq. world units) | habitat | day one (2 304 shallow / 4 096 deep / 0 land) | full 512², asked | full 512², capped |
|---|---|---|---|---|---|
| fish | 400 | shallow | 5 (one school) | 131 | 55 |
| whale | 2 000 | deep | 2 | 39 | 16 |
| deep-sea | 1 500 | deep | 2 | 52 | 22 |
| grazer | 100 | land | 0 (no land yet) | 1 310 | 556 |
| **ibex** | **700** | land | 0 | 187 | 79 |
| **bison** | **600** | land | 0 | 218 | 92 |
| **ray** | **1 200** | shallow | **1** | 43 | 18 |
| **shark** | **2 500** | shallow | **0** | 20 | 8 |
| | | | **10** | **2 000** | **846** |

**Day one is unchanged for every existing species** — the new rows only add a
single ray, and the shark deliberately does not fit the starter shelf (it
arrives with territory creep, the same progression the whale and the kraken
have). The cap does not bind on day one (10 ≪ 850) and does not bind on any
world that exists on this machine: the largest sculpted island measured 462
square world units of land.

**Where it does bind, and what it costs.** On the nominal fully-revealed
half-land 512² world the demand goes 1 532 → 2 000, and the proportional
scaling takes every species down by 850/2 000 = 0.425 instead of 0.555. The sea
thins: **fish 72 → 55, deep-sea 28 → 22, whale 21 → 16**. That is the honest
price of four more species under a fixed cap. It is proportional, so the
ecosystem is smaller rather than distorted; whales remain the rarest species
asked for; and no world of that shape exists. The dials that would move it back
are named where they live (`census.ts`: the cap is bandwidth, a per-species
reservation in `targetsFor` is the other answer) — neither is warranted yet.
This is asserted exactly in `test/wildlife.test.ts`, so a future drift fails
there rather than in someone's ocean.

---

## 5. Tests updated (no new tests, no new cases)

Permission was not granted this session, so nothing was added. These existing
assertions stopped being true statements about the code and were corrected:

| test | file:line | reason |
|---|---|---|
| `WildlifeEntity` fixtures (6 literals) | `gradient.test.ts:52,151,210`, `session-lifecycle.test.ts:48`, `wildlife.test.ts:1555,1804` | `idle` is a required field now |
| `countsBySpecies` | `wildlife.test.ts:286` | four-name literal → built from `WILDLIFE_HABITAT_SPECIES` |
| `holds a full 512² world near, and never above, the cap` | `wildlife.test.ts:523` | the capped table changed (§4); restated exactly, with the cost stated in the test |
| `never removes a not-yet-ripe habitat-loss credit…` | `wildlife.test.ts:874,903` | uniform shallow water is now habitat for three species, so "every credit is unambiguously fish" is false; the race runs on whichever species the despawn hits |
| `round-trips the population through a snapshot` | `wildlife.test.ts:1076` | compared the whole live entity; passed only because nothing was ever fleeing or idling at snapshot time |
| `carries school and size through a snapshot unchanged` | `wildlife.test.ts:2160` | same |
| `startles creatures within the flee radius…, and no others` | `wildlife.test.ts:724,751` | a sculpt is no longer the only startle source: a shark frightens prey anywhere on the map, every tick. The test now records who was already fleeing before the sculpt and excludes them, and picks a calm subject — so the claim stays "nothing far from the change was startled BY IT" rather than being weakened |

The two round-trips now compare `persistedShapeOf` (the fields
`PersistedEntity` actually carries) and assert `expectRestoredAtRest()` beside
it — which is a stronger statement than the old one, not a weaker one: it says
what the snapshot contract IS rather than relying on a fixture never producing
a transient.

---

## 6. Behaviours that are UNTESTED, and want permission

Nothing below has a test, because none may be written this session. Each is a
contract-level behaviour, so a contract-level test is the deliverable:

1. **Idle bouts** — `advanceIdleState` is exported precisely so this can be
   asserted directly: at rate 0 a creature never idles; an idling creature's
   `x/y/heading` are unchanged after `advanceEntity`; a fleeing creature's
   `idle` is cleared and stays cleared for the panic.
2. **Group startle** — a bison herd where only one member is inside the radius:
   every member ends up fleeing, all pointed away from the same origin, and a
   member already fleeing longer keeps its longer timer. And the negative: a
   fish school in the same geometry does **not** propagate.
3. **The predation filter** — `startleNear` with `{ species: [...] }` startles
   only those species; a shark does not startle itself or another shark; after
   one `advanceMovement` tick, fish inside the shark's alarm radius are fleeing
   and fish outside it are not.
4. **Broken-ground spawn** — `steepDirectionCount` on a scarp returns the steep
   directions and `openDirectionCount` on the same cell does not; an ibex
   settles on a scarp shoulder and a grazer refuses it; `satisfiesSpawnGround`
   dispatches on `kind`.
5. **Per-species turn radius** — `maxTurnRadiansPerSecondOf` for a ray is a
   third of what the same body length at 0.5 would give; the four original
   species are unchanged from the pre-change global.
6. **The gradient override** (§3, defect 1) — `walkerProfileOf('ibex')`
   carries `IBEX_MAX_GRADIENT_PER_CELL`, and `canTraverse` lets an ibex cross a
   riser a grazer is refused. This one is the highest value of the six: it is a
   silent-failure class, not a feature.

---

## 7. Verification

- `pnpm --filter @terrace/plugin-wildlife typecheck` — **green**.
- `pnpm typecheck` at the worktree root (all 24 packages, client included) —
  **green**.
- `pnpm --filter @terrace/plugin-wildlife test` — **green: 4 files, 132 tests
  passed, 0 failed** (555 s). Six existing assertions were corrected first;
  none were added or removed (§5).

### Demonstration run

Stand-in `HabitatWorld`: 512² cells, fully unlocked — a shallow shelf (west
half), a scarp of one 3-height riser per cell (a plain land walker's limit is 2,
the ibex's is 4), then a flat land plateau. Spawned entirely through the real
spawn path (`advancePopulation`), then 5 simulated minutes at 10 Hz of
`advancePopulation` / `advanceMovement` / `despawnInvalidHabitat` — the same
order as `server/index.ts`'s `simulate`. **No sculpt and no fire**, so the only
possible startle source is a hunter.

```
world 512² cells; 5 simulated minutes at 10 Hz

species   target  alive   distance(cells)  mean cells/s   idle%   max riser crossed   startled(no sculpt)
fish         20    20         71883.6        12.27    0.0                  0                   26
whale         0     0             0.0            -      -                  0                    0
deepsea       0     0             0.0            -      -                  0                    0
grazer       81    81         74093.4         3.20    0.0                  0                    0
ibex         11     9         11294.9         3.69   23.0                  3                    0
bison        13    13          5828.2         1.67   30.5                  0                    0
ray           6     5          5178.4         3.19   21.7                  0                    8
shark         3     2          5406.5         7.20    0.0                  0                    0

grazer cruise speed:
  before (1.6 world units/s): 6.4 cells/s
  after  (0.8 world units/s): 3.2 cells/s (0.8 × WORLD_UNIT_CELLS = 3.2)

land-walker gradient limit 2, ibex 4, scarp riser 3/cell
```

Reading it:

- **Grazer speed halved.** Mean 3.20 cells/s is exactly `cellsAcross(0.8)`, and
  exactly half the 6.4 it was. The grazer never idles, so cruise and mean
  coincide — which is also the check that the idle machinery did not leak into
  a species that declares no bouts.
- **Idle bouts fire at their declared rates.** Predicted stationary fractions
  from `onset/(onset+end)` are ibex 24%, bison 33%, ray 25%; measured 23.0%,
  30.5%, 21.7% over ~3 000 ticks. Fish, grazer and shark declare no bouts and
  measure 0.0%.
- **The ibex climbs what nothing else can.** It is the only species with a
  non-zero riser crossed, and the riser is 3 — above the land walker's limit of
  2 and inside its own 4. The grazer and the bison, on the same map with the
  same scarp, measure 0. This is the §3 defect-1 fix being exercised: before it,
  the ibex's declared limit was discarded and this column would read 0.
- **The shark's alarm works with no sculpt.** 26 fish and 8 ray startles arose
  purely from `applyPredatorAlarms`. The shark itself was startled 0 times —
  it is not in its own prey list.
- Mean speeds elsewhere track cruise × (1 − idle) with the residual being ticks
  the habitat veto refused a step (bison 1.67 against 2.4 × 0.695 = 1.67; ray
  3.19 against 4.0 × 0.783 = 3.13; ibex 3.69 against 4.8 × 0.77 = 3.70).

The script was deleted before the final commit, per the brief.

---

## 8. Assumptions and residuals, named

- **Assumption (unverified against the owner):** three land species should not
  share one behaviour, so the grazer keeps no idle bouts even though the name
  suggests grazing — the bison is the row that stops to graze. Stated at the
  grazer row in `species.ts`.
- **Residual, accepted and documented at `species/ray.ts`:** the ray's 1.5
  turn radius exceeds the bound `TURN_RADIUS_BODY_LENGTHS`' own note states
  (`lookaheadCellsFor` floors the probe at one body length, so a ratio above 0.5
  makes the turning circle wider than the sightline). It is acceptable for a
  slow animal on open shelf, where the only thing to arc into is a shoreline the
  veto refuses outright. If a ray is ever wanted on a reef, that number comes
  down or the look-ahead floor rises to the widest turning circle in the table.
- **Residual, named at `species/profile.ts`'s `Predation`:** the hunter alarm is
  O(hunters × population) per tick. It is affordable only because the shark's
  density is the thinnest in the table. A common species declaring `hunts` would
  make this the plugin's most expensive loop.
- **Behaviour change beyond the ask:** `FIRE_STARTLE_RADIUS_CELLS` 48 → 18
  cells. Forced by the halving, correct under the constant's own invariant, and
  the alternative (leaving it citing the grazer) would have been a comment that
  is false.
