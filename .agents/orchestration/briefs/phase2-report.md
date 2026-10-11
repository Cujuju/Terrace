# Phase 2 report — `storms` → `tornado` + `cyclone` over a kit `rotatingStorms` engine (#283, #291)

Branch `worktree-agent-a63416ea19b8c4c12`, base **`379863d`** (phases 0+1 merged).
Not merged to main. Working tree clean apart from the untracked `.phase2-stack/`
verification rig and `.verify-shots/`.

---

## 1. Commits

| hash | subject |
|---|---|
| `d2fdd67` | test(kit): pin the rotating-storm engine's contract, before the module |
| `e53dd97` | feat(kit): the rotating-storm sim engine, and one outward site search |
| `da5785c` | fix(core): off the map is visible to nobody (#291) |
| `9dfa408` | feat(plugins): tornado and cyclone, two plugins over one kit engine (#283) |
| `2598405` | fix(cyclone): a surge that has never moved a grain of sand |

`git diff --stat 379863d` — 45 files changed, +3 847 / −2 837. `plugins/storms/`
(4 284 lines) is gone; the two plugins are 4 139 lines and the new kit/shared modules 991.

**Read §6.10 first.** One commit fixes a pre-existing bug that makes a *permanent
terrain* mechanic start working for the first time. It is the one change in this
phase an owner might want to hold.

---

## 2. Kit `rotatingStorms` API

`server/src/plugins/kit/rotatingStorms.ts` (803 lines). One engine, one instance per
plugin, no kind anywhere in it.

```ts
export interface RotatingStormWorld { readonly worldSize: number; heightAt(x, y): number }
export type HostileTerrain = 'land' | 'water';

export interface RotatingStormProfile {                       // :81
  speedCellsPerSecond; veerRadiansPerSecond; meanLifetimeSeconds;
  spinUpSeconds; fadeSeconds; hostileTerrainDecayPerSecond;
  minPeakIntensity; maxPeakIntensity; maxActive;
  hostileTerrain: HostileTerrain;      // which ground decays it
  eyeRadiusFraction: number;           // 0 for a storm with no eye
  windFalloff(r: number): number;      // r = distance/radius, in [0, 1)
}

export interface RotatingStormsSpec {                          // :127
  profile; seed;
  radiusFor(worldSize): number;
  nameFor?(index, x, y, worldSize): string;   // absent ⇒ anonymous storms
  reportsLandfall?: boolean;                  // absent ⇒ landfalls always empty
}

export function createRotatingStorms(spec): RotatingStorms;    // :511
export function parseRotatingStormsSnapshot(data): RotatingStormsSnapshot | null;  // :493
export function waterFractionUnder(world, x, y, radius): number;                   // :414

// RotatingStorms                                              // :322
sitingAttempts; maxActive;
random(); rollSpawn(ratePerSecond, dt);
storms(); count();
trySpawn(world, drawSite);   // drawSite(random) → {x,y} | null, tried sitingAttempts times
spawnAt(world, x, y);        // dev/admin seam: no siting
advance(world, dt) → { changed, damage[], landfalls[] };
states(); snapshot(); restore(s); reset(); clear(); freeze(b); isFrozen();

// constants: ROTATING_STORM_SITING_ATTEMPTS 6 (:166),
// _DISC_SAMPLE_OFFSETS 13 samples (:182), _DESPAWN_MARGIN_RADII 1.5 (:208),
// _DAMAGE_INTERVAL_SECONDS 1 (:220), _DAMAGE_SAMPLE_CELLS 12 (:232)
```

**Siting is the caller's.** `trySpawn` takes the *draw* as an argument and the engine
only counts attempts — which is what keeps "inside a thunderstorm cell" and "over open
water" out of core. The tornado's parent-cell choice therefore still happens **once**,
outside the attempt loop, exactly as before (`plugins/tornado/server/sim.ts:143`).

**Decisions inside the engine, and why:**

* **The snapshot parse lives in the engine, not in a kit `slice.ts`.** The brief allowed
  a `slice.ts` "only if BOTH plugins would otherwise repeat the versioned record-array
  boilerplate". They would have — but the engine already owns the record shape, so it
  owns what a valid one looks like (`parseRotatingStormsSnapshot`, :493). Each plugin's
  `persistence.ts` is now 20 lines of version + delegate. No `slice.ts` was added.
* **`RotatingStorm.ownerDebtSeconds`** (`:277`) replaces `surgeDebtSeconds`. The engine
  never reads it: it is a per-storm seconds ledger the OWNER accumulates and clears (the
  surge, in the one caller that has periodic work). It is here because it is state *of a
  storm* that must persist with it — a side table beside the roster needed its own reset
  and prune to stay in step (the 2026-08-28 review that put it on the record).
* **`windFalloff` is supplied by the plugin**, not chosen by a `kind` branch: the shape of
  a storm's wind field is the one piece of physics that genuinely is about what kind of
  storm it is. The engine keeps only the two guards that are not the profile's business
  (zero radius, and nothing outside the disc) — `windFalloffAt`, :601.
* **The generator is the engine's** (seeded, `state()` in the snapshot). `random()` and
  `rollSpawn()` are exposed so a plugin's own draws come off the one sequence that
  explains a world; the surge draws through `cyclones.random`.

Also new:

* `server/src/plugins/kit/devSite.ts` gains **`searchOutwardFromCentre(worldSize, accepts,
  centre?)`** — the ring search itself, now that two plugins want the nearest ground of
  their own kind. `accepts` is a predicate; the 16 spokes and the 32-cell clearance rule
  moved with it. Phase 0 left the search in `storms` because it had one caller.
* `server/src/plugins/kit/difficultyCurve.ts` (37 lines) — `interpolateByDifficulty` and
  the two difficulty bounds, so the two-anchor lerp is not copied into both plugins.
  **Named punt:** `mudslides/server/slides.ts:652` and `volcanoes/server/vents.ts:238`
  still carry their own copies; rewiring them is not this phase's scope and was left.
* `client/src/plugins/kit/extrapolation.ts` (43 lines) — `MAX_EXTRAPOLATION_SECONDS` and
  `extrapolate(pose, age)`, shared by the two client halves.
* `shared/src/rotatingStormWire.ts` (108 lines) — `RotatingStormState`,
  `RotatingStormsPayload`, `parseRotatingStormsPayload`. Two plugins broadcast the
  identical payload and a plugin may not import a neighbour's protocol, so the wire form
  went where the disc form went in phase 1 (#180's argument). `shared/src/index.ts` gains
  one export line; nothing else in `shared/` was touched.

---

## 3. #291 — the `broadcastVisible` off-map contract

`server/src/plugins/world-api.ts:243-283`. A position outside the world is **visible to
nobody**: filtered out of every recipient's subset, never thrown, never clamped. Stated
once, at the callsite, with the helper `isInsideWorld` (`world-api.ts:117-129`) and one
paragraph added to the contract in `server/src/plugins/types.ts:230`.

The bug it closes, from primary source: `isCellVisibleTo` → `isChunkVisibleTo` →
`isChunkUnlockedForToken` → `chunkIndex` (`shared/src/chunks.ts:46-48`) throws a
`RangeError` for a cell that has no chunk. A cyclone is born over the sea beyond the coast,
so it hands exactly such a cell to `positionOf`.

Contract test first: `server/test/world-api-broadcast-visible.test.ts` (2 cases) — it
reproduced `RangeError: chunk (-4,-4) out of bounds for 4×4 chunks` before the fix, and
asserts the empty payload is still SENT after it (`skipEmpty` is false for a full-state
replace, so silence would be its own bug).

---

## 4. The two plugins, by name

| | `tornado` | `cyclone` |
|---|---|---|
| setting(s) | `tornado-frequency` (`off\|rare\|common`, default `rare`) | `cyclone-frequency` (same, default `rare`), `cyclone-surge` (`off\|on`, default `on`) |
| wire | `tornado:all`, eye-filtered, `skipEmpty: false`, 5 Hz | `cyclone:all`, same |
| events | `tornado:damage` | `cyclone:damage`, `cyclone:landfall` |
| slice | `tornado` v1 | `cyclone` v1 |
| dev switch | `TORNADO_DEV_FORCE=1` → nearest land to the centre | `CYCLONE_DEV_FORCE=1` → nearest open water |
| admin action | `tornado` — "Spawn a tornado" | `cyclone` — "Spawn a cyclone" |
| bridge | → `weather` hub, `livingSystems()` filtered to kind `'thunderstorm'` | none — a cyclone rides its own track |
| cap | 2 (`sim.ts:78`) | 1 (`sim.ts:85`) |
| client | `funnel.ts`, `drawBudget = 2` | `spiral.ts` + `gloom.ts`, `drawBudget = 1` |

Profiles carried over **byte-for-byte** from `379863d`'s `KindProfile` tables
(`plugins/storms/server/storms.ts:195-236`): tornado 2.5 u/s, 0.05 rad/s, 60 s, 4 s, 6 s,
0.25/s, 0.5–1, cap 2 (`plugins/tornado/server/sim.ts:70-79`); cyclone 0.25 u/s,
0.008 rad/s, 480 s, 45 s, 60 s, 0.018/s, 0.6–1, cap 1
(`plugins/cyclone/server/sim.ts:77-86`). Difficulty anchors 600/90 and 2400/360, the
`rare`×2 / `common`×0.5 multipliers, `SITING_ATTEMPTS` 6,
`CYCLONE_MIN_OPEN_WATER_FRACTION` 0.85, `DESPAWN_MARGIN_RADII` 1.5,
`DAMAGE_INTERVAL_SECONDS` 1, `DAMAGE_SAMPLE_CELLS` 12, the 13-sample disc pattern,
`BROADCAST_TICK_INTERVAL` 2, every surge constant, the basin/roster naming and
`cycloneRadiusFor`'s 30-unit / 0.3-of-world clamp: all unchanged, verified line by line
against `git show 379863d:plugins/storms/...`.

`plugins/storms/` is deleted, along with `client/src/previewStorm.ts` and
`client/preview-storm.html` (dead since the 2026-08-28 review; nothing referenced them —
`client/vite.config.ts` has no preview entries at all, the HTML files are picked up
implicitly). `client/src/plugins/registry.ts` lists `tornado, cyclone` where `storms` sat.

---

## 5. Tests

Only the three the brief allows, each written BEFORE the code it covers:

* `server/test/plugin-kit-rotating-storms.test.ts` — 12 cases: track (displacement =
  speed × dt, zero veer leaves the heading alone, seeded replay, off-map despawn), hostile
  terrain (decays on its own ground, not on the other), landfall (once, and only when
  asked), damage (cadence, eye spared and its radius reported), the freeze (movement,
  ageing and weakening stop; damage does not), snapshot (storms + generator + name counter
  through JSON; a non-snapshot rejected whole).
* `server/test/world-api-broadcast-visible.test.ts` — the #291 contract, 2 cases.
* `plugins/tornado/test/tornado.test.ts` and `plugins/cyclone/test/cyclone.test.ts` — one
  persistence round trip each (3 cases apiece: the JSON round trip including the name
  roster, an unreadable slice leaving an EMPTY sky rather than the old one, and the
  version).

Nothing else was added, and no existing assertion was weakened.

---

## 6. Behaviour deviations, with `file:line` old → new

Old paths are at `379863d`.

### 6.1 The wire loses its `kind` field
* Old: `plugins/storms/protocol.ts:352` — `StormState.kind`, on a message that carried
  both kinds.
* New: `shared/src/rotatingStormWire.ts:31-63` — no `kind`; the message is namespaced by
  the plugin that sends it (`tornado:all` / `cyclone:all`). Phase 1 made the same call for
  the disc payload, for the same reason. ~11 B/storm cheaper.
* Same for the two event payloads: `protocol.ts:412` and `:435` carried `kind`;
  `RotatingStormDamage` (`kit/rotatingStorms.ts:262`) and `RotatingStormLandfall` (`:293`)
  do not. **No consumer exists** — a fresh grep over `plugins/`, `server/src`, `client/src`
  finds zero subscribers to either event, then or now.

### 6.2 Two generators where there was one
* Old: one seeded stream for both kinds — `plugins/storms/server/storms.ts:390`, seed
  `0x57073d51`.
* New: `plugins/tornado/server/sim.ts:99` keeps that seed; `plugins/cyclone/server/sim.ts:120`
  gets `0x3d515707`. Two independent streams, so a seeded run **does not replay
  pre-split**: the arrival rolls no longer interleave. Deliberate — a shared stream would
  have coupled two independently-deletable plugins through their randomness.

### 6.3 One frequency setting becomes two
* Old: `storm-frequency` governed both kinds, and `off` stopped the whole sim
  (`plugins/storms/server/index.ts:353`).
* New: `tornado-frequency` and `cyclone-frequency`, each stopping only its own plugin.
  Turning tornadoes off no longer turns hurricanes off.
* Old rows are keyed by plugin name and only looked up for RUNNING plugins
  (`server/src/plugins/host.ts:188`), so the `storms` rows are orphaned and harmless and
  the new defaults (`rare`, `rare`, `on`) apply.

### 6.4 The snapshot slice
* Old: one `storms` slice v1 with `surgeDebtSeconds` per storm.
* New: `tornado` v1 and `cyclone` v1, with `ownerDebtSeconds`. A slice for a plugin the
  build no longer has is logged and dropped (`host.ts:107-110`), so **a storm in the air at
  upgrade time is lost**. Transient; nothing permanent goes with it (a surge is already in
  the heightmap, which core saves).

### 6.5 `MAX_ACTIVE_STORMS` is gone
* Old: `plugins/storms/server/storms.ts:261` — one ceiling of 3 = 2 + 1.
* New: `MAX_ACTIVE_TORNADOES` (2) and `MAX_ACTIVE_CYCLONES` (1), each its own plugin's.
  Nothing in the repo read the sum.

### 6.6 A funnel is no longer dimmed by a hurricane
* Old: one client half computed `daylight` from the gloom depth and handed it to BOTH rigs
  — `plugins/storms/client/index.ts:250,253`.
* New: the funnel is drawn at `FULL_DAYLIGHT = 1`
  (`plugins/tornado/client/index.ts:75,119`); the gloom belongs to the cyclone plugin. A
  tornado standing inside a cyclone's shadow is now lit as if it were not. Visible only in
  the (rare) case of both storms overlapping; closing it would mean a client-side bridge
  between two plugins, which the isolation rule refuses.

### 6.7 The dev force-spawn is per plugin
* Old: `STORMS_DEV_FORCE=tornado|cyclone|both` — `plugins/storms/server/dev.ts:46`; one
  `clearStorms()` and one `setDevFrozen(true)` (`:175`, `:180`) cleared and froze BOTH
  kinds.
* New: `TORNADO_DEV_FORCE=1` / `CYCLONE_DEV_FORCE=1` through the kit reader
  (`kit/devForce.ts:50`); each clears and freezes only its own population
  (`plugins/tornado/server/dev.ts:80,85`, `plugins/cyclone/server/dev.ts:89,94`). Forcing
  one no longer sweeps the other out of the sky. Accepted values are `1|true|yes|on`.

### 6.8 Two messages where there was one
Both plugins broadcast at 5 Hz on their own cadence, so a world with a tornado AND a
cyclone sends two messages per interval instead of one. Each is smaller (no `kind`, one
list); the total is within a byte or two of before.

### 6.9 The forced cyclone's site test
* Old: the dev search asked `heightAt <= SEA_LEVEL` cell by cell
  (`plugins/storms/server/dev.ts:89`), with the 32-cell clearance rule doing the work of an
  area test. New: identical (`plugins/cyclone/server/dev.ts:60`). The natural birth's
  0.85 open-water disc test is unchanged and still only on the natural path. Stated
  because the two tests look interchangeable and are not.

### 6.10 **The surge has never worked, and now does** — `2598405`

Found in-world, not by reading. A brush amount is an integer by contract
(`shared/src/heightmap.ts:722-724`, `assertBrushArgs`: *"brush amount must be an
integer"*), and the surge asked for `SURGE_SCOUR_HEIGHT_UNITS * intensity`, which is
continuous:

* Old: `plugins/storms/server/surge.ts:183` @ `379863d` — `world.sculpt(x, y, r,
  -SURGE_SCOUR_HEIGHT_UNITS * intensity)`.
* Every call threw `RangeError: brush amount must be an integer, got -5.963…`, was caught
  by the host's per-plugin guard (`server/src/plugins/host.ts:310`), logged as
  `ERROR plugin "storms" threw in onTick`, and **moved no ground at all**. The mechanic has
  been dead for as long as it has shipped — including through the owner's #230 decision to
  default it ON.
* New: `plugins/cyclone/server/surge.ts:180-193` rounds to a whole height unit. The
  magnitude cannot round to zero: the weakest storm allowed to surge is
  `SURGE_MIN_INTENSITY` 0.5 of half a band = 4 units.
* **Consequence the owner should see:** with this fix, `cyclone-surge: on` (the default)
  starts permanently changing revealed shorelines for the first time. Measured on a real
  world through the real host: one landfall lowered **14 shoreline cells, deepest cut 29
  height units** (1.8 bands) — in the range `surge.ts`'s own header predicts ("a band or
  two"), and the `footprintUnlocked` guard still keeps it off unrevealed coast. If that is
  not wanted yet, revert `2598405` alone; nothing else depends on it.

### 6.11 Verified UNCHANGED, from source lines
* The eye, not the disc, gates visibility — old `plugins/storms/server/index.ts:208` → new
  `plugins/tornado/server/index.ts:183`, `plugins/cyclone/server/index.ts:190`.
* `skipEmpty: false` on both, and the `broadcastPending` carry across a non-broadcast tick
  (the 2026-08-28 "spent cyclone spun forever" fix) — old `index.ts:131,236` → new
  `tornado/server/index.ts:109,190`, `cyclone/server/index.ts:113,218`.
* The tornado's coupling string `'thunderstorm'` and the whole bridge shape —
  old `plugins/storms/server/weather-bridge.ts:50` → new
  `plugins/tornado/server/weather-bridge.ts:50`, still a duck-typed `livingSystems()` with
  a warn-once and a per-system NaN skip.
* Spawn-draw ORDER inside a birth (heading → peak intensity → lifetime) — old
  `storms.ts:460-470` → new `kit/rotatingStorms.ts:531-543`.
* The surge's `footprintUnlocked` guard, 10 s cadence, 0.5 minimum intensity, 12 attempts,
  radius-4 brush, half-band depth — `plugins/cyclone/server/surge.ts:47-110`, all carried
  over unchanged from `379863d`.
* `off` still stops the SIM as well as the spawner, and the admin action still refuses when
  the plugin is off or at cap.

---

## 7. Gate outputs

**1. `pnpm typecheck` — 0 errors**, 27 workspace packages (25 before; `storms` out,
`tornado` and `cyclone` in).

**2. `pnpm -r --if-present --no-bail run test` — 23 packages pass, 4 fail, and the 4 are
exactly the known pre-existing set:**

| package | result |
|---|---|
| `plugins/mana` | 1 failed / 72 passed — the float-leak test |
| `client` | 1 failed / 503 passed — `vertexGrid` picking |
| `plugins/fire`, `plugins/temples` | exit 1, "No test files found" — their `test/` dirs are untracked in the main checkout, so no worktree has them |

New/changed suites green: `server` 359/359 (29 files, up from 345 — the two new contract
suites), `shared` unchanged, `tornado` 3/3, `cyclone` 3/3, `weather` 12/12, rain /
thunderstorm / snow / fog untouched and green. The brief's "mudslides / storms-dir: No test
files" no longer applies: mudslides has tests and passes, and the `storms` directory is
gone (its leftover empty `node_modules` shell was removed too — the server logged
`plugin "storms" has no server entry — skipped` until it was).

**3. Greps**
* `grep -rnE "from '\.\./\.\./(rain|thunderstorm|snow|fog|weather|tornado|cyclone|storms)/" plugins/` → **0 hits**. No plugin imports another.
* Plugin names in kit code → **0 identifiers**. `server/src/plugins/kit/devSite.ts`,
  `difficultyCurve.ts` and `client/src/plugins/kit/extrapolation.ts` have no plugin name at
  all (the two remaining matches are the English words "one way or another" and "into
  fog"); `rotatingStorms.ts` uses *storm* only as a common noun in its own vocabulary
  (`RotatingStorm`, `storms()`), never a plugin name. devSite's and mudslides' headers were
  rewritten to stop naming the retired `storms` folder.
* `grep -rn "storms" plugins server/src client/src` → the only hits are the common noun,
  the wire field name `storms` (which is the payload key, from `@terrace/shared`), and
  history-recording comments in `fire`, `mudslides` and the two new protocols that say what
  the split replaced.

**4. Draw budget — 3 → 3, no growth.**
Old: `FUNNEL_DRAW_OBJECTS 2 + SPIRAL_DRAW_OBJECTS 1 = 3`
(`plugins/storms/client/index.ts:189-199` @ `379863d`).
New: tornado 2 (`plugins/tornado/client/index.ts:72,84`) + cyclone 1
(`plugins/cyclone/client/index.ts:141,150`) = **3**. The gloom draws nothing — it modulates
the sky rig core already draws. Counts are from the mesh constructors, as before;
`client/test/drawBudget.test.ts` passes.

**5–7. In-world.** See §8.

---

## 8. In-world verification

### 8.1 The stack
`.phase2-stack/launch.sh` in the worktree, copied from phase 1's: port **2617** (`ss -ltn`
showed 2599 held by another stack, and 2611 was phase 1's), `WORLDS_DIR` and a
**nonexistent** `DB_PATH` under `<worktree>/.phase2-stack/`, `WORLD_SIZE=512`,
`CLIENT_DIST_PATH` at this worktree's own rebuilt `client/dist`. A fresh worlds dir per
run unless `KEEP_WORLDS=1` (added for the persistence round trip). `stop.sh` kills by pid
file, falling back to the port owner's pid from `ss -ltnp` — both from a script FILE, never
an inline `pkill -f`/`pgrep -f`.

**Torn down. `ss -ltn | grep 2617` returns nothing.** The owner's stack and port 2599 were
never touched.

### 8.2 Server log — gate 7
```
[terrace] loaded 24 plugin(s): boats, chronicle, cyclone, daynight, fire, flora, fog,
  invite, mana, monsters, mudslides, pilgrims, populous, rain, relics, reveal, snow,
  structures, temples, thunderstorm, tornado, volcanoes, weather, wildlife
[terrace] plugin "cyclone" v0.1.0+57d1b24
[terrace] plugin "tornado" v0.1.0+45a8c6b
[cyclone] frequency: rare, surge: on, difficulty 50 → one every ~2781s
[tornado] frequency: rare, difficulty 50 → one every ~695s
[cyclone] CYCLONE_DEV_FORCE: forced Cyclone Ada at (256, 256)
[tornado] TORNADO_DEV_FORCE: forced a tornado at (251, 267)
```
`tornado` and `cyclone` load, no `storms`, and **zero** bridge-unavailable warnings
(`grep -c "not available"` → 0), i.e. the tornado resolved the hub through
`WorldApi.sibling('weather')`.

### 8.3 The probe — what a screenshot cannot show
`.phase2-stack/probe-storms.mjs` drives the **real discovered plugins on a real world
through the real `PluginHost`** (phase 1's `probe-couplings.mjs` shape), with a recorder
plugin in the list to catch the world-event fan-out. Output:

```
1) cyclone:landfall events: 1
   first: {"stormId":1,"x":255.6,"y":256,"intensity":0.745,"name":"Cyclone Ada"}
   cyclone:damage events: 54
   a damage payload: {"stormId":1,"x":197.1,"y":256,"radius":120,"eyeRadius":15,
     "intensity":0.745,"durationSeconds":1.1,"cells":[…10 cells, each severity>0…]}
   landfall events after the whole run: 1
   shoreline cells lowered: 14, deepest cut: 29 height units (BAND_HEIGHT 16)
2) thunderstorm cells the tornado bridge sees: 1
   first: {"kind":"thunderstorm","x":256,"y":256,"radius":137.6,"intensity":1}
   born: (245.3, 387.4)
   distance from the cell centre: 131.8 of radius 137.6 → inside: true
   on land: true
3) ticks with the eye at (-40, -40) threw: nothing
   cyclone:all messages sent to the player: 10
```

* **Landfall fires once** and carries the storm's name; damage arrives on its 1 Hz cadence
  with every sampled cell outside the eye.
* **Surge**: 14 shoreline cells lowered, deepest 29 height units — this is what §6.10 fixed;
  before the fix the same run logged a `RangeError` per attempt and changed nothing.
* **The tornado's coupling is live**: born inside the thunderstorm cell (131.8 < 137.6) and
  on land.
* **#291 closed in-world (gate 6)**: twenty ticks with the eye at (-40, -40), a connected
  player with every chunk unlocked — **no throw**, and ten `cyclone:all` messages still
  sent (the empty list, which is the correct answer for a full-state replace).

### 8.4 Persistence round trip (gate 5c)
Forced `Cyclone Ada` on world *Ashthorn*, `SNAPSHOT_INTERVAL_S=5`, killed the server,
relaunched with `KEEP_WORLDS=1` and **no dev force**:

```
[terrace] loading world "ashthorn": snapshot #2 (512², 187s old)
```
and the slice on disk, read straight out of the SQLite WAL after the second process had
been running:
```json
{"nextStormId":2,"namedCount":1,"rngState":4022155327,"storms":[{"id":1,
 "x":249.72,"y":248.09,"radius":120,"heading":4.037,"peakIntensity":0.745,
 "envelope":1,"retiring":false,"lifeSeconds":129.2,"name":"Cyclone Ada",
 "landfallReported":false,"damageDebtSeconds":0.2,"ownerDebtSeconds":0}]}
```
Same storm, same name, same id — and it had MOVED from (256, 256) and aged from 480 s to
129 s, so the second process restored it and went on simulating it. The screenshot below
shows it drawn in the fresh process.

### 8.5 Screenshots
Primary copies in the worktree's `.verify-shots/phase2/`; **every file is also copied to
`/mnt/e/Development/Projects/Terrace/.verify-shots/phase2/`** under the same name.

| absolute path | what it shows |
|---|---|
| `/mnt/e/Development/Projects/Terrace/.verify-shots/phase2/tornado-in-thunderstorm.png` | **Gate 5a.** `TORNADO_DEV_FORCE=1 THUNDERSTORM_DEV_FORCE=1` on *Mirecrag*: the funnel standing on the shore at the world centre, debris at its foot, inside the forced thunderstorm's rain. Scene report `rigs:{funnel:true, vortexInstances:1}`; client and server build hashes match (no version skew). |
| `/mnt/e/Development/Projects/Terrace/.verify-shots/phase2/cyclone-deck.png` | **Gate 5b (first half).** `CYCLONE_DEV_FORCE=1`: the spiral deck — 810 puff instances in one draw call — lying over open water with its arms and centre visible, rain falling through it. |
| `/mnt/e/Development/Projects/Terrace/.verify-shots/phase2/cyclone-restored.png` | **Gate 5c.** The RESTARTED process on the same `WORLDS_DIR`, no dev force: `Cyclone Ada` drawn again over the sea where the slice above says she is. A natural arrival is impossible here — mean interval 2 781 s against a 25-second-old process. |
| `/mnt/e/Development/Projects/Terrace/.verify-shots/phase2/both-forced.png` | All three switches at once — funnel, cyclone deck and thunderstorm rain in one frame, four sky plugins and two storm plugins drawing together. |
| `/mnt/e/Development/Projects/Terrace/.verify-shots/phase2/inside-the-deck.png` | The camera under a cyclone's cloud deck at night: what the gloom + deck look like from inside, one draw call of puffs. |

---

## 9. What I could not verify

* **A cyclone photographed AT LANDFALL, and the before/after of a scoured shoreline
  (the rest of gate 5b).** The dev force freezes a storm so it can be photographed at all
  (a headless SwiftShader frame takes ~0.5–1 s), and a frozen storm never crosses a coast;
  an unfrozen one takes eight minutes to walk one, on a world whose coast has to land under
  it. I took the landfall and the surge NUMERICALLY instead, through the real host (§8.3) —
  1 landfall event, 14 cells scoured, 29 units deep. My one attempt at an in-world
  before/after pair produced a blank first frame and a storm parked over open ocean with no
  shoreline under it; both files were deleted rather than reported as evidence.
* **The admin actions** ("Spawn a tornado" / "Spawn a cyclone") were never clicked through
  the panel. Their code path (`forceTornadoNear` / `forceCycloneNear`) is the same
  `searchOutwardFromCentre` + `spawnAt` the dev force uses, which is exercised.
* **Frame cost.** The headless stack runs SwiftShader at 1–3 fps, so nothing here says
  anything about the 140 fps benchmark.
* **Seeded equivalence with the pre-split sim** — not claimed; §6.2 splits the stream in
  two.
* **Long-run natural arrival rates.** Every constant is arithmetically identical to the
  pre-split one and the log prints the derived interval, but I did not sit out a
  695-second tornado wait.
* Assumption, unverified: the two new plugin `package.json` / `tsconfig.json` files were
  copied from `rain`'s (name changed), so they carry `three`, `solid-js` and the DOM lib
  that both client halves need. `pnpm typecheck` passing for both is the check that would
  have caught a wrong one.
