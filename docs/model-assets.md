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

One of three per mesh, never mixed on one: flat colour, vertex colour
(merged by the baker), or ONE baseColor texture. PBR beyond colour and
roughness is ignored — rigSkin reads map, emissiveMap and color only.
Every mesh under a mapped material MUST carry `uv`; without it the load
fails naming the file instead of shipping an untextured part.

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
