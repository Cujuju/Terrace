# Report: fish+whales → Blender pass 9 — the deep-sea anglerfish (`deepsea`), the last of the list

Brief: `.claude/orchestration/briefs/species-glb-pass-template.md` +
`.claude/orchestration/briefs/deepsea-glb-pass9.md`, on the pass-1 shape
(`species/fish.ts`) and the pass-8 report pattern. Worktree branch
`worktree-agent-a18895aefbc756853`; nothing merged, nothing pushed, the app
was never started, no test added or changed, the main checkout untouched (its
untracked `.verify-sperm-whale-asset.mts`, `.verify-angelfish-asset.mts` and
`.envelope-diff.mts` were read and copied). `pnpm install --frozen-lockfile`:
"Done in 49.6s", exit 0, lockfile unchanged (`git status --short pnpm-lock.yaml`
empty).

## What landed (commit 9f6d1a4)

| file | what |
|------|------|
| `tools/blender/build_deepsea.py` (new, 1215 lines) | Header L1–L83: what it builds, why the bulb alone hangs under `lure`, why the unlit material is a Background shader. Constants with reasons L95–L316: `NOSE_X 0.50` L103, `TAIL_TIP_X −0.50` L105, `CROWN_Y 0.35` L109, `BELLY_Y −0.35` L112, `FLANK_Z 0.275` L115, hull `HULL_NOSE_X 0.36`/`HULL_TAIL_X −0.36` L120–L121, `HULL_SEGMENTS 20` L126, absolute `TOP_PROFILE`/`BOTTOM_PROFILE`/`WIDTH_PROFILE` L144–L162 (belly plateau at −0.35 over t 0.20–0.35, width plateau at 0.275 over t 0.35–0.45), anchor stations `BELLY_T 0.28`/`FLANK_T 0.40` L164–L165 (asserted ring stations, `hull_stations` L757), the jaw arc L170–L186 (`JAW_TIP_TAPER_FRACTION` L183 — sections lean forward where the arc turns up, so the tip is pointed and the arc's end vertex is the nose; `JAW_ABOVE_BELLY 0.02` L186 asserted), teeth L188–L203, fins L205–L258, eyes L260–L267, stalk L269–L277 (`STALK_BELOW_CROWN 0.02` asserted), `LURE_REST (0.42, 0.23, 0)` / `LURE_RADIUS 0.06` / `LURE_BOB 0.05` L285–L287, colours L295–L297, `SURFACE_ROUGHNESS 0.5` L304, `ANCHOR_TOLERANCE 1e-9` L314. `surface_point` L413 (two half-ellipses on one width, absolute back and belly), `check_outward` L459 (per-face reference on the local axis), `unlit_material` L554 (Background → Output), `arc_tube` L655 (winding derived in the docstring, caps proved non-trivially), `cone` L723, `build_hull` L771, `jaw` L892 (tube + 12 tooth cones, ONE mesh), `upper_teeth` L926, `stalk` L939, `check_attachment` L996 (parity, asserted), `check_lure_bob` L1014, `check_envelope` L1033, `main` L1097 (Empties, anchors, export via `export_glb.py`). |
| `plugins/wildlife/client/assets/deepsea.glb` (new, 58 668 bytes) | 12 meshes, 3 materials (one `KHR_materials_unlit`), 7 Empties, 2284 tris. |
| `plugins/wildlife/client/species/deepsea.ts` (new, 137 lines) | Header L1–L63 (what changed / did not / unlit in the file / one envelope and what each extreme is / the lure joint and its rest constant). `DEEPSEA_SWAY_HZ 0.7` L72, `DEEPSEA_SWAY_RADIANS 0.22` L74, `DEEPSEA_LURE_BOB 0.05` L76, `DEEPSEA_LURE_LAG_RADIANS 1` L81, `DEEPSEA_LURE_REST_Y 0.23` L86, `DEEPSEA_NOSE_X`/`TAIL_TIP_X` L94–L95, `DEEPSEA_ENVELOPE` L104 (five fields; `halfWidth 0.275` L109, `crownY 0.35` L111, `bellyY −0.35` L113), `DEEPSEA_JOINTS = ['rig', 'lure']` L120, `DEEPSEA_ASSET` L126 (`species: 'deepsea'`, `file: 'deepsea.glb'`), `buildDeepsea = assetSpeciesBuilder(DEEPSEA_ASSET, …)` L133: `rig.rotation.y = sin(beat)·0.22` L135, `lure.position.y = 0.23 + sin(beat − 1)·0.05` L136 — the same two formulas HEAD's models.ts:557–560 ran. |
| `plugins/wildlife/client/placement.ts` | The ONE authorised change: the `DEEPSEA_ENVELOPE` import moves from `./models.ts` to `./species/deepsea.ts` (L40 added, L42 now imports `BIRD_ENVELOPE` alone — a 2-line diff for a 1-import move). `BODY_COLUMNS.deepsea` L333 and `SWIM_PROFILES.deepsea` L175–L181 untouched (proof below). |
| `plugins/wildlife/client/models.ts` (668 → 619 lines) | Header L1–L13 (ten species in ./species/, only the bird authored here); `buildDeepsea` import L86; `DEEPSEA_COLOR`, `DEEPSEA_LURE_COLOR`, the exported `DEEPSEA_ENVELOPE`, `DEEPSEA_SWAY_HZ`, `DEEPSEA_SWAY_RADIANS`, `DEEPSEA_LURE_BOB`, `deepseaMaterial`, `deepseaLureMaterial`, `deepseaBody`, `deepseaJaw`, `deepseaStalk`, `deepseaLure`, `deepseaRig` and the hand-written `deepseaDrawable` deleted; `deepseaDrawable = speciesDrawable(buildDeepsea)` L525; `case 'deepsea'` L553 unchanged. `unlit()` L301 KEPT with a comment saying why (below). The comments that named the deepsea (colours L98–L106, envelope L116–L124, rates L131–L136) corrected. |
| `plugins/wildlife/client/index.ts` | The two-surface paragraph L285–L302 rewritten: the deepsea is a Blender-built file whose lure carries `KHR_materials_unlit` → `MeshBasicMaterial`, measured under Node. Table row L282 (`deepsea 2`) and the constants `SINGLE_SURFACE_SPECIES = 11` L315 / `TWO_SURFACE_SPECIES = 1` L316 unchanged; `drawBudget` stays 15. |
| `plugins/wildlife/client/species/assets.ts` | `DEEPSEA_ASSET` import L33, `deepseaUrl` L34, the one row L55; header L1–L3 and L9–L10 name the angler. |
| `client/src/previewSpecies.ts` | `?species=` list L8 and `BUILDERS.deepsea` L66 (the sheet's authorised edit), import L51. |
| `tools/blender/stat_glb.py` (+37 lines) | The sheet's "add the extension print if it lacks one": `gltf_json` L318 reads the GLB container's JSON chunk, `print_extensions` L329 prints `extensionsUsed` / `extensionsRequired` and each material's extensions, called from `main` L348. A re-import cannot show unlit-ness faithfully, so it is read off the file itself. |

Not touched: `assetSpecies.ts`, `speciesModel.ts`, `protocol.ts`,
`whaleHull.ts`, `bodyKit.ts`, `export_glb.py`, `render_glb.py`,
`docs/model-assets.md`, any test.

## Wiring verified at file:line this session (comments are claims; these are executed lines)

- HEAD's angler: `models.ts:104-105` colours, `:124-128` `export const DEEPSEA_ENVELOPE = { crownY: 0.35, bellyY: -0.35 }`, `:141` `DEEPSEA_SWAY_HZ = 0.7`, `:154` `DEEPSEA_SWAY_RADIANS = 0.22`, `:156` `DEEPSEA_LURE_BOB = 0.05`; geometry `:317-323` (`ellipsoid(1, 0.7, 0.55)`, `ConeGeometry(0.3, 0.45, 4)` rotated −π/2, `BoxGeometry(0.5, 0.04, 0.04)`, `ellipsoid(0.14…)`), rig `:467-479` (jaw at (0.5, −0.12), stalk at (0.42, 0.34), `lure` Group at (0.68, 0.36), `bakeSpecies(root, { rig, lure })`), animate `:549-563` (`rig.rotation.y = sway·0.22`, `lure.position.y = lureRestY + sin(… − 1)·0.05`). All read from `git show HEAD:…` (`client/.old-models.ts`).
- `placement.ts:41` (HEAD) `import { BIRD_ENVELOPE, DEEPSEA_ENVELOPE } from './models.ts'`; `:332` `BODY_COLUMNS.deepsea` reads it; `:174-180` `SWIM_PROFILES.deepsea` is five hand-set literals (depthFraction 0.88, minClearance 0.8, minSubmergence 0.5, halfLength 0.5, halfWidth 0.28) reading nothing.
- `index.ts:282` table row `deepsea 2`; `:316` `TWO_SURFACE_SPECIES = 1`; `:342-355` `drawBudget: WILDLIFE_SPECIES_DRAW_OBJECTS`; `:386` `attach` throws if `models.objects.length` disagrees.
- Why two surfaces: `client/src/render/rigSkin.ts:126-133` `materialSignature` begins with `material.type`; `:331` appends indexing. `client/node_modules/three/examples/jsm/loaders/GLTFLoader.js:799-809` `GLTFMaterialsUnlitExtension.getMaterialType()` returns `MeshBasicMaterial`; `:516` dispatches on `KHR_materials_unlit`.
- `installSpeciesAsset` (`assetSpecies.ts:228-`): measures AT REST (`updateMatrixWorld(true)` L229), `flank` vs z extent as an upper bound L259–L264, `ENVELOPE_TOLERANCE_WORLD_UNITS = 0.01` L187.
- `index.ts:365-368` and `previewSpecies.ts:139` loop `SPECIES_ASSETS` with `loadRigAsset(url, null)`; the one row in `assets.ts:55` reaches both.
- Blender's exporter and unlit: probed in Blender 5.2.1 with three spheres (scratch `probe_unlit.py`): Background → Output exports `"extensions": {"KHR_materials_unlit": {}}` with `baseColorFactor` = the colour; Emission → Output exports `emissiveFactor` on a black base and NO extension; Principled exports plain. So `unlit_material` (`build_deepsea.py:554`) uses the Background shader.

### Importer greps (before deleting anything)

- `DEEPSEA_ENVELOPE` importers at HEAD: `placement.ts:41` ONLY (grep over `plugins/` and `client/src`, excluding scratch). After: `placement.ts:40` from `./species/deepsea.ts`; `models.ts` no longer exports it (`.envelope-diff.mts` prints the export lists).
- `unlit(` users: `models.ts:302` (the definition) and `models.ts:436` (the `speciesPool` object); `species/speciesModel.ts:42` DECLARES it on `SpeciesModelPool`; `client/src/previewSpecies.ts:165` implements it for the harness. No species calls it. **KEPT**: deleting it means changing the `SpeciesModelPool` contract and the preview harness, which the sheet's "if nothing else uses it" does not cover — the contract and a second implementation use it. Comment at `models.ts:295-300` says so. Orchestrator's call whether to drop the contract field.
- `../whaleHull.ts` importers (unchanged by this pass): `species/bison.ts`, `species/ibex.ts`. `./bodyKit.ts`: `species/bison.ts`, `species/ibex.ts`, `species/quadruped.ts`. The angler never used either.

## Design decisions, as built

1. **New `species/deepsea.ts`, fish.ts-shaped** (the sheet). `DEEPSEA_ENVELOPE` has five fields; `crownY`/`bellyY` are the same literals `0.35`/`-0.35` (proof below); `length 1.0` = `DEEPSEA_NOSE_X − DEEPSEA_TAIL_TIP_X`, `halfLength 0.5` (it happens to equal `SWIM_PROFILES.deepsea`'s hand-set `halfLength 0.5` — neither reads the other), `halfWidth 0.275` (the procedural ellipsoid's own 0.55 across; the hand-set profile keeps 0.28).
2. **Lure rest as a NAMED CONSTANT** (`DEEPSEA_LURE_REST_Y = 0.23`, L86), not read off the joint at first animate: `position.y = …` is absolute, so the rest must be known before the first frame and must not depend on which frame ran first. Proven equal to the file's Empty under Node: file `0.2300000042`, constant `0.23`, |diff| `4.172e-9` against a float32 half-ulp of `1.371e-8` at 0.23 — the file cannot carry the number more exactly, and the verify script fails if the diff exceeds that.
3. **placement.ts: the import moves, nothing else.** `BODY_COLUMNS.deepsea` and `SWIM_PROFILES.deepsea` evaluate byte-identical (below). The comment at `placement.ts:167-172` still says "the model's body ellipsoid reaches 0.7 below … (models.ts, ellipsoid(1, 0.7, 0.55))" — now historical (the file's belly is −0.35, the 0.7 was always the ellipsoid's FULL height, and the clearance 0.8 stays). Left alone per "Nothing else in placement.ts"; flagged for the orchestrator.
4. **models.ts loses the deepsea**; `BIRD_ENVELOPE` and the bird stay; `unlit()` stays (above). `Group`, `MeshBasicMaterial`, `ConeGeometry`, `BoxGeometry`, `SphereGeometry`, `CONE_SEGMENTS`, `TWO_PI` all still have users (bird, `rigged`, `unlit`, `ellipsoid`).
5. **The lure is unlit IN THE FILE**: `deepsea_lure` is a Background-shader material → `KHR_materials_unlit` (stat_glb prints `extensionsUsed: ['KHR_materials_unlit']`, `material deepsea_lure: extensions=['KHR_materials_unlit']`) → `MeshBasicMaterial #a8fbff` under Node. Body and detail materials are Principled at one roughness 0.5 → one `MeshStandardMaterial` surface. **Exactly 2 surfaces**, measured.
6. **One envelope, and what each extreme is**: CROWN = the dorsal fin's tip (`DORSAL_PEAK_X −0.09`, 0.35); the hull's back tops at 0.31 (0.04 under), the stalk's arch at 0.32 (0.03 under, `STALK_BELOW_CROWN` asserted), the bulb's top at rest 0.29 and at the top of its bob 0.34 (0.01 under, asserted in Blender and under Node). BELLY = the hull's throat plateau (−0.35 exactly); the jaw's underside −0.2964 (0.0536 above, `JAW_ABOVE_BELLY 0.02` asserted), the anal fin −0.28, the pectorals −0.157. NOSE = the jaw tip (0.50, −0.02); the bulb's front 0.48. TAIL_TIP = the caudal fan's rear vertex (−0.50, 0). FLANK = the hull's width plateau 0.275 at x 0.072; the drooping pectorals reach 0.3133 (upper-bound case). The old body overshot both ways (`--old` measured y −0.42…+0.43 against ±0.35, x to 0.75); this file honours the declaration.
7. **The bulb ALONE hangs under `lure`; the stalk is body geometry.** The stalk's tip ends at the bulb's centre and `LURE_RADIUS 0.06 > LURE_BOB 0.05`, so the tip is 0.01 inside at either extreme — `check_lure_bob` proves it by parity: 19/74, 25/74, 7/74 stalk vertices inside the bulb at rest, +0.05, −0.05. Hinging stalk + bulb together would translate the stalk's root (sunk `STALK_BASE_SINK 0.04`) by 0.05 and it would float. `lure` is an Empty at identity rotation (Node: rotation (0, 0, 0), parent `rig`).
8. **Joints `['rig', 'lure']`**, no tail joint: the species sways as a whole, as it always did. Teeth are cones merged into the `jaw` mesh (lower, 12) and one `upper_teeth` mesh (6) whose bases are sunk into the hull. The jaw is a rigid body part.
9. **Colours** (hexes via `srgb()`): body 0x161c26, lure 0xa8fbff (unlit), ONE very dark detail tone 0x3a4150 for teeth and eyes (a shade paler than the body so the needles read). Roughness 0.5, metalness 0 on the lit materials.

## Envelope: measured vs declared, and old vs new

| field | declared | Blender (`check_envelope`, pre-export) | Node anchor / bounds | off by |
|-------|---------:|---------------------------------------:|---------------------:|-------:|
| nose x | +0.50 | +0.500000 | anchor (0.5000, −0.0200, 0); x max 0.5000 | 0.0000000 |
| tail_tip x | −0.50 | −0.500000 | anchor (−0.5000, 0, 0); x min −0.5000 | 0.0000000 |
| crown y | +0.35 | +0.350000 | anchor (−0.0900, 0.3500, 0); y max 0.3500 | 0.0000000 |
| belly y | −0.35 | −0.350000 | anchor (0.1584, −0.3500, 0); y min −0.3500 | 0.0000000 |
| flank z | 0.275 | +0.275000 | anchor (0.0720, −0.0169, 0.2750); model z extent 0.3133 (pectorals) | 0.0000000 |
| length / halfLength | 1.0 / 0.5 | 1.0000 / 0.5000 | size.x 1.000 | — |

`plugins/wildlife/.envelope-diff.mts` (uncommitted; HEAD's models.ts as
`client/.old-models.ts` from `git show HEAD:`, `Object.is`):

```
old DEEPSEA_ENVELOPE (models.ts @HEAD): {"crownY":0.35,"bellyY":-0.35}
new DEEPSEA_ENVELOPE (species/deepsea.ts): {"length":1,"halfLength":0.5,"halfWidth":0.275,"crownY":0.35,"bellyY":-0.35}
  crownY  old=0.35 new=0.35 IDENTICAL
  bellyY  old=-0.35 new=-0.35 IDENTICAL
  new-only fields: length 1, halfLength 0.5, halfWidth 0.275 (what the file measures; placement reads none of them)
BODY_COLUMNS.deepsea : {"bellyY":-0.35,"crownY":0.35} IDENTICAL to HEAD
SWIM_PROFILES.deepsea: {"depthFraction":0.88,"minClearance":0.8,"minSubmergence":0.5,"halfLength":0.5,"halfWidth":0.28} IDENTICAL to HEAD
old models.ts exports: BIRD_ENVELOPE, DEEPSEA_ENVELOPE, createWildlifeModels
new models.ts exports: BIRD_ENVELOPE, createWildlifeModels
ALL IDENTICAL
```

The HEAD evaluation of the two rows is the same literals (the `IDENTICAL to
HEAD` lines compare against the JSON of HEAD's source text, and
`BODY_COLUMNS.deepsea.crownY`/`bellyY` are `Object.is`-equal to HEAD's
`DEEPSEA_ENVELOPE`). `git diff placement.ts` is the two import lines only.

## Blender build log (shipped build; `tools/blender/out/deepsea_build.log`)

```
deepsea build:
  hull: 28 rings x 20 segments
  winding hull: 580 faces, 0 inward
  winding jaw tube: 132 faces, 0 inward
  winding jaw tooth cone @132 … @242 (12 cones): 10 faces each, 0 inward
  winding upper tooth cone @0 … @50 (6 cones): 10 faces each, 0 inward
  winding eye_port / eye_starboard: 40 faces, 0 inward
  winding stalk: 78 faces, 0 inward
  winding lure_bulb: 96 faces, 0 inward
  attachment (vertices strictly inside the hull):
    jaw 50/206   upper_teeth 32/42   dorsal 12/34   anal 12/34   caudal 4/50
    pectoral_port 6/22   pectoral_starboard 6/22   eye_port 29/34   eye_starboard 29/34   stalk 13/74
  lure bob (stalk vertices strictly inside the bulb):
    bulb at rest   19/74   bulb at +0.05  25/74   bulb at -0.05  7/74
    bulb top at rest +0.2900; + bob 0.05 = +0.3400 <= crown +0.3500 by 0.0100
    bulb front +0.4800 behind the nose +0.5000 by 0.0200
  envelope (measured vs declared): nose/tail_tip/crown/belly/flank all off by 0.0000000
    the crown is the dorsal (+0.3500); the hull's back tops out at +0.3100, 0.0400 under it; the stalk's arch at +0.3200, 0.0300 under it
    the belly is the hull's throat (-0.3500); the jaw's underside -0.2964, 0.0536 above it; the anal fin -0.2800, 0.0700 above; the pectorals -0.1571, 0.1929 above
    jaw tube (without teeth) tops out at -0.0200; the snout pole sits at +0.0400: gape 0.0600 at the front
    widest thing on the model 0.3133 (the drooping pectorals; flank is the hull's width plateau, the upper-bound case the install allows)
    length 1.0000, halfLength 0.5000
  anal 64  body 1120  caudal 96  dorsal 64  eye_port/eye_starboard 64 each  jaw 360
  lure_bulb 168  pectoral_port/starboard 40 each  stalk 144  upper_teeth 60
deepsea -> deepsea.glb: 2284 tris total
```

Every non-hull part has vertices strictly inside the hull; the stalk's tip
has vertices inside the bulb at rest and at both bob extremes; nothing floats.
Two build iterations before this one: (1) the jaw's tip ring leaned forward
past the nose (0.528) → `JAW_TIP_TAPER_FRACTION`; (2) `arc_tube`'s cap fans
were wound inward and had passed trivially because their reference lay in the
cap's plane → derivation fixed in the docstring, references restricted to the
arc's interior centres so the caps are checked for real.

## As exported (`stat_glb.py`, fresh import of the committed file; `tools/blender/out/deepsea_stat.log`)

```
bbox world units: x=1.000 y=0.700 z=0.627  min-y=-0.350  centre-xz=(0.000, 0.000)
meshes: 12 — anal 64, body 1120, caudal 96, dorsal 64, eye_port 64, eye_starboard 64, jaw 360,
  pectoral_port 40, pectoral_starboard 40, stalk 144, upper_teeth 60 (all parent=rig);
  lure_bulb 168 parent=lure
total: 2284 tris
materials: 3 — deepsea_body baseColor=(0.01, 0.01, 0.02) roughness=0.50;
  deepsea_detail baseColor=(0.04, 0.05, 0.08) roughness=0.50; deepsea_lure (no nodes: no Principled BSDF)
images: 0
empties: 7 — rig (0,0,0); lure (0.420, 0.230, 0) parent=rig; nose (0.500, -0.020, 0)
  tail_tip (-0.500, 0, 0)  crown (-0.090, 0.350, 0)  belly (0.158, -0.350, 0)  flank (0.072, -0.017, 0.275)
armatures: 0   skinned meshes: 0
extensionsUsed: ['KHR_materials_unlit']   extensionsRequired: []
  material deepsea_body: extensions=(none)   deepsea_detail: (none)   deepsea_lure: ['KHR_materials_unlit']
```

## `.verify-deepsea-asset.mts` (uncommitted)

`node --experimental-strip-types .verify-deepsea-asset.mts`:

```
installSpeciesAsset: accepted deepsea.glb
GLB deepsea:
  surfaces: 2
  joints:   20
  triangles:2284
  surface 0: MeshStandardMaterial (smooth, roughness 0.5, colour #ffffff), 2116 tris
  surface 1: MeshBasicMaterial (smooth, roughness undefined, colour #ffffff), 168 tris
  two surfaces: one MeshStandardMaterial (body, teeth, eyes, fins, stalk), one MeshBasicMaterial (the unlit lure)
  joints resolved: rig, lure
    rig   parent=Scene at (0.0000, 0.0000, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    lure  parent=rig at (0.4200, 0.2300, 0.0000) rotation (0.0000, 0.0000, 0.0000)
    mesh lure_bulb parent=lure material MeshBasicMaterial #a8fbff
    mesh stalk/jaw/dorsal/anal/caudal/pectoral_port/pectoral_starboard/body parent=rig material MeshStandardMaterial #161c26
    mesh upper_teeth/eye_port/eye_starboard parent=rig material MeshStandardMaterial #3a4150
  bounds x[-0.5000, 0.5000] y[-0.3500, 0.3500] z[-0.3133, 0.3133] size 1.000
  declared DEEPSEA_ENVELOPE: {"length":1,"halfLength":0.5,"halfWidth":0.275,"crownY":0.35,"bellyY":-0.35}
    nose (0.5000, -0.0200, 0)  tail_tip (-0.5000, 0, 0)  crown (-0.0900, 0.3500, 0)
    belly (0.1584, -0.3500, 0)  flank (0.0720, -0.0169, 0.2750)
  lure rest y in file 0.2300000042 vs DEEPSEA_LURE_REST_Y 0.23: |diff| 4.172e-9 (float32 half-ulp at 0.23 is 1.371e-8)
  lure top at rest 0.2900 + bob 0.05 = 0.3400 <= crownY 0.35 by 0.0100
  bulb x max 0.4800 behind the nose 0.5000
  lit surface carries a colour attribute: true (1438 vertices)
  expected: body #161c26, lure #a8fbff, detail #3a4150
draw-object tally: 11 single-surface species + 1 grazer + 1 wolf + 2 deepsea (measured) = 15
index.ts drawBudget = 11 + 1 + 1 + 1 * 2 = 15
disposed blueprint then asset
```

(The baked surfaces' `colour #ffffff` is the bake's vertex-coloured material —
colour rides in the `color` attribute, `rigSkin.ts` `paintVertexColor`; the
per-mesh lines show the file's own material colours.)

`--old` (HEAD's procedural body, REBUILT in the script from `models.ts:317-323`
and `:467-479` with the same primitives, positions and materials — the old
body only ever existed inside `createWildlifeModels`, so this row is a
faithful reconstruction, not the executed HEAD code): 2 surfaces
(`MeshLambertMaterial` flat + `MeshBasicMaterial`), 7 joints, 92 tris, bounds
x[−0.5, 0.75] y[−0.42, 0.43] z[−0.3, 0.3].

### Draw budget and the final draw-object tally

| herd | surfaces |
|--|--:|
| fish, ibex, bison, ray, shark, eel, angelfish, bird, whale-humpback, whale-blue, whale-sperm | 1 each (11) |
| grazer (downloaded asset) | 1 |
| wolf (downloaded asset) | 1 |
| **deepsea (built asset)** | **2** (1 `MeshStandardMaterial` + 1 `MeshBasicMaterial`, measured) |
| **total = `drawBudget`** | **15** (unchanged; `TWO_SURFACE_SPECIES` still 1) |

| body | surfaces | joints (bakeRig nodes) | triangles | materials |
|--|--:|--:|--:|--|
| procedural deepsea (HEAD, rebuilt) | 2 | 7 | 92 | MeshLambertMaterial (flat) + MeshBasicMaterial |
| **deepsea.glb** | **2** | 20 | **2 284** | MeshStandardMaterial + MeshBasicMaterial |

Triangle aim ≤ ~3 000: met at 2 284 (hull 1120 + jaw 360 + bulb 168 + stalk
144 + eyes 128 + caudal 96 + dorsal 64 + anal 64 + pectorals 80 + upper teeth 60).

## Renders (uncommitted, `tools/blender/out/`)

- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a18895aefbc756853/tools/blender/out/deepsea_iso.png`
  — from the play angle a near-black globular body with the bright pale lure
  bulb hanging ahead of the head on its arched stalk, the toothed lower jaw
  beneath, the small dorsal on the back and the caudal fan behind. **The
  lure renders as a flat bright disc**: Cycles treats the Background shader
  on a mesh as a constant-colour (emission-like) closure, so the unlit read
  is the render's own — and the unlit-ness is proven under Node by material
  type regardless.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a18895aefbc756853/tools/blender/out/deepsea_side.png`
  — a Melanocetus in profile: the globe of a body, the upturned lower jaw
  with two rows of needle teeth pointing up and back into the gape, the
  upper teeth hanging from the snout, the illicium rising from the snout
  and arching forward to the bulb, a tiny eye, small rounded dorsal, anal
  and pectoral fins, a short rounded caudal on a stubby peduncle.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a18895aefbc756853/tools/blender/out/deepsea_front.png`
  — a tall rounded head with the bulb above it, the teeth clustered at the
  mouth below, the pectoral tips as small bumps either side.
- `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a18895aefbc756853/tools/blender/out/deepsea_top.png`
  — a teardrop planform: the wide head, the stalk and bulb ahead, the quick
  taper to the peduncle, the pectoral stubs, the caudal blade.
- `deepsea_bow34.png` (a fifth view used to judge the head) — the jaw's
  teeth read as needles against the dark body, the bulb is bright and
  attached, the dorsal and pectoral have visible root thickness.

## Verification runs

- `pnpm install --frozen-lockfile`: exit 0, lockfile unchanged.
- `cd plugins/wildlife && npx tsc --noEmit -p .`: exit 0. `cd client && npx tsc --noEmit -p .`: exit 0. `pnpm typecheck` (root): 29 `Done`, exit 0 (`tools/blender/out/typecheck.log`).
- Wildlife tests per file from `plugins/wildlife`, `timeout 240 npx vitest run <file>`:
  `test/client.test.ts` 18 passed; `test/assetSpecies.test.ts` 4 passed;
  `test/gradient.test.ts` 6 passed; `test/session-lifecycle.test.ts` 3 passed;
  `test/wildlife.test.ts --hookTimeout 120000` 17 passed. No assertion encoded
  the procedural angler (client.test.ts:213-341 uses `creatureWorldY('deepsea', …)`
  through placement, whose rows are unchanged); no test changed, none added.
- Blender build log, `stat_glb.py`, `.verify-deepsea-asset.mts` (+ `--old`),
  `.envelope-diff.mts`: above.
- Importer greps: above.

## Left undone, and why

- **`unlit()` in models.ts** — kept (it is the `SpeciesModelPool` contract
  and previewSpecies.ts implements it). Nothing now calls it. Dropping the
  field from `speciesModel.ts` and both implementations is a contract change
  for the orchestrator to decide.
- **`placement.ts:167-172` comment** cites `models.ts, ellipsoid(1, 0.7, 0.55)`
  for the angler's body; historical now. Not edited (the sheet: nothing else
  in placement.ts).
- **The mouth's gape** at the very front is 0.06 (jaw tip −0.02 vs snout
  pole +0.04) and 0.25 at the snout's face; the jaw reads as an upturned,
  toothed chin hugging a huge mouth rather than a wide-open trap. That is the
  Melanocetus closed-mouth profile; a gaping mouth would put the jaw tip well
  below and ahead of the snout and would have to be checked against the belly
  and the halfLength contract. Not done.
- **Bob-extreme pose not rendered**: the +0.05/−0.05 attachment is proven by
  parity, not pictured — the app was not started and render_glb.py poses
  nothing.
- **Anchor Empties become bones** (20 joints for two driven ones): as every
  pass before; the render-kit change to skip meshless leaves is not this
  pass's.
- Uncommitted scratch left in the worktree as the brief asks:
  `plugins/wildlife/.verify-deepsea-asset.mts`, `plugins/wildlife/.envelope-diff.mts`,
  `plugins/wildlife/client/.old-models.ts`, `tools/blender/out/` (renders,
  logs, `blender.sh`). The Blender probe `probe_unlit.py` lived in the
  session scratchpad, not the repo.

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a18895aefbc756853`
Branch: `worktree-agent-a18895aefbc756853`
Code commit: `9f6d1a4`; final commit (this report): see `git log -1`.
