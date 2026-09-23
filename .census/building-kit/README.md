# Terrace building asset delivery

22 completed building packages: 17 remaining production building types improved or replaced, plus five new historical types. Each has original 2048 and low 1024 variants. The completed Viking longhouse is retained unchanged as the quality and pipeline reference (50b31cc7, 9e61b621).

[Core buildings — finished exported models](E:/Development/Projects/Terrace/.census/building-kit/core-buildings.png) · [Ten fishing buildings](E:/Development/Projects/Terrace/.census/building-kit/coastal-overview.png) · [Five historical additions](E:/Development/Projects/Terrace/.census/building-kit/historical-additions.png) · [Temple comparison](E:/Development/Projects/Terrace/.census/temple/comparison.png)

Screenshots are Blender studio renders of the actual exported PNG GLBs, not generated concepts or in-game captures. Each package includes matching 45° views, close-ups and an original/low comparison. The Artifact tool was unavailable, so this delivery uses the requested local-file fallback.

## Inventory and provenance

The unfinished inventory was the temple; camp, hut, timber house, stone cottage, watchtower and Durand's; and all ten fishing-hut variants. The timber-house production GLB was the third-party CreativeTrio cottage; the earlier timber experiment changed its textures only. It has been replaced with newly authored timber-frame geometry. Existing first-party procedural models were used as bases and improved under the owner's exception. The temple retains its original stepped design and placement, with rebuilt geometry.

The five additions are prehistoric-granary (Iron Age-inspired), roman-granary, medieval-dovecote, renaissance-workshop (early modern) and industrial-pump-house. They have newly authored geometry, each fitted inside a 0.86-unit footprint. The owner subsequently selected an eleven-stage historical game progression; all buildings now have integrated KTX2 original/low variants and a live Buildings quality HUD.

Original first-party geometry was captured from E:\Development\Projects\Terrace\plugins\temples\client\temple.ts, E:\Development\Projects\Terrace\plugins\structures\client\models.ts and E:\Development\Projects\Terrace\plugins\structures\client\fishingHuts.ts. [Frozen source inventory](E:/Development/Projects/Terrace/.census/building-kit/source-inventory.json) makes the build independent of later edits to those constructors. The production cottage contributes only its measured bounds. No third-party mesh or texture is reused. Maps use original procedural paint and typesetting. Crimson Cabaret additionally uses a new generated sign painting closely referenced to its selected concept; the painting and exact prompt are retained in building-kit/cabaret-paint.

Concept images were generated with the built-in image generator and saved with exact prompts in each folder. Its exact backend model cannot be selected or verified. Geometry, UVs, paint, exports and reviews use Blender 5.2.1. Shared authoring helpers derive from the completed longhouse scripts.

## Measured assets

Dimensions are glTF X/Y/Z world units, including ancillary props. Original and low have a common placement origin and aligned bounds. Each README records entrance orientation, ground corrections and deliberate differences. Smoke-pit-hut removes the old static smoke bubbles and preserves the building envelope instead. Durand's is now the owner-selected Crimson Cabaret: newly authored geometry and paint, replacing the old giant dancer with an arched cabaret sign, crimson facade and covered galleries. The six alternative concepts and earlier reference remain archived. Amber windows and red-orange lantern glass now use a fourth emissive texture; the building adds no scene lights.

