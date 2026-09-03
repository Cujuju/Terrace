# Report — the carve walks inward, lowers by default, hides Mode

Branch: `worktree-agent-ad08d84350c1dde3e`. Not merged to main. No app
started or stopped. No test added; no existing test needed changing.

## Commits

| Hash | Subject |
| --- | --- |
| `8c5ae39` | `fix(carve): the cut opens the band the pick names` |
| `8fcba7d` | `fix(carve): the carve lowers by default and hides Mode` |
| (this file) | `docs(carve): carve-review arc report` |

## Bug 1 — the cut opened a band above the band the pick names

### Verified at file:line before changing anything

- `client/src/world.ts:445-451` — `bandOfPick` on a riser hit is
  `Math.ceil(pick.hitY / (HEIGHT_WORLD_SCALE * BAND_HEIGHT))`, clamped to the
  struck span's drawn range. The band whose DRAWN SLAB contains the struck
  height. Unchanged, as instructed.
- `shared/src/columns.ts:392-408` — `spanIndexCoveringBand`: a span covers
  band k when `span.floor <= k·BAND_HEIGHT <= spanCapHeight(span)`. So "solid
  at band k" is about the boundary height `k·BH`, which is what makes the old
  bounds off by one band against the pick.
- `shared/src/heightmap.ts` (pre-fix) — `lo = spanBand·BH`,
  `hi = (spanBand + CARVE_BANDS_PER_STROKE)·BH`, anti-cheat loop over
  `spanBand+1 … spanBand+CARVE_BANDS_PER_STROKE−1`. Lower piece capped at
  `spanBand·BH` still covers band `spanBand`; roof floored at `(spanBand+2)·BH`
  covers band `spanBand+2`. Only `spanBand+1` opened.
- `shared/src/columns.ts:908-919` — `canCarveBandAt` is the eight-neighbour
  "already open there" rule, so the second cut, asking about a band no
  neighbour was open at, was refused.

Root cause, one sentence: the cut opened `spanBand + 1` while the pick names
`spanBand`, so the opening a cut left never named the band the next pick
inside it named, and the neighbour rule refused every cut after the first.

### Change — `shared/src/heightmap.ts`

- `shared/src/heightmap.ts:2552-2607` — `applyCarve` doc block rewritten. The
  sentence that stated "the cell is STILL SOLID at the grasped band" as the
  design is gone; the block now states the new cut, why the `− 1` is there
  (the slab convention `bandOfPick` uses), and that the DEPTH — and so
  `sculptDisplacementUnits`' price — is unchanged.
- `shared/src/heightmap.ts:2612-2628` — the bedrock paragraph updated: the
  anti-cheat is asked of `spanBand` upward, and the `lo <= BEDROCK_FLOOR`
  refusal now also (correctly) covers `spanBand === MIN_BAND + 1`, whose lower
  piece would be empty. The test itself is untouched.
- `shared/src/heightmap.ts:2635-2652` — the body:

  ```ts
  const lowestOpenedBand = spanBand;
  const highestOpenedBand = spanBand + CARVE_BANDS_PER_STROKE - 2;
  const lo = (lowestOpenedBand - 1) * BAND_HEIGHT;
  const hi = (highestOpenedBand + 1) * BAND_HEIGHT;
  ```

  Named locals rather than a bare `- 1`, and the anti-cheat loop
  (`shared/src/heightmap.ts:2679`) is now `for (let band = lowestOpenedBand;
  band <= highestOpenedBand; band++)` — derived from the SAME pair as the
  bounds, which is the contract-level fix: the two can no longer drift apart.
- `lo <= BEDROCK_FLOOR` refusal (`shared/src/heightmap.ts:2660`) and the
  `spanIndexCoveringBand` centre guard in `applySculpt` are unchanged.
- `CARVE_BANDS_PER_STROKE`'s comment (`shared/src/heightmap.ts:224-251`) was
  re-checked and left alone: its derivation is measured in band COUNT against
  a column capped at band 10 and never names a grasped band, so the new
  alignment does not touch it. Depth is still 2 bands.

