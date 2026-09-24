# Flipper & Shrimp — C + A reconstruction

Revision 4 is now wired into the game's existing coastal clubhouse slot: Low uses the unchanged 42,507-triangle export and Original uses the unchanged 90,294-triangle export. Both preserve all 37 material parts and 38 PNG images. Runtime copies and measured fitting radius are refreshed by `python E:\Development\Projects\Terrace\.census\building-kit\integrate_assets.py flipper-shrimp`. The standalone delivery notes below describe the authoring stages before this integration; frame cost remains unmeasured.

## Current revision: simplified slides, UV ropes and shells

Current files are in [revision-4](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-4/). Revision 3 remains available for comparison.

- [Editable Blender scene](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-4/flipper-shrimp-ca.blend)
- [Detailed GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-4/flipper-shrimp-ca.glb)
- [Lighter GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-4/flipper-shrimp-ca-light.glb)
- [Overall render](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-4/flipper-shrimp-ca.png)

| Geometry | Revision 3 | Revision 4 |
| --- | ---: | ---: |
| Slides and rims | 11,240 | 2,232 |
| Rope details | 7,708 | 2,680 |
| Shell decorations | 10,674 | 1,056 |
| Full asset | 113,948 | 90,294 |
| Lighter export | 53,412 | 42,507 |

The detailed asset loses 23,654 triangles (20.8%). These three groups lose 79.9% of their triangles; the other groups retain their prior geometry counts. Slides use 28 longitudinal samples and a closed cross-section with integrated rims. Suspended ropes use crossed, opaque UV strips; wraps use eight-sided open bands with UV-painted courses and fibre normals. Three connected shell fans replace the overlapping lobes and rib tubes. Normal and color maps carry the fine shell ribs. The shell silhouettes are more compact and the ropes have less volume at close inspection.

The brick/rock, barnacle and mascot texture files are retained unchanged. Light emission is retained. Build and verification commands below now produce revision 4; `verification.json` records actual export counts, slide topology and texture hash comparisons. Runtime performance has not been measured.

## Previous revision: shallow relief, clear slides, coastal textures

The current deliverables are in [revision-3](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-3/). Earlier versions remain available for comparison.

- [Editable Blender scene](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-3/flipper-shrimp-ca.blend)
- [Detailed GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-3/flipper-shrimp-ca.glb)
- [Lighter GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-3/flipper-shrimp-ca-light.glb)

The dolphin and shrimp are shallow bevelled relief ornaments. The dolphin has a tapered beak, dorsal fin, raised flipper and broad flukes; the shrimp has a curled shell, rostrum, antennae, walking legs and fan tail. Eyes, closed smiles, belly paint and shell divisions are image textures. There are no separate eye spheres or open mouth meshes. The reproducible artwork is in `painted_reliefs.py`.

The slides retain continuous U-shaped troughs and textured sheen. Entrance arches are removed and support posts terminate below the sampled trough centreline. Rock uses mineral mottling, flecks, pitted normal maps and roughness maps with varied UV offsets. Lower pier posts use clustered barnacle color, normal and roughness maps on simple cylindrical sleeves. Lanterns and the lighthouse use emissive materials with strength 6; the audit records the exported emission and renders the re-imported asset under dim studio lighting.

The detailed inspection results for revision 3 are in that folder's `verification.json`. Water remains static and the asset is not integrated into the game.

Current geometry is 113,948 triangles in the detailed asset and 53,412 in the lighter export. Both retain the same painted faces, rock and barnacle maps, and emission. The brick and barnacle appearance should be preserved in later optimization. Measured costs in the detailed source: slides with rolled rims 11,240; shell ornaments/canopy 10,674; pier posts/caps/rope collars 14,760; stone blocks 8,096; barnacle sleeves 1,408. Further savings can come from fewer curve segments and bevels, normal-mapped shell ribs, simpler small trim, and removing hidden stone faces. A 25–35k presentation asset is an unverified target, not a delivered count.

Both exported meshes were re-imported and rendered. They contain 34 material primitives and 32 embedded images. Each slide has 882/882 upward-facing trough polygons, no separate water overlays and zero trough vertices inside the lounge decks. All 17 small lanterns and the lighthouse use the same emissive material; the GLB retains its `KHR_materials_emissive_strength` value of 6. Triangle count alone does not measure runtime cost: texture memory and material batches still require in-game measurement.

## Previous revision: faces and slide cleanup

The current deliverables are in [revision-2](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/). The root-level files below are retained as the first version for comparison.

