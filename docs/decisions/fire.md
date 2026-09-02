# Fire

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-24 (fire — things burn, owner request)

Owner: "I want the ability to set trees on fire. In fact, I want the ability to
set a lot of things on fire," plus a specific mechanic — lightning strikes a
tree, the tree burns, and nearby trees catch from it.

**Fire is its own plugin, and it knows nothing about trees.** The alternative
considered and rejected was a burn flag on flora: "a lot of things" means
crops, buildings and whatever comes next, and a flora-owned mechanic would be
copied into structures within a week, at which point two spread models exist
and disagree.

**The dependency is INVERTED relative to every other cross-plugin link here.**
`fire` publishes `registerFuel`; each flammable plugin bridges to `fire` and
declares what it owns, how long it burns and how tall it is
(`plugins/fire/server/fuel.ts`). The established pattern — a bridge per sibling
(`relics → mana`, `flora → structures`) — would mean a file and an edit inside
`fire` for every burnable thing ever added. Registering inward means `fire`
never changes. The cost, stated: a registration is a WRITE, so bridge rule 3
("buffer, don't drop") lands on the registrant, which is one slot's worth of
care in each registrant instead of a bridge here per registrant.

The one thing `fire` DOES bridge out to is weather (`currentWind`,
`precipitationAt`), because wind and rain are one fact from one named plugin
and there will never be a second source of either.

**A fire's whole state is its age.** No stage union, no per-stage timer:
fierceness is `fireIntensity(age, burn)` and burnout is `age >= burn`, computed
identically on both sides of the wire (`plugins/fire/protocol.ts`). So a fire
is SENT ONCE — cell, fuel height, age at send, total burn — and the client runs
it forward with its own clock, which is what lets a 400-cell wildfire animate
on a delta stream costing under a kbit/s. The 10 s keepalive is deliberately
shorter than the shortest fuel's burn: a repair cadence longer than the thing it
repairs never repairs anything.

**A WALKING fire's repair cadence is derived, not chosen** (2026-08-24, after
review). The 10 s constant above is a number picked against the fuels that
existed when it was written, and entity fuel broke it silently: a creature burns
for 8 s, so its one repair was scheduled for after it was dead. A cell fire can
be repaired by event — its visibility only changes when the PLAYER's view does,
which the server is told about — but a walking fire's visibility changes because
it walked, and nothing announces that. So the entity set is re-sent on a cadence
computed from the shortest burn currently alight
(`ENTITY_REPAIRS_PER_BURN`), and any future plugin's shorter-lived fuel gets a
faster repair without anyone remembering to retune a constant.

**A fire ends in one of three ways, and only one consumes the fuel.** Burned out
(the source destroys what was there), extinguished (rain, or the ground dug from
under it — the tree survives, scorched), cleared (rollback; nobody is told).
Collapsing the first two was the obvious simplification and it is wrong: it
makes "we saved the forest" and "the forest burned down" the same message.

**Spread is one rate and five multipliers** — intensity, wind, slope, diagonal,
wet (`plugins/fire/server/spread.ts`). Only the FRONT spreads
(`SPREAD_MIN_INTENSITY`), so a burn is a ring rather than a filled disc. Fire
runs uphill at 1.6× per terrace band, which is the term that makes the world's
own geometry the mechanic.

**The firebreak is not a feature.** A cell with no registered fuel simply fails
to ignite, so water, bare rock, a ploughed field and a dug trench all stop a
fire through one code path. Digging under a live fire puts it out on the same
diff that fells the tree.

**Lightning moved to the server** (`plugins/weather/server/lightning.ts`). Every
bolt used to be a client decision — each rig ran its own `LightningSchedule` on
its own RNG — which was right while lightning was decoration and became wrong
the moment a bolt could start a fire: a fire authorised under a bolt drawn
elsewhere is a wood alight under clear sky. The server now rolls strikes per
storm, aims at the tallest of six samples under it, broadcasts the cell for
clients to draw and emits it for `fire` to roll ignition against
(`LIGHTNING_IGNITION_CHANCE` 0.35, which lands at roughly one fire per three
storms crossing woodland). `LightningSchedule` keeps the flash curve and the
photosensitivity governor and gives up choosing when; a refused flash is still
DROPPED, never deferred, and reduced motion drops the bolt at the door while the
server's fire burns either way.

