# Phase 2 report — skiff GLB into the structures plugin (agent skiff-p2, 2026-09-04)

Commit **858fbf7** on `skiff-glb-models` (worktree `.claude/worktrees/skiff-glb-models`).
Files: `plugins/structures/client/skiffModels.ts` (rewritten), `plugins/structures/client/index.ts`,
`plugins/structures/client/glb-url.d.ts` (new, copied from boats). Not pushed, not merged, no tests added,
app never started.

## Yaw-conversion derivation

`writeFrame` composes the instance matrix by hand in three's column-major order as
`elements[0]=yawCos, [2]=-yawSin, [8]=yawSin, [10]=yawCos` (skiffModels.ts:329-332) — element for element
`Matrix4.makeRotationY(yaw)`. Its third column `[8..10]` is where local **+Z** lands: `(sin yaw, 0, cos yaw)`.
The code sets `yawSin = dirSign*cos(angle)`, `yawCos = -dirSign*sin(angle)` (skiffModels.ts:324-325), which is
the unit tangent of the orbit, so local +Z *is* the direction of travel — the convention the old boxes were
built to (`hullLength` along Z). Under the same `makeRotationY(t)` the first column is where local **+X**
lands: `(cos t, 0, -sin t)`. Setting that equal to `+Z = (0,0,1)` gives `cos t = 0`, `-sin t = 1`, i.e.
**t = −π/2**. So `SKIFF_FORWARD_AXIS_YAW_RADIANS = -Math.PI/2`, baked once at install with
`geometry.rotateY(...)` (skiffModels.ts:112, 216); the per-frame math is byte-identical to before apart from
dropping the per-part offset terms.

Verified by execution, not by reading: a throwaway node script (`plugins/structures/.verify-skiff.mjs`, deleted
after use) parsed the real GLB, installed the kit, built the fleet, applied one placement and read instance 0's
matrix back — bow direction `(-1, 0, 0)`, finite-difference travel direction `(-1, 0, 0)`,
**dot(bow, travel) = 1**. The asset's bow vertex (x = +0.17097) measures at z = +0.17097 after the rotation.

## Numbers

| thing | value | source |
|---|---|---|
| `waterline` anchor y | 0.0392731 | `asset.anchor('waterline')`, executed |
| **SKIFF_WATERLINE_LIFT** | **−0.0392731** (`waterlineLift = -waterline.y`, skiffModels.ts:220) | executed: instance origin y = −0.0392731, so the authored waterline lands on world y = 0 |
| measured envelope | 0.34194 × 0.10412 × 0.12883 | `Box3.setFromObject(asset.scene)`, executed |
| budgets | `SKIFF_LENGTH_BUDGET_WORLD_UNITS = 0.36`, `SKIFF_BEAM_BUDGET_WORLD_UNITS = 0.14` (skiffModels.ts:82-83) | the exact `hullLength`/`hullWidth` the deleted `buildSkiffParts` used |
| fit tolerance | `SKIFF_FIT_TOLERANCE_WORLD_UNITS = 0.001` (skiffModels.ts:96) | see below |
| geometry reach | 0.23318 (`center.length() + radius`, computed once at install) | executed |
| draw objects | `SKIFF_SURFACE_DRAW_OBJECTS` 2 → **1** (index.ts:123-129); plugin `drawBudget` 38 → 37 | executed: `models.root.children.length === 1`, one `Mesh` |
| material | `MeshLambertMaterial{ vertexColors: true, flatShading: true }` | executed, read off the built mesh |
| instance capacity | 1536, unchanged (`mesh.instanceMatrix.count`) | executed |

**Fit tolerance choice — not copied from boats.** `BOAT_FIT_TOLERANCE_CELLS = 0.02` sits on a budget of 1.0
(2 %). Reusing 0.02 here would be 5.6 % of a 0.36 budget — big enough to hide a real overhang, which is the one
thing the constant must not do. glTF stores positions as float32, whose spacing near 0.36 is ≈3e−8, so 0.001 is
four orders of magnitude above the rounding it exists to absorb and still under 0.3 % of the budget. The
authored hull clears it with 0.018 world units to spare on length and 0.011 on beam.

## Other changes

