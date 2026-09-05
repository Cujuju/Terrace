# Fish + whales → Blender GLB (owner 2026-09-04)

One model per pass; owner reviews each before the next; /prep + /clear between.
Pipeline: docs/model-assets.md (Blender 5.2 headless → GLB → rigAsset/bakeRig).
Gate: wildlife has NO asset-sourced SpeciesModelBuilder yet (#321 open; #318/#319
phase-1 kit open). The first pass lands that adapter alongside its model.

| # | Model | Wire species | Procedural source (to replace) | Status |
|---|-------|--------------|--------------------------------|--------|
| 1 | Shallow fish | `fish` | plugins/wildlife/client/species/fish.ts | merged 36c9e41 (2026-09-04); in-game eyes-on pending |
| 2 | Shark | `shark` | plugins/wildlife/client/species/shark.ts | todo |
| 3 | Ray | `ray` | plugins/wildlife/client/species/ray.ts | todo |
| 4 | Eel | `eel` | plugins/wildlife/client/species/eel.ts (+ .fish-shots/eel.py concept) | todo |
| 5 | Angelfish | `angelfish` | plugins/wildlife/client/species/angelfish.ts (+ .fish-shots/angelfish.py concept) | todo |
| 6 | Humpback whale | `whale` variant 0 | plugins/wildlife/client/whaleSpecies.ts | todo |
| 7 | Blue whale | `whale` variant 1 | plugins/wildlife/client/whaleSpecies.ts | todo |
| 8 | Sperm whale | `whale` variant 2 | plugins/wildlife/client/whaleSpecies.ts | todo |
| 9 | Deep-sea anglerfish | `deepsea` | plugins/wildlife/client/models.ts (DEEPSEA_*) | todo |

Owner 2026-09-04: anglerfish is in (#9). Kraken is a monster, excluded.

Constraints every model must keep: species ENVELOPE (crownY/bellyY/length) read
by placement.ts SWIM_PROFILES; forward = +X, Y up, cell units; size classes are a
scale on the rig (WILDLIFE_SIZE_MODEL_SCALE), not separate models; animation
pivots as named Empties (peduncle, pectorals, fluke, jaw…) so the swim code drives
them. Shots + eyes-on per pass (memory: visual work needs eyes-on).
