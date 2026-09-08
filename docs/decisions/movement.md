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

## Decisions recorded 2026-09-07 (climb and fall rates; comment migration from climb.ts / pathing.ts)

Everything below was already settled; it is moved out of the comments in
`shared/src/climb.ts` and `shared/src/pathing.ts` verbatim in substance, plus
one new decision (climb and fall rates) at the end.

### Why climbing exists (2026-09-05)

**The ask.** Owner: "peeps need to be able to climb anything … and I think I
would even like them to be able to slowly climb sheer walls with maybe a
fifteen percent chance of falling and dying."

**Measured on the live world** (frostwick-hollows, snapshot 990): the land a
`LAND_WALKER_PROFILE` leaves connected is shattered — 35 617 separate regions
over 66 255 walkable cells, 28 157 of them a single isolated cell, and the
LARGEST reachable region is 4.3 % of the land and spans exactly ONE terrace
band. A walker's gradient limit is `LAND_WALKER_MAX_GRADIENT_PER_CELL` (2
height units per cell) while relaxation leaves adjacent cells differing by up
to `MAX_STEP + RELAX_SLACK` (5) and the renderer draws in steps of
`BAND_HEIGHT` (16) — so 68 % of adjacent land pairs are refused outright, and a
band change, which is every visible step in a terraced world, is EIGHT TIMES
the limit and can never be crossed at all. That is the "they seem to always be
confined to one layer" the owner saw.

