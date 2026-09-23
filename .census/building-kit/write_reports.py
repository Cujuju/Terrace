"""Write asset delivery notes from measured outputs, never from target counts."""
from pathlib import Path
import json,sys,hashlib
KIT=Path(__file__).parent
ratings=json.loads((KIT/'ratings.json').read_text())
MIB=1048576
for name in sys.argv[1:]:
    root=KIT.parent/name
    original=json.loads((root/'verification.json').read_text());low=json.loads((root/'low'/'verification.json').read_text())
    build=json.loads((root/'build-report.json').read_text());memory=json.loads((root/'memory-report.json').read_text());comp=json.loads((root/'compression-verification.json').read_text())
    assert original['passed'] and low['passed']
    delta=max(abs(a-b) for bound in ('min','max') for a,b in zip(original['bounds_gltf_y_up'][bound],low['bounds_gltf_y_up'][bound]))
    assert delta<.0002,(name,delta)
    era,score,comment=ratings[name]
    table=[]
    for label,check in [('original',original),('low',low)]:
        m=memory['variants'][label]
        table.append(f"{label}: {check['triangles']:,} triangles, {check['exported_vertices']:,} exported vertices; {check['uv_islands']:,} UV islands; minimum island bounds gap {check['minimum_island_bounds_gap_pixels']:.3f} px; density {check['texel_density_min_max'][0]:.3f}-{check['texel_density_min_max'][1]:.3f} px/world unit.\n  GPU mesh {m['geometry_gpu_bytes']/MIB:.3f} MiB; PNG total {m['png_gpu_total_bytes']/MIB:.3f} MiB; KTX2 BC7/ASTC total {m['ktx2_bc7_astc_gpu_total_bytes']/MIB:.3f} MiB.")
    summary=f"""{name} — Terrace building delivery

Original: 2048 x 2048 textures. Low: 1024 x 1024 textures, in low subfolder.
Each variant: editable packed {name}.blend; {name}.glb with embedded PNGs;
{name}-ktx2.glb with embedded UASTC KTX2s; separate basecolor, normal and
metallicRoughness PNG and KTX2 maps. Exactly one mesh, primitive and material.
Hierarchy: RootNode > {name}. Identity object transforms; geometry in world units.
No Draco or meshopt. Runtime KTX2 variants are integrated via the Buildings quality HUD.

Provenance
{build['geometry_source']}
{build['texture_source']}
Concept: {name}-concept.png, built-in image generator. Exact prompt: concept-prompt.txt.
Exact backend image-model version cannot be selected or verified; no version claim.
Shared authoring and validation code derives from the completed in-repo longhouse.
The immutable source-inventory.json records first-party procedural base geometry.
The third-party cottage supplies bounds only, never mesh or texture data.

Historical plausibility (editorial judgment, not an authenticity certification)
{score}/5 — {era}. {comment}
Rubric: 1 fantasy, 2 hybrid/anachronistic, 3 plausible type with substantial stylization,
4 coherent period cues, 5 documented reconstruction. None claims reconstruction.
Broad eras are independent of Terrace tier progression; cultures are not ranked.
Research and full inventory: {KIT / 'README.md'}

Placement and LOD alignment
glTF Y up; entrance {build['placement']['front_gltf']}.
Origin: {build['placement']['origin']}.
Original glTF dimensions X/Y/Z: {original['dimensions_gltf_y_up']}
Bounds: {original['bounds_gltf_y_up']}
Deliberate differences: {build['placement']['deliberate_difference']}
Maximum original/low bounds difference: {delta:.9f} world units.
Low preserves the important silhouette; excludes broad-edge chamfers and reduces
roof segments, curved profiles or small sign detail where applicable.

Measured geometry, UVs and memory
{chr(10).join(table)}
UVs wholly inside 0-1; exported triangles tested for positive-area intersections.
No overlapping islands, collapsed UV triangles or zero-area mesh triangles.
Atlases independently packed at each delivered resolution. Target gap: original
{build['gap_pixels']} px; low {json.loads((root/'low'/'build-report.json').read_text())['gap_pixels']} px.
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
PNG {(sum(v['png_gpu_total_bytes'] for v in memory['variants'].values()))/MIB:.3f} MiB;
KTX2 {(sum(v['ktx2_bc7_astc_gpu_total_bytes'] for v in memory['variants'].values()))/MIB:.3f} MiB.

Screenshots
{name}-45deg.png and {name}-closeup.png render the exported PNG GLB in Blender.
{'durands-front.png also provides a near-frontal view of the restored text, flags and porch.' if name=='durands' else ''}
The low subfolder uses identical cameras and lighting; comparison.png pairs them.
These show finished meshes, not concepts, and are studio renders, not game screenshots.
Artifacts was unavailable; local image delivery is the requested fallback.

Rebuild in PowerShell
python '{KIT / 'run_delivery.py'}' {name}
& '{KIT / 'contact_sheets.ps1'}' -BuildingIds {name}
python '{KIT / 'write_reports.py'}' {name}
Individual build/audit/render scripts: Blender --background --factory-startup
--python-exit-code 1 --python <absolute-script-path> -- --id {name} [--low].
Blender: E:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe
KTX tools: e:\\Scoop\\shims\\toktx.exe and e:\\Scoop\\shims\\ktx.exe.
Source scripts live together in {KIT}; retain that sibling folder.
No game process is required. Build scripts write the census package only; run
integrate_assets.py separately to verify and refresh production KTX2 copies.
"""
    (root/'README.txt').write_text(summary,encoding='utf8')
    (root/'alignment-verification.json').write_text(json.dumps({'max_bounds_delta_world_units':delta,'passed':True},indent=2))
    wrapper=f"from pathlib import Path\nimport subprocess,sys\nsubprocess.run([sys.executable,str(Path(__file__).parent.parent/'building-kit'/'run_delivery.py'),'{name}'],check=True)\n"
    (root/'rebuild.py').write_text(wrapper)
    print(name,'report complete')
