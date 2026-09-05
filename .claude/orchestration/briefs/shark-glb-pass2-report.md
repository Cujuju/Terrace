# Report: fish+whales → Blender pass 2 — the shark (model-only)

Brief: `.claude/orchestration/briefs/shark-glb-pass2.md`. Every claim below was
checked against executed code at the cited file:line, in this worktree, this
session.

## What landed

| Deliverable | Where |
|---|---|
| Build script | `tools/blender/build_shark.py` (1 062 lines; every dimension a named constant with a reason; `srgb()` for all four colours; one `SURFACE_ROUGHNESS` at L290; export through `export_glb.py` at L75 rather than a copied `bpy.ops` call) |
| Asset | `plugins/wildlife/client/assets/shark.glb` — 22 meshes, 4 materials, 9 Empties, 3 202 tris |
| Species file | `plugins/wildlife/client/species/shark.ts` — `SHARK_ENVELOPE` L77–90 (nose/tail-tip stations as explicit constants L67–68), `SHARK_ASSET` L96, `buildShark = assetSpeciesBuilder(SHARK_ASSET, animate)` L103; `TAIL_HZ 1.1` / `TAIL_SWING_RADIANS 0.30` / `BODY_COUNTER_YAW_FRACTION 0.28` L55–58; `animate` sets `tail.rotation.y` and `rig.rotation.y` only |
| One asset list | `plugins/wildlife/client/species/assets.ts` (new) — `SPECIES_ASSETS` L27 with the fish and shark rows; consumed by `plugins/wildlife/client/index.ts:33,321` (`preload`) and `client/src/previewSpecies.ts:39,128` (`installAssets`) |
| Docs | `docs/model-assets.md:187–199` — the `flank` bullet now says it is the half-width the envelope DECLARES (body for the fish, pectoral tip for the shark); new paragraph: an envelope extreme is authored in its rest pose in the file |

Not changed: `assetSpecies.ts`, `placement.ts`, `SINGLE_SURFACE_SPECIES` /
`WILDLIFE_SPECIES_DRAW_OBJECTS` (`index.ts:294–296`), every other species file,
anything in `shared/`.

## Envelope: the numbers, and where they come from

Verified by evaluating the procedural shark's expressions (`git show
HEAD~2:plugins/wildlife/client/species/shark.ts` L27–29, L43, L51, L63–73):
`HULL_LENGTH/2 = 0.70`; `PEDUNCLE_X = -0.70 + 0.02 = -0.68`; `length = 0.70 +
0.68 + 0.34 = 1.72`; `halfLength = 0.86`; `crownY = 0.16 + 0.27 - 0.03 = 0.40`;
`halfWidth = 0.42` and `bellyY = -0.26` were literals. `shark.ts` now writes
`SHARK_NOSE_X = 0.70`, `SHARK_TAIL_TIP_X = -1.02`, `length = 1.72`,
`halfLength = 0.86`, `halfWidth = 0.42`, `crownY = 0.40`, `bellyY = -0.26`.
`placement.ts:197–203` and `:334` read the same object and are untouched.

### Measured in Blender (build log, `check_envelope` at `build_shark.py:858`)

```
  envelope (measured vs declared):
    nose      +0.7000 vs +0.7000  (off by 0.00000)
    tail_tip  -1.0200 vs -1.0200  (off by 0.00000)
    crown     +0.4000 vs +0.4000  (off by 0.00000)
    belly     -0.2600 vs -0.2600  (off by 0.00000)
    flank     +0.4200 vs +0.4200  (off by 0.00000)
    body half-width 0.1294 (BODY_HALF_WIDTH 0.13); the envelope's halfWidth is the PECTORAL TIP, by placement.ts's contract
    length 1.7200, halfLength 0.8600
