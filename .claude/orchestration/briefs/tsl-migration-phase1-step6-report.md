# Report: TSL migration, phase 1 step 6 (plugins, reveal clip, celestial void)

Branch `worktree-agent-abf9e857de5b233fe`, from `e7490c7`. Issue #446, arc `arc/gpu-mesher-gates`.

**Status: items 1–7 done.** The goal grep returns nothing, `shaderSplice.ts` and
`kit/revealClip.ts` are deleted, and every material the step touches is a
`NodeMaterial`. Typecheck, the 602 client tests and the build pass. **Nothing has
been seen on screen** (no app launch). The numbers below come from the source, from
three's source, and from CPU checks under Node.

## Commits

| hash | message |
|---|---|
| `daf4e0e` | refactor(render): hoist the ACES inverse into a displayed-colour node helper |
| `addf93d` | feat(plugins): puff deck as TSL helpers; cumulus, spiral, plume on nodes |
| `cbf9be4` | fix(render): read the instance matrix through a storage-backed node |
| `421f5bb` | feat(render): reveal clip as a TSL discard; tornado funnel on nodes |
| `c9b9655` | feat(plugins): monster fur and saucer instanced alpha as TSL slots |
| `d779755` | feat(plugins): fire, lava and puddle programs as TSL vertex/fragment nodes |
| `75db372` | feat(relics): gem and spire as TSL nodes, displayed colour kept through ACES |
| `c5a01b2` | fix(monsters): share fur nodes so a baked yeti keeps six surfaces |
| `76e301a` | feat(render): celestial void on TSL nodes; stars as sized sprite points |
| `cf8e906` | fix(rigs): apply the pose before the instance matrix, as the GLSL did. **Not mine**: another session committed it on this branch, acting on the rigHerd finding below. It uses `instanceMatrix.ts` from `cbf9be4`. |
| `c321079` | chore(preview): harnesses on WebGPURenderer with ACES-matched backdrops |
| `8eafc83` | chore(render): dump every device-free migrated material graph |

History note: the first attempts at items 2 and 3 went into commits that held only a
staged deletion. A `git add` that listed an already-`git rm`'d path aborted, and I had
silenced its stderr. Nothing had been pushed, so I reset `--mixed` to `addf93d`, which
left the working tree alone, and recommitted in the order above. Every commit in the
table holds what its message says.

## Two contract gaps found, and fixed at the contract layer

1. **In three 0.185 the `position` slot runs after the instance matrix, and three
   exposes no node for that matrix.** `NodeMaterial.setupPosition` calls
   `instancedMesh()` and only then assigns `positionNode` (`NodeMaterial.js:764-806`).
   `Instance.js:28-73` builds the matrix node privately. Every GLSL splice edited
   `transformed` before `project_vertex` applied `instanceMatrix`, so an effect that
   places a vertex needs the matrix. Fix: `client/src/render/instanceMatrix.ts`
   switches the mesh to a `StorageInstancedBufferAttribute` and returns
   `storage(matrices, 'mat4', count).element(instanceIndex)`. three takes its own
   storage path for that attribute (`Instance.js:37`), so both nodes read one GPU
   buffer and nothing is uploaded twice. Non-compute stages bind it read-only
   (`WGSLNodeBuilder.js:1191-1203`), and the WebGL fallback reads storage through PBO
   textures (`StorageBufferNode.js:371-386`). Used by the puff decks, plume, tornado,
   fire and (via `cf8e906`) rigHerd.

   Why storage and not the alternatives. Four-`vec4` interleaved attributes over the
   same array would upload the matrix a second time, because three keeps its own
   interleaved copy in a private WeakMap (`Instance.js:17, 49-55`). A per-instance
   `vec3` placement attribute would change the data layout, and the GLSL consumed
   `instanceMatrix` itself, so the layout stays. `updateRanges` apply to storage
   attributes on the WebGPU backend (`WebGPUAttributeUtils.js:225-260`; itemSize 16 is
   never padded).

   **Hazard:** `mesh.instanceMatrix = matrices` replaces the attribute object, so code
   still holding the original `InstancedBufferAttribute` would update a dead copy. It is
   stated in the helper's comment. The puff decks, plume, tornado and fire all write
   through `mesh.instanceMatrix`. rigHerd (`cf8e906`) constructs its shared attribute as
   `StorageInstancedBufferAttribute`, so the helper keeps it as is.

   **Contract clarification for the owner** (no change to `materialSlots.ts`): on an
   `InstancedMesh` the `position` slot runs after instancing. Pre-instancing work must
   read the raw vertex (`attribute('position')` / `positionGeometry`) and re-apply the
   matrix through `instanceMatrix(mesh)`, as every placement here does, preserving
   inst·placement·p. Overriding `setupPosition` would also work.
2. **`bakeRig` merges parts by `material.customProgramCacheKey()`
   (`rigSkin.ts:54`).** For a `NodeMaterial` that key hashes node *identity*
   (`NodeMaterial.js:426-437`, `Node.js:470-474` uses `this.id`). Two fur materials
   that each composed their own nodes stopped merging. Measured under Node: a
   silverback yeti went from **6 to 10 surfaces** after `c9b9655`, against a budget of
   `MONSTER_MODEL_DRAW_OBJECTS = 6`. Fix (`c5a01b2`): `materialSlots.discard` returns
   one mask node per input condition (WeakMap memo), and the monster workshop reuses
   one fur colour node and one shell condition per frequency and threshold. Measured
   again: silverback, ram, ibex and fanged are all back to **6**. The gap that remains
   is recorded under Open questions.

## Per file: what it was, what it is

"Slots" is the lit-material route (contract rule 7 "everything else"); "vertexNode /
fragmentNode" is the full-custom-program route.

Tone case, by the chunks the GLSL included (the WebGPU output pass tone-maps and then
sRGB-encodes everything):

- **A**: neither `tonemapping_fragment` nor `colorspace_fragment`, so raw display bytes.
  The new output is inverse ACES of the sRGB-decoded old value.
- **B**: `colorspace_fragment` without tone mapping (or `toneMapped: false`). The new
  output is inverse ACES of the old linear value.
- **C**: both chunks. No inversion.

