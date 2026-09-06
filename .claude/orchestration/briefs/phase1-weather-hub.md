# Phase 1 brief — `weather` → hub + `rain` / `thunderstorm` / `snow` / `fog` (#283, #285)

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12`
(branch `worktree-agent-a63416ea19b8c4c12`, currently == main d82828a).
First action: `EnterWorktree({ path: "<that path>" })`. Every path below is
relative to the worktree root. Commit to the worktree branch as you go
(conventional commits, no attribution footers, stage exact paths only). Do NOT
merge to main; the orchestrator reviews and ff-merges.

Read first (they are binding, do not relitigate):
- `.claude/plans/weather-plugin-decomposition.md` §3–§5 (the design; §1 inventory
  is partly stale after phase 0 — trust source over it).
- `docs/decisions/plugin-host.md`, section "Decisions made 2026-09-01 (a library
  tier …, #283)" — what may be shared (kit) vs what stays a documented copy
  (contracts between plugins).
- `docs/decisions/chronicle.md` §World events (by-name subscription rule).
- `server/src/plugins/kit/bridge.ts` header (the sibling-bridge mechanism).
- `CLAUDE.md` at the root (hard rules: erasable TS, determinism, no gamey core).

## Hard constraints
- NEVER start or stop the app (server or client, any port). Owner permission is
  per turn and has not been given this session. Gate = typecheck + tests only;
  in-world shots are done later by the orchestrator.
- Tests: you MAY (a) move/split weather's existing tests into the new plugins
  and (b) write SHORT contract tests for the two new kit/hub pieces
  (`discSystems`, hub registry) BEFORE writing those modules. No other new
  tests. Keep them abbreviated.
- Comments are claims, not evidence: verify every behaviour you preserve from
  source lines, and cite `file:line` in your final report.
- Kit code names no plugin. Plugins never import each other. A kind plugin
  reaches the hub ONLY through `WorldApi.sibling('weather')` via
  `createSiblingBridge`.
- Behaviour-preserving where the plan does not say otherwise. The one
  intentional change: population budget becomes per-kind (see §Budget).
- Don't touch `docs/DESIGN.md` or `docs/decisions/*`. Don't touch anything under
  `plugins/storms/` except the two lines named in §Consumers.

## Today's shape (verified 2026-09-02)
`plugins/weather/` = one plugin, name `weather` (`protocol.ts:21`), one sim
`server/systems.ts` (877 lines): one wind (`advanceWind`, `currentWind`), kinds
`['rain','storm','snow','fog']` drawn by weights `[5,2,1.5,1.5]`
(`systems.ts:398`), `TARGET_SKY_COVERAGE_FRACTION = 0.18` (`:112`),
`MAX_ACTIVE_SYSTEMS = 14` (`protocol.ts`, re-exported), snow siting
(`isSnowSite`, `SNOW_SITING_ATTEMPTS = 4`, fallback `SNOW_FALLBACK_KIND = 'rain'`
`:383`), `precipitationAt` = max over wetting kinds (`:742`), `livingSystems()`
(`:439`). Lightning in `server/lightning.ts` only from kind `storm`, emitted by
`server/index.ts` `simulate()` as broadcast `strikes` + `world.emitEvent('strikes', …)`
(host prefixes plugin name → `weather:strikes`). Dev force:
`server/dev.ts` `WEATHER_DEV_FORCE=rain|storm|snow|fog`. Admin actions: one per
kind (`index.ts` `actions`). No persistence. Unfiltered broadcast every
`BROADCAST_TICK_INTERVAL = 10` ticks.
Client `plugins/weather/client/`: `index.ts` (289) subscribes `systems` +
`strikes`, reconciles rigs by id via kit `reconcileById`, interpolates via
`interpolation.ts` (151, over kit interpolator); `rig.ts` (864) builds per-kind
rigs (rain/storm columns, snow columns, fog sheets, bolt/flash/light bank);
`sky.ts` (729) is pure timing/number maths (misnamed; it does NOT touch core's
sky — `index.ts:12`). `drawBudget = MAX_ACTIVE_SYSTEMS * WEATHER_SYSTEM_DRAW_OBJECTS(7) + …`
(`client/index.ts:205-220`). Tests: `test/weather.test.ts` (634),
`test/client.test.ts` (501), `test/support/world.ts`.

## Target shape
Five plugins replace one. Each new plugin dir mirrors weather's layout
(`package.json` named `@terrace/plugin-<name>`, `tsconfig.json` copied from
`plugins/weather/tsconfig.json`, `protocol.ts`, `server/index.ts`,
`client/index.ts`, `test/`). Plugin `name` == dir name.

### `weather` (hub, keeps its name and dir)
Owns: the wind (move `advanceWind`/`currentWind`/wind constants here) and an
inward registry. Server exports (this is the seam phase 2's tornado depends on
— pin it exactly):
```ts
export interface SkyCell { readonly x: number; readonly y: number; readonly radius: number; readonly intensity: number }
export interface SkyKindEntry {
  readonly name: string;                     // the registering plugin's name
  cells(): readonly SkyCell[];               // living systems, for consumers
  wetnessAt(x: number, y: number): number;   // 0 for a non-wetting kind
  spawnOne?(): boolean;                      // #285: birth one unsited system now, within own cap
}
export function registerSkyKind(entry: SkyKindEntry): () => void; // returns unregister; same name replaces
export function spawnSkyKind(name: string): boolean;              // #285 hand-off; false if absent
export function currentWind(): Readonly<Wind>;                    // unchanged signature
export function precipitationAt(x: number, y: number): number;    // max over entries' wetnessAt, clamped 0..1
export function livingSystems(): readonly (SkyCell & { readonly kind: string })[]; // concat; `kind` STAMPED BY THE HUB = entry.name
```
Registry cleared in the hub's `onWorldClose` (NOT `onWorldCreate` — plugins
tick/create in name order, `weather` sorts after the four kinds, so a create-time
clear would wipe their registrations). Validate entries structurally at
register time. Hub has no wire messages, no actions, no client rendering
(its `client/index.ts` becomes a no-op plugin with `drawBudget: 0`, or is
removed from the registry — pick the one that keeps `client/test/drawBudget`
and the host happy; say which).
fire's and mudslides' bridges keep resolving `currentWind`/`precipitationAt`
on this module unchanged (`plugins/fire/server/weather-bridge.ts`,
`plugins/mudslides/server/weather-bridge.ts`) — do not edit them.

### Kit: `server/src/plugins/kit/discSystems.ts` (new) + `devForce.ts` (new)
`discSystems` = the engine extracted from `systems.ts` minus wind and minus
kind choice: drift on a SUPPLIED wind velocity, envelope gather/fade, Poisson
death, per-slot refill, off-map despawn, optional siting predicate, forced/dev
parking at world centre, `states()` rounding via `roundBroadcastIntensity`/
`roundBroadcastPosition`. Parameterised by `{ coverageFraction, siting?,
onUnsited?, rng }`; cap derived per instance from `coverageFraction` the same
way `activeSystemCapFor` does today. Deterministic: fixed iteration order,
seeded RNG from `@terrace/shared`. Contract test FIRST, short:
`server/test/kit/discSystems.test.ts` (cap derivation, drift on supplied
wind, siting retry + `onUnsited` callback, forced parking).
`devForce.ts`: `readDevForce(envName, env): boolean` for `<NAME>_DEV_FORCE=1`.
Hub registry contract test FIRST, short: `plugins/weather/test/hub.test.ts`
(register/replace/unregister, `kind` stamped by hub, precipitation max,
`spawnSkyKind` false when absent, cleared on close).

### `rain`, `thunderstorm`, `snow`, `fog`
Each: a `discSystems` instance, its own bridge to `weather` (duck-type
`registerSkyKind`, `currentWind`; buffer-don't-drop via `onResolved` so a
hub that resolves later still gets the registration), registers itself in
`onWorldCreate`, unregisters in `onWorldClose`, reads wind through the
bridge each tick (calm if hub absent — degraded mode per plan), broadcasts
`<name>:systems` (same payload shape as today's `systems`, kind field
dropped or fixed to the plugin's name — your call, say which), one admin
action ("Bring rain" etc.), `<NAME>_DEV_FORCE=1` via kit `devForce`.
- Coverage shares (today's weights normalised): rain 0.09, thunderstorm 0.036,
  snow 0.027, fog 0.027 — named constants with the derivation in a comment.
- `wetnessAt`: rain/thunderstorm/snow wetting as today's `precipitationAt`
  treats them (verify from `systems.ts:742` which kinds wet and how); fog 0.
- `snow`: siting = today's `isSnowSite` (unlocked-only elevation). #285: on a
  roll that fails siting after `SNOW_SITING_ATTEMPTS`, call the bridge's
  `spawnSkyKind('rain')` (snow names rain by STRING only). If false (rain absent
  or at cap) the roll is simply lost. Net effect on a snowless world equals
  today's.
- `thunderstorm`: rain engine + `lightning.ts` moved in; emits broadcast
  `strikes` AND `world.emitEvent('strikes', …)` → host-prefixed
  `thunderstorm:strikes`. Same packed payload (`packStrikes`).
- Client: split `rig.ts`/`sky.ts`/`interpolation.ts` by kind into each plugin;
  shared helpers that ≥2 kinds need go to `client/src/plugins/kit/` (no plugin
  names in them). thunderstorm's client = rain rig + bolt/flash/light bank +
  `LightningGovernor`. Each declares `drawBudget` as its own cap × objects per
  rig (+ fixed rigs); the SUM across the four must be ≤ today's weather budget
  (compute both, put them in the report).
- `client/src/plugins/registry.ts`: replace `weather` with the four (plus hub
  no-op if you kept one).

### Consumers (the only edits outside the five plugins + kit + registry)
- `plugins/fire/server/index.ts:957` `'weather:strikes'` → `'thunderstorm:strikes'`;
  update the comment at `plugins/fire/server/strike-event.ts:2`. Payload
  unchanged.
- `plugins/storms/server/weather-bridge.ts:42` `WEATHER_STORM_KIND = 'storm'`
  → `'thunderstorm'` (storms is decomposed in phase 2; this keeps tornado birth
  working meanwhile). Nothing else in storms.
- Grep for any other `weather:` / `WEATHER_DEV_FORCE` / `'storm'` kind
  coupling under `plugins/`, `server/src`, `client/src` and report hits; do not
  edit `.claude/**`, `.perf-run/**`, `.verify-shots/**`.

### Tests to move
`plugins/weather/test/weather.test.ts` describes: `rollEvent` (now shared →
already covered by kit? verify; if a duplicate of `shared` coverage, drop it
and say so), `drift coherence` (→ kit discSystems or hub wind), `spawn and
decay` (→ discSystems), `snow siting` (→ snow), `broadcast` (→ per kind, one
copy is enough if the engine is shared — say which). `client.test.ts`:
`parseSystemsPayload` (→ whichever protocol keeps it), `WeatherInterpolator`,
`falling column` (→ rain), `fog bank` (→ fog), `photosensitivity floor`
(→ thunderstorm). Import-path and rename edits are expected; no assertions
weakened.

## Gates (all must pass in the worktree before you report)
1. `pnpm typecheck` = 0 errors.
2. `pnpm test` green except the two pre-existing failures the orchestrator
   already reproduced on main (mana float leak; client vertexGrid picking).
   Any other failure is yours.
3. `git diff --stat main` — report it. `plugins/weather/server/systems.ts`
   should be gone or reduced to wind.
4. `grep -rn "import .*plugins/(rain|thunderstorm|snow|fog|weather)/" plugins/`
   across plugin boundaries = 0 hits (no plugin imports another).
5. `grep -rn "rain\|snow\|fog\|thunderstorm\|weather" server/src/plugins/kit client/src/plugins/kit` = 0 hits in code (comments may cite them as examples).

## Report (final message; the orchestrator reads only this)
- Commits (hash + subject).
- Hub API as shipped (verbatim signatures) — phase 2 depends on it.
- Draw budgets: old weather total vs sum of the four.
- Wire: message names per plugin, payload shape, any change from today.
- Every behaviour deviation from today, with `file:line` evidence for the old
  behaviour and the new.
- Gate outputs (typecheck summary, test totals, diff --stat, the two greps).
- Anything you could not verify without running the app, listed.
- For the orchestrator's in-world shots: the exact env per kind
  (`RAIN_DEV_FORCE=1` …) and where the forced system parks.
