# Brief 5A report — the wolf in game (#335)

Worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a0e8ba0011638ab17`,
branch `worktree-agent-a0e8ba0011638ab17`. Not merged, not pushed.

| commit | deliverable |
|--------|-------------|
| `5ab9405` | D0 — `stat_glb.py` ignores the glTF importer's fabricated bone-display mesh |
| `05a1439` | D1 — `plugins/wildlife/client/assets/wolf.glb` + its `LICENSES.md` entry |
| `381f37b` | D2 + D3 — client species, server profile, every table |
| `2e7baf7` | D5 — the population-cap table re-pinned; `hookTimeout` matched to `testTimeout` |
| `21de4e0` | preview-wildlife installs from the one asset list (needed for the pool-path shot) |

---

## D0 — the `--footprint` defect, fixed at the root

**Reproduced first.** `stat_glb.py --footprint 0.62 0.62 --height 0.464` on the
shipped deer, run from the SHARED checkout's unmodified copy:

```
  bbox world units: x=1.902 y=2.000 z=2.000
    Icosphere: 80 tris, materials=[], uv=['UVMap'], parent=(none)
  FIT FAIL: x = 1.902 ... y = 2.000 ... z = 2.000       exit 1
```

**What actually marks it — verified in Blender 5.2.1, not guessed.** A probe
(`.model-import/probe_icosphere.py`) dumped every object the importer produced
from `grazer-deer.glb`, with its custom properties, parent, parent type, vertex
groups, modifiers and collections. The Icosphere carries:

* no custom property (`custom_props={}`, as does every other object);
* no distinguishing name beyond `Icosphere`;
* **`parent=None`** — so the brief's fallback ("drop meshes that are children of
  an armature and have no vertex groups") would NOT have caught it; the deer's
  seven real meshes are the ones parented to `AnimalArmature`, and the sphere is
  parented to nothing.

Its one distinguishing fact is its collection: every real object is in
`Collection`, and the Icosphere alone is in **`glTF_not_exported`**, which is
also why the exporter never writes it back out.

**The fix** (`tools/blender/stat_glb.py:41-63`): a named constant
`GLTF_IMPORTER_SCAFFOLDING_COLLECTION`, a predicate `is_importer_scaffolding`,
and `model_objects()` — used by `world_bounds()` (the box, hence the fit check)
and by `print_stats` (the mesh/empty/armature listing, so a reviewer's counts
match the file too).

**Proof** — same command, worktree copy:

```
  bbox world units: x=0.477 y=0.464 z=0.158  min-y=-0.000
  meshes: 7   total: 2096 tris   armatures: 1   skinned meshes: 7
  FIT OK: within 0.62 x 0.62 cells and 0.464 high, tolerance 0.02      exit 0
```

0.477 x 0.464 x 0.158 and 2 096 triangles are exactly the numbers
`plugins/wildlife/client/assets/LICENSES.md` already records for the deer, so
the box is the same box as before the defect and not merely a smaller one.

`import_model.py` is deliberately NOT changed: it drops the sphere by name
(`--drop Icosphere`) because it must also drop art the source itself carries,
and the brief's D1 command records that flag. Named as a follow-up rather than
punted silently: it could now use the same predicate and make `--drop Icosphere`
unnecessary for every skinned import. Not done here — it would change every
recorded import command in the repo.

## D1 — the import

`plugins/wildlife/client/assets/wolf.glb`, 215 608 bytes, 1 962 triangles, 4
materials, no textures, armature kept as a glTF skin (51 joints), **no
`--rigidify`**. The exact command and the licence are in
`plugins/wildlife/client/assets/LICENSES.md` (the `## wolf.glb — the wolf`
section, which also argues every flag that differs from the deer's).

### Height — 0.348, derived

