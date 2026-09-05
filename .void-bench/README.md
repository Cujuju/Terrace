# Celestial void shader bench

`bench.html` times the wheel shader alone at 2560x1440 on the real GPU with
`EXT_disjoint_timer_query` (GPU time, median of 7 interleaved rounds of 60
frames). Chrome inside WSL only reaches SwiftShader, so `run.sh` runs it
through the Windows Chrome.

    node .void-bench/gen.mjs [name=CONST:value,CONST:value ...]   # rebuild SHADERS from celestialVoid.ts
    .void-bench/run.sh                                            # bench rev10 + cur + every variant
    node .void-bench/shot.mjs [names...]                          # look check: shots/<name>.png (SwiftShader)

`gen.mjs` lifts COMMON_GLSL + WHEEL_GLSL from the client source, substitutes
the `${...}` constants, and makes one variant per argument by overriding
GLSL `const` values by name. `cur` is always the unmodified source.

Numbers, RTX 3090 @1440p. 2026-09-05 wall clock + readPixels (old harness):
rev 10 1.7 ms, rev 15 6.1 ms, rev 16 2.1 ms. GPU timer (current harness):
rev 10 1.0 ms, rev 17 2.7 ms; of which stars ~1.0, gas march ~0.55 (puffs
~0.6 of the march+pattern), the rest the arm pattern.
