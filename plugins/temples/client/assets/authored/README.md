# Authored temple runtime assets

Original (2048) and low (1024) temple GLBs copied from `E:\Development\Projects\Terrace\.census\temple\`. Both embed three UASTC KTX2 textures with complete mip chains and KHR_texture_basisu. Base colour is sRGB; OpenGL tangent-space normal XYZ and metallic/roughness are linear, without channel swizzle. No Draco or meshopt; geometry matches the PNG GLB exactly.

The first-party stepped temple was rebuilt and textured in Blender. The census package contains editable sources, maps, reproducible scripts, provenance, validation and finished-model renders. Run `python E:\Development\Projects\Terrace\.census\building-kit\integrate_assets.py` to verify and copy both exports.

The game retains the placement origin, +X entrance, footprint and ground contact. Its celestial crown, placement beacon and legality ghost remain separate runtime effects. The building-quality HUD selection swaps the temple alongside the settlement buildings.