**The rule, and where it lives.** A profile that carries a `climb` rule
(`traversal.ts`'s `ClimbRule`) may cross ANY rise, up or down, by climbing it
instead of walking it: slowly, at `CLIMB_SECONDS_PER_BAND`, and with one roll
of that rule's `fallChance` at the foot of the wall. How a climb PROGRESSES is
`climb.ts`; WHO may climb is a profile; what a climb COSTS a route is
`pathing.ts`. Three files, one rule each, so a mover cannot be given the
ability without also being priced for it.

**"Walkable" is the climber's own figure**, and for a climber that is every
slope the world can grow (`traversal.ts`'s `walkableGradientLimit` and
`SHEER_RISE_HEIGHT_UNITS_PER_CELL`), so a band crossed over ordinary ground is
WALKED at walking pace and only a sculpted, sheer face is climbed — the owner's
rule of 2026-09-05, and the reason `climb.ts` needs no rate of its own for
gentle rises.

**Descent is a climb too.** A wall refused on the way up is refused on the way
down by the same symmetric |dh| test, so a climber that could only go up would
strand itself on the first ledge it reached. Same speed, same roll: letting go
of a cliff face is what kills you, and that is as true downward.

**Determinism.** No `Math.random` anywhere: the fall is decided by hashing a
caller-supplied seed (`rng.ts`'s `hashToIndex`, the same murmur3 finalizer
every seeded thing in this repo uses), so two servers fed the same streams kill
the same peep on the same wall — the property plugins/pilgrims' simulation
header already promises for everything else it does.

### Climb legs trace the band's profile (2026-09-06)

Owner, rejecting the diagonal `climb.ts` used to draw: "since it's a sheer
face, try to draw it to the profile of the band." A climb is a VERTICAL leg
against the face and a HORIZONTAL leg across the lip, never one diagonal
through the rock corner; `advanceClimb`'s leg tables are that shape written
down. An ascender walked up to the face, so it starts on it; a descender is
standing on the lip facing the drop, so it turns about, backs over the edge,
and steps off the face onto open ground at the bottom.

Coming over the lip costs exactly one band of this climber's climbing time;
stepping off at the bottom is the shorter half of the same cell, pro rata.
`CLIMB_TURN_SECONDS` is a quarter of a band's climb — long enough to read as
turning about, short enough not to read as a pause; ascents never pay it,
because they already face the wall they walked up to.

**`advanceClimb` owns the horizontal too**, and that is the fix rather than a
convenience (owner, 2026-09-06: "I don't want a model sitting in place for 4 s
as it climbs only for it to pop to the next level"). Every caller used to place
the mover on the target cell itself, in one frame, on the tick that returned
`'arrived'` — three plugins each writing the same teleport, and no place where
topping out could be written once. A tick may span a leg boundary, so the legs
run in a loop off one budget of seconds: the body does not stall for the
remainder of a tick at the corner. `'arrived'` and `'fallen'` are both
terminal — a caller that keeps ticking a finished climb gets the same answer
again rather than a moving corpse.

### A rate per climber, not one for the world (2026-09-06)

Owner: "Ibex are known for being incredible jumpers." The default stays
`CLIMB_SECONDS_PER_BAND` and every profile that does not ask for another one
keeps it exactly, so the widening costs the peep and the yeti nothing; what it
buys is that an animal whose whole character is HOW it gets up a wall can say
so in the one place the climb is defined, instead of the client faking a leap
over a crawl. Ask `climbRiseHeightUnitsPerSecond(rule)`, never
`CLIMB_RISE_HEIGHT_UNITS_PER_SECOND` directly, wherever a particular climber's
speed is meant — the constant is the default, not the answer.

### The body half-width inset

**Measured off the model, not chosen.** Rudy's torso is a sphere of 0.125
scaled 0.95 on its facing axis (`plugins/pilgrims/client/models.ts`), drawn at
`PILGRIM_MODEL_SCALE` 0.85 — so 0.125 × 0.95 × 0.85. Rudy rather than Uno
because Rudy is the deeper of the two peeps and neither may enter the rock. It
is a NUMBER, NOT AN IMPORT, because `shared/` may not read client geometry; if
the peep is remodelled it has to be re-measured.

**A body dimension, and the only thing that may be passed here.** It used to be
an argument, and all three callers handed it a crowding radius —
`WALKER_PERSONAL_SPACE_CELLS` at 0.68, wider than the half-cell it is
subtracted from, so the inset went negative and every climber hung 0.68 cells
out in the air instead of touching the wall (measured 2026-09-06). An argument
three callers get wrong the same way is the API's bug, so the argument is gone.
It comes to 0.404 of a cell: a peep is nearly as deep as a cell is wide, so a
climber's centre barely leaves its own cell centre. A climber that is not a
peep says so on its rule rather than at the callsite, and
`climbBodyHalfWidthCells` CLAMPS to `CELL_CENTRE_OFFSET` so a future animal
that declares a body wider than a cell stands on the edge rather than off the
wall.

**The foot belongs to the LOW cell of the pair**, always, up or down. Computing
it in the MOVER's cell is correct going up and buries a descender in the rock
column it is standing on (measured 2026-09-06: the foot landed inside the high
cell, so the body sank through solid rock for the whole descent and appeared at
the bottom). The face leg therefore pins x and y and moves only height, at that
foot, so the body is against the wall in open air rather than inside the rock.

### The fall

**One roll per climb**, whatever the wall's height — the owner's rule, and the
4:1 sheer face is what guarantees there is a wall to roll against at all
(`ClimbRule`'s own comment). A climb of forty bands is the same single roll as
a climb of four.

**`FALL_ROLL_BASIS_POINTS` = 10 000.** A `fallChance` is a fraction and
`hashToIndex` returns an integer, so the comparison needs a scale. 10 000 makes
every chance the owner has asked for (15 %, 5 %, 1 %) exact rather than
rounded, and leaves three more decimal places for any future one.

**Release height: not at the top and not at the bottom.** A climber that always
fell from the last inch would read as being pushed off the ledge, and one that
fell in the first inch would read as never having started; both make the fall
look like a bug rather than a slip. The fraction is HASHED per climb between
`FALL_RELEASE_MIN_FRACTION` (0.25) and `FALL_RELEASE_MAX_FRACTION` (0.9), so
consecutive falls on the same wall let go at visibly different heights, and it
is measured up the FACE so a descender that lets go has also let go part way up
the wall rather than part way through its own journey. The draw is a second,
independent one off the same seed — the first decides WHETHER, the second
WHERE; `seed + 1` rather than a second seed argument because `hashToIndex`'s
mix is an avalanche, so consecutive seeds land far apart. The release is tested
BEFORE arrival: a release and a target within one tick of each other must still
fall, or a fast enough tick would quietly save the climber. A fall lands at the
foot of the FACE whichever way the climb was going, which is what `lowHeight`
means and why the direction is not read off `fromHeight`.

**`climbSeed` is one rule for every climber** rather than one per plugin,
because the property it has to have is subtle enough to be worth writing down
once: STABLE for a given mover on a given face (so a climb cannot be re-rolled
by re-entering the branch that starts it) and DIFFERENT for the next one (so a
mover that meets the same wall twice is not fated to the same outcome).
`discriminator` is whatever the caller has that moves on between climbs — a
mover id, a route index — and mixing it in is what buys the second half. NO
CLOCK TERM anywhere, so a replayed server kills the same mover on the same
face. The shape every caller uses is a mover id mixed with the cell it is
climbing onto and a per-mover climb counter; see plugins/pilgrims'
`climbSeedFor`.

### The climb wire

**One shape for every wire**, because there are six places a mover's climb is
serialised (pilgrims' three walker kinds, monsters, wildlife's population and
its flocks) and a field added at five of them is a bug at the sixth. Each
protocol still declares its own fields — `ClimbWire` only decides what goes in
them. `falling` IS NOT INFERRABLE FROM `climbHeight`, which is why it is on the
wire: a descent is a climb whose height is also falling, at a different rate
(`FALL_DROP_HEIGHT_UNITS_PER_SECOND`), so a client watching the height alone
would have to guess a rate from two snapshots and would guess wrong at the
first tick of every fall — the same argument that put `climbHeight` on the wire
rather than deriving it from the ground.

### Why the approach lives in `climb.ts`

Every steering sweep in this repo looks for a heading that is legal to WALK,
and beside a wall there almost always is one — along the foot of it. Left to
the sweep, a climber with a wall in its way simply slides sideways along the
cliff for ever (measured on the pilgrims sim before `approachAndClimb` existed:
200 of 200 walkers, none climbing, none arriving). So the decision to climb is
taken by whatever knows the way on — a route, a goal bearing — and the last
fraction of a cell is walked STRAIGHT, unsteered: the destination is a point
inside the cell the mover is already standing in, which is ground it has
already been certified on, so there is nothing for a sweep to discover.

Where it walks to depends on the direction. Up, that is the foot of the face.
Down, it is the middle of the lip the mover is already standing on, so the
reverse mantle always has the same width of ledge to back across. Also
`Math.sqrt`, not `Math.hypot`, per the determinism rule `traversal.ts` states
at its own use of it.

`beginClimb` returns null for EVERY reason a climb is not the answer, and the
caller treats them all the same way (keep walking, or give up): the profile
cannot climb, the target is not ground this mover may stand on at all (water,
the wrong band, a river — climbing does not make a lake crossable), or the step
was never blocked in the first place and is simply walkable. One derivation
(`climbGeometryOf`) serves both the test and the act, because
`approachAndClimb` needs the foot before a climb exists and `beginClimb` needs
it again to start one; deriving it twice is how the two came to disagree about
which cell the foot is in.

`climbSeconds` adds the legs up, so a change to the motion cannot leave the
route planner pricing a climb that no longer exists: the face is the rise at
the climber's own rate, the lip is one band of that rate, and a descent also
turns about and steps off at the bottom.

### The cost model in `pathing.ts`

**Routing exists to go AROUND obstacles** (owner, 2026-08-19: "anything
traveling across the map — whether it be a pilgrim or wildlife — attempts to go
around obstacles instead of over or through them. That would also allow us to
add roads that actually look like something"). `traversal.ts` answers "may I
stand here / cross this one step"; `pathing.ts` answers "what SEQUENCE of steps
gets me from A to B", preferring gentle ground over steep-but-legal ground so
the chosen route is the one a road would plausibly follow. A greedy per-tick
local probe (the shape both plugins had before this file existed) can only ever
react to what is immediately ahead — face a cliff, turn, re-approach,
oscillate. A* over the traversal contract plans the whole leg before a single
step is taken.

**Determinism contract:** integer-only cost arithmetic (no Euclidean/√2 in the
cost function), a fixed neighbour scan order, and an explicit, total tie-break
in the open-set priority queue (f, then h, then a cell-key ascending fallback)
— so two callers searching the same heights from the same start/goal get a
byte-identical route, not merely "a shortest route", every time.

- **`ORTHOGONAL_STEP_COST` = 10** — the classic integer "octile distance" scale
  (Euclidean step cost ×10, rounded), chosen SPECIFICALLY so the diagonal cost
  can be an integer too: √2 has no exact integer ratio to 1, so representing
  both costs as small integers rather than floats needs a common scale where
  the rounding error is negligible relative to the cost itself. Kept out of the
  walker-visible API (`RoutePlan.cost` is "cost units", not cells or seconds)
  precisely so this scale is free to change.
- **`DIAGONAL_STEP_COST` = 14** ≈ 10·√2 (13.94, rounded) — the standard octile
  approximation. Rejected alternatives: 10 (equal to orthogonal) would make
  diagonal movement strictly dominant, producing needlessly diagonal-heavy
  routes even where a straighter orthogonal jog is just as short; 20 (2×
  orthogonal) would forbid diagonal cutting entirely, which is worse than
  Euclidean and produces visible staircase detours around anything a true
  diagonal could clear in one step.
- **`SLOPE_COST_PER_HEIGHT_UNIT`** was chosen against MAX_STEP-scale climbs,
  not against the base move costs directly. The ratio that decides route shape
  is the penalty for climbing one WORLD UNIT at the steepest legal land grade
  against what it costs to walk one world unit on the flat, and it is 1.6:
  before the 2026-08-21 re-sample that was +16
  (`LAND_WALKER_MAX_GRADIENT_PER_CELL` over one cell) on a base 10, and it is
  the same 1.6 now, spread over the four cells a world unit is sampled by. That
  is enough that two world units of flat detour already beat one world unit of
  max-gradient climb, and a short flat detour beats a short steep one by a
  wide, visible margin, without so overwhelming the base cost that gentle
  rolling terrain gets penalised into looking like a wall. WHY IT IS DERIVED
  (2026-08-21): height units did not get finer and steps did, so leaving it at
  a literal 1 would have quartered the slope term's weight against distance —
  a different pathfinder, with walkers taking the steep way because the gentle
  way now counts four times the steps. Skipped entirely for a water-ground
  profile (`maxGradientPerCell = Infinity`): water has no risers.
- **`WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND` = 0.5** — plugins/pilgrims'
  `PILGRIM_WALK_SPEED_CELLS_PER_SECOND`, RESTATED because `shared/` may not
  import a plugin, and the peep is the canonical land walker this cost model
  has always been reasoned about (see `SLOPE_COST_PER_HEIGHT_UNIT`, argued in
  peep-sized detours). It prices TIME ONLY: what it decides is how many cells
  of a mover's OWN walking a climb is worth — a ratio that barely moves across
  the shipped speeds (a yeti ambles at 0.45, an ibex trots faster) and would
  only change which of two nearly equal routes wins. As of 2026-09-07 it lives
  in `climb.ts`, because the climb and fall RATES now derive from it too.
- **`CLIMB_COST_PER_SECOND` is per SECOND rather than per height unit** since
  climbers gained rates of their own. The time term is DERIVED, NOT TUNED:
  `ORTHOGONAL_STEP_COST` buys one cell of flat walking, which takes
  `CELL_WORLD_SIZE / WALK_SPEED_FOR_COSTING` seconds; one height unit of wall
  takes `1 / CLIMB_RISE_HEIGHT_UNITS_PER_SECOND`. At the pre-2026-09-07 default
  the ratio came to 5 per height unit — 80 for a whole band, i.e. eight cells
  of detour, which was exactly the four seconds a band the climb then took
  against the half second a cell of walking takes. The height-unit figure is no
  longer a constant, because it depends on who is climbing.
- **The risk term is the point of having one.** Without it a route prices a
  lethal shortcut purely by how long it takes, and a climber walks up a cliff
  to save four cells. `CERTAIN_DEATH_COST` is what a route would pay to avoid a
  CERTAIN death — the widest detour the planner is able to plan at all
  (`ROUTE_SEARCH_MARGIN_CELLS` of flat walking), because a death it cannot plan
  around is one it must simply accept — and a fall chance buys that fraction of
  it. A larger figure would not buy a longer detour (the box is what limits
  that); it would only make every climbed edge look infinitely bad next to
  every walked one, which is the same thing as not being able to climb. At the
  shipped chances a peep (15 %) walks up to 19 cells out of its way rather than
  take a wall, a yeti (5 %) about six, and an ibex (1 %) barely more than one,
  which is the animal each of them is. Every climb rolls, so every climbed edge
  is priced for the risk; there is no height gate, because the 4:1 sheer rule
  is what keeps a knee-high ledge from being a climb in the first place. The
  climbed-edge price is taken SIGNED, not on the magnitude: a descent also
  turns about and steps off at the bottom, so it is the dearer of the two
  directions.

### Search bounds

**`ROUTE_SEARCH_MARGIN_CELLS` = two NEIGHBOURHOODS** — a fixed, generous
multiple of the game's own neighbourhood unit (16 world units of ground: 128
cells since the 2026-08-21 re-sample, 32 before it, the same swing across the
ground either way) — enough room to clear an obstacle several neighbourhoods
wide without letting the search box grow unboundedly with trip length.
ASSUMPTION, named because it is not measured: no telemetry exists yet on how
wide a player-built obstacle typically gets between two points a walker plugin
routes between (tens of cells, per pilgrims' `PILGRIMAGE_CATCHMENT_CELLS` /
wanderers' `WANDER_RANGE_CELLS`). If a shipped world ever shows a walker giving
up on a route that a human would call "obviously reachable by walking a bit
further out", this is the constant to retune. Until then: a destination that
needs a wider swing than this — circumnavigating a whole lake or peninsula —
is DELIBERATELY treated the same as truly unreachable (`findRoute` returns null
and the caller's failure contract takes over), because every shipped walker's
trip is a short local journey (a viewpoint, a neighbouring town), never a
cross-continent trek.

**`ROUTE_NODE_BUDGET`** is a hard cap on nodes EXPANDED (popped off the open
set) by one `findRoute` call — the "bounded work" requirement: a 512² world is
262 144 cells and terrain changes on every sculpt, so an unbounded search per
walker per tick cannot be allowed to exist.

- **Cost model**, benchmarked against the census's own measured rate
  (wildlife's `HABITAT_CENSUS_INTERVAL_SECONDS`: ~262 144 cells in ~1 ms, i.e.
  roughly 262 elementary cell-ops per microsecond on the reference hardware
  that figure was measured on). One expansion does substantially more work than
  one census cell: up to 8 neighbour edges, each running an `isWalkableCell`
  bounds+ground check and (for finite-gradient profiles) a height read and
  comparison, plus one binary-heap push and sift (O(log budget) ≈ 12
  comparisons at this budget) per surviving edge — call it on the order of 100
  elementary ops per expansion, ~10× a census cell. At the census's measured
  rate that puts 4096 expansions × ~100 ops ≈ 410 000 ops at roughly 1.5 ms —
  well under one 100 ms tick (`TICK_HZ` = 10) even if several walkers replan on
  the same tick.
- **That burst is not a steady load:** routes are computed on GOAL-CHANGE
  events (a walker is dispatched, or its leg changes — see pilgrims'
  `pilgrimage.ts`/`wandering.ts`), not once per tick per walker, and a goal
  change happens at most a handful of times over one walker's whole lifetime.
  Bounded further by each plugin's own population cap (pilgrims:
  `PILGRIMS_CAP + WANDERERS_CAP` = 40; wildlife does not use routing — see the
  `movement.ts` contour-following note), so the worst single-tick cost is that
  cap × this budget's ~1.5 ms, itself only reachable if every capped walker's
  goal changed on the exact same tick.
- **A test seam:** `findRoute` takes the budget as an optional last argument so
  a suite can force budget exhaustion on a small, fast search rather than
  construct a full-budget maze.
- **Scaled with the sampling density (2026-08-21).** What the budget really
  buys is a REACHABLE AREA — the ground A* may explore before giving up — and a
  given patch of ground is now sixteen cells where it was one. Left at 4096 the
  walkers would have kept the number and lost the range: every trip's reachable
  radius would have quartered, and "obviously reachable by walking a bit
  further out" would start failing at a quarter of the distance. The budget is
  therefore stated as expansions per unit of ground and multiplied by
  `WORLD_UNIT_CELLS`², holding the area constant at 65 536 expansions.
- **The cost is real and is the price of the range:** the cost model puts one
  exhausted search at ~24 ms rather than ~1.5, so the burst case it bounds —
  every capped walker replanning on one tick — no longer fits in a 100 ms tick.
  It is reachable only by a search that FAILS, which is why it is accepted here
  rather than paid for with range; the fix if a shipped world hits it is to
  spread replans across ticks (a scheduling change in the walker plugins), not
  to shrink the area a walker can see.

**`RouteBudget`: why the per-call budget was not enough (2026-08-29 perf
review, D1/D2).** `ROUTE_NODE_BUDGET` bounds ONE search. It says nothing about
a caller that runs N searches inside a single synchronous call, and that is
exactly what a site scan does — pilgrims' `scanSettleSites` walked 768 anchors
and asked A* about each one. Every anchor that was walkable but not connected
to the walker cost a WHOLE budget (~29 ms measured), so one temple-placement
press blocked the server's event loop for seconds. The bound has to be on the
turn, not on the call, and a pool is the smallest thing that expresses that:
the caller mints one, hands it to every search it makes, and the total spend
across all of them can never exceed what it minted. An exhausted pool (0) makes
every further search return null immediately, which is the caller's signal that
its turn's routing allowance is gone.

**Deterministic by construction, and that is why it is an expansion COUNT and
not an elapsed-time budget.** A wall-clock bound inside `pathing.ts` would make
the route a walker gets depend on how loaded the machine was — the server and a
client replaying the same heights would disagree, which is precisely what the
module's determinism contract forbids. An integer pool threaded through calls
in a fixed order is a pure function of its inputs: the same world, the same
start/goal sequence and the same starting `remaining` give byte-identical
routes every time, on any machine. A caller that genuinely wants a WALL-CLOCK
ceiling converts it to a pool size at ITS OWN layer (outside `shared/`), where
non-determinism is allowed because the number chosen is then part of the input,
not read mid-search. `findRoute` pays the pool back in a `finally` rather than
by a subtraction before each return: the search has four exits (budget, empty
heap, goal, open-set exhaustion) and a pool only paid back on some of them
would drift silently. A bare number is instead this ONE search's allowance —
the original contract, and the test seam.

**`RoutePlan` is EXPOSED** so a future roads feature (mechanics card 29:
"long-lived neighbouring settlements wear footpaths between themselves along
walkable routes") can read the ordered cell list without `pathing.ts` knowing
roads exist — the module never renders or persists a route, it only computes
one and hands back the list. `cost` is in the cost model's own units:
comparable between two routes over the same profile, meaningless outside that
comparison.

### Determinism details in the search

- **`NEIGHBOR_OFFSETS`** is N, NE, E, SE, S, SW, W, NW — clockwise from north,
  alternating orthogonal/diagonal. Part of the determinism contract only in the
  sense that it is FIXED (`rivers.ts`'s `FLOW_DIRECTIONS` precedent); it does
  not affect which route wins (the open-set tie-break does), only the
  incidental order candidate edges are relaxed in.
- **`octileHeuristic`** uses the same integer cost scale as the edges
  themselves, so it never overestimates the true remaining cost: slope cost
  only ever ADDS to an edge's base cost, never subtracts, so ignoring it keeps
  the estimate a lower bound.
- **`hasHigherPriority`** breaks ties by lower f, then lower h (prefer the node
  closer to the goal), then lower cell key (a fixed, arbitrary-but-stable
  ordering over the grid). Because `key` is unique per cell this is a STRICT
  total order — no two distinct entries ever compare equal — which makes the
  heap's output independent of push order and therefore reproducible
  byte-for-byte across runs. The heap itself is array-backed with fixed sift
  operations, with no dependency on Map/Set iteration order.
- **`edgeCost` handles adjacent cells only** — a route edge is always one grid
  step, so the segment-sampling `canTraverseSegment` would degenerate to this
  same single comparison; `edgeCost` is that degenerate case written directly.
- **Stale open-set entries** are dropped by lazy deletion (compare `g` against
  `gScore`), which is cheaper than a heap decrease-key.
- **`start`/`goal` are floored** to their containing cell, and coincident
  start/goal cells return a trivial one-cell, zero-cost route rather than
  running the search.

### Diagonals may not cut a corner (2026-08-20)

A diagonal edge is only offered when BOTH of its flanking orthogonal cells are
cells the walker could ACTUALLY STEP INTO from here — the standard grid-pathing
rule against squeezing diagonally through the corner of an obstacle it could
not pass along either straight edge. "Could actually step into" means the full
edge test (`edgeCost`), not merely walkable ground, and that distinction is a
bug fix: the ground-only version let A* emit a diagonal whose flanks were legal
GROUND but impassable RISERS — e.g. from a cell at height 226 to one at 232 (a
6-unit step, happily legal) with flanks at 258 and 64, both dry land and both
far past the gradient limit. On the grid that is a legal move; to anything that
moves CONTINUOUSLY it is not, because a body crossing from one cell to its
diagonal neighbour passes through one of the two flanks on the way, and both of
these are cliffs. A follower handed such a route walks up to the corner and
stops — which is exactly the "stuck in the middle of nowhere" the owner
reported, arriving by a second road (`shared/src/steering.ts` was the first).
The planner must only ever emit edges the walker can physically take.

### Reachability — the question A* should never have been asked (2026-08-29)

**Why `floodReachableRegion` exists** (perf review, D1/D2). Callers were using
`findRoute` as a reachability test, and it is the most expensive possible one:
proving a cell unreachable costs a whole node budget, because A* has to exhaust
its budget before it can say no. A flood fill answers the same question for a
WHOLE BOX at once, in one pass over that box, and then every candidate in the
box is an O(1) lookup. A scan that asked A* 768 times now floods once.

**It is a PREFILTER, not a replacement.** `has` true means "a walker can reach
this cell somewhere inside the flooded box"; the route itself is still
`findRoute`'s to produce, and `findRoute` searches a NARROWER box of its own
(`ROUTE_SEARCH_MARGIN_CELLS` around the start–goal line), so it may still fail
on a cell this says is reachable. The reverse cannot happen as long as the
caller floods a box CONTAINING every `findRoute` search box it will
subsequently use — i.e. the box around its start and all its candidate goals,
grown by `ROUTE_SEARCH_MARGIN_CELLS`. Then any route A* could have found lies
inside the flood, so the flood reaching nothing proves A* would have found
nothing, and no site A* would have accepted is ever refused.

**Cost is the box, not a budget:** one pass, each cell entered at most once,
eight edge tests per entered cell — so `bounds` IS the bound, and the caller
sizes it. A bounded, predictable sweep replaces an unbounded number of
budget-exhausting searches. It is deterministic: integer-only, a fixed
neighbour order, an array-backed FIFO, no Map/Set iteration anywhere, and the
answer does not depend on visit order in any case. Every cell is enqueued at
most once (marked as it is enqueued), so the queue can never outgrow the box —
a fixed allocation with no growth checks.

**Flood from the search's own START, never from its GOAL (issue #266).** It is
tempting to flood once from a shared destination and let many origins ask about
it — pilgrims' "which of these towns can reach that viewpoint" is exactly that
shape — but reachability over a profile with a finite gradient limit IS NOT
SYMMETRIC: the corner-cutting guard tests a diagonal's flanks against the
height of the cell being stood on, so a corner legal from one end can be
illegal from the other. Demonstrated with the shipped code: two diagonal
neighbours at base and base+MAX_STEP with both flanks at base−MAX_STEP give
`findRoute` A→B a route and a flood from B no way back to A. A goal-side flood
is therefore NOT a conservative prefilter for origin-side searches, and using
it as one silently refuses trips that are walkable. Issue #266 memoises A*'s
own answer instead.

**Flood performance.**

- **Ground classified once per cell, not once per edge.** `edgeCost` re-runs
  `isWalkableCell` and `heightAt` on its TARGET cell every time it is called,
  and a flood looks at every cell from up to eight sides — so calling it per
  edge pays for the same ground test eight times over. Caching the two facts an
  edge actually needs (may a walker occupy this cell, and how high is it)
  leaves the edge test as two array reads and a comparison. Measured on a 421²
  box over an Int16 heightmap: 40 ms per flood before, single digits after. The
  PREDICATE is unchanged — the same `isWalkableCell` and the same gradient
  limit `edgeCost` applies, read from a memo.
- **Neither a water profile nor a CLIMBER consults a height.** A water-ground
  profile has no risers to climb, the same branch `edgeCost` takes on a
  non-finite limit; so does a CLIMBER, because reachability asks whether a
  mover can get there at all, and one that climbs what it cannot walk is
  stopped by no rise, only by ground it may not stand on. (`edgeCost` still
  prices those edges — this is the same predicate, memoised, and it must admit
  exactly what that admits.)
- **Indexed, not destructured.** Array destructuring in the neighbour loop
  builds an iterator per neighbour per cell, and at ~1.4 million neighbours per
  flood that machinery outweighed the ground tests it was fetching offsets for
  (measured: 21 ms per flood with it, 5 ms without).
- **`| 0` is exact integer division** for the row index: index and width are
  both non-negative integers well under 2^31, so it truncates rather than
  rounds — the same value `Math.floor` gives, without the call.

### NEW, 2026-09-07: climb and fall rates derive from the walking speed

**Climb speed is half walking speed.** Owner: "make the climbing one-half the
speed of walking." `CLIMB_SPEED_FRACTION_OF_WALK` = 1/2, and
`CLIMB_SECONDS_PER_BAND` is now `BAND_WORLD_UNITS / (WALK_SPEED_FOR_COSTING ×
CLIMB_SPEED_FRACTION_OF_WALK)` — one second a band, replacing the hand-written
4 s a band of 2026-09-05 ("a brisk scramble", picked over an ordeal, and argued
as "one band of wall costs the same time as eight cells of walking"). A BAND
REMAINS THE UNIT because a band is what a player sees: the terrain draws
quantised to band floors, so every wall in the world is a whole number of them.

**Fall speed is three times walking speed, for every species.** Owner: "animals
… should fall faster than when they walk … two to four times peep walking
speed, and everything should fall at the same speed because gravity."
`FALL_SPEED_MULTIPLE_OF_WALK` = 3 gives `FALL_SECONDS_PER_BAND` = 1/6 s a band,
replacing the hand-written 0.5 s a band. That old figure was written as eight
times the climb rate while there was only one climb rate, and against the new
one-second band it would have EQUALLED walking speed — a fall that reads as a
controlled descent, which is the one thing it must not look like. Gravity
belongs to nobody: the better climber must not also be the faster faller, so
the multiple is off WALKING speed and not off any climber's own rate.

**Both derive from `WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND`, which moved
from `pathing.ts` into `climb.ts`** so the RATE and the PRICE share one input;
`pathing.ts` imports it back for `FLAT_CELL_SECONDS`. Route pricing, the lip
leg, the descent turn and the client's fall tumble all follow automatically,
because each is expressed in terms of the derived constants rather than a
literal.

**Per-species:** the ibex keeps its own `secondsPerBand` of 0.8 s a band on its
rule, so it declares its own character rather than inheriting the default. The
yeti carries no override, so it speeds up with the default.

## Decisions recorded 2026-09-07 (movers draw on the drawn ground; comment migration)

### Movers stand on the drawn cap, not the lattice band

**The root cause.** Ground-standing movers drew themselves at
`ClientPluginCtx.terrainHeightAt` — the cell LATTICE band — while the terrain
draws each band's cap over the SMOOTHED MARCHED CONTOUR. The two disagree by a
full band (a whole world unit of relief) wherever a cell sits on the wrong side
of its own contour: 430 of 6745 probes on the `fork` fixture, per
`client/src/terrain/drawnGround.ts`'s header. A walker there was drawn one band
inside the rock. It was seen descending a mountain; it can happen on any band
edge.

**The contract change.** One oracle for "where does a mover's foot go",
`drawnGroundSampler(ctx)` in `client/src/plugins/kit/groundFollow.ts`, which
reads `ctx.drawnGroundYAt` and never `ctx.terrainHeightAt`. Pilgrims, the
monsters' yeti, wildlife's walkers and the swimmers' seabed sample all go
through it. The kit was already the one vertical contract every mover uses
(`followGroundY`), so the sampler sits beside it rather than in a new module.

**The false premise that is now corrected.** `client/src/plugins/types.ts` used
to say "Anything that STANDS on the ground (a tree, a flame, a marker ring) can
use `terrainHeightAt`: a thing standing up is not seen against the surface
under it." That is wrong — a body standing a band inside the rock is as visible
as a decal floating over it. Both `types.ts` and `client/src/world.ts` now
document `terrainHeightAt` as the lattice band FOR LOGIC (site classification,
gradient tests, ordering) and `drawnGroundYAt` as the only oracle for anything
DRAWN at ground level, flat on it or standing on it.

**Fractional coordinates for a single-cell mover.** A pilgrim's sample is taken
at `(pilgrim.x, pilgrim.y)` rather than at the floored cell. `drawnGroundYAt`
resolves to a quarter cell (`BAND_GRID_CELLS`), so the foot follows the contour
inside its own cell instead of jumping at the cell edge.

**The footprint samplers keep their flooring, and that is a named residual.**
`walkerGroundY` and `swimmerSeabedY` (wildlife) and `walkerGroundWorldY`
(monsters) take the sampler as a parameter and floor each probe —
`Math.floor(x + dx)` — because the old lattice oracle required integer cells.
They now read the DRAWN cap at those integer points, which is the whole-band
fix; but the flooring still quantises each probe to its cell's lattice corner,
so a multi-cell walker loses the sub-cell contour detail a pilgrim now gets.
Removing it would change what "the footprint" means and would break the pinned
fixtures in `plugins/monsters/test/client.test.ts` and
`plugins/wildlife/test/client.test.ts`, which are written against integer-keyed
height maps. Flagged, not fixed.

**Cost.** `drawnGroundYAt` is one `Map` read for the chunk's published cap plan
plus two array reads: `capYAt` resolves through `topLevelIndexAt`, which is an
index into the store's precomputed `Int8Array` band grid, then an index into
`levelCapY`. There is no point-in-polygon walk — that was moved into the
store's rasteriser, once per chunk build. Safe for ~100 wildlife plus pilgrims
per frame, and no memoisation was added.

**Movers NOT converted, and why.** `plugins/tornado/client/index.ts` (a funnel
that travels, placed at `terrainHeightAt(round(x), round(y))`) and
`plugins/mudslides/client/debris.ts` (debris that slides across the ground) are
drawn movers with the same defect. They sit outside this change's named files
and outside its verification scope, and each carries its own written argument
for the old oracle that would have to be revisited. They are the first
follow-up. The static standing placements — fire, saucers' crash burst,
volcanoes' vent, temples, relics, structures, flora — rest on the same
corrected premise and need their own pass.

### Comment migration

Everything below was cut from source comments to bring the touched files under
the repo's comment budget. It is recorded here because it is reasoning, not
because it is still load-bearing beside the code.

**`client/src/plugins/kit/groundFollow.ts`.**
`GROUND_FOLLOW_WORLD_UNITS_PER_SECOND` was a hand-written 1.0, correct when a
walked step could not exceed MAX_STEP + RELAX_SLACK = 5 height units (0.078
world units, eased far inside the 0.5 s a walker spends on a cell).
`SHEER_RISE_TO_RUN` widened a walked step to 64 height units — a whole world
unit, thirteen times as far — and at 1.0 that took a full second, two cells of
walking; 2392 walkable pairs on frostwick-hollows (1.69 %) left the body drawn
more than a whole cell behind the ground. The rate is now derived: the tallest
legal walked step over one cell of walking. `GROUND_FOLLOW_SNAP_WORLD_UNITS`
was likewise a hand-written 1.0 justified by "a four-band gap is never
walking", true until `SHEER_RISE_TO_RUN` made a four-band step exactly a walk,
at which point 344 walkable pairs teleported. The comparison is strictly
greater because the maximal walked step is the case the easing exists to
smooth. `TALLEST_WALKED_STEP_WORLD_UNITS` is written against
`SHEER_RISE_TO_RUN * CELL_WORLD_SIZE` rather than
`SHEER_RISE_HEIGHT_UNITS_PER_CELL` and the client's `HEIGHT_WORLD_SCALE`
because that pairing drags client config, and Vite's `import.meta.env` with it,
into the node test environment this file stays out of.

**`plugins/pilgrims/client/index.ts`.** `HEIGHT_WORLD_SCALE` is restated from
its two `@terrace/shared` inputs rather than imported from
`client/src/config.ts` because that module drags `import.meta.env` into the
plugin's node typecheck and test run — the trap `plugins/mana` carries an
`env.d.ts` for. The client half is wildlife's shape exactly: a client that
misses messages looks stiller, never wrong. `drawnPoseOf` reads off the model's
own root so it is the pose this frame actually put on screen, never a second
derivation — and it answers null for a walker hidden because its ground is
unknown, which is exactly when a flame drawn on it would hang in the air. A
peep being pickable and being publishable as a mover are the two halves of
being able to set one alight and watch it run.

**`plugins/monsters/client/index.ts`.** The dread is the SEA's weather: every
sheet in the bank is authored above `SEA_SURFACE_WORLD_Y` and the effect is
pinned to the waterline, so it is meaningful for exactly the kinds placed
against the sea surface. On the yeti it would be mist at sea level under a
mountain nine bands up — a visible bug, not "atmosphere for a land monster"; a
land creature wanting weather wants a different effect authored against the
ground. Parameterising the height would have made one effect wrong for both.
`MonsterView.variant` is recorded rather than re-derived because a
`MonsterModel` is a root and an `animate()` and remembers no constructor; the
one way a live id's body can change in practice is a client watching a yeti
through a server upgrade, where the pre-variant payload defaulted him. The
rebuild leaves the dread alone because it follows the KIND's placement, and no
sea kind has variants. `reconcileViews` is a general reconcile over a map
because the wire format is a list; the day monster slots became one per habitat
it needed no change, which is what it was written for. `retiringDread` outlives
its monster by `MIST_FADE_SECONDS`, so the list is empty in every frame but the
couple of hundred after a banishment. The per-kind dread spec exists because a
bank authored for Cthulhu's 2.4-cell eye height sat over the kraken's waterline
eyes. `MONSTER_MODEL_DRAW_OBJECTS` is six because the yeti's rig bakes to six
surfaces; kraken three, cthulhu four.

**`plugins/wildlife/client/index.ts`.** The per-species surface table
(`SINGLE_SURFACE_SPECIES = 11`, `TWO_SURFACE_SPECIES = 1`): fish, ibex, bison,
ray, shark, eel, angelfish, the three whale bodies and bird each bake to ONE
surface, because their kit welds every extrusion and `rigSkin`'s material
signature excludes colour (a vertex colour attribute carries it). The deep-sea
angler is the one two-surface herd: its lure material carries
`KHR_materials_unlit`, which three's `GLTFLoader` turns into a
`MeshBasicMaterial` — a different `material.type` from the body's
`MeshStandardMaterial`, so two signatures. The grazer and the wolf are
downloaded files, so their counts are properties of art this repo did not
write; each was checked separately off `RigBlueprint.surfaceCount` (the deer's
seven glTF materials and the wolf's four differ only in base colour). The
budget is a constant rather than `models.objects.length` because `drawBudget`
is a static field the host reads before `attach` builds a pool; `attach` throws
on a mismatch so a species that gains a surface fails at boot. `preload` is
sequential rather than `Promise.all` because the failure a developer actually
hits is a bad asset, where being told WHICH file broke first is what makes the
message useful. `CreatureView.drawnX/drawnZ/drawnY` are held rather than read
back off a transform because a creature is one instance inside its species'
herd and the instance buffer is rewritten from scratch every frame — the eased
value has to be the one this loop last committed. A swimmer with no known
seabed used to be placed against `UNKNOWN_TERRAIN_WORLD_Y`, the sea surface,
which drew a whale lying on top of the sea whenever its whole hull sampled
unsent ground; it now skips the frame. The walker stride is three-dimensional
because measured horizontally it is zero on a climb, where x/y stay pinned at
the foot of the wall, and a climbing ibex rose on frozen legs. Assets are
disposed AFTER the blueprints because a baked surface holds a material clone
that shares the source's texture objects by reference.

**`client/src/plugins/types.ts`.** `SkyRigState` and `GroundShadeDisc` are
defined in the contract rather than in `render/skyRig.ts` /
`render/groundShade.ts` because those modules reach `client/src/config.ts` and
its `import.meta.env`, which a plugin's standalone `tsc`/`vitest` run cannot
evaluate — and `tsc` resolves and diagnoses every reachable file, type-only or
not. `MoverPose`'s `bodyBottomY`/`bodyHeight` are published by the owner
because only the owner knows the drawn scale and where the body sits on its
origin; for a walker the bottom is its feet, for a swimmer the belly line below
a centre-origin hull, for a boat the deck rather than the keel.
`markPickable`'s `occupancy` exists because a raycast descent tests every live
instance — a mature forest is eight thousand of them, 0.72–0.85 ms per pick,
paid in full even when the ray hits nothing, because a world-spanning
population's bounding sphere accepts every ray. `pickWorldCell` exists because
a tree's canopy is drawn above its cell, so at an orbit camera's angle a ray
through it meets the ground several cells behind — aiming at things standing on
the ground was impossible with a terrain-only pick. `cameraPosition` returns a
scratch object because it is asked once per frame by every plugin with a deck.
`applyRevealClip` is core's rather than each plugin's because three of the six
weather plugins draw with stock materials and every one of them wants the same
clip. `publishMovers` is a lookup rather than a list because a position copied
out and re-interpolated drifts away from the body it is attached to — the exact
bug a flame on a running animal would be made of — and it is a neutral
primitive for the same reason `WorldApi.emitEvent` is on the server: a plugin
addresses another by name and validates structurally, never by importing it.
`modulateSkyRig` exists because "who owns the sky" and "who has something to
say about it" are different questions; before it, a second plugin's only
options were to fight for the claim or draw its own dark canopy. `drawBudget`
exists because the per-object cost is `projectObject` to render list to
`setProgram` to uniforms to `drawArrays`, 1.55 ms for 197 calls and 3.10 ms for
340 — 44 % of a 140 fps frame's 7.1 ms, at idle — so the frame budget was spent
by whichever population happened to be largest.

**`client/src/world.ts`.** The sea draws nothing until the first snapshot's
`water.sync`, which replaced the old "the disconnected boot state is a
plausible empty ocean" behaviour. The frontier mist mode is kept in step by a
Solid effect so the panel's `<select>` applies live with no reload, and the fog
starts hidden so the microtask before the first run cannot flash a layer the
player turned off. The reveal mask sits beside the fog because they are the
same fact, synced at the same two call sites; a mask disagreeing with the mist
would draw a plugin's cloud over the very seam the mist covers. `nowMs` uses
`performance.now()` rather than `Date.now()` because these timestamps are only
compared to each other and a wall-clock adjustment must not expire — or
indefinitely postpone — a pending prediction. `applyDirty`'s empty-set guard is
there because `water.refresh` re-uploads its whole world-sized texture per
call, and the authoritative echo of a correctly predicted sculpt arrives with
an empty set several times a second. `fog` and `water` read the MIRROR, which
the caller has already written; the lips, the rivers and the sea's curtains
read the per-chunk CHART, which `meshes.update` only enqueues, so chart readers
are driven by `onChunkDrawn` and never from the dirty set — driving them from
it has them reading the pre-edit chart or the blocky MISSING-CHUNKS fallback.
The prediction sweep is scheduled for the exact moment the oldest outstanding
prediction times out, with no polling interval, because it covers the intents
the server answers with SILENCE: an intent rejected by the unlock mask or
vetoed by a plugin produces no diff by design, so nothing else would take that
prediction off the screen. `carveBandOfPick` applies the two tests only the
world can apply — the overlay's lip proximity for a tread hit, and the server's
own `spanIndexCoveringBand` belt. The arch fixture was once carved into the
mirror client-side because the wire could only carry one height per cell; it is
authored server-side at genesis now. `terrainHeightAt` answers null rather than
band 0 for a never-received cell because band 0 is the sea-surface plane, and a
footprint reader keeping the highest sample read "ground at the waterline" one
cell past the fog frontier. `drawnGroundYAt` answers null rather than the
blocky guess for a received-but-undrawn chunk because the per-chunk revision
counter is bumped when a chunk is dirtied, not when it is drawn, so a caller
that memoised a guess would have nothing to invalidate it with — structures'
survey cache is the case that found this.

## Decisions recorded 2026-09-07 (climbers hold the drawn riser)

### The report

Owner: "Peeps are still climbing in free space, away from the face instead of
on it." Phase 1 (movers stand on the drawn cap) had already landed.

### Two causes, measured

**A. The drawn wall is a staircase, not a plane.** `shared/src/climb.ts` pins a
climber's foot a fixed inset from the LATTICE cell edge (`climbGeometryOf`: low
cell centre + normal * (0.5 - halfWidth)), while the terrain draws each band's
boundary as a marching-squares contour between the two CELL CENTRES, biased by
`CONTOUR_SAMPLE_CLEARANCE` and clamped by `CONTOUR_CELL_CENTRE_GUARD`. Measured
on a stamped sheer 4-band wall between cells 7 (height 0) and 8 (height 64),
through the real `marchLevel` / `smoothLoop` / `groupLoops` pipeline: the four
risers are drawn at x = 7.300, 7.500, 7.700 and 7.875. One wall's face is
spread across three quarters of a cell, and no single inset can hold it.

**B. Movers are drawn half a cell off the terrain's own frame.** The terrain
draws cell `i` CENTRED on `i * CELL_WORLD_SIZE`: `capEmission` writes contour
points as `point.x * CELL_WORLD_SIZE`, `terrain/picking.ts`'s `worldPointToCell`
rounds, `terrain/faceFoot.ts` states "a cell owns the half-cell either side of
its centre", and `plugins/structures` places a building at
`cell.x * CELL_WORLD_SIZE`. The mover sim indexes a cell at its CORNER
(`CELL_CENTRE_OFFSET`, "a mover stands in the middle of one"), so a mover at the
centre of cell `i` has `x = i + 0.5` — and every mover plugin draws it at
`x * CELL_WORLD_SIZE`, which is the terrain's corner between cells `i` and
`i+1`. On the wall above, the server's foot (x = 7.596) therefore puts the
body's front face at x = 8.000: a full cell past the lowest drawn riser and an
eighth past the highest. Facing the other way the same arithmetic leaves the
front face 0.3 to 0.9 cells SHORT of the rock — the "climbing in free space"
the owner reported; facing east the body is inside the hill instead, where it
cannot be seen to be wrong.

This is a defect of every mover, not only of climbers: a walker standing at the
centre of a cell beside a cliff samples `drawnGroundYAt` half a cell into the
cliff's own contour, so phase 1's vertical fix draws it up on the wall's cap.
It is NOT fixed here — see the residuals.

### The contract

`client/src/plugins/kit/climbRiser.ts` owns where a climbing body is DRAWN
horizontally, exactly as `groundFollow.ts` owns the vertical. The server still
owns the climb itself: height, legs, timing, fall, landing cell, the wire x/y.
The kit answers in the TERRAIN's frame — the low cell of the pair is drawn at
its own integer coordinate, the riser is `along` cells from there, and the
body's front face is put on the riser — so the arithmetic never reads the
wire's own along-axis position and stays right if cause B is ever fixed. Across
the climb axis the wire stands unchanged.

### Which riser, and how it is found

**The rule: the first drawn ground ABOVE THE FEET, walking from the low cell's
centre toward the high one's.** It needs no band arithmetic, no threshold
lookup and no seabed-sink special case, and it is the same rule ascending and
descending — a body between two caps is against the riser that joins them,
whichever way it is travelling.

It is asked of `ctx.drawnGroundYAt`, the oracle phase 1 established, at the
drawn ground's own pitch (`BAND_GRID_CELLS`, a quarter cell): four probes from
the low cell's centre to the high one's, and the riser is taken as the midpoint
of the two probes that straddle the step. Measured against the true contours
above, that lands the front face within an eighth of a cell — 7.375 / 7.375 /
7.625 / 7.875 for feet in bands 0 to 3, against true risers of 7.300 / 7.500 /
7.700 / 7.875 — versus 8.000 today. An eighth of a cell is half the grid step
and is the finest answer the oracle has; nothing finer exists to read.

**Rejected: `DrawnGround.loopsAt` plus a segment/loop intersection.** It is
exact rather than quantised, but it needs a new `ClientPluginCtx` method
carrying contour geometry into the plugin contract, it drops holes (`loopsAt`
returns outer rings only, so a climb into a dug pit reads nothing), it needs
the chunk-seam segments filtered out by hand (`isSeamSegment` — a probe across
a chunk border finds the domain edge otherwise, which the fixture shows at
x = 16), and it answers nothing at all for a BLOCKY chunk, which is exactly a
chunk under sculpting load. The `drawnGroundYAt` walk gets holes, seams and the
blocky fallback for free, because the store already resolved them.

**Rejected: computing the crossing from `crossingFraction` in the kit.** That
restates the renderer's own biasing rule and would not see Chaikin smoothing or
the blocky fallback — the four ways-to-disagree list in
`client/src/terrain/drawnGround.ts`'s header.

### Which legs it applies to, without a leg on the wire

The plan offered (a) putting `climbLeg` on the mover wire and (b) inferring the
face leg from proximity to the server's own foot. Neither was taken. The gate
used instead is geometric and exact:

* the mover is on a wall at all (`climbHeight !== null`), AND
* the drawn ground at the LOW CELL'S OWN CENTRE is BELOW the feet — the body
  has left the ground the wall rises from, AND
* some probe between the two cell centres is above the feet.

Leg by leg on an ascent: the face leg passes all three; the lip leg fails the
third the moment the feet reach the top cap (nothing along the pair is above
them), and once the body crosses into the high cell the second test fails too,
because the cell under it is then the one it is standing on. On a descent the
turn leg fails the second test (the body stands on the high cell's cap), the
face leg passes, and the ground leg fails the second test again, because the
feet are back on the low cell's own drawn ground. A fall keeps the hold, which
is right: a body that has let go drops down the face it was on. Every failure
mode is "no offset, draw where the wire says", never a wrong offset.

Rejected (a) because the gate above answers the same question from the drawn
ground with no protocol surface, no version-skew story and no extra bytes: the
wire field would have had to be optional and absent for grounded movers anyway,
since `plugins/wildlife/test/wildlife.test.ts` pins the exact key set of a
broadcast row and the three plugins' parse tests pin the exact parsed shape.
Rejected (b) because proximity to the foot cannot tell a climber at the foot of
a wall from a body that has just topped out onto the ledge below the next wall
— the two are the same distance from the same computed foot.

### The chase

The offset is eased, not assigned. `RISER_SHIFT_CELLS_PER_SECOND` is the
mover's own walking speed in cells (`cellsAcross` of
`WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND`), so a correction never outruns
a walk, and the largest correction on the fixture wall (0.625 cells) resolves in
0.31 s — inside the lip leg's `CLIMB_SECONDS_PER_BAND`. Without it the body
would jump horizontally by up to a cell at every leg boundary and at every band
the climb crosses. The state is one `ClimbRiserShift` per view, beside the
`drawnY` the vertical follower already keeps; pilgrims clear it wherever they
clear `drawnY`, so a walker that reappears over different ground arrives rather
than gliding.

A body first seen mid-climb eases onto the wall from the wire position over at
most half a second, because the shift starts at zero and there is no
first-frame snap. Bounded and self-correcting, so no snap rule was added.

### Cost

Five `drawnGroundYAt` calls per CLIMBING mover per frame (one at the low cell's
centre, four along the pair), each a `Map` read plus two array reads. Nothing
is asked of a mover on the ground, which is what almost every mover is almost
all of the time.

### Residuals, named

* **The half-cell frame mismatch (cause B) is not fixed.** It is a property of
  every mover plugin's draw call, not of climbing, and correcting it means
  moving every mover — and every phase-1 ground sample, every footprint probe,
  every flame and hover ring drawn on a mover — by half a cell in both axes. It
  wants its own arc and its own eyes-on. The climb offset here is computed in
  the terrain's frame and so does not double-count it: fix B and this code
  still puts the front face on the riser.
* **Quantisation.** The drawn riser is resolved to the band grid's step, so the
  front face can sit up to an eighth of a cell inside the rock or off it.
* **The vertical pop at climb start and arrival (#412)** is untouched.
* **Multi-cell walkers' floored footprint samples** (phase 1's residual) are
  untouched: the horizontal offset moves the drawn body, never the ground
  samples that place it.
