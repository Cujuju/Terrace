# Report: fish+whales → Blender pass 3 — the ray (model-only, two envelopes)

Brief: `.claude/orchestration/briefs/ray-glb-pass3.md`. Worktree branch
`worktree-agent-a99c84fd5e2ad4412`; nothing merged, nothing pushed, the app
was never started.

## What landed (commit 2be291c)

| file | what |
|------|------|
| `tools/blender/build_ray.py` (new, 1102 lines) | The build: constants with reasons (L86–L285), `bl()` frame (L295), lens disc sweep (`build_disc` L608, `surface_point` L356 with `lens_height` L351), the wing grid with the tangent blend (`wing_grid` L666; blend law at `WING_BLADE_ROOT_HALF_THICKNESS` L154–L174), lobes (`lobe_blade` L773), whip (L787), ridges (L825), the checks (`check_outward` L403, `check_sheet_normals` L426, `check_attachment` L915, `check_envelope` L934), anchors (L1080–L1086), export via `export_glb.py`. |
| `plugins/wildlife/client/assets/ray.glb` (new, 78,648 bytes) | Built by the script; 19 meshes, 3 materials, 9 Empties, 3094 tris. |
| `plugins/wildlife/client/species/ray.ts` (rewritten, 162 lines) | `RAY_REST_ENVELOPE` L100, `RAY_ENVELOPE` L119 (crown/belly formula L126/L128), `RAY_JOINTS` L137, `RAY_ASSET` L143, `buildRay = assetSpeciesBuilder(RAY_ASSET, …)` L150, the sign derivation and assignments L153–L160. |
| `plugins/wildlife/client/species/assets.ts` | `import { RAY_ASSET }` L20, `rayUrl` L21, the one row L34. Header's species list gains "ray". |
| `docs/model-assets.md` | One paragraph, L208–L216, after "An envelope extreme is authored in its rest pose in the file." |

Not touched: `assetSpecies.ts`, `placement.ts`, `index.ts`, `previewSpecies.ts`,
`whaleHull.ts`, `bodyKit.ts`, any test.

## Verified claims (file:line, executed code)

- `installSpeciesAsset` resolves every declared joint by name
  (`plugins/wildlife/client/species/assetSpecies.ts:237-240`, `asset.node(joint)`
  throws), measures the four anchors against the scene's `Box3` extremes
  (L242–L251), checks `flank` against `halfWidth` and the z extent (L253–L261,
  L268), and asserts the five envelope fields (L264–L268) with
  `ENVELOPE_TOLERANCE_CELLS = 0.01` (L181). It measures `asset.scene` after
  `updateMatrixWorld(true)` (L223) — AT REST, before any `animate`. This is why
  the spec's envelope must be the rest one.
- `placement.ts:188-196` (`SWIM_PROFILES.ray`) and `placement.ts:333`
  (`BODY_COLUMNS.ray`) read `RAY_ENVELOPE` only; they never import
  `RAY_REST_ENVELOPE`. Unchanged.
- `index.ts:341-344` loops `SPECIES_ASSETS` with `loadRigAsset(url, null)` →
  `installSpeciesAsset`; `client/src/previewSpecies.ts:131-132` does the same.
  previewSpecies has no ray-specific code beyond the `ray: buildRay` builder
  row (L43, L53), identical in shape to fish (L37, L49) and shark (L44, L54).
- Surface merging: `client/src/render/rigSkin.ts:111` `materialSignature`
  omits colour and includes `shadingScalarSignature` (L175), whose
  `SHADING_SCALAR_FIELDS` (L164) begins with `roughness`, `metalness`. So three
  colours at one roughness bake to ONE surface — measured below as
  `surfaces: 1`. `index.ts:299` counts the ray among `SINGLE_SURFACE_SPECIES`.
- The old `leftWing` was at `+Z` (`git show HEAD~1:…/ray.ts` L120–L126:
  `sign * WING_ROOT_Z` with `sign = 1` for `wingHinges[0]` = `leftWing`), i.e.
  starboard by the −Z-is-port rule (`assetSpecies.ts:145-147`). The new names
  say which side is which.

## Two envelopes

### REST — `RAY_REST_ENVELOPE` (`ray.ts:100`), what `ray.glb` measures

