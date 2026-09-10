# Worker mesher: handoff (2026-09-09)

Self-contained. Facts below were read from source or measured on 2026-09-09 unless marked otherwise.

## Orchestration policy for the receiving Fable session

- Fable orchestrates, reviews, decides. Fable does not write the code.
- Spawn fresh Opus agents (`subagent_type: "general-purpose"`, `model: "opus"`) with self-contained written briefs. Never forks. One agent per step below, sequential; the next step's brief carries the previous step's numbers.
- Every agent works in its own git worktree on its own branch (`isolation: "worktree"`). Commit per step, exact paths only, conventional messages, no attribution lines. Merge to `main` only after Fable has verified the numbers by rerunning the measurement itself.
- Verify every agent claim with a concrete check before relaying it: rerun the probe, diff the files, run typecheck and tests. Never relay "done" without evidence.
- No new tests unless the owner grants permission in that session. No edits to `docs/DESIGN.md` or `docs/decisions/`. Never start the app, server, or a browser without the owner's permission in the current turn; the measurement steps below need that permission, so ask for it up front.
- `pnpm install` runs from PowerShell only. Never from WSL: it strips the Windows `.CMD` shims and writes symlinks Windows cannot read.

## Repo facts

- Monorepo at `E:\Development\Projects\Terrace`, pnpm 10.33, Node 24+. Packages: `shared/`, `client/`, `server/`, `plugins/*`. Commands: `pnpm typecheck`, `pnpm test`.
- `pnpm typecheck` currently fails on `main` in `plugins/mana/test/mana.test.ts:940`: a three-argument call to `sculptDisplacementUnits`, which takes two. Pre-existing, unrelated. Do not fix it in this arc; do report it if it still fails.
- Hard rules: `shared/` is the single source of terrain math, deterministic integer-only, erasable TypeScript only (no enums, no namespaces). Clients send intents, never heights. Nothing gamey in core.
- TypeScript strict. No `any` without a comment. Named exports. Comments only when necessary, 30 words max. No magic numbers: every literal gets a named constant.
- Git: `core.hooksPath` points at a `/mnt/e/...` path, so hooks run only from WSL. Ignore the warning on Windows.

## Current terrain pipeline (from source)

Files, all under `client/src/`:

- `render/terrainMeshes.ts` (780 lines). Owns the chunk build queue and the vertex arena. Constants at the top: `CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5`, `ARENA_COMPACT_STROKE_BUDGET_MS = 1.0`, `ARENA_COMPACT_IDLE_BUDGET_MS = 3.0`. Sets `pending`, `inFlight`, `retry`, array `ready`. `drain(budgetMs)` at ~line 612 submits builds up to `buildSource.concurrency` and splices ready answers until the budget is spent; called once per frame with `CHUNK_SPLICE_FRAME_BUDGET_MS` at ~line 705. `flush()` at ~line 632 builds and splices everything synchronously then compacts with an infinite budget. `spliceAnswer` at ~line 577 does, on the main thread per chunk: `drawnGroundStore.publishRastered`, `spliceChunk` into a super-mesh arena (holes list, `ensureSuperCapacity`, four `BufferAttribute.needsUpdate = true` at ~line 315), then every `chunkDrawnHandlers` callback. It records per-splice ms in a ring of `SPLICE_SAMPLE_WINDOW`.
- `render/chunkBuildSource.ts` (105 lines). Interface `ChunkBuildSource { build(mirror, chunkIdx, generation), concurrency, dispose }`. `createDirectChunkBuildSource()`: synchronous, concurrency 1. `createWorkerChunkBuildSource()`: pool of `CHUNK_WORKER_POOL_SIZE = 2` module workers running `render/chunkBuildWorker.ts`; least-loaded dispatch; per-worker owed-promise queues; a dead worker falls back to the direct source. The request is `extractChunkWindow(mirror, chunkIdx, generation)` from `terrain/chunkJob.ts`, posted with transfers. So the heightmap window copy happens on the main thread per request.
- `terrain/chunkJob.ts` (269 lines): `extractChunkWindow`, `buildChunkAnswer`, `chunkRequestTransfers`, types `ChunkJobRequest`, `ChunkJobAnswer`. `buildChunkAnswer` runs the mesher: `terrain/contours.ts`, `contourSmoothing.ts`, `triangulation.ts`, `capEmission.ts`, `vertexGrid.ts`.
- `world.ts:135` creates the worker source and passes it to `createTerrainMeshes` at `world.ts:219`. `world.ts:238` wires `onChunkDrawn` to `layerEdges.refreshChunk(chunkIdx)` plus a drawn-chunk scratch set; those run inside `spliceAnswer` on the main thread.

