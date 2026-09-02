# Phase 3 (i) report — core `revealClip` + `groundShade` (#284)

Worktree `.claude/worktrees/agent-a63416ea19b8c4c12`, branch
`worktree-agent-a63416ea19b8c4c12`. NOT merged. No server or client was started.
All paths below are relative to the worktree root; every `file:line` is the
state at `870f513`.

## Commits

| sha | what |
|---|---|
| `c39af60` | `test(render): contract tests for revealClip and groundShade` — tests (a)–(c), red at this commit |
| `870f513` | `feat(render): revealClip and groundShade, two core primitives` — the code that satisfies them |

## The API as shipped

### `ClientPluginCtx` (`client/src/plugins/types.ts`)

```ts
revealedAt(x: number, y: number): boolean;                        // :376
applyRevealClip(material: Material, label: string): void;         // :399
revealClipUniforms(): RevealClipUniforms;                         // :406
publishGroundShade(lookup: () => readonly GroundShadeDisc[]): () => void;  // :430
```

### `TerraceClientPlugin`

```ts
readonly groundShadeBudget?: number;                              // :605
```

### The disc

```ts
export interface GroundShadeDisc {                                 // types.ts:108
  readonly x: number; readonly z: number; readonly y: number;
  readonly radius: number; readonly darkness: number; readonly inner: number;
}
```

Defined in `types.ts`, re-exported from `render/groundShade.ts:52` — the same
inversion `SkyRigState` uses, because a plugin CONSTRUCTS one and the type must
sit where a plugin's standalone `tsc` run can reach it without pulling
`import.meta.env` in. `RevealClipUniforms` goes the other way (imported into
`types.ts:17` from `render/revealMask.ts`) because a plugin only passes it
through; verified that `revealMask.ts` reaches only `three`, `@terrace/shared`,
`terrain/mirror.ts` and `render/shaderSplice.ts`, none of which touch
`import.meta.env`.

### `client/src/render/revealMask.ts`

```ts
revealedAtCell(mirror, x, y): boolean            // :72   THE definition of "revealed"
REVEAL_MASK_RECEIVED_BYTE = 255                  // :86
REVEAL_CLIP_THRESHOLD = 0.5                      // :98
interface RevealClipUniforms                     // :101  { uRevealMask, uRevealChunksPerEdge, uWorldUnitsPerChunk }
interface RevealMask                             // :107  uniforms/sync/applyRevealClip/dispose
REVEAL_CLIP_UNIFORMS_GLSL                        // :146
REVEAL_CLIP_VERTEX_GLSL                          // :156  expects `world`
REVEAL_CLIP_FRAGMENT_GLSL                        // :166
createRevealMask(worldSize): RevealMask          // :203
```

`client/src/plugins/kit/revealClip.ts` re-exports the three snippets plus
`REVEAL_CLIP_THRESHOLD` and the uniform type, with the `ShaderMaterial` usage
worked through in its header. Re-exports, not copies: two shader snippets that
must agree are two things that can drift.

### `client/src/render/groundShade.ts`

```ts
GROUND_SHADE_MIN_SUN_Y                           // :96
groundShadeAt(px, py, pz, sunDir, discs): number // :130  the arithmetic the GLSL runs
groundShadeMaxFor(plugins): number               // :164  max(1, Σ budgets)
interface GroundShadeUniforms                    // :178  uShadeCount/uShadeSun/uShadeA/uShadeB
configureGroundShade(max): void                  // :244  once, at host construction
groundShadeUniforms(): GroundShadeUniforms       // :257
clearGroundShade(): void                         // :276
setGroundShade(sunPosition, discs): void         // :280
applyGroundShade(material, label): void          // :349
```

### Wiring

- `world.ts:360` creates the mask beside `fog`; `:759` and `:832` sync it beside
  the two `fog.sync` calls; `:1030/:1035/:1039` are the three new World members;
  `dispose` at `:1052`. The chart's `revealedAt` closure now calls
  `revealedAtCell` instead of re-deriving the chunk lookup inline — that inline
  copy was the only definition of the predicate before this sequence.
- `host.ts:829` computes and fixes `GROUND_SHADE_MAX`; `:833` registers the
  per-frame gather; `:489` is the gather; `:661–:678` are the four ctx members;
  `:947` unregisters on dispose.
- `terrainMeshes.ts:793` and `water.ts:489` call `applyGroundShade`, both AFTER
  the existing `makeSelfLitAware` / `makeDepthAware`, because both of those
  ASSIGN `onBeforeCompile` and the reverse order would silently drop them.

## Splice anchors, verified against three 0.185.1

