# Report: rain and snow storms cover 3× the area at spawn

Owner ask (2026-09-04): "grow the size of the rain and snowstorms. I want them to
cover three times as much area when they spawn."

## Commit

- Branch: `worktree-agent-a9ecd9a26353b96a1` (worktree
  `.claude/worktrees/agent-a9ecd9a26353b96a1`), off `517d051`.
- Commit: `928db13` — `feat(storms): rain and snow fronts cover three times the
  area`. (The report was staged in that commit; this one line, its own hash, was
  written in immediately after and amended on top.)
- Not merged into main. `ExitWorktree` called with `action: "keep"`.

## The contract change

One new optional field on the shared disc spec, defaulting to the old
behaviour, plus one derivation helper.

- `server/src/plugins/kit/discSystems.ts:145` —
  `DISC_DEFAULT_FOOTPRINT_AREA_SCALE = 1`. It is exactly 1 so that
  `Math.sqrt(1) === 1` and multiplying a radius by it is exact in IEEE: fog and
  thunderstorm draw bit-for-bit the radii they drew before the option existed.
- `server/src/plugins/kit/discSystems.ts:157` —
  `discRadiusFactorFor(footprintAreaScale) => Math.sqrt(footprintAreaScale)`.
  The caller states an AREA; the kit derives the radius. `Math.sqrt` is
  exactly-specified IEEE, which is what `CLAUDE.md`'s determinism rule permits,
  and the resulting radius reaches the wire already rounded by
  `roundBroadcastPosition` (`states`, `discSystems.ts:704`).
- `server/src/plugins/kit/discSystems.ts:300` — `DiscSystemsSpec.footprintAreaScale?: number`.
- `server/src/plugins/kit/discSystems.ts:395` — `discMinRadiusFor(scale)` (new).
- `server/src/plugins/kit/discSystems.ts:407` — `discMaxRadiusFor(worldSize, scale)`;
  the world-fraction ceiling is applied AFTER the scale, so it outranks it.
- `server/src/plugins/kit/discSystems.ts:422` — `discMeanRadiusFor(worldSize, scale)`.
- `server/src/plugins/kit/discSystems.ts:521` — the factory resolves the scale
  once; the three radius draws (`spawnOne` 577, `advanceForced` 560, `spawnAt`
  635) go through it.
- `discActiveCapFor` (`discSystems.ts:488`) is UNCHANGED and takes no scale —
  deliberately; see below.

Wiring:

- `plugins/rain/protocol.ts:97` — `RAIN_FOOTPRINT_AREA_SCALE = 3`.
- `plugins/snow/protocol.ts:75` — `SNOW_FOOTPRINT_AREA_SCALE = 3`.
- `plugins/rain/server/index.ts:98`, `plugins/snow/server/index.ts:96` — the two
  `createDiscSystems({...})` calls pass it.

Fog and thunderstorm were not touched in any file; their populations omit the
field and take the default.

## Radius band, old → new

Measured by running the shipped kit (`node --experimental-strip-types`), not by
hand arithmetic:

| World | scale | band (cells) | band (world units) |
|---|---|---|---|
| shipped, 2048 cells (512 u) | 1 (fog, thunderstorm) | 96.00 – 224.00 | 24.00 – 56.00 |
| shipped, 2048 cells (512 u) | 3 (rain, snow) | 166.28 – 387.98 | 41.57 – 96.99 |
| 128-unit, 512 cells | 1 | 96.00 – 179.20 | 24.00 – 44.80 |
| 128-unit, 512 cells | 3 | 166.28 – 179.20 | 41.57 – 44.80 |

`DISC_MAX_RADIUS_WORLD_FRACTION` (0.35) STILL BINDS on a 128-unit world: the
ceiling there is 0.35 × 512 = 179.20 cells, well below the 387.98 the scale would
otherwise ask for, so the largest front's diameter is still exactly 70% of the
world edge and there is still somewhere to stand. On such a world an enlarged
population's band is nearly a single size (166.28 – 179.20) — narrower, not
broken. On the shipped world the fraction still never binds (0.35 × 2048 = 717 ≫
388).

## How the storm count was kept

`discActiveCapFor` derives the population from `coverageFraction` over the mean
footprint of a BASE-SIZE disc, and it is blind to `footprintAreaScale`. That is
the one deliberate asymmetry in the kit and it is documented at
`server/src/plugins/kit/discSystems.ts:469-487`.

Before/after `capFor`, measured from the shipped kit:

| | rain (0.09, ceiling 7) | snow (0.027, ceiling 2) |
|---|---|---|
| shipped 2048-cell world, before | 7 | 2 |
| shipped 2048-cell world, after | 7 | 2 |
| 128-unit world, before | 1 | 1 |
| 128-unit world, after | 1 | 1 |

