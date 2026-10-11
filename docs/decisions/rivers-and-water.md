# Rivers and water

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the
owner; do not relitigate without new information.

## 2026-08-19 — rivers, springs, waterfalls (cards 27, 40)

- **Water is derived, never simulated.** `computeRiverNetwork(map, options)`
  (`shared/src/rivers.ts`) is a pure function of the heightmap. No river state
  anywhere, no per-tick simulation; both sides hold only a cache of the last
  answer. Two rebuilds on the same heightmap are byte-identical.
- **Nothing about a river or waterfall is on the wire.** Server and client each
  recompute and agree by construction. `WorldApi.riverNetwork()` is a read
  primitive, the same shape as `WorldApi.heightAt`.
- **Springs need no seed.** A cell is a spring when it is a strict local maximum
  among its active 4-neighbours and sits `SPRING_MIN_HEIGHT_ABOVE_SEA` above
  `SEA_LEVEL`. Purely local and geometric, so a spring appears exactly when the
  terrain that makes it appears — which is the card's puzzle. The genesis seed is
  outside `shared/`'s determinism contract and is deliberately not read.
- **Flow: bounded steepest descent, then a bounded basin fill.** `traceRiver`
  walks in fixed N/E/S/W scan order, recording a **waterfall** at any step whose
  ends cross a `bandOf()` boundary. A cell with no strictly-lower active
  neighbour is a closed basin: `fillBasin` runs a single-basin priority flood and
  stops at the first rim neighbour below the water level (the spillway). Every
  pooled point carries the one flat `poolHeight`, so a renderer draws a lake and
  not a lumpy wet patch.
- **Recompute is throttled, not per-edit.** Measured: ~15 ms on an adversarially
  rough 512² world, ~1.9 ms on sculpted terrain. Per-intent recompute would scale
  with `players × 8.3/s`; at ~10 players that is ~1.2 s of CPU per wall second.
  Instead: scoped to active/revealed cells, `World.riverNetwork()` recomputes at
  most every `RIVER_RECOMPUTE_INTERVAL_MS` (250 ms), and the client keeps its own
  independent 500 ms throttle in `riverRig.ts`. A wall-clock cap, not "once per
  tick", because `TICK_HZ` is operator-configurable up to 60.
- **Traces are budgeted.** Flowing steps and basin cells share
  `RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize` cells; springs are capped
  at `MAX_SPRINGS_PER_NETWORK` (24, highest kept). Cost is bounded by two named
  constants rather than by terrain roughness.

**Punts:** no audio system exists, so card 40's *sound* is deferred in full. A
basin or a course larger than the shared budget stops where the budget ran out
(`truncated: true`, tested). The 2026-08-19 render layer shipped without eyes-on
verification; the later entries below fixed that.

**The waterfall mana-regen aura was removed 2026-09-06** (owner). It multiplied a
player's regen by up to 1.45 with nothing in the HUD to attribute it, so the
gauge's number could not be explained from the world's difficulty. Base regen was
raised 50% in the same change (`plugins/mana`: 300/s at difficulty 1, 30/s at
100). Card 40's mist and waterfall geometry are unaffected.

## 2026-08-21 — rivers split, and are drawn as polylines

Owner: rivers "render as square blocks… anywhere that a river has multiple paths,
it should follow those multiple paths as well". Two defects, one in the math and
one in the presentation.

- **A river is a set of courses, not a path.** `traceRiver` takes every active
  neighbour tied for the lowest height strictly below the current cell; the first
  continues the course, the rest fork. `fillBasin` returns every saddle at the
  spillway height. `River.points` became `River.courses`, with `riverPoints(river)`
  as the derived flat view.
- **Exact ties only.** Heights are integers, so "equally downhill" is order-free
  and both sides fork identically. A tolerance would be a knob deciding how
  braided the world looks — rejected.
- **Merges fall out of the same walk.** A branch reaching a cell the river already
  owns stops there and repeats that cell so the ribbons meet. Repeats are
  geometry, not extra water; every per-cell consumer is set-based.
- **Cost is unchanged.** Every reached cell is claimed and charged once against
  the same per-river budget. Branches trace breadth-first.
- **Waterfalls are deduplicated by cell** (largest drop wins) — a plunge point is
  a place, not an event.
