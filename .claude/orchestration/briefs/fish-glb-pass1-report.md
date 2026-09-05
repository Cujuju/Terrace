# fish+whales → Blender pass 1 — report

Worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a69c65dfb12ef32f1`,
branch `worktree-agent-a69c65dfb12ef32f1`, commit `6b097cb`.

## What landed

| file | what |
|---|---|
| `plugins/wildlife/client/species/assetSpecies.ts` (new, 251 lines) | the adapter. `SpeciesAssetSpec`, `SpeciesEnvelope`, `SWIMMER_JOINTS` (:103), `ENVELOPE_TOLERANCE_CELLS` (:135), `installSpeciesAsset` (:157), `disposeSpeciesAssets` (:204), `assetSpeciesBuilder` (:216) |
| `plugins/wildlife/client/species/fish.ts` (rewritten, 220→116) | envelope + animation only. `FISH_ENVELOPE` :78, `FISH_ASSET` :97, `buildFish` :104 |
| `plugins/wildlife/client/index.ts` | `SPECIES_ASSETS` table :313, `preload()` :339, `disposeSpeciesAssets()` after `models.dispose()` :411 |
| `plugins/wildlife/client/glb-url.d.ts` (new) | ambient `*.glb?url`, same reason boats carries one (package tsconfig takes only `node` types) |
| `plugins/wildlife/client/assets/fish.glb` (new, 66 336 bytes) | the asset |
| `plugins/wildlife/client/species/speciesModel.ts` :62 | `AuthoredSpecies.root` widened `Group` → `Object3D` |
| `plugins/wildlife/client/models.ts` :377 | `bakeSpecies(root: Object3D, …)` to match |
| `client/src/previewSpecies.ts` :125, :218 | `installAssets()` then `main()` — the harness has no host to give it a `preload` |
| `tools/blender/build_fish.py` (new, 859 lines) | builds and exports the fish, with its own checks |
| `tools/blender/render_glb.py` (new) | the war boat's 4-view check, generalised to any `.glb` |
| `docs/model-assets.md` | new "Wildlife species" section: the joint convention, the anchors, the ownership rule |

Nothing was orphaned: `../whaleHull.ts` and `./bodyKit.ts` still have seven and
eight species using them respectively (grazer, ibex, bison, ray, shark, eel,
angelfish, plus `whaleSpecies.ts` on whaleHull) — verified by grep before the
rewrite.

## The adapter split, and the two alternatives rejected

**Chosen.** The `.glb` supplies the part tree and the joints, addressed **by
name**. The species `.ts` supplies (a) the envelope constants, (b) the joint
name list, (c) `animate`. `assetSpeciesBuilder(spec, animate)` returns a plain
`SpeciesModelBuilder`, so `models.ts`'s `speciesDrawable` / `bakeSpecies` /
`herdFor` / `drawInto` are unchanged and never learn a species came from a file.
The registry is keyed by species string, so pass 2 (shark) adds one
`SpeciesAssetSpec`, one row in `SPECIES_ASSETS`, and nothing else.

**Rejected 1 — the asset supplies the envelope too** (`FISH_ENVELOPE` derived
from the anchors at install). Cheaper, and wrong: `placement.ts`'s
`SWIM_PROFILES.fish` and `BODY_COLUMNS.fish` read those constants to decide how
much water column a fish needs, which is a contract with the server's spawn
rules. Deriving them means a re-export silently moves every fish in the world
and nothing reports it. Asserting instead turns the same re-export into a load
error naming the file.

**Rejected 2 — a `fish.glb`-shaped loader in `fish.ts`** (each species file
loads and validates its own asset). Fewer moving parts today, and it is the
duplication the brief exists to avoid: eight more species would each re-write
the anchor check, the joint check and the dispose order, and the joint-name
convention would live in eight places instead of one. The spec-plus-generic-
installer shape puts all of it at the contract layer.

## Ownership / dispose

| thing | owner | freed by | order |
|---|---|---|---|
| the `.glb`'s geometries, materials, textures | the `RigAsset` | `disposeSpeciesAssets()` (plugin `dispose`) | **second** |
| the baked merged geometry + vertex-coloured material | the `RigBlueprint` | `models.dispose()` (`speciesRigs` loop) | **first** |
| anything from `SpeciesModelPool` | nobody — an asset-sourced builder calls neither `keepGeometry` nor `lambert` | — | — |

Why blueprint-first, verified from code rather than from the doc's claim:
`bakeRig`'s `vertexColoured()` (`client/src/render/rigSkin.ts:472-500`) does
`material.clone()`, and three's `MeshStandardMaterial.copy` assigns `this.map =
source.map` — the clone **shares** the source texture object. Freeing the asset
first would drop the GPU upload out from under a living rig.
`plugins/wildlife/client/index.ts` disposes `models` and only then calls
`disposeSpeciesAssets()`. (The fish carries no textures, so today this is a
guard rather than a live path — but it is the rule every later species inherits.)

## Envelope: measured vs declared

Declared in `fish.ts` (unchanged from the procedural fish, so `placement.ts` is
untouched): `length 0.72, halfLength 0.36, halfWidth 0.08, crownY 0.17,
bellyY -0.17`.

Measured off the exported `.glb` by `plugins/wildlife/.verify-fish-asset.mts`
(Node, `parseRigAsset` off disk — the same install path the browser takes):

```
installSpeciesAsset: accepted fish.glb
bounds x[-0.4200, 0.3000] y[-0.1700, 0.1700] z[-0.1369, 0.1369] size 0.720
  nose      (0.3000, 0.0000, 0.0000)
  tail_tip  (-0.4200, 0.0000, 0.0000)
  crown     (-0.0200, 0.1700, 0.0000)
  belly     (-0.1100, -0.1700, 0.0000)
  flank     (0.0935, 0.0000, 0.0800)
