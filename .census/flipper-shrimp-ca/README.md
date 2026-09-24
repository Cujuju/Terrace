# Flipper & Shrimp — C + A reconstruction

## Current revision: faces and slide cleanup

The current deliverables are in [revision-2](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/). The root-level files below are retained as the first version for comparison.

- [Updated editable Blender scene](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/flipper-shrimp-ca.blend)
- [Updated detailed GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/flipper-shrimp-ca.glb)
- [Updated lighter GLB](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/flipper-shrimp-ca-light.glb)
- [Updated faces](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/mascots-closeup.png)
- [Slide clearance close-up](E:/Development/Projects/Terrace/.census/flipper-shrimp-ca/revision-2/slides-closeup.png)

Both faces use rounded upper and lower jaw surfaces, recessed mouth interiors, inset eyes and eyelids fitted to the head surface. Their head/body junctions are unified and smoothed. The broad separate lip pieces and flat mouth plates are removed.

The slide trough normals now face outward. Intersecting flat water strips are removed, and water sheen is part of the slide texture. The entry hoops are open arches. The right scallop canopy is moved clear of the coral flume, and both lower bends move inward to clear the lounge decks. Waterfall sheets also sit clear of the stone tiers.

Both GLBs were re-imported and rendered successfully. Each slide has 882 of 882 upward-facing trough polygons, zero vertices inside the lounge decks, and no separate water overlay. The detailed export has 156,730 triangles; the lighter export has 73,640. Both contain 37 material primitives and 25 embedded images. Additional geometry is concentrated in the unified mascot sculpts. Runtime performance remains unmeasured.

The commands below now build and verify `revision-2`.

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
