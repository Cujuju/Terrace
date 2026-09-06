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

`gen.mjs` lifts COMMON_GLSL + WHEEL_FIELDS_GLSL + WHEEL_GLSL + BAKE_GLSL from
the client source and emits `{ wheel, bake }` per variant (`bake` absent means
the variant needs no texture). Every `${...}` in the GLSL is evaluated against
the TS file's own top-level constants, so a shader constant has one source.
Each argument makes a variant by overriding GLSL `const` values by name, in the
wheel and the bake alike; `cur` is always the unmodified source. `gl2.js` holds
the WebGL2 setup both `bench.html` and `shot.mjs` use — a `file://` page cannot
load a sibling script, so both inline it.

For variants with a bake, the harness renders the bake shader once into the two
log-polar textures (RGBA16F for colour+pattern, R16F for level, mipmapped, u
repeating and v clamped — the app's setup) and reports that one-off cost apart
from the per-frame time.

## Frozen variants

`gen.mjs` never regenerates these; they are kept in `bench.html` so a change can
be timed against what it replaced on the same harness.

- `rev10` — the pre-3-D wheel. Predates DISK_SCALE, so it is posed at the
  reference's own eye distance, 2.6.
- `rev18` — the wheel as it stood before the log-polar bake (#340).

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
