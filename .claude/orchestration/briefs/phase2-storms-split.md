# Phase 2 brief — `storms` → `tornado` + `cyclone` over a kit `rotatingStorms` engine (#283, #291)

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12`
(branch `worktree-agent-a63416ea19b8c4c12`, == main after the phase-1 merge).
First action: `EnterWorktree({ path: "<that path>" })`. Paths below are relative to
the worktree root. Commit to the worktree branch as you go (conventional commits, no
attribution footers, stage exact paths only). Do NOT merge to main.

Read first (binding, do not relitigate):
- `.claude/plans/weather-plugin-decomposition.md` §2–§5 (design; §1 inventory is stale).
- `docs/decisions/plugin-host.md`, "Decisions made 2026-09-01 (a library tier …, #283)".
- `docs/decisions/chronicle.md` §World events.
- `.claude/orchestration/briefs/phase1-report.md` §2 (the hub API as shipped — tornado
  consumes it) and §12 (dev switches).
- `server/src/plugins/kit/bridge.ts`, `devSite.ts`, `devForce.ts`, `discSystems.ts`
  (the phase-1 engine: match its shape and conventions for `rotatingStorms`).
- Root `CLAUDE.md` hard rules (erasable TS, determinism, integer-only terrain math).

## Hard constraints
- You MAY start/stop your OWN isolated stack from the worktree (owner permission for this
  session). Never the owner's stack, never from the main checkout. Shape: copy
  `.phase1-stack/launch.sh`/`stop.sh`/`shot.mjs` (already in the worktree, untracked) to
  `.phase2-stack/`; pick a free port (check `ss -ltn` first; 2599 and 2611 may be held),
  `WORLDS_DIR` + NONEXISTENT `DB_PATH` under `.phase2-stack/`, `WORLD_SIZE=512`,
  `CLIENT_DIST_PATH` at this worktree's rebuilt `client/dist`. Kill by pid file or
  port-owner pid from a script FILE; NEVER an inline `pkill -f`/`pgrep -f`. Tear down
  when done.
- Tests: storms has NO tests today. You MAY write SHORT contract tests, BEFORE the code
  they cover, for exactly: (a) kit `rotatingStorms`, (b) the `broadcastVisible` off-map
  contract (#291), (c) one persistence round-trip per new plugin. Nothing else.
- Comments are claims, not evidence: verify preserved behaviour from source lines; cite
  `file:line` in the report.
- Kit code names no plugin. Plugins never import each other. tornado reaches the hub only
  through `WorldApi.sibling('weather')` via `createSiblingBridge`.
- Behaviour-preserving except where this brief says otherwise.
- Don't touch `docs/DESIGN.md`, `docs/decisions/*`, `.claude/**` (except your report file
  named below), `.perf-run/**`, `.verify-shots/**` (except your new `phase2/` dir),
  `plugins/{rain,thunderstorm,snow,fog,weather}/` (phase 1, merged — read-only for you).

## Today's shape (verified 2026-09-02, main)
`plugins/storms/` = one plugin `storms` (`protocol.ts:46`), 4 276 lines + the dead
harness `client/src/previewStorm.ts` (372) + `client/preview-storm.html`.
- `server/storms.ts` (912): profile-driven engine — `KindProfile` via `profileFor(kind)`
  (:250), `MAX_ACTIVE_STORMS = TORNADO.maxActive + CYCLONE.maxActive` (:261), siting
  (`SITING_ATTEMPTS = 6`, `DISC_SAMPLE_OFFSETS`, `CYCLONE_MIN_OPEN_WATER_FRACTION = 0.85`,
  `waterFractionUnder`), `trySpawnTornado` (:510, inside a thunderstorm cell from the
  weather bridge), `trySpawnCyclone` (:584, open water), `spawnStormAt` (:549),
  `DESPAWN_MARGIN_RADII = 1.5` (:613), `advanceStorms` (:732: movement, veer, lifetime,
  terrain decay, landfall detection, damage sampling every `DAMAGE_INTERVAL_SECONDS`),
  `stormStates` (:844), `stormSnapshot`/`restoreStorms` (:871/:883), `spawnRoll`,
  `stormRandom`, `setDevFrozen`, difficulty→interval maths (:96–:147).
- `server/surge.ts` (188): cyclone-only shoreline scour via terrain writes.
- `server/index.ts` (384): settings `storm-frequency` (`off|rare|common`, default `rare`)
  and `storm-surge` (`off|on`, default `on`) read once in `onWorldCreate` (:285–:286);
  `BROADCAST_TICK_INTERVAL = 2`; `broadcastVisible` gated on the EYE (:198–:210); events
  `damage`, `landfall` (host-prefixed `storms:damage`, `storms:landfall`); persistence
  slice `storms` v1 (`persistence.ts:34`); two admin actions.
- `server/dev.ts` (232): `STORMS_DEV_FORCE=tornado|cyclone|both`; spoke search from the
  centre for nearest land / nearest open water over the kit reach constants.
- `server/weather-bridge.ts`: `livingSystems()` filtered to kind `'thunderstorm'` (:42,
  changed in phase 1) → `stormCells()`.
- Client: `client/index.ts` (289) subscribes `all`, extrapolates ≤ 1 s, drives
  `funnel.ts` (690, tornado), `spiral.ts` (558, cyclone deck over kit `puffDeck`),
  `gloom.ts` (174, cyclone daylight loss). `drawBudget = FUNNEL_DRAW_OBJECTS + SPIRAL_DRAW_OBJECTS`.
- No plugin consumes `storms:damage`/`storms:landfall` today (grep over `plugins/`,
  `server/src`, `client/src`: zero hits outside storms). chronicle does not either.

## Target shape
### Kit
- `server/src/plugins/kit/rotatingStorms.ts` (new): today's engine parameterised by a
  profile + a spawn-site predicate + hooks, one instance per plugin. Owns movement, veer,
  lifetime, terrain decay, landfall detection, damage sampling, snapshot/restore,
  `states()` rounding, dev freeze. NO kind names, NO weather knowledge: the siting
  predicate is supplied by the plugin. Deterministic (seeded rng from `@terrace/shared`,
  fixed iteration order). Contract test FIRST, short: `server/test/kit/rotatingStorms.test.ts`.
- `server/src/plugins/kit/devSite.ts`: the spoke search itself moves here now that two
  plugins need it (`searchOutwardFromCentre(world, predicate)` or similar — one search,
  two predicates). Phase 0 left it in storms because it had one caller.
- `server/src/plugins/kit/slice.ts` only if BOTH plugins would otherwise repeat the
  versioned record-array boilerplate; say which way you went.

### #291 — `broadcastVisible` off-map contract (core)
`server/src/plugins/world-api.ts` `broadcastVisible`: define once that a position outside
the world is visible to NOBODY (filtered out, never thrown). Contract test FIRST, short,
in `server/test/`. This is a core change; keep it minimal and documented at the
callsite in world-api.ts. Do not clamp in the plugins instead.

### `tornado`
Profile = today's tornado profile; siting = inside a cell of kind `thunderstorm` from the
hub's `livingSystems()` (own bridge, duck-type `livingSystems`; the string
`'thunderstorm'` is the documented coupling — copy today's bridge). Setting
`tornado-frequency` (`off|rare|common`, default `rare`). Wire `tornado:all` (filtered on
the eye, `skipEmpty: false`). Event `tornado:damage`. Slice `tornado` v1.
`TORNADO_DEV_FORCE=1` via kit `devForce` → nearest land to the centre. One admin action.
Client: `funnel.ts` moved in; `drawBudget = FUNNEL_DRAW_OBJECTS`.

### `cyclone`
Profile = today's cyclone profile; siting = open water (`waterFractionUnder ≥ 0.85`),
basin/given names as today. Settings `cyclone-frequency` (`off|rare|common`, default
`rare`) and `cyclone-surge` (`off|on`, default `on`). Wire `cyclone:all`. Events
`cyclone:damage`, `cyclone:landfall`. Slice `cyclone` v1. `surge.ts` stays cyclone-only.
`CYCLONE_DEV_FORCE=1` → nearest open water. One admin action. Client: `spiral.ts` +
`gloom.ts` moved in; `drawBudget = SPIRAL_DRAW_OBJECTS` (+ gloom's objects if any).

### Removals
- `plugins/storms/` deleted entirely.
- `client/src/previewStorm.ts` and `client/preview-storm.html` deleted; check
  `client/vite.config.*` / `client/index.html` for an entry that references them.
- `client/src/plugins/registry.ts`: `storms` → `tornado`, `cyclone`.

### Migration facts (verified by the orchestrator from source; state them in your commit)
- Settings rows are keyed by plugin name and only looked up for RUNNING plugins
  (`server/src/plugins/host.ts:188`); the old `storms` rows are orphaned and harmless;
  defaults apply (`rare`, `rare`, `on`).
- A snapshot slice for a plugin the build no longer has is logged and dropped
  (`host.ts:107-110`); an in-flight storm at upgrade time is lost. Acceptable; flag it.

## Gates (all in the worktree before you report)
1. `pnpm typecheck` = 0 errors.
2. `pnpm -r --no-bail test` green except the known pre-existing failures (mana float
   leak; client vertexGrid picking; fire/temples/mudslides/storms-dir "No test files").
3. Greps: no `import` across plugin dirs; no plugin names in `server/src/plugins/kit`
   or `client/src/plugins/kit` code; `grep -rn "storms" plugins server/src client/src`
   = 0 hits outside comments that record history.
4. Draw budget: tornado + cyclone sum ≤ today's storms `drawBudget` (compute both).
5. In-world shots under `.verify-shots/phase2/` (also copy to the main checkout's
   `.verify-shots/phase2/`): (a) `TORNADO_DEV_FORCE=1 THUNDERSTORM_DEV_FORCE=1` — funnel
   visible inside the storm; (b) `CYCLONE_DEV_FORCE=1` — spiral deck over water, then the
   same cyclone at landfall, plus a before/after of a scoured shoreline (surge on);
   (c) persistence round-trip: force a cyclone, stop the server, start it on the same
   `WORLDS_DIR`, shot showing the same cyclone restored (log lines + screenshot).
6. #291 closed in-world: with a storm forced near the map edge (or by letting a cyclone
   drift out), the server log shows NO `out of bounds` throw from onTick.
7. Server log confirms: `tornado` and `cyclone` load, no `storms`; tornado's bridge
   finds thunderstorm cells; no bridge-unavailable warning.

## Report
Write the full report to
`/mnt/e/Development/Projects/Terrace/.claude/orchestration/briefs/phase2-report.md`
(main checkout path; plain file, uncommitted) and reply with ONLY that path. Include:
commits; kit `rotatingStorms` API; settings/slice/wire/event names per plugin; every
behaviour deviation with `file:line` old/new; gate outputs; PNG absolute paths with a
one-line description each; what you could not verify; stack torn down (port free).
