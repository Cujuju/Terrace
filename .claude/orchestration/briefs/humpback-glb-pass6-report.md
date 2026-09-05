# Report: fish+whales → Blender pass 6 — the humpback whale (`whale` variant 0)

Brief: `.claude/orchestration/briefs/species-glb-pass-template.md` +
`.claude/orchestration/briefs/humpback-glb-pass6.md`. Worktree branch
`worktree-agent-a0a06c9e610efffcb`; nothing merged, nothing pushed, the app
was never started, no test added or changed, the main checkout untouched
(its untracked `.verify-angelfish-asset.mts` / `.envelope-diff.mts` were read
and copied).

## What landed (commit 8b82a29)

| file | what |
|------|------|
| `tools/blender/build_humpback.py` (new, 1374 lines) | Constants with reasons L94–L367: the box `LENGTH`/`CROWN_Y`/`BELLY_Y` L95–L99, `HALF_WIDTH = 0.47` L114, `FLUKE_REACH`/`PEDUNCLE_X` L123–L124, `HULL_TAIL_X = PEDUNCLE_X` L130, `TOP_PROFILE`/`BOTTOM_PROFILE`/`WIDTH_PROFILE` L138–L165 (absolute back and belly lines, a chest plateau), `FLANK_T` L166, the long tail cap L183, hump L189–L191, pleats L204–L213 (`PLEAT_VERTICES_PER_PLEAT = 3`, `THROAT_BLEND_ARC`), flippers L216–L246 (`FLIPPER_ROOT_Y = BELLY_Y + SPAN·sin(hang)` L223 — the belly derivation), flukes L248–L290, dorsal, fin camber/foil L293–L299, tubercles/eyes L311–L336, colours L339–L341, `SURFACE_ROUGHNESS` L348, `PLACEMENT_CLEARANCE` L358, `ANCHOR_TOLERANCE = 1e-9` L367. `monotone_profile` L384 (no overshoot); surface functions L455–L576 (`surface_point` = smooth section + hump + pleats along the normal, `surface_normal` numeric on the full surface so relief shades); `throat_weight` L535 (vertex-tint gradient); `check_outward` L604 (per-ring axis reference), `check_winding_with_blender` L623 (Blender's recalc on a scratch copy must flip nothing), `tinted_material`/`paint_tints` L716–L733; `build_hull` L814; `loft_fin` L885 (lofted fins with thickness and camber, derived winding), `weld_mirrored` L960 (the flukes as one wing); outlines L990–L1076; `seated_sphere`/`tubercle_sites` L1079–L1105; `check_attachment` L1143 (parity), `check_envelope` L1161, `check_fluke_sweep` L1192; `main` L1251 (Empties, anchors, export via `export_glb.py`). |
| `plugins/wildlife/client/assets/humpback.glb` (new, 138 948 bytes) | 33 meshes (body, dorsal, 2 eyes, 2 flippers + 2 undersides, flukes blade + underside, 23 tubercles), 4 materials, 7 Empties, 5426 tris. |
| `plugins/wildlife/client/species/whale.ts` (new, 86 lines) | The shared whale-asset piece: `WHALE_JOINTS = ['rig','flukes']` L50, `whaleEnvelope(halfWidth)` L57 (WHALE_ENVELOPE's three numbers by identity + halfLength + the free halfWidth), `WHALE_FLUKE_HZ` L68, `WHALE_FLUKE_SWING_RADIANS` L70, `WHALE_BODY_ROLL_FRACTION` L76, `animateWhale` L82 (the old inline formula, verbatim). |
| `plugins/wildlife/client/species/humpback.ts` (new, 79 lines) | Header (what changed / did not / belly-authored decision / one envelope) L1–L46; `HUMPBACK_HALF_WIDTH = 0.47` L57; `HUMPBACK_ENVELOPE = whaleEnvelope(…)` L65; `HUMPBACK_ASSET` L72 (`species: 'whale-humpback'`, `joints: WHALE_JOINTS`); `buildHumpback = assetSpeciesBuilder(HUMPBACK_ASSET, animateWhale)` L79. |
| `plugins/wildlife/client/whaleSpecies.ts` | `humpbackSet` and its five `HUMPBACK_*` constants removed (profile numbers now the reference silhouette in build_humpback.py's header L47–L60); `PROCEDURAL_WHALE_BODIES = 2` L49; `buildWhaleGeometrySets` L356 returns `[blueSet(), spermSet()]` and throws if the count disagrees with the constant; header L1–L19 records the change. `WHALE_SPECIES` and `WHALE_ENVELOPE` untouched. |
| `plugins/wildlife/client/models.ts` | Imports `WHALE_SPECIES`/`WhaleSpecies`, `animateWhale`, `buildHumpback` L61–L70; local `WHALE_FLUKE_HZ`/`WHALE_FLUKE_SWING_RADIANS` and the inline `0.12` deleted (L139–L143 comment points at whale.ts); `proceduralWhaleRigs` keyed by `set.species` L503; `whaleDrawables` built in `WHALE_SPECIES` order L571–L583 — `humpback` → `speciesDrawable(buildHumpback)`, the others looked up by tag and animated by `animateWhale`; `drawableOf` L624–L625 unchanged. |
| `plugins/wildlife/client/index.ts` | Imports `PROCEDURAL_WHALE_BODIES` instead of `WHALE_SPECIES`; the surface table L268–L293 updated (eel, angelfish, whale-humpback rows; why a procedural whale is two surfaces, cited); `SINGLE_SURFACE_SPECIES = 9` L307, `TWO_SURFACE_SPECIES = 1 + PROCEDURAL_WHALE_BODIES` L308. `drawBudget` stays 16. |
| `plugins/wildlife/client/species/assets.ts` | `HUMPBACK_ASSET` import L27, `humpbackUrl` L28, the one row L44; header list gains the humpback. |
| `client/src/previewSpecies.ts` | `?species=` list L8 and `BUILDERS['whale-humpback']` L58 (the sheet's one authorised edit). |

Not touched: `assetSpecies.ts`, `placement.ts`, `protocol.ts`, `whaleHull.ts`,
`bodyKit.ts`, `export_glb.py`, `render_glb.py`, `stat_glb.py`,
`docs/model-assets.md`, any test.

## How the whale is wired — verified at file:line this session

- `models.ts:624-625` `case 'whale': return whaleDrawables[|trunc(seed)| % length]`;
  `whaleDrawables` is now `WHALE_SPECIES.map(...)` (L571), so index 0 is
  `humpback`, 1 `blue`, 2 `sperm` — `WHALE_SPECIES = ['humpback','blue','sperm']`
  at `whaleSpecies.ts:41`, unchanged.
- Old inline animation (HEAD `models.ts:552-566`): `flukes.rotation.z = swing·0.3`,
  `rig.rotation.z = swing·0.3·0.12`, `WHALE_FLUKE_HZ 0.45` (HEAD L136),
  `WHALE_FLUKE_SWING_RADIANS 0.3` (HEAD L150). Now `whale.ts:82-86`, same
  formula, and `models.ts:579` calls it for the two procedural bodies.
  `WHALE_COLOR 0x39506b`, `lambert(WHALE_COLOR, { flatShading: false })`
  (`models.ts:102`, `:318`) stay for those two.
- `WHALE_ENVELOPE = { crownY 0.670, bellyY -0.575, length 5.05 }`
  `whaleSpecies.ts:65-69`; `placement.ts:328` `BODY_COLUMNS.whale` reads
  crownY/bellyY; `placement.ts:156-164` `SWIM_PROFILES.whale` hand-set
  `0.5 / 0.7 / 0.7 / 2.53 / 0.5` with the comment citing length 5.05;
  `protocol.ts:134` cites it. `git diff HEAD -- placement.ts protocol.ts` is
  empty.
- `finish()` (`whaleSpecies.ts`, now L330-L351) fits each procedural body by
  the tightest of three ratios; the verify script measures blue at 0.7902 and
  sperm at 0.7805, matching the sheet's table.
- WHY A PROCEDURAL WHALE BAKES TO TWO SURFACES: `client/src/render/rigSkin.ts:302-309`
  — `bakeRig` appends `|flat`/`|indexed` (`piece.getIndex() === null`) to the
  material signature because `mergeGeometries` refuses a mix; the swept hull
  (`whaleHull.ts sweptHull`) is indexed and `ExtrudeGeometry` fins are not.
  Measured under Node: blue 2 surfaces, sperm 2 (below). The handoff's reading
  was right; the old index.ts comment ("a second material") was wrong and is
  replaced.
- `index.ts:298-303` `TWO_SURFACE_SPECIES = 1 + WHALE_SPECIES.length` was the
  old line; now `1 + PROCEDURAL_WHALE_BODIES` (L308). `attach` asserts
  `models.objects.length === WILDLIFE_SPECIES_DRAW_OBJECTS` at L364-L369.
- `installSpeciesAsset` (`assetSpecies.ts:225-280`): joints resolve by name
  L240-L243, anchors vs `Box3` extremes L245-L254, `flank` vs z extent as an
  upper bound L256-L264, five envelope fields L267-L271, tolerance 0.01 L184,
  measured AT REST (`updateMatrixWorld(true)` L226, before any `animate`).
- `rigSkin.ts:457-469` `paintVertexColor` multiplies the material colour by an
  existing `color` attribute — the mechanism the hull's throat gradient rides
  on (below). `materialSignature` L111-L152 keys on type, flatShading,
  roughness/metalness etc., NOT colour and not the presence of a colour
  attribute → one surface (measured).
- `index.ts:349` and `previewSpecies.ts:131-132` loop `SPECIES_ASSETS` with
  `loadRigAsset(url, null)`; the one row in `assets.ts:44` reaches both.

## Design decisions, as built

1. **Three assets, three keys, one wire species.** `HUMPBACK_ASSET.species = 'whale-humpback'`
   (install-map key only); `models.ts` keeps `case 'whale'`. Blue and sperm
   stay procedural and keep drawing (verified by baking them under Node).
2. **Fills the box.** The file measures nose +2.525, tail_tip −2.525, crown
   +0.670, belly −0.575 — `whaleEnvelope()` derives `HUMPBACK_ENVELOPE` from
   `WHALE_ENVELOPE` by identity; only `halfWidth 0.47` is the body's own. The
   humpback is 5.05 long against the fitted body's 4.478 (+12.8 %), intended.
3. **One envelope (rest).** `check_fluke_sweep` (build log below): flukes at
   ±0.3 rad about the hinge (−2.000, +0.120), tip reach 0.525: y sweeps to
   [−0.040, +0.280] — inside the box — and the x minimum shortens from −2.525
   to −2.503 (cos ≤ 1). Asserted. The body roll (×0.12 = 0.036 rad) applied to
   everything gives whole-model y [−0.600, +0.702] — 0.025/0.032 outside the
   box, exactly what a 0.036 rad roll does to a belly 0.7 ahead of the origin
   and a crown 0.9 behind it; it is the animation the procedural whale always
   had (same constants), sits inside placement's ±0.7 clearance, and is
   PRINTED, not asserted (comment at `build_humpback.py:1192-1200`; stated in
   `whale.ts:24-34`).
4. **Belly authored.** The starboard flipper tip: `FLIPPER_ROOT_Y` is derived
   so the tip vertex lands on −0.575 (measured off by 0.0000000); the chest
   bottoms at −0.510 (0.065 above). The flippers are rigid parts under `rig`,
   no joint, as today. Crown = the dorsal's tip vertex on the hump (hull back
   +0.521, dorsal 0.149 above it).
5. **Joints `['rig','flukes']`**, `flukes` an Empty at the peduncle (−2.0,
   0.12, 0) at identity rotation (Node: `rotation (0,0,0)`). Both fluke blades
   hang under it — as ONE welded wing (`flukes_blade` + `flukes_blade_underside`):
   two blades meeting at the centreline either shared a face (a z-fighting slot
   down the notch, seen in the first build's top render) or split their smooth
   normals along a crease; the weld (`weld_mirrored`, root rows proven
   coincident to 1e-9) does neither. Anchors: `nose` (2.525, −0.035, 0),
   `tail_tip` (−2.525, 0.12, 0), `crown` (−0.9, 0.67, 0), `belly` (0.7, −0.575,
   1.872 — the flipper tip), `flank` (0.805, −0.022, 0.47 — the hull's chest
   plateau; the flippers reach 1.872, the upper-bound case).
6. **`species/whale.ts`** written once; `models.ts` calls `animateWhale` for the
   procedural bodies rather than re-stating the constants, so the formula
   exists once too.
7. **`whaleSpecies.ts`** lost `humpbackSet`; `PROCEDURAL_WHALE_BODIES = 2`.
8. **`models.ts`** looks the procedural set up by `set.species` (a `Map`),
   never by index.
9. **`index.ts`** 9 / `1 + PROCEDURAL_WHALE_BODIES`; drawBudget 16, proven below.
10. **`previewSpecies.ts`** gains `whale-humpback`.

**The throat is a vertex-colour gradient, not a split mesh** — the one
construction decision not on the sheet. The sheet allows "one pale ventral
tone"; splitting the hull's faces by colour (the angelfish's bar technique)
gave the leaf-shaped throat patch a staircase edge, one ring-step per ring
(second build, `head_under` close-up). The shipped hull carries `COLOR_0`
(Blender `tint` attribute, exported because the material's Base Color is a
Color Attribute node) under a WHITE material: body tone everywhere blending
to the ventral tone over the pleated throat through `throat_weight`
(smoothstep over 0.3 rad of section). `rigSkin.ts:457-469` multiplies the
material colour (white) by the attribute, so the baked vertex colours are
exactly the hexes — measured: hull `COLOR_0` darkest `#39506b`, palest
`#b9c6d2`. The fin undersides and eyes are plain materials. Colours used:
body 0x39506b (WHALE_COLOR), ventral 0xb9c6d2, eye 0x0b0e13; one roughness
0.5, metalness 0.

**Other things the renders changed** (each recorded beside its constant): the
tail cap lengthened to 8 % (`TAIL_CAP_FRACTION`, L179-L184) and the stock's
top/bottom lines brought together over the last tenth (L122-L131) so the
peduncle sinks into the flukes rather than riding over them; the flukes'
thickest station moved to a quarter chord and their camber halved
(`FLUKE_THICKNESS_PEAK_POWER`, `FLUKE_CAMBER_FRACTION` L293-L299) so the
stock meets a level wing surface; pleats sampled three vertices each
(`PLEAT_VERTICES_PER_PLEAT`, L197-L208) because two — a crest and a trough —
gave every vertex the same normal and the grooves shaded flat.

## Envelope: measured vs declared, and old vs new

| field | declared | Blender (`check_envelope`, pre-export) | Node anchor / bounds | off by |
|-------|---------:|---------------------------------------:|---------------------:|-------:|
| nose x | +2.525 | +2.525000 | anchor (2.5250, −0.0350, 0); bounds x max 2.5250 | 0.0000000 |
| tail_tip x | −2.525 | −2.525000 | anchor (−2.5250, 0.1200, 0); x min −2.5250 | 0.0000000 |
| crown y | +0.670 | +0.670000 | anchor (−0.9000, 0.6700, 0); y max 0.6700 | 0.0000000 |
| belly y | −0.575 | −0.575000 | anchor (0.7000, −0.5750, 1.8716); y min −0.5750 | 0.0000000 |
| flank z | +0.47 | +0.470000 | anchor (0.8055, −0.0216, 0.4700); model z extent 1.8716 (flippers) | 0.0000000 |
| length / halfLength | 5.05 / 2.525 | 5.0500 / 2.5250 | size.x 5.050 | — |

`plugins/wildlife/.envelope-diff.mts` (uncommitted; HEAD's whaleSpecies.ts as
`client/.old-whaleSpecies.ts` from `git show HEAD:`, `Object.is`):

```
old WHALE_ENVELOPE: {"crownY":0.67,"bellyY":-0.575,"length":5.05}
new WHALE_ENVELOPE: {"crownY":0.67,"bellyY":-0.575,"length":5.05}
  crownY   old=0.67 new=0.67 IDENTICAL
  bellyY   old=-0.575 new=-0.575 IDENTICAL
  length   old=5.05 new=5.05 IDENTICAL
HUMPBACK_ENVELOPE: {"length":5.05,"halfLength":2.525,"halfWidth":0.47,"crownY":0.67,"bellyY":-0.575}
  humpback.crownY   = 0.67 vs WHALE_ENVELOPE 0.67 IDENTICAL
  humpback.bellyY   = -0.575 vs WHALE_ENVELOPE -0.575 IDENTICAL
  humpback.length   = 5.05 vs WHALE_ENVELOPE 5.05 IDENTICAL
  humpback.halfLength = 2.525 vs length/2 2.525 IDENTICAL
  humpback.halfWidth  = 0.47 (HUMPBACK_HALF_WIDTH 0.47, the one free field)
SWIM_PROFILES.whale: {"depthFraction":0.5,"minClearance":0.7,"minSubmergence":0.7,"halfLength":2.53,"halfWidth":0.5}
BODY_COLUMNS.whale : {"bellyY":-0.575,"crownY":0.67}
WHALE_SPECIES order: ["humpback","blue","sperm"] PROCEDURAL_WHALE_BODIES: 2
old procedural sets: humpback@0.6907, blue@0.7902, sperm@0.7805
new procedural sets: blue@0.7902, sperm@0.7805
ALL IDENTICAL
```

`placement.ts` and `protocol.ts` are byte-identical to HEAD (empty diff), so
the two placement rows are the same source text evaluating the same values.

## Blender build log (shipped build; `tools/blender/out/humpback_build.log`)

```
humpback build:
  hull: 37 rings x 42 segments (385 vertices tinted toward the throat tone)
  winding hull: 1596 faces, 0 inward
  blender recalc hull: 1596 faces, 0 it would flip
  blender recalc flipper_port: 241 faces, 0 it would flip
  blender recalc flipper_starboard: 241 faces, 0 it would flip
  blender recalc dorsal: 49 faces, 0 it would flip
  winding tubercle_00..22: 18 faces each, 0 inward
  winding eye_port / eye_starboard: 32 faces, 0 inward; blender recalc 0 it would flip
  blender recalc flukes_blade: 320 faces, 0 it would flip
  attachment (vertices strictly inside the hull):
    flipper_port 11/241   flipper_starboard 11/241   dorsal 8/49
    tubercle_00..22 8-10/14 each   eye_port 20/26   eye_starboard 20/26   flukes_blade 9/312
  envelope (measured vs declared): nose/tail_tip/crown/belly/flank all off by 0.0000000
    hull back tops out at +0.5207, 0.1493 under the crown; chest bottoms at -0.5100, 0.0650 above the belly (a flipper tip, -0.575000)
    widest thing on the model 1.8716 (the flippers; flank is the hull's chest, the upper-bound case the install allows)
    length 5.0500, halfLength 2.5250
  fluke sweep: hinge x -2.0000 y +0.1200, tip reach 0.5250 from the hinge
    flukes +0.30 rad: y [-0.0399, +0.2592] (box -0.575..+0.670); x min -2.5030 vs rest -2.5250 (-0.0220 shorter)
    + body roll +0.0360 rad: whole model y [-0.5494, +0.6372] against placement clearance +-0.7
    flukes -0.30 rad: y [-0.0030, +0.2799] (box -0.575..+0.670); x min -2.5030 vs rest -2.5250 (-0.0220 shorter)
    + body roll -0.0360 rad: whole model y [-0.5998, +0.7020] against placement clearance +-0.7
  body: 1596 polys, 3108 tris   dorsal: 94   eye_port/eye_starboard: 48 each
  flipper_port/starboard: 290 each + undersides 188 each   flukes_blade: 372 + underside 248
  tubercles x 23: 552 tris
humpback -> humpback.glb: 5426 tris total
```

Every non-hull part has vertices strictly inside the hull; nothing floats.

## As exported (`stat_glb.py`, fresh import of the committed file)

```
bbox world units: x=5.050 y=1.245 z=3.743  min-y=-0.575  centre-xz=(0.000, 0.000)
meshes: 33
  body 3108 tris materials=['humpback_hull'] colors=['Color'] parent=rig
  dorsal 94 parent=rig   eye_port/eye_starboard 48 parent=rig
  flipper_port 290 / flipper_port_underside 188 parent=rig (starboard the same)
  flukes_blade 372 / flukes_blade_underside 248 parent=flukes
  tubercle_00..22 24 each parent=rig
total: 5426 tris
materials: 4 — humpback_body (0.04,0.08,0.15), humpback_eye, humpback_hull (white; Base Color is the vertex colour),
  humpback_ventral (0.49,0.56,0.64); all metallic=0.00 roughness=0.50; images: 0
empties: 7 — rig (0,0,0) parent=(none); flukes (-2.000, 0.120, 0) parent=rig;
  nose (2.525, -0.035, 0)  tail_tip (-2.525, 0.120, 0)  crown (-0.900, 0.670, 0)
  belly (0.700, -0.575, 1.872)  flank (0.805, -0.022, 0.470) — all parent=(none)
armatures: 0   skinned meshes: 0
```

(`stat_glb` prints the re-imported hull material's socket default, 0.8, which
is unused because the socket is linked; the exported baseColorFactor is white
— Node below reads `#ffffff`.)

## `.verify-humpback-asset.mts` (uncommitted; from the main checkout's angelfish script, parameterised)

`node --experimental-strip-types .verify-humpback-asset.mts`:

```
installSpeciesAsset: accepted humpback.glb
GLB humpback (whale-humpback):
  surfaces: 1
  joints:   41
  triangles:5426
  materials: MeshStandardMaterial(smooth, roughness 0.5)
  joints resolved: rig, flukes
    rig      parent=Scene at (0.0000, 0.0000, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    flukes   parent=rig at (-2.0000, 0.1200, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    mesh flukes_blade / flukes_blade_underside parent=flukes; flipper_starboard, dorsal, body parent=rig
  bounds x[-2.5250, 2.5250] y[-0.5750, 0.6700] z[-1.8716, 1.8716] size 5.050
  declared HUMPBACK_ENVELOPE: {"length":5.05,"halfLength":2.525,"halfWidth":0.47,"crownY":0.67,"bellyY":-0.575}
    nose (2.5250, -0.0350, 0)  tail_tip (-2.5250, 0.1200, 0)  crown (-0.9000, 0.6700, 0)
    belly (0.7000, -0.5750, 1.8716)  flank (0.8055, -0.0216, 0.4700)
  body material colour #ffffff vertexColors=true; COLOR_0 present=true (1556 vertices, 3 components)
  hull COLOR_0 range (linear -> sRGB hex): darkest #39506b, palest #b9c6d2
  baked surface carries a colour attribute: true (2941 vertices)
  expected: body #39506b (WHALE_COLOR), ventral #b9c6d2
disposed blueprint then asset
procedural whale body "blue" (fitScale 0.7902):  surfaces: 2  joints: 10  triangles:19332
  bounds x[-2.5694, 2.4806] y[-0.3884, 0.4506] z[-1.0903, 1.0903] length 5.050
procedural whale body "sperm" (fitScale 0.7805): surfaces: 2  joints: 10  triangles:21944
  bounds x[-2.5726, 2.4774] y[-0.5507, 0.4725] z[-1.1452, 1.1452] length 5.050
draw-object tally: 9 single-surface species (incl. humpback) + 1 grazer + 2 deepsea + 4 (two procedural whales) = 16
index.ts drawBudget = 9 + 1 + (1 + 2) * 2 = 16
```

`materialSignature` reads `smooth` (flatShading false) and the count bakes to
ONE surface; `attach`'s assert (`index.ts:364`) holds: 16 = 16.

### Draw budget

| body | surfaces | joints (bakeRig nodes) | triangles | material |
|--|--:|--:|--:|--|
| procedural humpback (sheet's table, HEAD) | 2 | — | 22 424 | MeshLambertMaterial |
| **humpback.glb** | **1** | 41 | **5 426** | MeshStandardMaterial |
| procedural blue (still drawn) | 2 | 10 | 19 332 | MeshLambertMaterial |
| procedural sperm (still drawn) | 2 | 10 | 21 944 | MeshLambertMaterial |

Triangle aim ≤ ~8 000: met at 5 426 (hull 3108 + flippers 956 + flukes 620 +
tubercles 552 + dorsal 94 + eyes 96). Draw objects 17 → 16 (the humpback herd
went from two surfaces to one).

## Renders (uncommitted, `tools/blender/out/`)

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a0a06c9e610efffcb/tools/blender/out/humpback_iso.png`
  — from the play angle a long dark whale with the two great flippers spread
  down-and-out, the knobbed rostrum, the small hump-and-dorsal two thirds
  back, the narrow tail stock and the broad notched flukes; the pale flipper
  underside just showing on the far side.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a0a06c9e610efffcb/tools/blender/out/humpback_side.png`
  — a Megaptera in profile: flat tubercled rostrum, deep barrel chest with
  the pale pleated throat, the flipper hanging below the belly line as a broad
  scalloped paddle, the hump rising to a stubby dorsal, the tail stock lifting
  into thin serrated flukes; the eye behind the gape.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a0a06c9e610efffcb/tools/blender/out/humpback_front.png`
  — the broad head with its rows of tubercles over the pale throat, the
  flippers reaching out and down either side like wings, the dorsal a nub on
  the back, the fluke tips just visible beyond.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a0a06c9e610efffcb/tools/blender/out/humpback_top.png`
  — the planform: a barrel body tapering to the peduncle, the flippers as long
  scalloped blades swept aft, the flukes a wide swept wing with a central
  notch and serrated trailing edge, the dorsal a hairline on the hump.

Close-ups used to judge and fix (in `tools/blender/out/closeups/`): the first
build's fluke slot (fixed by the weld), the second's stepped throat (fixed by
the gradient), the stock riding over the flukes (long cap, lowered stock,
fluke foil moved forward).

## `whaleHull.ts` / `bodyKit.ts` remaining users (imports, not comments)

- `../whaleHull.ts`: `client/whaleSpecies.ts:38` (blue and sperm),
  `species/bison.ts:28`, `species/ibex.ts:16`.
- `./bodyKit.ts`: `species/bison.ts:29`, `species/ibex.ts:17`,
  `species/quadruped.ts:13`. The whale never used bodyKit.

Nothing deleted. `finGeometry`, `sweptHull`, `profileFromPoints`, `uprightFin`
all keep importers.

## Verification runs

- `pnpm install --frozen-lockfile`: "Done in 1m 48.9s"; lockfile unchanged.
- `pnpm typecheck` (root): every package `Done`, exit 0.
- Wildlife tests per file from `plugins/wildlife`, `timeout 240 npx vitest run <file>`:
  `assetSpecies.test.ts` 4 passed; `client.test.ts` 18 passed;
  `gradient.test.ts` 6 passed; `session-lifecycle.test.ts` 3 passed;
  `wildlife.test.ts --hookTimeout 120000` 17 passed (23.76 s). No assertion
  encoded the procedural humpback; no test changed, none added.
- Blender build log, `stat_glb.py`, `.verify-humpback-asset.mts`,
  `.envelope-diff.mts`: above; logs in `tools/blender/out/humpback_*.log`.
- `grep` for `humpbackSet`, `HUMPBACK_TUBERCLE`, the old `WHALE_FLUKE_*`
  locals: no live references outside whale.ts and comments.

## Left undone, and why

- At the extreme of the fluke stroke the flukes' root (0.40 ahead of the
  hinge, buried in the tail stock) rotates inside the stock and its upper or
  lower surface can emerge from the stock's back or belly for a frame — the
  hinged-fin-in-a-body residual every swimmer here carries. Estimated from
  the scratch probe, not rendered: at x −1.80 the wing's centre top (0.209)
  pitched by 0.2·sin 0.3 = 0.06 sits ~0.08 above the stock's back (0.190);
  at x −1.70 the stock (0.221) still covers it (0.182 + 0.09). Unverified in
  motion — the app was not started.
- The pleats are eight coarse grooves, not the thirty of the animal: the ring
  is 42 segments and the throat 24 of them; finer would cost the hull budget.
- The whole-model extremes under the body roll exceed the box by ≤ 0.032 (see
  design decision 3): a property of the shared animation the sheet fixes as
  unchanged, printed by the build and stated in whale.ts, not fixed here.
- Uncommitted scratch left in the worktree as the brief asks:
  `plugins/wildlife/.verify-humpback-asset.mts`, `plugins/wildlife/.envelope-diff.mts`,
  `plugins/wildlife/client/.old-whaleSpecies.ts`, `tools/blender/out/`
  (renders, close-ups, logs, `blender.sh`, `closeup.py`).

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a0a06c9e610efffcb`
Branch: `worktree-agent-a0a06c9e610efffcb`
Code commit: `8b82a29`; final commit (this report): see `git log -1`.