| file | GLSL site | now | not reproduced exactly | tone case |
|---|---|---|---|---|
| `client/src/plugins/kit/puffDeck.ts` | 5 GLSL strings | `puffInstanceBase(instanceMatrix)`, `puffBillboard(world, size)`, `puffMask(innerEdge, lobing?)` → `{ puff, discarded }`, `puffLobeScale(lobing)`, `puffAlphaDiscard(alpha)`, plus `PUFF_QUAD`. The names lost their `Glsl`/`_GLSL` suffix. Parameters: the GLSL's implicit `vQuad`, `world`, `size`, `alpha` are explicit, and `seedVarying: string` became `seed: Node` | The billboard returns a position-slot position (`modelWorldMatrixInverse * cameraWorldMatrix * billboardedView`), so three's own MVP lands it where `gl_Position` was | — |
| `client/src/plugins/kit/cumulusDeck.ts` | `onBeforeCompile` on `MeshLambertMaterial` | `MeshLambertNodeMaterial`: `position` (placement + billboard), `normal` (fake sphere), `opacity` (alpha), two `discard`s (puff mask, faint alpha); mass arrays became `uniformArray` of `Vector2` | A parked slot used to write `gl_Position = vec4(2,2,2,1)`. The slot now collapses the quad to its centre: zero area, no fragments, same result. The reveal clip now tests each fragment's world position; the GLSL tested the puff centre (`transformed`), so a puff that straddles the reveal edge is cut rather than kept or dropped whole | C (lit Lambert): none |
| `plugins/cyclone/client/spiral.ts` | `onBeforeCompile` | `MeshLambertNodeMaterial`: `position`, `normal`, `color` (eyewall shade), `opacity`, 2 `discard`s | Same reveal-clip note as the deck | C (lit Lambert): none |
| `plugins/volcanoes/client/plume.ts` | `ShaderMaterial` | `NodeMaterial` (unlit) with slots: `position`, `color`, `opacity`, 2 `discard`s, `output` (display inversion) | Blending happens in linear light before tone mapping, not on display bytes (see Tone mapping) | A: decode + inverse ACES |
| `client/src/render/revealMask.ts` | `applyRevealClip` splice | `discard` effect: `positionWorld.xz / span`, out-of-range uv, mask texel `< REVEAL_CLIP_THRESHOLD`. One `texture()` node and a span `uniform` per mask, re-pointed in `sync()` on a resize. `.sample()` clones reference the base's value (`TextureNode.js:678-686, 205-207`) | — | — |
| `client/src/plugins/types.ts:136`, `client/src/world.ts:455`, `kit/discRig.ts`, `kit/hazeBank.ts`, `kit/precipitation.ts`, `plugins/cyclone/client/rain.ts`, `plugins/thunderstorm/client/rig.ts` | parameter `Material` | parameter `NodeMaterial`. The haze sheets, precipitation line/points and thunderstorm glow/bolt materials are now built as `MeshBasicNodeMaterial`, `LineBasicNodeMaterial` and `PointsNodeMaterial`: the same classes `NodeLibrary.fromMaterial` would substitute at render | — | C (stock basic/line/points): none |
| `plugins/tornado/client/funnel.ts` | 2 `ShaderMaterial`s with hand-merged reveal uniforms | two `NodeMaterial`s with slots (`position`, `color`, `opacity`, `discard`, `output`) and two `applyRevealClip` calls (rule 8). `createFunnel` takes `applyRevealClip` instead of the uniforms. The cone and debris share one `uElapsed` and one `uDaylight` uniform node | The debris' reveal clip is per fragment (see the deck) | A ×2 |
| `client/src/plugins/kit/revealClip.ts` | GLSL re-exports | deleted | — | — |
| `plugins/monsters/client/geometry.ts` | 2 `onBeforeCompile` (fur `color_fragment`, shell `discard`) | `MeshLambertNodeMaterial`: `color` (× triplanar fur) and `discard` (shell threshold). The triplanar sample reads `positionGeometry` / `normalGeometry` | The GLSL read `transformed` and `objectNormal` at `begin_vertex`. For an unskinned mesh those are the same attributes | C (lit Lambert): none |
| `plugins/saucers/client/effects.ts` | 1 `onBeforeCompile` | `opacity` slot × `attribute('instancedAlpha')`. All five `MeshBasicMaterial`s in the file are `MeshBasicNodeMaterial` | — | C (stock basic): none |
| `plugins/fire/client/smoke.ts` | `ShaderMaterial` | `NodeMaterial`, **vertexNode / fragmentNode**. The foot distance and the instance scale read `instanceMatrix(mesh)`; GLSL's `normalMatrix` is written as `cameraViewMatrix * (modelNormalMatrix * n)` | Blending (see Tone mapping) | A |
| `plugins/fire/client/scar.ts` | `ShaderMaterial` | **vertexNode / fragmentNode** | Blending | A |
| `plugins/fire/client/flames/ribbons.ts` | `ShaderMaterial`, premultiplied custom blend | **vertexNode / fragmentNode**, same `CustomBlending` One / OneMinusSrcAlpha. `uSpinRates` became a `uniformArray` | The display inversion runs before the premultiply. `RIBBON_GAIN` pushes the root colour past 1, which WebGL clipped at the framebuffer; see the round-trip table | A |
| `plugins/fire/client/flames/shaderPlume.ts` | `ShaderMaterial` | **vertexNode / fragmentNode** | Blending | A |
| `plugins/fire/client/valueNoiseGlsl.ts` → `valueNoise.ts` | GLSL string | `hash21`, `vnoise`, `fnoise` as `Fn`s with `setLayout` (real WGSL functions) | — | — |
| `plugins/volcanoes/client/lavaFlow.ts` | `ShaderMaterial`, opaque, alpha-to-coverage | **vertexNode / fragmentNode**. The lava noise is local `Fn`s named `lavaHash21` / `lavaNoise`. Alpha to coverage stays on, and three enables it only when MSAA is on (`WebGPUPipelineUtils.js:213`) | The three `LAVA_*_RGB` strings became number tuples with the same values | A |
| `plugins/hydro/client/puddles.ts` | `ShaderMaterial` | **fragmentNode** only: its GLSL vertex stage was exactly three's `P * MV * instanceMatrix * position`, so `vertexNode` stays null | Blending | A |
| `plugins/relics/client/gemMaterial.ts` | `ShaderMaterial`, `toneMapped: false`, `colorspace_fragment` | **vertexNode / fragmentNode**, fragment → `radianceForDisplay(srgb)`. `dFdy` keeps GL's sign (three emits `- dpdy`, `WGSLNodeBuilder.js:221`) | — | B: inverse ACES of the linear value (it is `EOTF(srgb)`, so the call takes `srgb`) |
| `plugins/relics/client/relicSpire.ts` | `ShaderMaterial`, `toneMapped: false` | **vertexNode / fragmentNode**. The pulsing `uAlpha` is `material.opacity` through `materialOpacity`, and `index.ts` sets `opacity` | — | A (`toneMapped: false`, no chunks) |
| `client/src/render/celestialVoid.ts` | 4 `ShaderMaterial`s (bake, gas half-res, nebula/wheel composite, stars) | bake, gas and composite are `NodeMaterial`s with **vertexNode / fragmentNode** (full-screen triangle). Stars are **`PointsNodeMaterial` with `sizeNode`** on a `Sprite` with `count`. `WebGLRenderTarget` → `RenderTarget` | See "Celestial void" below | A for the nebula/wheel composite and the stars; bake and gas are off-screen data, none |
| `client/src/render/displayRadiance.ts` | — (new) | the ACES constants, inverse matrices and fit inverse (moved from `skyEnvironment.ts`), plus `radianceForDisplay(displayed)` | — | — |
| `client/src/render/instanceMatrix.ts` | — (new) | see the contract gaps above | — | — |
| `client/src/render/materialSlots.ts` | — | `discard` memoises its mask nodes | — | — |
| `client/src/render/shaderSplice.ts` | — | deleted | — | — |
| `client/src/render/rigSkin.ts:421` | `clone.onBeforeCompile = material.onBeforeCompile` | removed | — | — |
| `client/src/preview*.ts` (15) | `WebGLRenderer` | `WebGPURenderer` from `three/webgpu`, `await renderer.init()` before the first frame (top-level await, or `main` made async), `scene.background = backgroundRadiance(hex, renderer)` set after the tone-mapping configuration. `previewWater`'s night backdrop goes through the same call. `info.render.calls` → `drawCalls` (previewFire, previewStructures). `previewMusic.ts` has no renderer | — | backdrop: the CPU `backgroundRadiance` (decode + inverse ACES) |

Dropped as dead code: the void's `dstars()`, which nothing called, and the `t` argument
of `stars()`, which was never read.

### Celestial void

- **Stars, and why a `Sprite`.** `PointsNodeMaterial.setupVertex` expands a sized quad
  only when `builder.object.isPoints` is false. For a `Points` object it draws plain
  1-pixel points and ignores `sizeNode` (`PointsNodeMaterial.js:163-172`; the quad
  expansion is `setupVertexSprite`, `:89-157`). A `Sprite` with `count` was chosen over
  an `InstancedMesh`: the mesh would add a 64-byte instance matrix per star and three's
  instancing pass, which the stars never use. So each grid is a `Sprite` with `count` = its star count.
  Its geometry is a unit `PlaneGeometry` carrying `starPosition` / `starShape` as
  `InstancedBufferAttribute`s, and the renderer draws `object.count` instances
  (`RenderObject.js:610-612`).
- **Clip position.** The star's NDC comes from the disk frame, not three's camera. The
  `positionNode` carries it back through `cameraProjectionMatrixInverse`,
  `cameraWorldMatrix` and `modelWorldMatrixInverse`, so three's MVP lands it on that
  NDC. `sizeNode = size / screenDPR`, because three multiplies by the DPR and divides by
  half the viewport (`ScreenNode.js:110-126`). A culled star, whether behind the eye,
  faded or off screen, gets size 0 at NDC (2, 2): nothing is rasterised, and the gas
  fetch sits inside an `If` so a culled star costs no fetch, as before.
- **Blend.** GL used `AdditiveBlending` + `premultipliedAlpha` with alpha 0, i.e.
  One/One. On `NodeMaterial`, `premultipliedAlpha` also multiplies the output by alpha
  (`NodeMaterial.js:1184-1202`), which would zero the stars. So they use `CustomBlending`
  One/One with `premultipliedAlpha` off: the same equation.
- **Pixel coordinates.** `screenCoordinate` follows WebGPU (y down,
  `ScreenNode.js:181-195`), so every "gl_FragCoord" in the math is
  `vec2(sc.x, height - sc.y)`. The internal render targets (bake, gas half-res) are
  written and read in WebGPU texel orientation. On the WebGL fallback three flips the uv
  of render-target textures (`TextureNode.js:324-340, 903-907`), so both backends agree.
  The star's gas lookup is `(ndc.x·½+½, ½−ndc.y·½)`.
- **Render targets are not tone-mapped.** `currentToneMapping` is `NoToneMapping` off
  the output target (`Renderer.js:2495-2525`). The bake and gas passes therefore store
  raw data as on WebGL, and only the on-screen outputs are inverted.
- **Branches.** The GLSL early-outs are kept as `If` blocks (above-horizon gas pass,
  fully faded wheel pixel). three turns off WGSL's derivative-uniformity diagnostic
  except on Firefox (`WGSLNodeBuilder.js:245-251`).
- **`DISK_THICKNESS` is kept at the shipped value.** The GLSL baked it with
  `toFixed(3)`, i.e. 0.024, against the exact 0.023529. The nodes use
  `SHADER_DISK_THICKNESS = Number(DISK_THICKNESS.toFixed(3))` so the look is unchanged.
  See Open questions.
- The nested `renderer.render()` of the gas pass inside `onBeforeRender` is unchanged.
  `Renderer.render` saves and restores the render context for nested calls
  (`Renderer.js:895-1029`).

## Tone mapping (the binding rule), and where it applies

`radianceForDisplay(displayed)` (`client/src/render/displayRadiance.ts`) mirrors
`backgroundRadiance`:

1. clamp to [0, 1], because WebGL's 8-bit framebuffer clipped there;
2. `sRGBTransferEOTF`;
3. `ACES_OUTPUT_INVERSE`, the fit inverse per channel (the same quadratic and branches
   as the CPU function), then `ACES_INPUT_INVERSE`;
4. `/ (toneMappingExposure × ACES_EXPOSURE_PRESCALE)`, then clamp negative radiance to 0.

It returns the decoded colour unchanged when `renderer.toneMapping` is not ACES. The
matrices are the CPU inverses computed once, fed to `mat3`, which is row-major for nine
numbers (`NodeUtils.js:322`). The decode is three's own `sRGBTransferEOTF` node
(`nodes/display/ColorSpaceFunctions.js:12`), the same curve `colorSpaceToWorking`
applies for sRGB. The curve is not hand-written. Alpha is never touched.

**Applied to the six the brief names:** celestial void nebula, wheel and stars (the
bake and gas passes are off-screen data), relic gem, relic spire.

