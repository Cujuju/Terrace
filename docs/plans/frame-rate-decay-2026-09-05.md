# Frame-rate decay — root cause and fixes

> **Line numbers were correct at commit `909f551` (2026-09-05).** This is a
> shared checkout with concurrent agents — `635ce13 feat(climb)` moved every
> `rigHerd.ts` reference in this document once already. Locate code by the
> SYMBOL, not the line: `grep -n '<symbol>' <file>`. If a cited line does not
> say what this document claims, trust the file and tell the owner.


Measured 2026-09-05 on the owner's RTX 3090 (ANGLE / D3D11), world
`frostwick-hollows`, via `scripts/gpu-bench.sh` against an isolated bench stack
on 2599/5199. Written from measurements taken this session; every number below
names the run it came from.

The complaint: **"we should be at 144 fps, we're getting 60–80."**

---

## 1. What was actually wrong with the measurements first

Three tooling defects were found and fixed before any finding here could be
trusted. They are listed first because two of them silently invalidated earlier
conclusions, including conclusions stated in this session.

| defect | effect | fix |
| --- | --- | --- |
| No GPU timing at all | Impossible to tell a CPU-bound frame from a GPU-bound one. Every earlier perf conclusion in this repo rests on wall-clock frame time alone. | `EXT_disjoint_timer_query_webgl2` in `client/src/perfProbe.ts`; commit `82eb86e` |
| Ablation used ONE baseline for a 3-minute run | The world grows while the run proceeds, so later steps compared against a world that no longer existed. Produced confident, reproducible, **wrong** per-plugin numbers — `chronicle`, which draws nothing, scored 2.36 ms. | Baseline re-measured between every step, and the spread between consecutive baselines reported as the error bar; commit `e30ce28` |
| `gpu-bench.sh` launched Chrome via `cmd.exe /c start` | `cmd` treats `&` as a command separator, so **everything after the first `&` of the probe URL was dropped**. The documented `settle` flag has never worked; it went unnoticed because the script's default and the probe's default are both 45000. | Launch the Windows binary directly from WSL (real argv, no re-parse); commit `f7329f9` |

**Consequence worth stating plainly:** any per-plugin GPU attribution produced
before `e30ce28` should be discarded, including the "boats 2.55 / cyclone 2.85 /
fire 2.28, reproduced across two passes" table. Both passes shared the same bug,
so their agreement proved nothing.

---

## 2. The frame, measured

`overview` scenario (camera at the world-framing pose, untouched), aged server:

| | value |
| --- | --- |
| GPU p50 | **9.82 ms** |
| frame p50 | 8.50 ms |
| frame p99 / max | 25.7 / 50.8 ms |
| draw calls | ~305 |
| triangles | 4.1 M |
| **budget for 144 fps** | **6.94 ms** |

GPU time meets or exceeds wall-clock frame time — the signature of a saturated
GPU pacing the loop. Total CPU-side JavaScript across core *and* all plugins is
~2.5 ms even on the slowest 1 % of frames. **There is no CPU hot spot.** The
owner sees worse than the bench because the bench renders at a fixed 1600×900
and GPU cost scales with pixels.

Triangles are not the cost: hiding flora removes 1.34 M triangles (a third of
the scene) and saves ~1 ms.

---

## 3. The decay, isolated

`drift` scenario — one block per interval, camera locked, over four minutes.

**Live simulation** (`drift-programs`, aged server):

| t (s) | GPU p50 | draws | triangles | textures | programs |
| --- | --- | --- | --- | --- | --- |
| 1 | 8.71 | 320 | 3.99 M | 92 | 88 |
| 121 | 11.34 | 398 | 4.16 M | 124 | 95 |
| 222 | 11.32 | 390 | 4.27 M | **135** | **127** |

GPU +30 %, **triangles +7 %**. The things that grow are textures and programs,
not geometry.

**Frozen control** (`drift-frozen`, same code, inbound server state dropped):

```
geometries  153 -> 153      textures  124 -> 124      programs  72 -> 72
GPU p50    5.71 -> 4.18 ms  (settles DOWNWARD)
```

Flat on all three counters — **nothing accumulates without inbound messages.**

**RETRACTION (2026-09-06 04:10).** This document originally read that result as
"there is no client-side leak." That was wrong, and the error is worth naming:
freezing drops the inbound messages, which is also the input that *drives* the
accumulation, so the control cannot distinguish "the client leaks nothing" from
"the client leaks in response to traffic." It only ever proved the second
clause.

