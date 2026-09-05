# Report: fish+whales → Blender pass 5 — the angelfish (model-only, bars as geometry)

Brief: `.claude/orchestration/briefs/species-glb-pass-template.md` +
`.claude/orchestration/briefs/angelfish-glb-pass5.md`. Worktree branch
`worktree-agent-ac47f3cb7e3bbdbb7`; nothing merged, nothing pushed, the app
was never started, no test added or changed.

## What landed (commit 7aa6492)

| file | what |
|------|------|
| `tools/blender/build_angelfish.py` (new, 1114 lines) | Constants with reasons (L86–L275): the five envelope figures L87–L110, `BAR_PROUD = FLANK_Z - MAX_HALF_WIDTH` L115, the width plateau under the front bar `WIDTH_PROFILE` L153, `HEIGHT_RATIO_PROFILE` L161 (2.6 at the crown of the curve), `ANCHOR_TOLERANCE = 1e-9` L272. `monotone_profile` L289 (no overshoot: the plateau IS the maximum); `smooth_point` / `smooth_normal` L368/L381; the bars' bump `raised_cosine` / `flank_distance` / `bar_bump` L405–L433 and `surface_point` L435 (smooth section + bump along the smooth normal); `build_hull` L676 (one hull, faces split body / four bar patches, smooth normals as custom split normals); `dorsal` L766, `anal` L783, `caudal` L800, `pectoral_blade` L829, `mouth` L841 (all tapered blades — root-thick, edge-thin); the checks `check_outward` L464, `check_attachment` L911 (parity), `check_bars` L929 (front bar face == flank anchor, rims on the smooth hull), `check_envelope` L962 (extremes to 1e-9); Empties and anchors in `main` L1006–L1098; export via `export_glb.py` L1101. |
| `plugins/wildlife/client/assets/angelfish.glb` (new, 54,028 bytes) | 13 meshes, 4 materials, 9 Empties, 1786 tris. |
| `plugins/wildlife/client/species/angelfish.ts` (rewritten, 166 lines) | Header (what changed / did not / the bars decision / port-starboard derivation) L1–L57; `ANGELFISH_TAIL_HZ`, `ANGELFISH_TAIL_SWING_RADIANS` still exported L87–L88; `DORSAL_CROWN_Y` L113 and `ANAL_BELLY_Y` L119 full-precision literals with derivations; `ANGELFISH_ENVELOPE` L127 (length/halfLength by the old expression shape); `ANGELFISH_ASSET` L143 (`SWIMMER_JOINTS`); `buildAngelfish = assetSpeciesBuilder(…)` L150; tail/rig yaw L154–L155; pectoral sign mapping L164–L165. |
| `plugins/wildlife/client/species/assets.ts` | `import { ANGELFISH_ASSET }` L24, `angelfishUrl` L25, the one row L40; header list gains "angelfish". |
| `plugins/wildlife/client/species/fish.ts` L7–L9, `shark.ts` L8–L9 | The extra deliverable: stale "grazer, ibex, bison, ray, shark, eel and angelfish" user lists replaced with the actual remaining users (ibex, bison; whales on whaleHull; quadruped.ts on bodyKit). |

Not touched: `assetSpecies.ts`, `placement.ts`, `index.ts`, `previewSpecies.ts`,
`whaleHull.ts`, `bodyKit.ts`, `docs/model-assets.md`, any test.

## Design decision, as built: the bars are a locally thickened section

