# Terrace FPS review workflow

Tracking: https://github.com/Cujuju/Terrace/issues/535. Standing target: 140 FPS, or 7.14 ms. Repository root: `E:\Development\Projects\Terrace`.

## Continuous, lean readout

Open **Performance meter** or press **backquote**. The existing FPS readout updates every 500 ms; detailed windows close every 5 seconds. The panel now adds CPU-work p95, rendered-frame interval p99, and a count of CPU frames above the design budget.

The following API is available in the running client:

```js
__terracePerf.stats()             // Latest window, including counters and plugin work.
__terracePerf.history()           // Oldest-first, at most 120 windows; about ten minutes.
__terracePerf.hud(true)           // Open the meter and enable upload accounting.
__terracePerf.log(true)           // Log each window; also enables upload accounting.
JSON.stringify(__terracePerf.history()) // Export the bounded record.
```

`?perflog` enables the existing console logger at boot. History collection continues with the panel closed. Upload figures are collected while the panel or logger is enabled; zero upload figures from an unmetered window are unavailable evidence. The history resets with `resetFrameStats`; ordinary world remounts currently retain it, so start a new capture at every world/scene change.

`frameMs*` measures CPU frame work; `renderMs*` measures CPU submission inside render; `intervalMs*` measures time between rendered frames. GPU values are sparse timing samples, currently at most eight per window, and support a rough median only. Use interval tails and rendered-frame rate for FPS claims. A low CPU-work budget count does not establish a GPU deadline.

`frames / (windowMs / 1000)` gives rendered-frame rate for a regular window. `sampledFrames` exposes ring truncation above 2048 retained frames. Budget counts, plugin averages, and upload averages cover the entire window even if percentiles use only retained samples. Do not pool window percentiles into a whole-run percentile. Discard startup, hidden, build-held, world-switch and HUD/log-toggle windows from comparisons.

## Orchestration

Run these independent read-only reviews as fresh background children, without inherited conversation history. The source-review evidence from this launch is in `E:\Development\Projects\Terrace\bench\fps-review\reviews-2026-10-10.json`.

| Lane | Model | Ownership |
| --- | --- | --- |
| Rendering | Sonnet | Render passes, shaders, resolution, MSAA, GPU work, pipeline lifecycle |
| Entities | Sonnet | Plugin frame work, pose palettes, instance uploads, culling, LOD and lifecycle |
| Terrain | Opus | Prediction, picking, worker handoffs, streaming, meshing and determinism |
| Measurement | Sonnet | Metric semantics, benchmark traps, reproducibility and observer overhead |
| Final challenge | Opus | Review proposed code and challenge unsupported performance claims |

Each brief: cite current absolute source path and line, explain the mechanism, distinguish source evidence from measured cost, label assumptions, name the correctness risk, and provide a falsifiable benchmark. Require already-fixed/exonerated candidates. Assign disjoint ownership; children never launch benchmarks, edit the shared checkout, or spawn additional agents during the review. Limit reports to eight useful findings. The coordinator alone writes the synthesis and runs GPU measurements.

Starting/stopping the app needs permission in the current turn. The owner granted it for the 2026-10-10 review, together with lean profiling changes. New tests were not authorized. Read `E:\Development\Projects\Terrace\AGENTS.md` and the settled design/decision records before every run. No edits to those records are part of this workflow.

## Controlled measurements

