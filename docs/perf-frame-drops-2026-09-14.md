# Frame drops with boats + saucers disabled — measured investigation (2026-09-14)

Owner report: substantial frame drops persist with the UFO (saucers) and Boat plugins disabled.
Screenshot: Frostwick Hollows, day 11264, 1230×1252, up 617 s — frame p50 11.0 ms / p99 16.5 / max 17.0,
render 7.90, outside 3.00, gpu 3.67, draws 308–368, triangles 11.13 M, programs 139.
Top plugin rows: wildlife 1.74 ms (16%), pilgrims 0.41 (4%); boats and saucers 0.00.

Status: investigation complete; phases A–C landed (see §Phase sections below). Evidence files are untracked (index at bottom).
**2026-09-15 fresh-eyes audit:** §B1, §"Cost shape" precipitation rows, recommendation 2 and §Instrument-bug "Not applied"
are STALE — the weather-review merge rewrote precipitation GPU-side (`kit/precipitationField.ts`), and the census fix
is applied. See §Phase C fix for what changed and why.

## Verdict

The frame is **draw-call-bound on the CPU submission side**. Boats and saucers are exonerated three ways.
Draws belong to pilgrims, structures, flora and weather; per-frame GPU uploads are a second tax;
program-count growth feeds the p99 hitches. Typical render wall decomposes as:

**render ≈ gpu + draws × ~13 µs** (CPU submission + dynamic-upload overhead per draw)

Refinement from the core-only run below: pure submission of static draws costs ~0 µs —
core-only render (2.50 ms) ≈ gpu (2.56 ms) at 68 draws. The ~13 µs/draw effective rate in
plugin runs is therefore dominated by per-frame **upload churn** (dynamic buffers rewritten and
re-uploaded inside `renderer.render`), not by draw-call dispatch. Static draws are nearly free;
draws that upload every frame are the expensive ones.

| | owner shot (cam 227) | probe far view (cam 274) | probe overview (cam 80) |
|---|---|---|---|
| draws | 308–368 | 211 | 187 |
| triangles | 11.13 M | 7.42 M | 7.31 M |
| programs | 139 | 130 | 138 |
| frame p50 / p99 / max | 11.0 / 16.5 / 17.0 | 7.0 / — / — | 7.3 / 12.5 / 19.8 |
| render / outside / gpu | 7.90 / 3.00 / 3.67 | 5.1 / 1.8 / 2.2 | 5.5 / 1.7 / 2.8 |
| implied µs/draw | ~12.4 | ~13.7 | ~14.4 |

## Draw attribution (marginal draws over all-hidden core baseline, far view)

Core baseline (terrain supermeshes + water + overlays + gas/bake): **64**.
structures **46**, flora **30**, pilgrims **28**, snow **28** (active system; weather varies),
relics **12**, rain **11**, thunderstorm **11**, wildlife **10**, fog **8**, monsters **6**.
Saucers **0** (present but culled/absent). Hiding snow+rain+fog together saves **30 draws**
at far view (11 at overview) — precipitation is the largest single-toggle win and the
largest pose-dependent swing. Overview ranking is the same population, different order
(pilgrims 50, flora 30, structures 28). Full tables in the E/G JSONs.

## Cost shape beyond draws

- **Upload churn.** Self-profile top rows: `writeBuffer`, `updateAttributes`/`setVertexBuffer`,
  `writeTexture`, `precipitation.ts advance` (full position-buffer rewrite + upload every frame;
  columns are `frustumCulled = false`), `capturePose` (`rigHerd.ts:113`). 52% of all samples sit
  under three's `_renderObjectDirect` — the per-draw submission loop. Rain worst case ≈ 2700 drops ×
  2 verts × 3 floats × 7 systems ≈ 450 KB/frame churned on CPU and bus, before snow.
- **Program growth.** 116 cold → 130 → 138 with zero input. Each new program is a compile hitch;
  matches both p99 shapes. Growth rate, not absolute count, is the metric to watch.
- **Plugin JS is small.** Wildlife tops at ~1 ms (13–16%), pilgrims ~0.15–0.41. Wildlife's real cost
  is draws-adjacent (pose capture, instance uploads), not its `onFrame` row.
