# Wildlife

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-21 (whales pod, in mixed sizes — owner request)

**What prompted it.** Three sentences from the owner, after the three whale
bodies shipped: "Drop the number of unlocked cells required. Also add the
ability to spawn different size whales and allow them to school like whales in
real life with different sizes." The first is the day-one-whales problem this
file has been carrying as an accepted loss since 2026-08-19; the other two are
new capability for the species that had neither.

1. **Whale density 5 000 → 2 000 square world units per individual.** A fresh
   world's starter square holds 4 096 square units of open sea, so the old
   figure asked for zero whales and the new one asks for two. The number is not
   lower still because the same density decides a fully revealed world: at
   2 000 a nominal 512² asks for 39 whales against deep-sea's 52, and whales
   stay the rarest species; at the 1 365 that would fit a whole three-whale pod
   on day one they would be the second most common animal in the game. Day-one
   completeness lost to late-game shape, deliberately — the third pod member
   arrives with one small territory expansion. *Rejected:* growing the starter
   square back (it shrank for reveal-pacing reasons that have nothing to do
   with whales), and raising `WILDLIFE_POPULATION_CAP` (it is a bandwidth
   budget, not a tuning dial — see the 2026-08-14 entry).

2. **A whale group is a POD: three, mixed.** `groupSize` 1 → `WHALE_POD_SIZE`
   (3), the smallest group that reads as a family rather than as a pair that
   happened to meet. Sizes are `WHALE_SIZE_WEIGHTS` 3 : 5 : 2 calf : adult :
   bull — the opposite shape to a fish shoal, where the many are the small.

3. **Group size is drawn per member for whales, per group for fish** — the new
   `sizeDraw` field on `SpeciesProfile`. A shoal is size-graded (real ones sort
   themselves, and this is what fish shipped with); a pod is a family with a
   calf in it. Drawing one class for a whole pod would have made every pod
   uniform, which is the one thing a pod never is. The group still has ONE
   class for its school character, and for a mixed group that is its LARGEST
   member: three whales travelling with a bull are a bull's pod.

4. **Schooling probability moved onto the species profile.** It was a global
   table keyed by size class alone — 0.9 / 0.5 / 0.1 small to large — and those
   three numbers are *fish* ecology ("the small ones shoal, the big ones
   don't"). A pod obeys the opposite rule, so keying by size alone would have
   handed whales the solitary large-fish probability and quietly undone the
   pod. `WHALE_SCHOOLING_PROBABILITY_BY_SIZE` is 1 / 1 / 0.75: a pod holds
   together whatever is in it, and the lone full-grown bull is the one real
   exception.

5. **School spacing now scales with the species' body length.**
   `SCHOOL_COMFORT_RADIUS_CELLS` (2.5) and `SCHOOL_FULL_PULL_RADIUS_CELLS` (5)
   are absolute distances calibrated when the only schooling species was a
   0.7-unit fish. Separation (half a body length, per creature) and cohesion
   have always acted on disjoint distance ranges *because* the fish is small;
   put a five-unit whale on fish radii and its comfort distance sits inside its
   own personal space, with cohesion pulling in and separation pushing out for
   the first time in this plugin's life. `schoolLoosenessOf` multiplies the
   size-class looseness by the species' body length over the fish's, so the two
   terms scale together for any size of animal. The baseline is taken FROM the
   fish profile, so the fish's own multiplier is exactly 1 and the retune cannot
   move the one school those constants were ever measured against.

6. **Swim clearances scale with the size class** (`swimmerWorldY` takes the
   model scale as a REQUIRED argument). A clearance is the model's own
   half-height plus a little water, and the class scales the model but was
   scaling nothing in placement. CORRECTED 2026-08-22: this item originally
   blamed the fish, computing its half-height from `ellipsoid()`'s full height
   argument — 1.4 × 0.26 = 0.36 world units tall against a 0.3 minimum
   submergence, with `protocol.ts` calling 0.36 "comfortably inside" 0.3 — but
   `ellipsoid()` takes FULL extents, a fish's half-height is 0.13, and
   1.4 × 0.13 = 0.182 really is comfortably inside: there was never a fish bug.
   The conclusion stands on the whale instead: `WHALE_ENVELOPE`
   (whaleSpecies.ts) is a true half-extent envelope, and at the large class its
   crown reaches 1.4 × 0.670 = 0.938 and its belly 1.4 × 0.575 = 0.805 below
   the origin, against the whale profile's 0.7 minimum submergence and 0.7
   minimum clearance — unscaled, a bull's belly would have sat 0.1 units into
   the seabed and its dorsal 0.24 above the waterline. Required rather than
   defaulted because a default is exactly how the caller forgets.

**Day one and full reveal, restated against the code:**

| species | density (sq. world units) | day one (4 096 deep / 2 304 shallow) | full 512², capped |
|---|---|---|---|
| fish | 400 shallow | 5 (one school) | 72 |
| deep-sea | 1 500 deep | 2 | 28 |
| whale | 2 000 deep | **2** (a partial pod) | **21** |
| grazer | 2 700 land | 0 (no land yet) | 26 |

A fully revealed world now asks for 270 and the cap scales it to 147. Whales
cost more of that cap than they did (21 against 9) and every other species is
~9% smaller for it — accepted, because a pod is three whales by definition and
a world with room for only nine could hold three pods in total and would read
as a world of lone whales.
