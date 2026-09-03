# Report — wiring the species model files into the wildlife client

Arc `wildlife-species`, phase 2. Branch `wildlife-species`, worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/wildlife-species`.
Nothing merged to `main`; no app stack started or stopped.

## Commits

| hash | subject |
|---|---|
| `6dff735` | feat(wildlife): every species is drawn by its own file |
| `f927656` | fix(wildlife): placement reads the models instead of restating them |
| `a48c9e0` | fix(preview): frame the creature that is actually drawn |

## 1. models.ts builds every species through its file

`plugins/wildlife/client/models.ts`

- `models.ts:1-10` — header rewritten: the file no longer authors six of the
  nine creatures, it lends the pool and bakes what comes back.
- `models.ts:419` — `speciesPool: SpeciesModelPool`, an object literal over the
  pool's own `keepGeometry` / `lambert` / `unlit` / `part` / `rigged`. No helper
  is duplicated; a species file's geometry and materials land in the same two
  disposal lists the whale's do.
- `models.ts:428` — `speciesDrawable(build)`: author → `bakeSpecies` → `herdFor`
  → a `SpeciesDrawable` whose `animate(seconds, phase)` calls the species file's
  `animate(joints, seconds, phase)`. The `SpeciesDrawable` shape is unchanged.
- `models.ts:509-514` — the six drawables: `buildFish`, `buildGrazer`,
  `buildIbex`, `buildBison`, `buildRay`, `buildShark`.
- `models.ts:574-583` — `drawableOf` maps each species to its own drawable; the
  interim "ibex/bison borrow the grazer, ray/shark borrow the fish" block is
  gone.
- Whale, deepsea and bird are untouched.

**Removed as dead** (each was read only by the fish or grazer authoring):
`FISH_COLOR`, `FISH_TAIL_HZ`, `FISH_TAIL_SWING_RADIANS`, `GRAZER_SCALE`,
`GRAZER_BODY_COLOR`, `GRAZER_LEG_COLOR`, `GRAZER_BOB_HZ`,
`GRAZER_BOB_AMPLITUDE`, and the `fishMaterial` / `fishBody` / `fishTail` /
`grazerBodyMaterial` / `grazerLegMaterial` / `grazerBody` / `grazerHead` /
`grazerLeg` resources with the `fishRig` / `grazerRig` / `fishDrawable` /
`grazerDrawable` blocks. `ellipsoid`, `BoxGeometry` and `ConeGeometry` stay —
the deepsea and bird still use them.

## 2. Placement reads the envelopes

`plugins/wildlife/client/placement.ts`

Two named constants carry the derivation (`placement.ts:49`, `placement.ts:69`):

- `WATER_MARGIN_WORLD_UNITS = 0.12` — the water a swimmer keeps past its own
  skin. Read off the row it replaces: the shipped fish had `minSubmergence` 0.3
  against a crown of 0.182 at the large class, i.e. 0.118 of water, rounded.
- `CLEARANCE_SIZE_CLASS = 'large'` / `CLEARANCE_MODEL_SCALE = 1.4`, applied by
  `clearanceFor(halfExtent) = halfExtent * 1.4 + 0.12`.

### Derivation table

| row | field | envelope field read | value |
|---|---|---|---|
| fish | `minClearance` | `FISH_ENVELOPE.bellyY` (−0.17) | 0.358 |
| fish | `minSubmergence` | `FISH_ENVELOPE.crownY` (0.17) | 0.358 |
| fish | `halfLength` | `FISH_ENVELOPE.halfLength` | 0.36 |
| fish | `halfWidth` | `FISH_ENVELOPE.halfWidth` | 0.08 |
| fish | `depthFraction` | — (unchanged) | 0.2 |
| ray | `minClearance` | `RAY_ENVELOPE.bellyY` (−0.2244) | 0.4341 |
| ray | `minSubmergence` | `RAY_ENVELOPE.crownY` (0.2244) | 0.4341 |
| ray | `halfLength` | `RAY_ENVELOPE.halfLength` | 0.545 |
| ray | `halfWidth` | `RAY_ENVELOPE.halfWidth` | 0.59 |
| ray | `depthFraction` | — (brief) | 0.85 |
| shark | `minClearance` | `SHARK_ENVELOPE.bellyY` (−0.26) | 0.484 |
| shark | `minSubmergence` | `SHARK_ENVELOPE.crownY` (0.40) | 0.68 |
| shark | `halfLength` | `SHARK_ENVELOPE.halfLength` | 0.86 |
| shark | `halfWidth` | `SHARK_ENVELOPE.halfWidth` | 0.42 |
| shark | `depthFraction` | — (brief) | 0.4 |

Whale and deepsea rows are untouched.

### Walker footprint

`WALKER_FOOTPRINT_HALF_EXTENT` (a single 0.18 for every walker) is **removed** —
nothing outside `placement.ts` imported it but the plugin's own test, which is
updated. It is replaced by `WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES`
(`placement.ts:580`) and its cells twin (`placement.ts:595`):

| species | envelope field | world units | cells |
|---|---|---|---|
| grazer | `GRAZER_ENVELOPE.bodyHalfLength` | 0.190 | 0.760 |
| ibex | `IBEX_ENVELOPE.bodyHalfLength` | 0.162 | 0.648 |
| bison | `BISON_ENVELOPE.bodyHalfLength` | 0.340 | 1.360 |
| everything else | — | `null` | `null` |

`walkerGroundY` (`placement.ts:626`) now takes the species, scales the five unit
sample offsets by that species' half-extent, and **throws** for a non-walker
rather than silently probing a single cell. Its one caller,
`plugins/wildlife/client/index.ts:164`, passes `entity.species`.

**Open question for the orchestrator — the one place I deviated in spirit.**
The brief says `minSubmergence` = crown *at the large class* + margin, and that
is what is implemented. But `SwimProfile`'s own contract says a clearance is a
half-extent **at model scale 1**, and `swimmerColumnBounds` multiplies it by the
class scale *again* — so these three rows ask for `1.4²` of their crown at
`large`, while the whale and deepsea rows (hand-set at scale 1) do not. The
effect is never a body out of the water; it is that the two limits cross sooner
and `swimmerColumnBounds`' midpoint split takes over in shallower water than the
geometry requires. Column needed before that happens, at scale 1 / at `large`:
fish 0.716 / 1.00, ray 0.868 / 1.22, **shark 1.164 / 1.63**. The shark is the
one I would look at — it is a shelf species. Flipping
`CLEARANCE_SIZE_CLASS` to `'medium'` is a one-line change and gives fish
0.29/0.29, ray 0.344/0.344, shark 0.38/0.52. The residual is written up on the
constant itself (`placement.ts:51-68`), not hidden.

## 3. Draw budget

`plugins/wildlife/client/index.ts:224-259`. Every one of the six species files
bakes to **one** surface — measured, not assumed (bodyKit welds its extrusions,
and `rigSkin`'s material signature excludes colour, so a species' body, fins,
legs, horns and eyes merge).

| herd | surfaces |
|---|---|
| fish, grazer, ibex, bison, ray, shark, bird | 1 each = 7 |
| deepsea (unlit lure) | 2 |
| whale × 3 bodies (second material) | 2 each = 6 |
| **total** | **15** |

`WILDLIFE_SPECIES_DRAW_OBJECTS` is 15, up from 11. It stays a **constant**:
`drawBudget` is a static field the host reads before `attach` runs, so no pool
exists yet — a computed budget is not available under the plugin contract. In
its place `attach` (`index.ts:273-285`) throws if `models.objects.length`
disagrees, so a species that gains a material fails at boot rather than showing
up as a budget breach mid-frame.

## 4. Preview harness

`client/src/previewWildlife.ts`

- `?species=` already accepted the four new species — verified: it validates
  through `isWildlifeSpecies`, which is `WILDLIFE_SPECIES.includes`, and that
  array is the nine-row list. No code change was needed; the header's stale
  five-species list is corrected.
- Ground disc: `previewWildlife.ts:242-243` drops it to
  `min(0, drawnBox.min.y - GROUND_DROP_WORLD_UNITS)`, as `previewSpecies.ts`
  does. A walker still stands on it.
- **A real bug found on the way.** The disc needed the model's minimum Y and
  `Box3.setFromObject(group)` does not give it: three caches
  `InstancedMesh.boundingBox` on first use and computes it over `count`
  instances, so the fourteen herds with `count === 0` contribute nothing and the
  first herd ever measured keeps a stale box. Every species was being framed as
  if it were the fish — I measured it: nine species, one identical box. Fixed by
  `drawnBounds()` (`previewWildlife.ts:176-198`), which recomputes over the
  herds that are actually drawn. Camera framing now uses it too.
- Added `?t=<seconds>` (the harness only ever drew the rest pose, and the
  verification needs `t ≠ 0`) and `window.__previewStats`, which the shoot
  driver requires before it will capture.
- `client/scripts/shootSpeciesPreview.mjs` gains `--page`, so one driver serves
  both harnesses instead of a copy of the script.
- `client/scripts/buildWildlifePreview.config.mjs` is the new static-build
  config. It resolves its roots from `import.meta.url`, so it builds the shared
  checkout or any worktree — the existing `buildSpeciesPreview.config.mjs`
  hard-codes the main checkout's path and silently builds the wrong tree from a
  worktree. **Not fixed here** (out of my file scope); flagged.

## 5. Triangle budget

Read off the baked surfaces, not estimated.

| species | surfaces | triangles |
|---|---|---|
| fish | 1 | 3 012 |
| grazer | 1 | 4 484 |
| ibex | 1 | 5 060 |
| bison | 1 | 4 700 |
| ray | 1 | 3 516 |
| **shark** | 1 | **5 360** |

Whole pool, all fifteen surfaces (unique buffers, uploaded once): **89 992**
triangles.

Worst case at `WILDLIFE_POPULATION_CAP` (850) if every creature were the
heaviest species: **850 × 5 360 = 4 556 000 triangles per frame**, in 850
instances of one draw call. No model was changed to fit a budget — reporting
only, as instructed.

## Tests

`plugins/wildlife/test/client.test.ts`. **No new tests.** Every change is an
assertion the new signature or constant made false:

1. `:35-36` — imports `WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES` and
   `..._CELLS_BY_SPECIES` in place of the two removed singular constants.
2. `:356`, `:369`, `:391`, `:395`, `:397` — the five `walkerGroundY` calls take
   `'grazer'` as the new fourth argument.
3. `:364-369` — the fixture comment now names the per-species table and the
   grazer's own 0.19 rather than the shared 0.18. Both fixtures still pass on
   their own numbers (0.19 world units is 0.76 cells; x = 9.8 still overhangs
   the boundary at 10, x = 8.0 still does not).
4. `:379-387` — the cells-vs-world-units pin loops the whole table instead of
   the one constant; the "more than half a cell" assertion now reads the
   grazer's row.
5. `:427-430` — the placement-kind test covers ibex and bison as walkers and ray
   and shark as swimmers, which they now are.

**Untested behaviour, named:** the envelope-derived `SWIM_PROFILES` numbers, the
per-species footprint table's contents, `walkerGroundY`'s throw for a
non-walker, the draw-object assertion in `attach`, and every part of `models.ts`
and the preview harness (this suite imports no three, by design). I did not add
tests for any of it — permission was neither given nor asked for.

## Verification run

- `pnpm --filter @terrace/plugin-wildlife typecheck` — green.
- `pnpm --filter @terrace/client typecheck` — green.
- `pnpm --filter @terrace/plugin-wildlife test` — green: **4 files, 132 tests
  passed**, 567 s. No failures anywhere in the workspace's wildlife suite.
- Static build → `python3 -m http.server 8791` → `shootSpeciesPreview.mjs`
  against `preview-wildlife.html`, i.e. through the real
  `createWildlifeModels` pool, at `t = 0.37`. Server killed by pid afterwards.

### Screenshots — `.smoke-shots/species/wired/`

`fish-iso`, `fish-side`, `grazer-iso`, `grazer-side`, `ibex-iso`, `ibex-side`,
`bison-iso`, `bison-side`, `ray-iso`, `ray-side`, `shark-iso`, `shark-side`
(12 PNGs, 1280×800). I looked at all twelve.

No wiring faults: every creature is whole, every limb and fin present, nothing
passing through a body, no species drawn as another, both walkers' feet on the
disc, all three swimmers clear of it. The ray's wings are up **together** at
`t = 0.37` (clear in the side view's shallow V) — the opposite-sign discipline
is correct, contrary to what the iso view's foreshortening first suggests.

**Model observations, not wiring, so not changed** (the brief reserves geometry
and animation to you):

- The fish's dorsal and anal fins show a hairline of daylight under their roots
  in both views — the seat offsets (`fish.ts` `dorsalSeatY` / `analSeatY`, body
  half-height ∓ 0.02) look about 0.02 short against the finished hull.
- The shark's first dorsal has the same hairline gap at its root.
- The bison's head hangs very low and far forward, and its fore legs read short
  against the hump; deliberate per the file's header, but it is the one silhouette
  that reads oddly in isolation.

## Left undone

- Nothing in the brief. `docs/**`, `shared/**`, other plugins and
  `client/src/render/` are untouched.
- `buildSpeciesPreview.config.mjs`'s hard-coded main-checkout path (above).
- The `CLEARANCE_SIZE_CLASS` question (section 2) is yours to settle.