- **Server healthy.** 10 Hz tick at 7.5% util. Occasional 0.2–0.5 s plugin stalls (structures,
  pilgrims) do not block client render.

## Core-only floor + sculpt load (PLUGINS_ENABLED=none, same world copy, cam 274)

| | core idle | core + 9 raise strokes | delta |
|---|---|---|---|
| draws | 68 | 74 | +6 (brush/water refresh) |
| triangles | 5.61 M | 5.62 M | +1133 (strokes landed) |
| programs | 69 | 72 | +3 (mesher/water variants) |
| frame p50 / p99 / max | 2.8 / 4.1 / 5.1 | 3.3 / 4.9 / 6.2 | +0.5, no hitches |
| render / outside / gpu | 2.5 / 0.3 / 2.56 | 2.7 / 0.6 / 2.16 | +0.2 / +0.3 / noise |
| upload | 41 KB/frame (82 writeBuffers) | 50 KB/frame | +9 KB (arena + water) |

Read: the raw renderer idles at 2.5 ms (GPU-bound on 5.6 M terrain+water tris) and sculpting
9 strokes costs +0.5 ms frame, +0.2 render, no hitches. Plugins therefore account for roughly
+140 draws, +65 programs, +3 ms render-CPU and the great majority of upload churn versus this
floor (full-stack upload now measured: ~400 KB/frame — see Phase-A baseline below).
Also notable: server tick at 0.0% util with plugins off (vs 7.5% with them).

## Recommendations (ranked)

1. **Pilgrim instancing** (`plugins/pilgrims/client/models.ts`): 46 walkers × 3–5 `SkinnedMesh`
   draws → one `RigHerd`-style `InstancedMesh` per surface, as wildlife already does. ~−45 draws
   (~−0.6 ms) plus deletes per-walker bone-uniform uploads. Biggest single win.
2. **Precipitation**: real bounds + frustum culling per system (drop `frustumCulled = false`),
   consolidate toward one column per plugin, move falling to GPU (time-uniform over static seeds;
   upload once). Kills most upload churn and 10–30 draws.
   **DONE by the weather-review merge** (`kit/precipitationField.ts`: static seeds, GPU fall, one draw per
   kind, ~336 B/frame of uniform-array writes for rain). `frustumCulled = false` is now LOAD-BEARING there:
   the `position` attribute is never written (TSL composes it), so three's bounding sphere would be
   radius 0 — do not re-apply the culling half.
3. **Flora double-draw**: 15 objects → 30 draws exactly 2×. Find the second pass before anything else.
4. **Structures / relics**: merge statics, instance the rest (tier parts already instanced; audit
   signs/marquees/dancers materials, relic beams).
5. **Itemize the 53–64 unnamed core baseline** (water passes, gas/bake cadence, frontier/edge
   overlays, rivers, brush preview) — possible free win, currently unattributed.
6. **Program discipline**: no `new Material` + `compose` on spawn/activate paths (audit monster dread
   creation, weather acquire/release, saucer pools); share node closures; consider load-time warmup.
7. **Wildlife JS last**: LOD ground sampling / pose capture for distant entities. Capped at ~1 ms anyway.
8. **Process**: fix the census counter bug below; budget draws×triangles instead of objects
   (pilgrims were "under budget" at 62 objects while emitting 50 draws).

Rough total: draws 211 → ~120 plus upload removal ≈ −1.5 to −2 ms render on the owner's pose —
the difference between 74-fps-with-dips and locked high frame rate.

## Why the fixes land in plugins, not core

Core is thin and already optimized (terrain = 16 supermesh draws for the island). The ~150 draws
above baseline are authored by plugins, so draw-reduction diffs touch `plugins/*/client` even though
the ~13 µs tax is three.js-side. Genuinely core-side items: baseline itemization (5), program-cache
policy (6), the budget system (`client/src/plugins/host.ts`), the census bug. If a future census
shows the unnamed baseline dominating, the recommendation flips — the method decides.

## Instrument bug (action required)

