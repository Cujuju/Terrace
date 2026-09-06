# Celestial void perf phase 2 — march the gas at half resolution (#341)

You are the implementation agent for GitHub issue Cujuju/Terrace#341. Work ONLY in the
worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/celestial-void-perf`
(branch `celestial-void-perf`, tip = main 18b1bd9). Never touch
`/mnt/e/Development/Projects/Terrace` itself (shared checkout, other agents live there).
Use `git -C <worktree>` for every git command. Commit to the branch; do not merge, do not push.
Never start the app. Do not install anything.

Read first, in this order:
1. `<wt>/CLAUDE.md` (project rules: NO TESTS — the owner said so for this arc; erasable TS;
   named constants; keep every existing comment).
2. `<wt>/client/src/render/celestialVoid.ts` in full (971 lines). Everything below refers to it.
3. `<wt>/.void-bench/README.md`, `gen.mjs`, `gl2.js`, `shot.mjs`, `run.sh`, and `bench.html`
   lines 1 (canvas), 30-121 (skip the SHADERS blob on line 2).
4. `<wt>/client/src/render/scene.ts` lines 370-430 (the render loop) and 195-210 (`onFrame`).
5. `<wt>/client/node_modules/three/examples/jsm/objects/Reflector.js` lines 116-240: the
   precedent for rendering a target from inside `onBeforeRender`.
6. The phase 1 brief `/mnt/e/Development/Projects/Terrace/.claude/orchestration/briefs/void-perf-p1-bake.md`
   for the house style of the harness and report (do not redo any of it).

## What to build

In `WHEEL_GLSL`'s `main()` (~line 605) the gas march (`GAS_STEPS` samples of
`pattern*gasDepthProfile(...)`, two bake fetches, the transmittance loop) runs per full-res
fragment. Move it into a separate pass rendered at half resolution into a render target, and
have the full-res wheel pass read that target instead of marching. Cost target: about -0.4 ms
of the per-frame time measured in the same bench run. Look target: identical to the eye; the
owner's rule is "half-res is fine, quarter-res is not", so guard the dust-lane edges.

Baseline measured today on the unmodified worktree, same harness, RTX 3090 @1440p:
rev10 0.58 ms, rev18 1.75 ms, cur 1.33 ms, bake 1.6 ms once. Absolute numbers drift with the
GPU's clock state between runs (the handoff recorded cur 2.46 on an earlier run), so ONLY
same-run differences count: every table you report must have rev18, the frozen pre-phase-2
`cur` (see harness section) and your new `cur` from ONE `run.sh` invocation.
Before shots of the unmodified source are already at `<wt>/.void-bench/shots/p2_before.png`
and `p2_before_hub.png` (rendered from 18b1bd9 by the orchestrator, SwiftShader 1280x720).

Design decisions already made (do not relitigate; deviate only with a measured reason, stated
in your report):

- **Shader split, one source of truth.** Restructure so `WHEEL_FIELDS_GLSL` (consts, noise,
  gasPattern, bake helpers) is shared by three programs: `BAKE_GLSL` (unchanged),
  a new `GAS_GLSL` (the half-res pass) and `WHEEL_GLSL` (full-res). Move `gasDepthProfile`
  and the march loop into `GAS_GLSL`; `WHEEL_GLSL` keeps `stars3`, the bulge, the dome and the
  compositing. Nothing GLSL is duplicated between the two.
- **What the half-res target holds**: `rgb = gasCol*gasAcc` (lit gas colour, before GAS_GAIN,
  before depthFade), `a = gas` (= 1-T, the opacity the stars are dimmed by). `depthFade`, the
  bulge, GAS_GAIN and the early-out are cheap and analytic — apply them in the FULL-res pass so
  the fade edge stays crisp and the half-res field is smooth everywhere (no discontinuity to
  upsample except the horizon `d.z>=0`, where the pass writes zeros).
- **Target**: `WebGLRenderTarget`, `HalfFloatType`, `RGBAFormat`, `LinearFilter` min and mag,
  no mipmaps, `ClampToEdgeWrapping`, no depth/stencil. Size = drawing buffer / `GAS_RES_DIVISOR`
  (rounded up), a named constant = 2 with a comment carrying the owner's half-yes/quarter-no rule.
  Resize it in the existing `onFrame` callback where `u_res` is written, only when the drawing
  buffer size changed (`WebGLRenderTarget.setSize`).
- **Exact pixel-centre mapping.** The gas pass must reproduce the full-res `uv` for the full-res
  pixel its texel centre stands for. Pass the full-res `u_res` to both programs plus a uniform
  holding the target size (`u_gasRes`); derive `uv` in `GAS_GLSL` from
  `gl_FragCoord.xy * (u_res / u_gasRes)` so that with an odd drawing-buffer dimension the two
  passes still agree to a fraction of a pixel. The full-res pass samples the target at
  `gl_FragCoord.xy / u_res` with bilinear filtering. State the formula you used in the report.
- **Upsample filter**: bilinear first. Then diff against the before shots (verification 3). If
  the hub shot shows blockiness or a halo at dust-lane edges (look for it in the diff image —
  a structured edge, not noise), upgrade to a 4-tap filter weighted by the gas alpha difference
  (edge-aware), and report both diffs. Do not add the edge-aware filter speculatively: it costs
  fetches and the owner wants the cheapest version that looks identical.
- **When the pass runs**: inside `mesh.onBeforeRender` — the SAME hook that writes the world
  frame today — after `writeWorldFrame`, and only when `style === 'wheel'`. That hook runs after
  `controls.update()`, so the gas and the stars see the same camera; an `onFrame` callback would
  be one frame behind the camera and the two layers would slide against each other under orbit.
  Copy the Reflector's state discipline: save/restore `getRenderTarget` (with cube face and mip
  level, as `bakeGasPattern` already does), disable and restore `renderer.xr.enabled` and
  `renderer.shadowMap.autoUpdate` around the nested `renderer.render(gasScene, gasCamera)`.
  Reuse the fullscreen `geometry`; a second `Mesh` in its own `Scene` with the shared `uniforms`
  object, exactly like the bake does. Allocate the target, material, scene and mesh lazily from
  `materialFor('wheel')` next to the bake, so the nebula style never pays for them; dispose all
  of them in `dispose()`.
- **Uniforms**: the shared `uniforms` object gets `u_gasRes` (Vector2) and `u_gasHalf`
  (the target's texture). The gas program uses `u_gasBake`/`u_gasLevel`; the wheel program no
  longer does — three skips uniforms a program lacks, so nothing else changes.
- Keep every existing comment; move them with the code they describe. Update the header
  REVISION narrative in `celestialVoid.ts` only where a sentence becomes false. No new files.

## Bench harness — you must extend it, the numbers are the deliverable

- `gen.mjs`: also lift `GAS_GLSL`; emit `{ wheel, bake, gas }` per variant (`gas` absent =
  single-pass variant: rev10, rev18). The `name=CONST:val` override mechanism must apply to all
  three. Add a frozen `rev19` variant to `bench.html` = the current committed `cur` (wheel+bake,
  no gas pass) the same way `rev18` was frozen, so the phase's before/after is one run.
- `gl2.js` (inlined into both `bench.html` and `shot.mjs`): for variants with `gas`, create an
  RGBA16F half-res texture + framebuffer (size = ceil(W/GAS_RES_DIVISOR), lift the constant),
  and per frame draw the gas program into it, then the wheel program to the canvas with
  `u_gasHalf` bound. The GPU timer must bracket BOTH draws — the per-frame cost is the pair.
  Keep the bake reporting as it is.
- `shot.mjs`: unchanged poses; the two-pass path comes for free through `gl2.js`.
- README: add the phase 2 numbers under "Numbers" and a line describing the two-pass path.

## Verification (all four required; paste evidence in the report)
1. `pnpm --filter client typecheck` clean, run from the worktree.
2. `node .void-bench/gen.mjs && .void-bench/run.sh` from the worktree: report rev10, rev18,
   rev19 and cur medians from one run, plus the bake time. Then a second variant run with
   `GAS_RES_DIVISOR:1` (the two-pass path at full res) so the pass overhead itself is visible:
   report it too.
3. `node .void-bench/shot.mjs cur` → `cur.png`, `cur_hub.png`. Per-pixel diff (max and mean abs
   channel difference) against `p2_before.png` / `p2_before_hub.png` with whatever exists
   (python3 + PIL, ImageMagick `compare`, or a canvas in the same headless Chrome — check, do
   not install). Write the diff images to `shots/_diff_p2_view.png` and `_diff_p2_hub.png`.
   LOOK at both pairs and both diff images yourself (Read the PNGs); say what differs and
   whether any structured edge appears at dust lanes. Phase 1 landed at max 20/255 with eyes-on
   identical; that is the bar.
4. `git -C <wt> status --short` shows only your intended paths (`client/src/render/celestialVoid.ts`,
   `.void-bench/*` except `shots/`); commit with
   `perf(void): march the gas at half resolution (#341)`, no attribution trailers.

Do not touch `.claude/orchestration/refs/celestial-void-shaders.glsl` or the review page; the
orchestrator mirrors those after review.

## Report format (final message)
- Commit hash on `celestial-void-perf`.
- Bench table: rev10 / rev18 / rev19 / cur ms and the divisor-1 variant, bake ms, all from
  the runs named above.
- Shot diff numbers for both poses + your eyes-on description; whether the edge-aware filter
  was needed and, if so, both diffs.
- The uv formula used in the gas pass and how the target size is rounded.
- Decisions taken where the brief left a choice, and anything you could not verify, stated as such.
