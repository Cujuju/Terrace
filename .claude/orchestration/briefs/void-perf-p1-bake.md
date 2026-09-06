# Celestial void perf phase 1 — bake the arm pattern into a log-polar texture (#340)

You are the implementation agent for GitHub issue Cujuju/Terrace#340. Work ONLY in the
worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/celestial-void-perf`
(branch `celestial-void-perf`, tip = main c706ebe). Never touch
`/mnt/e/Development/Projects/Terrace` itself (shared checkout, other agents live there).
Use `git -C <worktree>` for every git command. Commit to the branch; do not merge, do not push.

Read first, in this order:
1. `<wt>/CLAUDE.md` (project rules: no tests without permission — the owner said NO TESTS for this
   arc; erasable TS; named constants; never start the app).
2. `<wt>/client/src/render/celestialVoid.ts` in full (765 lines). Everything below refers to it.
3. `<wt>/.void-bench/README.md`, `gen.mjs`, `run.sh`, `shot.mjs`, and the first 40 lines of `bench.html`.

## What to build

`WHEEL_GLSL`'s `gasPattern(rf, out gasCol)` (~line 441) and the `level` field
(`mix(GAS_TOP_Z,GAS_BOTTOM_Z,fbmLow(rf*LEVEL_SCALE+vec2(6.0,13.0)))`, ~line 493) are evaluated
per fragment every frame, though they depend only on the rotating-frame plane position `rf`.
Bake them ONCE into a texture in log-polar coordinates (u = theta/2pi wrapped, v = normalised
s = log(r + 0.05)) so the per-fragment cost becomes one atan, one log and one or two texture
fetches. Cost target: about -0.4 ms of the 2.80 ms baseline (the "arm pattern" share was
measured at ~0.45 ms). Look target: identical to the eye.

Design decisions already made (do not relitigate; deviate only with a measured reason, stated in
your report):
- **GPU bake, not CPU.** Write a `BAKE_GLSL` fragment shader that shares `COMMON_GLSL` and the
  wheel's const block, calls the SAME `gasPattern` and level code, and writes them into a
  render target. One GLSL source of truth: `gasPattern` must not be duplicated in JS. Restructure
  `WHEEL_GLSL` into pieces (e.g. a shared `WHEEL_FIELDS_GLSL` holding the consts + gasPattern) so
  the bake shader and the wheel shader are built from the same template strings.
- **Renderer is WebGL2** (three r185 has no WebGL1 path) — use a half-float RGBA render target
  (`HalfFloatType`), `RepeatWrapping` in u (theta wraps), `ClampToEdgeWrapping` in v, linear
  filtering, mipmaps ON (`generateMipmaps`, `LinearMipmapLinearFilter`) so the far-zoomed world
  anchor stops shimmering instead of aliasing as the procedural version does today. Verify
  mipmapped half-float RTs actually work in the bench (WebGL2 + EXT_color_buffer_half_float or
  EXT_color_buffer_float); if not, fall back to RGBA8 with a documented scale on `pattern`
  (pattern peaks near 1.55, so store pattern/2) and say so.
- **Five channels** are needed (gasCol.rgb, pattern, level). Use ONE texture twice as wide in u
  (left half = gasCol.rgb + pattern, right half = level in .r, the other channels free) OR two
  render targets — pick one, justify in the report. No MRT.
- **Resolution: a named constant** `GAS_BAKE_SIZE` (start at 2048 for the pattern axis pair,
  i.e. 2048 texels around theta and 2048 in s) with a comment carrying this derivation: the finest
  grain octave is `STREAK_ACROSS*16 = 640` cells around the circle (2pi/640 ~ 0.01 rad across an
  arm) and, because the wound angle advances `WIND/ARMS = 2` rad per e-fold of radius, ~0.005
  e-fold in s; over the baked s-range (~4.3 e-folds, see next bullet) Nyquist needs ~1700 texels
  in s and ~1300 around, so 2048 each. Bench 1024 as well and report both; keep 2048 unless 1024
  is indistinguishable in the shots (zoomed hub shot decides).
- **s-range**: `radial = exp(-r/DISK_RADIUS)*smoothstep(0,0.12,r)` is exactly 0 at r <= 0.12 and
  < 1e-3 beyond r ~ 12, so bake s from `log(0.12+0.05)` to `log(R_BAKE_MAX+0.05)` with
  `R_BAKE_MAX` a named constant (12.0, justified by that falloff). Outside: clamp-to-edge in v;
  the inner edge texel is 0 by construction, the outer edge is negligible. Level is fbmLow at
  LEVEL_SCALE 5 (coarse) — fine at this resolution anywhere.
- **Bake timing**: once, lazily, when the wheel material is first created (`materialFor('wheel')`)
  — the nebula style must not pay for it. Bake via `renderer.setRenderTarget` + a one-off
  fullscreen triangle draw with a bake `ShaderMaterial`, then restore the previous render target.
  `viewport.renderer` is available in `createCelestialVoid`. Dispose the RT and bake material in
  `dispose()`. Bind the RT texture as a `sampler2D` uniform (`u_gasBake`) on the wheel material.
- **Rotation stays per-frame**: `rf = rot(pp,-a)` is still computed in the shader; only the
  lookup replaces the procedural evaluation. The march loop (`gasDepthProfile`) is untouched
  (that is phase 2's territory).
- Keep every existing comment; add the minimum. Update the header REVISION narrative for this
  change in `celestialVoid.ts` only where a sentence becomes false (e.g. "evaluated ONCE per
  ray").

## Bench harness — you must extend it, the numbers are the deliverable

`.void-bench/gen.mjs` lifts `COMMON_GLSL` + `WHEEL_GLSL` by regex and bench.html / shot.mjs compile
the fragment shader standalone with a `webgl` (WebGL1) context and no textures. Extend all three so
that:
- `gen.mjs` also lifts the bake shader (and any new shared block) and emits, per variant,
  `{ wheel, bake }` (keep `rev10` working — it has no bake; treat `bake === undefined` as "no
  texture"). Keep the `name=CONST:val` override mechanism working on the new layout.
- `bench.html` and `shot.mjs` use a `webgl2` context (matching the app), and for variants with a
  bake: create the half-float texture (size from a `GAS_BAKE_SIZE` you also lift from the TS),
  render the bake shader into it once before timing, generate mipmaps, bind it to `u_gasBake`.
  The GPU timer extension on WebGL2 is `EXT_disjoint_timer_query_webgl2`. Timing must cover the
  per-frame wheel draw only (the bake is startup cost — report it separately, once, in ms).
- `run.sh` currently hardcodes `file:///E:/Development/Projects/Terrace/.void-bench/bench.html`.
  Make it resolve its own directory (the worktree path is
  `E:/Development/Projects/Terrace/.claude/worktrees/celestial-void-perf/.void-bench/bench.html`
  on the Windows side) so it benches the source it was generated from.
