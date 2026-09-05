# Model assets: authoring a native GLB for Terrace

Units are cells: 1 unit = 1 cell. Y up, forward = +X, origin on the
centreline at the keel. A model facing −X sails backwards.

## Scene graph

- `hull`, `deck`, `mast`, `yard`: plain meshes, exact names.
- `sail`: its own mesh, never merged — the plugin recolours it per boat.
- Oars: one pivot Empty per oar at its gunwale mount, mesh child under it:
  `oar_port_1`, `oar_port_2`, `oar_starboard_1`, `oar_starboard_2`.
  The swing is authored as rest; the dip is baked into the mesh.
- Anchors (Empties the plugin measures its constants from): `waterline`
  (sea-surface height), `deck_top` (deck plane), `fire_top` (masthead).

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

## Blender export

- Apply transforms (location kept: an anchor's position IS its location).
- +Y up, GLB format, textures embedded — no sidecar files.
- Headless, from WSL (paths inside the scripts are Windows paths):
  `blender.exe --background --python tools/blender/export_glb.py -- in.blend out.glb`
- The war boat is built, not modelled by hand:
  `tools/blender/build_war_boat.py` (traced loft at game dims, with checks).

## Consuming one (plugin side)

1. `preload()` loads via `loadRigAsset(url)` — a `.glb?url` import, which is
   why client/vite.config.ts carries `assetsInclude` for .glb files.
2. `bakeRig(asset.scene)`; pivots via `blueprint.jointIndex(asset.node(name))`.
3. Shape constants from `asset.anchor(name)`; the one-cell fit asserted at load.
4. `blueprint.dispose()` BEFORE `asset.dispose()` — baked surfaces sample the
   file's own texture objects.
