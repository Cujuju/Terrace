# Fish + whales → Blender GLB (owner 2026-09-04)

Owner 2026-09-04 (revised): the ORCHESTRATOR runs the whole list unattended.
For each remaining row, sequentially, never in parallel: write a brief (pass-1 brief
is the template, model-only from here), spawn ONE fresh Fable agent (`model: "fable"`,
`isolation: "worktree"`, no forks), let it finish, verify (typecheck, wildlife tests,
render_glb 4 views, view the renders), merge to main, close that agent, next row.
Owner reviews ALL models together when back — collect every pass's renders on one
Artifact page (one section per species) instead of waiting for review per pass.
Pipeline: docs/model-assets.md (Blender 5.2 headless → GLB → rigAsset/bakeRig).
Gate: wildlife has NO asset-sourced SpeciesModelBuilder yet (#321 open; #318/#319
phase-1 kit open). The first pass lands that adapter alongside its model.

| # | Model | Wire species | Procedural source (to replace) | Status |
|---|-------|--------------|--------------------------------|--------|
| 1 | Shallow fish | `fish` | plugins/wildlife/client/species/fish.ts | merged 36c9e41 (2026-09-04); in-game eyes-on pending |
| 2 | Shark | `shark` | plugins/wildlife/client/species/shark.ts | merged (2026-09-05); brief `briefs/shark-glb-pass2.md`, one asset list `species/assets.ts` |
| 3 | Ray | `ray` | plugins/wildlife/client/species/ray.ts | merged (2026-09-05); brief `briefs/ray-glb-pass3.md`; rest + swept envelopes |
| 4 | Eel | `eel` | plugins/wildlife/client/species/eel.ts (+ .fish-shots/eel.py concept) | merged (2026-09-05); brief `briefs/eel-glb-pass4.md`; nested five-joint spine chain |
| 5 | Angelfish | `angelfish` | plugins/wildlife/client/species/angelfish.ts (+ .fish-shots/angelfish.py concept) | todo |
| 6 | Humpback whale | `whale` variant 0 | plugins/wildlife/client/whaleSpecies.ts | todo |
| 7 | Blue whale | `whale` variant 1 | plugins/wildlife/client/whaleSpecies.ts | todo |
| 8 | Sperm whale | `whale` variant 2 | plugins/wildlife/client/whaleSpecies.ts | todo |
| 9 | Deep-sea anglerfish | `deepsea` | plugins/wildlife/client/models.ts (DEEPSEA_*) | todo |

Owner 2026-09-04: anglerfish is in (#9). Kraken is a monster, excluded.

Note from the model-assets arc orchestrator (terrace-11, 2026-09-04): #318/#319 are MERGED
(render kit PBR-complete, import_model.py/stat_glb.py/render_glb.py). Asset units are WORLD
units, not cells (a cell is CELL_WORLD_SIZE = 0.25 world units; the fish, deer and war boat all
carry no runtime scale). The render-kit type is being renamed AssetFootprintCells → AssetFootprint
to say so. Do not add per-plugin glb-url.d.ts files: types/glb-url.d.ts covers every package.
The deer grazer (#321) is being rebased onto pass 1's assetSpecies.ts contract, not a second one.

Constraints every model must keep: species ENVELOPE (crownY/bellyY/length) read
by placement.ts SWIM_PROFILES; forward = +X, Y up, cell units; size classes are a
scale on the rig (WILDLIFE_SIZE_MODEL_SCALE), not separate models; animation
pivots as named Empties (peduncle, pectorals, fluke, jaw…) so the swim code drives
them. Shots + eyes-on per pass (memory: visual work needs eyes-on).