```

and inside Blender, before export, against the mesh itself:

```
  envelope (measured vs declared):
    nose      +0.3000 vs +0.3000  (off by 0.00000)
    tail_tip  -0.4200 vs -0.4200  (off by 0.00000)
    crown     +0.1700 vs +0.1700  (off by 0.00000)
    belly     -0.1700 vs -0.1700  (off by 0.00000)
    flank     +0.0798 vs +0.0800  (off by 0.00019)
```

Tolerance `ENVELOPE_TOLERANCE_CELLS = 0.01`, justified from both ends in
`assetSpecies.ts:125-134`: far above float32 accessor dust (~2e-8 at 0.3), far
below a visible move (1/72 of the fish's length, under a pixel at the play
camera). `flank`'s 0.00019 miss is real and expected — no hull station lands
exactly at the widest u, so the sampled mesh is a fraction under the profile.

**A finding worth naming.** The procedural fish's declared `crownY`/`bellyY`
were *not* what it measured: its dorsal peaked at ≈0.133 and its anal fin at
≈-0.080 against a declared ±0.17, so `placement.ts` was reserving ~0.09 of
water column below the fish that nothing occupied. Rather than shrink the
contract (a behaviour change: fish would start swimming in shallower water),
the asset was built to **fill** the declared envelope — a taller dorsal and a
real anal fin — and the body was given an asymmetric section (belly deeper than
back, `BOTTOM_RATIO_PROFILE`) so the anal fin reaching -0.17 reads as anatomy
rather than as a spike. Placement behaviour is byte-identical; the assertion is
now true instead of aspirational.

## Draw budget

| | surfaces | joints | triangles |
|---|---|---|---|
| procedural fish (`HEAD~1`) | 1 | 13 | 1 576 |
| GLB fish | **1** | 21 | 2 012 |

Both measured, not quoted: the old figure by baking `git show
HEAD:…/species/fish.ts` through `bakeRig` in a scratch script, the new one by
`.verify-fish-asset.mts`. **`WILDLIFE_SPECIES_DRAW_OBJECTS` is unchanged (17)**
and `attach`'s assertion against `models.objects.length` still holds — the
plugin's tests and typecheck both pass with it untouched.

One surface is not luck. All four fish materials are `MeshStandardMaterial`,
smooth, untextured, with identical `transparent/opacity/side/blending/depth`
and black emissive, so `materialSignature` (`rigSkin.ts:103`) gives them one
key and colour rides as vertex data. That is also why `build_fish.py` pins one
`SURFACE_ROUGHNESS` for every material: roughness is *not* in the signature, so
two roughnesses would merge and one would be silently discarded.

The 8 extra joints are the five anchor Empties plus `tail` and the two
pectoral hinges. An anchor bone costs one matrix per pose slot and nothing
else; the war boat carries three of the same.

## Verification

**`pnpm typecheck` (root)** — all 27 packages `Done`, no errors. (The worktree
had no `node_modules`; `pnpm install --frozen-lockfile` ran first, 43.7 s,
lockfile unchanged.)

**`timeout 240 npx vitest run` in `plugins/wildlife`** —
`Test Files 4 passed (4) / Tests 44 passed (44)`, 13.76 s.
**No test file was added or changed.** No existing assertion encoded the
procedural fish: `test/client.test.ts` deliberately imports no `three`, and
nothing under `plugins/wildlife/test` builds the model pool. `plugins/boats`
was not touched and was not run.

**Blender build** (`build_fish.py`, Blender 5.2.1 LTS):

```
  winding body: 560 faces, 0 inward
  attachment (vertices strictly inside the body):
    dorsal                   6/34 inside
    anal                     4/34 inside
    caudal                   6/64 inside
    gill_line                40/60 inside
    pectoral_port            8/34 inside
    pectoral_starboard       8/34 inside
    eye_port                26/52 inside
    eye_starboard           26/52 inside
    lateral_line_port       39/60 inside
    lateral_line_starboard  39/60 inside
  fish -> …\fish.glb: 2012 tris total
