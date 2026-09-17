# Movement

Settled with the owner. Facts only; history is in git.

## Contract

- One movement loop: `shared/src/steering.ts` (`steerAvoiding`, `followRoute`). Plugins adapt it; they never copy it.
- `TraversalProfile` (`shared/src/traversal.ts`) has these axes: ground classes, minimum height, freshwater, slope limit, and an optional climb rule. Plugins pick a named archetype; they never build a literal.
- Archetypes:
  - Pilgrims, wanderers and grazers: land walker.
  - Yeti: amphibious.
  - Sea kinds and boats: open water.
  - A non-amphibious land monster: river-fording.
- Land walkers refuse ground below band 1.
- Monsters take only the freshwater axis from their profile; `isLairPose` is their constraint.
- Freshwater reaches `shared/` only through `WorldApi.freshwater`. Each cell is `none`, `channel` or `pool`, and pool wins over channel. The map is cached until `riverNetwork()` returns a different object, and cells outside unlocked territory read `none`.
- Plugin world interfaces declare `freshwater`.

## Steering

- `followRoute`:
  - It advances by cell containment and aims at the next cell.
  - It validates one certified edge at a time.
  - It never replans to the mover's own cell.
  - Give-up timers run on its `progressed` flag.
- Separation:
  - It is judged at `stepCells` (required), not at the terrain look-ahead.
  - It uses a snapshot taken at the start of the tick.
  - If every heading is crowded out, a second pass ignores other movers. Terrain is never relaxed.
- Personal space:
  - Wildlife: half the drawn body length.
  - Monsters: `bodyRadiusCells`.
- Boats do not separate while sailing; `makeRoom` (tangential) handles crowding.
- Residual: the separation floor is `selfRadius + theirRadius − 2·stepCells`, so small fish can pass through each other. Sub-stepping would fix it, but that decision hasn't been made.

## Footprints

- Model dimensions are in world units, and are converted with `cellsAcross` at the one place they meet cell space.
- The yeti samples its feet; wildlife samples just inside its body.
- Residual: the wildlife half-extent does not scale with model scale.

## Climbing

- A profile with a `climb` rule may cross any rise, up or down.
  - Walkable rises are walked; only sheer faces are climbed.
  - `climb.ts` defines progress, the profile defines who may climb, and `pathing.ts` defines the price.
- Climb speed = walk speed × `CLIMB_SPEED_FRACTION_OF_WALK` (1/2).
- Fall speed = walk speed × `FALL_SPEED_MULTIPLE_OF_WALK` (3), for every species.
- Both derive from `WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND` (0.5, in `climb.ts`).
- Per-climber speed:
  - Read it with `climbRiseHeightUnitsPerSecond(rule)`.
  - Ibex sets its own `secondsPerBand`.
- Legs:
  - A climb is a vertical face leg plus a horizontal lip leg, never a diagonal.
  - Descents add a turn of `CLIMB_TURN_SECONDS`.
  - `advanceClimb` owns both axes; `arrived` and `fallen` are terminal.
- The foot is in the low cell. The inset is `climbBodyHalfWidthCells` (measured from the peep), clamped to `CELL_CENTRE_OFFSET`.
- Fall rolls:
  - There is one roll per climb, as a hash out of `FALL_ROLL_BASIS_POINTS` (10 000). No `Math.random`.
  - A second draw from `seed + 1` sets the release point, between 0.25 and 0.9 of the way up the face.
  - Release is tested before arrival, and a fall lands at the foot of the face.
- `climbSeed`:
  - It mixes the mover id, the target cell and a per-mover climb counter, with no clock term.
  - A given mover on a given face always gets the same seed.
- `ClimbWire` is the single wire shape; `falling` is carried explicitly.
- Approach: `approachAndClimb` walks the last fraction of a cell straight, unsteered.
- `beginClimb`:
  - It returns null for every reason not to climb.
  - It shares `climbGeometryOf` with `approachAndClimb`.
- `climbSeconds` sums the legs, so route pricing follows the motion.

## Pathing (`shared/src/pathing.ts`)

- Determinism:
  - Costs are integer-only, and the neighbour order is fixed (N, then clockwise).
  - Heap ties break by f, then h, then cell key.
  - `start` and `goal` are floored to cells.
- Costs:
  - `ORTHOGONAL_STEP_COST` 10, `DIAGONAL_STEP_COST` 14.
  - `SLOPE_COST_PER_HEIGHT_UNIT` = `WORLD_UNIT_CELLS`, which holds the slope-to-distance ratio at 1.6.
  - Profiles with no slope limit (water) skip slope cost.
- Climb cost:
  - It is per second of the climber's own time.
  - The risk term is `CERTAIN_DEATH_COST` × `fallChance`, where `CERTAIN_DEATH_COST` = the widest possible detour.
  - Climbed edges are priced in each direction separately, so descents cost more.
- Diagonals are offered only when both flanking cells pass the full `edgeCost` test.
- Search box: `ROUTE_SEARCH_MARGIN_CELLS` (2 neighbourhoods). A goal that needs a wider detour counts as unreachable.
- `ROUTE_NODE_BUDGET` caps expansions per search and is scaled by `WORLD_UNIT_CELLS`².
  - An exhausted search costs about 24 ms.
  - If that becomes a problem, spread replans across ticks rather than shrinking the budget.
- `RouteBudget` is an expansion pool shared across one caller's turn, repaid in `finally`. The budget is a count, not a wall-clock limit.
- `floodReachableRegion`:
  - It is a prefilter; routes still come from `findRoute`.
  - Flood from the start, never the goal: reachability is asymmetric.
  - Cache ground per cell.
  - Water profiles and climbers read no height.
- `RoutePlan` is exported for future roads.

## Drawn ground (client)

- Anything drawn at ground level reads `ctx.drawnGroundYAt`, which accepts fractional cells.
  - Movers go through `drawnGroundSampler(ctx)` (`client/src/plugins/kit/groundFollow.ts`).
  - Hot paths call `ctx.drawnGroundYAt` directly.
  - The camera also reads `drawnGroundYAt`.
- `ctx.terrainSampleAt` is the raw server height, used only to reproduce server rules (the mana quote, the temple site check). Nothing draws at it.
- `drawnGroundYAt` returns null until every cell the drawn field reads (the cell plus its east and south neighbours) is received and drawn.
- Drawing a chunk bumps `terrainRevisionAt`, so callers use revisions to retry.
- River band surfaces use `drawnBandCapY(band)`.
- Chart readers (lips, rivers, curtains) run on `onChunkDrawn`, never on the dirty set.
- `followGroundY` rate and snap are derived from `TALLEST_WALKED_STEP_WORLD_UNITS`.
- Climb drawing:
  - `client/src/plugins/kit/climbRiser.ts` places a climbing body horizontally, at the first drawn ground above the feet.
  - That point is found with probes at `BAND_GRID_CELLS` spacing between the two cell centres.
  - The offset is eased at walking speed and is applied only while the low cell's own ground is below the feet.
- A swimmer with no known seabed skips the frame.

## Open

- #492: the water curtain reads the drawn band without the arrival check.
- #493: footprint samplers floor their probes, and skip probes that come back unknown.
- #412: the vertical pop at climb start and at arrival.
- Half-cell frame mismatch: movers are drawn at `x * CELL_WORLD_SIZE` with corner-indexed cells, while the terrain is centre-indexed. Fixing it needs its own arc.
- The drawn riser is quantised to ⅛ cell.
