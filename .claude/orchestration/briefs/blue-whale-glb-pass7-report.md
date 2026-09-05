# Report: fish+whales → Blender pass 7 — the blue whale (`whale` variant 1)

Brief: `.claude/orchestration/briefs/species-glb-pass-template.md` +
`.claude/orchestration/briefs/blue-whale-glb-pass7.md`, on the pass-6 pattern
(`humpback-glb-pass6.md` and its report). Worktree branch
`worktree-agent-ae088bb4bc19a824b`; nothing merged, nothing pushed, the app was
never started, no test added or changed, the main checkout untouched (its
untracked `.verify-humpback-asset.mts` / `.envelope-diff.mts` were read and
copied). `whale.ts` was not changed — no defect found in it.

## What landed (commit 5b2c861)

| file | what |
|------|------|
| `tools/blender/build_blue_whale.py` (new, 1399 lines) | Constants with reasons L110–L378: the box `LENGTH`/`CROWN_Y`/`BELLY_Y` L114–L118, `HALF_WIDTH = 0.37` L122, `FLUKE_REACH = 0.50`/`PEDUNCLE_X` L131–L132, `TOP_PROFILE`/`BOTTOM_PROFILE`/`WIDTH_PROFILE` L153–L172 (absolute back and belly lines with a crown plateau t 0.40–0.60 and a belly plateau t 0.34–0.50; a blunt U rostrum), the anchor stations `FLANK_T`/`CROWN_T`/`BELLY_T` L175–L177 (asserted to be ring stations, main), `RIDGE_EXTRA_ARCS` L186 (extra ring rows either side of the back line so the ridge has slopes), `NOSE_CAP_PLAN_POWER = 2.8` L200 (a superellipse cap in plan only: the U from above, a wedge from the side), the ridge L212–L215, pleats L233–L239 (`PLEAT_COUNT 10`, depth 0.02, chin to t 0.40 — the front third), flippers L247–L268 (span 0.64 = an eighth of the body, hang 0.25 rad, a pointed tip via `FLIPPER_TIP_ROUNDING_POWER 3.0` + `FLIPPER_TAPER 0.55`, the tip at −0.458 > belly), flukes L283–L292 (half-span 0.66, notch 0.10 deep, tip swept to −0.28, 20 span stations so the lobe s 0.45 is a vertex — asserted in `fluke_stations`), the dorsal nub L301–L311 (`DORSAL_T 0.78`, height 0.13, `DORSAL_TIP_BELOW_CROWN 0.05` asserted), colours L348–L350, `SURFACE_ROUGHNESS` L357, `ANCHOR_TOLERANCE 1e-9` L376. `cap_factor(t, nose_power)` L444; `ridge` L528 (replaces the humpback's hump); `throat_weight` L555 (vertex-tint gradient, as pass 6); `ring_thetas` L798; `loft_fin` L910 / `weld_mirrored` L985 (verbatim from pass 6); `check_attachment` L1146 (parity); `check_envelope` L1164 (now also asserts the nub is below the crown and no flipper is the belly); `check_keel` L1201 (`KEEL_FROM_T 0.70`); `check_fluke_sweep` L1224; `main` L1283. |
| `plugins/wildlife/client/assets/blue-whale.glb` (new, 130 268 bytes) | 9 meshes (body, dorsal, 2 eyes, 2 flippers + 2 undersides, flukes blade), 4 materials, 7 Empties, 5438 tris. |
| `plugins/wildlife/client/species/blueWhale.ts` (new, 86 lines) | Header (what changed / did not / crown-is-the-back decision / one envelope) L1–L52; `BLUE_WHALE_HALF_WIDTH = 0.37` L64; `BLUE_WHALE_ENVELOPE = whaleEnvelope(…)` L72; `BLUE_WHALE_ASSET` L79 (`species: 'whale-blue'`, `file: 'blue-whale.glb'`, `joints: WHALE_JOINTS`); `buildBlueWhale = assetSpeciesBuilder(BLUE_WHALE_ASSET, animateWhale)` L86. |
| `plugins/wildlife/client/whaleSpecies.ts` | `blueSet` and its seven `BLUE_*` constants removed (profile numbers now the reference silhouette in build_blue_whale.py's header L64–L77); `PROCEDURAL_WHALE_BODIES = 1` L51; `buildWhaleGeometrySets` L273 returns `[spermSet()]` and still throws if the count disagrees; header L1–L19 records the change. `WHALE_SPECIES` and `WHALE_ENVELOPE` untouched (L43, L67). |
| `plugins/wildlife/client/models.ts` | Header L9–L11; `buildBlueWhale` import L72; `whaleDrawables` L576 — `blue` → `speciesDrawable(buildBlueWhale)`; the procedural comment L328–L331. `drawableOf` unchanged. |
| `plugins/wildlife/client/index.ts` | Surface table gains the `whale-blue` row L279; the two-surface explanation now names sperm only and cites both verify scripts L288–L295; `SINGLE_SURFACE_SPECIES = 10` L309; `TWO_SURFACE_SPECIES = 1 + PROCEDURAL_WHALE_BODIES` L310 (= 2). `drawBudget` 16 → 15. |
| `plugins/wildlife/client/species/assets.ts` | `BLUE_WHALE_ASSET` import L29, `blueWhaleUrl` L30, the one row L47; header list gains the blue whale. |
| `client/src/previewSpecies.ts` | `?species=` list L8 and `BUILDERS['whale-blue']` L60 (the sheet's authorised edit). |

Not touched: `whale.ts`, `assetSpecies.ts`, `placement.ts`, `protocol.ts`,
`whaleHull.ts`, `bodyKit.ts`, `export_glb.py`, `render_glb.py`, `stat_glb.py`,
`docs/model-assets.md`, any test.

## Wiring verified at file:line this session

- `models.ts:628-629` `case 'whale': return whaleDrawables[|trunc(seed)| % length]`;
  `whaleDrawables = WHALE_SPECIES.map(...)` L574, so index 1 is `blue` —
  `WHALE_SPECIES = ['humpback','blue','sperm']` at `whaleSpecies.ts:43`, unchanged.
- The animation is `species/whale.ts:82-86` (`animateWhale`, 0.45 Hz L68,
  0.3 rad L70, roll 0.12 L76); `assetSpeciesBuilder(BLUE_WHALE_ASSET, animateWhale)`
  hands it the same function the humpback and the procedural sperm run on
  (`models.ts:583`).
- `WHALE_ENVELOPE` `whaleSpecies.ts:67-71`; `placement.ts:328` `BODY_COLUMNS.whale`
  and `placement.ts:156-164` `SWIM_PROFILES.whale` read it; `git diff HEAD --
  client/placement.ts protocol.ts` is empty (0 lines).
- `installSpeciesAsset` (`assetSpecies.ts:225-280`): joints by name L240-L243,
  anchors vs `Box3` extremes L245-L254, `flank` vs z extent L256-L264, five
  envelope fields L267-L271, tolerance 0.01 L184, measured at rest L226.
- Why a procedural whale is two surfaces: `client/src/render/rigSkin.ts:302-309`
  (indexed hull vs non-indexed `ExtrudeGeometry` fins); the sperm body measures
  2 under Node (below). `materialSignature` L111-L152 omits colour, so the
  three-colour, one-roughness file bakes to ONE.
- `index.ts:351` and `previewSpecies.ts:135` loop `SPECIES_ASSETS` with
  `loadRigAsset(url, null)`; the one row in `assets.ts:47` reaches both.

## Design decisions, as built

1. **Key `whale-blue`, wire species `whale`.** `BLUE_WHALE_ASSET.species`
   is the install-map key only; `models.ts` keeps `case 'whale'`.
2. **Fills the box.** Nose +2.525, tail_tip −2.525, crown +0.670, belly
   −0.575 measured to 0.0000000; `whaleEnvelope()` derives the three numbers
   by identity; `halfWidth 0.37` is the body's own (the fitted procedural
   hull measured 0.3646). Same length as the fitted body (which was
   length-capped); now the full 1.245 tall instead of 0.84 — intended.
3. **THE CROWN IS THE BACK ITSELF; the nub stays below it** (the sheet's
   "state which"). The hull's back plateaus at 0.670 over t 0.40–0.60 (a
   monotone-cubic plateau is exact); the dorsal nub (0.13 tall on a seat
   0.03 into the back at t 0.78) tops out at +0.5767, 0.093 under the crown,
   and `check_envelope` ASSERTS it stays ≥ `DORSAL_TIP_BELOW_CROWN` (0.05)
   under. Reason: a blue whale's tell from the side is a long low flat back
   with a nub on it; lifting the nub to the crown would make it a fin.
4. **The belly is the chest**, on its own plateau (t 0.34–0.50) at −0.575;
   the flippers, held close (hang 0.25 rad, set low at y −0.30), reach
   −0.4583 — 0.117 above it; asserted (`flipper_min > BELLY_Y`).
5. **One envelope (rest).** `check_fluke_sweep`: hinge (−2.025, +0.130),
   tip reach 0.500; at ±0.3 rad the flukes' y stays in [−0.0225, +0.2825]
   and the x minimum shortens to −2.5041 (cos ≤ 1); asserted. With the body
   roll ±0.036 rad the whole model spans y [−0.6098, +0.6949], inside
   placement's ±0.7 clearance — printed, not asserted, as in pass 6.
6. **Joints `['rig','flukes']`**, `flukes` an Empty at the peduncle at
   identity (Node: rotation (0,0,0)), the welded wing (`flukes_blade`) under
   it as ONE closed object in the body tone (a blue whale's flukes are dark
   both sides, so no underside sheet). Anchors: `nose` (2.525, −0.065, 0),
   `tail_tip` (−2.525, 0.130, 0), `crown` (0.5685, 0.670, 0), `belly`
   (0.5685, −0.575, 0), `flank` (0.705, 0.0475, 0.370); the flippers reach
   0.896 out, the upper-bound case.
7. **Tail stock taller than wide.** `check_keel` finds the last run of
   rings with half-height > half-width and asserts it starts by t 0.70; it
   starts at t 0.08 — in this box (1.245 tall, 0.74 wide) the whole body is
   deeper than it is wide, and the stock at t 0.90 is 0.50 tall by 0.23
   wide (the stern close-up: a tall oval under the wing).
8. **Colours** (hexes via `srgb()`): body 0x39506b (WHALE_COLOR), ventral
   0x8fa4b8 (the pleated throat as a vertex-tint gradient under a white hull
   material, and the flipper undersides as a plain material — a blue-grey
   rather than the humpback's near-white, because the animal's underside is
   grey), eye 0x0b0e13. One roughness 0.5, metalness 0.

**Construction notes.** The throat is the pass-6 vertex-colour gradient
(`throat_weight`), not a face split. The rostrum's plan cap is a superellipse
(`NOSE_CAP_PLAN_POWER`, L195–L200): the first build's quarter-ellipse cap
rendered the head as a spade from above; the height cap stays power 2 so the
side profile is a wedge. The median ridge needed its own ring rows
(`RIDGE_EXTRA_ARCS`): on the 15° quadrant grid a 0.22 rad ridge had one
vertex. The pleats went from 0.012 to 0.02 deep after the first throat
close-up showed nothing.

## Envelope: measured vs declared, and old vs new

| field | declared | Blender (`check_envelope`, pre-export) | Node anchor / bounds | off by |
|-------|---------:|---------------------------------------:|---------------------:|-------:|
| nose x | +2.525 | +2.525000 | anchor (2.5250, −0.0650, 0); x max 2.5250 | 0.0000000 |
| tail_tip x | −2.525 | −2.525000 | anchor (−2.5250, 0.1300, 0); x min −2.5250 | 0.0000000 |
| crown y | +0.670 | +0.670000 | anchor (0.5685, 0.6700, 0); y max 0.6700 | 0.0000000 |
| belly y | −0.575 | −0.575000 | anchor (0.5685, −0.5750, 0); y min −0.5750 | 0.0000000 |
| flank z | +0.37 | +0.370000 | anchor (0.7050, 0.0475, 0.3700); model z extent 0.8963 (flippers) | 0.0000000 |
| length / halfLength | 5.05 / 2.525 | 5.0500 / 2.5250 | size.x 5.050 | — |

`plugins/wildlife/.envelope-diff.mts` (uncommitted; HEAD's whaleSpecies.ts as
`client/.old-whaleSpecies.ts` from `git show HEAD:`, `Object.is`):

```
old WHALE_ENVELOPE: {"crownY":0.67,"bellyY":-0.575,"length":5.05}
new WHALE_ENVELOPE: {"crownY":0.67,"bellyY":-0.575,"length":5.05}
  crownY   old=0.67 new=0.67 IDENTICAL
  bellyY   old=-0.575 new=-0.575 IDENTICAL
  length   old=5.05 new=5.05 IDENTICAL
BLUE_WHALE_ENVELOPE: {"length":5.05,"halfLength":2.525,"halfWidth":0.37,"crownY":0.67,"bellyY":-0.575}
  blueWhale.crownY   = 0.67 vs WHALE_ENVELOPE 0.67 IDENTICAL
  blueWhale.bellyY   = -0.575 vs WHALE_ENVELOPE -0.575 IDENTICAL
  blueWhale.length   = 5.05 vs WHALE_ENVELOPE 5.05 IDENTICAL
  blueWhale.halfLength = 2.525 vs length/2 2.525 IDENTICAL
  blueWhale.halfWidth  = 0.37 (BLUE_WHALE_HALF_WIDTH 0.37, the one free field)
SWIM_PROFILES.whale: {"depthFraction":0.5,"minClearance":0.7,"minSubmergence":0.7,"halfLength":2.53,"halfWidth":0.5}
BODY_COLUMNS.whale : {"bellyY":-0.575,"crownY":0.67}
WHALE_SPECIES order: ["humpback","blue","sperm"] PROCEDURAL_WHALE_BODIES: 1
old procedural sets: blue@0.7902, sperm@0.7805
new procedural sets: sperm@0.7805
ALL IDENTICAL
```

## Blender build log (shipped build; `tools/blender/out/blue_whale_build.log`)

```
blue whale build:
  hull: 37 rings x 52 segments (447 vertices tinted toward the throat tone)
  winding hull: 1976 faces, 0 inward
  blender recalc hull: 1976 faces, 0 it would flip
  keel: the stock is taller than wide from t 0.08 (x +2.161) to the peduncle
  blender recalc flipper_port / flipper_starboard: 161 faces each, 0 it would flip
  blender recalc dorsal: 41 faces, 0 it would flip
  winding eye_port / eye_starboard: 32 faces, 0 inward; blender recalc 0 it would flip
  blender recalc flukes_blade: 400 faces, 0 it would flip
  attachment (vertices strictly inside the hull):
    flipper_port 10/161   flipper_starboard 10/161   dorsal 16/41
    eye_port 19/26   eye_starboard 19/26   flukes_blade 14/392
  envelope (measured vs declared): nose/tail_tip/crown/belly/flank all off by 0.0000000
    the crown is the hull's back (+0.670000); the dorsal nub tops out at +0.5767, 0.0933 under it
    the belly is the hull's chest (-0.575000); the flippers reach -0.4583, 0.1167 above it
    widest thing on the model 0.8963 (a fin; flank is the hull's chest, the upper-bound case)
    length 5.0500, halfLength 2.5250
  fluke sweep: hinge x -2.0250 y +0.1300, tip reach 0.5000 from the hinge
    flukes +0.30 rad: y [-0.0225, +0.2430] (box -0.575..+0.670); x min -2.5041 vs rest -2.5250 (-0.0209 shorter)
    + body roll +0.0360 rad: whole model y [-0.5669, +0.6949] against placement clearance +-0.7
    flukes -0.30 rad: y [+0.0188, +0.2825] (box -0.575..+0.670); x min -2.5041 vs rest -2.5250 (-0.0209 shorter)
    + body roll -0.0360 rad: whole model y [-0.6098, +0.6774] against placement clearance +-0.7
  body 3848   dorsal 78   eye_port/eye_starboard 48 each
  flipper_port/starboard 194 each + undersides 124 each   flukes_blade 780
blue whale -> blue-whale.glb: 5438 tris total
```

Every non-hull part has vertices strictly inside the hull; nothing floats.

## As exported (`stat_glb.py`, fresh import of the committed file)

```
bbox world units: x=5.050 y=1.245 z=1.793  min-y=-0.575  centre-xz=(0.000, 0.000)
meshes: 9
  body 3848 tris materials=['blue_whale_hull'] colors=['Color'] parent=rig
  dorsal 78 parent=rig   eye_port/eye_starboard 48 parent=rig
  flipper_port 194 / flipper_port_underside 124 parent=rig (starboard the same)
  flukes_blade 780 parent=flukes
total: 5438 tris
materials: 4 — blue_whale_body (0.04,0.08,0.15), blue_whale_eye, blue_whale_hull (white; Base Color is the vertex colour),
  blue_whale_ventral (0.27,0.37,0.48); all metallic=0.00 roughness=0.50; images: 0
empties: 7 — rig (0,0,0) parent=(none); flukes (-2.025, 0.130, 0) parent=rig;
  nose (2.525, -0.065, 0)  tail_tip (-2.525, 0.130, 0)  crown (0.568, 0.670, 0)
  belly (0.568, -0.575, 0)  flank (0.705, 0.047, 0.370) — all parent=(none)
armatures: 0   skinned meshes: 0
```

## `.verify-blue-whale-asset.mts` (uncommitted; pass 6's script, parameterised, `--old` added)

`node --experimental-strip-types .verify-blue-whale-asset.mts`:

```
installSpeciesAsset: accepted blue-whale.glb
GLB blue whale (whale-blue):
  surfaces: 1
  joints:   17
  triangles:5438
  materials: MeshStandardMaterial(smooth, roughness 0.5)
  joints resolved: rig, flukes
    rig      parent=Scene at (0.0000, 0.0000, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    flukes   parent=rig at (-2.0250, 0.1300, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    mesh flukes_blade parent=flukes; flipper_starboard(_underside), dorsal, eye_port, body parent=rig
  bounds x[-2.5250, 2.5250] y[-0.5750, 0.6700] z[-0.8963, 0.8963] size 5.050
  declared BLUE_WHALE_ENVELOPE: {"length":5.05,"halfLength":2.525,"halfWidth":0.37,"crownY":0.67,"bellyY":-0.575}
    nose (2.5250, -0.0650, 0)  tail_tip (-2.5250, 0.1300, 0)  crown (0.5685, 0.6700, 0)
    belly (0.5685, -0.5750, 0)  flank (0.7050, 0.0475, 0.3700)
  body material colour #ffffff vertexColors=true; COLOR_0 present=true (1926 vertices, 3 components)
  hull COLOR_0 range (linear -> sRGB hex): darkest #39506b, palest #8fa4b8
  baked surface carries a colour attribute: true (2805 vertices)
  expected: body #39506b (WHALE_COLOR), ventral #8fa4b8
disposed blueprint then asset
procedural whale body "sperm" (fitScale 0.7805):  surfaces: 2  joints: 10  triangles:21944
  bounds x[-2.5726, 2.4774] y[-0.5507, 0.4725] z[-1.1452, 1.1452] length 5.050
draw-object tally: 10 single-surface species (incl. humpback, blue whale) + 1 grazer + 2 deepsea + 2 (one procedural whale, sperm) = 15
index.ts drawBudget = 10 + 1 + (1 + 1) * 2 = 15
```

`--old` (HEAD's `whaleSpecies.ts`): `blue` fitScale 0.7902, 2 surfaces, 10
joints, 19 332 tris; `sperm` 0.7805, 2 surfaces, 21 944 tris.

`materialSignature` reads `smooth` and the count bakes to ONE surface;
`attach`'s assert (`index.ts:366`) holds: 15 = 15.

### Draw budget and draw-object tally

| herd | surfaces |
|--|--:|
| fish, ibex, bison, ray, shark, eel, angelfish, bird | 1 each (8) |
| whale-humpback (asset) | 1 |
| **whale-blue (asset)** | **1** |
| grazer (downloaded asset) | 1 |
| deepsea | 2 |
| whale-sperm (procedural) | 2 |
| **total = `drawBudget`** | **15** (was 16) |

| body | surfaces | joints (bakeRig nodes) | triangles | material |
|--|--:|--:|--:|--|
| procedural blue (HEAD, `--old`) | 2 | 10 | 19 332 | MeshLambertMaterial |
| **blue-whale.glb** | **1** | 17 | **5 438** | MeshStandardMaterial |
| humpback.glb (pass 6, unchanged) | 1 | 41 | 5 426 | MeshStandardMaterial |
| procedural sperm (still drawn) | 2 | 10 | 21 944 | MeshLambertMaterial |

Triangle aim ≤ ~8 000: met at 5 438 (hull 3848 + flippers 636 + flukes 780 +
dorsal 78 + eyes 96).

## Renders (uncommitted, `tools/blender/out/`)

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ae088bb4bc19a824b/tools/blender/out/blue_whale_iso.png`
  — from the play angle a long, slim, dark body: the broad flat head, the
  small pointed flippers swept back close to the flank, a nub of a dorsal far
  back on a flat back, the narrow stock and the wide thin flukes with their
  small notch.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ae088bb4bc19a824b/tools/blender/out/blue_whale_side.png`
  — in profile a flat back running level over the chest, the low wedge of a
  head with the eye behind the gape, a small flipper held under the chest, the
  tiny falcate nub three quarters back, the stock rising into thin flukes; the
  body is deeper than a real blue whale's because the box is 1.245 tall on a
  0.74 beam (see "left undone").
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ae088bb4bc19a824b/tools/blender/out/blue_whale_front.png`
  — a tall oval section with the median ridge as a line down the head's
  centre, the paler throat under the chin, the flippers as slender blades
  angled down and out, the fluke tips just visible beyond.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ae088bb4bc19a824b/tools/blender/out/blue_whale_top.png`
  — the planform: a broad rounded U of a rostrum, a slim body tapering
  steadily to the peduncle, small swept flippers, the dorsal a dash, and the
  flukes a wide, slightly swept wing with a shallow notch.

Close-ups used to judge (`blue_whale_close_*.png`): `head_plan` (the U
rostrum and ridge, after the superellipse cap), `throat` (the pleats as
parallel grooves under the pale gradient, the flipper's pale underside, the
eye), `peduncle` and `stern` (the stock sinks into a level wing surface, no
crease; the keel a tall oval), `belly`, `head_top`, `head_side`, `flipper`.

## `whaleHull.ts` / `bodyKit.ts` remaining users (imports, not comments)

- `../whaleHull.ts`: `client/whaleSpecies.ts:40` (sperm), `species/bison.ts:28`,
  `species/ibex.ts:16`.
- `./bodyKit.ts`: `species/bison.ts:29`, `species/ibex.ts:17`, `species/quadruped.ts:13`.
  The whale never used bodyKit.

Nothing shared deleted. In `whaleSpecies.ts`, `uprightFin` (L202), `DORSAL_SEAT_DEPTH`
(L216), `seatY` (L237) and the `ExtrudeGeometry`/`Shape` imports are now
UNREFERENCED — only the blue whale had a dorsal. Left in place (the sheet
authorised removing `blueSet`; the file goes with pass 8), flagged here for
that pass.

## Verification runs

- `pnpm install --frozen-lockfile`: "Done in 1m 44.6s", exit 0; lockfile unchanged.
- `pnpm typecheck` (root): every package `Done`, exit 0.
- Wildlife tests per file from `plugins/wildlife`, `timeout 240 npx vitest run <file>`:
  `assetSpecies.test.ts` 4 passed; `client.test.ts` 18 passed;
  `gradient.test.ts` 6 passed; `session-lifecycle.test.ts` 3 passed;
  `wildlife.test.ts --hookTimeout 120000` 17 passed (20.93 s). No assertion
  encoded the procedural blue whale; no test changed, none added.
- Blender build log, `stat_glb.py`, `.verify-blue-whale-asset.mts` (+ `--old`),
  `.envelope-diff.mts`: above; logs in `tools/blender/out/blue_whale_*.log`.
- `grep` for `blueSet` / `BLUE_` outside the build script's header: no live
  references.

## Left undone, and why

- **Body depth.** Filling the box puts 1.245 of height on a 0.74 beam (aspect
  1.68 at the chest; the procedural body was ~1.06). From the play camera the
  whale reads long and slim (the top and iso renders); side-on it is deeper
  than the animal. That is the sheet's rule (every whale asset fills the box,
  crown and belly exactly) meeting the sheet's half-width (≈0.37, the
  slimmest) — the alternative, a wider hull, would break the "slimmest of the
  three" read that separates it from the sperm whale. Not changed; named.