```

The pectoral's span and anhedral are SOLVED, not tuned (`pectoral_geometry`,
`build_shark.py:727`): the blade is a tapered extrusion, so its tip is two
vertices offset ± the edge half-thickness along the blade normal, and the
lowest and widest of them are different vertices. The fixed-point solve puts
the lowest at exactly `BELLY_Y` and the widest at exactly `FLANK_Z`; result
`span 0.3812, anhedral 33.13°, seat z 0.0997`.

### Measured in Node (`plugins/wildlife/.verify-shark-asset.mts`, uncommitted)

`parseRigAsset` off disk → `installSpeciesAsset` → `bakeRig`, the same install
path the browser's `preload` takes:

```
installSpeciesAsset: accepted shark.glb
GLB shark:
  surfaces: 1
  joints:   32
  triangles:3202
  materials: MeshStandardMaterial
  joints resolved: rig, tail, pectoral_port, pectoral_starboard
  bounds x[-1.0200, 0.7000] y[-0.2600, 0.4000] z[-0.4200, 0.4200] size 1.720
  declared SHARK_ENVELOPE: {"length":1.72,"halfLength":0.86,"halfWidth":0.42,"crownY":0.4,"bellyY":-0.26}
    nose      (0.7000, 0.0000, 0.0000)
    tail_tip  (-1.0200, 0.3600, 0.0000)
    crown     (-0.0400, 0.4000, 0.0000)
    belly     (-0.1500, -0.2600, 0.4178)
    flank     (-0.1500, -0.2600, 0.4200)
