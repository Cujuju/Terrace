# Session handoff 2026-09-10: TSL migration kickoff

## Status
SHIPPED+PUSHED (main); IN-PROGRESS (background Opus agent `tsl-migration`, own worktree)

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
- Owner: "If TSL conversion would not hurt performance ... and look the same, go ahead ... or pass it to a background Opus agent." Conditions met on the desktop; agent launched with brief `.claude/orchestration/briefs/tsl-migration-phase1.md`; it reports to `.claude/orchestration/briefs/tsl-migration-phase1-report.md` in its worktree (`git worktree list`, branch `worktree-agent-*`, look for that file).
- Owner decisions still open: water specular slot (agent defaults to `specularColorNode`), `forceSinglePass`, dirty-footprint coalescing, slot-shrink idle 2,000 ms, shipped world size, merging `worktree-arena-pad4`.
- Gate 2 laptop (#447) not pushed. `.claude/worktrees/webgpu-count` locked `.node` files still to remove.
- #444 eyes-on in the app, then close.

## Resume path
1. `git -C E:\Development\Projects\Terrace log -3 --oneline`; `git worktree list`; find the migration agent's worktree and read its report if present, else `git -C <worktree> log --oneline main..HEAD` to see how far it got.
2. Merge order when accepted: `worktree-arena-pad4` first, then the migration branch; `pnpm typecheck && cd client && npx vitest run`.
3. Eyes-on with the owner's permission only: run the app on WebGPU, compare the sky and terrain against `bench/webgpu-renderer-ab/webgl.png`; run `?perfprobe=sculpt&settle=45000` via `.gpu-perf/results/2026-09-09-worker-mesher-baseline/probe-run-win.mjs` (recipe in `.gpu-perf/results/2026-09-09-stroke-trace/SUMMARY.md` §10) against `.gpu-perf/results/2026-09-10-arena-pad4/base-*.json`.
4. Then gate 4 proper: the GPU mesher per the design doc; measurements owed are listed in its §10.

## Cross-refs
[[project_session_handoff_2026_09_10_gpu-mesher-gates]] [[terrain-renderer-options]] [[gate2-laptop]] [[worker-mesher]]
