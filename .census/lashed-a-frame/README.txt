lashed-a-frame — Terrace building delivery

Original: 2048 x 2048 textures. Low: 1024 x 1024 textures, in low subfolder.
Each variant: editable packed lashed-a-frame.blend; lashed-a-frame.glb with embedded PNGs;
lashed-a-frame-ktx2.glb with embedded UASTC KTX2s; separate basecolor, normal and
metallicRoughness PNG and KTX2 maps. Exactly one mesh, primitive and material.
Hierarchy: RootNode > lashed-a-frame. Identity object transforms; geometry in world units.
No Draco or meshopt. No production integration or LOD switching implemented.

Provenance
Improved original first-party Terrace procedural model from plugins/structures/client/fishingHuts.ts (original procedural base); not third-party geometry. New UVs and all texture maps authored in Blender pipeline.
Textures are original procedural paint, not generated concept pixels or old maps.
Concept: lashed-a-frame-concept.png, built-in image generator. Exact prompt: concept-prompt.txt.
Exact backend image-model version cannot be selected or verified; no version claim.
Shared authoring and validation code derives from the completed in-repo longhouse.
The immutable source-inventory.json records first-party procedural base geometry.
The third-party cottage supplies bounds only, never mesh or texture data.

Historical plausibility (editorial judgment, not an authenticity certification)
3/5 — Preindustrial temporary fishing shelter; undated. Lashed poles and steep reed cover are plausible; stylized closed entry and simplified lashings.
Rubric: 1 fantasy, 2 hybrid/anachronistic, 3 plausible type with substantial stylization,
4 coherent period cues, 5 documented reconstruction. None claims reconstruction.
Broad eras are independent of Terrace tier progression; cultures are not ranked.
Research and full inventory: E:\Development\Projects\Terrace\.census\building-kit\README.md

Placement and LOD alignment
glTF Y up; entrance +Z.
Origin: Original placement origin retained; ground contact corrected to zero.
Original glTF dimensions X/Y/Z: [0.625, 0.7171738743782043, 0.6831256151199341]
Bounds: {'min': [-0.3125, 0.0, -0.2750000059604645], 'max': [0.3125, 0.7171738743782043, 0.4081256091594696]}
Deliberate differences: Original silhouette and horizontal extents preserved. Broad edges chamfered in original; low uses coplanar simplification. Sub-ground source slivers corrected to Y=0.
Maximum original/low bounds difference: 0.000000000 world units.
Low preserves the important silhouette; excludes broad-edge chamfers and reduces
roof segments, curved profiles or small sign detail where applicable.

Measured geometry, UVs and memory
original: 1,036 triangles, 2,010 exported vertices; 448 UV islands; minimum island bounds gap 12.013 px; density 694.786-694.830 px/world unit.
  GPU mesh 0.098 MiB; PNG total 64.098 MiB; KTX2 BC7/ASTC total 16.098 MiB.
low: 580 triangles, 1,204 exported vertices; 308 UV islands; minimum island bounds gap 12.004 px; density 328.153-328.159 px/world unit.
  GPU mesh 0.058 MiB; PNG total 16.058 MiB; KTX2 BC7/ASTC total 4.059 MiB.
UVs wholly inside 0-1; exported triangles tested for positive-area intersections.
No overlapping islands, collapsed UV triangles or zero-area mesh triangles.
Atlases independently packed at each delivered resolution with a 12 px target gap.
Per-face planar projection at uniform density; no stacked/mirrored UV islands.

Texture and runtime verification
Base colour sRGB. Tangent-space normal uses OpenGL/glTF +Y green, XYZ retained.
Normal height derivatives account for UV vertical direction; unit normals encoded RGB.
MetallicRoughness is linear RGB: R=1 unused, G=roughness, B=0 metalness.
All six KTX2 textures: UASTC, complete mip chains (12 levels original, 11 low),
base sRGB, normal/MR linear, no channel swizzle. KTX-Software glTF-basisu validation passed.
KHR_texture_basisu is required and each texture references an embedded KTX2 image.
Every geometry accessor bufferView matches the PNG GLB byte-for-byte after packing.
Embedded texture bytes match delivered standalone files. Decoded UASTC metalness
is zero through every mip (mip-channel-verification.json); compression-verification.json
records channel error and normal angular error at the base level.
Validation uses UASTC-to-RGBA8 decoding, not all possible hardware transcodes.

Memory assumptions
PNG: RGBA8 GPU storage plus complete mip chains (64 MiB textures original, 16 low).
KTX2: BC7 or ASTC 4x4 at 16 bytes/block with all mips (16 MiB original, 4 low).
Actual GPU format depends on device support; uncompressed fallback may cost PNG-level memory.
Calculated totals include exported vertex/index bytes, not live GPU measurements.
Exclude driver allocation, CPU loader/image copies, shaders, scene objects and framebuffers.
Repeated instances share mesh and textures. Loading both variants adds both totals:
PNG 80.156 MiB;
KTX2 20.157 MiB.

Screenshots
lashed-a-frame-45deg.png and lashed-a-frame-closeup.png render the exported PNG GLB in Blender.
The low subfolder uses identical cameras and lighting; comparison.png pairs them.
These show finished meshes, not concepts, and are studio renders, not game screenshots.
Artifacts was unavailable; local image delivery is the requested fallback.

Rebuild in PowerShell
python 'E:\Development\Projects\Terrace\.census\building-kit\run_delivery.py' lashed-a-frame
& 'E:\Development\Projects\Terrace\.census\building-kit\contact_sheets.ps1' -BuildingIds lashed-a-frame
python 'E:\Development\Projects\Terrace\.census\building-kit\write_reports.py' lashed-a-frame
Individual build/audit/render scripts: Blender --background --factory-startup
--python-exit-code 1 --python <absolute-script-path> -- --id lashed-a-frame [--low].
Blender: E:\Program Files\Blender Foundation\Blender 5.2\blender.exe
KTX tools: e:\Scoop\shims\toktx.exe and e:\Scoop\shims\ktx.exe.
Source scripts live together in E:\Development\Projects\Terrace\.census\building-kit; retain that sibling folder.
No game process is required. Nothing under plugins is overwritten.