| Building | Triangles original / low | Dimensions X × Y × Z | Screenshots |
|---|---:|---|---|
| [temple](E:/Development/Projects/Terrace/.census/temple/README.txt) | 1,232 / 948 | 2.180 × 1.800 × 2.000 | [original / low](E:/Development/Projects/Terrace/.census/temple/comparison.png) |
| [camp](E:/Development/Projects/Terrace/.census/camp/README.txt) | 803 / 379 | 0.864 × 0.645 × 0.537 | [original / low](E:/Development/Projects/Terrace/.census/camp/comparison.png) |
| [hut](E:/Development/Projects/Terrace/.census/hut/README.txt) | 1,236 / 548 | 0.777 × 0.850 × 0.777 | [original / low](E:/Development/Projects/Terrace/.census/hut/comparison.png) |
| [timber-house](E:/Development/Projects/Terrace/.census/timber-house/README.txt) | 1,632 / 1,040 | 0.585 × 0.539 × 0.909 | [original / low](E:/Development/Projects/Terrace/.census/timber-house/comparison.png) |
| [stone-cottage](E:/Development/Projects/Terrace/.census/stone-cottage/README.txt) | 3,688 / 1,572 | 0.740 × 0.960 × 0.530 | [original / low](E:/Development/Projects/Terrace/.census/stone-cottage/comparison.png) |
| [watchtower](E:/Development/Projects/Terrace/.census/watchtower/README.txt) | 3,096 / 1,174 | 0.660 × 2.000 × 0.678 | [original / low](E:/Development/Projects/Terrace/.census/watchtower/comparison.png) |
| [durands](E:/Development/Projects/Terrace/.census/durands/README.txt) | 7,164 / 5,296 | 0.824 × 1.270 × 0.850 | [original / low](E:/Development/Projects/Terrace/.census/durands/comparison.png) |
| [reed-cone](E:/Development/Projects/Terrace/.census/reed-cone/README.txt) | 1,368 / 728 | 0.625 × 0.750 × 0.707 | [original / low](E:/Development/Projects/Terrace/.census/reed-cone/comparison.png) |
| [lashed-a-frame](E:/Development/Projects/Terrace/.census/lashed-a-frame/README.txt) | 1,036 / 580 | 0.625 × 0.717 × 0.683 | [original / low](E:/Development/Projects/Terrace/.census/lashed-a-frame/comparison.png) |
| [stilted-hut](E:/Development/Projects/Terrace/.census/stilted-hut/README.txt) | 1,088 / 642 | 0.476 × 0.715 × 0.631 | [original / low](E:/Development/Projects/Terrace/.census/stilted-hut/comparison.png) |
| [windbreak-dome](E:/Development/Projects/Terrace/.census/windbreak-dome/README.txt) | 1,194 / 728 | 0.651 × 0.280 × 0.673 | [original / low](E:/Development/Projects/Terrace/.census/windbreak-dome/comparison.png) |
| [upturned-hull](E:/Development/Projects/Terrace/.census/upturned-hull/README.txt) | 902 / 582 | 0.468 × 0.493 × 0.642 | [original / low](E:/Development/Projects/Terrace/.census/upturned-hull/comparison.png) |
| [twin-hut-yard](E:/Development/Projects/Terrace/.census/twin-hut-yard/README.txt) | 2,106 / 1,130 | 0.880 × 0.524 × 0.880 | [original / low](E:/Development/Projects/Terrace/.census/twin-hut-yard/comparison.png) |
| [drying-rack-long-hut](E:/Development/Projects/Terrace/.census/drying-rack-long-hut/README.txt) | 952 / 688 | 0.629 × 0.478 × 0.691 | [original / low](E:/Development/Projects/Terrace/.census/drying-rack-long-hut/comparison.png) |
| [turf-roof-on-stone](E:/Development/Projects/Terrace/.census/turf-roof-on-stone/README.txt) | 2,038 / 744 | 0.510 × 0.470 × 0.609 | [original / low](E:/Development/Projects/Terrace/.census/turf-roof-on-stone/comparison.png) |
| [net-draped-cone](E:/Development/Projects/Terrace/.census/net-draped-cone/README.txt) | 2,416 / 1,664 | 0.756 × 0.660 × 0.646 | [original / low](E:/Development/Projects/Terrace/.census/net-draped-cone/comparison.png) |
| [smoke-pit-hut](E:/Development/Projects/Terrace/.census/smoke-pit-hut/README.txt) | 1,772 / 1,116 | 0.706 × 0.655 × 0.659 | [original / low](E:/Development/Projects/Terrace/.census/smoke-pit-hut/comparison.png) |
| [prehistoric-granary](E:/Development/Projects/Terrace/.census/prehistoric-granary/README.txt) | 876 / 524 | 0.784 × 0.806 × 0.860 | [original / low](E:/Development/Projects/Terrace/.census/prehistoric-granary/comparison.png) |
| [roman-granary](E:/Development/Projects/Terrace/.census/roman-granary/README.txt) | 1,140 / 836 | 0.545 × 0.481 × 0.860 | [original / low](E:/Development/Projects/Terrace/.census/roman-granary/comparison.png) |
| [medieval-dovecote](E:/Development/Projects/Terrace/.census/medieval-dovecote/README.txt) | 484 / 436 | 0.860 × 1.219 × 0.860 | [original / low](E:/Development/Projects/Terrace/.census/medieval-dovecote/comparison.png) |
| [renaissance-workshop](E:/Development/Projects/Terrace/.census/renaissance-workshop/README.txt) | 1,820 / 1,180 | 0.715 × 0.832 × 0.860 | [original / low](E:/Development/Projects/Terrace/.census/renaissance-workshop/comparison.png) |
| [industrial-pump-house](E:/Development/Projects/Terrace/.census/industrial-pump-house/README.txt) | 1,214 / 910 | 0.765 × 0.935 × 0.860 | [original / low](E:/Development/Projects/Terrace/.census/industrial-pump-house/comparison.png) |

