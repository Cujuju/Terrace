# Report: fish+whales → Blender pass 8 — the sperm whale (`whale` variant 2) and the end of the procedural whale

Brief: `.claude/orchestration/briefs/species-glb-pass-template.md` +
`.claude/orchestration/briefs/sperm-whale-glb-pass8.md`, on the pass-6/7
pattern (`humpback-glb-pass6.md`, `blue-whale-glb-pass7.md` and their
reports). Worktree branch `worktree-agent-ad2bcd0cf27ea53fa`; nothing merged, nothing pushed, the
app was never started, no test added or changed, the main checkout untouched
(its untracked `.verify-blue-whale-asset.mts` / `.envelope-diff.mts` were
read and copied). The killed prior attempt's `build_sperm_whale.py`
(worktree `agent-aa5987e2204a1b89a`, uncommitted) was read, copied here as
the starting point, rebuilt, rendered and judged; one constant changed
(below). That worktree was not modified.

## What landed (commit a29d6ef)

| file | what |
|------|------|
| `tools/blender/build_sperm_whale.py` (new, 1494 lines) | Header L1–L100: what it builds, the crown-is-the-hump / belly-is-the-chest decision, the procedural `spermSet` profile arrays as the reference silhouette (L65–L81). Constants with reasons L110–L404: the box `LENGTH`/`CROWN_Y`/`BELLY_Y` L116–L120, `HALF_WIDTH = 0.44` L124, `FLUKE_REACH 0.50`/`PEDUNCLE_X` L133–L134, `TOP_PROFILE`/`BOTTOM_PROFILE`/`WIDTH_PROFILE` L156–L179 (absolute back and belly lines: a flat head top at `HEAD_TOP_Y 0.585`, a flat head underside `HEAD_BOTTOM_Y −0.43` the jaw hangs under, a hump plateau at `CROWN_Y` t 0.64–0.69, a chest plateau at `BELLY_Y` t 0.40–0.50, full width t 0.14–0.34), anchor stations `FLANK_T`/`CROWN_T`/`BELLY_T` L182–L184 (asserted ring stations, main), the superellipse section `HEAD_SECTION_POWER 3.4` → round by t 0.50 L191–L194, `NOSE_CAP_POWER 4.0` L211 (a wall, not a dome), the blowhole L225–L232 (front-LEFT: `BLOWHOLE_ARC` two grid rows port of the back line, a parabolic crater with a lip), wrinkles L244–L248 (7 grooves 0.014 deep, three vertices each, flanks only), knuckles L255–L261 (5, 0.032 tall, back only, `KNUCKLE_BELOW_CROWN 0.02` asserted), the jaw L270–L288 (a swept rod 1.40 long, tip 0.42 behind the front, `JAW_ABOVE_BELLY 0.02` asserted, lip tint fading into the throat), flippers L295–L315 (paddle: span 0.48, hang 0.40 rad, elliptical rounding), flukes L330–L340 (half-span 0.72, notch 0.28 behind the hinge vs reach 0.50 — deep; triangular via a near-straight leading edge to a pointed tip; 20 span stations so the lobe is a vertex), colours L374–L376, `SURFACE_ROUGHNESS 0.5` L383, `ANCHOR_TOLERANCE 1e-9` L402. `monotone_profile` L419; `surface_point`/`surface_normal` L619/L630 (relief along the smooth normal, numeric normals of the built surface so it shades); `check_outward` L658, `check_winding_with_blender` L677; `tinted_material`/`paint_tints` L770/L782; `build_hull` L877; `build_jaw` L962; `loft_fin` L1023 / `weld_mirrored` L1098 (verbatim from passes 6–7); `check_attachment` L1242 (parity, asserted), `check_envelope` L1260 (also asserts hump = crown, knuckles and head under it, jaw and flippers above the belly), `check_head` L1313, `check_fluke_sweep` L1332; `main` L1377 (Empties, anchors, export via `export_glb.py`). |
| `plugins/wildlife/client/assets/sperm-whale.glb` (new, 108 644 bytes) | 7 meshes (body, jaw, 2 flippers, 2 eyes, flukes blade), 3 materials, 7 Empties, 5576 tris. |
| `plugins/wildlife/client/species/spermWhale.ts` (new, 91 lines) | Header (what changed / did not / crown-hump belly-chest / one envelope) L1–L58; `SPERM_WHALE_HALF_WIDTH = 0.44` L69; `SPERM_WHALE_ENVELOPE = whaleEnvelope(…)` L77; `SPERM_WHALE_ASSET` L84 (`species: 'whale-sperm'`, `file: 'sperm-whale.glb'`, `joints: WHALE_JOINTS`); `buildSpermWhale = assetSpeciesBuilder(SPERM_WHALE_ASSET, animateWhale)` L91. |
| `plugins/wildlife/client/whaleSpecies.ts` (315 → 54 lines) | Keeps ONLY `WHALE_SPECIES` L34, `WhaleSpecies` L35, `WHALE_ENVELOPE` L50–L54; the envelope JSDoc paragraph (L37–L49) is verbatim from HEAD. Header L1–L31 rewritten: the three bodies are assets, what this file now is. No imports. |
| `plugins/wildlife/client/models.ts` | Header L9–L12; imports L63–L66 (`WHALE_SPECIES`, `WhaleSpecies`, the three builders; `animateWhale` no longer imported here); `WHALE_COLOR` deleted (comment L100–L108 says where the colour lives now); `whaleMaterial`, `whaleSets`, `proceduralWhaleRigs` deleted; `whaleBuilders` L540–L544 keyed by body, `whaleDrawables = WHALE_SPECIES.map(...)` L545–L547; `drawableOf` `case 'whale'` L589–L590 unchanged. |
| `plugins/wildlife/client/index.ts` | `PROCEDURAL_WHALE_BODIES` import removed; table L268–L283 (whale-sperm row, no procedural row); the two-surface paragraph L285–L295 rewritten (deepsea is the one two-surface herd; the old mechanism recorded with the corrected rigSkin citation ~L325–331); `SINGLE_SURFACE_SPECIES = 11` L309, `TWO_SURFACE_SPECIES = 1` L310. `drawBudget` stays 15. |
| `plugins/wildlife/client/species/whale.ts` | Header L5–L12 only: "the bodies not yet converted keep drawing from the procedural sets" → all three are assets; the historical sentences ("were FITTED", "the animation the procedural whale always had") stay true and stay. Code unchanged. |
| `plugins/wildlife/client/species/assets.ts` | `SPERM_WHALE_ASSET` import L31, `spermWhaleUrl` L32, the one row L52; header list gains the sperm whale and the wolf. |
| `client/src/previewSpecies.ts` | `?species=` list L8 and `BUILDERS['whale-sperm']` L64 (the sheet's authorised edit). The wolf's line and entry are intact. |

Not touched: `assetSpecies.ts`, `placement.ts`, `protocol.ts`, `whaleHull.ts`,
`bodyKit.ts`, `export_glb.py`, `render_glb.py`, `stat_glb.py`,
`docs/model-assets.md`, any test.

## Wiring verified at file:line this session

- `models.ts:589-590` `case 'whale': return whaleDrawables[|trunc(seed)| % length]`;
  `whaleDrawables = WHALE_SPECIES.map(body => speciesDrawable(whaleBuilders[body]))`
  L545, `WHALE_SPECIES = ['humpback','blue','sperm']` at `whaleSpecies.ts:34`,
  proven byte-identical to HEAD by `.envelope-diff.mts` (below) — index 2 is
  still the sperm whale.
- The animation is `species/whale.ts:82-86` (`animateWhale`, 0.45 Hz L68,
  0.3 rad L70, roll 0.12 L76), the function `assetSpeciesBuilder` hands every
  whale; models.ts no longer states any whale motion.
- `WHALE_ENVELOPE` `whaleSpecies.ts:50-54`; `placement.ts:40` imports it,
  `placement.ts:328` `BODY_COLUMNS.whale` and `:156-164` `SWIM_PROFILES.whale`
  read it; `protocol.ts:139` cites it. `git status` shows neither file modified.
- `installSpeciesAsset` (`assetSpecies.ts:228-`): measured at rest
  (`updateMatrixWorld(true)` L229), `flank` vs z extent as an upper bound
  L259-L264, `ENVELOPE_TOLERANCE_WORLD_UNITS = 0.01` L187.
- Why a procedural whale baked to two: `client/src/render/rigSkin.ts:325-331`
  — `bakeRig` appends `|flat`/`|indexed` (`piece.getIndex() === null`) to the
  material signature. Measured under Node with `--old`: HEAD's sperm body 2
  surfaces. `materialSignature` (L126-) omits colour, so this file's three
  colours at one roughness bake to ONE (measured).
- `index.ts` and `previewSpecies.ts` loop `SPECIES_ASSETS` with
  `loadRigAsset(url, null)` (unchanged); the one row in `assets.ts:52` reaches
  both.
- `lambert(…, { flatShading: false })` in `models.ts:302` STAYS: the option is
  the `SpeciesModelPool` contract (`species/speciesModel.ts:40`) and
  `species/bison.ts:124-127` and `species/ibex.ts:57-60` call it. Only the
  models.ts comment that pointed at `whaleMaterial` changed (L297-L301).

## Design decisions, as built

1. **Key `whale-sperm`, wire species `whale`.**
2. **Fills the box.** Nose +2.525, tail_tip −2.525, crown +0.670, belly −0.575
   measured to 0.0000000; `whaleEnvelope()` derives the three by identity;
   `halfWidth 0.44` is the body's own (the fitted procedural hull measured
   0.4375; the widest of the three, vs 0.47 humpback — the humpback's 0.47 is
   its chest plateau, so "widest of the three" holds for the head-box read
   rather than the number; noted, not changed: the sheet's ≈0.44 is met).
3. **THE CROWN IS THE HUMP** (the sheet fixes it): the back plateaus at 0.670
   over t 0.64–0.69; the head's top is 0.5885 (0.0815 under) and the tallest
   knuckle 0.6247 (0.0453 under), both asserted.
4. **THE BELLY IS THE CHEST** (the sheet's "state which"): the hull's bottom
   plateaus at −0.575 over t 0.40–0.50 behind the head; the jaw's underside
   is −0.5312 (0.0438 above, `JAW_ABOVE_BELLY 0.02` asserted) and the flippers
   reach −0.5169 (0.0581 above, asserted). Reason: the jaw is a narrow rod; a
   rod as the lowest point would put the envelope's belly on a 0.15-wide
   part, and the chest is what the water column is really cleared for.
5. **One envelope (rest).** `check_fluke_sweep`: hinge (−2.025, +0.130), tip
   reach 0.500; at ±0.3 rad the flukes' y stays in [−0.0225, +0.2825] and the
   x minimum shortens to −2.5041; asserted. With the body roll ±0.036 rad the
   whole model spans y [−0.6000, +0.6917], inside placement's ±0.7 — printed,
   not asserted, as passes 6–7.
6. **Joints `['rig','flukes']`**, `flukes` an Empty at the peduncle at identity
   (Node: rotation (0,0,0)); the welded wing `flukes_blade` under it, dark both
   sides. Anchors: `nose` (2.525, 0.080, 0), `tail_tip` (−2.525, 0.130, 0),
   `crown` (−0.5008, 0.670, 0), `belly` (0.523, −0.575, 0), `flank` (1.4557,
   0.0775, 0.440); the flippers reach 0.7685 out, the upper-bound case.
7. **The jaw is a body part, no joint** (the sheet), a swept rod whose aft end
   is buried in the throat (114 of 194 vertices inside the hull).
8. **Colours** (hexes via `srgb()`): body 0x39506b (the old WHALE_COLOR),
   lip 0xb8c4cf (the jaw only, as a vertex tint under a white material fading
   to the body tone over jaw station 0.55–0.95 so the rod melts into the
   throat), eye 0x0b0e13. One roughness 0.5, metalness 0.

**The one change from the prior attempt's build**: `HEAD_BOTTOM_Y` −0.46 →
−0.43 (`build_sperm_whale.py:162-165`). The first side render showed the jaw
as a hairline under the head (0.09 of its 0.18 depth); at −0.43 about 0.12
shows and the pale lower jaw reads side-on. Everything else in the script was
re-verified by rebuilding here: every assert passes, and the numbers in the
log below are this worktree's build, not the old one's.

## Envelope: measured vs declared, and old vs new

| field | declared | Blender (`check_envelope`, pre-export) | Node anchor / bounds | off by |
|-------|---------:|---------------------------------------:|---------------------:|-------:|
| nose x | +2.525 | +2.525000 | anchor (2.5250, 0.0800, 0); x max 2.5250 | 0.0000000 |
| tail_tip x | −2.525 | −2.525000 | anchor (−2.5250, 0.1300, 0); x min −2.5250 | 0.0000000 |
| crown y | +0.670 | +0.670000 | anchor (−0.5008, 0.6700, 0); y max 0.6700 | 0.0000000 |
| belly y | −0.575 | −0.575000 | anchor (0.5230, −0.5750, 0); y min −0.5750 | 0.0000000 |
| flank z | +0.44 | +0.440000 | anchor (1.4557, 0.0775, 0.4400); model z extent 0.7685 (flippers) | 0.0000000 |
| length / halfLength | 5.05 / 2.525 | 5.0500 / 2.5250 | size.x 5.050 | — |

`plugins/wildlife/.envelope-diff.mts` (uncommitted; HEAD's whaleSpecies.ts as
`client/.old-whaleSpecies.ts` from `git show HEAD:`, `Object.is`):

```
old WHALE_ENVELOPE: {"crownY":0.67,"bellyY":-0.575,"length":5.05}
new WHALE_ENVELOPE: {"crownY":0.67,"bellyY":-0.575,"length":5.05}
  crownY   old=0.67 new=0.67 IDENTICAL
  bellyY   old=-0.575 new=-0.575 IDENTICAL
  length   old=5.05 new=5.05 IDENTICAL
SPERM_WHALE_ENVELOPE: {"length":5.05,"halfLength":2.525,"halfWidth":0.44,"crownY":0.67,"bellyY":-0.575}
  spermWhale.crownY   = 0.67 vs WHALE_ENVELOPE 0.67 IDENTICAL
  spermWhale.bellyY   = -0.575 vs WHALE_ENVELOPE -0.575 IDENTICAL
  spermWhale.length   = 5.05 vs WHALE_ENVELOPE 5.05 IDENTICAL
  spermWhale.halfLength = 2.525 vs length/2 2.525 IDENTICAL
  spermWhale.halfWidth  = 0.44 (SPERM_WHALE_HALF_WIDTH 0.44, the one free field)
SWIM_PROFILES.whale: {"depthFraction":0.5,"minClearance":0.7,"minSubmergence":0.7,"halfLength":2.53,"halfWidth":0.5}
BODY_COLUMNS.whale : {"bellyY":-0.575,"crownY":0.67}
WHALE_SPECIES order: old ["humpback","blue","sperm"] new ["humpback","blue","sperm"] IDENTICAL
old procedural sets: sperm@0.7805
old exports: PROCEDURAL_WHALE_BODIES, WHALE_ENVELOPE, WHALE_SPECIES, assembleWhale, buildWhaleGeometrySets, geometriesOf
new exports: WHALE_ENVELOPE, WHALE_SPECIES
ALL IDENTICAL
```

`placement.ts` and `protocol.ts` are unmodified (not in `git status`), so the
two placement rows are the same source text evaluating the same values.

## Blender build log (shipped build; `tools/blender/out/sperm_whale_build.log`)

```
sperm whale build:
  hull: 64 rings x 30 segments
  winding hull: 1950 faces, 0 inward
  blender recalc hull: 1950 faces, 0 it would flip
  head: full width from t 0.160 to 0.335; the boxy section ends at t 0.3 (1.36 of 5.05 cells: 27%); the corner at 45 degrees sits at 0.816 of the beam against a round section's 0.707
  jaw: 16 rings x 12 segments, tip x +2.105 (0.42 behind the front), aft x +0.705; 181 vertices tinted toward the lip tone
  winding jaw: 204 faces, 0 inward
  blender recalc jaw: 204 faces, 0 it would flip
  blender recalc flipper_port / flipper_starboard: 121 faces each, 0 it would flip
  winding eye_port / eye_starboard: 32 faces, 0 inward; blender recalc 0 it would flip
  blender recalc flukes_blade: 400 faces, 0 it would flip
  attachment (vertices strictly inside the hull):
    jaw 114/194   flipper_port 20/121   flipper_starboard 20/121
    eye_port 18/26   eye_starboard 18/26   flukes_blade 14/392
  envelope (measured vs declared): nose/tail_tip/crown/belly/flank all off by 0.0000000
    the crown is the hump (+0.670000); the head's top is +0.5885, 0.0815 under it; the tallest knuckle +0.6247, 0.0453 under it
    the belly is the hull's chest (-0.575000); the jaw's underside -0.5312, 0.0438 above it; the flippers reach -0.5169, 0.0581 above it
    widest thing on the model 0.7685 (a fin; flank is the hull's head and chest, the upper-bound case the install allows)
    length 5.0500, halfLength 2.5250
  fluke sweep: hinge x -2.0250 y +0.1300, tip reach 0.5000 from the hinge
    flukes +0.30 rad: y [-0.0225, +0.2503] (box -0.575..+0.670); x min -2.5041 vs rest -2.5250 (-0.0209 shorter)
    + body roll +0.0360 rad: whole model y [-0.5665, +0.6631] against placement clearance +-0.7
    flukes -0.30 rad: y [+0.0188, +0.2825] (box -0.575..+0.670); x min -2.5041 vs rest -2.5250 (-0.0209 shorter)
    + body roll -0.0360 rad: whole model y [-0.6000, +0.6917] against placement clearance +-0.7
  body 3840   jaw 384   eye_port/eye_starboard 48 each   flipper_port/starboard 238 each   flukes_blade 780
sperm whale -> sperm-whale.glb: 5576 tris total
```

Every non-hull part has vertices strictly inside the hull; nothing floats.

## As exported (`stat_glb.py`, fresh import of the committed file)

```
bbox world units: x=5.050 y=1.245 z=1.537  min-y=-0.575  centre-xz=(0.000, 0.000)
meshes: 7
  body 3840 tris materials=['sperm_whale_body'] parent=rig
  jaw 384 materials=['sperm_whale_jaw'] colors=['Color'] parent=rig
  eye_port/eye_starboard 48 parent=rig   flipper_port/flipper_starboard 238 parent=rig
  flukes_blade 780 parent=flukes
total: 5576 tris
materials: 3 — sperm_whale_body (0.04,0.08,0.15), sperm_whale_eye (0,0,0.01),
  sperm_whale_jaw (white; Base Color is the vertex colour); all metallic=0.00 roughness=0.50; images: 0
empties: 7 — rig (0,0,0) parent=(none); flukes (-2.025, 0.130, 0) parent=rig;
  nose (2.525, 0.080, 0)  tail_tip (-2.525, 0.130, 0)  crown (-0.501, 0.670, 0)
  belly (0.523, -0.575, 0)  flank (1.456, 0.078, 0.440) — all parent=(none)
armatures: 0   skinned meshes: 0
```

## `.verify-sperm-whale-asset.mts` (uncommitted; the main checkout's blue-whale script, parameterised)

`node --experimental-strip-types .verify-sperm-whale-asset.mts`:

```
installSpeciesAsset: accepted sperm-whale.glb
GLB sperm whale (whale-sperm):
  surfaces: 1
  joints:   15
  triangles:5576
  materials: MeshStandardMaterial(smooth, roughness 0.5)
  joints resolved: rig, flukes
    rig      parent=Scene at (0.0000, 0.0000, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    flukes   parent=rig at (-2.0250, 0.1300, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    mesh flukes_blade parent=flukes; flipper_port, flipper_starboard, jaw, eye_port, eye_starboard, body parent=rig
  bounds x[-2.5250, 2.5250] y[-0.5750, 0.6700] z[-0.7685, 0.7685] size 5.050
  declared SPERM_WHALE_ENVELOPE: {"length":5.05,"halfLength":2.525,"halfWidth":0.44,"crownY":0.67,"bellyY":-0.575}
    nose (2.5250, 0.0800, 0)  tail_tip (-2.5250, 0.1300, 0)  crown (-0.5008, 0.6700, 0)
    belly (0.5230, -0.5750, 0)  flank (1.4557, 0.0775, 0.4400)
  jaw material colour #ffffff vertexColors=true; COLOR_0 present=true (194 vertices, 3 components)
  jaw COLOR_0 range (linear -> sRGB hex): darkest #39506b, palest #b8c4cf
  body material colour #39506b vertexColors=false
  baked surface carries a colour attribute: true (2802 vertices)
  expected: body #39506b (the old WHALE_COLOR), lip #b8c4cf
disposed blueprint then asset
GLB humpback (whale-humpback):   surfaces: 1  joints: 41  triangles:5426
GLB blue whale (whale-blue):     surfaces: 1  joints: 17  triangles:5438
draw-object tally: 8 single-surface non-whale species + 3 (three whale assets, measured) + 1 grazer + 1 wolf + 2 deepsea = 15
index.ts drawBudget = 11 + 1 + 1 + 1 * 2 = 15
```

`--old` (HEAD's `whaleSpecies.ts`): `sperm` fitScale 0.7805, 2 surfaces, 10
joints, 21 944 tris, bounds x[−2.5726, 2.4774] y[−0.5507, 0.4725]
z[−1.1452, 1.1452].

`materialSignature` reads `smooth` and the count bakes to ONE surface;
`attach`'s assert (`index.ts:380`) holds: 15 = 15.

### Draw budget and the final draw-object tally

| herd | surfaces |
|--|--:|
| fish, ibex, bison, ray, shark, eel, angelfish, bird | 1 each (8) |
| whale-humpback (asset) | 1 |
| whale-blue (asset) | 1 |
| **whale-sperm (asset)** | **1** |
| grazer (downloaded asset) | 1 |
| wolf (downloaded asset) | 1 |
| deepsea | 2 |
| **total = `drawBudget`** | **15** (unchanged: the sperm herd went 2 → 1 and the constant-side count moved from `TWO_SURFACE_SPECIES` to `SINGLE_SURFACE_SPECIES`) |

| body | surfaces | joints (bakeRig nodes) | triangles | material |
|--|--:|--:|--:|--|
| procedural sperm (HEAD, `--old`) | 2 | 10 | 21 944 | MeshLambertMaterial |
| **sperm-whale.glb** | **1** | 15 | **5 576** | MeshStandardMaterial |
| humpback.glb (pass 6, unchanged) | 1 | 41 | 5 426 | MeshStandardMaterial |
| blue-whale.glb (pass 7, unchanged) | 1 | 17 | 5 438 | MeshStandardMaterial |

Triangle aim ≤ ~8 000: met at 5 576 (hull 3840 + flukes 780 + flippers 476 +
jaw 384 + eyes 96).

## Renders (uncommitted, `tools/blender/out/`)

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ad2bcd0cf27ea53fa/tools/blender/out/sperm_whale_iso.png`
  — from the play angle a dark whale that is a box on the front: the
  squared-off head with the blowhole crater at its front-left corner, a barrel
  body collapsing to a narrow stock, the small paddle flippers, and the broad
  triangular flukes with their deep notch.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ad2bcd0cf27ea53fa/tools/blender/out/sperm_whale_side.png`
  — a Physeter in profile: a third of the length is a blunt, flat-topped,
  near-vertical-fronted head with the pale underslung jaw showing beneath it
  and the eye at the corner of the mouth; the back rises into the rounded
  hump two thirds back, knuckles ridge the stock behind it, and there is no
  dorsal fin.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ad2bcd0cf27ea53fa/tools/blender/out/sperm_whale_front.png`
  — a tall rounded-square section (the boxy head) with the flipper tips
  either side, the hump peeking over the head top behind, and the fluke tips
  beyond.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ad2bcd0cf27ea53fa/tools/blender/out/sperm_whale_top.png`
  — the planform: a wide flat-fronted head holding its beam for a third of
  the body, then a steady taper to the peduncle, short flippers swept aft,
  and the wide triangular flukes with the deep central notch.

Close-ups used to judge (`sperm_whale_close_*.png`, via the scratch
`out/closeup.py`): `flank` (the seven wrinkles as soft vertical grooves, the
flipper's thick blended root), `head_under` (the pale jaw rod stopping short
of the snout, the eye), `head_side` (before/after the `HEAD_BOTTOM_Y` change:
the jaw now a visible pale strip), `stern` (the stock sinks into a level wing
surface; the deep notch).

## Deletion list, and `whaleHull.ts` / `bodyKit.ts` remaining users

Deleted from `whaleSpecies.ts` (all verified unreferenced by grep over
`plugins/` and `client/src`, excluding the scratch `.old-whaleSpecies.ts`):
`spermSet`, `WhaleGeometrySet`, `WhalePart`, `part`, `assembleWhale`,
`buildWhaleGeometrySets`, `geometriesOf`, `finish`, `uprightFin`,
`FIN_ROOT_INSET`, `DORSAL_SEAT_DEPTH`, `bodyT`, `seatZ`, `seatY`,
`AUTHORED_LENGTH`, the eleven `SPERM_*` constants, `PROCEDURAL_WHALE_BODIES`,
and the `three` and `./whaleHull.ts` imports. Deleted from `models.ts`:
`WHALE_COLOR`, `whaleMaterial`, `whaleSets`, `proceduralWhaleRigs`, the
`animateWhale` import. `lambert`'s `flatShading` option KEPT (bison, ibex).

`../whaleHull.ts` remaining importers (imports, not comments):
- `plugins/wildlife/client/species/bison.ts:28` (`profileFromPoints`, `sweptHull`, `BodyProfile`)
- `plugins/wildlife/client/species/ibex.ts:16` (`profileFromPoints`, `sweptHull`, `BodyProfile`)

`./bodyKit.ts` remaining importers: `species/bison.ts:29`, `species/ibex.ts:17`,
`species/quadruped.ts:13` (unchanged; the whale never used bodyKit).

**`finGeometry` (`whaleHull.ts:200`) has lost its last user** — only the
whale ever called it. `sweptHull` (L62) and `profileFromPoints` (L170) keep
bison and ibex. Nothing deleted from `whaleHull.ts`; the orchestrator decides.

## Verification runs

- `pnpm install --frozen-lockfile`: "Done in 34s", exit 0; lockfile unchanged
  (`git status --short pnpm-lock.yaml` empty).
- `pnpm typecheck` (root): every package `Done`, exit 0
  (`tools/blender/out/typecheck.log`).
- Wildlife tests per file from `plugins/wildlife`, `timeout 240 npx vitest run <file>`:
  `assetSpecies.test.ts` 4 passed; `client.test.ts` 18 passed;
  `gradient.test.ts` 6 passed; `session-lifecycle.test.ts` 3 passed;
  `wildlife.test.ts --hookTimeout 120000` 17 passed (first run was killed at
  exit 137 while the other four ran concurrently on /mnt/e; re-run alone it
  passed — `tools/blender/out/wildlife-test.log`). No assertion encoded the
  procedural whale; no test changed, none added.
- Blender build log, `stat_glb.py`, `.verify-sperm-whale-asset.mts` (+ `--old`),
  `.envelope-diff.mts`: above.
- grep for `spermSet`, `SPERM_`, `assembleWhale`, `buildWhaleGeometrySets`,
  `geometriesOf`, `PROCEDURAL_WHALE_BODIES`, `WhaleGeometrySet`,
  `whaleMaterial`, `WHALE_COLOR`, `uprightFin`, `seatY`, `DORSAL_SEAT_DEPTH`:
  no live references outside comments (bodyKit.ts has its own `uprightFin`,
  which the angelfish uses — unrelated to the deleted one).

## Left undone, and why

- **Wrinkle depth.** The seven wrinkles (0.014) read in the flank close-up as
  soft grooves and are subtle at play distance — as the animal's are; deeper
  would start to read as ribs. Not changed.
- **The jaw is a thin strip side-on** even after the `HEAD_BOTTOM_Y` change:
  0.12 of a 0.18-deep rod under a 1.0-deep head. That is the sheet's "narrow
  underslung lower jaw as a rod"; making it the belly instead would have put
  the envelope's lowest point on a 0.15-wide part (decision 4).
- Hinged-fin residual as passes 6–7: at the stroke extreme the flukes' buried
  root (0.36 ahead of the hinge) rotates inside the stock and a surface can
  emerge for a frame. Estimated, not rendered in motion — the app was not
  started.
- Whole-model extremes under the body roll exceed the box by ≤ 0.025
  (decision 5): the shared animation's property, printed, not fixed here.
- `whaleHull.ts`'s header (and `finGeometry`) still speak of the whale; left
  for the orchestrator's decision on `finGeometry`.
- Uncommitted scratch left in the worktree as the brief asks:
  `plugins/wildlife/.verify-sperm-whale-asset.mts`, `plugins/wildlife/.envelope-diff.mts`,
  `plugins/wildlife/client/.old-whaleSpecies.ts`, `tools/blender/out/` (renders,
  close-ups, logs, `blender.sh`, `closeup.py`).

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ad2bcd0cf27ea53fa`
Branch: `worktree-agent-ad2bcd0cf27ea53fa`
Code commit: `a29d6ef`; final commit (this report): see `git log -1`.
