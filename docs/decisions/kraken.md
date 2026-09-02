# Kraken

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (kraken correctness pass, commit 268cf9a)

**Kraken depth bar — derivation corrected.** The bar stays at 7 bands (−448);
the reasoning recorded for it did not survive checking. Genesis never
smooths, so a fresh world's floor is always an exact band multiple and −496
is an *edited* floor, not a natural one; the relaxation shave is `ceil(e/2)`,
not a MAX_STEP/2 bound. Band −8 is a reference, not a maximum — the noise
lattice spans bands −10..+4. And because only unlocked cells count as
habitat, the "no mandatory dig" benefit lands in ~30% of fresh worlds
(measured over 400 seeds at both 128² and 512²), not all of them. Seven
remains the right number on the corrected facts: it is the deepest bar
admitting both an untouched band-8 floor and that floor after one one-band
shave, and going shallower would collapse onto the 3-band `FRESH_SEABED`
clamp — Cthulhu's own line — erasing the only thing that separates the two
sea kinds. Owner ratified the follow-through the same day: worldgen will
GUARANTEE one qualifying trench per fresh world (issue #42) rather than move
the bar.

**Monster aura geometry.** The no-raise disc bounds the brush by
`intent.radius`; since the tight-disc footprint (`dx²+dy² < r·(r−1)`,
2026-08-19) that is an upper bound, not an equality. Erring wide refuses a
raise that could not have touched the monster, which is the safe direction
and is deliberate; a contract test pins the containment against shared's own
footprint function for every legal radius.

## Decisions made 2026-08-19 (every fresh world contains a kraken trench, #42)

**Every fresh world contains a kraken trench (owner-decided).** The kraken
bar moved to the natural ocean floor earlier the same day, but whether a
world HAD such a floor was a per-seed coin toss: over 48 seeds, a lair-sized
basin reaching 7 bands existed on 46% of 128² worlds and 58% of 512². The
rest owed their players a mandatory dig. Genesis now guarantees it. After the
noise field is drawn, `buildFreshGenesisTerrain` surveys the oceans it
produced and — only if none is both lair-sized (`KRAKEN_MIN_LAIR_DEEP_CELLS`,
restated core-side) and already deep enough — cuts a capsule trench to
`GENESIS_DEEP_OCEAN_REFERENCE_BAND` through the deepest ocean it has, along
one of eight seed-chosen integer axes. Integer-only, derived from
`(size, seed)`, no additional RNG draws, tie-broken by total orders rather
than traversal order. The load-bearing rule is that it only ever LOWERS cells
that are already open ocean: the set of deep-water cells is exactly what the
noise produced, so no classification moves, the wildlife day-one census is
untouched, and the chosen region keeps its area. It is a byte-for-byte no-op
on every world whose noise already qualified (verified: the no-op count
equals the already-qualifying count exactly), and it runs on the genesis path
only, so snapshot-restored worlds are unaffected. Trench walls descend one
band per `BAND_HEIGHT / MAX_STEP` cells — the steepest slope that still
satisfies the relaxation invariant — so a smooth stroke cannot slump the
floor the guarantee rests on. The guarantee is about terrain, not
progression: `isLairCell` still requires an unlocked cell, so day one remains
a mixture (33/48 and 29/48, up from 15/48 and 19/48) and a trench outside the
starter square arrives with territory creep. Rejected: stamping a fixed basin
(cuts through whatever the noise placed) and biasing a lattice point deeper
(a soft bowl, and not actually a guarantee).

## Decisions made 2026-08-19 (kraken eviction withdrawn; arrivals scatter)

**The kraken has no eviction (owner: "For now, no eviction. Later, if we do
boats, they can attack the kraken.").** The collapse rule is withdrawn rather
than retuned. It had never described what the code did — it counted cells of
the 3-band deep-water region, not of the 7-band trench, so refilling the
trench that summoned the kraken did nothing, genuinely draining it meant
raising ~87% of a fresh world's ocean, and the only cheap counter was an
undocumented trick, walling it into a sub-threshold pocket. Rather than pick
new numbers for a mechanic nobody had designed, the mechanic waits for a
fiction: boats fight the kraken (#43), terrain does not. What remains is
physics — raise the seabed under its own cell and it cannot stay, which
starts the usual ten-minute absence — and the cooldown machinery is kept
whole for the boats arc. The yeti's collapse rule is unaffected;
LAIR_COLLAPSE_HYSTERESIS_DIVISOR stands as the rule any future departure rule
must satisfy.

**Monsters no longer rise from one cell (owner-decided).** The summon point
was a region's single deepest cell, so after Deep Strata gave players 24
bands to dig through, one hand-sunk shaft owned every future arrival of every
kind — and made the permitted co-location of the two sea kinds structural
rather than incidental. Arrivals are now hash-picked uniformly among the
region's qualifying cells: the kind's own reach bar, so the kraken scatters
over trench cells and Cthulhu over any deep water and they remain different
animals. The pick is seeded from the persisted monster-id counter and mixed
with murmur3's fmix32 — integer-only, exactly repeatable, unique per summon,
and different for two kinds arriving on the same tick. Co-location remains
allowed; it is now a coincidence. Applied to all kinds, the yeti included,
because nothing else in this lifecycle special-cases a habitat.

## Decisions made 2026-08-19 (the kraken's body; dread derives per kind)

**The kraken's body, corrected (owner: "physically wrong").** The first
kraken stood its 6.4-cell mantle near-vertically on a floating head — ~90% of
the animal above the waterline, fins as a mid-air brim — which no soft-bodied
floating animal can do. The model now follows surfaced-cephalopod fact: a
humped back arching from the head to a fin-fluked tail riding at the
waterline, arms draped along the surface with tips just under, tentacles
rearing higher and hanging deeper. Eyes stay at the waterline (ratified
intent). The 7-cell footprint holds, with the mantle's swept SKIN (axis +
local radius, sampled off the real curve by test) inside the half-footprint
and the arm tip still the binding constraint; `KRAKEN_TOTAL_HEIGHT` is a
tested upper bound on the skin top. The kraken is now deliberately WIDER than
it is tall — the "spider on the water" its own design prose always claimed.

**Dread weather derives per kind (#44).** The authored effect was Cthulhu's
anatomy applied to every swimmer; each swimmer now gets mist ceiling,
flash-light height, bolt annulus, and bolt bottom derived from its own
anatomy (`dreadSpecOf`), with Cthulhu's spec reproducing the authored values
exactly. On the kraken — eyes 0.30 above water — the bank is by construction
a low film on the sea, never over the lamps.

## Decisions made 2026-08-20 (boats fight the kraken; the mechanic settled)

**The arc parked on 2026-08-19 now has its fiction.** That entry withdrew the
kraken's collapse rule and said the mechanic "waits for a fiction: boats fight
the kraken (#43), terrain does not". Settled with the owner 2026-08-20 and
shipped as `plugins/boats`:

- **Villages dispatch; players do not command.** A coastal settlement that has
  survived its first tier-up keeps up to three boats and sends them at any
  kraken within its patrol range. There is deliberately no player verb — you
  fight krakens by growing coastline. A direct reinforcement verb was raised
  and explicitly deferred by the owner to its own card (#49).
- **Combat is attrition.** The kraken sinks one engaged boat every 12 s; each
  engaged boat wounds it 1/s; 54 wounds rout it. Every constant is derived from
  one sentence — *it takes a full fishing fleet, and not one boat less* — and
  the relation between them is pinned by test rather than the values being four
  independent dials.
- **`KRAKEN_ROUT_WOUNDS` is 54 and not 60.** 60 is reached at exactly the
  instant the kraken sinks its second boat, which made the outcome a
  floating-point tie-break between two accumulators. A win condition must never
  coincide with a loss event.
- **A rout goes through `banish`.** Boats emit `boats:defeated`; the monsters
  plugin decides what that means, so a routed kraken gets exactly the
  ten-minute cooldown a drained basin would have given it. This is what the
  2026-08-19 entry meant by keeping the cooldown machinery whole for the arc.
- **`structures` needed no change.** `VILLAGE_MIN_TIER` is 1 and reaching tier 1
  requires an upgrade, so every qualifying settlement already announces itself
  with its tier on structures' existing `changes` event. Coastal-ness is decided
  in the boats plugin (a settlement with no wet 4-neighbour has nowhere to
  launch from) rather than by teaching structures what a coastline is.

**A monster is a body, not a point, when it steers (#45's last finding).**
`protection.ts` had always treated a monster as a disc — a player may not raise
ground within 4.5 cells of the kraken — while `lurk.ts` treated the same animal
as a point, so it was free to swim its own 3.5-cell arm crown into ground that
already existed. The server forbade the world from moving into the monster's
body and permitted the monster to move its body into the world. Fixed at the
predicate (`isLairPose`), not at the three callsites, because the callsites all
asked the only question on offer. Filed under #44 as a render-only graphics
item; it was neither.
