# Boats owns half the frame's draw calls

Measured 2026-09-05 on the RTX 3090 via `scripts/gpu-bench.sh ablate`.
Handoff for whoever is already working on boats — this is a rendering-shape
change, not a gameplay change.

## The measurement

Five ablation runs (hide the plugin's layer, re-measure) across three
methodologies. Boats was the top row in every frozen run and owned the same
share of draw calls in all five:

| run | method | boats GPU ms saved | boats draw calls |
| --- | --- | --- | --- |
| 1 | single baseline (flawed, drifts) | 2.55 | 135 |
| 2 | single baseline (flawed, drifts) | 3.48 | 172 |
| 3 | interleaved baseline, live sim | 0.91 | 151 |
| 4 | interleaved baseline, frozen sim | 1.15 | 150 |
| 5 | interleaved baseline, frozen sim | 2.57 | 158 |

Whole-frame context from run 5, same run, same camera (the world-framing
`overview` pose, camera untouched):

- frame GPU p50 **8.46 ms** against a 6.94 ms budget (the ≥140 fps bar in
  `docs/DESIGN.md`) — the client is GPU-bound, not CPU-bound.
- **~305 draw calls total**, of which boats is **~150**.
- Core with every plugin and named core rig hidden: **2.29 ms, 37 draw calls**.

The GPU-millisecond column is the noisy one (per-step error bar ranged ±0.21 to
±0.74 ms between runs). **The draw-call column is not noisy** and is the claim
this brief rests on.

## The cause — verify these lines before trusting this paragraph

1. `plugins/boats/client/models.ts:376` — `create()` calls
   `instantiateRig(blueprint)` once per boat.
2. `client/src/render/rigSkin.ts:405-435` — `instantiateRig` builds a fresh
   `Group`, a fresh `Skeleton`, and **one `SkinnedMesh` per surface, per
   instance**. Nothing is instanced.
3. `plugins/boats/client/models.ts:382` — plus one more `Mesh` for the sail,
   with a **cloned material per boat** (`installed.sailMaterial.clone()`,
   line 380) so it can be tinted when fighting (line 419).
4. `plugins/boats/client/models.ts:372` — `drawObjects = blueprint.surfaceCount
   + 1`, and `plugins/boats/client/index.ts:181-183` —
   `drawBudget = BOATS_PAYLOAD_CAP * BOAT_SHAPE.drawObjects`.
5. `plugins/boats/protocol.ts:327` — `BOATS_PAYLOAD_CAP = 2048`.

So: **3 draw calls per boat, linear in fleet size, with no instanced path.**
~50 boats afloat is the ~150 calls measured. The declared budget is
`2048 × 3 = 6144` draw calls, which the plugin is entitled to and which no
frame can afford.

## The alternative already in this repo

`client/src/render/rigHerd.ts` is the instanced skinned-rig path, used today by
wildlife (`plugins/wildlife/client/models.ts:352`). It draws a whole herd in a
handful of `InstancedMesh` calls by quantising animation into shared pose slots
(`POSE_SLOTS_PER_HERD = 32`, `plugins/wildlife/client/models.ts:173`) held in a
bone-matrix palette texture, with per-instance transforms in an instance
buffer.

Boats' animation looks compatible, but **check each of these before
committing to the approach** — they are the reasons it might not be:

- **Oar swing and swell are pure functions of `elapsed + phase`**
  (`models.ts:404-412`), which is exactly the shape a pose slot quantises. Good.
- **`fighting` changes the stroke RATE** (`models.ts:407`,
  `OAR_FIGHTING_RATE`). A rate change is not a phase offset, so fighting and
  non-fighting boats do not share a pose cycle. Likely needs two herds, or the
  fighting rate expressed as a phase multiplier.
- **The sail is tinted per boat** (`models.ts:419-421`). A cloned material per
  instance defeats instancing outright; this has to become an instanced colour
  attribute, or the sail has to leave the instanced set.
- **The sail is not part of the baked rig** — `sailNode.removeFromParent()`
  before `bakeRig` (`models.ts:350-357`). It is a separate `Mesh` parented to
  the instance root, so it needs its own instanced path regardless.

## What is NOT established, and must not be assumed

- **That instancing will actually recover the GPU milliseconds.** The draw-call
  reduction is certain; the frame-time win is not. Boats' GPU-ms saving swung
  0.91–3.48 across runs, so measure before and after with the same scenario
  rather than quoting a number from this brief.
- **That rigHerd is free.** Its palette upload is itself a measured stall: the
  `texSubImage2D 92x32` / `68x32` calls in the upload report are wildlife bone
  palettes at **0.89 ms and 0.63 ms per call**, and cost there does not scale
  with size (344×32 costs 0.031 ms), which is the signature of a driver stall
  on a texture still in use by the in-flight frame. Moving boats onto rigHerd
  trades ~150 draw calls for another palette upload per frame. That may still
  be a large win — but it is a trade, not a free lunch, and it needs measuring.
- **Whether ~50 boats is representative.** The fleet size at measurement time
  was not recorded. `4b85631 feat(boats): war boats form squadrons and sail the
  open sea` landed mid-session, so the population is actively growing and the
  per-boat cost matters more now than when these numbers were taken.

## How to measure it

Isolated bench stack on ports 2599/5199 against a **copy** of a grown world —
never the owner's 2567/5173 stack or their live `.db`. Full recipe in
`scripts/gpu-bench.md`.

```bash
export TERRACE_PERF_SINK=<abs>/.gpu-bench-run/sink.jsonl
bash scripts/gpu-bench.sh ablate <label>     # per-rig table, sim frozen
bash scripts/gpu-bench.sh overview <label>   # whole-frame GPU/CPU split
```

Read `sample.gpuMsP50` (frame GPU time), `sample.drawCalls`, and the
`ablation[]` row for `boats`. `noise.baselineGpuMsMeanStep` is the error bar —
**a row that does not clear it means nothing.**

Vite on `/mnt/e` never watches (drvfs delivers no inotify events): restart Vite
after every client edit or you are benchmarking the old bundle.