1. Check existing app processes, ports, concurrent work and usage. Use a consistent SQLite backup of an existing world, its own settings directory and its own ports. Preserve the original world. Record the source commit and dirty source files. For this launch: copied Frostwick Hollows, server 2698, Vite 5219.
2. Run one GPU benchmark at a time. Prefer the T3 collaborative browser; on documented unavailability use the Chrome DevTools connector or the Windows/CDP workflow in `E:\Development\Projects\Terrace\scripts\gpu-bench.md`. Never accept software-renderer numbers as this machine's FPS evidence. Record the actual WebGPU adapter, backend, GPU timing support, browser, visibility/focus, frame cap, MSAA, mesher, pixel ratio and drawing-buffer dimensions.
3. Wait for `__terrace.world.pendingTerrainCount()` to reach zero and `__terrace.world.terrainBuildHeld()` to be false in a dev client. Check draws, triangles and programs at a fixed pose across consecutive windows. A changed population/pass set requires a new baseline. Restart the isolated Vite process after source edits and reload the benchmark client to avoid stale transforms or HMR state.
4. Capture at least two control blocks at unchanged settings. Then bracket each candidate with controls (A-B-B-A), repeat until the effect exceeds the measured control spread, and preserve the complete windows. Change one factor at a time. Match camera target, position and drawing-buffer dimensions. Keep display/vsync policy constant. CPU tests and builds finish before accepted benchmark measurements.
5. Run idle, camera movement, sculpt and soak separately. Reuse `E:\Development\Projects\Terrace\client\src\perfProbe.ts` scenarios for controlled idle/sculpt probes. `E:\Development\Projects\Terrace\.perf-probe\motion.mjs` is an untracked historical pan/orbit driver: inspect it and copy it into the run folder before reuse; it carries older 144 Hz constants. A new motion path must be based on wall time. Each sculpt arm gets a fresh world copy. Use a continuous 20-minute soak for a first decay gate: earlier reports already exercised this duration; longer sessions require a longer gate.
6. Export the history and run metadata. Accept a change only when repeated interval/work/GPU improvements exceed control variation, spikes do not worsen, and a matched-pose visual comparison preserves the intended appearance. Render changes require visual QA; terrain changes additionally require existing parity/determinism checks. Run relevant existing tests and typecheck; obtain separate permission before writing tests.

The performance target is measured on the owner's machine, not imposed as an acceptance number on a different display or software renderer. Record refresh/display caps with throughput measurements.

## Ranked measurement queue

These are investigation priorities, not measured FPS gains. Their detailed evidence and risks are in `E:\Development\Projects\Terrace\bench\fps-review\reviews-2026-10-10.json`.

| Order | Candidate | Mechanism / next discriminator |
| --- | --- | --- |
| 1 | Pose palette upload contract | Animated herds recapture slots and queue one texture write per layer. Count live-slot texture writes, then evaluate contiguous/coalesced uploads before reducing animation cadence. |
| 2 | Fire live-range uploads | Scar, smoke and flame buffers mark full capacity dirty. Measure one active fire; verify live draw counts, then range only written elements and compare pixels. |
| 3 | Unchanged hover pick | The stable aim key still re-marches the ray. Compare hover self-time at a still pointer; cache against exact camera/aim and terrain revisions without changing hit results. |
| 4 | Prediction ledger scaling | Small authoritative diffs still copy the whole map and all column spans. Profile large layered maps; prove the complete height/span write-set before sparse reconciliation. |
| 5 | River worker copies | Refresh transfers a full copied heightmap on a throttle. Trace copy time and unchanged refreshes; consider a persistent worker mirror with dirty patches and world-reset discipline. |
| 6 | Celestial star/void work | About 839k star instances and a gas pass sized for broad coverage. Measure selective draw suppression and gas cost before changing generation or quality. |
| 7 | Camera/frustum and entity LOD | Coarse terrain super-mesh bounds and herd union bounds retain off-screen work. Measure near/far/turned-away views before splitting draws or lowering cadence. |
| 8 | Cloud transparency, terrain shading, MSAA/DPR | Test pass elimination and shader gating first; quality-changing controls remain explicit experiments with matched captures. |
| 9 | Event/reveal batch hitches | Trees/structures rebuild globally; unlock messages repeat whole-set syncs. Trace event bursts and coalesce only after preserving immediate authoritative state. |
| 10 | Session decay and environment repaint | Watch CPU submission, resource/upload trends and interval tails over a soak. Separate instrument growth from application growth. |

Important ablation correction: `E:\Development\Projects\Terrace\client\src\render\celestialVoid.ts` resets star visibility in its `onBeforeRender`, so writing a star object's `visible=false` alone is not a valid star ablation. Use a draw filter or temporary non-light layer-mask exclusion, verify the star draw/triangle reduction, and restore state. Hiding whole plugin layers also hides their fixed lights; that does not isolate plugin draws and violates the settled stable-light rule. Preserve light visibility when measuring draw cost.

Already shipped, so do not repeat as new work: gated parked point lights, fixed light banks, shader warmup, pilgrim instancing, GPU-side precipitation, static boat poses, ranged water texel/arena/lip updates, and the corrected per-frame `render.drawCalls` census. Historical issue #473's idle-light result precedes the current gate. Existing related work is tracked in #467, #378, #343 and #450; validate current source before reusing any old number.

## Evidence from this launch

