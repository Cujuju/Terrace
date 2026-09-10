# Terrain renderer: carry-forward facts (2026-09-09, gate 1 added 2026-09-10)

## Measured (owner's RTX 3090, ANGLE D3D11, frostwick-hollows 512², app default camera pose, 1406×1229 px)

- App, all plugins, 45 s settle: frame p50 6.8 ms, p95 16.0 ms, p99 18.8 ms; GPU p50 2.57 ms; 3.2 M triangles; 104 draw calls.
- Terrain-only bench, zero plugins, shipped mesher output drawn as one Lambert mesh: GPU p50 0.68 ms; 4.02 M triangles; build 938 ms for 1,024 chunks (0.92 ms/chunk, single thread); 207 MB vertex buffers resident.
- Per-pixel raymarch of the same map: GPU p50 8.1 ms, holes. Dead.
- Main-thread time per frame in the app, profiled 2026-09-09: 4.34 ms JS = three.js render 2.73 (program lookup 0.62, uniform upload 0.56, projectObject 0.37, matrices 0.25, texSubImage2D 0.24) + plugin hooks 1.35 (wildlife 0.58, disc systems 0.34, cyclone 0.23, boats 0.08) + program 0.30; terrain 0.07. Transparent DoubleSide materials without forceSinglePass are drawn twice with a forced program rebuild, ≈0.6 ms/frame over 30 objects; not applied, owner's visual call. App renders uncapped at 128 to 240 fps.
- Owner's Chrome exposes WebGPU: NVIDIA Ampere adapter, compute, timestamp-query, indirect-first-instance, subgroups. Laptop: nothing measured.
- Shared drawn-ground function (mesher draws a function; consumers query it): implementation in progress by an agent, report pending. Required by options 1 and 2, compatible with 3.

## Option 1: smooth heightfield, painted bands

- Regular grid displaced from the height texture, distance LOD (clipmap or quadtree), bands as fragment colour with a line at band boundaries.
- No per-edit build; resident data is the height texture plus one grid; placement exact at cell centres.
- Terrace risers do not exist; the step is paint.
- Test: implement behind a flag in the existing client; run the app probe at the same pose; compare frame, GPU, memory against the numbers above; owner judges the look.

## Option 2: WebGPU compute mesher

- Compute pass per dirty chunk emits terrace geometry from the shared function into GPU buffers with compaction; indirect draw; CPU never builds.
- Requires the client on the WebGPU renderer; every custom shader splice is rewritten.
- Test, in order:
  1. Standalone WebGPU page, 512² map: compute mesher + timestamp queries. Pass: per-chunk compute < 0.1 ms, full-world rebuild < 50 ms, draw ≤ 1 ms, resident bytes ≤ 207 MB, zero mismatches against the shared function. DONE 2026-09-10, below.
  2. Existing client booted on the WebGPU renderer with terrain disabled: count materials and shader splices that fail; that count is the migration cost. DONE 2026-09-09: 160 materials, 23 ShaderMaterial refused by the node builder, 61 onBeforeCompile splices silently lose their effect, 76 unaffected; 22 files (11 with splices, 11 with ShaderMaterial) plus the celestial void's Points sizing, the PMREM variant, the GL timer, and async renderer init. Results in `.gpu-perf/results/2026-09-09-option3-profile/webgpu-run.json`.
  3. Steps 1 and 2 on the laptop. NOT DONE. Earlier check from Vivaldi on the M4 Max returned no adapter; chrome://gpu there reports WebGPU hardware accelerated on Metal. Use Chrome or Safari.

### Gate 1 result (2026-09-10, owner's RTX 3090, headless Chrome, timestamp queries, owner's stack running on the same GPU throughout, so all timings are upper bounds)

Page and harness: `.gpu-perf/gate1-webgpu-mesher/` (untracked). Run: `node E:\Development\Projects\Terrace\.gpu-perf\gate1-webgpu-mesherun.mjs`. Writes `results.json`, `report.md`, `gpu.png`, `cpu.png`, `diff.png`. Raw WebGPU + WGSL, no three.js. Per-cell marching squares on the CPU mesher's lattice with its crossing, saddle, refinement and colour rules; caps, risers, seabed border, shoreline level; no overhang undersides. Vertex 12 bytes quantized. Count pass, host prefix sum, emit pass at exact offsets; four 64-thread workgroups per chunk, one thread per cell square.

- Band parity, top-down band-ID pass against `drawnBandAt` at 4 samples/cell (4,198,401 samples): 157 mismatches, 0 holes. All 157 at exact cell centres in seabed bands; the shipped CPU mesh under the same pass: 573 mismatches, 4,097 holes, mismatching at the same samples. The repo's own gate (`client/scripts/drawnGroundParity.mjs`) exempts these as near-contour. Isoline port: 0 mismatches over 4,096 cases; bit-exact without wide integers (the bilinear field is linear along the solve axis, so the 2¹⁶ bisection reduces to one exact i32 division).
- Pixels, both meshes drawn by the same page at the bench pose, 1200×900, 3×3 neighbourhood, tolerance 8/255: 0.220 % differ. The shipped mesh diffed against itself translated 0.01 px: 0.191 %. So the GPU mesh is 313 pixels above the metric's noise floor. The 0.1 % limit was set below the floor and is void. Remaining visible difference: two small patches on one cliff, attributed unverified to the missing undersides.
- Triangles: GPU 5,207,401; CPU 3,917,911. Draw p50: GPU 0.69 ms; CPU mesh 0.69 ms. Resident: GPU 189.6 MB total (175.6 vertex); CPU mesh 188.1 MB.
- Full-world rebuild, 1,024 chunks, one dispatch: 2.5 ms GPU, 3.7 ms wall. CPU single thread: 938 ms. Serial one-pass-per-chunk was 160 to 1,005 ms across runs; that mode is dead.
- Edit, 3×3 chunk window, 100 KB height upload + re-emit, 100 iterations: heaviest window in the world (466,860 vertices) GPU p50 2.08 / p95 2.35 / max 2.59 ms; median window (115,635) 0.44 / 0.45 / 0.71 ms. Wall adds a ~3 ms submit-to-completion round trip a client would not block on. No CPU-to-GPU vertex upload exists on this path; the shipped path's stroke stall is upload-bound per the worker-mesher agent's finding.
- Verdicts by the pre-set criteria: parity kill (157 vs 0), pixels kill (0.22 % vs 0.1 %), per-chunk serial compute kill (0.17 vs 0.1 ms, superseded), rebuild pass, draw pass, memory pass. Judgement: look and holes are answered; the remaining kills are criterion defects, documented above.
- Not done: undersides (overhangs), the CPU's blocky fallback for over-budget chunks (6 of 1,024), incremental capacity per chunk (the page allocates by an exact count pass; a client needs per-chunk slack or a re-count on overflow).
- Next: worker-mesher stroke p95 and max after its upload fix set the bar; then the laptop on battery (this page and the shipped client, 10 min each, discharge rate + CPU); then decide the TSL rewrite. Screenshots and tables: https://claude.ai/code/artifact/8dadd956-fc02-42f5-8add-ddb2f50866c8

## Option 3: CPU mesher, cheaper

- Residency window: build and keep buffers only for chunks within N cells of the camera; far chunks two triangles each or none. Bounds build time and memory by view, not world size.
- All chunk builds in the worker; main thread only splices.
- Test, in order:
  1. Main-thread profile of the app at the probe pose, per-function split, to attribute the ≈4 ms; ablation probe for per-plugin savings.
  2. Same probe and profile on the laptop with battery and thermal readings.
  3. Implement the residency window; re-run 1 and 2.