- `preload(ctx)` added to the plugin (index.ts:140-147) calling `preloadSkiffModels(skiffUrl)` from a
  `./assets/skiff.glb?url` import; `plugins/structures/client/glb-url.d.ts` was needed — this package's tsconfig
  takes `"types": ["node"]` only, so `vite/client` is not in scope (checked, not assumed:
  `plugins/structures/tsconfig.json`, whose `include` already covers `client/`).
- `createSkiffModels()` throws when no kit is installed (skiffModels.ts:250-257). It is a **guard, not a race**:
  the host awaits `preload` and only then calls `attach` — `client/src/plugins/types.ts:665-681` (the contract)
  and `client/src/plugins/host.ts:844-864` (the generation-checked `Promise.resolve().then(() => preload(ctx))`
  whose `.then` runs `finishMount`).
- One `InstancedMesh` instead of two; `SkiffPart`, `localOffsets`, `buildSkiffParts`, `partReachWorldUnits`,
  `SKIFF_HULL_COLOR`, `SKIFF_THWART_COLOR` and the `BoxGeometry` import are gone. Update-range upload,
  scratch-matrix discipline and the DERIVED bounding sphere are unchanged in kind.
- **Bounding-sphere centre moved** (skiffModels.ts:378-380): it now sits at `SKIFF_FLOAT_WORLD_Y + waterlineLift`,
  the line the boats' origins ride at, not at the sea surface. Necessary, not cosmetic — with the lift the origin
  is 0.039 *below* y = 0, and leaving the centre on the surface would have left that much reach unaccounted for
  under the existing `halfDiagonal + bob + reach` radius formula.
- Disposal order: `skiffModels.dispose()` frees the mesh and the material it created (never the geometry, which
  belongs to the asset), then `disposeSkiffKit()` frees the asset — index.ts:210-215, matching
  `RigAsset.dispose`'s documented contract (`client/src/render/rigAsset.ts:63-68`).
- Install-time rejections, all throwing and naming the file, none silent: not exactly one mesh, no
  vertex-colour attribute, over the silhouette budget (skiffModels.ts:181-213).
- Banners updated in both files where they described boxes / two parts.
- Nothing added talks to the server; "clients send intents, never heights" is untouched.

## Verification output

```
$ pnpm typecheck            # worktree root, all workspace packages
... plugins/structures typecheck: Done ... server typecheck: Done ... plugins/wildlife typecheck: Done
(no "error" / "ELIFECYCLE" line in the whole run)

$ cd plugins/structures && timeout 240 npx vitest run
 Test Files  8 passed (8)
      Tests  188 passed (188)
   Duration  27.37s

$ cd client && timeout 240 npx vitest run test/rigAsset.test.ts test/pluginPreload.test.ts
 Test Files  2 passed (2)
      Tests  5 passed (5)
   Duration  4.58s
```

Diff self-review: no `any`, no magic numbers (every literal introduced is a named, justified constant), no
stale comments left describing boxes or two parts.

## Unverified / stated as such

- **No pixels were looked at.** Everything above is measured from executed code and matrix reads; that the skiff
  *reads* as a boat at the game camera, floats convincingly, and is lit right against the village is phase 3's
  eyes-on. In particular the Lambert-instead-of-Standard swap is a parity decision (every other structures mesh
  is flat Lambert) whose visual result is unconfirmed.
- The bounding sphere is derived, not measured; its correctness is argued (yaw cannot push geometry past its own
  reach) and its inputs are executed values, but no frustum-culling test exercises it.
- `SKIFF_LENGTH_BUDGET_WORLD_UNITS` / `SKIFF_BEAM_BUDGET_WORLD_UNITS` reproduce the old boxes' dimensions. That
  skiffs.ts's orbit radii and spacing were *originally tuned* against exactly those numbers is stated in the new
  comment as the reason the budget exists; I did not find a written record of that tuning, so treat that
  provenance claim as inference from the code, not from a primary source.
- `.skiff-shots/` (phase 1's renders) remains uncommitted in the worktree; untouched.
- The editor's language server reported `Cannot find module './assets/skiff.glb?url'` on index.ts:33. It is a
  stale editor-project resolution, not a real error: both compilers that actually build this file exit 0 and
  pull in the declaration — `plugins/structures` `tsc --noEmit` exit 0 with `glb-url.d.ts` in `--listFiles`, and
  `client` `tsc --noEmit` exit 0 with `plugins/structures/client/index.ts` in `--listFiles` (it gets the
  declaration from `vite/client`). Boats carries the identical pattern.