`scripts/draw-census.ps1` samples `renderer.info.render.calls` — the **cumulative `render()` count
since boot**, not per-frame draws (three r185 `Renderer.js`; per-frame draws are `render.drawCalls`,
the field `frameStats` uses). All prior "isolated calls" tables from it, including the September
census behind "boats own ~150 draws," are render counts and must be discarded. (`drawables`
composition counts are unaffected.) Fix: `render.calls` → `render.drawCalls` in both `frame()`
helpers. Applied in `a1ee5caa` (`scripts/draw-census.ps1:163`). `.census/HANDOFF.md:46,73` still describes
the old counter and quotes a retracted "151 calls" reading — treat those lines as superseded.

## HUD accuracy proposal

The HUD's plugin rows (`recordPluginFrame` around `onFrame` handlers in `host.ts`) measure **plugin
JS update only** — ~15% total is correctly measured and genuinely small. Everything plugins cause
downstream (draw submission, uploads inside `renderer.render`, GPU time, program compiles) lands in
`render`/`gpu`, unattributed. True plugin cost = JS + draws-owned × µs/draw + upload bytes + GPU
share. All three missing terms are measurable without changing render architecture (see next section
of the chat discussion / §HUD below): per-layer drawables are already sampled each second in
`host.ts` (`sampleDrawObjects`), upload-by-owner accounting already exists in `perfProbe.ts`, and
µs/draw calibrates from `(render − gpu) / draws`, all present in `frameStats`. Proposed HUD rows per
plugin: `js ms` (have), `draws ~N (~M ms submission)`, `upload ~B KB/frame`. No per-layer renders,
no flicker.

## Caveats

- Absolute draws differ (owner ~340, probe 211): live day-11264 world vs a snapshot copy aged ~2 h
  with no players; weather, camera angle and warm features differ. Ranking is population-driven and
  transfers; the per-draw model predicts the owner's wall quantitatively.
- Weather attribution is noisy (systems spawn mid-probe); reported as ranges with the
  combined-ablation number as cleanest read. One noisy cell: `core:void-stars-0` +18 in run G,
  likely a celestial re-bake firing mid-probe, not real cost.
- Self-profiles ran at ~430 samples/10 s (background-tab profiler throttling); shape is decisive
  (submission + uploads on top, no app JS), absolute ms come from the meter, not the profiler.
- Far-view pose reached by synthetic wheel input (80 → 274, verified via stats): a hand-seeded
  localStorage pose (dist 227) is reproducibly ignored on boot while parsing valid in-page —
  separate bug, not a perf factor. Repro recipe for the owner's own tab (no reload needed):
  evaluate the census JS from `.perf-probe/measureE.ps1` (drawCalls version) in the hurting tab.

## Method

Isolated stack: server `:2678` on a copy of `frostwick-hollows.db` (boats already disabled in world
settings), client `:5199` (Vite dev, real GPU), throwaway Chrome over CDP `:9333`. Quiescence-gated
(terrain stream + program warmup stable <5% twice) before every census. Owner stack untouched.

## Phase-A baseline (full-stack, world plugin set, far view cam 274, 1249×1285, 5-min idle)

2026-09-14 probe, `PLUGINS_ENABLED` unset (boats disabled per world). Denominator for Phases B–D.

| | window open | window close | drift |
|---|---|---|---|
| draws | 237 | 248 | +11 (walkers/weather) |
| triangles | 7.53 M | 7.57 M | flat |
| programs | 134 | 134 | flat |
| frame p50 / p99 / max | 7.8 / 13.1 / 18.4 | 8.7 / 15.3 / 33.5 | **+0.9 p50 with flat programs** |
| render p50 / p99 | 6.0 / 10.5 | 6.9 / 12.0 | +0.9 |
| outside p50 | 1.7 | 1.7 | flat |
| gpu p50 | 2.88 | 2.75 | flat |
| upload | 395 KB/frame | 403 KB/frame | ~10× core floor (41–50 KB) |
| upload by kind | writeBuffer ~245 KB (~360 calls), writeTexture ~151 KB (~37 calls) | similar | zero bufferData (no reallocations) |
| top plugin JS | wildlife 0.82→0.78, pilgrims 0.22→0.29, snow 0.19, rain 0.14 | same ranking | — |

