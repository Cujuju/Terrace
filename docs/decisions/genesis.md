# Genesis

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-25/26 (archipelago genesis, and MIN_WORLD_SIZE, #181)

**Supersedes:** the 2026-08-19 starter-profile decision (the fixed shelf/slope
inside the unlock square), the exact day-one habitat census the wildlife plugin
asserted against it, and — from 2026-08-26 — the promise that a fresh world's
starter square holds a whale pair. The 2026-08-19 kraken-basin guarantee
survives unchanged in its rule; only where it is enforced moved.

**The owner's report (2026-08-25).** "New worlds should not have just a single
starter square; they should have islands — not just a single island. They should
also have some random trenches, and the depth of the sea should vary."

**The owner's review of the first attempt (2026-08-26).** Not merge-ready: the
starter square rendered as a hard-edged rescaled rectangle with stamped disc
islands, and half the seed sample was near-landless at 1.4% land. Three things
came out of it, and they are the shape of what shipped: **drop the day-one
whale-pair guarantee**, make guaranteed islands **noise-shaped, not stamped**,
and put a floor under the **world-wide land fraction**.

**One noise field, edge to edge.** The fixed shelf/slope/abyss profile inside the
starter unlock square is gone, and with it the clamp that pinned that square to
deep water. Genesis is now five octaves of integer value noise at
256/128/64/32/16-cell lattice spacings, each at half the amplitude of the one
before it, summed (not averaged — averaging shrinks relief by the same factor it
shrinks any variance, and measured, it left land on 1.2% of a fresh world's
cells) and clamped to the amplitude limits. The wander is symmetric about the
baseline rather than drawn from the lopsided amplitude range, so the baseline is
the height the world actually averages. Everything is still integer band
offsets, exact band floors, fixed RNG draw order, pure in `(size, seed)`.

**Flat worlds retired, and this is a reversal.** "It's OK to create flat worlds"
(owner, 2026-08-18) does not survive the two whole-world guarantees below: land
and a kraken basin sit on opposite sides of the deep-water line, and a field with
less relief than that distance can keep neither — lifting it to make land removes
the basin, lowering it to make the basin removes the land. `roughness` therefore
has a floor, `GENESIS_MIN_ROUGHNESS`, derived as exactly that distance measured
in coarse-octave amplitude. The world at the floor is still very calm; it is no
longer featureless. Above the floor the draw is square-rooted, which keeps calm
worlds rare rather than a fifth of all worlds (measured over 200 seeds).

**Four passes, all on the 2026-08-19 trench-pass contract** — derived from
`(size, seed)` by integer arithmetic with no further RNG draws, fixed iteration
order, total-order tie-breaks, and a no-op where the noise already qualified:

1. **Land.** At least `GENESIS_MIN_LAND_PERCENT` (8%) of the map is dry, reached
   by a single whole-band LIFT of the noise baseline — the smallest that clears
   the floor. A monotone shift of the whole field: nothing is stamped, no shape
   is invented, every contour the seed drew is exactly where it was and the water
   is lower against it. Computed from a histogram of the unclamped band sums, so
   one pass answers the question for every candidate lift at once. Eight per cent
   because Earth is 29% and a world of islands belongs well below that, while a
   default 512-world-unit map at 8% carries ~200 islands' worth of land — land
   within sailing distance of wherever the reveal takes a player — and still
   leaves 92% ocean for the water mechanics.
2. **Basin.** The kraken needs one CONNECTED ocean of
   `GENESIS_TRENCH_MIN_BASIN_CELLS`, and the trench pass cannot supply it: a
   trench only lowers cells that are already deep, so it can deepen an ocean but
   never merge a fragmented one. An island-rich map is a map of small seas —
   measured, 22 of the monsters suite's 48 probe seeds. So where no ocean is
   lair-sized, the field is DROPPED around the world's lowest cell by the same
   terraced lift the islands use with its sign reversed. Its depth is provable
   rather than tuned, because the amplitude clamp sits between the noise and the
   passes: the field under the drop can be no higher than the amplitude ceiling.
   The anchor is held a full basin radius clear of the map edge — the world's
   lowest cell is very often on one, and a basin centred there is a half-disc.
   The land floor is then topped up, bounded, since the drop costs land.
3. **Islands.** The starter square holds `GENESIS_MIN_STARTER_LAND_CELLS` of land
   in landmasses of at least `GENESIS_MIN_ISLAND_CELLS` — restated from the
   wildlife plugin's `MIN_FOUNDING_HABITAT_CELLS`, so an island is by definition
   somewhere a founding population could live. Short of that, the field is LIFTED
   around the shallowest candidate site until it isn't. **Lifting, not stamping**,
   is the whole of the 2026-08-26 fix: taking the maximum of the terrain and a
   cone puts the cone's own contour on the map, so it renders as a disc with a
   halo however the cone is jittered; ADDING the lift to the field's band offset
   before the waterline moves the field's own contour lines, so the coast is the
   seed's terrain raised and comes out as ragged as everything around it. Sites
   are tried shallowest-ground-first, which is both the cheapest lift and where
   an island would naturally be.
   It counts LAND rather than landmasses, and that is a correction: a landmass
   COUNT is not something a lift can deliver — on a seed whose starter square is
   one continent, every extra lift joins that continent and the count never
   moves. Counting land terminates and asks the question that matters.
4. **Trenches.** The kraken trench where the noise fell short (rule unchanged),
   plus `GENESIS_EXTRA_TRENCH_MIN..MAX` (1–3) extras at seed-chosen basins,
   anchors and axes — the owner's "some random trenches".

**What was dropped, and what it costs.** The day-one habitat minima are gone:
genesis no longer promises the starter square any particular amount of shallow or
deep water. The arithmetic that killed them is worth recording — two whales want
64 000 of the square's 102 400 cells (62.5%) and a fish school 32 000 more, which
left 6 400 for land and forced a rescale of most of the square on most seeds. The
rescale is what drew the rectangle. So: **whales arrive with territory creep**,
the same answer the kraken has always had, and the wildlife densities that decide
them are untouched. A seed that draws an abyss in the starter square still opens
with whales; one that draws shallows opens with fish. What a fresh world always
has is land a founding population can live on, which it never had before.

**MIN_WORLD_SIZE, issue #181.** `WORLD_SIZE=256` booted an all-ocean world,
because the 20-chunk starter unlock footprint clamped to the whole map and
genesis had no outside left to draw. The floor was one CHUNK — true about masks,
silently false about terrain. It is now derived: the starter footprint span plus
one NEIGHBOURHOOD ring on every side, 320 + 2 × 64 = 448 cells (112 world units),
a whole number of chunks by construction. A ring of the COARSEST noise octave was
the first derivation and is wrong — that lattice is four neighbourhoods, so it
would have put the floor at 208 world units and forbidden the 128-world-unit map
this document calls the Populous-proven playable minimum. Below the floor the
boot fails through the existing config validation.

**Tests moved from geometry to guarantees.** `server/test/fresh-world.test.ts`,
`plugins/wildlife/test/wildlife.test.ts` and
`plugins/monsters/test/monsters.test.ts` no longer assert cell-for-cell shelf
positions or exact habitat totals; they assert the guarantees above, plus what
was always the point — every height an exact band floor inside
`[MIN_HEIGHT, MAX_HEIGHT]`, reproducible from a seed, different across seeds, and
never without deep water somewhere. Two are worth naming: **"lifts the terrain
rather than stamping a shape on it"** (islands raised by the same lift on
different ground must come out different sizes, which a stamp can never do) and
**"leaves no seam at the starter square edge"** — measured against columns a
whole coarse-lattice period away, because bilinear interpolation makes the height
gradient change at every lattice boundary and the footprint edge is one of those
columns, so the naive comparison fails on terrain that has no seam at all.
Wildlife's day-one census now expects land and grazers, which a fresh world has
never had.

**Rejected alternatives.**
* *Keep the fixed starter profile and put islands only outside it.* The starter
  square is the entire world a player can touch on day one, so an island the
  player cannot walk to is scenery. It also preserves precisely the "single
  starter square" the owner complained about.
* *Stamp a fixed archipelago template into every starter square.* Deterministic
  and two lines shorter, and every world would wear the same islands in the same
  places — the defect this change exists to fix.
* *Float simplex/Perlin noise.* Better-looking gradients, and it puts accumulated
  float error into the one part of the codebase whose whole contract is that
  identical inputs give identical outputs. Integer value noise with integer
  bilinear weights keeps genesis on the same footing as the rest of the terrain
  math.
* *Bias the baseline's draw range so land is likelier, instead of the land pass.*
  Cheaper, guarantees nothing, and it removes the low-baseline deep-ocean worlds
  the sea's depth variation comes from.
* *Let the land floor and the kraken basin share one dial.* The first attempt did
  — it walked the land lift back down until a basin appeared — and it cost the
  land floor on exactly the seeds that needed it. Two guarantees pulling in
  opposite directions cannot share a parameter; the basin got its own pass.
