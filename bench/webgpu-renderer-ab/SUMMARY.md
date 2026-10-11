# Renderer A/B: three.js WebGLRenderer vs WebGPURenderer, same scene — 2026-09-10

Question (owner): would moving the client to the WebGPU renderer and TSL hurt the
current CPU mesher's performance, and would it look the same?

One page, `ab.html`, builds the shipped CPU mesh (`bench/webgpu-mesher/cpu-mesh.bin`,
11,753,733 vertices, 3,917,911 triangles) into the client's arena layout — 16
super-meshes, f32 position, 8-bit normal, 8-bit colour, 8-bit selfLit, capacity
18.87 MB of positions each as shipped — with the client's lights, camera pose,
ACES tone mapping and exposure, and one `MeshStandardMaterial` (vertexColors,
flatShading, DoubleSide, roughness 0.95). `?r=webgl|webgpu` picks the renderer;
nothing else differs. After 120 warm-up frames: 600 idle frames, then 600 frames
replaying the post-fix stroke upload pattern (1.2 MB/frame of ranged writes into
one super-mesh, four ranges, all four attributes, via `addUpdateRange` +
`needsUpdate`, the client's path). Visible Chrome window 1200×900, 144 Hz,
RTX 3090, `--use-angle=d3d11`, `--enable-unsafe-webgpu`; adapter reported
`nvidia / ampere`, not a fallback. The owner's stack was running on the same GPU
throughout, so every number is an upper bound. `?extra=150` adds 150 small
meshes with distinct materials so the draw count matches the app's (163).

Run: `node bench/webgpu-renderer-ab/run.mjs [--idle N] [--stroke N] [--only webgl|webgpu] [--query "pad=1&extra=150"]`.
Results files: `results-*.json`; images `webgl.png`, `webgpu.png`, `diff.png`.

## Frame intervals (rAF, ms) — 163 draws

| layout | renderer | idle p50 / p99 / max | stroke p50 / p95 / p99 / max | stroke fps | `render()` JS stroke p50 |
|---|---|---|---|---|---|
| 8-bit ×3 (as shipped) | WebGL | 6.9 / 7.2 / 7.4 | 7.0 / **20.8** / **97.4** / **118.1** | 94.7 | 1.6 |
| 8-bit ×3 | WebGPU | 6.9 / 7.1 / 7.3 | 55.5 / 62.6 / 69.5 / 83.3 | 18.2 | **53.4** |
| 8-bit ×4 | WebGL | 6.9 / 7.1 / 9.1 | 6.9 / 7.0 / 7.1 / 7.1 | 144.0 | 0.7 |
| 8-bit ×4 | WebGPU | 6.9 / 7.1 / 7.2 | 6.9 / 7.0 / 7.1 / 13.8 | 143.8 | 1.6 |

Same without the extra meshes (16 draws): WebGL ×3 stroke p99 / max 125 / 139
and 104 / 125 in two runs; WebGL ×4 13.9 / 20.9; WebGPU ×4 7.1 / 7.9.

## What the table says

1. **The WebGPU renderer does not hurt the CPU mesher; with one layout change it
   removes the stroke tail entirely on this machine.** Idle is vsync-locked on
   both. Under the stroke pattern WebGPU ×4 holds 144 fps with p99 7.1 ms; the
   renderer's own JS is 1.6 ms per stroke frame (0.8 idle at 163 draws, against
   WebGL's 0.6), so per-object CPU cost is not a regression.
2. **The 8-bit ×3 attribute layout is the stroke tail in this bench, on both
   renderers, for different reasons.**
   - WebGL: p99 97–125 ms with ×3, 7–14 ms with ×4. D3D11 has no 8-bit ×3
     vertex format, so ANGLE must translate those attributes into a native
     layout on the CPU in the GPU process; the stroke trace
     (`.gpu-perf/results/2026-09-09-stroke-trace/SUMMARY.md`) found exactly that
     signature — `CommandBufferService:PutChanged` CPU growing with upload bytes
     while call counts stay flat — without naming the mechanism. *Inference*:
     the arena's `Int8Array ×3` normals and `Uint8Array ×3` colours are that
     mechanism. Not yet verified in the client; the next measurement is the
     sculpt probe with the arena padded to ×4.
   - WebGPU: three 0.185 pads ×3 8-bit attributes to ×4 itself, but on every
     update it re-pads the **whole** array in JS
     (`WebGPUAttributeUtils.js:200-212`) — 53 ms of `render()` per stroke frame.
     Storing ×4 on the CPU side avoids the path.
3. **`DynamicDrawUsage` is a trap on WebGPU.** three's WebGPU `Attributes.update`
   re-uploads any attribute with that usage every frame, whole array
   (`Attributes.js:103`), and re-pads it: the first run of this page, with the
   flag set as a hint, drew at 12–20 fps idle. The client sets it on the water
   position/normal attributes (`riverRig.ts:217-218`), layer-edge overlay,
   precipitation and herd instancing; the migration removes it everywhere.

## Look

`diff.png`, 3×3 neighbourhood, tolerance 8/255, WebGL vs WebGPU ×4:

| region | pixels | mismatched | mean |abs| diff | signed bias WebGPU − WebGL |
|---|---|---|---|---|
| terrain | 778,828 | 6,804 (0.87 %) | 1.45 / 255 | +0.75 / +0.75 / +0.76 |
| sky | 301,172 | 100 % | — | (159,199,232) → (196,214,226) |

Terrain shading is the same to within 1.5/255 with a uniform +0.3 % brightness
bias; the mismatches are single-pixel tread specks, the gate 1 metric's known
floor for two rasterisations of the same mesh. The sky is a real difference:
`WebGPURenderer` passes `scene.background` colours through tone mapping and
exposure, `WebGLRenderer` clears with the raw sRGB value. The client's sky is
the celestial void's own shader plus a background colour from
`skyEnvironment.ts`; the migration must set the background so it lands at the
same sRGB value (a `backgroundNode` with tone mapping off, or the colour
pre-inverted), and this diff is the check.

Colours in both images are the raw palette bytes declared linear (the client
decodes sRGB in a vertex splice, not reproduced here), so the images compare to
each other, not to the app.

## Not measured

- Plugins, water, reveal clip, ground shade, the celestial void: none are in
  this page. Their cost on WebGPU is whatever their TSL ports cost.
- The laptop (gate 2).
- GPU-process thread time (`CrGpuMain`) — only rAF intervals and `render()` JS.
  The whole-browser trace tooling in `.gpu-perf/results/2026-09-09-stroke-trace/`
  can be pointed at this page if the attribution needs confirming.