So: chunk geometry is already built off the main thread by a 2-worker pool. What remains on the main thread per edited chunk is the window extraction, the arena splice with its buffer uploads, `publishRastered`, and the chunk-drawn handlers (layer-edge overlay refresh and drawn-ground bookkeeping). All 1,024 chunks of a 512² world, and 16,384 of a 2048² world, are resident in the arena at all times; there is no residency window.

## Measured numbers

Owner's desktop: RTX 3090, Windows 10, Chrome with ANGLE D3D11. World "frostwick-hollows" 512². Client window 1404×1205 px.

- Idle, all plugins, default pose, 45 s settle, 2026-09-09: frame p50 6.9 ms, p95 8.0 ms, p99 9.6 ms, max 151.7 ms (one hitch). 165 draw calls, 4.0 M triangles. Main-thread JS 4.34 ms/frame, of which terrain code (`drawnGroundStore`, `drawnGround`, `terrainMeshes`) is 0.07 ms. The rest is three.js render overhead (2.73 ms) and plugin frame hooks (1.35 ms). Idle frame time is not a terrain problem.
- Terrain-only bench, no plugins, one Lambert mesh of the mesher's output, 2026-09-08: build 938 ms for 1,024 chunks, 0.92 ms per chunk single-threaded, 207 MB of vertex buffers resident, GPU draw 0.68 ms.
- Sculpt stroke, last recorded 2026-08 at client version 688, stale, fewer plugins than today: stroke frame p50 2.7 ms, p95 22 to 24 ms, max 414 to 505 ms; median splice 0.1 ms. The p95 and max are the numbers this arc exists to fix. They have not been re-measured on today's client.
- Laptop (Apple M4 Max, Vivaldi, Metal, 2× display at 120 Hz): nothing measured.

## Deliverable

Reduce edit-time main-thread stalls and resident memory without changing what is drawn. Three steps, each its own Opus agent, each gated by a measurement Fable reruns.

### Step 1: measure today, no code

Brief: run the sculpt probe on current `main`, three runs, report stroke p50/p95/p99/max, idle p50, median splice ms, and a 10 s V8 CPU profile during the held stroke aggregated by self time per function and inclusive time per subtree, per frame. Also record the full-world build wall time at world load (instrument `flush()` and the first `drain` cycle with `performance.now()`, behind `import.meta.env.DEV`, not committed). Deliverable: a results file under `.gpu-perf/results/<date>-worker-mesher-baseline/` and a one-page summary naming the top five main-thread costs during a stroke.

Pass: numbers exist and the profile attributes at least 80% of stroke-frame main-thread time to named functions.

### Step 2: main thread only splices

Brief, driven by step 1's attribution: move whatever step 1 shows still on the main thread per edited chunk into the worker or off the hot path. Candidates from source: window extraction (`extractChunkWindow` could read from a `SharedArrayBuffer` mirror or the worker could hold its own mirror updated by diffs), the layer-edge refresh in the chunk-drawn handler, and arena growth (`ensureSuperCapacity` reallocations at ~line 496 and ~512 are the likely source of the 400 ms max frames; confirm from the profile before touching). Keep `CHUNK_SPLICE_FRAME_BUDGET_MS` semantics. Every moved computation must produce byte-identical `ChunkJobAnswer` output; prove it with the existing parity gate `node client/scripts/drawnGroundParity.mjs` if it exists on the branch, otherwise with a before/after hash of the arena buffers on a fixed fixture.

Pass: stroke p95 under 8 ms and max under 20 ms at the same pose and window, idle p50 unchanged within 0.3 ms, zero parity mismatches, typecheck and existing tests green.

### Step 3: residency window

Brief: build and keep arena buffers only for chunks within a named radius of the orbit target; chunks outside get either nothing or two triangles at their mean drawn band (owner decides which; default to nothing and report the visual). Entering the window enqueues a build; leaving frees the slot. Bound both build time and memory by view, not world size. Must work with the existing drawn-ground store: consumers that query heights for chunks outside the window must still get correct answers, since the height data is still resident even when geometry is not.

