# Phase 1 report — `weather` → hub + rain / thunderstorm / snow / fog (#283, #285)

Branch `worktree-agent-a63416ea19b8c4c12`, base **`d82828a`**. Not merged; working tree
clean apart from the untracked `.phase1-stack/` verification rig.

**`main` has moved on since the worktree was cut** (now `10cbb50` — flora/fire work by
another agent). Every figure below is measured against the base `d82828a`, not against
current `main`. The orchestrator will need to merge, not fast-forward.

---

## 1. Commits

| hash | subject |
|---|---|
| `f5887f2` | feat(shared): one disc-systems wire form, for four senders |
| `b86e151` | test(kit): pin the disc-systems engine's contract, before the module |
| `47ade56` | feat(kit): the drifting-disc sim engine, and one dev-force reader |
| `d6ff416` | feat(kit): the client half of a drifting-disc plugin, five modules |
| `f35a031` | test(weather): pin the sky-kind registry's contract, before the module |
| `6b2da3c` | refactor(weather): the plugin becomes a hub — one wind, one register |
| `556375a` | feat(plugins): rain, thunderstorm, snow and fog as four plugins (#283, #285) |
| `79f84b2` | fix(plugins): point fire and storms at the kind that owns the thing |

---

## 2. Hub API as shipped

`plugins/weather/server/index.ts`, re-exporting `./registry.ts` and `./wind.ts`:

```ts
// registry.ts:32-39, 42-63, 66-68
export interface SkyCell {
  readonly x: number; readonly y: number;
  readonly radius: number; readonly intensity: number;
}
export interface SkyKindEntry {
  readonly name: string;
  cells(): readonly SkyCell[];
  wetnessAt(x: number, y: number): number;
  spawnOne?(): boolean;
}
export interface SkyKindSystem extends SkyCell { readonly kind: string }

export function registerSkyKind(entry: SkyKindEntry): () => void;   // registry.ts:96
export function spawnSkyKind(name: string): boolean;                // registry.ts:117
export function precipitationAt(x: number, y: number): number;      // registry.ts:132
export function livingSystems(): readonly SkyKindSystem[];          // registry.ts:150
export function resetSkyRegistry(): void;                           // registry.ts:169
export function currentWind(): Readonly<Wind>;                      // wind.ts:88  (unchanged)
export function windVelocity(): { vx: number; vy: number };         // wind.ts:93
```

Additive deviations from the brief's pinned text: `SkyKindSystem` is a named type (the
brief inlined it); `windVelocity` and `resetSkyRegistry` are also exported (the latter is
the test seam the hub suite drives). `registerSkyKind` **throws** a `TypeError` on a
structurally invalid entry (`registry.ts:97-101`) — inside the host's per-callback guard
that is one logged line and a kind that is simply not in the sky.

Registry cleared in `onWorldClose` only (`plugins/weather/server/index.ts:62-67`), never
in `onWorldCreate` (`:49-59`). Verified from primary source: `server/src/plugins/
discovery.ts:231` sorts plugin directories, so load order is
`fog < rain < snow < thunderstorm < weather` and every kind creates before the hub.

**Hub client half: removed entirely.** `plugins/weather/client/` is deleted and `weather`
is absent from `client/src/plugins/registry.ts`. A server-only plugin is the ordinary case
here (`reveal`, `populous` have none either), and it keeps `client/test/drawBudget.test.ts`
happy with no zero-budget no-op to explain.

---

## 3. Changes to `shared/` — exactly two files

`git diff --stat d82828a -- shared/`:

```
 shared/src/discWire.ts | 108 +++++++++++++++++++++++++++++++++++++++++++++++++
 shared/src/index.ts    |   1 +
 2 files changed, 109 insertions(+)
```

* `shared/src/discWire.ts` — **new**. `DiscSystemState`, `DiscSystemsPayload`,
  `parseDiscSystemsPayload`. Four plugins broadcast the identical disc list and a plugin
  may not import another plugin's protocol, so the payload shape and its defensive parse
  live here — the same move #180 made for broadcast rounding, for the same reason.
* `shared/src/index.ts` — **one line**: `export * from './discWire.ts';` inserted after
  the existing `export * from './wire.ts';`.

**Nothing else in `shared/` was touched** — in particular `shared/src/rng.ts` is
byte-identical to `d82828a`. (An earlier `git diff --stat main` appeared to show
`shared/src/rng.ts | 50 +-`; that was another agent's post-`d82828a` commit showing up
inverted because `main` had advanced. Against the real base, it is untouched.)

