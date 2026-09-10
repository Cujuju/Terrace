# Session handoff 2026-09-10: TSL migration kickoff

## Status
SHIPPED+PUSHED (main); IN-PROGRESS (migration branch `worktree-agent-abf9e857de5b233fe`, pushed, phase 1 steps 1–5 done, step 6 not started; the client does not run on it yet)

## Tip
89e5f0f docs: brief for the WebGPU renderer and TSL migration, phase 1

## What changed
- #444 frame-rate target setting shipped (`40c3ba0`): Controls panel select, unlimited + 144/120/90/60/30, nearest-tick scheduler, persisted. Not yet run in the app.
- #445 `.claude/orchestration/gpu-mesher-production-design.md`; #446 `.claude/orchestration/tsl-material-composition-contract.md`.
- `bench/webgpu-renderer-ab/`: WebGL vs WebGPU on the shipped mesh with the stroke upload replay. WebGPU holds 144 fps under stroke with 8-bit ×4 attributes; terrain look within 1.5/255; sky differs (WebGPU tone-maps `scene.background`); `DynamicDrawUsage` re-uploads every frame on WebGPU.
- Branch `worktree-arena-pad4` (5bc22e5, pushed): arena normals/colours ×4. Sculpt probe A/B (`.gpu-perf/results/2026-09-10-arena-pad4/SUMMARY.md`): modest (median p95 16.5→13.9 ms, fps 102→121), n=3, noisy; not the stroke tail. Required for WebGPU anyway.
- Stroke-trace report read: tail is CPU in the GPU process executing ANGLE's `bufferSubData` — gate 4's "upload-bound" precondition holds.

## Uncommitted
None of this session's. `.gpu-perf/` results are gitignored by design.

## Pending
- Migration (#448): branch `worktree-agent-abf9e857de5b233fe` (8cde57f, on top of pad4 5bc22e5). Done: `materialSlots.ts`, WebGPURenderer + async init + timestamp timer, terrain/ground shade/water/rivers/rig skinning as slots, all `DynamicDrawUsage` removed, background pre-inverted through ACES (`skyEnvironment.backgroundRadiance`). Not done (report §"What could not be done"): reveal clip (blocked on `NodeMaterial` narrowing through the plugin API and cyclone spiral), cumulus/puffDeck, celestial void (4 ShaderMaterials), 15 plugin ShaderMaterials, 3 plugin splices, 15 `preview*.ts` harnesses. Typecheck green (re-verified), 599 tests, vite build ok — nothing seen on screen. Report: `.claude/orchestration/briefs/tsl-migration-phase1-report.md` on that branch.
- Agent's open questions for the owner: selfLit became a Float32 attribute (+3 B/vertex; WebGPU has no 8-bit ×1 format) vs packing it into the colour pad byte; water moved to `MeshPhysicalNodeMaterial` for `specularColorNode` (F0 scaling, not post-BRDF); terrain normal attribute may be dead under flatShading; `programCacheKeys` now `[]`; previews to migrate.
- Owner decisions still open: water specular slot (agent defaults to `specularColorNode`), `forceSinglePass`, dirty-footprint coalescing, slot-shrink idle 2,000 ms, shipped world size, merging `worktree-arena-pad4`.
- Gate 2 laptop (#447) not pushed. `.claude/worktrees/webgpu-count` locked `.node` files still to remove.
- #444 eyes-on in the app, then close.

## Resume path
1. `git -C E:\Development\Projects\Terrace log -3 --oneline`; read `.claude/orchestration/briefs/tsl-migration-phase1-report.md` from `.claude/worktrees/agent-abf9e857de5b233fe` (or `git show worktree-agent-abf9e857de5b233fe:.claude/orchestration/briefs/tsl-migration-phase1-report.md`). Step 6 of the brief remains: continue on that branch (a fresh Opus agent with the brief + report, or inline), plugins first, celestial void last.
2. Merge order when accepted: `worktree-arena-pad4` first, then the migration branch; `pnpm typecheck && cd client && npx vitest run`.
3. Eyes-on with the owner's permission only: run the app on WebGPU, compare the sky and terrain against `bench/webgpu-renderer-ab/webgl.png`; run `?perfprobe=sculpt&settle=45000` via `.gpu-perf/results/2026-09-09-worker-mesher-baseline/probe-run-win.mjs` (recipe in `.gpu-perf/results/2026-09-09-stroke-trace/SUMMARY.md` §10) against `.gpu-perf/results/2026-09-10-arena-pad4/base-*.json`.
4. Then gate 4 proper: the GPU mesher per the design doc; measurements owed are listed in its §10.

## Cross-refs
[[project_session_handoff_2026_09_10_gpu-mesher-gates]] [[terrain-renderer-options]] [[gate2-laptop]] [[worker-mesher]]
