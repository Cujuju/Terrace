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



Lower-resolution and runtime variants (2026-09-23)
- The original .blend, PNG maps and PNG-embedded GLB above are unchanged.
- low\longhouse.blend and low\longhouse.glb: 3,016 triangles, 1,874 editable vertices, 6,002 exported vertices; one mesh/material and the same hierarchy, dimensions and origin as the original.
- low\longhouse-*.png: three 1024-square maps, repacked and regenerated rather than downsampled. UVs have 1,474 non-overlapping islands, minimum 12-pixel gap, and uniform density 152.343-152.356 pixels per game unit.
- Low geometry uses square timber sections, four main roof length segments instead of eight, and a simpler door pull. It retains the layered roof, porch, shutters and carved gable heads.
- low\longhouse-45deg.png and low\longhouse-closeup.png are screenshots of the low PNG GLB; comparison.png shows original/low side by side under identical cameras and lighting. These are asset studio renders, not screenshots inside Terrace.
- longhouse-ktx2.glb and low\longhouse-ktx2.glb are separate runtime exports with embedded UASTC KTX2 textures. Each includes a complete mip chain (12 levels at 2048, 11 at 1024) and requires KHR_texture_basisu. No mesh compression. The PNG exports remain available for editing and conversion.
- The adjacent .ktx2 files are the exact embedded images. Base colour is sRGB; normal/MR are linear. Normal XYZ channels retain the glTF/OpenGL convention. Metalness remains zero after UASTC-to-RGBA decoding.
- KTX-Software validated all six textures against KHR_texture_basisu. Geometry bytes match each corresponding PNG GLB exactly. compression-verification.json records decoded colour error and normal angular error; this verifies UASTC decoding, not every possible hardware transcode format.

Calculated GPU memory, per loaded variant (MiB = 1,048,576 bytes)
                         Original 2048     Low 1024
Triangles                     4,260          3,016
Geometry                      0.406          0.292
PNG textures + mipmaps       64.000         16.000
PNG total                   64.406         16.292
KTX2 BC7/ASTC textures       16.000          4.000
KTX2 BC7/ASTC total          16.406          4.292
PNG GLB on disk               5.355          1.805
KTX2 GLB on disk              6.935          2.228

Assumption: PNG GPU textures use RGBA8, with the complete mip chains enabled by Terrace. KTX2 estimates assume BC7 or ASTC 4x4 at 8 bits/pixel; actual format depends on device support. Devices requiring uncompressed fallback can use the PNG-level memory. KTX2 files can be larger on disk than PNG while using less GPU memory: they contain precomputed mipmaps and GPU-oriented data.
These are storage calculations from the delivered mesh/texture data, not live GPU measurements. They exclude driver overhead, CPU image/loader copies, shaders, scene objects and framebuffers. Decoded PNG base levels alone can occupy another 48 MiB original / 12 MiB low in CPU-side image storage during or after loading; browser retention varies.

Sharing in Terrace
plugins\structures\client\models.ts uses InstancedMesh with shared geometry/material maps. The texture and geometry totals above are per loaded asset version, not per building. Instance transforms are 64 bytes each, with optional 12-byte RGB tint; allocation is by capacity (currently 512: 32 KiB transforms plus 6 KiB tint per instanced mesh), not strictly by visible count. Game state and scene bookkeeping add separate CPU overhead. More buildings still cost more rendering work.
Loading both KTX2 versions simultaneously would cost about 20.70 MiB for the two mesh/texture sets on BC7/ASTC hardware. Loading both PNG versions would cost about 80.70 MiB. The current task supplies assets only; no automatic LOD selection or production model integration was added.
Memory details and hashes: memory-report.json.

Rebuild low: append -- --low to the Blender build, audit and render commands above.
Package KTX2: python 'E:\Development\Projects\Terrace\.census\longhouse\package_runtime.py'
Audit decoded compression: run Blender --background --factory-startup --python-exit-code 1 --python 'E:\Development\Projects\Terrace\.census\longhouse\audit_compression.py'
KTX packaging requires the already installed KTX-Software toktx and ktx command-line tools on PATH.

Reference: https://threejs.org/manual/pages/textures.html#memory-usage
Reference: https://threejs.org/docs/pages/KTX2Loader.html
