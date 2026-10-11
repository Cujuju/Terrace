# Report — durable real-GPU frame benchmark, and the cyclone tower (#305)

Branch: `worktree-agent-a63a4f94ecd5ebe45`. Not merged.
Date: 2026-09-03. Machine: RTX 3090, Windows-side Chrome, `920.837cb4e`.

---

## 1. What was built

| file | what it is |
| --- | --- |
| `client/src/perfProbe.ts` (new, 749 lines) | the page-side probe: per-frame ms with p50/p95/p99/max, 1 % low, draw calls, triangles, GL upload time/volume **split per entry point**, and a per-callback breakdown over all frames and over the slowest 1 %. Gated on `?perfprobe=<scenario>`; `settle=<ms>` overrides the 45 s settle. |
| `client/src/main.tsx:65`, `:346` | the two install points, both inside `if (import.meta.env.DEV)`. The early one is before `createWorld` (that is what wraps `viewport.onFrame`, so core's and every plugin's handlers register through it); the late one sits in the existing DEV block beside the `__terrace` handle at `:337`. Verified in the file this session, not from the brief. |
| `client/vite.config.ts` (`perfSink`) | the `/__perf` POST sink, JSONL to `TERRACE_PERF_SINK`. **Required env, absolute path required, no `/tmp` default** — unset answers 503 naming the variable. |
| `scripts/gpu-bench.sh` | one command per sample: kills only the bench's own Chrome (matched on its throwaway `--user-data-dir`), launches Windows Chrome with the rig's flags and their reasons, polls the sink, prints one JSON line with `label`, `scenario` and `launchMode`. **Takes no desktop focus by default** — see §2b. Every timing and port is a named constant with its reason. |
| `scripts/gpu-bench-foreground.ps1` | the foreground raise, moved out of `$HOME`, **narrowed**, and **demoted to an opt-in fallback**. It takes a mandatory `-ProfileMatch` and only ever raises Chrome processes whose command line carries the bench's own profile directory; the `$HOME` original raised the first Chrome window it found, which could be the operator's. It also gained `-Once`. The original is left in place as asked. |
| `scripts/gpu-bench.md` | how to start the isolated stack (2599 / 5199, throwaway world in a project dot-dir), the full output-field contract, the A/B recipe, and the residuals. |

Scenarios (`SCENARIOS` in `perfProbe.ts`) — adding one is **one function plus one
table entry**, nothing else:

- `idle` — park on the cell under screen centre at `CAMERA_MIN_DISTANCE × 1.05`, sample 240 frames.
- `sculpt` — same park, 240 idle frames, then the patch's 5 s held radius-4 stroke (send-then-predict at `SCULPT_REPEAT_INTERVAL_MS`), kept in shape for A/B parity with the older `.gpu-perf/results/*.json`.
- `cyclone` — wait for the server's first `cyclone:all` carrying a storm, park on its eye at `radius × 1.15 / tan(fov/2)` (the whole deck framed, so two runs cannot frame different fractions of it), sample 240 frames.

**How the eye is found**, since the brief asked for the accessor at `file:line`:
the cyclone client plugin's storm list is module-private (`plugins/cyclone/client/index.ts:72`,
not exported), so the probe does **not** reach into it. It wraps
`pluginHost.routeMessage` (interface `client/src/plugins/host.ts:172`,
implementation `:934`) read-through and parses `cyclone:all` with the plugin's
own wire contract — `parseAllPayload`, re-exported from `@terrace/shared` at
`plugins/cyclone/protocol.ts:376`. Every message still reaches the host
untouched.

Typecheck: `npx tsc --noEmit -p client/tsconfig.json` clean (it includes
`vite.config.ts`). `bash -n scripts/gpu-bench.sh` clean. No tests added — none
were granted. No new dependencies.

**`perfProbe.ts` is 749 lines, past the ~300 the project style asks you to
consider splitting at. Considered and not split, deliberately:** it is one
measurement instrument, roughly half of it comment, and its four parts (upload
accounting, callback attribution, the sampler, the scenarios) all read and reset
the same two per-frame accumulators. Splitting them across modules would make
those accumulators cross-module mutable state — a worse shape than a long file.
The line the project style is protecting (a scenario is one function plus one
table entry) is drawn inside the file instead. Flagging it for the orchestrator
rather than deciding it silently.

## 2. Verification — a real run's JSON line

Truncated for the report; the ten full lines are in
`.gpu-perf/results/2026-09-03-305-cyclone-bench.jsonl`.

