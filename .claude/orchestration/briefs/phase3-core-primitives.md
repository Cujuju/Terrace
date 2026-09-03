# Phase 3 (i) brief — core `revealClip` + `groundShade` primitives (#284)

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12`
(branch `worktree-agent-a63416ea19b8c4c12`, == main 2598405). First action:
`EnterWorktree({ path: "<that path>" })`. Paths below are relative to the worktree
root. Commit to the worktree branch as you go (conventional commits, no attribution
footers, stage exact paths only). Do NOT merge to main. Do NOT start any app stack:
this sequence is core code + tests, no visuals.

Read first (binding, do not relitigate — every decision in it is the owner's):
- `/mnt/e/Development/Projects/Terrace/.claude/plans/weather-clouds-shadow-reveal-clip.md`
  (absolute path; it is untracked in the main checkout). §2 is your scope; §3 is
  sequence (ii), NOT yours — but design §2 so §3 can consume it unchanged.
- `client/src/render/shaderSplice.ts` (the only way to patch a stock shader here),
  `client/src/render/terrainMeshes.ts:336-380` (`makeSelfLitAware`, the splice you add
  beside), `client/src/render/water.ts:290-390` (the water's own splices).
- `client/src/plugins/types.ts:90-487` (`ClientPluginCtx`, `TerraceClientPlugin`,
  `drawBudget` doc — your `groundShadeBudget` mirrors it exactly),
  `client/src/plugins/host.ts` (`publishMovers` at the pose phase; `countDrawObjects`
  + breach logging — copy that shape for shade over-publish).
- `client/src/world.ts:720-800` (the two `fog.sync`/`water.sync` sites) and `:980-990`
  (`revealedAt` closure over `mirror.received`); `client/src/terrain/mirror.ts:47-80`.
- `client/src/render/scene.ts:257-262` (the sun), `client/src/render/skyRig.ts:40-47`.
- `client/test/drawBudget.test.ts` (the style your contract tests match).
- Root `CLAUDE.md`, `docs/DESIGN.md` standing rules (140 fps; no magic numbers).

## Hard constraints
- Tests: permission granted for THIS arc only — write SHORT contract tests BEFORE the
  code, for exactly: (a) reveal mask texel ↔ `received` set incl. world edge / outside;
  (b) ground-shade projection as a pure function (sun dir + disc + point → shade; sun
  at/below `GROUND_SHADE_MIN_SUN_Y` → 0; `inner` eye hole); (c) `GROUND_SHADE_MAX` =
  Σ mounted plugins' `groundShadeBudget`, over-publish dropped + logged once, never a
  throw. Nothing else. Node tests, no GL (this project ships no headless GL rig).
- Comments are claims, not evidence: verify from source lines; cite `file:line` in the
  report.
- Core names no plugin. Nothing in `plugins/**` changes in this sequence.
- `spliceShader` for every stock-shader patch; every anchor must be an include three
  0.185 emits (verify in `node_modules/three/src/renderers/shaders/ShaderLib/`).
- Don't touch `docs/**`, `.claude/**` except your report, `plugins/**`, `shared/**`.

## Deliverables

### 1. `client/src/render/revealMask.ts`
- `createRevealMask(worldSize)`: one `DataTexture` R8 `chunksPerEdge²` (2048-cell world
  → 128², 16 KB), texel 1 = chunk index ∈ `received`, else 0. `LinearFilter`,
  `ClampToEdge`; `sync(mirror)` rewrites bytes and `needsUpdate` only when something
  changed. `dispose()`.
- One SHARED uniform object `{ uRevealMask, uRevealChunksPerEdge, uWorldUnitsPerChunk }`
  (or your equivalent) so one upload reaches every material.
- `applyRevealClip(material, label)`: onBeforeCompile splice for stock materials
  (`MeshBasicMaterial`, `LineBasicMaterial`, `PointsMaterial`, `MeshLambertMaterial`):
  vertex → `varying vec2 vRevealXZ` from the WORLD position; fragment → sample the
  mask at XZ / world extent; `discard` when the sample < a named threshold OR the UV
  is outside [0,1]² (the world-edge clause). Must compose with a material that already
  has an `onBeforeCompile` (chain, do not overwrite).
- GLSL snippets for `ShaderMaterial` callers in `client/src/plugins/kit/revealClip.ts`:
  `REVEAL_CLIP_UNIFORMS_GLSL`, `REVEAL_CLIP_VERTEX_GLSL` (expects `world`),
  `REVEAL_CLIP_FRAGMENT_GLSL` — same indentation convention as `kit/puffDeck.ts`.
- Wire into `world.ts`: created with the mirror, `sync` at BOTH sites beside `fog.sync`,
  disposed with it. Promote `revealedAt` to a World member; the chart closure calls it.

### 2. `client/src/render/groundShade.ts`
- `GroundShadeDisc = { x, z, y, radius, darkness, inner }` (world units; darkness and
  inner in [0,1]).
- Pure `groundShadeAt(px,py,pz, sunDir, discs): number` — the exact arithmetic the GLSL
  runs (plan §2.2 snippet), so test (b) pins the shader's maths without GL. Sun dir is
  the direction the light comes FROM (three's `DirectionalLight.position` convention,
  `skyRig.ts:42-44`). Below `GROUND_SHADE_MIN_SUN_Y` → 0, with the constant's value
  justified in its comment (the projection runs to infinity; daynight has already cut
  the sun's intensity there — read `plugins/daynight/client/sky.ts:113-135` for the
  horizon numbers and derive, don't guess).
- Shared uniform object: `uShadeCount`, `uShadeSun`, packed `vec4 uShadeA[N]` (x,z,y,
  radius) + `vec2 uShadeB[N]` (darkness, inner). `N` = `#define GROUND_SHADE_MAX` =
  `max(1, Σ budgets)` — GLSL forbids a zero-length array; with 0 publishers the loop
  bound is `uShadeCount = 0`.
- `applyGroundShade(material, label, max)`: splice before `#include <opaque_fragment>`
  → `outgoingLight *= 1.0 - shade;` (max over discs). Needs the fragment's WORLD
  position: add a varying from the vertex stage (`#include <worldpos_vertex>` exists
  in these shaders; verify).
- Apply in `terrainMeshes.ts` (beside `makeSelfLitAware`) and `water.ts` (chain with
  its existing patch).
- Host (`host.ts`, `types.ts`): `TerraceClientPlugin.groundShadeBudget?: number`;
  `ClientPluginCtx.publishGroundShade(lookup: () => readonly GroundShadeDisc[]): () => void`
  (publishing moves the plugin to the pose phase, exactly as `publishMovers`);
  `ClientPluginCtx.revealedAt(x,y)`, `applyRevealClip(material,label)`,
  `revealClipUniforms()`. Per frame, after the pose phase: gather every publisher's
  discs, copy ≤ `GROUND_SHADE_MAX` into the uniforms, read the sun from
  `viewport.lighting.sun.position` normalised, log ONE breach line per plugin when it
  publishes more than its budget (drop the excess). `GROUND_SHADE_MAX` is computed at
  host mount from the mounted plugins. VERIFY the ordering between host mount and the
  terrain/water material construction (`world.ts` builds terrain at snapshot time, the
  host mounts at boot?) — the define must be known before the first compile; if the
  order is wrong, say so in the report and use the mechanism that is correct (a
  material `needsUpdate` after mount is acceptable ONCE, at boot, never per frame).

### 3. Nothing adopts yet
With zero publishers and zero clipped materials the frame must be byte-identical to
today except for: one 16 KB texture, ≤ 1 extra varying per terrain/water fragment, and
an empty loop. State that cost in the report with the shader diff.

## Gates (in the worktree, before you report)
- `pnpm typecheck` clean; `pnpm test` green (scope test runs to `client/`; root vitest
  picks up other worktrees). Tests (a)–(c) present and green, committed BEFORE the code
  commit that satisfies them.
- `git diff --stat main` lists ONLY: the two render modules, the kit snippet file,
  `world.ts`, `host.ts`, `types.ts`, `terrainMeshes.ts`, `water.ts`, new tests.

## Report
Write `.claude/orchestration/briefs/phase3-core-report.md` (in the worktree; it will
be read from there): commits; the exact ctx/plugin API as shipped (signatures, with
`file:line`); the splice anchors used and the three include order you verified them
against; the mount-vs-compile ordering finding; the zero-publisher cost; every
deviation from the plan with its reason; anything sequence (ii) must know.
