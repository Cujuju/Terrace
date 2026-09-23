Timber house retexture

Files
- timber-house.blend: editable scene, three packed texture images, only RootNode and Cottage.
- timber-house.glb: one mesh, one material, embedded PNGs, no compression.
- timber-house-basecolor.png: 1024 x 1024, sRGB.
- timber-house-normal.png: 1024 x 1024, linear OpenGL tangent-space +Y.
- timber-house-metallicRoughness.png: 1024 x 1024, linear; R=255 (unused), G=roughness, B=0 (metalness).
- before-45deg.png / after-45deg.png: matching orthographic cameras at 45 degrees elevation.
- before-closeup.png / after-closeup.png: matching detail views at 25 degrees elevation.
- verification.json: measured geometry, UV, texture, and Blender scene checks.

UVs
1,060 planar islands, unique 0-1 UVs, no overlaps. Minimum measured bounding-box separation is 12.003 pixels at 1024 square. Texel density ranges from 288.280 to 288.305 pixels per source unit. The original vertex splits are retained; atlas surface occupancy is 29.57%. All three maps have extended colour/data gutters.

Geometry
4,216 indexed vertices, 2,094 triangles. POSITION, NORMAL and index buffers are byte-identical to the source. Nodes, transforms, scenes and hierarchy are unchanged. The GLB adds explicit tangents consistent with Blender's OpenGL tangent basis. The Blender file preserves the source vertex count, one mesh and one material, with no staging objects.

Reproduction
Run build_texture.py with Blender 5.2 in background mode, then audit_asset.py and render_delivery.py. The source path is resolved relative to this folder. atlas-data.npz records the layout used by the audit.

Source SHA-256: d7c40c2fe55a0513b9389ca337ecd4588a9f17fb4a2883aea4ae315e073487eb
The source asset under plugins was not modified.
