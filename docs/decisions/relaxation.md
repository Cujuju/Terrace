# Relaxation

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-29 (relaxation conserves height; the steepest legal slope is MAX_STEP + 1, #108)

**The defect.** Gradient relaxation is CLOSED over the map: the only thing it is
allowed to do is move height between two neighbouring cells. It was not closed.
`movePair` took the excess `e` a pair had over `MAX_STEP` and gave the high cell
`e >> 1` while giving the low cell `e - (e >> 1)` — one unit more than the high
cell lost, on every odd excess, taken from nobody. One bare smooth of a 401-unit
cliff on a 128² map invented 1,666,592 height units, 50.7% of the map's own
total, and a player roaming with the smooth brush was a height pump. Issue #239
(a mudslide's head scour measuring a net GAIN and abandoning the slide) was this
defect seen from a plugin.

**The fix, and its price.** The split is exact: `drop = rise = e >> 1`. That
makes a pass sum-preserving by construction on every path through the function,
including the coupled band clamp. An even split of an excess of 1 moves nobody,
so the trigger had to move with it — a pair is relaxed only when it exceeds
`MAX_STEP + RELAX_SLACK`, with `RELAX_SLACK = 1`, which keeps `e >= 2` for every
pair the sweep touches and so keeps "every counted move is progress", the
sweep's termination argument.

**THE STEEPEST LEGAL SLOPE IS THEREFORE `MAX_STEP + 1` (= 5), NOT `MAX_STEP`.**
A pair sitting one unit over the gradient limit is AT REST. Every reader of the
gradient invariant must allow it: `shared/test/heightmap.test.ts`'s
`expectGradientLimitHolds`, mudslides' `MUDSLIDE_MAX_DROP_OVER_SPAN` (now
`(MAX_STEP + RELAX_SLACK) × span`), and any future consumer that wants to know
what the terrain can hold. The walker rule
(`LAND_WALKER_MAX_GRADIENT_PER_CELL`) deliberately stays at `MAX_STEP / 2`:
half of 5 is not a height, and the tie is broken downward so the walker refuses
slightly more than half the legally-possible slopes rather than fewer.

**Saved worlds re-grade on their next smooth stroke.** Nothing migrates a
persisted heightmap. A world saved under the old rule may hold pairs at
gradients the new rule would not have produced; those are simply terrain the
next relaxation that reaches them will pull in, one stroke at a time, and until
then they render and walk exactly as they did. This is the same incremental
repair the pass-cap residual below relies on, and it is why no version bump or
save migration is part of this decision.

**`SMOOTH_PASS_LIMIT` stays 2560 — owner decision, with the residual named.**
Conservation costs passes on sheer ground: the fill on the low side of a cliff
is no longer invented, so every unit of the ramp is walked down off the plateau.
Measured by bisection on a bare cliff over 128² (`.sim-108/passes.mjs`'s
truncation-threshold section, output in `.sim-108/passes.txt`), walls of 593
height units and up no longer converge inside the cap; a 592-unit cliff
finishes in 2,524 passes, a 593-unit one truncates at 2,560, and a 1000-unit one
wants ~7,205. A truncated sweep leaves the gradient invariant locally violated —
worst local gradient 6 at the threshold, 7 at 1000 units, against the 5 it
guarantees elsewhere — deterministically on both sides, visibly (`smooth`
returns its pass count, and a count equal to the cap means exactly this), and
repairably: the next smooth stroke over that ground resumes the cascade.

Such a wall is not player-constructible. A 593-unit sheer face is ~37 stamped
bands with no tread between them: legacy or synthetic terrain. The worst strokes
a player CAN make converge in 108–118 passes, 4% of the cap. Raising the cap
would raise the worst-case CPU of every intent on every world to buy convergence
on those; the price of leaving it is that a legacy over-steep world re-grades
over several strokes instead of one, plus wall-clock on such worlds — a relic
cast landing on genesis-steep ground was measured at 888 ms before and 1,271 ms
after (issue #108's review).

**The plugin constants named in the review were re-derived against the new
rule, not assumed** — not every constant in every plugin, which is a claim
nobody has earned. Each of these was re-measured old-vs-new on a 512² genesis
world (`.sim-108/plugins.mjs`), driven through the same
`applySculpt(..., {smooth, soft, banded})` that `WorldApi.sculpt` is:

- **volcanoes `CONE_GROWTH_BANDS_PER_ERUPTION` 1 → 2**, and rewritten as the
  derivation it is: `CONE_PEAK_BANDS_PER_ERUPTION ×
  CONE_BRUSH_BANDS_PER_PEAK_BAND`. The intent — one band of PEAK per eruption —
  is unchanged; what changed is that a cone's flanks are at the gradient limit,
  so half of what the brush puts on the apex now really leaves it. Mean peak
  gain per eruption: 16.0 old, 9.0 at one band, 15.1 at two.
- **mudslides `MUDSLIDE_MAX_DROP_OVER_SPAN` 32 → 40**, written as
  `(MAX_STEP + RELAX_SLACK) × MUDSLIDE_SLOPE_SPAN_CELLS` — the constant claims
  to be "the steepest the sim permits", and that is now 5 per cell.
- **volcanoes `FLOW_THICKNESS`, storms `SURGE_BRUSH_RADIUS_CELLS`, mudslides
  `MUDSLIDE_TRACK_DEPOSIT_FRACTION` / `MUDSLIDE_TOE_DUMP_STEPS` /
  `MUDSLIDE_MASS_TOLERANCE_HEIGHT_UNITS` / `MUDSLIDE_MEASURE_MARGIN_CELLS`:
  re-measured, deliberately NOT retuned**, each with the numbers recorded in its
  own doc comment. The headline: a single flow cell still settles at exactly 8
  units under both rules (only the pooled crust changed, and by shedding
  manufactured height); one surge removes 1.09× what it used to on a genesis
  shoreline and still drops the shore less than one band; and a slide now
  deposits 1,828 units against 1,848 excavated (1.1% residual) where the old
  rule "cleared" its ledger by depositing 1,811 units it had measured as 675.
  The mudslide measurement window did not need widening either — the widest
  single sculpt diff FELL from 502 cells to 229, because the manufacturing rule
  had been feeding its own cascade.
- **volcanoes `GENESIS_CONE_BANDS`: measured, accepted, not retuned.** One
  `raiseCone` of 4 bands delivers a peak gain of exactly 64 units (4.00 bands)
  on FLAT ground under both rules — the documented ten-band summit is exact
  there — and on genesis ground 54 units (3.38 bands) old against 44 (2.75)
  new, because a fresh world's over-steep terraces take the difference. The
  ten-band summit was therefore already nominal before this fix; the split
  moved it by 0.63 of a band, and its only consumers are cosmetic (the client's
  plume and the settings preview). Retuning to 6 or 8 bands would overshoot to
  11.4 or 12.4 bands on flat ground and make genesis dearer. Recorded on the
  constant, and on `VENT_SUMMIT_WORLD_UNITS`, which is now labelled nominal.

## Decisions made 2026-09-15 (the player smooth is closed again, and its cascade is bounded by the brush)

**Smooth only moves height; it never invents it (owner).** The intent of the
tool is to soften the edges stamping leaves, not to add or remove land. The
anchored melt introduced on 2026-09-14 (`948e5e4c`, generalised in `648826f9`,
budgeted in `b0c8a0f4`) let one side of a bounded pair move alone, which made
a press manufacture height; it is removed (`bc4b930e`). Every move is an
exact even exchange again, so the CLOSED property above holds for the player
tool as well as the library `settle`. The anchor freeze from `fae5150a` stays:
a footprint cell already past the stroke's target does not move, so a step
taller than one drawn band does not melt from either side. Pinned by the
whole-map sum in `heightmap-relax` and the 600-press flux test in
`heightmap-layers`.

**The player smooth's cascade stops at a reach derived from the brush.** The
sweep used to grow one cell per pass with no spatial bound, so one press on
over-steep genesis ground rewrote a quarter of a 512² world. The `smooth`
tool now passes a reach to the sweep: the brush radius plus a named margin
beyond the footprint, the smallest that converges a one-band stamp edge on
flat ground at every radius (measured: 2 at r=1 … 18 at r=16, i.e. r+2).
Pairs straddling the reach edge are left as they are — the same accepted
residual as the pass cap, repaired by the next stroke that reaches them.
`sculptReachCells` in `shared/src/sculpt/reach.ts` is the one statement of
how far a stroke can write; the server's fault resync reads it. The library
`settle` (plugin cones, craters, slides) keeps the unbounded sweep, so the
constants re-derived above are untouched.
