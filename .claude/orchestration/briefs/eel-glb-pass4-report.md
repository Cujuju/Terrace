# Report: fish+whales → Blender pass 4 — the eel (model-only, a spine chain)

Brief: `.claude/orchestration/briefs/eel-glb-pass4.md`. Worktree branch
`worktree-agent-a1bc8c7e3153c01ce`; nothing merged, nothing pushed, the app
was never started, no test added or changed.

## What landed (commit 32307ca)

| file | what |
|------|------|
| `tools/blender/build_eel.py` (new, 1200 lines) | Constants with reasons (L80–L275); `monotone_profile` L288 (Fritsch–Butland, no overshoot: the plateau IS the maximum); the two-half-ellipse section `surface_point` L374 and analytic `surface_normal` L386; `slice_stations` L650 / `build_slice` L682 (one profile, one `RING_STEP` grid, integer-indexed so shared stations are identical floats — `grid_stations` L637); custom split normals L503; `ridge_piece` L776, `paddle` L824, `pectoral_blade` L854, `mouth` L867; the checks `check_outward` L453, `check_seams` L971 (rest identity + posed overlap), `check_attachment` L943 (parity, OR-ed over capped slices), `check_envelope` L1023 (extremes to 1e-9); the chain of Empties and anchors in `main` L1072–L1184; export via `export_glb.py`. |
| `plugins/wildlife/client/assets/eel.glb` (new, 71,428 bytes) | 18 meshes, 4 materials, 14 Empties, 2478 tris. |
| `plugins/wildlife/client/species/eel.ts` (rewritten, 177 lines) | `EEL_ENVELOPE` L117 (crownY = `RIDGE_CROWN_Y` literal L105 with its derivation), `EEL_JOINTS` L137, `EEL_ASSET` L149, `buildEel = assetSpeciesBuilder(EEL_ASSET, …)` L156; the spine loop L160–L163, tail L164, rig sway L166, the port/starboard derivation and assignments L167–L176. |
| `plugins/wildlife/client/species/assets.ts` | `import { EEL_ASSET }` L22, `eelUrl` L23, the one row L37; header list gains "eel". |
| `docs/model-assets.md` | One sentence (a short paragraph) at L218–L221 on the nested-chain convention, after the ray's two-envelope paragraph. |

Not touched: `assetSpecies.ts`, `placement.ts`, `index.ts`, `previewSpecies.ts`,
`whaleHull.ts`, `bodyKit.ts`, any test.

## Verified claims (file:line, executed code)

- `installSpeciesAsset` resolves every declared joint by name
  (`assetSpecies.ts:237-240`, `asset.node(joint)` throws); `asset.node` is
  `scene.getObjectByName(name)` (`client/src/render/rigAsset.ts:172`), which
  searches the whole tree — nested joints resolve. It measures the four anchors
  against the scene's `Box3` extremes (L242–L251), checks `flank` against
  `halfWidth` and the z extent (L253–L261, L268), and asserts the five envelope
  fields (L264–L268) with `ENVELOPE_TOLERANCE_CELLS = 0.01` (L181), AT REST
  (`updateMatrixWorld(true)` L223, before any `animate`).
- `rigAsset.ts:127-132` rejects a mesh with several materials — hence the belly
  is a separate `belly{i}` mesh per slice, not a second material on the hull.
- **The chain composes.** `bakeRig` (`client/src/render/rigSkin.ts:260-271`)
  records each node's parent index into `bones` and recurses into children;
  `instantiateRig` (L385–L399) creates a `Bone` per descriptor and
  `joints[descriptor.parent].add(bone)`, so a child Bone's local rotation
  composes onto its parent's. Every mesh is bound rigidly to ITS OWN node
  (`bindRigidly(piece, joint)` at L296, where `joint = indexOf.get(node)`), and
  the mesh's node is itself a bone whose parent chain runs
  mesh → spine4 → spine3 → … → rig, so a slice under spine4 follows the whole
  chain. This is exactly what the procedural eel relied on with nested Groups
  (`.old-eel.ts:203-215`).
- `placement.ts:208-213` (`SWIM_PROFILES.eel`) and `placement.ts:335`
  (`BODY_COLUMNS.eel`) read `EEL_ENVELOPE` only. Unchanged.
- `index.ts:341` loops `SPECIES_ASSETS`; `client/src/previewSpecies.ts` imports
  `buildEel` (L45) and the same list. Nothing else to wire.
