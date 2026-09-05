# Model assets shipped by the wildlife plugin

Everything here is CC0. Sources are downloaded into `.model-import/src/` (never
committed) and normalised by `tools/blender/import_model.py`; the exact command
is recorded below so the file can be rebuilt from the source byte for byte.

## grazer-deer.glb — the grazer

- Pack page: <https://quaternius.com/packs/ultimateanimatedanimals.html>
  ("License CC0", linking <https://creativecommons.org/publicdomain/zero/1.0/>)
- File fetched from a mirror, because the pack itself downloads through a
  Google Drive folder no headless client can walk:
  <https://raw.githubusercontent.com/trebeljahr/quaternius-showcase/main/public/glb/animals_pack/Deer.glb>
- Author: Quaternius
- Licence: CC0 1.0
- Size: 274 612 bytes (268 KB). 2 096 triangles, 7 materials, no textures —
  the colour is a `COLOR_0` vertex attribute, which is why the seven materials
  bake to a single draw call (see `../index.ts`, `GRAZER_ASSET_DRAW_OBJECTS`).

Import command (run from the repo root; the Blender binary is a Windows one, so
its arguments are Windows paths):

```
"/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
  --background --python tools/blender/import_model.py -- \
  E:\Development\Projects\Terrace\.model-import\src\Deer.glb \
  E:\Development\Projects\Terrace\.model-import\out\grazer-deer.glb \
  --forward -Y --up +Z --rigidify --drop Icosphere --origin ground \
  --footprint 0.62 0.62 --height 0.464 \
  --rename FrontUpperLeg.L=foreLeft --rename FrontUpperLeg.R=foreRight \
  --rename BackLeg.L=hindLeft --rename BackLeg.R=hindRight \
  --rename Head=head
```

Notes on the flags, so nobody has to re-derive them:

- `--forward -Y`: the source stands facing Blender's -Y after a default glTF
  import. The convention is +X.
- `--drop Icosphere`: every file in this Quaternius pack carries a stray
  80-triangle sphere at the origin. It is not part of the animal and it sets
  the bounding box, so the footprint fit would otherwise be computed for it.
- `--footprint 0.62 0.62 --height 0.464`: the budget the previous, hand-built
  grazer occupied — see `../species/grazer.ts`, which derives both numbers and
  states why the height is the binding one.
- The `--rename`s put the asset's bones under the names `species/quadruped.ts`'s
  `poseWalk` already drives, so no runtime name table exists.

**The source's animation clips are IGNORED and are not in the exported file.**
The pack ships thirteen (Walk, Gallop, Idle, …); this game poses a creature
itself, from `poseWalk` against rigid one-bone-per-vertex skinning
(`client/src/render/rigSkin.ts`), so a clip would have nothing to play into.
Do not go looking for them.
