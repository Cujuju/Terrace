# Celestial void shader bench

`bench.html` times the wheel shader alone at 2560x1440 on the real GPU with
`EXT_disjoint_timer_query_webgl2` (GPU time, median of 7 interleaved rounds of
60 frames). The context is `webgl2`, matching the app (three r185 has no WebGL1
path). Chrome inside WSL only reaches SwiftShader, so `run.sh` runs it through
the Windows Chrome; it resolves its own directory, so a worktree benches the
source it was generated from.

    node .void-bench/gen.mjs [name=CONST:value,CONST:value ...]   # rebuild SHADERS from celestialVoid.ts
    .void-bench/run.sh                                            # bench every variant
    node .void-bench/shot.mjs [names...]                          # look check: shots/<name>{,_hub}.png (SwiftShader)

`gen.mjs` lifts COMMON_GLSL + WHEEL_FIELDS_GLSL + WHEEL_GLSL + BAKE_GLSL +
GAS_GLSL + STARS_VERT_GLSL + STARS_FRAG_GLSL from the client source and emits
`{ wheel, bake, gas, stars }` per variant (`bake` absent means the variant needs
no texture; `gas` absent means it marches the gas inline instead of in a half-res
pass; `stars` absent means it finds its stars inside the wheel program instead of
drawing a point cloud). Every `${...}` in the GLSL is evaluated against
the TS file's own top-level constants — and against `shared/src/constants.ts` and
`client/src/config.ts` first, since the star field's extents are derived from
world and camera constants celestialVoid.ts imports — so a shader constant has
one source.
Each argument makes a variant by overriding GLSL `const` values by name, in the
wheel, the bake, the gas pass and the star programs alike; `cur` is always the unmodified source. `gl2.js` holds
the WebGL2 setup both `bench.html` and `shot.mjs` use — a `file://` page cannot
load a sibling script, so both inline it.

