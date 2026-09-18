# Terrain relief

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## The world re-terraced, and the Populous slump retired (2026-08-20)

Two owner decisions, taken together because the second falls out of the first.

**`BAND_HEIGHT` 64 → 16.** The world was too blocky: a band was drawn one full
cell tall, so every riser was a cube-sized step and the land read as stacked
blocks rather than as terraces. The client now draws a band at a QUARTER of a
cell and there are four times as many of them in the same height range, so the
world keeps exactly its relief while every step in it is four times finer.
`MAX_STEP` moved with it, from `BAND_HEIGHT/2` to `BAND_HEIGHT` — one cell of
run per band, the finest tread that still reads as a terrace. Hills therefore
spread twice as wide as they used to; a full-height mountain's foot moves from
32 cells out to 64.

**No more outward flow.** Because a click and the gradient limit are now the
same number, one click on flat ground satisfies the invariant at its own edge
and nothing spills. That is the Godus look the owner asked for, and it retires
the Populous signature recorded at the top of this document.

**The contract this bought, and why it is the real deliverable.** A band is a
RENDER quantum. Re-terracing the world must not move anything the world is
made OF. Every constant that meant a physical fact but was written as a band
count had to be restated in HEIGHT UNITS with its band count derived — the
strata stack, deep water, the snow line, genesis's coastal staircase and
trench, the noise field's amplitude, the client's own vertical scale. They
interlock, so getting one wrong was not cosmetic: left as "3 bands", a fresh
world's abyss would have been 48 units deep against a 192-unit deep-water line,
and no fresh world would have had deep water anywhere — or any sea monsters.

The same rule settled two rendering questions. The terrain palette became a
ramp GENERATED from height anchors instead of one hex literal per band (it
indexed off its end otherwise), and the owner chose to interpolate between the
anchors, so each of the four bands now standing where one stood gets its own
shade. And the chunk geometry guard had to change kind, not just size: a deep
dig crosses 94 band levels where it crossed 22, which pushed legitimate
triangulation work up into the adversarial population's range and closed a 2.2×
separation to 1.2%. Discrimination moved to the largest single merged polygon —
the quantity ear-clipping is actually quadratic in, and the one metric here that
does not move when the world is re-terraced.

**Costs, measured and accepted.** A fully explored 512² world goes from 1.69 M
triangles to 4.09 M and terrain vertex buffers from 279 MB to 673 MB. Reaching a
given height takes four times the clicks (digging to the world floor is ~96 held
clicks, about 12 s on the hold-repeat ramp, against ~24 before). The per-chunk
triangle ceiling quadrupled to 14.5 MB at the current 111 bytes per triangle,
which promotes vertex-format compression from an optimisation to load-bearing
work.

## The shore isoline is degenerate because band 0 sits on its own threshold (2026-09-18)

Investigated for #487. The band geometry is **unchanged**; a separate mask bug found
alongside it was fixed in `2cab9ea5` (below).

**Symptom.** The sea's wet/dry edge renders as a cell-aligned staircase while
every other band in the same frame is a smooth contour.

**Not the water.** The per-pixel shore mask (e6131752) is faithful: hiding the
sea plane leaves the land cap's band-0 boundary pixel-identical, and over a
continuous field the same shader draws a true curve.
`client/test/shoreField.test.ts` pins the registration.

**Cause.** The shore threshold is raw height 1, which is also
`bandLevelHeight(0)`, `bandFloorHeight(0)`, and one unit off `SEA_LEVEL`. At a
coast the threshold therefore coincides with a sample instead of falling between
two, and marching squares puts every shore vertex on the cell lattice.
`drawnCrossingFraction` at `drawnLevelThreshold(0)`:

| coast edge | wet → dry | crossing |
| --- | --- | --- |
| sculpted shelf → shore | −16 → 1 | 0.9990 |
| genesis sea → land | 0 → 16 | 0.0625 |
| sea → shore | 0 → 1 | 0.9990 |
| shelf → land | −16 → 16 | 0.5313 |