Reads: full-stack upload churn is **~400 KB/frame vs 41–50 KB core-only** — plugins own ~90%
of it (writeBuffer vertex/instance traffic plus a surprising ~150 KB writeTexture component,
likely pose palettes; attribute per-owner in Phase B with `perfProbe` upload-by-owner).
Frame p50 crept +0.9 ms over 5 idle minutes with programs, tris and outside all flat and draws
+5%: live reproduction of the decay signature on a fresh world copy (session-time, not world-age).
Decoupled from program growth this session — Phase C must explain render-side creep without new
programs (candidate: upload bytes or submission-state accumulation; re-measure by-kind deltas).

Fixed-script verification (same stack, fresh tab, overview cam 80): isolated `drawCalls` range
**38–76** across layers (baseline 38), varying by layer rather than rising with loop position;
full-frame 128 ≥ max isolated 76. Old field gave 302→497 rising and ~19900 cumulative on the
same kind of run. Fix confirmed; prior tables stay discarded.

## Phase B1 — precipitation 30 Hz + bounds (client/src/plugins/kit/precipitation.ts) — SUPERSEDED

The B1 code (`2fed7511`) was deleted by the weather-review merge; the numbers below describe deleted
code. HEAD's precipitation is GPU-side (see recommendation 2 note). Kept for the record.

Gated `advance()` position rewrites to 30 Hz (opacity/haze/deck still per-frame),
gave every column an explicit bounding sphere refreshed per call, deleted
`frustumCulled = false`. No signature changes; fog/thunderstorm share `discRig` untouched.
Far view cam ~900 (dolly overshoot; draws 239–246 ≈ Phase-A 237–248, comparable), clean
meter windows (no layer hiding ±20 s), vs Phase-A baseline:

| | Phase-A baseline | B1 after | delta |
|---|---|---|---|
| upload | 395–403 KB/f | 274–287 KB/f | **−~120 KB/f (−30%)** |
| writeBuffer | 245–265 KB (~360 calls) | 152–157 KB (~390 calls) | **−~100 KB/f (−40%)** |
| writeTexture | 138–151 KB (~32–37 calls) | 122–130 KB (~33–37 calls) | flat (noise) — precip positions were never textures; palettes remain suspect #1 |
| frame p50 | 7.8 → 8.7 | 7.7 → 8.0 | −0.7 at close window |
| render p50 | 6.0 → 6.9 | 6.2 → 6.4 | flat-to-better |
| precip ablation (3×, symmetric) | Δ30 (run G) | 247→217 ×3 | unchanged (on-screen systems draw the same; savings are upload + culling) |
| snow/rain JS rows | 0.19 / 0.14 | 0.05 / 0.04 | −3–4× (advance loop halved) |
| programs | 134 | 151 | +17 session variance (weather mix; B1 creates no materials) |

Read: upload churn cut nearly a third with zero visual change (30 Hz fall aliases
invisibly; opacity/haze untouched). writeTexture flat confirms it is a separate stream —
wildlife pose palettes stay the prime suspect (B3 should collapse it; verify via upload rows).

## Phase B2 — flora double-draw hunt: NO BUG (no code change)

Verdict: flora draws ≈ drawables (≈13–15 live). The 2× was probe noise. Three measures agree:

1. Differencing ablation, hide-flora-alone, 3 symmetric rounds: 247→234 (Δ13) every round.
2. Same-session isolation: 77 − 64 baseline = 13.
3. Drawables census: 15 visible meshes (2 culled or count-0).

The E/G "30" readings (83−53, 94−64) were single-sample isolation transients — same class
as the void-stars +18 re-bake artifact already noted in Caveats. Lesson: for single layers,
trust symmetric differencing over one-shot isolation. Code inspection corroborates: single
materials per mesh, no geometry groups, no second pass anywhere (picking is raycast-only,
reveal/ground-shade add no renders, flora never calls applyRevealClip).
No fix committed; nothing to optimize here — flora's 15 draws are legitimate.

## Phase B3 — wildlife distance LOD (plugins/wildlife/client/index.ts, models.ts)