**Also applied, a finding beyond the brief:** 14 of the 15 ShaderMaterials wrote
`gl_FragColor` with neither `tonemapping_fragment` nor `colorspace_fragment`; only the
gem includes colorspace. `main:client/src/render/scene.ts:107-109` sets ACES + sRGB with
no composer. On WebGL their bytes reached the screen unmapped, which is exactly what
`toneMapped: false` would have done. On WebGPU they would be tone-mapped and encoded.
So the inversion is also applied to the volcano plume, tornado cone and debris, fire
smoke, scar, ribbons and shader plume, lava, and puddles. Each site carries the comment
"The GLSL wrote display bytes straight to the framebuffer". Removing one is a one-line
revert.

**Round trip, CPU under Node** (`sRGBencode(ACES(radianceForDisplay(c)))`, exposure
1.25, ×255):

```
plumeEmber       fitted 0.697,0.218,0.029  back*255 255.0,114.8,31.5  want 255.0,114.8,30.6
plumeAsh         fitted 0.070,0.064,0.064  back*255 76.5,71.4,71.4  want 76.5,71.4,71.4
tornadoDebris    fitted 0.113,0.086,0.046  back*255 102.0,81.6,58.7  want 102.0,81.6,58.7
tornadoCloud     fitted 0.350,0.355,0.415  back*255 158.1,160.7,173.4  want 158.1,160.7,173.4
smokeBase        fitted 0.044,0.040,0.037  back*255 61.2,56.1,53.6  want 61.2,56.1,53.5
smokeTip         fitted 0.495,0.479,0.450  back*255 188.7,183.6,178.5  want 188.7,183.6,178.5
scarChar         fitted 0.005,0.004,0.004  back*255 17.9,14.0,12.2  want 17.9,14.0,12.2
scarAsh          fitted 0.069,0.064,0.056  back*255 76.5,71.4,66.3  want 76.5,71.4,66.3
ribbonRoot       fitted 0.848,0.655,0.184  back*255 255.0,209.1,107.1  want 255.0,209.1,107.1
ribbonMid        fitted 0.710,0.259,0.029  back*255 255.0,127.5,34.7  want 255.0,127.5,25.5
ribbonTip        fitted 0.171,0.020,0.003  back*255 140.3,15.3,5.1  want 140.3,15.3,5.1
white            fitted 1.000,1.000,1.000  back*255 255.0,255.0,255.0  want 255.0,255.0,255.0
ribbonRootGain   fitted 0.966,0.993,0.311  back*255 250.6,254.6,237.3  want 331.5,271.8,139.2
```

What the table shows:

- Muted and dark colours round-trip to within 0.1 of a code value.
- **Bright saturated colours are outside what ACES can display.** ACES desaturates
  highlights, so no radiance maps back to them, and the inverse clamps the negative
  channel to 0. The ember's blue is +0.9 codes, and the ribbon mid-orange's blue is
  **+9 codes (25 → 35)**.
- `ribbonRoot × RIBBON_GAIN` (clipped to (1, 1, 0.55)) comes back **near-white (251,
  255, 237)**, where WebGL showed a clipped yellow (255, 255, 139). The fire's hottest
  root will read paler.

This is a limit of tone-mapping these materials at all, not of the inverse. A
radiance that ACES maps to it does not exist.

**Blended materials: mode, and why the match is inexact.** WebGL blended these on
display bytes, so it showed `a·c + (1−a)·d`. WebGPU blends radiance before the output
pass, so it shows `D(a·R(c) + (1−a)·R(d))`, where R is the inversion and D is
ACES + encode. The two agree only where `a` is 0 or 1. No blend-space workaround was
attempted; the owner judges these on screen.

| material | blending | inexact where |
|---|---|---|
| volcano plume | Normal, transparent | every partly transparent puff over the sky |
| tornado cone, debris | Normal, transparent | the churned sheet (alpha ≤ 0.85) |
| fire smoke | Normal, transparent | the whole column (alpha ≤ 0.5) |
| fire scar | Normal, transparent | the eroded rim; the body (alpha 0.82) slightly |
| fire ribbons | Custom One / OneMinusSrcAlpha (premultiplied) | everywhere below full alpha; the inversion runs before the premultiply |
| fire shader plume | Normal, transparent | the guttering tip |
| puddles | Normal, transparent | the whole disc (alpha ≤ 0.55 × ripple) |
| relic spire | Normal, transparent | the whole beam (alpha ≤ 0.28) |
| void stars | Custom One / One (additive) | stars over gas: display-space addition vs radiance addition |
| lava | opaque, alpha to coverage | only the MSAA-resolved rim; the body is exact |

## Test expectations changed (the contract was the reason)

All four are in `client/test/pluginKit.test.ts`, whose describe block was renamed
"puff deck GLSL" → "puff deck nodes". They assert on the node graph through
`node.toJSON()`. No test was added; the file gained two local helpers, `graphOf` and
`has`.

| test | old | new |
|---|---|---|
| offsets the vertex AFTER the view transform — that is the billboard | `PUFF_BILLBOARD_GLSL` contains `viewPosition = viewMatrix * vec4(world, 1.0)`, `viewPosition.xy += position.xy * size`, `gl_Position = projectionMatrix * viewPosition` | `puffBillboard(vec3(1,2,3), float(2))` has root `SplitNode` and contains `OperatorNode '+'`, `SplitNode .xy`, `SplitNode .zw`, `ConstNode 2` |
| reads the instance matrix as a position only | `PUFF_INSTANCE_BASE_GLSL` contains `(instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz` | `puffInstanceBase(mat4(new Matrix4()))` has root `SplitNode` and contains `OperatorNode '*'` and `ConstNode [0,0,0,1]` |
| builds a radial mask that discards outside the quad, at the given inner edge | `puffMaskGlsl('0.15')` contains `smoothstep(0.15, 1.0, radius)`; `'0.0'` gives `smoothstep(0.0, …)` and `if (puff <= 0.0) discard;` | `puffMask(0.15).puff` contains `MathNode smoothstep` and `ConstNode 0.15`; `puffMask(0).puff` contains `ConstNode 0`; `.discarded` contains `OperatorNode '<='` |
| discards a puff too faint to be worth blending | `PUFF_ALPHA_DISCARD_GLSL` contains `if (alpha <= 0.004) discard;` | `puffAlphaDiscard(float(1))` contains `OperatorNode '<='` and `ConstNode 0.004` |

## Verification, verbatim

Goal grep (`grep -rn 'new ShaderMaterial\|onBeforeCompile' client/src plugins`,
excluding node_modules and tests):

```
$ grep -rn 'new ShaderMaterial\|onBeforeCompile' client/src plugins --exclude-dir=node_modules | grep -v '\.test\.' ; echo "grep exit: $?"
grep exit: 1
```

(no matches)

```
$ pnpm typecheck
plugins/tornado typecheck: Done
server typecheck$ tsc --noEmit
plugins/weather typecheck: Done
plugins/volcanoes typecheck: Done
plugins/wildlife typecheck: Done
server typecheck: Done
=== EXIT 0
```

```
$ cd client && npx vitest run
 Test Files  41 passed (41)
      Tests  602 passed (602)
   Duration  76.08s (transform 16.62s, setup 0ms, import 30.82s, tests 109.95s, environment 6ms)
```

```
$ cd client && npx vite build
dist/assets/index--xBZ1JdD.css                 24.39 kB │ gzip:   5.42 kB
dist/assets/index-_5cSktzl.js               1,784.10 kB │ gzip: 534.30 kB
✓ built in 1.48s
```

```
$ node client/scripts/drawnGroundParity.mjs
PASS relaxed real patch: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS stamped whole-band plateau with 4-cell treads: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS sheer multi-band wall in one cell: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS saddle: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS chunk seam: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS layered column: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
```

Workspace tests (`pnpm -r --no-bail --if-present run test`): every plugin with tests
passes, including cyclone 3, tornado 3, thunderstorm 17, monsters 49, relics 73,
wildlife 56 and structures 192, as do shared (320) and client (602). **Server fails 25
tests** in `plugin-reload`, `world-switch`, `world-admin` and `world-registry` (plugin
re-import from a temp dir). This step touches nothing under `server/`, `shared/`,
`plugins/*/server` or any `protocol.ts` (`git diff --stat e7490c7 -- server shared
'plugins/*/server' 'plugins/*/protocol.ts'` is empty), so these are not from this work.
Their origin is unverified. `plugins/temples` also fails with "No test files found": it
has no tests and no `--passWithNoTests`, which predates this step.

`node client/scripts/dumpMaterialGraphs.mts` now covers every material this step
touches that builds without a device. The default output is a per-slot
"RootType <- ChildTypexN" summary; `--json` gives the full `toJSON()`. The full JSON is
too large as a default, because a storage-backed instance matrix serialises its whole
array. The celestial void is **not** dumped: `createCelestialVoid` bakes its gas pattern
through the renderer at construction, which needs a device. `Fn`-call fragment programs
dump as their call node (`VarNode <- Nodex2`) because three builds an `Fn` body only
during a shader build. As before, the dump diffs composition, not shader code.