The real-GPU diagnostic capture used Chrome 156, WebGPU on a non-fallback NVIDIA Ampere adapter, 4x MSAA, DPR 1 and a 1249 × 1229 drawing buffer. The application frame-rate preference was unset (the default is unlimited); the fastest windows were about 144 rendered FPS. Assumption: display/vsync accounts for that ceiling; verify the monitor/browser presentation configuration before interpreting throughput headroom.

Two A-B-B-A star-draw sequences retained 24 complete five-second windows after transition windows were discarded. All retained windows were visible, focused, terrain-ready and had 173 programs. Original-star controls ranged from 95.6 to 144.0 rendered FPS. Excluding only the star objects removed about 1.68 million triangles per frame. The median of window GPU medians was 2.79 ms in controls and 2.10 ms with stars excluded (averaging the two middle values for an even number of windows). These are sparse-window summaries, not pooled GPU percentiles. Population and draw counts changed during the live run, and the control spread is too large for a defensible FPS-gain claim. No visual setting was changed permanently.

Raw windows and metadata: `E:\Development\Projects\Terrace\bench\fps-review\star-ablation-2026-10-10.json`. Independent profiling reviews: `E:\Development\Projects\Terrace\bench\fps-review\profiling-review-2026-10-10.json`. The final reviewer approved overflow accounting; its claim that the design lacked a 140 FPS target was a grep false negative, resolved against `E:\Development\Projects\Terrace\docs\DESIGN.md:39`.

Single-run workloads were also captured with the original visual settings. The first window of each workload is excluded below because it overlaps its transition. These ranges describe complete five-second windows, not repeated optimization arms:

| Workload | Windows | Rendered FPS range | Median of window GPU medians | Interval p99 range |
| --- | --- | --- | --- | --- |
| Camera oscillation ±30°, 6-second period | 5 | 120.7–131.4 | 7.14 ms | 10.3–13.9 ms |
| Near idle, 12-unit view distance | 3 | 130.0–144.0 | 5.37 ms | 8.3–14.5 ms |
| Near sculpt, radius 4 every 120 ms | 3 | 117.6–128.9 | 5.77 ms | 13.3–17.3 ms |

The sculpt block sent 168 intents through the normal connection/prediction path, alternating raise/lower every two seconds. The count records successful local sends, not confirmed authoritative acceptances. Motion's 82 ms maximum interval deserves a trace before assigning a cause. The camera and original star masks were restored; the isolated apps were then stopped. Raw workload records and an 82-window telemetry check (ordered, zero invalid field/count/percentile invariants) are in `E:\Development\Projects\Terrace\bench\fps-review\workloads-2026-10-10.json`.

The motion workload's GPU time reaches the entire 7.14 ms design budget. Investigate camera-dependent draw coverage, the celestial gas/void pass, terrain shading and culling before accepting a CPU-only optimization as the solution to this workload. The source queue order reflects low-risk measurement opportunities, not an exclusive diagnosis. No before/after optimization comparison or whole-run p99 is implied by this table.

The ranked queue remains a measurement queue. Pose texture writes and live-range fire updates are the first implementation candidates; prediction reconciliation and worker mirroring are withheld until their complete authoritative/reset contracts are proven. A 20-minute decay soak has not been completed in this launch and remains a separate gate for decay claims.

## Decisions and boundaries

The chosen profiler extends the existing frame-stat contract. An always-on heavy perfProbe was rejected because it wraps calls, sparsely samples soak tails and can contaminate its own timing. A second timing recorder was rejected because it would duplicate the frame timing/reset contract. Dynamic light removal was rejected because it rekeys pipelines and breaks the standing design. Reduced DPR, disabled MSAA, Lambert terrain and slower animation remain explicit quality experiments, not assumed improvements.

No gameplay, terrain math, visual defaults or deterministic protocol behavior changed in this review. Large prediction/reveal/worker changes require their own correctness evidence before implementation. No claim of recovered milliseconds is made from source inspection or synthetic Node microbenchmarks alone.

## Validation

Client/electron typecheck and ESLint on the three changed TypeScript files passed. The first existing client suite passed 798 tests with one skipped. Its repeat after the accounting correction passed 797, skipped one and hit a 60-second timeout in the unchanged `E:\Development\Projects\Terrace\client\test\vertexGrid.test.ts` WORST POLYGON case. That exact case passed in isolation with the original timeout (51.90 seconds). The existing draw-budget contract suite passed all 22 tests. No tests were added. Exact commands, runtime checks and limitations are recorded in `E:\Development\Projects\Terrace\bench\fps-review\validation-2026-10-10.json`.