```json
{"scenario":"cyclone","gpu":"ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 (0x00002204) Direct3D11 vs_5_0 ps_5_0, D3D11)","clientVersion":"920.837cb4e","pixelRatio":1,"settleMs":45000,"cameraDistance":66.27388338050521,"programs":81,"geometries":142,"textures":20,"storm":{"id":1,"x":238,"y":212,"radiusCells":120,"intensity":0.804,"name":"Hurricane Ada"},"framedRadiusWorldUnits":30,"sample":{"frames":239,"fpsMean":242.98,"msMean":4.115,"msP50":4.100,"msP95":5.300,"msP99":6.100,"fps1pctLow":163.93,"msMax":8.700,"drawCalls":153,"drawCallsMax":153,"triangles":3074826,"uploadMsTotal":430.70,"uploadMBTotal":296.36,"uploadMaxCallMB":0.524,"slowBreakdown":{"frame ms":7.40,"raf renderFrame (src/render/scene.ts:229:17)":6.95,"renderer.render":6.40,"gl upload (inside render)":4.10,"frame pose mountPlugin (src/plugins/host.ts:607:36)":0.35},"allBreakdown":{"frame ms":4.115,"raf renderFrame (src/render/scene.ts:229:17)":3.949,"renderer.render":3.433,"gl upload (inside render)":1.800,"frame pose mountPlugin (src/plugins/host.ts:607:36)":0.367}},"fpsMean":242.98,"label":"main-cyclone-run1"}
```

The `gpu` string names the discrete 3090, so the frames are real. The
attribution works: it names `render/scene.ts:229`'s rAF, `renderer.render`, the
plugin host's pose phase and the GL upload separately, per frame.

## 2b. Launch modes — the focus grab was never necessary

Owner amendment: test the launch modes in order and record each. Done, one
`idle` run per mode on the same stack, same scenario, same settle. **Every mode
reported the discrete adapter (`ANGLE (NVIDIA, NVIDIA GeForce RTX 3090
(0x00002204) Direct3D11 vs_5_0 ps_5_0, D3D11)`) and a full 239-frame block — no
mode failed.**

| # | mode | flag | window | sink line | msMean | p95 | p99 | msMax | draws |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | flags only | *(default)* | lands wherever, untouched | arrived | **2.17** | 3.50 | 3.90 | 4.10 | 110 |
| 1b | flags only, **window minimised mid-run** | *(default)* | minimised by force as soon as it appeared | arrived | **1.83** | 2.90 | 3.60 | 4.70 | 115 |
| 2 | raise once | `--raise-once` | raised one time, focus then released | arrived | 2.74 | 4.20 | 4.80 | 5.00 | 123 |
| 3 | headless | `--headless` (=`--headless=new`) | none at all | arrived | 2.24 | 3.30 | 4.20 | 5.00 | 116 |
| 4 | continuous hold | `--raise-hold` | held foreground for the run | arrived | 1.72–4.77 across the ten §3 runs | | | | |

**Mode 1 is the default and nothing is raised.** The rig author's note that the
flags alone were insufficient is refuted: row 1b is the decisive test I added on
top of the amendment — the bench window was *minimised by force* mid-run, which
is as hidden as Windows can make it, and the page still sampled all 239 frames
at 1.83 ms mean. `--disable-features=CalculateNativeWinOcclusion` plus the three
backgrounding switches are sufficient on their own.

`--raise-once` and `--raise-hold` survive as documented escalations for the day
a Chrome or Windows update stops honouring those switches (symptom: `NO SAMPLE
after Ns`); `--raise-hold` is the only mode that steals focus and is last.
`--headless` reached the discrete adapter here, and the script now warns if a
run's `gpu` string names SwiftShader or llvmpipe, because a headless Chrome that
cannot reach the adapter falls back silently. Each output line records
`launchMode`, since a headless run and a windowed one are not automatically
comparable.

Caveat, stated: the §3 numbers were all taken in mode 4 (the hold), before the
amendment arrived. Modes 1–3 were measured afterwards on a freshly restarted
stack. Mode 1b's 1.83 ms and mode 1's 2.17 ms sit at the fast end of the §3
idle spread, so nothing suggests the default mode measures slower — but the §3
table and the mode table are not one controlled comparison.

## 3. The #305 numbers