- [Updated editable Blender scene](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/flipper-shrimp-ca.blend)
- [Updated detailed GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/flipper-shrimp-ca.glb)
- [Updated lighter GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/flipper-shrimp-ca-light.glb)
- [Updated faces](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/mascots-closeup.png)
- [Slide clearance close-up](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/slides-closeup.png)

Both faces use rounded upper and lower jaw surfaces, recessed mouth interiors, inset eyes and eyelids fitted to the head surface. Their head/body junctions are unified and smoothed. The broad separate lip pieces and flat mouth plates are removed.

The slide trough normals now face outward. Intersecting flat water strips are removed, and water sheen is part of the slide texture. The entry hoops are open arches. The right scallop canopy is moved clear of the coral flume, and both lower bends move inward to clear the lounge decks. Waterfall sheets also sit clear of the stone tiers.

Both GLBs were re-imported and rendered successfully. Each slide has 882 of 882 upward-facing trough polygons, zero vertices inside the lounge decks, and no separate water overlay. The detailed export has 156,730 triangles; the lighter export has 73,640. Both contain 37 material primitives and 25 embedded images. Additional geometry is concentrated in the unified mascot sculpts. Runtime performance remains unmeasured.

This revision is retained for comparison; the commands below build the current revision.

Editable Blender asset and reproducible build, authored against the owner-supplied C + A reference. This is a separate replacement candidate; the existing asset and game are preserved.

The rooftop dolphin and shrimp are retained. The duplicate slide heads are omitted under the owner's explicit fidelity tradeoff. The paired blue/coral sweeping slides, raised pier, lighthouse, central cascade, scallop canopy, equal lounge areas, nautical signs and warm lanterns are retained.

Surface grain, shingle overlaps, rope strands, water caustics and stone mottling use original reusable texture maps. Only silhouettes, large joints and visible relief receive geometry. No pixels from the concept are used as model textures.

Build with Blender 5.2:

```powershell
& 'E:\Development\Projects\Terrace\.census\flipper-shrimp-ca\paint_signs.ps1'
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --threads 8 --python-exit-code 1 --python 'E:\Development\Projects\Terrace\.census\flipper-shrimp-ca\build.py'
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --threads 8 --python-exit-code 1 --python 'E:\Development\Projects\Terrace\.census\flipper-shrimp-ca\verify_export.py'
```

Validation measurements and known limitations are recorded in `verification.json` after generation. Review images show actual Blender geometry. The Artifact publishing tool is unavailable in this session, so local delivery is used.

## Delivery

| File | Contents |
| --- | --- |
| [Editable Blender scene](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/flipper-shrimp-ca.blend) | 1,507 named authoring parts, packed textures, studio and camera in a separate collection |
| [Detailed GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/flipper-shrimp-ca.glb) | 127,116 triangles; one mesh; 33 material primitives |
| [Lighter GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/flipper-shrimp-ca-light.glb) | 59,248 triangles; one mesh; same embedded textures |
| [Overall render](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/flipper-shrimp-ca.png) | Detailed Blender source |
| [Mascot close-up](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/mascots-closeup.png) | Actual dolphin and shrimp geometry |
| [Detailed export render](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/export-roundtrip.png) | Rendered after importing the delivered GLB |
| [Lighter export render](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/lighter-export-roundtrip.png) | Rendered after importing the lighter GLB |

Both GLBs use a 0.86-unit maximum horizontal footprint, glTF +Z front, and a centred ground origin. The Blender scene retains larger authoring units. Studio lights and ground are excluded from both exports. Surface detail uses 21 embedded image textures, including a sign atlas, netting and foam alpha textures, and base-color/normal pairs. All maps are authored here; no generated concept pixels are projected onto the model.

The initial all-geometry lettering and foam version measured 208,042 triangles. Painted lettering, foam decals and simpler hidden bevels removed most of that excess. The final detailed version retains the extra silhouette geometry in characters, curved flumes, nautical trim and vegetation. A separate collapsed mesh reduces geometry by 53.4%; it is optional, and the editable source is preserved.

This is a stylized reconstruction, with fewer small decorative props and simpler water/vegetation than the reference. The two slide-head copies are deliberately omitted. Water is static. In-game integration, animation, runtime frame cost and texture compression are not part of this delivery; 33 material primitives should not be mistaken for one draw call.

The export audit checks the GLB container, embedded images, alpha materials, triangle counts and footprint, then imports and renders both files. No application server/client was started and no game source was changed.