Beyond 120 world units a creature holds its pose: placement refreshes every frame but
ground sampling, phase advance, joint animation and palette capture run at 1/6 frames
(staggered by id), plus on gait change and first sight. `models.draw` gains optional
`holdPose`; frozen phase + unchanged gait addresses the already-captured palette slot, so the
hold is always visually valid (≤100 ms staleness, subpixel at distance). Nearby creatures
take the full path unconditionally. Far view cam 274, 5 stable polls, vs pre-LOD rows:

| | pre-LOD (E/G) | B3 after | delta |
|---|---|---|---|
| wildlife JS row | 0.93–0.98 | 0.23–0.29 | **~4×** |
| upload | ~280 KB/f (post-B1) | 135–147 KB/f | **~−50%** (held entities skip palette capture) |
| render p50 | 5.1–5.5 | 2.8–3.0 | −2+ (LOD + B1 combined vs G) |
| draws | 211 | ~180–193 | placement still draws every frame, as designed |

Taken over mid-flight: worker's 2-file diff reviewed (hold-validity invariants hold —
first-sight/gait-change force full, cleared capture flags bypassed only under holdPose),
`cameraPosition()` API verified, client typecheck green, probe-verified above, committed.
Audio note (owner): the hold path touches no audio — wildlife emits none (only positional
SFX in the tree is thunderstorm cracks, event-driven), and `drawnPoseOf` (fire's consumer)
still refreshes every frame on hold. Standing rule for future work: any creature
vocalization added later must be distance-gated independently of the 1/6 stagger, never
wired to the held update.

## C1 follow-up — parked lights out of the lit set (takeover)

C4 census + worker audit found pools kept intensity-0 lights `visible` (fire pool,
monster dread bank, thunderstorm bank/dry-bolt); three keys lit programs off visible
lights. Fix: `visible=false` whenever parked, unhidden exactly when contributing
(fire: on assignment; dread: on lend; storm: on flash). Non-visual by construction.
Measured far view: 12 point lights, 3 visible — all real fires (2 fire + 0 dread +
0 storm at that instant; bank spares all HID). Typecheck green (all three plugin
projects). Methodology note: the first re-verify silently measured STALE code — the
long-lived probe Vite server (no file watcher) serves cached transforms keyed by URL
even to fresh browsers. Rule now in plan: restart probe Vite after every client-side edit.

## Phase C fix — lit-set stability (2026-09-15, takeover after a 3-reviewer fresh-eyes audit)

**Root cause (one sentence).** three keys every render object's pipeline on the set of *visible* lights
(`Renderer._projectObject` drops hidden lights → `LightsNode.customCacheKey` hashes every visible light id →
`RenderObject.getDynamicCacheKey` → `RenderObjects.get` disposes + recreates every render object →
`Pipelines.delete` releases programs), so `8ab914d8` ("hide parked lights") turned every fire-light handover
and dread lend/reclaim into a full-scene node rebuild + WGSL regeneration + pipeline recreation.
`info.memory.programs` is therefore a **churn** counter, not a monotonic cache count — the "116→130→138 with
zero input" signature was this.

**Contract (now in `client/src/plugins/kit/lightBank.ts`).** A plugin's dynamic point lights are a fixed-size
bank created and parented at attach, permanently visible, parked by intensity 0 only; nothing after attach
adds, removes, reparents or hides a light. Same rule for materials/geometries on spawn paths (built at attach,
reused). Thunderstorm already followed it (`flashLight.ts`); fire and monsters now do.

Commits: `926b569e` (HUD: frozen `<Show>` consts → memos; meter installed lazily, WebGPU queue writes only),
`217373f9` + `473c00d4` (wildlife hold path integrates skipped time/travel; fixes distant moonwalk),
`f995568e` (storm rigs prebuilt at attach), `6b83fab9` + `204fc9c4` (one `bakeSolidColor`, merged-material
leak, minimum-parts guard), `953185d7` (light banks + dread rigs pooled). The uncommitted C2 warmup and C3
draws×tris breaker were DROPPED: rigs are empty Groups post-merge (warmup rendered nothing and could corrupt
the slot ledger), and the breaker was a behavioural no-op with a wrong draw formula and a red test.

**A/B (isolated stacks, far view cam 900, 1264×1305; baseline = worktree at `bc4b930e`, fix = `a6287f66`).**

| | baseline (pre-fix) | fix |
|---|---|---|
| 20-min idle: programs start→end | 132 → 176 | 134 → 141 |
| 20-min idle: per-frame program-count changes | 14 | 2 |
| 20-min idle: frame max | 488 ms (also 70, 80) | 35.6 ms |
| 8 cells ignited, 150 s: fires burning / lights lit | 27 / 4 | 17 / 4 |
| ignited: program-count changes | **39** | **0** |
| ignited: max frame / p99 | 6950 ms / 770–1019 ms | 73 ms / 12–17 ms |

Caveats (signoff): the baseline Chrome was still rendering during the first 12 min of the fix idle run (gpu
13–14 ms vs 6–9 after teardown), so p50/p99 between the two idle runs are not comparable; churn counts and
max-frame are. The baseline camera also dropped 900→45 at ~885 s and stayed there, so the last 7 min of the
baseline idle run (and 3 of its 14 program changes) are pose-contaminated; the 488 ms max is at 824 s, cam 900,
inside a lit-set flip window, so the conclusion stands. The rAF sampler counts net per-frame movement of
`info.memory.programs`; a same-frame dispose+recreate nets to zero, so the next probe should count
pipeline/program creations directly. The remaining +7 programs / 2 events on the fix run are first-appearance compiles (candidates for a
host-level `compileAsync` warmup — see plan C2′). Cost side: 8 point lights are now permanently in every lit
program (4 fire + 3 dread + 1 storm); GPU p50 at this pose read 6–9 ms in both runs once contention ended.

Evidence: `.census/census-phaseC-fix-{baseline,after}.json` (+PNGs), `.census/churn-phaseC-fix-{baseline,after}-ignite.json`,
instruments `.perf-probe/{stack-up,stack-down,gate,churn,eval}.ps1`, `client/.perf-ignite.mjs`, reviews in the
session scratchpad (`review-AB/C/C2C3/fixbatch.md`, `signoff-phaseC.md`).

M1/M2 visual gate — **ACCEPTED by owner** (2026-09-16, matte pilgrims are fine): before/after PNGs at matched poses plus deterministic
studio renders, published at https://claude.ai/artifact/5GZxxrWRQgMqu3e7x9RPeK (files
`.census/gate-m1m2-*.png`). Pilgrims: real change — eye catchlight and muzzle sheen gone (Phong→Lambert),
802 of 1,649,520 studio pixels, all in the eye/nose row; body+gloss now one skinned surface per walker
(real −1 draw/walker). Flora/structures/temples: pixel-identity (`bakeSolidColor` is a no-op in pixels).
Pilgrims test updated (`4e4114a5`) and the light-bank rule recorded in `docs/DESIGN.md` (`027d0a79`).