disposed blueprint then asset
```

Both `belly` and `flank` sit on the starboard pectoral tip (`build_shark.py:
1045–1046`): the one point that is both the lowest and the widest thing on the
shark. `installSpeciesAsset` (`assetSpecies.ts:171–197`) checks the four
extremes against the `Box3`, `flank` against `halfWidth` and the z extent, all
within `ENVELOPE_TOLERANCE_CELLS = 0.01` (`assetSpecies.ts:135`); every
difference above is 0.0000.

**A finding worth naming (same as pass 1's).** The procedural shark did not
measure its own envelope either: baked through `bakeRig` (below), its bounds
were `y[-0.2068, 0.3822] z[±0.4115] x[-1.0270, 0.7117]` against a declared
`bellyY -0.26 / crownY 0.40 / halfWidth 0.42 / length 1.72`. The asset was
built to FILL the declared envelope rather than shrink the contract, so
placement behaviour is byte-identical and the assertion is now true.

## Draw budget

| | surfaces | joints | triangles |
|---|---|---|---|
| procedural shark (`HEAD~2`, baked via `bakeRig`) | 1 | 14 | 2 456 |
| GLB shark | **1** | 32 | 3 202 |
| (GLB fish, pass 1, for scale) | 1 | 21 | 2 012 |

Both measured, not quoted: the old figure by baking `git show
HEAD:…/species/shark.ts` (copied to `client/species/.old-shark.ts`, uncommitted)
through a minimal `SpeciesModelPool` in `.verify-shark-asset.mts --old`; the
new by the same script. `SINGLE_SURFACE_SPECIES` stays 9 and
`WILDLIFE_SPECIES_DRAW_OBJECTS` stays 17; `attach`'s assertion against
`models.objects.length` is untouched.

One surface is not luck: `materialSignature` (`client/src/render/rigSkin.ts:
111`) keys on type / transparency / side / blending / depth / shading /
maps / `SHADING_SCALAR_FIELDS` (`rigSkin.ts:164`: roughness, metalness, …) /
emissive / program key — NOT colour. All four shark materials are
`MeshStandardMaterial`, untextured, roughness 0.50, metalness 0.00, so the four
colours (body 0x6b7886, fin 0x5a6674, eye 0x0f1114, line 0x3f4852) ride as
vertex colours in one draw. `build_shark.py:281–290` pins the one roughness for
exactly that reason.

3 202 tris against the brief's ~4 000 aim: body 1 824 (40 × 24 sweep), caudal
200, seven other fins 80 each, eyes 100 each, eleven ridges 38 each. The 32
joints are `rig`, `tail`, the two pectoral hinges, 22 meshes and 5 anchor
Empties — the anchors-become-bones note from pass 1 still applies and is still
not worth render-kit surgery at this count.

## The SPECIES_ASSETS single-list decision

Done: `plugins/wildlife/client/species/assets.ts` exports `SPECIES_ASSETS`
(`{spec, url}[]`); `index.ts` and `previewSpecies.ts` both import it and each
kept list is gone (`index.ts` no longer imports `FISH_ASSET`, `fishUrl` or
`SpeciesAssetSpec`; `previewSpecies.ts` no longer imports `FISH_ASSET` or
`fishUrl`).

- Import cycle: none. `assets.ts` → `fish.ts`/`shark.ts` → `assetSpecies.ts`/
  `speciesModel.ts`; neither species file imports `assets.ts`, and `index.ts` /
  `previewSpecies.ts` are leaves.
- `.glb?url` resolution: `tsconfig.base.json:19` lists `types/glb-url.d.ts` in
  `files`, which every package inherits (they override `include`, not `files`),
  so the import types in both `plugins/wildlife` and `client` with no new
  d.ts. `plugins/wildlife/client/glb-url.d.ts` is a pre-existing redundant
  copy; left alone (not this brief's).
- `pnpm typecheck` passes for every package (below).

## whaleHull / bodyKit remaining users (grep of `import` lines)

- `../whaleHull.ts`: `whaleSpecies.ts`, `species/bison.ts`, `angelfish.ts`,
  `grazer.ts`, `ibex.ts`, `eel.ts`, `ray.ts`. Still 7 users; nothing deleted.
- `./bodyKit.ts`: `species/bison.ts`, `angelfish.ts`, `grazer.ts`, `ibex.ts`,
  `eel.ts`, `ray.ts`, `quadruped.ts`. Still 7 users; nothing deleted.

The shark was the only user of `deform` together with `flatFin`+`uprightFin`+
`smoothEllipsoid`; `deform` is still used by `bison.ts`. No function in either
helper became orphaned.

## Verification

**`pnpm typecheck`** (root): every package `Done`, `grep -ci error` → 0.

**Wildlife tests per file** (`plugins/wildlife`, `timeout 240 npx vitest run
<file>`):

| file | result |
|---|---|
| `test/client.test.ts` | 18 passed |
| `test/gradient.test.ts` | 6 passed |
| `test/session-lifecycle.test.ts` | 3 passed |
| `test/wildlife.test.ts` | **17 passed with `--hookTimeout 120000`**; at the default 10 s hook timeout its `beforeAll` (a server-side settle of `SETTLE_SECONDS` of ticks, `test/wildlife.test.ts:190`) timed out twice on /mnt/e, once while the other three files ran concurrently and once alone (53 s wall). The file imports no client code; unrelated to this pass. |

No test file was added or changed. No existing assertion encoded the
procedural shark (`client.test.ts:341` only checks `placementKindOf('shark')
=== 'swimmer'`; nothing under `plugins/wildlife/test` builds the model pool).

**Blender build** (`build_shark.py`, Blender 5.2.1 LTS):

```
shark build:
  winding body: 936 faces, 0 inward
  pectoral: span 0.3812, anhedral 33.13 deg, seat z 0.0997
  attachment (vertices strictly inside the body):
    dorsal                   4/42 inside
    dorsal_second            8/42 inside
    anal                     10/42 inside
    caudal                   6/102 inside
    pectoral_port            3/42 inside
    pectoral_starboard       3/42 inside
    pelvic_port              3/42 inside
    pelvic_starboard         3/42 inside
    eye_port                 27/52 inside
    eye_starboard            27/52 inside
    mouth                    12/21 inside
    gill_1_port              14/21 inside
    gill_1_starboard         14/21 inside
    gill_2_port              10/21 inside
    gill_2_starboard         11/21 inside
    gill_3_port              14/21 inside
    gill_3_starboard         14/21 inside
    gill_4_port              14/21 inside
    gill_4_starboard         14/21 inside
    gill_5_port              14/21 inside
    gill_5_starboard         14/21 inside
  envelope (measured vs declared): [as quoted above, all off by 0.00000]