```
$ node client/scripts/dumpMaterialGraphs.mts
terrain MeshStandardNodeMaterial
  colorNode: VarNode <- ColorSpaceNodex1, MaterialNodex1, OperatorNodex1, SplitNodex1, VertexColorNodex1
  outputNode: VarNode <- AttributeNodex1, JoinNodex2, MathNodex2, Nodex2, OperatorNodex1, PropertyNodex2, SplitNodex5, VarNodex5
water MeshPhysicalNodeMaterial
  colorNode: VarNode <- ConditionalNodex1, ConstNodex38, MaterialNodex1, MathNodex15, Nodex2, OperatorNodex31, SplitNodex2, TextureNodex1, UniformGroupNodex1, UniformNodex2, VarNodex51
  opacityNode: VarNode <- ConstNodex2, MaterialNodex1, Nodex2, OperatorNodex4, SplitNodex2, TextureNodex1, UniformGroupNodex1, UniformNodex1, VarNodex4
  emissiveNode: VarNode <- ConstNodex1, MaterialNodex1, OperatorNodex2, PropertyNodex1, SplitNodex1, VarNodex1
  outputNode: VarNode <- JoinNodex1, MathNodex1, Nodex2, OperatorNodex1, PropertyNodex1, SplitNodex2, VarNodex3
  specularColorNode: VarNode <- ConstNodex2, ConvertNodex1, Nodex2, OperatorNodex3, SplitNodex2, TextureNodex1, UniformGroupNodex1, UniformNodex1, VarNodex4
reveal clip on a stock material MeshBasicNodeMaterial
  maskNode: VarNode <- ConstNodex3, MathNodex2, Nodex2, OperatorNodex8, SplitNodex2, TextureNodex2, UniformGroupNodex1, UniformNodex1, VarNodex12
cumulus deck/dump:puffs MeshLambertNodeMaterial
  positionNode: ConditionalNode <- AttributeNodex5, ConstNodex24, ConvertNodex1, IndexNodex1, JoinNodex5, MathNodex7, Nodex4, OperatorNodex36, SplitNodex11, StorageArrayElementNodex1, StorageBufferNodex1, SubBuildx1, UniformArrayElementNodex3, UniformArrayNodex2, UniformGroupNodex1, UniformNodex1, VarNodex59, VaryingNodex1
  normalNode: VarNode <- AttributeNodex2, ConstNodex13, JoinNodex1, MathNodex12, Nodex2, OperatorNodex19, SplitNodex4, VarNodex35
  opacityNode: VarNode <- AttributeNodex4, ConstNodex16, ConvertNodex1, MaterialNodex1, MathNodex10, OperatorNodex23, SplitNodex5, SubBuildx1, UniformArrayElementNodex1, UniformArrayNodex1, UniformGroupNodex1, VarNodex36, VaryingNodex1
  maskNode: VarNode <- AttributeNodex4, ConstNodex20, ConvertNodex1, MathNodex12, Nodex2, OperatorNodex36, SplitNodex7, SubBuildx1, TextureNodex2, UniformArrayElementNodex1, UniformArrayNodex1, UniformGroupNodex1, UniformNodex1, VarNodex54, VaryingNodex1
cyclone spiral/cyclone:spiral:puffs MeshLambertNodeMaterial
  positionNode: SplitNode <- AttributeNodex6, ConstNodex21, IndexNodex1, JoinNodex4, MathNodex10, Nodex4, OperatorNodex34, SplitNodex4, StorageArrayElementNodex1, StorageBufferNodex1, SubBuildx1, UniformGroupNodex1, UniformNodex2, VarNodex58, VaryingNodex1
  normalNode: VarNode <- AttributeNodex1, ConstNodex4, JoinNodex1, MathNodex5, Nodex2, OperatorNodex2, SplitNodex2, VarNodex10
  colorNode: VarNode <- AttributeNodex1, ConstNodex4, MaterialNodex1, MathNodex2, OperatorNodex2, SubBuildx1, VarNodex5, VaryingNodex1
  opacityNode: VarNode <- AttributeNodex3, ConstNodex9, MaterialNodex1, MathNodex5, OperatorNodex6, SplitNodex1, SubBuildx1, VarNodex14, VaryingNodex1
  maskNode: VarNode <- AttributeNodex3, ConstNodex13, MathNodex7, Nodex2, OperatorNodex19, SplitNodex3, SubBuildx1, TextureNodex2, UniformGroupNodex1, UniformNodex1, VarNodex32, VaryingNodex1
volcano plume/volcanoes:plume:particles NodeMaterial
  positionNode: SplitNode <- AttributeNodex3, ConstNodex16, IndexNodex1, JoinNodex5, MathNodex9, Nodex4, OperatorNodex26, SplitNodex8, StorageArrayElementNodex1, StorageBufferNodex1, SubBuildx1, UniformGroupNodex1, UniformNodex2, VarNodex46, VaryingNodex1
  colorNode: VarNode <- AttributeNodex1, ConstNodex5, MathNodex3, OperatorNodex2, SubBuildx1, UniformGroupNodex1, UniformNodex1, VarNodex6, VaryingNodex1
  opacityNode: VarNode <- AttributeNodex3, ConstNodex10, MathNodex5, OperatorNodex8, SplitNodex1, SubBuildx1, UniformGroupNodex1, UniformNodex1, VarNodex14, VaryingNodex1
  outputNode: VarNode <- JoinNodex1, Nodex2, PropertyNodex1, SplitNodex1, VarNodex1
  maskNode: VarNode <- AttributeNodex3, ConstNodex12, MathNodex5, OperatorNodex13, SplitNodex1, SubBuildx1, UniformGroupNodex1, UniformNodex1, VarNodex19, VaryingNodex1
lava flow/volcanoes:flow:crust NodeMaterial
  vertexNode: VarNode <- AttributeNodex1, ConstNodex1, JoinNodex1, Nodex4, OperatorNodex2, VarNodex5
  fragmentNode: VarNode <- Nodex2
tornado/tornado:funnel:vortex NodeMaterial
  positionNode: VarNode <- AttributeNodex2, ConstNodex12, IndexNodex1, JoinNodex2, MathNodex5, OperatorNodex23, SplitNodex5, StorageArrayElementNodex1, StorageBufferNodex1, UniformGroupNodex1, UniformNodex1, VarNodex32
  colorNode: VarNode <- AttributeNodex1, ConstNodex4, MathNodex2, OperatorNodex1, SplitNodex1, UniformGroupNodex1, UniformNodex1, VarNodex4
  opacityNode: VarNode <- AttributeNodex3, ConstNodex19, MathNodex3, OperatorNodex27, SplitNodex2, UniformGroupNodex1, UniformNodex1, VarNodex35
  outputNode: VarNode <- JoinNodex1, Nodex2, PropertyNodex1, SplitNodex1, VarNodex1
  maskNode: VarNode <- AttributeNodex3, ConstNodex23, MathNodex5, Nodex2, OperatorNodex38, SplitNodex4, TextureNodex2, UniformGroupNodex1, UniformNodex2, VarNodex51
tornado/tornado:funnel:debris NodeMaterial
  positionNode: SplitNode <- AttributeNodex3, ConstNodex18, IndexNodex1, JoinNodex3, MathNodex7, Nodex4, OperatorNodex33, SplitNodex4, StorageArrayElementNodex1, StorageBufferNodex1, SubBuildx1, UniformGroupNodex1, UniformNodex2, VarNodex54, VaryingNodex1
  colorNode: VarNode <- ConstNodex1, OperatorNodex1, UniformGroupNodex1, UniformNodex1, VarNodex1
  opacityNode: VarNode <- AttributeNodex3, ConstNodex10, MathNodex5, OperatorNodex8, SplitNodex1, SubBuildx1, UniformGroupNodex1, UniformNodex1, VarNodex14, VaryingNodex1
  outputNode: VarNode <- JoinNodex1, Nodex2, PropertyNodex1, SplitNodex1, VarNodex1
  maskNode: VarNode <- AttributeNodex3, ConstNodex15, MathNodex7, Nodex2, OperatorNodex22, SplitNodex3, SubBuildx1, TextureNodex2, UniformGroupNodex1, UniformNodex2, VarNodex33, VaryingNodex1
monster fur MeshLambertNodeMaterial
  colorNode: VarNode <- AttributeNodex2, ConstNodex2, JoinNodex3, MaterialNodex1, MathNodex4, OperatorNodex10, SplitNodex12, TextureNodex3, UniformGroupNodex1, UniformNodex1, VarNodex17
monster fur shell MeshLambertNodeMaterial
  maskNode: VarNode <- AttributeNodex2, ConstNodex3, JoinNodex3, MathNodex4, OperatorNodex11, SplitNodex12, TextureNodex3, UniformGroupNodex1, UniformNodex1, VarNodex18
saucer bolts/saucers:bolts:pool MeshBasicNodeMaterial
  opacityNode: VarNode <- AttributeNodex1, MaterialNodex1, OperatorNodex1
fire smoke/fire:smoke:columns NodeMaterial
  vertexNode: VarNode <- AttributeNodex2, ConstNodex30, IndexNodex1, JoinNodex8, MathNodex6, Nodex11, OperatorNodex42, SplitNodex5, StorageArrayElementNodex1, StorageBufferNodex1, UniformGroupNodex1, UniformNodex1, VarNodex65
  fragmentNode: VarNode <- Nodex2
fire scar/fire:scar:marks NodeMaterial
  vertexNode: VarNode <- AttributeNodex1, ConstNodex1, IndexNodex1, JoinNodex1, Nodex4, OperatorNodex3, StorageArrayElementNodex1, StorageBufferNodex1, UniformGroupNodex1, VarNodex6
  fragmentNode: VarNode <- Nodex2
fire ribbons/fire:ribbons:tongues NodeMaterial
  vertexNode: VarNode <- AttributeNodex5, ConstNodex15, ConvertNodex1, IndexNodex1, JoinNodex2, MathNodex7, Nodex4, OperatorNodex29, SplitNodex3, StorageArrayElementNodex1, StorageBufferNodex1, UniformArrayElementNodex1, UniformArrayNodex1, UniformGroupNodex1, UniformNodex1, VarNodex44
  fragmentNode: VarNode <- Nodex2
fire shader plume/fire:shaderPlume:plumes NodeMaterial
  vertexNode: VarNode <- AttributeNodex3, ConstNodex22, IndexNodex1, JoinNodex5, MathNodex5, Nodex8, OperatorNodex28, SplitNodex3, StorageArrayElementNodex1, StorageBufferNodex1, UniformGroupNodex1, UniformNodex1, VarNodex46
  fragmentNode: VarNode <- Nodex2
hydro puddles/hydro:puddles:discs NodeMaterial
  fragmentNode: VarNode <- Nodex2
relic gem NodeMaterial
  vertexNode: VarNode <- AttributeNodex1, ConstNodex1, JoinNodex1, Nodex4, OperatorNodex2, VarNodex5
  fragmentNode: VarNode <- Nodex2
relic spire NodeMaterial
  vertexNode: VarNode <- AttributeNodex1, ConstNodex1, JoinNodex1, Nodex4, OperatorNodex2, VarNodex5
  fragmentNode: VarNode <- Nodex2
```

