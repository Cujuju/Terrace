# Brief — four new wildlife species (server side) + grazer speed (arc `wildlife-species`)

You are a fresh Opus implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/wildlife-species`
(branch `wildlife-species`, forked from main). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/wildlife-species" })`.
If `node_modules` is missing in the worktree, run `pnpm install --offline`
there (several minutes on this drive; background it and poll). Paths below
are relative to the worktree root. Commit to the worktree branch as you go
(conventional commits, first line < 72 chars, no attribution footers, stage
exact paths only). Do NOT merge to main. Do NOT start or stop any app
stack. Do NOT touch `docs/**`, `shared/**`, `.claude/**` (except your
report), or any plugin other than `plugins/wildlife`. Do NOT write any 3D
model geometry — the orchestrator is authoring every model in
`plugins/wildlife/client/species/<name>.ts` in parallel; you never create
or edit files under `plugins/wildlife/client/species/`.

## The owner's asks (verbatim)

> Grazers move too fast. I like their speed reduced by half.
> Add two additional grazer types. Give them high-resolution 3D models and
> unique behavior. Put them in separate plugins or files denoted with their
> name.
> Add two additional fish types. Give them high-resolution 3D models and
> different behavior.

Decision already made by the orchestrator (do not relitigate): the new
species live INSIDE the wildlife plugin as per-name FILES, not as separate
plugins — a species is a row in wildlife's census / population / movement /
broadcast, and the client's wire vocabulary (`isWildlifeSpecies`) is closed;
a foreign plugin would need a registry API this plugin does not have.

The four species are fixed:

| species | class   | one-line behaviour                                   |
|---------|---------|------------------------------------------------------|
| `ibex`  | grazer  | crag climber: steep-slope walker, perches in bouts   |
| `bison` | grazer  | herd animal: tight herd, grazes in bouts, stampedes  |
| `ray`   | fish    | bottom glider: slow, wide turns, rests on the seabed |
| `shark` | fish    | hunter: solitary cruiser, prey scatter ahead of it   |

## Read first (binding)

- `plugins/wildlife/protocol.ts` (species lists; `WILDLIFE_SPECIES` is the
  wire vocabulary), `server/species.ts` (the `SpeciesProfile` table and its
  numbered rationale), `server/movement.ts` (steering, schools, flee),
  `server/population.ts` (spawning, groups, sizes), `server/census.ts`
  (`isValidCellFor`, `canTraverse`, `openDirectionCount`, `targetsFor`),
  `server/persistence.ts`, `server/index.ts`, `client/placement.ts`
  (`SWIM_PROFILES`, `FLIGHT_ALTITUDES` — `Record<WildlifeSpecies, …>`, so
  typecheck forces entries), `client/models.ts` (`drawableOf` switch),
  `client/index.ts` (`WILDLIFE_SPECIES_DRAW_OBJECTS`).
- `docs/decisions/wildlife.md` (settled decisions; densities and the
  population cap reasoning).
- `plugins/monsters/server/lurk.ts` `advanceIdleState` + the idle fields on
  `MonsterProfile` in `plugins/monsters/server/kinds.ts` — the idle-bout
  shape this plugin should mirror (read only; do not import monsters).
- Root `CLAUDE.md` and `docs/DESIGN.md` Rules (determinism: fixed iteration
  order, RNG only through `server/rng.ts`; no magic numbers; no
  species-name branching in engine code).

## Hard constraints

- Every behaviour is DECLARED on `SpeciesProfile` and interpreted by the
  engine (`movement.ts` / `population.ts`). `movement.ts` and
  `population.ts` must contain no `=== 'ibex'`-style species branching.
  The per-name file supplies the profile (and any pure helper it needs);
  the engine reads fields.
