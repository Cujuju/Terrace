# Apache gunship

Original stylized AH-64 asset for Terrace. Geometry and texture artwork
are generated locally; there are no downloaded meshes or texture dependencies.
Silhouette reference: [Boeing AH-64 Apache](https://www.boeing.com/defense/military-rotorcraft/ah-64-apache).
The silhouette is traced from the owner's latest 577 × 162 side elevation:
canopy roof/sill, fuselage roof/belly, nacelles, low tail boom, swept fin and wheel
centres. The builder keeps these as source-image coordinates (30 pixels per
construction unit), then fits the completed aircraft to the world-unit budget.
Assumption: cross-section widths are estimated from the accompanying quarter-view
photo. Both latest references omit the radar dome, so this version omits it too.
Canopy and hull UVs span their complete profiles; glazing and panel markings no
longer repeat on every polygon. Geometry is original, not extracted from the photos.
The latest revision was built and exported through live Blender MCP, with the
reference aligned behind the mesh. The nose deck, curved nose pod, canopy stations,
roof fairing, engine height, tail-boom roof, fin tip and rotor rest pose were
adjusted against that overlay. It remains a low-poly approximation of the reference.

Detail revision: the main gear now has splayed oleos, drag braces and inboard
axles; the tail gear has a trailing knuckle. The ventral fin has the reference's
vertical stem and rearward foot. The chin gun has a receiver, cradle and separate
barrel. Rounded engine nacelles use continuous side UVs, circular intake detail
and dark aft exhausts.
The tail rotor uses two offset pairs at 55°/125° spacing, documented in
[AFIT's Apache tail-rotor study](https://scholar.afit.edu/etd/2946/).
Panel lips, recess shadows, hull curvature, wheel hubs and optical reflections
are painted into the atlas. A tangent-space normal atlas supplies panel and
lens-rim relief; roughness varies between paint, rubber, glass and metal.

The imaging pod is a transverse drum with two rounded housings, a central
mounting strap, asymmetric optical windows and a separate upper turret on a
turntable. Assumption: the clearest Arrowhead front photograph supplies the
window arrangement; the other supplied views guide the housing depth and mounts.
The gun has paired rearward-raked supports, a low receiver, an open lower guard,
and a level barrel with a wider muzzle. The owner accepted these shapes on
2026-09-22. Lens coatings, seals and small fittings remain texture detail.
Rotor blades use triangular airfoil sections to recover triangles for the pods.
The side glazing follows separate traced apertures, with an upright forward
corner, narrow centre post, clipped rear upper corner and thin rubber seals.
The front pane has a short level bottom edge before its upward bend, and its
aft lower corner sits above the rear pane's forward lower corner. Glazing is
plain, without painted occupants or reflected scenery.
The canopy shoulder bevel is reduced to keep the roof border close to the panes.

This is a reusable model asset, not a spawning or combat plugin.

| Budget | Exported asset |
| --- | --- |
| Triangles | 1,050 (872 body, 40 main rotor, 40 tail rotor, 98 gun) |
| Meshes / materials | 4 / 1, shared opaque PBR material |
| Textures | Three embedded 1024² atlases: base colour, packed metallic/roughness, tangent normal |
| Rest bounds, world units | X 0.997 × Y 0.260 × Z 0.776 |
| Full rotor sweep | Fits a 1 × 1 world-unit footprint |

The saucer diameter is `SAUCER_DIAMETER_CELLS * CELL_WORLD_SIZE = 1` world unit.
Unlike the older saucer files, this GLB is already authored in world units:
load it at scale **1**, with no cell conversion. Origin is the rest bounding-box
centre, +X forward, +Y up. Windows, seams, vents, stencils and rocket-tube holes
are texture detail. Rotor blades have actual thickness and need no transparency
or double-sided material.

Load using the existing `loadRigAsset` path with the sky environment. Each
mesh has one material and UV0, so the asset supports the existing rigid-joint
`bakeRig` path; shared material and textures allow the parts to merge there.
There are no animation tracks, lights, cameras or external resources in the GLB.

| Node | Purpose / glTF local axis |
| --- | --- |
| `rig` | Whole-aircraft banking and heading |
| `main_rotor_pivot` | Main rotor rotation about Y |
| `tail_rotor_pivot` | Tail rotor rotation about Z |
| `chin_gun_pivot` | Gun yaw about Y, elevation about Z |
| `muzzle` | Gun-child anchor; follows gun aiming |
| `nose`, `tail_tip`, `top` | Static body reference anchors |

Mesh names: `fuselage`, `main_rotor`, `tail_rotor`, `chin_gun`.

Rebuild and independently inspect in PowerShell:

```powershell
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --python-exit-code 1 --python 'E:\Development\Projects\Terrace\tools\blender\build_apache.py' -- 'E:\Development\Projects\Terrace\client\src\assets\apache'
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --python-exit-code 1 --python 'E:\Development\Projects\Terrace\tools\blender\stat_glb.py' -- 'E:\Development\Projects\Terrace\client\src\assets\apache\apache.glb' --footprint 1 1 --height 0.4
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --python-exit-code 1 --python 'E:\Development\Projects\Terrace\tools\blender\render_glb.py' -- 'E:\Development\Projects\Terrace\client\src\assets\apache\apache.glb' 'E:\Development\Projects\Terrace\tools\blender\out\apache' --views bow34,side,top,game
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --python-exit-code 1 --python 'E:\Development\Projects\Terrace\tools\blender\render_apache.py' -- 'E:\Development\Projects\Terrace\client\src\assets\apache\apache.glb' 'E:\Development\Projects\Terrace\tools\blender\out\apache'
```

The builder refuses exports over 1,050 triangles and sizes from the complete
main and tail rotor sweeps. It uses Blender's bundled NumPy and the project's
shared GLB export recipe. Reviewed with fresh-import bounds/material/UV checks
and studio views; no running game was started or changed for verification.
The shared material allows the existing `bakeRig` path to merge the four parts
into one surface; `rigHerd` can instance that surface. These are integration
capabilities, not a measured frame-time result. Assumption: three uncompressed
RGBA8 1K maps with full mip chains occupy about 16 MiB of shared GPU texture
memory. The PNG-compressed GLB file size does not describe resident GPU memory.
The Apache-specific renderer adds a true orthographic side elevation, a quarter
view and a game view, using fresh timestamped filenames to avoid cached previews.

For live Blender work, `build_asset(output_directory)` builds in the active scene
without resetting the open file. Use an empty asset scene with no conflicting
rig names. It exports only the new rig's selected objects from that active scene;
reference images, cameras, and objects selected in other scenes are excluded.
The local authoring/review copy, including its packed reference and comparison
scene, is `E:\Development\Projects\Terrace\tools\blender\out\apache\apache-mcp-review.blend`.
