# Model assets everywhere — plan (owner decision 2026-09-04)

Owner, 2026-09-04: "I want everything to have the ability to have textures and
external assets. I want the ability to import real, actual, attractive models as
assets." This resolves GitHub #93 (procedural vs DCC+glTF): the pipeline is the
default for every plugin; procedural builders stay legal but are no longer the rule.
The "no textures / no external assets" rules in plugin headers (flora/models.ts,
structures/models.ts, monsters/geometry.ts, cthulhu.ts, kraken.ts) are superseded.
Owner 2026-09-04: no DESIGN.md entry needed. docs/decisions untouched unless asked.

Arc label: `arc/model-assets-glb-loader`. Tracker: GitHub Issues, Cujuju/Terrace.

## What already exists (verified 2026-09-04 from source)

- `client/src/render/rigAsset.ts` — generic GLB loader (browser + Node paths),
  validates: ≥1 mesh, single material per mesh, `uv` present under map/emissiveMap,
  sRGB on colour maps, mipmaps+anisotropy (RIG_TEXTURE_ANISOTROPY=4), node()/anchor()/dispose().
- `client/src/render/rigSkin.ts` — bakeRig/instantiateRig. materialSignature keys on
  map + emissiveMap identity only (lines ~103–135); stripUnbakeableAttributes keeps
  `uv` only for map/emissiveMap and always deletes uv1..3 + tangent (~450–466);
  blueprint.dispose frees map + emissiveMap only (~321–323). SkinnedMesh passes
  isDrawableMesh (isMesh true) and would bake WRONG (bind pose, no joints).
- `client/src/render/rigHerd.ts` — instanced herds from a blueprint (pose palette).
- Plugin `preload(ctx)` hook (client/src/plugins/types.ts ~681) awaited before attach.
- Static family contract: `plugins/structures/client/parts.ts` StructurePart =
  {geometry, material, localMatrices}; own materialSignature (keeps colour).
- Blender 5.2 at "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe";
  tools/blender/{export_glb.py, build_war_boat.py, render_war_boat.py, stat_glb.py}.
- `*.glb?url` ambient declaration duplicated: plugins/boats/client/glb-url.d.ts and
  client/src/vite-env.d.ts. vite.config.ts assetsInclude covers **/*.glb already.
- three 0.185.1. aoMap/lightMap sample `texture.channel` (default 1 → `uv1`).
- Lighting: hemisphere + directional sun, ACES tone mapping, sRGB output. No
  environment map → metallic PBR surfaces will read dark; roughness-dominant
  assets are fine. (Env map is a possible phase-3 item, not assumed.)

## Two consumer families, one loader, two adapters

| Family | Plugins | Consumes | Adapter |
|---|---|---|---|
| Rigged (animated, pivots) | boats, wildlife, monsters, pilgrims | bakeRig(root) → blueprint → instantiateRig / createRigHerd | preload → RigAsset → bakeRig(asset.scene); joints = named Empties |
| Static instanced | structures, flora, temples, relics, crops | StructurePart[] → InstancedMesh per part | preload → RigAsset → flattenAssetParts(asset) → parts |

## Phases (two Opus agents at a time, each in its own worktree; orchestrator reviews and merges)

### Phase 1 — contracts (parallel, disjoint paths)
- **1A render kit PBR-complete** (client/src/render/**, plugins/boats/client/models.ts, d.ts consolidation)
  brief: briefs/assets-p1-render-kit.md
- **1B Blender import/normalize tool + docs** (tools/blender/**, docs/model-assets.md)
  brief: briefs/assets-p1-blender-import.md

### Phase 2 — adapters + first real assets (parallel)
- **2C static family**: `client/src/render/staticAsset.ts` flattenAssetParts; structures'
  tier table accepts asset parts; parts.ts signature uses the shared map helper; one
  real CC0 building (or tree for flora) through preload, fit-checked against
  STRUCTURE_FOOTPRINT_RADIUS; preview harness shot.
- **2D rigged family**: wildlife `SpeciesModelBuilder` gains an asset-sourced variant
  (pool skips asset-owned buffers; asset.dispose after blueprint); wildlife/monsters/
  pilgrims get `preload`; one real CC0 rigidified creature as a species; herd path proven.

### Phase 3 — eyes-on + rules
- In-game screenshots (agent-owned stack, see glb-eyes-on brief for the recipe),
  Artifact page for owner; header rule text updated in the five files; docs/decisions
  entry (owner permission); drawBudget entries recounted from blueprint.surfaceCount.

## Standing constraints for every brief
- Tests: owner permission granted 2026-09-04 for THIN, SIMPLE, CONTRACT-LEVEL tests only
  (one small file per contract module; no per-callsite tests; no large fixtures).
  Existing tests must pass; if an existing assertion encodes the OLD contract, change
  the minimum and list it in the report.
- Never run whole-workspace tests. `pnpm typecheck` at root; `timeout 240 npx vitest run`
  inside the touched package only.
- Comments are claims, not evidence: cite file:line from executed code.
- Determinism: nothing here touches shared/. Client-only.
- 140 fps benchmark: the draw-call count is the cost, not triangles. Every asset's
  cost is `blueprint.surfaceCount` (rigged) or parts.length (static) and must be
  reported; a plugin's drawBudget must account for it.
- Licenses: CC0 only for downloaded models; record source URL + license per asset in
  an `assets/LICENSES.md` beside the .glb. Never commit source downloads (fbx/blend/zip).
- Commit on the worktree branch, conventional message, no attribution. Do not merge, do not push.

## Review checklist (orchestrator, per phase)
1. `git diff main...<branch> --stat` matches the brief's path scope.
2. `pnpm typecheck` clean on the branch; touched-package vitest green with timeout.
3. Every new number is a named constant with a justification comment.
4. Texture disposal: grep that every map slot in the shared slot list is disposed in
   BOTH rigAsset.dispose and blueprint.dispose (one helper, two callers).
5. Eyes-on: PNGs viewed by the orchestrator before merge (memory: visual work needs eyes).
6. Merge to main on the shared checkout only after 1–5; note other agents'
   uncommitted paths (plugins/flora/server, plugins/structures/server) are untouched.

## Status 2026-09-04 (orchestrator)
- Phase 1 merged: 1A 7a6eced (#318 closed), 1B a7a2672 (#319 closed).
- Phase 2 merged: 2C 905c939 (#320 closed), 2D 912f92c (#321 closed). Both were rebased onto a
  fast-moving main first; the wildlife adapter was UNIFIED onto the fish/whales session's
  assetSpecies.ts (pass 1, 36c9e41) rather than kept as a second contract.
- Decision (orchestrator, from evidence): asset units are WORLD units; render-kit names renamed
  (AssetFootprint, ASSET_FIT_TOLERANCE_WORLD_UNITS); docs and fish/whales checklist updated.
- Residual filed: #328 rigid-binding seams on imported skinned creatures → carry real skin weights.
- Phase 3 running: briefs/assets-p3-eyes-on-and-rules.md (#322).
- Lesson recorded in memory: shared-checkout merge race (check HEAD/dirty overlap in the same
  command as the merge; recover with read-tree HEAD).
