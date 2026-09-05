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
- `flank`: the BODY's widest half-width. Fins may reach further than this —
  the fish's pectorals do — so it is checked against the declared `halfWidth`
  and against the model's z extent as an upper bound, never taken from the
  bounding box.

The envelope constants stay DECLARED in the species .ts, because
`placement.ts` fits the creature's water column from them. The asset is
checked against them; it never supplies them.

Ownership: an asset-sourced species allocates nothing from `SpeciesModelPool`.
The .glb's buffers belong to the `RigAsset` and are freed by
`disposeSpeciesAssets()`; the baked merged geometry and material belong to the
`RigBlueprint` and are freed by `models.dispose()`. Blueprints first, always.

## Consuming one (plugin side)

1. `preload()` loads via `loadRigAsset(url)` — a `.glb?url` import, which is
   why client/vite.config.ts carries `assetsInclude` for .glb files.
2. `bakeRig(asset.scene)`; pivots via `blueprint.jointIndex(asset.node(name))`.
3. Shape constants from `asset.anchor(name)`; the one-cell fit asserted at load.
4. `blueprint.dispose()` BEFORE `asset.dispose()` — baked surfaces sample the
   file's own texture objects.