For variants with a bake, the harness renders the bake shader once into the two
log-polar textures (RGBA16F for colour+pattern, R16F for level, mipmapped, u
repeating and v clamped — the app's setup) and reports that one-off cost apart
from the per-frame time.

For variants with a gas pass (#341), each frame is TWO draws: the gas shader into
an RGBA16F target at `ceil(canvas / GAS_RES_DIVISOR)` — bilinear, clamped, no
mips, the app's target — and then the wheel to the canvas with that texture bound
to `u_gasHalf`. The GPU timer brackets the pair, so a reported ms/frame is the
whole two-pass cost. `GAS_RES_DIVISOR` is a GLSL const purely so the harness can
lift it: `div1=GAS_RES_DIVISOR:1` benches the two-pass path at full resolution,
which isolates the pass's own overhead from the resolution saving.

For variants with a point cloud (#342), the frame gains a third stage: three
`drawArrays(POINTS)`, one per star grid, additively (`ONE, ONE` — the app's
`AdditiveBlending` on a premultiplied material) straight over the wheel's output,
with blending off again afterwards. The GPU timer brackets all three stages. The
buffers are built ONCE from the generator's own source: `gen.mjs` runs
`client/src/render/celestialVoidStars.ts` through `stripTypeScriptTypes` and
inlines it with the grid table lifted from `celestialVoid.ts`, so the bench draws
the very stars the app draws rather than a second implementation of the same
formulas. That build is reported apart from the frame time, as the bake is, and
so are the point counts, their bytes and the driver's
`ALIASED_POINT_SIZE_RANGE` (1..1024 on the RTX 3090, 1..1023 under SwiftShader).

The point cloud's cost depends on the POSE — the ray march's did not — so `rev20`
and `cur` are timed at the hub pose as well, as extra `@hub` rows. A variant's
second pose shares the first's bake textures and star buffers; only its programs
and uniforms are built again.

## Frozen variants

`gen.mjs` never regenerates these; they are kept in `bench.html` so a change can
be timed against what it replaced on the same harness.

- `rev10` — the pre-3-D wheel. Predates DISK_SCALE, so it is posed at the
  reference's own eye distance, 2.6.
- `rev18` — the wheel as it stood before the log-polar bake (#340).
- `rev19` — the wheel as it stood after the bake and before the half-res gas
  pass (#341): one program, the march inline at full resolution.
- `rev20` — the wheel as it stood after the half-res gas pass and before the
  star point cloud (#342): two programs, the stars still walked per fragment.

## Shot poses

Both are the view anchor's frame at WHEEL_TILT_DEGREES = 60, u_focal 1.2,
u_time 0.7, 1280x720, u_toDisk = [1,0,0, 0,cos60,sin60, 0,-sin60,cos60]
(column major).

- `<name>.png` — the reference framing. Eye 2.6/DISK_SCALE = 3.05882 disk units
  from the hub: u_origin = (0, -2.64902, 1.52941), u_dome = 0.
- `<name>_hub.png` — the same tilt and hub-centred framing at
  HUB_POSE_FRACTION = 1/6 of that distance, 0.50980 disk units:
  u_origin = (0, -0.44150, 0.25490), u_dome = 1. This is where the bake's
  texels are largest on screen, so it is the pose that decides GAS_BAKE_SIZE.
  Its eye height above the disk plane, 0.2549 disk units, is about what the
  world anchor reaches at CAMERA_MIN_DISTANCE, so it stands in for the app's
  closest zoom.

## Numbers

RTX 3090 @1440p. 2026-09-05 wall clock + readPixels (old harness): rev 10
1.7 ms, rev 15 6.1 ms, rev 16 2.1 ms. WebGL1 GPU timer: rev 10 1.0 ms, rev 17
2.7 ms; of which stars ~1.0, gas march ~0.55 (puffs ~0.6 of the march+pattern),
the rest the arm pattern.

WebGL2 GPU timer, 2026-09-05, medians of three runs (the WebGL2 context reads
within a few percent of the WebGL1 one on the same shader):

| variant | ms/frame | note |
| --- | --- | --- |
| rev10 | 1.25 | pre-3-D reference |
| rev18 | 3.05 | before #340 |
| cur | 2.46 | #340, GAS_BAKE_SIZE 2048 — bake 1.5–2.5 ms once |
| cur1024 | 2.47 | GAS_BAKE_SIZE 1024 — bake ~1.6 ms once |

The bake saves 0.59 ms/frame (19%). Resolution does not move the frame time —
it is a VRAM and a sharpness choice, not a speed one.

WebGL2 GPU timer, 2026-09-05, ONE run (absolute numbers drift with the GPU's
clock state between runs — the table above ran cooler; only same-run differences
mean anything). This is the phase 2 before/after, #341:

| variant | ms/frame | note |
| --- | --- | --- |
| rev10 | 1.05 | pre-3-D reference |
| rev18 | 2.84 | before #340 |
| rev19 | 2.22 | after #340, before #341 — bake 1.8 ms once |
| cur | 1.71 | #341, gas at 1280x720 — bake 2.6 ms once |
| div1 | 2.50 | the same two-pass path at 2560x1440 — bake 3.4 ms once |

The half-res gas pass saves 0.51 ms/frame against rev19 (23%). `div1` is what
the second program, the extra target write and the texture read cost on their
own: +0.28 ms over rev19 at the same resolution. So the resolution drop is worth
about 0.79 ms and the split gives 0.51 of it back.

WebGL2 GPU timer, 2026-09-05, ONE run. This is the phase 3 before/after, #342 —
the stars as a point cloud. Baselines drift between runs, so only the same-run
differences count:

| variant | view pose | hub pose | note |
| --- | --- | --- | --- |
| rev10 | 1.02 | | pre-3-D reference |
| rev18 | 2.83 | | before #340 |
| rev19 | 2.22 | | after #340, before #341 — bake 2.0 ms once |
| rev20 | 1.73 | 1.43 | after #341, before #342 — bake 1.2 ms once |
| cur | 1.00 | 1.00 | #342, 1,194,486 points — bake 3.9 ms once, buffers 179 ms once |

The point cloud saves 0.73 ms/frame at the view pose (42%) and 0.43 ms at the hub
pose (30%), and it takes the whole wheel back to the pre-3-D reference's cost.
The two poses now time the same, which is the point: a fragment's cost no longer
depends on how many voxels its ray crosses. The one-off buffer build is 179 ms of
CPU at startup for 27.3 MB of vertex data (24 bytes a star: position float32 x3,
radius/kind/brightness float32 x3).