Read from `client/node_modules/three/src/renderers/shaders/`, version confirmed
`0.185.1`. Every anchor is present in all five ShaderLib programs this codebase
can patch — `meshphysical` (terrain, water), `meshbasic` (`MeshBasicMaterial`
AND `LineBasicMaterial`: `WebGLPrograms.js:39` maps `LineBasicMaterial → 'basic'`),
`meshlambert`, `points`, `linedashed`:

| anchor | meshphysical | meshbasic | meshlambert | points | linedashed |
|---|---|---|---|---|---|
| `#include <common>` (vert / frag) | 12 / 132 | 2 / 55 | 6 / 60 | 5 / 56 | 7 / 42 |
| `#include <project_vertex>` | 44 | 34 | 39 | 32 | 25 |
| `#include <clipping_planes_fragment>` | 165 | 75 | 90 | 68 | 53 |
| `#include <opaque_fragment>` | 216 | 108 | 118 | 80 | 69 |

**`#include <worldpos_vertex>` is NOT usable and this is the one real surprise.**
`ShaderChunk/worldpos_vertex.glsl.js` wraps its whole body in
`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) ||
defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0`. This project uses no
shadow maps (`render/scene.ts:260`, "No shadow map in Phase 1"), no env maps and
no transmission — so `worldPosition` is simply **not declared** in the terrain's
or the water's compiled vertex shader, and a patch that read it would have failed
to compile. It is also absent from `linedashed` entirely. So
`shaderSplice.ts:72` restates the chunk's own arithmetic unconditionally as
`WORLD_POSITION_VERTEX_GLSL` (`tWorldPosition`), including its `USE_BATCHING` and
`USE_INSTANCING` branches so an `InstancedMesh` lands where it is drawn, anchored
after `#include <project_vertex>` (`:82`) — exactly where three emits
`<worldpos_vertex>` itself.

**Also added, and not in the brief's file list:** `customProgramCacheKey`
chaining on both `applyRevealClip` and `applyGroundShade`. three keys a compiled
program by material type, parameters and that method — **never** by
`onBeforeCompile` — so a clipped `LineBasicMaterial` and an unclipped one with
the same parameters would otherwise share one program and whichever compiled
first would decide whether both clip. Cheap, and the failure is user-visible.
(The pre-existing `makeSelfLitAware` / `makeDepthAware` do not set one; they are
single-instance materials so nothing collides today. Flagged, not fixed here.)

## The mount-vs-compile ordering finding

**Construction order is wrong; compile order is right; the mounted set is the
real hazard, and it is not the one the brief anticipated.**

- `main.tsx:58` builds the world, and `createWorld` constructs the water's
  material immediately (`world.ts:325`). The terrain's material is constructed
  later still, at the first join snapshot (`terrainMeshes.ts:775`).
- `main.tsx:118` builds the plugin host. So the module that owns the materials
  never sees the plugin list, and vice versa — construction order cannot supply
  the `#define`.
- What actually matters is **compilation**, not construction: three runs
  `onBeforeCompile` on a material's first *render*, which is after boot in every
  case. So a value settled at host construction, before the first frame, is
  known in time. **No `needsUpdate` recompile is needed at boot**; the
  `material.needsUpdate = true` in both apply functions is only there so a
  material patched after it has already compiled (a plugin patching a live pool)
  is legal.
- **The hazard the brief did not name**: `syncLivePlugins` mounts and unmounts
  plugins at any time, so Σ over the *mounted* set is not a session constant. A
  `#define` that changed mid-session would need every terrain and water program
  recompiled — the one thing a `#define` cannot do cheaply.
- **Mechanism used**: `configureGroundShade(groundShadeMaxFor(plugins))` at
  `host.ts:829`, over the **compiled-in registry**, not the mounted set. That is
  the upper bound the mounted sum can never exceed, it is fixed before the first
  frame, and it is still an expression of the plugins' own caps rather than a
  number anybody chose. Cost of the difference: unused slots in a uniform array
  whose loop bound is `uShadeCount` — nothing per fragment, a few dozen bytes of
  uniform storage. `configureGroundShade` throws if a second call would change
  the value after something has already compiled (`groundShade.ts:244`), same
  stance as `spliceShader`.

## Zero-publisher cost

With no publisher and no clipped material, versus today:

1. **One 16 KB `DataTexture`** (`RedFormat`/`UnsignedByteType`, 128² for a
   2048-cell world), allocated once for the session and uploaded only when a
   `sync` actually moved a texel. Bound to nothing until a material is clipped.