shark -> ...\shark.glb: 3202 tris total
```

**`stat_glb.py`** (fresh re-import):

```
  bbox cells: x=1.720 y=0.660 z=0.840  min-y=-0.260  centre-xz=(-0.160, 0.000)
  meshes: 22   (body 1824, caudal 200, dorsal/dorsal_second/anal/pectoral_*_blade/pelvic_* 80 each,
                eye_* 100 each, mouth + gill_1..5_{port,starboard} 38 each; uv=[], colors=[])
  total: 3202 tris
  materials: 4
    shark_body: baseColor=(0.15, 0.19, 0.24, 1.00), metallic=0.00, roughness=0.50
    shark_eye:  baseColor=(0.00, 0.01, 0.01, 1.00), metallic=0.00, roughness=0.50
    shark_fin:  baseColor=(0.10, 0.13, 0.17, 1.00), metallic=0.00, roughness=0.50
    shark_line: baseColor=(0.05, 0.06, 0.08, 1.00), metallic=0.00, roughness=0.50
  images: 0
  empties: 9
    belly (-0.150, -0.260, 0.418)   crown (-0.040, 0.400, 0)   flank (-0.150, -0.260, 0.420)
    nose (0.700, 0, 0)   tail_tip (-1.020, 0.360, 0)   rig (0, 0, 0)
    tail (-0.680, 0, 0) parent=rig
    pectoral_port (0.150, -0.050, -0.100) parent=rig   pectoral_starboard (0.150, -0.050, 0.100) parent=rig
  armatures: 0   skinned meshes: 0
```

(The linear baseColors are the sRGB hexes through the standard transfer
function: 0x6b → 0.15, 0x78 → 0.19, 0x86 → 0.24.)

**Renders** (`render_glb.py --name shark --views iso,side,front,top`, no
stage; uncommitted, viewed by me):

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ac41c7f4bc6b59b92/tools/blender/out/shark_iso.png`
  — from the play camera's angle it reads as a grey shark: tall first dorsal
  standing off the back, swept pectorals angled down either side, the long
  upper caudal lobe trailing, eyes and gill lines visible on the head.
- `.../tools/blender/out/shark_side.png` — the species tells are all there
  side-on: pointed snout with the mouth line under it, eye, five gill slits,
  triangular first dorsal, small second dorsal and anal aft, pelvic, and a
  clearly heterocercal tail (long upper lobe with its subterminal step, short
  lower lobe, notch between); fins show thickness at their roots, none reads
  as a plate.
- `.../tools/blender/out/shark_front.png` — round head section with the
  flattened belly, the dorsal as a fin (not a line) above, both pectorals
  with matching anhedral, both eyes; symmetric.
- `.../tools/blender/out/shark_top.png` — fusiform plan view widest at the
  pectorals, tapering to the peduncle; pectorals swept back, the caudal seen
  edge-on as expected for a vertical fin; nothing detached.

Colour is the declared grey in all four; nothing floats (the parity check
above proves it, the renders agree).

## Left undone, and why

- **Countershade** (lighter belly): not done. The brief made it optional and
  conditional on the one-surface rule; a vertex-colour attribute in the file
  would have been the way, and how `rigAsset`/`rigSkin` treat a file-supplied
  `COLOR_0` was not verified this session. Assumption, unverified: it would
  merge fine. Left for a later pass rather than risk the draw-budget assertion.
- **`plugins/wildlife/client/glb-url.d.ts`** is redundant with the root
  `types/glb-url.d.ts`; not removed (not in scope, and the brief said verify,
  do not add — removal is a different decision).
- **Anchors become bones** (32 joints): same observation as pass 1; not acted
  on.
- **`.verify-shark-asset.mts`** and **`client/species/.old-shark.ts`** are
  left in the worktree uncommitted (dot-files, like `.verify-closed.mts`); the
  renders in `tools/blender/out/` are uncommitted too.
- **In-game eyes-on** is the orchestrator's step; the app was not started.

## Where

- Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-ac41c7f4bc6b59b92`
- Branch: `worktree-agent-ac41c7f4bc6b59b92`
- Commits: `27941f9` feat(tools): build the shark in Blender and export shark.glb;
  `48f4d0b` feat(wildlife): draw the shark from shark.glb through assetSpecies;
  plus this report's commit (hash in the final message).