- Surface merging: `rigSkin.ts:111` `materialSignature` omits colour and keys
  on roughness/metalness; four colours at one roughness bake to ONE surface,
  measured below (`surfaces: 1`). `index.ts:299` counts the eel among
  `SINGLE_SURFACE_SPECIES = 8`; unchanged and still true.
- `tubeSlice` and the two hull profile arrays were used only by `eel.ts`
  (`grep tubeSlice plugins/wildlife/client` → only the old eel.ts); they went
  with the body. `profileFromPoints` stays in `whaleHull.ts` for its other users.
- The old `leftPectoral` was the `sign = +1` hinge at `+Z`
  (`.old-eel.ts:284-297`: `hinge.position.set(…, sign * pectoralSeatZ)`,
  `pectorals[0]` = sign 1 = `leftPectoral` at L304) — starboard by the −Z-is-port
  rule (`assetSpecies.ts:145-147`). `eel.ts:175-176` carries the sign mapping
  (`pectoral_starboard = +0.5 + flutter`, `pectoral_port = −0.5 − flutter`).

## Envelope: measured vs declared, and old vs new

One envelope (the eel's extremes are static at rest; a bent eel is shorter than
a straight one — `eel.ts:41-47`).

| field | declared | Blender (pre-export, `check_envelope`) | Node anchor / bounds | off by |
|-------|---------:|---------------------------------------:|---------------------:|-------:|
| nose x | +0.595 | +0.595000 | anchor (0.5950, 0, 0); bounds x max 0.5950 | 0.0000000 |
| tail_tip x | −0.695 | −0.695000 | anchor (−0.6950, 0, 0); x min −0.6950 | 0.0000000 |
| crown y | +0.07064932759133065 | +0.070649 | anchor (−0.3000, 0.0706, 0); y max 0.0706 | 0.0000000 |
| belly y | −0.08625 | −0.086250 | anchor (0.2500, −0.0862, 0); y min −0.0862 | 0.0000000 |
| flank z | +0.075 | +0.075000 | anchor (0.2500, 0, 0.0750); body z 0.075, model z extent 0.1142 (flat pectorals; upper bound only, the fish's case) | 0.0000000 |
| length / halfLength | 1.29 / 0.645 | 1.2900 / 0.6450 | size.x 1.290 | — |

The build's `ANCHOR_TOLERANCE` is 1e-9 (`build_eel.py:267`), not the install's
0.01: a build has no float32 round trip to absorb. It caught the first
build's paddle, whose 0.075 half-span overtopped the crest by 0.0044 — within
the install tolerance, so the file would have loaded with the crown anchor NOT
at the true y max. `PADDLE_HALF_SPAN` is now 0.06 (L197). Two things the
procedural eel did that its envelope never said: its hull top reached +0.0875
(> crownY 0.0706) and its paddle ±0.075; the old bounds below show it
(y ±0.0920). The file honours the declaration: the back tops out at +0.0615,
0.0091 under the crest (`UPPER_RATIO_PROFILE` L149 — the section is two half-
ellipses, the belly hanging 1.15× the half-width and the back rising 0.80×).

Proof of invariance, `plugins/wildlife/.envelope-diff.mts` (uncommitted;
imports HEAD's file as `.old-eel.ts` from `git show HEAD:`, `Object.is`):

```
old EEL_ENVELOPE: {"length":1.29,"halfLength":0.645,"halfWidth":0.075,"crownY":0.07064932759133065,"bellyY":-0.08625}
new EEL_ENVELOPE: {"length":1.29,"halfLength":0.645,"halfWidth":0.075,"crownY":0.07064932759133065,"bellyY":-0.08625}
  length     old=1.29 new=1.29 IDENTICAL
  halfLength old=0.645 new=0.645 IDENTICAL
  halfWidth  old=0.075 new=0.075 IDENTICAL
  crownY     old=0.07064932759133065 new=0.07064932759133065 IDENTICAL
  bellyY     old=-0.08625 new=-0.08625 IDENTICAL
SWIM_PROFILES.eel: {"depthFraction":0.8,"minClearance":0.20625,"minSubmergence":0.19064932759133063,"halfLength":0.645,"halfWidth":0.075}
BODY_COLUMNS.eel : {"bellyY":-0.08625,"crownY":0.07064932759133065}
ALL FIVE IDENTICAL
```

`length`/`halfLength` keep the old expression shape (`NOSE_X + -PEDUNCLE_X +
PADDLE_REACH` with `PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2`), so the
same doubles come out; crownY is the full-precision literal of the old
derivation (`eel.ts:97-105`), which JS parses back to the same double.

## The chain as exported (`stat_glb.py`, fresh import of the committed file)

```
bbox world units: x=1.290 y=0.157 z=0.228  min-y=-0.086  centre-xz=(-0.050, 0.000)
meshes: 18
  slice0 372 tris parent=spine0   belly0 124 parent=spine0   eye_port/eye_starboard 64 each parent=spine0
  mouth 38 parent=spine0          pectoral_port_blade 40 parent=pectoral_port
  pectoral_starboard_blade 40 parent=pectoral_starboard
  slice1 288 parent=spine1        belly1 96 parent=spine1
  slice2 288 parent=spine2        belly2 96 parent=spine2
  slice3 264 parent=spine3        belly3 88 parent=spine3    ridge_a 84 parent=spine3
  slice4 276 parent=spine4        belly4 92 parent=spine4    ridge_b 68 parent=spine4
  paddle 96 parent=tail
total: 2478 tris
materials: 4 (eel_belly, eel_body, eel_eye, eel_fin), all metallic=0.00 roughness=0.50; images: 0
empties: 14
  rig (0.000, 0.000, -0.000)  parent=(none)
  spine0 (0.526, 0, 0)  parent=rig
  spine1 (0.296, 0, 0)  parent=spine0
  spine2 (0.066, 0, 0)  parent=spine1
  spine3 (-0.164, 0, 0) parent=spine2
  spine4 (-0.371, 0, 0) parent=spine3
  tail (-0.555, 0, 0)   parent=spine4
  pectoral_port (0.400, -0.030, -0.059) parent=spine0
  pectoral_starboard (0.400, -0.030, 0.059) parent=spine0
  nose (0.595, 0, 0)  tail_tip (-0.695, 0, 0)  crown (-0.300, 0.071, 0)
  belly (0.250, -0.086, 0)  flank (0.250, 0, 0.075)   — all parent=(none)
armatures: 0   skinned meshes: 0
```

(stat_glb prints world positions; the file's node translations are the
parent-relative differences.) three sees the same nesting
(`.verify-eel-asset.mts`): `spine0<-rig spine1<-spine0 spine2<-spine1
spine3<-spine2 spine4<-spine3 tail<-spine4`.

## Slices, seams, and the overlap at max bend

Design (`build_eel.py:38-54`, `slice_stations` L650): slice *i* owns the body
from its own hinge back to the next hinge, plus a `SLICE_OVERLAP = 0.04` (0.046
cells) extension FORWARD of its hinge whose rings are sunk `RIM_SINK = 0.015`
under the slice ahead. The visible seam is therefore AT the hinge, where a yaw
displaces nothing, and the sunk extension is what fills the crescent the bend
opens on the inside. Rings sample one profile on one `RING_STEP = 0.02` grid
(integer-indexed, `grid_stations` L637), so a rear rim and the next hinge ring
are the SAME floats — asserted — and the analytic normals are written as
custom split normals (L503) so the shading is continuous too.

Blender build log (final run):

```
eel build:
  winding slice0: 256 faces, 0 inward   slice1: 192, 0   slice2: 192, 0   slice3: 176, 0   slice4: 192, 0
  seams:
    spine0/spine1 at 0.09 rad: rest rim identical; 32 extension vertices, 0 outside the slice ahead; min radial margin +0.0111; hinge-ring lip 0.0000
    spine1/spine2 at 0.13 rad: rest rim identical; 32 extension vertices, 0 outside the slice ahead; min radial margin +0.0094; hinge-ring lip 0.0000
    spine2/spine3 at 0.17 rad: rest rim identical; 32 extension vertices, 0 outside the slice ahead; min radial margin +0.0071; hinge-ring lip 0.0003
    spine3/spine4 at 0.21 rad: rest rim identical; 32 extension vertices, 0 outside the slice ahead; min radial margin +0.0052; hinge-ring lip 0.0002
    minimum slice overlap at max bend 0.0052 (RIM_SINK 0.015); worst hinge-ring lip 0.0003
  ridge: crest 0.070649 at x -0.3, 0.0269 proud of the back (0.0438); runs x -0.164 -> -0.509, seam at -0.371
  winding eye_port: 40 faces, 0 inward   eye_starboard: 40, 0
  attachment (vertices strictly inside the hull slices):
    ridge_a 22/44 inside   ridge_b 18/36   paddle 4/50   pectoral_port 6/22   pectoral_starboard 6/22
    eye_port 19/34   eye_starboard 19/34   mouth 14/21
  envelope (measured vs declared): nose/tail_tip/crown/belly/flank all off by 0.0000000
    hull back tops out at +0.0615, 0.0091 under the crest
    widest thing on the model 0.1142 (the flat pectorals; flank is the BODY, as for the fish)
    length 1.2900, halfLength 0.6450
eel -> eel.glb: 2478 tris total
```

**Minimum slice overlap at max bend: 0.0052 cells** (seam spine3/spine4 at
0.21 rad; the extension's front rim swings 0.046·sin 0.21 = 0.0096 out of its
0.015 sink). Both yaw signs are tested (`check_seams` L971–L1013); every
extension vertex passes the parity test against the slice ahead's capped
shell, and the tilted hinge ring stands proud by at most 0.0003 (a taper
effect, under `LIP_TOLERANCE = 0.002`). The relative bend at a seam depends
only on that seam's own joint, so testing each joint at its own amplitude IS
the worst case.

`render_glb.py` cannot pose a chain, so the posed render was replaced by two
Node-side checks in `.verify-eel-asset.mts` on the exported file: (a) 72
rim/hinge vertex pairs coincide across the four seams with a worst normal
disagreement of 1.73e-4 rad (the custom normals survived the export); (b) with
every spine yawed to its amplitude through the real `authored.joints` (the
composed pose), the per-slice `Box3` x-overlap is at least 0.0598 — the
extension never leaves its neighbour's span. The geometric proof is the
Blender one above.

The dorsal ridge is two pieces meeting AT spine4's hinge (`ridge_stations`
L809), not two overlapping halves: a seam at a hinge opens a wedge of
0.012·sin 0.21 = 0.0025 at most and no gap. The paddle root is buried in the
stem's cap (4/50 vertices inside; `PADDLE_ROOT_A` 0.03 forward of the hinge).

## `.verify-eel-asset.mts` (uncommitted; from the main checkout's `.verify-ray-asset.mts`, parameterised)

`node --experimental-strip-types .verify-eel-asset.mts --old`:

```
installSpeciesAsset: accepted eel.glb
GLB eel:
  surfaces: 1
  joints:   33
  triangles:2478
  materials: MeshStandardMaterial
  joints resolved: rig, spine0, spine1, spine2, spine3, spine4, tail, pectoral_port, pectoral_starboard
  chain: spine0<-rig spine1<-spine0 spine2<-spine1 spine3<-spine2 spine4<-spine3 tail<-spine4
  bounds x[-0.6950, 0.5950] y[-0.0862, 0.0706] z[-0.1142, 0.1142] size 1.290
  declared EEL_ENVELOPE (asserted at install): {"length":1.29,"halfLength":0.645,"halfWidth":0.075,"crownY":0.07064932759133065,"bellyY":-0.08625}
    nose      (0.5950, 0.0000, 0.0000)
    tail_tip  (-0.6950, 0.0000, 0.0000)
    crown     (-0.3000, 0.0706, 0.0000)
    belly     (0.2500, -0.0862, 0.0000)
    flank     (0.2500, 0.0000, 0.0750)
  seams: 72 rim/hinge vertex pairs coincide; worst normal disagreement 1.73e-4 rad
  posed at max amplitudes (composed): min slice Box3 x-overlap 0.0598 (extension is 0.046)
disposed blueprint then asset
procedural eel (HEAD):
  surfaces: 1
  joints:   27
  triangles:2236
  materials: MeshLambertMaterial
  bounds x[-0.7098, 0.6198] y[-0.0920, 0.0920] z[-0.1101, 0.1101]
```

(`joints` is `RigBlueprint.jointCount` — every node in the tree — not the nine
driven joints.) The procedural eel overshot its own envelope in every axis
(x +0.025/−0.015, y ±0.021); the asset measures exactly.

### Draw budget

| | surfaces | joints (bakeRig nodes) | triangles | material |
|--|--:|--:|--:|--|
| procedural eel (HEAD) | 1 | 27 | 2236 | MeshLambertMaterial |
| eel.glb | 1 | 33 | 2478 | MeshStandardMaterial |

Budget ≤ ~3000: met at 2478 (hull 1488 + belly strips 496 + fins/eyes/mouth
494). `SINGLE_SURFACE_SPECIES` in `index.ts:299` stays 8.

## Renders (uncommitted, `tools/blender/out/`)

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a1bc8c7e3153c01ce/tools/blender/out/eel_iso.png`
  — from the play angle one continuous olive tube with no seam or shading
  band at any of the four slice boundaries, the low dorsal ridge catching
  light along the rear half, tiny pectorals behind the head, the rounded
  paddle at the tail, and the pale belly just visible under the flank.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a1bc8c7e3153c01ce/tools/blender/out/eel_side.png`
  — a blunt rounded snout with an eye and the faint underslung mouth line, a
  body widest just behind the head tapering to a thin stem, the ridge rising
  to its crest at −0.30 and running low into the stem, and the fan paddle;
  the pale belly strip runs the full length.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a1bc8c7e3153c01ce/tools/blender/out/eel_front.png`
  — a near-circular section (rounder above, deeper below) with two eyes at
  the sides, the flat pectorals standing out at rest (their dihedral is
  animation), the ridge as a thin fin on top, and the belly as a pale wedge
  beneath.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a1bc8c7e3153c01ce/tools/blender/out/eel_top.png`
  — a smooth planform: blunt head, the widest station just behind the eyes,
  a long even taper, the ridge as a dark line down the rear half, and the
  paddle edge-on behind the stem.

The first build's paddle (±0.075) was rejected by the build's own exact
extreme check before anything was rendered; only the shipped build was
rendered.

## `whaleHull.ts` / `bodyKit.ts` remaining users (imports, not comments)

- `../whaleHull.ts`: `species/angelfish.ts:23`, `species/bison.ts:28`,
  `species/ibex.ts:16`, `client/whaleSpecies.ts:28`.
- `./bodyKit.ts`: `species/angelfish.ts:24`, `species/bison.ts:29`,
  `species/ibex.ts:17`, `species/quadruped.ts:13`.

Nothing deleted. `fish.ts:8`, `shark.ts:8` and `ray.ts:9` header comments still
list "eel" among the helpers' users; stale now, left alone (outside this
pass's commit list).

## Verification runs

- `pnpm install --frozen-lockfile`: "Done in 1m 3.9s"; `git status
  pnpm-lock.yaml` clean.
- `pnpm typecheck` (root): every package `Done`, no errors (wildlife and
  server last).
- Wildlife tests per file, `timeout <n> npx vitest run <file>` from
  `plugins/wildlife`: `wildlife.test.ts --hookTimeout 120000` 17 passed
  (26.97 s); `assetSpecies.test.ts` 4 passed; `client.test.ts` 18 passed;
  `gradient.test.ts` 6 passed; `session-lifecycle.test.ts` 3 passed. No
  assertion encoded the procedural eel (the `eel: 13` population row in
  `wildlife.test.ts:316` is a server-side target, untouched); no test changed,
  none added. One earlier run of `wildlife.test.ts` while another vitest
  process was competing for the machine reported 1 failure (16 passed) in a
  payload-timing test; two clean reruns alone passed 17/17 and
  `assetSpecies.test.ts` was killed (exit 137) once for the same reason
  before passing alone. Not a code failure.
- Blender build log, `stat_glb.py`, `.verify-eel-asset.mts --old`,
  `.envelope-diff.mts`: above.

## Left undone, and why

- A posed render: `render_glb.py` takes no pose; the Blender-side geometric
  check and the Node-side composed-pose check stand in (see above). Adding a
  `--pose` flag to render_glb.py was outside the commit list.
- Stale "eel" mentions in `fish.ts` / `shark.ts` / `ray.ts` header comments
  — outside the commit list; one-line follow-up.
- Uncommitted scratch, left in the worktree as the brief asks:
  `plugins/wildlife/.verify-eel-asset.mts`, `plugins/wildlife/.envelope-diff.mts`,
  `plugins/wildlife/client/species/.old-eel.ts`, `tools/blender/out/eel_*.png`,
  `tools/blender/out/eel_build.log`, `eel_stat.log`, `blender.sh`, `bltest.py`,
  test logs.

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a1bc8c7e3153c01ce`
Branch: `worktree-agent-a1bc8c7e3153c01ce`
Code commit: `32307ca`; final commit (this report): see `git log -1`.