## Bug 2 — the carve required the lower chord

### Verified at file:line

- `client/src/input/sculptInput.ts:942` (`onPointerDown`) —
  `resolvePress(event.button, event)`; `client/src/state/controlPrefs.ts:262-275`
  with the default bindings resolves left+none to `raise`.
- `client/src/input/sculptInput.ts` (pre-fix `emitIntent`) —
  `if (strokeTool === 'carve' && sculptDirection(action) > 0) return;` dropped
  every unmodified carve press.
- pre-fix `currentStrokeAction` re-resolved the modifier on every repeat, so
  releasing shift mid-carve flipped the stroke to `raise` and the rest of it
  was dropped.
- `startStroke` and `emitIntent` both called `setSculptMode(action)`, and
  `client/src/state/hudState.ts:469` shows `sculptMode` is the persisted,
  storage-backed signal shared by every tool.

### Change

The fact "which tools have no direction" now lives in exactly one place:

- `shared/src/heightmap.ts:200-222` — new `TOOLS_WITHOUT_DIRECTION`
  (`['carve']`), beside `TOOLS_WITHOUT_EDGE_PROFILE`, exported through
  `shared/src/index.ts`'s `export *`. Its doc says why `drag` is NOT in it.

Read by:

- `client/src/input/sculptInput.ts:862-869` (`startStroke`) — `strokeTool` is
  resolved first, then a direction-less tool's stroke is pinned to `lower` and
  `setSculptMode` is NOT called; every other tool keeps exactly the old two
  lines.
- `client/src/input/sculptInput.ts:875-879` — `takeHold(strokeAction)` rather
  than `takeHold(action)`, so its raise-only seeding rescue sees the direction
  the stroke will actually sculpt in.
- `client/src/input/sculptInput.ts:490` (`currentStrokeAction`) — a
  direction-less tool's stroke is never re-resolved from the modifier.
- `client/src/input/sculptInput.ts:529` (`emitIntent`) — `setSculptMode` is
  skipped for those tools.
- `client/src/input/sculptInput.ts:547` (`emitIntent`) — the `dir > 0` refusal
  KEPT, now off the shared list, with its comment saying it is unreachable and
  why it stays (it is the one function that puts a sculpt on the wire, while
  the pinning lives in two places).
- `client/src/input/sculptInput.ts:918` (`syncMode`) — **beyond the brief, and
  deliberate**: `syncMode` wrote the persisted `sculptMode` on every modifier
  event regardless of tool. With the Mode row hidden (bug 3) that is a hidden
  control mutating a persisted setting — tap shift with Carve up, switch to
  Stamp, and the stamp digs. Same failure the brief names for the carve
  stroke, same one-line fix off the same constant.
- `client/src/input/sculptInput.ts:16-24` — the file-header control scheme now
  states the tool-owns-the-direction rule.

Wire contract unchanged: `dir: -1`, and `shared/src/protocol.ts:528`
(`if (tool === 'carve' && dir === 1) return null;`) is untouched.

`takeHold` / camera checked, not changed: `client/src/input/cameraBindings.ts:31-47`
maps a press to a camera verb through the SAME `resolvePress`, and returns
`null` for anything that resolves to `raise` or `lower`. Left+none resolves to
`raise` and left+shift to `lower` — both sculpt-owned, so the camera stands
down for either, and both now carve. `takeHold` returns immediately for any
tool that is not `drag`, so a carve press grabs nothing, as before.

## Bug 3 — the HUD showed Mode for the carve

- `client/src/ui/Hud.tsx:396-425` — the Mode row is wrapped in
  `<Show when={!TOOLS_WITHOUT_DIRECTION.includes(brushTool())}>`, exactly as
  the Edge row at `client/src/ui/Hud.tsx:374` is wrapped in the
  `TOOLS_WITHOUT_EDGE_PROFILE` equivalent. REMOVED, not disabled, for the
  reason the Edge comment gives. `brushTool()` is called inside the JSX.
- `client/src/ui/Hud.tsx:100` — import extended.
- `client/src/state/hudState.ts` needed no change: the stored mode is
  untouched, so selecting Stamp again restores the player's last choice.