Declared from named constants: `RAY_NOSE_X = 0.33`, `RAY_TAIL_TIP_X = -0.76`,
`WING_REACH = WING_ROOT_Z + WING_SPAN = 0.59`, `MAX_HALF_HEIGHT = 0.05`,
`EYE_DOME_ABOVE_DISC = 0.012`. Crown is an eye-dome top (the eyes sit on the
head's shoulders, `EYE_Z = 0.095`); belly is the disc's underside at a
full-height ring.

Measured in Blender (`build_ray.py` `check_envelope`, asserted) and again in
Node off the exported file (`.verify-ray-asset.mts`, `installSpeciesAsset`):

| field | declared | Blender (pre-export) | Node anchor / bounds | off by |
|-------|---------:|---------------------:|---------------------:|-------:|
| nose x | +0.3300 | +0.3300 | anchor (0.3300, −0.0100, 0.0520); bounds x max 0.3300 | 0.00000 |
| tail_tip x | −0.7600 | −0.7600 | anchor (−0.7600, 0.0300, 0.0000); x min −0.7600 | 0.00000 |
| crown y | +0.0620 | +0.0620 | anchor (0.1600, 0.0620, 0.0950); y max 0.0620 | 0.00000 |
| belly y | −0.0500 | −0.0500 | anchor (0.0974, −0.0500, 0.0000); y min −0.0500 | 0.00000 |
| flank z | +0.5900 | +0.5900 | anchor (−0.1200, 0.0000, 0.5900); z extent 0.5900 | 0.00000 |
| length / halfLength | 1.09 / 0.545 | 1.0900 / 0.5450 | size.x 1.090 | — |

`installSpeciesAsset: accepted ray.glb`.

### SWEPT — `RAY_ENVELOPE` (`ray.ts:119`), what placement reads

Written as `WING_REACH * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT` —
the same operands in the same order as HEAD's
`(WING_ROOT_Z + WING_SPAN) * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT`.
Proof, `plugins/wildlife/.envelope-diff.mts` (uncommitted; imports HEAD's file
as `.old-ray.ts` from `git show HEAD:` and the new one, compares with
`Object.is`):

```
old RAY_ENVELOPE : {"length":1.09,"halfLength":0.545,"halfWidth":0.59,"crownY":0.2243569219301903,"bellyY":-0.2243569219301903}
new RAY_ENVELOPE : {"length":1.09,"halfLength":0.545,"halfWidth":0.59,"crownY":0.2243569219301903,"bellyY":-0.2243569219301903}
RAY_REST_ENVELOPE: {"length":1.09,"halfLength":0.545,"halfWidth":0.59,"crownY":0.062,"bellyY":-0.05}
  length     old=1.09 new=1.09 IDENTICAL
  halfLength old=0.545 new=0.545 IDENTICAL
  halfWidth  old=0.59 new=0.59 IDENTICAL
  crownY     old=0.2243569219301903 new=0.2243569219301903 IDENTICAL
  bellyY     old=-0.2243569219301903 new=-0.2243569219301903 IDENTICAL
SWIM_PROFILES.ray: {"depthFraction":0.85,"minClearance":0.3443569219301903,"minSubmergence":0.3443569219301903,"halfLength":0.545,"halfWidth":0.59}
BODY_COLUMNS.ray : {"bellyY":-0.2243569219301903,"crownY":0.2243569219301903}
ALL FIVE IDENTICAL
```

`SWIM_PROFILES.ray` / `BODY_COLUMNS.ray` are pure functions of `RAY_ENVELOPE`
in an unchanged `placement.ts`, so identical inputs give identical outputs;
the values above are the post-change evaluation.

## The model

Read from above at the play camera the ray is nearly all wing; the design
problem of this pass was making a wing that is a separate hinged mesh read as
the disc's own skin. Two attempts:

1. Superellipse disc + 0.026-thick flat wing root: the wing left a 69° slope
   and read as a plate in a slot (rejected on the first render).
2. **Shipped.** The disc is a swept LENS section,
   `y = ±H·(1 − (z/W)²)^1.5` (`SECTION_EDGE_EXPONENT`, L142–L149) whose slope
   goes to zero at its edge; the wing's half-thickness is a thin BLADE
   (0.012 root → 0.002 edge/tip, half-sine in chord) PLUS a BLEND: at the hinge
   line the wing's back is set on the disc's back over that line (less
   `SEAM_SINK = 0.001`), leaves with the disc's own analytic slope
   (`disc_surface_slope` L380), and the excess decays as a parabola over the
   reach that slope needs (`wing_grid` L666–L700). The wing is therefore
   tangent to the disc where it emerges and envelopes the disc's thin edge
   beyond; the build prints the least blend excess along the root (+0.0079)
   and asserts it positive. Rows are biased to the root
   (`WING_ROW_ROOT_BIAS = 1.6`) so the blend is sampled by four rows.

Wing planform: leading root x = 0.24 on the head's shoulder, tip at
x = −0.12 / z = ±0.59, trailing root x = −0.22 near the tail hinge with a
concave trailing edge. Cephalic lobes are tapered paddles rooted in the head,
tips at x = 0.33 curled inward. Whip: 12 stations × 8, rising 0.03 to a pole
at x = −0.76. Mouth ridge and 5 transverse gill ridges per side on the
underside, in a darker line colour. Eyes are domes at the head's shoulders.
Colours `srgb(0x3F4B5A)`, `srgb(0x0F1114)`, `srgb(0x262D36)`; one roughness
0.5, metalness 0.

Hinges: `wing_port` (0.04, 0, −0.09), `wing_starboard` (0.04, 0, +0.09),
`tail` (−0.26, 0, 0), all identity rotation, each blade/whip its child with
zero local location (`stat_glb`: `parent=wing_port` etc.). `rig` at the
origin, anchors unparented.

### Blender build log (final run)

```
ray build:
  winding disc: 644 faces, 0 inward
  winding wing +off sheet: 120 sheet faces, 0 reversed
  winding wing -off sheet: 120 sheet faces, 0 reversed
  wing: blade root half-thickness 0.012; disc back over the hinge line 0.0283 at the hinge station, sloping 23.6 deg; least blend excess along the root +0.0079
  attachment (vertices strictly inside the disc):
    wing_port                42/266 inside
    wing_starboard           42/266 inside
    lobe_port                8/34 inside
    lobe_starboard           8/34 inside
    eye_port                 7/52 inside
    eye_starboard            7/52 inside
    whip                     25/98 inside
    mouth                    6/15 inside
    gill_1_port .. gill_5_starboard   10/15 inside (all ten)
  rest envelope (measured vs declared):
    nose      +0.3300 vs +0.3300  (off by 0.00000)
    tail_tip  -0.7600 vs -0.7600  (off by 0.00000)
    crown     +0.0620 vs +0.0620  (off by 0.00000)
    belly     -0.0500 vs -0.0500  (off by 0.00000)
    flank     +0.5900 vs +0.5900  (off by 0.00000)
    disc half-width 0.1600 (DISC_HALF_WIDTH 0.16); the envelope's halfWidth is the WING TIP, by placement.ts's contract
    length 1.0900, halfLength 0.5450
ray -> ...\ray.glb: 3094 tris total
```

Per mesh: disc 1232, wing blades 528 × 2, whip 192, eyes 100 × 2, lobes 64 × 2,
mouth 26, gills 26 × 10.

### `stat_glb.py` on ray.glb (fresh import of the committed file)

```
bbox world units: x=1.090 y=0.112 z=1.180  min-y=-0.050  centre-xz=(-0.215, 0.000)
meshes: 19 ... total: 3094 tris
materials: 3
  ray_body: baseColor=(0.05, 0.07, 0.10, 1.00), metallic=0.00, roughness=0.50
  ray_eye:  baseColor=(0.00, 0.01, 0.01, 1.00), metallic=0.00, roughness=0.50
  ray_line: baseColor=(0.02, 0.03, 0.04, 1.00), metallic=0.00, roughness=0.50
images: 0
empties: 9
  belly (0.097, -0.050, -0.000)   crown (0.160, 0.062, 0.095)   flank (-0.120, 0.000, 0.590)
  nose (0.330, -0.010, 0.052)     rig (0, 0, 0)                 tail (-0.260, 0, 0) parent=rig
  tail_tip (-0.760, 0.030, 0)     wing_port (0.040, 0, -0.090) parent=rig
  wing_starboard (0.040, 0, 0.090) parent=rig
armatures: 0   skinned meshes: 0
```

### `.verify-ray-asset.mts` (uncommitted; copied from the main checkout's
`.verify-shark-asset.mts` and parameterised)

