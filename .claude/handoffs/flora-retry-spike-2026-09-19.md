# Flora retry spike: full grass rebuilds every 0.5s at idle

Date: 2026-09-19. Status: diagnosed, not implemented. Handoff for another agent.
Related: plugin frame-budget (#1, on `main`) + perf HUD (`max` column,
`async/ms`, per-plugin table) that exposed this.

> The proposed fix below is a starting sketch, not a decision — discuss the
> approach with the owner before implementing.

## Problem

At idle, one frame in ~every stats window takes 35–45ms (HUD `max`), dragging
120fps+ sessions down to ~117. Plugins-off bisect kills the tail
(`max` 45.4 → 4.9). Per-plugin `max` column names flora: single runs over
35ms; everything else peaks ≤2.2. Flora's *mean* impact (0.64ms/frame, 19%
share) is built almost entirely from these spikes.

## Root cause

`plugins/flora/client/index.ts`: the `onFrame` handler retries pending ground
every `FLORA_GROUND_RETRY_SECONDS` (0.5s). When `pendingGrassGround` is
non-empty it calls `rebuildGrass`, which scans **all** grass cells
(`grassPlacementsFor(grass.values(), …)`) and rewrites the **entire** GPU
buffer (`grassModels.apply`), then re-queues whatever still failed.

A cell pends when `drawnGroundYAt` returns null (chunk not drawn yet). Cells
whose ground *never* resolves (unmeshed chunks, world edge) keep the set
non-empty forever → full recompute + full buffer re-upload every 0.5s, idle
or not. CPU profile corroborates: `rebuildGrass` ~0.9s/12s wall, plus the
steady `writeBuffer` upload traffic of full rewrites.

The frame budget (#1) cannot prevent this: it skips *after* an overrun, never
preempts a synchronous 35ms call.

## Proposed fix (grass first, template for the rest)

Retry pending-only through the existing incremental path:

- `grass` is a `Map<number, GrassCell>` keyed by `grassKey`, and
  `pendingGrassGround` holds those keys — resolve pending keys to cells,
  run `grassPlacementsFor` on that subset, and fold placements in with the
  existing `grassModels.applyDelta(result.placements, [])` (same call shape
  as `applyGrassDelta`, minus withers).
- Give up: drop keys that fail N consecutive sweeps (suggest N=10, ~5s);
  they re-seed on the next full `replaceGrass` server push, which keeps its
  full rebuild. A bounded number of cheap subset retries replaces the
  unbounded full-rebuild loop.
- Keep the 0.5s gate; with subset-only work each retry is proportional to
  the pending set (usually near-empty), not to total grass.

Same disease in the same file — apply the template after grass lands:
`rebuild` (trees), `rebuildCrops`, `rebuildFringe`, `rebuildStumps` all retry
full scans + full `apply` on their pending sets. Check each model's
`applyDelta`-equivalent exists before converting (grass has one; verify the
rest rather than assuming).

## Constraints

- No new tests (repo rule, per-session; run the existing host-adjacent
  tests + client typecheck).
- Client display code only — determinism/sim rules (`shared/`, server) are
  untouched, but keep it that way: placement math stays identical, only
  *when/how much* recomputes changes.
- Do not change the `max`/HUD instrumentation to hide this; the fix must
  move the numbers, not the ruler.
- Commit promptly on `main`; stage exact paths only (shared checkout).

## Acceptance

- Idle session: flora `max` column drops to wildlife levels (~2ms); frame
  `max`/`p99` tail collapses toward the plugins-off numbers
  (`max` ~5ms, `p99` ~4ms); flora mean share drops out of the top rows.
- No visual regression: grass still appears when its chunk draws (pending
  cells resolve through the subset path, not just full pushes); withered
  grass still clears.
- `writeBuffer` per-frame bytes drop (no more full rewrites on retry).
