# Gate 2 — laptop (Apple M4 Max, macOS)

Step 1 and step 2 complete on 2026-09-09. Step 3 (battery runs) complete on 2026-09-10.

adapter: apple, metal-3, timestamp-query **yes**, Vivaldi 8.2.4133.47 (Chromium 152)
macOS: 26.6.2   display: Built-in Liquid Retina XDR, 3456x2234, 120 Hz   brightness: ~50%, fixed, auto-brightness and True Tone off

## Step 1 — adapter

`navigator.gpu.requestAdapter()` on a `http://127.0.0.1` page returns an adapter:
vendor `apple`, architecture `metal-3`, `device` and `description` empty.
`timestamp-query` is present, so every GPU figure below is a real timestamp
query, not the wall-clock fallback. 26 features total, including `subgroups`,
`shader-f16`, `texture-formats-tier2`, `maxStorageBufferBindingSize` 4294967292.

Gate 2 is not killed at step 1.

## Step 2 — correctness and timings

Node self-checks: all 6 pass.

| | laptop | desktop (RTX 3090) | ratio |
|---|---|---|---|
| draw p50, gpu mesh | 2.348589 ms | — | |
| draw p50, cpu mesh | 3.735110 ms | — | |
| rebuild wall | 3.5 ms | — | |
| rebuild gpu | 3.28145 ms | 2.5 ms | 1.31x |
| rebuild serial per-chunk | 228.6 ms | — | |
| first rebuild wall | 201 ms | — | |
| count pass | 121.7 ms | — | |
| edit heaviest gpu | p50 2.708793 / p95 2.715541 / max 2.916997 ms | 2.1 ms p50 | 1.29x |
| edit median gpu | p50 0.572824 / p95 0.576866 / max 0.578824 ms | 0.44 ms p50 | 1.30x |
| cpu mesher full build | 806.2 ms | 938 ms | 0.86x (laptop faster) |
| resident GPU | 189.6 MB | — | |

Triangles: gpu 5,207,349 / cpu 3,917,911. The GPU mesh draws 1.59x faster than
the shipped CPU mesh while carrying 33% more triangles.

The three GPU measures sit at a near-uniform 1.29-1.31x of the desktop, which is
what a straightforwardly slower GPU looks like — no single measure is an outlier,
so nothing here points at a fallback path or a stall.

### Criteria

| criterion | value | limit | |
|---|---|---|---|
| band parity mismatches | 158 | 0 | FAIL |
| band parity holes | 0 | 0 | pass |
| isoline port mismatches | 0 | 0 | pass |
| pixel mismatch fraction | 0.2298% | 0.1% | FAIL |
| compute per chunk p50 | 0.11279 ms | 0.1 | FAIL |
| full-world rebuild | 3.5 ms | 50 | pass |
| draw p50 | 2.348589 ms | 1 | FAIL |
| resident GPU bytes | 189,581,964 | 207,000,000 | pass |

parity: 158 mismatches, 0 holes, 73679 exempt of 4198401
pixels: 2482 / 1080000 = 0.2298%, metric noise floor 2056 / 1080000 = 0.1904%
(desktop noise floor was 0.191% — reproduced almost exactly)

**Parity is 158, not the documented 157.** The handoff says to stop and report if
this moves; reported, and the owner said to continue and collect the rest.
Two runs — one perturbed by browser first-run setup, one clean — produced
byte-identical parity and pixel figures, so 158 is deterministic on this machine
and not measurement noise. All sampled mismatches carry the same single-band-off
boundary signature as the documented 157 (`mesh band -11, function band -12`).
For scale, the shipped CPU mesh scores 574 mismatches and 4097 holes against the
same function, so the GPU mesh remains far tighter than the thing it replaces.

**`compute per chunk p50` straddles its limit.** 0.099788 (pass) in the perturbed
run, 0.11279 (fail) in the clean one. It is on the boundary and flips between
runs; which side it lands on carries no signal.

**`draw p50` fails, but the shipped mesher fails it worse** (3.735 vs 2.349 ms).
At 120 Hz the frame budget is 8.33 ms, so draw takes ~28% of it with the GPU mesh
and ~45% with the CPU mesh. This is genuine draw work, not a refresh artifact.

## Deviations from the handoff

- **Browser is Vivaldi 8.2.4133.47, not Google Chrome.** Chrome is not installed
  on this laptop; the owner directed using Vivaldi. Same Chromium engine family
  (152), but the desktop numbers were taken on Chrome.
- **Step 2 ran with a visible window, not headless**, at the owner's direction.
  Vivaldi has no usable headless mode. Geometry figures are unaffected (identical
  across runs); the timings were taken while compositing to screen.
- Display is 120 Hz here; the desktop display is 144 Hz. Any fps comparison
  across the two machines is against different caps.
- Other applications stayed running for step 3, at the owner's direction,
  including the owner's own Vivaldi window (separate profile) and this agent
  session. Their draw lands in every run's figures equally.

