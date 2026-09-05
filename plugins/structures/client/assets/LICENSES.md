# Sources and licences for the models in this directory

CC0 only — the standing rule in docs/model-assets.md ("Sources and licences").
Every entry records the page the licence was read ON, not a mirror.

## timber-house.glb — tier 2, the timber-house (models.ts's IMPORTED_STRUCTURE_TIER)

- Source page: https://poly.pizza/m/YDGLLT0emC ("Cottage")
- File downloaded from that page: https://static.poly.pizza/8ab3d7cd-dcce-4535-8c64-a22aa0487050.glb
- Author: CreativeTrio (https://poly.pizza/u/CreativeTrio)
- Licence: CC0 1.0, stated on the model page above
  (https://creativecommons.org/publicdomain/zero/1.0/)
- Source geometry: 1 mesh, 1 material, one 256×256 sRGB palette texture
  (`Diffuse_palette_2.jpg`), 2094 triangles, no armature, no animations.

Normalised with the repo's own tool — nothing was modelled or repainted:

```
"/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
  --background --python tools/blender/import_model.py -- \
  <src>\cottage-creativetrio.glb <out>\timber-house.glb \
  --forward +X --footprint 0.909090909 0.909090909 --height 1.84 \
  --origin ground
```

- The numbers are WORLD UNITS, the frame every asset in this repo is authored
  in (orchestrator decision 2026-09-04: the war boat and wildlife's deer are
  both authored this way, with no runtime scale between the file and the model
  space — the plugin uses an asset's transforms exactly as they load).
- `--footprint 0.909090909` squared is the footprint contract:
  2 × STRUCTURE_FOOTPRINT_RADIUS = 2 × (1 / 2 / 1.1) — see models.ts's
  IMPORTED_STRUCTURE_FOOTPRINT_WORLD_UNITS, the same derivation in code, which
  is what asserts it at load.
- `--height 1.84` is the height ceiling: the watchtower's spire apex
  (models.ts's TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS). It does not bind —
  the footprint does — so the house comes out 0.539 tall.
- `--origin ground`: a building is placed by standing it on a cell.
- No `--max-texture`: the only image is already 256 px, under the 512 cap.
- No `--drop`, no `--rigidify`, no `--rename`: the file contains one mesh and
  nothing else.

Verified on the OUTPUT, not on the source:

```
blender --background --python tools/blender/stat_glb.py -- \
  <out>\timber-house.glb --footprint 0.909090909 0.909090909 --height 1.84
-> bbox cells: x=0.585 y=0.539 z=0.909  min-y=0.000  centre-xz=(0.000, 0.000)
-> FIT OK: within 0.909090909 x 0.909090909 cells and 1.84 high, tolerance 0.02
```

(The tool prints "cells" because docs/model-assets.md's unit wording is being
corrected separately; the numbers above are world units.)

- Committed size: 182 KB (the cap this repo keeps for a building is ~500 KB).
