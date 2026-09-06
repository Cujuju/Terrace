# RigHerd: make the pose palette an immutable LUT

The single largest per-frame cost found in the 2026-09-05 frame-rate
investigation. Full analysis and the measurements behind it:
`docs/plans/frame-rate-decay-2026-09-05.md` §4.

**This is a rendering-shape change with a visible-fidelity trade in it. Read §
"The trade" before starting, and surface it to the owner rather than deciding it
alone.**

## The defect

`client/src/render/rigHerd.ts` keeps a bone-matrix palette texture per herd:
one row per pose slot, `boneCount × MATRIX_TEXELS` texels wide
(`rigHerd.ts:203-205`). Every frame:

1. `beginFrame()` — `captured.fill(0)` (`rigHerd.ts:264-270`) throws away every
   captured pose.
2. Draw code re-captures each slot it needs (`plugins/wildlife/client/models.ts:399-403`).
3. `endFrame()` — `if (capturedThisFrame > 0) palette.needsUpdate = true`
   (`rigHerd.ts:354`), which in three is a **whole-texture re-upload**, not a
   ranged one.
4. `plugins/wildlife/client/models.ts:564` runs that for **every** herd, so the
   per-frame upload count is the number of species currently drawing.

**Verify all four lines before proceeding.** The comments in that file describe
a per-frame pose cache as intentional; the claim here is not that the cache is
wrong but that its *invalidation* is unnecessary.

## Why the re-upload is unnecessary

- **Walkers do not use the clock at all.**
  `plugins/wildlife/client/species/grazer.ts:233` is
  `(joints, _seconds, phase) => { const beat = phase; … }` — `seconds` is
  discarded. Same in `wolf.ts:218`, `bison.ts:290`, and the walk branch of
  `ibex.ts:194`. A walker's phase is its stride, driven by distance travelled.
  **Their palette is byte-identical frame to frame and is re-uploaded anyway.**
- **Swimmers use the clock and the phase only as a SUM.**
  `fish.ts:42` — `beat = seconds * FISH_TAIL_HZ * TWO_PI + phase`.
  `shark.ts:40` — `Math.sin(seconds * TAIL_HZ * TWO_PI + phase)`.
  So the *set* of `poseSlots` poses is invariant as time advances; only which
  slot a given creature should read rotates.

## What it costs today

From the `overview` upload report, grouped by upload shape (each `W×32` is a
herd palette — height 32 is `POSE_SLOTS_PER_HERD`, width is `boneCount × 4`):

| shape | texels | **ms per call** |
| --- | --- | --- |
| `92x32` | 2 944 | **0.889** |
| `68x32` | 2 176 | 0.627 |
| `332x32` | 10 624 | 0.208 |
| `344x32` | 11 008 | **0.031** |

Cost is **not** proportional to size (344×32 is 4× bigger and 30× cheaper), which
means these are driver stalls on a texture still in use by the in-flight frame,
not bandwidth. On the slowest 1 % of frames, `gl upload (inside render)` is
**31.65 ms of a 42.35 ms frame**. An aged world had ~8 herds uploading per frame;
a freshly loaded one ~2 — which is the shape of the observed decay.

## The change

Make the palette a **static lookup table of one animation cycle, uploaded once
at herd construction**, and make animation a choice of which row to read.

1. At build time, fill all `poseSlots` rows (× `poseVariants` gait bands) and
   upload once. Then never set `palette.needsUpdate` again.
2. Delete the per-frame `captured.fill(0)` invalidation and the
   `needsPose`/`capturePose` round trip from the draw path.
3. **Walkers:** no change of meaning — the pose already depends only on slot and
   gait.
4. **Swimmers:** fold the clock into the slot index. Because the pose is
   `f(seconds·k + phase)`, choose
   `slot = (phaseSlot + timeSlot) mod poseSlots`, where `timeSlot` is the
   quantised clock. The palette contents do not change; the indexing rotates.
5. `place()` and the instance-matrix path are unaffected.

## The trade — do not skip this

Animation becomes quantised in time to `poseSlots` steps per cycle instead of
continuous. At today's `POSE_SLOTS_PER_HERD = 32`
(`plugins/wildlife/client/models.ts:173`) and a ~1 Hz stride, that is 32
samples per cycle, which **will** read as stutter at 144 fps.

Because the palette is now static, slot count costs **one-time memory only, not
per-frame bandwidth**. So raise it. At 128 slots and an 86-bone species:
`344 × 128` texels × RGBA float = ~704 KB per herd; ~10 MB across ~15 species.

Pick the number against how it looks, not against a formula — and **show the
owner** before settling it. Per the project's standing bar, in-world eyes-on
decides fidelity questions, not a benchmark.

## Verify before you commit to the approach

These would each break the LUT premise:

- `plugins/wildlife/client/species/ibex.ts:182-195` branches to `poseClimb` /
  `poseFall`, both of which take `seconds`. Confirm they are periodic in
  `seconds·k + phase` too, or give them their own `poseVariants` bands.
- Audit **every** species file in `plugins/wildlife/client/species/` for a use
  of `seconds` that is not of the form `seconds·k + phase` — a one-shot, a
  ramp, or anything reacting to world state would need its own treatment.
- `plugins/wildlife/client/species/bodyKit.ts:178,230` sets
  `positions.needsUpdate`. Confirm that is build-time, not per-frame.
- Check whether anything outside wildlife constructs a `RigHerd`
  (`grep -rn createRigHerd`). If boats adopt it (see
  `.claude/orchestration/briefs/boats-draw-calls.md`) their oar animation is
  `Math.sin(t * rate)` with `t = elapsed + phase` — same sum form — but
  `OAR_FIGHTING_RATE` changes the *rate*, which is not a phase offset and needs
  its own band.

## Explicitly NOT the fix

Do **not** convert the palette upload to `addUpdateRange` (the pattern
`rigHerd.ts:374-378` already uses for the instance buffers). Per-call cost is
dominated by the stall and is near-independent of size, so N changed rows as N
height-1 calls would likely be **worse** than one whole-image call. If the LUT
proves infeasible, the stall-shaped interim is double-buffering (2–3 palette
textures per herd, alternating), and that must be **measured**, not assumed.

## How to prove it worked

Isolated stack on 2599/5199 against a **copy** of a grown world — never the
owner's 2567/5173 or their live `.db`. Recipe: `scripts/gpu-bench.md`.

```bash
export TERRACE_PERF_SINK=<abs>/.gpu-bench-run/sink.jsonl
bash scripts/gpu-bench.sh overview before-<label>
# ... change ...
bash scripts/gpu-bench.sh overview after-<label>
```

Success criteria, in order of how much they mean:

1. **The `W×32` shapes disappear from `sample.uploadByShape`.** This is a
   yes/no fact and is the direct proof the change did what it claims.
2. `sample.uploadMsTotal / sample.frames` drops.
3. `sample.gpuMsP50` drops, and `sample.msP99` / `msMax` drop (the stall shows
   up in the tail more than the median).

Also run `bash scripts/gpu-bench.sh drift <label>` before and after: the decay
slope over four minutes is what this fix is ultimately aimed at.

**The error bar is real.** `noise.baselineGpuMsMeanStep` from an `ablate` run
ranged ±0.21 to ±0.94 ms between runs. A millisecond claim that does not clear
it has not been demonstrated. Criterion 1 does not have this problem, which is
why it is first.

Tests: the project forbids adding tests without the owner's explicit permission
in the current session — ask before writing any.

Vite on `/mnt/e` never watches — restart Vite after every client edit or you are
benchmarking the old bundle.