The terrain and water lines are identical to the step 1–5 report's summary, which
shows those compositions are untouched.

## Open questions for the owner

1. **Should the display inversion also cover the nine unlisted raw-output materials?**
   (plume, tornado ×2, fire ×4, lava, puddles). I applied it because on WebGL they
   were effectively `toneMapped: false`. Without it they come out tone-mapped and
   sRGB-encoded: the plume's ash (0.30, 0.28, 0.28), shipped as 77/255, would display
   near 179/255 (0.703, computed with the CPU ACES above). Say which, if any, to
   revert.
2. **Bright saturated colours cannot survive ACES** (table above): the fire's
   ribbon root goes near-white and the mid-orange shifts +9 codes in blue. The only
   exact fix is architectural. Set `renderer.toneMapping = NoToneMapping` (keeping sRGB
   output) and apply ACES per lit material in its `output` slot; raw materials could
   then output `sRGBTransferEOTF(c)` exactly. The cost: lit transparent materials
   (water) would blend in tone-mapped space rather than in radiance. Your call; I did
   not do it.
3. **Reveal clip on billboards is now per fragment.** The GLSL clipped cumulus, spiral
   and tornado-debris puffs by their centre. The node version clips by `positionWorld`,
   so a puff that straddles the frontier is cut along it rather than kept or dropped
   whole. Carrying the centre through would mean the clip effect knows about
   billboards. Keep, or ask for the centre?
4. **`SHADER_DISK_THICKNESS = 0.024`** reproduces the shipped `toFixed(3)` rounding. The
   exact value is 0.023529, 2 % thinner. Keep the shipped look, or use the exact
   constant?
5. **`bakeRig`'s merge key** (`rigSkin.ts:54`, `customProgramCacheKey()`) is
   identity-based for node materials. `c5a01b2` makes the monsters share nodes, but any
   future node-material rig whose parts compose their own nodes will silently
   under-merge: more draw calls, never wrong pixels. A structural key would close it,
   but `toJSON` also serialises texture images, so it is not a cheap swap. Want a
   dedicated signature?
6. **Comments.** The GLSL template strings carried long prose (owner quotes, dates,
   "was 0.75" history) that the repo's comment-budget hook rejects as TS comments. Each
   one is condensed to a ≤30-word comment where it explains non-obvious math; the
   originals are verbatim in the appendix below. Say if any should be restored into
   `docs/decisions/`.
7. **Literals that were literals in the GLSL stayed literals** in the node code, for
   side-by-side review (plume 1.25 / 31.7 / 0.28, tornado churn floors, smoke hash
   salts, …). Every constant the GLSL named stays named, and I named the discard
   thresholds that were bare (`*_ALPHA_DISCARD_THRESHOLD`) plus `FUR_AXIS_WEIGHT_FLOOR`.
   Name the rest too?
8. **`ctx.revealClipUniforms()`** (`plugins/types.ts:138`) has no caller now that
   tornado uses `applyRevealClip`. I left it: removing it changes the plugin API, and
   `client/test/groundShade.test.ts` stubs it. Remove?
9. **Instance normals in `cf8e906`** (not my commit): it transforms the normal by the
   instance matrix directly, not by its inverse transpose. That is exact for rotation
   plus uniform scale, which is what the herd composes today, but not for non-uniform
   instance scale.
10. **Server tests.** 25 server tests fail in this checkout (plugin reload / world
    switch). Nothing here touches the server. Worth a look separately.

## Appendix: GLSL comment prose, verbatim

Every `//` comment in the migrated files as they stood at `e7490c7` (nearly all of it inside GLSL template strings). The node code keeps a condensed ≤30-word version where the math needs one; this appendix keeps the rest.

### `client/src/plugins/kit/cumulusDeck.ts`

```text
A dome: each tier is drawn over a smaller disc than the one below it.

The rim fades, so the deck has no edge; the mass's own intensity fades
the whole thing, so a gathering front costs nothing until it is there.

NOTHING IS DRAWN FOR A PARKED OR DARK SLOT. Every vertex of the quad
lands on the same point outside the clip volume, so the primitive is
culled before it reaches a fragment — the deck's equivalent of
discRig.ts's "a transparent draw call that contributes nothing is still
a transparent draw call".

Bigger toward the top, and never twice the same size in a row.

Oblong, per seed, and area-neutral: stretched along x by the aspect,
squashed along y by the same — see PUFF_ASPECT_SEED_VARIATION.
```

### `plugins/cyclone/client/spiral.ts`

```text
THE EYEWALL PROFILE: 1 at the eyewall, 0 at the rim, and the puff's
size, solidity and shade are read off it. See the TOWER block above —
the deck's depth is a separate linear funnel and is already in aRise,
computed once per layout because the STACK COUNT is what varies with it
and a count cannot be produced in a vertex shader.

THE LOGARITHMIC SPIRAL. aAlong runs 0 at the eyewall to 1 at the rim; the
radius interpolates from the innermost band's centre line to the storm's
edge, and the angle is the arm's own starting angle plus the wrap, MINUS
the whole deck's slow rotation: +angle runs +X towards +Z, which is
CLOCKWISE seen from above, and a cyclone turns anticlockwise (owner,
2026-09-05 — it spun the wrong way). With the wrap positive and the spin
negative the arms TRAIL the rotation, as real bands do; the same sign on
both had them leading. The inner end is the EYE PLUS A PUFF
(CYCLONE_BAND_INNER_RADIUS_FRACTION), so the cloud's inner edge is the
eye rather than its centre line.

A scatter across the arm's width, so an arm is a BAND of cloud and not a
wire. It widens outward, which is what real arms do and what stops the
eyewall being swallowed.

The band an arm covers, narrow at the eyewall and wide at the rim. Kept
narrow for the reason the puff size is: at a wider band the scatter alone
fills the gaps between two arms and the deck is a disc again.

THE OFFSET FROM THE EYE, not the world position: the instance matrix
carries the eye and the project_vertex chunk applies it two lines later.
The Y is absolute because the matrix carries no height — the deck is a
cloud layer at a fixed base, and where the ground under it happens to be
is irrelevant (see ./index.ts's header).

BIGGER AT THE EYEWALL, and varying with the seed so the deck is not a
grid of clones.

This is what makes the wall OCCLUDE rather than merely tint: a puff with
a flat core hides what is behind it, and a hundred puffs that are all
gradient average out into something the far coast shows through.

DARKEST AT THE EYEWALL, THINNING TO THE RIM — see CYCLONE_EYEWALL_SHADE.
A multiplier on the ALBEDO: the deck is lit, so the sun still moves
across it and the storm's own gloom still reaches it.

The outer tenth fades out, so the deck has no edge — the one thing that
would give away that this is a finite set of quads rather than a sky.
```

### `plugins/volcanoes/client/plume.ts`

```text
0 at the mouth, 1 at the top of the column. fract() is what makes one
instance a REPEATING particle rather than a single puff — the phase
attribute spaces the instances evenly around that cycle, so the column is
continuous with no CPU respawning anything.

The instance matrix carries ONLY the vent's position; everything else
about where this particle is happens here.

Rise, eased so particles bunch near the MOUTH and thin out at the top —
a column dense where it leaves the vent, which is what a real one looks
like and what a linear rise conspicuously does not.

THE EXPONENT WAS 0.75 AND THAT BUNCHED THEM AT THE WRONG END: above 1,
pow(life, e) < life, so particles climb slowly at first and spread out
near the top; below 1 they shoot up and pile at the ceiling, which —
with additive blending and a size that grows with life — stacked forty
large bright quads on top of each other and blew the whole column out to
a white ball. Verified in preview-volcano.html, which is what a preview
harness is for.

Lean, fixed per vent by its seed. Quadratic in life so the column goes up
before it goes sideways, instead of setting off at an angle.

Per-particle scatter, so the column is a COLUMN and not a rope. It widens
with life for the same reason the size does: the plume spreads as it
goes. The first value here was half a summit and left the plume a
vertical thread — at this world's vertical scale the spread has to be
comparable to the mountain, not to a cell.

A FLOOR ON THE SPREAD, not pure growth: with scatter proportional to life
alone every particle leaves the mouth on the same axis, and forty
additive quads on one axis is a searchlight beam, not a vent. The floor
is what gives the column a throat.

BILLBOARD IN VIEW SPACE: offset the vertex after the view transform, so
the quad faces the camera exactly, with no rotation written from the CPU
and no chance of lagging the camera by a frame.

A soft round puff. The quad is authored two units across, so vQuad is the
offset from its centre in half-widths and everything past 1 discards.

GLOWING AT THE MOUTH, ASH ABOVE IT. The first fifth of the column is
lit by what it came out of; past that it is cooling dust. Two colours
and one smoothstep, because the transition is the whole picture: a
uniformly grey column reads as smoke from a chimney, and a uniformly
orange one as a fire that happens to be very tall.

In fast, out slow — a particle that appears at full opacity pops.
FADE IN SLOWLY. A fast ramp puts every particle at full strength while it
is still bunched at the mouth, and additive blending turns that into a
clipped white disc sitting on the summit.

Far higher than the additive version's, and that is the blend mode's doing:
under normal blending each particle CONTRIBUTES ITS OWN COLOUR rather than
adding light, so a column of forty converges on the ash colour instead of
running away to white. Still well under 1 so the column is something you
see the sky through, which is what fire's smoke means by a thin volume.
```