Reference longhouse: 4,260 / 3,016 triangles, unchanged. These counts are comparisons, not mandatory budgets.

## Contents and verification

Each building folder contains an editable packed .blend; a GLB with three embedded PNGs; the three standalone PNGs; a separate runtime GLB with embedded UASTC KTX2s; the three standalone KTX2s (plus a fourth emissive PNG/KTX2 for Crimson Cabaret); concept and prompt; build, UV, placement, compression, mip and memory reports; screenshots; and a rebuild wrapper. The low subfolder contains its independent 1024 atlas, geometry and exports.

All 44 variants passed the delivered audits: exactly one mesh, one primitive and one material; all images packed in the blend; three embedded images (four for Crimson Cabaret) matching the standalone files; UVs within 0–1 with no positive-area island overlap; at least the required 8 pixels between island bounds at the delivered resolution (12-pixel target, except the repacked Crimson Cabaret low atlas at 9); uniform measured texel density within each atlas; valid tangents; no zero-area exported triangles. Original/low bounds differ by less than 0.0002 world units.

Base colour is sRGB. Normal is linear tangent-space OpenGL/glTF, green +Y, with XYZ retained. MetallicRoughness is linear, G roughness and B metalness, with B exactly zero in PNGs and decoded UASTC at every mip level. Every KTX2 uses UASTC and has a complete chain: 12 levels at 2048, 11 at 1024. No incompatible channel swizzle. KTX-Software glTF-basisu validation passed. Runtime GLBs require KHR_texture_basisu, and preserve geometry accessor bytes, mesh definitions and hierarchy exactly. No Draco or meshopt is present.

[Final delivery verification](E:/Development/Projects/Terrace/.census/building-kit/delivery-summary.json) records the final checks. Each package also includes verification.json, delivery-verification.json, compression-verification.json and mip-channel-verification.json. Decoded UASTC checks do not claim verification of every device-specific hardware transcode. Models were visually inspected; overlapping source trim surfaces, roof joins, buried entrances and ground contact defects were corrected.

## Calculated GPU memory

Assumption: PNG textures occupy RGBA8 GPU storage with complete mip chains: approximately 64 MiB for the three original maps and 16 MiB for low. Assumption: KTX2 transcodes to BC7 or ASTC 4×4, 16 bytes per block: approximately 16 MiB original and 4 MiB low. Crimson Cabaret has a fourth emissive map, adding approximately 5.333 MiB original / 1.333 MiB low under BC7/ASTC, or 21.333 / 5.333 MiB under RGBA8. Add the vertex/index allocation recorded per variant in its memory-report.json. File sizes are not GPU allocation sizes; UASTC downloads can exceed PNG size.

