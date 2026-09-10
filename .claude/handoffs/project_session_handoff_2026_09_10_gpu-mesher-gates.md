# Session handoff 2026-09-10: GPU mesher gates

## Status
SHIPPED+PUSHED

## Tip
97efaf6 docs: gate 1 results, desktop visible run, and the terrain handoffs

## What changed
- `run_server.py` stops the stack cleanly on Windows (node children in their own console group, Ctrl-Break, `taskkill` fallback); server binds SIGBREAK to graceful shutdown.
- `plugins/mana/test/mana.test.ts` arity fix; workspace typecheck green.
- `bench/webgpu-mesher/`: standalone raw-WebGPU terrace mesher gate (page, CDP driver with `--visible` and `--serve`, self-checks, one-snapshot Frostwick DB). Desktop results in `results/desktop/`.
- `pnpm-workspace.yaml` allows darwin arm64 so the laptop clone installs.
- Handoffs tracked: `terrain-renderer-options.md` (gate 1 numbers), `worker-mesher.md`, `gate2-laptop.md`.

## Measured (RTX 3090, visible window, owner's stack on the same GPU)
- Gate 1: parity 157 cell-centre mismatches / 0 holes (shipped mesh: 573 / 4,097 under the same pass); pixels 0.220 % vs 0.191 % metric floor; draw p50 0.69 ms both meshes; full rebuild 3.0 ms GPU vs 938 ms CPU; edit 3×3 chunks heaviest 2.08 / 2.74 / 2.84 ms, median 0.44 / 0.70 / 1.10 ms (p50 / p95 / max); resident 189.6 MB; loop 144 fps.
- Worker-mesher agent (`.gpu-perf/results/2026-09-09-upload-stall/SUMMARY.md`, fix 03a3759): stroke p50 / p95 / max 7.2 / 12.1 / 54 ms unchanged by the upload fix; slow frames are main thread idle; residual tail unattributed, `chrome://tracing` capture in progress by that agent.

## Pending (GitHub #444 fps setting, #445 mesher design, #446 TSL contract, #447 gate 2; label arc/gpu-mesher-gates)
- User: "put in a setting that allows the user to decide what they want the FPS to run at. I'm not going to put a hard cap in there." Do on local main.
- Then: production design for the GPU mesher (per-chunk capacity slack, overhang undersides, over-budget fallback; memory and edit budgets stated). Document only.
- Then: TSL material composition contract (ground shade, reveal clip, band colour, water emissive as node functions). Document only. Gate 4 does not start before gate 2 and the tracing capture report.
- Gate 2 running on the laptop (Mac session, visible Chrome only); results arrive on branch `gate2-laptop`.
- `.claude/worktrees/webgpu-count`: two locked `.node` files remain; remove after the owner's stack stops.
- Owner decisions open: `forceSinglePass` on transparent DoubleSide materials (~0.6 ms/frame); dirty-footprint coalescing (predict + confirm build the same chunks twice, §2 of the upload-stall summary).

## Resume path
1. `git -C E:\Development\Projects\Terrace log -3 --oneline`; read `.claude/handoffs/terrain-renderer-options.md` and `.gpu-perf/results/2026-09-09-upload-stall/SUMMARY.md`.
2. FPS setting: find the render loop (`client/src/render/scene.ts` `renderFrame`, rAF scheduling in `client/src/world.ts`) and the settings UI; add a user-selectable target (unlimited plus fixed values), persisted; never start the app without owner permission.
3. Write the mesher production design and the TSL composition contract as documents under `.claude/orchestration/`; no client code.
4. When `gate2-laptop` is pushed: `git fetch && git log origin/gate2-laptop`; read `bench/webgpu-mesher/results/laptop/notes.md`; decide against the kill criterion in `.claude/handoffs/gate2-laptop.md`.

## Cross-refs
[[terrain-renderer-options]] [[worker-mesher]] [[gate2-laptop]]
