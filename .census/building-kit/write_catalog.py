"""Generate the delivery catalog from final measured assets and editorial ratings."""
from pathlib import Path
import json,hashlib
KIT=Path(__file__).parent.resolve();CENSUS=KIT.parent
ratings=json.loads((KIT/'ratings.json').read_text())
names=[n for n in ratings if n!='longhouse']
def link(label,path):return f'[{label}]({path.as_posix()})'
rows=[];era_rows=[];total_png=0;total_ktx=0
for name in names:
    root=CENSUS/name
    v=json.loads((root/'verification.json').read_text());lo=json.loads((root/'low'/'verification.json').read_text())
    memory=json.loads((root/'memory-report.json').read_text())
    assert json.loads((root/'delivery-verification.json').read_text())['passed']
    assert json.loads((root/'mip-channel-verification.json').read_text())['passed']
    dims=' × '.join(f'{x:.3f}' for x in v['dimensions_gltf_y_up'])
    rows.append(f"| {link(name,root/'README.txt')} | {v['triangles']:,} / {lo['triangles']:,} | {dims} | {link('original / low',root/'comparison.png')} |")
    for m in memory['variants'].values():total_png+=m['png_gpu_total_bytes'];total_ktx+=m['ktx2_bc7_astc_gpu_total_bytes']