- **One ribbon per course.** Each unbroken run of flowing points is smoothed
  (Chaikin, `RIVER_SMOOTHING_PASSES = 2`, endpoints pinned) and extruded into one
  triangle strip `FLOW_HALF_WIDTH_CELLS` either side of the tangent. Chaikin, not
  Catmull-Rom: an interpolating spline overshoots and puts water outside the cells
  `freshwater.ts` calls wet. XZ is smoothed, Y is not — the ribbon steps down the
  terraces it crosses instead of tunnelling through their lips.

**Second round, after the owner looked.** Measured by raycasting the drawn mesh
under the finished ribbon, not by looking:

1. The ribbon's geometry was already unbroken — every "gap" was terrain drawn
   over the water.
2. **The height rule was wrong by a whole band.** The ribbon used
   `quantizeToBand(nearest cell)`; the terrain is marching squares, and
   `crossingFraction` puts a band boundary a quarter cell inside the higher cell.
   `renderedBandAt` now reproduces the terrain's own interpolation.
3. A separable 2-D form of that rule applies the clearance twice on the diagonal
   and lands a band out near a cell corner — rejected. A river runs cell centre to
   cell centre, so the 1-D rule along the course is the exact case.
4. **The ribbon was wider than the drawn channel.** `FLOW_HALF_WIDTH_CELLS` is now
   derived from the terrain constant instead of chosen.
5. A fall gets an explicit vertical curtain (tread to the lip, full-width curtain,
   tread resuming below), nudged `RIVER_FALL_CLEARANCE_WORLD_UNITS` downstream so
   it stands in front of the face. The ribbon necks in through the lip stretch
   (`FALL_TAPER_CELLS`) and the corner cut is bounded
   (`MAX_SMOOTHING_DEVIATION_CELLS`).

**Residuals:** seen from straight overhead a curtain is edge-on, so a river down a
very steep face still reads as treads. In a one-cell slot turning 90° every few
cells (the adversarial `meander` fixture) the uphill edge is still under the bank
for about a cell after each fall — fixing it means re-running marching squares for
the water. Overlapping translucent water still double-blends at a junction
(pre-existing).

**Verified in a running client** over CDP: continuous ribbons, and a probe found
89% of flow-mesh vertices off the per-cell quad grid. `client/preview-rivers.html`
+ `previewRivers.ts` add three fixtures — `fork`, `meander`, `terrace` — because
the live world cannot show these on demand.

## 2026-08-21 — a lake is drawn with the terrain's own outline (#62)

Owner: "the lakes and other areas still need the edge smoothing". A pool was a
field of full-cell quads inside a bank the terrain draws as a smooth contour; no
half-width tuning could reconcile them, because they were not the same kind of
shape.

- **March the lake with the code that marches the ground.** `appendPoolSurface`
  runs `capEmission.ts`'s exact sequence (`loadSampleField` → `marchLevel` →
  `assembleLoops` → `smoothLoop` → `groupLoops`/`bridgeHole`/`earClip`) over the
  lake. One marching-squares implementation, one saddle rule, one Chaikin pass.
- **The threshold is the floor of the band above the pool's surface**, so the
  lake's edge and the foot of the riser it meets are the same contour.
- **Heights are negated** (a lake is the region below a threshold), which is exact
  — `crossingFraction` clears both ends symmetrically.
- **Membership is the flood's, not the heightmap's.** A cell outside `fillBasin`'s
  set is lifted by `DRY_CELL_CLEARANCE_HEIGHT_UNITS`; one height unit, so a cell at
  the waterline is excluded but the outline still runs almost to its centre.
- **Tiled in chunk-sized steps**, sharing border samples under seam contracts
  S1–S4, so two tiles' halves of one lake meet with neither gap nor overlap. Only
  tiles holding a flooded cell are marched.
- **The surface floated, and that was the worse bug.** A pool drawn at its raw
  spill height sat 0.203 world units — four fifths of a band — above the
  band-quantised ground under it. The surface is now quantised to the band the
  terrain draws the pool in.

**Rejected:** a binary in/out field (places the waterline half a cell out from
every flooded cell, so the lake sits in a ragged dry margin); rounding each pool
quad (adjacent tiles overlap or leave holes); flooding every cell below the pool
surface (that is the whole hillside below the spillway).