Repeated structures share mesh and texture allocations. Loading both variants adds their allocations. All 22 packages with both variants resident total 1792.80 MiB under the PNG assumption or 452.81 MiB under the BC7/ASTC assumption, including exported geometry. These are calculations, not live GPU measurements, and exclude CPU copies, loader buffers, driver overhead, instance data, shaders and framebuffers. An uncompressed runtime fallback can cost PNG-level texture memory.

## Historical plausibility ratings

Assumption: “rate based on historical period” means an editorial plausibility rating, not a progression ranking or an authenticity claim. Rubric: 1 fantasy; 2 intentional hybrid/anachronism; 3 plausible type with substantial stylization; 4 coherent period cues; 5 documented reconstruction. None is presented as a documented reconstruction. Undated fishing vernacular is left undated rather than assigned a false era. Cultural types are not ranked as stages of development.

| Building | Historical reading | Rating | Limits |
|---|---|---:|---|
| temple | Ancient stepped-temple inspired fantasy | 2/5 | Retains Terrace's ziggurat mass, but dressed stone and tiled summit are an intentional stylistic hybrid, not a reconstruction. |
| camp | Plains tipi-inspired portable camp | 3/5 | Recognizable lodgepole and hide structure; simplified closure and hearth. A cultural building type, not a universal prehistoric era. |
| hut | Iron Age-inspired agrarian vernacular | 3/5 | Round daub body, bindings and conical thatch are plausible; vent and proportions remain game stylization. |
| timber-house | Late medieval timber-frame cottage | 4/5 | Visible timber bracing, infill and tile courses; compact game proportions and broad joints. |
| longhouse | Viking Age-inspired hall, c. 800-1100 CE | 3/5 | Completed reference retained. Carved gables are stylistic; tiled appearance, shutters and chimney-free proportions are not site-specific reconstruction. |
| stone-cottage | Medieval to early modern stone cottage | 4/5 | Masonry walls, dressed corners, pitched tile roof and chimney are legible; exact region and date unspecified. |
| watchtower | High/late medieval watchtower | 3/5 | Masonry shaft, arrow slits and corbelled parapet are plausible; very tall narrow proportions and roof are stylized. |
| durands | Late nineteenth-century Western cabaret / saloon interpretation | 3/5 | Owner-selected Crimson Cabaret. False front, covered galleries, velvet curtains and painted cabaret emblem are coherent theatrical cues; compressed footprint and large sign are stylized, not a reconstruction. |
| reed-cone | Preindustrial coastal vernacular; undated | 3/5 | Reed roof, daub and fish processing are plausible; no specific culture or archaeological site is claimed. |
| lashed-a-frame | Preindustrial temporary fishing shelter; undated | 3/5 | Lashed poles and steep reed cover are plausible; stylized closed entry and simplified lashings. |
| stilted-hut | Preindustrial waterside vernacular; undated | 3/5 | Raised platform, access ramp and pile braces fit the function; no regional attribution. |
| windbreak-dome | Preindustrial woven shelter; undated | 3/5 | Woven dome and separate windbreak are functionally plausible, but not a documented site reconstruction. |
| upturned-hull | Preindustrial boat-reuse fishing shelter; undated | 3/5 | Inverted hull silhouette and daub base are a vernacular interpretation, not a securely dated type. |
| twin-hut-yard | Preindustrial fishing compound; undated | 3/5 | Shared work yard and paired huts are plausible. Ground disk and fish scale are game conventions. |
| drying-rack-long-hut | Preindustrial fish-processing hut; undated | 4/5 | Drying rack, hanging catch and low reed roof explain the function without modern equipment; region unspecified. |
| turf-roof-on-stone | Northern preindustrial turf-roof vernacular | 3/5 | Stone footings and turf cover are plausible; pyramidal roof is an inherited stylization, not a Norse reconstruction. |
| net-draped-cone | Preindustrial coastal fishing hut; undated | 3/5 | Net stakes, floats and reed cover support the function; no era-specific archaeological claim. |
| smoke-pit-hut | Preindustrial fish-smoking compound; undated | 3/5 | Hearth, smoking spit and hut are functionally readable; static smoke bubbles were removed and the hearth is delivered cold/unlit. |
| prehistoric-granary | Iron Age-inspired raised grain store | 3/5 | Raised timber store and ladder reflect reconstructed agrarian storage; stone rodent guards are an interpretive addition, not a claimed excavated detail. |
| roman-granary | Roman provincial granary, c. 1st-4th century CE | 4/5 | Raised ventilated base, buttresses and tile roof are based on documented granary principles; dimensions condensed for gameplay. |
| medieval-dovecote | Medieval/early modern dovecote, c. 13th-17th century | 4/5 | Masonry tower, flight holes and roof lantern suit the type; polygonal plan is stylized. |
| renaissance-workshop | Early modern European workshop, c. 15th-17th century | 3/5 | Jettied timber frame and shop counter are plausible; general period interpretation, not an identified Renaissance building. |
| industrial-pump-house | Industrial steam era, c. 19th century | 4/5 | Brick engine-house form, tall chimney and slate roof fit industrial architecture; interior machinery is not modeled. |