- No mouth line: the blue whale's gape (snout to eye along the head's side) is
  not cut into the hull. It would need its own dense ring rows through the
  head's flank as the ridge and pleats have; the sheet's list did not include
  it. The eye marks its end.
- The pleats are ten grooves for the animal's sixty-odd, 0.02 deep: visible in
  the throat close-up as fine parallel lines, subtle at play distance (as the
  animal's are).
- Hinged-fin residual as pass 6: at the stroke extreme the flukes' buried root
  (0.36 ahead of the hinge) rotates inside the stock; the stock at that station
  is 0.13 tall about the hinge's y and the root's half-thickness 0.055 pitched
  by 0.3 rad moves ±0.1 — a surface can emerge for a frame. Estimated, not
  rendered in motion — the app was not started.
- Whole-model extremes under the body roll exceed the box by ≤ 0.035 (decision
  5): the shared animation's property, printed, not fixed here.
- Uncommitted scratch left in the worktree as the brief asks:
  `plugins/wildlife/.verify-blue-whale-asset.mts`, `plugins/wildlife/.envelope-diff.mts`,
  `plugins/wildlife/client/.old-whaleSpecies.ts`, `tools/blender/out/` (renders,
  close-ups, logs, `blender.sh`, `closeup.py`).

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ae088bb4bc19a824b`
Branch: `worktree-agent-ae088bb4bc19a824b`
Code commit: `5b2c861`; final commit (this report): see `git log -1`.
