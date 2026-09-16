# Smooth brush: `raise` vs `lower` (current behavior)

Settled against `shared/src/heightmap.ts` (`applySculpt`, anchored-smooth block),
`shared/src/sculpt/relax.ts` (`movePair` / `relaxPair`), `shared/src/sculpt/footprint.ts`
(`anchoredTargetHeight`), `shared/src/protocol/sculpt.ts` (`WIRE_DEFAULT_SCULPT_OPTIONS`),
`server/src/intent/pipeline.ts` (amount), `shared/src/sculpt/reach.ts` (cascade reach).
Design record: `docs/decisions/relaxation.md`, `docs/decisions/sculpt-tools.md`.

## What both directions share

- `smooth` never deposits. `relaxes = true`, `deposits = false`. All it does is move
  height between orthogonal neighbours, sum-preserving: `drop = rise = e >> 1`.
- A pair moves only when `|d| > MAX_STEP + RELAX_SLACK` (4 + 1 = 5 per cell). One unit
  over `MAX_STEP` is at rest.
- Player smooth is always anchored: wire default `anchor: 'clicked'`, amount
  `±DEFAULT_SCULPT_AMOUNT` (`±BAND_HEIGHT`, ±16), so `anchoredSmooth = true`.
  `anchorTarget = stepTowardBand(clickedHeight, raising)`: the canonical level of the
  drawn band one step above (raise) or below (lower) the clicked cell.
- Cascade is bounded: writes at most `radius + SMOOTH_REACH_MARGIN_CELLS` (radius + 2)
  past the footprint. Pairs straddling the reach edge are left over-steep.
- Player smooth is `spill: 'banded'`: halo cells outside the footprint are clamped to
  stay inside their starting drawn band. Inside the footprint, `anchorBounds` take
  precedence over the spill clamp.
- Frozen rule (both directions): a footprint cell already past the target in the
  stroke direction is frozen solid `{lo:h, hi:h}` for the stroke. A `>1`-band step
  therefore grinds at most one band per stroke from the frozen side; the next stroke
  re-derives a new target one band further.
- Center exception (both directions): the exact clicked cell (`clickedIndex`) gets a
  one-sided pin the other footprint cells do not get. This is the spire mechanism
  (see below). In `movePair`, a pin that bites stops the pair outright (`t <= 0`
  returns `false`).

## `raise` (`dir: +1`, `amount = +16`)

Target: one drawn band **above** the clicked cell.

| cell | bound when not frozen | frozen when |
| --- | --- | --- |
| clicked center | `{lo: h_center, hi: target}` — may rise ~1 band, **may never fall** | `h_center > target` (rare; target starts above click) |
| other footprint cell | `{lo: MIN_HEIGHT, hi: target}` — may fall arbitrarily far, may rise up to target | `h > target` |
| halo cell | drawn-band clamp | — |

Net window: cap rise at click+1, free fall (except center).

- Intended use: knock down a mound. Flank cells can shed height downhill without limit
  (up to the reach/band-clamp limit), so the mound drains outward.
- Failure: the peak center cell cannot shed anything. `dropCap = center - h_center = 0`,
  so every pair where the center is the high side is blocked. Surroundings flatten,
  center stays → single-cell spire at `clickedIndex`. Each repeat stroke re-pins `lo`
  to the (still high) center, so repeats never heal it; they make it relatively taller.
- On a deep pit: rim cells above target are frozen, so only ~1 band of fill happens per
  stroke (grind from the frozen side).

## `lower` (`dir: -1`, `amount = -16`)

Target: one drawn band **below** the clicked cell. Exact mirror of raise.

| cell | bound when not frozen | frozen when |
| --- | --- | --- |
| clicked center | `{lo: target, hi: h_center}` — may fall ~1 band, **may never rise** | `h_center < target` (rare; target starts below click) |
| other footprint cell | `{lo: target, hi: MAX_HEIGHT}` — may rise arbitrarily far, may fall to target | `h < target` |
| halo cell | drawn-band clamp | — |

Net window: floor fall at click-1, free rise (except center).

- Intended use: fill a pit/valley. Flank cells can gain height without limit, so the
  hollow fills inward.
- Failure (mirror): the pit center cell cannot gain anything. `riseCap = h_center - center = 0`,
  so every pair where the center is the low side is blocked → single-cell pit-hole at
  `clickedIndex` that repeats never heal.
- On a tall mound: flank cells below target are frozen, so only the top ~1 band shaves
  off per stroke (grind from the frozen side).

## One-line contrast

- `raise` = "rise at most one band above the click, fall freely — unless you are the
  clicked cell, which cannot fall." Melts highs, grinds lows, strands high centers.
- `lower` = "fall at most one band below the click, rise freely — unless you are the
  clicked cell, which cannot rise." Fills lows, grinds highs, strands low centers.

## Why the reported spire looks the way it does

Thick tall mound + `smooth` with default mode `raise`: target sits just above the peak,
so nothing is frozen, flanks have `{lo:MIN, hi:target}` and relax/drain into the
`radius + 2` halo, while the center has `{lo:h_center, ...}` and contributes nothing.
Result is a flattened apron with a one-cell needle at the brush center — exactly the
screenshot. `lower` on the same mound would instead shave one band and freeze the low
flanks, leaving a plateau rather than a needle.
