# Model assets shipped by the wildlife plugin

Third-party art here is CC0. Sources are downloaded into `.model-import/src/`
(never committed) and normalised by `tools/blender/import_model.py`; the exact
command is recorded below so the file can be rebuilt from the source byte for
byte.

## fish.glb — the fish

Not third-party: built by `tools/blender/build_fish.py` in this repo, so it
carries no external licence. Listed here only so this file is a complete
inventory of the directory rather than a grazer-only note.

## grazer-deer.glb — the grazer

- Pack page: <https://quaternius.com/packs/ultimateanimatedanimals.html>
  ("License CC0", linking <https://creativecommons.org/publicdomain/zero/1.0/>)
- File fetched from a mirror, because the pack itself downloads through a
  Google Drive folder no headless client can walk:
  <https://raw.githubusercontent.com/trebeljahr/quaternius-showcase/main/public/glb/animals_pack/Deer.glb>
- Author: Quaternius
- Licence: CC0 1.0
- Size: 274 964 bytes (269 KB). 2 096 triangles, 7 materials, no textures —
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
  --rename Head=head \
  --anchor nose=0.2525,0.3937,0 --anchor tail_tip=-0.2525,0.0404,0 \
  --anchor crown=0.1331,0.4640,0 --anchor belly=0,0,0 \
  --anchor flank=0.1317,0.4533,0.0875
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
- The `--anchor`s are the five envelope stations
  `species/assetSpecies.ts` asserts the file against at install
  (`nose`/`tail_tip`/`crown`/`belly` at the model's own bounding-box extremes,
  `flank` at its half-width). They are Empties, so they add no geometry and do
  not move the box they mark. On this deer the widest z is the EAR TIPS, which
  is where `flank` sits.

**The source's animation clips are IGNORED and are not in the exported file.**
The pack ships thirteen (Walk, Gallop, Idle, …); this game poses a creature
itself, from `poseWalk` against rigid one-bone-per-vertex skinning
(`client/src/render/rigSkin.ts`), so a clip would have nothing to play into.
Do not go looking for them.
