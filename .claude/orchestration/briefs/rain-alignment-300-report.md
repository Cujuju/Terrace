# Report — #300 rain column not aligned with its cloud deck

Worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12`,
branch `worktree-agent-a63416ea19b8c4c12`, fast-forwarded to main (`78b68a0`) before
any edit. NOT merged to main.

## Commits

| sha | subject |
|---|---|
| `c4d21b9` | `fix(kit): the rain column no longer double-counts the wind` |
| `996818b` | `fix(kit): the cloud deck is ordered against the camera, not sorted` |
| `f7d1669` | `docs(kit): name the deck ordering's one residual, the tier jitter` |

## A — the column's position double-counted the wind

**Verified from source before touching it.** At `fe93ae3`/main:

- `client/src/plugins/kit/precipitation.ts:280` — `const x = discX[i]! * radius + vx * aloft + sway;`
- `client/src/plugins/kit/precipitation.ts:286` — `vy * aloft +` in the `z` expression
- `client/src/plugins/kit/discRig.ts:149` — `root.position.set(disc.x * CELL_WORLD_SIZE, 0, disc.y * CELL_WORLD_SIZE);`
  — the rig root is already carried by the mass, and the column is a child of that root
  (`discRig.ts:120`, `root.add(column.object)`), so the two displacements added.
- `plugins/weather/server/wind.ts:39-40` — wind magnitude, confirmed as the brief states.

**Fixed** (`c4d21b9`):

- `client/src/plugins/kit/precipitation.ts:296-299` — the `x` term is now
  `discX[i]! * radius + sway`, with a comment naming the double-count.
- `client/src/plugins/kit/precipitation.ts:303-311` — the `z` term likewise; sway kept on
  both axes, quarter-cycle apart, unchanged.
- The `const aloft = driftSeconds(...)` line inside the loop is gone (`grep -n aloft` on
  the file now returns nothing). `driftSeconds` itself is **still exported**
  (`precipitation.ts:161`) with a rewritten doc (`:145-160`) saying it is pure fall time
  and that the wind no longer enters the position.
- Streak direction is byte-for-byte the same three lines
  (`precipitation.ts:283-286` in the old file → `:283-286` now, after the comment above them grew): `streakX/Y/Z` from
  `(vx, −fallSpeed, vy)` normalised. The `advance` doc (`precipitation.ts:167-174`) and
  the in-loop comment now state that the wind's ONLY effect here is the streak's tilt.

No existing test pinned the removed shear: the only `driftSeconds` assertion,
`plugins/rain/test/client.test.ts:224-229`, checks the pure function's value against
`PRECIPITATION_COLUMN_WORLD_UNITS / fallSpeed` and is untouched by this change (it passes).

## B — deck vs column draw order

**Verified from source before touching it.** At `fe93ae3`/main:

- `client/src/plugins/kit/discRig.ts:50` — `export const DISC_RENDER_ORDER = 1;`
- `client/src/plugins/kit/discRig.ts:119,122` — column and haze bank both built with
  `DISC_RENDER_ORDER`.
- `client/src/plugins/kit/cumulusDeck.ts:579` — `mesh.renderOrder = spec.renderOrder;`,
  and all three plugins passed `DISC_RENDER_ORDER` (`plugins/rain/client/rig.ts:132`,
  `plugins/snow/client/rig.ts:119`, `plugins/thunderstorm/client/rig.ts:525`).
- The deck's object position is the world origin (it is placed entirely from
  `uMassXZ` in the vertex stage, `cumulusDeck.ts:427-459`), while the rig's parts sit at
  the mass — so at equal `renderOrder` three's transparent sort (by object-centre view
  depth) decided the composite arbitrarily.
- Every column particle: `y = CLOUD_BASE_WORLD_Y − fraction * COLUMN` with
  `fraction ∈ [0,1)` (`precipitation.ts:136-142, 287`) → `y ≤ CLOUD_BASE_WORLD_Y`.
  Every puff: `DECK_BASE_WORLD_Y + aTier * DECK_THICKNESS + tierJitter`
  (`cumulusDeck.ts:455-459`) with `aTier ≥ 0`, and `DECK_BASE_WORLD_Y === CLOUD_BASE_WORLD_Y`
  (`cumulusDeck.ts:84`). The jitter is the one term that can put a bottom-tier puff a
  fraction below the plane (`DECK_TIER_JITTER_WORLD_UNITS`); it is small against the
  column's 28 units and does not change which side of the plane a *ray* sees first for
  any camera not inside the deck itself. **Stated, not glossed:** the argument is exact
  for the tiers and approximate to within the tier jitter at the base.

