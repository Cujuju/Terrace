# Report — #301 a mudslide's scar is at the rim

Worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/mudslide-301-fix`,
branch `worktree-mudslide-301-fix`, based on `f72a6ae` (origin/main at entry — it
does not contain main's later `78b68a0`). NOT merged.

Commits:

- `29322cd` — `fix(mudslides): a site is a rim, not the tread behind one`

## The change, file:line

All line numbers are post-change, in the worktree.

| File | Line | Change |
| --- | --- | --- |
| `plugins/mudslides/protocol.ts` | 121–145 | `MUDSLIDE_MAX_DROP_PER_CELL = MAX_STEP + RELAX_SLACK` split out of the span figure and re-documented; both scales now carry a threshold. |
| `plugins/mudslides/protocol.ts` | 147–148 | `MUDSLIDE_MAX_DROP_OVER_SPAN` derives from it, value unchanged (40). |
| `plugins/mudslides/protocol.ts` | 150–171 | `MUDSLIDE_TRIGGER_STEEPNESS` doc rewritten: it is now the SECONDARY test ("there is somewhere for the mud to go"), with the measured figure moved to the new constant. |
| `plugins/mudslides/protocol.ts` | 173–201 | NEW `MUDSLIDE_RIM_STEEPNESS = 0.6` and `MUDSLIDE_RIM_DROP = ceil(5 × 0.6) = 3`, with the value's reasoning and the re-measured qualifying fraction. |
| `plugins/mudslides/server/terrain.ts` | 13 | imports `MUDSLIDE_RIM_DROP`. |
| `plugins/mudslides/server/terrain.ts` | 174–207 | `slopeAt`'s doc rewritten: two tests, why the local one defines a site, and the diagonal caveat now covers both scales. |
| `plugins/mudslides/server/terrain.ts` | 208–240 | `slopeAt` measures the span drop and the one-cell drop in ONE pass over the same fixed `NEIGHBOUR_OFFSETS`, returns `localDrop` as well, and rejects on `bestLocalDrop < MUDSLIDE_RIM_DROP` before the span test. |
| `plugins/mudslides/server/slides.ts` | 96–111 | `MUDSLIDE_SURVEY_SAMPLES` doc: why it stays at 64 and what the narrower contract costs (fill time, not arrival rate). |
| `plugins/mudslides/server/slides.ts` | 247–258 | `MUDSLIDE_HEAD_SCOUR_STEPS`'s "the scarp deepens" claim: says why the cell it deepens really is the scarp now. |
| `plugins/mudslides/server/dev.ts` | 54 | stops importing the kit's `DEV_SEARCH_STEP_CELLS`. |
| `plugins/mudslides/server/dev.ts` | 87–114 | NEW local `DEV_RIM_SCAN_STEP_CELLS = 1`, with the measurement that forced it; the re-export comment says why the kit's step still fits the kit's own ring search. |
| `plugins/mudslides/server/dev.ts` | 178–192 | `scanForSite` doc: one definition of "steep" (it is `slopeAt`), and why longest-run scoring no longer prefers the tread. |
| `plugins/mudslides/server/dev.ts` | 207–208 | the scan steps by `DEV_RIM_SCAN_STEP_CELLS`. |

### The two doc claims the diagnosis found false

- **`terrain.ts` "the bearing that gives the drop is the bearing the mud will
  take"** — MADE TRUE, not merely rewritten. `dx/dy` is kept (it is not on the
  wire; `MudslideFlowEvent` carries only `headX/headY`, and no caller reads
  `.dx`/`.dy` today) and now reports the LOCAL one-cell bearing instead of the
  span bearing. That bearing is exactly what `nextFlowCell` picks — same eight
  offsets, same lowest-neighbour rule, same first-wins tie-break — so the
  sentence is now a statement about the code, qualified in the doc by the one
  difference that remains: `nextFlowCell` also applies the water/locked/visited
  stop tests.
- **`slides.ts` "the scarp deepens while the front is already running"** —
  rewritten to say what it now does and why it used to be true only by
  coincidence.

## Proof

Rig: `.verify-301/transect.mjs` (throwaway, in the worktree, NOT committed; the
pre-fix column comes from `git archive HEAD` of the base commit into
`.verify-301/before/` with `node_modules` symlinked). No browser, no server: the
rig builds a `World.createFresh(2048, …, seed 20260902)`, unlocks every chunk and
drives the plugin's own `startSlide` / `advanceSlides` / `flowEventFor` through a
plain `MudslideWorld` object literal.

Fixture: the rig finds a plateau rim by pure geometry — a cell whose eight
neighbours and whose ten up-transect cells all sit within `MAX_STEP` of it (flat
tread), which never climbs back above the rim down-transect and has fallen by
`MUDSLIDE_TRIGGER_DROP` by the far end. Same rim, same transect, both runs:
**(1549, 515), bearing (1, 1)**, k < 0 = tread, k = 0 = rim, k > 0 = face.

One preparation step, applied identically in both runs: a single `+12` raise at
radius 16, 14 cells back from the rim, through the world's own sculpt path. It is
needed because FRESH genesis ground is quantised to whole terrace bands — every
one-cell drop on it is 0, 16 or 32 — so a plateau's tread is EXACTLY flat and
`nextFlowCell` refuses to start a slide there under either contract. Real ground
is not: relaxation, player brushes and earlier slides leave treads with gradients
of one or two height units, which is the ground the owner reported the bug on.
The raise leaves the tread with one- and two-unit drops and does not touch the
rim or the face.

The slide is started at the innermost transect cell the plugin's own contract
admits AND `startSlide` accepts — the draw the survey makes uniformly.

### Transect, before (base `f72a6ae`) and after (`29322cd`)

`site?` = does `slopeAt` admit this cell. `scour` = delta at the end of the
three-step head scour. `final` = delta when the slide finished.

| k | cell | height | 1-cell drop | site? before | site? after | scour before | scour after | final before | final after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| -10 | 1539,505 | 264 | 2 | yes | **no** | **-36** | 0 | +8 | 0 |
| -9 | 1540,506 | 262 | 0 | yes | no | -32 | 0 | +9 | 0 |
| -8 | 1541,507 | 262 | 1 | yes | no | -24 | 0 | +9 | 0 |
| -7 | 1542,508 | 261 | 2 | yes | no | -14 | 0 | +5 | 0 |
| -6 | 1543,509 | 259 | 0 | yes | no | -3 | 0 | +1 | 0 |
| -5 | 1544,510 | 259 | 2 | yes | no | 0 | 0 | 0 | 0 |
| -4 | 1545,511 | 257 | 1 | yes | no | 0 | -1 | 0 | -1 |
| -3 | 1546,512 | 256 | 0 | yes | no | 0 | -14 | 0 | -7 |
| -2 | 1547,513 | 256 | 0 | yes | no | 0 | -23 | 0 | -4 |
| -1 | 1548,514 | 256 | 0 | yes | no | 0 | -31 | 0 | -3 |
| **0 (rim)** | 1549,515 | 256 | **16** | yes | **yes** | **0** | **-38** | **0** | **-8** |
| 1 | 1550,516 | 240 | 16 | yes | yes | 0 | -29 | 0 | -1 |
| 2 | 1551,517 | 224 | 0 | yes | no | 0 | -17 | 0 | +5 |
| 3 | 1552,518 | 224 | 16 | yes | yes | 0 | -15 | 0 | -4 |
| 4 | 1553,519 | 208 | 0 | yes | no | 0 | +5 | 0 | +4 |
| 5 | 1554,520 | 208 | 16 | yes | yes | 0 | 0 | 0 | -1 |
| 6 | 1555,521 | 192 | 0 | yes | no | 0 | 0 | 0 | +5 |
| 7 | 1556,522 | 192 | 16 | yes | yes | 0 | 0 | 0 | 0 |
| 8 | 1557,523 | 176 | 0 | yes | no | 0 | 0 | 0 | +2 |
| 9 | 1558,524 | 176 | 16 | yes | yes | 0 | 0 | 0 | 0 |
| 10 | 1559,525 | 160 | 0 | yes | no | 0 | 0 | 0 | 0 |

| Claim (diagnosis §4) | Before | After |
| --- | --- | --- |
| Flow event head | (1539, 505) = **k = -10**, ten cells inside the rim | (1549, 515) = **k = 0**, the rim |
| Head == transect cell of maximal one-cell downhill drop (±1) | NO — the max-drop cell is k = 0, the head is k = -10 | **YES** — both k = 0 |
| Most-negative delta at that cell ±1 | scour −36 at k = -10; rim delta 0 | **YES** — most-negative scour (−38) and most-negative final (−8) both at k = 0 |
| Every transect cell more than `MUDSLIDE_BRUSH_RADIUS_CELLS` (6) inside the rim has delta 0 | NO — **4** such cells moved | **YES** — 0 such cells moved |
| `volumeMoved` same order of magnitude | 1848 | **1848** |
| Same seed twice → byte-identical `event.cells` | IDENTICAL | **IDENTICAL** |

Both runs stopped `basin` with a 2–3 cell path: on this world the mud has nowhere
far to run, so the run-out drops most of its load back around the head — which is
why the `final` column is shallower than `scour` and why `scour` is the column
that shows where the ground actually broke. The `site?` columns are the contract
change on its own: before, all 21 transect cells were sites, including ten cells
of flat tread; after, only the rim and the risers below it are.

Dev fixture, same world, same preparation (`forceSlideNear` at the rim):

| | site chosen | its own one-cell drop | run | scan time |
| --- | --- | --- | --- | --- |
| before | (1529, 507) | 5 | 13 cells | 192 ms |
| after | (1536, 501) | 4 | 14 cells | 128 ms |

Both land on a face (the prepared dome's flank, which is the longest run inside
the 48-cell anchor radius) rather than on the plateau's own rim — longest-run
scoring still chooses BETWEEN faces, which is what it is for. What changed is
that it can no longer choose tread at all, because `slopeAt` is now its only site
test. A full-resolution scan of a 321-cell square costs 128–192 ms on a fixture
world, once per force.

### The 4-cell grid could miss a rim — how it was handled

Measured, not argued: in one dev search square of a default-size world there are
2338 qualifying cells and only **7%** of them sit on the kit's 4-cell grid, so a
rim that weaves between the samples is missed entirely. The reason is that on
genesis ground a rim is a contour line ONE CELL wide (one-cell drops are 0, 16 or
32 — there is no four-cell-wide face to catch). The scan therefore steps by a
named local constant `DEV_RIM_SCAN_STEP_CELLS = 1` (dev.ts:114) instead of the
kit's `DEV_SEARCH_STEP_CELLS`, which stays right for the kit's own ring search —
that one is looking for a REGION (open water, land), not a one-cell feature.

## Recalibration

Measured with `.verify-301/measure2.mjs` over the population the old figure was
measured over — the cells of a fresh world's revealed square
(`INITIAL_UNLOCK_CHUNK_SPAN × CHUNK_SIZE = 320²`), on default-size (2048²)
worlds:

| seed | old: span test alone | new: span + rim | new / old |
| --- | --- | --- | --- |
| 7 | 1 revealed cell in **39.9** | 1 in **105.8** | 37.7% |
| 99991 | 1 in 33.0 | 1 in 88.1 | 37.4% |
| 20260902 (unusually landy) | 1 in 3.4 | 1 in 9.6 | 35.5% |

Seeds 7 and 99991 reproduce the doc's existing "one unlocked cell in forty",
which is what validates the method. The rewritten doc quotes **one revealed cell
in ninety to a hundred**.

The value of `MUDSLIDE_RIM_STEEPNESS` is not observable on fresh ground: every
one-cell drop on a genesis world is 0, 16 or 32, so every fraction in (0, 1]
admits exactly the same set. It decides what counts as a rim on RELAXED or
sculpted ground, where drops of 1–5 exist; 0.6 → 3 is the first drop past half
the legal gradient, so a slope relaxation has nearly finished flattening is tread
and one still standing at or near the limit is a face.

**Frequency tiers: unchanged, deliberately.** `FREQUENCY_INTERVAL_MULTIPLIERS`
(slides.ts:204) multiplies a mean interval; the qualifying fraction reaches the
arrival rate only through `saturatedFraction`, which is measured against
`MAX_TRACKED_SITES` (96) and not against the table's size. A site set that is
2.6× rarer per sample still fills a 96-slot table on any world with rims in the
revealed square — what changes is the FILL TIME, from a few minutes of play to
several. `MUDSLIDE_SURVEY_SAMPLES` was left at 64 for the same reason: raising it
to hold the fill time constant would be tuning the survey to hide a change the
owner asked for. Both decisions are written into the doc comments.

## Verification

`pnpm --filter @terrace/plugin-mudslides test`:

```
> vitest run --passWithNoTests
 RUN  v4.1.10 …/plugins/mudslides
