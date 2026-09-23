# Authored building runtime assets

The original and low folders contain byte-identical copies of the verified runtime GLBs in `E:\Development\Projects\Terrace\.census\<building-id>\` and its `low` subfolder. Reproduce the copies, URL table, shared LOD fitting radii and compression audit with `python E:\Development\Projects\Terrace\.census\building-kit\integrate_assets.py`.

All maps are embedded UASTC KTX2, with full mip chains. Original uses 2048 maps and detailed geometry; low uses 1024 maps and simplified geometry. Base colour is sRGB, normal and metallic/roughness are linear RGB with no swizzle. Each GLB has one mesh, one material and one primitive, using KHR_texture_basisu without mesh compression. Geometry is unchanged from the corresponding PNG GLB.

These are original Terrace assets: newly authored geometry, or improvements to Terrace's first-party procedural originals. The timber house uses newly authored geometry and textures; it does not reuse the old CreativeTrio asset. The Viking longhouse is the previously completed original asset. Editable Blender sources, PNG and KTX2 maps, authoring scripts, provenance, dimensions and renders remain in the census packages. The existing Durand's package is installed pending the owner's selection of its replacement design.

Only the selected quality is loaded. During a switch both sets temporarily coexist; the previous scene resources and textures are disposed after the new set is installed. Repeated buildings share geometry and materials through instancing. Both quality variants use the same fitting radius, measured across both exports, so switching quality does not change building scale, rotation, origin or placement. Uniform fitting keeps rotated buildings over surveyed ground.
