# Brief 1B: Blender import/normalize tool for real third-party models

Repo: /mnt/e/Development/Projects/Terrace. You run in your own git worktree (the harness created
it; `pwd` to find it). Commit to the worktree branch. Do not merge, do not push, never touch the
main checkout directly. When done, call ExitWorktree with action "keep".

Owner decision (2026-09-04): the game must be able to import "real, actual, attractive" models
(downloaded PBR glTF/FBX/OBJ/.blend) as assets for every plugin. The runtime loader
(client/src/render/rigAsset.ts) enforces a convention and rejects anything else; a downloaded
model never matches it. Your job is the offline tool that turns an arbitrary model into a
conforming .glb, plus the stat/render tools that let a reviewer verify one without opening
Blender, plus the generalised convention doc.

Read first (verify claims against code, cite file:line in the report):
1. docs/model-assets.md — the current convention (boat-specific wording).
2. tools/blender/export_glb.py, build_war_boat.py, render_war_boat.py, stat_glb.py.
3. client/src/render/rigAsset.ts — what the loader rejects (multi-material meshes, missing uv
   under a textured material, no meshes). Another agent is adding in parallel: rejection of
   armatures/SkinnedMesh, support for the full PBR map set (normal/roughness/metalness/ao/
   emissive/alpha), and a footprint fit check `assertAssetFits(asset, {x, z, y?}, tolerance)`.
   Design your output to satisfy those.
4. client/src/render/rigSkin.ts ~L1–60 and ~L213–300 — how a rig is baked: a Group/Empty per
   joint, a Mesh per part rigidly bound to the node it sits under. That is the ONLY animation
   model; armatures are not consumed.
5. plugins/wildlife/client/species/speciesModel.ts and plugins/boats/client/models.ts
   OAR_PIVOTS — how plugins address joints (by node name).

Blender: "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background
--python <script> -- <args>. Paths passed INTO Blender must be Windows paths (`wslpath -w`).
The existing scripts show the pattern. Network is available (curl to kenney.nl and
raw.githubusercontent.com returned 200/301 on 2026-09-04).

## Deliverables