Only the last is healthy. Every other band gets ~0.5 because its threshold
`16k` is the midpoint of levels `16(k−1)` and `16k`. Band 0 cannot: it spans 7
height units against band −1's 25, so centring the threshold would need level 18,
outside the band.

**Why raw 1.** `h = SEA_LEVEL` must never draw dry. With integer heights, 1 is
the lowest threshold that holds that, and `DRAWN_SHORE_HEIGHT` is it.

**The regular scheme, if it is ever taken.** Band `k` = `[16k+1, 16k+17)`,
`bandLevelHeight(k) = 16k+9`, `drawnLevelThreshold(k) = 16k+9`. Every band 16
tall, every level its band's midpoint, the shore threshold mid-gap like the
rest. All four band-0 special cases (`bands.ts` ×4, `drawnGround.ts:182`,
`mesherWgsl.ts:137`) disappear. Adjacent levels stay 16 apart, so `MAX_STEP`,
traversal, ramps and mana costs are untouched; `level(−1) = −7` and
`level(0) = 9` keep the `h <= SEA_LEVEL` wetness tests (`heightmap.ts:95`,
`traversal.ts:28`, `rivers.ts:362`, cyclone, hydro, genesis) on the same side.

**What it costs.**
- Band membership moves for raw heights in `[16k+1, 16k+9)`: those drop one
  band, so existing worlds re-terrace unless migrated by snapping each cell to
  its old band's new level. That migration is lossy — sub-band relief left by
  erosion is discarded.
- Coastal contour vertices roughly quadruple. Measured on a 128² synthetic
  coast, 33 loops, after `simplifyLoop`: sculpted coast 293 → 1091, which is
  exactly an ordinary band's cost (band 2 = 1091). Today's shore is cheap only
  because a 0.999 crossing lands vertices on lattice corners and long collinear
  runs simplify away. Genesis coastline already pays 991 for a blocky look.
- Scope: 173 of 1024 chunks (16.9%) are coastal in Frostwick Hollows; only their
  band-0 level pays.

**Rejected:** lifting `bandLevelHeight(0)` alone — band 0's best level, 8,
reaches 0.708 against a −16 shelf but 0.125 against a sea-level cell, worse than
today, and does nothing for generated coastline. Moving `bandLevelHeight(−1)`
to −2 as well centres the shore but skews band −1's own contour to 0.267.
Forcing the band-0 `crossingOverride` to 0.5 — the sea mask reads the raw
bilinear field, not `drawnCrossingFraction`, so land and water would part by
half a cell.

## The shore mask asked about the water plane, not the land under it (2026-09-18)

Owner: "I can see the water jetting into the land." Fixed in `2cab9ea5`.

The sea is a flat plane at `SEA_LEVEL + WATER_SURFACE_LIFT`; band 0's cap is at
exactly `SEA_LEVEL`. `shoreCoverage` sampled the shore field at `positionWorld.xz`
— the plane's own xz — so a grazing ray, which meets the plane before the land
beneath it, tested a point up to several cells seaward of the land it covered.
The wet side then flooded the flat shore, bounded by the locus where the two
points straddle the shoreline: a constant-height line, and so dead straight
across the frame. Invisible from overhead, which is why top-down A/B comparisons
of the mask against the land cap kept agreeing.

**Fix.** Project the fragment onto band 0's cap plane along the view ray before
sampling: `P.xz + (P.xz - eye.xz) * lift / (eye.y - planeY)`, with the divisor
floored at the lift so an eye at or below the surface cannot flip the sign.

**Measured** at a grazing camera over the Frostwick Hollows shore (cell 223,359),
watered pixels landing on dry band-0 cap: 2.17% → 0.36%, and 0.14% close in. The
residual is the one-pixel shore fade, scattered — at most 7 of 159 sampled columns
in any row, against a solid 35-row band before.

**Not** the isoline degeneracy above: that governs the shoreline's *shape*, this
governed *where the mask was asked*. `SEA_SURFACE_WORLD_Y` was left alone — boats,
skiffs, monsters, wildlife, saucers, cyclone and rivers all float on it.

## The drawn-band contract, moved out of the source (2026-09-18)

