# Celestial void perf phase 3 — stars as a point cloud (#342)

You are the implementation agent for GitHub issue Cujuju/Terrace#342. Work ONLY in the
worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/celestial-void-perf`
(branch `celestial-void-perf`, tip = main 2f4831a). Never touch
`/mnt/e/Development/Projects/Terrace` itself (shared checkout, other agents live there).
Use `git -C <worktree>` for every git command. Commit to the branch; do not merge, do not push.
Never start the app. Do not install anything. Do not write tests (owner's rule for this arc).

Read first, in this order:
1. `<wt>/CLAUDE.md` (project rules: erasable TS; named constants; keep every existing comment;
   a runtime value exported from a module only when shared by two modules).
2. `<wt>/client/src/render/celestialVoid.ts` in full (1172 lines). Everything below refers to it.
   The star code you are replacing is `stars3` (line 659) and the `--- stars ---` block of
   `WHEEL_GLSL`'s `main()` (lines 716-729); the constants are `STAR_*`, `CELL_FADE_PX`,
   `GLOW_*`, `TWINKLE_*` (lines 469-484).
3. `<wt>/.void-bench/README.md`, `gen.mjs`, `gl2.js`, `shot.mjs`, `run.sh`, and `bench.html`
   lines 1 (canvas), 30-121 (skip the SHADERS blob on line 2).
4. `<wt>/client/src/render/scene.ts` lines 225-240 (the renderer: `alpha` is three's default,
   false, so the drawing buffer's alpha channel is dead) and 370-430 (the render loop).
5. `<wt>/client/node_modules/three/src/renderers/WebGLRenderer.js`: find `projectObject` and the
   opaque/transparent list split, and `WebGLState.setBlending`, to confirm for yourself the two
   facts this design rests on: (a) `material.transparent` only chooses the list an object is
   sorted into, opaque objects sort by `renderOrder` first; (b) `material.blending` is applied
   whatever `transparent` is. Quote the lines in the report.
6. The phase 2 brief `/mnt/e/Development/Projects/Terrace/.claude/orchestration/briefs/void-perf-p2-halfres.md`
   for the house style of the harness and the report (do not redo any of it).

## What to build

Today every full-res fragment walks three 3-D voxel grids (`stars3` x3, `STAR_WALK` = 24 visits
each) to find the stars on its ray. That is about 1.0 ms of the wheel's cost at 1440p and it is
the last bulk item. Replace it with a point cloud: the stars are generated ONCE into vertex
buffers and drawn as `GL_POINTS` — the GPU rasterises each star exactly where it is instead of
every pixel searching for it. Cost target: about -0.9 ms in the same bench run. Look target:
the same field to the eye, with the differences listed under "Look changes to disclose" and
none others.

Baseline measured today on the unmodified worktree (2f4831a), same harness, RTX 3090 @1440p,
ONE run: rev10 1.26, rev18 3.11, rev19 2.51, cur 2.00 ms; bake 1.7 ms once. Absolute numbers
drift with the GPU clock state between runs, so ONLY same-run differences count: every table you
report has rev19, the frozen pre-phase-3 `cur` (= `rev20`, see harness section) and your new
`cur` from ONE `run.sh` invocation. Before shots of the unmodified source are at
`<wt>/.void-bench/shots/p3_before.png` and `p3_before_hub.png` (SwiftShader 1280x720).

### Design decisions already made (do not relitigate; deviate only with a measured reason, stated in your report)

- **Draw order and compositing: the points are drawn AFTER the wheel, additively, straight into
  the drawing buffer. No new render target.** Today's composite is literally `col += stars`,
  so an additive draw over the wheel's output is the same arithmetic. The wheel keeps the
  background, the gas (`u_gasHalf`), the bulge and the dome; it loses `stars3` and the whole
  `--- stars ---` block. The gas opacity every star formula needs is already in a texture the
  gas pass wrote this frame (`u_gasHalf.a`), so the point programs read it from there. This
  means the in-arm stars KEEP today's `*gas*2.5` and the field stars keep today's
  `dim`/`(0.45+0.9*gas)` — the "in-arm stars go fully behind the gas" look change the issue
  warned about does not happen. Say so in the report.
- **The three.js object**: one `Points` per grid (coarse field, fine field, in-arm) sharing one
  `ShaderMaterial` built on the SAME `uniforms` object as the wheel (clock, anchor frame,
  `u_res`, `u_focal`, `u_gasHalf` all shared — nothing can drift a frame). Material:
  `blending: AdditiveBlending`, `transparent: false` (it must stay in the opaque list so the
  terrain drawn later covers it — see read item 5), `depthTest: false`, `depthWrite: false`,
  `toneMapped: false`. `frustumCulled = false`, `matrixAutoUpdate = false`,
  `renderOrder = STARS_RENDER_ORDER` = `VOID_RENDER_ORDER + 1`, a named constant with a comment.
  Write `gl_FragColor.a = 0.0` so the additive pass leaves the buffer's alpha alone. Three
  `Points` rather than one so the fine and in-arm draws can be skipped on the CPU (below);
  they are created lazily from `materialFor('wheel')` next to the bake and the gas pass, hidden
  unless `style === 'wheel'` (toggle `.visible` in `setStyle`), and disposed in `dispose()`.
- **Generation: a seeded PRNG, not the voxel hashes.** Enumerating every voxel of the three
  grids through a JS port of `hash3` would be ~40 M hash calls (about a second at startup), and
  a float32 port would not reproduce the GLSL draw bit-for-bit anyway. Instead each grid gets
  its expected star COUNT and the same DISTRIBUTIONS: N = round(density * STAR_POINT_BOOST *
  columns) with columns = pi * R^2 * scale^2 (that is exactly `perVoxel * voxels`); position
  uniform over the disc of radius R (r = R*sqrt(u), theta = TAU*u) and uniform in depth over
  [-depth, 0]; radius = (0.03 + 0.05*u)/scale disk units; brightness = 0.5 + 0.5*u (that is
  today's `0.5+0.5*h/perVoxel` with h uniform on [0, perVoxel)); kind = u. The PRNG is
  mulberry32 (or splitmix32 — a 10-line, well-known one; cite which) with a named constant
  seed per grid so the field is the same on every start. Put the generator in a NEW sibling
  module `client/src/render/celestialVoidStars.ts` that imports nothing (pure functions over
  numbers and typed arrays, the grid parameters passed in) — it is shared by `celestialVoid.ts`
  and the bench, which is what earns it a file of its own under the CLAUDE.md rule. Attributes:
  `position` (Float32 x3, rotating-frame disk units) and one more attribute for
  radius/kind/brightness — Float32 x3 is fine; if you pack smaller, use normalized
  Uint8/Uint16 `BufferAttribute`s, nothing cleverer. Report the byte total.
- **Extents (the field must never show an edge).** Each grid's disc radius is a named constant
  with its derivation in a comment:
  - Coarse field: everything the depth fade can ever reveal. The fade ends at
    `FADE_END_HEIGHTS` (9.23) times the eye's height, so the visible ground radius from the eye's
    foot is at most `sqrt(FADE_END_HEIGHTS^2 - 1) * hMax`; hMax is the world anchor's greatest
    eye height in disk units — derive it from `CAMERA_MAX_DISTANCE` (900), the relief
    `(MAX_HEIGHT - MIN_HEIGHT) * HEIGHT_WORLD_SCALE`, `LOCKED_HUB_CLEARANCE_WORLD` and
    `LOCKED_WORLD_UNITS_PER_DISK_UNIT` (read config.ts; show the arithmetic). Add the eye foot's
    greatest horizontal offset from the hub (the orbit target stays on the map: half the largest
    world span you can find in config/shared, plus `CAMERA_MAX_DISTANCE`, in disk units).
    Expect roughly 50-55 disk units and ~400-500 k coarse stars. Beyond that radius the fade is
    zero by construction, so there is no edge to see.
  - Fine field: only visible while `cellFade > 0`, i.e. `sdist < u_focal*u_res.y/(32*CELL_FADE_PX)`
    (the fine grid's 32 cells per unit, as in today's `pxPerUnit/32.0`). That bound is
    RESOLUTION-dependent, so assume a named maximum drawing-buffer height
    `STAR_FINE_MAX_RES_Y = 2160` and the larger of the two anchors' focal lengths (VIEW_FOCAL
    1.2, or `0.5/tan(CAMERA_FOV_DEGREES/2)` in the world anchor — take the larger), plus the same
    eye-foot offset. Document the residual in the constant's comment: above that resolution the
    fine grid ends before it fades. Expect ~20-25 units, ~200-300 k stars.
  - In-arm: bounded by the gas, not the fade — it is drawn `*gas*2.5`, and the gas falls as
    `exp(-r/DISK_RADIUS)` (1.7). Choose the radius where `2.5*exp(-r/1.7)` is under 2 % of a
    star (r ≈ 8); name it, justify it. Expect ~300-350 k stars.
  - Hard budget: 1.2 M points total. Report the three counts and the total.
- **Per-frame CPU guard for the fine grids**: the smallest `sdist` on screen is the eye's height
  (the ray straight down), so when `origin.z >= focal*res.y/(32*CELL_FADE_PX)` the fine and
  in-arm factors are zero for every pixel — set those two `Points` invisible for the frame from
  `onBeforeRender` (after the frame is written, before the gas pass). Name the 32 (it is the fine
  grid's scale; the in-arm grid at 40 is finer still, so the same bound covers it — say so).
- **Vertex shader = today's per-star arithmetic, once per star.** From the rotating-frame
  position S: disk space `P = (rot(S.xy, +a), S.z)` (a = `u_time*WHEEL_RATE`, the wheel's own
  rotation — read `rot`'s sign convention and match `rf = rot(pp,-a)` inverted), then view space
  `v = transpose(u_toDisk) * (P - u_origin)` (`u_toDisk` is a rotation, so its inverse is its
  transpose; `viewRay` is `u_toDisk*normalize(vec3(uv,-u_focal))`). If `v.z >= 0` the star is
  behind the eye: emit a clip-space position outside the frustum and `gl_PointSize = 0`, and
  RETURN before any texture fetch. Otherwise `uv = -v.xy * u_focal / v.z` (screen heights, the
  wheel's `uv` convention), `ndc = 2*uv*u_res.y/u_res`, `gl_Position = vec4(ndc, 0.0, 1.0)`.
  Cull off-screen stars the same way (|ndc| > 1 + the sprite's half-size in NDC) BEFORE the
  fetch — at the view pose over 90 % of the coarse field is off screen and the fetch is the
  expensive part of this shader. Then: `t = length(v)` (today's `tBase + along/scale`);
  `sdist = -u_origin.z / dz` where dz is the disk-space ray's z, i.e. `(P - u_origin).z / t`
  (today's ray length to the plane along this star's ray); `depthFade` from `sdist` exactly as the
  wheel; `pxPerUnit = u_focal*u_res.y/sdist`; `cellFade` as today; radius on screen
  `rPx = max(radius * u_focal*u_res.y / t, STAR_MIN_PX)` (today's `max(size, minPerT*t*scale)`
  projected); `gas = texture2D(u_gasHalf, ndc*0.5+0.5).a` (one fetch per star, in the vertex
  shader — the same texture the wheel reads, bilinear, no mips, so `texture2D` in a vertex shader
  is fine under GLSL ES 1.00); `dim = 1 - STAR_GAS_SHADE*above*clamp(-S.z/DISK_THICKNESS,0,1)`
  with `above` = gas for the field grids and 0 for in-arm; the grid's weight (1.0 coarse,
  0.6*cellFade fine, cellFade*gas*2.5 in-arm) and the wheel's outer factor
  (`(0.45+0.9*gas)` for the field grids, none for in-arm) and `depthFade*depthFade`; twinkle by
  kind as today. Pass the fragment ONE varying: the star's premultiplied colour
  (`vec3(0.95,0.93,0.9) * brightness * everything above`), plus `rPx` and a glow flag (a
  second varying, or pack; keep it plain). `gl_PointSize = 2*rPx*(glow ? GLOW_RADIUS : 1)`
  plus a named 1-2 px margin so the smoothstep's tail is not clipped by the sprite's edge.
  Query `ALIASED_POINT_SIZE_RANGE` once at creation and clamp `gl_PointSize` to it through a
  uniform; log nothing, just report the value the bench's renderer gives.
- **Fragment shader = today's falloff on `gl_PointCoord`.** `d = length((gl_PointCoord-0.5) *
  pointSize)` in px; `core = smoothstep(rPx, 0, d)`; glow kinds add
  `GLOW_GAIN*smoothstep(rPx*GLOW_RADIUS, 0, d)`. Output `vec4(colour*core, 0.0)`. This is the
  same smoothstep the ray walk evaluated in 3-D, so the 0.8 px floor and its anti-shimmer role
  carry over unchanged — state that in the header narrative rather than inventing a new falloff.
- **Which grid a vertex belongs to** is a property of the `Points` object, not the vertex:
  pass `u_starGrid` (0/1/2) per object via `onBeforeRender`-free means — simplest is three
  materials sharing the `uniforms` object plus one own uniform each, or one material and a
  per-object uniform through `Points.onBeforeRender`. Pick the plainer; say which.
- **Keep every existing comment**; move them with the code they describe (the `STAR_*`,
  `GLOW_*`, `TWINKLE_*` constants and their comments move to wherever the star programs now
  live — they can stay in `WHEEL_FIELDS_GLSL` if the star programs include it, or move to a
  `STARS_GLSL` block; no GLSL duplicated). Update the header narrative: add a "THE STARS ARE A
  POINT CLOUD" paragraph in the house style of the bake and half-res paragraphs, and fix any
  sentence the change makes false (the rev 13 comment that "the ray walks exactly" the voxel
  grids, the `STAR_WALK` comment, the `--- stars ---` comments). Delete `STAR_WALK` and
  `STAR_POINT_BOOST` only if nothing reads them any more — `STAR_POINT_BOOST` is still the
  density multiplier in the count formula, so it very likely stays.

### Look changes to disclose (owner eyes-on decides; list them, do not hide them)
1. The field is a fresh random draw with the same statistics, not today's exact stars. It is
   stable across starts (fixed seeds).
2. Every star to the grid's full depth is drawn. Today's walk stopped at `STAR_WALK` = 24 voxels
   (~80 % of the coarse depth at 60°, less at flatter angles), so flat world-anchor views gain
   the deepest stars back. The `STAR_WALK` comment called this a bench compromise, not a look
   decision.
3. The in-arm stars do NOT change: the gas dims them exactly as before (see compositing above).
4. Fine and in-arm grids end at a finite radius sized for 4K; at higher resolutions they end
   before they fade.

## Bench harness — you must extend it, the numbers are the deliverable

- `gen.mjs`: also lift the star vertex and fragment GLSL, and inline the generator's JavaScript
  by reading `celestialVoidStars.ts` and running it through
  `stripTypeScriptTypes` from `node:module` (Node 24.19 — confirm the function exists with a
  one-liner first) so `bench.html` and `shot.mjs` run the SAME generator the app does. Emit
  `{ wheel, bake, gas, stars: { vert, frag, gen } }` per variant; `stars` absent = the variant
  has stars in its wheel program (rev10, rev18, rev19, rev20). The `name=CONST:val` override
  must apply to the star programs too. Add a frozen `rev20` = the current committed `cur`
  (wheel + bake + gas, stars still inline) to `bench.html` the way `rev19` was frozen.
- `gl2.js` (inlined into both `bench.html` and `shot.mjs`): for variants with `stars`, build
  the three vertex buffers once from the generator (report the build time), and per frame draw
  gas → wheel → points (three `drawArrays(POINTS)` with additive blending, `ONE, ONE`, blend
  off again afterwards). The GPU timer brackets all of it. The bench's `pose(...)` already
  takes a `kind`: add a `hub` timing column beside the view pose for `rev20` and `cur` only (the
  point cost depends on the pose; the march did not). Log `ALIASED_POINT_SIZE_RANGE`.
- `shot.mjs`: unchanged poses; points come through `gl2.js`.
- README: a "point cloud" paragraph under the harness description, the phase 3 numbers under
  "Numbers", `rev20` under "Frozen variants".

## Verification (all four required; paste evidence in the report)
1. `pnpm --filter client typecheck` clean, run from the worktree.
2. `node .void-bench/gen.mjs && .void-bench/run.sh` from the worktree: rev10, rev18, rev19,
   rev20 and cur medians from ONE run at the view pose, plus rev20 and cur at the hub pose, plus
   the bake time and the point-buffer build time.
3. `node .void-bench/shot.mjs cur` → `cur.png`, `cur_hub.png`. Per-pixel diff (max and mean abs
   channel difference) against `p3_before.png` / `p3_before_hub.png` with whatever exists
   (python3 + PIL, ImageMagick, or a canvas in the same headless Chrome — check, do not install).
   Write `shots/_diff_p3_view.png` and `_diff_p3_hub.png`. The stars WILL differ pixel-for-pixel
   (a new draw), so the numbers alone prove nothing here: LOOK at both pairs yourself (Read the
   PNGs) and describe star density, size range, glow halos, the softness of the smallest stars,
   and whether the gas over the in-arm stars reads the same. Also count bright pixels above a
   threshold in a star-only region of each pair (before vs after) as a density check and report
   the two counts.
4. `git -C <wt> status --short` shows only your intended paths (`client/src/render/celestialVoid.ts`,
   `client/src/render/celestialVoidStars.ts`, `.void-bench/*` except `shots/`); commit with
   `perf(void): draw the stars as a point cloud (#342)`, no attribution trailers.

Do not touch `.claude/orchestration/refs/celestial-void-shaders.glsl` or the review page; the
orchestrator mirrors those after review.

## Report format (final message)
- Commit hash on `celestial-void-perf`.
- Bench table: rev10 / rev18 / rev19 / rev20 / cur at the view pose, rev20 / cur at the hub
  pose, bake ms, buffer build ms, point counts per grid and bytes, `ALIASED_POINT_SIZE_RANGE`.
- Shot diff numbers, the bright-pixel density counts, and your eyes-on description per pose.
- The projection formula used (vertex shader), the extents with their derivations, the PRNG.
- The three.js lines you verified for read item 5.
- Decisions taken where the brief left a choice, and anything you could not verify, stated as such.
