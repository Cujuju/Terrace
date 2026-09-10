# Brief: TSL migration, phase 1 step 6 (plugins, reveal clip, celestial void)

Continues `tsl-migration-phase1.md` on branch `worktree-agent-abf9e857de5b233fe`
(worktree `E:\Development\Projects\Terrace\.claude\worktrees\agent-abf9e857de5b233fe`,
tip `222a463`, main already merged in). Issue #446, arc `arc/gpu-mesher-gates`.

Read first, in this order: `tsl-migration-phase1.md` (rules and verification),
`tsl-migration-phase1-report.md` (what steps 1–5 did, the blockers, and the
"what could not be done" table — that table is this brief's scope),
`../tsl-material-composition-contract.md` §2–§4 (slots, rules 6–8).
`client/src/render/materialSlots.ts` is the contract layer; use it, do not
add a second one.

## Goal

After this step `grep -rn 'new ShaderMaterial\|onBeforeCompile' client/src plugins`
(excluding tests and node_modules) returns nothing, `shaderSplice.ts` is
deleted, and every material the app builds is a `NodeMaterial` that
`WebGPURenderer` will compile. Nothing may be seen on screen (no app launch),
so every translation must be reviewable side by side: keep the source GLSL's
structure, names and constants in the node code.

## Order (commit after each numbered item, conventional message, exact paths)

1. `client/src/plugins/kit/puffDeck.ts`: the five exported GLSL strings become
   TSL `Fn` helpers with the same names and parameters. Consumers:
   `kit/cumulusDeck.ts`, `plugins/cyclone/client/spiral.ts`,
   `plugins/volcanoes/client/plume.ts`. Migrate all three in this commit
   (`position` for placement/billboard, `normal` for the fake sphere,
   `discard` for the puff mask; `plume.ts`'s `ShaderMaterial` → `NodeMaterial`).
   `kit/revealClip.ts` (GLSL re-exports for tornado) goes when tornado does.
2. `client/src/render/revealMask.ts` `applyRevealClip` → `discard` effect. The
   report gives the working node expression. Now that spiral is a
   `NodeMaterial`, narrow the parameter to `NodeMaterial` and let it cascade:
   `client/src/plugins/types.ts:136`, `client/src/world.ts:455`, `kit/discRig.ts`,
   `kit/cumulusDeck.ts` and the plugin rigs that call it. Keep the name and
   arity. `plugins/tornado/client/funnel.ts`: both `ShaderMaterial`s →
   `NodeMaterial`; the hand-merged reveal uniforms become two `applyRevealClip`
   calls (contract rule 8). Delete `kit/revealClip.ts`.
3. `plugins/monsters/client/geometry.ts` (fur shells `color`, alpha `discard`),
   `plugins/saucers/client/effects.ts` (`opacity` from the instanced attribute
   via `attribute()`).
4. `plugins/fire/client/{smoke,scar,flames/ribbons,flames/shaderPlume}.ts`,
   `plugins/volcanoes/client/lavaFlow.ts`, `plugins/hydro/client/puddles.ts`:
   `ShaderMaterial` → `NodeMaterial`. Use slots where the program is a lit
   material with tweaks; use `vertexNode`/`fragmentNode` where it is a full
   custom program (contract rule 7). Say which per file in the report.
5. `plugins/relics/client/{gemMaterial,relicSpire}.ts`: as above, plus the
   tone-mapping rule below.
6. `client/src/render/celestialVoid.ts`: the four `ShaderMaterial`s →
   `NodeMaterial` with `vertexNode`/`fragmentNode`; stars → `PointsNodeMaterial`
   with `sizeNode` (three's `Points` size path is different on WebGPU: read
   `src/materials/nodes/PointsNodeMaterial.js` and cite it). Tone-mapping rule
   below. Delete `client/src/render/shaderSplice.ts` and the dead
   `clone.onBeforeCompile = material.onBeforeCompile` at `rigSkin.ts:421`.
7. `client/src/preview*.ts` (15 files build a `WebGLRenderer`): switch each to
   `WebGPURenderer` from `three/webgpu` with `await renderer.init()` before its
   first frame, and `scene.background` through
   `skyEnvironment.backgroundRadiance` where a background is set. Mechanical;
   one commit; the owner may drop it.

## Tone mapping (binding)

`toneMapped: false` is inert on `WebGPURenderer` (report §Background). Every
migrated material that set it (celestial void ×4, relics ×2) must produce
the same displayed sRGB as before: run its final colour through
`backgroundRadiance`'s inverse-ACES math. Hoist that inverse from
`skyEnvironment.ts` into a node helper (`Fn`) once, in one file, and use it in
all six; do not re-derive the matrices. Say in the report which materials
used it.

## Verification (no app launch; never start server or client)

- `pnpm typecheck` green; `cd client && npx vitest run` green (602 today);
  `cd client && npx vite build` succeeds.
- Never add tests. Update an existing expectation only when the contract is
  the reason, and list old/new values in the report.
- `node client/scripts/dumpMaterialGraphs.mts` still runs; extend it with the
  migrated materials that can be constructed without a device, so the
  composition is dumped for every material this step touches. If one cannot
  be constructed under plain Node, say which and why.
- `node client/scripts/drawnGroundParity.mjs` still passes.
- Final grep (goal above) pasted verbatim.

## Rules

- Work only in the worktree above, on its branch. Commit per item; stage exact
  paths; never `git add -A`; no attribution lines. Push after the last commit.
- Do not edit `docs/DESIGN.md`, `docs/decisions/`, or the two orchestration
  design documents. Do not touch `shared/`.
- No new dependencies.
- When a TSL API is uncertain, read `client/node_modules/three/src/nodes/` and
  `src/materials/nodes/` and cite the file; never guess.
- Keep constants named; no new number literals in node code that were named
  in the GLSL.
- If budget runs short, stop at a clean commit boundary and list what remains
  per file.

## Report (`.claude/orchestration/briefs/tsl-migration-phase1-step6-report.md`, committed)

Commits with hashes; per-file table (GLSL site → slot(s) or vertexNode/fragmentNode,
and any behaviour you could not reproduce exactly); tone-mapping inversions
applied; test expectations changed (old/new); verification output verbatim;
open questions for the owner.
