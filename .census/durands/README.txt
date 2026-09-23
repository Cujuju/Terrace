durands — Terrace building delivery

Original: 2048 x 2048 textures. Low: 1024 x 1024 textures, in low subfolder.
Each variant: editable packed durands.blend; durands.glb with embedded PNGs;
durands-ktx2.glb with embedded UASTC KTX2s; separate basecolor, normal and
metallicRoughness PNG and KTX2 maps. Exactly one mesh, primitive and material.
Hierarchy: RootNode > durands. Identity object transforms; geometry in world units.
No Draco or meshopt. Runtime KTX2 variants are integrated via the Buildings quality HUD.

Provenance
Original Blender geometry, revised against owner-selected concept D (Crimson Cabaret). No prior mesh or texture maps reused. Central sign is newly generated reference-matched artwork; all other paint is procedural.
Original procedural materials and typeset panels, plus an original generated central sign painting closely referenced to selected concept D; source image and exact prompt retained in building-kit/cabaret-paint.
Concept: durands-concept.png, built-in image generator. Exact prompt: concept-prompt.txt.
Exact backend image-model version cannot be selected or verified; no version claim.
Shared authoring and validation code derives from the completed in-repo longhouse.
The immutable source-inventory.json records first-party procedural base geometry.
The third-party cottage supplies bounds only, never mesh or texture data.

Historical plausibility (editorial judgment, not an authenticity certification)
3/5 — Late nineteenth-century Western cabaret / saloon interpretation. Owner-selected Crimson Cabaret. False front, covered galleries, velvet curtains and painted cabaret emblem are coherent theatrical cues; compressed footprint and large sign are stylized, not a reconstruction.
Rubric: 1 fantasy, 2 hybrid/anachronistic, 3 plausible type with substantial stylization,
4 coherent period cues, 5 documented reconstruction. None claims reconstruction.
Broad eras are independent of Terrace tier progression; cultures are not ranked.
Research and full inventory: E:\Development\Projects\Terrace\.census\building-kit\README.md

Placement and LOD alignment
glTF Y up; entrance +Z.
Origin: Inherited Durand's footprint center at ground.
Original glTF dimensions X/Y/Z: [0.8240382075309753, 1.2699999809265137, 0.8500947952270508]
Bounds: {'min': [-0.41201910376548767, 0.0, -0.4250473976135254], 'max': [0.41201910376548767, 1.2699999809265137, 0.4250473976135254]}
Deliberate differences: Crimson Cabaret revision restores the selected seated figure, text panels and flags. Ground porch projects 3.2 construction units beyond the enclosed facade and 1.6 beyond the upper gallery; awning covers the projecting porch. Overall X/Z envelope retained at 0.824038 x 0.850095 by fitting the complete structure; enclosed body is shallower to reserve porch space. Height about 1.27 rather than the legacy 2.060096. No extra scene lights.
Maximum original/low bounds difference: 0.000000000 world units.
Low preserves the important silhouette; excludes broad-edge chamfers and reduces
roof segments, curved profiles or small sign detail where applicable.

Measured geometry, UVs and memory
original: 7,164 triangles, 13,840 exported vertices; 3,246 UV islands; minimum island bounds gap 12.005 px; density 338.220-338.265 px/world unit.
  GPU mesh 0.675 MiB; PNG total 64.675 MiB; KTX2 BC7/ASTC total 16.675 MiB.
low: 5,296 triangles, 10,404 exported vertices; 2,536 UV islands; minimum island bounds gap 9.001 px; density 141.645-141.658 px/world unit.
  GPU mesh 0.507 MiB; PNG total 16.507 MiB; KTX2 BC7/ASTC total 4.507 MiB.
UVs wholly inside 0-1; exported triangles tested for positive-area intersections.
No overlapping islands, collapsed UV triangles or zero-area mesh triangles.
Atlases independently packed at each delivered resolution. Target gap: original
12 px; low 9 px.
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
PNG 81.181 MiB;
KTX2 21.181 MiB.

Screenshots
durands-45deg.png and durands-closeup.png render the exported PNG GLB in Blender.
durands-front.png also provides a near-frontal view of the restored text, flags and porch.
The low subfolder uses identical cameras and lighting; comparison.png pairs them.
These show finished meshes, not concepts, and are studio renders, not game screenshots.
Artifacts was unavailable; local image delivery is the requested fallback.

Rebuild in PowerShell
python 'E:\Development\Projects\Terrace\.census\building-kit\run_delivery.py' durands
& 'E:\Development\Projects\Terrace\.census\building-kit\contact_sheets.ps1' -BuildingIds durands
python 'E:\Development\Projects\Terrace\.census\building-kit\write_reports.py' durands
Individual build/audit/render scripts: Blender --background --factory-startup
--python-exit-code 1 --python <absolute-script-path> -- --id durands [--low].
Blender: E:\Program Files\Blender Foundation\Blender 5.2\blender.exe
KTX tools: e:\Scoop\shims\toktx.exe and e:\Scoop\shims\ktx.exe.
Source scripts live together in E:\Development\Projects\Terrace\.census\building-kit; retain that sibling folder.
No game process is required. Build scripts write the census package only; run
integrate_assets.py separately to verify and refresh production KTX2 copies.
