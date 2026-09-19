# Plugin frame isolation #2: background decision/prep vs onFrame apply-only

Date: 2026-09-18. Status: sketch (drafted by subagent, reviewed; not implemented).
Related: #1 (host frame time-box + skip) in progress in worktree
`.claude/worktrees/plugin-frame-budget`, branch `plugin-frame-budget`.

## Problem

Client plugin `onFrame` handlers run synchronously and unbounded inside
`renderFrame` (`client/src/render/scene.ts`), directly before
`renderer.render()`. One slow plugin spends the whole ~7ms / 140fps budget
(`docs/DESIGN.md`). Measurement exists but enforces nothing:
`recordPluginFrame` → `frameStats.plugins[]`, `drawBudget` object-counts that
only log. Optimizing individual plugins is not converging because costs add
linearly on the frame (wildlife/monsters per-entity ground sampling,
structures rebuilds, flora placements).

#1 caps the bleeding (host skips an over-budget plugin for N frames). This doc
(#2) is the structural fix: move decision/prep off the frame so `onFrame`
becomes apply-only. Mirrors the terrain pattern
(`terrainMeshes.ts:drain(CHUNK_SPLICE_FRAME_BUDGET_MS=1.5)` + backlog cap +
compact budgets). No `DESIGN.md` change — fits "budgeted or moved off the
frame".

## 1. Proposed API (`client/src/plugins/types.ts`)

```ts
interface BackgroundSlice {
  readonly timeLeftMs: () => number;
  readonly generation: number;
  readonly frameIndex: number;
  readonly isCancelled: () => boolean;
}
onBackgroundTick(handler: (slice: BackgroundSlice) => void): () => void;
```

- Mirrors `onFrame`: deferred registration in `mountPlugin`, try/catch +
  timing wrapper, unregister via existing `track()/undo[]`. `dispose`/unmount
  cancels; `resetWorld` bumps generation; in-flight slices observe
  cancellation via `isCancelled()`.
- Ordering: `onMessage`/`onWorldReset` stay synchronous and immediate.
  Background ticks never run re-entrant with `onFrame`; they mutate plugin
  scratch only. `onFrame` (pose/draw phases unchanged) reads the last
  *completed* output — never partial. Convention: double-buffer
  (`pending` → `applied` swap only at slice completion).
- No `dt` in background. Apply integrates with its own clamped step
  (existing `MAX_ANIMATION_STEP_SECONDS` pattern); background stamps outputs
  with source `frameIndex`, apply uses its stored `sinceFullSeconds`
  accumulator. If `frameIndex - appliedFrame > 2`, apply snaps instead of
  smoothing (same as the existing hold-path bail).

## 2. Host scheduler (`client/src/plugins/host.ts`)

- Pump lives in host, not the `scene.ts` hot path: `requestIdleCallback`
  with `setTimeout(0)` fallback, plus one guaranteed small pre-pose drain via
  the existing `viewport.onFrame` so background never starves under sustained
  load. No `scene.ts` change expected.
- Budgets: total pump `BACKGROUND_FRAME_BUDGET_MS = 3`, per-plugin
  `BACKGROUND_PLUGIN_SLICE_MS = 1`. Handlers loop
  `while (timeLeftMs() > 0 && cursorHasWork)` and return; host round-robins
  plugins per pump with a deficit flag (exhausted slice → back of queue).
- Backlog cap per plugin (mirror `CHUNK_ANSWER_BACKLOG_CAP = 8`): over-cap
  coalesces (drop oldest, count `coalesced++` for stats).
- Check `timeLeftMs()` every N entities, not per entity
  (`performance.now()` per entity shows up at these counts).

## 3. Migration path (wildlife pilot)

Before: `renderFrame` does `interpolator.sample()` + per-entity
`walkerGroundY`/`swimmerSeabedY` + `models.draw` in one `onFrame`
(`plugins/wildlife/client/index.ts`).

After:

- `onBackgroundTick`: cursor over a *copied* snapshot of sampled ids
  (persist `nextId` across slices); per slice, amortize: compute `terrainY`,
  `drawnX/Y/Z`, `phase`, gait → write into `pendingPoses: Map<id, Pose>`.
  Swap to `readyPoses` when the cursor completes a pass.
- `onFrame` apply-only: `interpolator.advance(dt)` + `reconcileViews` stay
  (cheap), `models.beginFrame/draw/endFrame` from `readyPoses` only.
  Hold-path (`!full`) unchanged — it already reads `view.drawnY`.
- Monsters same shape (`monsterOriginY` + `followGroundY` prep moves
  off-frame; `root.position.set` stays).

## 4. Observability

- `frameStats.ts`: add `recordPluginBackground(name, ms)` mirroring
  `recordPluginFrame`; extend `PluginFrameCost` with `bgMsPerFrame`
  (`msPerFrame` stays apply-only). `closeWindow` aggregates both, sorts by
  total.
- HUD (`VersionWatermark.tsx` + `pluginDrawRows`): row becomes
  `wildlife 0.35 bg + 0.12 apply (7%)`. Breach logging mirrors
  `stepDrawBudgetBreach` with `DRAW_BUDGET_CLEAR_SAMPLES` clear semantics.

## 5. Rules for background handlers (binding)

- Read-only world access plus private scratch. Forbidden in background:
  `layer.add/remove`, three mutations, `models.draw`, `setSkyRig` /
  `modulateSkyRig`, `markPickable` mutation, audio, `send()`.
  Background decides, apply commits: `publishMovers` poses,
  ground-shade arrays, pickability occupancy and sky writes are swapped or
  published only in apply, atomically at slice completion.
- Slices capturing `terrainRevisionAt`/`drawnGroundYAt` validate
  `generation` before swap, else discard (same id-keyed-state rule as
  `resetWorld`). Pump skips `pendingMounts`; handlers start after
  `finishMount`, like deferred frame handlers.

## 6. Review amendments (why #2 as drafted needed them)

1. `isCancelled()` is a getter, not a snapshot boolean, so a mid-slice
   `resetWorld` is observed.
2. Background iterates a copied id snapshot — `advance` + `reconcile` stay
   in apply and mutate the live map the background must not traverse.
3. Background/apply mutation split (above) is a contract, not a convention;
   document it on `onBackgroundTick`.
4. Still main-thread idle time, not a Worker — paces frames, does not reduce
   total CPU. Stated so nobody expects throughput gains.
5. Guaranteed pre-pose drain must be adaptive off `outsideMsP50`, not a fixed
   1ms, or it re-spends the budget it protects.

## 7. File touch list

- `client/src/plugins/types.ts` — `BackgroundSlice` + `onBackgroundTick`.
- `client/src/plugins/host.ts` — registry, idle/timeout pump, budgets,
  backlog cap, `recordPluginBackground` wiring, breach states, generation
  cancellation.
- `client/src/render/frameStats.ts` — `recordPluginBackground`,
  `bgMsPerFrame`, aggregation.
- `client/src/ui/VersionWatermark.tsx` (+ `hudPanels.ts` row type if needed).
- `plugins/wildlife/client/index.ts` — pilot migration.
- `scene.ts` — no change expected.