Unchanged by construction, on every world, because the derivation never sees the
scale. What DOES change is the realised share of the map under weather —
`coverageFraction × footprintAreaScale`: rain 0.09 → 0.27, snow 0.027 → 0.081
(snow's remains an upper bound on a low world, for the siting reason its protocol
already stated).

**Rejected alternative:** derive the cap from `coverageFraction × areaScale` over
the SCALED footprint. It looks equivalent and is not — the scaled band is clamped
by `DISC_MAX_RADIUS_WORLD_FRACTION` and the scaled mean radius also widens the
spawn field, so the two scalings do not cancel. Computed: on a 128-unit world at
scale 3 it asks for **2** rain systems where the base derivation asks for 1. A
population that changes because a size changed is exactly the coupling the
asymmetry exists to break. Documented in the code as REJECTED, with that number.

## Client budget decision

**Density per cell is the invariant; the per-system count follows the area.**

`RAIN_DROP_COUNT`'s own rationale justifies 900 as a DENSITY ("one drop per two
cells to one per eleven … the density at which the eye reads 'it is raining'"),
and particles are seeded uniformly by AREA over the disc
(`client/src/plugins/kit/precipitation.ts`, `seedRadius`, verified at :152). Holding the count fixed while tripling the area would divide that
density by three — a front you can see straight through, which is a thinning
nobody asked for.

| | before | after | at plugin cap |
|---|---|---|---|
| rain drops / rig | 900 | 2 700 | 7 rigs → 6 300 → 18 900 |
| rain vertex upload / frame | ~151 KB | ~454 KB | (2 verts × 3 floats × 4 B) |
| snow flakes / rig | 700 | 2 100 | 2 rigs → 1 400 → 4 200 |
| draw calls | unchanged | unchanged | 5 per rig + 1 deck |
| cumulus puffs / mass | 139 rain / 119 snow | 139 / 119 | unchanged |

- `plugins/rain/client/rig.ts:50,72` — `RAIN_DROP_COUNT_AT_BASE_FOOTPRINT = 900`
  (local, unexported) × `RAIN_FOOTPRINT_AREA_SCALE`.
- `plugins/snow/client/rig.ts:41,58` — same shape, 700 × 3.
- The **cumulus deck needs no change**, and I verified why rather than assuming
  it: `puffsForCoverage(sizeFraction)` (`client/src/plugins/kit/cumulusDeck.ts:286`)
  derives the count from a FRACTION of the radius alone, so an enlarged mass gets
  the same 139/119 puffs, each grown with it. Texture per unit of cloud is
  identical and the instance buffer does not move. Same for the haze bank, whose
  sheets are scaled by `worldRadius` at `update` time.

Against the 140 fps / ≈7 ms benchmark this is a deliberate purchase: three times
the sky under a front costs three times the drops in it. **UNVERIFIED —** these
are counted, not profiled; I did not start the app (forbidden by the brief) and
have no frame-time measurement. If rain at 7 concurrent fronts turns out to cost
more than the budget allows, the lever is `RAIN_DROP_COUNT_AT_BASE_FOOTPRINT`,
which is now a single named local.

## Rationale comments rewritten

Every one of these was falsified by the change and was rewritten to be true, not
appended to:

1. `server/src/plugins/kit/discSystems.ts:116-131` — the radius band is now the
   BASE band; says so and names the option.
2. `server/src/plugins/kit/discSystems.ts:135-166` — new:
   `DISC_DEFAULT_FOOTPRINT_AREA_SCALE`, `discRadiusFactorFor`.
3. `server/src/plugins/kit/discSystems.ts` (`DISC_MAX_RADIUS_WORLD_FRACTION`) —
   the old text said "on the nominal world it never binds (0.35 × 512 = 179 ≫
   56)", which silently mixed cells and world units. Restated in one unit
   (0.35 × 2048 = 717 ≫ 224) and extended to say the ceiling outranks the scale,
   with the 128-unit numbers.
4. `DiscSystemsSpec.coverageFraction` doc — now states that a population with a
   footprint scale covers `coverageFraction × scale`.
5. `discMeanFootprintCells` doc — now says BASE SIZE and why.
6. `discActiveCapFor` doc — the "how many" derivation, the deliberate blindness
   to the scale, and the rejected alternative with its number.
7. `plugins/rain/server/index.ts` (`BROADCAST_TICK_INTERVAL`) — the old text
   said "the wind's ceiling is 2 cells/s, so a system moves at most 2 cells
   between messages — 8% of the SMALLEST system's 24-cell radius". Two of those
   three numbers were world units labelled as cells: the ceiling is
   `cellsAcross(2) = 8` cells/s (`plugins/weather/server/wind.ts:40`, verified)
   and the base floor is 96 cells. Restated in cells throughout, and the ratio
   updated: 8/166.28 is now under 5% where it was 8% of the base floor. The
   cadence conclusion is unchanged and now more conservative.
