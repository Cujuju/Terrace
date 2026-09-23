# Issue 506: fractional grounding and continuous climb placement

Baseline: `061d0515`. Implementation branch: `t3code/issue-506-impl`.

## Implemented contract

Public ground queries take rendered world-cell coordinates: world X/Z divided by `CELL_WORLD_SIZE`. The client converts to shared field coordinates with `DRAWN_GROUND_CELL_CENTRE`; availability derives its stencil from the same conversion. Chart selection uses the rendered position, and blocky support uses the nearest lattice sample. Integer probes, world clamping, receipt/publication gates, and raw/binomial modes remain supported.

The exported `drawnGroundYAt(mirror, ground, x, z)` in `E:\Development\Projects\Terrace\client\src\terrain\drawnGround.ts` owns this gate and conversion boundary; `E:\Development\Projects\Terrace\client\src\world.ts` delegates to it. Coordinate with #504 when replacing live field reads with published snapshots. Its chart lifetime/publication work remains separate; this change does not repair dirty-chart invalidation or snapshot consistency independently.

A small optional `ClimbPath` wire descriptor carries the existing entry, exit, foot, raw endpoint heights, heading, leg, and seed-derived identity. It changes serialization and client adaptation, not server movement advancement, terrain math, climb timing, or fall decisions. Existing server projections already spread `climbWireOf`.

All three client movers use one continuous mapping between drawn endpoint support. Entry/arrival share the horizontal interpolation window. Falls map continuously to foot support. Endpoint samples are cached against relevant terrain revisions; terrain/mode changes rebase the correction from the displayed pose. Riser probes use the same rendered coordinate origin, the actual climb heading/body inset, and release their offset over the arrival interpolation window.

Unknown required climb anchors defer placement; newly unsupported monster climb meshes are hidden until support returns. Existing non-climbing monster fallback behavior is unchanged.

Swimmer clearance again samples fractional center, bow, stern, and both beam positions, rotated and scaled from the model envelope. Every required probe must be known and wet; an unknown or dry probe skips placement rather than silently accepting partial support. Existing shallow-column midpoint behavior is unchanged. Walkers retain center sampling, and distant wildlife retains its existing held-frame schedule.

## Evidence

Captured measurements and sampled position traces:
`E:\Development\Projects\Terrace\docs\investigations\issue-506-grounding-evidence.json`.

- Existing actual WebGPU/CPU mesher parity harness: 80 golden-fixture chunks in raw mode and 80 in binomial mode; both report agreement under their existing geometry tolerances.
- Direct point-in-emitted-triangle comparisons on an asymmetric slope and both sides of chunk seams: all eight selected raw/binomial positions match the corrected fractional query, CPU cap, and GPU cap.
- One exploratory position exactly on an isoline, (15.9, 10.2), still differs by a band at the pre-existing subcell quantization boundary. Shared field coordinates floor to 1/1024 cell; emitted contours and packed GPU positions have their own precision. This patch does not claim exact equality at contour ties or resolve #475.
- Controlled climb traces execute production shared movement, wire projection, pilgrim parsing/interpolation, ground placement, and riser alignment at 60 Hz. Ascent, descent, and falls in both directions finish with zero support error and zero riser offset.
- In the fixture, ordinary ascent/descent maximum per-frame vertical movement changes from 0.033333 to 0.002083 world units. Falls remain continuous with maximum steps about 0.0125. These are placement traces, not a claim about all gameplay animation.
- Additional traces cover a late join, switching to binomial smoothing, and changing terrain during a climb. Revision changes produce bounded correction motion instead of snapping directly to the replacement endpoint heights.
- Actual drawn-terrain swimmer fixture: an elongated eel crosses a submerged ledge at 0°, 45°, and 90°, at scales 0.6 and 1.4. Center-only placement penetrates the forward sampled support by up to 2.327 world units; restored footprint placement gives positive sampled belly clearance in all six cases.

## Placement cost

Browser CPU microbenchmark: fixed populations, 180 full-update frames, nine alternating-order trials after warmup; median elapsed time divided by frame count. Both variants use the same live-style revision-managed field cache. Baseline grounding/riser helpers come from `061d0515`; comparison includes their availability gates. Climber counts include riser probes and initial endpoint sampling.

| Mode | Population | Ground queries/frame, baseline → updated | Placement ms/frame, baseline → updated |
|---|---|---:|---:|
| raw | pilgrims (46) | 46.0 → 46.0 | 0.015 → 0.013 |
| raw | walkers (300) | 300.0 → 300.0 | 0.046 → 0.045 |
| raw | swimmers (200) | 200.0 → 1000.0 | 0.034 → 0.179 |
| raw | climbers (50) | 212.8 → 275.8 | 0.049 → 0.073 |
| binomial | pilgrims (46) | 46.0 → 46.0 | 0.017 → 0.026 |
| binomial | walkers (300) | 300.0 → 300.0 | 0.064 → 0.076 |
| binomial | swimmers (200) | 200.0 → 1000.0 | 0.041 → 0.214 |
| binomial | climbers (50) | 200.0 → 284.2 | 0.053 → 0.073 |

Swimmer correctness costs four additional queries per full update. Endpoint caching avoids three extra queries on every climbing frame. Unchanged LOD held frames are not included in this full-update benchmark. These measurements exclude rendering, networking, and meshing and do not establish an FPS improvement or regression.

## Checks

- Workspace `pnpm typecheck`: passed.
- ESLint on changed TypeScript files: passed.
- Shared, client, pilgrims, monsters, wildlife, and server suites: 1,934 passed, one skipped (536 + 790 + 23 + 53 + 58 + 474).
- Minimal additions extend the existing drawn-ground and wildlife client suites: coordinate/seam/cap agreement, blocky/receipt behavior, continuous climb mapping and arrival alignment, revision/unknown/fall behavior, wire propagation, and oriented swimmer clearance.
- The initial whole-workspace run also exposed a missing local performance snapshot; copying the existing baseline fixture into this isolated checkout allowed the complete client suite to pass.
- Unchanged baseline failures remain: mana's zero-effect stroke assertion, reveal's two sweep-reach assertions, and the temples package's test command with no test files. Mana and reveal failures were reproduced against untouched baseline code. They were not repaired as part of grounding.

## Remaining limits and integration

- #504 must integrate its published query snapshots with the corrected client coordinate boundary. #505 should retain this rendered-world-cell public contract.
- Five hull probes establish the existing sampled clearance contract, not exact collision over every point of an animated hull. Arbitrary narrow obstacles between probes and held LOD frames are not proven collision-free.
- The deployed client and server should be updated together. Older servers remain parseable and get continuous raw-height fallback, but lack the endpoint information needed for the full drawn-support guarantee.
- The browser harness exercises production geometry and movement code; it is not a networked gameplay/pose review. #364 remains open. #412 has controlled endpoint evidence; neither related issue was closed automatically.
- #493's old instruction to restore walker footprint maxima is obsolete. The remaining swimmer fractional/unknown-support requirements are addressed explicitly here.
- No authoritative sculpt math, smoothing protection, or generic interpolation engine was changed.

Diagnostic harnesses remain in the isolated checkout under `C:/Users/<user>/.t3/worktrees/Terrace/issue-506-impl-20260922/client/.terrace-tmp/`; the concise evidence JSON is committed for review.
