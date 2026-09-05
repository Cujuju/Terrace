# Brief 4A: real skin weights through the bake (#328)

Repo: /mnt/e/Development/Projects/Terrace. You run in your own git worktree (harness-created;
`pwd` and `git branch --show-current` first; use that root for every command). Commit on the
branch; do not merge or push; never edit the main checkout. GitHub issue: Cujuju/Terrace#328.
Time box: 90 minutes of wall clock. If you are not at D3 by 60 minutes, stop, commit what
compiles, and report where you are.

## The defect (owner-visible, 2026-09-04)

.model-import/shots/wildlife/grazer-stride.png: the imported Quaternius deer opens seams at
the shoulder and hip mid-stride. Root cause in one sentence: the rig kit binds every vertex
rigidly to one bone (client/src/render/rigSkin.ts `RIGID_BIND_WEIGHT`, `bindRigidly`), and
tools/blender/import_model.py `--rigidify` splits a smooth-skinned source by dominant weight
to feed it, so a vertex that was 60/40 across a joint is torn to one side. The rigid contract
is correct for hinged bodies (boats, hand-built creatures) and wrong for a downloaded
smooth-skinned animal. This brief makes the smooth path exist beside the rigid one.

## Read first — verify against code, cite file:line in your report. Comments are claims.

1. client/src/render/rigSkin.ts — whole header; `bakeRig` (~L247): node collection
   (depth-first, EVERY node is a bone, index = collection order), `boneInverses` from
   `node.matrixWorld`, `bindRigidly`, `isDrawableMesh` (rejects isBone/isSkinnedMesh),
   `stripUnbakeableAttributes`, `vertexColoured`; `instantiateRig`.
2. client/src/render/rigHerd.ts — `POSE_SHADER_PARS` (~L79): reads `skinIndex.x` ONLY;
   `capturePose` (~L269): `world * boneInverses[i]` per bone into the palette. The herd is
   how wildlife is drawn; instantiateRig is how boats/monsters are drawn. Both must blend.
3. client/src/render/rigAsset.ts — `assertNotSkinned` at load, `RIGIDIFY_INSTRUCTION`,
   `RigAsset` interface, `createRigAsset` (materials/uv checks per mesh).
4. plugins/wildlife/client/species/assetSpecies.ts — `SpeciesAssetSpec.rigidified` and
   `.adopt`, `prepareRigidified`, `modelAxisPivot`, `adoptKeepingTransform`, `installSpeciesAsset`
   (envelope asserted from Box3 + anchors).
5. plugins/wildlife/client/species/grazer.ts — GRAZER_ASSET (joints, adopt list), envelope
   numbers, the header's "clips are ignored" paragraph.
6. plugins/wildlife/client/assets/LICENSES.md L14–60 — the exact import command that made
   grazer-deer.glb. tools/blender/import_model.py: `rigidify()` (~L424), `main()` (~L640):
   the armature branch, `apply_renames`, `bake_object_transforms`, `fit_to_footprint`,
   `recentre`, `add_anchors`; tools/blender/export_glb.py `export_scene_glb`.
7. .model-import/blender.sh (how Blender is invoked here), .model-import/verify-rig-asset.mts
   (Node-side parse of a .glb through parseRigAsset), client/scripts/shootSpeciesPreview.mjs
   header (static build + http.server + CDP; Vite dev on /mnt/e does not watch).
8. docs/model-assets.md — the sections on rigidify and on wildlife species.

## Design (decided; say in the report if the code forces a change)

- SMOOTH IS ADDITIVE. The rigid path is untouched for every existing caller. A file that
  ships an armature is ACCEPTED by rigAsset (drop `assertNotSkinned`; keep the multi-material
  and uv checks per SkinnedMesh too). `RIGIDIFY_INSTRUCTION` and the rejection in
  `isDrawableMesh` go away or become the smooth branch — no dead constant left behind.
- bakeRig, for a SkinnedMesh part: positions/normals are stored at the BIND pose. Bake them
  into the rig's REST space by CPU-skinning each vertex with the file's own skeleton
  (`mesh.skeleton.bones[i].matrixWorld * mesh.skeleton.boneInverses[i]`, blended by the
  file's skinWeight, then `mesh.bindMatrix` — mirror three's `Skeleton`/`SkinnedMesh.applyBoneTransform`
  order exactly; verify in node_modules/three, cite the lines). After that the existing
  `boneInverses = node.matrixWorld.invert()` rule holds for bones exactly as for Groups, and
  rest == bind by construction. Do NOT assume the file's rest pose equals its bind pose.
- skinIndex REMAP: the file's indices address `mesh.skeleton.bones`; the bake's address its
  own depth-first node list. Remap through `indexOf.get(skeleton.bones[i])`; a bone that is
  not in the baked tree is a thrown error naming the mesh (it cannot happen for an
  unparented scene, so the throw is a guard, not a path).