The measurement that settles it: a **fresh page against a server aged 4 h 15 m**
(`night-freshpage`) —

| | fresh page, aged server | long-lived page, same world |
| --- | --- | --- |
| GPU p50 | **2.68 ms** | 8.7 – 11.3 ms |
| draw calls | **170** | 320 – 390 |
| textures | **41** | 135 – 189 |

An older *world* seen through a new *page* is dramatically cheaper than a
younger world seen through an old page. **The accumulation is page-side, driven
by inbound traffic — a client-side leak that only manifests while messages are
arriving.** This is the strongest candidate for the owner's "it gets worse the
longer I play," and it displaces the ranking in §8 below.

*Confidence:* the direction is unambiguous, but these are two different runs
against servers of different uptimes, so the magnitude is not yet pinned. The
run that settles it is a single page watched from fresh with the per-rig census
(`phase 11`, `leak-soak`), which attributes the growth to an owning rig.

~~And at matched geometry the frozen client renders in 3.8–4.2 ms against the
live client's 8.95 ms, so more than half the GPU frame is the cost of applying
state.~~

**RETRACTED (2026-09-06 04:15).** That compared an *aged* live page against a
*fresh* frozen one — the pages differed, not just the freeze. Re-run with both
on fresh pages against the same 4 h-old server:

| | GPU p50 |
| --- | --- |
| live (`night-freshpage`) | 2.68 – 2.98 ms |
| frozen (`night-frozen`) | 2.81 – 3.03 ms |

**Identical within the error bar. Applying server state costs nothing
measurable.** The freeze's only real value is as a stabiliser for the ablation
scenario (§1), not as evidence about state cost.

---

## 4. Root cause A — the pose palette is re-uploaded every frame, unchanged

**This is the main finding and it is proven from source, not inferred.**

### The measurement that pointed here

`overview` upload accounting, grouped by upload shape:

| shape | texels | ms per call |
| --- | --- | --- |
| `texSubImage2D 92x32` | 2 944 | **0.889** |
| `texSubImage2D 68x32` | 2 176 | 0.627 |
| `texSubImage2D 332x32` | 10 624 | 0.208 |
| `texSubImage2D 344x32` | 11 008 | **0.031** |
| `texSubImage2D 8x8` | 64 | 0.015 |

Cost **does not scale with size** — 344×32 is 4× larger than 92×32 and 30×
cheaper. That is a driver stall (writing a texture the GPU is still reading),
not bandwidth. On the slowest 1 % of frames, `gl upload (inside render)` is
**31.65 ms of a 42.35 ms frame**.

Every `W×32` shape is a wildlife bone-pose palette: `POSE_SLOTS_PER_HERD = 32`
is the texture height (`plugins/wildlife/client/models.ts:178`) and
`paletteWidth = boneCount × MATRIX_TEXELS` (`client/src/render/rigHerd.ts:224`,
`MATRIX_TEXELS = 4`). So 92×32 is a 23-bone species, 332×32 an 83-bone species.
The aged server showed ~8 such shapes uploading per frame; the fresh server ~2.

### The mechanism, from source

1. `client/src/render/rigHerd.ts:289` — `beginFrame()` does
   `captured.fill(0)`, discarding every captured pose **every frame**.
2. `client/src/render/rigHerd.ts:383` — `endFrame()` does
   `if (capturedThisFrame > 0) palette.needsUpdate = true`, which in three is a
   **full re-upload of the whole palette**, not of the changed rows.
3. `plugins/wildlife/client/models.ts:564` — `endFrame()` runs this for **every
   herd**, so the per-frame upload count is the number of *active* species.
4. `plugins/wildlife/client/models.ts:397-403` — a slot's pose is
   `drawable.animate(seconds, herd.poseSlotPhase(slot), gait)`.

Now the decisive part — what those `animate` functions actually depend on:

- **Walkers ignore `seconds` entirely.** `plugins/wildlife/client/species/grazer.ts:233`
  is `(joints, _seconds, phase) => { const beat = phase; … }`. Identical in
  `wolf.ts:218`, `bison.ts:290`, and the walk branch of `ibex.ts:182-195`. Their
  phase *is* their stride, driven by distance travelled.
  **Their palette is a pure function of the slot index and is byte-for-byte
  identical every frame.** It is recomputed and re-uploaded anyway.
