# Frame-budget branch review, 2026-08-29 — 19 held, 4 refuted

## 1. [high/correctness] A drawBudget of 0 is a permanent, unclearable breach — four plugins ship with one
`client/src/plugins/host.ts:131`

**Claim:** `stepDrawBudgetBreach` breaches on `objects >= budget` and can only clear on `objects < budget * (1 - DRAW_BUDGET_CLEAR_MARGIN)`. For a budget of 0 the breach test is `0 >= 0` (always true) and the clear test is `objects < 0` (never true), so the state machine latches breached on the first sample and can never leave it. mana (MANA_DRAW_OBJECTS = 0, index.ts:26), invite (:20), chronicle (:24) and daynight (:92) all declare exactly 0 — the plan's own B7 table gives them 0 because they add no scene geometry.

**Scenario:** Boot the client with the compiled-in registry. FPS_SAMPLE_INTERVAL_MS (500 ms) after the host is created, `sampleDrawObjects` walks mana's empty layer: objects = 0, budget = 0 → `stepDrawBudgetBreach` returns `{breached: true}`. Four `console.error('[terrace] client plugin "mana" is over its draw budget: 0 objects against a budget of 0')` lines are logged on every session, and VersionWatermark renders four permanent red rows reading `mana 0/0`, `invite 0/0`, `chronicle 0/0`, `daynight 0/0` for the life of the page — for plugins that draw nothing.

