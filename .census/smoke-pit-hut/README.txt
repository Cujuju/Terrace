smoke-pit-hut — Terrace building delivery

Original: 2048 x 2048 textures. Low: 1024 x 1024 textures, in low subfolder.
Each variant: editable packed smoke-pit-hut.blend; smoke-pit-hut.glb with embedded PNGs;
smoke-pit-hut-ktx2.glb with embedded UASTC KTX2s; separate basecolor, normal and
metallicRoughness PNG and KTX2 maps. Exactly one mesh, primitive and material.
Hierarchy: RootNode > smoke-pit-hut. Identity object transforms; geometry in world units.
No Draco or meshopt. No production integration or LOD switching implemented.

Provenance
Improved original first-party Terrace procedural model from plugins/structures/client/fishingHuts.ts (original procedural base); not third-party geometry. New UVs and all texture maps authored in Blender pipeline.
Textures are original procedural paint, not generated concept pixels or old maps.
Concept: smoke-pit-hut-concept.png, built-in image generator. Exact prompt: concept-prompt.txt.
Exact backend image-model version cannot be selected or verified; no version claim.
Shared authoring and validation code derives from the completed in-repo longhouse.
The immutable source-inventory.json records first-party procedural base geometry.
The third-party cottage supplies bounds only, never mesh or texture data.

Historical plausibility (editorial judgment, not an authenticity certification)
3/5 — Preindustrial fish-smoking compound; undated. Hearth, smoking spit and hut are functionally readable; static smoke bubbles were removed and the hearth is delivered cold/unlit.
Rubric: 1 fantasy, 2 hybrid/anachronistic, 3 plausible type with substantial stylization,
4 coherent period cues, 5 documented reconstruction. None claims reconstruction.
Broad eras are independent of Terrace tier progression; cultures are not ranked.
Research and full inventory: E:\Development\Projects\Terrace\.census\building-kit\README.md

Placement and LOD alignment
glTF Y up; entrance +Z.
Origin: Original placement origin retained; ground contact corrected to zero.
Original glTF dimensions X/Y/Z: [0.7056654691696167, 0.6550000309944153, 0.6585074663162231]
Bounds: {'min': [-0.34154877066612244, 0.0, -0.261548787355423], 'max': [0.36411669850349426, 0.6550000309944153, 0.39695867896080017]}
Deliberate differences: Original silhouette and horizontal extents preserved. Broad edges chamfered in original; low uses coplanar simplification. Sub-ground source slivers corrected to Y=0. Static smoke bubbles removed; building height is 0.655 instead of 0.806 including smoke. Hearth is cold/unlit.
Maximum original/low bounds difference: 0.000000000 world units.
Low preserves the important silhouette; excludes broad-edge chamfers and reduces
roof segments, curved profiles or small sign detail where applicable.

Measured geometry, UVs and memory
original: 1,772 triangles, 3,601 exported vertices; 832 UV islands; minimum island bounds gap 12.008 px; density 1076.116-1076.156 px/world unit.
  GPU mesh 0.175 MiB; PNG total 64.175 MiB; KTX2 BC7/ASTC total 16.175 MiB.
low: 1,116 triangles, 2,398 exported vertices; 628 UV islands; minimum island bounds gap 12.010 px; density 471.108-471.115 px/world unit.
  GPU mesh 0.116 MiB; PNG total 16.116 MiB; KTX2 BC7/ASTC total 4.116 MiB.
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
PNG 80.291 MiB;
KTX2 20.291 MiB.

Screenshots
smoke-pit-hut-45deg.png and smoke-pit-hut-closeup.png render the exported PNG GLB in Blender.
The low subfolder uses identical cameras and lighting; comparison.png pairs them.
These show finished meshes, not concepts, and are studio renders, not game screenshots.
Artifacts was unavailable; local image delivery is the requested fallback.

Rebuild in PowerShell
python 'E:\Development\Projects\Terrace\.census\building-kit\run_delivery.py' smoke-pit-hut
& 'E:\Development\Projects\Terrace\.census\building-kit\contact_sheets.ps1' -BuildingIds smoke-pit-hut
python 'E:\Development\Projects\Terrace\.census\building-kit\write_reports.py' smoke-pit-hut
Individual build/audit/render scripts: Blender --background --factory-startup
--python-exit-code 1 --python <absolute-script-path> -- --id smoke-pit-hut [--low].
Blender: E:\Program Files\Blender Foundation\Blender 5.2\blender.exe
KTX tools: e:\Scoop\shims\toktx.exe and e:\Scoop\shims\ktx.exe.
Source scripts live together in E:\Development\Projects\Terrace\.census\building-kit; retain that sibling folder.
No game process is required. Nothing under plugins is overwritten.