2. **The terrain's and the water's shader diff** — the whole of it:
   - vertex `#include <common>` +7 lines of declarations (`#define
     GROUND_SHADE_MAX 1`, `#define GROUND_SHADE_MIN_SUN_Y 0.031238`, four
     uniforms, `varying vec3 vGroundShadeWorld`);
   - vertex after `#include <project_vertex>`: the eight-line
     `WORLD_POSITION_VERTEX_GLSL` (of which the two `#ifdef` branches are
     compiled out for a non-instanced mesh, leaving two `vec4` ops) plus
     `vGroundShadeWorld = tWorldPosition.xyz;`;
   - fragment: the same declarations, and before `#include <opaque_fragment>`:
     ```glsl
     float gsShade = 0.0;
     if ( uShadeSun.y > GROUND_SHADE_MIN_SUN_Y ) {
         for ( int i = 0; i < GROUND_SHADE_MAX; i ++ ) {
             if ( i >= uShadeCount ) break;
             ...
         }
     }
     outgoingLight *= 1.0 - gsShade;
     ```
   So: **one extra `vec3` varying**, one compare, one loop test that breaks
   immediately, and one multiply per terrain/water fragment. `uShadeCount` is 0,
   so the loop body never runs.
3. **Per frame on the CPU**: `host.ts:489` returns after one `Map.size` test and
   one integer store (`clearGroundShade`) when nothing publishes. The lighting
   rig is not read at all.

No draw objects are added, and no existing frame path changed.

## Deviations from the plan/brief, each with its reason

1. **`GROUND_SHADE_MAX` is Σ over the compiled-in registry, not the mounted
   set.** See the ordering finding above. Test (c) pins `groundShadeMaxFor` as a
   pure function of a plugin list, so the rule itself is tested either way.
2. **`applyGroundShade(material, label)` takes no `max`.** The brief's third
   argument cannot be supplied: `world.ts` builds both materials and has no
   plugin list (see the ordering finding). The max is module state, fixed by one
   `configureGroundShade` call at host construction and guarded against changing
   after a compile.
3. **Uniform packing is two `vec3` arrays, not `vec4` + `vec2`.** `A = (x, z, y)`,
   `B = (darkness, inner, radius)`. `Vector3` is what three uploads as a `vec3`
   array with no per-frame allocation, the six numbers a disc carries fit two of
   them exactly, and it is one fewer type to keep in step between the TypeScript
   and the GLSL. Same two uploads, same register count.
4. **`client/src/render/shaderSplice.ts` is in the diff**, beyond the brief's
   file list. `WORLD_POSITION_VERTEX_GLSL` and `glslFloat` are needed by BOTH new
   modules; putting them in either one and importing across would be arbitrary,
   and writing them twice is the duplicated contract the project's own checklist
   bans. `shaderSplice.ts` is the module that already owns "how we patch a stock
   three shader". Append-only: nothing existing was changed.
5. **`clearGroundShade()` exists** (not in the brief). Without it the gather had
   to read `viewport.lighting.sun.position` on every frame even with no
   publishers — which is both wasted work and a hard dependency on the lighting
   rig that broke three existing `drawBudget.test.ts` cases against their stub
   viewport. Skipping the gather entirely is the root fix; clearing once is what
   stops a retired cloud's last shadow being frozen onto the ground.
6. **`REVEAL_CLIP_UNIFORMS_GLSL` is one snippet pasted into BOTH stages**, not a
   vertex half and a fragment half. A varying must be declared identically in the
   two stages or the link fails, and two snippets that must agree can drift. The
   vertex stage's copy of the uniforms is unused and the compiler drops it.
