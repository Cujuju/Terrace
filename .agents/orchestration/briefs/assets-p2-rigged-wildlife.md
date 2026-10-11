# Brief 2D: rigged adapter + first real creature asset (wildlife)

Repo: /mnt/e/Development/Projects/Terrace. You run in your own git worktree (harness-created;
`pwd` and `git branch --show-current` first; use that root for every command). Commit on the
branch; do not merge or push; never edit the main checkout. GitHub issue: Cujuju/Terrace#321.

Owner decision 2026-09-04: every plugin may use textures and external model assets; the game
must be able to import real, attractive third-party models. Phase 1 landed on main:
- client/src/render/materialMaps.ts, rigAsset.ts (loadRigAsset/parseRigAsset,
  assertAssetFits, armature rejection with a "rigidify" message), rigSkin.ts (PBR-complete
  bake), rigHerd.ts (instanced herds from a blueprint).
- tools/blender/import_model.py — normalises any model; `--rigidify` converts an armature
  into the game's pivot convention (an Empty per bone, meshes split by dominant weight and
  parented under it). stat_glb.py --footprint; render_glb.py. docs/model-assets.md.
- types/glb-url.d.ts — `.glb?url` imports work in every package.
Boats is the worked example of a rigged asset in a plugin: plugins/boats/client/models.ts
(preload → installBoatKit → bakeRig(asset.scene), joints via blueprint.jointIndex(asset.node(name))).

Wildlife is the hard case because it POOLS: one species file authors a tree, the pool owns
every geometry/material, bakes once, and draws the species as a herd. Your job: let a species
be an asset instead of a hand-built tree, with the same pool/herd path, and prove it by
replacing the GRAZER's model with a real CC0 herbivore.

Read first (verify against code; cite file:line):
1. plugins/wildlife/client/species/speciesModel.ts — SpeciesModelPool, AuthoredSpecies,
   SpeciesModelBuilder; the header on why one file per species.
2. plugins/wildlife/client/models.ts — createWildlifeModels (~L266): keepGeometry/lambert/
   unlit/part/rigged pool, bakeSpecies (~L378), herdFor (~L400), POSE_SLOTS_PER_HERD, the
   dispose order at the end, how each species builder is invoked and registered.
3. plugins/wildlife/client/species/grazer.ts — GRAZER_SCALE (0.4), GRAZER_ENVELOPE (used by
   placement.ts — grep it), buildGrazer, poseWalk from quadruped.ts (leg joint names, gait).
4. plugins/wildlife/client/species/quadruped.ts — legJoints/poseWalk: what joint NAMES and
   axes the walk drives. The asset's pivots must be driven by the same animation code (a
   thin mapping from bone names to those joint names is fine; a second walk cycle is not).
5. plugins/wildlife/client/index.ts — attach (~L304), WILDLIFE_SPECIES_DRAW_OBJECTS (~L22)
   and its derivation comment (~L284–302): the drawBudget is a constant that must match the
   real surface count; boats measures it from blueprint.surfaceCount — do likewise.
6. plugins/wildlife/client/placement.ts — how GRAZER_ENVELOPE (length/height/bodyHalfLength)
   is used; the envelope of the asset must be MEASURED from it (Box3), not typed in.
7. client/src/previewSpecies.ts + client/preview-species.html + client/scripts/
   shootSpeciesPreview.mjs — the species preview harness; it imports species builders
   directly and builds a one-creature herd (~L145).
8. client/src/render/rigAsset.ts, rigSkin.ts (bakeRig contract at the top), rigHerd.ts header.

## Deliverables

