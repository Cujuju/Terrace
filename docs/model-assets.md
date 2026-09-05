# Model assets: the GLB convention for Terrace

Every authored model — a boat, a building, an animal, a prop — is one `.glb`
that obeys the same convention, whether it was built by a script in this repo
or downloaded from an asset site and normalised by `tools/blender/
import_model.py`. The runtime loader (`client/src/render/rigAsset.ts`) enforces
the parts of it a loader can check and rejects the file, by name, when they are
broken; the rest is enforced offline by the tools below.

## Units, axes, origin

Units are WORLD units: 1 unit is one unit of the space three draws in, and a
model carries no runtime scale, so the size it is authored at is the size it is
drawn at. Y up. Forward = +X — a model facing −X walks, sails or swims
backwards, and nothing at runtime can tell.

A cell is `CELL_WORLD_SIZE` world units (`shared/src/constants.ts:50`), so a
footprint that starts life on the server, stated in cells, is converted with
`cellsAcross` before it becomes an asset footprint — at that one boundary, never
inside the asset.

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

An asset is budgeted in world units, the unit its bounding box is measured in:
the war boat gets 1×1, a wolf-sized animal about 0.8×0.8. The whole
silhouette — oars out, tail out, wings out — must fit inside that budget plus a
small tolerance for float dust (`ASSET_FIT_TOLERANCE_WORLD_UNITS`, 0.02, in
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
   an independent re-import of the finished file: bounding box in world units,
   min-Y, per-mesh tri count / material / uv layers, each material's filled slots,
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

## Wildlife species

A creature asset is a body, not a creature: the .glb supplies the part tree and
the joints, and the species file
(`plugins/wildlife/client/species/<name>.ts`) supplies the envelope constants,
the joint names it drives, and `animate`. The adapter is
`species/assetSpecies.ts`; nothing in `models.ts` knows which species came
from a file.

Joint names for a SWIMMER — required, and the load fails naming the file and
the joint if one is missing:

- `rig`: an Empty at the origin. Everything hangs under it; the body's
  counter-yaw acts on it.
- `tail`: an Empty AT THE PEDUNCLE, the caudal mesh its child. A yaw on the
  Empty sweeps the fin from its root; a yaw on the mesh spins it on a pin.
- `pectoral_port`, `pectoral_starboard`: Empties at the flank root, authored
  at REST IDENTITY. The fin's sweep is baked into its outline (rigid, so it
  cannot swing the root out of the flank); the rest dihedral is animation and
  lives in the species .ts, which assigns the hinge's rotation outright.

**Port is −Z.** With +X forward and +Y up in a right-handed frame,
left = up × forward = Y × X = −Z.

Anchors (Empties), all measured at install and asserted against the species'
declared envelope within `ENVELOPE_TOLERANCE_CELLS`:

- `nose`, `tail_tip`: the length's two ends, and the model's own x extremes.
- `crown`, `belly`: the highest and lowest points, and its y extremes.
- `flank`: the half-width the species' envelope DECLARES — the body for the
  fish (its pectorals reach further), the angled pectoral tip for the shark
  (placement.ts fits its column to the fins). It is checked against the
  declared `halfWidth` and against the model's z extent as an upper bound,
  never taken from the bounding box.

**An envelope extreme is authored in its rest pose in the file.** The install
measures the file AT REST, before any `animate` runs, so a part whose rest
angle `animate` assigns (the fish's pectorals, flat in the file and rolled to
their dihedral every frame) cannot be an envelope extreme. When it must be —
the shark's angled pectoral tip is both its `bellyY` and its `halfWidth` — the
angle is baked into the mesh under an identity hinge, and `animate` leaves
that hinge alone.

**A species whose extremes move with its animation declares two envelopes**:
the REST envelope the file is checked against (`SpeciesAssetSpec.envelope`)
and the SWEPT envelope placement reads, derived in the species .ts as rest
plus animation amplitude, with the relationship written once. Fish and shark
have one envelope because their extremes are static; the ray is the first with
two — its placement `crownY`/`bellyY` are a wing tip at the top and bottom of
its beat, which a file authored with the wings flat never reaches, so
`RAY_REST_ENVELOPE` is what `ray.glb` measures and `RAY_ENVELOPE` is
`rest ± wingReach · sin(flap)`.

**A body that bends is a chain of NESTED joint Empties** (the eel: `spine0`
… `spine4`, each a child of the one before, positioned in its parent's frame)
— `bakeRig` composes a child's rotation onto its parent's, so `animate` drives
relative bends and the file must carry the nesting, not a flat row of hinges.

A WALKER reads the same five envelope numbers differently, and the difference
is the origin: a swimmer is authored about its body centre so `crownY` and
`bellyY` straddle zero, while a walker is authored at its FEET, so `bellyY` is
zero and `crownY` IS the standing height. `placement.ts` already knows this
(`BODY_COLUMNS` gives a walker `{ bellyY: 0, crownY: height }`), so no new
field exists for it. Its joints are its own — the grazer declares `rig` plus
four leg hinges and a head, driven by `species/quadruped.ts`'s `poseWalk`.

The envelope constants stay DECLARED in the species .ts, because
`placement.ts` fits the creature's water column from them. The asset is
checked against them; it never supplies them.

### A DOWNLOADED species (`--rigidify`)

A file built by a script in this repo arrives at the convention already. A file
downloaded from an asset site is somebody else's armature put through
`import_model.py --rigidify`, and a converted armature is not yet a set of
hinges these animations can drive. `SpeciesAssetSpec.rigidified: true` says so,
and the adapter then does two things at install — once, never per bake:

- **Synthesises `rig`.** A converted armature has the bones the artist drew and
  nothing spare, so the whole-body node is wrapped around the file's scene
  rather than demanded of the import (which keeps `import_model.py` generic).
  `rig` is still listed in `joints`; it must NOT exist in the file.
- **Gives every other declared joint a model-axis pivot.** `--rigidify` puts an
  Empty at each bone's head carrying the BONE's rest rotation, and the
  animations here drive MODEL axes (`rotation.z` is fore-and-aft because a model
  faces +X). Worse, `joint.rotation.z = swing` assigns an EULER, so three
  rebuilds the whole quaternion and any rest rotation the node had is gone —
  which is a model that comes apart on its first posed frame. The pivot is a
  pure translation the animation drives instead; the bone hangs under it,
  unmoved. The cost: a driven joint inherits from `rig` only, not from the bones
  above it.

`SpeciesAssetSpec.adopt` handles the third hazard: a source rig may hold bones
that are not in the limb chain at all — IK targets, commonly at the armature
ROOT — and `--rigidify`'s dominant-weight split honestly hands one of those the
geometry that weighed most on it. Naming the node and the joint that must carry
it moves it, unmoved, into the chain. Without it the deer's legs swing and its
hooves stay standing on the ground.

Ownership: an asset-sourced species allocates nothing from `SpeciesModelPool`.
The .glb's buffers belong to the `RigAsset` and are freed by
`disposeSpeciesAssets()`; the baked merged geometry and material belong to the
`RigBlueprint` and are freed by `models.dispose()`. Blueprints first, always.

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
