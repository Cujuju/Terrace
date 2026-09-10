# Gate 2 — laptop (Apple M4 Max, macOS)

Step 1 and step 2 complete on 2026-09-09. Step 3 (battery runs) not started.

adapter: apple, metal-3, timestamp-query **yes**, Vivaldi 8.2.4133.47 (Chromium 152)
macOS: 26.6.2   display: Built-in Liquid Retina XDR, 3456x2234, 120 Hz   brightness: not recorded (step 3)

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
- Battery-run conditions (unplugged, other apps quit) are NOT yet established.
  The owner has asked to leave other applications running for step 3, which
  departs from "Every other app quit" — other apps' draw lands in the same
  combined mW figure. Absolute mW will read high. A-vs-C (the kill criterion) is
  inflated on both sides; A-idle vs B is the comparison most at risk.

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

Note `rpc()` in run.mjs still has no timeout, so any protocol stall hangs the
driver silently rather than failing. This cost 38 minutes once. Worth adding a
generous per-call timeout before the unattended battery runs.

## Step 3 — not started

Blocked on two things, both requiring the owner at the machine:
- `sudo` requires a password, so `sudo powermetrics` cannot be driven from the
  agent session.
- The laptop is on AC power at 100%. The handoff requires unplugged, above 60%.

| run | what | fps | battery start -> end | CPU mW | GPU mW | combined mW | Chrome CPU % | fans |
|---|---|---|---|---|---|---|---|---|
| A | page gpu, edit=100 | | | | | | | |
| A-idle | page gpu, no edits | | | | | | | |
| A-cpu | page cpu mesh, no edits | | | | | | | |
| B | client, probe overview, idle | | | | | | | |
| C | client, hand sculpting | | | | | | | |

Kill criterion, unchanged: if A draws more combined mW than C, or step 1 finds no
adapter, WebGPU does not solve the laptop's power problem. Step 1 passed.