---

## 4. Wire

| plugin | messages | payload |
|---|---|---|
| `weather` (hub) | none | — |
| `rain` | `rain:systems` | `{ systems: DiscSystemState[] }` |
| `thunderstorm` | `thunderstorm:systems`, `thunderstorm:strikes` (+ world event `thunderstorm:strikes`) | systems as above; strikes = flat `[systemId, x, y, …]`, unchanged `packStrikes` |
| `snow` | `snow:systems` | as above |
| `fog` | `fog:systems` | as above |

**Change from today: the `kind` field is DROPPED** (my call, per the brief's "your call,
say which"). Seven keys instead of eight — `id, x, y, radius, intensity, vx, vy` — because
the message is already namespaced by the plugin that sends it, so a kind field would be a
second, weaker copy of that name. ~11 B/system cheaper. Each plugin's `protocol.ts`
re-exports the shape from `@terrace/shared` (e.g. `plugins/rain/protocol.ts:21-25`), so a
plugin's two halves still import one wire contract.

Strikes payload is byte-identical to today's.

---

## 5. Draw budgets

| | cap | objects per rig | total |
|---|---|---|---|
| **old `weather`** (`plugins/weather/client/index.ts:205-222` @ d82828a) | 14 | 7 (worst case) | 14×7 + 1 dry bolt + 0 light bank = **99** |
| rain | 7 | 5 (column + 4 haze sheets) | 35 |
| thunderstorm | 3 | 7 (+ glow sheet + bolt) | 3×7 + 1 dry bolt + 0 = 22 |
| snow | 2 | 5 | 10 |
| fog | 2 | 4 (haze only) | 8 |
| **new sum** | 14 | | **75** |

75 ≤ 99. The per-kind ceilings 7/3/2/2 are each what the coverage formula asks for on the
shipped 2048-cell world at that kind's share, and they sum to the old ceiling of 14.

---

## 6. Behaviour deviations from today, with `file:line` evidence

### 6.1 Per-kind population budget — the one intentional change

* **Old:** one cap of 14 over `TARGET_SKY_COVERAGE_FRACTION = 0.18` with kind weights
  `[5, 2, 1.5, 1.5]` — `plugins/weather/server/systems.ts:112`, `:398`, `:519-526`
  @ `d82828a`.
* **New:** four instances at 0.09 / 0.036 / 0.027 / 0.027 with ceilings 7 / 3 / 2 / 2 —
  `plugins/rain/protocol.ts:57,76`, `plugins/thunderstorm/protocol.ts:49,64`,
  `plugins/snow/protocol.ts:44,56`, `plugins/fog/protocol.ts:41,50`; derived by
  `discActiveCapFor` at `server/src/plugins/kit/discSystems.ts:361-374`.
* Shares sum to 0.18; ceilings sum to 14. Deleting `fog` now removes fog's share rather
  than redistributing it.

### 6.2 One tick of wind lag

* **Old:** `advanceWeather` veered the wind and then moved every system inside the same
  call — `plugins/weather/server/systems.ts:807-838` @ `d82828a`.
* **New:** the hub veers on its own tick and sorts last in load order, so kinds drift on
  the wind as it stood at the END of the previous tick —
  `plugins/weather/server/index.ts:69-82`.
* Coherence (every system displaced by the same vector within a tick) is preserved and
  asserted — `plugins/rain/test/rain.test.ts`, `describe('drift coherence')`. The lag is
  0.1 s at the shipped TICK_HZ against a wind that veers ~20°/hour.

### 6.3 Snow's unsited roll is handed off by name, not mutated in place

* **Old:** `if (!sited) kind = SNOW_FALLBACK_KIND` mutated the kind of the system about to
  be created — `plugins/weather/server/systems.ts:383`, `:630` @ `d82828a`.
* **New:** the roll is abandoned and `spawnSkyKind('rain')` is asked to birth one instead —
  `plugins/snow/server/index.ts:70-76`, `:100-106`;
  `plugins/snow/server/weather-bridge.ts:165-169`.
* Net effect equals today's **when rain is running and below its own cap**. If rain is
  absent, disabled for the world, or at cap, the roll is lost.
* **Residual, named:** the hand-off system is drawn from rain's own generator with rain's
  own radius and intensity bands, not snow's — the old path reused the draws it had
  already made. A seeded run therefore diverges from the pre-split one.

### 6.4 `MIN_ACTIVE_SYSTEMS` is now per kind

* **Old:** a floor of 1 for the whole sky — `plugins/weather/server/systems.ts:91`
  @ `d82828a`.
* **New:** a floor of 1 per instance — `server/src/plugins/kit/discSystems.ts:50`.
* On the shipped world the caps are 7/3/2/2 and this never binds. On a world small enough
  for the floor to bind, the sky holds 4 systems where it used to hold 1.

### 6.5 Flash-light bank shrinks 4 → 3

* **Old:** `STORM_FLASH_LIGHT_BANK_SIZE = 4` against a 14-system ceiling, so most storms
  were unlit — `plugins/weather/client/sky.ts:483` @ `d82828a`.
* **New:** `= MAX_ACTIVE_SYSTEMS` = 3 — `plugins/thunderstorm/client/rig.ts:108`.
* One fewer PointLight in the scene, and every thunderstorm the cap allows now gets one.

### 6.6 Dev switch renamed

* **Old:** `WEATHER_DEV_FORCE=rain|storm|snow|fog` — `plugins/weather/server/dev.ts:327`
  @ `d82828a`.
* **New:** `<PLUGIN>_DEV_FORCE=1` — `server/src/plugins/kit/devForce.ts:53`
  (`devForceEnvName` at `:33`).

### 6.7 Admin actions

* **Old:** four actions generated from `WEATHER_KINDS` on the one plugin —
  `plugins/weather/server/index.ts:214-218` @ `d82828a`.
* **New:** one action per plugin ("Bring rain" / "Bring a thunderstorm" / "Bring snow" /
  "Bring fog") — e.g. `plugins/rain/server/index.ts:189-196`.

### 6.8 Verified UNCHANGED (from source lines, not comments)

* Wetting kinds: old `WETTING_KINDS = ['rain','storm','snow']`, fog excluded —
  `plugins/weather/server/systems.ts:723` @ `d82828a`. New: rain/thunderstorm/snow expose
  `systems.intensityAt` (`plugins/rain/server/index.ts:121`,
  `plugins/thunderstorm/server/index.ts:99`, `plugins/snow/server/index.ts:127`); fog
  returns a constant 0 (`plugins/fog/server/index.ts:83`).
* `precipitationAt` is still a max, clamped to [0,1] —
  `plugins/weather/server/systems.ts:742-753` @ `d82828a` →
  `plugins/weather/server/registry.ts:132-141`.
* Sim constants carried over byte-for-byte: 240 s mean lifetime, 30 s fade, 20 s per-slot
  interval, 130 s effective lifetime, spawn/despawn margins 1 / 1.5, radius band 24–56
  world units, peak intensity band 0.45–1, 4 siting attempts —
  `server/src/plugins/kit/discSystems.ts:50,70,84,102,114,162,179,192`.
* Lightning: 0.06/s world budget, 6 storm samples, 1/240 dry rate, 24 dry samples,
  prominence weight 2 — `plugins/thunderstorm/server/lightning.ts:73,88,117,127`.
* Photosensitivity: 3 s floor, exactly one rise and one fall —
  `plugins/thunderstorm/client/lightning.ts:54`, `:186-193`.
* Snow siting: 2 bands above sea, 5 samples, unlocked-only —
  `plugins/snow/server/siting.ts:39,65,86-101`.
* fire's and mudslides' bridges (`plugins/fire/server/weather-bridge.ts`,
  `plugins/mudslides/server/weather-bridge.ts`) were **not edited** and still resolve
  `currentWind` / `precipitationAt` on the hub module.

---

## 7. Consumers touched (the only edits outside the five plugins + kit + registry)

* `plugins/fire/server/index.ts` — `'weather:strikes'` → `'thunderstorm:strikes'`; comment
  header at `plugins/fire/server/strike-event.ts:1-7` updated. Payload unchanged.
* `plugins/storms/server/weather-bridge.ts:50` — `WEATHER_STORM_KIND = 'storm'` →
  `'thunderstorm'`. Nothing else in storms.
* `client/src/plugins/registry.ts` — `weather` removed; `rain`, `thunderstorm`, `snow`,
  `fog` added in that order where `weather` sat.
* Sweep: **zero** remaining `'weather:'` message/event strings and **zero** `'storm'` kind
  strings under `plugins/`, `server/src`, `client/src`. `mudslides` and `storms` keep their
  own `*_DEV_FORCE` readers — phase 2's to migrate.

---

## 8. Tests moved, split and dropped

* `rollEvent` + `pickWeightedIndex` — **dropped**: duplicate of existing coverage at
  `shared/test/rng.test.ts:76` and `:114` (verified).
* `drift coherence` — split: wind band / canonical heading → `plugins/weather/test/
  wind.test.ts`; system displacement → `plugins/rain/test/rain.test.ts`.
* `spawn and decay`, `broadcast` → `plugins/rain/test/rain.test.ts`. **One copy only** —
  the engine is shared, so re-asserting it in four suites would test the kit four times.
* `snow siting` → `plugins/snow/test/snow.test.ts` (the three "it rains instead" cases
  rewritten against the hand-off mechanism).
* `parseSystemsPayload`, `WeatherInterpolator`, `the falling column` →
  `plugins/rain/test/client.test.ts`; `the fog bank` → `plugins/fog/test/fog.test.ts`;
  `the photosensitivity floor` → `plugins/thunderstorm/test/thunderstorm.test.ts`.
* New contract tests, written BEFORE the modules they cover:
  `server/test/plugin-kit-disc-systems.test.ts` (path follows the repo's existing
  `plugin-kit-*.test.ts` convention rather than the brief's `server/test/kit/`), and
  `plugins/weather/test/hub.test.ts`.
* No assertions weakened. `rain`'s suite drives a **local fake hub**, not an import of
  `plugins/weather`: a plugin's suite depending on a neighbouring plugin is the same
  cross-plugin coupling the shipped code refuses.

---

## 9. Gate outputs

**1. `pnpm typecheck` — 0 errors**, all 26 workspace packages.

**2. `pnpm test`** — new suites all green: rain 31, thunderstorm 17, weather 12, snow 11,
fog 7. Workspace totals: server 345/345, shared 309/309, client 503/504, monsters 193,
structures 188, wildlife 132, relics 77, flora 70, boats 52, pilgrims 42, daynight 29,
populous 25, chronicle 15, reveal 9, invite 8.

Failures, all pre-existing:

* `plugins/mana` — 1 failed / 72 passed (the float-leak test the orchestrator reproduced).
* `client/test/vertexGrid.test.ts` — 1 failed / 503 passed (the picking test).
* `plugins/fire` and `plugins/temples` — exit 1, "No test files found". **Their `test/`
  directories exist only as UNTRACKED files in the main checkout**
  (`git ls-files plugins/fire plugins/temples | grep test/` → 0 hits), so any worktree cut
  from `main` is missing them. Not caused by this branch. `pnpm -r` aborts on the first, so
  the full run was `pnpm -r --if-present --no-bail --filter '!@terrace/plugin-fire'
  --filter '!@terrace/plugin-temples' run test`.

**3. `git diff --stat d82828a`** — 72 files changed, **+7 510 / −4 835**.
`plugins/weather/server/systems.ts` (877 lines) is **gone**; weather's server half is now
`index.ts` (127) + `wind.ts` (128) + `registry.ts` (172) + `rng.ts` (46).

**4. Gate 4 — no plugin imports another.**
`grep -rnE "^\s*(import|export).*from '\.\./\.\./(rain|thunderstorm|snow|fog|weather)/" plugins/`
→ **0 hits**.

**5. Gate 5 — kit code names no plugin.**
`grep -rn "rain\|snow\|fog\|thunderstorm\|weather" server/src/plugins/kit client/src/plugins/kit`
→ 18 hits, **all inside comments** (prose only: "raindrop", "scene.fog", "weather covers
the whole world", "…is fog-of-war bound"). No kit identifier names a plugin — the fog
sheets are a HAZE bank (`client/src/plugins/kit/hazeBank.ts`).

---

## 10. In-world verification

### 10.1 Stack

`.phase1-stack/launch.sh` in the worktree: port **2611** (2599 was already held by another
agent's stack — checked with `ss -ltn` before starting, and the script refuses if the port
is taken), `WORLDS_DIR` and a **nonexistent** `DB_PATH` under
`<worktree>/.phase1-stack/`, `WORLD_SIZE=512`, `CLIENT_DIST_PATH` pointed at this
worktree's own `client/dist` (rebuilt from this branch, so the page under test is this
code). Fresh worlds dir per run.

`.phase1-stack/stop.sh` kills by pid file, falling back to the port owner's pid from
`ss -ltnp` — **no inline `pkill -f` / `pgrep -f` anywhere** (both run from a script file).

**The stack is torn down. `ss -ltnp | grep 2611` returns nothing — port 2611 is free.**
Port 2599 was never touched, nor was the main checkout's server or the owner's stack.

Screenshot rig: `.phase1-stack/shot.mjs` — raw CDP against `chrome-headless-shell`
(SwiftShader; Chrome DevTools MCP is unreliable in WSL2). Waits for the first actually
drawn frame, holds for the 30 s gather, optional wheel-zoom via a real
`Input.dispatchMouseEvent`, and an optional `WAIT_FOR` expression polled at 120 ms so a
0.32 s flash can be caught.

### 10.2 Screenshots

Primary copies live in the worktree; **every file is also copied to
`/mnt/e/Development/Projects/Terrace/.verify-shots/phase1/`** under the same name so they
survive the worktree being removed.

| absolute path | what it shows |
|---|---|
| `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12/.verify-shots/phase1/rain.png` | `RAIN_DEV_FORCE=1` — rain streaks falling across sea and forested shore, the forced front parked on the world centre. Scene report `{rain:1, thunderstorm:1, snow:0, fog:0}`; the second system is a naturally-spawned thunderstorm elsewhere on the map, not a second rain. |
| `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12/.verify-shots/phase1/thunderstorm.png` | `THUNDERSTORM_DEV_FORCE=1`, captured on the frame a bolt's flash light was lit: night, heavy storm rain, the strike's PointLight flaring on the water and lighting the terrain. |
| `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12/.verify-shots/phase1/thunderstorm-wide.png` | Same, one zoom step out — the flash pool unmistakable against the dark sea, storm streaks over the whole map. |
| `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12/.verify-shots/phase1/snow.png` | `SNOW_DEV_FORCE=1` — square white flake sprites drifting at sunset, visibly a different particle form from the rain streaks also in frame. |
| `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12/.verify-shots/phase1/fog.png` | `FOG_DEV_FORCE=1` — the haze bank as a bright soft-edged mass over the world centre at dusk, clear water outside it. Not scene fog: the far side of the map is untouched. |
| `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12/.verify-shots/phase1/all-four-forced.png` | All four switches at once — rain streaks, snow flakes and the fog bank drawn together over one centre. Scene report `{rain:1, thunderstorm:1, snow:1, fog:1}`: four plugins, four namespaced messages, four rigs. |
| `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12/.verify-shots/phase1/natural-sky.png` | No dev force, Day 2 08:16 after ~4 min of sim — rain over the western half, land and sea clear on the east. "Weather in large chunks" with clear sky the default. Scene report `{rain:1, thunderstorm:1, snow:0, fog:1}`. |

**Caveat on the two thunderstorm shots:** what is captured is the FLASH — the point light
and the lit water — not the bolt ribbon. At these zoom levels the camera sits below the
cloud base the ribbon hangs from. I did not get a frame with the ribbon in view.

### 10.3 Server log — five plugins loaded, four dev forces

From `.phase1-stack/server.log`:

```
[terrace] loaded 23 plugin(s): boats, chronicle, daynight, fire, flora, fog, invite, mana,
  monsters, mudslides, pilgrims, populous, rain, relics, reveal, snow, storms, structures,
  temples, thunderstorm, volcanoes, weather, wildlife
[terrace] plugin "fog" v0.1.0+fccdbe2
[terrace] plugin "rain" v0.1.0+3e0d1bd
[terrace] plugin "snow" v0.1.0+1e2d3bb
[terrace] plugin "thunderstorm" v0.1.0+1b705ce
[terrace] plugin "weather" v0.1.0+ba1b7aa
[terrace] [fog] FOG_DEV_FORCE=1 — one fog system parked over the world centre
[terrace] [rain] RAIN_DEV_FORCE=1 — one rain system parked over the world centre
[terrace] [snow] SNOW_DEV_FORCE=1 — one snow system parked over the world centre
[terrace] [thunderstorm] THUNDERSTORM_DEV_FORCE=1 — one thunderstorm parked over the world centre
[terrace] serving built client from <worktree>/client/dist
[terrace] listening on ws://0.0.0.0:2611 (room "world")
```

**All five plugins load. No bridge-unavailable warning from any kind** — i.e. every kind
resolved the hub through `WorldApi.sibling('weather')`.

### 10.4 The three couplings — proven, not inferred

The hub logs nothing on registration and fire logs nothing on ignition, so a log line
could not settle these. I probed them against the **real discovered plugins on a real
world through the real `PluginHost`** — `.phase1-stack/probe-couplings.mjs`. Output:

```
discovered: boats, chronicle, daynight, fire, flora, fog, invite, mana, monsters,
  mudslides, pilgrims, populous, rain, relics, reveal, snow, storms, structures,
  temples, thunderstorm, volcanoes, weather, wildlife
1) hub livingSystems kinds: ["fog","rain","snow","thunderstorm"]
   hub precipitationAt(centre): 1.000
   hub currentWind(): {"heading":2.7363198429581086,"speed":3.5654193284087414}
3) storms stormCells(): 1
   first: {"kind":"thunderstorm","x":256,"y":256,"radius":137.6,"intensity":1}
2) fires lit by the RETIRED name weather:strikes: 0
   fires lit by thunderstorm:strikes: 75
after close, hub livingSystems: 0
```

* **Four registrations — CONFIRMED.** All four kinds register inward; `livingSystems()`
  stamps each system with its owner's plugin name; `precipitationAt` at the centre is 1.0
  with three wetting kinds parked there; `currentWind()` answers live; and the register
  empties on `onWorldClose`.
* **fire receives `thunderstorm:strikes` — CONFIRMED, and it ACTS on it.** 200 strikes
  delivered under the retired `weather:strikes` name lit **0** fires; the same 200 under
  `thunderstorm:strikes` lit **75** — ≈ 200 × `LIGHTNING_IGNITION_CHANCE` (0.35). Events
  went through the host's own `notifyWorldEvent` fan-out, so the name, the load order and
  fire's real handler are all the shipped ones. Fuel was supplied through fire's own
  `registerFuel` open-set contract, because bare highland has nothing to burn at that world
  age (and the forced-sky world could not be used: `precipitationAt` 1.0 suppresses
  ignition by design).
* **storms finds thunderstorm cells — CONFIRMED.** `stormCells()` — the tornado spawner's
  own bridge accessor, the same module singleton storms resolved at `onWorldCreate` —
  returns the parked thunderstorm at the world centre, radius 137.6. The
  `'storm'` → `'thunderstorm'` string change at
  `plugins/storms/server/weather-bridge.ts:50` is exactly what makes it non-empty.

---

## 11. Not verified

* **The bolt ribbon geometry.** The flash is photographed; the ribbon is not. At the zoom
  levels used the camera is below the cloud base.
* **Per-rig draw-object counts (5 / 7 / 5 / 4)** are counted from the mesh constructors,
  not measured live with `countDrawObjects` in a running scene. The budget arithmetic
  (75 ≤ 99) rests on them.
* **Admin actions** ("Bring rain", "Bring a thunderstorm", "Bring snow", "Bring fog") were
  never clicked through the panel.
* **Frame cost.** The headless stack runs SwiftShader at ~1 fps, so nothing here says
  anything about the 140 fps benchmark or the per-plugin frame budget.
* **Long-run natural coverage.** I watched ~4 minutes of unforced sim, not the hours the
  0.18 target is defined over. Assumption, unverified: realised coverage still lands near
  0.18 in aggregate — the caps and constants are arithmetically identical to the pre-split
  ones, but I did not re-run the coverage sweep.
* **Seeded-run equivalence with the pre-split sim.** Not claimed: §6.3 changes which
  generator draws a handed-off system, and §6.2 shifts the wind by one tick.

---

## 12. Per-kind dev switch and park location

| kind | env | parks at |
|---|---|---|
| rain | `RAIN_DEV_FORCE=1` | world centre, `(worldSize/2, worldSize/2)` |
| thunderstorm | `THUNDERSTORM_DEV_FORCE=1` | same |
| snow | `SNOW_DEV_FORCE=1` | same — **siting is bypassed for a forced system**, so it snows over lowland |
| fog | `FOG_DEV_FORCE=1` | same |

Radius is the mean of the band the world allows. The system gathers from envelope 0 over
`DISC_FADE_SECONDS = 30` and then holds: it never drifts, ages or dies, and no second
system of that kind ever arrives — `server/src/plugins/kit/discSystems.ts:409-424`.
Several switches may be set at once; they all sit on the same centre. As before the split,
a parked wetting system reports full `precipitationAt` over the central disc, so fire
cannot start there.

Values accepted for the switch: `1`, `true`, `yes`, `on` (case-insensitive, trimmed);
anything else — including `0` and `false` — is off
(`server/src/plugins/kit/devForce.ts:44,53`).
