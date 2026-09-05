# Species sheet: pass 9 — the deep-sea anglerfish (`deepsea`), the last of the list

Generic brief: `.claude/orchestration/briefs/species-glb-pass-template.md` — read it FIRST; this
sheet carries what is specific to the anglerfish. Every other fish and whale is an asset by now;
this is the last procedural swimmer, and the only one with an UNLIT part.

## How the anglerfish is wired (verify each at file:line, cite)
- It lives in `plugins/wildlife/client/models.ts`, not in `species/`: constants `DEEPSEA_COLOR`
  0x161c26 (near-black), `DEEPSEA_LURE_COLOR` 0xa8fbff (the one bright thing down there),
  `DEEPSEA_ENVELOPE = { crownY 0.35, bellyY −0.35 }` (EXPORTED; placement.ts imports it from
  models.ts for BODY_COLUMNS.deepsea), `DEEPSEA_SWAY_HZ` 0.7, `DEEPSEA_SWAY_RADIANS` 0.22,
  `DEEPSEA_LURE_BOB` 0.05. Geometry: body `ellipsoid(1, 0.7, 0.55)` at the origin; jaw cone
  (r 0.3, h 0.45) rotated to point +X at (0.5, −0.12); stalk box 0.5×0.04×0.04 at (0.42, 0.34);
  lure sphere Ø0.14 under a `lure` Group at (0.68, 0.36) with an UNLIT `MeshBasicMaterial`.
  Rig: `bakeSpecies(root, { rig, lure })`. `animate`: `rig.rotation.y = sway·0.22`;
  `lure.position.y = lureRestY + sin(… − 1)·0.05` — the lure is a JOINT driven in POSITION.
- `placement.ts` SWIM_PROFILES.deepsea is HAND-SET (depthFraction 0.88, minClearance 0.8,
  minSubmergence 0.5, halfLength 0.5, halfWidth 0.28) with a comment on the 2026-08-14 seabed
  clipping report; BODY_COLUMNS.deepsea reads DEEPSEA_ENVELOPE. Those numbers do not change.
- `index.ts` table: deepsea = 2 surfaces (`TWO_SURFACE_SPECIES`), because the lure's
  `MeshBasicMaterial` has a different `material.type` (rigSkin.ts `materialSignature` ~L111
  keys on type). A glTF `KHR_materials_unlit` material becomes `MeshBasicMaterial` in three's
  GLTFLoader (client/node_modules/three/examples/jsm/loaders/GLTFLoader.js ~L795–810) — so the
  asset bakes to 2 surfaces too, and the table stays. Verify the number under Node.
- The old body OVERSHOOTS its own envelope: the jaw base reaches y ≈ −0.42 and the lure's top
  y ≈ 0.43 against ±0.35. As with the eel, the file honours the declaration.

## Design decisions, already made
1. **New file `species/deepsea.ts`**, the fish.ts shape: `DEEPSEA_ENVELOPE` moves here with all
   FIVE fields — `crownY 0.35` and `bellyY −0.35` IDENTICAL (BODY_COLUMNS contract), plus the
   file's own `length` / `halfLength` / `halfWidth` (what the .glb measures; SWIM_PROFILES.deepsea
   is hand-set and stays). `DEEPSEA_JOINTS = ['rig', 'lure']`, `DEEPSEA_ASSET` (key `deepsea`,
   file `deepsea.glb`), `buildDeepsea = assetSpeciesBuilder(DEEPSEA_ASSET, animate)` with the
   same three motion constants and the same two formulas (lure bob in position.y about its rest
   y read from the joint at first animate — or bake the rest y as a named constant equal to the
   Empty's y; state which and prove they agree).
2. **placement.ts gets ONE line changed**: the import of `DEEPSEA_ENVELOPE` moves from
   `./models.ts` to `./species/deepsea.ts`. Prove BODY_COLUMNS.deepsea and SWIM_PROFILES.deepsea
   evaluate byte-identical before/after. Nothing else in placement.ts.
3. **models.ts loses the deepsea**: constants, geometries, `deepseaMaterial`, `unlit()` if
   nothing else uses it (grep; state), `deepseaRig`, `deepseaDrawable` → `speciesDrawable(buildDeepsea)`.
   `BIRD_ENVELOPE` and the bird stay. `DEEPSEA_ENVELOPE` is no longer exported from models.ts
   (grep every importer first).
4. **The lure is UNLIT in the file**: a second glTF material carrying `KHR_materials_unlit`
   (Blender: an Emission-only or Background-shader material exports as unlit — check
   tools/blender/export_glb.py's exporter options and `stat_glb.py`'s material print; add the
   extension print to stat_glb.py if it lacks one). Colour 0xa8fbff via `srgb()`. Everything
   else `MeshStandardMaterial` at one roughness → exactly 2 surfaces.
5. **One envelope.** Crown 0.35 is a BODY extreme at rest (a dorsal spine or the back's crest),
   NOT the lure: the lure bobs ±0.05 so its top at rest must sit ≤ 0.30 and it is never the
   crown. Belly −0.35 is the jaw's lowest point or the belly, at rest. `flank` at the body's
   widest (≈0.275 today; the file's own). nose = jaw/teeth tip (x max), tail_tip = caudal fin's
   rear (x min). Say all this in the file header.
6. **previewSpecies.ts**: add `deepsea` to BUILDERS and the header list.

## The model
A Melanocetus (humpback anglerfish) silhouette: a globular, deep body ~1 world unit long, nearly
as tall as long at the head; a huge upturned mouth spanning the whole front, lower jaw jutting,
lined with long needle teeth (thin cones, part of the jaw mesh); tiny eyes; a short, rounded
caudal fin on a stubby peduncle (rigid — no tail joint; the species sways as a whole as it does
today); small rounded dorsal/anal/pectoral fins with root thickness; the illicium (stalk) rising
from the snout and arching forward to the esca (lure) — the stalk is body geometry, the bulb
alone hangs under `lure` so the bob reads as the lure dangling (or hinge stalk + bulb together
under `lure` if the stalk would visibly detach: pick the one that does not float at ±0.05 and
say why). Near-black body via `srgb(0x161c26)`; you MAY add one very dark tooth/eye tone; the
lure is the only bright colour and is unlit. Triangle aim ≤ ~3 000.

## Verification specific to this pass
- `.verify-deepsea-asset.mts`: accepted; anchors; `surfaceCount` 2 with the material types
  named per surface (one `MeshBasicMaterial`); joints; tris. Node tally proving `drawBudget`
  unchanged (deepsea 2).
- Old vs new: `crownY`/`bellyY` `Object.is`-identical; BODY_COLUMNS.deepsea and
  SWIM_PROFILES.deepsea byte-identical.
- Lure bob check: lure top at rest + 0.05 ≤ crownY; print it.
- Renders: the iso view must show the lure as a bright bulb against a dark body; if the unlit
  material renders lit in Cycles, say so (Cycles ignores the extension) and prove unlit-ness in
  Node by material type instead.

Report: `.claude/orchestration/briefs/deepsea-glb-pass9-report.md`.