- `shot.mjs`: add a second pose per variant, `<name>_hub.png`, = the world anchor zoomed on the
  hub: eye straight above the hub, tilted 60 deg, at ~1/6 of the view-anchor distance, so texels
  are largest on screen. Use the same uniform layout (`u_toDisk`, `u_origin`, `u_dome=1`).
  Write the exact pose numbers in the README.
- The baseline shot from BEFORE your change is already saved on the shared checkout at
  `/mnt/e/Development/Projects/Terrace/.void-bench/shots/p1_before.png` (view anchor, rev 18,
  SwiftShader 1280x720). Copy it into your worktree's `.void-bench/shots/` (untracked dir) and
  ALSO render the hub pose of the unmodified source before you change anything
  (`p1_before_hub.png`) — do that first, from a clean tree, so the before/after pair is honest.

## Verification (all four required; paste evidence in the report)
1. `pnpm --filter client typecheck` clean, run from the worktree.
2. `node .void-bench/gen.mjs cur1024=GAS_BAKE_SIZE:1024 && .void-bench/run.sh` from the worktree:
   report rev10, cur (2048) and cur1024 medians, plus the one-off bake time. Baseline on the
   shared checkout today: rev10 1.06 ms, cur 2.80 ms (median of 7, RTX 3090 @1440p).
3. `node .void-bench/shot.mjs cur` → `cur.png` and `cur_hub.png`; produce a per-pixel diff
   against `p1_before.png` / `p1_before_hub.png` (max and mean abs channel difference — a tiny
   node script with pngjs is NOT available; decode PNGs with a Canvas in the same headless Chrome
   run, or use Python if `python3 -c 'import PIL'` works, or ImageMagick `compare -metric AE` if
   installed — check what exists, do not install anything). Report the numbers and LOOK at both
   pairs yourself (Read the PNGs) — say what, if anything, differs.
4. `git -C <wt> status --short` shows only your intended paths; commit with a conventional
   message (`perf(void): bake the arm pattern into a log-polar texture (#340)`), no attribution
   trailers.

Do not touch `.claude/orchestration/refs/celestial-void-shaders.glsl` or the review page; the
orchestrator mirrors those after review.

## Report format (final message)
- Commit hash on `celestial-void-perf`.
- Bench table: rev10 / cur / cur1024 ms, bake ms, GAS_BAKE_SIZE chosen and why.
- Shot diff numbers for both poses + your eyes-on description.
- Decisions taken where the brief left a choice (channel layout, RT type, mip filter, anything).
- Anything you could not verify, stated as such.
