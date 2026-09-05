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
  --forward +X --footprint 3.636 3.636 --origin ground
```

- `--footprint 3.636 3.636` is the footprint contract in CELLS:
  2 × STRUCTURE_FOOTPRINT_RADIUS = 2 × (1 / 2 / 1.1) world units, through
  `cellsAcross()` at four cells to the world unit (see models.ts's
  IMPORTED_STRUCTURE_FOOTPRINT_CELLS, which is the same derivation in code and
  is asserted at load).
- `--origin ground`: a building is placed by standing it on a cell.
- No `--max-texture`: the only image is already 256 px, under the 512 cap.
- No `--drop`, no `--rigidify`, no `--rename`: the file contains one mesh and
  nothing else.

Verified on the OUTPUT, not on the source:

```
blender --background --python tools/blender/stat_glb.py -- \
  <out>\timber-house.glb --footprint 3.636 3.636 --height 7.36
-> bbox cells: x=2.341 y=2.156 z=3.636  min-y=0.000  centre-xz=(0.000, 0.000)
-> FIT OK: within 3.636 x 3.636 cells and 7.36 high, tolerance 0.02
```

- Committed size: 182 KB (the cap this repo keeps for a building is ~500 KB).
- 7.36 cells is the height ceiling: the watchtower's spire apex, 1.84 world
  units (models.ts's TALLEST_PROCEDURAL_TIER_HEIGHT_WORLD_UNITS).
