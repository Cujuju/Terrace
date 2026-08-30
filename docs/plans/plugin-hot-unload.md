# Plugin hot swap / update — research and options

Status: IMPLEMENTED 2026-08-26 — every phase in §7 has shipped (S0, S, 1, 2
#196, 3 #197, 4 #198; arc `arc/plugin-hot-swap` closed). Per-step DONE markers
and the measured restart gap / reload leak are in §7, §9 and DESIGN.md.
Research 2026-08-25 against `main` at f78b056, after per-world plugin
enablement shipped (3aee383, 10aed51, 2199d88, 6e80860, e3a87b6).
Restructured 2026-08-25 (owner feedback): the two scenarios that matter are
first-class goals; memory reclamation is demoted to a finding (§4). The owner
decisions in §8 were settled by approving the phases.

The two goals:

- **(a) Swap one life algorithm for another at runtime** — `life` (Conway CA)
  ↔ `populous` (Bullfrog growth) ↔ the alternative maintenance rules another
  session is prototyping (#28 growth-family CA, #153 Life rules under temples,
  #74 fed birth unreachable, #178 immortal buildings, #183 populous tier-0
  camps). Per world, without a process restart. → §2.
- **(b) Module updates** — the operator has a new version of one plugin's code
  and wants it live. → §3.

Short answer:

- **(a) is not an unload/load problem at all.** From source, `populous` is not
  a rival of `structures`: it is a RULE registered into structures' one
  growth-model slot; the board, the wire, the slice and the client half are
  structures' under either rule (§1.8). The swap is "one plugin with a
  per-world model setting persisted like `disabled_plugins`", and every future
  rule from #28 (Maze/Coral/HighLife/hybrid) is a value of that same setting.
  Toggling `structures` off and `populous` on today does NOT swap anything —
  it breaks in four verified ways (§1.9). Recommendation: per-world plugin
  settings (Phase S), which depends on Phase 2 (host-mediated bridges) to be
  safe. Estimate 2–3 days plus Phase 2.
- **(b) is a restart made cheap.** Option A (graceful restart with player
  carry-over) is the recommended procedure; Option B (in-process reload)
  delivers the server half only, still needs a client rebuild + page reload,
  and needs Phases 2–3 first. Both need the same slice-compatibility contract
  (§3.3), which is missing today: only 9 of the 16 plugins have a persistence
  slice at all, 6 of those 9 version it, 3 do not, and no snapshot on disk
  carries a host-level version envelope.
- **Memory is a finding, not a goal (§4):** all 16 plugins' code plus
  per-world state measure ~5.5 MB in a ~126–142 MB process.

---

## 1. Findings

### 1.1 Server: how plugins are discovered, imported and held

- Discovery is folder-based and happens once at boot (`server/src/index.ts:128`
  → `discoverPlugins`). Each `plugins/<name>/server/index.ts` is loaded with a
  bare `await import(pathToFileURL(entryPath).href)`
  (`server/src/plugins/discovery.ts:141`). The product is a `LoadedPlugin`
  `{ plugin, directory, entryPath }` (`server/src/plugins/types.ts:511-517`).
  Nothing reads the plugin's `package.json` — `plugins/structures/package.json`
  says `"version": "0.1.0"` and every plugin says the same; no version reaches
  the process.
- **The installed set was captured for the life of the process. FIXED
  2026-08-26 (issue #198, Phase 4 step 16).** It is now an `InstalledPlugins`
  object (`server/src/plugins/installed.ts`) whose slots can be replaced in
  load order, asked afresh every time a session is built — which is what makes
  a reload reach the next world at all. The three captures below were the
  reason it could not.
- The `LoadedPlugin[]` is captured for the life of the process in three places:
  `WorldManager.deps.plugins` (`server/src/index.ts:131-136`,
  `world-manager.ts:114`), `bindRoomContext({ pluginMessageTypes:
  PluginHost.messageTypesFor(plugins) })` (`index.ts:192-196`), and — per
  session — `PluginHost.installed` / `PluginHost.entries`
  (`server/src/plugins/host.ts:67-77, 116-123`).
- **Message types were fixed at boot. FIXED 2026-08-26 (issue #197, Phase 3
  step 15).** The Colyseus room used to register one `onMessage` per namespaced
  type at room create from the boot-time list; a reloaded plugin that ADDED a
  message type would never receive it, and one that REMOVED a type left a dead
  registration. It now registers a single `onMessage('*')` and asks the live
  host per message (`server/src/net/plugin-message-routing.ts`), so nothing
  about plugin messages is snapshotted at boot.
  `onMessage('*')` is VERIFIED present in @colyseus/core 0.17.50: the overload
  `onMessage(messageType: '*', callback: (client, type, message) => void)` is
  declared at `build/Room.d.ts:437`, and `_onMessage` (`build/Room.mjs:994-1000`)
  emits to `'*'` only when no handler is registered for the incoming type,
  falling back to `__no_message_handler` (`Room.mjs:94-103`: `client.error` in
  dev mode, `client.leave(CloseCode.WITH_ERROR)` otherwise) when there is no
  `'*'` either. The room therefore reproduces that rejection itself for any
  non-namespaced type, so an unknown core type still degrades as it always did;
  a namespaced type nobody claims is dropped in silence, as before.
- **Per-session views are already revocable.** `createWorldApi` holds the
  World in a mutable cell; `closeSession` runs `host.closeWorld()` then
  `host.revokeApis()` (`server/src/world/session.ts:212-230`,
  `world-api.ts:90-101, 259-261`). After revoke a stale reference pins a stub,
  not the heightmap (#164). This is the ONLY eviction mechanism core has today,
  and it evicts the World from the plugin — not the plugin from the process.
- **No plugin implements `onWorldClose`** (`grep -rl onWorldClose plugins/`
  → nothing; only `types.ts:342` and `host.ts:167-173`). The hook (#167) is
  declared "belt and suspenders, not the fix" (`types.ts:337-340`) and no
  plugin releases derived state on close.
- **All 16 server plugins keep state at module scope** (DESIGN §3.2 "One live
  world, not many, because plugin state is module-scoped"; `session.ts:19-27`;
  issue #78). Top-level `let/const` counts per server half, from
  `grep -cE '^(let|const|var) '`: structures 36, fire 36, flora 35, pilgrims 34,
  boats 26, wildlife 25, monsters 19, relics 17, chronicle 14, populous 14,
  temples 14, weather 7; daynight/invite/mana/reveal 0 at the pattern (mana
  keeps `const poolsByPlayer = new Map()` at `plugins/mana/server/index.ts:604`
  — the grep pattern is a floor, not a census). Examples:
  `plugins/chronicle/server/index.ts:114-149` (`let entries`, `tierFirsts`…),
  `plugins/wildlife/server/index.ts:148` (`let tickCount`).
  Reset is by convention: every `onWorldCreate` assigns rather than
  accumulates, and `restorePersistence` + `worldCreate` is replayed on open and
  on rollback (`session.ts:119-129`, `rollback.ts:21-22`).
  **The convention has a hole** (§1.9 finding 3): a module's state is only
  reset when its plugin is ENABLED in the new session. A disabled plugin's
  module keeps the last session's state forever, and its siblings can still
  reach it.
- **No plugin owns a timer, a process listener or a worker**
  (`grep -rnE 'setInterval|setTimeout|process\.on|new Worker' plugins/*/server`
  → nothing). Everything a plugin does happens inside a host-driven hook. That
  is the single fact that makes any unload story tractable: there is no
  plugin-owned background activity to cancel.
- **16 cross-plugin bridge files hold sibling MODULE IDENTITY** (the earlier
  count of 17 counted one twice; `ls plugins/*/server/*bridge*.ts` → 16).
  Pattern from `plugins/relics/server/mana-bridge.ts:1-60` (four rules:
  dynamic import, start in `onWorldCreate` without awaiting, buffer-don't-drop,
  duck-type). Sites: boats→fire, fire→{mana,weather}, flora→{fire,structures},
  pilgrims→{fire,monsters,structures,temples}, populous→{pilgrims,structures},
  relics→mana, structures→fire, temples→{pilgrims,structures}, wildlife→fire.
  Each bridge caches the resolved namespace at module scope
  (`plugins/flora/server/fire-bridge.ts:45-47` `let fireApi`). The specifier is
  the sibling's ON-DISK path, so it resolves to whatever Node's module map
  holds for that URL — the boot-time instance, forever. Reloading `fire` under
  a new URL would leave every registrant feeding fuel to the OLD fire module
  while the host ticks the NEW one: split-brain, silent, and `safely` would
  not log it because nothing throws. **The same binding makes enablement
  invisible to a bridge**: a disabled sibling's module still resolves and
  still answers (§1.9). **This is the root cause that blocks both single-plugin
  reload and a safe per-world swap**, not any callsite: the bridge contract
  binds to module identity instead of to the host's notion of "the plugin
  currently running as X in this session".

### 1.2 What Node 24 ESM offers for eviction (platform facts)

Stated from Node's documented module semantics; the two numbers below were
measured here (`~/.terrace-plugtest/heap/cachebust.mjs`).

- The ESM module map is per-realm and keyed by resolved URL; there is no API to
  evict an entry (`require.cache` deletion does not apply to ESM). An import
  is permanent for the life of the realm.
- `import(url + '?v=N')` creates a NEW instance of the ENTRY module only. Its
  static imports resolve to their plain URLs and hit the cache — so an edit to
  `plugins/wildlife/server/population.ts` would NOT be picked up by busting
  `index.ts`. Measured: 20 cache-busted re-imports of
  `plugins/wildlife/server/index.ts` grew the heap by 1.06 MB total
  (0.053 MB per re-import) against 0.50 MB for the first import of the same
  entry — the delta is the entry module alone; the subtree was shared. Real
  reload needs the whole `plugins/<name>/server/**` subtree re-resolved under a
  generation tag, i.e. a `module.register()` resolve hook that rewrites
  specifiers under that directory (Node ≥20.6 customization hooks; run on a
  separate thread, so they cannot see host state — the generation must be
  passed via the hook's `data` or encoded in the parent URL).
- The old instances stay reachable from the module map, so each reload leaks
  the old module's code and whatever its module-scope state held at the
  moment it was abandoned (estimate, from §4: ≤0.55 MB code + ≤0.35 MB
  state per reload of the largest plugin; measured entry-only re-import leak
  0.053 MB).
- Real unload requires a boundary whose teardown frees a module map:
  `worker_threads` (own isolate, own module map; `terminate()` frees all),
  a child process, or `vm.SourceTextModule` contexts (still behind
  `--experimental-vm-modules` in Node 24 — unverified whether it graduated;
  treated as experimental). Each is assessed in §6.

### 1.3 Server: what a boundary would do to Terrace's contracts

- Every plugin hook is **synchronous** and the host fans out **in load order**
  (`host.ts:5-7`). `onIntent` composes a verdict inline (`host.ts:232-252`);
  `onTick` calls `WorldApi.sculpt` which writes the World synchronously through
  `applyServerSculpt` (`world-api.ts:173-197`). A worker or process boundary
  makes every hook a round trip; the intent chain, the tick, and the
  terrain-change cascade depth guard (`host.ts:301-322`) all assume the plugin
  returns before the next one runs.
- `WorldManager.openInto` is synchronous by design (guarantee 2,
  `world-manager.ts:9-12, 408-414`). A boundary that introduces `await` into
  session open/close breaks "no instant at which a tick can observe a
  half-swapped process".
- Single-writer World: plugins mutate the World only through `WorldApi`, which
  delegates to the one `World` (`world-api.ts:1-6`). Across a boundary the
  heightmap would have to be a `SharedArrayBuffer` and every mutation would
  race the tick — or be serialised as messages, which is the async problem
  again. Either way `shared/` determinism ("fixed iteration order",
  CLAUDE.md hard rules) has to be re-established by hand at every boundary.

### 1.4 Client

- Client halves are statically imported and compiled in
  (`client/src/plugins/registry.ts:9-40`; DESIGN Q6, decided:
  `docs/DESIGN.md:463-466` — runtime loading was costed and deferred because
  the hard part is sharing Solid/Three/shared across bundle boundaries).
  `populous` has NO client half and is not in the registry (`registry.ts`
  lists `structures` only) — by design (`plugins/populous/server/index.ts:14-19`).
- 6e80860 made mount/unmount per plugin: `unmountPlugin` removes tools, HUD
  panels, the header action, runs `dispose()`, every tracked unregister, clears
  and removes the scene layer (`client/src/plugins/host.ts:435-467`);
  `syncLivePlugins` diffs against `JoinSnapshotMessage.livePlugins`
  (`host.ts:495-514`, `shared/src/protocol.ts:330`). What is freed: the
  plugin's Three objects (subject to the plugin disposing its own geometries —
  `layer.clear()` does not call `.dispose()` on GPU resources; unverified per
  plugin), Solid components, handler sets. What stays: the module code in the
  bundle, any module-scope state in the client half, and the sky rig's last
  look (`host.ts:462-466`).
- "Update a plugin's code" on the client means a new chunk: `import.meta.glob`
  lazy chunks would let a disabled plugin's code never download, but a CHANGED
  plugin is a new build with a new hash and the page has to reload to get it —
  there is no in-page swap that does not re-solve Q6's bundle-boundary
  problem. In dev, Vite HMR with `TERRACE_WATCH=1` (polling, mandatory on
  /mnt/e — `client/vite.config.ts:63-80`) already hot-swaps a client half
  module, but HMR re-evaluates the module and re-runs whatever `attach` did
  without calling `dispose`: **no client half registers `import.meta.hot`
  handlers** (verified: `grep -rn "import.meta.hot" plugins/*/client` → none).
- Build identity: the bundle carries `__CLIENT_VERSION__` (`client/vite.config.ts:50`),
  the server `SERVER_VERSION` (`server/src/version.ts`: `<commit count>.<short
  hash>` or `TERRACE_VERSION`), and `VersionWatermark.tsx:43` already renders
  the skew. Both are ONE stamp for the whole build — there is no per-plugin
  version anywhere in the stack.

### 1.5 Protocol / shared

- Nothing in `shared/src/protocol.ts` has to change for any server-only
  option. Option B (in-process reload) adds one admin request/result pair
  (`worldPluginReload`), additive and optional exactly like `worldPluginSet`
  (`protocol.ts:956-963`). `PLUGIN_NAME_PATTERN` / `validatePluginName`
  (`protocol.ts:1121-1128`) already validate the name off the wire. No terrain
  math is touched; the file stays erasable TS.
- `worldPluginListing` (`protocol.ts:995-1007`) carries `installed: string[]`
  and `disabled: string[]` — names only. Built by
  `WorldAdminService.pluginListing` (`world-admin.ts:151-162`) from
  `WorldManager.installedPluginNames`. A per-plugin version stamp (§3.6) is an
  additive field here.
- Snapshot slices are keyed by plugin name (`host.ts:445-461`) and versioned
  only by per-plugin convention. **Nine plugins declare a `PersistenceSlice`**
  (verified individually, `grep -n 'const persistence: PersistenceSlice'
  plugins/*/server/index.ts`): boats:118, chronicle:389, fire:686, flora:1029,
  monsters:279, relics:598, structures:589, temples:244, wildlife:300. The
  other seven (daynight, invite, mana, pilgrims, populous, reveal, weather)
  have no slice at all, so there is nothing to version — pilgrims says so by
  settled design (`plugins/pilgrims/server/index.ts:176-182`).
- **Six of those nine carry a version constant and check it on load**
  (verified by opening each file):
  `chronicle` (`CHRONICLE_SLICE_VERSION = 2`, `index.ts:105`; written as `v`
  at `:392`, checked `:417`; v1 MIGRATED via `migrateDay`, `index.ts:182,
  417-440`), `flora` (`FLORA_SLICE_VERSION = 1`,
  `plugins/flora/server/persistence.ts:37`, checked `:93`), `monsters`
  (`MONSTERS_SLICE_VERSION = 3` plus V2 = 2 and LEGACY = 1,
  `plugins/monsters/server/persistence.ts:52-58`, checked `:231-235`),
  `relics` (`RELICS_SLICE_VERSION = 1`, `index.ts:194`, checked `:545`),
  `structures` (`STRUCTURES_SLICE_VERSION = 2`,
  `plugins/structures/server/persistence.ts:36` — the earlier `:37` citation
  was off by one; v1 READ not refused at `:137-138`, `population` field
  additive-optional), `wildlife` (`WILDLIFE_SLICE_VERSION = 1`,
  `plugins/wildlife/server/persistence.ts:26`, checked `:114`).
- **Three have a slice and no version at all**: `boats`
  (`index.ts:118` → `saveBoats`/`loadBoats`, no version anywhere in
  `plugins/boats/server/persistence.ts`), `fire` (`index.ts:686`, save returns
  `{fires, entities}`), `temples` (`index.ts:244`, save returns `{temple}`).
  These are the only plugins that literally *cannot tell* an old slice from a
  new one — three, not thirteen.
- **Downgrade behaviour today** (stored version HIGHER than the code knows —
  every versioned plugin treats it as "unknown"), for all six:

  | plugin | forward-slice behaviour today | blast radius |
  |---|---|---|
  | `structures` (`persistence.ts:138`) | returns an empty board | the town is demolished on the next save |
  | `flora` (`persistence.ts:93`) | returns the empty forest | every tree in the world is erased |
  | `wildlife` (`persistence.ts:114`) | keeps no entities | every animal is erased |
  | `monsters` (`persistence.ts:231-256`) | empty monsters + empty cooldowns | monsters and their cooldown clocks are erased |
  | `relics` (`index.ts:545`) | returns early, keeps nothing | relics and the relic RNG are erased |
  | `chronicle` (`index.ts:417`) | returns early, keeps nothing | the chronicle is erased |

  `flora` is as destructive as `structures`, not a milder case — which is the
  strongest single argument for §3.3's dormant-on-downgrade rule.
- **Migration precedent: `monsters`, not `chronicle`.** `chronicle` has one
  legacy branch (`index.ts:417-440`). `monsters`
  (`plugins/monsters/server/persistence.ts:225-256`) implements a two-step
  chain — v3 current, v2 accepted with its cooldowns rewritten by
  `migrateV2Cooldowns` (`:246-251`), v1 through `migrateLegacySlice`
  (`:252-255`) — and is the richer pattern any `load(data, fromVersion)`
  signature has to accommodate (§3.3).
- A reloaded plugin reading an older slice is the SAME path as a server
  upgrade reading yesterday's snapshot — the contract already exists and is
  each plugin's `persistence.load`, wrapped in `safely` (`host.ts:491`) so a
  throw is logged, not fatal.
- **No envelope exists on disk.** `collectPersistence` writes the plugin's
  raw save value (`host.ts:458` `slices[plugin.name] = data`) and
  `restorePersistence` hands it straight back (`host.ts:493-495`), one
  argument, no version. `plugin_slices(snapshot_id, plugin, data)`
  (`server/src/persistence/snapshot-store.ts:382, 464, 479`) stores it
  verbatim, for snapshots AND for restore points. Every byte in every existing
  world file is therefore un-enveloped — which §3.3 must have a read path for.

### 1.6 Operational facts already in place

- Graceful shutdown: SIGINT/SIGTERM → `onBeforeShutdown` stops the tick loop,
  writes the final snapshot, leaves the active pointer alone so the next boot
  returns to the same world (`server/src/index.ts:207-220`, `world-manager.ts:400-406`).
- Clients reconnect silently with backoff (400 ms → 5 s, factor 2) and never
  show a retry UI (`client/src/net/connection.ts:25-31, 83-85`); the player
  token is in localStorage (`client/src/state/playerToken.ts`) and territory
  rides the snapshot (`tokenMasks`), so a returning player gets their land
  back (`world-manager.ts:462-465`).
- Dev: `run_server.py --watch` already restarts the server on source changes by
  stat polling (`run_server.py:78-96`) — inotify and `node --watch` are dead
  on /mnt/e. Prod: docker-compose `restart: unless-stopped`
  (`docker-compose.yml:97,116`).
- Every session open/close already replays restore + worldCreate, and a
  reopen carries players across without dropping sockets
  (`world-manager.ts:240-274, 408-486`). `setPluginEnabled` persists first,
  reopens second (`world-manager.ts:307-352`); the disabled set lives in the
  world file's `disabled_plugins` table (`snapshot-store.ts:355, 923-935`) and
  is read at every open by `enabledPluginNames` (`session.ts:110-118`).
  Disabled plugins' slices ride through untouched as `dormantSlices`
  (`host.ts:83-98, 445-495`).

### 1.7 Per-world enablement: what the shipped commits give and do not give

- Gives: per-world on/off for any installed plugin, persisted, applied by
  reopen with player carry-over; client mounts/unmounts the matching half;
  disabled slice preserved verbatim.
- Does not give: any per-plugin SETTING beyond on/off (there is no
  `plugin_settings` table, no `WorldApi` accessor for world-scoped config);
  any isolation of a disabled plugin's MODULE from its siblings (§1.9);
  any notion of which code version a plugin is (§1.4).

### 1.8 The growth-model seam: what `life` and `populous` actually share

Read from `plugins/structures/server/{index,growth-model,persistence}.ts` and
`plugins/populous/server/{index,structures-bridge,model}.ts`.

- **Ownership.** `structures` owns the board (`live: Map<cellKey,
  BoardCellRecord>`, `index.ts:124`), the generation counter, the RNG, the
  seed calendar (`lastSeedDay`), the wire (`structures:all` /
  `structures:changes`, `plugins/structures/protocol.ts`), the tiers, fog of
  war, reactive demolition, the fire fuel registration, the persistence slice
  and the client half. `populous` owns ONE function — `step(world, live,
  ctx) → GrowthStepResult` — plus `afterSwap` (emit settlers via pilgrims).
  It has no client half, no messages, no persistence slice
  (`populous/server/index.ts:7-19, 98-117`).
- **The slot.** `growth-model.ts:184-193` (verified; `:170-180` is the tail of
  the `afterSwap` doc comment): `let registered: GrowthModel | null = null` at
  `:184`, `setGrowthModel` at `:191` is LAST WRITER WINS, one slot,
  `growthModel()` at `:196`. `populous` reaches
  it through a dynamic-import bridge (`populous/server/structures-bridge.ts:26`
  `import('../../structures/server/index.ts')`, `setGrowthModel` re-exported
  there), buffered until structures resolves.
- **Selection.** Process-wide env `STRUCTURES_MODEL` (`life` default |
  `populous`), read TWICE by design ("restate, don't import"): structures reads
  it once at MODULE IMPORT (`index.ts:143-152`, `let selectedModel =
  readStructuresModel(process.env)`; a bad value is fatal at boot,
  `growth-model.ts:55-73`), populous reads it at `onWorldCreate`
  (`index.ts:61-63, 101-104`) and registers nothing when not selected. The
  structures comment says "never re-read: a world that changed settlement
  models halfway through its life would have a board whose history no single
  rule explains" — that is a code comment, not a DESIGN.md decision
  (`grep STRUCTURES_MODEL docs/DESIGN.md` → nothing), so it is open to the
  owner.
- **The board is model-agnostic by construction.** Both paths produce the same
  `GrowthStepResult` and go through the same swap/delta/event
  (`index.ts:301-367` `advanceLife`, `:369-431` `advanceGrowthModel`).
  `BoardCellRecord = LiveCellRecord {age, tier} + population?`; the CA never
  writes `population`, populous reads `population ?? 0`. Slice v2 stores
  `{x,y,age,tier,population?}`, `generation`, `rngState`, `lastSeedDay`
  (`persistence.ts:37-83`). **Nothing in the slice records which model wrote
  it.**
- **What a swap must carry:** the board as-is (both rules accept any board),
  `generation` (diagnostic), `rngState` (only the CA consumes it; populous
  uses none — `grep rng plugins/populous/server/model.ts` → none, unverified
  beyond grep), `lastSeedDay` (CA only). **Destroy:** nothing — no per-model
  derived state exists outside the board except the CA's in-flight
  `GenerationSurvey` (`survey`, amortised scan over ticks) and populous' clock
  `lastGrowthSeconds`, both module-scope and both re-initialised on
  `onWorldCreate`... **except they are not**: `survey`, `scanCredit`,
  `lastGrowthSeconds`, `warnedNoGrowthModel`, `simSeconds` are initialised at
  module load and reset only by the test seam `resetStructuresState`
  (`index.ts:830+`), not in `onWorldCreate` (`index.ts:604-660`). On a reopen
  today the CA resumes a half-finished sweep of the PREVIOUS session's board
  snapshot. Harmless in practice (the sweep reads a snapshot and the swap
  replaces `live`), but it is exactly the class of state a model swap must
  reset explicitly. **Re-seed:** under `life`, an empty board re-seeds itself
  on the next Monday (`shouldSeed`); under `populous` nothing seeds — houses
  arrive only from pilgrims' `foundStructure`, so a populous world with
  pilgrims disabled never builds. A swap life→populous on a board of CA
  still-lifes works (populous grows whatever stands); populous→life on a
  board of populous camps works (the CA applies B3/S23 to them, which will
  demolish most 2×2 homesteads — expected, deterministic, and the owner should
  know that is what "swap" means).
- **What the alternative rules in flight need.** #28's candidates
  (Maze/Coral/HighLife/hybrid) are variants INSIDE `life.ts`, not new plugins;
  #153/#74/#178/#183 are rule changes to life or populous. All of them are
  values of one selector, not plugin toggles — which is the deciding argument
  against "swap = enablement" in §2.

### 1.9 What breaks TODAY if an operator disables `structures`, enables `populous`, reopens

Traced from source; not run on the rig (no app start permitted this turn).
Labelled per item.

1. **Nothing swaps (verified).** `populous.onWorldCreate` re-reads the
   process-wide env; with `STRUCTURES_MODEL` unset it logs
   `POPULOUS_INACTIVE_MESSAGE` and registers nothing. With
   `STRUCTURES_MODEL=populous` it imports the structures MODULE (still in the
   module map — disabled ≠ absent), registers the model into a slot nobody
   ticks (structures is not in `host.entries`), and nothing grows. The
   structures slice is preserved as a dormant slice either way.
2. **The client shows no buildings (verified).** `syncLivePlugins` unmounts the
   structures client half; populous has none to mount. `structures:*` room
   handlers stay registered from boot and `handlerFor` returns undefined →
   messages dropped (harmless).
3. **A ghost board answers the siblings (verified from source).** flora
   (`flora/server/structures-bridge.ts:106`), pilgrims (`:127, :140, :159,
   :165`) and temples (`:97`) hold the structures module namespace and keep
   calling `standingStructures()`, `canFoundStructure`, `foundStructure`,
   `setBlessedStructureCells`, `setReservedStructureCells` on it. The module's
   `live` is the board from the moment the previous session closed —
   `closeWorld` runs no reset (`onWorldClose` unimplemented, `resetStructuresState`
   is a test seam). Consequences: flora refuses to grow trees on cells of
   buildings that are no longer in the world ("buildings always win", DESIGN
   2026-08-19); pilgrims' settlers walk to, and "found", houses in a board no
   one ticks or persists — `foundStructure` writes `live` and pushes
   `pendingFounded` (`index.ts:731-737`).
4. **Ghost foundings surface on re-enable (verified from source).**
   `pendingFounded` is reset only when drained by `simulate` (`index.ts:456`)
   and by the test seam (`:844`), NOT in `onWorldCreate`. When structures is
   re-enabled, `onWorldCreate` rebuilds `live` from the dormant slice (dropping
   the ghost cells) but the first tick broadcasts the stale `pendingFounded`
   list as `structures:changes {founded}` — clients draw houses the server
   board does not hold, until the 60 s keepalive `structures:all` replaces
   them. Small, but it is the concrete proof that "disabled" is not "gone".

Root cause (one sentence): a disabled plugin is removed from the HOST's fan-out
but not from its SIBLINGS' reach, because bridges bind to module identity
(§1.1); the fix is the host-mediated sibling lookup (Phase 2), which must
answer `null` for a plugin not enabled in the current session, plus the
`onWorldClose` reset each plugin owes (#167) as the belt-and-suspenders half.

---

## 2. Goal (a): swapping one life algorithm for another at runtime

### 2.1 Framing

The question "is it unload A, load B?" is answered by §1.8: no. Both models
are already resident and inert-until-selected; the board, wire and slice are
model-agnostic; the only per-model state is a few module-scope clocks. What is
missing is (i) a per-WORLD selector instead of a per-PROCESS env, (ii) a
reset of the model-side clocks on swap, and (iii) siblings that stop reading a
plugin the session is not running.

### 2.2 Options

**S1 — swap = enablement.** Drop the env gate; "populous enabled in this
world" means populous drives the board (structures runs the registered model
when one is present, else the CA). Populous implements `onWorldClose` →
`setGrowthModel(null)` so a later disable actually clears the slot.
- Buys: zero new protocol/UI; the toggle panel already exists.
- Rejected-because: (1) selection-by-registration is racy — the bridge import
  resolves asynchronously after `onWorldCreate`, so the CA would run until
  populous lands (in practice sub-second, in principle non-deterministic, and
  determinism is a hard rule); (2) it cannot express #28's Maze/Coral/HighLife
  variants, which live inside `life.ts` — a second selector would then be
  needed anyway; (3) it couples "installed and running" to "chosen rule",
  which the owner brief for populous deliberately separated
  (`populous/server/index.ts:24-32`).

**S2 — per-world plugin settings (RECOMMENDED).** A generic world-file table
`plugin_settings (plugin, key, value)` next to `disabled_plugins`
(`snapshot-store.ts:355`), surfaced to plugins as `WorldApi.setting(key):
string | undefined` (world-scoped, read in `onWorldCreate`), and to the
operator as an additive admin pair `worldPluginConfigure {id, plugin, key,
value}` (key-gated like `worldPluginSet`) plus `settings` on
`worldPluginListing`. structures declares `model` with values
`life | populous | <future life variants>`; `selectedModel` becomes
session-scoped (set in `onWorldCreate` from the setting, default `life`;
env `STRUCTURES_MODEL` remains as the boot-time DEFAULT for worlds with no
row, so nothing existing changes behaviour). populous drops its env gate and
registers whenever it is enabled; structures consults the slot only when its
setting says `populous`. Changing the setting on the live world → `reopen()`
(already carries players). structures' `onWorldCreate` performs the
**session-scoped subset of `resetStructuresState`** (`index.ts:830-846`),
enumerated: `survey`, `scanCredit`, `lastGrowthSeconds`,
`warnedNoGrowthModel`, `pendingFounded`, **`simSeconds`** and
**`lastKeepaliveSeconds`** (closes §1.9 finding 4 as a side effect). The two
clock terms are load-bearing and were missing from the earlier list:
`advanceGrowthModel` gates on `simSeconds - lastGrowthSeconds <
CA_GENERATION_INTERVAL_SECONDS` (`index.ts:389`), so zeroing
`lastGrowthSeconds` while `simSeconds` still carries the whole process uptime
makes the first tick after any reopen step a generation IMMEDIATELY — a
cadence discontinuity that does not exist today (today neither term is reset,
so the delta, and therefore the cadence, survives a reopen intact). Reset the
clock pair together, or — if the accumulator is meant to survive a reopen —
set `lastGrowthSeconds = simSeconds` instead of 0. Not in the subset: `live`,
`generation`, `rngState`, `restoredLive`, `restoredGeneration` (all rewritten
by `persistence.load` before `onWorldCreate` runs) and `rng`.
`lastKeepaliveSeconds` is separately re-set by the `broadcastAll(world)` at
the end of `onWorldCreate` (`index.ts:658` → `:224`); resetting it explicitly
costs nothing and makes the subset self-evident rather than dependent on that
call order. The gate this fixes is reached only on the registered-model path
(`index.ts:464-465`), i.e. exactly the path S2 exists to enable per world.
- Buys (a) fully, per world, persisted, no restart, and one knob for every
  rule in #28/#153/#74/#178/#183.
- Cost: estimate 2–3 days (store DDL + migration, `WorldApi.setting`,
  protocol pair + validation, panel control, structures/populous changes,
  contract test that a setting survives reopen and rollback).
- Determinism: the setting is read once per session at `onWorldCreate`, same
  as the env is read once per process today; a reopen is the only way it
  changes, and a reopen already replays restore + worldCreate. The env
  fallback cannot itself change a world's rule across reopens — `process.env`
  is fixed for the life of the process, so flipping the fallback still
  requires an operator edit AND a restart, exactly as today. Cadence
  continuity across that reopen is what the clock-pair reset above protects.
- Safety: DEPENDS ON PHASE 2 (host-mediated bridges answering `null` for
  not-enabled siblings). Without it, disabling populous mid-world is fine (the
  slot is cleared by structures' own `onWorldCreate` re-reading the setting),
  but disabling STRUCTURES still leaves the ghost board of §1.9. S2 can ship
  before Phase 2 if the operator never disables structures — flag, do not
  rely on it.
- Slice: unchanged (v2). Optionally stamp `model` into the slice for
  diagnostics — not needed for correctness, since both rules read any board.

**S3 — a second plugin per rule, swap by unload/reload (Option B of §6).**
- Rejected-because: it is the wrong unit — the rules share one board, one
  wire and one client half; a rule-as-plugin would have to duplicate or
  bridge all of them (populous' own header explains why it did not), and it
  inherits every prerequisite of Option B for no gain.

### 2.3 Recommendation and phased plan for (a)

S2. Phase order and dependencies:

- **Phase S0 (no dependency, 0.5 day) — close §1.9 findings 3–4 narrowly:**
  structures' `onWorldCreate` performs the session-scoped subset of
  `resetStructuresState` — `survey`, `scanCredit`, `lastGrowthSeconds`,
  `warnedNoGrowthModel`, `pendingFounded`, `simSeconds`,
  `lastKeepaliveSeconds` — the clock pair reset TOGETHER (see §2.2 S2: zeroing
  `lastGrowthSeconds` alone fires a growth generation on the first tick after
  every reopen);
  structures, flora, pilgrims, temples, populous implement `onWorldClose`
  that clears their module state and bridge buffers (#167). Verify: contract
  test — disable structures, reopen, `standingStructures()` via the flora
  bridge returns `[]`.
- **Phase 2 (existing, §7) — host-mediated sibling lookup**, with the added
  guarantee: a sibling not enabled in the current session resolves to `null`.
  This is what makes S2 safe when structures itself is toggled.
- **Phase S (S2 proper, 2–3 days, after S0; safe after Phase 2):**
  1. `plugin_settings` DDL + `SnapshotStore.pluginSetting/setPluginSetting`
     (issue-sized; store test).
  2. `WorldApi.setting(key)`; `PluginHost` hands each entry its own plugin's
     rows (issue-sized).
  3. Protocol: `worldPluginConfigure` request, `settings` on
     `worldPluginListing`, validation in `parseWorldAdminRequest`
     (issue-sized; additive).
  4. structures: session-scoped `selectedModel` from the setting; populous:
     register when enabled, unregister on close (issue-sized).
  5. Client panel: a select next to the structures toggle (issue-sized). The
     panel renders whatever settings the listing declares, generically — it
     must not name any plugin's vocabulary; `life | populous | <variants>` is
     structures' declaration, not a core-side list. `worldPluginConfigure` is
     validated against the declaring plugin's declared keys and values and
     refused like an unknown plugin name (see step 3).
  6. Verify on the rig: set `populous` on a live CA world → reopen → next
     generation is a populous step (log `POPULOUS_ACTIVE_MESSAGE`, houses
     gain `population`); set back to `life` → CA resumes; rollback to a
     restore point keeps the setting (it is a world-file row, not a snapshot
     slice — decide in §8 whether that is wanted).

Depends on: Phase S0 (must), Phase 2 (must for toggling structures itself),
nothing from Phase 1/3/4.

---

## 3. Goal (b): module updates — a new version of one plugin's code

### 3.1 Procedure under Option A (restart with carry-over) — RECOMMENDED

1. Operator edits/pulls the plugin (server and/or client half), runs
   `pnpm typecheck` (and the plugin's tests if any).
2. If the client half changed: `pnpm --dir client build` (served by the same
   process, DESIGN §3.6 / #20) — or in dev, Vite HMR has already swapped the
   module (with the caveat in §1.4: `attach` re-runs without `dispose`).
3. Operator presses **Restart** (admin-gated `serverRestart`, Phase 1 step 1).
   Server: notice to connected players (reuse the switch-countdown shape,
   `world-manager.ts:488-557`) → `await gameServer.gracefullyShutdown(false)`
   (final snapshot written by the existing `onBeforeShutdown`,
   `server/src/index.ts:207-220`) → `process.exit(TERRACE_RESTART_EXIT_CODE)`.
   The `false` matters: with the default `exit = true`,
   `gracefullyShutdown` itself calls `process.exit(err && !isDevMode ? 1 : 0)`
   and never returns, so "exit with a named code" is unreachable
   (`server/node_modules/@colyseus/core/build/Server.mjs:172-189`, verified).
4. Supervisor restarts the process (Phase 1 step 2). Boot re-discovers
   `plugins/`, imports the NEW code, opens the active world, restores every
   slice through the new code's `persistence.load`.
5. Clients reconnect silently (existing backoff); the join snapshot carries a
   **build identity that changes when the CODE changes** — NOT `serverVersion`
   — and the client reloads the page ONCE if it differs from the one it joined
   under (Phase 1 step 3) — that is how the new client bundle arrives. Tokens
   restore territory. `serverVersion` is derived from git HEAD
   (`server/src/version.ts:29-32`) and is the constant `'unversioned'` in
   docker (`:48-52`; no `.git` in the image, no `TERRACE_VERSION` in
   `docker-compose.yml`), so it cannot see an uncommitted edit and is dead in
   production — see Phase 1 step 3 for what replaces it.
6. Operator verifies via the per-plugin version stamp (§3.6) in the plugin
   panel.

Rollback: if the new code throws at import, `worldCreate`, `persistence.load`
or the first tick, the process exits non-zero and the supervisor's restart
loop makes it visible; the world file is untouched (final snapshot from the
old code is the latest row). Operator checks out the previous code and
restarts. Nothing half-loaded is possible (openInto guarantee 4).
Estimate (re-derived): Phase 1 as re-sized (2–3 days, §7) + §3.3 contract
(2–3 days) + §3.6 stamp (0.5 day).

### 3.2 Procedure under Option B (in-process single-plugin reload)

Prerequisites: Phases 2 and 3 (§7). Then:

1. Same edit/typecheck/build steps as A.1–A.2.
2. Operator presses **Reload** on one plugin (admin `worldPluginReload
   {plugin}`). Server: import `plugins/<name>/server/**` under a new
   generation tag (loader hook, §1.2) → new `LoadedPlugin` → replace in the
   installed set → `reopen()`. The host's sibling lookup (Phase 2) now hands
   every bridge the NEW instance on their next `onWorldCreate`; the room's
   wildcard routing (Phase 3) delivers any added message types.
3. Rollback: on import error, `onWorldCreate` throw, `persistence.load`
   throw/refusal, or a throw in the first `onTick` (run one tick inside the
   reload before returning to the operator), keep the OLD `LoadedPlugin`
   and reopen with it; the old module's state is replayed from the slice so
   it is consistent. Report the failure in `worldAdminResult`.
4. Client half: unchanged from A — a changed client half is a new build and
   needs the page reload; no process restart happens at all here, so the
   reload must key on a per-plugin stamp change (§3.6). Option A needs the
   same thing for a different reason (the git stamp cannot see an uncommitted
   edit and is `'unversioned'` in docker, §3.1 step 5), so the stamp is a
   shared prerequisite of both options, not a B-only extra.
5. Leak: the old subtree stays in the module map (§1.2, ≤~0.9 MB per reload
   of the largest plugin, estimate).

Honest summary: B saves the reconnect gap (estimate 2–5 s, unmeasured) and
the other 15 plugins' re-import, at the price of Phases 2–4 (estimate 6–9
days total) and a server-only benefit. Not recommended until Phases 2–3 exist
for their own reasons (npm-plugin readiness DESIGN §3.5; swap safety §2).

### 3.3 Slice-compatibility contract across versions (needed by A and B)

Today (§1.5): 9 of 16 plugins have a slice; 6 of those version it, 3 do not,
and unknown-version handling is per-plugin and inconsistent (drop / ignore /
migrate / read-anyway). Nothing on disk carries a host-level envelope.
Proposed contract, at the `PersistenceSlice` type (`types.ts`), not per
callsite:

- `PersistenceSlice.version: number` (required, integer ≥1); the host wraps
  every save as `{ v, data }` — or, less invasively, requires the plugin's
  own `save()` output to carry `version` and validates it at
  `collectPersistence`. Recommend the host envelope: the 3 plugins that have
  no version today (boats, fire, temples) get one without touching their
  format. The 6 that already carry a version INSIDE `data` keep it there —
  the host envelope's `v` is the authority and the in-`data` field becomes
  redundant-but-harmless, to be dropped when each plugin is ported. State that
  explicitly so nobody double-versions a slice.
- **Legacy read path (required — it is 100 % of the data on disk).** A stored
  slice value that is not an envelope (no `v`) is read as **version 1** and
  handed to `load(data, 1)`; the host re-writes it in envelope form on the
  next save. Without this rule the naive implementation unwraps `{v, data}`
  from a raw value, gets `v === undefined` and `data === undefined`, and
  `host.ts:493`'s `Object.hasOwn` check still passes — so `load(undefined,
  undefined)` runs and every plugin silently comes up EMPTY on the first boot
  after the change. That would breach MVP criterion 6 (`docs/DESIGN.md:372`,
  "restart; the world comes back from SQLite intact") and DESIGN's "nothing
  deletes a world implicitly" (`docs/DESIGN.md:123-127`).
  `restore_points` rows are read through the SAME legacy rule rather than
  being rewritten — a rollback reads old `plugin_slices` rows
  (`server/src/persistence/snapshot-store.ts:382, 464, 479`) forever, so the
  rule has to be permanent, not a one-boot migration.
- `PersistenceSlice.load(data, fromVersion)` — the host passes the stored
  version; the plugin migrates or returns `'refuse'`. The reference pattern is
  **`monsters`** (`plugins/monsters/server/persistence.ts:225-256`): a
  multi-version chain (v3 current, v2 accepted with per-field rewriting by
  `migrateV2Cooldowns`, v1 through `migrateLegacySlice`), not chronicle's
  single legacy branch. The signature must accommodate N accepted versions,
  not two.
- **Downgrade** (stored version > code version): the host does NOT call
  `load`; it parks the slice and logs once. Under Option A the world runs with
  that plugin's state absent but preserved; under Option B the reload is
  refused and the old module reopened. This replaces the current behaviour of
  demolishing the town (`structures`) AND erasing the forest (`flora`) on a
  forward slice — see §1.5's downgrade table; four more plugins erase their
  own state the same way.
- **Parking needs a host mechanism that does not exist yet — this is a
  `host.ts` change, not a per-plugin one.** `dormantSlices` does NOT have
  these semantics for an ENABLED plugin: `restorePersistence` populates it
  only past `if (enabled.has(name)) continue;` (`host.ts:480`), so a
  downgraded-but-running plugin's bytes never enter the map; and
  `collectPersistence` seeds the record with `{ ...this.dormantSlices }`
  (`host.ts:450`) and then does `slices[plugin.name] = data` for every enabled
  plugin (`host.ts:458`), so the enabled plugin's (empty) save overwrites the
  parked bytes at the very next snapshot — `DEFAULT_SNAPSHOT_INTERVAL_S = 60`
  (`server/src/config.ts:87`), i.e. the town is destroyed about a minute
  later, which is the exact failure this rule exists to replace. Required
  addition: a per-name **write-suppress set** consulted at `host.ts:451-459`,
  so a parked plugin contributes nothing to `collectPersistence` and the
  parked bytes are re-emitted verbatim for the life of the session. The
  one-line contract: **a slice key has exactly one writer per session, and
  parking makes the host that writer.** (The alternative — refuse to enable
  the plugin for that world — is simpler but changes the operator-visible
  enabled set behind their back; not recommended, flagged so the owner can
  choose.)
- `pnpm typecheck` enforces the new required field; contract-level tests:
  (i) save under v N, load under v N+1 with a migration; (ii) load under
  v N−1 → slice parked, and re-emitted byte-identical **across at least two
  snapshots** (one snapshot passes even with the bug above); (iii) a
  pre-envelope snapshot fixture loads and every plugin restores its state.
- Estimate **2–3 days** (re-derived; the old 1–1.5 days assumed 3 plugins to
  port and no host-side work). Scope: host envelope + legacy read path,
  write-suppress set in `PluginHost`, `load(data, fromVersion)` signature,
  porting 6 versioned plugins onto the envelope, giving 3 unversioned plugins
  a version they never had, and the three contract tests. Issue-sized on its
  own; both A and B depend on it.

### 3.4 The bridge / module-identity problem for a plugin others import

- Option A: none — the whole process restarts; every bridge re-imports.
- Option B: fatal without Phase 2 (§1.1 split-brain). With Phase 2, the host
  is the only holder of module identity; bridges ask the host per session and
  are handed the current instance. Rule 3 (buffer-don't-drop) still needed
  for load-order gaps within one session.

### 3.5 Rollback summary

| failure point | Option A | Option B |
|---|---|---|
| import throws | boot fails, supervisor loop visible, world untouched | keep old `LoadedPlugin`, reopen, report |
| `worldCreate` throws | same (openInto guarantee 4: nothing loaded) | same as above |
| `persistence.load` throws/refuses | logged by `safely`, plugin runs with empty state — **today**; with §3.3 the slice is parked AND the plugin is write-suppressed for the session | reload refused, old module reopened |
| first tick throws | `safely` logs, plugin keeps ticking broken — **today** | probe tick inside the reload; failure → rollback |
| client half broken | page reload shows it; fix and rebuild; server untouched | same |

### 3.6 How the operator verifies which version is running

There is no per-plugin version anywhere (§1.4). Proposal, additive: discovery
reads `plugins/<name>/package.json` `version` (all are `0.1.0` today — the
stamp is only useful once plugins bump it, or better, derive
`<version>+<git short hash of plugins/<name>>` at discovery the same way
`SERVER_VERSION` is derived) into `LoadedPlugin.version`; `worldPluginListing`
gains `versions: Record<string, string>`; the panel shows it next to the
toggle; the server logs `plugin "<name>" v<stamp>` at discovery. Both options'
clients compare stamps across reopens to decide on a page reload (Option A
because the git-derived `serverVersion` cannot see an uncommitted edit and is
`'unversioned'` in docker, §3.1 step 5; Option B because no restart happens at
all). The derived form must include a working-tree-dirty marker, or an
uncommitted edit produces the same stamp as the commit before it.
Estimate 0.5 day. Depends on nothing, but Phase 1 step 3 depends on IT.

### 3.7 Recommendation for (b)

Option A procedure (§3.1) + §3.3 slice contract + §3.6 stamp. Total estimate
**4.5–6.5 days** (re-derived: Phase 1 2–3 + §3.3 2–3 + §3.6 0.5; the old
3–4.5 assumed a 1–1.5-day slice contract over 3 plugins and a one-line
supervisor change). Depends on Phase 1 (existing). Option B stays behind Phases 2–3
and is picked up only if the owner still wants it after the swap work (§2)
has made Phase 2 exist.

---

## 4. Finding: plugin memory is not material (demoted from goal)

Rig: `~/.terrace-plugtest` (isolated, port 2601, its own worlds dir). Scripts
left in `~/.terrace-plugtest/heap/` (`measure.mjs`, `world-one.mjs`,
`drive.sh`, `cachebust.mjs`, `result.json`); nothing written into the repo.
World: a copy of the rig's 256² world, no players connected, 600 host ticks
(60 s of sim at 10 Hz). Heap read via `process.memoryUsage().heapUsed` after
two forced GCs. Noise floor ≈ ±0.02 MB (the daynight/populous/reveal rows).

**A. Module cost** (heap delta per server-entry import, discovery order,
core already loaded at 10.44 MB):

| plugin | MB | plugin | MB |
|---|---|---|---|
| structures | 0.55 | relics | 0.20 |
| wildlife | 0.50 | mana | 0.18 |
| flora | 0.47 | weather | 0.17 |
| monsters | 0.42 | chronicle | 0.15 |
| fire | 0.37 | temples | 0.14 |
| pilgrims | 0.34 | populous | 0.09 |
| boats | 0.28 | daynight | 0.05 |
| | | invite, reveal | 0.02 each |

All 16 modules: **3.94 MB**.

**B. Per-world state** (one fresh process per configuration — an in-process
A/B is INVALID because module-scope state survives `closeSession`, which the
first attempt demonstrated: every "disable one plugin" run inherited the
previous run's state — the same fact as §1.9 finding 3). All-enabled: open
0.24 MB, live after 600 ticks **1.56 MB**, **retained after `closeSession`
1.54 MB (99 %)**. Per plugin (all-enabled minus that plugin disabled), live /
retained-after-close:

| plugin | live MB | retained MB |
|---|---|---|
| wildlife | 0.35 | 0.33 |
| monsters | 0.28 | 0.29 |
| flora | 0.18 | 0.19 |
| structures | 0.15 | 0.12 |
| pilgrims | 0.12 | 0.10 |
| boats | 0.06 | 0.09 |
| weather | 0.05 | 0.06 |
| relics | 0.04 | 0.05 |
| others | ≤0.03 | ≤0.05 |

**C. Whole-process reality check**, rig booted on 2601 for 20 s after
"listening": all 16 plugins **VmRSS 142.2 MB**; `PLUGINS_DIR` pointing at an
empty dir **125.99 MB**. Difference 16 MB = code + per-world state + V8
compile artefacts and slack that the heap numbers above do not count.

**Conclusion:** the most a perfect unload of ALL plugins could return is
~16 MB of a 142 MB process (~11 %), and one plugin at most ~1 MB heap. The
measured world is idle; a world with players, fires and full entity caps is
larger (estimate, unverified: an order of magnitude on the state rows — still
under 20 MB). Memory is not a reason to build unloading. The 1.54 MB retained
after close is a consequence of module-scope state, and the fix for that is
issue #78's factory contract, not unloading. Record in DESIGN.md and close.

---

## 5. Root-cause framing (one sentence each)

- (a) is blocked because the model selector is a process-wide env read at
  import, and toggling plugins cannot stand in for it because a disabled
  plugin's module stays reachable to its siblings through module-identity
  bridges. Contract change: per-world plugin settings + host-mediated sibling
  lookup that answers `null` for a plugin not running in this session.
- (b) is blocked because the unit of code identity is the Node module map,
  which has no eviction, and because the bridge contract binds plugins to each
  other by module identity rather than through the host. Contract change: a
  restart that is one button with carry-over, plus a host-owned slice version
  envelope so a new version can refuse, migrate, or park a slice.
- Memory is not a problem to solve: measured plugin memory is ~1 % of RSS per
  plugin, and the part that outlives a world (1.54 MB total) is module-scope
  state — issue #78's factory contract, not unloading, is its fix.

---

## 6. Options for code reload (reference; §3 applies them)

Costs are estimates (labelled). "Buys" is what the option delivers for goal
(b) / memory.

### Option A — reload-by-restart: graceful process restart with player carry-over

Mechanism: an admin-gated `serverRestart` request (same key/lockout as world
admin) → broadcast a notice (reuse the switch countdown shape,
`world-manager.ts:488-557`) → `await gameServer.gracefullyShutdown(false)` →
`process.exit(TERRACE_RESTART_EXIT_CODE)` → the supervisor (run_server.py /
docker restart policy / systemd) brings the process back → clients' existing silent reconnect
re-joins, active pointer reloads the same world, tokens restore territory.

- Buys (b): fully, for server AND client halves (the client reload is a page
  reload or the reconnect's fresh join; a new client build is served by the
  same process, §3.6 issue #20). Memory: fully (fresh process).
- Cost: estimate **2–3 days** (re-derived from the feasibility findings; the
  old 1–2 assumed the exit code fell out of `gracefullyShutdown()`, that
  run_server.py only had to reclassify a code, and that `serverVersion` could
  drive the reload). Server: one admin action + the exit-code sequence and its
  named constant; client: notice banner + one-shot page reload on a build
  identity that actually changes with the code (§3.6 stamp / per-boot nonce —
  NOT the `serverVersion` watermark at `protocol.ts:300-313`, which is a git
  stamp). Supervisor: docker and systemd already restart; run_server.py needs
  a NEW restart branch plus a loop guard (§7 Phase 1 step 2).
- Determinism / security risk: none new — it is the boot path. The only
  visible cost is the reconnect gap (estimate: 2–5 s on the rig; unmeasured)
  and in-flight strokes during the gap being dropped (the client already
  handles an offline sea).
- In-flight state: the final snapshot is written before exit; anything since
  the last tick's snapshot-dirty write is included (`snapshotIfDirty`).
  Nothing is lost that a Ctrl-C would not also lose, i.e. nothing.
- Failure mode: new code fails to boot → the process exits with an error and
  the supervisor's restart loop makes it visible; the world file is untouched.
  Rollback = check out the previous code and restart. No half-loaded state is
  possible (guarantee 4).
- Rejected-because: not rejected. This is the recommendation for the
  operator path. Its honest limitation: it is not "without restarting the
  server" in the literal sense — it is a restart made cheap.

### Option B — in-process single-plugin reload (cache-bust re-import, accept the leak)

Mechanism: admin `worldPluginReload {plugin}` → re-import
`plugins/<name>/server/**` under a new generation (loader hook so the SUBTREE
re-resolves, §1.2) → build a new `LoadedPlugin` → replace it in the
process-wide list → `WorldManager.reopen()` (which already does the whole
close/open/carry-over dance). On import or `onWorldCreate` failure keep the
old `LoadedPlugin` and reopen with it (the old module's state is replayed from
the slice, so it is consistent).

Prerequisites — the two contract fixes, without which this is unsafe:

1. **Bridges resolve through the host, not through `import()`.** Add a
   host-mediated sibling lookup (`WorldApi.sibling<T>(name): T | null`, or a
   host registry of per-plugin exported APIs declared on `TerracePlugin`), and
   port the 16 bridge files (rule 3 "buffer, don't drop" survives unchanged;
   rule 1/2/4 collapse into the host lookup). This is ALSO what npm-package
   plugins need (DESIGN §3.5 "design the loader so both coexist" — a bridge
   that hard-codes `../../fire/server/index.ts` cannot resolve a package), and
   what goal (a) needs (§1.9), so the change pays for itself independently.
2. **Plugin message routing is not fixed at boot.** Replace the boot-time
   `pluginMessageTypes` registration (`terrace-room.ts:288-295`) with a
   wildcard handler that routes any `<plugin>:<type>` through the current
   host's `handlerFor` — or re-register on reload if Colyseus permits (verify
   `onMessage('*')` in 0.17.50 first).

- Buys (b): server half of ONE plugin without a restart; the client half still
  needs a build + page reload (§1.4) — so for a plugin with both halves the
  operator restarts the client anyway. Memory: NEGATIVE — each reload leaks
  the old subtree (estimate ≤0.9 MB per reload of the largest plugin, §1.2/§4;
  100 reloads of wildlife ≈ 90 MB, dev-session scale, never prod scale).
- Cost: estimate 4–6 days. Loader hook with generation tags (must be
  registered before any plugin import; `module.register` runs hooks off-thread),
  bridge contract + 16 ports + their tests, room wildcard routing, admin
  request/result + panel button, rollback-to-old path, and the `WorldManager`
  change from a fixed `deps.plugins` to a mutable installed set.
- Determinism risk: load ORDER stays alphabetical by directory and the
  reopen replays restore + worldCreate, so a reloaded plugin runs in the same
  slot with the same inputs. Risk is in the OLD module: its module-scope state
  is abandoned mid-life but still reachable via the module map; anything that
  still holds its namespace (a bridge not yet ported, a test) would tick a
  ghost. Prerequisite 1 is what removes that class.
- Security: admin-key gated like every other world admin action; the loader
  hook only rewrites URLs under the configured `pluginsDir`, never arbitrary
  specifiers.
- Slice compatibility: §3.3. Recommend the reload refuses when the plugin's
  `persistence.load` throws or refuses on the current slice and reopens with
  the old module.
- Rejected-because: not rejected outright — deferred behind Option A.
  Reasons: it delivers half of (b) (server half only) for a leak and a large
  surface; and the two prerequisites are worth doing on their own merits
  first, after which this option shrinks to ~2 days. Revisit if the owner's
  dev loop is dominated by server-plugin edits on a world that is expensive
  to re-enter.

### Option C — worker / process isolation per plugin

Mechanism: each plugin runs in its own `worker_threads` Worker (or child
process); the host proxies `WorldApi`; unload = `terminate()`.

- Buys (b): fully for the server half, with a true unload. Memory: fully
  for the server half — the only option that actually frees module code.
- Cost: estimate 3–5 weeks. Every hook becomes asynchronous: `runIntent`'s
  synchronous verdict chain (`host.ts:232-252`) becomes N round trips per
  stroke; `onTick` needs a per-tick barrier across 16 workers; `WorldApi`
  becomes an RPC surface (23 members, `world-api.ts:122-252`); the heightmap
  either crosses as a `SharedArrayBuffer` (then two writers — the tick and
  the plugin — race, breaking single-writer) or every read is a message (then
  `heightAt` in a movers loop is unusable). `openInto`'s synchronous swap
  guarantee dies. All 16 plugins are rewritten against the async API.
- Determinism risk: highest. "Identical inputs give identical outputs" (hard
  rule) now depends on barrier ordering that the host must reconstruct; a
  slow plugin either stalls the tick (reintroducing the failure `safely` was
  built to contain) or gets skipped (non-deterministic across machines).
- Security: real fault isolation (a plugin crash cannot take the process) —
  the one genuine benefit, and DESIGN §3.2 already chose process-per-world
  for crash isolation, not worker-per-plugin.
- Rejected-because: it trades the platform's core contracts (synchronous
  interceptor chain, single-writer World, synchronous swap) for a memory win
  measured at ≤1 MB per plugin. Not worth it at any measured scale.

### Option D — factory contract (#78) + enablement: unload STATE, keep code

Mechanism: `createPlugin(): TerracePlugin` per module; state lives in the
closure; a disabled or closed plugin's instance is dropped with the session.

- Buys (b): nothing. Memory: the 1.54 MB that currently outlives a close
  (§4 B) — and, structurally, it is the prerequisite for two live worlds
  (#78), which is the actual owner-visible reason to do it. It would ALSO
  close §1.9 finding 3 structurally (a disabled plugin has no instance for a
  bridge to reach) — but only once bridges go through the host (Phase 2);
  until then a bridge imports the module, not the instance.
- Cost: issue #78's own estimate — port 16 plugins and tests (estimate 3–5
  days). Already scheduled by decision (2026-08-21, "revisit simultaneity
  later").
- Rejected-because: not an answer to (a) or (b) on its own; listed so the
  memory conversation lands on the right issue. Do it when #78 is picked up.

### Option E — do nothing beyond enablement; document why

- Buys: nothing new. Cost: this document.
- Rejected-because: (a) is broken today in four verified ways (§1.9) for the
  one swap the owner wants, and the dev-loop pain behind (b) is real and
  Option A is cheap.

---

## 7. Consolidated phased plan (each step issue-sized and verifiable)

Dependencies: S0 → S; 2 → S (safe when structures itself is toggled);
1 + 3.3 + 3.6 → (b) via Option A; 2 + 3 → 4 (Option B).

Ordering changes forced by the review (§1.5, §3.3, Phase 1 findings):

- **Within Phase 1, step 6 (per-plugin stamp) now precedes step 3 (client
  reload)**: the reload trigger cannot key on `serverVersion`, so step 3
  consumes the stamp step 6 produces. §3.6 is therefore no longer "depends on
  nothing, do it last" — it is a prerequisite of the Option A client path.
- **Step 2 depends on step 1 being verified end to end**, including that the
  named exit code survives `pnpm start`; step 2's branch keys on it.
- **Step 5 is now partly a `host.ts` change, not only a `types.ts` one** (the
  write-suppress set), so it is no longer a purely additive per-plugin port
  and its estimate moved from 1–1.5 to 2–3 days.

**Phase S0 — stop the ghost board (goal a, 0.5 day, no dependency)**

0. structures' `onWorldCreate` performs the session-scoped subset of
   `resetStructuresState` (`plugins/structures/server/index.ts:830-846`):
   `survey`, `scanCredit`, `lastGrowthSeconds`, `warnedNoGrowthModel`,
   `pendingFounded`, `simSeconds`, `lastKeepaliveSeconds` — the clock pair
   reset TOGETHER, or `lastGrowthSeconds = simSeconds` if the accumulator is
   meant to survive (§2.2 S2); structures,
   flora, pilgrims, temples, populous implement `onWorldClose` clearing module
   state and bridge buffers (#167). Verify: contract test in host — disable
   structures, reopen, flora's bridge sees `[]`; re-enable → no phantom
   `founded` on the first tick; and a reopen under a registered growth model
   does NOT step a generation on its first tick.

**Phase 1 — restart is one button (Option A; goal b, 2–3 days re-derived)**

1. `serverRestart` admin action: protocol pair (additive, key-gated, same
   lockout as `WorldAdminService`), handler runs the existing switch-countdown
   notice when others are connected, then the exit sequence — **in this
   order**: `await gameServer.gracefullyShutdown(false)` (so
   `onBeforeShutdown` still stops the tick loop and writes the final snapshot,
   `server/src/index.ts:207-220`), then
   `process.exit(TERRACE_RESTART_EXIT_CODE)`. Passing `false` is mandatory:
   `gracefullyShutdown(exit = true, err)` ends in
   `process.exit(err && !isDevMode ? 1 : 0)` and never returns
   (`@colyseus/core/build/Server.mjs:172-189`), so the default call can only
   ever exit 0 or 1. `TERRACE_RESTART_EXIT_CODE` is a NAMED constant in
   `server/src` (not a literal at the callsite); it must be in 1–255 and must
   not collide with 0 (clean exit) or 1 (`index.ts:246`, boot failure).
   Proposed value **75** — `EX_TEMPFAIL` from `sysexits.h`, "temporary
   failure, the caller should retry", which is exactly what a restart request
   is; it also avoids 2 (shell misuse) and the 128+N signal range (130 SIGINT,
   143 SIGTERM) that a reaped process produces.
   Verify: on the rig, press restart → log shows "shutdown snapshot written" →
   process exits with 75, **and** that code is observed by the supervisor
   through `pnpm start` (`server/package.json:11` `node src/index.ts`, spawned
   by `run_server.py:296`). Assumption, unverified this session: pnpm
   propagates the child's exit code unchanged — confirm this on the rig BEFORE
   step 2 is written, since every branch there keys on it.
2. Supervisor contract. docker (`restart: unless-stopped`) and systemd
   (`Restart=always`, README note) already restart on any exit — for them this
   IS just classification. **run_server.py is not**: it has no restart-on-exit
   path for ANY code. `server.wait()` returning at all means "the server
   exited on its own (crash, pnpm failure)" and the script returns that code
   (`run_server.py:540-543`), after which the `finally` reaps Vite too
   (`:595-601`) and the whole stack goes down. So step 2 is a NEW branch, not
   a reclassification: on `TERRACE_RESTART_EXIT_CODE`, log the restart,
   re-take `watch_snapshot()` BEFORE relaunching (same reason the `--watch`
   path re-snapshots after the shutdown rather than before, `:562-566`),
   `spawn_server(env)`, keep the new handle in `children`, and leave Vite
   running. Every other code keeps today's return-and-tear-down.
   Add a **loop guard** — at most `TERRACE_RESTART_MAX_BURST` restarts within
   `TERRACE_RESTART_BURST_WINDOW_S` (suggest 3 within 60 s: three consecutive
   sub-20-second lifetimes is not a dev loop, it is a plugin throwing at
   import), then give up and return the code — otherwise a plugin that fails
   at import spins forever. The plan's rollback story (§3.1, §6 Option A,
   "the supervisor's restart loop makes it visible") presumes a loop that does
   not exist today and would spin without this guard.
   Note the overlap: the operator-at-the-terminal case is already covered by
   run_server.py's `r` key (`:305, :334, :569-584`), which SIGINT-reaps and
   relaunches the whole stack. The in-game button is still wanted because it
   is reachable from the client by an admin who is not at the terminal, it
   gives connected players the countdown notice first, and it works in docker
   and systemd where there is no terminal at all.
   Verify: rig restarts itself and keeps the same Vite; a genuine crash code
   still surfaces as a crash; a plugin that throws at import stops after the
   burst limit instead of spinning.
3. Client one-shot page reload. It must key on something that changes when the
   CODE changes. `serverVersion` does not: it is `<commit count>.<short hash>`
   from git HEAD (`server/src/version.ts:29-32`), so an uncommitted plugin or
   client edit leaves it byte-identical across the restart, and with no `.git`
   and no `TERRACE_VERSION` it is the constant `'unversioned'`
   (`:48-52`) — which is the docker case, where the repo-wide grep finds
   `TERRACE_VERSION` in no compose file, Dockerfile or `run_server.py` CONFIG.
   Use instead either (a) the per-plugin stamp of §3.6 —
   `<version>+<git short hash of plugins/<name>>` plus a working-tree-dirty
   marker so an uncommitted edit is visible — or (b) a per-boot nonce on the
   join snapshot, reloading when the nonce changed AND the client's asset
   manifest hash differs (the nonce alone would reload on every restart,
   including ones that changed nothing). **Docker:** `TERRACE_VERSION` must be
   injected at image build (a build arg written into the image env) or the
   trigger is dead in production; note also that in docker the client is a
   separate nginx image with `VITE_SERVER_URL` baked in, so a new client
   bundle only exists after a client image rebuild — a server-side stamp
   cannot observe that at all, and that case is an image redeploy, not a
   reload.
   Verify with a case that can actually distinguish the two builds: edit a
   client half, rebuild, restart → the identity differs → the page comes back
   on the new build without a manual refresh; restart with NO edit → identity
   equal → no reload.
4. Measure the gap on the rig (press-to-playable, one client) and record it in
   DESIGN.md. Estimate before measuring: 2–5 s.
5. Slice version envelope (§3.3) on `PersistenceSlice`: envelope + legacy
   read path (a value with no `v` is version 1) + `load(data, fromVersion)` +
   downgrade → parked, with the host **write-suppress set** that makes the
   host the single writer of a parked slice key (a `host.ts` change —
   `dormantSlices` alone does not do this, `host.ts:450, 458, 480`).
   Verify: contract tests — save N / load N+1 migrate / load N−1 parked and
   re-emitted byte-identical **over two consecutive snapshots** / a
   pre-envelope snapshot fixture restores every plugin.
6. Per-plugin version stamp (§3.6) in discovery, `worldPluginListing`, panel,
   boot log. Verify: panel shows the stamp; changes after a plugin edit +
   restart.

**Phase 2 — bridge contract (goal a safety; Option B prerequisite 1; npm-plugin
readiness DESIGN §3.5)**

7. Host-mediated sibling lookup on `WorldApi`, with the four bridge rules
   restated as host guarantees (buffer-don't-drop stays in the caller) and
   one new one: a sibling not enabled in this session is `null`.
   Verify: contract-level test — a plugin can register with a sibling that is
   installed later in load order; a missing OR DISABLED sibling degrades
   exactly as today (`*_UNAVAILABLE_WARNING` once).
8. Port the 16 bridge files; delete `DEFAULT_*_MODULE_LOADER` and the
   `import('../../…')` lines. Verify: `grep -rn "import('../../" plugins/`
   is empty; existing bridge tests pass unchanged in behaviour.

**Phase S — per-world plugin settings; the model selector (goal a, 2–3 days)**

9–14. §2.3 steps 1–6.

**Phase 3 — room routing not fixed at boot (Option B prerequisite 2)**

15. DONE 2026-08-26 (issue #197). Colyseus 0.17.50's wildcard `onMessage`
    verified from source (§1.1); `<plugin>:<type>` routed per message through
    `handlerFor` by `net/plugin-message-routing.ts`. Verified on an isolated
    rig (port 2603, own plugins dir): a plugin whose `messages` map was EMPTY
    at boot and gained `ping` on its second `onWorldCreate` — long after room
    create — had `lateping:ping` delivered and answered; the same rig on the
    pre-fix build disconnected the client with Colyseus's unregistered-type
    close (4002) instead.

**Phase 4 — Option B proper (owner said proceed, 2026-08-26)**

16. DONE 2026-08-26 (issue #198). The resolve hook is STATELESS — the
    generation and the plugin's own real root travel in the URL
    (`plugins/reload-hooks.ts`), so it can be registered lazily at the first
    reload instead of before every plugin import, and it re-imports the
    plugin's subtree without dragging core (which several plugins import by
    relative path) in with it. The installed set became an object
    (`plugins/installed.ts`) whose slots are replaceable in load order;
    `WorldManager.reloadPlugin` re-imports, reopens the live world over the new
    module and takes one probe tick, and rolls back to the old `LoadedPlugin`
    on failure at any of import / restore+`onWorldCreate` /
    `persistence.load` / the probe tick. Two of those failures are throws the
    host swallows, so `PluginHost` now counts per-plugin faults. The stamp
    gains a `-reload.<n>` marker and the build identity is rebound once the
    probe has PASSED (#209 — rebinding before the reopen page-reloaded every
    browser for builds that were then rejected, and a client ignores every
    identity after the first difference it acted on, so the rollback could not
    take it back); `WorldManager.announceBuildIdentity` then hands every
    connected player one more join snapshot, which carries the new identity and
    fires the client's existing one-shot reload.

    Verified on an isolated rig (port 2604, own plugins dir, `--expose-gc`):
    editing the SECOND file of a two-file plugin and pressing reload changed
    its answer `v1` → `v2` with no restart and moved the build identity; a
    build that throws at module scope was refused `reloadFailed` and left the
    old module answering. LEAK, measured over 20 reloads of `structures` (the
    largest plugin, symlinked into the rig, heap after two forced GCs):
    **≈0.66 MB heapUsed and ≈3.3 MB RSS per reload**; a two-file toy plugin
    cost 17–33 KB per reload. Recorded in DESIGN as the known residual.

    Contract test: `server/test/plugin-reload.test.ts` — a real plugin
    directory, imported for real, with one case per failing step.

---

## 8. Open questions for the owner

1. **(a) Is a mid-life model swap allowed?** structures' code comment says a
   board "whose history no single rule explains" should not exist
   (`index.ts:147-151`). S2 makes it a per-world, operator-driven choice. If
   the answer is "only at world creation", Phase S shrinks (setting written
   at create, immutable) and the reopen path is not needed.
2. **(a) Should the model setting survive a rollback?** As a world-file row it
   does; as a slice field it would not. Recommendation: world-file row
   (a rollback restores TERRAIN and plugin state, not operator configuration —
   same as `disabled_plugins` today).
3. **(a) Does populous→life on a populous board need a warning?** The CA will
   demolish most 2×2 homesteads on its first generation (§1.8). Suggest the
   panel says so; no code guard.
4. **(b) Is "without restarting the server" a hard requirement**, or is a
   one-button restart with a measured few-second gap and player carry-over
   acceptable? (Phase 4 hinges on this.)
5. **(b) Is the dev loop the real driver?** If so, `run_server.py --watch`
   already restarts the server; the missing piece is Phase 1 step 3 (client
   auto-reload) and `import.meta.hot` handlers in client halves (§1.4).
6. Should Phase 2 (bridge contract) be scheduled on its own as npm-plugin
   readiness (DESIGN §3.5), independent of both goals? (It is the dependency
   of both.)
7. Accept the memory finding (§4) as closed, with the retained-state
   remainder assigned to #78?
8. #180 turned out NOT to be a `persistence.load` defect — the restored whale
   was in-bounds; the wire rounding pushed it off the map (fixed 7f26c33).
   `persistence.load` therefore has no known unsafe case today. §3.3's
   envelope is still recommended because a reload/update is exactly a load
   of a slice written by a different code version, and 3 plugins (boats, fire,
   temples — the sliced-but-unversioned ones, §1.5) cannot tell. Six more can
   tell but respond by erasing their own state (§1.5's downgrade table), which
   the envelope's park-don't-load rule is what replaces.

## 9. Measurement record

- Scripts: `~/.terrace-plugtest/heap/{measure.mjs,world-one.mjs,drive.sh,cachebust.mjs}`;
  raw output in `result.json` and `rss/*.log`. World copy in
  `~/.terrace-plugtest/heap/worlds-copy` (the rig's own world untouched).
- Rig booted twice on port 2601 (all plugins, core-only), 20 s after
  "listening", torn down by exact pid; port confirmed free afterwards. No
  owner port touched.
- Headless runs use `openSession`/`closeSession` from `server/src` directly,
  600 ticks, no clients. Numbers are heap deltas after two forced GCs; RSS
  from `/proc/<pid>/status`.
- 2026-08-25 restructure: source-only research (no app started, per brief);
  §1.8–1.9 traced from `plugins/structures/server/{index,growth-model,
  persistence}.ts`, `plugins/populous/server/{index,structures-bridge}.ts`,
  `plugins/{flora,pilgrims,temples}/server/structures-bridge.ts`,
  `server/src/plugins/host.ts`, `server/src/world/world-manager.ts`.

---

## 10. Review log

Multi-agent adversarial review of this plan, 2026-08-25. Ten CONFIRMED
findings, each re-verified against primary source before being folded in
(every file:line below was re-opened during this pass). Two findings were
REFUTED; nothing was added for them except one clarifying sentence each where
the plan's own wording invited the misreading (§2.2 determinism bullet, §2.3
step 5).

1. **"3 of 16 plugins version their slice" is wrong — it is 6 of the 9 that
   have a slice.** → Short answer bullet (b), §1.5 rewritten with the verified
   9 / 6 / 3 / 7 breakdown, §3.3, §8.8.
2. **Migration and downgrade behaviour is catalogued from three plugins when
   six are relevant.** → §1.5 gains the six-row downgrade table (flora erases
   the forest exactly as structures demolishes the town); §3.3 now names
   `monsters` as the migration reference pattern instead of `chronicle`.
3. **The growth-model slot citation points into a doc comment.** → §1.8 now
   cites `growth-model.ts:184-193`. (Applied as a citation fix only; the
   finding's claim that §2.3 step 4 and Phase 4 send an implementer to that
   range is not true of the plan text — neither cites it.)
4. **Phase S0's reset list zeroes `lastGrowthSeconds` without `simSeconds`.**
   → §2.2 S2, §2.3 Phase S0 and §7 Phase S0 step 0 now specify the
   session-scoped subset of `resetStructuresState` with the clock pair reset
   together, plus the alternative (`lastGrowthSeconds = simSeconds`).
5. **§3.3's "downgrade → slice goes dormant" cannot work: the enabled
   plugin's own save overwrites the parked slice one snapshot later.** →
   §3.3 gains the write-suppress set and the one-writer-per-slice-key
   contract; §7 step 5 and §3.5's table updated.
6. **The slice-version envelope has no read path for the snapshots every
   existing world already holds.** → §3.3 gains the legacy read path (no `v`
   ⇒ version 1), the `restore_points` rule, the double-versioning rule for
   the six already-versioned plugins, and a pre-envelope fixture test.
7. **Phase 1 step 1's exit-code contract is not implementable as written.** →
   §3.1 step 3, §6 Option A mechanism and §7 step 1 now specify
   `gracefullyShutdown(false)` then `process.exit(TERRACE_RESTART_EXIT_CODE)`,
   with the constant named, a proposed value (75, `EX_TEMPFAIL`) and its
   collision reasoning, and the pnpm propagation flagged as unverified.
8. **run_server.py never restarts the server on exit — Phase 1 step 2 is a
   new branch, not a reclassification.** → §7 step 2 rewritten with the
   branch, the re-snapshot, leaving Vite alone, the loop guard with named
   burst constants, and why the in-game button is still wanted next to the
   existing `r` key.
9. **Phase 1 step 3's page-reload trigger cannot fire in either case it
   exists for.** → §7 step 3 rewritten to key on the §3.6 stamp (with a
   dirty marker) or a per-boot nonce, with the docker `TERRACE_VERSION`
   injection stated and a verification that distinguishes the two builds;
   §3.1 step 5, §3.2 step 4 and §3.6 updated to match.
10. **§3.3's "downgrade → dormant" destroys the slice it claims to preserve**
    (the feasibility-lens twin of finding 5). → Same §3.3 / §7 step 5 change,
    plus the ~60 s window it fails in (`DEFAULT_SNAPSHOT_INTERVAL_S = 60`,
    `server/src/config.ts:87`).

Estimates re-derived because a finding invalidated them: §3.3 1–1.5 → **2–3
days**; Phase 1 / §6 Option A 1–2 → **2–3 days**; §3.7 total 3–4.5 →
**4.5–6.5 days**. §2's Phase S0/S estimates are unchanged (finding 4 adds two
assignments, not work).