### D1 — tools/blender/import_model.py
`import_model.py -- <source> <out.glb> [options]`, source = .glb/.gltf/.fbx/.obj/.blend.
Normalisation steps, each a small function with a docstring saying WHY:
- Import; delete cameras, lights, and non-mesh/non-empty/non-armature objects.
- `--forward {+X,-X,+Y,-Y,+Z,-Z}` (source's forward axis) and `--up` if not +Z-in-Blender:
  rotate the whole model so forward = +X in the exported (Y-up) file.
- `--footprint X Z` in cells and optional `--height H`: uniform-scale so the bounding box fits
  (largest ratio wins); never non-uniform. Print the resulting size.
- `--origin {ground,centre}`: recentre so the origin is the footprint centre at min-Y
  (ground; walkers, buildings, boats' keel) or the bbox centre (swimmers/fliers).
- Split every multi-material mesh into one object per material (bpy.ops.mesh.separate
  type='MATERIAL'), then apply rotation+scale into mesh data (location kept, as export_glb.py
  does and for the same reason: an Empty's position IS the anchor).
- `--rigidify`: if the model has an armature, convert it to the pivot convention: for each
  bone create an Empty named after the bone at the bone head, oriented like the bone,
  parented to its parent bone's Empty; split each skinned mesh by DOMINANT vertex-group
  weight (each vertex goes with the bone it weighs most on) into one mesh object per bone,
  parented under that bone's Empty; remove the armature and armature modifiers. Print a
  table: bone → vertex count. Without `--rigidify`, an armature is a hard error naming the
  flag. (Rigid split is the correct binding for the game's bake — rigSkin binds every vertex
  weight 1.0 to one node — so no information the bake could use is lost.)
- `--rename OLD=NEW` (repeatable) and `--anchor NAME=x,y,z` (repeatable; adds an Empty in
  the OUTPUT frame, after scaling/recentring).
- `--max-texture N`: downscale any image larger than N px on its long side (in place in
  Blender, before export). Default: no resize; print every image's size and colour space.
  Colour images (baseColor, emissive) must export sRGB; data maps (normal, roughness/
  metallic, occlusion) non-colour. Verify Blender's glTF exporter does this by default and
  cite where you checked.
- Export via the same call export_glb.py makes (reuse it: import its function or factor a
  shared `export_scene_glb(out_path)` both scripts call — do not copy the block).
- End with a stats block (same format as D2 so they can be diffed).

### D2 — tools/blender/stat_glb.py extended (keep existing behaviour)
Print: bounding box in cells (x, y, z), min-Y, mesh count, per-mesh: name, tri count,
material name, uv layers present; materials: which PBR slots are set; images: name, size,
colour space; Empties: name, position; armature/skinned: yes/no. Add `--footprint X Z
[--height H] [--tolerance T]` that exits non-zero when the box exceeds it — this is the
reviewer's check and must match the runtime rule (fit within footprint + tolerance; the
runtime tolerance is 0.02 cells today, in plugins/boats/client/models.ts; reference the
constant's home in a comment so they cannot drift silently).

### D3 — tools/blender/render_glb.py (generalise render_war_boat.py)
`render_glb.py -- <in.glb> <out_dir> [--views iso,side,front,top] [--ground|--water]`
Renders PNGs with the same neutral studio setup the war-boat renderer uses. Keep
render_war_boat.py working (it may become a thin wrapper).

### D4 — prove it on two real CC0 models
Download into /mnt/e/Development/Projects/Terrace/.model-import/src/ (a project dot-dir; NOT
~ and NOT the session scratchpad; never commit sources). Candidates (verify licence on the
page you download from; CC0 only):
- static: a Kenney kit building or tree (kenney.nl, CC0), or a Poly Haven model (CC0).
- rigged: a Quaternius animated animal (quaternius.com, CC0) — these ship with armatures,
  which is exactly the rigidify case. If Quaternius is unreachable, any CC0 armature-rigged
  low-poly animal.
Run import_model.py on each with sensible footprints (a building: footprint 1×1 cell, origin
ground; an animal: footprint ~0.8×0.8, origin ground, --rigidify), then stat_glb.py with the
footprint check, then render_glb.py. Outputs to .model-import/out/<name>.glb and
.model-import/shots/<name>_{iso,side,top}.png. Write .model-import/LICENSES.md with source
URL, author, licence per model. Do NOT commit anything under .model-import (it is a
scratch dir; add it to .gitignore if not already ignored).

Then prove the OUTPUT loads in the game's loader: a Node script under .model-import/ that
reads the .glb bytes and calls `parseRigAsset` from client/src/render/rigAsset.ts (see
client/test/rigAsset.test.ts or plugins/boats/test/models.test.ts for how tests do it —
node --experimental-strip-types or the project's vitest env). It must not throw. If it
throws for a reason the tool should have prevented, fix the tool.

### D5 — docs/model-assets.md generalised
Rewrite everything EXCEPT the "Materials" section (another agent owns it) so it describes
the convention for ANY asset: units/axes/origin per family (rigged walker: feet; swimmer/
flier: body centre; boat: keel; static: ground centre), footprint in cells, pivots as
Empties (never armatures), anchors as Empties, naming, and the tool flow
import_model.py → stat_glb.py → render_glb.py → plugin preload. Keep the boat as the worked
example. Add a short "Sources and licences" section: CC0 only, LICENSES.md beside the asset.

## Rules
- Python: moderate comments, functions small, no magic numbers (name every default).
- Do not write tests (owner rule). Verification is D4's runs; paste their stat output.
- Keep the diff to tools/blender/**, docs/model-assets.md, .gitignore. No TypeScript changes.
- Do not delete existing comments; update them where they became false.
- Commit conventional (`feat(tools): …`), no attribution/footers. Do not merge or push.

## Report (short, cite file:line)
- Commit hash(es), branch.
- The two models: URL, licence, source triangle/material/texture counts → output counts,
  footprint result, rigidify table for the animal.
- Absolute PNG paths (the orchestrator will view them).
- parseRigAsset result for both outputs.
- Anything the brief got wrong or that the runtime loader must additionally accept.