Pass: resident vertex bytes on the 512² world at the default pose under 100 MB; on the 2048² world "reach-of-wildfall" under 250 MB; full-world load-to-first-frame under 1 s on 2048²; stroke numbers from step 2 hold; parity gate zero mismatches within the window.

## Measurement recipe

The owner's own server is on port 2567 and Vite on 5173. Never touch either. Use an isolated stack:

```powershell
$root = "E:\Development\Projects\Terrace"; $run = "$root\.gpu-bench-run"; $stack = "$root\.gpu-perf\bench-stack"
# World copy via the SQLite backup API (the live DB may have a hot WAL):
python3 -c "import sqlite3; s=sqlite3.connect('$root/server/data/worlds/frostwick-hollows.db'); d=sqlite3.connect('$stack/worlds/frostwick-hollows.db'); s.backup(d)"
Set-Content "$stack\worlds\.active" 'frostwick-hollows' -NoNewline
$env:PORT='2599'; $env:WORLDS_DIR="$stack\worlds"; $env:DB_PATH="$stack\nonexistent.db"
Start-Process node -ArgumentList 'src/index.ts' -WorkingDirectory "$root\server" -RedirectStandardOutput "$run\server.log" -PassThru -WindowStyle Hidden | % Id | Out-File "$run\server.pid"
Remove-Item Env:PORT, Env:WORLDS_DIR, Env:DB_PATH
$env:TERRACE_PERF_SINK="$run\sink.jsonl"; $env:VITE_SERVER_URL='ws://localhost:2599'
Start-Process node -ArgumentList 'node_modules/vite/bin/vite.js','--port','5199','--strictPort','--host' -WorkingDirectory "<worktree>\client" -RedirectStandardOutput "$run\vite.log" -PassThru -WindowStyle Hidden | % Id | Out-File "$run\vite.pid"
Remove-Item Env:TERRACE_PERF_SINK, Env:VITE_SERVER_URL
```

Stop by the recorded pids. Vite does not reliably pick up edits made under `.claude\worktrees\`; restart it after every client change and confirm by fetching the module over HTTP.

Probe: `client/src/perfProbe.ts`, DEV-only, armed by `?perfprobe=<scenario>&settle=<ms>`. Scenarios: `overview` (default pose, 240 frames), `sculpt` (dolly to centre cell, 240 idle frames, then a 5 s held radius-4 stroke), `cyclone`. It POSTs one JSON line to `/__perf`, which Vite appends to `TERRACE_PERF_SINK` (absolute path required). Heartbeat lines `"settled"` and `"parked"` precede the report. The report carries `sample.msP50/msP95/msP99/msMax`, `drawCalls`, `triangles`, `uploadByShape`, `allBreakdown`, `slowBreakdown`, and for `sculpt` a `detail.idle` block.

Drive real Windows Chrome over CDP, not headless and not WSL (WSL browsers are SwiftShader; numbers from them are meaningless). Launch `C:\Program Files\Google\Chrome\Application\chrome.exe` with `--use-angle=d3d11 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --window-size=1420,1300 --remote-debugging-port=<port>` and a throwaway `--user-data-dir`. Attach with `Target.attachToTarget` flatten, `Page.navigate` to the probe URL, poll the sink for `"settled"`, then `Profiler.start` with a 200 µs sampling interval for 10 s, `Profiler.stop`, write the `.cpuprofile`. Aggregate self time per `functionName url:line` and inclusive time deduplicated per label along each stack; divide by `fpsMean × wallSeconds` for per-frame numbers. A working driver and aggregator from 2026-09-09 are archived under `.gpu-perf/results/2026-09-09-option3-profile/` (`cpu-profile-win.mjs`, `analyze2.py`); reuse or rewrite, either is fine.

Report every measurement with the exact command, the client version string from the report, and the window size. Label estimates as estimates.

## Out of scope for this arc

- Idle frame time. Known separate defect: every material with `transparent: true` and `side: DoubleSide` is drawn twice per frame by three.js with a forced program rebuild each pass (`forceSinglePass` unset); 30 such objects at the default pose cost about 0.6 ms/frame. Owner has not decided; do not change it here.
- The shared drawn-ground function (`shared/src/drawnGround.ts`, another agent's in-flight work on branch `worktree-agent-a8d5177dccd773647`). Do not touch that worktree. If step 2 needs its exports, wait for it to land on `main`.
- WebGPU. A separate gate sequence follows this arc only if this arc leaves a gap.