### `plugins/tornado/client/funnel.ts`

```text
The geometry is a UNIT open cylinder: uv.y runs 0 at the bottom rim to 1
at the top, and uv.x runs once around. Everything about the funnel's real
shape happens here, so the same geometry serves every tornado.

The instance matrix carries ONLY where the tornado is standing.

THE TAPER. Quadratic rather than linear so the funnel is PINCHED near the
ground and flares late — the shape a tornado actually has. A linear cone
is a megaphone.

THE TWIST AND THE SPIN. Each ring is rotated by a different amount, which
shears the whole cone into a helix — the mesh stays intact because every
vertex in a ring shares its own life value and therefore its rotation.

uv.x IS THE ANGLE, not atan(position.z, position.x): the seam vertices
are duplicated with uv.x = 0 and 1, which is exactly what makes the two
sides of the seam land on the same point. Deriving the angle from the
position would work too, but it would recompute what the geometry
already knows and it would put a discontinuity at the seam.

A WOBBLE OF THE WHOLE AXIS, so the funnel snakes instead of standing
plumb. Two sines at incommensurate rates, which never visibly repeat, and
scaled by the taper so the foot stays planted while the top wanders.

NOTHING IS DRAWN OFF THE RECEIVED MAP (#284). The funnel is one of the
two kinds the server already filters on its CENTRE (broadcastVisible),
and this is the other half of that: a funnel standing near the frontier
is a 28-unit column, so its top can lean over ground this client has
never been sent even when its foot is on ground it has.

See ./spiral.ts's uDaylight note: this material is unlit, so the scene's
own light has to reach it as a number, or a funnel under a cyclone stays
sunlit while the ground around it does not.

The clip FIRST, so a discarded fragment does no other work.

THE CHURN, painted rather than modelled. Two bands of streaks at
incommensurate frequencies scrolling in opposite directions: one is the
condensation spiralling up the wall, the other tears holes in it. Their
beat is what makes a smooth cone look turbulent without a single extra
triangle or a texture fetch.

THE FLOORS ARE HIGH, and that is what makes this a sheet with texture
rather than a lattice of gaps. Two sines multiplied average about a third
of their peak, so the first values here (0.58 and 0.62) put the whole
funnel at a third of its nominal alpha — in world, against a bright sea,
it read as a smear of glass. Raising the floors keeps the streaks and
gives the surface a body.

DIRT AT THE BOTTOM, CLOUD AT THE TOP. What a funnel picks up is the
colour of the ground it is standing on; the top of it is the storm base
it hangs from. One smoothstep between the two is what makes a grey cone
read as a tornado rather than as a chimney.

DENSER AT THE FOOT, DISSOLVING INTO THE CLOUD AT THE TOP. Without the top
fade the cone ends on a hard rim, which reads as a cut-off pipe rather
than as a funnel going up into a storm.

Thrown OUTWARD and up, then falling back — a parabola in height against a
radius that only ever grows. That asymmetry is what reads as debris being
flung out rather than as a ring pulsing.

Clipped like the cone above: debris thrown across the frontier is
geometry over floor this client was never sent.

BILLBOARD IN VIEW SPACE — faces the camera exactly, for free, with no
rotation written from the CPU and no chance of lagging it by a frame.

The quad is authored two units across, so vQuad is the offset from its
centre in half-widths. Harder-edged than the cloud puffs elsewhere in
this plugin: this is dirt and chaff, not vapour.

In fast, out slow, and gone before it lands: a sprite that reached the
ground at full opacity would pile into a solid ring.
```

### `plugins/fire/client/smoke.ts`

```text
The sleeve is authored with its foot at y = 0 and unit height, so
position.y IS the height fraction — no division, no uniform.

Anchor the foot over the fire, free the top.

Two decorrelated lookups so x and z wander independently — one lookup
shared between them would make every column sway along one diagonal.

Neck and swell BEFORE the lean, so the billows are carried sideways with
the column rather than being stretched across a shape that already leant.

The shared draught, on top of the per-column wander: this is what makes a
wood full of fires read as one event rather than as many. Swung off that
shared bearing by a bounded, seed-stable amount per column, because five
columns leaning IDENTICALLY are five parallel pillars and no column of
gas has ever been parallel to the one next to it. Two decorrelated hashes
so bearing and length do not vary together.

Rotating the shared unit bearing, rather than jittering x and z apart,
keeps every column's lean the same LENGTH it was asked for — a component
jitter would quietly make diagonal leans longer than axis-aligned ones.

DISTANCE FADE, measured to the COLUMN'S FOOT and not per-vertex: the
whole column must fade as one body. A per-vertex distance would fade a
column's near side differently from its far side, which is a gradient
across a single object that nothing in the world justifies.

...and it runs from NOTHING at the closest zoom to full at the default
orbit. No floor under it: inside SMOKE_SILENT_DISTANCE the flame is a
fifth of the frame on its own and the column is only in the way.

HOW SQUARELY THIS PIECE OF WALL FACES THE CAMERA, 0 at the silhouette and
1 head-on. This is the term the whole no-visible-billboard problem rests
on, and getting it from the AUTHORED normal — which is what this file
shipped first — is why the sleeve read as a quad.

The normal that matters is the normal of the surface ACTUALLY DRAWN, and
two transforms stand between the two:

  THE WARP, which is a SHEAR. Every stretch above displaces xz by an
  amount that grows with height, so the wall is not the wall the cone
  authored: it is tilted by the rate at which that displacement changes
  with height. At the lean this column now carries that is on the order
  of fifteen degrees, and it tilts the two sides of the column in
  OPPOSITE directions — which is exactly what the renders showed, one
  silhouette edge softening correctly and the other staying hard.

  THE INSTANCE MATRIX, which is a non-uniform SCALE: this sleeve is
  stretched about four times harder up (SMOKE_HEIGHT_PER_FUEL) than out
  (SMOKE_TIP_RADIUS_PER_FUEL), and three's normalMatrix is built from the
  modelView matrix ALONE, with the instance matrix nowhere in it.

Both are undone here, in order, and BOTH ARE EXACT rather than
approximated, because a normal is transformed by the INVERSE TRANSPOSE of
the map that moved the surface and both maps are known in closed form.
The only thing left out is the noise's own dependence on position, which
is a second-order wobble on a term feeding a soft falloff — and recovering
it would mean three more noise evaluations per vertex.

The shear's Jacobian is [[s, gx, 0], [0, 1, 0], [0, gz, s]]: s is the
radial swell, and gx/gz are how fast the lateral displacement grows with
height — the same drift, swell and lean already computed above, times the
slope of the height bias. Its inverse transpose is what the three lines
below apply, at the cost of two multiplies and a divide.

Sooty at the fire, pale where it has cooled and spread.

In off the foot, out into nothing at the top.

Billow, sampled around the column AND up it, so the turning-over crawls
across the surface instead of pulsing the whole sleeve at once. Stronger
near the top: the foot of a column is a coherent stream, the top is where
it breaks up.

No hard outline: the column thins to nothing at its silhouette, which is
the difference between gas and a pane of grey glass.

...and no outline the eye can TRACE either. the billow noise is the same slow noise
the billows are made of, reused rather than sampled again, so the ragged
boundary crawls with the body it belongs to instead of shimmering against
it. (0.5 - 0.5 * turn) maps the noise's -1…1 onto 0…1, deepest where the
noise is darkest.
```

### `plugins/fire/client/scar.ts`

```text
The quad is authored two units across and lying in XZ, so position.xz IS
the offset from the scar's centre in radii — no division, no uniform.

DISTANCE MEASURED TO THE SCAR'S CENTRE, not per-vertex: ./smoke.ts's rule
and its reason — the whole mark must fade as one body, and a per-vertex
distance would fade a scar's near edge differently from its far one.

THE EXACT COMPLEMENT OF ./smoke.ts's vDistanceFade, over the same two
distances: full inside the closest zoom, where a column is drawn at
nothing, and gone by the default orbit, where a column is at full. One
signature, two halves, and the sum of the two is what the player sees.

Distance from the scar's centre in NOMINAL RADII: the outline sits at 1,
the quad reaches SCAR_QUAD_HALF_WIDTH along its axes so the eroded rim can
bulge past 1 without being sliced flat, and everything past the outline —
including all four corners — discards below.

No hard outline, and no outline the eye can trace either. The noise moves
the boundary in and out, so what falls off is a ragged front rather than
an arc — a circle is the one shape a fire never burns.

Char and ash, mottled. Decorrelated from the outline by frequency AND by
seed offset: sampled at the same phase, the pale patches would sit in the
same places as the outline's lobes and the whole mark would read as one
stencil scaled twice.
```

### `plugins/fire/client/flames/ribbons.ts`

```text
Two rotations about the fire's axis, summed: a steady spin for the whole
strip, and a whip that only the upper part of the strip feels.

Breathing, weighted the same way — the roots stay where the fuel is.

Fade along the strip, and across it: a burning sheet has no hard side
edge either, and feathering the sides is what keeps five overlapping
strips from reading as five ribbons of paper.

Flicker travelling UP the strip, keyed to the strip index so no two of
the five gutter together.

Premultiplied: the colour is scaled by its own alpha before it leaves
the shader, which is what the ONE/1−srcAlpha blend above expects.
```

### `plugins/fire/client/flames/shaderPlume.ts`