Lifted verbatim from `shared/src/bands.ts`, which the comment budget sends here.

The renderer draws a height sample `h` as band `drawnBandOfSample(h)`, which reads
the biased field `h + DRAWN_GROUND_BAND_BIAS`. Sculpt targets and coverage
predicates must agree with that field, or a press can move raw heights without
changing what is drawn (e.g. raising 8 to 16 used to stay inside drawn band 1).

**Determinism.** Every function in `bands.ts` is integer-only — `Math.floor` (an
exactly-specified IEEE-754 operation whose result is immediately used as an
integer), integer +/-1 steps, and comparisons — evaluated in a fixed order with no
iteration. Identical inputs give identical outputs on server and client.

## Band 0's contour marches a two-valued field (2026-09-18)

Owner: "I literally just want the water to match the outline of the shore on band
zero." Fixed in the commit that follows this entry.

The shore threshold is raw 1, which is also `bandLevelHeight(0)`, so

    exact = (threshold − BIAS − outside) / (inside − outside) = (1 − outside) / (1 − outside) = 1.0

for **every** shore edge whatever the depth on the wet side — −8, −24 and −67 all
give 1.0. The shoreline collapsed onto the cell lattice: a straight run with
hairline spikes where an isolated dry cell poked out, and one-cell puddles fell
below `DRAWN_GROUND_SIMPLIFY_EPSILON` and vanished.

**Fix.** Band 0 marches `SHORE_CONTOUR_OUTSIDE = 0` / `SHORE_CONTOUR_INSIDE = 2`
instead of raw heights. The existing threshold 9 and bias 8 then give
`(9 − 8 − 0) / 2` = exactly a half, while membership `+8 >= 9` still means `h >= 1`
— so what counts as land, every stored height and the whole sculpt pipeline are
untouched. `capEmission`, `mesherWgsl` and the sea's mask texture all read that one
field, so land and water are a single curve by construction rather than by test.

**A latent bug it surfaced.** `writeBlockyFallback` reads the shared `samples`
array, which a per-band `loadLevel` had already been leaving derived for layered
chunks; an over-budget chunk therefore drew its cells at the wrong heights. It only
became reachable in tests once band 0 loaded a field of its own. Fixed by reloading
raw samples before the fallback.

**Cost.** Every one-cell puddle is now a real hole in band 0's cap rather than
collapsing away, and ear-clipping is quadratic in merged vertices against
`MAX_MERGED_POLYGON_VERTICES = 512`. A 1-in-5 scatter of wet cells (the
`vertexGrid` honesty fixture) reaches ~918 merged vertices and drops the chunk to
blocky. Frostwick Hollows has **no** blocky chunk at all, so real coastlines sit far
inside the budget, but noisier terrain is the thing to watch.

**Verified** at cell 223,359: the water edge spans 55 distinct screen rows across
233 columns where it was one row at every column, and tracks the rendered land edge
to within a pixel. shared 533 passed, client 789 passed.

## The shore keeps the sea's depth, not a flag (2026-09-18)

Owner, on the first cut: "Why does the shoreline look rounded now?"

The first attempt gave band 0 a two-valued field. That removes the degeneracy but
also removes every scrap of sub-cell information, so thresholding it at the midpoint
yields the smooth blob isosurface: every corner rounded by half a cell, uniformly,
and a coastline of inflated lobes.

**Fix.** Only the dry side is flattened. `shoreContourSample` maps dry land to
`SHORE_CONTOUR_DRY_HEIGHT` — as far above the shore threshold as the canonical shelf
lies below it, so `bandLevelHeight(-1)` gives a crossing of exactly a half — and
leaves wet cells at their real depth. The crossing then tracks the seabed:

| wet neighbour | 0 | −8 | −16 | −24 | −40 | −67 | −160 | −457 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crossing | 0.056 | 0.346 | 0.500 | 0.595 | 0.707 | 0.800 | 0.904 | 0.964 |

A sheer drop puts the waterline hard against the cell edge, which is what a cliff
looks like; a shelving bottom carries it out into the cell. The shape comes from the
terrain rather than from rounding.
