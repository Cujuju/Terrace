# Apache gunship

Original stylized AH-64/Longbow asset for Terrace. Geometry and texture artwork
are generated locally; there are no downloaded meshes or texture dependencies.
Silhouette reference: [Boeing AH-64 Apache](https://www.boeing.com/defense/military-rotorcraft/ah-64-apache).

This is a reusable model asset, not a spawning or combat plugin.

| Budget | Exported asset |
| --- | --- |
| Triangles | 988 (788 body, 92 main rotor, 68 tail rotor, 40 gun) |
| Meshes / materials | 4 / 1, shared opaque PBR material |
| Textures | Embedded 1024² base colour and 1024² packed metallic/roughness |
| Rest bounds, world units | X 0.976 × Y 0.290 × Z 0.897 |
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
```

The builder refuses exports over 1,000 triangles and sizes from the complete
main and tail rotor sweeps. It uses Blender's bundled NumPy and the project's
shared GLB export recipe. Reviewed with fresh-import bounds/material/UV checks
and four studio views; no running game was started or changed for verification.
