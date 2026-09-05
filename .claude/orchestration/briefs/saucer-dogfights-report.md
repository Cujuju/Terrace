# Report — flying-saucer dogfights (arc `saucers`)

Branch `saucers`, worktree `.claude/worktrees/saucers`, forked from `4ad45f5`.

| commit | what |
|---|---|
| `54eacb1` | `feat(saucers): flying-saucer dogfights that leave a burning crater` — the whole plugin |
| `412220c` | `chore(client): register the saucers plugin` — `client/src/plugins/registry.ts` + lockfile |
| `089aea3` | `fix(saucers): keep the authored emissive strengths, tolerate extra meshes` |
| *(this file)* | `docs(orchestration): report for the saucer-dogfights arc` |

`pnpm --filter @terrace/plugin-saucers typecheck` and `pnpm typecheck` at the
root are both green (28 packages, exit 0). No tests were added — owner rule.
Nothing was started, restarted or stopped.

**THE ASSETS ARE NOT IN THESE COMMITS.** I committed them before you said not to
(`cd23cb1`, `083fefa`); those two commits have been **removed from the branch**
by a soft reset to `412220c` and the work rebuilt without them, so the three GLBs
and `tools/blender/build_saucers.py` are yours to commit. Nothing else was lost —
your `40f15ae` (the build script) landed after that reset and is untouched, and
the assets sit untracked in `plugins/saucers/client/assets/`. Also untracked and
deliberately unstaged: `plugins/saucers/.verify-assets.mts`, the headless asset
check, alongside `plugins/wildlife/.verify-closed.mts`.

---

## What was built, with file:line

### Server

| mechanism | where |
|---|---|
| Plugin entry, tick order, broadcast, admin action, world-create/close | `plugins/saucers/server/index.ts` |
| Arrival roll against the difficulty curve | `server/index.ts:264-282` (`rollArrival`), anchors at `:104-114` |
| The encounter state machine (phases, poses, fight, crash) | `server/encounter.ts` |
| Arena centre, cruise altitude, crash cell | `server/site.ts` |
| Two RNG streams (arrival vs. per-encounter seeded) | `server/rng.ts` |
| `igniteAt` through the host's sibling lookup | `server/fire-bridge.ts` |
| Settlement stand-off through the host's sibling lookup | `server/structures-bridge.ts` |
| Wire contract, every shared constant | `plugins/saucers/protocol.ts` |

**Registration.** The server half needs none: `discoverPlugins` scans the
`plugins/` directory and imports each directory's server entry
(`server/src/plugins/discovery.ts:178-216`), picking the `plugin` export
(`:114-136`). `pnpm-workspace.yaml` already globs `plugins/*`. Per-world
enablement is opt-*out* (a disabled list, `world-manager.ts:404-420`), so the
plugin is live on existing worlds with no migration. Only the client registry is
hand-written.

**Sim step** (`server/index.ts:284-311`), fixed order per tick: roll an arrival
if nothing is flying → advance the encounter → emit `saucers:crashed` on the
tick of impact → broadcast on the cadence, if anything changed.

