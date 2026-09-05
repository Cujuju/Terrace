# Species sheet: pass 8 — the sperm whale (`whale`, variant 2) and the end of the procedural whale

Generic brief: `.claude/orchestration/briefs/species-glb-pass-template.md` — read it FIRST. Then
`humpback-glb-pass6.md` + report and `blue-whale-glb-pass7.md` + report: the whale-asset pattern
(`species/whale.ts`: `WHALE_JOINTS`, `whaleEnvelope(halfWidth)`, `animateWhale`; every whale asset
FILLS crownY 0.670 / bellyY −0.575 / length 5.05 exactly; one REST envelope; `flukes` hinge at the
peduncle; smooth-shaded; ONE surface). This pass converts the last body AND retires the
procedural whale machinery.

## The body you replace
`spermSet()` in `plugins/wildlife/client/whaleSpecies.ts` (fitScale 0.7805; fitted extents
x −2.5726…2.4774, y −0.551…0.473, hull halfWidth 0.4375, 21 944 tris, 2 surfaces: hull + jaw
indexed, fins non-indexed). Its profile arrays go into build_sperm_whale.py's header.

## Files
- `tools/blender/build_sperm_whale.py` → `plugins/wildlife/client/assets/sperm-whale.glb`.
- `plugins/wildlife/client/species/spermWhale.ts`: `SPERM_WHALE_HALF_WIDTH`,
  `SPERM_WHALE_ENVELOPE = whaleEnvelope(SPERM_WHALE_HALF_WIDTH)`, `SPERM_WHALE_ASSET` (key
  `whale-sperm`), `buildSpermWhale = assetSpeciesBuilder(SPERM_WHALE_ASSET, animateWhale)`.
- `species/assets.ts` one row; previewSpecies.ts BUILDERS + header list gain `whale-sperm`.

## Retiring the procedural whale — the design decision of this pass
- `whaleSpecies.ts` keeps ONLY `WHALE_SPECIES`, `WhaleSpecies` and `WHALE_ENVELOPE` (placement.ts,
  index.ts and protocol.ts cite them; `species/whale.ts` derives from `WHALE_ENVELOPE`). Delete
  `spermSet`, `WhaleGeometrySet`, `assembleWhale`, `buildWhaleGeometrySets`, `geometriesOf`,
  `finish`, `uprightFin`, `seatY/seatZ`, `PROCEDURAL_WHALE_BODIES` and the three-import from
  `whaleHull.ts`. Rewrite its header: the three bodies are now assets; the envelope paragraph
  (why 0.670/−0.575 are the placement contract) STAYS verbatim.
- `models.ts`: `whaleDrawables` = `WHALE_SPECIES.map(...)` over the three asset builders;
  delete `whaleMaterial`, `WHALE_COLOR`, `whaleSets`, `whaleRigs` and the `lambert(…,
  { flatShading: false })` option if nothing else uses it (grep; state). The `case 'whale'`
  seed selection is unchanged.
- `index.ts` table: SINGLE_SURFACE_SPECIES gains the third whale; `TWO_SURFACE_SPECIES = 1`
  (deepsea only). Rewrite the comment table; the `attach` assert must pass — prove it by the
  Node tally.
- `whaleHull.ts`: grep its remaining importers (bison.ts, ibex.ts, quadruped.ts via bodyKit?) and
  STATE them; delete nothing shared. If `finGeometry` / `sweptHull` lose their last user, say so
  in the report — do not delete them (the orchestrator decides).

## The model
A third of the animal is head, and it does not taper — it stops: a boxy, squared-off head with
a blunt near-vertical front, the blowhole at the front-left of the top; a narrow underslung
lower jaw as a rod beneath the head, stopping short of the snout so the head overhangs it
(it is a body part, no joint); wrinkled, prune-like skin behind the head as shallow baked
relief; NO dorsal fin — a rounded hump two thirds back followed by a row of knuckles down the
tail stock (the hump is the crown, 0.670); short, paddle-shaped flippers; broad triangular
flukes with a deep notch. Belly −0.575: the jaw's underside or the chest — state which, authored
at rest. Length 5.05. halfWidth ≈ 0.44 (the widest of the three). Smooth-shaded, one surface.
Colour: body 0x39506b via `srgb()`; you MAY use one paler tone for the jaw's inside/lips and
one dark eye; list hexes. Triangle aim ≤ ~8 000.

Report: `.claude/orchestration/briefs/sperm-whale-glb-pass8-report.md` — same sections as
pass 6, plus: the deletion list with each remaining importer of whaleHull.ts, and the final
draw-object tally proving `drawBudget`.
