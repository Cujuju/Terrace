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
- Size: 283 120 bytes (277 KB). 2 096 triangles, 7 materials, no textures —
  the colour is a `COLOR_0` vertex attribute, which is why the seven materials
  bake to a single draw call (see `../index.ts`, `GRAZER_ASSET_DRAW_OBJECTS`).
  The file keeps the source's ARMATURE as a glTF skin: 46 joints, 4 influences
  per vertex, 3 457 of 4 316 vertices shared across two bones or more.

Import command (run from the repo root; the Blender binary is a Windows one, so
its arguments are Windows paths):

```
"/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
  --background --python tools/blender/import_model.py -- \
  E:\Development\Projects\Terrace\.model-import\src\Deer.glb \
  E:\Development\Projects\Terrace\.model-import\out\grazer-deer.glb \
  --forward -Y --up +Z --drop Icosphere --origin ground \
  --footprint 0.62 0.62 --height 0.464 \
  --rename FrontUpperLeg.L=foreLeft --rename FrontUpperLeg.R=foreRight \
  --rename BackLeg.L=hindLeft --rename BackLeg.R=hindRight \
  --rename Head=head \
  --anchor nose=0.2387,0.3937,0 --anchor tail_tip=-0.2387,0.0404,0 \
  --anchor crown=0.1331,0.4640,0 --anchor belly=0,0,0 \
  --anchor flank=0.1317,0.4533,0.0792
```

Notes on the flags, so nobody has to re-derive them:

- `--forward -Y`: the source stands facing Blender's -Y after a default glTF
  import. The convention is +X.
- NO `--rigidify` (dropped 2026-09-04). The armature is kept and exported as a
  skin, so the artist's weights reach `bakeRig`. `--rigidify` split the deer by
  dominant weight and opened seams at the shoulder and hip mid-stride; see
  `../species/grazer.ts` and `docs/model-assets.md`, "Rigid or smooth".
- `--drop Icosphere`: Blender's glTF importer builds an 80-triangle sphere as
  the display shape for zero-length bones, and it lands at the origin as a real
  mesh object. It is not part of the animal and it sets the bounding box, so
  the footprint fit would otherwise be computed for it. It is an IMPORT
  artefact: it never appears in the exported file, but `tools/blender/stat_glb.py`
  re-imports through the same importer and so shows one of its own.
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
  is where `flank` sits. They moved on 2026-09-04 with the drop of `--rigidify`:
  a skinned file is measured as its vertex hull (three's Box3.setFromObject
  calls SkinnedMesh.computeBoundingBox), where a rigidified one was measured as
  the union of every rotated part's own box — 0.477 x 0.464 x 0.158 against the
  old 0.505 x 0.464 x 0.175, same animal.

**The source's animation clips are IGNORED and are not in the exported file.**
The pack ships thirteen (Walk, Gallop, Idle, …); this game poses a creature
itself, from `poseWalk` against the renamed joints
(`client/src/render/rigSkin.ts` bakes the pose, it never plays one), so a clip
would have nothing to play into. Do not go looking for them.
