# Band smoothing

## Current owner decision — 2026-09-22

Remove the protection portion of the binomial filter. This supersedes the
September 21 requirement to preserve tiny terraces and holes. The current kernel
is one immutable-input 3×3 `[1,2,1]²/16` pass, with no extrema, diagonal, or layered
feature veto. Missing-input fallback and world-edge clamping remain correctness
rules. Undersides keep their existing binary extraction. Stored terrain and
server sculpt math remain unchanged; the setting remains default off.

Filter reach is now one cell: CPU/GPU filtered input windows shrink from 21×21
to 19×19. Raw mode restores 18×18 CPU worker and 17×17 GPU input windows. GPU
resident slots still reserve the maximum 19×19 stride and the synchronization
barrier remains unconditional because WGSL rejects the conditional form.

Workspace typecheck, 536 shared tests, and 786 client tests pass (one skipped).
Actual WebGPU/CPU cap and wall comparisons pass existing tolerances for all 80
golden-fixture chunks in each mode, including layered and world-edge fixtures.
These checks do not establish that the owner's live Stamp/Hard/2.0 interaction
is fixed. Three requested independent reviews are recorded in
`E:\Development\Projects\Terrace\docs\investigations\renderer-review-2026-09-22.md`.

The protected implementation and measurements below are historical evidence,
not the current filter specification.

## Picking and rebuild publication — 2026-09-22 (#504)

Owner decision: queries read live terrain; no immutable published snapshot.

- Cause of the Stamp/Hard/2.0 pit failure: smoothing drew the pit floor above
  its stored top, and picking handed the hit to the nearest rim column that
  covered the drawn band. Stamp targets the anchor's stored band plus one, so
  each press raised rim and pit together. Fix: the stored column under the hit
  owns the pick (`picking.md`).
- Dirty chunks no longer lose their chart. Picks previously failed on every
  rebuild frame, in raw mode too: raw picks struck the next chunk, smoothed
  picks returned nothing. A finished build newer than the displayed geometry is
  spliced even when a later edit is pending; stale generation, mode and
  disposed answers are still rejected. Supersedes "dirty chunks remain
  unavailable until their replacement geometry is written" below.
- Live probe, private stack, 2×2 pit two bands deep, 96 aimed rays, three
  stamp clicks, 12-press held stroke at 120 ms, GPU and CPU meshers:

  | Measure | Before, raw | Before, smoothed | After, raw | After, smoothed |
  |---|---|---|---|---|
  | Pit-floor picks owned by a pit cell | 39/96 | 0/96 | 39/96 | 56/96 |
  | Pit after 2 stamp clicks (rim 43) | 43 | 43 (rim 45) | 43 | 43 |
  | Rebuild frames with a wrong or missing pick | all | all | 0 | 0 |

- Rebuild window per edit: 1–3 frames CPU, 3–6 GPU. Walls come from the
  published chart and treads from live terrain until the new chart publishes.