- Per-name files: `plugins/wildlife/server/species/ibex.ts`, `bison.ts`,
  `ray.ts`, `shark.ts`, each exporting its `SpeciesProfile` and its named
  constants with the same rationale-comment standard `species.ts` keeps.
  `species.ts` imports the four rows into `SPECIES_PROFILES`. (Move the
  existing four rows into `server/species/fish.ts` etc. ONLY if it costs no
  behaviour change and you say so; optional.)
- Determinism: any new per-tick randomness draws from `server/rng.ts` in
  the population's fixed order. No `Math.random`.
- Wire: new species go into `WILDLIFE_HABITAT_SPECIES` (they are census
  species). Payload size per entity does not change. Persistence must
  round-trip them (`persistence.ts` guards with `isWildlifeHabitatSpecies`).
- `WILDLIFE_POPULATION_CAP` is a bandwidth budget — do not raise it.
  Densities below are chosen so the cap does not bind on existing worlds;
  restate the day-one / full-reveal table from `docs/decisions/wildlife.md`
  in your report with the new rows.

## Deliverables

### 0. Grazer speed halved
`SPECIES_PROFILES.grazer.cruiseSpeedCellsPerSecond`: `cellsAcross(1.6)` →
`cellsAcross(0.8)`, with the owner's sentence as the comment (2026-09-02).
Update any test that pins the old number (list it).

### 1. Engine additions to `SpeciesProfile` (the contract)
Design the fields; these are the behaviours they must express:
- **Idle bouts** (`idle?: { onsetPerSecond; endPerSecond }` or similar):
  a creature in an idle bout does not translate and does not turn-noise
  wander (it holds its heading); fleeing cancels/overrides idle; entering
  and leaving are Poisson-rolled per tick like monsters' `advanceIdleState`.
  Needs a per-entity field (and persistence of it, or a documented reason
  not to persist — a restored animal starting "moving" is acceptable if
  said). Used by ibex (perch), bison (graze), ray (rest on the seabed).
- **Turn radius per species**: `TURN_RADIUS_BODY_LENGTHS` (movement.ts) is
  global 0.5; make it a profile field with 0.5 as the value every existing
  row states explicitly (no default that lets a row forget). Ray: 1.5.
- **Group startle**: when `startleNear` startles a member of a school whose
  profile declares it, every living member of that school is startled from
  the same origin (heading away from the point, `fleeSecondsRemaining`
  never shortened). Bison only. Keep the "never shortens" rule.
- **Predation**: a profile may declare `hunts?: { preySpecies: readonly
  WildlifeHabitatSpecies[]; alarmRadiusCells: number }`. Each tick, after
  movement, every hunter startles prey within its alarm radius FROM ITS OWN
  POSITION (reuse `startleNear` with a species filter — add the filter to
  `startleNear` as an options argument; the existing callers pass none).
  Cost is O(hunters × population) per tick; hunters are rare by density
  (below). Shark: prey = fish, ray; radius `cellsAcross(3)`.
- **Spawn ground rule**: `spawnOpenDirectionsRequired` says "at least N
  open of 8". The ibex needs the opposite reading — broken ground: at
  least `IBEX_SPAWN_STEEP_DIRECTIONS` (3) of 8 neighbours that a plain
  land walker (`LAND_WALKER_MAX_GRADIENT_PER_CELL`) could NOT cross but the
  ibex can. Generalise the field into one rule the census evaluates (e.g.
  `spawnGround: { kind: 'open', minOpen } | { kind: 'broken', minSteep }`)
  rather than adding a second parallel field.

### 2. The four profiles (values are the orchestrator's; keep them, argue
in comments why each is right relative to its neighbours)

- `ibex` — habitat `land`; cruise `cellsAcross(1.2)`; turnNoise 1.3; body
  `cellsAcross(0.9)`; `maxGradientPerCell` = 2 × `LAND_WALKER_MAX_GRADIENT_PER_CELL`
  (named `IBEX_MAX_GRADIENT_PER_CELL`, in ibex.ts); density
  `cellsOverArea(700)`; groupSize 2; single size; solitary schooling;
  idle onset 0.08/s, end 0.25/s (moves ~12 s, perches ~4 s); spawn: broken
  ground, 3 steep. Turn radius 0.5.
