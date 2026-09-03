# The real-GPU frame benchmark

One command gives one JSON line of real frame times from the machine's discrete
GPU. Written so an agent (Anthropic's or pi's) can run it cold.

Three pieces, all committed:

| piece | what it is |
| --- | --- |
| `client/src/perfProbe.ts` | the page-side probe and the scenario table. DEV-only, inert without `?perfprobe=<scenario>`. |
| `client/vite.config.ts` (`perfSink`) | the `/__perf` POST sink, writing JSONL to `TERRACE_PERF_SINK`. |
| `scripts/gpu-bench.sh` + `scripts/gpu-bench-foreground.ps1` | launches Windows Chrome at the probe URL, holds its window foreground, waits for the sample, prints it. |

## Why it is shaped this way

Linux-side Chrome on this machine has no `/dev/dri`, so every browser inside
WSL2 — headless or under WSLg — renders on SwiftShader, where triangles cost
everything and draw calls cost nothing. That inverts the exact tradeoff most of
this renderer's work turns on, so **no number measured inside WSL can judge it**.
Only Windows-side Chrome has the RTX 3090.

And only ONE direction of the WSL2 NAT boundary is open without firewall
changes: Windows → WSL localhost. An inbound CDP socket from WSL to Windows
times out. So the page cannot be *driven*; it measures itself and POSTs its
report back to the dev server that served it.

## Run it

Three terminals' worth of setup, then one command per sample.

### 1. The isolated stack — NEVER the owner's ports

The owner's own server is on **2567** and their Vite on **5173**. A bench must
never touch either, nor their `WORLDS_DIR`. Use 2599 / 5199 and a throwaway
world copied into a project dot-dir (`.gpu-perf/` is already gitignored; nothing
working ever goes in `$HOME`).

```bash
ROOT=/mnt/e/Development/Projects/Terrace        # or your worktree
STACK=$ROOT/.gpu-perf/bench-stack               # throwaway world + logs live here
RUN=$ROOT/.gpu-bench-run                        # pids + the sink
mkdir -p "$STACK/worlds" "$RUN"

# A COPY of a grown world, never the live file: the owner's server may be
# writing it, and a hot WAL makes the copy unreadable.
cp $ROOT/server/data/worlds/<some-world>.db "$STACK/worlds/"
printf '%s' '<some-world>' > "$STACK/worlds/.active"

# The server. CYCLONE_DEV_FORCE=1 only for the `cyclone` scenario.
cd "$ROOT/server"
PORT=2599 WORLDS_DIR="$STACK/worlds" DB_PATH="$STACK/nonexistent.db" \
  nohup node src/index.ts > "$RUN/server.log" 2>&1 &
echo $! > "$RUN/server.pid"

# Vite. TERRACE_PERF_SINK must be ABSOLUTE — Vite runs in client/, the bench
# script polls from the repo root, and a relative path would be two files.
cd "$ROOT/client"
TERRACE_PERF_SINK="$RUN/sink.jsonl" VITE_SERVER_URL=ws://localhost:2599 \
  nohup npx vite --port 5199 --strictPort --host > "$RUN/vite.log" 2>&1 &
echo $! > "$RUN/vite.pid"
```

Wait for `listening on ws://0.0.0.0:2599` in `server.log` — loading a grown
world takes up to a minute.

**Stop it by the recorded pid, from a script file.** Never `pkill -f`: it
self-matches the shell running it, and would take out other agents' processes.

**Vite on `/mnt/e` never watches** (drvfs delivers no inotify events). Restart
Vite after every client edit or you are benchmarking the old bundle.

### 2. One sample

```bash
export TERRACE_PERF_SINK=$RUN/sink.jsonl      # the same absolute path Vite got
bash scripts/gpu-bench.sh <scenario> <label>
```

**The default takes no desktop focus.** A window opens, wherever Windows puts
it, and nothing is raised.

`<scenario>` is a key of `SCENARIOS` in `client/src/perfProbe.ts`:

| scenario | what it does | needs |
| --- | --- | --- |
| `idle` | parks on the cell under the screen centre at stroke zoom (`CAMERA_MIN_DISTANCE × 1.05`), samples 240 frames | — |
| `sculpt` | same park, 240 idle frames, then a 5 s held radius-4 stroke; A/B-comparable with the older `.gpu-perf/results/*.json` | — |
| `cyclone` | waits for the server's first `cyclone:all` storm, parks on its eye framing the whole deck (`radius × 1.15 / tan(fov/2)`), samples 240 frames | server started with `CYCLONE_DEV_FORCE=1` |

Each run takes ~2 minutes: 45 s settle (chunk streaming, and Vite's
dependency-optimiser reload if the page gets one), plus Chrome start and
sampling.

Optional environment: `TERRACE_PROBE_URL` (default `http://localhost:5199`),
`TERRACE_PROBE_SETTLE_MS` (default 45000).

### Launch modes — measured, not assumed

Chrome stops running `requestAnimationFrame` **and** `setTimeout`/`setInterval`
in a page it considers hidden, and rAF is the sampling loop, so a hidden page
reports nothing and reads exactly like a crash. The rig this replaced worked
around that by holding the bench window foreground for the whole run, stealing
the desktop. That turns out to be unnecessary. Measured 2026-09-03, same stack,
same `idle` scenario, one run each — every one reported the discrete adapter
(`ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 … D3D11)`) and a full 239-frame block:

