# Brief: skiff GLB, phase 2 — load skiff.glb into the structures plugin (GH #317)

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TS strict, three.js client, Node 24 server via type stripping).
Work ONLY in the arc worktree (already exists, phase 1 committed there):
  /mnt/e/Development/Projects/Terrace/.claude/worktrees/skiff-glb-models   (branch skiff-glb-models)
Never edit or run git against the main checkout. Commit to branch skiff-glb-models. Do not push. Do not merge.
Comments are claims, not evidence: verify from executed code and cite file:line in your report.
Do not add or write tests (owner rule; no permission this session). Do not install dependencies.
Never start the app (server or client) in this phase — phase 3 does eyes-on.

## Context
Phase 1 committed plugins/structures/client/assets/skiff.glb (one mesh `skiff`, one material, vertex colours,
forward +X, origin at keel bottom, Empty `waterline`) plus tools/blender/build_skiff.py. Read its report first:
  /mnt/e/Development/Projects/Terrace/.claude/orchestration/briefs/skiff-p1-report.md
(measured envelope, waterline.y, tri count).

Read next:
- plugins/structures/client/skiffModels.ts (whole file) — the InstancedMesh fleet to convert.
- plugins/structures/client/index.ts:100-175 — attach(), drawBudget, SKIFF_SURFACE_DRAW_OBJECTS.
- client/src/render/rigAsset.ts — loadRigAsset / RigAsset (scene, node(), anchor(), dispose()).
- plugins/boats/client/index.ts:27,186-192 and plugins/boats/client/models.ts:200-262 — the war boat's
  preload → installBoatKit pattern (`.glb?url` import, glb-url.d.ts ambient declaration, fit check, measured shape).
- client/src/plugins/types.ts:665-681 — the host's preload contract; client/src/plugins/host.ts:594-600, 844-860 for
  how attach waits on preload.
- client/vite.config.ts:118-122 (assetsInclude for .glb already covers this plugin).

## The change (keep it small; this is a swap of geometry source, not a redesign)
1. Structures plugin gets `preload(ctx)`: `import skiffUrl from './assets/skiff.glb?url'` (copy plugins/boats/client/
   glb-url.d.ts into plugins/structures/client/ if this package's tsconfig needs it — check, do not assume) and
   `installSkiffKit(await loadRigAsset(skiffUrl))` in skiffModels.ts, mirroring installBoatKit's shape: a module-level
   kit that createSkiffModels() requires (throw with a clear message if not installed — attach only runs after preload
   per host.ts, so this is a guard, cite the lines).
2. installSkiffKit measures, before assigning anything:
   - `waterline` anchor → SKIFF_WATERLINE_LIFT (= -waterline.y): the instance's Y becomes SKIFF_FLOAT_WORLD_Y + lift + bob.
     Replace the old `offset.y = hullHeight/2` placement, which sat the box ON the surface.
   - Fit check against the envelope skiffModels.ts already implies (the placement cell cannot grow): Box3 of the scene
     x ≤ 0.36 + tol, z ≤ 0.14 + tol, with a named tolerance constant justified like BOAT_FIT_TOLERANCE_CELLS. Throw
     naming the file on failure (no silent fallback).
   - The single mesh's geometry and its vertex-colour attribute. The asset is +X-forward; the existing writeFrame yaw
     math assumes the hull runs along local +Z (skiffModels.ts, "hull's length runs along local +Z"). Bake the
     conversion ONCE at install with `geometry.rotateY(...)` (work out the sign so the bow faces the direction of travel;
     state the derivation), so the per-frame matrix code is untouched. Do NOT change the per-frame math.
3. ONE InstancedMesh (was two parts). Material: `MeshLambertMaterial({ vertexColors: true, flatShading: true })` for
   parity with every other structures mesh (models.ts) — do not use the loader's MeshStandardMaterial; dispose the
   loader's material via asset.dispose() at plugin dispose (after the InstancedMesh is disposed — see RigAsset.dispose's
   doc on ordering). Keep the instance capacity, update-range upload, and the DERIVED bounding sphere; replace
   partReachWorldUnits with the single geometry's computeBoundingSphere() reach (center length + radius) computed once
   at install. Delete SkiffPart / localOffsets / buildSkiffParts and the box colour constants that no longer exist
   (constants that still encode a decision stay). Update the file banner where it describes boxes / two parts.
4. index.ts: SKIFF_SURFACE_DRAW_OBJECTS 2 → 1 with its comment; add preload.
5. Preserve the global rule "clients send intents, never heights" — nothing here talks to the server.

## Verify (all from the worktree root)
- `pnpm typecheck` (whole workspace) passes.
- `cd plugins/structures && timeout 240 npx vitest run` passes; `cd client && timeout 240 npx vitest run test/rigAsset.test.ts test/pluginPreload.test.ts` passes.
- Diff review of your own change for: magic numbers, stale comments, any `any`.
Commit (conventional, e.g. `feat(structures): skiffs draw the authored GLB through one InstancedMesh`; no attribution, no footers).

## Final report (short)
Commit hash; the yaw-conversion derivation (one paragraph); SKIFF_WATERLINE_LIFT value; fit tolerance chosen and why;
draw-object count change; test/typecheck output tails; anything unverified, stated as such.