### 1. `ClientPluginCtx.cameraPosition()`

- `client/src/plugins/types.ts:392-411` — the accessor and its doc; it says explicitly
  that this answers an ORDERING question and is not a licence for camera-anchored layout
  (which `discRig.ts`'s header forbids), and that the returned object is shared scratch.
- `client/src/plugins/types.ts:126-138` — new `WorldPosition` interface (readonly triple).
- `client/src/plugins/host.ts:369-388` — implementation: one host-scoped scratch object,
  refilled from `viewport.camera.position` per call, no allocation.
  `client/src/plugins/host.ts:681` — wired into the ctx literal.

**Test fakes searched** (`grep -rn "ClientPluginCtx" client/test plugins/*/test`, plus
`grep -rln "revealedAt\|applyRevealClip\|pickWorldCell" client/test plugins/*/test`):
the only ctx-adjacent fakes are `client/test/groundShade.test.ts:180-188` (a `World` stub
cast `as unknown as World` — it does not enumerate `ClientPluginCtx`) and
`client/test/chart.test.ts:26` (a world-shaped literal, unrelated). **No fake enumerates
the interface, so nothing needed adding and no type was weakened.** `groundShade.test.ts`
passes unchanged: its stub viewport has no `camera`, and the accessor reads
`viewport.camera` lazily, only when a deck asks — which that test's plugins never do.

### 2. The two constants

`client/src/plugins/kit/cumulusDeck.ts:86-136`:

```
const DECK_ORDER_HALF_STEP = 0.5;                                    // :99
export const DECK_RENDER_ORDER_CAMERA_ABOVE_BASE = DISC_RENDER_ORDER + DECK_ORDER_HALF_STEP;  // :135
export const DECK_RENDER_ORDER_CAMERA_BELOW_BASE = DISC_RENDER_ORDER - DECK_ORDER_HALF_STEP;  // :136
```

Both relative to `DISC_RENDER_ORDER`, both positive (1.5 and 0.5), so the deck still
lands after the world-sized transparent sea whichever side of the plane the camera is —
the promise `DISC_RENDER_ORDER`'s own doc makes. `DISC_RENDER_ORDER` is **not** bumped;
`client/src/plugins/kit/discRig.ts:51-56` now points at the deck's argument.

`CumulusDeckSpec.renderOrder` is **removed**: the deck's place in the pass is now the
kit's contract, not three copies of one number in three plugins
(`plugins/rain/client/rig.ts`, `plugins/snow/client/rig.ts`,
`plugins/thunderstorm/client/rig.ts` each lost the `renderOrder:` line; rain and snow lost
the now-unused `DISC_RENDER_ORDER` import, thunderstorm still uses it for its bolt and
glow sheet).

#### Render-order table

| constant | file:line | before | after | note |
|---|---|---|---|---|
| `SMOKE_RENDER_ORDER` | `plugins/fire/client/smoke.ts:441` | −1 | −1 | untouched |
| `SCAR_RENDER_ORDER` | `plugins/fire/client/scar.ts:288` | −2 | −2 | untouched (`SMOKE − 1`) |
| sea (`render/water.ts`) | — | 0 | 0 | untouched |
| **deck, camera BELOW base** | `kit/cumulusDeck.ts:136` | — (was 1) | **0.5** | new |
| `DISC_RENDER_ORDER` (column, haze, bolt, glow) | `kit/discRig.ts:50` | 1 | **1** | unchanged |
| `SPIRAL_RENDER_ORDER` (cyclone) | `plugins/cyclone/client/spiral.ts:211` | 1 | 1 | untouched |
| `DREAD_RENDER_ORDER` (monsters) | `plugins/monsters/client/atmosphere.ts:101` | 1 | 1 | untouched |
| `LAVA_RENDER_ORDER` | `plugins/volcanoes/client/lavaFlow.ts:233` | 1 | 1 | untouched (opaque anyway) |
| **deck, camera ABOVE base** | `kit/cumulusDeck.ts:135` | — (was 1) | **1.5** | new |
| `FUNNEL_RENDER_ORDER` (tornado) | `plugins/tornado/client/funnel.ts:172` | 2 | 2 | untouched |
| `PLUME_RENDER_ORDER` (volcano ash) | `plugins/volcanoes/client/plume.ts:142` | 2 | 2 | untouched |
| `DEBRIS_RENDER_ORDER` (tornado) | `plugins/tornado/client/funnel.ts:173` | 3 | 3 | untouched |
| `RESTING_RENDER_ORDER` / `GRABBED` | `client/src/render/layerEdgeOverlay.ts:131,134` | 500/501 | 500/501 | untouched |

**What changes relative order with anything outside the kit: nothing.** That is the whole
reason for the half step. Every other `*_RENDER_ORDER` in the repo is a whole number and
each one states a relation to another whole number (tornado's funnel above cyclone's
spiral; debris above the funnel). The deck needs a slot immediately either side of
`DISC_RENDER_ORDER = 1`, and there is no integer between the sea at 0 and 1. Both of the
deck's orders therefore sit strictly inside gaps no integer occupies, so they can neither
tie with nor reorder any other plugin's slot. The deck's relation to every one of them is
what it was: below the funnel, below the plume, below the debris, above the sea and above
fire's smoke and scar.

Rejected alternative: bump `DISC_RENDER_ORDER` to 2 (or higher) and use integers either
side. Rejected because at 2 the rig ties with `FUNNEL_RENDER_ORDER`/`PLUME_RENDER_ORDER`,
and at 3 or above the rain haze would paint over a tornado funnel — inverting the relation
`funnel.ts:165-171` and `spiral.ts:207-211` each state in prose. A fix for #300 that
silently reorders two other plugins is not a fix.

### 3. One call, one place

- `client/src/plugins/kit/cumulusDeck.ts:412-422` — `CumulusDeck.orderAgainstCamera(cameraWorldY)`
  on the interface, with the plane argument in the file's own voice;
  `:738-743` the implementation (one comparison, one property write);
  `:638-641` the mesh is born at `DECK_RENDER_ORDER_CAMERA_ABOVE_BASE` rather than three's
  default 0, so a deck never sits under the sea for the frame before its first call.
- `client/src/plugins/kit/discSystemsView.ts:52-66` — `DiscSystemsViewSpec.deck?()`, a
  lookup (the deck is built inside `createPool`, which runs at attach).
- `client/src/plugins/kit/discSystemsView.ts:154-159` — the single call site, in
  `renderFrame`, before `frameExtras` and before the rigs update.
  `:114-118, 175, 187` — the ctx is held for the view's attached life so the frame can read
  the camera.
- `plugins/rain/client/index.ts:55-57`, `plugins/snow/client/index.ts:50-52`,
  `plugins/thunderstorm/client/index.ts:68-70` — each passes `deck: () => rigs?.deck ?? null`.
  **Three plugins, one call site.** Cyclone has no deck and passes nothing; nothing in
  `plugins/cyclone` changed.

### 4. Doc comments

Every touched contract carries the argument: `cumulusDeck.ts:86-136` (the plane argument,
why the half step, and the residual), `:412-422` (why once per frame for the whole plugin),
`discRig.ts:51-56` (the pointer), `discSystemsView.ts:52-66` (why the view owns the call),
`types.ts:390-411` (why a plugin gets the camera at all, and the scratch contract),
`host.ts:369-380` (why one host-scoped scratch).

## Gates

`pnpm typecheck` — every package `Done`, no `error`/`failed` line in the output
(`pnpm typecheck 2>&1 | grep -iE "error|failed"` → empty).

```
plugins/thunderstorm test:  Test Files  1 passed (1)
plugins/thunderstorm test:       Tests  17 passed (17)
plugins/rain test:  Test Files  2 passed (2)
plugins/rain test:       Tests  31 passed (31)
plugins/snow test:  Test Files  1 passed (1)
plugins/snow test:       Tests  11 passed (11)
```

`pnpm --filter @terrace/client test`:

```
 Test Files  2 failed | 29 passed (31)
      Tests  2 failed | 533 passed (535)
 FAIL  test/pickAgreesWithMesh.test.ts > pickTerrainCellByRay vs the mesh raycast it replaced > still agrees when the arena the rays cross is fragmented
 FAIL  test/vertexGrid.test.ts > the blocky fallback > keeps walls attributed to the higher cell, through the real picking
```

**Both are terrain-picking tests and neither can reach anything this branch changed.**
Their imports are `src/terrain/picking.ts`, `src/terrain/mirror.ts`,
`src/render/terrainMeshes.ts`, `src/config.ts` and `@terrace/shared`
(`pickAgreesWithMesh.test.ts:16-33`, `vertexGrid.test.ts:9-61`) — no plugin host, no kit,
no `plugins/types.ts` beyond an additive interface member. Reported as other agents'
in-flight work per the project CLAUDE.md rule, **not** verified against a clean checkout
of the base (I did not build a second worktree to do so) — so this is an argument from
the import graph, not a bisect.

No tests were added or written (owner rule).

## In-world verification

Own isolated stack, in the worktree: `.rain300-stack/launch.sh`, `stop.sh`, `shot.mjs`
(the phase-3 `shot.mjs`, copied). Game server on **2731**, **Vite DEV** on **2732** —
`ss -ltn` showed both free, and the owner's 2567/5173/8765/8766/8791/11434 were untouched.
Per the brief the client is served by `vite` dev, never `vite build`;
`VITE_SERVER_URL=ws://localhost:2731` pins the socket to this stack rather than
`config.ts`'s dev default 2567 (which is the owner's server). `WORLDS_DIR` and a
nonexistent `DB_PATH` both under `.rain300-stack/`.

