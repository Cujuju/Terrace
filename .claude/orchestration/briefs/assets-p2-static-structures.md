# Brief 2C: static-instanced adapter + first real building asset (structures)

Repo: /mnt/e/Development/Projects/Terrace. You run in your own git worktree (harness-created;
`pwd` and `git branch --show-current` first; use that root for every command). Commit on the
branch; do not merge or push; never edit the main checkout. GitHub issue: Cujuju/Terrace#320.

Owner decision 2026-09-04: every plugin may use textures and external model assets; the game
must be able to import real, attractive third-party models. Phase 1 landed on main:
- client/src/render/materialMaps.ts — SHADING_MAP_SLOTS, texturesOf, uvChannelsUsed,
  mapIdentitySignature, applyMapColourSpaces.
- client/src/render/rigAsset.ts — loadRigAsset/parseRigAsset (validating GLB loader),
  assertAssetFits(asset, {x, z, y?}, tolerance), ASSET_FIT_TOLERANCE_CELLS, armature rejection.
- tools/blender/import_model.py (normalise any model to the convention), stat_glb.py
  (--footprint check), render_glb.py (studio renders). docs/model-assets.md is the convention.
- types/glb-url.d.ts — `import url from './x.glb?url'` works in every package.
Boats is the worked example of the plugin side: plugins/boats/client/models.ts (preload →
installBoatKit → bake) and plugins/boats/client/index.ts `preload()`.

The STATIC family (structures, flora, temples, relics, crops) does not bake rigs. It draws
InstancedMesh per part from `StructurePart = {geometry, material, localMatrices}`
(plugins/structures/client/parts.ts:31). Your job: the adapter from a loaded asset to that
shape, at the render-kit layer, and one real building proving it end to end in structures.

Read first (verify every claim against code; cite file:line in the report):
1. plugins/structures/client/parts.ts — StructurePart, materialSignature (~L204, keeps colour),
   mergeSharedSurface (~L317), mergeParts (~L366), fitToRadius. Understand whether mergeParts
   bakes localMatrices into geometry and what it does with `uv`.
2. plugins/structures/client/models.ts — STRUCTURE_FOOTPRINT_RADIUS (~L151) and the comment
   above it (world units vs cells; STRUCTURE_SCALE_MAX), buildTierParts (~L683),
   createStructureModels (~L3027–3110: geometry/material disposal lists, InstancedMesh per
   part, capacity STRUCTURES_CAP × localMatrices.length), RACE_TINTS via setColorAt (~L2958,
   ~L3154, ~L3184), the tier table comment at the top of the file.
3. plugins/structures/client/index.ts — attach() creates the models (~L129–136); drawBudget.
4. plugins/structures/protocol.ts — STRUCTURE_TIER_COUNT, STRUCTURE_SCALE_MAX (L234),
   STRUCTURE_FOOTPRINT_SPAN_WORLD_UNITS (L260), cellsAcross (~L348).
5. client/src/render/rigAsset.ts, materialMaps.ts; plugins/boats/client/models.ts.
6. docs/model-assets.md; tools/blender/import_model.py header (flags).
7. client/scripts/shootSpeciesPreview.mjs + chromeHeadlessShell.mjs (screenshot rig for the
   preview harnesses; raw CDP, polls window.__previewReady).

## Deliverables

### D1 — client/src/render/staticAsset.ts (new)
`flattenAssetParts(asset: RigAsset, options?: { exclude?: readonly string[] }): AssetPart[]`
where `AssetPart = { geometry, material, localMatrices: Matrix4[] }` — structurally identical
to StructurePart (the render kit cannot import from a plugin; say so in a comment and keep
the field names identical so a StructurePart[] accepts it without a cast).
- One part per drawable mesh; localMatrices = [mesh.matrixWorld.clone()] (scene at identity,
  updateMatrixWorld(true) first). Meshes sharing one geometry object become ONE part with
  several matrices (that is what localMatrices is for).
- Do NOT bake matrices into geometry and do NOT merge here: structures' mergeParts already
  merges by material signature; the adapter's job is only the shape change. Reject
  multi-material meshes (rigAsset already does; assert, don't re-implement).
- Ownership: geometries/materials/textures belong to the asset; `asset.dispose()` frees
  them. Document that the consumer must NOT dispose them and must dispose its
  InstancedMeshes/merged copies BEFORE asset.dispose(). This is the same rule boats keeps
  (blueprint before asset).
- `exclude` names nodes to skip (an anchor Empty has no mesh anyway; this is for, e.g., a
  mesh the plugin draws separately).

### D2 — parts.ts materialSignature adopts the shared helper
Replace the hand-written map fields (if any) with `mapIdentitySignature(material)` from
materialMaps.ts, keep colour in the signature (that is structures' deliberate choice — read
the comment). Two parts with different normal maps must not merge; two with the same texture
set and colour must. mergeParts must keep `uv` (and uvN) when the material samples them —
verify with the flattened asset, fix if it strips.

### D3 — structures consumes an asset for one tier
- Add `preload()` to plugins/structures/client/index.ts that loads the building asset(s) via
  loadRigAsset (`.glb?url` import), asserts fit with assertAssetFits against the footprint:
  footprint x = z = 2 × STRUCTURE_FOOTPRINT_RADIUS, expressed in the unit assertAssetFits
  uses (cells) — read the STRUCTURE_FOOTPRINT_RADIUS comment and cellsAcross to get the
  unit right, and write the derivation as a named constant with the comment. Height: pick
  from the tallest procedural tier's height (read it) so an imported cottage never towers
  over the watchtower; name the constant.
- Replace ONE tier's procedural parts with `flattenAssetParts(asset)` — choose tier 4
  stone-cottage or tier 2 timber-house (whichever the model you find fits best; say why).
  The other tiers stay procedural. Keep buildTierParts' return contract (STRUCTURE_TIER_COUNT
  entries). The replaced tier's procedural builder stays in the file (do not delete code or
  comments; mark it as superseded by the asset in a comment).