- **Swimmers use `seconds` and `phase` only as a SUM.**
  `fish.ts:42` — `beat = seconds * FISH_TAIL_HZ * TWO_PI + phase`;
  `shark.ts:40` — `Math.sin(seconds * TAIL_HZ * TWO_PI + phase)`.

**Root cause in one sentence:** `rigHerd` invalidates its entire pose cache
every frame, so every active species pays a full, stalling palette texture
upload per frame for contents that are either unchanged (walkers) or a
rotation of the previous frame's (swimmers) — and the number of active species
grows as a world matures, which is the decay.

### The fix — make the palette an immutable LUT

The palette becomes a **static lookup table of one animation cycle, uploaded
once at build time**, and animation becomes a choice of *which row to read*.

- **Walkers** need no change of meaning at all: the pose already depends only on
  the slot. Build all `poseSlots` rows once at herd construction; never clear
  `captured`; never set `needsUpdate` again. Per-frame upload cost → **zero**.
- **Swimmers** exploit the sum: because the pose is `f(seconds·k + phase)`,
  quantise the clock into the same slot space and select
  `slot = (phaseSlot + timeSlot) mod poseSlots`. The set of 32 poses is
  invariant under time; only the *indexing* rotates. Per-frame upload → **zero**.
- **Gaits** already have their own bands via `poseVariants`
  (`plugins/wildlife/client/models.ts:367`); each band is baked once, same
  as above.

**The trade this makes, stated honestly:** animation becomes quantised in time
to `poseSlots` steps per cycle rather than continuous. At 32 slots and a ~1 Hz
stride that is 32 samples/cycle, which will read as stutter at 144 fps. Because
the palette is now static, **slot count costs only one-time memory, not
per-frame bandwidth**, so raise it: 128 slots × 86 bones × 4 texels × RGBA
float = ~704 KB per herd, ~10 MB across ~15 species. That is the whole cost, paid
once, and it buys back an unbounded per-frame stall.

**What must be verified before implementing** (do not take this document's word
for it):
- Every species' `animate` really is a function of `(seconds·k + phase)` and of
  gait alone. `ibex.ts:182-195` branches to `poseClimb`/`poseFall`, which take
  `seconds` — confirm those are also periodic, or give them their own bands.
- `plugins/wildlife/client/species/bodyKit.ts:178,230` writes `positions.needsUpdate`;
  confirm that is per-species-build and not per-frame.
- Whether anything outside wildlife builds a `RigHerd`.

### Cheaper interim fix, if the LUT is too large a change

Do **not** reach for `addUpdateRange` on the palette (the pattern `rigHerd.ts:374`
already uses for its instance buffers). Cost per upload call is dominated by the
stall and is nearly independent of size, so uploading N changed rows as N calls
of height 1 would likely be **worse** than one call. The stall-shaped interim fix
is double-buffering: alternate 2–3 palette textures per herd so no frame writes
a texture the previous frame may still be reading. Measure it; do not assume it.

---

## 5. Root cause B — boats own half the frame's draw calls

Full handoff already written: **`.claude/orchestration/briefs/boats-draw-calls.md`**.

Summary: `plugins/boats/client/models.ts:377` calls `instantiateRig` per boat,
and `client/src/render/rigSkin.ts:405-435` builds **one `SkinnedMesh` per surface
per instance** — nothing is instanced. Plus a per-boat cloned sail material
(`models.ts:380`). That is 3 draw calls per boat, and boats measured **135, 172,
151, 150 and 158 draw calls across five runs** — roughly half of ~305.

The declared budget is `BOATS_PAYLOAD_CAP × 3 = 2048 × 3 = 6144` draw calls
(`index.ts:181`, `protocol.ts:327`), which no frame can afford.

The draw-call finding is reproducible in every run. The **GPU-millisecond**
saving is not — it ranged 0.91–3.48 and did not always clear the error bar. Fix
it for the draw calls, and measure the frame-time result rather than predicting
it. Note `4b85631 feat(boats): war boats form squadrons and sail the open sea`
landed mid-session, so this population is actively growing.

---

## 6. Root cause C — shader program churn

Programs grew 74→124, 88→127, 101→123 across three four-minute runs — **different
starting points, all converging near ~125**. That pattern says *bounded catalogue
warming up*, not an unbounded leak, and the frozen control (programs 72→72)
confirms nothing leaks client-side.