- `bison` — habitat `land`; cruise `cellsAcross(0.6)`; turnNoise 0.5; body
  `cellsAcross(1.6)`; gradient = land walker; density `cellsOverArea(600)`;
  groupSize 6; single size; schooling probability 1 at every size (a herd
  holds together — new constant, not the whale table); idle onset 0.05/s,
  end 0.10/s; group startle; spawn: open ground, 5 of 8 like the grazer.
  Turn radius 0.5.
- `ray` — habitat `shallow`; cruise `cellsAcross(1.0)`; turnNoise 0.3;
  body `cellsAcross(1.0)`; density `cellsOverArea(1200)`; groupSize 1;
  single size; solitary; idle onset 0.05/s, end 0.15/s; turn radius 1.5;
  no spawn clearance.
- `shark` — habitat `shallow`; cruise `cellsAcross(1.8)`; turnNoise 0.6;
  body `cellsAcross(1.5)`; density `cellsOverArea(2500)`; groupSize 1;
  single size; solitary; hunts fish + ray at `cellsAcross(3)`; turn radius
  0.5; no spawn clearance; no idle.

### 3. Client typecheck stubs (temporary, explicit)
`client/placement.ts` needs rows for the four species. Use these envelope
figures (the orchestrator's models are authored to them; the wiring phase
corrects any drift): ibex `null`, bison `null`; ray `{ depthFraction: 0.85,
minClearance: 0.2, minSubmergence: 0.3, halfLength: 0.5, halfWidth: 0.5 }`;
shark `{ depthFraction: 0.4, minClearance: 0.35, minSubmergence: 0.35,
halfLength: 0.75, halfWidth: 0.15 }`. `FLIGHT_ALTITUDES`: all four `null`.
`client/models.ts` `drawableOf`: map `ibex`/`bison` → `grazerDrawable` and
`ray`/`shark` → `fishDrawable` with a comment "interim until the species
models land (wiring phase, same arc)". Do not change
`WILDLIFE_SPECIES_DRAW_OBJECTS` (no new herds yet). Do not otherwise edit
`client/models.ts`.

## Tests

NO new test files and NO new test cases — the owner has not granted test
permission this session. Existing tests in `plugins/wildlife/test` that
enumerate species exhaustively or pin changed constants may be UPDATED to
stay true; list each with the reason. Your report must list the new
contract behaviours that are UNTESTED because of this rule (idle bouts,
group startle, predation filter, broken-ground spawn, per-species turn
radius), so the owner can grant permission.

## Verification (required)

- `pnpm --filter @terrace/plugin-wildlife typecheck` and
  `pnpm --filter @terrace/plugin-wildlife test` green; `pnpm typecheck` at
  the worktree root green (client typecheck covers placement/models stubs).
- A Node demonstration script (not a test; put it under
  `.claude/orchestration/briefs/` and delete before the final commit) that
  builds a stand-in `HabitatWorld` (a land plateau with a scarp, a shallow
  shelf), spawns each new species via the real spawn path, advances 5
  simulated minutes at 10 Hz and prints per species: distance travelled,
  fraction of ticks idle, max gradient crossed, and for the shark the count
  of fish startled with no sculpt. Paste the output in the report. Grazer
  speed: print the grazer's cells/s before and after (0.8 × WORLD_UNIT_CELLS).

## Report

Write `.claude/orchestration/briefs/wildlife-species-server-report.md` in
the worktree and commit it: the final field shapes on `SpeciesProfile`
(the wiring phase and the model files consume them), file:line for every
engine change, the density table, tests updated, behaviours untested, and
the demonstration output. Comments are claims, not evidence — cite lines.