for name,(era,score,note) in ratings.items():era_rows.append(f'| {name} | {era} | {score}/5 | {note} |')
readme=f"""# Terrace building asset delivery

22 completed building packages: 17 remaining production building types improved or replaced, plus five new historical types. Each has original 2048 and low 1024 variants. The completed Viking longhouse is retained unchanged as the quality and pipeline reference (50b31cc7, 9e61b621).

{link('Core buildings — finished exported models',KIT/'core-buildings.png')} · {link('Ten fishing buildings',KIT/'coastal-overview.png')} · {link('Five historical additions',KIT/'historical-additions.png')} · {link('Temple comparison',CENSUS/'temple'/'comparison.png')}

Screenshots are Blender studio renders of the actual exported PNG GLBs, not generated concepts or in-game captures. Each package includes matching 45° views, close-ups and an original/low comparison. The Artifact tool was unavailable, so this delivery uses the requested local-file fallback.

## Inventory and provenance

The unfinished inventory was the temple; camp, hut, timber house, stone cottage, watchtower and Durand's; and all ten fishing-hut variants. The timber-house production GLB was the third-party CreativeTrio cottage; the earlier timber experiment changed its textures only. It has been replaced with newly authored timber-frame geometry. Existing first-party procedural models were used as bases and improved under the owner's exception. The temple retains its original stepped design and placement, with rebuilt geometry.

The five additions are prehistoric-granary (Iron Age-inspired), roman-granary, medieval-dovecote, renaissance-workshop (early modern) and industrial-pump-house. They have newly authored geometry and no existing gameplay envelope. Each is fitted inside a 0.86-unit footprint and awaits owner integration.

Original first-party geometry was captured from {CENSUS.parent / 'plugins/temples/client/temple.ts'}, {CENSUS.parent / 'plugins/structures/client/models.ts'} and {CENSUS.parent / 'plugins/structures/client/fishingHuts.ts'}. {link('Frozen source inventory',KIT/'source-inventory.json')} makes the build independent of later edits to those constructors. The production cottage contributes only its measured bounds. No third-party mesh or texture is reused. All new maps are authored procedural paint; concept pixels are not used as texture maps.

Concept images were generated with the built-in image generator and saved with exact prompts in each folder. Its exact backend model cannot be selected or verified. Geometry, UVs, paint, exports and reviews use Blender 5.2.1. Shared authoring helpers derive from the completed longhouse scripts.

## Measured assets

Dimensions are glTF X/Y/Z world units, including ancillary props. Original and low have a common placement origin and aligned bounds. Each README records entrance orientation, ground corrections and deliberate differences. Smoke-pit-hut removes the old static smoke bubbles and preserves the building envelope instead; Durand's retains one static sign pose. Scene lighting and runtime sign animation integration remain the owner's work.

| Building | Triangles original / low | Dimensions X × Y × Z | Screenshots |
|---|---:|---|---|
{chr(10).join(rows)}

Reference longhouse: 4,260 / 3,016 triangles, unchanged. These counts are comparisons, not mandatory budgets.

## Contents and verification

Each building folder contains an editable packed .blend; a GLB with three embedded PNGs; the three standalone PNGs; a separate runtime GLB with embedded UASTC KTX2s; the three standalone KTX2s; concept and prompt; build, UV, placement, compression, mip and memory reports; screenshots; and a rebuild wrapper. The low subfolder contains its independent 1024 atlas, geometry and exports.

All 44 variants passed the delivered audits: exactly one mesh, one primitive and one material; all images packed in the blend; three embedded images matching the standalone files; UVs within 0–1 with no positive-area island overlap; at least 12 pixels between island bounds at the delivered resolution; uniform measured texel density within each atlas; valid tangents; no zero-area exported triangles. Original/low bounds differ by less than 0.0002 world units.

Base colour is sRGB. Normal is linear tangent-space OpenGL/glTF, green +Y, with XYZ retained. MetallicRoughness is linear, G roughness and B metalness, with B exactly zero in PNGs and decoded UASTC at every mip level. Every KTX2 uses UASTC and has a complete chain: 12 levels at 2048, 11 at 1024. No incompatible channel swizzle. KTX-Software glTF-basisu validation passed. Runtime GLBs require KHR_texture_basisu, and preserve geometry accessor bytes, mesh definitions and hierarchy exactly. No Draco or meshopt is present.

{link('Final delivery verification',KIT/'delivery-summary.json')} records the final checks. Each package also includes verification.json, delivery-verification.json, compression-verification.json and mip-channel-verification.json. Decoded UASTC checks do not claim verification of every device-specific hardware transcode. Models were visually inspected; overlapping source trim surfaces, roof joins, buried entrances and ground contact defects were corrected.

## Calculated GPU memory

Assumption: PNG textures occupy RGBA8 GPU storage with complete mip chains: approximately 64 MiB for the three original maps and 16 MiB for low. Assumption: KTX2 transcodes to BC7 or ASTC 4×4, 16 bytes per block: approximately 16 MiB original and 4 MiB low. Add the vertex/index allocation recorded per variant in its memory-report.json. File sizes are not GPU allocation sizes; UASTC downloads can exceed PNG size.

Repeated structures share mesh and texture allocations. Loading both variants adds their allocations. All 22 packages with both variants resident total {total_png/1048576:.2f} MiB under the PNG assumption or {total_ktx/1048576:.2f} MiB under the BC7/ASTC assumption, including exported geometry. These are calculations, not live GPU measurements, and exclude CPU copies, loader buffers, driver overhead, instance data, shaders and framebuffers. An uncompressed runtime fallback can cost PNG-level texture memory.

## Historical plausibility ratings

Assumption: “rate based on historical period” means an editorial plausibility rating, not a progression ranking or an authenticity claim. Rubric: 1 fantasy; 2 intentional hybrid/anachronism; 3 plausible type with substantial stylization; 4 coherent period cues; 5 documented reconstruction. None is presented as a documented reconstruction. Undated fishing vernacular is left undated rather than assigned a false era. Cultural types are not ranked as stages of development.

| Building | Historical reading | Rating | Limits |
|---|---|---:|---|
{chr(10).join(era_rows)}

The interpretations are informed by these institutional references:

- [British Museum: Girsu project](https://www.britishmuseum.org/research/projects/girsu-project) — ancient temple context; Terrace's stone-and-tile summit remains an intentional hybrid.
- [Pembrokeshire Coast: Castell Henllys](https://www.pembrokeshirecoast.wales/castell-henllys/about-castell-henllys/) and [Museum Wales: Bryn Eryr](https://museum.wales/stfagans/bryn-eryr-open/) — Iron Age reconstructed agrarian architecture.
- [Museum Wales: Roman fortress granary](https://museum.wales/blog/1319/Roman-fortress-discovered-underneath-town-centre/) — raised granary floors and protection from damp and vermin.
- [English Heritage: Minster Lovell Hall and Dovecote](https://www.english-heritage.org.uk/visit/places/minster-lovell-hall-and-dovecote/history/) and [National Trust: dovecotes](https://www.nationaltrust.org.uk/discover/history/architecture/what-is-a-dovecote) — medieval and early modern dovecote context.
- [Weald & Downland: medieval shop from Horsham](https://www.wealddown.co.uk/buildings/medieval-shop-from-horsham/) — combined domestic and commercial timber buildings; the modeled counter is interpretive.
- [English Heritage: Shrewsbury Flaxmill Maltings](https://production.english-heritage.org.uk/visit/places/shrewsbury-flaxmill-maltings/history/) — industrial engine-house context; the pump-house is a condensed fictional exterior.
- [National Park Service: tipi activity](https://home.nps.gov/articles/000/create-your-own-tipi.htm) and [Painted Lodges](https://home.nps.gov/glac/learn/education/painted-lodges-narrative.htm) — portable lodge form and cultural specificity.

## Reproduction

PowerShell; requires system Python, Blender 5.2 (bundled NumPy), KTX-Software and this repository. No game process is needed. The source inventory is frozen; inventory.mjs is the optional refresh tool and requires repository Node dependencies. Retain the sibling longhouse reference and {KIT} together with the asset folders.

```powershell
python '{KIT / 'run_delivery.py'}' temple
& '{KIT / 'contact_sheets.ps1'}' -BuildingIds temple
python '{KIT / 'write_reports.py'}' temple
python '{KIT / 'verify_delivery.py'}'
python '{KIT / 'write_catalog.py'}'
```

run_delivery.py runs build, audit, export, matched renders, UASTC packaging, compression inspection and every-mip metalness validation. --original-only and --low-only support isolated revision. prepare_pipeline.py regenerates the shared longhouse-derived scripts; designs.py owns all building-specific authoring. audit_mips.py runs in background Blender; verify_delivery.py runs in system Python. Final checks should run after all build processes finish.

No production plugin files were edited, and the game was not started or stopped. Tracking: [Terrace issue 507](https://github.com/Cujuju/Terrace/issues/507).
"""
(KIT/'README.md').write_text(readme,encoding='utf8')
print('Catalog written for',len(names),'packages')