**Verified** eyes-on in the new `basin` fixture and by contract test —
`client/test/poolSurface.test.ts` asserts the surface covers every flooded cell
centre and no dry one, is one flat plane, leaves an island uncovered, and
partitions its area across a tile seam.

**Residual:** dry ground above the water but inside the water's own band renders
coplanar with the lake and is not covered by it, so a terraced shore gives no
relief cue at the waterline — only the colour change marks the edge.

## 2026-08-21 — a fall's curtain is placed on the drawn face (#63)

Owner: "some step sections that are missing the water drawing on the vertical edge
face". They were not missing — the third time in this arc that "the water is not
drawn" was "the water is drawn inside the hill". Hide the ground before judging.

- **Root cause: the ribbon located a face by a rule the terrain does not draw it
  by.** `renderedBandAt` is exact about where a band boundary crosses, but the mesh
  marches the whole lattice and then runs `smoothLoop`, which slides the face along
  the channel. Measured in `meander` at the fall between (8,4) and (9,4): unsmoothed
  crossing x = 8.40, drawn outline x = 8.51, so the curtain stood a tenth of a cell
  inside the hillside.
- **Read the lip off the outline the mesh builds its skirt from.**
  `makeLipLocator` intersects the segment between two ribbon samples with
  `chunkContourLoops(mirror, chunk, band floor)` and takes the crossing nearest the
  bisected estimate, which survives as the fallback. Loops are cached per
  (chunk, threshold) for one rebuild only, so no cache outlives its terrain.
- **Rejected: enlarging `RIVER_FALL_CLEARANCE_WORLD_UNITS`.** The displacement is
  whatever Chaikin did to that loop — data, not a constant — so any value large
  enough for the worst case detaches the water everywhere else.

**Verified by measurement:** walking the whole `meander` course at 1/20-cell steps
and raycasting — **1280 samples, 0 with water below the ground, 0 with no water**.
New preview probes `__previewPickWaterY` and `__previewContour`.

**Punt:** no unit test for the locator — it could only assert the lip lands on the
input it reads. The honest test is a headless "ribbon agrees with the mesh" check
in the spirit of `pickAgreesWithMesh.test.ts`; not written.

## 2026-08-26 — the sculpt-time water rebuild, three fixes

Every sculpt routes through `applyDirty` → `rivers.refresh`, throttled to 500 ms,
so a held stroke rebuilds the world's water twice a second. Measured on a 512²
world with 400 chunks revealed and a network at its design ceilings (~24.5k wet
cells): **235 ms per rebuild** against a 7.1 ms frame budget. Three causes, three
fixes, all owner-approved.

1. **The terrain publishes its plan; nothing re-derives it.**
   `createDrawnGround(mirror)` re-called `planChunkCaps` for chunks
   `writeChunkVertexData` had already planned and discarded — and a plan that must
   not outlive a terrain edit needed four call sites to remember to null it.
   `terrain/drawnGroundStore.ts` is now the handover and `terrain/drawnGround.ts` a
   pure reader with no cache and no invalidation. A chunk not yet drawn has no
   entry, which is a real state: water gets what is on screen. Each chunk's level
   polygons are also rasterised once into a band grid at `BAND_GRID_CELLS`, turning
   `bandAt`/`topmostLevelAt` into an array read.
2. **Water geometry is re-emitted per region, not per world.** A region's identity
   is its band, so one band is one region by construction. Each region owns a packed
   run spliced with `copyWithin`, re-emitted only when the chunks it stands over can
   have changed — the dirty set plus every chunk whose water entered, left or changed
   band, each grown by one ring. Both the region's current and last-drawn tiles are
   tested, since a region that lost its cells in a chunk no longer lists it.
3. **The network recompute moved off the main thread.** `computeRiverNetwork` is
   global by nature and measured 24–48 ms, over the whole budget alone. Purity is
   what makes a Web Worker safe. Cells are transferred as a copy; `columnSpans` is
   not sent. **What comes back is not the network** — it is flattened worker-side to
   three typed arrays, because posting ~24.5k point objects would put the
   structured-clone deserialisation back on the main thread. Requests coalesce, and
   an answer whose mirror has since been replaced is dropped. Where no worker starts,
   the source falls back to this thread — slower, never wrong; tests and previews use
   that same direct source.

**Result, same fixture:** 235 ms → **3.4 ms** of main-thread work per refresh, with
48 ms of network recompute off-thread.