The interpretations are informed by these institutional references:

- [British Museum: Girsu project](https://www.britishmuseum.org/research/projects/girsu-project) — ancient temple context; Terrace's stone-and-tile summit remains an intentional hybrid.
- [Pembrokeshire Coast: Castell Henllys](https://www.pembrokeshirecoast.wales/castell-henllys/about-castell-henllys/) and [Museum Wales: Bryn Eryr](https://museum.wales/stfagans/bryn-eryr-open/) — Iron Age reconstructed agrarian architecture.
- [Museum Wales: Roman fortress granary](https://museum.wales/blog/1319/Roman-fortress-discovered-underneath-town-centre/) — raised granary floors and protection from damp and vermin.
- [English Heritage: Minster Lovell Hall and Dovecote](https://www.english-heritage.org.uk/visit/places/minster-lovell-hall-and-dovecote/history/) and [National Trust: dovecotes](https://www.nationaltrust.org.uk/discover/history/architecture/what-is-a-dovecote) — medieval and early modern dovecote context.
- [Weald & Downland: medieval shop from Horsham](https://www.wealddown.co.uk/buildings/medieval-shop-from-horsham/) — combined domestic and commercial timber buildings; the modeled counter is interpretive.
- [English Heritage: Shrewsbury Flaxmill Maltings](https://production.english-heritage.org.uk/visit/places/shrewsbury-flaxmill-maltings/history/) — industrial engine-house context; the pump-house is a condensed fictional exterior.
- [National Park Service: tipi activity](https://home.nps.gov/articles/000/create-your-own-tipi.htm) and [Painted Lodges](https://home.nps.gov/glac/learn/education/painted-lodges-narrative.htm) — portable lodge form and cultural specificity.

## Reproduction

PowerShell; requires system Python, Blender 5.2 (bundled NumPy), KTX-Software and this repository. No game process is needed. The source inventory is frozen; inventory.mjs is the optional refresh tool and requires repository Node dependencies. Retain the sibling longhouse reference and E:\Development\Projects\Terrace\.census\building-kit together with the asset folders.

```powershell
python 'E:\Development\Projects\Terrace\.census\building-kit\run_delivery.py' temple
& 'E:\Development\Projects\Terrace\.census\building-kit\contact_sheets.ps1' -BuildingIds temple
python 'E:\Development\Projects\Terrace\.census\building-kit\write_reports.py' temple
python 'E:\Development\Projects\Terrace\.census\building-kit\verify_delivery.py'
python 'E:\Development\Projects\Terrace\.census\building-kit\write_catalog.py'
```

run_delivery.py runs build, audit, export, matched renders, UASTC packaging, compression inspection and every-mip metalness validation. --original-only and --low-only support isolated revision. prepare_pipeline.py regenerates the shared longhouse-derived scripts; designs.py owns all building-specific authoring. audit_mips.py runs in background Blender; verify_delivery.py runs in system Python. Final checks should run after all build processes finish.

No production plugin files were edited, and the game was not started or stopped. Tracking: [Terrace issue 507](https://github.com/Cujuju/Terrace/issues/507).