- Keep ALL FOUR influences and the file's weights (normalise if they do not sum to 1 within
  float dust; three's exporter path does, Blender's does). `SKIN_INFLUENCES` is already 4.
- rigHerd shader: blend four palette matrices by skinWeight, the way three's
  `<skinning_vertex>` does (`boneMatX * skinWeight.x + …`), for position AND normal. The
  rigid case is then the 1/0/0/0 special case of the same code — one shader, not two.
  Verify `instantiateRig`'s SkinnedMesh path already blends (three's own skinning does).
- Wildlife adapter: `SpeciesAssetSpec.rigidified` stays the "downloaded model" flag but its
  meaning shifts to "a converted armature" whether rigid or smooth. `modelAxisPivot` inserts a
  Group between a Bone and its parent: bakeRig collects it as one more bone, and the weighted
  vertices follow their Bone wherever it now lives. Confirm this holds (the pivot must not
  break the depth-first parent-before-child invariant rigHerd relies on, rigHerd.ts ~L159).
  `adopt` likewise: reparenting the IK-target Bone under the leg pivot carries its weighted
  hooves with it — no vertex moves. Prove it with the stride shot (hooves stay on the legs).
- import_model.py: `--rigidify` becomes OPTIONAL. Without it, an armature is KEPT and exported
  as a glTF skin (Blender's exporter does this by default — confirm export_glb.py's
  settings do not strip skins/`export_skins`, `export_all_influences` or the 4-influence cap).
  `--rename` must apply to BONE names too (today it renames objects — check). `fit_to_footprint`
  / `bake_object_transforms` / `recentre` must scale the armature and its skinned meshes
  together and apply (a mesh with an Armature modifier plus a scaled armature: apply scale to
  the armature object AND the mesh with the same factor, then bake). Measure with
  stat_glb.py --footprint after; the numbers must still match GRAZER_ASSET_ENVELOPE within
  ENVELOPE_TOLERANCE_WORLD_UNITS or you re-derive them and say so.
  Node-name sanitising: GLTFLoader strips `.` from names (grazer.ts explains) — bones too.
- Envelope: `installSpeciesAsset` measures Box3.setFromObject; on a SkinnedMesh three's Box3
  uses the BIND-pose geometry unless `precise`/skinned handling is applied — check
  `Box3.setFromObject(obj, precise)` and `SkinnedMesh.computeBoundingBox` in node_modules/three
  and make the measurement the posed one (or bake-then-measure). Cite lines.
- The model's animation clips stay ignored (grazer.ts header); do not play them.

## Deliverables

D1. Render kit: rigSkin.ts + rigHerd.ts + rigAsset.ts as above. Constants named; comments
    ≤30 words each; no `any` without a why. `pnpm --filter client typecheck` (or the repo's
    equivalent — check package.json) clean. Run the existing tests for client/src/render and
    plugins/wildlife ONLY, each with `timeout 300` (never `pnpm -r test`). Do not add tests.
D2. Re-import the deer WITHOUT `--rigidify` (same command otherwise, from LICENSES.md; via
    .model-import/blender.sh). Update LICENSES.md's recorded command. Replace
    plugins/wildlife/client/assets/grazer-deer.glb. Update grazer.ts (joints/adopt still by
    name; header paragraph about rigid binding rewritten to the truth).
D3. EYES-ON: preview-species stride shot of the grazer at the same phase as
    .model-import/shots/wildlife/grazer-stride.png (static build + http.server on a free port
    + client/scripts/shootSpeciesPreview.mjs; see its header). Save to
    .model-import/shots/wildlife/grazer-stride-smooth.png plus side/iso. VIEW THE IMAGE
    YOURSELF (Read tool) before claiming seams are gone; describe what you see. Also shoot
    one boat via the existing boats preview if one exists (grep client/*.html for preview-)
    to prove the rigid path is unchanged — a before/after pixel diff if cheap.
D4. docs/model-assets.md: the rigidify section becomes "rigid or smooth" — when to use each.
    Do not touch docs/DESIGN.md or docs/decisions/.
D5. Report at .claude/orchestration/briefs/assets-p4-report.md: what changed with file:line;
    the shader diff; the CPU-skin order verified against three's source with line cites;
    measured envelope numbers before/after; shot paths; draw-call count from the shot
    (window.__previewDrawCalls) before/after; anything you assumed, labelled "Assumption:".

## Rules

- Blender runs on Windows through .model-import/blender.sh — read it; paths are E:\ style.
- Never start or stop the game server/client (a static preview http.server on a scratch port
  is fine; kill only your own pid, recorded to a file — never `pkill -f`).
- `git add` exact paths only. Conventional commits, no attribution lines.
- Another session works on fish/whales in plugins/wildlife/client/species/{fish,ray,shark,
  eel,angelfish}.ts and tools/blender/build_*.py — do not touch those files. Keep
  assetSpecies.ts edits minimal and additive so its merge stays clean.