It still costs: each new program is a shader compile, which stalls, and shows up
in the p99/max column (25.7 / 50.8 ms).

The cache keys name the variants exactly. three's default
`Material.customProgramCacheKey()` returns `onBeforeCompile.toString()`, so keys
here are 1100+ characters and end in this codebase's own suffixes:

```
…|revealClip
…|cumulusDeck:snow:deck|revealClip
…|cumulusDeck:rain:deck|revealClip
…|cumulusDeck:thunderstorm:deck|revealClip
…|rigHerd:posePalette
…monster-fur-shell-1-of-3   (and -2-of-3, -3-of-3, plus monster-fur-triplanar)
```

These are legitimately distinct variants — the growth is content types appearing
for the first time, not duplicate compiles.

**Fix:** warm the catalogue instead of paying for it mid-play. three's
`WebGLRenderer.compileAsync` compiles off the critical path; call it for the
known variant set at load, or after first join while the camera is still
settling. This converts ~50 mid-play compile stalls into load-time work.

**A hazard to check first:** `applyGroundShade` (`groundShade.ts`, `applyGroundShade`) and
`applyRevealClip` (`revealMask.ts`, `applyRevealClip`) both *wrap* `customProgramCacheKey`,
appending a suffix. Applying either **twice to the same material** yields
`…|revealClip|revealClip`, a different key, and therefore a duplicate program.
`applyGroundShade` is called exactly twice on distinct materials
(`terrainMeshes.ts:794`, `water.ts:487`) and is safe. `applyRevealClip` is a
**public plugin API** (`client/src/plugins/types.ts:586`) with ~15 call sites
across plugins — audit those for repeat application on a shared material, and
make both functions idempotent (a `WeakSet` of already-patched materials) so the
hazard cannot recur. This was **not** observed in the data; it is a latent trap,
not a diagnosed bug.

---

## 7. Open — texture growth

`renderer.info.memory.textures` grew 120 → 189 in one four-minute run (+69) and
92 → 135 in another, while the frozen control held flat at 124. So it is
server-state driven, but **what** allocates them is not yet identified — three
exposes no texture list the way it does for programs.

**Leading hypothesis (source-read 2026-09-05, NOT yet confirmed by measurement):
on-demand GLB asset loading as content types first appear — the same bounded
warm-up shape as the program catalogue in §6, not a leak.**

Supporting the hypothesis: every texture-*constructing* site in the client and
plugins is bounded or shared, so none of them can account for +69.

| site | why it cannot be the growth |
| --- | --- |
| `plugins/structures/client/models.ts:2258` | `DURANDS_SIGN_TEXTURE` is built once at module init and shared by every instance (`models.ts:2262`) |
| `plugins/monsters/client/geometry.ts:444,637` | memoised — `if (furTexture === undefined) furTexture = furShadeTexture()` (`geometry.ts:1094`) |
| `client/src/render/rigHerd.ts:226` | one palette per herd; herds are built eagerly, all ~15 at once (`plugins/wildlife/client/models.ts:466-486`) |
| `revealMask.ts:183`, `water.ts:229`, `skyEnvironment.ts:182` | one each, at construction |
| `celestialVoid.ts:1287,1389` | two render targets, at construction |
| `plugins/structures/client/models.ts:335` | `part.material.clone()` — three's clone SHARES texture objects, as that file's own comment at `:315` states |

That leaves textures arriving inside loaded assets (`ClientPluginCtx.loadRigAsset`
— boats, saucers, structures, wildlife), where one GLB can carry many maps and a
new building or creature type appearing for the first time pulls its whole set in
at once.

**How it will be settled:** a per-rig material/texture census was added to the
`drift` scenario (`censusOf` in `client/src/perfProbe.ts`, commit `f419d7d`). It
counts DISTINCT material and texture objects reachable from each `plugin:`/`core:`
scene child, so the growth names its owner. If the hypothesis holds, the count
rises in one or two content plugins and then plateaus; if instead it climbs
without bound in a rig whose population is growing, it is per-instance allocation
and a genuine leak.

If the census proves insufficient, the fallback is wrapping
`WebGL2RenderingContext.prototype.createTexture` the way GL uploads already are.

Tracked as issue #377.

---

## 7b. Overnight result — the world is not the problem (2026-09-06)

An isolated bench server was left simulating for 4 h 15 m, then measured with a
**fresh page**. Same world, same camera, same scenario as §2:

