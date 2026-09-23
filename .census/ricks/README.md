# Ricks — Black Vault

Owner-selected concept B, faithfully adapted into an original game asset on 2026-09-23. Visual review: `E:\Development\Projects\Terrace\.census\ricks\review.html`. The grouped local page is the fallback because Artifact publishing is unavailable. Its images show actual exported GLBs rendered in Blender, not in-game captures.

## Delivery

Original: `E:\Development\Projects\Terrace\.census\ricks\ricks.blend`, `E:\Development\Projects\Terrace\.census\ricks\ricks.glb`, `E:\Development\Projects\Terrace\.census\ricks\ricks-ktx2.glb`.

Low: `E:\Development\Projects\Terrace\.census\ricks\low\ricks.blend`, `E:\Development\Projects\Terrace\.census\ricks\low\ricks.glb`, `E:\Development\Projects\Terrace\.census\ricks\low\ricks-ktx2.glb`.

Each has one mesh, one material, one primitive and four maps: basecolor, normal, metallicRoughness and emissive. Original: 7,224 triangles and 2048 atlases. Low: 4,880 triangles and 1024 atlases. Packed PNG sources and separate UASTC KTX2 runtime copies are retained, with standalone maps and full mip chains. Basecolor/emission are sRGB; normal/MR are linear. Metalness is zero. No scene lights are exported.

Both variants have the same envelope and placement: entrance glTF +Z, ground at Y=0, approximately X 0.860 × Y 0.386 × Z 0.726 world units. The existing runtime fitting code uses their shared measured radius, approximately 0.504242 units.

## Fidelity and lighting

Preserved features: sloped chamfered bunker, three octagonal roof drums, green clerestory belt, framed roof vents, recessed double door, five steps, raised Ricks lettering, raised gold biohazard emblem, amber markers and red beacon. Lettering uses installed Windows Segoe fonts, converted to geometry; font binaries are not redistributed. All geometry and procedural maps are original. No concept pixels are sampled for textures.

Assumption: the unseen rear extends the selected front-right design. Low simplifies curves, louvers and fasteners while preserving the silhouette and all emissive regions.

Emission strength 1.6 and the dedicated emissive mask survive PNG-to-KTX2 packaging. The atlas is black outside green glazing, amber fixtures and red beacon. Both variants remain visible with world and sun energy zero; emission-off control frames are black. No bloom was used. Evidence: `E:\Development\Projects\Terrace\.census\ricks\lighting-verification.json`. Blender may show local light from emissive surfaces; Terrace's emissive materials remain self-lit without adding scene lights.

## Game integration

Runtime copies: `E:\Development\Projects\Terrace\plugins\structures\client\assets\authored\original\ricks.glb` and `E:\Development\Projects\Terrace\plugins\structures\client\assets\authored\low\ricks.glb`. Both participate in the existing Buildings quality switch and surveyed-ground fitting.

Assumption: Ricks appears as a rare top-tier inland cosmetic variant, like Durand's. It takes 24/256 cell-hash buckets after Durand's unchanged 43 buckets: about 9.375% of eligible cells. Coastal variants retain precedence. Terrain math, server simulation, persistence and tier progression are unchanged. No bioweapon behavior is implemented. One pooled instanced mesh is allocated at attach; placement creates no materials or lights.

The existing preview page supports `?ricks=1&quality=original` and `?ricks=1&quality=low`; append `&unlit=1` to remove external lighting. Entry point: `E:\Development\Projects\Terrace\client\src\previewStructures.ts`. The app was not started or stopped.

## Verification

Geometry, UV overlap/padding/density, packed images, UASTC validation, all metalness mips, matching bounds, and byte-identical geometry between PNG and KTX2 GLBs passed. Runtime files match the delivery by SHA-256. Reports and manifest are beside the models.

Client build and structures typecheck passed. Existing structures tests: 195 passed, two failed on unchanged <=6-tier assertions; the existing protocol already has eleven tiers. Workspace typecheck reports existing Buffer/Uint8Array incompatibilities in `E:\Development\Projects\Terrace\client\test\rigAsset.test.ts`. No diagnostics occur in changed source files. No tests were added or changed.

## Rebuild

Use installed Blender 5.2, KTX-Software, Python and Windows Segoe fonts:

```powershell
python 'E:\Development\Projects\Terrace\.census\building-kit\run_delivery.py' ricks
python 'E:\Development\Projects\Terrace\.census\building-kit\integrate_assets.py'
& 'E:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --threads 8 --python-exit-code 1 --python 'E:\Development\Projects\Terrace\.census\building-kit\render_ricks_lighting.py'
python 'E:\Development\Projects\Terrace\.census\ricks\build_review.py'
```

Authoring source: `E:\Development\Projects\Terrace\.census\building-kit\black_vault.py`. The existing shared pipeline now supports an optional fourth emissive atlas without altering three-map buildings.
