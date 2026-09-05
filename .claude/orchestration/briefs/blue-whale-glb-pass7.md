# Species sheet: pass 7 — the blue whale (`whale`, variant 1)

Generic brief: `.claude/orchestration/briefs/species-glb-pass-template.md` — read it FIRST. Then
read `.claude/orchestration/briefs/humpback-glb-pass6.md` and its REPORT
(`humpback-glb-pass6-report.md`): pass 6 settled how a whale body becomes an asset (three keys
`whale-humpback|blue|sperm`, `species/whale.ts` with `WHALE_JOINTS`, `whaleEnvelope(halfWidth)`,
`animateWhale`; every whale asset FILLS crownY 0.670 / bellyY −0.575 / length 5.05 exactly; one
REST envelope; `flukes` hinge at the peduncle; smooth-shaded; ONE surface). This pass repeats it
for the blue whale and changes NOTHING in `whale.ts` unless the report names a defect.

## The body you replace
`blueSet()` in `plugins/wildlife/client/whaleSpecies.ts` (fitScale 0.7902; fitted extents
x −2.5694…2.4806, y −0.388…0.451, hull halfWidth 0.3646, 19 332 tris, 2 surfaces). Its profile
arrays go into build_blue_whale.py's header as the reference silhouette; `blueSet` is deleted
and `buildWhaleGeometrySets()` returns only the sperm set; `PROCEDURAL_WHALE_BODIES` → 1.

## Files
- `tools/blender/build_blue_whale.py` → `plugins/wildlife/client/assets/blue-whale.glb`.
- `plugins/wildlife/client/species/blueWhale.ts`: `BLUE_WHALE_HALF_WIDTH`, `BLUE_WHALE_ENVELOPE
  = whaleEnvelope(BLUE_WHALE_HALF_WIDTH)`, `BLUE_WHALE_ASSET` (key `whale-blue`),
  `buildBlueWhale = assetSpeciesBuilder(BLUE_WHALE_ASSET, animateWhale)`.
- `species/assets.ts` one row; models.ts `whaleDrawables` — `blue` → `speciesDrawable(buildBlueWhale)`;
  index.ts table SINGLE_SURFACE_SPECIES +1, TWO_SURFACE_SPECIES = 1 + PROCEDURAL_WHALE_BODIES (1);
  previewSpecies.ts BUILDERS + header list gain `whale-blue`.

## The model
The opposite animal to the humpback, and it must read as one at a glance from the play camera:
very long and slim (halfWidth ≈ 0.37, the slimmest of the three); a flat, broad, U-shaped
rostrum with ONE median ridge from blowhole to snout tip; ventral throat pleats as shallow grooves
over the front third of the underside; small, slender, pointed flippers (~an eighth of body
length) set low; a tiny falcate dorsal nub three quarters of the way back (that nub, on a
low back, is the crown — set the back's height so the nub's tip is 0.670 exactly, or make the
crown the back itself and keep the nub below it: state which); a tail stock that is TALLER
than wide (laterally compressed keel) ending in wide, thin, slightly swept flukes with a small
notch. Belly −0.575: the chest, not a flipper (blue whale flippers are held close). Length
5.05 nose to fluke trailing edge. Smooth-shaded, one surface. Colour: body 0x39506b via `srgb()`
as the humpback did; a pale mottled tone is NOT available (no textures) — you MAY use one paler
ventral colour for the pleats and flipper undersides; list hexes. Triangle aim ≤ ~8 000.

Report: `.claude/orchestration/briefs/blue-whale-glb-pass7-report.md` — same sections as pass 6,
plus the draw-object tally proving `drawBudget` (asset whales 1 surface each, sperm 2).
