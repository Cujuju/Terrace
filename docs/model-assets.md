# Model assets: the GLB convention for Terrace

Every authored model — a boat, a building, an animal, a prop — is one `.glb`
that obeys the same convention, whether it was built by a script in this repo
or downloaded from an asset site and normalised by `tools/blender/
import_model.py`. The runtime loader (`client/src/render/rigAsset.ts`) enforces
the parts of it a loader can check and rejects the file, by name, when they are
broken; the rest is enforced offline by the tools below.

## Units, axes, origin

Units are cells: 1 unit = 1 cell. Y up. Forward = +X — a model facing −X walks,
sails or swims backwards, and nothing at runtime can tell.

The origin is where the game holds the model, and that differs by family:

| Family | Origin | Why |
| --- | --- | --- |
| Rigged walker | Footprint centre, at the feet | It is placed by standing it on a cell |
| Building, prop | Footprint centre, at the base | Same: it sits on ground the terrain moves |
| Boat | Centreline, at the keel | It is placed by floating it; the `waterline` anchor says how deep |
| Swimmer, flier | Bounding-box centre | It never touches the ground, and it banks about its body |

`import_model.py --origin ground` produces the first three, `--origin centre`
the last.

## Footprint

An asset is budgeted in whole cells, because the game's geometry is counted in
cells: the war boat gets 1×1, a wolf-sized animal about 0.8×0.8. The whole
silhouette — oars out, tail out, wings out — must fit inside that budget plus a
small tolerance for float dust (`ASSET_FIT_TOLERANCE_CELLS`, 0.02, in
`client/src/render/rigAsset.ts`; the fit is authored, not fitted, so the
tolerance never absorbs a real overhang).

The check is `assertAssetFits(asset, {x, z, y?})` — a `Box3` over the loaded
scene, so it measures each part's axis-aligned box transformed into place, a
little larger than the part itself for anything rotated.
`stat_glb.py --footprint X Z [--height H]` applies the identical measure
offline and exits non-zero, which is how a reviewer knows before load time.

## Scene graph

- **Meshes** are the drawable parts. ONE material each: `bakeRig` draws one
  surface per material and cannot bake a mesh that carries several, so the
  loader rejects a multi-material mesh instead of showing the wrong one.
- **Pivots are Empties**, never armatures. A joint is a named Empty; the meshes
  that move with it are its children, positioned in its space. That is the only
  animation model this game has: `client/src/render/rigSkin.ts` bakes the tree
  into one skinned mesh by binding every vertex, weight 1.0, to the node it was
  authored under. A file containing an armature or a `SkinnedMesh` is rejected
  — `import_model.py --rigidify` converts one offline instead.
- **Anchors are Empties too**: a named point a plugin measures a constant from,
  rather than guessing it. The boat's are `waterline` (sea-surface height),
  `deck_top` (deck plane) and `fire_top` (masthead).
- **Names are the API.** A plugin addresses a joint or an anchor by name
  (`asset.node('oar_port_1')`, `asset.anchor('fire_top')`), and a missing one is
  a load error, not a silent no-op. Use lower_snake_case for anything a plugin
  names.
- **No animation tracks.** Motion is written in the plugin that owns the
  creature; the file supplies the rest pose and nothing else.

## Materials

One material per mesh, never several on one — the baker cannot split a
part. Within that, the FULL glTF PBR set is supported: baseColor, emissive,
normal, metallic-roughness, occlusion, alpha, and the KHR extension slots
GLTFLoader promotes to a MeshPhysicalMaterial. The one list of slots lives
in `client/src/render/materialMaps.ts`; nothing else keeps its own.

- **Colour slots** (uploaded as sRGB): baseColor (`map`), emissive,
  sheen colour, specular colour — the four GLTFLoader itself marks sRGB.
- **Data slots** (uploaded linear): normal, metallic-roughness, occlusion,
  alpha, bump, displacement and the rest. A data map forced to sRGB is
  gamma-decoded before it is used as a number, so the loader corrects
  either mistake at load rather than trusting the file.
- **UVs.** A mesh must carry the uv attribute for EVERY channel its
  material samples: `uv` for glTF `TEXCOORD_0`, `uv1` for `TEXCOORD_1`
  (an occlusion map is commonly authored there), and so on. A missing one
  fails the load naming the file, the mesh and the channel — never a
  silently untextured part. Unsampled uv sets and `tangent` are dropped at
  bake time (three derives the tangent frame in-shader).
- **Armatures are rejected**, at load and again at bake. Skinning is the
  baker's own job: it binds every vertex rigidly to the node it was
  authored under, so a file's own skeleton has to be converted first —
  `tools/blender/import_model.py --rigidify`.
