# Brief: fish+whales → Blender pass 1 — the wildlife GLB adapter + the shallow fish

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TypeScript strict, three 0.185.1,
SolidJS client, Node 24 server). You run in your own git worktree (the harness created it;
`pwd` to find it). Commit to the worktree branch, conventional messages, no attribution.
Do not merge, do not push, never touch the main checkout directly. When done, call
ExitWorktree with action "keep".

Owner decision (2026-09-04): every fish and whale in plugins/wildlife becomes a Blender-built
GLB asset, one species per pass. This pass is the FIRST and lands two things:
  (A) the asset-sourced species path in the wildlife plugin (GitHub #321's "2D rigged family"),
  (B) the shallow fish (`fish`) as the first asset through it.
Later passes (shark, ray, eel, angelfish, three whales, deepsea) must be model-only, so (A) is
the contract and must not be fish-shaped.

## Read first — verify every claim against code; comments are claims, not evidence.
Cite file:line from executed code in your report.
1. docs/model-assets.md — the GLB convention (cells as units, +X forward, Y up, named nodes,
   anchors as Empties, one material per mesh, Blender export flags).
2. client/src/render/rigAsset.ts (whole) — loadRigAsset (browser) / parseRigAsset (Node),
   node(), anchor(), dispose().
3. client/src/render/rigSkin.ts ~L1–60, ~L213–330 — bakeRig: a Group/Empty per joint, a Mesh
   per part rigidly bound under its node; blueprint.dispose. "blueprint.dispose() BEFORE
   asset.dispose()" is the documented order; confirm why from the code.
4. plugins/boats/client/models.ts — installBoatKit / preloadBoatModels / disposeBoatKit /
   createBoatModels: the shipped pattern for preload → asset → bakeRig → jointIndex. And
   plugins/boats/client/index.ts L190 (the plugin `preload` hook), client/src/plugins/types.ts
   ~L660–690 (host contract: preload awaited before attach; a rejecting preload is a logged
   breach for that plugin only).
5. plugins/wildlife/client/species/speciesModel.ts — SpeciesModelPool / AuthoredSpecies /
   SpeciesModelBuilder, the contract every procedural species is authored against.
6. plugins/wildlife/client/models.ts — createWildlifeModels: keepGeometry/lambert pools,
   rigged(), bakeSpecies (~L375), herdFor, drawInto, the species switch (~L593), dispose.
7. plugins/wildlife/client/species/fish.ts (whole) — the fish you replace: FISH_ENVELOPE,
   FISH_TAIL_HZ, FISH_TAIL_SWING_RADIANS, the hinge layout (tail Group at the peduncle,
   pectoral hinges on the flank), and `animate`. plugins/wildlife/client/placement.ts
   SWIM_PROFILES.fish reads FISH_ENVELOPE — find every reader of FISH_ENVELOPE.
8. plugins/wildlife/client/index.ts — attach builds the models (L304–322); there is no
   preload yet. WILDLIFE_SIZE_MODEL_SCALE: size classes are a scale on the rig, never
   separate models.
9. plugins/wildlife/test/client.test.ts and test/support — how the client models are built
   under Node today (no browser, no HTTP). Boats' tests show how an asset is fed from disk.
10. tools/blender/build_war_boat.py, export_glb.py, render_war_boat.py, stat_glb.py — the
    build-not-download pattern, export flags, and the 4-view render check.
11. plugins/wildlife/.verify-closed.mts if present — the vertex-inside attachment parity
    check the owner requires for "nothing floating" (see memory rule below).

Blender 5.2: "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background
--python <script> -- <args>. Paths passed INTO Blender are Windows paths (`wslpath -w`).

## Deliverables

### A. The adapter (contract layer, not fish-specific)
- A wildlife `preload(ctx)` that loads the species assets the plugin ships (this pass: one,
  `assets/fish.glb` via `.glb?url`, following boats' d.ts/vite pattern) and installs them;
  `createWildlifeModels` consumes installed assets; `dispose` order: blueprint before asset.
  Under Node (tests) the same install path is fed from disk via parseRigAsset — one install
  function, two feeders, like boats.
- An asset-sourced species builder that yields the SAME `AuthoredSpecies` shape the procedural
  files do (root, named joints incl. `rig`, animate), so models.ts's bakeSpecies/herdFor/
  drawInto do not change. Decide and document the split: the asset supplies tree + joints
  (nodes addressed BY NAME from the GLB), the species .ts supplies the envelope check, the
  joint-name list, and `animate`. Pool geometry/material ownership: asset-owned buffers are
  NOT registered with keepGeometry (asset.dispose frees them) — state exactly who frees what.
- Envelope from the asset, not restated: anchors `nose`, `tail_tip`, `crown`, `belly` (and
  a half-width measure — either anchor `flank` or measured from the bake's bounds) are read at
  install and ASSERTED against the species' declared envelope constants with a stated
  tolerance; a mismatch throws naming the file. FISH_ENVELOPE stays the placement contract.
- A joint-name convention for swimmers written down once (in docs/model-assets.md, a
  "Wildlife species" section): `rig` (whole body), `tail` (Empty at the peduncle, caudal mesh
  under it), `pectoral_port`, `pectoral_starboard` (Empties at the flank root). Missing
  required joint → throws at install naming file + joint.

### B. The fish
- `tools/blender/build_fish.py`: builds the shallow fish in Blender and exports
  `plugins/wildlife/client/assets/fish.glb`. Built, not downloaded. Read the CURRENT fish.ts
  for proportions/colours (warm orange body 0xe8a13c, lighter fins 0xf3c46e, dark eyes) and
  its envelope — the GLB must measure the same FISH_ENVELOPE (length, crownY, bellyY,
  halfWidth) within the tolerance you assert. Higher fidelity than the procedural one is the
  point (owner's fidelity bar: this is a real model, not a blob): smooth laterally-compressed
  body, forked caudal, soft dorsal, anal, paired pectorals, eyes, a gill line and a lateral
  line are welcome. Materials: flat colour or a small generated baseColor texture (the war
  boat's stripe pattern shows how); NO PBR maps beyond colour/roughness (render kit does not
  read them yet — #318).
- Nothing floating: every fin must share vertices with / penetrate the body; run the
  vertex-inside parity check (item 11) or an equivalent in build_fish.py's checks and PRINT
  the result.
- The fish .ts keeps `animate` (tail yaw about the peduncle, head counter-yaw, pectoral
  flutter, the SAME constants) driving the asset's joints. The procedural body code goes;
  if a helper (whaleHull.ts etc.) loses its last user, say so — do not delete shared code
  other species still use.
- `tools/blender/render_glb.py` (generalise render_war_boat.py to take any glb + out dir,
  or add a species preset) — 4 views at 512px into tools/blender/out/ (uncommitted).
  Also `stat_glb.py` output for fish.glb: node names, mesh count, materials, bounds.
- drawBudget: the wildlife plugin's draw budget must account for the fish's
  `blueprint.surfaceCount`; report the old vs new count.

### C. Verification (report each with the command and its output)
- `pnpm typecheck` at root.
- `timeout 240 npx vitest run` inside plugins/wildlife ONLY (and plugins/boats if you touched
  shared render code — you should not need to). Never run whole-workspace tests.
- Blender build log, the 4 renders (paths), stat_glb output, envelope assertion passing,
  attachment check output.
- Tests: NO new test files this session (owner's per-session rule; not granted). If an
  existing assertion encodes the old procedural fish (e.g. counts geometries), change the
  minimum and list it in the report.

## Constraints
- 140 fps benchmark: draw calls are the cost. One material per mesh; merge what shares a
  material; report surfaceCount.
- Determinism: nothing in shared/. Client-only + tools.
- Comments: verbose on the contract (who owns/frees what, why the order), moderate elsewhere.
  No magic numbers — every dimension in build_fish.py is a named constant with a reason.
- Do not touch other species files beyond what the adapter requires.
- Do not start or stop the app (server/client). In-game eyes-on is the orchestrator's step.
- Report: write .claude/orchestration/briefs/fish-glb-pass1-report.md in the worktree:
  what landed (file:line), the adapter split you chose and 2 alternatives rejected, the
  ownership/dispose table, envelope numbers measured vs declared, surfaceCount old/new,
  verification outputs, anything left undone and why.