```text
The sleeve is authored with its foot at y = 0 and unit height, so
position.y IS the height fraction — no division, no uniform.

Anchor the foot, free the tip.

Two decorrelated lookups so x and z lean independently — one lookup
shared between them would make the plume sway along a single diagonal.

Flame silhouette: waist, belly, taper. Applied before the noise, so
the noise deforms the flame shape rather than the cone.

A fiercer fire is a taller one, applied here rather than in the instance
matrix so intensity can change without a rebuild of the matrices.

Colour by height: white-hot at the fuel, orange through the body, dark
red where it is going out.

The plume thins out towards the tip and is solid at the foot.

Flicker, sampled around the plume AND up it, so the guttering crawls
around the surface instead of pulsing the whole sleeve at once. Stronger
near the tip: the foot of a fire is steady, the tip is where it tatters.
```

### `plugins/volcanoes/client/lavaFlow.ts`

```text
The geometry is authored in WORLD space, so position.xz IS the world
plan coordinate — which is what makes the crust pattern below continuous
across the whole flow instead of restarting in every cell.

THE COOLING CURVE, RUN IN THE SHADER — protocol.ts's heatFromAge, restated
in GLSL. This is why nothing is written per frame: aBirth is when this
cell went molten and uElapsed is now, so the heat falls out of one
subtraction and no buffer has to be touched as a flow goes out.

THE CRUST. Cold plates floating on molten rock: the noise field is the
plates, and what shows between them is the glow.

THE VEINS NARROW AS IT COOLS, rather than the colour washing out — and
that is the whole reason there is no brown anywhere in this shader
(owner, 2026-08-27). Fading hot orange toward dark rock passes THROUGH
brown, and a flow spends most of its life in exactly that middle. So the
lit colour never changes; only how much of the surface is lit does. A
half-cooled flow is thin bright cracks on near-black, which is both what
the real thing looks like and the one version of it that is never muddy.

The exponent runs 2 (fresh: broad rivers of lava with plates riding on
them) to 18 (cold: hairline seams), so what changes across a flow's life
is the AREA that is lit and never the colour of it.

A slow, shallow pulse, offset by position so a hillside breathes unevenly
rather than strobing in unison. Lava is a heavy liquid with a skin that
breaks and heals; it does not flicker like flame.

Tightened with a smoothstep so most of the surface is decisively crust or
decisively lava and the band between them is thin — the other half of
keeping the midtones out of the mud.

The hottest seams glow through toward yellow, which is what stops a fresh
flow reading as a single flat orange.

OPAQUE MATTER, AND THE ALPHA IS COVERAGE. This is new ground: nothing it
buried should read through it, so the alpha here is never a see-through
factor. The material is opaque with alphaToCoverage on, so this value is
consumed as the FRACTION OF THE PIXEL'S MSAA SAMPLES the flow occupies —
1 across the body of the flow, easing to 0 at the rim, which resolves to
a soft edge made of geometry coverage rather than of blending. Full
strength therefore writes a fully opaque pixel (the 0.96 that used to sit
here existed only to let the terrace lip read through, which the owner
settled against on 2026-09-01).
```

### `plugins/hydro/client/puddles.ts`

```text
The quad is authored two units across and lying in XZ, so position.xz IS
the offset from the patch's centre in radii — no division, no uniform.

Distance from the centre in NOMINAL RADII — the same input
../protocol.ts's hydroFalloff takes, and the same curve applied to it, so
what is drawn here and what the server douses inside cannot disagree.

Rings travelling outward. They ride ON TOP of the falloff rather than
being multiplied into it, so the ripple can never move the patch's edge —
which is the one thing about this disc that is not a rendering decision.
```

### `plugins/relics/client/gemMaterial.ts`

```text
0 at the top of the gem on screen, 1 at its bottom: the icon's vertical
gradient, spanning the whole gem rather than each face.

The face's own normal, from screen-space derivatives: flat shading with
no normal attribute, as three's own flatShading does it.

A vertex with its own blend (the tile) is painted with it; the rest are
lit. A face is all one or all the other, so the varying never straddles.

The paints are sRGB and the icon blends them as sRGB; blend the same,
then hand three linear light to write out.
```

### `client/src/render/celestialVoid.ts`