No test files found, exiting with code 0
```

The mudslides package ships no tests — none were added (owner rule), and none
pinned the old contract.

`pnpm typecheck` (all 24 workspace packages):

```
plugins/weather typecheck: Done
server typecheck: Done
plugins/wildlife typecheck: Done
```

No errors on any package.

## Left undone / residuals

- **No test covers the new contract.** Adding one needs the owner's permission
  in-session; the brief forbade it. The contract-level test that belongs here is
  "`slopeAt` admits a cell iff its own one-cell drop ≥ `MUDSLIDE_RIM_DROP` and
  its span drop ≥ `MUDSLIDE_TRIGGER_DROP`", over a hand-built `MudslideWorld`
  literal — the plugin has no test file at all today.
- **`slopeAt`'s `dx`/`dy` still has no reader.** Kept per the brief; it is now a
  true statement about the flow direction rather than a false one, but nothing
  consumes it.
- **A slide's run-out buries its own scar when the run is short** (2–3 cells,
  `stop: basin` — every plateau rim on the measured genesis worlds). That is the
  mass ledger doing its job, not #301, and the brief ruled the deposit ledger out
  of scope. If the owner wants the scar to stay visible, the question is whether
  the toe lobe should refuse cells within the head's brush footprint — a separate
  decision.
- **The dev fixture still scores by run length**, so a forced slide lands on the
  longest-running face within the anchor radius, which need not be the nearest
  rim to where the developer is looking.
- `.verify-301/` (rig, pre-fix tree, measurement scripts) is untracked and must
  not be committed; `node_modules` was installed in the worktree to run it.