- Pick cost did not justify a traversal index (figures in `picking.md`).
- Probe and raw results:
  `E:\Development\Projects\Terrace\scratch-band-investigation\pick-probe\`.

## Per-band clamped filter prototype — 2026-09-22

Offline only; owner visual review pending. Each band blurs its own field:
heights clamped to ±1 band around that band's contour height, same `[1,2,1]²/16`
kernel. Band outlines stay nested (monotone clamp, positive kernel).

Production contour resolution:

| Fixture | Measure | Original | Current filter | Clamped |
|---|---|---:|---:|---:|
| Stamp | total turning, rad | 614 | 240 | 159 |
| Stamp | band-12 area, cells | 76.4 | 70.0 | 72.5 |
| Stamp then smooth | total turning, rad | 570 | 203 | 139 |
| Jagged 8-band cliff | cliff width, cells | 1.07 | 2.69 | 0.77 |
| Jagged 8-band cliff | top tread area, cells | 494 | 468 | 499 |

- The current filter turns stamped walls and cliffs into stepped slopes; the
  clamped filter keeps them vertical. Clamped cliffs are narrower than the
  original (0.77 vs 1.07 cells): every band shares one outline.
- One-cell terrace, hole, channel and saddle controls vanish and the one-cell
  ridge nearly does, as with the current filter.
- Layer-opening slice, band 4: solid area 385 original, 403 current, 372
  clamped — the opening grows instead of shrinking.
- Files: `clamped-field.mjs`, fixture and variant in `build-protected-data.mjs`.
  Viewer: `node build-protected-comparison.mjs <out.html>`, then choose
  **Per-band clamped filter**.

## Owner decisions — 2026-09-21

- Prefer derived-field filtering to Bezier rounding: “derived looks better
  than bezier.” The owner judges the images; turning measurements do not
  establish aesthetic acceptability.
- Preserve one-cell terraces and tiny holes, with another visual review if
  protection changes the preferred full-filter appearance.
- Build the protected prototype and keep the design document current.
- Follow-up requirement: remove remaining high-frequency contour noise,
  especially sharp corners on the lowest visible terrace, while retaining
  the broader shape. A permissible displacement bound has not been selected.

Status: offline prototype built; protected appearance awaits owner review.
No production mesher, terrain storage, brush behavior, or ground query changed.
Tracking: [#503](https://github.com/Cujuju/Terrace/issues/503).

Implementation plan requested and written:
`E:\Development\Projects\Terrace\docs\plans\terrain-band-smoothing.md`.
It specifies shared/CPU/GPU integration, a live comparison setting, stale-build
protection, validation, and a separate experiment for residual contour noise.
Its implementation choices are proposals; this entry does not record visual
approval of the protected candidate or authorize a default change.

Follow-up inspection: the stamp-only band-1 full-filter and locally protected
results have identical reported area, turning, and vertex counts. Dense
extraction retains substantial turning there. Thus protection is not needed
to explain that example's remaining noise, and extra subdivisions alone are
insufficient. In stamp-then-smooth, protection adds further turning. The
piecewise bilinear field also permits contour-tangent changes at cell edges.
Distance-based contour smoothing under a displacement bound is an unbuilt
candidate for removing residual wiggles; it is not an approved replacement
for the shared field/query contract.

## Executable prototype

The input is the archived synthetic production-sculpt reproduction, plus
canonical small-feature controls. It is not the unidentified original world
patch. The filter is one separable binomial pass, `[1,2,1]² / 16`, on derived
samples. Store the integer numerator and scale the contour threshold with it.
Never feed a filtered value back into this pass or write it to the heightmap.

The default candidate applies the full filter except at protected samples:

1. Convert each original sample to its drawn band using the shared contract.
   Inspect the four 2×2 blocks containing that sample. If none has every corner
   at or above its band, or none has every corner at or below its band, mark
   it as thin. Restore the original samples throughout its 3×3 neighborhood.
   This preserves the four original contour squares touching the marked sample.
2. If a square's diagonal band ranges are disjoint, some band has ambiguous
   diagonal connectivity there. Restore all four original corner samples.
   This retains the current saddle decision; it does not fix the independently
   observed saddle-decider defect.
3. Restore each layered-column sample and its 3×3 neighborhood. All squares
   touching that column therefore retain their original input field. The
   layered control is a horizontal slice, not an underside closure proof.

Marks are computed from original inputs before any output is generated. The
dependency radius is two raw samples: a sample can be restored because of a
neighbor whose classification reads one additional neighbor. This means a
21×21 complete input window for a 16×16-square chunk. It does not settle the
production upload format or the policy for missing chunks.

Two additional variants remain available for owner comparison:

- **Local protection + band clamp:** outside protected regions, constrain the
  numerator to the original drawn band's half-open interval. Upper bound is
  the next band's raw floor multiplied by 16, minus one numerator unit.
- **Band clamp only:** the same constraint without restoring vulnerable
  neighborhoods. This preserves sample membership but can reduce a terrace
  to a nearly invisible point; it does not meet useful feature preservation.

The default local candidate permits band-membership changes outside its
protected neighborhoods. It is not a general topology-preserving filter.
Shapes beyond the specified local guards, including broader plateaus and
necks, may change size or connectivity. Those limitations remain explicit
until a broader production contract is selected.

## Review evidence

The viewer compares original, full filter, and the selected protection variant
with identical cameras, materials, lights, and crease settings. All variants
use the same contour resolution selected in the viewer: production's four
subdivisions or the 32-subdivision dense reference. Caps and risers in this
diagnostic renderer share the extracted boundary. This is not a production
GPU capture or a production triangulation/capacity measurement.

At production contour resolution, the local candidate exactly retains the
original contour vertices of the one-cell terrace, hole, ridge, channel, and
diagonal control. Full filtering removes the isolated terrace, fills the
hole/channel, and nearly collapses the ridge.

Selected band-12 absolute turning, radians (diagnostic only):

| Variant | Stamp | Stamp then smooth |
|---|---:|---:|
| Original | 24.15 | 19.17 |
| Full filter | 11.42 | 7.43 |
| Local protection | 11.42 | 10.88 |
| Local protection + band clamp | 11.72 | 19.53 |
| Band clamp only | 11.72 | 19.09 |

These numbers show the tradeoff to inspect, not which appearance to accept.
In particular, local protection restores some corners in the smoothed-stamp
example; the stricter clamp removes much more of the full filter's effect.

Recorded verification: both contour resolutions retain the five small-control
outlines exactly; the layered slice retains its original hole outline. All
nine inputs remain unchanged. Rebuilding produces byte-identical compressed
geometry and measurement output. Four complete interior chunk windows per
fixture agree with the whole-field result at all 10,404 compared sample
positions, including their guard masks. This covers complete input windows,
not streaming or missing-neighbor behavior. Browser inspection exercised the
fixture, protection, resolution, camera, zoom, and crease controls, with no
console errors or warnings after the theme-color conversion fix.

Reproduction and evidence files, all beneath
`E:\Development\Projects\Terrace\scratch-band-investigation\`:

- `protected-field.mjs`: the experimental field and protection rules.
- `build-protected-data.mjs`: archived inputs, extra controls, production/dense
  contour extraction, area/turning/feature and complete-window measurements.
- `protected-measurements.json`: source/input hashes, metrics, input immutability,
  protected-sample equality, and complete-window agreement observations.
- `protected-data.json.gz`: all five variants, both resolutions, nine fixtures.
- `build-protected-comparison.mjs`: uses the existing comparison template to
  reproduce the interactive comparison in this task's visualization directory.

Run the data builder with Node 24, then the comparison builder. The original
investigation files remain available for the earlier alternatives.

## Production work still unverified

Owner approval of the protected appearance is pending. Actual CPU/GPU parity,
packing and integer bounds for the complete implementation, missing-neighbor
fallback, streamed-chunk invalidation, query/picking agreement, inter-band and
underside closure, allocation limits, and representative edit/frame cost are
not demonstrated by this prototype. Its repeated-build and complete-window
measurements are narrower evidence, not substitutes for those checks.

No new regression tests were written and the Terrace app was not started or
stopped. Those actions remain subject to the repository's permission rules.


## Production implementation and live verification

The owner authorized implementation with minimal contract-level tests and a
controlled app instance. **Smooth terrain bands** is a persistent, default-off
client preference. Its integer field definition lives in shared code; no server,
wire format, stored heights, or sculpt behavior changes. It uses the existing
budgeted terrain rebuild when switched, preserving the camera and world mirror.
A large revealed area rebuilds over several seconds.

The protected kernel exactly matches the reviewed prototype at 81,920 sample
positions. Executed WebGPU/CPU comparisons pass the existing geometry tolerance
for 80 chunks across the five golden fixtures in both modes. A world-edge clamp
mismatch was found and corrected during this check. Top fields are reused across
GPU levels; a bounded revision-invalidated client cache removes repeated query
work without changing the filter.

Filtered picking now intersects canonical published contour walls and shared
field treads before assigning a legal original column owner. Canonical pick
segments are independent of the optional decorative Smooth lines setting and
available at reveal edges. Layered underside rules remain guarded; blocky mesh
fallbacks report their actual top-box representation. Stale generations/revisions
cannot publish charts or notify grounded objects, and dirty chunks remain
unavailable until their replacement geometry is written.

The new regression coverage is limited to five contract cases: shared arithmetic
and feature protection (three), worker/streaming/cache agreement (one), and stale
answer/publication lifecycle (one). Existing suites and the actual GPU probe are
reused. The implementation record in the plan carries current counts, observed
cost, and unrelated workspace-test failures. Actual production appearance still
needs the owner's acceptance; broad topology preservation and post-contour
high-frequency fairing are not claimed.

## Owner interaction review and measured overhead

The owner reports Stamp, Hard, width 2.0 failing to close small holes with band
smoothing enabled, and working with it disabled. Implementation acceptance and
commit are held. The CPU comparison URL's permanent mode override was separately
corrected so the live toggle works there; rebuilding now has visible feedback.

Isolated measurements show that the protected sampling path is 8–9 times the
basic binomial averaging cost. CPU stamp rebuilds range from a small increase on
noise to 1.4 → 9.1 ms on terraces and 8.6 → 46.5 ms on a played stress fixture.
These are stage timings, not FPS measurements. Protection often restores raw
samples and can suppress smoothing heavily, but the exact cause of the reported
brush behavior remains unverified. The full method, limits and numbers are in
`E:\Development\Projects\Terrace\docs\investigations\terrain-filter-overhead.md`.
