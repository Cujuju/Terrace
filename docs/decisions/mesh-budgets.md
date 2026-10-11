# Mesh budgets

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (mesh budgets recalibrated — the blocky fallback, #38)

**Mesh budgets recalibrated for Deep Strata.** The blocky fallback fired on a
legitimate dig: a brush-4 hard pit from the coastal shelf to the lava floor
measures 10,575 triangles against the 10,240 budget calibrated 08-14 on land
fixtures — bordered underwater risers count double and Deep Strata added 8
bands, so floor-depth digs stack ~26 contour levels per chunk. New submerged
fixtures (wire-default anchored brush, provably bottoming at MIN_HEIGHT)
remeasured the table; heaviest legitimate chunk = 28,033 tris / 777k work.
Legitimate triangle counts now exceed adversarial pit-fields', so the
triangle budget stops discriminating and becomes purely the memory bound:
32,768 (one capacity doubling, 3.64 MB high-water). The work budget stays
1,000,000 as the sole discriminating guard (legit ≤ 777k, adversarial ≥
1,695k; depth adds levels — linear; adversarial shapes add holes —
quadratic). Counts report triangulationWork; the legitimate-sculpting
contract is pinned both ways in tests. Known cost: the worst legitimate chunk
builds in ~9 ms — an occasional dropped frame at the bottom of the world,
chosen over drawing the dig as blocks; the architectural remedy is
async/multi-frame meshing (#47, flagged, not built).

## Upload only what changed — 2026-09-23

Held-stroke stutter (1% slowest frames 70–110 ms) was GPU uploads of unchanged data. Fixes:

- River water and layer-edge lip lines: each run owns a power-of-two slot
  padded with zero-area triangles / zero-length segments. A resize within the
  slot rewrites that slot; an outgrown run moves to a new slot at the end;
  freed slots are holes, compacted once they pass half the buffer. Nothing
  shifts a tail. Slot order carries nothing: water normals are all +Y.
- A re-emitted run whose vertices did not change uploads nothing.
- A rebuilt lip chunk rewrites its run in place (no delete and re-append).
- three's WebGPU backend ignores texture update ranges and re-sends the whole
  image. The water curve texture writes each dirty chunk's 16×16 texels
  directly (`client/src/render/gpuTextureWrite.ts`), falling back to
  `needsUpdate` when there is no GPU texture.

Measured (real GPU, `frostwick-hollows`, 5 s held r4 stamp, 3 runs a side, vs
main `1814af5d`): uploads 341 → 68 MB; upload time 2.78 → 0.06 ms per frame;
mean frame 9.7 → 2.8 ms; 1% slowest 113 → 10 ms. Idle unchanged within noise;
triangles −10%. Residual tail frames are not attributable to uploads.

Zero-length line segments draw nothing on D3D and Vulkan; WebGPU does not
specify it. Unverified on Metal.