`node --experimental-strip-types .verify-ray-asset.mts --old`:

```
installSpeciesAsset: accepted ray.glb
GLB ray:
  surfaces: 1
  joints:   29
  triangles:3094
  materials: MeshStandardMaterial
  joints resolved: rig, wing_port, wing_starboard, tail
  bounds x[-0.7600, 0.3300] y[-0.0500, 0.0620] z[-0.5900, 0.5900] size 1.090
  declared RAY_REST_ENVELOPE (asserted at install): {"length":1.09,"halfLength":0.545,"halfWidth":0.59,"crownY":0.062,"bellyY":-0.05}
  declared RAY_ENVELOPE (swept, placement): {"length":1.09,"halfLength":0.545,"halfWidth":0.59,"crownY":0.2243569219301903,"bellyY":-0.2243569219301903}
    nose      (0.3300, -0.0100, 0.0520)
    tail_tip  (-0.7600, 0.0300, 0.0000)
    crown     (0.1600, 0.0620, 0.0950)
    belly     (0.0974, -0.0500, 0.0000)
    flank     (-0.1200, 0.0000, 0.5900)
disposed blueprint then asset
procedural ray (HEAD):
  surfaces: 1
  joints:   13
  triangles:1324
  materials: MeshLambertMaterial
  bounds x[-0.7603, 0.3582] y[-0.0500, 0.0600] z[-0.6019, 0.6019]
```

