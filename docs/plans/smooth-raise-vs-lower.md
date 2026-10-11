# Smooth brush: `raise` vs `lower` (current behavior, Laplacian)

Settled against `shared/src/heightmap.ts` (`applySculpt`, anchored-smooth block),
`shared/src/sculpt/relax.ts` (red-black Laplacian passes), `shared/src/sculpt/footprint.ts`
(`anchoredTargetHeight`), `shared/src/protocol/sculpt.ts` (`smoothLambda`),
`server/src/intent/pipeline.ts` (amount), `shared/src/sculpt/reach.ts` (cascade reach).
Design record: `docs/decisions/relaxation.md`, `docs/decisions/sculpt-tools.md`.
Replaces the 2026-09-15 note that described pinned relaxation; that behavior
is gone (owner decision 2026-09-16).

## What both directions share

- `smooth` never deposits. Each stroke runs `SMOOTH_LAPLACIAN_PASSES` (3)
  red-black passes moving every footprint cell toward its four-neighbour
  average by the wire lambda (integer percent 1–100, default 50, Strength
  slider), minimum one unit of progress so quiet strokes certify liveable
  ground. Integer-only, fixed order: identical on server and client.
- Player smooth is always anchored: wire default `anchor: 'clicked'`, amount
  `±DEFAULT_SCULPT_AMOUNT` (`±BAND_HEIGHT`, ±16), so `anchoredSmooth` is set.
- Direction names net effect: Lower removes, Raise builds. The anchor target
  sits on the far side of the click from the historical reading.
- Every footprint cell stays within about one band of its start per stroke
  (symmetric clamp window, at most two bands wide), capped at the target
  in-stroke; cells past the target freeze. No cell is special-cased, so no
  single-cell artifact can strand. The click pin survives only when a deposit
  actually wrote (deposit-then-relax strokes).
- Net drift per press stays under touched-cells x 2 bands (proven by the
  window widths, pinned in tests and the fuzz tolerance). Free smooth and
  library `settle` still exchange exactly and conserve exactly.
- Cascade writes stay inside the footprint plus the passes' halo, within the
  unchanged `radius + SMOOTH_REACH_MARGIN_CELLS` reach. The interior holds the
  gradient limit; brush-tip spill seams may keep up to one band until a
  re-aimed stroke re-grades them.

## `raise` (`dir: +1`, `amount = +16`): builds

Target: one drawn band **below** the clicked cell.

| cell | bound when not frozen | frozen when |
| --- | --- | --- |
| any footprint cell | `[max(target, h−BAND), min(MAX, h+BAND)]` — may fall to target, rise at most one band | `h < target` |
| halo cell | drawn-band clamp | — |

Net window: floor falls at click−1, free-ish rise capped at one band above start.

- Intended use: lift a hollow. Pit cells rise toward the target; low ground below target stays frozen.
- On a tall mound it mostly grinds: the top shaves toward the deep target while high flanks past it freeze. Slow by design — bulk is preserved.

## `lower` (`dir: −1`, `amount = −16`): removes

Target: one drawn band **above** the clicked cell. Exact mirror of raise.

| cell | bound when not frozen | frozen when |
| --- | --- | --- |
| any footprint cell | `[max(MIN, h−BAND), min(target, h+BAND)]` — may rise to target, fall at most one band | `h > target` |
| halo cell | drawn-band clamp | — |

Net window: cap rises at click+1, free-ish fall capped at one band below start.

- Intended use: knock a mound down. Shoulder cells shed downhill without limit of direction (one band per stroke each); nothing is frozen on a peak, so the whole brush melts evenly.
- On a deep pit it mostly grinds: the floor fills a band per stroke while the rim past target stands.

## One-line contrast

- `raise` = "fall at most to one band below the click, rise at most one band above start." Fills lows, grinds highs.
- `lower` = "rise at most to one band above the click, fall at most one band below start." Melts highs, grinds lows.

## Why the reported spire is gone

The old code pinned the clicked cell against the stroke (`{lo: h}` on raise),
so a raise-melt drained every neighbour while the center could never fall —
one cell wide, permanent across repeats. The pin now applies only when a
deposit wrote first (pure smooth deposits nothing), and every footprint cell
shares the same symmetric window, so the center melts with its neighbours.
Step taller than one band still grinds (frozen side + one-band windows);
repeats accumulate instead of collapsing in one press.
