# Crimson Cabaret — selected design D, revised to match the concept

The owner selected the image ending exec-6a536f4f-2839-4b5f-89fb-ece0523a6c95.png and requested that every candidate remain preserved. All six candidates, prompts and the earlier Durand's concept remain in E:\Development\Projects\Terrace\.census\durands-redesign\.

This revision addresses the owner's visual review:
- The central sign now carries the reference's seated, right-facing cabaret figure, supporting left arm, burgundy corset, raised knee, high heel and large red feather fan, with ornate Durand's lettering.
- Text returns to both false-front wings and the panels flanking the ground-floor entrance. The tall side panel reads Durand's / Saloon / Girls / Rooms; the awning reads Good Drinks - Better Company.
- Two hanging crimson heart banners project forward at the front corners. Their heart outlines have geometry so they remain visible at low texture resolution.
- The timber ground-floor porch extends beyond the enclosed building and upper gallery. The awning starts at the gallery edge and covers the external porch, with a scalloped gold hem, supporting rods, outer rails, newels and entrance steps.

Geometry is authored in E:\Development\Projects\Terrace\.census\building-kit\crimson_cabaret.py. The central painting is a new output from the built-in image generator, closely referenced to concept D; its exact backend version is unverified. The retained image and prompt are E:\Development\Projects\Terrace\.census\building-kit\cabaret-paint\front-reference.png and front-reference-prompt.txt. Rebuilds use this fixed source image rather than generating another. Other materials and lettering are original procedural paint and Windows Georgia typesetting. No font file, existing model mesh or existing model texture is redistributed.

Both variants retain one mesh and one material, ground contact at zero, the +Z entrance, common origin and the overall inherited 0.824038 x 0.850095 X/Z envelope. The enclosed body is shallower within that envelope to reserve room for the external porch. In construction coordinates, the facade is Y=-2.595, upper gallery edge -4.195, outer porch edge -5.80 and awning edge -5.64; geometry is then fitted to the shared footprint before uniform-density UV packing. The porch therefore projects 3.205 construction units beyond the facade and 1.605 beyond the gallery. Height remains approximately 1.270 world units.

The original atlas uses 12-pixel gutters; the independently packed low atlas uses 9, above the required 8. All faces retain even texel density within each atlas. Source sign paint is sampled over the atlas texel footprint to reduce broken thin strokes. Fine text is present in both variants, but readability at strategy-camera distance remains limited by the delivered resolution, particularly low. No unequal-density sign exception is used.

Matching 45-degree, close-up and near-frontal images render the exported PNG GLBs. These are finished-model studio renders, not concepts or game screenshots. The game is not started or stopped for this work. Validation, KTX2 channel/mip verification and calculated memory are recorded in README.txt and the JSON reports.