Rain forced with **`RAIN_DEV_FORCE=1`** — the env var is
`plugins/rain/server/index.ts:87`, `RAIN_DEV_FORCE_ENV = devForceEnvName(RAIN_PLUGIN_NAME)`,
and `server/src/plugins/kit/devForce.ts:31-33` renders that as `RAIN_DEV_FORCE`.
(There is no `plugins/rain/server/dev.ts`; the switch lives in the plugin's `index.ts`.)
Server log line: `[terrace] [rain] RAIN_DEV_FORCE=1 — one rain system parked over the world centre`.

Shots, in `.verify-shots/rain-300/` (camera poses relative to the `rain:system` rig root;
`DECK_BASE_WORLD_Y` = 24):

| file | camera | what it shows |
|---|---|---|
| `1-above.png` | y = 120, looking down | Deck reads as puffs; **no rain streaks painted across its top**. Camera above the base → deck last. |
| `2-side-cloud-height.png` | y = 26/28, 95 units out | **The money shot.** The column falls straight down out of the deck's footprint, centred under it — no downwind offset — and no streak is painted on the cloud's face. |
| `3-below-base.png` | y = 3, 95 units out | Camera below the base → deck first, rig after: the streaks are correctly drawn IN FRONT of the cloud's underside, and land under it. |

Renderer snapshot at each pose confirmed `decks.rain = {instances: 973, visible: true}`
and no shader-compile line in the relayed page console. Stack torn down by pid
(`stop.sh`), both ports confirmed free. Wall clock on stack + shots: ~11 minutes, inside
the 20-minute cap.

## Left undone, deliberately

- **No test for the ordering contract.** The owner's per-session rule forbids writing
  tests; permission was not granted in this session. The contract that would want one is
  `orderAgainstCamera` (a pure `cameraY ≥ DECK_BASE_WORLD_Y` decision) — named here so it
  can be asked for.
- **The two failing client tests were not bisected** against a clean base checkout; see
  the argument above.
- **The tier-jitter caveat** on the plane argument (a bottom-tier puff can sit a jitter's
  worth below `DECK_BASE_WORLD_Y`) is documented in this report and in
  `cumulusDeck.ts:123-134` (commit `f7d1669`) as the residual, not silently ignored. It cannot re-produce
  the reported defect: the misordering it could cause is between one low puff and the top
  of the column at the same height, not between the column and the deck as bodies.
- **Not merged to main**, per the brief.