**Skeptic:** Verified in the worktree: stepDrawBudgetBreach breaches on `objects >= budget` (host.ts:131) and clears only on `objects < budget*(1-0.1)` (host.ts:136), so budget 0 latches breached on the first sample and can never clear; countDrawObjects returns 0 for an empty layer (host.ts:52-79), and mana/invite/chronicle/daynight declare 0 (plugins/*/client/index.ts:26/20/24/92). No zero-budget guard exists in sampleDrawObjects (host.ts:679-697), and VersionWatermark.tsx:79 renders every breached row, so the console.error and four permanent red rows occur exactly as described.

## 2. [medium/correctness] Budgets are exact full-rig counts, so a fully-populated plugin breaches by construction
`plugins/flora/client/index.ts:321`

**Claim:** Every fixed-pool plugin's budget is the sum of its rigs' measured object counts (flora 3+2+3+2+4 = 14, fire 2+1+1+0+1 = 5, storms 3, volcanoes 2, mudslides 2, structures 36+2 = 38, weather 14*7+1 = 99), i.e. the count the layer holds when the plugin is fully active. Paired with the `objects >= budget` breach test (host.ts:131) that healthy full state is reported as a failure, and clearing needs the layer to drop below 90 % of the budget — a whole pool going away — for two consecutive samples. The type doc calls the field "the most renderable objects this plugin's layer may hold", which is a value that must be permitted, not a value that trips the alarm.

**Scenario:** A world with trees, crops, grass, stumps and a shoreline fringe alive at once: flora's layer holds 3+2+3+2+4 = 14 objects, its declared budget is 14, so `14 >= 14` breaches. `console.error` names flora as over budget and a red `flora 14/14` row sits in the watermark until at least one whole instanced pool empties (objects < 12.6) for two sampling windows. Same for weather at its cap of 14 systems (98 rig objects + 1 dry bolt = 99 = budget), fire with all five pools populated (5/5), structures with both merged surfaces (38/38).

**Skeptic:** Verified: budgets are exact full-rig sums (plugins/flora/client/index.ts:321 = 3+2+3+2+4 = 14; plugins/weather/client/index.ts:251 = 14*7+1 = 99) and the breach test is inclusive — `if (objects >= budget) return { breached: true, lowSamples: 0 }` at client/src/plugins/host.ts:131 — so a healthy fully-populated layer trips the alarm at exactly its declared ceiling. countDrawObjects (host.ts:52-79) counts one per visible, non-empty InstancedMesh, so the full-population count does equal the summed rig counts. Clearing then needs objects < 0.9x budget for 2 consecutive samples (host.ts:90, 98, 136), contradicting the type doc at client/src/plugins/types.ts:429 that calls drawBudget the most objects the layer may hold.

## 3. [medium/correctness] settle() from a harness or the bench is a wall-clock race and usually a silent no-op
`client/src/render/terrainMeshes.ts:1631`

**Claim:** `settle()`'s global gate is `now() - lastUpdateMs < TERRAIN_QUIET_MS` (800 ms), and `lastUpdateMs` is stamped by `update()` itself. Every non-frame-hook caller runs `update(allChunks); flush(); settle();` synchronously in one turn (previewArch.ts:200, previewWater.ts, previewRivers.ts, and the bench's `for (…) meshes.settle()` in client/test/zz-perf-sculpt.bench.test.ts:146), so whether the headroom pass does anything depends entirely on how long the build happened to take. The doc on the public method says the harnesses are the ones who can name the quiet moment, but the implementation ignores the caller's assertion and re-derives quiet from a clock the caller cannot advance. The unit tests only pass because they call `clock.advance(TERRAIN_QUIET_MS)` first (terrainMeshes.test.ts:1350).

**Scenario:** previewWater builds its world: `meshes.update(allChunks)` stamps lastUpdateMs = T, `flush()` returns after, say, 300 ms, `meshes.settle()` then evaluates `300 < 800` and returns immediately. No super-mesh gets headroom, and the harness's first sculpt reallocates mid-stroke — exactly the defect #229 is about — with no indication that the settle call did nothing. In the bench the same silence makes `arenaReport('after settle()')` print numbers identical to `after stream`, so the verification step the plan relies on can report success-shaped output from a pass that never ran.

**Skeptic:** Confirmed in code: settle() gates on `now() - lastUpdateMs < TERRAIN_QUIET_MS` (terrainMeshes.ts:1631) where `now` defaults to `performance.now` (1424) and `lastUpdateMs` is stamped by update() (1657), and TERRAIN_QUIET_MS = 2*400 ms (279, config.ts:305). previewArch.ts:198-200, previewWater.ts:234-236 and previewRivers.ts:585-587 all run `update(allChunks); flush(); settle();` in one synchronous turn with no scheduling (so no frame hook ever calls settle again — 1645), and the bench does the same with real wall-clock (zz-perf-sculpt.bench.test.ts:44,146), so whether the headroom pass runs is decided by how long the intervening build happened to take, silently.

## 4. [high/spec-conformance] Every zero-budget plugin is in permanent breach from the first sample
`client/src/plugins/host.ts:131`

**Claim:** `stepDrawBudgetBreach` breaches on `objects >= budget` (B3.4's literal wording), but B7 assigns budget 0 to four plugins that deliberately draw nothing — mana (plugins/mana/client/index.ts:35), invite (:29), chronicle (:33), daynight (:101). With objects 0 and budget 0 the predicate is true, so all four breach on the first window and can never clear: the clear branch needs `objects < budget * (1 - 0.1)` = `< 0`, which is unreachable. Their own comments ("Zero is a real budget: the first mesh added to this layer breaches it") state the intent the code does not implement.

**Scenario:** Boot the client. 500 ms later the host's first sample runs: four `console.error("[terrace] client plugin \"mana\" is over its draw budget: 0 objects against a budget of 0")` lines fire, and VersionWatermark.tsx renders four permanent red `mana 0/0`, `invite 0/0`, `chronicle 0/0`, `daynight 0/0` rows for the life of the page. The HUD breach display — the whole developer-facing half of the contract — is noise from the first frame, so a real breach in a drawing plugin is buried among four false ones.

**Skeptic:** Confirmed in code: host.ts:131 breaches on `objects >= budget`, and mana/invite/chronicle/daynight all declare `drawBudget: 0` (plugins/mana/client/index.ts:26,35; invite:20,29; chronicle:24,33; daynight:92,101) while being mounted unconditionally from client/src/plugins/registry.ts:29,30,40,45. With objects 0 the first `sampleDrawObjects` (host.ts:683-696) sets breached=true, logs the console.error transition, and the clear path at host.ts:136 requires `objects < 0`, which is unreachable — so the breach is permanent exactly as described.

## 5. [low/spec-conformance] The frame total's `objects` walks the whole scene, not the enumerated contributors it is budgeted against
`client/src/plugins/host.ts:701`

**Claim:** B3.3 specifies the sampler walks "each mounted plugin's layer and core's named contributors". The code instead calls `countDrawObjects(viewport.scene)`, while `frameDrawBudget()` (host.ts:659) sums only `coreDrawBudget()` plus mounted plugins' budgets. Anything in the scene that is neither a plugin layer nor one of core's seven enumerated rigs is counted on the objects side and absent from the budget side — the two halves of the ratio the HUD prints are drawn from different populations.

**Scenario:** Any future core rig added to the scene (or a plugin that adds a mesh to the scene rather than to `ctx.layer`) inflates `frameDraw().objects` with no matching budget contribution. The HUD's `objects/budget` drifts toward red, and no per-plugin row explains it, because the extra objects belong to no row — the breach is unattributable, which is exactly what B3's per-plugin rows exist to prevent.

**Skeptic:** The deviation is real: host.ts:701 sets `objects: countDrawObjects(viewport.scene)` (whole scene) while `frameDrawBudget()` at host.ts:659-668 sums only `deps.coreDrawBudget()` plus mounted plugins' declared budgets, and `coreDrawBudget` (main.tsx:81-84) is an enumeration — `world.drawBudget() + BRUSH_PREVIEW_DRAW_OBJECTS + PICK_DEBUG_OVERLAY_DRAW_OBJECTS` — so the two halves of the HUD ratio genuinely come from different populations, against spec B3.3's "walk each mounted plugin's layer and core's named contributors". The failure scenario can occur: any scene child that is neither a plugin layer nor an enumerated core rig raises `objects` with no budget contribution and no per-plugin row to attribute it to. The code's comment at host.ts:669-676 documents this as a deliberate "core = remainder" choice (a remainder cannot go stale when core gains a rig), which mitigates severity but does not make it conform to the written spec.

## 6. [low/spec-conformance] B6's registry-driven test is omitted; the runtime shape of the compiled-in budgets is unpinned
`client/test/drawBudget.test.ts:252`

**Claim:** B6 lists "every registered plugin's `drawBudget` is finite (a registry-driven test — the type already requires the field, so this pins the runtime shape, not the compile-time one)" as a deliverable. The file documents skipping it (vitest transform cannot handle plugin `.tsx` panels imported via plugins/registry.ts) and substitutes the type requirement, which is precisely the thing B6 says the test is not for. The 0-budget defect above is one a registry-driven assertion over `CLIENT_PLUGINS` would have surfaced.

**Scenario:** A plugin ships a budget computed from an import that resolves to `undefined` at runtime (a cap moved back into a server half, a circular import). TypeScript is satisfied, the suite is green, and the plugin is silently in permanent breach with `NaN`/`undefined` in its HUD row — the runtime case the omitted test was specified to catch.

**Skeptic:** The deviation is real: B6 (docs/plans/frame-budget-growth-and-draw-calls.md:308-310) names the registry-driven finite-budget test as a deliverable, and client/test/drawBudget.test.ts:252-262 explicitly documents omitting it and substituting the compile-time type guarantee. I reproduced the stated harness limit (a probe test importing client/src/plugins/registry.ts fails in vite:import-analysis on plugins/chronicle/client/ChroniclePanel.tsx:103), so the excuse is genuine — but that justifies the gap rather than refuting it, and the runtime failure scenario (a budget resolving to undefined/NaN at runtime with the suite green) remains reachable.

## 7. [high/tests] Nothing tests that the frame hook calls settle() — the whole feature can be dead in the real client
`client/test/terrainMeshes.test.ts:1316`

**Claim:** A6 requires the seam `drain(…); compact(…); settle()`. Every test in `describe('headroom at settle')` calls `meshes.settle()` explicitly; no test observes a growth caused by a frame. The three places a frame runs inside these tests (`stream()`, and the `clock.frame()` calls in the in-flight test) all run with the clock parked at the same value as `lastUpdateMs`, so the hook's `settle()` is gated off by the quiet test every time and contributes nothing to any assertion.

**Scenario:** Mutation: delete the `settle();` line from the `stopDraining` frame handler (client/src/render/terrainMeshes.ts:1642-1648). All 62 tests still pass, and the shipped client never grows a super-mesh at all — main.tsx has a scheduler, so `settle()` is only ever reached from the hook — leaving issue #229 exactly as it was while the suite claims the contract is held.

**Skeptic:** Verified empirically: copied the worktree to scratchpad, deleted the `settle();` line from the frame hook (client/src/render/terrainMeshes.ts:1646), and client/test/terrainMeshes.test.ts still passed 44/44 — no test observes a growth caused by a frame. Outside tests the only settle() callers are preview harnesses (previewArch.ts:200, previewRivers.ts:587, previewWater.ts:236) and the bench, so the hook is the sole path in the shipped client and the mutation silently disables the feature. Two details of the claim are inaccurate but not load-bearing: the file has 44 tests, not 62, and one frame does run past the quiet window (the `clock.frame()` after `held.release()`, test ~line 1485) — it just cannot fail any assertion because the explicit `settle()` two lines later produces the same growth.

## 8. [medium/tests] The quiet gate's per-super-mesh scoping is untested — a global 'any chunk anywhere' gate passes
`client/test/terrainMeshes.test.ts:1453`

**Claim:** Both quiet-gate tests park the blocking chunk in the SAME super-mesh as the one under test (ORIGIN and NEIGHBOUR are both in super-mesh 0), and every other settle test has all four queues empty. Nothing asserts that a chunk queued for a DIFFERENT super-mesh leaves this one free to grow.

**Scenario:** Mutation: make `superMeshHasChunkQueued` ignore its `superIdx` argument (`return pending.size + inFlight.size + retry.size + ready.length > 0`). Every test passes, but on a live world any single chunk still streaming anywhere blocks headroom for all 16 super-meshes, so during a long reveal `settle()` never runs and every super-mesh enters the first stroke with the accidental ladder slack — the original defect, silently.

**Skeptic:** Confirmed by mutation testing: replacing superMeshHasChunkQueued (client/src/render/terrainMeshes.ts:1591) with the superIdx-ignoring global form leaves all 44 tests in client/test/terrainMeshes.test.ts passing. The only test involving a second super-mesh (OTHER_SUPER, client/test/terrainMeshes.test.ts:1403) has every queue empty, and both quiet-gate tests (lines 1453 and 1494) block on NEIGHBOUR, which shares super-mesh 0 with ORIGIN. Nothing asserts the gate's per-super-mesh scoping.

## 9. [medium/tests] The `ready` queue is not covered by any quiet-gate test
`client/src/render/terrainMeshes.ts:1591`

**Claim:** A3 names four queues (pending, inFlight, ready, retry); A6 asks only for retry and inFlight, and the tests cover exactly those two. No test ever runs `settle()` with an answered-but-unspliced chunk in `ready` — in the in-flight test, `held.release()` is followed by `clock.frame()`, whose `drain` empties `ready` before `settle` is reached (the settle scheduler's `now()` never advances, so the splice budget is never exhausted).

**Scenario:** Mutation: delete the `for (const answer of ready)` loop from `superMeshHasChunkQueued`. All tests pass. On the real worker source with a full splice budget, a chunk answered but held over to the next frame lets `settle()` reallocate the super-mesh whose run is about to be spliced in — a growth on a frame that is not quiet, plus a second full `bufferData` when the splice then outgrows the new capacity.

**Skeptic:** Confirmed by mutation: deleting the `for (const answer of ready)` loop at client/src/render/terrainMeshes.ts:1601 leaves all 44 tests in client/test/terrainMeshes.test.ts passing (run in the worktree, file restored afterwards). The in-flight test (test line 1484-1487) does `held.release()` then `clock.frame()`, and `drain` (terrainMeshes.ts:1454-1483) loops until `ready` is empty because settleScheduler's `now()` is frozen so `now() - startedMs` is always 0 — so `settle()` never sees a non-empty `ready`.

## 10. [medium/tests] countDrawObjects is never tested on a drawn node that has children
`client/test/drawBudget.test.ts:51`

**Claim:** All six countDrawObjects cases use leaf Meshes/Lines/Points/Sprites under Groups. Nothing pins that the walk descends INTO a counted node — which is the common plugin shape (a baked model is a Mesh with Mesh children; pilgrims/monsters/temples all nest). Verified by probe: the implementation does return 3 for a Mesh with two Mesh children, but no committed test observes it.

**Scenario:** Mutation: `if (…isMesh…) return 1;` — an early return instead of falling through to the child loop. All tests pass; every plugin whose rig nests meshes under a mesh under-counts by its whole subtree, so a plugin can sit far over its budget and the sampler reports it comfortably under, which is the exact failure the budget exists to catch.

**Skeptic:** Not refuted. In client/src/plugins/host.ts:63-78 the counted-node branch falls through to the child recursion, but no test in client/test/drawBudget.test.ts ever puts a drawn node (Mesh/Line/Points/Sprite/InstancedMesh) above children — the only nesting cases (lines 61-66, 68-80) hang meshes under Groups, and the sampler's `filler` adds flat meshes to the layer. An early-return mutation after `drawn = 1` would leave the whole committed suite green while under-counting every nested plugin rig.

## 11. [medium/tests] The frame total's `objects` is indistinguishable from the sum of the plugin rows in the test rig
`client/test/drawBudget.test.ts:299`

**Claim:** `sampleDrawObjects` publishes `objects: countDrawObjects(viewport.scene)` and documents core's objects as 'the remainder — the scene minus the plugin layers'. `stubViewport` builds a bare `new Scene()` whose only children are the plugin layers the host adds, so the scene walk and the row sum are numerically identical (3 = 3) in the only test that asserts it. Core's contribution to the frame's object count is never observed.

**Scenario:** Mutation: `objects: rows.reduce((n, r) => n + r.objects, 0)`. Tests pass. In the real client the HUD then shows ~a few dozen plugin objects against a budget that includes core's 355 — the number the frame is judged by is off by core's entire contribution (measured 351 objects, 319 of them the layer-edge overlay), so the one figure meant to expose a draw-call regression cannot.

**Skeptic:** Confirmed: `stubViewport` (client/test/drawBudget.test.ts:178-199) builds a bare `new Scene()` and the only scene children are the plugin layers the host attaches, so the scene walk at client/src/plugins/host.ts:701 returns exactly the plugin-row sum; the single `frameDraw()` assertion (drawBudget.test.ts:308) is `objects: 3` against one plugin row of 3, and no test ever adds a non-plugin object to the stub scene (no `scene.add` outside the countDrawObjects unit tests). A mutation replacing the scene walk with `rows.reduce((n, r) => n + r.objects, 0)` therefore passes the whole suite, so core's contribution to the frame object count — the remainder the doc comment defines — is untested. The rig also sets `coreDrawBudget: () => 0`, so the frame budget in that same assertion likewise carries no core component.

## 12. [medium/tests] The sampler's window is never observed to reset, and 'once per window' is not asserted
`client/test/drawBudget.test.ts:311`

**Claim:** The title says 'once per window' but the test calls `window()` once and asserts the published state; the only sub-window test runs two frames before any sample has ever fired (clock still 0). No test runs a frame inside a window that has already sampled.

**Scenario:** Mutation: delete `sampleWindowStartMs = nowMs;` (host.ts:719). All tests pass; in the client every frame after the first 500 ms performs two full scene walks plus a Solid signal write — a ~0.05 ms/frame tax and a HUD re-render every frame, from the sampler that was budgeted at twice a second.

**Skeptic:** Verified in the worktree: host.ts:715-720 resets sampleWindowStartMs at line 719, and no test covers it — drawBudget.test.ts:311-316 runs both frames at clock 0 (no sample has fired yet), and the breach test at :318 advances a full FPS_SAMPLE_INTERVAL_MS per window() call, so with line 719 deleted the start stays 0 and every window still fires, leaving all three assertions green. No other test file references the sampler (grep for FPS_SAMPLE_INTERVAL_MS / sampleWindowStart). The described mutation therefore survives, and the per-frame double scene walk plus signal write it causes is real.

## 13. [low/tests] A non-finite budget never reaches the host — only the pure step function
`client/test/drawBudget.test.ts:160`

**Claim:** B6's 'a missing budget is a breach' is covered only against `stepDrawBudgetBreach` directly, and `frameDrawBudget` is tested to exclude it from the total. No sampler test mounts a plugin with a non-finite `drawBudget`, so the path that actually matters for the design-Q6 runtime-loaded plugin — row published, breach flagged, error logged — is unexercised.

**Scenario:** Mutation: add `if (!Number.isFinite(entry.plugin.drawBudget)) continue;` at the top of the sampler's per-plugin loop. All tests pass; a runtime-loaded plugin with no budget is silently omitted from the HUD rows and never logs, which is precisely the case the 'missing budget is itself a breach' rule was written for.

**Skeptic:** Confirmed by reading both files: the only non-finite-budget mount is in the frameDrawBudget suite (client/test/drawBudget.test.ts:238-249), which never runs the sampler, and every sampler test uses a finite budget (client/test/drawBudget.test.ts:299-336). The proposed mutation — an early `continue` for non-finite `entry.plugin.drawBudget` at the top of sampleDrawObjects (client/src/plugins/host.ts:680-684) — would drop the HUD row and suppress the console.error while leaving all tests green. The file's own caveat comment (lines 251-261) excuses only the missing registry-wide test, not this sampler path.

## 14. [low/tests] Unmount cleanup of the draw row and breach state is untested
`client/src/plugins/host.ts:631`

**Claim:** B3.3 requires the row to be removed on `unmountPlugin` 'like its panels'. `removePluginDrawRow` and `breachStates.delete` are exported and called but no test unmounts a plugin and inspects `pluginDrawRows()`; likewise `stopSampling()` in `dispose()`.

**Scenario:** Mutation: delete both cleanup lines (and `stopSampling()`). All tests pass. After `syncLivePlugins` drops a plugin, its row keeps showing a stale objects/budget pair (until the next window, and forever for the breach state a returning plugin inherits), and a disposed host keeps walking a dead scene every frame.

**Skeptic:** Confirmed the gap: the syncLivePlugins test in client/test/drawBudget.test.ts (lines 226-235) asserts only frameDrawBudget(), never pluginDrawRows(), and no test in the file calls dispose() or unmounts a plugin and then inspects rows — deleting host.ts:631-632 (removePluginDrawRow/breachStates.delete) or host.ts:770 (stopSampling()) leaves every test green. The consequences are real but small: breachStates (host.ts:241) is per-host, so a re-mounted plugin inherits its old breach state and never re-logs, and a stale row persists only until the next sampling window.

## 15. [low/tests] `lastUpdateMs` is documented as unconditional but only ever tested with a live dirty set
`client/src/render/terrainMeshes.ts:1657`

**Claim:** The comment states it is set 'BEFORE the loop and unconditionally, including for a dirty set that is entirely locked chunks: the quiet test asks when the terrain was last ASKED to change'. The only test exercising it (`does not grow before TERRAIN_QUIET_MS…`) passes a dirty set containing a received chunk.

**Scenario:** Mutation: move `lastUpdateMs = now();` inside the loop, after the `if (!mirror.received.has(chunkIdx)) continue;` guard. All tests pass. On the frontier, a stroke over locked/unreceived chunks stops refreshing the quiet timestamp, so `settle()` fires mid-stroke and takes the full-super-mesh `bufferData` on a frame the player is watching — the defect, reintroduced through the one branch the comment says was thought about.

**Skeptic:** Confirmed: the only quiet-window test (client/test/terrainMeshes.test.ts:1428-1450) drives `update` with a diff on the received ORIGIN chunk, and the one test about unreceived indices (line 274) never touches settle/growths, so moving `lastUpdateMs = now()` past the `if (!mirror.received.has(chunkIdx)) continue;` guard (terrainMeshes.ts:1657-1661) survives the suite. The scenario is reachable: `update` receives whatever chunk indices a diff dirties, including locked/unreceived ones (the guard exists precisely because those arrive), so a stroke landing only on such chunks would stop refreshing the quiet stamp and let `settle`'s full-super-mesh `bufferData` fire mid-stroke. The comment explicitly claims the entirely-locked dirty set was considered, but nothing pins it.

## 16. [low/tests] Only one of the two 'splice' growth callsites is tagged-tested
`client/test/terrainMeshes.test.ts:1533`

**Claim:** 'counts a growth taken during a splice as a STROKE growth' grows chunk `a` whose run is not at `liveEnd` (a=0..1500, b=1500..3000), so it exercises the relocate branch's `ensureSuperCapacity(sm, sm.liveEnd + count, 'splice')` only. The case-3 callsite (`slot.offset + old === sm.liveEnd`, terrainMeshes.ts:1233) has no test that its growth is charged to `strokeGrowths`.

**Scenario:** Mutation: change the case-3 callsite's site argument to `'settle'`. All tests pass; a stroke that grows the last run in a super-mesh — the commonest growth shape, since the newest chunk is usually at the live end — is reported as planned headroom growth, and A6's `strokeGrowths === 0` bench/probe assertion goes green while the stroke is still reallocating.

**Skeptic:** The tagged-growth test (client/test/terrainMeshes.test.ts:1521-1537) grows chunk a whose run is 0..1500 while b occupies 1500..3000, so slot.offset+old (1500) !== sm.liveEnd (3000) and control falls to the relocate/append branch, hitting only ensureSuperCapacity(..., 'splice') at terrainMeshes.ts:1261. A repo-wide grep shows strokeGrowths is asserted in only four places: line 1364 (expects 0 after settle) and 1594 (a delta against a captured value), both of which stay green if terrainMeshes.ts:1233 were mistagged 'settle', plus 1531/1536 which exercise the case-5 path. The case-3 callsite's charge to strokeGrowths is therefore unpinned by any test, as claimed.

## 17. [low/tests] Every tuned constant is recomputed from itself, so no test pins a value
`client/test/terrainMeshes.test.ts:1304`

**Claim:** `expectedHeadroom` derives the expected value from `ARENA_HEADROOM_RUN_MULTIPLE`/`ARENA_HEADROOM_FLOOR_TRIANGLES`; the hysteresis suite derives `LOW` from `DRAW_BUDGET_CLEAR_MARGIN` and loops `DRAW_BUDGET_CLEAR_SAMPLES` times; the quiet test advances by `TERRAIN_QUIET_MS`. This is right for the RULE but means the measured numbers (p90 run 13 653 triangles, ×2, 800 ms, 0.1, 2) are unpinned. Also unpinned: `ARENA_HEADROOM_FLOOR_TRIANGLES === ARENA_HEADROOM_RUN_MULTIPLE * ARENA_P90_RUN_TRIANGLES`, and `TERRAIN_QUIET_MS === 2 * SCULPT_REPEAT_DELAY_MS`.

**Scenario:** Mutation: `ARENA_P90_RUN_TRIANGLES = 137` (a typo dropping two digits) or `DRAW_BUDGET_CLEAR_MARGIN = 0.9`. Every test passes; the floor collapses to 822 vertices, super-meshes get effectively no headroom, and strokes reallocate again with the suite green. One cheap assertion per constant (the literal, with the date/run it came from) would close it.

**Skeptic:** Half-refuted but the core stands: no test pins any literal (grep for 13_653/0.1/400 in client/test finds none), and the `DRAW_BUDGET_CLEAR_MARGIN = 0.9` mutation genuinely passes the whole hysteresis suite — LOW becomes 9 and the guard at client/test/drawBudget.test.ts:150 (`99 > 100*0.1`) still holds. The other example is wrong: `ARENA_P90_RUN_TRIANGLES = 137` would fail client/test/terrainMeshes.test.ts:1356-1358, which asserts `2 × SMALL_RUN (3000 verts) < floor (822 verts)`, so the digit-drop typo is caught. Finding is real but its ARENA example should be dropped.

## 18. [low/tests] 'flush() does not call settle()' is a named A3 rule with no test
`client/src/render/terrainMeshes.ts:1667`

**Claim:** A3 makes it explicit that `flush()` must not settle, because on the no-scheduler path `update` → `flush` runs on every sculpt step. No test asserts it, and the quiet gate would mask the mutation anyway on the fixtures used (`arenaSetup` runs `update` and `flush` back to back, so `now() - lastUpdateMs` is ~0).

**Scenario:** Mutation: add `settle();` at the end of `flush`. All tests pass. On any no-scheduler consumer (preview harnesses, bench, the `meshes` bench row) a pause of more than TERRAIN_QUIET_MS between strokes puts a full-super-mesh reallocation inside the next sculpt step's flush, and the bench measures it as sculpt cost.

**Skeptic:** Verified: the A3 rule is only a comment (client/src/render/terrainMeshes.ts:1624-1626) and settle's own guard `now() - lastUpdateMs < TERRAIN_QUIET_MS` (line 1631, 800 ms via SCULPT_REPEAT_DELAY_MS=400) would swallow the mutation on the no-scheduler fixtures, since `update` sets lastUpdateMs then immediately calls flush (line 1665) and `now` falls back to real performance.now (line 1424). No test exercises flush after a quiet gap — the only `meshes.flush()` in the suite is client/test/terrainMeshes.test.ts:860, which asserts only builtChunkCount/pendingCount, and every settle test drives the scheduler path where update never calls flush. So adding `settle();` to flush would keep the suite green; the finding is not refuted.

## 19. [low/tests] B6's registry-driven 'every registered plugin's drawBudget is finite' test is absent
`client/test/drawBudget.test.ts:253`

**Claim:** The file documents its absence as a harness limit; I verified the claim — importing `../src/plugins/registry.ts` from a client test fails in `vite:import-analysis` on `plugins/chronicle/client/ChroniclePanel.tsx`, because client/vitest.config.ts wraps the base config with no JSX/Solid plugin at all. The mitigation stated (the type makes the field mandatory) is real, and all 17 declared budgets are products of statically-typed named constants, so the residual NaN risk is small.

**Scenario:** A future budget written as an expression that is `number`-typed but NaN at runtime (e.g. a cap read from a JSON payload, or a circular import resolving to `undefined` at module-init order) is registered, typechecks, and is silently excluded from `frameDrawBudget` while its own row breaches — with nothing failing in CI. Closing it needs one line of vitest config (a JSX transform for plugins/**) or a plain-node check, not a new test harness.

**Skeptic:** I reproduced the harness limit exactly: a temporary client test importing `../src/plugins/registry.ts` fails in `vite:import-analysis` on `plugins/chronicle/client/ChroniclePanel.tsx:103`, and `client/vitest.config.ts` merely wraps `vitest.base.config.ts` (a plain `{test:{testTimeout}}` object) with no Solid/JSX plugin, so B6's registry-wide "every registered plugin's drawBudget is finite" assertion genuinely cannot exist as written — the comment at client/test/drawBudget.test.ts:253 documents its own absence. The failure scenario is live: client/src/plugins/host.ts:665 adds a plugin's budget to `frameDrawBudget` only `if (Number.isFinite(declared))`, so a future `number`-typed-but-NaN budget is dropped from the frame total with no CI signal, and only client/src/plugins/host.ts:130 flags it at runtime in that plugin's own row. Severity is fairly rated low, since all currently declared budgets are statically-typed named constants.

## REFUTED: A plugin sitting at its declared ceiling breaches, because budget is a max but the test is `>=`
Not a deviation: the spec itself dictates the `>=` test — docs/plans/frame-budget-growth-and-draw-calls.md B3.4 reads "A breach is reported on the first sample with `objects ≥ budget`", and host.ts:131 (`if (objects >= budget) return { breached: true, ... }`) implements exactly that, with the rationale spelled out in its own comment ("a budget is a ceiling, and reaching it is already the failure"). The declared budgets likewise come straight from the B7 table the same spec authorises. Whether a ceiling-touching plugin ought to log is a design objection to B3.4, not a conformance gap in the implementation — and the spec's own B7 note 4 already records that the declared totals are not yet real ceilings.

## REFUTED: Core's draw budget is a live count of core's own objects, so core can never breach
Not a spec deviation: the plan itself prescribes exactly this — step B5 (docs/plans/frame-budget-growth-and-draw-calls.md:256-259) says "Core's contributors each get a `drawCallCount()` or a named constant (`BRUSH_PREVIEW_DRAW_OBJECTS = 4`, …) — the same ratchet, no pass for core", and world.ts:855-863 / main.tsx:81-84 implement precisely that (terrainMeshes.ts:1714 `superMeshes.size`, frontierFog.ts:739, layerEdgeOverlay.ts:404 `meshes.size + grabbed`, plus the two named constants). The self-licensing property is a weakness of the spec, faithfully implemented, and the plan already records it — ticket 4 (line 404) states the declared total "is therefore not yet a ceiling anything can breach" and defers `FRAME_DRAW_CALL_CEILING`, while ticket 1 (line 391) names the 319-per-chunk layer-edge overlay as the finding to fix rather than to bound. The described scenario (core quadruples, no breach) is therefore true but is the specified behaviour, not a conformance defect.

## REFUTED: Plan Order inverted: B7 filled in the last commit, and step 0's probe patch is not in the repo
The failure scenario cannot occur: `.gpu-perf/perf-probe.patch` exists in the shared checkout and contains the per-layer walk (6 `countDrawObjects`/`drawObjectsByLayer` hits), and the bench exists as `client/test/zz-perf-sculpt.bench.test.ts`, so both verifications are re-runnable. Neither is a missing deliverable: the plan itself names `.gpu-perf/perf-probe.patch` as the location (docs/plans/frame-budget-growth-and-draw-calls.md:272-273) while `.gitignore` classes `.gpu-perf/` as a throwaway rig, and the project CLAUDE.md bars committing unrequested tests — so leaving both untracked is conformance, not deviation. What remains is only that the B7 record commit (e514d3b) landed after the code commits, a docs sequencing point with no consequence given the artifacts above.

## REFUTED: TERRAIN_QUIET_MS's derivation comment cites the wrong module for its source constant
The parenthetical names the module that *owns the repeat schedule*, not the file where the literal is written — the same convention config.ts itself uses for this exact constant ("see SCULPT_REPEAT_DELAY_MS and SCULPT_REPEAT_RAMP_FACTOR — input/sculptInput.ts owns the schedule", client/src/config.ts:236-238), so it is consistent, not stale. The definition site is unambiguous from the import two hundred lines up (client/src/render/terrainMeshes.ts:144, `import { SCULPT_REPEAT_DELAY_MS } from '../config.ts'`), and the derivation the plan requires (2× the slowest inter-intent gap) is present and correct. A reader following the pointer lands on sculptInput.ts:165-176, which is where the ramp actually is; nothing there invites editing the wrong constant.