## Phase C2′ — settle shader warmup (2026-09-15/16)

**Root cause (one sentence).** Plugin drawables are constructed `visible = false` and three skips invisible
(and frustum-culled) objects before pipeline creation in both `render` and `compileAsync`, so every plugin
paid its shader compile on its first visible frame mid-play.

**Contract (`client/src/render/settleWarmup.ts`, wired from the plugin host at terrain settle and on late
mounts).** Once the terrain stream settles, flip every effectively-hidden drawable visible with
`frustumCulled = false`, `renderer.compileAsync(viewport.scene, viewport.camera)` on the WHOLE scene (a
sub-tree would key pipelines on the sub-tree's light set — silent no-op), restore the flags synchronously
(no await precedes projection once the renderer is initialised), then await. Hidden lights are never
flipped (they would change the lit set). Transparent `DoubleSide` materials need two passes because three
draws them twice (BackSide render object, then FrontSide) and `compileAsync` defers pipeline creation past
its own side restore: pass A projects at `DoubleSide` (both render objects queued) and switches to
`BackSide` for the drain; pass B projects at `FrontSide`; `DoubleSide` restored in `finally`. Skinned
kinds that never exist at settle get a hidden specimen per race×kind at attach (pilgrims: 6).

Commits: `2b3f76e9`, `7cc0f712` (hidden lights excluded, initialised guard), `a085096c`, `81b80d2f`
(double-pass), `a50fc6fc` (pilgrim specimens). Warmup runs once ~10 ms after `terrain-queue-empty` and takes
1.6–5.5 s; its window sits inside the already-hitchy load phase (frame max 336 ms during warmup vs 575 ms in
the 3 s before it, 23 ms in the 5 s after).

| 20-min idle, far view, backend pipeline/program creations counted directly | pre (e4865899) | final (7af93e2c) |
|---|---|---|
| programs start→end | 134 → 145 (16 min, gate died) | 153 → 153 |
| pipelines / programs created after settle | 9 / 11 in 3 events | 1 / 0 |
| per-frame program-count changes | 3 | 0 |
| event frame max | ~36 ms | 33.7 ms (no compile events) |

Naming probe (`.perf-probe/pipenames.ps1`, `.census/pipenames-phaseC2-*.json`): on the final build the only
post-settle compiles are monster kinds whose first real spawn precedes their idle template build (templates
build lazily on `requestIdleCallback` by design; eager builds would add ~1.9 s of boot).

**Signoff round 2 (2026-09-16, Fable BLOCKED → fixed in `77ce752b`).** (1) three fixes a render object's
program to `material.side` at creation, so pass A's BackSide program was reused for the front pass of hidden
lit double-sided materials (negated front-face normals on snow/cyclone decks); fix: `material.needsUpdate`
between passes so the default render object rebuilds at FrontSide while the `'backSide'` one keeps its
key. (2) Every pass drained VISIBLE double-sided objects (water) at DoubleSide, releasing their warm
side pipelines; fix: double-pass drawables are hidden for the synchronous projection unless the pass
flips their side, so no object is ever drained at a foreign side. Re-runs (`requestShaderWarmup()`,
`1340c4b7`: monsters add a hidden specimen per idle-built template) never flip sides and never touch
double-pass drawables. Final gate on `77ce752b` (`.census/census-phaseC2-final2.json`, 20 min, far
view): programs 162→165, 1 program-count change, 2 pipelines / 3 programs created after settle (one
monster spawn), frame max 44.9 ms; naming probe: zero recreations of warmed objects. Residuals: a
double-pass object's drawable descendants are skipped with it; hidden double-pass drawables are not
warmed by re-runs (first-show compile); two junk side-2 pipelines on one core `MeshStandardMaterial` mesh
at the tail of the settle pass (identity not captured, load-time only); no re-arm across a world switch;
`compileAsync` returns early on device loss.

**Update 2026-09-22 (`10a728d0`, `11a650c3`, `f5bd07dd`).** The warmup is now driven by the plugin
host's build hold (`docs/decisions/plugin-host.md`), not by `terrain-queue-empty`. A pass runs when a
snapshot arms the hold, and another runs once the terrain is drawn and the batched terrain changes have
been delivered. Plugins draw again only after that second pass. Held plugin layers stay visible, go
undrawn through `setRenderObjectFunction`, and are passed to `warmHiddenDrawables` as `undrawn`: their
drawables warm like hidden ones. Passes return a promise; calls made during a pass share one follow-up
pass. The "no re-arm across a world switch" residual is closed: every snapshot build warms.
2026-09-23 (`8b1ac029`): monster template surfaces build in a worker, not on `requestIdleCallback`; all six
templates are warmed with specimens at join.

## Evidence index (all untracked, all kept per instruction)

- `.census/census-perfprobe-G-farview-drawcalls.json` — far-view census + stats + profile (main exhibit)
- `.census/census-perfprobe-E-hurting-drawcalls.json` — overview ditto
- `.census/census-perfprobe-A-overview.json` — superseded (wrong counter; documents the bug)
- `.census/census-core-sculpt.json` — core-only idle vs sculpted (upload rows included)
- `.census/census-phaseB-b3.json` — B3 LOD verify (wildlife row + upload, 5 polls)
- `.census/census-lights-parked.json` — parked-light fix verify (light table + stats)
- `.perf-probe/measureE.ps1`, `measureF.ps1`, `dolly.ps1`, `measureH.ps1` — working instruments
- `.perf-probe/measureB/C/D.ps1`, `check*.ps1`, `spytrace.ps1` — iteration trail
- `.perf-probe/perf.log` — probe server tick/stall log
