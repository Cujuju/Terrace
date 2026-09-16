# Relaxation

Facts about the gradient relaxation that free `smooth` and the library
`settle` run, and the Laplacian melt that player `smooth` runs.

Owner decision 2026-09-16: the player brush smooths with Laplacian (it keeps
the sculpt, softens edges) instead of relaxing to the gradient limit (which
flattened mounds and stranded the clicked cell as a spire).

## The pass (exact exchange: free smooth, settle)

- Relaxation is closed over the map: its only operation moves height between two neighbouring cells. Every move is an exact even split, `drop = rise = e >> 1`, so a sweep is sum-preserving on every path, including the band clamps.
- A pair is relaxed only when it differs by more than `MAX_STEP + RELAX_SLACK` (4 + 1). An even split of an excess of 1 moves nobody, so the slack keeps every counted move a real move and the sweep terminating.
- **The steepest legal slope is therefore `MAX_STEP + 1` = 5 per cell.** A pair one unit over `MAX_STEP` is at rest. Every reader of the gradient invariant allows it: `expectGradientLimitHolds`, mudslides' `MUDSLIDE_MAX_DROP_OVER_SPAN` (`(MAX_STEP + RELAX_SLACK) × span`). The walker rule stays at `MAX_STEP / 2`, tie broken downward.
- `SMOOTH_PASS_LIMIT` = 2560 passes. A sweep that hits it leaves the gradient invariant locally violated, deterministically on both replicas, and `smooth` returns its pass count so a caller can tell. Walls of 593 units and up do not converge inside the cap; the worst player-constructible stroke converges in about 118 passes. The next stroke over that ground resumes the cascade.
- Saved worlds are never migrated. Over-steep legacy terrain re-grades one stroke at a time as relaxation reaches it.

## Player smooth (Laplacian, 2026-09-16)

- Three red-black passes per stroke move each footprint cell toward its
  four-neighbour average by the wire lambda (integer percent, default 50),
  minimum one unit, through the existing sweep machinery (layer views, spill
  clamps, reach limits). Free smooth and `settle` keep the exact-exchange
  pass below untouched.
- Direction names net effect: Lower removes (target one band above the click),
  Raise builds (target one band below it). The target side, freeze side, and
  window below all key off that reading, not the historical one.
- Anchored: a footprint cell already past the stroke's target is frozen; every
  other cell stays within about one band of its start per stroke while capped
  at the target in-stroke. No cell is pinned: without a deposit there is
  nothing for a stroke to undo, and the pin is what stranded spires. The pin
  stays for deposit-then-relax strokes only.
- Drift is bounded, not zero: every write stays inside its clamp window, at
  most two bands wide, so net drift per press stays under touched-cells x 2
  bands. Pinned by that bound in directed tests and a fuzz tolerance; the
  exact-sum guards still cover free smooth and `settle`.
- Bounded: writes stay inside the footprint plus the passes' halo, within the
  unchanged `radius + SMOOTH_REACH_MARGIN_CELLS` reach. The interior holds the
  gradient limit; brush-tip spill seams may keep up to one band until a
  re-aimed stroke re-grades them (measured 7 -> 2).
- `sculptReachCells` in `shared/src/sculpt/reach.ts` is the one statement of
  how far a stroke can write; the server's fault resync and the client's
  prediction guard read it.

## Free smooth and settle (exact exchange)

- Only moves height; never invents or destroys it. There is no manufacturing
  branch. Pinned by the whole-map sum and a random-press flux test.
- Anchored (settle with an anchor): a footprint cell already past the stroke's
  target is frozen; the rest may move to the target in the stroke's direction.
  A step taller than one drawn band therefore does not melt from either side.
  A bound that bites leaves the pair over-steep for the next stroke.

## Library settle (plugins)

- `settle` deposits, then relaxes with the unbounded sweep. Cones, craters, surges and slides depend on it.
- Plugin constants derived against the closed pass: volcanoes `CONE_GROWTH_BANDS_PER_ERUPTION` = `CONE_PEAK_BANDS_PER_ERUPTION × CONE_BRUSH_BANDS_PER_PEAK_BAND` (one band of peak per eruption); mudslides `MUDSLIDE_MAX_DROP_OVER_SPAN` = `(MAX_STEP + RELAX_SLACK) × MUDSLIDE_SLOPE_SPAN_CELLS`. `GENESIS_CONE_BANDS` and `VENT_SUMMIT_WORLD_UNITS` are nominal: exact on flat ground, less on genesis terraces.
