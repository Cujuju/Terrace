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