| | fresh page, 4 h-old world | long-lived page |
| --- | --- | --- |
| GPU p50 | **2.76 ms** (~360 fps) | 9.82 ms |
| frame p99 / max | **4.0 / 4.8 ms** | 25.7 / 50.8 ms |
| draw calls | **152** | ~305 |
| textures | **40** | 135 – 189 |
| programs | **81** | 124 – 127 |
| upload | **0.161 ms/frame** | 3.246 ms/frame |
| ablation error bar | **±0.08 ms** | ±0.21 – 0.94 ms |

A four-hour-old world renders in **less than half the 144 fps budget**, and the
per-rig ablation on it finds nothing above 0.41 ms (thunderstorm), with the
all-hidden floor at 0.95 ms.

**So world content is not what makes the frame slow. Page uptime is.** The same
uploads cost 20× more on an aged page than a fresh one against the same world —
and because those uploads are driver *stalls* rather than bandwidth (§4), that is
consistent with accumulated textures and programs raising the cost of every
upload the page issues.

### This demotes §5 (boats), and the demotion is the honest reading

On the fresh page, boats is **45 draw calls and −0.16 ms**. On aged pages it was
135–172. The world is the same. So the "boats owns half the frame's draw calls"
finding measures a *long-lived page*, not boats' design.

Boats' own cleanup looks correct on inspection — `reconcileViews`
(`plugins/boats/client/index.ts`) removes and disposes any view absent from the
interpolator's sample, and `BoatInterpolator`
(`plugins/boats/client/interpolation.ts`) drops ids absent from the newest
message. **No boats leak has been demonstrated**; the 45-vs-158 gap may equally
be fleet size varying between measurements. Issue #375 should not be worked as a
leak, and its instancing rationale now rests on draw-call count alone, which is
a smaller prize than first reported.

*What is still unresolved:* which subsystem's objects/textures actually
accumulate on a long-lived page. Only a single page watched from fresh can show
it — every `gpu-bench.sh` run launches a new Chrome, so phases 2–5 above are all
blind to it by construction. The per-rig census soak (`leak-soak`) is the run
that answers it.

---

## 8. Ranked plan

| # | Fix | Evidence | Est. size | Expected |
| --- | --- | --- | --- | --- |
| 0 | **Find and stop the page-side accumulation (§7b)** | fresh page 2.76 ms vs aged page 9.82 ms on the SAME world | unknown until the census names the owner | this is the decay; everything below is secondary to it |
| 1 | Pose palette → immutable LUT (§4) | proven from source + measured 0.2–0.9 ms per active herd per frame | medium, contained to `rigHerd.ts` + species slot indexing | removes a per-frame stall, and stalls are what page-side accumulation makes worse |
| 2 | Boats instancing (§5) — **demoted, see §7b** | 45 draw calls on a fresh page; the ~150 figure measured an aged page | medium | draw-call reduction only; no leak demonstrated |
| 3 | Precompile shader catalogue (§6) | 74→~125 programs, converging | small | removes ~50 mid-play compile stalls (p99/max) |
| 4 | Idempotent `applyRevealClip` / `applyGroundShade` (§6) | latent, not observed | small | prevents a duplicate-program class of bug |
| 5 | Identify texture growth (§7) | +69 textures / 4 min, unexplained | investigation | unknown |

**Measure every one of these with the same scenario before and after.** The
error bar (`noise.baselineGpuMsMeanStep`) ranged ±0.21 to ±0.94 ms between runs;
a change that does not clear it has not been demonstrated.

---

## 9. How to reproduce any of this

```bash
# Isolated stack — NEVER the owner's 2567/5173 or their live .db.
# Full recipe: scripts/gpu-bench.md
export TERRACE_PERF_SINK=<abs>/.gpu-bench-run/sink.jsonl
bash scripts/gpu-bench.sh overview  <label>   # whole-frame CPU/GPU split + upload shapes
bash scripts/gpu-bench.sh ablate    <label>   # per-rig cost, sim frozen, with error bar
bash scripts/gpu-bench.sh drift     <label>   # decay over time + new shader programs
bash scripts/gpu-bench.sh drift-frozen <label> # the control: is it the world or the client?

# drift accepts &blocks=N&interval=MS via TERRACE_PROBE_EXTRA_QUERY.
```

Vite on `/mnt/e` never watches (drvfs delivers no inotify events) — **restart
Vite after every client edit** or you are benchmarking the old bundle.
