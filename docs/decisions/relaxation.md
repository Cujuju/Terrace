# Relaxation

Facts about the gradient relaxation that `smooth` and the library `settle` run.

## The pass

- Relaxation is closed over the map: its only operation moves height between two neighbouring cells. Every move is an exact even split, `drop = rise = e >> 1`, so a sweep is sum-preserving on every path, including the band clamps.
- A pair is relaxed only when it differs by more than `MAX_STEP + RELAX_SLACK` (4 + 1). An even split of an excess of 1 moves nobody, so the slack keeps every counted move a real move and the sweep terminating.
- **The steepest legal slope is therefore `MAX_STEP + 1` = 5 per cell.** A pair one unit over `MAX_STEP` is at rest. Every reader of the gradient invariant allows it: `expectGradientLimitHolds`, mudslides' `MUDSLIDE_MAX_DROP_OVER_SPAN` (`(MAX_STEP + RELAX_SLACK) × span`). The walker rule stays at `MAX_STEP / 2`, tie broken downward.
- `SMOOTH_PASS_LIMIT` = 2560 passes. A sweep that hits it leaves the gradient invariant locally violated, deterministically on both replicas, and `smooth` returns its pass count so a caller can tell. Walls of 593 units and up do not converge inside the cap; the worst player-constructible stroke converges in about 118 passes. The next stroke over that ground resumes the cascade.
- Saved worlds are never migrated. Over-steep legacy terrain re-grades one stroke at a time as relaxation reaches it.

## Player smooth

- Only moves height; never invents or destroys it. There is no manufacturing branch. Pinned by the whole-map sum and a random-press flux test.
- Anchored: a footprint cell already past the stroke's target is frozen; the rest may move to the target in the stroke's direction. A step taller than one drawn band therefore does not melt from either side. A bound that bites leaves the pair over-steep for the next stroke.
- Bounded: the cascade may write at most `radius + SMOOTH_REACH_MARGIN_CELLS` (margin 2) beyond the footprint, so a stroke's write extent from the click is `2·radius + 2`. Margin 2 is the smallest that reproduces the unbounded result byte-for-byte on a one-band stamp edge at every radius. Pairs straddling the reach edge are left as they are.
- `sculptReachCells` in `shared/src/sculpt/reach.ts` is the one statement of how far a stroke can write; the server's fault resync and the client's prediction guard read it.

## Library settle (plugins)

- `settle` deposits, then relaxes with the unbounded sweep. Cones, craters, surges and slides depend on it.
- Plugin constants derived against the closed pass: volcanoes `CONE_GROWTH_BANDS_PER_ERUPTION` = `CONE_PEAK_BANDS_PER_ERUPTION × CONE_BRUSH_BANDS_PER_PEAK_BAND` (one band of peak per eruption); mudslides `MUDSLIDE_MAX_DROP_OVER_SPAN` = `(MAX_STEP + RELAX_SLACK) × MUDSLIDE_SLOPE_SPAN_CELLS`. `GENESIS_CONE_BANDS` and `VENT_SUMMIT_WORLD_UNITS` are nominal: exact on flat ground, less on genesis terraces.