`0.464 x 0.75`. The deer's 0.464 is `GRAZER_HEIGHT_WORLD_UNITS`
(`plugins/wildlife/client/species/grazer.ts:83`). 0.75 is the shoulder-height
ratio of a grey wolf to a deer (~0.8 m against ~1.05 m); both models carry
their crown at the EAR TIPS with the head up, so the shoulder ratio carries to
the crown without a second measurement. Result: the shortest land animal in the
plugin (bison 0.54, ibex 0.511, grazer 0.464) and 0.56 x PILGRIM_HEIGHT 0.62 —
plainly under the rule rather than near it. **Assumption:** the two real-world
shoulder heights are from general knowledge, not a cited source; the RATIO is
what the design rests on, and it is the ratio the brief asked for ("stands lower
than the deer's 0.464 and below PILGRIM_HEIGHT").

### Footprint — 0.8 x 0.8, deliberately not binding

At height 0.348 the model measures 0.721 along X. 0.8 is the next round number
that clears it, so `fit_to_footprint`'s `min(ratios)` picks the HEIGHT and the
file measures 0.348 exactly — the same arrangement the deer's `--footprint 0.62
0.62 --height 0.464` has. (Verified from the import's own line: `scaled by
0.129802 -> 0.721 x 0.138 cells, 0.348 high`.)

### Renames

`FrontUpperLeg.L/R=foreLeft/foreRight`, `BackLeg.L/R=hindLeft/hindRight`,
`Head=head`. `BackLeg`, not `BackUpperLeg`, and this differs from the brief's
wording ("the four upper-leg bones") on purpose: a bone probe of the exported
file puts `hindLeft` at y 0.2300 (the hip, under `BackShoulder.L`) with
`BackUpperLeg.L` at y 0.1747 below it — the stifle. `modelAxisPivot`
(`plugins/wildlife/client/species/assetSpecies.ts:429`) re-homes a driven joint
under `rig` and severs the chain above it, so driving the hip swings the whole
leg and driving the stifle would swing only the shank. It is also exactly what
the deer's command does (`BackLeg.L=hindLeft`). The fore chain has no such pair:
`FrontUpperLeg` IS the shoulder joint (y 0.1906, under `FrontShoulder.L`).

### Measured envelope

A per-vertex probe of the fitted file (`.model-import/probe_extremes.py`), then
the anchors placed at those exact points and the file re-imported:

| station | measured point (export frame) | on |
|---------|-------------------------------|----|
| nose (max x) | 0.3604, 0.2747, 0.0000 | `Wolf_Nose` |
| tail_tip (min x) | -0.3604, 0.2800, 0.0000 | `Wolf_Main` |
| crown (max y) | 0.3043, **0.3480**, 0.0485 | `Wolf_Main` (an ear tip) |
| belly (min y) | -0.0643, **0.0000**, -0.0376 | `Wolf_Main_Light` (a hind paw) |
| flank (max z) | 0.1663, 0.1744, **0.0691** | `Wolf_Main` (the ribs) |

Box **0.721 x 0.348 x 0.138**. `stat_glb.py --footprint 0.8 0.8 --height 0.348`
on the exported file: `FIT OK`, exit 0. The five anchors round-trip
(`nose: (0.360, 0.275, -0.000)` and friends in the stat output), and
`installSpeciesAsset` accepted the file without throwing, which is the real
check: it asserts all five against the declared envelope at load.

## D2 — the client

`plugins/wildlife/client/species/wolf.ts`, on the `assetSpecies.ts` contract:
envelope declared and asserted, `rigidified: true`, joints
`rig/foreLeft/foreRight/hindLeft/hindRight/head`, `adopt` for
`IKFrontLegL/R -> foreLeft/foreRight` and `IKBackLegL/R -> hindLeft/hindRight`.

**PoleTargets: NOT adopted, and that is measured, not assumed.** A weight probe
over the exported file (`.model-import/probe_weights.py`, threshold
`MIN_MEANINGFUL_WEIGHT` = 1e-4, the same one `import_model.py:64` uses) walked
all 4 030 vertices of all four meshes and tallied every vertex group. Result:
46 groups carry weight; `PoleTarget.L`, `PoleTarget.R`, `PoleTargetBack.L`,
`PoleTargetBack.R` and `Body` carry **none above 1e-4 on any vertex**. The four
IK bones by contrast carry real weight (`IKBackLeg.L/R` sumW 78.21,
`IKFrontLeg.L/R` sumW 64.55, plus their `FFB`/`FF` children at 76.32/106.03),
which is why they must be adopted. The same probe reports **3 500 of 4 030
vertices shared across two bones or more**, the number quoted in the file header
and in LICENSES.md.

Gait, all derived rather than eyeballed:

* `WOLF_PAW_SPAN_WORLD_UNITS = 0.314` — measured (vertices at y <= 0.02 span
  x -0.1066..0.2074). Used instead of the envelope length because a third of
  the wolf's box is tail.
* `STRIDE_HZ = 1.0 / 0.314 = 3.18`. Cross-check: 1.6x the grazer's 2.0 for an
  animal with legs 0.75 as long moving 1.25x as fast (1.25 / 0.75 = 1.67).
* `LEG_SWING_RADIANS = 0.32` — unchanged from the grazer, on purpose.
* `WALK_BOB = 0.012 x 0.75`, `HEAD_NOD = 0.05 x 0.75` — the grazer's, scaled by
  the same crown ratio the height is.
* `WOLF_STANCE_FRACTION_OF_HALF_LENGTH = 0.6` -> `bodyHalfLength` 0.216. This
  is the one place the wolf does NOT follow the grazer, and the reason is
  measured: the grazer probes its whole half-length and calls the surplus "at
  most the tail's overhang", which on a wolf is 0.153 world units (0.6 of a
  cell) of ground under a tail that bears no weight. `walkerGroundY` stands a
  creature on the HIGHEST cell it probes, so that surplus is an animal hovering
  beside a riser its tail merely overhangs. 0.6 is the measured 0.2074/0.3604 =
  0.575 rounded up; it stays a fraction of the asserted envelope so a re-import
  moves both together.

`surfaceCount` **MEASURED, not assumed**: a throwaway Node script installed the
file through `installSpeciesAsset` and baked it through `bakeRig` — wolf
`surfaceCount=1`, deer `surfaceCount=1` (control). Four glTF materials that
differ only in base colour, which `materialSignature` leaves out.

### Wiring points

| file:line | what |
|-----------|------|
| `plugins/wildlife/client/species/assets.ts:28-29,44` | the one asset list |
| `plugins/wildlife/client/models.ts:78,546,616` | import, drawable, `drawableOf` case |
| `plugins/wildlife/client/placement.ts:37,183,303,334,674` | envelope import, `SWIM_PROFILES`, `FLIGHT_ALTITUDES`, `BODY_COLUMNS`, `WALKER_FOOTPRINT_HALF_EXTENT_BY_SPECIES` |
| `plugins/wildlife/client/index.ts:272,317-326,327-331` | budget table row, `WOLF_ASSET_DRAW_OBJECTS`, the sum |
| `client/src/previewSpecies.ts:41,52` | preview species map |

`placementKindOf` returns `'walker'` by construction (no flight altitude, no
swim profile) — `plugins/wildlife/client/placement.ts:354-357`.

## D3 — the server

`plugins/wildlife/server/species/wolf.ts`; `'wolf'` **appended last** to
`WILDLIFE_HABITAT_SPECIES` (`plugins/wildlife/protocol.ts:52-56`); wired at
`plugins/wildlife/server/species.ts:36` (import), `:54` (re-export), `:249`
(the table row).

| field | value | argument |
|-------|-------|----------|
| `cruiseSpeedCellsPerSecond` | `cellsAcross(1.0)` | Exactly between the halved grazer's 0.8 and the ibex's 1.2. **Checked**: the ibex at 1.2 is the fastest thing on land, so this is under it; the bison at 0.6 stays the slowest, so `SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND` and the fire alarm derived from it (`plugins/wildlife/server/index.ts:200`) do not move. That derivation is a `min` over the table, so it is true by construction, not by inspection. |
| `turnNoiseRadiansPerSecond` | 0.9 | Steadier than the grazer's 1.1 and the ibex's 1.3, well above the bison's 0.5. |
| `bodyLengthCells` | `cellsAcross(1.0)` | Steering body (look-ahead, personal space, school spacing), not the model box — the box is 0.72 only because a third is tail. Order: bison 1.6 > grazer 1.1 > wolf 1.0 > ibex 0.9. |
| `habitatCellsPerIndividual` | `cellsOverArea(2000)` | The LOWEST land density, against the grazer's **100** (not 2 700 — the grazer's figure was cut on 2026-08-23; the 2 700 the brief quotes is the pre-cut number, `plugins/wildlife/server/species.ts:190-210` records both). Twenty grazers to a wolf. On the nominal 512² world it asks for 65 against a previous total of 2 099, i.e. ~3% off every other species. |
| `groupSize` | 2, `SOLITARY_SCHOOLING_PROBABILITY_BY_SIZE` | A pair born together and dispersed, like the grazer's triplet. A pack that HELD together would need the bison's real schooling plus `groupStartle`, and both of those exist to carry a startle through a herd — which is predation's machinery. |
| `idle` | `{ onsetPerSecond: 0.05, endPerSecond: 0.4 }` | ~20 s moving, ~2.5 s stopped = 11% still: the least still animal in the table, against the ibex's 24% (0.08/0.25) and the bison's 33% (0.05/0.1). Onset matches the bison's (long walks between pauses); the end rate is the fastest here (a check, not a rest). |
| `spawnGround` | `{ kind: 'open', minOpenDirections: GRAZER_SPAWN_OPEN_DIRECTIONS }` | Open country, the grazer's constant rather than a second 5. |
| `spawnHeights` | `SPAWN_AT_ANY_HEIGHT` | Any height, like the grazer. A wolf's range is not a band of the land ramp, and pinning it to the uplands would put it where the grazer never is. |
| `maxGradientPerCell` | `LAND_WALKER_MAX_GRADIENT_PER_CELL` | A plain walker; the doubled limit is the ibex's whole idea. |
| `hunts` | **unset** | See the punt below. |

`shared/` is untouched. Nothing in this change does arithmetic that has to be
deterministic across client and server.

## D4 — eyes-on

All four viewed with the Read tool before anything below was written.

| shot | path |
|------|------|
| side | `.model-import/shots/wildlife/wolf-side.png` |
| iso | `.model-import/shots/wildlife/wolf-iso.png` |
| stride, t=0.125 | `.model-import/shots/wildlife/wolf-stride.png` |
| pool path (`preview-wildlife.html?species=wolf`) | `.model-import/shots/wildlife/wolf-wired.png` |

What I see: a grey wolf standing square on four paws, **head to +X** (facing
right in the side view, which is forward). Paws — not hooves — with pale toes,
all four soles on the ground plane, none sunk into it and none floating. Pale
cheeks, muzzle, throat and chest against the dark coat, a black nose and eye,
ears up, tail out behind and level. **No seams** at shoulder, hip, neck or
tail: the coat is one continuous surface across every joint, which is the thing
`--rigidify` broke on the deer. **No stray geometry at the origin** — nothing
between or under the legs, and no sphere.

The stride shot at t=0.125 shows the legs in diagonal pairs (near fore forward
with near hind back), each leg swinging as a WHOLE from its shoulder or hip with
the paw carried along — which is the `adopt` of the four IK targets working;
without it four paw stubs would stand still on the ground. Still no seam at the
swinging joints.

The wired shot is the same animal through `createWildlifeModels`, reported by
the harness as `poolSurfaces: 18` — exactly `WILDLIFE_SPECIES_DRAW_OBJECTS`
(8 + 1 + 1 + 4 x 2), so `attach`'s boot-time assertion passes.

The preview-wildlife harness did NOT accept `?species=wolf` when I got there,
and would not have accepted `ray`, `shark`, `eel` or `angelfish` either: it
hand-listed the fish and the grazer as the only assets to install
(`client/src/previewWildlife.ts:233-234`, stale since the ray landed) while
`createWildlifeModels` bakes every species eagerly, so it threw before drawing
anything. Fixed by pointing it at `species/assets.ts`, THE ONE LIST that the
plugin's preload and previewSpecies already read (`21de4e0`).

## D5 — checks

* `pnpm typecheck` — clean, all 30 workspace packages.
* `timeout 300 pnpm --filter @terrace/plugin-wildlife test` — **5 files, 48
  tests, all pass**.
* `timeout 300 pnpm --filter client exec vitest run test/rigAsset.test.ts
  test/rigSkinMaterials.test.ts test/rigSkin.test.ts` — **3 files, 21 tests,
  all pass**.
* Census/spawn-order tests outside the plugin: grepped `server/test/` for
  `WILDLIFE_HABITAT_SPECIES` / `WILDLIFE_SPECIES` — **no hits**; the four server
  tests that mention wildlife do so only in prose. Nothing else to run.
* `pnpm -r test` was NOT run.

### The one existing test edited, and why

`plugins/wildlife/test/wildlife.test.ts:283-317` enumerates the population
target for every species by hand. Adding a species necessarily changes it. New
table (all values are what `targetsFor` returns, not what I wanted it to
return): fish 51, whale 15, deepsea 20, grazer 514, ibex 73, bison 85, ray 16,
shark 7, eel 13, angelfish 25, **wolf 25**; total 844 (was 846), still under
`WILDLIFE_POPULATION_CAP` 850. Raw demand went 2 099 -> 2 164 and the scale
850/2 164 ~ 0.393. The comment above the table is updated with the same
arithmetic. The other enumerating test (`expect(new
Set(Object.values(targets)).size).toBe(WILDLIFE_HABITAT_SPECIES.length)`) needed
no edit — the wolf's density gives it a distinct count.

### A second, unrelated fix that D5 forced — flagged for review

Adding the wolf made `wildlife.test.ts`'s `beforeAll` (the settled population,
documented in the file at "about eight seconds of wall clock") exceed **10
seconds** and the whole suite fail. That 10 s is Vitest's DEFAULT hook budget:
`vitest.base.config.ts` raises `testTimeout` to 30 s with a long argument about
slow fixtures, and never touches `hookTimeout` — so a fixture built in a hook
got a third of the rail the assertions it feeds get, and the suite was one
species away from failing on a limit nobody had chosen. Fixed at the contract
layer: `hookTimeout: 30_000` beside `testTimeout: 30_000`, workspace-wide, with
the reasoning in place. Raising a timeout cannot make a passing test fail, so
the blast radius is one-directional. **It is a root-file change and other
sessions may be in that file — worth the orchestrator's eye at merge.**

## The punt, named

**Predation is not implemented and is not stubbed.** The wolf hunts nothing,
nothing flees it, and no other species' row changed. `SpeciesProfile.hunts`
(the `Predation` type at `plugins/wildlife/server/species/profile.ts:596,667`)
already existed before this brief and remains unset and unused by every row —
I added no flag, field or hook toward it. It is an owner design decision:
whether wolves eat grazers changes the population equilibrium, the alarm
machinery and the meaning of `groupStartle`, and half-wiring it would ship a
mechanic nobody chose. Stated in the source too, in both wolf files' headers,
so the next reader does not take the silence for an oversight.

## Verified vs assumed

**Verified by running or measuring, this session:**

* the `--footprint` defect, its marker (`glTF_not_exported`), and the fix's
  before/after on the deer;
* the wolf's box, its five anchor extremes and its paw span — per-vertex probes
  of the exported file;
* PoleTarget bones carry no weight; the four IK bones do — a full weight tally;
* `hindLeft`/`foreLeft` are the hip and the shoulder — a bone-position probe;
* `surfaceCount = 1` — a real `bakeRig`, with the deer as a control;
* `installSpeciesAsset` accepts the file (its five envelope assertions pass);
* the pool bakes 18 surfaces, matching `drawBudget`;
* the four screenshots, viewed;
* typecheck and the three test commands above.

**Assumed, and labelled where it matters:**

* **Assumption:** the ~0.8 m / ~1.05 m shoulder heights behind
  `WOLF_TO_GRAZER_CROWN_RATIO = 0.75` are general knowledge, not a cited
  measurement. Confirmable by replacing the ratio with any other and re-running
  the import; nothing else in the change depends on the absolute value.
* **Assumption:** `turnNoiseRadiansPerSecond 0.9` and `bodyLengthCells 1.0` are
  placed by their ORDER against the other three land species, which is how
  every other row in the table is argued; there is no measurement that fixes
  them.
* **Assumption:** the gait reads right in motion. I have a single frame at
  t = 0.125, not a clip — the diagonal pairing, the whole-leg swing and the
  absence of seams are visible in it, but "3.18 Hz is not frantic" is a
  judgement from a still.
* **Unverified:** the wolf has not been seen in the actual game — no server or
  client was started (per the brief). Spawning, idling and the ground probe are
  exercised only by the plugin's own test suite.
