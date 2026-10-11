# The kraken is confined to its trench — report (arc `kraken-trench`)

Branch `kraken-trench`. Package `plugins/monsters` only; nothing under `docs/`,
`shared/`, `plugins/boats` or any other plugin was touched.

Every mechanism claim below cites the line it was read from, in this branch's
tree. Comments were not taken as evidence for anything.

---

## 1. The defect, re-verified from source

- `plugins/monsters/server/kinds.ts:894` (Cthulhu) and `:912` (kraken) both set
  `habitat: WATER_HABITAT`. `habitat.ts:175-179` defines that regime with
  `thresholdBands: DEEP_WATER_BANDS_BELOW_SEA`, which `habitat.ts:121-122`
  derives as `192 / BAND_HEIGHT` — **12 bands** at today's `BAND_HEIGHT = 16`.
  (The brief said 3; that is the pre-re-terrace number. Verified at runtime:
  `BAND_HEIGHT=16`, so the floor is 12 bands and the kraken's bar is 31.)
- The kraken's row additionally carried `minLairReachBands:
  KRAKEN_LAIR_MIN_DEPTH_BANDS` (`kinds.ts:912`), computed at `kinds.ts:357-359`
  as `floor(NATURAL_OCEAN_FLOOR_MIN_DEPTH / BAND_HEIGHT)` = `floor(510/16)` =
  **31 bands**.
- That demand was applied at admission ONLY: `summoning.ts:664` (the region's
  extreme cell), `summoning.ts:776` (the arrival cell), and `habitat.ts`'s
  survey walk.
- Movement read the FLOOR. Before this change, all four movement predicates in
  `lurk.ts` passed `profile.habitat`: the steering probe's `permits` hook, the
  `isStranded` centre test, the pinched-body clearance decision, and the
  destination re-check. So a kraken summoned in a 31-band trench was steered
  against the 12-band contour — the whole open sea.

**Root cause, one sentence:** a kind carried two depth bars — its habitat's
floor and its own reach demand — and every rule that decided where the animal
may GO knew about only the first.

---

## 2. The contract fix

### `MonsterProfile.range` — one regime that answers "where may this be"

- `habitat.ts:246` `habitatRangeOf(regime, thresholdBands)`: returns a
  `HabitatRegime` with the habitat's `id` and `inward` and the given threshold,
  clamped up to the habitat's own floor so a row can never *widen* a habitat.
  It **returns the regime object itself** when the threshold equals the
  habitat's, and caches otherwise, so identity is meaningful.
- `kinds.ts:835` `MonsterProfile.range`, `kinds.ts:945` `MonsterProfileRow`
  (`Omit<MonsterProfile,'range'>`) and `kinds.ts:989` `withRange` — the ONE
  place it is computed. The table is written as rows and each row is wrapped, so
  no row can state a range inconsistent with its own reach.
- **Cthulhu and the yeti are unchanged by identity, not by equivalence.**
  `profileOf('cthulhu').range === profileOf('cthulhu').habitat` and the same for
  the yeti — printed `true` in the verification output below. Cthulhu's
  `minLairReachBands` is `DEEP_WATER_BANDS_BELOW_SEA` (`kinds.ts:894`) and the
  yeti's `YETI_LAIR_MIN_HEIGHT_BANDS` is defined as `SNOW_LINE_BANDS_ABOVE_SEA`
  (`kinds.ts:635`), so `habitatRangeOf` hands both the same object they had
  before. Their movement runs the identical code over the identical value.

### `lurk.ts` — every call site decided, with the reason at the callsite

All four are the RANGE. There is no `profile.habitat` left in `lurk.ts`.

| line | call | why the range |
|---|---|---|
| `lurk.ts:175` | steering probe's `permits` | this is literally "where may it go"; reading the floor here IS the bug |
| `lurk.ts:258` | `isStranded` | "out of its element" must be the same set movement is confined to, or a kraken in 12-band water reports *not* stranded and then runs a certain-to-fail steering ladder every tick for the rest of its life, landing on the identical hold |
| `lurk.ts:329` | pinched-body clearance | must be the same set the probe uses, or a rim lapping the trench wall is permanently pinched by one test and permanently fine by the other |
| `lurk.ts:402` | destination re-check | it is the suspenders on "never outside the set it is confined to"; checked against a wider set it is not a check |

### Identity uses of `HabitatRegime` — checked, and left alone

`kinds.ts:1175` `KINDS_BY_HABITAT` and `kinds.ts:1196` `LAIR_FIT_RULES_BY_HABITAT`
are `Map`s keyed by the regime OBJECT; `habitat-index.ts:319` keys
`HabitatIndex.regimes` by `regime.id`; `habitat.ts:196` `habitatById` resolves
an id. A range carries its habitat's `id`, so handing one to any of these would
silently answer for the wrong regime. **None of them was changed** — they stay
keyed by `profile.habitat`, and the rule is stated on `habitatRangeOf` and again
on `MonsterProfile.range`.

`summoning.ts:603-609` `enforceHabitat` also deliberately stays the habitat
FLOOR. Asking the range there would make "a player raised the trench floor one
band" an eviction of the kraken — a departure rule the owner explicitly refused
on 2026-08-19 — reached by a side door. A kraken whose trench is filled in is
not banished; it is stranded (`lurk.ts:258`) and holds still. Demonstrated below.

---

## 3. The fit-rule finding (the brief's question)

**It was the floor.** The survey walk counted `fittingCells[rule]` off
`habitat-index.ts`'s `fit` bitmap, which `habitat-index.ts:290`
(`recomputeFitBit`) derived from the REGIME's `habitat` bitmap; the rule's
`minReachBands` was applied afterwards to the centre cell alone, producing the
second count `summonableCells`. So the survey reported that a kraken's 28-cell
body "fits" on cells whose surroundings were 12-band shallows.

That is the same defect one level up: a trench could be admitted for a body that
fits nowhere in it at trench depth, and the animal would live permanently in
`lurk.ts`'s clearance-0 pinched fallback — exactly the failure `fittingCells`
was added for the yeti to end.

**Fixed.** `LairFitRule` (`habitat.ts:642`) now carries BOTH bars:

- `rangeBands` (`habitat.ts:651`) — the pose is tested against
  `habitatRangeOf(regime, rangeBands)`. `habitat-index.ts:131` keeps one range
  bitmap per rule and `:141` `derivedRanges` lists the ones that are not simply
  the habitat array; both repair paths recompute them between the habitat pass
  and the fit pass.
- `minReachBands` — still the arrival bar, still applied to the candidate cell's
  own height, still what `summonableCells` and `summonCandidates` are drawn
  against.

`kinds.ts:1205` builds both from the profile, so neither number is stated twice.
`summoning.ts:798` (the live arrival re-check) was moved to `profile.range` to
match the bitmap; a disagreement there would mean `invalidateSurvey()` on every
roll, forever.

**Cost:** one extra `Uint8Array` per world for the kraken's range (the land
regime pays nothing — the yeti's range IS its habitat, so the array is the same
object), plus one byte written per diff cell per derived range in each repair
path. The fit pass itself is unchanged in cost.

---

## 4. The range bar is derived from the body, not set to the arrival bar

Making the fit rule ask the range exposed something the brief anticipated, and
the measurement made it much larger than expected.

**The arrival bar cannot be reused as the movement bar.** `minLairReachBands` is
a bar on ONE CELL: `summoning.ts:664` applies it to a region's single most
extreme cell and `:776` to the cell the animal lands on. A trench is a V, so its
deepest contour is a RIBBON whose width is fixed by the wall slope — genesis
cuts trench walls at `GENESIS_TERRACE_WALL_CELLS_PER_BAND = BAND_HEIGHT /
MAX_STEP` = **4 cells per band** (`server/src/world/genesis.ts:150`, applied to
the floor profile at `:1595`, against the floor depth of
`GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA` = 32 bands at `:1064`). So the ≥31-band
contour of a genesis trench is about 15 cells wide, and the kraken's body is
**28 cells across**. A range bar its body fits on nowhere is not "anywhere
inside that deep trench" — it is no kraken at all.

**The contract.** `kinds.ts:1000` `bodyReachBands`, subtracted in `withRange`:

```
range.thresholdBands = minLairReachBands − ceil(bodyRadiusCells / TRENCH_WALL_CELLS_PER_BAND)
```

A body on the contour reaches `bodyRadiusCells` out from its centre, and over
that distance the wall has climbed that many bands. This is a derivation, not a
dial, and the numbers on both sides of it come from the geometry:

- `TRENCH_WALL_CELLS_PER_BAND` (`kinds.ts:980`) is `BAND_HEIGHT / MAX_STEP` —
  **the same expression genesis cuts with**, not a restated number. Genesis's
  own copy is module-private (a bare `const` at `genesis.ts:150`, not exported)
  so it cannot be imported, and a plugin reaching into `server/src/world` for
  terrain shape would be the wrong direction regardless; but both operands come
  from `@terrace/shared`, the same module genesis takes them from, so the two
  expressions cannot drift unless someone edits one by hand. The comment names
  `genesis.ts:150` / `:1064` at the definition.
- It is the STEEPEST wall the engine permits (`MAX_STEP` is the gradient limit),
  so the subtraction is a worst case: a gentler trench only makes the relaxation
  more generous than it had to be.
- `ceil`, not `floor`. The rim probe furthest from the centre is a whole cell
  out, so a fractional band of climb is a band the body genuinely needs; rounding
  it down leaves the outermost probes on the wrong side of the range boundary on
  the steepest walls — the failure the subtraction exists to prevent.

At today's constants the kraken's is `ceil(14 / 4) = 4`, giving a range of **27
bands**.

**The floor clamp is in code, not in the arithmetic.** `habitatRangeOf`
(`habitat.ts:246`) takes `Math.max(thresholdBands, regime.thresholdBands)`, so a
range can never be shallower than its habitat's own floor. This is what makes
Cthulhu and the yeti untouched: both already sit at that threshold
(`kinds.ts:894`, `kinds.ts:635`), subtracting takes them below it, and the clamp
returns the habitat regime OBJECT — verified as `true` in the output below.

**No named constant was retuned.** `KRAKEN_LAIR_MIN_DEPTH_BANDS` still means what
it meant — where the kraken must RISE — and is unchanged at 31.

### Both bars, measured on genesis worlds

Twenty seeds at 512², through the plugin's own survey and all four of
`bestLairFor`'s gates (`summoning.ts:660-673`). The only difference between the
two columns is the kraken's `rangeBands`.

```
kraken: body 28 cells, arrival bar 31 bands, derived range 27 bands; needs 36864 region cells and 784 fitting cells
seed 7919: at 31 bands false (fit 0) | at 27 bands true (fit 1521, summonable 1109)
seed 15838: at 31 bands false (fit 0) | at 27 bands true (fit 3032, summonable 2324)
seed 23757: at 31 bands true (fit 18162) | at 27 bands true (fit 25306, summonable 24341)
seed 31676: at 31 bands true (fit 39253) | at 27 bands true (fit 50098, summonable 46984)
seed 39595: at 31 bands true (fit 12854) | at 27 bands true (fit 49387, summonable 32388)
seed 47514: at 31 bands false (fit 0) | at 27 bands true (fit 6194, summonable 3611)
seed 55433: at 31 bands true (fit 23600) | at 27 bands true (fit 32409, summonable 30718)
seed 63352: at 31 bands true (fit 45774) | at 27 bands true (fit 52996, summonable 52791)
seed 71271: at 31 bands true (fit 27321) | at 27 bands true (fit 35228, summonable 33827)
seed 79190: at 31 bands true (fit 861) | at 27 bands true (fit 4955, summonable 3442)
seed 87109: at 31 bands false (fit 0) | at 27 bands true (fit 1306, summonable 1039)
seed 95028: at 31 bands false (fit 7) | at 27 bands true (fit 4646, summonable 3486)
seed 102947: at 31 bands true (fit 40893) | at 27 bands true (fit 45829, summonable 45496)
seed 110866: at 31 bands false (fit 10) | at 27 bands true (fit 6367, summonable 4678)
seed 118785: at 31 bands false (fit 0) | at 27 bands true (fit 2485, summonable 1906)
seed 126704: at 31 bands false (fit 0) | at 27 bands true (fit 4804, summonable 3661)
seed 134623: at 31 bands false (fit 0) | at 27 bands true (fit 3457, summonable 1816)
seed 142542: at 31 bands true (fit 35281) | at 27 bands true (fit 40060, summonable 39693)
seed 150461: at 31 bands false (fit 150) | at 27 bands true (fit 3666, summonable 1976)
seed 158380: at 31 bands false (fit 15) | at 27 bands true (fit 5921, summonable 4136)
admitted at the 31-band bar: 9/20
admitted at the derived 27-band bar: 20/20
cthulhu range === habitat: true; yeti range === habitat: true
```

**Nine of twenty against twenty of twenty.** The naive contract — range bar at
the admission reach — would have removed the kraken from more than half of all
fresh worlds. The derived bar keeps every one of them, and the owner's
2026-08-19 ruling that a natural ocean floor admits the kraken with no digging
survives intact.

`KRAKEN_MIN_LAIR_FITTING_CELLS` was NOT retuned. It is `ceil(28²) = 784`, one
body's worth of room to roam, and every seed clears it — the thinnest margin in
the table is seed 7919's 1 521, roughly twice the bar.

**Residual, stated rather than papered over.** The relaxation is derived from the
STEEPEST wall genesis can cut. A trench cut by a player with a shallower profile
has a wider contour and is more permissive than this arithmetic assumes, which
is the safe direction. The unsafe direction — a wall steeper than `MAX_STEP` —
cannot exist: `MAX_STEP` is the gradient limit relaxation enforces.

---

## 5. Persistence

`persistence.ts:255-257` states that a restored monster is trusted to be where
it was and that the first tick's `enforceHabitat` handles a changed world. With
confinement, a kraken restored from a pre-confinement snapshot can be inside its
habitat and outside its range. Verified live (output below, third line):
`enforceHabitat` returns false (it asks the floor, `summoning.ts:609`), the
monster stays alive, and across 12 000 ticks it never moves — the existing
stranded path at `lurk.ts:258`, no crash, no teleport.

---

## 6. Verification

`pnpm --filter @terrace/plugin-monsters typecheck` — clean.
`pnpm typecheck` (worktree root, all packages) — clean, no errors.
`npx vitest run --root plugins/monsters` — **193 passed, 0 failed** (2 files).

The demonstration script (a 96² sea at the habitat floor with a round basin at
the kraken's own depth, 20 simulated minutes at 10 Hz through `advanceLurking`
with the plugin's own seeded RNG):

```
BAND_HEIGHT=16 SEA_LEVEL=0
habitat floor = 12 bands (h=-192); kraken arrival bar = 31 bands (h=-496)
kraken range threshold = 27 bands; cthulhu range === habitat: true; yeti range === habitat: true
basin radius 12 cells, sea 96² cells, 12000 ticks @ 10 Hz
restored-outside-range kraken: banished = false, still alive = true, moved = false, on shelf (habitat, not range) = true
kraken: ticks outside basin = 0, max distance from centre = 3.07 cells, ticks that moved = 10871, final = (48.68, 48.68)
cthulhu: ticks outside basin = 11878, max distance from centre = 37.44 cells, ticks that moved = 8590, final = (22.36, 56.90)
```

The kraken moved on 10 871 of 12 000 ticks and never once left the basin.
Cthulhu, on the same world, spent 11 878 of 12 000 ticks outside it and reached
37 cells from the centre — the open sea is still his. Both scripts were deleted
before the final commit.

---

## 7. Tests changed, and why

No test file and no test case was added. Four existing pins were updated; all
four were pinning fixture geometry that confinement invalidated, not behaviour
the owner asked for.

1. **`KRAKEN_TRENCH_DEPTH_MARGIN` → derived** (`monsters.test.ts:804-830`). It
   was the literal `64`, which the fixture's own comment already recorded as
   having been raised once (2026-08-20) when the re-terrace collapsed the
   qualifying pocket. 64 buys a 28-cell pocket: enough distinct cells for the
   summon-spread tests, and not enough for a 28-cell body to FIT once the pocket
   became the animal's whole range. It is now solved from
   `KRAKEN_TRENCH_POCKET_RADIUS_CELLS` = `3 · bodyRadiusCells` — a pocket of
   radius `p` has a fitting core of radius `p − bodyRadius`, so clearing
   `π·bodyRadius²` needs `p ≥ bodyRadius·(1+√π) ≈ 2.8·bodyRadius`. Nine tests
   were failing on this one fixture.
2. **`channelWorld`'s floor → the kraken's range boundary**
   (`monsters.test.ts:2906-2929`). It cut the channel to `DEEP_WATER_MAX_HEIGHT`,
   the habitat's shallowest line. Every case in that block steers a kraken, so
   after confinement such a channel is not a pinched kraken but a STRANDED one,
   which holds still by design — the "lets an already-pinched body swim out
   instead of freezing" test would have been asserting the wrong mechanism. The
   pose answers in that block are unchanged; only the depth is.
3. **The puddle guard's factor → `PUDDLE_MAX_SHARE_OF_ARRIVAL_BAR = 1/4`**
   (`monsters.test.ts:1115`, used at `:1141`). It was
   `KRAKEN_MIN_LAIR_DEEP_CELLS / 10`. The puddle is not a chosen size — it is the
   smallest pool guaranteed to still cover wherever in the summon pocket the draw
   put the animal — and since that pocket is now derived from the body, the pool
   is ~6 400 cells against a 36 864-cell bar (17 %). A quarter is the nearest
   round bound above it and is exactly the ratio
   `LAIR_COLLAPSE_HYSTERESIS_DIVISOR` (`kinds.ts:663`) uses, so the guard still
   fails loudly if a region-size eviction is ever reintroduced.
4. **`habitatBoundaryHeight` added to the test's imports** — mechanical, for (2).

Nothing that pinned the OLD behaviour ("kraken free in shallow water") existed to
update: no test ever asserted that the kraken could leave its trench. That
absence is itself worth noting — it is why the bug shipped.

---

## 8. Behaviours now UNTESTED (no-new-tests rule)

Every one of these is verified in this session by the demonstration script or by
direct measurement, and none of it is pinned in the suite. Listed so the owner
can grant permission for the ones worth keeping.

1. **The confinement invariant itself.** "A kraken advanced for N ticks in a sea
   containing a trench never leaves the trench." This is the owner's whole ask
   and there is no test for it. The strongest candidate for permission.
2. **`range === habitat` for Cthulhu and the yeti**, by object identity. This is
   what makes "their behaviour did not change" a fact rather than a claim, and it
   is a two-line assertion.
3. **`habitatRangeOf`'s clamp** — a rule demanding less than its habitat's floor
   must not widen the habitat. Currently only reachable through a hypothetical
   row; the guard is untested.
4. **The range bitmap's repair paths.** That `noteTerrainChangedInIndex` and
   `applyNewlyUnlockedChunks` leave the derived range arrays byte-for-byte equal
   to a fresh `buildHabitatIndex` — the same property the fit bitmaps have, now
   with a second layer under them. A sculpt that lifts a trench floor out of the
   kraken's range while leaving it deep water moves a range bit and NOT a habitat
   bit, which is a path nothing exercises.
5. **The fit rule's two bars being two.** That `summonableCells < fittingCells`
   for the kraken (every genesis row in the section 4 table shows the gap) and
   that they are equal for the yeti.
6. **The restored-outside-range kraken**: not banished, not crashed, held still.
   Verified live; the persistence tests cover the round trip but not this state.
7. **Genesis admission.** That a fresh world still admits the kraken. Measured
   at 20/20 here; nothing in the suite would notice if it went to 0/20 — the
   existing `summons a kraken into a natural-floor trench` test uses a stubbed
   cone, not the generator. Given that the naive bar scored 9/20 and no test
   moved, this is the gap that would have let the regression ship.
8. **`bodyReachBands` itself** — that the range bar is the arrival bar minus the
   bands of wall the body climbs, and that it tracks `BAND_HEIGHT` / `MAX_STEP`
   rather than being pinned to 27.

---

## 9. Boats

Untouched, as instructed. `plugins/boats` finds the kraken by position, and
confinement does not change how a position is published.
