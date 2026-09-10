# Brief: WebGPU renderer + TSL migration, phase 1 (client)

Owner authorised 2026-09-10 ("If TSL conversion would not hurt performance of
the current CPU mesher and if it will look the same, go ahead"). The measurements
that cleared it: `bench/webgpu-renderer-ab/SUMMARY.md` (same scene, WebGL vs
WebGPU: idle and stroke both vsync-locked on WebGPU with the 4-component 8-bit
layout; terrain look within 1.5/255). Issue #446, arc `arc/gpu-mesher-gates`.

## Spec

`.claude/orchestration/tsl-material-composition-contract.md` is the contract.
Read it fully first, then `bench/webgpu-renderer-ab/SUMMARY.md`. Three facts
from the bench are binding:

1. **No `DynamicDrawUsage` anywhere.** three 0.185's WebGPU backend re-uploads
   any attribute with that usage every frame, whole array
   (`client/node_modules/three/src/renderers/common/Attributes.js:103`).
   Remove it from `riverRig.ts`, `layerEdgeOverlay.ts`, `kit/precipitation.ts`,
   `rigHerd.ts` and anywhere else `grep -rn DynamicDrawUsage client plugins` finds.
2. **No 8-bit ×3 vertex attributes.** WebGPU has no such format; three pads them
   to ×4 in JS over the whole array on every update
   (`WebGPUAttributeUtils.js:200-212`). The terrain arena is already ×4 on branch
   `worktree-arena-pad4` (merge it first: `git merge worktree-arena-pad4`). Audit
   every other `Int8Array`/`Uint8Array` `BufferAttribute` with itemSize 3
   (`frontierFog.ts` `COLOR_COMPONENTS_PER_VERTEX`, water, rivers, plugins) and
   make them ×4 through a named constant, never a literal.
3. **The background colour is tone-mapped on WebGPU.** `scene.background`
   (159,199,232) rendered as (196,214,226). The sky must land at the same sRGB
   value as today; use a `backgroundNode` with tone mapping off or pre-invert,
   and say which in the report.

## Scope, in order (commit after each step, conventional messages, exact paths)

1. `client/src/render/materialSlots.ts`: `compose(material, slot, fn)` and
   `discard(material, condition)` per contract §3. This is the whole contract
   layer; keep it under ~60 lines.
2. `client/src/render/scene.ts`: `WebGPURenderer` from `three/webgpu`; async
   `init()` before the first frame (`main.tsx` awaits `createViewport`);
   `renderer.localClippingEnabled` goes (node clipping is always on);
   `gpuTimer.ts` → timestamp queries (`renderer.trackTimestamp = true`,
   `renderer.resolveTimestampsAsync`) or a documented no-op with the same
   interface if the adapter lacks the feature; `skyEnvironment.ts` PMREM via the
   WebGPU `PMREMGenerator`; the background rule above.
3. Terrain: `terrainMeshes.ts` `makeSelfLitAware` → `output` effect
   (`mix(output.rgb, diffuseColor.rgb, selfLit)`) and the palette colour: the
   colour attribute holds sRGB bytes decoded in today's vertex splice — do the
   same decode in `colorNode` (`vertexColor()` converted from sRGB to working
   space), not by changing the bytes. `groundShade.ts` → `output` effect with
   `uniformArray`; keep `configureGroundShade`'s boot-only rule and throw.
   `revealMask.ts` `applyRevealClip` → `discard` effect; keep the plugin API
   name and arity (`plugins/types.ts:136`, `world.ts:455`).
4. Water and rivers: `water.ts` `makeDepthAware` → `color` + `opacity` +
   `emissive` effects, specular curve via `specularColorNode` (owner default;
   flag in the report); `water/waterBands.ts` `makeBanded` → `color` effect;
   `riverRig.ts` the same slots.
5. Client-side `onBeforeCompile` users still in `client/src`: `rigHerd.ts`,
   `rigSkin.ts`, `kit/cumulusDeck.ts` → `position` / `normal` / `discard`
   effects. Delete `shaderSplice.ts` when nothing imports it.
6. Plugins (`plugins/*/client`): the 3 `onBeforeCompile` users and the 15
   `ShaderMaterial` sites listed in contract §4 → `NodeMaterial` with
   `vertexNode`/`fragmentNode` or slots. Do the celestial void
   (`client/src/render/celestialVoid.ts`, 4 materials, `PointsNodeMaterial` with
   `sizeNode` for the stars) in this step too. If budget runs short, stop at a
   clean commit boundary and list what remains per file.

## Verification (no app launch — the owner runs the app; do not start server or client)

- `pnpm typecheck` green; `cd client && npx vitest run` green (600 tests);
  `cd client && npx vite build` succeeds.
- Never add tests. Update an existing expectation only when the contract is
  the reason, and list old/new values in the report.
- Static composition check: for terrain and water, dump the built WGSL
  (`renderer.debug.getShaderAsync` is unavailable without a device; instead
  write the node graph description via `material.colorNode/outputNode` `toJSON`
  in a small `client/scripts/dumpMaterialGraphs.mts` run under Node with the
  `three/webgpu` module — if the module needs a GPU device to build nodes,
  say so and skip; do not fake it).
- `node client/scripts/drawnGroundParity.mjs` still passes (terrain math is
  untouched by this work; this proves you did not touch it).

## Rules

- Work only in your worktree. Commit per step; never `git add -A`; no
  attribution lines in commit messages.
- Do not edit `docs/DESIGN.md`, `docs/decisions/`, or the two orchestration
  design documents.
- Erasable TypeScript only in `shared/` (you should not need to touch it).
- No new dependencies. `three/webgpu` and `three/tsl` are already installed
  with types (`@types/three` 0.185.4).
- When a TSL API is uncertain, read `client/node_modules/three/src/nodes/` and
  `src/materials/nodes/` rather than guessing; cite the file in the report.

## Report (write to `.claude/orchestration/briefs/tsl-migration-phase1-report.md`, commit it)

Commits with hashes; per-file table (today's splice/ShaderMaterial → slot(s)
used); the background solution chosen; what could not be done and why; the
verification commands with their output verbatim; open questions for the owner.
