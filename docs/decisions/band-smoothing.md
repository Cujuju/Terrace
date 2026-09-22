# Band smoothing

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
