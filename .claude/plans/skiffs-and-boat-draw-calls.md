# Skiffs go fishing, and boats stop owning half the frame

Status: IN PROGRESS on branch `arc/skiffs-and-draw-calls` (pushed, unmerged).
Phase 1 of the boats arc (squadrons) shipped as `4b85631`. Tracked on GitHub
Issues 2026-09-05: D0-D2 = #367, #368, #369 (`arc/render-draw-call-budget`);
S1-S4 = #370, #371, #372, #373 (`arc/skiffs-go-fishing`).

**2026-09-06.** S1 SHIPPED (`b2052be`, #370 closed). D0 ATTEMPTED, NO NUMBERS.
Owner calls both answered: sharks ARE fishable (no exclusion list); skiffs are
VILLAGE-BOUND, not roaming.

Two corrections to this plan, evidenced in #367's comment thread:

- **D0 cannot be run on `the-windward-fells`.** It has 0 villages and 0 boats —
  as do `galewick-downs`, `moonreach` and `wilds-of-thornfall`. It is big
  *terrain* (2048x2048) with no settlements, so its `boats` ablation row would
  read ~0. `frostwick-hollows` (512x512, 119 villages, 231 boats) is the only
  world with a fleet and is almost certainly what the pre-squadron baseline was
  taken on. Bench it via a read-only `VACUUM INTO` copy (owner-approved
  2026-09-06); verify the copy reopens at 119/231 before benching.
- **Two agents cannot bench concurrently.** `scripts/gpu-bench.sh:88,97,99`
  hardcodes one Chrome profile and kills + `rm -rf`s it every launch, so the
  second caller destroys the first caller's run and sees only `NO SAMPLE`.
  Filed as #380; land it before the next D0 attempt.

The fleet distribution D0 did obtain (frostwick snapshot #1057): 231 boats,
77 villages with hulls, distance-from-home p50 21.33 cells, 219 of 231 beyond
10 cells. The squadrons effect this plan predicted, in the data.

Two arcs that touch the same plugin and must be sequenced together:

- **D — draw calls.** `.claude/orchestration/briefs/boats-draw-calls.md`: boats
  is ~150 of ~305 draw calls, three per hull, no instanced path.
- **S — skiffs.** Owner, 2026-09-05: "the small skiff boats should attempt to go
  where the fish are." Today a skiff is client-side fiction with no simulation.

## The constraint that ties them together

**A skiff costs 1 draw call today; a war boat costs 3.** Verified this session:

- `plugins/structures/client/skiffModels.ts:363` — the whole skiff fleet draws
  through ONE `InstancedMesh`, capacity `STRUCTURES_CAP x SKIFF_MAX_PER_SETTLEMENT`
  = 1536. The asset loader at `:280-289` *rejects* an asset that is not a single
  mesh, so this is enforced, not merely observed.
- `plugins/boats/client/models.ts:376` — `create()` calls `instantiateRig` per
  boat; `client/src/render/rigSkin.ts:428-437` — that builds a fresh `Skeleton`
  and **one `SkinnedMesh` per surface per instance**. Nothing is instanced.
- `plugins/boats/client/models.ts:380-382` — plus a `Mesh` for the sail with a
  **cloned material per boat**, so it can be tinted when `fighting`.
- `plugins/boats/client/models.ts:372` — `drawObjects = surfaceCount + 1`;
  `plugins/boats/client/index.ts:181` — `drawBudget = BOATS_PAYLOAD_CAP x
  drawObjects` = 2048 x 3 = 6144 declared.

**Therefore the S phases must not move skiffs onto the war-boat rig path.**
Promoting ~45 skiffs from the instanced path to the per-instance path would add
~135 draw calls to a frame already at 8.46 ms GPU against a 6.94 ms budget. The
skiff's *source of truth* moves to the server; its *drawing* stays one
`InstancedMesh`. This is the single hardest requirement in the S phases and
every one of them is written against it.

## Ordering: D before S

The frame is over budget **now** (`8.46 ms` p50 GPU, `~305` draw calls,
measured 2026-09-05), and Phase 1 plausibly made it worse in a way the brief's
numbers predate: squadrons put 24 of 45 hulls out on open water instead of
clustered at moorings, so fewer hulls fall outside the frustum at once. The
brief itself flags that the fleet size at measurement was not recorded and that
`4b85631` landed mid-session.

D is independent of S and fixes what is actually broken today. S adds hulls.
Do D first.

---

# Arc D — boats onto an instanced path

## D0 — an honest baseline (no code)

The brief's five runs predate squadrons. Re-measure on a **copy** of a grown
world on the isolated 2599/5199 stack (`scripts/gpu-bench.md`), and **record
the fleet size and how many are at sea**, which no prior run did.

```
export TERRACE_PERF_SINK=<abs>/.gpu-bench-run/sink.jsonl
bash scripts/gpu-bench.sh ablate  baseline-post-squadrons
bash scripts/gpu-bench.sh overview baseline-post-squadrons
```

Read `sample.gpuMsP50`, `sample.drawCalls`, the `ablation[]` row for `boats`,
and `noise.baselineGpuMsMeanStep` as the error bar. Vite on `/mnt/e` never
watches — restart it after any client edit or you bench the old bundle.

**Done when:** a recorded before-number with a fleet count beside it. No edits.

**DONE 2026-09-06** (#367 closed, full table in its comment thread). Stack 2598/
5198 from this worktree — a peer owned 2599/5199. World: `VACUUM INTO` copy of
`frostwick-hollows`, loaded as snapshot #1057, verified at 119 villages / 231
boats / 118 structures. 1584x805.

| | |
| --- | --- |
| baseline draw calls | **373** |
| baseline GPU p50 | **5.544 ms** |
| error bar (`noise.baselineGpuMsMeanStep`) | **0.135 ms** |
| **boats** | **180 draw calls, 1.231 ms GPU, 1.30 ms frame** |
| next largest (pilgrims) | 59.5 draw calls, 0.627 ms |
| `overview`, live sim | 357 draws, 5.518 ms GPU p50, 182.7 fps |

Boats are **48% of the frame's draw calls** — 180 at 3/hull is ~60 hulls in
frame of 231 in the world. Boats cost more CPU (1.30 ms) than GPU (1.23 ms),
the signature of submission cost, which is what D1 and D2 remove. Contrast
fire: 2.04 ms GPU from 5 draws — fill, which instancing cannot touch.

Caveat carried forward: 1600x900 is not the owner's fullscreen-1440p target
(2.6x the pixels). Kept for comparability with the historical numbers; the
budget question must be re-asked at fullscreen.

## D1 — the sail leaves the per-instance path

The sail is the easier half and is a blocker for D2 regardless: it is never
baked into the rig (`models.ts:350-357` removes `sailNode` before `bakeRig` and
re-parents it after), it is a separate `Mesh`, and its material is cloned per
boat purely so `fighting` can tint it (`models.ts:419-421`).

Make the sails one `InstancedMesh` with an instanced colour attribute, tint
written per instance. Removes one draw call per hull — about a third of the
boats total — on its own.

**Done when:** ablation shows boats' draw calls fall by ~1/3 and the drop clears
`baselineGpuMsMeanStep`; sails still visibly tint red in a fight.

**DONE 2026-09-06** (`54b3cf2`, #368 closed). A/B on one world snapshot (#1071),
restored between runs, bundle verified over HTTP each side:

| | pre-D1 | D1 |
| --- | --- | --- |
| boats' draw calls | 213 | **145 (−32%)** |
| whole frame draw calls | 336 | 283 |
| boats GPU / frame ms | 2.23 / 2.20 | 1.67 / 1.55 |
| whole-frame GPU p50 | 5.151 | 5.332 (inside the 0.419 error bar) |

Draw calls fell by the designed third. **Whole-frame GPU time did not move
outside noise** — the win is submission cost, and it shows in boats' own row,
not in the frame total at this window size. Visual: the preview pair is
PIXEL-IDENTICAL before and after (0 of 1,024,000 differ).

Two rig failures found and fixed on main while measuring: `npx vite` hides the
server's real pid, so a restart silently left the OLD bundle serving (the first
D1 numbers were discarded); and the world simulates between runs, moving fire's
row 2.04 → 0.55 ms on scene drift alone. The bench now warns on a
clientVersion mismatch, and the A/B rig restores a pristine world per side.

## D1b — the hull's two surfaces become one (#381)

**Owner, 2026-09-06: do this and D2; the third lever — fewer hulls in frame —
is off the table ("I am not ready yet to reduce the number of boats").**

**Run this BEFORE D2.** A hull costs 2 draw calls because of one textured
material. Verified from the asset, not from a comment: `war-boat.glb` carries
`deck_flat`, `wood_dark`, `sail_canvas` (flat) and `hull_mapped` (a
`baseColorTexture`), and `bakeRig` keys its merge on map identity
(`client/src/render/rigSkin.ts:331`) — so the flat pieces merge and the textured
hull stands alone. Give the hull its colour by vertex colour or the shared
atlas and `surfaceCount` goes 2 -> 1.

Worth on its own: boats 145 -> ~72 draws, frame 283 -> ~210. After D2 it turns
the fleet's 2 draws into 1. It carries no animation seam, and it shrinks what
D2 has to justify — which is the point of doing it first.

**Done when:** `BOAT_SHAPE.drawObjects` is 1, ablation shows boats' draws
roughly halve, and the preview pair is compared by EYE against the pre-change
shot. D1's pixel-identical bar does NOT apply here: a texture-to-vertex-colour
change is meant to look slightly different, so the owner's eye is the acceptance.

## D2 — the hull onto `rigHerd`

`client/src/render/rigHerd.ts:190` (`createRigHerd`) is the instanced
skinned-rig path wildlife already uses (`plugins/wildlife/client/models.ts:352`),
quantising animation into shared pose slots held in a bone-matrix palette.

Boats' oar swing and swell are pure functions of `elapsed + phase`
(`models.ts:400-412`) — exactly what a pose slot quantises. **The obstacle is
real and named:** `fighting` changes the stroke *rate*, not the phase
(`models.ts:405`, `OAR_FIGHTING_RATE`), so fighting and calm hulls do not share
a pose cycle. Two sub-options, decide with a measurement rather than taste:

- **Two herds**, one per stroke rate, and a hull migrates between them when
  `fighting` flips. Simple; costs a second palette.
- **One herd, phase-accumulator per hull.** A rate change cannot be expressed as
  a phase *multiplier* without a visible jump at the transition — the phase must
  be integrated, `phase += rate * dt`, and the slot chosen from the accumulated
  phase. One palette, and no discontinuity.

Recommend the accumulator; it is one herd and has no seam at the transition.

**Sized after D1 (2026-09-06):** boats are still **145 of 283 draw calls, 51% of
the frame**. This phase takes that to ~2 (or ~1 after D1b): frame -> ~141. It is
the whole remaining prize.

**Judge it on the boats row, not the frame total.** D1's win was real and
whole-frame GPU p50 could not see it (5.151 -> 5.332 ms against a 0.419 ms error
bar). Read boats' `drawCallsSaved`, its `gpuMsSaved` and its `frameMsSaved`.

**Do not assume this wins.** The brief's own caveat is verified-worth-keeping:
wildlife's palette uploads are themselves measured stalls (`texSubImage2D`
92x32 at **0.89 ms**, 68x32 at **0.63 ms**, while 344x32 costs 0.031 ms — cost
that does not scale with size is a driver stall on a texture still in use by the
in-flight frame). Trading ~150 draw calls for another palette upload per frame
is a trade, not a free lunch.

**Done when:** re-measured against D0 on the same scenario and camera, with the
delta clearing the error bar. If it does not clear it, D2 is **reverted**, not
kept — and the finding is written into the brief.

---

# Arc S — skiffs

## The architecture decision, made

**Skiffs go into `plugins/boats`, not a new `plugins/skiffs`.**

Rejected: a separate plugin. Plugins may not import each other, so a skiffs
plugin would have to duplicate `isHullPose`, `HULL_PROFILE`, the draft
derivation and `resolveOverlaps` — and `CLAUDE.md`'s hard rule is that terrain
math has exactly one source. The alternative (promote hull-pose into `shared/`)
is defensible but is a `shared/` change in service of a plugin's convenience,
and it would still leave the two fleets resolving overlaps in separate passes,
which is precisely how GH #327 happened.

Rejected: leave skiffs client-side and steer them locally. Structures' client
cannot see wildlife (plugin independence), and roaming skiffs re-open #327
because the inshore-band zoning assumed static moorings.

`plugins/boats` already listens to `structures:changes` for villages, already
surveys the inshore band (`surveyedLaunch` computes an `inshore` list today and
throws it away except as a pocket-bay fallback), and already owns the one
overlap-resolution pass. Skiffs belong there. `fleet.ts` is 2400+ lines and will
need splitting as part of S2.

## S1 — `wildlife:shoals` on the event bus

Wildlife emits nothing today (it only *listens*, for fire). Add an emitter
modelled exactly on `plugins/monsters/server/index.ts:192-203`'s
`emitPositions` — server-side `WorldApi.emitEvent`, not a broadcast, so no wire
bytes and no fog-of-war question.

**Centroids, not fish.** `WildlifeEntity.schoolId` is already first-class
(`plugins/wildlife/server/population.ts:121`) with `schoolMembers()` at `:375`,
and schools are far fewer than fish. Emit one point per school.

**Which species: every `habitat: 'shallow'` one, derived and not typed out.**
Verified in `plugins/wildlife/server/species.ts` and `species/*.ts`: shallow =
`fish`, `angelfish`, `eel`, `ray`, `shark`; deep = `whale`, `deepsea`; the rest
are land. Deriving from the habitat means a future shallow species is fishable
the day it lands, with no list to forget. *Open call for the owner: this makes
sharks fishable. Funny, possibly wrong — say if skiffs should avoid them.*

- Deliverable: emitter + a `parseShoalSightings` validator in
  `plugins/boats/server/events.ts` alongside the monster and village ones.
- Contract tests: the parser rejects malformed payloads whole and accepts
  unknown species rather than failing on them (the rule
  `parseMonsterSightings` already holds).
- **No consumer yet.** Ships alone, changes nothing visible.

**Done when:** the event fires at the wildlife tick rate with the expected
school count, typecheck and the wildlife + boats suites pass.

## S2 — skiffs become authoritative, and look exactly as they do now

The big phase, and deliberately **behaviour-neutral**: the acceptance test is
"the owner cannot see a difference." Everything moves; nothing changes.

- **Server:** a skiff roster per village — tier to count, the rule that lives in
  `skiffsForSettlement` today (`SKIFF_MAX_PER_SETTLEMENT`, `SKIFF_MIN_TIER`)
  moves to the server. Each skiff is a hull at a surveyed **inshore** mooring,
  with its own shallower draft constant, and rides the same `isHullPose` /
  `resolveOverlaps` machinery as the war boats.
- **Wire:** a `skiffs:state` broadcast, shaped on `boats:state` and fog-filtered
  through `broadcastVisible` the same way (`plugins/boats/server/index.ts:116`).
  Its own payload cap, derived from `STRUCTURES_CAP x SKIFF_MAX_PER_SETTLEMENT`
  rather than restated.
- **Client:** `structures/client` stops inventing skiffs — `skiffsForSettlement`
  and `placement.ts`'s second claiming pass are deleted, not left dead. A new
  `boats/client` consumer feeds the **existing** `skiffModels` `InstancedMesh`,
  which moves to `boats/client` with it. `apply()` takes wire positions;
  `animate()` keeps only the bob, since the orbit is now the server's.
- **Persistence: none.** War boats persist because a lost fleet is a cost with a
  20-second rebuild. A skiff has no such stake, and its position is rederivable
  from its village's survey — so skiffs re-float at their moorings on restart.
  State this in the decision record rather than leaving it implied.

The mooring survey the client does today (`structures/client/site.ts`'s
`surveySite`, with its under-count-never-over-count contract) is replaced by the
server's `inshore` list, which is already computed and already zoned off the
war-boat berths by `BERTH_STANDOFF_CELLS`.

- Contract tests: the tier-to-count rule; a skiff is never placed on a pose the
  hull law refuses; two villages never claim one mooring (the #327 guarantee,
  now enforced server-side in one pass instead of by a client claiming loop).

**Done when:** eyes-on in-world screenshot comparison against a pre-S2 capture,
published as an Artifact; draw calls unchanged (this is the constraint —
verify with `ablate`, not by inspection); the boats and structures suites pass.

**Risk, stated:** this is the phase that can regress draw calls, delete a
working client path, and change how every skiff in the world is placed, all at
once. It is worth its own worktree and its own review pass.

## S3 — skiffs fish

Only now does behaviour change. A skiff's goal source becomes, in order:

1. Its mooring, when no shoal is in reach — today's behaviour, unchanged.
2. The nearest shoal centroid within a fishing range of its **home village**,
   bounded exactly the way `targetFor` bounds a war boat's kraken so a skiff
   cannot be walked across the ocean by a drifting school.
3. Home, when the shoal leaves or a fishing bout times out.

Reuses `sailBoat`'s goal-selection block and the `Voyage` machinery wholesale —
the same seam squadrons plugged into, with a fourth `BerthList` value.

**Skiffs do not catch anything.** The owner asked that they "attempt to go where
the fish are"; a catch mechanic is a new game rule and is not in scope. Named
here as a punt with a reason, not deferred silently.

**Open call for the owner, needed before S3 starts and not before:** does a
skiff stay bound to its home village, or may it roam like a squadron? Recommend
village-bound — a fishing village's boats coming home is the fiction, and it
keeps the fishing range small enough that the shoal event stays cheap.

- Contract tests: goal precedence; a skiff never leaves its home range; a shoal
  that vanishes mid-bout sends the skiff home rather than to a stale point.

**Done when:** eyes-on in-world, published as an Artifact — a skiff visibly
leaves its mooring for a school and returns.

## S4 — the two fleets share water

S3 breaks the assumption GH #327's fix rests on. That fix (`structures/protocol.ts:487-520`,
`HARBOUR_INSHORE_BAND_WORLD_UNITS`) separates skiffs from war boats by a
distance **band measured from each village's shoreline** — which works only
while a skiff stays on its mooring. A fishing skiff crosses the band by design.

Since S2 puts both fleets in one `resolveOverlaps` pass, hull separation is
handled by construction. What is *not* handled and must be decided here:

- A skiff and a war boat converging on the same water at different drafts — the
  shallower hull can legally be where the deeper one cannot.
- Whether the inshore band still means anything once skiffs leave it, or whether
  it collapses to "where a skiff moors" and stops being a keep-out zone.

**Done when:** the band's remaining meaning is written into
`docs/decisions/kraken.md` or a new `docs/decisions/skiffs.md`, and eyes-on
confirms no hull-on-hull collisions across a harbour with both fleets active.

---

## Sequencing summary

| Phase | Depends on | Visible change | Owner call needed |
| --- | --- | --- | --- |
| D0 | — | none (measurement) | no |
| D1 | D0 | none | no |
| D2 | D1 | none | no |
| S1 | — | none | sharks fishable? |
| S2 | S1 | none, by design | no |
| S3 | S2 | skiffs fish | village-bound or roaming? |
| S4 | S3 | none, by design | no |

D and S1 are independent and can run in either order. S2 is the largest and
riskiest single phase; S1 is small enough to fold into S2 if the owner would
rather not ship a producer with no consumer.