8. `plugins/snow/server/siting.ts` (`SNOW_ELEVATION_SAMPLE_OFFSETS`) — "would
   qualify a system 50 cells across" was already wrong in units and is now wrong
   in magnitude; restated as a 388-cell radius (was 224), plus why five samples
   is still the right number after the enlargement (the offsets are FRACTIONS of
   the radius) and the accepted consequence: a larger candidate straddles a coast
   more often, is refused, and is handed to rain.
9. `plugins/rain/client/rig.ts` and `plugins/snow/client/rig.ts` — the drop/flake
   count rationale, the density-vs-count decision, and the note that the cumulus
   puff count is untouched and why.

## Test assertions changed

No tests added (owner rule). Exactly one existing assertion encoded the old band:

- `plugins/rain/test/rain.test.ts:148-149` (old) —
  `system.radius < DISC_SYSTEM_MIN_RADIUS_CELLS || system.radius > DISC_SYSTEM_MAX_RADIUS_CELLS`
  → now `system.radius < minRadius || system.radius > maxRadius`, with
  `minRadius = discMinRadiusFor(RAIN_FOOTPRINT_AREA_SCALE)` and
  `maxRadius = discMaxRadiusFor(WORLD_SIZE, RAIN_FOOTPRINT_AREA_SCALE)` bound
  just above the loop. Old expectation: 96 – 224 cells. New: 166.28 – 387.98 on
  this suite's 2048-cell world. Stated through the kit's own helpers rather than
  as literals, so it stays true on any world and at any scale. Imports adjusted
  accordingly.

Deliberately NOT changed: `server/test/plugin-kit-disc-systems.test.ts:102-103`
still asserts the BASE band against `DISC_SYSTEM_MIN/MAX_RADIUS_CELLS`, and it
passes untouched — which is the evidence that a population without the option is
byte-for-byte what it was. Same for `plugins/fog` and `plugins/thunderstorm`.

## Verification run

All green in this worktree (`pnpm install --frozen-lockfile` was needed first —
the worktree had no `node_modules`; no dependency was added or changed):

- `pnpm typecheck` — all 27 projects Done.
- `timeout 300 pnpm --filter ./plugins/rain test` — 31 passed (2 files).
- `timeout 300 pnpm --filter ./plugins/snow test` — 11 passed.
- `timeout 300 pnpm --filter ./plugins/fog test` — 7 passed, untouched.
- `timeout 300 pnpm --filter ./plugins/thunderstorm test` — 17 passed, untouched.
- `timeout 600 pnpm --filter ./server test` — 342 passed (29 files).

## Assumptions, flagged

1. **The owner wants bigger storms, not fewer.** The ask names the storms'
   SIZE; nothing in it asks for a quieter sky. Everything above follows from
   reading it that way. The consequence, stated plainly so it can be rejected:
   the shipped world's rain coverage goes from 9% to 27% of the map and snow's
   from 2.7% to 8.1%, so the sky is genuinely wetter, not merely lumpier. If the
   owner wanted total coverage held constant, the change is one line — pass the
   scale into `discActiveCapFor` — and the count drops to a third.
2. **Assumption: the "three times as much area" is the disc's footprint**, not
   its on-screen silhouette or its diameter. Area is what the word says and it is
   what the constant now names.
3. **Unverified: the client cost.** Counted, not profiled — see the budget
   section. I did not start the app.
4. **Unverified: how much more often snow siting refuses a candidate.** A larger
   candidate samples ground further out, so refusals (and hand-offs to rain)
   rise on a world with only a small massif. The mechanism is verified at
   `plugins/snow/server/siting.ts:100-107`; the RATE is not measured, and it is
   world-shape dependent, so no number is claimed.

## Left undone, explicitly

- No visual confirmation. The brief forbids starting the app and screenshots, so
  nobody has yet looked at a 97-world-unit rain front from the camera's 80-unit
  orbit. That is the one check this change most wants and it is not done.
- `docs/DESIGN.md` and `docs/decisions/storms-and-mudslides.md` were read and
  NOT appended to, per the brief and `CLAUDE.md`. If the owner wants the
  coverage change (0.18 → 0.36 across the four kinds) in the decision record,
  that is their call to make and their permission to give.
- The two `*_FOOTPRINT_AREA_SCALE` constants are duplicated across rain and snow
  rather than shared. That is forced: a plugin may not import another plugin's
  protocol (stated at the head of both files), and the kit-level default belongs
  to the kit. They are one ask today and two independent dials tomorrow.