```text
The anchor frame (see the header): focal length in screen heights, the
rotation taking a view-space direction into disk space, and the eye's
position in disk space (disk units, z up, plane at z = 0).

1.0 in the world anchor, 0.0 in the view anchor: whether a look that has no
plane to intersect (the nebula's clouds, the wheel's sky above its horizon)
maps the ray onto a dome around the world instead of the view's image plane.

Lambert azimuthal equal-area projection of a direction, from the nadir: a
smooth 2-D domain over every direction but straight up (|p| = 2 there), with
no seam and no stretch at the horizon (|p| = sqrt 2). Near the nadir it is
d.xy to first order, so it matches the plane mapping where the two meet. The
zenith is the one singular point, and the orbit's polar cap
(CAMERA_MAX_POLAR_ANGLE_DEGREES) keeps it off screen.

The same fbm cut to FBM_LOW_OCTAVES, for fields read only on the broad scale (their fine octaves
were below a filament wide and invisible); the same first octaves, so the look is unchanged.

The same noise, periodic in y with period per cells: the lattice row wraps, so a domain
whose y is an angle has no seam. Lacunarity exactly 2 and no y offset keep every octave periodic.

Star layer: one candidate per grid cell, soft falloff, steady (stars do not twinkle here).

drift clock scale; owner set 3x the original 0.05

reference: p = uv*2.2

World anchor only: how much of the eye's offset from the hub (disk units)
slides the clouds. A quarter: panning across the whole default map (±1.28
disk units) moves them by about a third of a screen, which reads as far
away but still attached to the world.

World anchor: clouds on a dome around the world, so orbiting turns them
with the terrain and no camera angle can see them stretch; panning
slides them a little (NEBULA_PARALLAX).

View anchor: the cloud plane is z = 0 in disk space with the eye
u_origin.z = NEBULA_ZOOM*focal above it and u_toDisk the identity, which
makes p exactly the reference's uv*NEBULA_ZOOM.

the reference's screen coordinate, for the star layers

Disk stars: steady points in the disk plane with a screen-space size floor so far stars
never shrink below a pixel and shimmer. minSize is in cell units, from the ray length.

rad/s (2*pi/300 = ~5.0 min per turn); rev 7 owner 2026-09-04: 'about five minutes per turn'; negative = clockwise from above

Depth fade, as multiples of the eye's height above the plane so it is the
same at every zoom in the world anchor: the reference faded between ray
lengths DISK_DIST (2.6) and FAR_FADE (12.0) with the eye 2.6*cos(60deg) = 1.3
above the plane, i.e. between 2.0 and ~9.23 heights. The end is a TS constant
as well: the star field's extents are derived from it.

four gas arms; owner 2026-09-04: 'more than two'

how tightly the arms wind (log-spiral pitch); rev 6: 3.2 -> 6.0 'more circular', rev 7: 8.0

arm cross-section exponent; rev 6: 2.2 -> 1.2 'thicker arms', rev 7: 1.0, rev 14: 1.4 'more definition between the arms'

brightness of the gas arms; rev 6: 1.5 -> 1.2 'a little darker', rev 7: 1.0

warm hub glow; rev 6: 0.55 -> 0.25 and the white core removed, 'get rid of the bright center'

rad of low-frequency phase wander; rev 9: 2.0 'too rigid', rev 10 owner 2026-09-04: 'not random squiggly lines' - arms follow the spiral again

floor under the arm profile so gas spills across the gaps; rev 10: 0.35 'bleed into each other', rev 14: 0.18 'too homogeneous'

disk units per wobble feature: the arms bend on a scale near the disk radius

grain cells per e-fold of radius ALONG an arm (long filaments)

grain cells around the full circle ACROSS the arms (fine filaments); integer, the y period

disk units per hue-drift feature between the deep blue and the violet

e-folding radius of the gas disk, plane units; TS: the in-arm stars' extent is derived from it

Rev 13 (owner 2026-09-05: 'the gas should look diffuse in three dimensions, and the stars should be
placed in three dimensions', and 'don't make the disk any thicker than four world units'). The
gas is a volume under the plane, ray-marched: the arm pattern runs through it as columns
(gasPattern, once per ray), a vertical profile makes it diffuse about each patch's own level,
and 3-D puff noise breaks it up through the thickness (gasDepthProfile, per sample). The stars are
points in three 3-D grids: the in-arm stars inside the gas, the field and fine grids on down to
STAR_FIELD_DEPTH under it, each dimmed by the gas in front of it. They used to be found by walking
those grids per fragment; since issue #342 they are a point cloud drawn after this program (see
STARS_VERT_GLSL and the header), and the numbers below that describe them are its numbers too. The
in-arm grid is the exception: its walk broke before its first voxel, so it has never drawn, and
STAR_ARM_GRID_ENABLED keeps it off until the owner has seen it.
Nothing is above the plane, so the clearance to the map is unchanged.

DISK_THICKNESS_WORLD in disk units; gas and stars both stay within it

march samples through the thickness; rev 16 bench: 10 -> 6 saves ~0.5 ms at 1440p, no visible banding

Rev 14 (owner: 'needs more 3-D variability, still a flat disk'): the depth of peak density is not one
number but a field - each patch of gas sits at its own level between GAS_TOP_Z and GAS_BOTTOM_Z, in
a thin layer, so patches above hide and shade the patches below.

shallowest layer centre

deepest layer centre

sech^2 scale height of each patch about its own level

level-field features per disk unit: patches change level on about the filament scale

gas at the bottom of the slab is this much darker than at the top (a depth cue the eye reads)

optical depth per unit density per disk unit; 160 read like the rev 10 sheet; rev 17 'colors a little more transparent, maybe 20%' 128; rev 18 owner 2026-09-05 'more transparent' 100

3-D puff noise features per disk unit across the disk

... and about three through the thickness, so the puffs vary with depth

how much the puffs modulate the density (0 = columnar gas); rev 14: 0.35 -> 0.7

weight of the second, finer puff octave (0 drops it: one vnoise3 per march step)

The grids' depths (STAR_FIELD_DEPTH, STAR_FINE_DEPTH) and their density boost (STAR_POINT_BOOST)
are TS/JS constants since issue #342: nothing in GLSL reads them now that the point cloud, not the
fragment, decides where the stars are. STAR_WALK went with the walk itself; the ~80% of the coarse
depth it reached at 60 degrees was a bench compromise, and the cloud draws every star instead.

how much fully overlying gas dims a star (1 = hidden)

smallest star radius on screen, px

star cells narrower than this on screen fade out (anti-shimmer); TS too, for the per-frame guard

Rev 17 (owner 2026-09-05: 'make some of the floating stars glow a little bit, and others twinkle just a
little bit'). Each star draws one kind from its own hash: the first GLOW_FRACTION carry a soft halo
GLOW_RADIUS times their core, the next TWINKLE_FRACTION breathe in brightness by TWINKLE_DEPTH at
TWINKLE_RATE with a per-star phase, the rest are steady. u_time is frozen under reduced motion.

halo radius as a multiple of the core radius

halo peak brightness relative to the core

brightness swing, peak to trough, as a fraction of the star

rad/s: about one breath every three seconds

--- the log-polar bake (perf, issue #340) --------------------------------------------------
gasPattern and gasLevel below depend only on rf, the rotating-frame plane position, so they are
evaluated once into two textures at startup (BAKE_GLSL) and read back per fragment. The grid is
the arms' own coordinate: theta across u, wrapping, and s = log(r + S_LOG_EPS) up v, in which a
log spiral is a straight line - so a texel keeps the same shape across an arm at every radius
(its aspect is TAU/BAKE_S_SPAN, a constant) and the grain stays resolved out to the rim.

radius over which the gas ramps in from the hub (a ramp, not a floor)

the offset in s = log(r + eps); keeps s finite at the hub

texels per axis; the TS constant carries the Nyquist derivation

s at the hub: log(S_LOG_EPS)

log(R_BAKE_MAX + S_LOG_EPS) - BAKE_S_MIN

The gas pattern on the plane in the rotating frame: the arms, their grain, lanes and colour.
It is columnar - the same at every depth of the four-unit slab, whose parallax across the
thickness is under a filament wide - so it is baked ONCE into the log-polar texture above and
read back per fragment, and the march below only
varies the vertical profile and the 3-D puffs (rev 16: 6.1 ms -> see the bench in .void-bench).
ARMS log-spiral arms. The arm's own coordinates: s = log r runs ALONG an arm (a log spiral is a
straight line in log-polar space) and thw, the angle in the frame wound so every arm is radial,
runs ACROSS it - an arm sits at a fixed thw. The grain is sampled in (s, thw) with long cells
along and short cells across, so the filaments run along the curve of each arm.

Unwind by MINUS the arm's own twist so the wound angle is phase/ARMS - constant along an arm.

dark dust lanes cut through the arms

Rev 9 palette: deeper and more saturated - a deep blue drifting into violet across the disk,
rose where the grain is dense, a touch of teal in the haze; the warm bulge keeps its colour.

This patch's depth in the slab: the level field of rev 14, baked alongside the pattern.

rf -> bake texture coordinate. u wraps with theta (RepeatWrapping, so the two sides of atan's
branch cut still filter into each other); v spans the hub to R_BAKE_MAX and clamps beyond it,
where the gas is under 1e-3 of its peak.

...and back: the rf that a bake texel centre stands for. Exactly the inverse of gasBakeUv, so a
lookup lands on the texel that was written for it.

Reads the bake through whichever branch of atan has its cut a quarter turn away. RepeatWrapping
gets the VALUE right across the cut, but u jumps by 1 there, and the quad that straddles the
jump derives a huge du/dx and drops to the coarsest mip - a blurred radial line along -x, plain
to see in the hub shot. u+1 reaches the same texel through the branch that is continuous there,
so its cut lies along +x instead; each fragment takes the branch whose cut it is far from.
The two branches sample the same texel wherever both are valid, so the switch itself is unseen.

0: colour and pattern; 1: level

The baked fields: gasPattern's colour in rgb and its pattern in a, gasLevel in the second
texture's r. Half float, so the pattern's ~1.55 peak needs no scaling on the way through.

This pass's own resolution in texels; u_res stays the FULL-res drawing buffer in both programs.

Declared for the bench harness, which lifts it to size its own target (.void-bench/gl2.js); the
app sizes the render target from the TS constant of the same name. The pass itself needs only
the two resolutions, because ceil() rounding makes the ratio not exactly the divisor.

The gas's variation through the thickness at a point: a sech^2 layer about this patch's own level,
broken up by 3-D puffs. Multiplies gasPattern.

sech^2 (no cosh in GLSL ES 1.00): diffuse both ways about the level

mean 1

The full-res pixel this texel stands for. Scaling the texel centre by the exact ratio of the
two buffers — not by GAS_RES_DIVISOR — is what keeps the two passes on the same uv when the
drawing buffer has an odd dimension and the target was rounded up. The wheel reads back at
gl_FragCoord.xy/u_res, which is this mapping inverted exactly.

disk space: plane z = 0, hub at the origin

above the plane's horizon: no gas to march

ray length to the plane

disk coordinates, hub at the origin

rotating frame: everything sampled here turns rigidly

--- gas: the plane pattern once, then march the thickness front to back ---

this patch's depth

lit weight so far

transmittance so far

deeper gas is darker

lit colour before GAS_GAIN; alpha = total gas opacity

The half-res gas pass's output (issue #341): rgb = gasCol*gasAcc before GAS_GAIN, a = the gas
opacity. Bilinear, so a full-res pixel between texel centres gets the interpolated field.

disk space: plane z = 0, hub at the origin

ray length to the plane

disk coordinates, hub at the origin

rotating frame: everything sampled here turns rigidly

fully faded: nothing below would show

--- gas: marched at half resolution into u_gasHalf (issue #341), read back here ---
The exact inverse of the gas pass's own mapping, so the texel a pixel lands on is the one
written for it; between centres the bilinear filter interpolates a field that is smooth
everywhere below the horizon, which is why the fade and the gain stay out of it.

lit gas colour (gasCol*gasAcc), before GAS_GAIN

The stars under the plane are no longer found here: they are a point cloud drawn straight
over this program's output, additively (issue #342, STARS_VERT_GLSL below). col += stars
was already the composite, so the arithmetic is unchanged.

Above the plane's horizon (never in the view anchor at 60deg; the world anchor at a flat
orbit): a still, sparse field so the void is not empty, fixed to the sky direction.

Which grid this Points object is: 0 the coarse field, 1 the fine field, 2 the in-arm stars (which
STAR_ARM_GRID_ENABLED keeps off - the branch below is kept because it is the intended design, not
because anything reaches it today). It is a property of the OBJECT, not of the vertex, so it is a
uniform and the materials differ in nothing else (see createStarPoints).

The half-res gas pass's output (issue #341). Only its alpha is read here — the total gas opacity
along the ray — and only once per star, at the star's own screen position. Bilinear, no mips, so
a vertex-shader texture2D is well defined under GLSL ES 1.00.

The widest a sprite may be: the drawing buffer's long edge. The fragment's falloff is measured
across the sprite, so the clamp has to happen here where both the size and the varying that
carries it can see it.

Per star: radius in disk units, kind on [0,1), brightness on [0.5,1) - the three draws the voxel
hashes used to make, now generated once (render/celestialVoidStars.ts).

the star's colour, everything but the falloff already applied

core radius in px, 1 for a glow star, and the sprite's width in px

the cell fade's own measure, for the in-arm grid as well as the fine one

the fine field's stars are drawn dimmer than the coarse field's

a field star keeps this much of itself with no gas in front of it...

...and gains this much where the gas is thickest

in-arm stars are revealed BY the gas: bright only where it is

so the smoothstep's tail is not clipped by the sprite's edge

Clip space well outside the frustum, for a star that must not rasterise at all.

The rotating frame back into disk space: the wheel samples at rot(pp,-a), so this is that
inverted, and the field turns rigidly with the gas exactly as before.

Disk space back into view space. u_toDisk is a rotation, so its inverse is its transpose, and
rel*u_toDisk is that product (a row vector times the matrix). viewRay is the same map the
other way: u_toDisk*normalize(vec3(uv,-u_focal)).

behind the eye

Screen heights, the wheel's own uv convention. Named suv, not uv: three declares an attribute
vec2 uv in every ShaderMaterial's vertex prefix and shadowing it here would only confuse.

disk units along the ray from the eye (the walk's tBase+along/scale)

ray length to the plane along THIS star's ray

The walk's max(size, minPerT*t*scale) projected: a star never shrinks below STAR_MIN_PX.

Faded out, or off screen by more than the sprite's own half width: no fragment, and no fetch.
At the reference pose over nine tenths of the coarse field is off screen and the fetch is by
far the most expensive thing here, so the order matters.

total gas opacity along the ray

The field grids are dimmed by the gas over them and lifted by the gas in front of them; the
in-arm stars are INSIDE the gas, so nothing is over them and the gas is what reveals them.

Rev 17's kinds, unchanged: the first GLOW_FRACTION carry a halo (the fragment adds it), the
next TWINKLE_FRACTION breathe, the rest are steady. u_time is frozen under reduced motion.
```
