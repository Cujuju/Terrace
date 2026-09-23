Original Viking-inspired longhouse

Delivered assets
- longhouse.blend: editable polygon mesh, one material, three packed textures.
- longhouse.glb: triangulated game export; one mesh, one primitive, one material; PNG textures embedded; no mesh compression.
- longhouse-basecolor.png: 2048 x 2048, sRGB.
- longhouse-normal.png: 2048 x 2048, linear tangent-space OpenGL +Y.
- longhouse-metallicRoughness.png: 2048 x 2048, linear; R=1 unused, G=roughness, B=0 metalness.
- longhouse-concept.png and concept-prompt.txt: the generated design reference and exact prompt.
- longhouse-beauty.png, longhouse-45deg.png, longhouse-front.png, longhouse-side.png, longhouse-closeup.png: renders of the delivered GLB.

Construction and provenance
The concept was produced with the built-in image generator after the user approved that route. The exact backend image-model version is unverified; it is not claimed to be GPT Image 2.5.

The mesh and all three texture maps were authored from scratch by build_longhouse.py. The concept is a design reference, not a projected texture. No existing game mesh, stock model, third-party texture, or previous timber-house geometry was imported. The scripts and editable Blender source are included for modification and reproduction.

Blender 5.2 was run directly in background mode with its Python API. Blender MCP was not used.

Geometry and coordinates
- 4,260 triangles, 2,496 Blender vertices; 8,332 GLB vertices after UV, normal and tangent seams.
- Hierarchy: RootNode > Longhouse.
- Width 0.747, length 1.619, height 0.677 in game units.
- Origin: ground level, centered on the main hall footprint. Porch and steps extend toward the front.
- Blender: Z up, front toward -Y. glTF: Y up, front toward +Z.
- The editable Blender file contains only the model and root node. Render staging is separate.

UVs and materials
- 1,940 non-overlapping islands within 0-1.
- Measured minimum island-bounds gap: 12.002 pixels at 2048 square.
- Measured texel density: 411.501 to 411.542 pixels per game unit.
- No collapsed UV triangles or zero-area geometry triangles.
- Base colour contains authored material markings and wear, not directional lighting.
- Roof courses, timber grain, stone joints and shallow carving relief are represented by original geometry and normal-map details.
- Roughness approximately 0.780 to 0.980; metalness zero throughout.
- verification.json contains the measured checks and final GLB hash.

Rebuild in PowerShell
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python-exit-code 1 --python 'E:\Development\Projects\Terrace\.census\longhouse\build_longhouse.py'
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python-exit-code 1 --python 'E:\Development\Projects\Terrace\.census\longhouse\audit_longhouse.py'
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python-exit-code 1 --python 'E:\Development\Projects\Terrace\.census\longhouse\render_longhouse.py'

build_longhouse.py is self-contained apart from asset_helpers.py and Blender's bundled NumPy. The render script uses the repository's existing studio-render helper. parts.json maps the named construction pieces to editable polygon ranges.

No production asset under plugins was replaced or integrated.