```

Nothing floats: the check is odd ray-crossing parity against the body's closed
mesh (the Python twin of `plugins/wildlife/.verify-closed.mts`), not bounds
overlap, and it **asserts** — a part with zero vertices inside fails the build.
The body is the trunk and is not tested against itself.

**`stat_glb.py` (fresh re-import of the exported file)** — 21 nodes, 11 meshes,
4 materials, 1 940→2 012 tris, `uv=False` throughout (no textures):

```
  anal [MESH] 64 tris, mats=['fish_fin']          belly [EMPTY] at (-0.110, 0.000, -0.170)
  body [MESH] 1080 tris, mats=['fish_body']       crown [EMPTY] at (-0.020, -0.000, 0.170)
  caudal [MESH] 124 tris, mats=['fish_fin']       flank [EMPTY] at (0.094, -0.080, 0.000)
  dorsal [MESH] 64 tris, mats=['fish_fin']        nose [EMPTY] at (0.300, 0.000, 0.000)
  eye_port / eye_starboard [MESH] 100 tris each, mats=['fish_eye']
  gill_line [MESH] 120 tris, mats=['fish_line']   rig [EMPTY] at (0.000, 0.000, 0.000)
  lateral_line_port / _starboard [MESH], mats=['fish_line']
  pectoral_port [EMPTY] at (0.100, 0.062, -0.030)   tail [EMPTY] at (-0.260, 0.000, 0.000)
  pectoral_starboard [EMPTY] at (0.100, -0.062, -0.030)
  tail_tip [EMPTY] at (-0.420, 0.000, 0.000)
```

(Blender frame; `+Y` there is `-Z` in game space, so `pectoral_port` is on
`-Z` — port, per the right-handed `left = up × forward` rule.)

**Renders** — `tools/blender/render_glb.py`, 4 × 512 px, uncommitted:
`tools/blender/out/fish-game.png`, `fish-side.png`, `fish-top.png`,
`fish-front.png`. All four viewed; the model reads as a fish at the play
camera's angle and holds up side-on.

## A defect found and fixed on the way

`build_war_boat.py` writes colours as `0xE8 / 255` into Blender's **Base Color**
socket. That socket is **linear** and every colour in this codebase is an sRGB
hex (three reads `new MeshLambertMaterial({ color: 0xe8a13c })` as sRGB), so the
value asks for a colour whose sRGB encoding is ≈0.96 — the fish came out pale
cream instead of warm orange, visibly, in the first render. `build_fish.py` now
converts through the sRGB standard transfer function in exactly one place
(`srgb()`, :365) and the render shows 0xe8a13c.

**`tools/blender/build_war_boat.py` still has this bug** (`DECK_COLOR`,
`WOOD_COLOR`, `SAIL_COLOR`, and the whole `hull_texture()` palette). Not fixed
here: it would change the shipped war boat's appearance, which is an eyes-on
decision for the owner and outside this pass. Flagged explicitly rather than
deferred quietly.

`render_glb.py` also sets `view_transform = 'Standard'` and holds total light
below clipping — Blender 5's default AgX look transform desaturates, which is
right for photoreal work and wrong for a check whose whole job is "is this the
colour the species file declares".

## Left undone, with reasons

- **In-game eyes-on.** Not run: the brief forbids starting the app, and the
  owner's rule requires permission. The Blender renders and the Node bake are
  what this pass can prove; the fish in water is the orchestrator's step.
- **`preview-species.html?species=fish`** is wired (the harness installs the
  asset before building) but was not opened, for the same reason.
- **A test for the adapter.** `installSpeciesAsset`'s rejections (missing
  joint, moved anchor, `flank` past the model) are exactly the contract-level
  assertions that deserve tests, and boats has the precedent
  (`plugins/boats/test/models.test.ts:259`, `installBoatKit` refusals). Not
  written: test permission is per-session and was not granted. **This is the
  one real gap in the pass** — recommend granting it next session and adding
  `plugins/wildlife/test/speciesAsset.test.ts` against hand-built fake assets,
  contract-level, not per-species.
- **`plugins/wildlife/.verify-fish-asset.mts`** is left in the worktree
  uncommitted (dot-file, like `.verify-closed.mts`) — it is how every number in
  the draw-budget and envelope tables above was obtained.
- **The five anchor Empties become bones** in every baked fish (21 joints vs
  13). Harmless at this scale and true of the war boat too; if a later species
  carries many anchors it is worth teaching `bakeRig` to skip childless,
  meshless nodes. Not done here: it is render-kit surgery for a cost nobody has
  measured as mattering.
