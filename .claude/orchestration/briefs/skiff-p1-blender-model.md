# Brief: skiff GLB, phase 1 — build the model in Blender (GH #317)

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TS strict, three.js client).
Work ONLY in the arc worktree, already created for you:
  /mnt/e/Development/Projects/Terrace/.claude/worktrees/skiff-glb-models   (branch skiff-glb-models)
Never edit or run git against the main checkout. Commit to branch skiff-glb-models. Do not push. Do not merge.
Comments are claims, not evidence: verify from executed code and cite file:line in your report.
Do not add or write tests (owner rule; no permission this session). Do not install dependencies.

## Goal
The structures plugin's skiffs are BoxGeometry slabs (plugins/structures/client/skiffModels.ts, buildSkiffParts).
Beside the modelled GLB war boat they read as brown boxes. Phase 1 = author a small rowing skiff as a
GLB through the existing Blender pipeline. Phase 2 (a different agent) wires it into the plugin. You do NOT
touch any .ts file in this phase.

Read first, in this order:
1. docs/model-assets.md — the authoring convention (Y up, forward = +X, origin on the centreline at the keel,
   one material per mesh, apply transforms, GLB with embedded images).
2. tools/blender/build_war_boat.py — the pattern: an analytic/traced build script with LOUD asserts, outward
   winding, Solidify on the loft skin, empties as anchors, transform_apply per object, then export_scene.gltf.
   Also tools/blender/render_war_boat.py (4 Cycles check renders) and tools/blender/stat_glb.py (re-import stats).
3. plugins/structures/client/skiffModels.ts — the CURRENT skiff: hull 0.36 long x 0.14 beam x 0.06 tall (world
   units), hull length along local +Z, one thwart; colours SKIFF_HULL_COLOR 0x6b4a30, SKIFF_THWART_COLOR 0x4a3220.
4. plugins/boats/client/models.ts lines 130-134 and 226-262 — how the war boat asset is measured and fit-checked
   at load (Box3 of the scene vs a budget + BOAT_FIT_TOLERANCE_CELLS = 0.02). The skiff will get the same kind of
   check in phase 2 against the envelope below.
5. .boat-ref/ (read-only reference): a traced Gokstad hull (build.py, out/mesh.json, REPORT.md). A skiff is a
   different, simpler boat — you may borrow the station-loft approach, not the plan shape.

## Units — IMPORTANT, verify before building
The war boat is authored at 0.9 units long and rendered at the identity transform, and plugins/boats/client/index.ts:125-132
converts CELL coordinates to world by CELL_WORLD_SIZE (= 1/4, shared/src/constants.ts:33,50). So one authoring unit is
ONE WORLD UNIT (= 4 cells), even though docs/model-assets.md says "1 unit = 1 cell" — that line predates the quarter-cell
re-sample. Do not "fix" the doc in this phase; just note it in your report. Author the skiff in world units.

## What to build: tools/blender/build_skiff.py (new) → plugins/structures/client/assets/skiff.glb (new)
A small open rowing boat, clearly a smaller cousin of the war boat (same wood palette family), that reads at the
game's orbit camera (~55° down, 6+ world units away, see render_war_boat.py's "game" view).

Hard constraints:
- ENVELOPE, never exceeded (the placement cell can't grow): bounding box x-length ≤ 0.36, z-beam ≤ 0.14, any height
  ≤ 0.12 (world units). Assert these in the build script after the loft; print the measured box.
- ONE mesh object named `skiff`, ONE material, NO texture: use a vertex-colour attribute (COLOR_0 on export) to
  separate hull planking / thwarts / gunwale rail / keel. Reason: phase 2 draws up to 1 536 instances through a single
  InstancedMesh with one geometry and one material; a textured hull would force a second draw path and a UV check.
  Verify after export (stat_glb.py-style re-import) that the mesh carries a colour attribute and exactly one material.
- Forward = +X (bow at +X), Y up, origin on the centreline at the keel bottom (the lowest hull point is y = 0).
- Anchor Empty `waterline` on the centreline at the height the sea surface should cut the hull (roughly 45-55% of
  the side depth, so the boat sits IN the water, not on it). Phase 2 lifts the instance by -waterline.y.
- Solid geometry: the hull skin gets Solidify (like the war boat) or is modelled with thickness, so from above the
  far wall does not backface-cull into a see-through boat. Interior visible: it is an open boat — a floor/thwarts
  inside, no deck.
- Triangle budget ≤ 300 tris after export (print it). Worst case 1 536 instances; typical world floats a few dozen.
- Flat shading (use_smooth False), like the war boat.
- All numbers named constants at the top of the script with a one-line reason each; no magic numbers in the body.
- Winding: outward normals, verified numerically (reuse the flip_to_outward pattern ONLY where the reference point is
  genuinely inside the part; closed boxes/cylinders keep analytic winding).

Shape suggestions (your call, but state the choice): 9-11 stations, a gentle sheer rising to stem and transom or
double-ended, two thwarts, a short keel strip, gunwale rails as ribbons, optionally two shipped oars laid inboard
(inside the envelope!). No mast, no sail.

Run headless from WSL (Windows paths INSIDE the args):
  "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background --python <worktree>/tools/blender/build_skiff.py -- E:\Development\Projects\Terrace\.claude\worktrees\skiff-glb-models\plugins\structures\client\assets\skiff.glb
(Blender 5.2.1 is installed there; export_scene.gltf with export_yup=True, export_apply=True, export_colors / vertex
colour export flag — check the 5.2 operator's parameter name for vertex colours and set it explicitly.)

## Checks and renders (deliverables, not committed except where noted)
1. tools/blender/stat_glb.py on the exported file: node list, tri count, material count, colour attribute present.
2. A render script tools/blender/render_skiff.py (commit it; copy render_war_boat.py's four views, sized for a 0.36
   boat) → PNGs under <worktree>/.skiff-shots/ (do NOT commit PNGs; do not write under ~ or the session scratchpad).
   Add a fifth view with the war boat GLB (plugins/boats/client/assets/war-boat.glb) placed 0.8 units alongside for
   scale comparison. LOOK at every PNG yourself (Read tool) before reporting; fix what looks wrong (see-through hull,
   inverted normals as black faces, boat not sitting on the waterline, proportions off).
3. Node-side parse check without adding a test file: a one-off script under <worktree>/.skiff-shots/parse.mjs that
   reads the .glb bytes and calls parseRigAsset from client/src/render/rigAsset.ts (see plugins/boats/test/models.test.ts
   for how the war boat file is parsed in node — reuse its imports/setup verbatim), then prints the Box3 size, the
   `waterline` anchor, mesh count, material count, and whether geometry has a `color` attribute. Run it with the
   same runner that test uses (check that test's package.json / vitest config; if only vitest can run it, run it as
   an ad-hoc `npx vitest run <path>` with a timeout ≤ 240 s and delete nothing).

Commit: build_skiff.py, render_skiff.py, skiff.glb (conventional message, e.g. `feat(structures): authored skiff GLB`,
no attribution, no footers). Then `pnpm typecheck` from the worktree root must still pass (you touched no TS, prove it).

## Final report (short, absolute paths)
- Commit hash; measured envelope (x, y, z); waterline.y; tri count; material count; colour attribute yes/no.
- Absolute paths to the PNGs with one line each on what they show and any defect you saw and fixed.
- The units observation from docs/model-assets.md.
- Anything you could not verify, stated as such.
