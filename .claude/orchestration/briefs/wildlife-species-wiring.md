# Brief — wire the species model files into the wildlife client (arc `wildlife-species`, phase 2)

You are a fresh Opus implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/wildlife-species`
(branch `wildlife-species`; it has been fast-forwarded to contain both the
server-side species work and the orchestrator's model files). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/wildlife-species" })`.
`node_modules` is installed; do not run pnpm install. Paths below are
relative to the worktree root. Commit to the branch as you go (conventional
commits, first line < 72 chars, no attribution footers, stage exact paths
only). Do NOT merge to main. Do NOT start or stop any app stack. Do NOT touch
`docs/**`, `shared/**`, `.claude/**` (except your report), any plugin other
than `plugins/wildlife`, or anything under `client/src/render/`.

## What exists (read first, all binding)

- `plugins/wildlife/client/species/speciesModel.ts` — the contract: a
  species file exports a `SpeciesModelBuilder`; it takes a `SpeciesModelPool`
  and returns `{ root, joints, animate }`. `joints` MUST include `rig`.
- `plugins/wildlife/client/species/{fish,grazer,ibex,bison,ray,shark}.ts` —
  the six models (the orchestrator's; do not edit their geometry or
  animation). Each exports an `*_ENVELOPE` constant in world units.
- `plugins/wildlife/client/species/bodyKit.ts`, `quadruped.ts` — shared kit.
- `plugins/wildlife/client/models.ts` — the pool and herds. Its `fishRig`,
  `grazerRig`, `fishDrawable`, `grazerDrawable` are the OLD blocky models
  the species files replace. `drawableOf` currently maps the four new species
  to the old fish/grazer drawables as an interim.
- `plugins/wildlife/client/placement.ts` — `SWIM_PROFILES`,
  `FLIGHT_ALTITUDES`, `WALKER_FOOTPRINT_HALF_EXTENT` (one constant for every
  walker, derived from the OLD grazer body).
- `plugins/wildlife/client/index.ts` — `WILDLIFE_SPECIES_DRAW_OBJECTS` and the
  draw-budget arithmetic; `client/src/plugins/host.ts` asserts it.
- `client/src/previewWildlife.ts` — the preview harness; its species list.
- `.claude/orchestration/briefs/wildlife-species-server-report.md` — the
  server phase's report (field shapes; the four species' habitats).
- `plugins/wildlife/test/client.test.ts` — existing client tests you must keep
  green (update only where a changed constant or model makes an old assertion
  false; list each).

## Deliverables

1. **`models.ts` builds every species through its file.** Add a
   `SpeciesModelPool` implementation over the pool's existing `keepGeometry` /
   `lambert` / `unlit` / `part` / `rigged` helpers (they already exist as
   local functions — expose them through the interface, do not duplicate
   them). Replace the inline fish and grazer authoring (geometry constants,
   rig blocks, drawables, and their animation constants) with
   `buildFish` / `buildGrazer`; add `buildIbex`, `buildBison`, `buildRay`,
   `buildShark`. `drawableOf` maps each species to its own drawable. The
   `SpeciesDrawable.animate(seconds, phase)` shape stays; it calls the species
   file's `animate(joints, seconds, phase)`. Whales, deepsea and bird are
   untouched. Remove the now-dead fish/grazer constants rather than leaving
   them (a constant nothing reads is a lie about what the file does).
2. **Placement reads the envelopes.** `SWIM_PROFILES.fish/ray/shark` and the
   walker footprint derive from `FISH_ENVELOPE`, `RAY_ENVELOPE`,
   `SHARK_ENVELOPE`, `GRAZER_ENVELOPE`, `IBEX_ENVELOPE`, `BISON_ENVELOPE` —
   `halfLength`/`halfWidth` straight from the envelope; `minSubmergence` =
   envelope `crownY` at the LARGE size class (`WILDLIFE_SIZE_MODEL_SCALE`) plus
   the same water margin the existing fish row carries (state it as a named
   constant); `minClearance` likewise from `bellyY`. `depthFraction`: fish
   0.2 (unchanged), shark 0.4, ray 0.85. The walker footprint becomes
   per-species (`WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES` or a function) from
   each envelope's `bodyHalfLength`; keep the old name exported only if
   something outside placement.ts still imports it (grep; if nothing does,
   remove it). Every derivation carries a one-line comment naming the
   envelope field it reads.
3. **Draw budget.** Every species file bakes to ONE surface (its kit welds
   extrusions so indexed and non-indexed pieces do not split). Recompute
   `WILDLIFE_SPECIES_DRAW_OBJECTS` from the real herd surface counts — better,
   derive it from `models.objects.length` at attach time if the plugin
   contract allows a computed `drawBudget`; if it must be a constant, state
   the per-species count table in the comment and assert it against
   `models.objects.length` in `attach` with a thrown Error (not a log).
4. **Preview harness.** `client/src/previewWildlife.ts` accepts the four new
   species in `?species=` (it validates through `isWildlifeSpecies`, so this
   may already work — verify) and its ground disc no longer hides a swimmer's
   lower half: drop the disc under the model's minimum Y as
   `client/src/previewSpecies.ts` does.
5. **Triangle budget note.** Report per-species triangle counts from the
   baked surfaces (read them, do not estimate) and the worst-case frame cost
   at `WILDLIFE_POPULATION_CAP` if every creature were the heaviest species.
   Do not change any model to fit a budget — report, the orchestrator
   decides.

## Tests

NO new tests. Update `plugins/wildlife/test/client.test.ts` only where an
assertion pins the old fish/grazer geometry or the old footprint constant;
list every change. Report which new behaviour is untested.

## Verification (required)

- `pnpm --filter @terrace/plugin-wildlife typecheck`,
  `pnpm --filter @terrace/client typecheck`, and
  `pnpm --filter @terrace/plugin-wildlife test` green (the test run takes
  ~10 minutes on this drive; run it in the background and poll).
- Static preview build + screenshots of all SIX species through the REAL
  pool (`createWildlifeModels`), iso and side, at `t` ≠ 0, into
  `.smoke-shots/species/wired/` — the recipe is in the header of
  `client/scripts/shootSpeciesPreview.mjs`; adapt a copy of
  `client/scripts/buildSpeciesPreview.config.mjs` to build
  `preview-wildlife.html` instead. Look at every image yourself before
  reporting (a creature drawn with a missing limb or a fin through its body
  is a wiring bug). A `python3 -m http.server` on a spare port is fine; kill
  it by pid when done.

## Report

`.claude/orchestration/briefs/wildlife-species-wiring-report.md`, committed:
file:line for each change, the placement derivation table, the draw-object
count, triangle counts, tests updated, screenshots list, anything left.
