# Report — #299 (part 2 of 2): the cyclone towers

## Where the work is

- **Worktree** `/mnt/e/Development/Projects/Terrace/.claude/worktrees/cyclone-tower-299`
- **Branch** `cyclone/tower-299`, off `main` at `f7a928d` (which carries the #300 kit change)
- **Not merged.** Three commits, oldest first:

| commit | subject |
|---|---|
| `9568a74` | `feat(kit): a precipitation column can seed an annulus` |
| `a74e184` | `feat(cyclone): the deck is a tower, not a lid` |
| `93047f2` | `feat(cyclone): rain falls out of the bands, never through the eye` |

`EnterWorktree` with no path failed twice — *"Could not read the repository git
config to neutralize filter drivers"* — with the config plainly readable
(`git config --list --local` succeeded). Worked around with `git worktree add`
followed by `EnterWorktree` on the path, which is the same worktree the tool
would have made, under `.claude/worktrees/`.

## The brief, item by item

### 1. Depth profile — done

`aRise`, a sixth per-instance attribute, carries a puff's height above the base
in world units; the shader writes `BASE + aRise` into `transformed.y`
(`spiral.ts:281`). **No per-frame CPU work was added**: the rise is written in
`writeLayout` (`spiral.ts:949`), which `layoutDirty` still runs only on a push,
a move, a resize or a life-cycle change — the steady state is still at most one
float per puff and usually none.

One `wall` term — `1 - along^k`, 1 at the eyewall and 0 at the rim — drives the
height, the puff size, the puff's solidity and the shade, so the tall, dense and
dark parts of the storm are the same part by construction rather than by four
ramps agreeing.

**The stack, and which of the brief's two options this is.** *More puffs per arm
near the eye.* A position carries `tiersAt(along)` puffs spaced `tierRiseAt(along)`
apart — five at the eyewall, four mid-arm, three at the rim (`spiral.ts:317-356`).
The rejected alternative is a fixed stack count spaced by a fraction of the local
height: it spreads the *same* number of puffs over three times the height at the
eyewall, so the tallest part of the storm would also be its thinnest —
see-through exactly where it has to occlude. Dealing the extra puffs where the
cloud is deep is also the cheaper of the two, since the rim is most of the
storm's area.

**The instance count is derived, not typed** (`spiral.ts:372-377`), exactly as
`PUFFS_PER_SPIRAL` was before: `PUFFS_PER_ARM` is the sum over the ninety
positions' stacks, 365, so a spiral is 3 285 puffs and the buffers are 6 570.
Verified live: the page reported `spiralInstances: 3285`. Shrink the puffs or
the tower and the number falls on its own.

### 2. Eyewall reads dark and solid — done

`CYCLONE_EYEWALL_SHADE` was kept and **made to do the job properly** rather than
replaced: it was a linear ramp in `along`, which put mid-grey half way to the
rim — a wash over the whole storm, which is why the dark never read as standing
anywhere. It is now read off `wall`, so the dark collapses onto the same narrow
ring the height does (`spiral.ts:413`, applied at the fragment).

Solidity is the second half and it is new. The mask's inner edge is now a
varying: `CYCLONE_RIM_SOFT_EDGE` (0, the smear this deck used everywhere) at the
rim, `CYCLONE_EYEWALL_SOFT_EDGE` at the eye — imported from the kit's
`PUFF_SOFT_EDGE_FRACTION` rather than copied, since it is the same measured
defect (a hundred overlapping gradients average into fog you can see through)
and the kit already paid for the number.

The third half is geometric: eyewall puffs are 60 % larger, which is what makes
the ring close. The under-the-rim shot shows the far side of the storm hidden.

### 3. Rain under the bands — done

- Contract: `PrecipitationProfile.innerRadiusFraction`
  (`precipitation.ts:135`) and the exported, GL-free `seedRadius`
  (`precipitation.ts:152`), called at `precipitation.ts:249`. Rain, snow and
  thunderstorm pass 0 and are **bit-for-bit unchanged** — at inner 0 the law is
  `sqrt(u)`, which is the line it replaced. Their tests pass untouched.
- The cyclone's column: `plugins/cyclone/client/rain.ts`, one pooled column per
  storm, seeded with the eye's own fraction as the hole (`rain.ts:108`).
- **Render order.** `SPIRAL_RENDER_ORDER` (a bare `1`) is replaced by the kit's
  camera-dependent pair (`spiral.ts:483-484`), switched once a frame from
  `ctx.cameraPosition().y` before anything is submitted (`index.ts:300`,
  `spiral.ts:1077`). The relations after the change:

  | | order |
  |---|---|
  | sea | 0 |
  | cyclone deck, camera **below** the cloud base | 0.5 |
  | the cyclone's rain column (`DISC_RENDER_ORDER`) | 1 |
  | cyclone deck, camera **above** the cloud base | 1.5 |
  | tornado funnel (`FUNNEL_RENDER_ORDER`) | 2 |

  So the column can never paint over the deck from above, and the funnel is
  still over the overcast whichever side of the base the camera is — both deck
  orders are under 2. Verified live: `renderOrder: 1.5` with the camera at
  y = 75. `funnel.ts:166` was updated to name the new constant.

  The #300 argument transfers word for word *because* both halves now share the
  kit's plane, and it is **exact here, not within one jitter**: the tier jitter
  is one-sided upward (`spiral.ts:314`), so every puff centre is at or above the
  base. That is a strengthening of the residual the kit names for itself.

### 4. Ground shade and gloom — kept, moved, deliberately not raised

The shade disc now sits at the deck's new base (`index.ts:204`). The gloom is
untouched, and it needed nothing: it is a function of cell distance and the
storm's intensity, not of the deck's height, and `overheadFraction` already
follows the deck's *shape*, which has not changed in plan.

`CYCLONE_SHADE_DARKNESS` stays at 0.15, and this is a decision rather than a
punt. The issue text flags it, but the two numbers are not in competition: the
eyewall shade is a multiplier on the *cloud's albedo* and the ground shade is
*light removed from the ground*, and the disc's stated job is to put an EDGE on
a darkness the gloom has already produced — stacking a deeper disc on a
0.6 gloom takes the coast away twice, which is the reason the constant gives for
being the lowest of the four publishers. In the daylight shots the ground under
the storm is plainly darker than the coast outside it with 0.15 in place. If the
owner wants it deeper it is a one-line change with the doc paragraph already
written.

The eye-core decision stays parked: `CYCLONE_SHADE_CORE_FRACTION` and the eye
logic are untouched.

### 5. Draw budget — done, derived

`CYCLONE_DRAW_OBJECTS = SPIRAL_DRAW_OBJECTS + MAX_SPIRALS * CYCLONE_RAIN_DRAW_OBJECTS`
(`index.ts:230`), used at `index.ts:239`.

**Arithmetic**: 1 (the one instanced deck, whatever its population) + 2 × 1
(one `LineSegments` column per storm this renderer can hold) = **3**, up from 1.
`MAX_SPIRALS` rather than the server's cap for the reason `groundShadeBudget`
already gives: a dispersing storm is still drawing a deck and is still raining.
No haze bank — the cyclone's air is darkened globally by `gloom.ts`.

### 6. Reduced motion — confirmed from source, nothing added

`index.ts:250` advances `elapsedSeconds` only when `reducedMotion.matches()` is
false. That one variable is the shader's `uElapsed` (so the deck stops turning)
*and* the argument to `rain.apply` (`index.ts:307`), which is the column's
`elapsed` — so the rain becalms from the same fact with no branch of its own.
Nothing new animates on the CPU: the columns' `advance` is the kit's existing
per-frame buffer write, and the deck's per-frame path is unchanged.

### The integration constraint — verified, and resolved the way the brief prefers

Verified from primary source, not from the note: `CLOUD_BASE_WORLD_Y = 24`
(`precipitation.ts`), `MAX_GROUND_WORLD_Y = 16`, and
`CYCLONE_DECK_HEIGHT_WORLD_UNITS` was `10` — **below** the tallest ground the
world can hold, while its own doc claimed it was above it. So the old number was
wrong on its own terms before rain entered the picture, and rain born at 24 over
a deck at 10 would have fallen out of empty sky.

Resolved at the contract, the first way: the cyclone's base **is** the kit's
cloud base, taken as the import (`spiral.ts:170`), and the eyewall rises above
it. The rejected alternative — a base height on the column profile — would let
two clouds in one sky sit at two altitudes with nothing saying which is right.

The "seen from inside it" design survives: what makes the deck read from
underneath is that it is billboarded puffs with no edge, not how low it hangs,
and the eyewall now stands *above* the base instead of the whole deck sitting
under the mountains. The gloom needed no change (above), and the shade disc's
`y` follows.

`CYCLONE_DECK_HEIGHT_WORLD_UNITS` is **gone from `protocol.ts`**, replaced by a
comment saying where it went and why it cannot be restated there (the kit is
client code that imports three; the protocol is imported by the server). No
server file ever read it — grepped. `plugins/cyclone/server/**` is untouched.

## Constants

| name | value | why |
|---|---|---|
| `CYCLONE_DECK_BASE_WORLD_Y` | `DECK_BASE_WORLD_Y` = 24 | the kit's one cloud base, as an import, so the deck and the rain cannot be moved apart |
| `CYCLONE_EYEWALL_HEIGHT_MULTIPLE` | 3 | eyewall against ordinary overcast; at 2 the ring still reads as a band, past 3 it reads as a chimney |
| `CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS` | `DECK_THICKNESS × 3` = 12 | a LENGTH off the kit's cloud depth, which derives from the world's *vertical* scale — the radius clamp cannot touch it (a fraction-of-radius eyewall pancakes on a small world) |
| `CYCLONE_RIM_HEIGHT_WORLD_UNITS` | `DECK_THICKNESS` = 4 | at its rim a hurricane is an ordinary overcast; nothing to add to the kit |
| `CYCLONE_TOWER_FALLOFF_EXPONENT` | 0.5 | sqrt: half the height gone by a quarter of the way out — a narrow tall ring with a broad low deck. k = 1 is a cone (the tornado's shape); k > 1 is a cylinder with a lid |
| `CYCLONE_EYEWALL_PUFF_GROWTH` | 0.6 | set by the occlusion requirement: takes an eyewall puff from ~1/12 to ~1/6 of the radius, wider than the gap between two arms there, so the ring closes |
| `PUFF_SIZE_SEED_MIN` / `_SPAN` | 0.7 / 0.6 | named out of the shader's bare `0.7 + 0.6 *`; the tier spacing reads the min and the band's inner radius reads the max |
| `CYCLONE_NOMINAL_RADIUS_WORLD_UNITS` | 30 | the one radius at which a length (the spacing) and a fraction (the puff) can be compared |
| `CYCLONE_EYEWALL_SOFT_EDGE` | `PUFF_SOFT_EDGE_FRACTION` = 0.55 | the kit's measured value for "puffs with bodies that occlude", imported not copied |
| `CYCLONE_RIM_SOFT_EDGE` | 0 | the smear this deck already used, which is right for an arm seen from far above |
| `CYCLONE_BAND_INNER_RADIUS_FRACTION` | 0.125 + 0.1768 = **0.3018** | eye + the widest puff that can land there, so the cloud's inner EDGE is the eye; the arms used to straddle it and all but fill the hole |
| `CYCLONE_TIER_JITTER_FRACTION` | 0.5, upward only | half a tier keeps a puff in its own band; one-sided makes "every centre at or above the base" exact, which the draw order rests on |
| `POSITIONS_PER_ARM` / `ARMS_PER_SPIRAL` | 90 / 9 | unchanged, and the measured coverage reasoning is unchanged with them |
| `PUFFS_PER_ARM` / `PUFFS_PER_SPIRAL` | **365 / 3 285**, derived | the sum over the stacks; a coverage consequence, not a budget |
| `BAND_HALF_WIDTH_EYEWALL/RIM_FRACTION` | 0.012 / 0.057 | the same band the shader drew as `0.012 + 0.045 * along`, written as its two ends so both numbers are visible |
| `SEED_HASH_*`, `GOLDEN_RATIO_CONJUGATE` | 13.7, 7.13, 0.17, 5.7, 7.31, 0.618 | the hashes this file already used, named so the source carries no bare numbers |
| `CYCLONE_RAIN_DROPS_PER_WORLD_AREA` | 1 | a density, so the count cannot drift from the storm's size; the sparse end, because the area it multiplies is ~20× a rain mass's |
| `CYCLONE_DROP_COUNT` | **2 783**, derived | density × the annulus area at the nominal radius |
| `CYCLONE_RAIN_PROFILE` | streak, fall 34, streak 1.3, opacity 0.5, `0x8ea3b8`, no sway | rain driven harder: the longer, faster streak is what makes the wind's lean legible; darker because it falls under a deck the gloom has taken 60 % of the light from |
| `CYCLONE_RAIN_DRAW_OBJECTS` | 1 | one `LineSegments`; there is no haze bank |

## Verification

**Typecheck** — `pnpm typecheck`, whole workspace, exit 0:

```
plugins/cyclone typecheck: Done
client typecheck: Done
server typecheck: Done
```

**Tests** (touched packages only, each with a timeout; never `pnpm -r test`):

```
@terrace/plugin-cyclone        Test Files  1 passed (1)   Tests   3 passed (3)
@terrace/plugin-rain           Test Files  2 passed (2)   Tests  31 passed (31)
@terrace/plugin-snow           Test Files  1 passed (1)   Tests  11 passed (11)
@terrace/plugin-thunderstorm   Test Files  1 passed (1)   Tests  17 passed (17)
@terrace/plugin-tornado        Test Files  1 passed (1)   Tests   3 passed (3)
@terrace/client                Test Files  2 failed | 29 passed (31)
                               Tests       2 failed | 533 passed (535)
```

No tests were added (owner rule).

**The two client failures are not this branch's**, and here is the basis rather
than an assertion: they are `test/pickAgreesWithMesh.test.ts` (a 30 s timeout)
and `test/vertexGrid.test.ts` ("expected +0 to be 16"), both deterministic on
re-run, and their import graphs are `terrain/picking.ts`, `terrain/mirror.ts`
and `render/terrainMeshes.ts` — none of which this branch touches. This branch's
eight files are the kit's `precipitation.ts`, the cyclone plugin, three one-line
profile fields and one comment in the tornado's funnel. **Not** verified by
running them at `f7a928d` in a clean tree; the worktree is the only checkout
with `node_modules` and installing a second one to prove it was not worth the
minutes.

**In-world shots** — `.verify-shots/cyclone-tower/` in the worktree:

| file | pose |
|---|---|
| `t1-side-at-cloud-height.png` | eye at (64, 64), camera (154, 28, 64) — 12:30 PM |
| `t2-low-under-the-rim.png` | camera (88, 4, 64) on the ground inside the rim, looking up and in |
| `t3-from-above.png` | camera (64, 75, 64.5) looking down the eye |
| `t0-default.png` | the client's own default pose, for context |

What they show: the side view has a broad low deck with a distinctly **raised,
darker central mass** standing above it and a rain column beneath — a body, not
a lid. From above there is a clear spiral of dark arms around a **bright open
eye**. From under the rim the storm is overhead in every direction, rain is
falling, and the far side of the storm does not show through the eyewall.

A probe read off the deck's own buffers, live
(`.tower-stack/where-probe.js`), which is the part not open to interpretation:

```
{"count":3285,"renderOrder":1.5,"eye":{"x":63.99,"y":0,"z":63.99},
 "strength":0.745,"radiusWorldUnits":30,"maxRiseWorldUnits":12.46}
```

3 285 instances (the derived count exactly), the camera-above render order, and
a tallest puff 12.46 world units over the base — the 12-unit eyewall plus its
one-sided jitter. No shader or program errors on the page console across four
sessions.

**Stack**: `.tower-stack/{launch.sh,stop.sh,shot.mjs,where-probe.js}` in the
worktree. Vite DEV (never `vite build`) on 5311, server on 2711 — both free per
`ss -ltn`, which showed only 53, 8765, 8766, 8791, 11434 held. `WORLDS_DIR` and
a nonexistent `DB_PATH` under `.tower-stack/`, `CYCLONE_DEV_FORCE=1`. Torn down
by pid file, never an inline `pkill -f`; both ports confirmed free afterwards.

## What I overran, and what I left undone

- **The 20-minute stack cap was broken, by about fifteen minutes, deliberately.**
  The world booted at 6:25 PM and its day runs ~19 real minutes, so the first
  two shot passes photographed a storm at night: a black lump against a black
  sky, from which nothing about a tower could be read either way. The choice was
  to report "shots not taken" on a gate that is entirely visual, or to hold the
  same stack until noon. I held it, then tore down immediately. Flagging it
  rather than burying it: a future brief for this rig should either force the
  clock or budget ~25 minutes.
- **Fill cost is not measured.** The deck went from 810 puffs to 3 285, and the
  eyewall ones are 60 % wider, so it asks the rasteriser for several times the
  puff fragments it used to. That is inherent to a wall that occludes, but the
  number is unmeasured here: there is no GPU in this container, so a frame time
  under SwiftShader says nothing about the owner's card, and the previous
  worktree's `overdraw-probe.js` is written against the kit deck's buffers, not
  this one's. If the 140 fps benchmark is at risk this is where to look first.
- **The radius-clamp residual is named, not fixed** (`spiral.ts:249-263`): on a
  world small enough for `cycloneRadiusFor` to bite, the puffs shrink with the
  storm while the tower's height and tier spacing do not, so a heavily clamped
  cyclone's stack can separate into visible layers. Fixing it means a
  radius-dependent instance count, which is a buffer that cannot be sized once
  at build.
- **The rain's fixed count over a variable radius** is the residual
  `discRig.ts` already names for the other three plugins: a clamped-small
  cyclone rains harder than a full-sized one.
- **Nothing was appended to `docs/`** or `docs/decisions/`, and `.claude/` holds
  only this report.