The sheet fixed the decision (halfWidth 0.085 is a bar's outer face; `flank`
sits there; bars cannot be paint) and offered two constructions. I took the
second — a locally thickened section — because it has no seam, no rim and
nothing to float: the hull's surface function (`surface_point`,
`build_angelfish.py:435`) is the smooth ellipse-section disc plus a bump
along the smooth normal, `BAR_PROUD · raised_cosine(Δx / 0.035) ·
raised_cosine(Δθ / 60°)`, so it is exactly 0.015 proud on the front bar's
centre ring at the flank line and exactly zero at the bar's rim rings and
60° rows. The bar's faces (rim ring to rim ring, ±4 of 24 segments about
each flank line, sin 60° = 0.866 of the hull's height — the sheet's ~0.88,
crowns and heels buried) are split into their own meshes for the bar colour,
the way the eel's belly strip is. Their custom normals are the SMOOTH hull's
(`build_hull` L676 passes `smooth_normal` for every vertex), so the bump is
a silhouette fact (top view) and not a shading fact (side view) — a marking.
The width profile is a plateau over the whole front bar (t 0.24–0.40; the
bar's five rings at t 0.255–0.387), so the front bar's shape is the bump
alone and the flank vertex is `MAX_HALF_WIDTH + BAR_PROUD` with the normal
exactly +z there (`smooth_normal` L381 docstring; measured off by 0.0000000).

First build had a stepped "lens" colour footprint (outer ring bands one
segment shorter); from the play camera it read as notches, so the shipped
build paints a plain band (constant `BAR_ARC_SEGMENTS = 4`, L126; the
comment at L54–L56 records the change).

## Verified claims (file:line, executed code, this session)

- `installSpeciesAsset` resolves every declared joint by name
  (`assetSpecies.ts:240-243`, `asset.node(joint)` throws; `asset.node` is
  `scene.getObjectByName` at `rigAsset.ts:172`). It measures the four
  anchors against the scene `Box3` extremes (L245–L254), checks `flank`
  against the z extent as an upper bound (L256–L264) and asserts the five
  envelope fields (L267–L271) with `ENVELOPE_TOLERANCE_WORLD_UNITS = 0.01`
  (L184), AT REST (`updateMatrixWorld(true)` L226, before any `animate`).
- `rigAsset.ts:126-132` rejects a mesh with several materials — hence the
  bars are four separate meshes, not a second material on the hull.
- Surface merging: `rigSkin.ts:111` `materialSignature` omits colour and
  keys on type/roughness/metalness etc.; four colours at one roughness bake
  to ONE surface, measured below (`surfaces: 1`). `index.ts:299` counts the
  angelfish among `SINGLE_SURFACE_SPECIES = 8`; unchanged and still true.
- `placement.ts:215-221` (`SWIM_PROFILES.angelfish`) and `placement.ts:336`
  (`BODY_COLUMNS.angelfish`) read `ANGELFISH_ENVELOPE` only. Unchanged.
- `index.ts:341-344` loops `SPECIES_ASSETS` with `loadRigAsset(url, null)`;
  `client/src/previewSpecies.ts:131-132` the same list, and imports
  `buildAngelfish` (L46, name unchanged). Nothing else to wire.
- `ANGELFISH_TAIL_HZ` / `ANGELFISH_TAIL_SWING_RADIANS`: grep across
  `plugins/` and `client/` finds no importer outside angelfish.ts; the
  exports are kept as the sheet asks.
- The old `leftPectoral` was the `sign = +1` hinge at `+Z`
  (`.old-angelfish.ts:215-217`: `sign = i === 0 ? 1 : -1`,
  `hinge.position.set(…, sign * pectoralSeatZ)`; `pectorals[0]` = sign 1 =
  `leftPectoral` at L226, driven `+0.55 + flutter` at L234) — starboard by
  the −Z-is-port rule (`assetSpecies.ts:145-147`).
  `angelfish.ts:164-165` carries the sign mapping.
- Old model's dorsal/anal roots were flat lines at the seat height of one
  station (`.old-angelfish.ts:201-202`, `pool.part(dorsal, fin, DORSAL_X,
  dorsalSeatY, 0)`), so their rear ends (x ≈ −0.22, y ≈ 0.089) floated
  above a hull ~0.03 tall there. The new roots follow the back
  (`dorsal()` L766 samples `hull_top(x) - FIN_SEAT_BITE` at 7 stations).

## Envelope: measured vs declared, and old vs new

One envelope (crown and belly are rigid fins, static at rest; the pectorals
are rolled to their dihedral every frame and are not extremes — flat in the
file they reach 0.1243, the upper-bound case `assetSpecies.ts:256-264`
allows).

| field | declared | Blender (pre-export, `check_envelope`) | Node anchor / bounds | off by |
|-------|---------:|---------------------------------------:|---------------------:|-------:|
| nose x | +0.25 | +0.250000 | anchor (0.2500, 0, 0); bounds x max 0.2500 | 0.0000000 |
| tail_tip x | −0.38 | −0.380000 | anchor (−0.3800, 0, 0); x min −0.3800 | 0.0000000 |
| crown y | +0.3287741112302734 | +0.328774 | anchor (−0.1400, 0.3288, 0); y max 0.3288 | 0.0000000 |
| belly y | −0.3152764129638672 | −0.315276 | anchor (−0.1300, −0.3153, 0); y min −0.3153 | 0.0000000 |
| flank z | +0.085 | +0.085000 | anchor (0.0800, 0, 0.0850); front bar face 0.0850 at x 0.0800; model z extent 0.1243 (flat pectorals) | 0.0000000 |
| length / halfLength | 0.63 / 0.315 | 0.6300 / 0.3150 | size.x 0.630 | — |

Hull back tops out at +0.1820 (0.1468 under the crown), belly line −0.1820
(0.1333 above the belly); body widest 0.0700 at x 0.115 (plateau); rear bar
0.0668 at x −0.103.

Proof of invariance, `plugins/wildlife/.envelope-diff.mts` (uncommitted;
imports HEAD's file as `.old-angelfish.ts` from `git show HEAD:`, `Object.is`):

```
old ANGELFISH_ENVELOPE: {"length":0.63,"halfLength":0.315,"halfWidth":0.085,"crownY":0.3287741112302734,"bellyY":-0.3152764129638672}
new ANGELFISH_ENVELOPE: {"length":0.63,"halfLength":0.315,"halfWidth":0.085,"crownY":0.3287741112302734,"bellyY":-0.3152764129638672}
  length     old=0.63 new=0.63 IDENTICAL
  halfLength old=0.315 new=0.315 IDENTICAL
  halfWidth  old=0.085 new=0.085 IDENTICAL
  crownY     old=0.3287741112302734 new=0.3287741112302734 IDENTICAL
  bellyY     old=-0.3152764129638672 new=-0.3152764129638672 IDENTICAL
SWIM_PROFILES.angelfish: {"depthFraction":0.3,"minClearance":0.4352764129638672,"minSubmergence":0.4487741112302734,"halfLength":0.315,"halfWidth":0.085}
BODY_COLUMNS.angelfish : {"bellyY":-0.3152764129638672,"crownY":0.3287741112302734}
ALL FIVE IDENTICAL
```

`length`/`halfLength` keep the old expression shape (`NOSE_X + -PEDUNCLE_X +
CAUDAL_REACH`, `PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2`, `NOSE_X`
0.25 where the old file wrote the literal); crownY/bellyY are the
full-precision literals of the old derivations (`angelfish.ts:104-119`),
which JS parses back to the same doubles (printed above from the hull
lines, scratch `.angel-hull.mts`: crownY 0.3287741112302734, bellyY
−0.3152764129638672).

## Blender build log (shipped build)

```
angelfish build:
  hull: 26 rings x 24 segments
  winding hull: 648 faces, 0 inward
  bars:
    bar 0 at x +0.080: centre flank z +0.085000 / -0.085000, 0.0150 proud of the hull; rim rings off the smooth hull by 0.00e+00; 64 faces
    bar 1 at x -0.100: centre flank z +0.066800 / -0.066800, 0.0147 proud of the hull; rim rings off the smooth hull by 0.00e+00; 64 faces
  winding eye_port: 40 faces, 0 inward
  winding eye_starboard: 40 faces, 0 inward
  attachment (vertices strictly inside the hull):
    dorsal 14/44 inside   anal 14/44   caudal 10/64   pectoral_port 4/22   pectoral_starboard 4/22
    eye_port 23/34   eye_starboard 23/34   mouth 14/21
  envelope (measured vs declared): nose/tail_tip/crown/belly/flank all off by 0.0000000
    hull back tops out at +0.1820, 0.1468 under the crown; belly line -0.1820, 0.1333 above the belly
    widest thing on the model 0.1243 (the flat pectorals; flank is the front bar's face, the upper-bound case the install allows)
    length 0.6300, halfLength 0.3150
angelfish -> angelfish.glb: 1786 tris total
```

## As exported (`stat_glb.py`, fresh import of the committed file)

```
bbox world units: x=0.630 y=0.644 z=0.249  min-y=-0.315  centre-xz=(-0.065, 0.000)
meshes: 13
  body 992 tris parent=rig   bar_front_port/starboard 64 each parent=rig   bar_rear_port/starboard 64 each parent=rig
  dorsal 84 parent=rig   anal 84 parent=rig   caudal 124 parent=tail
  pectoral_port_blade 40 parent=pectoral_port   pectoral_starboard_blade 40 parent=pectoral_starboard
  eye_port/eye_starboard 64 each parent=rig   mouth 38 parent=rig
total: 1786 tris
materials: 4 (angelfish_bar, angelfish_body, angelfish_eye, angelfish_fin), all metallic=0.00 roughness=0.50; images: 0
empties: 9
  rig (0,0,0) parent=(none)   tail (-0.250, 0, 0) parent=rig
  pectoral_port (0.000, -0.040, -0.054) parent=rig   pectoral_starboard (0.000, -0.040, 0.054) parent=rig
  nose (0.250, 0, 0)  tail_tip (-0.380, 0, 0)  crown (-0.140, 0.329, 0)  belly (-0.130, -0.315, 0)  flank (0.080, 0, 0.085)  — all parent=(none)
armatures: 0   skinned meshes: 0
```

## `.verify-angelfish-asset.mts` (uncommitted; from the main checkout's `.verify-eel-asset.mts`, parameterised, chain checks replaced by bar checks)

`node --experimental-strip-types .verify-angelfish-asset.mts --old`:

```
installSpeciesAsset: accepted angelfish.glb
GLB angelfish:
  surfaces: 1
  joints:   23
  triangles:1786
  materials: MeshStandardMaterial
  joints resolved: rig, tail, pectoral_port, pectoral_starboard
    tail                parent=rig at (-0.2500, 0.0000, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    pectoral_port       parent=rig at (0.0000, -0.0400, -0.0543) rotation (0.0000, 0.0000, 0.0000)
    pectoral_starboard  parent=rig at (0.0000, -0.0400, 0.0543) rotation (0.0000, 0.0000, 0.0000)
  bounds x[-0.3800, 0.2500] y[-0.3153, 0.3288] z[-0.1243, 0.1243] size 0.630
  declared ANGELFISH_ENVELOPE (asserted at install): {"length":0.63,"halfLength":0.315,"halfWidth":0.085,"crownY":0.3287741112302734,"bellyY":-0.3152764129638672}
    nose      (0.2500, 0.0000, 0.0000)
    tail_tip  (-0.3800, 0.0000, 0.0000)
    crown     (-0.1400, 0.3288, 0.0000)
    belly     (-0.1300, -0.3153, 0.0000)
    flank     (0.0800, 0.0000, 0.0850)
  body                 widest |z| 0.0700 at x 0.1150
  bar_front_starboard  widest |z| 0.0850 at x 0.0800
  bar_front_port       widest |z| 0.0850 at x 0.0800
  bar_rear_starboard   widest |z| 0.0668 at x -0.1032
  bar_rear_port        widest |z| 0.0668 at x -0.1032
  front bar face == flank anchor (0.085000) within 1e-6
disposed blueprint then asset
procedural angelfish (HEAD):
  surfaces: 1
  joints:   15
  triangles:2056
  materials: MeshLambertMaterial
  bounds x[-0.3851, 0.2931] y[-0.3220, 0.3354] z[-0.1139, 0.1139]
```

(`joints` is `RigBlueprint.jointCount` — every node in the tree — not the
four driven joints.) The procedural angelfish overshot its own envelope in
every axis (nose +0.043 from bevelled bar slabs, y ±0.007); the asset
measures exactly. Hinges rest at identity.

### Draw budget

| | surfaces | joints (bakeRig nodes) | triangles | material |
|--|--:|--:|--:|--|
| procedural angelfish (HEAD) | 1 | 15 | 2056 | MeshLambertMaterial |
| angelfish.glb | 1 | 23 | 1786 | MeshStandardMaterial |

Budget ≤ ~2500: met at 1786 (hull 992 + bars 256 + fins 372 + eyes 128 +
mouth 38). `SINGLE_SURFACE_SPECIES` in `index.ts:299` stays 8.

## Renders (uncommitted, `tools/blender/out/`)

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ac47f3cb7e3bbdbb7/tools/blender/out/angelfish_iso.png`
  — from the play angle a golden disc with two clean near-black bands on the
  flank (no notch, no edge, no ridge shading), the sail dorsal sweeping up
  and back, the anal fin below, a flat pectoral stub, the eye ahead of the
  front bar, and the small fork behind.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ac47f3cb7e3bbdbb7/tools/blender/out/angelfish_side.png`
  — the Pterophyllum silhouette: a tall disc, the long triangular dorsal
  rising to its tip aft of the middle and the matching anal fin below, the
  two bars reading as painted vertical markings on the flank (crowns and
  heels buried, no plate edge), the eye, a pectoral edge-on, the forked
  caudal on a narrow peduncle.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ac47f3cb7e3bbdbb7/tools/blender/out/angelfish_front.png`
  — a thin upright ellipse with the dorsal and anal blades as hairlines
  above and below, the flat pectorals standing out either side (their
  dihedral is animation), the eyes at the head's sides, the dark bar faces
  just visible at the flanks, and the mouth line as a small underslung arc.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ac47f3cb7e3bbdbb7/tools/blender/out/angelfish_top.png`
  — a narrow planform, the two bars as dark lens-section bulges at the
  flanks (the front pair widest — the flank anchor), the flat pectorals as
  two leaves, the dorsal a bright line down the back, the caudal edge-on
  behind the peduncle.

The first build's stepped bar footprint was rendered, judged (notches from
the play camera) and replaced; the four shots above are the shipped build.

## `whaleHull.ts` / `bodyKit.ts` remaining users (imports, not comments)

- `../whaleHull.ts`: `species/bison.ts:28`, `species/ibex.ts:16`,
  `client/whaleSpecies.ts:28`.
- `./bodyKit.ts`: `species/bison.ts:29`, `species/ibex.ts:17`,
  `species/quadruped.ts:13`.

Nothing deleted. `sweptHull`, `profileFromPoints`, `uprightFin`, `flatFin`,
`smoothEllipsoid` all keep other importers. `ray.ts:9-10` still names
"eel and angelfish" as bodyKit users — outside this sheet's extra
deliverable (fish.ts and shark.ts only); one-line follow-up.

## Verification runs

- `pnpm install --frozen-lockfile`: "Done in 54.2s"; `git status
  pnpm-lock.yaml` clean.
- `pnpm typecheck` (root): every package `Done`, exit 0, no errors.
- Wildlife tests per file, `timeout 240 npx vitest run <file>` from
  `plugins/wildlife`: `assetSpecies.test.ts` 4 passed; `client.test.ts` 18
  passed; `gradient.test.ts` 6 passed; `session-lifecycle.test.ts` 3 passed;
  `wildlife.test.ts --hookTimeout 120000` 17 passed (27.79 s). No assertion
  encoded the procedural angelfish (the `angelfish: 26` population row in
  `wildlife.test.ts:317` is a server-side target, untouched); no test
  changed, none added.
- Blender build log, `stat_glb.py`, `.verify-angelfish-asset.mts --old`,
  `.envelope-diff.mts`: above. Logs in `tools/blender/out/angelfish_*.log`.

## Left undone, and why

- `ray.ts` header's stale "eel and angelfish" — not in this sheet's commit
  list (fish.ts and shark.ts only); one line for the next pass.
- The bars do not continue into the dorsal and anal fins as a real
  angelfish's do: the fins are single n-gon-capped blades and a colour
  split would mean splitting each blade; the sheet asks for bars on the
  flanks and the flank contract is what the bars exist for.
- Uncommitted scratch, left in the worktree as the brief asks:
  `plugins/wildlife/.verify-angelfish-asset.mts`,
  `plugins/wildlife/.envelope-diff.mts`, `plugins/wildlife/.angel-hull.mts`,
  `plugins/wildlife/client/species/.old-angelfish.ts`,
  `tools/blender/out/angelfish_*.png`, `tools/blender/out/angelfish_*.log`,
  `tools/blender/out/blender.sh`.

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ac47f3cb7e3bbdbb7`
Branch: `worktree-agent-ac47f3cb7e3bbdbb7`
Code commit: `7aa6492`; final commit (this report): see `git log -1`.