- `client/test/hudState.test.ts` asserts only the store's behaviour (no DOM,
  no assumption the row is rendered) and passes unchanged. There is no
  DOM-level HUD test in the repo.

## Verification

### `pnpm typecheck`

Green across every workspace package — no `error` or `Failed` line in the
output; last packages reported `server typecheck: Done`,
`plugins/wildlife typecheck: Done`.

### `pnpm test`

`pnpm test` recursive aborts in `plugins/fire` — **pre-existing and unrelated**:

```
plugins/fire test: No test files found, exiting with code 1
```

That package has no `*.test.ts` at all (its only `carve` hit is
`plugins/fire/server/spread.ts`, source). Nothing in this arc touched
`plugins/`. Packages run individually:

```
@terrace/shared:  Test Files  15 passed (15)
                       Tests  309 passed (309)

@terrace/client:  Test Files  1 failed | 27 passed (28)
                       Tests  1 failed | 503 passed (504)
```

The one client failure is `test/vertexGrid.test.ts > the blocky fallback >
keeps walls attributed to the higher cell, through the real picking`
(`expected +0 to be 16`, `client/test/vertexGrid.test.ts:1115`).

**Confirmed pre-existing, not this arc's breakage**, by A/B rather than by
inspection: with this branch's client edits stashed and
`shared/src/heightmap.ts` checked out at `HEAD~1` (the pre-fix state), that
same test fails identically — `Tests 1 failed | 64 passed (65)`. The file
contains no reference to `carve`, `sculptMode` or `TOOLS_WITHOUT_*`. Per
CLAUDE.md this is another agent's in-flight work; it is reported, not fixed.

### Reproduction — the cut walks inward

`.carve-chain.mjs` at the worktree root (the brief's script, re-pointed at
this worktree's `shared/src`): a cliff at band 10 over ground at band 2, the
player grabs the lowest lip (band 3) and each later pick is the back-wall
riser inside the opening the last cut left.

```
$ node --experimental-strip-types .carve-chain.mjs
cut x=10 spanBand=3: changed=1 -> [{"floor":-1536,"ceiling":32},{"floor":64,"ceiling":160}]
  opening [32, 48] -> next pick names band 3
cut x=11 spanBand=3: changed=1 -> [{"floor":-1536,"ceiling":32},{"floor":64,"ceiling":160}]
  opening [32, 48] -> next pick names band 3
cut x=12 spanBand=3: changed=1 -> [{"floor":-1536,"ceiling":32},{"floor":64,"ceiling":160}]
  opening [32, 48] -> next pick names band 3
cut x=13 spanBand=3: changed=1 -> [{"floor":-1536,"ceiling":32},{"floor":64,"ceiling":160}]
  opening [32, 48] -> next pick names band 3
cut x=14 spanBand=3: changed=1 -> [{"floor":-1536,"ceiling":32},{"floor":64,"ceiling":160}]
  opening [32, 48] -> next pick names band 3
cut x=15 spanBand=3: changed=1 -> [{"floor":-1536,"ceiling":32},{"floor":64,"ceiling":160}]
  opening [32, 48] -> next pick names band 3
```

Six cells, every one cut, and the pick names the same band every time — the
fixed point the brief predicted (`[-1536,32),[64,160)`, floor level with the
outside ground). Before the fix the same script cut once at `x=10` and was
refused at `x=11`.

## Not done, on purpose

- `docs/**` untouched, per the brief. The doc drift is the orchestrator's to
  flag: anything in `docs/` describing the carve as leaving the grasped band
  solid, or as requiring the lower chord, is now stale.
- No test added or changed. No existing test encoded the old alignment — the
  only carve test in `shared/test/heightmap.test.ts:2698` is the bedrock
  refusal, which is written against `lo` and passes unchanged. That the new
  behaviour has no test of its own is a real gap, named rather than filled,
  because adding one needs the owner's permission.
- `.carve-chain.mjs` left untracked, matching the repo's existing untracked
  `.verify-*.mjs` verification scripts.