7. **`GROUND_SHADE_MIN_SUN_Y` is derived geometrically, not photometrically.**
   Reading `plugins/daynight/client/sky.ts` showed the sun's intensity is never
   low while it is ABOVE the horizon (`HORIZON_SUN_INTENSITY = NOON/3` at
   elevation 0, rising from there), and is exactly zero below it
   (`NIGHT_SUN_INTENSITY`, "below the horizon there is no direct sunlight to
   model"). So there is no photometric knee above y = 0 to derive from, and the
   failure being guarded is geometric anyway: `(disc.y - p.y) / s.y` runs to
   infinity at the horizon. The value is therefore
   `1 / hypot(1, GROUND_SHADE_MAX_TRAVEL_WORLD_UNITS /
   GROUND_SHADE_LOWEST_DECK_WORLD_UNITS)` = `1 / hypot(1, 512/16)` ≈ **0.031238**
   (~1.8° elevation): the elevation at which a disc sitting at the lowest height
   one can sit at (`MAX_RELIEF_WORLD_UNITS`, just clear of the tallest ground)
   throws its shadow one whole world span (`DEFAULT_WORLD_SPAN`) sideways. Both
   sub-constants are named at `groundShade.ts:59` and `:67`. Cross-checked
   against daynight: that cut sits at `|sunHeight| ≈ 0.067`, the last few percent
   of the day either side of the crossing, inside the band where daynight is
   already taking the sun out — so it is not a visible pop.

## What sequence (ii) must know

1. **`inner` is a FLAT CORE, not a hole — plan §2.2 and §3.3 disagree and §2.2
   won.** §2.2's snippet is `shade = darkness * (1 - smoothstep(inner, 1, d))`,
   which holds FULL darkness for `d < inner` and fades to zero at the rim. §3.3
   says cyclone's `inner` is "the eye fraction… the same hole the wind spares",
   which reads as the opposite — a bright hole in the middle of the shadow.
   Implemented as §2.2 (it is the binding arithmetic, and the brief names it),
   pinned by the test `holds full darkness inside 'inner' before the falloff
   begins`. **If the owner wants a literal eye hole, that is a second falloff
   term and a change to this primitive, not a value cyclone can pass.** Decide
   before cyclone publishes.
2. **Sun convention**: `sunDir` is the direction the light comes FROM, i.e.
   `DirectionalLight.position` (`skyRig.ts:42-44` writes exactly that). The host
   normalises before writing `uShadeSun`; `groundShadeAt` normalises internally,
   and the projection is scale-invariant, so a caller may pass either.
3. **`groundShadeBudget` is an expression of caps.** rain 7 + thunderstorm 3 +
   snow 2 + cyclone 2 = 14 gives `GROUND_SHADE_MAX 14` on the stock registry.
   Over-publishing is dropped and logged once per plugin per mount, never a
   throw (`host.ts:489`).
4. **Publishing shade moves the plugin to the pose phase**, exactly like
   `publishMovers`, and the two conditions are OR'd at `host.ts:763`.
5. **Clip a MATERIAL once, not a mesh.** `applyRevealClip` patches
   `onBeforeCompile`; a pooled material shared by every rig is patched once and
   every rig is clipped. It chains, so a plugin material that already had a patch
   keeps it.
6. **`ShaderMaterial` callers** spread `ctx.revealClipUniforms()` into their own
   `uniforms` (shared boxes, so one mask upload reaches everything), paste
   `REVEAL_CLIP_UNIFORMS_GLSL` into both stage headers, put a `vec3 world` in
   scope before `REVEAL_CLIP_VERTEX_GLSL`, and open `main()` with
   `REVEAL_CLIP_FRAGMENT_GLSL`. Worked example in
   `client/src/plugins/kit/revealClip.ts`'s header.
7. **The mask fades over one chunk, deliberately**, and
   `REVEAL_CLIP_THRESHOLD = 0.5` puts the visible cut back on the chunk boundary
   — the same line the frontier mist hangs on. No half-texel correction, unlike
   water's depth sample; the difference is documented at `revealMask.ts:19-25`.
8. **Cost budget spent so far is ~nothing**; the §4 arithmetic (+3 draw objects,
   the under-deck fill-rate risk) is entirely sequence (ii)'s.

## Gate results

| gate | result |
|---|---|
| `pnpm typecheck` | **clean**, exit 0, all workspace packages |
| `pnpm test` (client scope, `npx vitest run` in `client/`) | **527 passed, 1 failed** |
| tests (a)–(c) present and green | yes — 24 cases across `client/test/revealClip.test.ts` and `client/test/groundShade.test.ts` |
| tests committed BEFORE the code | yes — `c39af60` then `870f513` |
| `git diff --stat main...HEAD` | the two render modules, the kit snippet, `world.ts`, `host.ts`, `types.ts`, `terrainMeshes.ts`, `water.ts`, the two new tests, **plus `shaderSplice.ts`** (deviation 4) |

**The one failure is pre-existing on this branch's base and is not mine**:
`test/vertexGrid.test.ts > the blocky fallback > keeps walls attributed to the
higher cell, through the real picking`. Evidence: that file imports only
`@terrace/shared`, `terrain/vertexGrid.ts`, `terrain/mirror.ts`,
`terrain/bandColors.ts`, `terrain/picking.ts` and `config.ts`, and
`git diff main...HEAD -- client/src/terrain client/test/vertexGrid.test.ts`
is **empty** — every file it can reach is byte-identical to `main`. It fails
identically when run alone. `drawBudget.test.ts` failed mid-sequence for a real
reason of mine (the gather read `viewport.lighting` unconditionally) and was
fixed at the root, not in the test — see deviation 5; it is green.

Note: `git diff --stat main` (two-dot) additionally shows ~13 `plugins/**` files.
Those are commits on `main` (`9dfa408`, `2598405`, `d273354`) that this branch,
based at `2598405`, does not carry — they are not changes of mine. `main...HEAD`
above is the honest list.
