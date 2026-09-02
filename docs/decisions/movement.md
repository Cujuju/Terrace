# Movement

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-20 (movement is one contract; the walkers were frozen)

**The report.** Owner: "my little people seem to get stuck in the middle of
nowhere, and they also tend to run into each other and they tend to walk
through water, which they should not be able to do. They need to path around
the water." Then, on seeing the code: "it would be nice if this pathing code
was semi-generic so that we could add the ability to specify certain rules for
different objects as to what they should and should not go around … the Yeti
should easily be able to traverse water. Same with terrestrial monsters, though
the terrestrial monsters should only be able to traverse the rivers, not the
lakes. Boats should be able to go anywhere in the water. At the moment, they
just kind of spin on top of each other."

**Diagnosis, from the live world rather than from reading.** The real
`server/data/world.db` (snapshot #188, 512², 4557 dry cells) was replayed
through the real sims:

- **Every wanderer in the world froze within 60 s and never moved again** — 16
  of 16 alive at the cap, none ever completing a journey, for the whole 20
  minutes of replay. Traced to a two-tick cycle: the route follower advanced
  its waypoint index on a 0.75-cell proximity radius while orthogonal waypoints
  are 1.0 cell apart, so a walker standing ON a waypoint was already "arrived"
  at the next one and skipped it; it then validated a free-space line to the
  one after that — a segment A* never certified, crossing a 44-unit riser —
  which failed, triggering a replan whose first cell is the walker's OWN cell,
  sending it back where it stood. The give-up timer could not catch it because
  it measured straight-line distance to the goal, which the oscillation reduced
  every other tick.
- **A second, independent freeze in the planner.** A*'s corner-cutting guard
  tested that a diagonal's two flanking cells were walkable GROUND but not that
  they were climbable, so it emitted diagonals whose flanks were cliffs. Legal
  on a grid; impossible for anything that moves continuously, because a body
  crossing to a diagonal neighbour passes through a flank.
- **Nothing anywhere implemented separation.** No mover read another mover's
  position, in any plugin. Boats have the same hole and it is why they spin:
  every boat is sent to the same kraken and told to hold at the same range, so
  they converge on one point of one circle and turn in place together.
- **They were never in the water.** 0 of 95 854 sampled walker positions were
  on a water cell. What they walk on is BAND-0 DRY LAND (height 1 to
  BAND_HEIGHT−1), which `quantizeToBand` draws at exactly SEA_LEVEL while
  `render/water.ts` floats the sea plane just above it — so the fringe every
  shoreline is made of is drawn underneath the sea. 292 of the world's 4557
  dry cells at the time of measurement (BAND_HEIGHT was 64), all coastal, and
  routes hug coasts. `waterDepth.ts`'s claim that "the water plane fails the
  depth test over dry terrain" was false for exactly that band.

**THE ROOT CAUSE UNDER ALL OF IT, in one sentence: four plugins had each grown
their own copy of the same steer-and-veto movement loop, and three of them said
so in their own comments** — boats' `steerToWater` ("Monsters' sweep"),
monsters' `steerToValidHeading` ("this is the pattern, copied, not an import"),
pilgrims' `stepWalker` ("wildlife's veto-the-step shape"), and wildlife's
`movement.ts`. Duplicating the loop duplicated its gaps: only one of the four
ever gained route following, none of them knew any other mover existed, and the
shared `WalkerProfile` could express exactly one ground class plus a slope
limit — which is why every rule the owner asked for was unwriteable.

**The fix is the contract, not the call sites.**

- **`shared/src/traversal.ts` — `WalkerProfile` becomes `TraversalProfile`,**
  carrying four independent axes instead of two: a SET of ground classes, a
  minimum ground height, a freshwater rule, and the slope limit. The archetypes
  every mover uses are named there once — `LAND_WALKER_PROFILE`,
  `RIVER_FORDING_WALKER_PROFILE`, `AMPHIBIOUS_WALKER_PROFILE`,
  `OPEN_WATER_PROFILE`, `waterBandProfile` — and a plugin PICKS one rather than
  building a literal, because building literals is how pilgrims shipped
  wildlife's pre-fix rule the first time.
- **`shared/src/freshwater.ts` — the river network, transposed.** Traversal asks
  a per-cell question; `computeRiverNetwork` answers a per-river one. A cell
  carries `none` / `channel` / `pool`, and pool beats channel where a spillway
  is both. This is what makes "rivers but not lakes" sayable. Optional on
  `TerrainSampler`, defaulting to none, so the axis is additive.
- **`shared/src/steering.ts` — one movement loop.** `steerAvoiding` is the
  sweep, now also refusing headings that land inside another mover, with a
  `permits` hook for the rules that are genuinely a plugin's own (boats'
  unlocked territory, monsters' whole-body lair pose). `followRoute` is the
  route follower, rebuilt: the index advances by CELL CONTAINMENT, it aims at
  the NEXT cell, it validates exactly one certified route edge, and a replan
  never targets the mover's own cell. It reports `progressed` — did the mover
  enter a new route cell — which is what a give-up timer must run on, since
  goal distance can neither survive a real detour (routes on the live world run
  a mean 1.74× and up to 3.57× straight-line) nor detect an oscillation.
- **Separation never freezes anyone.** The sweep runs a second pass ignoring
  occupants if every candidate was crowded out. Terrain is not relaxed on that
  pass. A deadlocked knot of walkers would be the same bug in a new hat.

**Both sides of the water question, owner-chosen.** The render is fixed — the
sea plane is fully transparent over dry cells, so a band-0 flat reads as the
"buildable-looking flat" §4 of the acceptance criteria always claimed — AND
land walkers decline ground below band 1, so they path around anything that
still reads as water. Q3 is untouched: height ≤ 0 is still water. The walker
rule is the narrower true statement (that fringe is land; a land walker just
will not stand on it), and it is a walker rule rather than a ground rule
because the ground classes are shared with everything that swims.

**Per-mover rules as shipped.** Yeti: amphibious — water inside his range stops
being an obstacle. His snowfield confinement is UNCHANGED; that is the habitat
regime and the banishment rule, both settled, and levelling his peaks is still
how he goes. Sea kinds and boats: open water, the whole sea. Pilgrims,
wanderers and grazers: land walkers. A future terrestrial monster that is not
amphibious picks the river-fording archetype, which exists and is tested even
though no shipped kind is its subject — that is what the owner asked for.

**Monsters keep `isLairPose` as their movement constraint** and take only the
freshwater axis from the new profile. Letting the archetype's slope limit
through as well would quietly add a rule monsters have never had (a yeti
refusing a riser inside his own snowfield), which is a gameplay decision nobody
has made.

**Named residual.** Separation is chosen against a start-of-tick snapshot of
everyone's positions — that is what keeps a mover's path independent of where
it sits in the iteration order. Two movers closing on each other can therefore
end a tick up to their combined step closer than their combined radii: a tenth
of a cell on a 0.4-cell gap at walker speed. Closing it would need a second
resolution pass over the whole population and an order-dependent tie-break, for
a tenth of a cell that is invisible at the scale bodies are drawn.

**Measured after the fix, same world, same replay:** 14 of 20 walkers complete
a full round trip (the rest give up honestly on a world that is 1.7% land and
heavily fragmented); 0 frozen; 0 on band-0 ground; minimum observed separation
0.415 cells against a 0.4 target. Before: 0 of 16 completed anything, ever.

**Follow-up 2026-08-21 — the freshwater axis was inert; core now supplies it.**
The axis above shipped as a profile field and a `TerrainSampler.freshwater`
that nothing ever populated: its absent-default is `NO_FRESHWATER`, so every
mover in the running game was answering "no fresh water anywhere". "Terrestrial
monsters may cross the rivers but not the lakes", and land walkers going round
a lake at all, were expressible and not in effect.

Supplied at the CORE layer, not per plugin: `World.freshwaterMap()` transposes
`riverNetwork()` once per network recompute, and `WorldApi` exposes it as a
`freshwater` PROPERTY named to match `TerrainSampler` — so a plugin's own world
interface is still handed straight to `isWalkableCell` with no adapter, the
same structural-typing trick `worldSize` and `heightAt` already use. Rejected:
each plugin building its own map from `riverNetwork()` (four copies of a
transpose, which is the duplication this whole contract exists to end), and
passing a `RiverNetwork` into traversal directly (freshwater.ts's header has
the cost argument — a linear scan per `isWalkableCell`, eight times per A*
expansion against a 4096-node budget).

`WorldApi.freshwater` is the ONLY route by which the map reaches `shared/`'s
predicates, and deliberately so: a `World` publishes `size` where
`TerrainSampler` asks for `worldSize`, so it cannot be handed to
`isWalkableCell` at all — the compiler refuses. One supply route means one
place to check when asking whether the axis is live.

Cache invalidation is by IDENTITY, not a second staleness flag:
`riverNetwork()` already promises the same object between recomputes, so
`cachedFor === riverNetwork()` is the whole test, and there is no copy of the
recompute condition to drift. The map inherits the network's scoping — unlocked
territory only — so a cell nobody has revealed reads `none`, which is the same
answer it gave before rivers existed.

The three plugin world interfaces (`PilgrimWorld`, `LairWorld`,
`HabitatWorld`) now DECLARE `freshwater` even though the field is optional.
Omitting it would still work in the running server and silently not work in
every test that builds a stand-in world — the one place a rivers-vs-lakes
regression would be caught.

**Follow-up 2026-08-21 — wildlife is on the contract, and separation was
measured at the wrong distance.** Wildlife was the fourth copy of the sweep and
the one the other three cited when they wrote their own; it is now a thin
adapter over `steerAvoiding`, keeping only what is genuinely its own (the
species → archetype resolution, the unlocked-habitat veto as a `permits` hook,
body size, the school terms, the two-stage contour retry). Personal space is
HALF THE BODY LENGTH as the client draws it, a derived half-extent rather than
a dial, because a small fish is 0.42 cells long and a whale is 5 and one
constant would either let whales overlap or hold fish a whale's length apart.

Migrating it exposed a real defect in the shared contract. `steerAvoiding`
tested separation at the TERRAIN look-ahead point, so whether separation did
anything at all was an accident of the ratio between a mover's look-ahead and
its body. Pilgrims got that by luck — a 0.3-cell probe against a 0.4-cell gap,
so the probe never left the exclusion circle and the test read as "is anyone
near me". Wildlife did not: a 1.8-cell probe against a 0.42-cell gap only ever
fired on a creature almost exactly 1.8 cells dead ahead. Measured worst-case gap
inside a school of five small fish, 100 trials: **0.033 cells, i.e. nothing.**

The fix is a required `stepCells` on `SteerOptions`, and separation is now
judged where the mover will BE rather than where it can SEE. Terrain keeps the
look-ahead, which is a different question with a different right answer — a
mover must see a cliff while there is still room to turn. Same measurement after
the fix: **0.290 cells.** Required rather than optional-with-a-default because
the only available default is the look-ahead distance, which is the defect
itself; `followRoute` already carried the field, so pilgrims' routed walkers got
it for nothing, and monsters state their step even though they supply no
occupants (the day they do, it is one line, not a silent no-op).

**Boats do NOT separate while sailing, and that is a division of labour.** With
the contract fixed, boats' sail-phase separation began bending the radius they
were closing on: measured at 5.03 cells against a 5.00-cell station, past
`BOAT_ENGAGEMENT_RANGE_CELLS`, and the fleet stopped routing the kraken at the
predicted time. `makeRoom` is this fleet's one anti-crowding rule and its whole
design is that it moves TANGENTIALLY, preserving range exactly, for precisely
that reason. Sailing is the radial motion; a crowd term inside it can only
express itself by bending the radius. So closing on a station ignores other
boats and holding one ignores everything else. Named cost: two boats converging
from different villages may pass through one another on the way, resolved by
`makeRoom` the moment either arrives.

**A residual the arithmetic cannot remove.** The observable separation floor is
`selfRadius + theirRadius − 2 × stepCells`, which goes NEGATIVE for a mover
whose step exceeds its own radius. A pilgrim steps 0.05 against a 0.4-cell gap
(floor 0.3 — bodies genuinely never merge). A small fish steps 0.3 against 0.42,
so two fish closing head-on can pass through each other inside one tick whatever
either picks: at that speed the body is smaller than the distance it teleports.
Separation still measurably shapes where they swim, which is what it is for
here; the only cure for the crossing case is sub-stepping the movement, a
simulation-cost decision nobody has made.

**Monsters now separate too, and it was never as low-impact as "kinds are
singletons" suggested.** Each KIND has one slot, but a HABITAT may hold more
than one kind since the 2026-08-19 per-kind slots: the sea carries the kraken
and Cthulhu at once, both on `OPEN_WATER_PROFILE`, both free to occupy the same
basin — and two seven-cell bodies were swimming straight through one another. A
monster's personal space is `bodyRadiusCells` (half its footprint), the radius
`isLairPose` already uses, rather than a second figure the two rules could
drift apart on. The residual does not bite here: a monster ambles at most 0.6
cells/second, so one tick is 0.06 cells against radii measured in whole cells.

## Decisions made 2026-08-22 (the walkers were probing a quarter of their feet)

- **Two walker footprints were stated in world units, named in cells, and
  consumed as cells** — `YETI_FOOT_GROUND_HALF_EXTENT_CELLS` (monsters) and
  `WALKER_FOOTPRINT_HALF_EXTENT_CELLS` (wildlife). Both are model dimensions,
  and a model dimension has been WORLD UNITS since the 2026-08-21 re-sample cut
  a cell to a quarter of one; both were handed straight to a function that adds
  them to a CELL coordinate. Every walker in the game therefore probed a quarter
  of the ground it stands on, and could stand a band below a riser its own body
  overhung — which is precisely the clipping bug `walkerGroundY` was written to
  prevent, reintroduced underneath it by a units change three months later.

  **Root cause, in one sentence that names no callsite:** a distance crossing
  the model↔board boundary skipped `cellsAcross`, the one conversion every
  physical distance in this codebase is supposed to go through, and its NAME
  asserted the wrong side of that boundary — so the value was wrong and the
  compiler, the reviewer and the tests all read it as right.

  **Fixed at the boundary, not at the callsites.** Each constant is renamed to
  drop the `_CELLS` it never earned and states world units; the single place it
  meets cell space converts once. The names now disagree loudly with a misuse
  instead of endorsing it.

  **The tests were part of the failure, so they changed shape.** Both plugins'
  fixtures pinned an OUTCOME on a hand-written height field, and both passed
  with the wrong number — the yeti's because 1.02 still reached the neighbouring
  cell, wildlife's because its "well clear of the boundary" case was only clear
  of a footprint a quarter of the true size (it moves from x = 9.0 to x = 8.0,
  and the move IS the bug). Each plugin now also pins the CONVERSION itself, and
  that the half-extent exceeds one cell — a walker that does not overhang its
  own cell is not a walker whose footprint needs sampling.

  **Found by the yeti rescale**, which is worth recording: at quarter size his
  wrong half-extent stopped reaching any cell but his own and the fixture
  finally failed. A four-times-too-small probe is invisible until the thing it
  measures gets small enough that a quarter of it is nothing.

  **Not changed:** the two plugins sample different extents on purpose — the
  yeti samples his FEET (a walker stands on what it steps on; his shoulders
  overhang bands his soles never touch), wildlife samples just inside the BODY.
  Both are stated in their own files and both are defensible; unifying them is a
  design decision, not a units fix. Nor does wildlife's half-extent scale with
  `WILDLIFE_SIZE_MODEL_SCALE`, so a large creature (1.4×) still probes a medium
  one's footprint — noted, not fixed, and the residual is one band of clipping
  on the biggest land animals at a riser's edge.
