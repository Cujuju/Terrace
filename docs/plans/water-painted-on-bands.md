# Water painted onto the terrain's own bands

Status: PLAN — approved to implement 2026-08-23. Supersedes the apron (retired),
the per-segment riser (reverted), and the draped course ribbon (reverted).

## The defect, measured

Raycasting the drawn terrain under all 6745 water vertices of the `fork`
fixture, 2026-08-23:

| gap above the drawn ground | vertices |
| --- | --- |
| +1.125 … +1.25 bands | 430 |
| +0.25 … +0.375 bands | 5769 |
| +0.125 bands | 480 |
| −0.875 bands (buried) | 66 |

**Zero** vertices sat at the intended `RIVER_SURFACE_LIFT_WORLD_UNITS` (1/64
world unit) clearance. Owner, on seeing it in game: "the water is not rendering
on the surface of those bands, it is literally floating off in space", and "it's
also not acceptable if it draws like a bunch of squares".

## Root cause, one sentence

Water derived its own surface from the cell lattice while the terrain draws a
marched-and-smoothed contour surface, so two implementations of "where is the
ground" had to be kept in agreement and could not be.

## The contract change

Water is never modelled alongside the terrain. Every water vertex is placed
from the terrain's own contour output — `terrain/contours.ts`'s
`loadSampleField → marchLevel → assembleLoops → smoothLoop`, the pipeline
`terrain/capEmission.ts` already draws every cap and skirt from.

Two facts make this exact rather than approximate, both read from source this
session:

1. **`capEmission.ts:606-609`** — the terrain's cap for band `k` is at
   `k * BAND_WORLD_HEIGHT`, its skirt drops exactly one band to
   `(k-1) * BAND_WORLD_HEIGHT`, and a tall cliff is a STACK of one-band skirts,
   one per level, each hung off its own loop at threshold `k * BAND_HEIGHT`.
2. **`waterTread.ts:171-173`** — where the ground falls away, the water field
   returns the TRUE height, so `marchLevel(threshold)` puts the water boundary
   on the terrain's cap contour at that same threshold. The tread's own
   returned loops therefore already lie on the rock's edge along every
   falling-away arc.

So a waterfall is an ARC of the loop the tread already returned, extruded down
the same one-band drop the terrain's own skirt uses. It is smooth because the
loop is Chaikin-smoothed; it is coincident because the numbers are the same
numbers; it is not cell-shaped because the loop has sub-cell vertices.

This restores issue #63's conclusion — a fall belongs on the DRAWN contour —
which the record already called structural. What #63 got wrong, and what the
apron and riser both repeated, was building a separate curtain and hanging it
off a located point. The curtain now IS the contour arc.

## What the review pass changed

Written, then reviewed against source before any of it was handed out. Three
things in the first draft were wrong or underspecified; recorded because the
draft was wrong and reading the code is what settled it.

1. **The per-vertex classification pass is deleted.** The draft had
   `waterTread.ts` label each loop vertex with the `fieldAt` branch that
   produced it, "at emission time, never re-probed". That cannot be done as
   written: `chaikinPass` (`contourSmoothing.ts:59`) emits two points per input
   SEGMENT through `pushDistinct`, and `smoothLoop` then runs
   `enforceCentreGuard` and `dropCollinear` — so a smoothed vertex has no
   stable index correspondence to the marched edge it came from. Carrying the
   label would mean adding a field to `ContourPoint` and threading it through
   the terrain's smoother for water's benefit. Instead the arc is classified by
   PROBING `drawnBandAt` just outside each smoothed SEGMENT. That is not the
   mistake the apron made: the apron probed CELL MEMBERSHIP with a per-vertex
   normal that is undefined at a snout tip, whereas a segment has an exact
   normal and `drawnBandAt` answers the same question the terrain does. This
   removes a work item and leaves `waterTread.ts` untouched.