**Dry lightning, and what "exposed" means** (owner, 2026-08-24: "I would like it
to randomly fire even without a storm, and it needs to do so over exposed
land"). A world-wide Poisson process independent of any weather system, one bolt
every ~4 minutes, aimed at the most EXPOSED of 24 sampled cells — where exposure
is `height + 2 × prominence` and prominence is the cell's height minus the mean
of four samples one world unit out. Height alone picks the middle of the highest
plateau; prominence alone picks a one-cell pimple in a valley. Measured on a test
world whose ridge is 6% of its area: the ridge takes 74% of dry strikes, the
surrounding plateau 26%, low ground and sea none.

It carries `STRIKE_NO_SYSTEM` (0) as its system id, and the client draws it with
a single loose bolt rig positioned in world space rather than as an offset inside
a storm's rig — the same path now also covers a strike from a system the client
does not know about, which previously drew nothing at all.

**Lighting a fire is a plugin message, not a sculpt intent** — it moves no
ground and the client predicts nothing about it. Gated on the player's own
unlocked view; every reason it could fail is checked BEFORE the mana debit, so
there is no refund path to get wrong. `mana` gained `spendMana(world, playerId,
amount)`: the ledger takes an amount and never an opinion about what things
cost.

**The chronicle gets one line per WILDFIRE, not per tree.** `fire` accumulates
an episode — cells consumed since the world last stopped burning — and emits
`fire:burned` once, when the last fire goes out.

**The look is TWO of the four candidates, crossfaded by intensity** (owner,
2026-08-24; `plugins/fire/client/flames/ribbonsToPlume.ts`). The order asked for
was plume → ribbons; the renders inverted it, for a geometric reason worth
recording because it will recur for any future flame:

> A plume is a column standing at the tree's centre, and a crown is opaque. Its
> height is 1.4× the fuel's, scaled by intensity, so below intensity ≈0.56 the
> whole flame is shorter than the tree it stands in and is depth-culled by it. A
> catching fire drawn as a plume rendered as NOTHING.

Widening, brightening and raising its height floor were each tried and
photographed; they give a translucent smear over the crown or a wisp at its tip.
So the ribbons — which wrap the trunk and pool on the ground, outside the crown's
silhouette — own the low end, and the plume takes over at 0.55, exactly the
intensity at which its column starts to clear the tree. The handover is an
EQUAL-POWER crossfade (√share, not share): two looks at 0.5 opacity read as two
ghosts, because what must stay constant through a handover is energy, not sum.

**The LOOK is behind an interface** (`plugins/fire/client/flames/types.ts`)
because it is chosen from pictures and the sim had to ship first. Four
candidates were authored and rendered for selection; the budget rules any
candidate must keep are in that file's header — fixed small draw-call count
whatever the fire count, no external assets, no per-fire lights, allocation-free
steady state. Firelight is a fixed pool of four PointLights that move between
the fiercest fires, because adding or removing a light invalidates every
material's shader program.

## Decisions made 2026-08-24 (fire that walks — owner request)

Owner, after the first in-world session with fire: "We also need the ability to
set buildings, boats, grazers, peeps on fire. If it's on land, I should be able
to burn it," and — asked what a burning creature does, since fire is anchored to
a cell and a creature is not — "They catch fire and continued to burn until they
dropped dead."

**A building is cell fuel; anything that moves is not.** structures registers
into the existing `registerFuel` and nothing new was needed. A creature broke
the cell model in three places at once: its fire has to ask where it is every
tick, it must survive the thing being removed by something else entirely (an
animal dies of old age mid-burn), and what it consumes at the end is an
individual rather than a patch of ground. Bolting those onto `CellFuel` would
make every static source implement callbacks it can never use, so `fire` gained
a SECOND registry and a second burning set (`entityFuel.ts`, `entityBlaze.ts`)
sharing one clock, one intensity curve and one flame. A cell fire and a walking
fire look identical because they are the same fire; only where the position
comes from differs.

**The position is not on the wire, and that is the load-bearing decision.** The
plugin that owns the creature is already drawing it, interpolated its own way,
sixty times a second. Sending a position from the server would mean two
independent interpolations of one animal, and the flame would slide off the body
— the same defect as a river modelled beside its own valley instead of from it.
So the flame is drawn at the pose the OWNER publishes.

**That needed a client-side cross-plugin seam, which this repo had none of.**
Three options were put to the owner: a neutral primitive in core; `fire`
publishing a client registry that registrants import; or streaming positions and
interpolating them twice. The owner chose the neutral primitive, and it is the
one consistent with §"World events" ("cross-plugin agreement travels as
documented copies... never by import"): `ClientPluginCtx.publishMovers` /
`moverPose`, addressed BY PLUGIN NAME exactly as `WorldApi.emitEvent` is. Core
knows nothing about what is being drawn or why — it holds one lookup per plugin
and hands it to whoever asks.

**A boat needed no special case in the end.** It is the only flammable thing not
standing on the ground, and a "how far above the ground does this flame sit"
field was approved for the cell wire before it turned out to be unnecessary: an
entity flame sits at its owner's published pose, and boats draw hulls at the
waterline. The deck is where the fire lands, by construction.

**Aiming was the other half of the same request.** `pickTerrainCell` raycasts
the terrain surface only, so a tree's canopy — drawn above its own cell — sent
the ray past it onto ground several cells behind; torching a wood was luck.
`pickWorldCell` asks the declared objects first (`markPickable`, opt-in per
plugin so weather's sky dome and the frontier fog are never aimed at) and falls
back to the terrain. The torch — now labelled **Pyro** — uses it for both the
hover ring and the click, so the ring cannot promise a cell the click would not
light.

**Burn times, and what they are relative to.** A crop flashes in 4 s, a creature
or a peep dies in 8, a tree takes 22, a boat 16, a building 30. Creatures are
the shortest of the solid things on purpose: a creature on fire is a death, not
a bonfire, and the number is how long the player watches it run before it drops.
Peeps are deliberately NOT tuned apart from grazers — same size, same sort of
thing, and a player who has learned one has learned the other.

**What a fire does NOT do yet, named rather than discovered later:** a burning
creature does not set light to what it runs through. The machinery is all there
(`EntityBlaze.positions()` exists for exactly this), and it was left out of the
first cut because a panicking animal towing a spread front through a forest is a
balance question, not a plumbing one.

## Decisions made 2026-08-24 (fire review — owner: "fix every fire bug")

A multi-agent adversarial review of the whole fire implementation confirmed 12
defects. Three of them were one defect wearing different clothes, and the fixes
below are stated at the level the review put them, not at the callsites.

**A cell-addressed ignite resolves to the NEAREST candidate, across every
source.** `EntityFuelSource.entityAt` used to license "the first one it finds",
which is sound only while every source answers for exactly the cell that was
aimed at. Sources do not agree on that — a creature answers for half a cell, a
boat for two — so `entityAt` now returns the distance with the id and
`entityFuelAt` takes the global minimum. That fixes both halves of the same
hole: the torch that lit the boat beside the one the player clicked, and the
plugin FOLDER NAME deciding whether a berthed boat or the settler standing on
the cell caught. The reach itself stays each plugin's own decision; only the
arbitration is shared (`nearestWithinReach` in `shared/`).

**Anything that remembers a fire between frames holds its key, never the
instance.** The drawn list is rebuilt every frame, so a held instance object is
a snapshot of a fire as it was — which is why a fire's light lagged a fleeing
animal by over a world unit and went on lighting ground where a fire had already
been put out. `FireInstance.key` exists for this and nothing else.

**A plugin that publishes poses draws before the plugins that read them.** Frame
callbacks now run in two declared phases and the HOST assigns them: calling
`publishMovers` puts that plugin in the pose phase. The guarantee used to rest
on the order of an array in `registry.ts`.

**An id only means the same individual after a restore if its owner says so.**
`EntityFuelSource.idsSurviveRestore` — absent means no. Existence
(`positionOf(id) !== null`) cannot answer a question about identity, and a
rollback across a restart used to re-attach a fire to whoever now held that
number and kill them. Boats and wildlife persist their id spaces and declare it;
pilgrims deliberately do not.

**An episode closes where the burning set empties, not where the tick looks.**
Digging a firebreak through the last burning cell empties the set from outside
`onTick`, and the tick that followed took its quiet-world early-out above the
end-of-episode check — so beating a fire, the headline mechanic, was the one
ending that never got its chronicle line, and the next wildfire's cells were
added to the abandoned count.

**Banked time is carried, never clamped away.** The spread accumulator clamped
to one interval before testing against that same interval and then reset to
zero, so at any tick rate whose period does not sum exactly (the shipped 10 Hz
included) every step threw away its remainder: fires spread ~10% slower than
their stated rates, and by an amount that depended on `TICK_HZ`. Fixing it
shifts the shipped feel by about that much, accepted by the owner as the price
of the rates meaning what they say.

## Decisions made 2026-08-25 (fire spreads to everything)

Owner: *"fire should spread across wheat, grass, boats, buildings — anything
that gets close enough to another fire should catch fire."*

**Spread is a question about distance, not about registries.** `spreadOnce`
used to read `blaze.fires()` and light cells through `blaze.ignite`, so both
ends of every spread were cells. Fire therefore could not cross between the two
fuel registries in either direction — a wildfire burned up to a moored boat and
stopped, a burning boat sat in a reed bed and lit nothing, and a boat alight
beside its neighbour left that neighbour untouched. Nothing about a flame
justified any of it; what decided it was which registry the owning plugin
happened to register in. A step now takes SOURCES (everything alight, cell or
individual) and TARGETS (everything flammable in reach, cell or individual) and
applies the same one product to all four combinations.

**`spreadRate` is keyed on a fractional offset.** The flat 1/√2 diagonal factor
is gone, replaced by `1/d` floored at one cell (`SPREAD_MIN_DISTANCE_CELLS`),
which is the same number wherever the old one applied — 1 cardinally, 1/√2 at a
corner — and is defined for a boat standing at (12.4, 9.9). `SPREAD_REACH_CELLS`
is √2, the corner distance of the eight-neighbourhood the file always used, so
cell-to-cell spread is unchanged *by construction* rather than by assertion.
Verified: a cardinal step is still exactly `BASE_SPREAD_RATE_PER_SECOND`.

**`EntityFuelSource.flammable()` is a second query, not a reuse of `entityAt`.**
`entityAt` is the *torch's* question ("of yours, which did the player aim at?")
and the contract promises sources it is asked only at ignition — pilgrims
answers it by building three arrays and spreading them. Spread asks "what is
near a flame" of a world with up to `FIRE_CELL_CAP` cells alight, every
`SPREAD_INTERVAL_SECONDS`; routing that through `entityAt` would be
O(burning × individuals) and would allocate the whole walker list 400 times a
second. `flammable()` is swept ONCE per step, so the cost is O(individuals).
Absent, a source can still be lit by torch and by lightning but cannot catch
from a nearby fire — the same degradation an absent cell source takes.

**Reach is edge-to-centre.** `FlammableIndividual.radiusCells` lets a two-cell
hull catch from further out than a walker standing at a point; walkers and
creatures declare 0, which is deliberately NOT their torch reach (that is the
half-cell *box* a click covers, and reusing it would let a walker catch from
further away than the ground they stand on).

**A burning individual lights the cell it stands on**, which a burning cell
obviously does not need to. That is what makes a fire that walks interesting: a
burning animal crossing dry grass starts a wildfire behind it.

**Grass is fuel now**, reversing the 2026-08-24 decision. That decision's
reasoning was right about the consequence and wrong about the magnitude, and the
correction is measured rather than argued (256² bed, 20 trials per point,
2026-08-25):

- At the shipped thinning — `FLORA_GRASS_SHARE_OF_256`/256 ≈ **0.398** — a
  meadow fire stays a local scorch at EVERY burn time tested (2 s → 1 cell,
  22 s → 26 cells mean / 204 max) and in a full gale. 0.398 sits just under the
  ~0.407 site-percolation threshold of the eight-neighbour lattice, so a meadow
  has no spanning cluster and fire cannot cross it.
- A SOLID bed of the same fuel runs away above 5 s — tens of thousands of cells,
  never self-extinguishing. That is the firestorm the old comment feared; it is
  unreachable at the shipped density, and that is the whole reason grass could
  be registered.
- **The lever is therefore density, not burn time.** `GRASS_CELLS_PER_TUFT` is
  the number to change if meadow fires should run, and crossing 0.407 flips the
  world from local scorches to unstoppable ones with very little in between.

Two hypotheses were tested and **rejected** on the way, recorded so they are not
re-tried: that `FLORA_GRASS_BURN_SECONDS` is the meadow's brake (it is not —
density is), and that `SPREAD_INTERVAL_SECONDS = 1` under-samples short-lived
fuel (it does not — `happensWithin` is exponential and cadence-neutral, and a
3 s burn still spends 2.5 s above `SPREAD_MIN_INTENSITY`; measured at cadences
from 1 s down to 0.1 s with no material difference).

`FLORA_GRASS_BURN_SECONDS = 3`: a flash, ordered grass < crop (4) < tree (22),
and enough rolls to hand the fire to a neighbouring tuft or to the tree it grows
under. A stale comment in `grass.ts` claiming the thinning rejects ~71% of green
cells was corrected to ~60% — it was never true of the shipped threshold, and
the difference is load-bearing now that the number decides percolation.

## Decisions made 2026-08-26 (fire is reacted to: flee, and smoke)

Fire has been wired as a SOURCE of events since 2026-08-24 and not at all as
something other plugins react to (issue #184). Two owner decisions close that,
and one closes a balance question deferred twice.

**Everything near a fire panics, and a burning thing panics hardest.** Both
halves, not one: bystanders near a new ignition startle, and an individual that
is itself alight gets a SUSTAINED panic lasting as long as it burns — not the
2.5 s `FLEE_DURATION_SECONDS` burst that sculpting produces. The two arrive by
different channels on purpose. A bystander learns from the new `fire:ignited`
world event, batched per tick exactly as `weather:strikes` is; the plugin that
OWNS a burning creature learns from the fuel source's existing
`onIgnited?.([ids])` callback, which already tells it which of its own entities
caught. Matching a broadcast event against your own positions to discover that
one of them is yours would be re-deriving an answer the registry already has.

**The balance question is answered: let it spread — that is the drama.**
DESIGN.md § "(fire that walks)" deferred "a panicking animal towing a spread
front through a forest" on 2026-08-24, and 2026-08-25 made it sharper by having
a burning individual light the cell it stands on. A panicking burning animal is
therefore a FIRE VECTOR, deliberately and without mitigation: its ignition is
not suppressed while panicked, its speed is not reduced, its panic is not
shortened. A wood going up because one torched deer ran into it is the intended
outcome, not a bug to tune away.

**Peeps are in scope, so the seam ships with two subscribers.** Pilgrims have
no equivalent of `startleNear` and one is written for them. Peep movement is
goal-driven, so panic must interrupt that pathing and hand it back — the two
primitives mirror each other in shape only, since the plugins are forbidden
from importing each other.

**Smoke keeps its own decay and OUTLIVES the flame (#185).** It is the one fire
visual NOT derived from `fireIntensity(age, burn)`: a burned-out fire still
smokes, and that lasting signature — "a fire happened here" — is the whole
feature. #185 is about an ESTABLISHED fire reading at DISTANCE, distinct from
#135's catching fire reading close up. A ground scar was considered as the
after-the-fact signature instead and rejected: it is a separate concern, not a
substitute for smoke. Smoke's lifetime is client-owned, keyed by the fire's
stable `key` and never by holding a `FireInstance` across frames; the residual
is that a client joining after a fire died sees no smoke for it, which is
accepted rather than paid for with server state. The flame's budget rules in
`plugins/fire/client/flames/types.ts` bind smoke unchanged — a plume per fire
done naively breaks the draw-call rule and is disqualified however good it
looks.

## Decisions made 2026-08-26 (the burn scar — the close-range half of smoke, #203)

Smoke's close-range falloff goes to ZERO inside `SMOKE_SILENT_DISTANCE` (9.6
world units), which is what fixed the grey-slab-in-the-face defect and left a
new one: at the closest zoom a wood that has finished burning shows nothing at
all — no flame, and now no smoke either. The record of 2026-08-26 above rejected
a ground scar as a SUBSTITUTE for smoke; the owner has now settled #203 by
shipping it as the thing that rejection left room for.

**One signature, two halves, and the crossover is the distance smoke goes
silent at.** The scar is at full strength where smoke is at nothing and fades
out as smoke comes up, so at every camera distance exactly one of the two is
carrying "a fire happened here". `SMOKE_SILENT_DISTANCE` is therefore not
copied into a second constant — it is the shared boundary, read once and used
by both, because two numbers that must agree are one number.

**The scar's LIFETIME is smoke's, not the world's.** It appears when the fire
does and retires on the same `SMOKE_AFTERLIFE_SECONDS` clock, keyed by the
fire's own stable key exactly as a smoke column is, with smoke's accepted
residual kept unchanged: a client that joins after a fire died sees neither
half of the signature. A PERSISTED burn record — a scar that survives a rejoin
— is a different feature and a question about world history, and it is
deliberately not being invented inside #203.

**The scar is drawn ON the terrain's own drawn surface, never modelled beside
it.** It is placed by querying `client/src/terrain/drawnGround.ts` for what the
terrain actually draws at that point, which is the rule the water work paid for
four rewrites to learn. It is a plugin-drawn decal in the fire plugin's own
client half and the terrain's colouring is not touched: tinting terrain
vertices would put a gameplay concern inside core, which §"nothing gamey in
core" forbids.

**The flame's budget rules bind the scar unchanged.** One instanced draw call,
constant in count, capped with the columns it accompanies — a quad per burned
cell done naively breaks the draw-call rule however good it looks, which is the
same bar smoke was held to.