(`joints` is `RigBlueprint.jointCount`, every node in the tree, not the four
driven joints.) Note the procedural ray's actual bounds overshot its own
declared envelope by 0.028 in x and 0.012 in z; the asset measures exactly.

### Draw budget

| | surfaces | joints (bakeRig nodes) | triangles | material |
|--|--:|--:|--:|--|
| procedural ray (HEAD) | 1 | 13 | 1324 | MeshLambertMaterial |
| ray.glb | 1 | 29 | 3094 | MeshStandardMaterial |

Budget ≤ ~3500: met at 3094. `SINGLE_SURFACE_SPECIES` in `index.ts:299`
stays 8; `attach`'s assertion is unchanged and still true.

## Renders (uncommitted, `tools/blender/out/`)

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a99c84fd5e2ad4412/tools/blender/out/ray_iso.png`
  — from the play angle the body is one continuous lens flowing into two
  swept wings with no visible seam; eyes at the shoulders, lobes forward,
  whip trailing.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a99c84fd5e2ad4412/tools/blender/out/ray_top.png`
  — an eagle-ray planform: blunt head with two lobes, swept leading edges,
  tips well aft, concave trailing edges running into the tail root, whip
  longer than the disc.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a99c84fd5e2ad4412/tools/blender/out/ray_side.png`
  — a thin lens with the eye domes proud on top, lobes at the front and the
  whip rising slightly aft; nothing below the disc's underside.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a99c84fd5e2ad4412/tools/blender/out/ray_front.png`
  — one continuous convex arc from tip to tip through the body, thinning to
  an edge at each wing tip; the lobes and gill ridges visible underneath.

The first build's renders (superellipse disc, plate-thick wing root) showed a
stepped shoulder at the wing root and were rejected before anything was
written to `ray.ts`; the tangent blend is the fix and was re-rendered.

## `whaleHull.ts` / `bodyKit.ts` remaining users (imports, not comments)

- `../whaleHull.ts`: `species/angelfish.ts:23`, `species/bison.ts:28`,
  `species/eel.ts:22`, `species/ibex.ts:16`, `client/whaleSpecies.ts:28`.
- `./bodyKit.ts`: `species/angelfish.ts:24`, `species/bison.ts:29`,
  `species/eel.ts:23`, `species/ibex.ts:17`, `species/quadruped.ts:13`.

Nothing deleted. The header comments of `fish.ts:8` and `shark.ts:8` still
list "ray" among the helpers' users; those lines are now stale but were left
alone (outside this pass's commit list).

## Verification runs

- `pnpm typecheck` (root): every package `Done`, no errors.
- Wildlife tests per file, `timeout 240 npx vitest run <file>`:
  `assetSpecies.test.ts` 4 passed; `client.test.ts` 18 passed;
  `gradient.test.ts` 6 passed; `session-lifecycle.test.ts` 3 passed;
  `wildlife.test.ts --hookTimeout 120000` 17 passed (27.85 s). No assertion
  encoded the procedural ray; no test changed, none added.
- `pnpm install --frozen-lockfile`: lockfile unchanged (`git status` shows no
  `pnpm-lock.yaml` change).

## Left undone, and why

- The stale "ray" mention in `fish.ts:8` / `shark.ts:8` header comments —
  outside the brief's commit list; one-line follow-up.
- A paler underside as a fourth material — offered as optional by the brief;
  skipped because the ray is seen from above and a fourth colour adds nothing
  the camera sees.
- During the down-stroke (wing −0.30 rad) a sliver of the disc's thin edge
  (≤ ~0.003 over |z| 0.09–0.16) rises through the wing's back; at rest and on
  the up-stroke the wing envelopes it. Inherent to a rigid hinge inside a
  lens; the procedural ray had the same with its plates. Not fixed.
- Uncommitted scratch, left in the worktree as the brief asks:
  `plugins/wildlife/.verify-ray-asset.mts`, `plugins/wildlife/.envelope-diff.mts`,
  `plugins/wildlife/client/species/.old-ray.ts`, `tools/blender/out/ray_*.png`.

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a99c84fd5e2ad4412`
Branch: `worktree-agent-a99c84fd5e2ad4412`
Code commit: `2be291c`; final commit (this report): see `git log -1`.
