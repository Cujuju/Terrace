# Report — celestial background outside the map (arc `celestial-void`, GH #326)

Branch `celestial-void`, worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/celestial-void`.
Not merged. No app stack was started or stopped. No tests added. No
dependencies installed (`pnpm install --offline` only).

## Commits on the branch

| sha | subject |
| --- | --- |
| `15087ca` | `feat(render): celestial void behind the map, wheel or nebula` |
| *(this file)* | `docs(render): celestial void arc report` |

Files changed by `15087ca`:

- `client/src/render/celestialVoid.ts` (new) — the pass, `VOID_HAZE_COLOR`.
- `client/src/state/persistedChoice.ts` (new) — the pref contract.
- `client/src/state/voidPrefs.ts` (new) — the `voidStyle` pref.
- `client/src/render/scene.ts` — `scene.background` line removed, `Color`
  import dropped, `SKY_COLOR`'s doc comment corrected.
- `client/src/render/skyRig.ts` — comment now states the new truth.
- `client/src/render/frontierFog.ts` — top row blends to `VOID_HAZE_COLOR`.
- `client/src/state/controlPrefs.ts` — `resetBindings` also resets the look.
- `client/src/ui/ControlsPanel.tsx` — the "Beyond the map" `<select>`.
- `client/src/main.tsx` — wiring + the live-apply effect.

## Reference revision 2

The reference shader file changed on disk mid-implementation
(`.claude/orchestration/refs/celestial-void-shaders.glsl:3-5`, "REVISION 2
(owner 2026-09-04)"). **Revision 2 is what shipped**, so three things in the
brief are superseded:

- **Tilt is 60°, not 35°.** The brief said 35° from the owner's "thirty to
  forty five"; revision 2's own header says "wheel tilt default 60 deg"
  (`refs/…glsl:3,7`). `WHEEL_TILT_DEGREES = 60`
  (`client/src/render/celestialVoid.ts:97`). Say the word and it is a
  one-line change.
- Rotation reversed (`WHEEL_RATE = -0.006`), stars steady in both looks (no
  twinkle term), and the wheel's stars gained a screen-space size floor plus a
  far-cell fade. The wheel's separate backdrop starfield was dropped in
  revision 2; the disk now carries every star.

## Mechanism claims, verified from source this session

Every line number below is post-change unless the claim is about what was
there before.

| claim | evidence |
| --- | --- |
| Core set a flat sky-coloured background | `client/src/render/scene.ts:247` before the change: `scene.background = new Color(SKY_COLOR);` — now replaced by a comment at `scene.ts:251-257`. |
| `SKY_COLOR` is also the hemisphere light's sky term | `client/src/render/scene.ts:265-269` (`new HemisphereLight(SKY_COLOR, …)`), definition at `scene.ts:50-60`. Left exactly as it was — the map's lighting is not part of this arc. |
| The fog's top row was a lightened `SKY_COLOR` | `client/src/render/frontierFog.ts:181` before the change; now `frontierFog.ts:192-193` builds it from `VOID_HAZE_COLOR`, unwhitened. |
| `applySkyRig` only writes a background that is a `Color` | `client/src/render/skyRig.ts:73` — `if (background instanceof Color) background.setHex(...)`. With `scene.background` left null the guard never matches, so day/night's and cyclone's `backgroundColor` is inert. Comment rewritten at `skyRig.ts:56-72`. |
| Day/night and cyclone still compute a `backgroundColor` | `plugins/daynight/client/sky.ts:260`, `plugins/cyclone/client/gloom.ts:154`. **Not edited** (brief forbids `plugins/**`), and they do not need to be. |
| Render loop, one `renderer.render`, no `scene.fog` | `client/src/render/scene.ts:369-392`; `grep -n 'scene.fog' client/src` → no hits. |
| ACES tone mapping + exposure 1.25 | `client/src/render/scene.ts:241,247` (`renderer.toneMapping = ACESFilmicToneMapping`, `renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE`; the constant is defined at `scene.ts:130`). |
| Frame callbacks give a capped `dt` | `client/src/render/scene.ts:211` (`FRAME_DELTA_CAP_S = 0.1`), delivered at `scene.ts:380-381`. |
| Three near-identical pref copies exist | `client/src/state/controlPrefs.ts:112-152` (bindings), `:187-215` (touch), `:236-266` (wheel). Left untouched apart from `resetBindings`. |
| Previews build their own scenes | 16 hits of `scene.background = new Color(...)` across `client/src/preview*.ts`; `createViewport` has exactly one caller, `client/src/main.tsx:60`. Untouched. |
| three version | `client/package.json:17` — `"three": "^0.185.1"`. |

**One brief claim did not hold.** The brief pointed at
`client/test/zz-perf-probe.test.ts` as the fallback measurement approach —
that file does not exist. `client/src/perfProbe.ts` and `scripts/gpu-bench.md`
are the real machinery, and both require a running dev stack, which is
forbidden here. Measured with a standalone harness instead (below).

**Confirmation grep.** After the change, the only runtime read of
`scene.background` in `client/src` outside the previews' own scenes is
`client/src/render/skyRig.ts:73` — the deliberate guard. No other module
treats it as a `Color`.

## Design decisions taken

**Fullscreen triangle mesh, not a sky sphere.** The criterion in the brief was
"least code in `scene.ts`". The mesh's vertex shader writes clip space
directly, ignoring every matrix, so `scene.ts` needed exactly one deletion and
no per-frame work; a camera-following sphere would have needed
`position.copy(camera.position)` inside `renderFrame` plus a radius chosen
against `CAMERA_NEAR`/`CAMERA_FAR`, and the "render before the scene with
`autoClear` managed" option would have split one `renderer.render` call into a
manual two-pass sequence there. Rationale is in the module header
(`celestialVoid.ts:28-40`).

**Screen-space anchoring, for both looks.** The brief's anchoring paragraph
reads two ways: "camera-anchored … the shader sees view direction" alongside
"the ray/plane math is in screen space; do not re-derive it in world space".
I took the reading that keeps the approved images intact — the shaders are
ported verbatim in screen space, so the void is fixed to the view: panning
does not drag it, and the wheel's hub sits exactly on the view axis as the
reference's ray/plane math assumes.

The consequence, stated plainly so it can be overruled: **orbiting the camera
does not move the void either.** It reads as a fixed backdrop rather than as a
skybox the world turns inside. The alternative I did not take is a nebula-only
`u_skyPan` uniform — the camera's azimuth and elevation, accumulated
*unwrapped* on the CPU (so the noise domain never hits the ±π seam that a raw
`atan2` would produce) and scaled by `1 / fovRadians` so a screen-height of
noise stays a screen-height of noise. That is ~15 lines and no measurable
cost; it was left out because it changes an approved look on my own judgement,
which is not mine to do. Easy follow-up if the owner wants the sky to turn.

**`VOID_HAZE_COLOR = 0x0a0a1a`** (`celestialVoid.ts:86`) — the component-wise
mean of the two looks' base colours: nebula `deep` (0.05, 0.05, 0.14) and the
wheel's backdrop (0.025, 0.03, 0.06) → (0.0375, 0.04, 0.10). Those two fill
most of the screen in each look, so the mean is the honest average, and one
value serves both styles without the fog having to know which is showing.

The top row is now **not whitened at all**. `FOG_COLOR_WHITEN = 0.35` (`frontierFog.ts:173`) still
lifts the water end (it sits against the sea and must stay visible there), but
lifting the top end 35 % toward white against a near-black void is exactly the
white-wall failure the brief warned about — 0x0a0a1a lerped 35 % to white is
mid-grey. Residual, documented at `celestialVoid.ts:80-85`: the fog is a
lit-pipeline material and passes through ACES + sRGB conversion while the void
pass deliberately does not, so the mist's top row lands slightly *lighter*
than the void rather than identical to it. That is the right direction for
haze, and the screenshots below show it dissolving rather than walling.

**Pref contract.** `persistedChoice(key, allowed, fallback)` in
`client/src/state/persistedChoice.ts` returns `[accessor, setter]` with the
same load/validate/save/try-catch behaviour the three existing prefs have,
plus `clearPersistedChoice(key)` for the reset path. It is deliberately
string-choices-only: the membership test *is* the validation, which is what
makes "a stale or hand-edited value falls back to the default" true by
construction. The three existing prefs store *objects* and were left alone
(focused PR) — **they are candidates to migrate**, but only the wheel and
touch ones directly; the bindings pref stores a four-field record and would
need a different contract.

**Reset-button decision: hooked in.** `ControlsPanel.tsx`'s reset button
carries `title="Puts every setting on this panel back to how it started."`
and the comment above it says "every setting on this panel"
(`ControlsPanel.tsx:225-231`). The look appears on that panel, so leaving it
out would make a documented promise false. `resetBindings` now calls
`resetVoidStyle()` (`controlPrefs.ts:166`), and both comments were updated to
say so.

**Time.** One `u_time` advanced from the render loop's own `dt`, never from a
wall clock, so a backgrounded tab resumes where it left off
(`celestialVoid.ts:315-321`). `prefers-reduced-motion: reduce` freezes it
(`celestialVoid.ts:244-253`, read once — it is an accessibility setting, not
something worth a live listener, and a frozen frame of either look is still
the intended image).

## Measured cost

Real GPU, not SwiftShader: **NVIDIA GeForce RTX 3090** (ANGLE / D3D11), the
owner's machine. `EXT_disjoint_timer_query_webgl2` around the void draw only,
with the pass in a scene holding nothing else, 60 samples, median reported.

| look | resolution | median | min | max |
| --- | --- | --- | --- | --- |
| wheel | 2560 × 1440 | **0.433 ms** | 0.431 | 0.750 |
| nebula | 2560 × 1440 | **0.526 ms** | 0.515 | 0.972 |

Both are far under the brief's 1.5 ms-at-1440p trigger, so the
half-resolution render target and upscale were **not** built — that machinery
would have been unjustified complexity. Against the project's ~7 ms frame
budget (`docs/DESIGN.md:27`, 140 fps) the pass is ~6-7 % of a frame at 1440p,
and it *replaces* a full-screen clear, so the marginal cost is a little lower
than the figure above.

Measured with `client/.celestial-harness.ts` + `.celestial-harness.html` +
`.celestial-harness.vite.config.ts` (untracked, in the worktree), built with
`vite build` and opened as a `file://` page in **Windows-side** Chrome
(`--headless=new --use-angle=d3d11 --enable-gpu`). No dev server, no game
server: `scripts/gpu-bench.md` is the project's normal route and it needs a
running stack, which the owner's rule forbids without permission in the turn.

## Screenshots

All in `.celestial-shots/` in the worktree (untracked, per the brief).
Rendered through the same harness; the two "void" stills are 1600 × 900,
captured in Linux-side Chrome on SwiftShader (pixel-identical output, just
slow — the GPU only matters for the timings above).

| file | what it shows |
| --- | --- |
| `.celestial-shots/wheel-1600x900.png` | Star wheel at 60°: tilted disk, spiral arms, hub on the view axis, stars with short trails. |
| `.celestial-shots/nebula-1600x900.png` | Nebula: domain-warped clouds, ember and pale bands, two steady star layers. |
| `.celestial-shots/frontier-wheel.png` | A frontier edge against the wheel — the mist bank's top dissolves into the void instead of standing as a pale wall. |
| `.celestial-shots/frontier-nebula.png` | The same edge against the nebula. |

The frontier shots use the real `frontierFog`, `terrainMeshes` and `water`
modules over a synthetic 4 × 4-chunk mirror with the centre 2 × 2 block
received, so every outer side of that block is a genuine frontier edge. The
terrain itself is harness filler and is not meant to look like a real world.

## Verification run

- `pnpm --filter client typecheck` — clean.
- `pnpm --filter client test` — 35 files, 556 tests, all passing (120 s).
  Client package only, with a timeout; never `pnpm -r test`.
- No test was added (owner rule; permission not granted).

## Left out, and why

- **No `u_skyPan`** — see the anchoring decision above. Deliberate, not a
  punt: taking it would have changed an approved look on my own judgement.
- **No half-resolution target** — measured at 0.43/0.53 ms, under the trigger.
- **The three existing prefs were not migrated to `persistedChoice`** — the
  brief asked for a focused PR. Named above as follow-up work.
- **`plugins/**`, `shared/**`, `docs/**` untouched**, as instructed. Nothing
  in this change needs them: the day/night rule is enforced by core declining
  to apply `backgroundColor`, not by editing the plugin.
- **`SkyRigState.backgroundColor` was not removed.** Keeping the field and the
  guard is what makes the rule structural rather than conventional, and it is
  the one-line door back to a tintable flat background if a future look wants
  one (`skyRig.ts:66-71`).
- **Not merged to main**, per the brief.