### D1 — the asset-sourced species contract (speciesModel.ts + models.ts)
- Add a second builder shape, e.g. `AssetSpeciesModelBuilder = (asset: RigAsset, pool) =>
  AuthoredSpecies`: root = asset.scene (identity, unparented — bakeRig's contract), joints =
  the named pivots (`asset.node(name)`), plus `rig`: the asset's root has no `rig` Group under
  it, and the pool's `rigged()` contract requires one (counter-sway/bob act on it). Decide:
  wrap the scene under a fresh rig Group (root → rig → asset.scene) or require the import to
  name a top node `rig`. Prefer the wrap — it keeps import_model.py generic — and say why.
- Ownership: asset-owned geometries/materials/textures are NOT pool-owned. The pool's dispose
  must run blueprint.dispose() for every species first, then asset.dispose() for each asset
  (the same order boats keeps: baked surfaces sample the asset's texture objects). Make this
  a contract in models.ts (an `assets` list disposed last), not a comment.
- Scale: grazer applies GRAZER_SCALE on the rig node so authored dims stay legible. For an
  asset, the size is set at import (footprint) — so the asset's rig scale is 1 and the
  envelope is measured. Keep GRAZER_SCALE exported if placement or anything else imports it;
  check every importer.
- Species-specific idle/walk: poseWalk drives named leg joints. Map the asset's bone-derived
  Empty names to those names in the grazer species file (a small `const JOINT_NAMES = {...}`
  table), or rename at import with `--rename`. Prefer rename at import so the runtime code
  reads the convention's names; say why if you differ.

### D2 — preload in wildlife
plugins/wildlife/client/index.ts gets `preload()` loading the grazer asset (`.glb?url`),
`assertAssetFits` against a footprint derived from the CURRENT grazer envelope (named
constants with the derivation; owner rule 2026-08-24: grazers stay plainly smaller than
PILGRIM_HEIGHT 0.62 — the height budget is that, cite plugins/pilgrims/client/models.ts:53),
and installs it where createWildlifeModels can reach it (boats' kit pattern, or pass assets
into createWildlifeModels — prefer passing: no module-level mutable state; say why if not).
previewSpecies.ts must keep working: it builds species directly — give it the same preload
(it already awaits preloadBoatModels-style calls in previewBoats.ts; mirror that).

### D3 — drawBudget truthful
WILDLIFE_SPECIES_DRAW_OBJECTS assumes the grazer is one surface. A textured asset with N
materials bakes to N surfaces (materialSignature keys on texture identity). Measure from
blueprint.surfaceCount at bake and make the plugin's drawBudget derive from the real count
(boats: BOAT_DRAW_OBJECTS = surfaceCount + 1). Read the ~L284–302 comment for why it is a
constant and satisfy that constraint honestly (e.g. a per-asset constant asserted against the
measured count at boot, throwing on mismatch). Report the count.

### D4 — the asset
A CC0 low-poly herbivore that reads as a grazer from an overhead camera: Quaternius
"Animated Animals"/"Ultimate Animated Animals" deer or similar (CC0; verify on the page).
Sources to /mnt/e/Development/Projects/Terrace/.model-import/src/ (never commit).
Normalise: import_model.py --rigidify --origin ground --forward <source axis> --footprint
<from D2> --rename <bone>=<joint name>… ; stat_glb.py --footprint; render_glb.py. Check the
rigidify table: each leg must be its own pivot with the vertices you expect; a bone with
zero vertices means the split picked wrong. Commit ONLY plugins/wildlife/client/assets/
<name>.glb + assets/LICENSES.md (URL, author, licence, exact import command). Under ~400 KB;
say the size. If the model's own animation clips exist, they are IGNORED (the game's
poseWalk drives the pivots) — note it in LICENSES.md/README so nobody hunts for them.

### D5 — eyes-on
Shoot with client/scripts/shootSpeciesPreview.mjs on preview-species.html:
`grazer=species=grazer&view=iso`, side, top, and a mid-stride frame (`t=`), plus one shot of
the ibex at the same framing so the size relation to a procedural species is visible. Herd
path: add a shot from preview-wildlife.html (buildWildlifePreview config) if it shows several
grazers; otherwise state the herd was exercised by the vitest run below. PNGs to
/mnt/e/Development/Projects/Terrace/.model-import/shots/wildlife/. Check specifically: feet on
the ground disc (not floating — memory: prove attachment, not bounds overlap), legs swing
about their own pivots (no hull clipping), texture sRGB (not washed out), no magenta.

### D6 — tests (owner permission: thin, simple, contract-level only)
One file plugins/wildlife/test/assetSpecies.test.ts (mirror how plugins/boats/test/
models.test.ts parses a GLB with parseRigAsset — reuse its in-memory GLB builder if it is
exported/importable; otherwise a ≤ few-KB hand-built scene): (1) an asset-sourced species
bakes with every joint in JOINT_NAMES resolvable via blueprint.jointIndex; (2) pool dispose
disposes blueprints before assets (spy order); (3) surface count equals the material count
of the asset. Nothing per-species beyond that.

## Rules
- Verify: `pnpm typecheck`; `cd client && timeout 300 npx vitest run`;
  `cd plugins/wildlife && timeout 240 npx vitest run`. Never `pnpm -r test`.
- No magic numbers; named constants with one-line justifications. Do not delete existing
  comments; update the ones you make false (the "no textures/no external assets" rule in
  wildlife/monsters headers was superseded by the owner 2026-09-04 — rewrite only wildlife's
  own; monsters is phase 3).
- Diff scope: plugins/wildlife/** (client, test, assets), client/src/previewSpecies.ts and
  its preview config if needed. Nothing in structures/monsters/pilgrims; nothing in
  client/src/render (phase 1 owns it — if you find a render-kit defect, report it, do not fix).
- Commit conventional (`feat(wildlife): …`), no attribution/footers. Do not merge or push.

## Report (short; file:line for claims)
Commit hash + branch; asset URL/licence/size/tri/material counts; rigidify table summary;
the D1 decisions (wrap vs rig name; pass vs kit; rename vs map); measured envelope vs old
GRAZER_ENVELOPE; drawBudget before → after; absolute PNG paths; typecheck/vitest results;
anything the brief got wrong.

## Notes from phase 1B (read before D4)
- Quaternius' pack downloads via Google Drive; a working mirror is
  raw.githubusercontent.com/trebeljahr/quaternius-showcase/…/animals_pack/<Name>.glb (Wolf.glb
  is already at /mnt/e/Development/Projects/Terrace/.model-import/src/Wolf.glb, normalised to
  .model-import/out/wolf.glb). Try Deer.glb (or another herbivore) from the same folder first.
- The Wolf source carries a stray `Icosphere` at the origin that sets the bbox: use `--drop`.
  Check stat_glb output for the same in any Quaternius file.
- import_model.py splits/rigidifies BEFORE fitting (rotated parts measure larger); run
  stat_glb.py --footprint on the OUTPUT as the proof, never trust the pre-split size.
- Bone names in that pack: Torso/Torso2/Torso3, Neck1, Head, Back, Front/BackUpperLeg.L/R,
  Front/BackLowerLeg.L/R, Tail2, Ear4.L/R, IK* helper bones (zero-vertex IK bones become
  empty pivots — harmless but consider `--drop` if they clutter node()).
