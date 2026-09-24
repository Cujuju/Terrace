# Flipper & Shrimp — C + A reconstruction

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