## run.mjs changes required for Vivaldi

Four fixes, all opt-in — default behaviour for Chrome on desktop/Windows is
unchanged. Step 2 was run as:

```
GATE1_CHROME="/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" \
GATE1_HEADLESS=0 GATE1_REUSE_TAB=1 GATE1_PROFILE=/tmp/gate2 node run.mjs
```

- `GATE1_HEADLESS=0` — drops `--headless=new`. Vivaldi has no usable headless mode.
- `GATE1_REUSE_TAB=1` — Vivaldi hands `Target.createTarget` a tab with no renderer
  behind it: the session attaches, then every session-scoped command hangs
  forever. Tabs the browser opens itself work. Reuses the launch tab and
  navigates it per page; pages open and close one at a time, so one tab serves all.
- The reuse lookup polls (30 s), because Vivaldi builds its window asynchronously
  and the first tab lands seconds after the devtools endpoint answers.
- The reuse lookup skips targets with an empty url — an uncommitted document is
  the same dead-tab class, and taking one wedged a run for 38 minutes.
- `GATE1_PROFILE=<dir>` — a fresh profile makes Vivaldi run its first-run wizard
  on every launch, which needs a human mid-measurement and perturbs the run. Only
  a temp profile is deleted afterwards. `/tmp/gate2` has been through setup.

`rpc()` in run.mjs now has a 300 s per-call timeout (added before step 3), so a
protocol stall fails the run instead of hanging it.

## Step 3 — battery runs

All five runs 2026-09-10, 20:43-21:51, back to back, ten minutes each (600
one-second powermetrics samples), unplugged, battery 100% at the start of A and
60% at the end of C. Browser: Vivaldi, profile `/tmp/gate2`, one window, one
tab, viewport 1200x900 CSS px at devicePixelRatio 2, not fullscreen.

| run | what | fps | battery start -> end | CPU mW | GPU mW | combined mW | Vivaldi CPU % | fans |
|---|---|---|---|---|---|---|---|---|
| A | page gpu, edit=100 | 119.9 | 100% -> 100% (mAh not recorded) | 223 | 3,927 | 4,150 | 26.3 | see note |
| A-idle | page gpu, no edits | 120.0 | 100% -> 99%, 8295 -> 8074 mAh | 204 | 3,615 | 3,819 | 29.0 | see note |
| A-cpu | page cpu mesh, no edits | 120.0 | 99% -> 96%, 8051 -> 7863 mAh | 244 | 2,799 | 3,043 | 30.4 | see note |
| B | client, probe overview, idle | 56.8 | 94% -> 80%, 7676 -> 6548 mAh | 7,398 | 38,397 | 45,796 | 38.3 | see note |
| C | client, sculpting (synthetic) | not measured | 75% -> 60%, 6144 -> 4830 mAh | 8,091 | 35,710 | 43,801 | 57.4 | see note |

GPU active residency, mean over the run: A 80.4%, A-idle 81.8%, A-cpu 79.2%,
B 99.7%, C 99.7%.

Whole-system draw from the battery's raw charge (mAh x mean voltage over the
595 s between readings; the gauge is an estimate, treat as approximate):
A-idle 17.1 W, A-cpu 14.4 W, B 81.7 W, C 90.9 W. This includes the display,
DRAM and fabric, and the other running apps; powermetrics' combined figure is
CPU + GPU + ANE only.

Run A detail (`A-loopstats.json`): 5681 edits in 594 s (9.6 / s), edit GPU
p50 1.76 / p95 5.06 / max 9.86 ms.

Run B probe block (`B-client-overview.json`, 240 frames): frame p50 17.8 /
p95 19.1 / p99 19.8 ms, mean 56.8 fps, GPU p50 25.7 / p99 27.8 ms, 182 draw
calls, 4,377,251 triangles, render target 2400x1800 (pixel ratio 2).

### Verdict

**Kill criterion not met.** A draws 4,150 mW combined; C draws 43,801 mW. The
GPU mesher sculpting at ten edits a second costs about a tenth of what the
shipped client costs while being sculpted. Step 1 passed. Gate 2 passes.

### Reading it