| mode | flag | window | result |
| --- | --- | --- | --- |
| flags only | *(default)* | lands wherever, untouched | **2.17 ms mean**, p99 3.90, max 4.10, 110 draw calls |
| flags only, **window minimised mid-run** | *(default)* | minimised by force once it appeared | **1.83 ms mean**, p99 3.60, max 4.70, 115 draw calls |
| raise once | `--raise-once` | raised one time, then focus released | 2.74 ms mean, p99 4.80, max 5.00, 123 draw calls |
| headless | `--headless` | none at all | 2.24 ms mean, p99 4.20, max 5.00, 116 draw calls |
| continuous hold | `--raise-hold` | held foreground all run | 1.72–4.77 ms mean across ten runs earlier the same day |

The second row is the decisive one: a **minimised** window — which is as hidden
as Windows can make it — still sampled every frame at full rate. So
`--disable-features=CalculateNativeWinOcclusion` plus the three backgrounding
switches are sufficient on their own, and **nothing needs to be raised**.

`--raise-once` and `--raise-hold` remain as escalations for the day a Chrome or
Windows update stops honouring those switches: the symptom is `NO SAMPLE
after Ns`, and the fix is to try the next mode up. `--raise-hold` steals desktop
focus for the length of the run and is the last resort.

`--headless` also works and reached the discrete adapter here, but **check the
`gpu` field on every headless run**: a headless Chrome that cannot reach the
adapter falls back to SwiftShader silently, and a SwiftShader number cannot
judge anything in this renderer. The script prints a warning if it sees one.

The mode used is recorded in each output line as `launchMode`, because a
headless run and a windowed one are not automatically comparable.

### 3. Add a scenario

One function of type `Scenario` and one entry in the `SCENARIOS` table in
`client/src/perfProbe.ts`. Nothing else — not the sink, not the shell script.

## The output line

One JSON object, printed and appended to the sink.

| field | meaning |
| --- | --- |
| `label`, `scenario` | what you passed on the command line |
| `launchMode` | `none` (default), `once`, `hold` or `headless` — see the launch-mode table |
| `gpu` | the unmasked WebGL renderer string. **If this does not name the discrete GPU, throw the run away** — you measured SwiftShader. |
| `clientVersion` | `<commit count>.<short hash>` of the bundle that was served |
| `pixelRatio`, `cameraDistance`, `settleMs` | the framing the sample was taken at |
| `programs`, `geometries`, `textures` | `renderer.info` totals at the end of the run |
| `sample` | the frame block the run is judged on (below) |
| `fpsMean` | copied from `sample`, top level, so a poll can find the one number the bar is written in |
| scenario extras | `cell` (idle, sculpt), `intentsSent` + `idle` block (sculpt), `storm` + `framedRadiusWorldUnits` (cyclone) |
| `error`, `stack` | the run failed; nothing else is present |

A `sample` block:

| field | meaning |
| --- | --- |
| `frames` | frames in the block (the first is dropped — it has no interval) |
| `msMean`, `msP50`, `msP95`, `msP99`, `msMax` | frame interval, milliseconds |
| `fpsMean`, `fps1pctLow` | `1000 / msMean` and `1000 / msP99` |
| `drawCalls`, `drawCallsMax`, `triangles` | `renderer.info.render`; the plain figures are MEDIANS, because the counters step when a chunk streams in |
| `uploadMsTotal`, `uploadMBTotal`, `uploadMaxCallMB` | synchronous GL upload time and volume over the block |
| `uploadPerFrameByKind` | per-frame mean calls / ms / MB for `bufferData`, `bufferSubData`, `texSubImage2D` — "many bytes" and "many calls" are different bugs |
| `allBreakdown` | mean ms per attribution key over every frame, sorted desc: each `viewport.onFrame` handler named by its registration site, `renderer.render`, each timer/rAF/message handler, `gl upload (inside render)` |
| `slowBreakdown` | the same, over the slowest 1 % of frames — where a tail excursion names itself |

**The bar** (owner, 2026-08-26): ≥140 fps on this machine, i.e. **~7.1 ms on
every frame** — so `msP99` and `msMax`, not just `msMean`.

## A/B recipe

```bash
# Baseline, on the checkout you are comparing against.
bash scripts/gpu-bench.sh idle before-<sha>      # x3
# Then the change (a worktree; symlink each package's node_modules from the
# main checkout rather than reinstalling), restart Vite, and:
bash scripts/gpu-bench.sh idle after-<sha>       # x3
```

Rules that make the two comparable:

- **Same world, same scenario, same window size.** Frame time is a function of
  pixel count; the script pins 1600×900 for that reason.
- **At least three runs a side, and read the spread, not the best.** Run-to-run
  variation on this machine is large when anything else is running on it — a
  session on 2026-09-03 measured the same `idle` scenario at 1.72 ms and
  4.77 ms mean an hour apart, with p99 from 3.4 ms to 34.4 ms. **If the effect
  you are chasing is smaller than that spread, quiet the machine before you
  conclude anything.** The pairs to trust are ones taken back-to-back.
- **Interleave** before/after runs rather than doing three then three, when you
  cannot quiet the machine.
- Keep the results: `.gpu-perf/results/` is gitignored and is where they go.

## Residuals, stated

- `medianSpliceMs` (`client/src/render/terrainMeshes.ts:1741`) is **not**
  reported. The old patch reached it through a `__terraceMeshes` global written
  from `client/src/world.ts`'s hot path; exposing it properly means widening the
  `World` interface for a diagnostic, which was not this change's to decide. The
  `sculpt` scenario's other numbers are unaffected.
- The pre-cull per-layer draw-object walk the old patch carried is not ported —
  `renderer.info.render.calls` is the number the bar is written in.
- `texSubImage2D` byte volume is counted as `width × height`, i.e. a volume, not
  exact bytes; its call count and time are exact.
