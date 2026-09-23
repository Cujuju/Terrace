# Crimson Cabaret — selected design D

The owner selected the image ending `exec-6a536f4f-2839-4b5f-89fb-ece0523a6c95.png` and asked to preserve every candidate. The six candidates, exact prompts and earlier Durand's concept are retained in `E:\Development\Projects\Terrace\.census\durands-redesign\`.

The replacement carries the selected arched cabaret sign, crimson timber facade, cream pilasters, covered upper gallery, gathered curtains, red lanterns, scalloped canopy and saloon doors. Small ornamental lettering is simplified for Terrace's strategy camera. The illustration is translated into original game geometry, not reconstructed at illustration-level detail.

Geometry is authored in `E:\Development\Projects\Terrace\.census\building-kit\crimson_cabaret.py`, using the shared Blender export/UV pipeline. The sign artwork is independently authored: an original polygonal adult cabaret silhouette, fan, corset and stocking linework, plus Georgia lettering rasterized with Windows System.Drawing. No font file is redistributed. Source paint is reproducible with `prepare_cabaret_paint.ps1`; neither concept pixels nor the previous model's mesh/textures are reused.

Exactly one mesh/material per variant. Roof courses, porch columns, doorway, curtains, lantern housings and galleries have real geometry. The low variant simplifies turned balusters, bevels, roof subdivisions, sign-arch subdivisions and small props. Both variants use the same placement origin, front direction and X/Z bounds. The shorter integrated sign lowers total height to 1.270 world units from the previous 2.060096; the footprint remains 0.824038 × 0.850095.

Windows and lantern glass use warm painted colour. The asset creates no extra lights or emissive material effects. This preserves the three-map, one-material delivery and Terrace's existing lighting setup.

Review corrections included lowering gallery capitals below the roof, joining the sign arch continuously, simplifying unreadable secondary lettering, and correcting the side sign's orientation. Matching 45-degree and close-up renders show the exported models, not concepts. See `comparison.png` and `README.txt` for measured delivery results. The game was not started or stopped during authoring.

The original atlas uses 12-pixel gutters. The low atlas is independently repacked with 9-pixel gutters, exceeding the owner's 8-pixel minimum while recovering usable texel area for signage. All faces retain equal texel density within their atlas; the sign does not receive an unequal-density exception.