- Disposal: createStructureModels currently pushes every part's geometry/material into its
  own dispose lists — asset-owned ones must not be double-freed. Fix at the contract:
  e.g. the tier builder returns parts plus an `owned: boolean`/owner handle, or the asset
  parts are tracked separately and asset.dispose() runs after the meshes are removed. Say
  which and why.
- Tint: RACE_TINTS multiplies via instanceColor. With a textured material the tint
  multiplies the texel — verify it still reads as a tint (screenshot both races) and that
  an untinted texture is not darkened (instanceColor default is black when lazily
  allocated — read ~L3184 and confirm the existing guard covers the new tier).
- drawBudget: recount for the plugin from the real merged part count of the asset tier and
  fix the constant/expression it derives from; report before/after.

### D4 — the asset
Find a CC0 low-poly house that reads as a stone cottage or timber house from an overhead
orbit camera (Kenney "Fantasy Town Kit"/"Medieval Town"/"Holiday Kit", Quaternius
"Medieval Village"/"Ultimate Modular…", or Poly Haven). Verify the licence on the download
page. Sources go to /mnt/e/Development/Projects/Terrace/.model-import/src/ (never commit).
Normalise with tools/blender/import_model.py (footprint as derived in D3, --origin ground,
forward +X, --max-texture 512 unless the texture is already ≤512), check with stat_glb.py
--footprint, render with render_glb.py. Commit ONLY the output .glb under
plugins/structures/client/assets/<name>.glb plus plugins/structures/client/assets/LICENSES.md
(source URL, author, licence, import command used). Keep the .glb under ~500 KB; say its size.

### D5 — eyes-on
There is no preview-structures harness. Either (a) add a tiny THROWAWAY one mirroring
client/preview-boats.html + previewBoats.ts (same lighting rig, `?tier=<n>&race=<rudy|uno>`,
raises window.__previewReady), or (b) run the in-game stack per
.claude/orchestration/briefs/glb-eyes-on-and-accessors.md Part B. (a) is enough for this
phase. Shoot with client/scripts/shootSpeciesPreview.mjs --page <your page>: iso, side, top,
both races, and one shot with a procedural tier beside the asset tier at the same scale so
the size relation is visible. PNGs to /mnt/e/Development/Projects/Terrace/.model-import/shots/structures/.

### D6 — tests (owner permission: thin, simple, contract-level only)
One file client/test/staticAsset.test.ts: (1) a scene with two meshes sharing one geometry
→ one part with two matrices; (2) matrices equal the meshes' world matrices; (3) exclude
skips a named mesh; (4) parts.ts mergeParts keeps two parts with different normal maps apart
and merges two identical-map parts (put in the structures test dir if one exists, else here).
No fixtures over a few KB (build scenes in memory).

## Rules
- Verify: `pnpm typecheck` (worktree root); `cd client && timeout 300 npx vitest run`;
  `cd plugins/structures && timeout 240 npx vitest run`. Never `pnpm -r test`.
- No magic numbers; every literal named with a one-line justification. Do not delete
  existing comments; update the ones you make false (e.g. "no textures, no external
  assets" in models.ts's header — owner superseded it 2026-09-04; rewrite that paragraph).
- Diff scope: client/src/render/staticAsset.ts, plugins/structures/** (client, test, assets),
  the preview harness files, client/test/staticAsset.test.ts. Nothing in wildlife/monsters.
- Commit conventional (`feat(structures): …`), no attribution/footers. Do not merge or push.

## Report (short; file:line for claims)
Commit hash + branch; asset URL/licence/size/tri count/material count; the tier chosen and
why; the D3 disposal design; drawBudget before → after; absolute PNG paths (orchestrator
views them); typecheck/vitest results; anything the brief got wrong.

## Notes from phase 1B (read before D4)
- import_model.py has `--drop NAME` for stray source nodes that would set the bbox; run
  stat_glb.py --footprint on the OUTPUT as the proof. A worked static example is
  .model-import/out/barrel.glb (Poly Haven Barrel_01, 3× 512² PBR textures) — useful to
  test flattenAssetParts before your building is ready, not as the shipped asset.
- Downscaled textures keep correct colour spaces (verified by 1B); use --max-texture 512.
