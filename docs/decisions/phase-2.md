# Phase 2

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-14 (Phase 2, settled with owner)

- **Touch controls are v1 scope** (owner request, supersedes the §6 non-goal's
  "touch can come later"): one-finger sculpts in the HUD's sticky raise/lower
  mode, two-finger pinch zooms with the drag component configurable (pan
  default, orbit optional). Touch strokes arm after `TOUCH_STROKE_GRACE_MS`
  so a camera gesture's second finger cancels them before they sculpt.
- **Control bindings are user-configurable** (owner request): raise/lower/
  orbit/pan each bind to a mouse button + optional modifier, persisted in
  localStorage, edited in the HUD's Controls panel. One resolver
  (`client/src/state/controlPrefs.ts`) owns "who gets this press"; OrbitControls'
  `mouseButtons`/`touches` are derived from it per press.

- **Sculpting gains brush TOOLS and edge PROFILES; the stamp becomes the
  default brush** (owner request, settled 2026-08-14). Two orthogonal axes on
  every sculpt:

  | Axis | Values | Meaning |
  |---|---|---|
  | tool | `stamp` (player default) / `smooth` | `stamp` changes exactly the brush footprint — no relaxation pass, so repeated radius-1 raises build a true vertical spire and lowering digs a sheer pit. `smooth` is today's behaviour verbatim: brush **plus** the gradient-limit relaxation. |
  | profile | `soft` (default) / `hard` | `soft` is the original linear falloff from the centre. `hard` applies one flat delta across the whole footprint, edge cells included — plateaus and clean holes with sheer edges. |

  All four combinations are legal and meaningful (hard+smooth = stamp a plateau,
  let it slump).

  **AMENDED 2026-08-19 (owner report): the `hard` profile level-fills under
  BOTH tools.** hard+smooth now means "level-fill, then slump" — the flat
  delta it used to run lifted the *higher* neighbouring level's cells inside
  the footprint up a band, so clicking beside level 7 made level 7's contour
  retreat from the brush ("seven sometimes contracts like it's getting pushed
  away"). The `hard` profile never starts the next level anywhere; "fill this
  level FLAT and leave it standing" remains stamp+hard's promise alone, since
  smooth's relaxation still re-slopes the fill the instant the brush lifts.

  **AMENDED 2026-08-19 (owner-settled, later the same day): player sculpts are
  ANCHORED to the clicked cell's level.** "It should be locked at that layer
  that I'm clicking on": a raise computes one target — the floor of the band
  above the clicked cell's pre-stroke band — and no footprint cell may cross
  it (cells already past it are untouched; lowering mirrors with the band
  below). `soft` keeps its centre-out falloff under that ceiling, which is
  what stops the periphery from ever ending above the centre; `hard`'s level
  fill anchors to the clicked band instead of the footprint's surveyed
  minimum — the owner chose this knowing a hole under the brush edge no
  longer holds the fill back (superseding that clause of the 2026-08-14
  level-fill request). Plumbing mirrors `spill`: a resolved option
  (`anchor: 'clicked'` on the wire path, `'free'` for the library/plugins),
  never a wire field. Pricing deliberately ignores the ceiling, same rule as
  the clamping/level-fill exclusions.

  **AMENDED 2026-08-19 (owner-settled, same session): the brush footprint is a
  tight integer disc.** `dx² + dy² < r·(r−1)` (radius 1 = the centre cell) —
  1/5/21/37 cells at radii 1–4 — replacing `floor(sqrt) < r`, whose lattice
  fill made radius 2–3 literal squares. Chosen after reviewing Populous's own
  mechanic (single-point edits on an isometric diamond grid); the disc is the
  rounder, more organic footprint the owner asked for. Displacement volumes
  (and therefore mana prices) re-derive through the one shared footprint
  iterator: soft 64/192/652/1152, hard 64/320/1344/2368.

  **AMENDED 2026-08-19 (issue #26, owner-settled): player-facing smooth spill
  is band-contained.** "Today's behaviour verbatim" above now describes the
  LIBRARY path only. A PLAYER's smooth stroke still relaxes terrain outside the
  brush, but an outside cell may only move within the terrace band it occupied
  when the stroke touched it — the spill can slope ground, it can never create
  or erase a rendered level outside the brush ("area outside of the brush
  should never be raised or lowered ahead of the structure under the brush").
  Standing residual (measured 2026-08-19): where the cap binds, the MAX_STEP
  invariant stands exceeded at the brush ring — PERMANENTLY, as far as banded
  relaxation is concerned: the capped side cannot rise past its band and the
  coupled transfer rule then moves neither side, so further banded smooth
  strokes never lower the excess (verified over hundreds of strokes). The wall
  is removed only by deliberately lowering the high side (brush deltas are
  uncapped inside the footprint) or by a plugin's 'free' sculpt covering it —
  consistent with the stamp tool's precedent that sheer player-built walls are
  legal and permanent. Rejected alternative: slumping only the free side down
  to the cap + MAX_STEP — it erodes the built mound at its ring (~25k
  height-units on a measured slope scenario) and caps every smooth build at
  the ring's band + MAX_STEP. Plumbed as a third
  resolved option, `spill: 'banded' | 'free'` — never carried on the wire
  (fairness policy, not brush shape); wire default `banded`, library default
  `free`. The library default was ORIGINALLY justified as "plugin terraforms
  keep the unbounded relaxation they were tuned against, bit for bit"; that
  argument is retired twice over and is recorded here only so the next reader
  does not resurrect it. The 2026-08-20 re-terrace invalidated the tuning it
  appealed to; `WorldApi.sculpt` has passed EXPLICIT banded options for every
  plugin since (server/src/plugins/world-api.ts, `PLUGIN_SCULPT_OPTIONS`), so
  no plugin reaches the library default at all; and the 2026-08-29 conserving
  split (issue #108) then re-derived the plugin constants that tuning produced.
  The library default stays `free` because it is the bare arithmetic a direct
  `applySculpt` caller asks for, not because anything is tuned against it. See
  SculptSpill in shared/src/heightmap.ts.

  **This SUPERSEDES the §2 framing of gradient limiting as "the single most
  important element of the feel" — for the DEFAULT brush only.** Relaxation is
  no longer what happens on every edit; it is one of two tools, and the owner's
  new player-facing feel is the stamp. The mechanic itself is unchanged and
  fully available: nothing about §2's description of *how* relaxation works, or
  of why it matters when you want land to flow, is retracted.

  **Two different defaults, on purpose.** The wire default (an intent naming
  neither field) is **stamp + soft** — the new player-facing feel, so a client
  too old to send the fields still gets the new brush. The library default
  (`applySculpt` called with no options argument) stays **smooth + soft**,
  because every existing caller — above all the plugin `WorldApi.sculpt` path —
  was tuned against relaxation, and a silent re-tune of every installed plugin
  is not an acceptable side effect of a UI feature. `WorldApi.sculpt` keeps its
  signature and its smooth behaviour.

  **The normalisation is one function.** `sculptOptionsOf(intent)` in
  `shared/src/protocol.ts` is the only place "absent means what" is decided for
  an intent, and both the server's intent pipeline and the client's prediction
  store call it. Two copies of that default that agreed today would be a client
  predicting a spire where the server builds a mound tomorrow. The wire fields
  are additive and optional (same pattern as `seq`); a present value outside the
  known set fails validation with the whole intent rather than being defaulted,
  because silently reshaping an edit desyncs the sender's prediction.

  Anti-cheat is unaffected: tool and profile choose the SHAPE of an edit, never
  its power. The amount stays server-side.

- **A fresh world starts as an ocean with a coast, not a flat shoreline**
  (owner request, settled 2026-08-14, from the report "we need more wildlife,
  I don't see any deep sea creatures"). **Superseded in shape, not in intent,
  by two later passes on the same feature — 2026-08-18's seeded randomization
  and 2026-08-19's starter-square shrink, both folded into this entry rather
  than left as a stale description of code that no longer exists; the
  starter-square shrink's own wildlife consequences are broken out as their
  own entry immediately below.** `World.createFresh`
  (`server/src/world/world.ts`) still generates three concentric terraces by
  Chebyshev (square-ring) distance from the starter region's centre, but as of
  2026-08-18 that fixed profile is now scoped to the starter unlock square
  only:

  | region | depth | constant | height |
  |---|---|---|---|
  | shelf — a centred square of `spanChunks / FRESH_SHELF_SPAN_DIVISOR` (= 4, floored, never below one chunk) chunks | 1 band | `FRESH_SHELF_BANDS_BELOW_SEA` | −64 |
  | slope ring — `FRESH_SLOPE_WIDTH_CELLS` (= `CHUNK_SIZE`, 16) cells wide | 2 bands | `FRESH_SLOPE_BANDS_BELOW_SEA` | −128 |
  | open sea beyond the slope ring, still inside the starter square | 3 bands or deeper | `FRESH_SEABED_BANDS_BELOW_SEA`, a floor | ≤ −192, seed-varied |
  | open sea outside the starter square entirely | unconstrained | seeded value noise | seed-varied, any band |

  The shelf is placed from `initialUnlockFootprint()` — the one definition of
  the starter square, which `applyInitialUnlock` also reads — rather than from
  a second copy of its centring rule, so the 2026-08-19 span change below
  moves the shelf with it automatically.

  **No longer deterministic end to end — by design, and precisely scoped.**
  The original fix was integer-only with no RNG anywhere; the 2026-08-18 pass
  ("Doesn't look very creative; we need something more creative and maybe less
  deterministic… every world should have at least some fairly deep water. It's
  OK to create flat worlds, but the terrain should be randomized" — owner) adds
  exactly ONE random draw per world: a 32-bit seed (`drawGenesisSeed`, backed
  by `Math.random`), drawn once at `World.createFresh` and never re-derived —
  the same "this is the one place it's allowed" boundary `generateWorldName`
  already uses for the world's name. Every height in the map is then a PURE
  function of `(size, seed)` via `mulberry32Rng`, a small public-domain 32-bit
  PRNG — same seed, same world, byte for byte, which is what keeps client-side
  prediction and every test in `server/test/fresh-world.test.ts` reproducible
  by simply passing a seed explicitly. The shelf and slope ring stay BYTE-
  IDENTICAL across every seed at a given size — no noise reaches them at all —
  because the wildlife plugin's day-one census (`plugins/wildlife/test/
  wildlife.test.ts`) counts that exact region and asserts exact cell counts;
  changing plugin behaviour is out of this change's scope. Everything OUTSIDE
  the starter square is a seeded value-noise field (`buildOuterTerrainLattice`
  + bilinear `outerTerrainBandAt`, one lattice point per 4 chunks, integer
  arithmetic throughout) that can put a continent, an island chain, a basin,
  rolling hills, or — on a low `roughness` draw — something close to a flat
  sea wherever the noise lands; `roughness` and a per-world `baseline` are
  drawn together so a "calm" (low-roughness) world is flat at a height the
  SEED chose, not silently collapsed to the same sea-level plate every calm
  seed would otherwise share. The open-sea CELLS still inside the starter
  square (beyond the slope ring) also read this noise field, but are clamped
  to never come out SHALLOWER than `FRESH_SEABED_HEIGHT` — a one-way ratchet,
  deeper-only — so the wildlife census's deep-water classification there can
  never move even though the exact depth now varies by seed. Only the deep
  water GUARANTEE is enforced outside the seed's control: after generation,
  `World.createFresh` re-scans for the deepest cell and, on the documented
  valid size range, the starter-square clamp already proves one exists; on a
  world small enough that the shelf and its fixed-width slope ring cover every
  cell (below the shipped 128² minimum), a `carveFallbackAbyss` fallback
  forces the single farthest cell down to `FRESH_SEABED_HEIGHT` directly, and
  a boot-time throw backstops the (expected-unreachable) case where even that
  fails — the same "fail loudly at boot rather than serve a broken world"
  idiom `applyInitialUnlock` already uses.

  **Root cause this fixes.** `createHeightmap` allocates zeros and `SEA_LEVEL`
  is 0, so every cell of a fresh world sat *exactly* at the waterline: the sea
  had no depth anywhere. Nothing that classifies water by depth could ever fire
  — the wildlife plugin's deep-water habitat begins three bands down, so whales
  and deep-sea creatures had literally nowhere to exist unless a player hand-dug
  a trench. The ocean was a surface, not a volume. Still the diagnosis today —
  the 2026-08-18 pass changed HOW the fix varies, not why it exists.

  **Why these depths.** Three bands is the shallowest depth satisfying
  `FRESH_SEABED_BANDS_BELOW_SEA >= DEEP_WATER_BANDS_BELOW_SEA` — the open sea
  must qualify as deep habitat *by design*, and every band beyond that is one
  more sculpt a player spends raising land out there. One band for the shelf is
  the shallowest water that is still water: shallow habitat for coastal species,
  and only one band below the surface so an island where the game starts you
  costs two sculpts rather than four. Core cannot import a plugin constant, so
  both relations (open sea deep, shelf and ring shallow) are pinned by tests on
  the plugin side (`plugins/wildlife/test/wildlife.test.ts`).

  **Why the shelf is a quarter of the starter square, and why that quarter now
  buys fewer whales.** The habitat census only counts *unlocked* cells, so the
  starter square is the entire day-one habitat budget, and
  `FRESH_SHELF_SPAN_DIVISOR` (4, unchanged since 2026-08-14) is what splits it
  between coastal and open-sea species. The split's absolute numbers moved when
  the starter square itself shrank (2026-08-19, see the entry below): at the
  ORIGINAL 8-chunk / 16 384-cell square the split was 4 096 shallow / 12 288
  deep, comfortably buying 2 whales at 5 000 deep cells each; at the CURRENT
  5-chunk / 6 400-cell square it is 2 304 shallow / 4 096 deep, which no longer
  reaches a whale's 5 000-cell need at all (superseded 2026-08-21: that need is
  now 2 000, and the same 4 096 cells reach it twice over). The divisor itself was never
  retuned for this — 4 is still "coarse enough that a larger shelf would eat
  the open sea this whole change exists to create, and a smaller one would
  leave no coast for fish" — the starter square just got smaller out from under
  it, an accepted consequence named in full in the entry below.

  **Residual, named** (and worse since the 2026-08-20 re-terrace: a coastal
  step is 64 height units against a `MAX_STEP` of 16, so it overshoots the
  invariant by four times rather than two — the step did not grow, the limit
  shrank with the band). A coastal step is 64 height units against a gradient
  limit of `MAX_STEP`, so the shelf/slope/noise boundaries do not satisfy
  the relaxation invariant at genesis. Nothing enforces it at rest — the stamp
  tool violates it deliberately on every spire — but a `smooth` sculpt whose
  relaxation reaches a boundary will slump it once, with a larger-than-usual
  diff bounded by `SMOOTH_PASS_LIMIT`. Accepted: that is the smooth tool doing
  its job on a terrace edge, and a ramped coast would trade the terraced house
  style for it. (Re-decided 2026-08-18, issue #12: the cap's original
  travel-distance derivation, 64 passes, was exhausted by ordinary stamp-then-
  smooth play, silently violating the gradient invariant. It is now
  `SMOOTH_SPREAD_CELLS × SMOOTH_PASSES_PER_SPREAD_CELL` = 256, sized off the
  measured worst player-constructible strokes with 2× headroom and pinned by
  stress tests; `smooth` returns its pass count so truncation is observable.
  A fully clamped smooth stroke also now relaxes its footprint instead of
  no-opping.)

  **Where it lives, and why not in `shared/`.** The server fills the floor —
  and, since 2026-08-18, draws the one random seed and builds the noise field
  — while `createHeightmap` stays zero-filled. `shared/` is the determinism
  contract that client and server both run, and world *genesis*, seed draw
  included, is not part of it: the client never generates terrain, it receives
  chunks, so a non-deterministic server-only step here breaks nothing on that
  contract. This also keeps "what a new world looks like" a server policy a
  future world-gen plugin can replace.

  **Consequences, accepted:**
  - Raising land costs band-steps it did not before, and how many now varies by
    place AND by seed: two sculpts to break the surface on the starter shelf
    (fixed, every world), more out in the open sea where seeded noise can push
    the floor deeper than the old fixed abyss. Intended — the ocean is a volume
    with a bottom, and now a volume with a variable one.
  - A fresh world has **no land inside the starter square** — the wildlife
    plugin's day-one census depends on that (see above) — but land is possible,
    and expected, beyond it: the seeded noise field can and does place islands,
    coastlines and hills there, decided at genesis and not before. Land-habitat
    species (the wildlife plugin's grazers) still have nowhere to be on day one
    regardless; water species, coastal and open-sea alike, have somewhere from
    the first tick.
  - Every generated world still contains water at least as deep as
    `FRESH_SEABED_HEIGHT`, guaranteed by construction (the starter-square clamp
    can only push that region deeper, never shallower) and re-checked, loudly,
    right after generation.
  - Snapshot-restored worlds are untouched: genesis (fixed profile AND seeded
    noise alike) applies to the no-snapshot path only, so existing self-hosted
    worlds do not silently gain a coastline or a reroll on upgrade.
  - The client boots its local heightmap at band 0, so for the single frame
    before the first chunk arrives it draws a flat shoreline where the server
    has a coast and (now) seed-varied terrain beyond it. Cosmetic, pre-connect
    only, and **not fixed here** — it belongs in the client's boot state.

- **The starter unlock square shrinks from 8 chunks to 5** (owner decision
  2026-08-19, `server/src/world/initial-unlock.ts`). `INITIAL_UNLOCK_CHUNK_SPAN`
  moves from 8 to **5** — 80×80 = 6 400 cells, down from 128×128 = 16 384,
  ~39% of the old footprint. Distinct from, and not part of, the per-player
  creep/territory-mask redesign filed under issue #17 below: this is a change
  to the SIZE of the region genesis and the fallback unlock policy agree on,
  not to how or when territory unlocks. Deliberately small — the static
  genesis profile inside the starter square stops mattering as much once most
  of the world is earned by sculpting (per-player creep, issue #17), so a
  smaller guaranteed-safe starting point trades less day-one certainty for
  more of the map being "the seeded, varied kind" sooner.

  **Why 5 and not 4.** Five is the smallest span whose genesis geometry stays
  clean: the shelf (`spanChunks / FRESH_SHELF_SPAN_DIVISOR`, floored) comes out
  to exactly 1 chunk, the remaining 4 chunks split symmetrically around it, and
  the 16-cell slope ring sits strictly inside the square with a uniform
  one-chunk-deep frame beyond it on every side. Span 4 was rejected: it leaves
  an off-centre shelf and a slope ring touching the square's own edge, which
  both `freshGenesisProfile`'s concentricity assumption and the wildlife
  census's exact-cell-count assertions depend on not happening.

  **Wildlife day-one consequences, named rather than discovered later**
  (`plugins/wildlife/server/species.ts`'s own doc comment states the same
  numbers against the code):

  | species | old day-one (8-chunk square, 16 384 cells: 4 096 shallow / 12 288 deep) | new day-one (5-chunk square, 6 400 cells: 2 304 shallow / 4 096 deep) |
  |---|---|---|
  | fish | 10 (two schools of 5) | 5 (one school) |
  | deep-sea | 8 | 2 |
  | whale | 2 | **0** — a whale needs 5 000 deep cells; only 4 096 exist |
  |  |  | *(superseded 2026-08-21: the density dropped to 2 000, so the same 4 096 cells now buy **2**. See the whale-pod entry at the end of this file.)* |
  | grazer | 0 | 0 (unchanged — a fresh world still has no land) |

  **Superseded 2026-08-21** (whale density 5 000 → 2 000, at the owner's
  request). The paragraph below is kept as the record of why the situation
  arose; the fix, when it came, moved the density rather than the starter
  square, exactly as the last sentence here anticipated it would have to.

  Whales no longer fit on day one at all — the 4 096 deep cells inside the
  new, smaller starter square fall short of a whale's 5 000-cell habitat need
  regardless of how the shelf/deep split is tuned (see the "why the shelf is a
  quarter" paragraph above). This supersedes the 2026-08-14 wildlife-density
  tuning goal of "2–3 whales immediately"; whales now arrive once a player's
  own per-player creep (issue #17) grows their personal unlocked area past the
  threshold, which was already the intended long-run shape for every species
  as territory expands — day one just no longer includes them. Fish and
  deep-sea counts both roughly halve for the same reason (smaller day-one
  census, same per-individual densities) without ceasing to exist outright.
  `FRESH_SHELF_SPAN_DIVISOR` itself is unchanged (4) — see the entry above for
  why moving it was rejected as the fix.

- **Wildlife is denser, and its population is a living process rather than an
  inventory** (owner request, settled 2026-08-14, same report). Two parts:

  1. **Density retune.** Per-species `habitatCellsPerIndividual` roughly doubles
     the asked-for population overall. The two DEEP species move much further
     than the other two (whale 20 000 → 5 000, deepsea 6 000 → 1 500) because
     deep water stopped being a rare remote habitat and became three quarters of
     the ground every new server opens on. Fish moved again on the same day
     (1 000 → 400) for the schooling change below. Day one on any fresh world
     (4 096 shallow / 12 288 deep inside the starter square):

     | species | density | day-one target |
     |---|---|---|
     | fish | 400 shallow cells each | **10** (two full schools of 5) |
     | deep-sea | 1 500 deep cells each | **8** |
     | whale | 5 000 deep cells each | **2** |
     | grazer | 2 700 land cells each | **0** — a fresh world has no land |

     A fully revealed nominal 512² world asks for 246 (131 fish / 52 deep-sea /
     48 grazer / 15 whale); `WILDLIFE_POPULATION_CAP` (raised 100 → 150) scales
     that by 150/246 to **148** (79 / 31 / 29 / 9). Bandwidth at that cap, with
     the `size` field added below: 150 × 58 B ≈ 8.7 KB per full-state broadcast,
     43.5 KB/s ≈ 348 kbit/s per client at the 5 Hz cadence.
     Honest note, restated after the fish retune: a *fully* revealed 512² world
     now rides the cap hard, getting 60% of what the densities ask for, and fish
     are the majority species there (53%). Accepted — the cap is a bandwidth
     budget and scales species proportionally, so a capped world loses scale, not
     shape; and "enough fish to see schools" is arithmetically "a lot of fish".
  2. **Stochastic population.** Targets are a CEILING approached at random, never
     a quota filled at boot. Each pending spawn credit carries a constant hazard
     (`SPAWN_MEAN_WAIT_SECONDS = 20`), so the deficit decays exponentially and a
     world is ~95% stocked after a minute rather than in three seconds — and
     creatures also leave of their own accord (`NATURAL_LIFESPAN_SECONDS = 300`),
     so spawn events keep happening forever and the mix a player watches never
     repeats. Both are per-second rates converted with the host's `dt`; the
     equilibrium sits at `T / (1 + W/L)` ≈ 0.94 of target, deliberately never
     pinned to it. Tests assert bounds and statistics, never exact counts.

- **Fish school, and how strongly depends on their size** (owner request,
  settled 2026-08-14: "I see individual fish but I haven't seen any schools of
  fish", then "fish come in three sizes; smaller fish should be more likely to
  school"). Entirely inside `plugins/wildlife`; core is untouched.

  **Root cause.** A spawn group placed five fish together and then steered every
  one of them independently, so a school existed only at the instant it appeared
  and was gone within a minute — and per-individual turnover eroded whatever was
  left. Schools were a spawn-time coincidence, never a thing.

  **Four parts.**
  1. **School identity.** Every creature carries a `schoolId`, allocated once per
     spawn group and never changed. Solitary species and lone-remainder fish get
     a school of one, which makes every school rule degenerate to the old
     per-individual behaviour instead of needing a "does this school" branch.
     It is **never on the wire** — the client draws creatures where it is told
     they are and needs no concept of a school.
  2. **Boids-lite cohesion.** Each tick a creature's steering is `wander +
     attraction toward the rest of its school + mild alignment to its mean
     heading`, both school terms clamped to a turn rate and to the angle
     remaining, so they compose rather than override. Habitat/unlock steering and
     FLEE keep absolute priority: cohesion only proposes a desired heading, and
     the existing veto still rejects it, so a school straddling a new island is
     deflected member by member and a startled school scatters outright (and
     re-forms afterwards — measured: 25 cells apart during the panic, back inside
     2 cells a minute later). No separation term: attraction switches off inside
     the comfort radius, so members never converge to a point.
  3. **Turnover moves the school, not the fish.** The natural-departure roll is
     per school, and takes every member at once. **The mean does not change**:
     per-individual rolls lose `N·dt/L` fish per tick and per-school rolls lose
     `(N/k)·dt/L·k` — the same number, so `NATURAL_LIFESPAN_SECONDS` stays 300 and
     an individual's expected lifetime is unchanged. What changes is the *event*
     rate: departures happen `k` times less often and take `k` fish. A
     "correspondingly longer" mean would have cut fish turnover fivefold.
  4. **Three sizes.** `small | medium | large`, drawn once per spawn group at
     6 : 3 : 1, driving both the model scale (0.6 / 1 / 1.4) and how strongly the
     group schools: `SCHOOLING_PROBABILITY_BY_SIZE` is 0.9 / 0.5 / 0.1, and
     `SCHOOL_LOOSENESS_BY_SIZE` (1 / 1.5 / 2) widens the cohesion radii and
     softens the pull for bigger fish. Everything but fish has exactly one size,
     which is why no species needs a "varies in size" flag. Size **is** on the
     wire — the client cannot scale a model it has not been told about — as a
     one-byte class index, optional so that a payload from a server that predates
     it reads as ordinary medium creatures rather than being dropped.

  **Why fish density had to move with it.** A school is recognisable only when
  there is more than one of them; the old day-one shelf held four fish in total,
  less than one whole group. `FISH_SCHOOLS_ON_FRESH_SHELF = 2` × the group size
  of 5 is 10 fish, and 4 096 shelf cells / 10 gives the 400 in the table above.

  **Persistence.** `schoolId` and `size` are persisted as additive optional
  fields (no version bump). School membership is not recoverable from position,
  so dropping it would make a restart silently undo the whole behaviour; a slice
  written before this change restores as independent wanderers of default size,
  which is the honest reading of data that never had the information.

- **Bird flocks cross the world overhead, on their own spawner** (owner request,
  settled 2026-08-14: "we need random flocks of birds flying overhead").
  Entirely inside `plugins/wildlife`; core is untouched, and so is the census.

  **The split, and the trade-off it buys.** Birds are a *transient* — they
  arrive, cross, and leave — while `census.ts`/`population.ts` regulate a
  *standing* population toward a habitat-derived equilibrium. Every mechanism
  there is the wrong shape for a bird: `targetsFor` divides habitat *cells* by a
  density (birds occupy none), the per-tick `despawnInvalidHabitat` sweep deletes
  anything outside its habitat (a bird is outside every habitat by definition,
  so it would be culled the tick it appeared), and the respawn-credit loop exists
  to *heal* a count that dropped, which is precisely what a departing flock is
  not. So flocks get their own ~150-line spawner, `plugins/wildlife/server/
  flocks.ts`. **Named cost:** birds sit outside `WILDLIFE_POPULATION_CAP`, the
  equilibrium arithmetic, and the snapshot; their wire cost is bounded by a
  second ceiling (`MAX_BIRDS_ALOFT`) that must be kept in step with the first by
  hand. `BROADCAST_ENTITY_CEILING` in `server/index.ts` is the one place the two
  are added up.

  **What is reused, not re-implemented.** The boids-lite cohesion + alignment
  from `movement.ts`, unchanged — a flock *is* a school. `steerWithSchool` now
  takes a structural `SchoolMember` (x, y, heading) and a `looseness` parameter
  instead of a fish and a size-class lookup, which is what makes it species-
  agnostic geometry rather than fish code a bird borrows.

  **Loose cluster, not a V.** A V is a *formation*, not steering: it needs a
  leader, per-bird slot assignment behind-and-outboard, and a re-assignment rule
  when a slot's occupant is lost — a solver, not two more terms in a blend. And
  it would not read: a V is only legible from directly below or above, and this
  game's camera looks *down* from an 80+ cell orbit, at which angle a V projects
  to the same smear the existing steering already produces for free.
  `BIRD_FLOCK_LOOSENESS = 2` widens the shared cohesion radii to a 5-cell comfort
  / 10-cell full-pull skein, because birds hold wingspans of clearance where fish
  hold body lengths.

  **The crossing.** A flock is born on a circle that circumscribes the square
  world (`worldSize × √½`, plus a chunk of margin) so it is never seen popping
  into existence, aims at a random point inside the middle half of the map, and
  is removed once its centroid passes back out through that ring. Straightness is
  a `FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND = 1` pull back onto the course —
  net displacement over distance flown measures 1.00. That rate sits deliberately
  *between* the wander noise (0.5) and the *effective* cohesion pull (1.5 — the
  nominal 3 divided by the looseness), because the three terms share one heading:
  a course-hold at or above cohesion buys straightness by taking it out of a
  straggler's ability to rejoin, and the two would then fly perfectly straight
  parallel courses, which no straightness measurement can see. Measured over 40
  trials of a bird displaced 30 cells across the course, mean gap after 30 s:
  13.3 at rate 0.5, **13.8 at 1**, 18.4 at 2, 18.8 at 4 — 1 is the knee, and the
  ordering is pinned by test. A `FLOCK_LIFETIME_SLACK_FACTOR = 2` guard removes a flock that somehow
  fails to cross, so a wedged flock cannot permanently occupy one of the two
  concurrency slots and silently stop the sky.

  **Altitude is not on the wire.** Every bird flies at one world Y,
  `MAX_TERRAIN_WORLD_Y + BIRD_ALTITUDE_HEADROOM_WORLD_UNITS` = 16 + 8 = **24** —
  half the tallest possible mountain again in clear air above the tallest
  possible mountain, so "overhead" holds at the worst case and not just the
  typical one. The client already knows that constant, so the payload stays the
  same six keys as every other creature; wing flap is likewise derived from
  elapsed time and the entity id, client-side, like every other idle animation
  here. Adding birds *did* mean the client's "is this a walker" test — previously
  `SWIM_PROFILES[species] === null` — became a named three-way `PlacementKind`
  (`flyer | swimmer | walker`), because a two-valued test on a table with nothing
  to say about flight would have made birds walk.

  **Bandwidth, recomputed.** 150 habitat creatures + 18 birds (2 flocks × 9) =
  **168** entities × 58 B ≈ **9.7 KB** per full-state broadcast, **48.7 KB/s ≈
  390 kbit/s** per client at the unchanged 5 Hz cadence, ≈3.9 Mbit/s of server
  upstream at ~10 players. That is +12% over the 348 kbit/s before birds; an
  empty sky still costs exactly the old figure. `BIRD_CRUISE_SPEED_CELLS_PER_
  SECOND = 8` is chosen against that cadence: 1.6 cells between updates, just
  under the 1.8 a fleeing fish already interpolates smoothly, so the fastest
  thing in the world needs no cadence of its own.

  **Persistence: none, deliberately.** A flock's entire state is how far along a
  path it will have finished in a minute or two, so restoring one resumes a
  journey nobody was watching; the spawner puts a fresh flock up within a mean
  interval anyway. A snapshot *restore* also clears the sky, which is not
  tidiness — `replacePopulation` resets the shared entity-id counter, so an
  airborne bird would be holding an id about to be reissued.

  **Anti-cheat.** `flocks.ts` reads no terrain and no unlock mask; the only world
  property it touches is `worldSize`. A bird's position is a function of RNG
  alone, so the un-filtered broadcast leaks nothing about locked land — the same
  guarantee the habitat population gets from "creatures only exist in unlocked
  chunks", reached from the opposite direction. Accepted consequence: a flock is
  visible over ground the player has not revealed, and tells them nothing.

- **A world has a DIFFICULTY rating, and it is a neutral core scalar** (owner
  request, settled 2026-08-14: "maps get a difficulty rating 1–100; warm maps
  regenerate 200 mana/s, difficult maps 20/s").

  **What core owns.** `WORLD_DIFFICULTY` — an integer in `[1, 100]`, default
  **50**, where 1 is warm/forgiving and 100 is punishing. It is stored on the
  `World` and published to plugins as `WorldApi.difficulty` (readonly). Core
  attaches **no mechanics** to it: it reads the number in no simulation path and
  has no opinion about what a hard world does. That is what keeps it inside
  "nothing gamey in core" (§3.5) — core is publishing a *dial*, not a difficulty
  system, in the same way it publishes `worldSize`. It is deployment
  configuration, **not snapshot state**: re-rating a world is an env edit plus a
  restart, and an old snapshot never overrides today's setting.

  **Why a 1–100 scalar rather than named tiers.** Consumers interpolate against
  it, so a continuous scale lets each plugin choose its own two anchors and lerp
  without core knowing what any of them mean. Named tiers would put that
  vocabulary — and therefore the game design — in core.

  **Validation: it CLAMPS where the other settings refuse.** Out-of-range is
  clamped to the nearest end with a warning (`WORLD_DIFFICULTY=250` means "as
  hard as you can make it", and the ceiling delivers exactly that); non-integer
  text is still fatal, like every other integer variable. The rule that splits
  the two is whether the bad value states an intent the clamp can honour — it
  does for a scale, and it does not for `PORT=70000`. Safe only because a scale
  has no correctness cliff: no stored data, protocol, or other setting depends
  on where in the band it lands.

  **First consumer: mana.** Regen's DEFAULT is now interpolated linearly between
  `MANA_REGEN_AT_DIFFICULTY_1 = 200`/s and `MANA_REGEN_AT_DIFFICULTY_100 = 20`/s:

      regen(d) = 200 + (d − 1)/99 × (20 − 200)

  so difficulty 50 gives ≈**110.9**/s — up from the flat 20/s default this
  replaces, which is intended (it is the mid-scale answer to the owner's two
  anchors, not a retune of the old number). Linear because the dial is
  dimensionless and a plugin author reading "difficulty 25" should be able to
  predict the rate; any easing would hide a second tuning decision inside the
  first.

  **Precedence, one-way: an explicit `MANA_REGEN_PER_S` always wins.** A host who
  writes a number means that number — they are configuring the plugin directly,
  and a world-level dial silently overruling them would make the setting a lie.
  Difficulty supplies the *default*, i.e. the answer for a deployment that has
  said nothing about mana. The existing validation band still applies to
  whichever source won (200/s sits well inside `MAX_MANA_REGEN_PER_SECOND` =
  810), and a junk `MANA_REGEN_PER_S` degrades to the difficulty-derived rate
  with a warning rather than refusing to boot.

  **The wire is unchanged**: `regenPerSecond` already travels in the balance
  push, so the client HUD animates at the derived rate with no protocol work.

  **Future consumers read the SAME scalar** and pick their own anchors — monster
  aggression and relic counts are the expected next ones — so a host turns one
  dial and the whole installed plugin set moves together. A consumer should treat
  only the two ends as fixed points and interpolate; switching on particular
  values leaves ninety-eight settings undefined.

- **A world has a NAME, and the HUD states who the world is** (owner request,
  settled 2026-08-14). Two facts about world IDENTITY, shown together in a
  header above the mana gauge: the world's generated name, and its 1–100
  difficulty rating.

  **The name is minted once and persisted.** `server/src/world/world-name.ts`
  composes evocative names from curated word lists in four shapes (`Emberfall`,
  `Ashmoor Basin`, `The Sundered Reach`, `Isles of Gloamwatch`). It runs exactly
  once — at genesis, or on the first boot of a world created before names
  existed — and the result is stored in the snapshot beside the heightmap, so a
  restart returns the same world by the same name.

  **Where the randomness is allowed to live.** The generator draws from
  `Math.random` at generation time only; it is never re-derived, so a different
  draw is impossible rather than merely unlikely. It is server-side, in
  `server/`, and no part of it touches `shared/` — terrain math and world
  genesis both stay RNG-free.

  **Persistence, and why the schema version does NOT move.** `snapshots` gains a
  nullable `world_name TEXT` column, added to existing databases by an
  idempotent `ALTER TABLE` at open. The column is compatible in both directions
  — this build reads a row without one as unnamed, an older build ignores it —
  so `SNAPSHOT_SCHEMA_VERSION` stays 1; bumping it would turn an additive column
  into a refusal to boot. A world restored unnamed is marked DIRTY, because the
  snapshot scheduler writes only a changed world and an unwritten name would be
  re-drawn on every boot; a snapshot is additionally written at the end of boot
  so a crash in the first minute cannot re-name a world.

  **Name vs difficulty are persisted OPPOSITELY, on purpose.** The name is
  snapshot state (it is what the world IS, and must come back); the difficulty
  stays deployment configuration read from the environment (a host re-rates a
  world by editing it). The two sit side by side on `World` with that difference
  documented at each.

  **The wire is additive.** `JoinSnapshotMessage` gains optional `worldName` and
  `difficulty`, following the `seq` pattern: a snapshot from an older server is
  still valid, and absent means unknown rather than a default. This does not
  breach "nothing gamey in core" — core already publishes the difficulty dial to
  plugins and attaches no mechanic to it, and a name is identity, not gameplay.

  **The header is CORE client UI**, not a plugin panel: it is the first child of
  the `.hud-top-center` column in `client/src/ui/Hud.tsx`, so it stacks above any
  `top-center` plugin panel whatever plugins are installed. Core is not a plugin
  and does not compete for a placement slot. Identity arrives on the join
  snapshot, is normalised once in `state/hudState.ts` (blank name and unusable
  rating both become "unknown"), and is deliberately not persisted — it is
  re-sent on every join, and a rejoin may land on a different world.

- **The hard edge brush LEVEL-FILLS: one terrace at a time** (owner request,
  settled 2026-08-14: "I would also like the hard edge brush to only work at one
  level at a time until it fills out everything at that level. So if I'm at
  level 2 and I'm trying to fill out all the ground at a level 2, I don't want it
  to start building level 3 until everything within that brush edge is level 2").

  **What it does.** `stamp` + `hard` no longer adds one flat delta to every
  footprint cell. It surveys the footprint, finds the **lowest** terrace band
  present, and fills **that** level: cells already at or above the floor of the
  next band up are untouched; cells below it rise by the sculpt amount but stop
  AT that floor, never through it. Lowering is the same operation mirrored — the
  **highest** band present, the floor of the band below it, and only cells above
  it descend. Repeated strokes therefore flatten the lowest ground under the
  brush to one level, and only when the whole footprint has reached it does the
  next level start. The brush can no longer build a step inside its own
  footprint. Implemented as `applyLevelFillBrush` in `shared/src/heightmap.ts`,
  dispatched from `applySculpt`.

  **On flat ground nothing changed.** A footprint flat at band B goes uniformly
  to band B+1 — byte-identical to the flat delta it replaces, because
  `DEFAULT_SCULPT_AMOUNT` is exactly `BAND_HEIGHT`. Every world starts flat
  (genesis lays band-aligned terraces), so this change is invisible until a
  player has made the ground uneven, which is exactly when they asked for it.

  **One band per stroke, whatever the amount.** A plugin-raised amount of two
  bands still advances the footprint one level: the request is about levels, not
  about how hard a stroke hits. The amount still governs cells that are *below*
  the level being filled, which is where a partly-filled level lives.

  **Only `stamp` + `hard`.** `soft` is untouched, and `hard` + `smooth` keeps the
  flat delta and its documented meaning ("stamp a plateau, let it slump"):
  relaxation re-slopes the footprint the instant the brush lifts, so "fill this
  level flat" is a promise that tool cannot keep. The owner's phrase names the
  hard *edge brush* — the stamp, the player-facing default, and the only
  combination that leaves the footprint it edited standing.
  *SUPERSEDED 2026-08-19 (owner report — see the amendment under the Phase 2
  tool/profile decision): `hard` now level-fills under both tools. The
  paragraph above keeps the surviving half of its own argument: relaxation
  still re-slopes a just-filled level, so the flat-and-standing promise is
  still stamp+hard's alone.*

  **Raise and lower mirror exactly on band-aligned terrain**, which is all the
  stamp tool produces. Off the band grid — only `smooth`'s relaxation makes such
  heights — they differ by the half-open band convention `[B·H, (B+1)·H)` that
  `bandOf` (floor division) defines and terraced rendering draws: a cell at
  height 70 renders on band 1, so lowering must leave it rendering on band 0
  (→ 6), and raising must leave it rendering on band 2 (→ 128). A perfect
  negation mirror would instead drop it to 64 — still band 1, a stroke with no
  visible effect. The asymmetry is the correct one.

  **PRICING DOES NOT MOVE.** `sculptDisplacementUnits` stays the nominal
  flat-delta volume, so a level-fill stroke displaces less and costs the same.
  This is a fourth documented exclusion beside clamping, map edges and relaxation
  — and the first three are preferences where this one is a constraint: the mana
  plugin gates a stroke on the CLIENT before it is sent and the server charges
  the same number (`plugins/mana/pricing.ts`), so the price must be a pure
  function of `(radius, profile)`. A terrain-dependent price would be derived
  from heights the client holds only as base-plus-predictions, and not at all in
  a locked chunk; the local gate and the server would then disagree, which is
  precisely the phantom-stroke-and-clawback the shared price exists to remove.
  The softer argument is the `clamping` one: a stroke that moves less because the
  ground was already level is the same request landing on flatter ground, not a
  cheaper request.

  **Determinism is unaffected.** Integer-only throughout, two passes over the one
  fixed-order footprint iterator (min/max over a set is order-independent), and
  both sides reach it through the same `applySculpt`, so client prediction and
  the server cannot pick different branches. The footprint itself is now defined
  in exactly one function (`forEachFootprintOffset`) that `applyBrush`,
  `applyLevelFillBrush` and `sculptDisplacementUnits` all iterate — previously
  three verbatim copies of one loop, where a cell surveyed but not edited, or
  priced but not brushed, would each have been a real defect.

  **Consequence, named.** At radius 1 the two profiles are identical only on
  band-aligned ground: off it, `hard` snaps the cell to the band boundary while
  `soft` adds the full amount. That is the terraced answer and it is tested, but
  it does narrow the older "radius 1 makes the two profiles identical" claim.

- **A SNOW YETI lives on the high peaks, and monster slots become one per
  HABITAT** (owner request, settled 2026-08-14: "I would like to see a snow Yeti
  that spawns in the high Alps"). Entirely inside `plugins/monsters`; core is
  untouched.

  **Habitat stops meaning "deep water".** `plugins/monsters/server/habitat.ts`
  used to know exactly one thing about the world — how deep the sea was — and
  the connected-region flood fill, the minimum-area rule, the survey interval
  and the "arrive at the region's extreme cell" rule are all habitat-AGNOSTIC.
  So a kind now names a **HabitatRegime**: a direction (`inward`, ±1) and the
  band from sea level where the habitat begins. Every question the plugin asks
  about a height — is it habitat, is this cell further in than that one, is this
  region deep/high enough for this kind — is a comparison of two
  `habitatReachHeightUnits(regime, h)` values, so the land regime cannot
  disagree with itself about which way is up. A basin's extreme cell is its
  deepest; a massif's is its summit; the same twenty lines find both.

  | regime | inward | begins at | who lives there |
  |---|---|---|---|
  | water | down | `DEEP_WATER_BANDS_BELOW_SEA` = 3 | kraken, Cthulhu |
  | land | up | `SNOW_LINE_BANDS_ABOVE_SEA` = 9 | yeti |

  **The snow line is 9 bands, restated rather than imported.** The client's
  palette draws band 9+ as snow (`client/src/terrain/bandColors.ts`) — that is
  where a mountain turns white on screen, and the server may not import the
  client. It is also a good threshold on its own: `MAX_STEP` is `BAND_HEIGHT`
  since 2026-08-20 (it was `BAND_HEIGHT/2`, which doubled every cell-distance
  quoted below when the world's maximum slope halved),
  so a snow cell is at least **18 cells** from the nearest shoreline (three
  times what the deep-water line buys) and 9 of the 16 bands `MAX_HEIGHT`
  allows.

  **ONE LIVING MONSTER PER HABITAT, not per world** — the decision this feature
  turns on, and a deliberate revision of the earlier world-wide singleton. That
  rule was written when every kind lived in the sea, where two horrors in one
  ocean is a bestiary. A mountain yeti contends for none of that: the habitats
  are disjoint halves of the heightmap, and a world where digging a trench
  silently cost you the yeti on the peak you spent an hour building reads as a
  bug rather than as scarcity. Scarcity is kept exactly where it means
  something — one thing in the sea, one thing on the snow. The invariant stays
  STRUCTURAL (one nullable slot per regime, so two-in-one-habitat is
  unrepresentable) rather than counted; `MAX_LIVING_MONSTERS` is now derived as
  per-habitat × regimes. Everything downstream was verified against it: the
  summon pass, the collapse test and the cooldown are per habitat (banishing the
  yeti must not keep the kraken out of the water); the broadcast list is
  iterated in a fixed regime order; the client's reconcile and interpolation were
  already keyed by id and needed no change, which is what they were written for;
  the sculpt veto asks every living monster rather than "the" monster.

  **The persistence slice goes to version 2**, with version 1 read and migrated:
  its single monster keeps its slot and its one world-wide cooldown becomes the
  WATER cooldown — exact rather than guessed, because version 1 predates the land
  habitat and every kind it could name lives in the sea.

  **The yeti's profile**, and each number stated against the two sea kinds
  (AMENDED 2026-08-22 — he is a quarter of this size now, and the lair and the
  amble speed went with him; see that section):
  lair = a connected snowfield of **512 cells** (two chunks, ~23 across — the
  same 4.5 body-widths Cthulhu's threshold is justified by, for a 5-cell animal
  instead of a 7-cell one), **banishable by levelling** his peaks below the snow
  line (the collapse machinery pointed at the land predicate, with the same
  quarter-of-arrival hysteresis and a ten-minute absence), **does not block
  sculpting** (a banishable kind that vetoed raises would be half-vetoing its own
  counter), ambles at **0.45 cells/s** — between Cthulhu's brood and the kraken's
  hunt, and under a third of a wildlife grazer, because a monster that moves like
  livestock reads as livestock. He halts often and briefly where Cthulhu broods
  rarely and at length: a similar share of the time stationary, decomposed the
  opposite way, because beat length is what a player reads.

  **A fresh world cannot host him, and that is intended.** Genesis makes an
  ocean with no land at all, so every snow cell in the world is one a player
  raised nine bands out of the sea — roughly a couple of hundred level-fill
  strokes for the minimum lair. The sea monsters are what a new world has; the
  yeti is something a player builds the country for.

  **Client.** A per-kind model file like the other two (`client/yeti-anatomy.ts`
  + `client/yeti.ts`, ~6 100 triangles against the kraken's 7 700 — 15 600 as of
  the 2026-08-22 fidelity pass): a hunched
  white biped, mass in the shoulders, arms below the hips, a ruff of brighter fur
  at the neck because a white animal on white snow needs a broken silhouette
  edge rather than a colour change. He is the first WALKER — placement became a
  named kind (`swimmer | walker`) rather than the nullness of the lurk-depth
  table, the wildlife plugin's lesson — and stands on the highest band his FEET
  overlap. His gait rate is DERIVED from the server's amble speed over his
  stride length so his feet cannot skate, and its amplitude is chosen to read as
  a weight shift when he is standing still, because the wire deliberately
  carries no gait flag. **He wears no dread**: the mist and lightning are the
  SEA's weather, authored above the waterline, and on a peak nine bands up they
  would be a bug rather than atmosphere.
