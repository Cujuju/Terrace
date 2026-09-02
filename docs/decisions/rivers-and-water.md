# Rivers and water

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (Rivers & Springs — mechanics card 27; Waterfalls — card 40)

**Card 27** — "Springs on high ground send water stepping down band edges to
the sea, pooling in basins. Deterministic flow from the heightmap alone —
sculpting a river's course becomes the game's most satisfying puzzle."
**Card 40** — "Where a river (card 27) crosses a band edge it falls — mist,
sound, and a small mana-regen aura at the plunge pool." Card 40 depends on
card 27 and was built on top of it in the same pass, owner-approved.

**Water is derived, never simulated — extended, not amended.** Q3 already
settled this for the sea (`height ≤ SEA_LEVEL` is water, computed identically
on both sides, nothing synced). A river is the same fact one level up: a
PURE FUNCTION of the heightmap — `computeRiverNetwork(map, options)` in the
new `shared/src/rivers.ts` — with no per-tick simulation and no river state
anywhere, ever, including in memory: server and client each hold only a
CACHE of the last computed answer, rebuilt from scratch whenever they choose
to recompute, and two rebuilds against the same heightmap are byte-identical
(pinned by `shared/test/rivers.test.ts`'s determinism test). **Nothing about
a river or a waterfall is on the wire.** Springs, courses, pools and
waterfalls are recomputed independently by the server (from its authoritative
`Heightmap`) and by every client (from its own `TerrainMirror`) and agree by
construction, the same way two clients' sea renders agree without either
being told where the coastline is.

**Where springs come from, and why it needs no seed.** A cell is a spring
when it is a STRICT local maximum among its in-bounds, active 4-neighbours
(no tie — a flat plateau seeds no spring) and sits at least
`SPRING_MIN_HEIGHT_ABOVE_SEA` (one terrace band, 64) above `SEA_LEVEL`. This
is a purely LOCAL, purely geometric test — no RNG, and deliberately no world
seed either, unlike fresh-world genesis noise. Two reasons, not one:

  1. **Stability under sculpting is the whole point of the card.** A spring
     must appear or vanish exactly when the terrain that makes it a peak
     appears or vanishes — that is what makes "sculpting a river's course"
     the puzzle the card asks for. A seed-anchored placement would have
     springs the player cannot move by sculpting, or springs that drift for
     reasons unrelated to what they just built.
  2. **The genesis seed is explicitly outside shared/'s determinism
     contract** (see the fresh-world entry above: "world genesis, seed draw
     included, is not part of it... the client never generates terrain").
     Reading it from `shared/` would need threading a server-only value into
     client-side prediction math for no benefit — the heightmap the player
     can see already carries every bit this mechanic needs.

**The flow algorithm: bounded steepest descent, then a bounded basin fill.**
(AMENDED 2026-08-21 — a tie between neighbours no longer picks one and drops
the rest; it SPLITS the river. See "rivers split, and are drawn as polylines"
below; everything else in this paragraph stands.)
From each spring, `traceRiver` walks to the strictly-lowest of its four
neighbours (fixed N, E, S, W scan order — part of the determinism contract,
exactly like `forEachFootprintOffset`'s fixed scan order in heightmap.ts),
recording a **waterfall** at any step whose two ends cross a `bandOf()`
boundary (this IS the "crosses a band edge" test card 40 asks for — no
separate detection pass). Reaching `SEA_LEVEL` ends the river. Reaching a
cell with **no** strictly-lower active neighbour is a closed basin, handled
by `fillBasin`: a textbook priority-flood (min-heap over the rim, `level`
rising to the highest cell absorbed so far), restricted to ONE basin rather
than run over the whole map, stopping the instant it finds a rim neighbour
BELOW the current water level — that cell is the spillway, and the pool's
surface height is `level` at that moment. **Every pooled point carries that
one flat `poolHeight`** (not each submerged cell's own, lower, ground
height), which is what lets a renderer draw a flat lake instead of a lumpy
wet patch — added to `RiverPoint` specifically for that reason. This is the
"classic answer" the pooling requirement asked for: a lake at the basin's
true spill height, not merely "stop and don't loop" — see the punt below for
where it is intentionally cheaper than a full watershed solve.

**Recompute strategy — the cost argument, in full.** A naive full recompute
on every terrain diff does not fit: `computeRiverNetwork` scans every active
cell for local maxima (O(active cells)) and then traces every spring found —
MEASURED on a 512² world with adversarially rough terrain (every cell a
pseudo-random height, the worst realistic case for "how many local maxima
exist"): **~15 ms**; on terrain shaped like actual sculpting (40 stamped
peaks on an otherwise flat 512² world): **~1.9 ms** (`shared/perf_rivers.ts`,
run ad hoc — not committed, the numbers are recorded here). A held brush
emits an intent every `SCULPT_REPEAT_INTERVAL_MS` (120 ms, client/src/
config.ts) ≈ 8.3/s, **per player** — recomputing inside every applied intent
would scale server CPU with `players × 8.3/s`, not with a fixed budget, and
at ~10 concurrent players sculpting at once that is 80+ recomputes/s ×
15 ms worst case ≈ 1.2 s of CPU per second of wall clock. That is the "will
not fit" failure mode named in the task brief, confirmed rather than assumed.

The fix, matching `plugins/wildlife/server/census.ts`'s own
`HABITAT_CENSUS_INTERVAL_SECONDS` precedent ("too expensive per tick, so it
runs on an interval"), with two refinements of its own:

  - **Chunk/mask-scoped, not whole-world.** Both the scan and every trace are
    bounded by an `isActive(x, y)` predicate — the server passes
    `isCellUnlocked` (nobody can see a river over land nobody has revealed,
    exactly the wildlife census's own "unlocked chunks only" scoping); the
    client's `TerrainMirror` is naturally bounded to received chunks (an
    unreceived cell reads flat at `SEA_LEVEL`, which can never be a spring or
    a mid-course cell above it), so it passes no predicate at all. Cost is
    therefore proportional to the REVEALED area, not to `WORLD_SIZE²` — cheap
    for the overwhelming majority of a game's lifetime, when most of a 512²
    allocation is still locked.
  - **A real-time throttle, decoupled from both player count and edit rate.**
    `World.riverNetwork()` (server/src/world/world.ts) caches its last
    answer and recomputes at most once every `RIVER_RECOMPUTE_INTERVAL_MS`
    (250 ms — 4 Hz), driven by a dirty flag `World.applySculpt` sets on every
    non-empty diff. Worst case, at the measured 15 ms adversarial figure:
    `15 ms × 4/s = 60 ms/s` — 6% of one core, REGARDLESS of how many players
    are sculpting or how fast, because the cost is now a function of the
    THROTTLE, not of the edit stream. 250 ms (not "once per tick") is
    deliberately independent of `TICK_HZ`, which an operator may configure up
    to `MAX_TICK_HZ` (60): "once per tick" at 60 Hz would let the same
    adversarial case cost `15 ms × 60/s = 900 ms/s`, i.e. potentially over
    budget — a wall-clock cap avoids that regardless of tick configuration.
    The client keeps its OWN, independent 500 ms (2 Hz) throttle in
    `client/src/render/riverRig.ts` — half the server's rate, argued there:
    it is one screen's redraw cost, not a shared multi-player CPU budget, so
    it is tuned for feel (a river visibly settles a beat after the last click
    of a held stroke) rather than for worst-case aggregate cost. Determinism
    does not require the two throttles to agree, or to fire at the same
    moment — only that a given heightmap always produces the same network,
    which both sides' pure `computeRiverNetwork` guarantees regardless of
    when either side chooses to call it.
  - **A bounded downstream re-trace.** Within one recompute, every spring's
    trace (flowing steps AND the cells a basin fill absorbs, SHARING one
    budget) is capped at `RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER ×
    worldSize` cells (2×, i.e. 1024 cells on a 512-edge world) — a river or a
    pool larger than that stops where its budget ran out (`truncated: true`,
    observable, tested) rather than ever running unbounded. Springs
    themselves are capped at `MAX_SPRINGS_PER_NETWORK` (24, the highest peaks
    kept — sorted by height descending before the cap is applied), which
    bounds the number of traces a rough revealed area can trigger. Together
    these turn "cost could scale with terrain roughness" into "cost is capped
    by two named constants, independent of terrain" — the same shape
    `SMOOTH_PASS_LIMIT` gives the relaxation pass in heightmap.ts.

**What is on the wire: nothing.** No river message, no waterfall message, no
spring list — re-stated because it is the one thing this whole design would
be wrong to get subtly incomplete. `WorldApi.riverNetwork()` is a new READ
primitive (server/src/plugins/types.ts), exactly the same shape as
`WorldApi.heightAt` or `WorldApi.difficulty`: a plugin queries core's own
derived cache; core publishes a neutral fact and knows nothing about what any
plugin does with it.

**The waterfall mana-regen aura is `plugins/mana`'s concern, not core's**
(constraint from the task brief, matching "nothing gamey in core"). It reads
`WorldApi.riverNetwork()` directly inside its own `regenerate()`/
`manaRegenFor()` — the SAME multiplier-composition shape mana already uses
for perks (`manaPerkOf(playerId).regenMultiplier`, see the PERK API section
of `plugins/mana/server/index.ts`) rather than a new cross-plugin seam: this
is mana reading one more fact about ITS OWN world, not a second plugin
touching mana the way relics touches it through `setManaPerk`. Because there
are no player avatars in this game (players are gods sculpting a world, never
embodied in it — design §3.1), "standing at the plunge pool" is read against
a player's own REVEALED TERRITORY (`WorldApi.isCellVisibleTo`, the existing
per-player fog-of-war primitive from issue #17) rather than spatial
proximity: a waterfall the player has personally unlocked grants
`WATERFALL_AURA_REGEN_BONUS_PER_WATERFALL` (0.15 — a SMALL bonus, the card's
own word, capped at `WATERFALL_AURA_MAX_COUNTED` = 3 waterfalls so the effect
cannot be farmed by revealing a jagged coastline) on top of the
difficulty-derived rate. Tested end-to-end through the real plugin host in
`plugins/mana/test/mana.test.ts`.

**Render: two derived-geometry layers plus a mist puff, no headless GL rig**
(design §8: client rendering is verified manually; this project ships none).
`client/src/render/riverRig.ts` follows the house rig pattern
(`plugins/weather/client/rig.ts`'s own header): geometry/materials built once
and mutated in place on each throttled recompute (never inside the frame
loop), one owner frees what it made, and the only animated element — the
mist's gentle vertical bob — freezes under `prefers-reduced-motion`, matching
weather's "the whole sky holds still" rule (there is no flashing-light
concern here at all; this is done purely for consistency with the house
standard). (AMENDED 2026-08-21: flowing water is no longer a tile per cell
but one smoothed ribbon per course — see "rivers split, and are drawn as
polylines" below. Pools are still tiles, as described here.) Every river point
becomes a small flat translucent tile at its
cell's rendered (band-quantised) height — narrower for flowing channel,
full-cell-width and flat-at-`poolHeight` for a pool, so adjacent pooled tiles
join into one continuous lake surface. Each waterfall gets a small ring of
mist particles at its plunge point. Wired into `client/src/world.ts`
alongside `water`/`fog` — same lifetime, same "one instance for the session"
shape — refreshed from every path that changes the mirror's terrain
(`applyDirty`, `onChunkUnlock`) and FORCE-refreshed (bypassing the throttle)
on `onSnapshot`, so a rejoin to a different world never shows the previous
session's rivers for up to the throttle window.

**Punts, named:**

  - **Sound.** Card 40 says "mist, sound, and a small mana-regen aura". This
    project has no audio system anywhere in the client — confirmed by reading
    the whole client tree — and this change does not add one. Deferred in
    full; the mist and the mana aura ship, the sound does not.
  - **Basins are filled to their true spill height, but a basin larger than
    the shared trace budget is not.** `fillBasin`'s priority-flood is the
    textbook-correct algorithm — no approximation in the ALGORITHM — but it
    shares its per-river cell budget with ordinary flowing steps
    (`RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize`, 1024 cells on a
    512-edge world). A basin larger than that stops where the budget ran out,
    `truncated: true`, drawn as a pool at whatever level it reached rather
    than at the true spill height. Accepted because a player-scale basin is
    bounded by the brush footprint that dug it (≤ 37 cells at
    `MAX_BRUSH_RADIUS`) unless many strokes compound into one huge pit, which
    is a rare, deliberate act rather than an ordinary outcome.
  - **A single spring's course, in the adversarial worst case, can be cut off
    by the SAME shared budget** before it reaches the sea (`truncated: true`,
    observable, tested in `rivers.test.ts`'s truncation coverage via the
    budget-exhaustion path in `fillBasin`). Not observed on any
    player-constructed terrain during this change's own testing; named as a
    residual the same way `SMOOTH_PASS_LIMIT`'s truncation is.
  - **No headless visual verification.** The render layer (`riverRig.ts`) was
    NOT run in a browser or screenshotted as part of this change — there was
    no running client/server pair available to drive it against. Its
    correctness rests on: (a) the underlying math being unit-tested
    end-to-end in `shared/test/rivers.test.ts`, (b) `pnpm typecheck` passing
    for the client package, and (c) manual code review against the house
    rendering rules (`plugins/weather/client/rig.ts`'s header). Visual
    correctness — tile placement, mist legibility, colour/opacity balance —
    is UNVERIFIED and should be checked against a running client before this
    is considered feel-tuned.

## Decisions made 2026-08-21 (rivers split, and are drawn as polylines)

Owner report: rivers "render as square blocks, but we need them path smoothed
so that they render like polylines, and anywhere that a river has multiple
paths, it should follow those multiple paths as well — like a split in the
river." Two defects, one in the math and one in the presentation, fixed
separately because they are separate.

**The math: a river is a set of courses, not a single path.** `traceRiver`
used to move to "the strictly-lowest neighbour, ties broken by
FLOW_DIRECTIONS' scan order" — so on a symmetric slope (exactly what a
player's radially-symmetric brush stroke makes) half the drainage was silently
discarded. It now takes EVERY active 4-neighbour tied for the lowest height
strictly below the current cell: the first continues the course it is on, the
rest are queued as new courses forking from that cell. `fillBasin` does the
same at a pool's rim — it returns every saddle at the spillway height, so a
brimming lake that overflows in two places drains in two places.
`River.points` is therefore replaced by `River.courses`, each an unbroken
polyline in flow order (with `riverPoints(river)` as the flat, derived view
the per-cell consumers — `buildFreshwaterMap`, the world tests — want).

  - **Exact ties only.** Heights are integers, so "equally downhill" is an
    exact, order-free test and both sides fork identically. A tolerance
    ("within N units") would be a tuning knob deciding how braided the whole
    world looks; rejected.
  - **Merges fall out of the same walk.** A branch that flows into a cell this
    river already owns stops there rather than re-tracing it, repeating that
    cell as its last point so the drawn ribbons meet. A branch course likewise
    repeats its junction cell as its FIRST point. Both repeats are geometry,
    not extra water: every per-cell consumer is set-based.
  - **Cost is unchanged.** A junction fans out to at most the four cells
    FLOW_DIRECTIONS names, and every cell a river reaches down any branch is
    claimed, pushed and charged exactly once against the SAME per-river budget
    (`RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize`). Branching spends
    that budget across more courses; it never spends more of it. Branches are
    traced breadth-first in queue order — fixed, and it spends the budget on
    reach rather than on the first branch's full descent.
  - **Waterfalls are deduplicated by cell** (largest drop wins), because two
    courses can now plunge into the same cell and a plunge point is a place,
    not an event. Without this the mana waterfall aura would double-count a
    confluence.

**The presentation: one ribbon per course.** `riverRig.ts` drew one
axis-aligned quad per flowing cell; since a course is a 4-connected cell walk,
every turn was a hard 90° and the result read as a staircase of separate
squares. Each unbroken run of flowing points in a course is now smoothed
(Chaikin corner-cutting, `RIVER_SMOOTHING_PASSES = 2`, endpoints pinned) and
extruded into ONE continuous triangle strip, `FLOW_HALF_WIDTH_CELLS` either
side of the local tangent. A fork is two ribbons that meet at the junction —
which is exactly what the junction-point repeat above is for.

  - **Chaikin, not Catmull-Rom.** An interpolating spline overshoots, putting
    water outside the cells that `freshwater.ts` calls wet. Chaikin's
    approximating cut cannot leave the walk's convex hull.
  - **XZ is smoothed; Y is not.** Height is resampled per sample from the
    band-quantised terrain, so the ribbon steps down the terraces it crosses
    instead of tunnelling through their lips.
  - **Lakes stay a field of full-cell quads.** A pool must tile edge to edge
    with no seam, which a ribbon cannot express; `pushQuad` is the one square
    primitive left, and it also covers the degenerate flowing run of a single
    cell (one point has no direction to extrude along).
    **SUPERSEDED the same day** (issue #62, see "a lake is drawn with the
    terrain's own outline" below): a lake is now marched and smoothed by the
    terrain's own pipeline. `pushQuad` survives only for the single-cell
    flowing run.

**Punts, named:**

  - **A terrace fall gets an explicit vertical curtain** (added the same day,
    after the first screenshots). Joining two samples in different bands
    directly produced a strip that was near-vertical and about a tenth of a
    cell long — effectively coincident with the terrace face it crossed, so it
    vanished inside the terrain and every course rendered as a DASHED line,
    one dash per tread, which is the very "square blocks" this work exists to
    abolish. A fall is now three pieces: the tread carried to the lip, a
    full-width vertical curtain, and the tread resuming below, with the
    curtain nudged `RIVER_FALL_CLEARANCE_WORLD_UNITS` downstream so it stands
    in front of the terrace face rather than inside it — the horizontal twin
    of `RIVER_SURFACE_LIFT_WORLD_UNITS`. Residual, named: seen from straight
    overhead a curtain is still edge-on, so a river down a very steep face
    still reads as treads. Every oblique angle — which is where the camera
    actually sits — shows a connected river.
  - **Overlapping translucent water still double-blends at a junction**, where
    two courses' ribbons cross the same cell. Pre-existing (two springs whose
    courses merged already did this) and unchanged by this work.
**Second round, after the owner looked (2026-08-21).** The dashed courses
above were only the first layer of the same defect, and the owner's report —
"disjointed sections where the river is not painting… I would like it to also
paint down the side of the layer" — sent the investigation to the bottom of
it. What was measured, in order, by raycasting the DRAWN terrain mesh under
the finished ribbon (a debug hook in the preview harness) rather than by
looking:

  1. **The ribbon's geometry was already unbroken.** Rendering the water with
     the terrain hidden showed one continuous strip end to end. Every "gap"
     was therefore terrain drawn OVER the water, not water missing.
  2. **The height rule was wrong, and by a whole band.** The ribbon took its
     height from `quantizeToBand(nearest cell)` — a per-cell block field. The
     terrain is nothing of the sort: it is marching squares over the cell
     lattice, and `crossingFraction` puts a band boundary a QUARTER of a cell
     inside the higher cell, not at the half-way mark. So for a quarter cell
     past every lip the water was a band below the cap it was still crossing,
     drawn inside the hillside. `renderedBandAt` now reproduces the terrain's
     own interpolation — importing `CONTOUR_SAMPLE_CLEARANCE` rather than
     restating it — and the raycast confirms the water sits exactly its own
     lift above the ground at every sample of the course.
  3. **A 2-D form of that rule was tried and rejected.** The clearance is
     defined per lattice edge; a separable (x, then z) extension applies it
     twice on the diagonal and lands a whole band out near a cell corner,
     which put the water UNDER the terrain in exactly the places it was meant
     to fix. A river runs cell centre to cell centre — along lattice edges —
     so the one-dimensional rule along the course is the case that is
     genuinely exact, and the ribbon carries a course parameter through the
     smoothing to use it.
  4. **The ribbon was wider than the channel the terrain draws.** That same
     quarter-cell offset means a one-cell channel renders as a groove only
     HALF a cell across, so a 0.6-cell ribbon had a sixth of its width buried
     under the banks. `FLOW_HALF_WIDTH_CELLS` is now derived from the terrain
     constant instead of chosen.
  5. **What is left is a genuine pinch.** Where a course steps down inside a
     carved channel, the terrain's band outline does not cross the channel
     square-on — it lags at the banks, so for about half a cell past the lip
     the lower terrace exists only along the middle of the channel. The
     ribbon necks in through that stretch (`FALL_TAPER_CELLS`) rather than
     being drawn inside the hillside, and the smoothing's corner cut is
     bounded (`MAX_SMOOTHING_DEVIATION_CELLS`) so a turn cannot walk the
     whole strip out of the channel. **Named residual:** in a one-cell-wide
     slot that turns ninety degrees every few cells — the adversarial
     `meander` fixture, not terrain a player is likely to build — the uphill
     edge is still under the bank for roughly a cell after each fall.
     Reproducing that outline per vertex means re-running marching squares
     for the water; that is the price of removing this last case, and it was
     not paid.

**Visually verified, and what it took.** Unlike the 2026-08-19 entry, this
one was checked with eyes on a running client — twice, and the second look is
what found the dashed-line defect above.

  - **In the live world**, driven over CDP (see the headless-screenshot
    recipe): rivers draw as continuous ribbons following their courses, and a
    probe of the flow mesh confirmed the smoothing is real rather than assumed
    — 89% of its vertices sit off the per-cell quad grid, at sub-cell sample
    spacing.
  - **`client/preview-rivers.html` + `previewRivers.ts`** is new, in the
    established throwaway-harness pattern (`preview-boats.html` and friends).
    It drives the REAL `createTerrainMeshes` and `createRiverRig` over a
    hand-built heightmap. It exists because the live world cannot show these
    two things on demand: its shape is whatever players sculpted, rivers only
    exist where somebody built a hill, and the daynight plugin rewrites the
    lighting rig ten times a second — which a screenshot driver on a ~1 fps
    software-GL page can never outvote, so half the captures came back at
    night. Three fixtures: `fork` (a square cone whose summit ties four ways —
    four courses radiate down four faces, which is the split, drawn),
    `meander` (a channel of hard 90° corners carved into a hillside — draws as
    one continuous ribbon with rounded corners, which is the smoothing,
    drawn), and `terrace` (a staircase, for the fall curtain).
  - **Fixture lessons worth keeping**, since each cost a round trip: a channel
    walled in with one tall constant is a canyon, not a river on a hill (bank
    the channel with a hillside that slopes the same way); a cone that is
    still above SEA_LEVEL at the map border makes its whole outer ring one
    enormous flat basin, which swallows every course; a spring needs its four
    neighbours strictly below it, which walls and ramps both break; and a
    fixture that drops a whole band per cell puts a plunge-pool effect on
    every cell, hiding the very water it is meant to show.

## Decisions made 2026-08-21 (a lake is drawn with the terrain's own outline, issue #62)

Owner report, after the ribbon work above: "the lakes and other areas still
need the edge smoothing". A pool was still a field of full-cell quads — the
one thing the rivers entry above explicitly left as a square — so a lake's
edge was the polyomino boundary of the flooded cells, hard 90° corners and
all, sitting inside a bank the terrain draws as a smooth rounded contour. The
two could never be reconciled by tuning a half-width, because they were not
the same kind of shape.

**Decision: march the lake with the code that marches the ground.**
`appendPoolSurface` (client/src/render/riverRig.ts) runs the exact sequence
`terrain/capEmission.ts` runs per band — `loadSampleField` → `marchLevel` →
`assembleLoops` → `smoothLoop` → `groupLoops`/`bridgeHole`/`earClip` — over
the lake instead of over a chunk. It is the same borrowing
`render/brushPreview.ts` already does for the brush outline, and for the same
reason: one marching-squares implementation, one saddle rule, one Chaikin
pass, so the water and the bank cannot speak different shape languages.

**The field it marches, which is where the shape decision lives:**

  - **The threshold is the floor of the band ABOVE the pool's surface** — the
    height at which the terrain starts drawing ground that stands above this
    water. Everything in the surface's own band is drawn AT that band's floor,
    at or under the waterline, so it belongs to the lake. Marching the real
    heights at a real band boundary means the lake's edge and the foot of the
    riser it meets are the same contour, solved by the same
    `crossingFraction`; they cannot disagree.
  - **Heights are negated**, because a lake is the region BELOW a threshold
    and `marchLevel` traces the region at or above one. This is exact, not an
    approximation: `crossingFraction` pushes both ends
    `CONTOUR_SAMPLE_CLEARANCE` clear of the threshold symmetrically, so the
    crossing solved on the negated pair is algebraically the same point on the
    same lattice edge.
  - **Membership is the flood's, not the heightmap's.** A cell outside
    `fillBasin`'s flooded set is lifted to the threshold plus
    `DRY_CELL_CLEARANCE_HEIGHT_UNITS` however low it really is — the ground
    below the spillway is lower than the lake and is not part of it. One
    height unit, so a cell genuinely at the waterline (the spillway is exactly
    that) is pushed only far enough to be excluded, and the outline still runs
    almost to its centre instead of stopping a cell short of the outflow.

**Tiled in chunk-sized steps.** The marching lattice is a chunk's 17×17 and a
lake is not bounded by one. Tiles share their border samples exactly as
neighbouring chunks do (seam contracts S1–S3) and `smoothLoop` pins border
points (S4), so two tiles' halves of one lake meet with neither gap nor
overlap — the same reason the terrain's caps tile seamlessly. Only tiles whose
lattice actually holds a flooded cell are marched, so cost is proportional to
the water rather than to the span between two unrelated puddles.

**A second, worse bug found on the way: the surface floated.** A pool was
drawn at its raw spill height (`poolHeight × HEIGHT_WORLD_SCALE`) while the
terrain under it is band-quantised like all the rest of the world. Measured in
the `basin` fixture by raycasting the drawn mesh: the floor of a pool at spill
height 109 rendered at **y = 1.5** (band 6's cap, 96 height units) while the
water sat at 109 × HEIGHT_WORLD_SCALE = **y = 1.703** — 0.203 world units, or
**four fifths of a band**, above the ground it was supposed to be resting on. The surface is now
quantised to the band the terrain draws the pool in, which is the same
correction the flowing ribbon already carried (`renderedBandAt`) and the same
plane the outline's threshold is derived from.

**Rejected alternatives:**

  - **A binary in/out field** (the brush preview's rule: membership is
    yes/no, crossing forced to the cell edge). Tried first and visibly wrong —
    it places the waterline half a cell out from every flooded cell regardless
    of where the terrain's riser actually is, so the lake sat inside a ragged
    margin of dry ground instead of meeting its bank. Marching the real
    heights is what makes the two outlines the same curve.
  - **Rounding each pool quad** (keep the tile field, soften its corners).
    Cannot express a shared boundary: adjacent tiles either overlap or leave
    holes, and the outline still would not know where the bank is.
  - **Flooding every cell below the pool surface** rather than only the
    basin's. That is the whole hillside below the spillway; membership has to
    come from `fillBasin`.

**Verified, both ways.** Eyes-on in the `basin` fixture (new — a channel into
a walled bowl with a lobe off its side, so the outline has convex arcs and a
concave neck; its size is bounded by the per-river trace budget, or
`fillBasin` stops mid-lake and leaves a straight budget-shaped cut). And as a
contract test rather than a wiring test — `client/test/poolSurface.test.ts`
asserts the surface covers every flooded cell centre, no dry one (the honesty
guard `CONTOUR_CELL_CENTRE_GUARD` gives), is one flat plane at the height it
was handed, leaves an island uncovered, and PARTITIONS its area across a tile
seam: every sampled point covered at least once and no point strictly inside
two triangles.

**Named residual.** Dry ground whose height is above the water but inside the
water's own band renders at the same band floor — coplanar with the lake, and
not covered by it. That is honest (it is dry land, and the terrain draws it
flat there), but it means a terraced shore gives no relief cue at the
waterline; only the colour change marks where the lake ends.

## Decisions made 2026-08-21 (a fall's curtain is placed on the drawn face, issue #63)

Owner report: "there are also still some step sections that are missing the
water drawing on the vertical edge face". They were not missing. Rendering the
water with the terrain hidden showed one unbroken ribbon, curtains and all —
the third time in this arc that "the water is not drawn" turned out to be "the
water is drawn inside the hill", and the reason the issue's own method note
says to hide the ground before judging anything.

**Root cause: the ribbon located a terrace face with a rule the terrain does
not draw it by.** `renderedBandAt` inverts `crossingFraction` along the
course's lattice edges and is exact about where the band boundary CROSSES —
but the mesh marches the whole 2-D lattice and then runs `smoothLoop` over the
result, which slides the face along the channel. Measured in the `meander`
fixture at the fall between cells (8,4) and (9,4): the unsmoothed crossing is
at **x = 8.40**, the drawn outline crosses the course at **x = 8.51**, and the
curtain — nudged `RIVER_FALL_CLEARANCE_WORLD_UNITS` (a 64th of a cell) past
8.40 — stood a tenth of a cell inside the hillside, behind the very cap it
falls from.

**Decision: read the lip off the outline the mesh builds its skirt from.**
`makeLipLocator` intersects the segment between two ribbon samples with
`chunkContourLoops(mirror, chunk, band floor)` — the same marched-and-smoothed
loops `capEmission.ts` emits caps and skirts from — and takes the crossing
nearest the bisected estimate. Whatever the smoothing did to that face, the
curtain goes with it, for any angle of course against face. The bisected
crossing survives as the FALLBACK when a segment does not cross the outline
inside the chunks it touches, so the geometry is never worse than it was.
Loops are cached per (chunk, threshold) for the life of one rebuild and thrown
away with it, so no cache can outlive the terrain it was read from.

**Rejected: enlarging `RIVER_FALL_CLEARANCE_WORLD_UNITS`** until the curtain
cleared the face. The displacement is whatever Chaikin did to that particular
loop — it is data, not a constant — so any value large enough for the worst
case detaches the water from the lip everywhere else.

**Verified by measurement, not by looking.** Walking the whole `meander`
course at 1/20-cell steps and raycasting the drawn meshes at each: **1280
samples, 0 with the water below the ground, 0 with no water at all.** Before
the change the same walk found the water a band low through every fall's first
tenth of a cell. The preview harness grew the probes that make this possible —
`__previewPickWaterY` (the water's drawn height, the twin of `__previewPickY`)
and `__previewContour` (the terrain's own smoothed band outline).

**Named punt: no unit test for the locator.** A test could only assert that
the lip lands on `chunkContourLoops`' output, which is what the locator reads
— tautological. The honest test is the one that catches the class of bug: a
headless "the ribbon agrees with the mesh" check in the spirit of
`pickAgreesWithMesh.test.ts`, comparing every ribbon vertex against the cap
triangles `chunkCapTriangles` emits. Not written; the in-world measurement
above is what stands behind this change today.

## Decisions made 2026-08-26 (the sculpt-time water rebuild, three fixes)

**The measurement.** Every sculpt routes through `applyDirty` (client/src/
world.ts), which calls `rivers.refresh` — throttled to
`RIVER_RECOMPUTE_INTERVAL_MS` (500 ms), so a held stroke rebuilds the world's
water twice a second. Measured on a 512² world with 400 chunks revealed and a
network at its own design ceilings (`MAX_SPRINGS_PER_NETWORK` = 24 springs,
each traced to `RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER × worldSize` cells,
i.e. ~24.5k wet cells): **235 ms per rebuild**, against the owner's ≥140 fps
bar — a 7.1 ms frame budget for everything. Three separate causes, three fixes,
all owner-approved.

**1. THE TERRAIN PUBLISHES ITS PLAN; NOTHING RE-DERIVES IT.** Commit 7e3332c
gave the world "the terrain publishes what it drew; water reads it", and the
reading half honoured it by RE-DERIVING: `createDrawnGround(mirror)` called
`planChunkCaps` again for every chunk any query touched, while
`writeChunkVertexData` had already planned exactly those chunks and thrown the
result away. Two costs, and the second is the worse one: a plan that is a
private memo of a mutable mirror "MUST NOT outlive a terrain edit", so FOUR
places in world.ts had to remember to null it and a fifth that forgot would
have placed decals on pre-edit contours. `terrain/drawnGroundStore.ts` is now
the handover: the mesh builder publishes each chunk's `ChunkDrawnCaps` as it
draws it, and `terrain/drawnGround.ts` is a pure reader with no cache and no
invalidation. **A chunk not yet drawn has no entry**, and that is a real state
rather than a gap — the mesh queue drains under a frame budget, so water asking
the store gets what is ON SCREEN, which is the side of that race water must be
on; the reader answers for such a chunk exactly as it answers for a blocky one,
from the cell's own height through the blocky fallback's Y rule.

Alongside the plan, each chunk's level polygons are RASTERISED ONCE into a band
grid at `BAND_GRID_CELLS` (a quarter cell — the curtain's own probe step, now
one constant read by both). `bandAt`/`topmostLevelAt` become an array read
instead of a point-in-polygon walk down the level stack, which the waterfall
curtain was calling four times per boundary segment for thousands of segments.
The grid samples sit ON the lattice, so every query at a cell centre, half cell
or quarter cell is exact; only the curtain's outward probe is quantised, and by
at most half a grid step, at a boundary where its own doc comment already
records that either adjacent band is a correct answer.

**2. WATER GEOMETRY IS RE-EMITTED PER REGION, NOT PER WORLD.** A region's
identity is its BAND — the rebuild groups every wet cell by the band its
surface is drawn at, so one band is one region by construction, and the same
terrain always produces the same bands. Each region owns a packed RUN in the
water buffer, spliced with `copyWithin` exactly as `terrainMeshes.ts` packs
chunks into a super-mesh, and re-emitted only when the chunks it stands over
can have changed: the dirty set `applyDirty` already computes, plus every chunk
holding a cell whose water entered, left or changed band, each grown by one
ring of chunks (a marching tile reads the border row it shares with its
neighbour, and a curtain probes up to a cell outside its own region). BOTH the
region's current tiles and the tiles it was last drawn with are tested — a
region that lost every cell it had in a chunk no longer lists that chunk, so
only the tiles it was drawn with can report that its old geometry there is
stale.

**3. THE NETWORK RECOMPUTE MOVED OFF THE MAIN THREAD.** `computeRiverNetwork`
is GLOBAL by nature — a scan of every active cell for local maxima, then a
trace from every spring — so unlike the geometry it cannot be scoped to a
stroke's chunks. Measured at 24–48 ms depending on how much river a world has,
it is over the whole frame budget on its own. It now runs in a Web Worker,
which the purity Q3 established is exactly what makes safe: same heightmap in,
same network out, no state to synchronise, so the answer does not depend on the
thread. The mirror's cells are TRANSFERRED as a copy (the worker never shares
memory with the thread that is sculpting), and `columnSpans` is not sent
because the river math never reads it. **What comes back is not the network.**
The tree is flattened worker-side to three typed arrays (wet cells, their
bands, the river head cells — `render/water/riverSurface.ts`), because posting
~24.5k point objects would put the structured-clone DESERIALISATION back on the
main thread, which is the thread the move exists to unload. Requests coalesce:
one compute in flight, a request made during it only marks "again when this
lands", and an answer whose mirror has since been replaced by a rejoin is
dropped. Where no worker can be started the source falls back to this thread —
slower, never wrong. Tests and previews use that direct source, so there is one
rebuild path rather than a fast one and a test one.

**Result, same fixture:** 235 ms → **3.4 ms** of main-thread work per refresh,
with 48 ms of network recompute off-thread. What remains is the O(wet cells)
walk that stamps the surface into a per-cell table and groups it into regions —
bounded by rivers.ts's own two constants rather than by terrain roughness.