- **A-idle vs B: 3,819 vs 45,796 mW, 12x.** Same pose, same terrain. Not
  like-for-like: the client renders 4x the pixels (pixel ratio 2 against the
  page's 1, owner chose to keep it), runs the probe's timing hooks (owner chose
  to keep them), and draws the whole scene with plugins, water, weather and
  audio. The client cannot hold the 120 Hz cap (56.8 fps) and saturates the GPU
  (99.7% active). The page holds 120 fps at ~80% GPU residency.
- **A vs A-idle: +331 mW** for ten edits a second on the GPU mesher.
- **B vs C: C is 1,995 mW lower in combined mW, but 9 W higher whole-system.**
  Both runs are GPU-saturated, so sculpting cannot add GPU work. It raises CPU
  (+693 mW) and Vivaldi CPU (38% -> 57%). C ran last, at 75% -> 60% battery
  with the lowest voltage of any run; whether the lower GPU figure is a power
  limit at lower charge is not established.
- **A-idle vs A-cpu: 776 mW, not near zero as the handoff expected.** Both draw
  through the same pipeline, one non-indexed draw per frame; only the vertex
  buffer differs. The GPU mesh carries 5.21 M triangles against the CPU mesh's
  3.92 M (1.33x), and A-idle's GPU power is 1.29x A-cpu's. Hypothesis, not
  tested: at a fixed 120 fps, power tracks triangle count rather than draw time
  (the GPU mesh draws faster in step 2, 2.35 vs 3.74 ms). If it holds, the GPU
  mesher's denser output costs ~0.8 W to display, independent of meshing.
- Neither A-idle nor B supports the "60 fps cap as the cheapest lever" reading
  cleanly: the page already runs at 120 fps for under 4 W, and the client never
  reaches 60.

### Step 3 conditions and deviations

- **Run C was driven by a script, not by hand**, at the owner's direction.
  `drivers/sculpt.mjs` sends real pointer input over CDP: one stroke every
  100 ms at a random point in the middle half of the viewport (move, press,
  drag 3 px, release after 60 ms), in raise/lower pairs at one spot (left, then
  shift+left) so the world stays near its starting shape. 5750 strokes in
  575 s, starting 15 s into the window; 5072 WebSocket frames sent, 31,418
  received (`C-strokes.txt`). Mana never limited it: +166/s regeneration
  against 7 per use. Repeatable, unlike the handoff's hand-driven C, but not a
  human's stroke pattern. The client has no frame counter without the probe,
  so C's fps is not measured.
- **The handoff's powermetrics awk doubles the GPU figure.** `GPU Power` prints
  twice per sample (cpu_power and gpu_power sections) and the two can differ.
  The summaries here take the first, the one that sums into `Combined Power`;
  CPU + GPU + ANE matches Combined to within 1 mW in all 3,000 samples.
- **Minute-five top** takes two samples one second apart and keeps the second
  (the first has no CPU delta), filtered to the gate browser's own process tree
  so the owner's Vivaldi is excluded. The Vivaldi CPU % column is that total.
- **`__loopStats()` read over CDP**, not the DevTools console, so DevTools was
  never open during a measurement.
- **Run A's first ~30 s had two extra tabs** restored from step 2's session: a
  dead `127.0.0.1:63415` page (its server long gone) and `about:blank`. Closed
  over CDP ~30 s in. Later runs clear the profile's session before launch and
  close any stray tab after sizing; each `<run>-window.txt` records the tab list.
- **Run A has no raw mAh reading**; the driver recorded it from A-idle on. The
  percentage sits at 100% through A (macOS holds 100 near full charge).
- **Run B's probe block was sampled just after the power window**, not in it:
  the probe waits out `settle=600000` and then samples 240 frames. Conditions
  were unchanged. Before B, the client was loaded once for 60 s and closed so
  Vite's first-load dependency build fell outside the window.
- **The server simulated throughout B and C** (tornadoes ~every 174 s, active
  volcanoes, mudslides), as the shipped game does. One server process served
  both B and C; world state carried over from B into C.
- The client played audio (Vivaldi held a "Playing audio" assertion).
- **Fans: heard in several runs, not attributed per run.** Reported by the
  owner after the session; the owner's estimate is that fans ran in whichever
  runs drew more than 15 W. On combined CPU + GPU mW only B and C exceed that;
  on whole-system draw from the battery A-idle (17.1 W) does too.
- Battery ran from 100% to 60% across the session; the later runs (B, C) ran at
  lower charge and voltage than the A runs.

Drivers are in `drivers/`: `battery.sh` (one run: sampler, browser, top,
loop stats, battery, summary), `cdp.mjs` (window sizing and page evaluate),
`closeothers.mjs`, `sculpt.mjs`. Invocations:

```
drivers/battery.sh A      'http://127.0.0.1:9320/mesher.html?src=gpu&loop=1&edit=100' loopstats
drivers/battery.sh A-idle 'http://127.0.0.1:9320/mesher.html?src=gpu&loop=1' loopstats
drivers/battery.sh A-cpu  'http://127.0.0.1:9320/mesher.html?src=cpu&loop=1' loopstats
WAIT_SINK=$PWD/B-client-overview.json drivers/battery.sh B 'http://localhost:5173/?perfprobe=overview&settle=600000'
drivers/battery.sh C 'http://localhost:5173/' & sleep 15; node drivers/sculpt.mjs localhost:5173 575
```

The A runs need `node run.mjs --serve 9320`; B and C need
`TERRACE_PERF_SINK=... python3 run_server.py`. `battery.sh` needs a sudoers
NOPASSWD rule for `/usr/bin/powermetrics` and has absolute paths for this
laptop.