Stack: server on 2599 with a copy of `frostwick-hollows.db` (512² world,
snapshot #525) in `.gpu-perf/bench-stack/worlds`, Vite on 5199. The owner's
2567/5173 were untouched throughout. Storm: `Hurricane Ada` forced at (238, 212),
radius 120 cells = 30 world units, intensity 0.804. Camera distance 66.27 world
units for every `cyclone` run, 10.09 for every `idle` run.

**Bar: ≥140 fps = ~7.1 ms on every frame.**

| run | storm | camera | msMean | p50 | p95 | p99 | 1 % low fps | msMax | draw calls |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| idle-run1 | none | centre | 2.98 | 2.90 | 4.60 | 5.40 | 185 | 5.90 | 118 |
| idle-run2 | none | centre | 2.07 | 1.90 | 3.10 | 3.90 | 256 | 3.90 | 117 |
| idle-run3 | none | centre | 1.72 | 1.60 | 2.90 | 3.40 | 294 | 4.70 | 104 |
| cyclone-run1 | yes | **on the eye** | 4.12 | 4.10 | 5.30 | 6.10 | 164 | 8.70 | 153 |
| cyclone-run2 | yes | **on the eye** | 4.26 | 3.70 | 8.20 | 16.60 | 60 | 25.70 | 146 |
| cyclone-run3 | yes | **on the eye** | 4.44 | 4.00 | 7.70 | 27.60 | 36 | 42.10 | 138 |
| idle-control-forced | yes | centre | 4.45 | 4.50 | 5.30 | 5.90 | 169 | 9.90 | 136 |
| cyclone-run4 | yes | **on the eye** | 3.96 | 4.10 | 5.10 | 6.10 | 164 | 8.20 | 153 |
| idle-forced | yes | centre | 4.18 | — | 5.80 | 18.30 | 55 | 23.20 | 113 |
| idle-nostorm (last) | none | centre | 4.77 | — | 7.70 | 34.40 | 29 | 69.00 | 130 |

### What holds

**Mean frame time never breaks the bar.** Every cyclone run sits at
3.96–4.44 ms against a 7.1 ms budget (243–253 fps).

**The tail does break it, and it breaks it with the storm absent too.** Cyclone
p99 ranged 6.10–27.60 ms and `msMax` 8.20–42.10 ms; but the *last* run of the
session, `idle` with **no storm at all**, measured p99 34.40 ms and
`msMax` 69.00 ms — worse than any cyclone run. The first three no-storm idles,
an hour earlier on the same build, measured 1.72–2.98 ms mean and p99 ≤ 5.40 ms.

**So the run-to-run drift on this machine over one session (idle mean 1.72 →
4.77 ms, p99 3.4 → 34.4 ms) is larger than the effect being measured.** The
owner's own server and client were running on 2567/5173 throughout, as were
other agents; I could not quiet the machine and must not touch their processes.

**The one comparison that survives is the back-to-back pair**, same server
process, minutes apart — camera framing the tower vs camera not on it:

| pair | on the eye | not on it | Δ mean | Δ draw calls |
| --- | ---: | ---: | ---: | ---: |
| A (`cyclone-run3` → `idle-control-forced`) | 4.44 | 4.45 | **−0.01 ms** | 138 → 136 |
| B (`cyclone-run4` → `idle-forced`) | 3.96 | 4.18 | **−0.22 ms** | 153 → 113 |

Framing the whole cyclone tower costs **no measurable mean frame time** on this
GPU. Both pairs put the storm's on-screen cost at or below the noise.

The +40 draw calls in pair B are **not** the storm: the cyclone plugin's entire
declared budget is 3 objects — `SPIRAL_DRAW_OBJECTS = 1`
(`plugins/cyclone/client/index.ts:219`) plus `MAX_SPIRALS × CYCLONE_RAIN_DRAW_OBJECTS`
= 2 (`:230`, `plugins/cyclone/client/rain.ts:116`). The difference is terrain and
water chunks entering the frustum at 66 world units instead of 10.

## 4. The tier-count lever, and why I am not naming it as the first one

The brief asked, if the bar broke, for the tier counts in
`plugins/cyclone/client/spiral.ts` as the first lever with the measured delta
per tier. **The measurement does not support that framing**, and here is the
primary-source reason.

Derived by executing the file's own exported arithmetic
(`.gpu-bench-run/tiers.mts`, importing `tiersAt`/`alongAt`/`PUFFS_PER_ARM` from
`plugins/cyclone/client/spiral.ts:355,360,372`):

- tiers per position: **3 at 15 of the 90 positions, 4 at 55, 5 at 20**
- `PUFFS_PER_ARM = 365`, `PUFFS_PER_SPIRAL = 3285` (`:372`, `:377`), pool capacity `2 × 3285 = 6570` (`MAX_SPIRALS = 2`, `:91`)
- per instance the deck writes a `mat4` plus six float attributes = **88 B**, so a full layout write for one storm is **3285 × 88 ≈ 0.29 MB**

But `writeLayout` (`:895`) runs only when `layoutDirty` (`:885`) — a deck added,
dropped, moved or resized, i.e. **on a server push, twice a second**, not per
frame; the six buffers are then uploaded as named ranges (`markUploaded`, `:966`).
That is ~0.58 MB/s. The probe measured **1.5–2.9 MB per FRAME** of
`bufferSubData` in both the storm and the no-storm runs, so the deck's instance
layout is between two and three orders of magnitude away from being the
per-frame upload cost.

Measured GL upload split, per frame (`uploadPerFrameByKind`):

| run | bufferSubData calls / ms / MB | texSubImage2D calls / ms / MB |
| --- | --- | --- |
| cyclone-run4 (storm framed) | 23.97 / 0.155 / 1.46 | 12.00 / 1.116 / 0.013 |
| idle-forced (storm off-camera) | 20.13 / 1.793 / 2.72 | 10.13 / 0.257 / 0.012 |
| idle-nostorm | 22.27 / 1.110 / 2.88 | 11.13 / 1.116 / 0.014 |

Call counts and byte volumes barely move with the storm; the ~1.2–2.2 ms of
"upload" time moves between the two entry points from run to run. That is a
driver pipeline stall landing on whichever upload call happens to hit it, not a
volume cost belonging to any one rig — and the no-storm run pays it too.

**Conclusion for the owner's decision:** the cyclone tower is not, on this
hardware, spending a measurable share of the 7.1 ms budget. A tier reduction has
at most ~0.2 ms of mean frame time available to win. If the tiers are to be
retuned it should be for a reason other than frame cost, or after the same
measurement is repeated on a quiet machine. **Nothing was retuned**, as
instructed.

## 5. Assumptions I could not verify

- **The session's absolute numbers are not a clean baseline.** The owner's stack
  and other agents were live on this machine for every run; I had no way to
  quiet it and no permission to stop anything of theirs. Everything in §3 other
  than the two back-to-back pairs should be treated as a distribution, not a
  measurement.
- **Whether the tail excursions (p99 up to 34 ms, max 69 ms) are a real client
  defect or contention with the other processes on the box is unresolved.** They
  appear with and without the storm. That is worth its own issue on a quiet
  machine; it is the single largest thing standing between this repo and "≥140 fps
  on every frame", and it is not #305's.
- `intensity` came back as **0.804**, not 1, on a storm `dev.ts:104` sets
  `envelope = 1` on and freezes. I did not chase where the remaining factor is
  applied; the deck was drawn at that strength for every cyclone run, so the
  runs are comparable with each other but may under-state a full-strength storm.
- The `frostwick-hollows` copy logs `dropped N malformed layered column(s)` on
  several chunks at load. Pre-existing in that world file, unrelated to this
  change, and identical across every run — but it means those chunks render
  less than a clean world would.

## 6. One thing found on the way, not fixed

`client/src/render/scene.ts:209–217` carries three lines marked **"TEMPORARY
PERF PROBE — not for commit"** that *are* committed (introduced in `945a556`):
a module-level `scene0Holder` and two un-gated `globalThis.__terraceRenderer` /
`__terraceScene` writes. They are **not** behind `import.meta.env.DEV`, so they
ship in production builds and hold the renderer and scene alive off a global.
The `__terrace` handle at `main.tsx:337` already exposes both, properly gated.

Left alone deliberately: several `.gpu-perf/*.mjs` CDP tools read those globals,
so removing them is its own change with its own verification. Flagged for the
orchestrator to file.

## 7. The command a future agent runs

With the stack up per `scripts/gpu-bench.md` §1:

```bash
TERRACE_PERF_SINK=/abs/path/sink.jsonl bash scripts/gpu-bench.sh cyclone my-label
```

No flag needed and no desktop focus taken. If a future Chrome or Windows build
ever makes that report `NO SAMPLE after Ns`, escalate through `--raise-once`,
then `--headless`, then `--raise-hold` (§2b).