2. **`drawnBandAt` needs a cache and a hole rule.** Marching a chunk per
   threshold, per query, is not affordable — a world can span ~94 bands. And a
   naive point-in-polygon over `assembleLoops` output reads a basin enclosed
   inside a band as inside it; the loops must go through `groupLoops` so holes
   subtract.
3. **Band 0 is two levels, not one.** `capEmission.ts` inserts an extra
   waterline level at `SEA_LEVEL + 1` alongside band 0, and band 0's cap is
   sunk to `-SEABED_CAP_SINK` where it is seabed while dry land at band 0 sits
   at y = 0. `drawnBandWorldY(0)` is therefore ambiguous and the draft did not
   say which it meant.

Also corrected: the draft re-seated a falling arc onto the next level down by
taking the nearest contour point PER VERTEX, which can reorder vertices and
self-intersect the arc. It re-seats by the run's two ENDPOINTS instead, walking
that level's loop between them in a consistent direction.

## Work items

W1 and W3 are specified against each other's signatures so they can be written
in parallel. W5 is independent of both.

### W1 — `client/src/terrain/drawnGround.ts` (new)

The single source of truth for "what does the terrain DRAW here", so nothing
else ever re-derives it. This module existing is the fix; everything else is a
consequence.

```ts
/** A memo over one rebuild. Marching is per (chunk, threshold) and cached. */
export interface DrawnGround {
  /** The band whose cap the terrain draws at this point, in CELL coordinates. */
  bandAt(cellX: number, cellZ: number): number;
  /** Nearest point on `threshold`'s contour in the chunk holding the query. */
  nearestOnContour(
    threshold: number,
    cellX: number,
    cellZ: number,
  ): { x: number; z: number; loop: ContourLoop; index: number } | null;
  /** The smoothed loops of `threshold` for the chunk holding a cell. */
  loopsAt(threshold: number, cellX: number, cellZ: number): readonly ContourLoop[];
}

export function createDrawnGround(mirror: TerrainMirror): DrawnGround;

/**
 * World Y of the terrain's drawn cap for a band — capEmission.ts:606's rule.
 * `seabed` picks between band 0's two levels: the sunk seabed cap
 * (-SEABED_CAP_SINK) and the dry shore cap at y = 0.
 */
export function drawnBandWorldY(band: number, seabed: boolean): number;
```

- `bandAt` walks thresholds DOWNWARD from the band `bandOf(sampleHeight(...))`
  suggests and returns the first whose contour contains the point. Starting
  from the lattice guess bounds the search to the one or two levels the
  smoothing can have moved it by — it is a correction, not a scan from the
  summit.
- Containment is tested on `groupLoops` output so holes subtract.
- Every march is memoised on `(chunkX, chunkZ, threshold)` for the lifetime of
  the `DrawnGround`. One is created per rebuild and thrown away; it must never
  outlive a terrain edit.
- `drawnBandWorldY` must reproduce `capEmission.ts:606-609` exactly and import
  `SEABED_CAP_SINK` rather than restating it.
- HAZARD, document it: `contours.ts`'s `samples` is a module-level scratch
  buffer shared by every marcher in the client. A march must complete before
  another starts — no interleaving, no laziness that resumes mid-march.

Tests:
- on a hand-built terraced fixture, `bandAt` agrees with a raycast of the
  emitted terrain mesh at every point of a fine grid, INCLUDING within half a
  cell of a band boundary — the case `bandOf(sampleHeight(...))` gets wrong and
  the one that produced the 430 floating vertices;
- a band containing an enclosed basin reports the basin's own lower band, not
  the surrounding band (the hole rule);
- `drawnBandWorldY(0, true) !== drawnBandWorldY(0, false)`.

### W2 — deleted by the review pass

See "What the review pass changed", item 1. `waterTread.ts` is not modified.

### W3 — `client/src/render/water/waterCurtain.ts` (new, replaces the apron)

```ts
export function appendCurtains(
  ground: DrawnGround,
  loops: readonly ContourLoop[],   // exactly what appendRegionSurface returns
  surfaceBand: number,
  seaWorldY: number,
  out: number[],
): void;
```