**Broadcast.** `broadcastVisible` with `skipEmpty: false`, at 10 Hz (every tick),
**but only while an encounter is alive** — `broadcastPending` (tornado's pattern)
means an idle world sends nothing at all, and the last message of an encounter is
the empty payload. Three item categories travel in one flat tagged list and are
re-partitioned inside `buildPayload` — the documented multi-category pattern in
`server/src/plugins/types.ts` (`broadcastVisible`'s doc comment).

**Determinism.** Every choice inside an encounter — run-in bearing, hulls, arena,
crash cell, every hit roll, the tie-break — comes from one `createSeededRng`
stream seeded per encounter (`server/rng.ts:78-96`), and the fight loop iterates
saucers by index in a fixed order (`encounter.ts:advanceFight`). Positions are
**parametric in the phase clock**, not integrated (`encounter.ts:placeSaucers`),
so the wreck lands exactly on the cell the sculpt is aimed at and a retuned
`TICK_HZ` changes nothing. `Math.random` is used in exactly two places, both
outside the reproducibility claim: the Poisson arrival roll (through the swappable
source, as monsters does) and the *site* draw for a not-yet-existing encounter.

**Persistence.** None, deliberately — an encounter lives ~23 s. The crater
persists because terrain does; the fire because fire does.

### Client

| mechanism | where |
|---|---|
| Plugin entry, per-frame placement, bank, ring spin, light flash | `plugins/saucers/client/index.ts` |
| GLB load + procedural fallback behind one interface | `client/models.ts` |
| Pooled laser bolts and the crash fireball | `client/effects.ts` |
| Kit interpolator instance | `client/interpolation.ts` |
| `import.meta.glob` typing for this package | `client/vite-glob.d.ts` |

Cosmetic only: it never spawns, moves or decides anything. Reduced motion freezes
this plugin's own animation clock (`client/index.ts` `renderFrame`), which stops
the ring and the lights; the saucers keep flying, because their positions are the
server's. No HUD. No per-frame allocation: bolt meshes are pooled and hidden
rather than added/removed, the shard cloud's positions are rewritten in place, and
the scratch vectors are module-scope.

---

## Constants

### Pacing and geometry (`protocol.ts`)

| name | value | why |
|---|---|---|
| `MAX_LIVING_ENCOUNTERS` | 1 | Structural (one nullable slot in `encounter.ts`), not counted. Two dogfights at once is ambient traffic, not an event. |
| `SAUCERS_PER_ENCOUNTER` | 2 | The resolution is written against exactly one winner and one loser. |
| `SAUCER_VARIANT_COUNT` | 3 | Three authored GLBs. Index 0 is the version-skew fallback. |
| `APPROACH_SECONDS` | 2.5 | 85 world units of run-in at approach speed — the pair cross the horizon rather than blinking in. |
| `DOGFIGHT_SECONDS` | 18 | ~22 bursts each: the outcome is earned, and the whole encounter stays under half a minute. |
| `RESOLVE_SECONDS` | 3 | Shorter than the approach on purpose — a slow fall reads as a landing. |
| `AFTERMATH_SECONDS` | 1.5 | Longer than the client's 1 s burst, so the fireball ends by finishing, not by the payload stopping. |
| `APPROACH_SPEED` | `cellsAcross(34)` | A tornado, the previous fastest thing here, walks at 2.5 world units/s. This crosses a default world in under four seconds. |
| `DOGFIGHT_SPEED` | `cellsAcross(20)` | Laps the arena every ~2.5 s — a fight, not two dots leaving. |
| `DIVE_SPEED` / `EXIT_SPEED` | `cellsAcross(26)` / `cellsAcross(40)` | The wreck accelerates in; the winner outruns everything else. |
| `ENTRY_DISTANCE_CELLS` | derived | `APPROACH_SPEED × APPROACH_SECONDS` — retuning either moves the run-in. |
| `ARENA_RADIUS_CELLS` | `cellsAcross(8)` | 16 world units across: half a chunk, which one orbit-camera shot holds. |
| `CRUISE_ALTITUDE_BANDS` | 24 | = 6 world units, the same clearance `TORNADO_HEIGHT_WORLD_UNITS` uses. **This was 6 in the first draft and was wrong** — see "unit bug" below. |
| `SAUCER_MAX_HP` | 8 | The loser is shot down eight times over ~22 bursts, so the result is a sum of many rolls, not one. |
| `LASER_BURST_INTERVAL_SECONDS` | 0.8 | 22 bursts each per fight. |
| `LASER_HIT_CHANCE` | 0.5 | The honest coin: higher and whoever fires first wins; much lower and the fight times out. Mean damage ≈ 11 vs. 8 hp, so a kill is the common path and the tie-break is the tail. |
| `LASER_BOLT_LIFETIME_SECONDS` | 0.25 | Reads as a streak at 60 fps; keeps at most a couple in flight. |
| `MAX_LASER_BOLTS` | derived (2) | `SAUCERS_PER_ENCOUNTER × ceil(lifetime / interval)` — an honest ceiling, and what the client's pool is sized from. |
| `CRASH_CRATER_RADIUS_CELLS` | `cellsAcross(2.5)` | A hole a player notices from the ground and can walk out of. |
| `CRASH_CRATER_DEPTH_BANDS` | 2 | Written in bands because terrain is quantised in bands; three would punch to the water table on ordinary land. |
| `CRASH_FIRE_RING_RADIUS_CELLS` | 2 | Just outside the crater wall — inside it the flames sit in a hole. |
| `CRASH_FIRE_RING_OFFSETS` | 9 cells | Impact + eight compass points, a **fixed table** so the same crash lights the same cells everywhere. |
| `HEIGHT_WORLD_SCALE` | derived | `MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT`, restated from `client/src/config.ts` because a server half cannot import that file. |

### Sim internals (`server/encounter.ts`, `server/site.ts`, `server/index.ts`)

| name | value | why |
|---|---|---|
| `ENCOUNTER_MEAN_INTERVAL_AT_EASIEST/HARDEST_SECONDS` | 1200 / 240 | Two anchors and a lerp, per `WorldApi.difficulty`. Rarer than the tornado's 600/90 because this leaves a **permanent** crater. |
| `WEAVE_RADIUS_FRACTION` / `WEAVE_RADIANS_PER_SECOND` | 0.25 / 1.7 | Without a weave the pair fly a carousel. The rate is not a whole multiple of the orbit rate, so the pattern does not repeat inside the fight. |
| `WEAVE_ALTITUDE_WORLD_UNITS` / rate | 1.5 / 1.1 | A shallow porpoise; deeper reads as losing control, which is the resolve phase's job. |
| `EXIT_CLIMB_WORLD_UNITS` | 12 | Takes the winner off the top of the frame, so nothing has to chase it to the map edge. |
| `FIRE_STAGGER_FRACTIONS` | 0.25, 0.75 | Half an interval apart, permanently. A simultaneous mutual kill is an outcome `resolve` has no representation for — it names one loser. |
| `ARENA_SITE_ATTEMPTS` / `CRASH_SITE_ATTEMPTS` | 24 / 24 | Not sized to make failure impossible: an all-ocean world genuinely has nowhere for this, and giving up is the honest answer. |
| `ALTITUDE_SAMPLE_SPOKES` / `_RADII` | 16 / {0.5, 1} | 33 height reads per encounter. Widened from the clearance test's 4 probes because a peak between two probes is a peak the pair fly *through*. |
| `CRASH_SETTLEMENT_CLEARANCE_CELLS` | 6 | Outside crater (2.5) + fire ring (2), and deliberately not derived from them: it is how close a player wants a flaming wreck to their town. |
| `SAUCERS_RNG_DEFAULT_SEED` | `0x5a11c304` | Fixed so "the same saucer always wins in my world" is reproducible. Value arbitrary; fixedness is the point. Distinct from every other plugin's. |

### Render (`client/`)

| name | value | why |
|---|---|---|
| `SAUCER_DIAMETER_CELLS` | 4 | From the brief. |
| `AUTHORED_UNIT_SCALE` | `CELL_WORLD_SIZE` | See the unit bug below. |
| `AUTHORED_FIT_TOLERANCE_FRACTION` | 0.05 | A *fraction*, not boats' absolute 0.02: this budget is a proportion, and exporter dust scales with the model. The installed `saucer-a` is 1.75 % over. |
| `SAUCER_MESHES_MAX` / `FALLBACK_SAUCER_MESHES` | 8 / 4 | The per-hull count is **measured** at preload (the installed hulls carry `rivets`, and `saucer-b` a `deck`, for six); the ceiling is what `drawBudget` reads before any file is seen, and it is deliberate headroom — two spare draw objects per saucer is four draw calls out of a 197-call frame, while a ceiling the next re-export exceeds drops the set to grey primitives over a split part. Extra meshes are **tolerated, never rejected**. |
| `SAUCER_LIGHTS_BASE_EMISSIVE` | 1.2 | The **fallback's** rest intensity only. An authored hull's own value is read off the material and never written over. |
| `RING_RADIANS_PER_SECOND` | 6 | A turn every 1.05 s: machinery, not a carousel, and well below the ~30 rad/s where it would alias backwards. |
| `LIGHTS_FLASHES_PER_SECOND` / `_FRACTION` | 2 / 0.4 | A navigation light. A **fraction** of the model's own rest value, not an absolute: an authored hull carries its baked emissive strength (2.0 on `lights`, 1.3 on `ring`) and the fallback supplies its own, so an absolute swing would mean something different on every body and need re-tuning on every re-export. Under 1.0, so the strip *dims* rather than switching off. |
| `MAX_BANK_RADIANS` / `BANK_FULL_TURN_RATE` | 0.6 rad / 2 rad·s⁻¹ | The dogfight circle turns at ~2.5 rad/s, so the pair bank hard in the fight and fly level on the run-in and exit — the owner's "in flat, wheel, out flat". |
| `MAX_INTERPOLATION_SECONDS` | 0.25 | **Eight times tighter than monsters' 2 s.** A monster gliding 2 s past truth moves half a cell; a saucer crosses half the world. |
| `BURST_SECONDS` | 1 | Shorter than `AFTERMATH_SECONDS`, on purpose. |
| `BOLT_RADIUS_CELLS` | 0.12 | 3 % of a one-world-unit hull: a beam, not a pipe, and thick enough to survive being seen end-on. |
| `BURST_MAX_RADIUS_CELLS` / `SHARD_*` | 3 / 5 / 2.5 | A crater and a bit; the shard bearings are a **fixed** twelve, so two players beside each other see the same debris. |
| `drawBudget` | `2 × measured + 2 + 2` | A getter, like boats', so it follows the measurement instead of freezing the pre-load ceiling. |

---

## How to trigger one (smoke test)

**Admin panel action**, exactly as monsters and tornado do it — a
`PluginActionDeclaration`, gated by core behind the world-admin key:

- plugin `saucers`, action key **`dogfight`**, label *"Start a saucer dogfight"*.
- The site is the cell the operator is looking at; the search walks rings out to
  `ADMIN_SEARCH_RADIUS_CELLS` (160) for open, unlocked land with a full arena's
  clearance **and** a legal crash cell inside it.
- The receipt names both: `two saucers are coming in over (256, 256); the wreck
  will land at (272, 232)` — or `a dogfight is already under way`, or `no open,
  unlocked land clear of towns within 160 cells of (x, y) big enough for an
  arena`.
- Clients are told immediately (the action runs between ticks), then every tick
  for ~23 s.

Watch for: two hulls crossing the map edges → converging → banking a circle with
bolts between them → one diving into the ground while the other climbs out → a
crater with fire in it.

There is **no** boot-time `SAUCERS_DEV_FORCE`. Punted, deliberately (see below).

### What I verified headlessly

Not a substitute for eyes-on, but not nothing either. Three throwaway harnesses
under the scratchpad drove the real plugin against a fake `WorldApi`:

- **Full encounter**: `approach` 0.0–2.4 s → `dogfight` 2.4–14.3 s (ended by a
  kill) → `resolve` 14.3–17.3 s → `aftermath` → one empty payload at 18.8 s.
  Exactly **one** `sculpt(277, 234, r=10, amount=-32)` and one `saucers:crashed`
  event. Every payload round-trips through `parseSaucersPayload`.
- **Fight**: bolts on 110 of 180 dogfight frames, max 1 concurrent (ceiling 2);
  hp falls 8→0 progressively; the final `resolve` frame has the loser at
  (246.5, 266.0) alt 1.93 closing on crash cell (248, 268) at ground alt 1.56.
  The winner is correctly filtered off-map by then.
- **Siting**: all-land → a site; all-ocean → `null`; all-locked → `null`; a
  40-cell island (too small for the arena) → `null`. One simulated hour at
  difficulty 100 produced 11 completed encounters against a ~14 nominal — the
  shortfall is the ~23 s each encounter blocks the next, which is expected.
- **Assets** (`plugins/saucers/.verify-assets.mts`), re-run against the latest
  export: all three parse through `parseRigAsset`, carry `hull`/`ring`/`dome`/
  `lights` plus the `muzzle` and `top` Empties, one material per mesh, and `hull`
  carries `uv` so the mapped-material check passes. `saucer-a` 4.07 × 0.92 × 4.07
  / 31.5k tris, `saucer-b` 4.00 × 1.31 × 4.01 / 30.4k tris (plus `deck`),
  `saucer-c` 4.00 × 0.75 × 4.00 / 14.8k tris; all three carry `rivets`, so the
  worst case is **six** meshes. Emissive intensities read back as authored:
  `lights` 2.0, `ring` 1.3 on every file. Worst-case scene cost is two hulls
  ≈ 62k triangles and 12 draw objects, nothing beside the terrain. The Node run
  logs `Couldn't load texture blob:nodedata:…` and reports `map=no` — a Node
  limitation (blob URLs are unresolvable there), not a file fault; the browser
  path is unaffected, and the `uv` attribute the check actually depends on is
  present.

---

## Where the brief was wrong from source

Four places. In each, what I did instead and why.

**1. There is no deny chain for a plugin's own sculpt.** The brief said the crash
cell must clear "any protection another plugin exposes via the deny-chain in
types.ts ~573", and that if the chain rejects the sculpt I should pick another
cell. `onIntent` is a **player-intent** interceptor (`server/src/plugins/types.ts`
`onIntent`), and `WorldApi.sculpt` goes straight to `applyServerSculpt`
(`server/src/plugins/world-api.ts:226` → `server/src/world/sculpt-service.ts:54`),
which applies the brush and notifies listeners — it never consults an
interceptor. A plugin terraform cannot be vetoed by anybody.
*Instead:* the crash cell is vetted **before** the encounter starts — in bounds,
unlocked, above `SEA_LEVEL`, and `CRASH_SETTLEMENT_CLEARANCE_CELLS` from every
standing building, asked of the structures plugin through a duck-typed sibling
bridge (`server/structures-bridge.ts`). An encounter that cannot get all three of
arena, altitude and crash cell simply does not start. The full argument, and the
rejected alternative (site the crash when the loser is decided), is in
`server/site.ts`'s header.

**2. Monsters has no `monsters:summon` client message.** The brief asked for a
client→server `saucers:summon` "gated exactly the way monsters gates its admin
summon". Monsters' debug spawns are `actions` + `onAction`
(`plugins/monsters/server/index.ts`), and `PluginActionDeclaration`'s own doc
comment says why: a plugin message would give the power to **every player**,
whereas a declaration lets core gate it behind the world-admin key. A literal
`saucers:summon` message would have let any connected client crater someone
else's land on demand. *Instead:* the `dogfight` action above. This is the brief's
stated intent ("gated exactly the way monsters gates it"), not a departure from
it.

**3. `t0` on the wire cannot work; it is `age`.** The brief specified
`lasers: {from, to, t0}` and `crash: {x, y, at}`. A timestamp has to be read
against a clock, and the server's `simMillis` and the client's frame clock are not
the same clock. *Instead:* both carry **`age`**, seconds since the event on the
server's own clock — the same number in both frames of reference, so a client that
joins mid-aftermath starts the fireball part-way through instead of replaying it
over a crater that is already cold.

**4. `roundBroadcastCell` would pin the run-in to the map edge.** Monsters bounds
its wire positions with it. A saucer is legitimately off the map for part of its
life (it starts `ENTRY_DISTANCE_CELLS` outside and the winner exits past the far
edge), and clamping would pile both hulls against x = 0 for the whole approach.
*Instead:* `roundBroadcastPosition` (unbounded), which is what
`roundBroadcastCell`'s own doc comment prescribes for that case (wildlife's birds
are the precedent), and core drops an off-map item from every recipient's subset
without throwing — verified at `server/src/plugins/world-api.ts:117-129` and
`:274-283`, not from the comment. That filtering *is* the run-in effect.

---

## A unit bug the brief's convention would have shipped

`docs/model-assets.md` opens with *"Units are cells: 1 unit = 1 cell"*, and the
brief repeats it ("authored outer diameter 4 cells"). **A three.js unit in this
scene is a WORLD unit, which is four cells** since the 2026-08-21 re-sample
(`CELL_WORLD_SIZE = 1/4`). Verified from primary source: boats places its hull at
`boat.x * CELL_WORLD_SIZE` and applies **no scale** to the model root
(`plugins/boats/client/index.ts:131-135`), so one authored unit is one scene unit.

This bit twice and both are fixed:

- The **fallback** was first written with radii in raw "cells", which would have
  built a saucer 16 cells across. It now builds in
  `SAUCER_DIAMETER_WORLD_UNITS`, and `effects.ts` runs every stated cell length
  through a `worldUnitsAcross` helper.
- The **authored hulls** measure ~4.0 in their own units, i.e. the modeller
  correctly followed "1 unit = 1 cell". Drawn unscaled they would each be 16
  cells wide. `buildAuthoredSaucer` therefore scales the cloned root by
  `AUTHORED_UNIT_SCALE = CELL_WORLD_SIZE`, with a fit check that refuses (and
  falls back) anything past 5 % over budget.
- `CRUISE_ALTITUDE_BANDS` was 6 in the first draft — 1.5 world units, a saucer
  skimming the treetops. It is 24 (6 world units, a tornado's height).

**For you to decide, not me:** `docs/model-assets.md`'s first line is stale, and
boats carries the same latent confusion (its "one cell" fit budget actually
admits a four-cell boat). I did not touch `docs/**` or another plugin's files —
the brief forbids both. Flagging it as its own piece of work.

---

## Punted, explicitly

| thing | yes/no | why |
|---|---|---|
| Playing the authored `spin` clip on `ring` | **No** | `RigAsset` exposes a scene, `node()` and `anchor()` — it never surfaces `gltf.animations` (`client/src/render/rigAsset.ts:44-68`). Using the clip means changing core's asset contract and carrying an `AnimationMixer` per saucer, to reproduce one `rotation.y = t × k`. The clip stays in the file as the modeller's statement of intent; `RING_RADIANS_PER_SECOND` is that intent, evaluated for free. |
| Deleting the procedural fallback now the art has landed | **No** | You said I *may*. `preloadSaucerModels` is contractually forbidden to reject — a rejected preload unmounts the plugin for the whole session — so something has to be drawable when a file is missing, truncated, or refused by `rigAsset`'s own validation. It is no longer a stand-in for unfinished art; it is the degraded path, and its header now says exactly that. |
| Tests | **No** | Owner rule: no tests without permission, per session. Nothing was added. The three headless harnesses live in the scratchpad and are not in the repo; `plugins/saucers/.verify-assets.mts` is left uncommitted alongside `plugins/wildlife/.verify-closed.mts`. |
| `SAUCERS_DEV_FORCE` env var | **No** | The admin action already gives a developer an encounter now, here, and again in a minute — which is exactly the argument `PluginActionDeclaration`'s doc comment makes for preferring an action to the older env vars. A boot-time force would only serve a headless screenshot rig, and there isn't one for this. |
| Per-world `frequency` setting (tornado has one) | **No** | Difficulty already spans 20 min → 4 min. A second dial is worth adding when somebody wants a world *with* saucers but *fewer* of them; nobody has said so. The seam is one `settings` entry away. |
| Persistence slice | **No** | An encounter lives 23 s. Resuming an animation across a restart nobody watches is the only thing a slice would buy, and it would then have to survive a rollback correctly. |
| A HUD panel | **No** | Same reasoning as monsters — a counter would be the opposite of the feature. |
| `revealClipUniforms` on the rigs | **No** | Tornado clips its funnel against the fog frontier because a funnel stands *on* contested ground. These fly 6 world units up over ground the arena test already proved is unlocked, and the fog-of-war broadcast filter already hides an encounter a player cannot see. |
| Consumers of `saucers:crashed` | **No** | Nothing subscribes today. It is the seam a chronicle entry attaches to and costs one fan-out per encounter. |

## Residuals you should know about before merging

1. **The bank direction is unverified.** `client/index.ts` rolls about local X
   with Euler order `YXZ` (so the roll composes in the model's frame, before the
   yaw — with the default `XYZ` it would *pitch* instead). The **sign** has not
   been seen in-world, because I may not start the app. If a saucer leans *out*
   of its turn, negate the one expression the comment there points at; nothing
   else depends on it.
2. **Everything visual is unverified.** Hull scale, altitude read, bolt
   thickness, the fireball, the light flash — all reasoned from source and
   arithmetic, none of it seen. That is the eyes-on pass you named.
3. **`arenaAltitude` samples 33 cells, not the whole disc.** A spire narrower
   than 22.5° at the arena radius that stands more than 6 world units above every
   sample would be flown through. Named rather than fixed: the honest fix is a
   real max over the disc, which is ~800 height reads per encounter, and I would
   rather you decided that than have me spend it silently.
4. **The hulls went through five exports during this session**, and after the
   first the client needed no change for any of them: the scale, the fit budget,
   the mesh count and the emissive rest value are all derived or measured from
   the file rather than written down. Export again freely.