- **Merge rule.** Parts that differ ONLY in `color` merge into one draw
  (their colour is folded into vertex colours). Anything else that changes
  shading splits them: a different texture in any slot, the same texture on
  a different uv channel, a different roughness/metalness/normalScale or
  map intensity, and the usual transparency/side/blending/shading-model
  differences.

## The worked example: the war boat

`plugins/boats/client/assets/war-boat.glb`, built by
`tools/blender/build_war_boat.py` (a traced loft at game dimensions, with
checks) rather than modelled by hand.

- `hull`, `deck`, `mast`, `yard`: plain meshes, exact names.
- `sail`: its own mesh, never merged — the plugin recolours it per boat.
- Oars: one pivot Empty per oar at its gunwale mount, mesh child under it:
  `oar_port_1`, `oar_port_2`, `oar_starboard_1`, `oar_starboard_2`.
  The swing is authored as rest; the dip is baked into the mesh.
- Anchors: `waterline`, `deck_top`, `fire_top`.

## The tools

All four run headless, from WSL, against the Windows Blender binary. Paths
passed INTO Blender must be Windows paths (`wslpath -w`):

```
"/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
  --background --python tools/blender/<script>.py -- <args>
```

1. **`import_model.py <source> <out.glb> [options]`** — turns a downloaded
   `.glb`/`.gltf`/`.fbx`/`.obj`/`.blend` into a conforming asset. It never
   invents art; it only normalises.
   - `--forward {+X,-X,+Y,-Y,+Z,-Z}` and `--up …`: the source's own axes, named
     in Blender's frame (Z-up, which is where the importer leaves it). The
     model is rotated so forward becomes +X in the exported file.
   - `--footprint X Z` and `--height H`: uniform-scale to fit the budget. The
     binding axis wins; nothing is ever squashed on one axis.
   - `--origin {ground,centre}`: the family origins above.
   - `--drop NAME`: delete a stray mesh the author left in the file (a pivot
     ball, a collision proxy). It would otherwise set the bounding box.
   - `--rigidify`: convert an armature to the Empty-per-joint convention — an
     Empty per bone at the bone's head, each skinned mesh split by DOMINANT
     vertex weight into one part per bone, parented under it, armature deleted.
     Nothing the bake could use is lost, because the bake binds rigidly anyway.
     Prints bone → vertex count. Without the flag an armature is a hard error.
   - `--rename OLD=NEW` and `--anchor NAME=x,y,z` (both repeatable): give a
     joint the name the plugin asks for, and add measuring points. Anchor
     coordinates are in the OUTPUT frame.
   - `--max-texture N`: downscale any image longer than N px on its long side.
   Multi-material meshes are always split, transforms are always baked into the
   mesh data (location kept — an anchor's position IS its location), and the
   export goes through the one recipe in `export_glb.py`. It ends with the same
   stats block `stat_glb.py` prints, so the two can be diffed.

2. **`stat_glb.py <in.glb> [--footprint X Z] [--height H] [--tolerance T]`** —
   an independent re-import of the finished file: bounding box in cells, min-Y,
   per-mesh tri count / material / uv layers, each material's filled PBR slots,
   each image's size and colour space, every Empty's position, and whether any
   armature or skinned mesh survived. With a footprint it exits non-zero on a
   model that does not fit.

3. **`render_glb.py <in.glb> <out_dir> [--views iso,side,front,top] [--ground|--water]`**
   — neutral studio PNGs, so the model can be judged by eye without opening
   Blender. `render_war_boat.py` is the boat's preset of it (sea plane, rested
   at its `waterline` anchor).

4. **`export_glb.py <in.blend> <out.glb>`** — the plain path for a model built
   by a script in this repo, and the home of the export settings both it and
   `import_model.py` use.

## Consuming one (plugin side)

1. `preload()` loads via `loadRigAsset(url)` — a `.glb?url` import, which is
   why client/vite.config.ts carries `assetsInclude` for .glb files.
2. `bakeRig(asset.scene)`; pivots via `blueprint.jointIndex(asset.node(name))`.
3. Shape constants from `asset.anchor(name)`; the footprint fit asserted at load.
4. `blueprint.dispose()` BEFORE `asset.dispose()` — baked surfaces sample the
   file's own texture objects.

## Sources and licences

Third-party art is **CC0 only** — no attribution-required licence, no
"free for personal use". Verify the licence on the page you download from, not
on a mirror.

Downloads live in `.model-import/` (git-ignored: `src/` for the sources, `out/`
for the tool's output, `shots/` for the renders) with a `LICENSES.md` beside
them recording, per model, the source URL, the author and the licence. Only the
finished `.glb` is committed, into its plugin's `assets/` directory, and the
LICENSES.md entry moves with it.