1. **Classify each SEGMENT** of each loop: take its midpoint, step
   `CURTAIN_PROBE_CELLS` along its outward normal, and ask `ground.bandAt`.
   Lower than `surfaceBand` → this segment pours. Segments with either endpoint
   on the chunk border (`rect !== RECT_NONE`) never pour — the terrain skips
   those too (`isBorderSegment`), and across them lies the same region's other
   half.
2. **Group into maximal runs** of consecutive pouring segments.
3. **Walk down one band at a time**, exactly as `capEmission` stacks skirts:
   at level `k` emit a quad per segment from `drawnBandWorldY(k)` to
   `drawnBandWorldY(k-1)`, then re-seat the run onto level `k-1`'s own contour
   — `nearestOnContour` for the run's two ENDPOINTS, then the loop walked
   between them in a consistent direction — and repeat while `ground.bandAt`
   under the run is still lower. Stop at that band, or at `seaWorldY`,
   whichever is higher.

Re-seating per level is what paints a tall fall onto a STAIRCASE instead of
cutting one flat sheet through the intermediate treads.

Tests, all contract-level, none tolerance-based:
- every emitted vertex's Y equals `drawnBandWorldY` of some band, EXACTLY;
- every emitted vertex lies on the terrain's own contour for its own level;
- an N-band cliff emits N stacked quads per segment, not one;
- a chunk-border segment emits nothing;
- nothing is emitted below `seaWorldY`.

### W4 — `client/src/render/riverRig.ts` (wire) — orchestrator, not delegated

Treads for every wet cell per band (the pre-2026-08-23 behaviour, which never
floated), then `appendCurtains` off the loops the tread already returns. Delete
`water/waterApron.ts` and `test/waterApron.test.ts`; retarget
`test/waterFallIntegration.test.ts`.

### W5 — `client/scripts/measureWaterFloat.mjs` (new)

Commit the raycast probe from the measurement above as a repeatable check, so
"does it float" is a command rather than an opinion. Drives
`chrome-headless-shell` over CDP (the full recipe is in the session's
headless-screenshot note: the `--screenshot` flag hangs on these WebGL
harnesses; poll `window.__previewReady` instead), walks every water vertex,
raycasts the terrain under it via `__previewPickY`, prints the gap histogram in
bands, and exits non-zero if any vertex is off the drawn ground by more than
`RIVER_SURFACE_LIFT_WORLD_UNITS * 2`.

## Explicit decisions, not punts

- **Lakes are untouched.** Owner's call, and the tread path is the one thing
  that has never floated.
- **Chunk seams.** Loops stop at chunk borders and the terrain itself skips
  those segments (`isBorderSegment`). Water inherits identical behaviour, so
  the two match rather than fight. `'tile-border'` vertices never get a curtain.
- **Two new constants, both named for what they are.** `CURTAIN_OUTWARD_WORLD_UNITS`,
  a depth-buffer offset so the curtain does not z-fight the rock face it is
  coincident with — `emitSkirtQuad` already carries the opposite-signed inset
  for picking (`capEmission.ts:895`), and this is its twin and must cite it.
  And `CURTAIN_PROBE_CELLS`, how far outside a segment's midpoint the
  classification probe steps; it must exceed the residual disagreement between
  the smoothed water rim and the smoothed rock rim, measured at 0.11 cell
  (DESIGN.md, issue #63), and stay under half a cell so it cannot reach past
  the next face.
- **The channel's plan-view width** stays whatever the tread's region rule
  gives it. It is not re-tuned in this change.

## Verify before calling it done

1. `pnpm typecheck` and `pnpm test` clean.
2. `client/scripts/measureWaterFloat.mjs` reports zero vertices off the drawn
   ground, on `fork`, `meander`, `terrace`, `basin`, `stairpools`.
3. Eyes-on: iso and side captures of every fixture, published as an Artifact.
   No floating, no cell-shaped edges, falls visibly on the rock face.
