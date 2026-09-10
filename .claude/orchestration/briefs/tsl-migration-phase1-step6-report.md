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

| file | GLSL site | now | not reproduced exactly |
|---|---|---|---|
| `client/src/plugins/kit/puffDeck.ts` | 5 GLSL strings | `puffInstanceBase(instanceMatrix)`, `puffBillboard(world, size)`, `puffMask(innerEdge, lobing?)` → `{ puff, discarded }`, `puffLobeScale(lobing)`, `puffAlphaDiscard(alpha)`, plus `PUFF_QUAD`. The names lost their `Glsl`/`_GLSL` suffix. Parameters: the GLSL's implicit `vQuad`, `world`, `size`, `alpha` are explicit, and `seedVarying: string` became `seed: Node` | The billboard returns a position-slot position (`modelWorldMatrixInverse * cameraWorldMatrix * billboardedView`), so three's own MVP lands it where `gl_Position` was |
| `client/src/plugins/kit/cumulusDeck.ts` | `onBeforeCompile` on `MeshLambertMaterial` | `MeshLambertNodeMaterial`: `position` (placement + billboard), `normal` (fake sphere), `opacity` (alpha), two `discard`s (puff mask, faint alpha); mass arrays became `uniformArray` of `Vector2` | A parked slot used to write `gl_Position = vec4(2,2,2,1)`. The slot now collapses the quad to its centre: zero area, no fragments, same result. The reveal clip now tests each fragment's world position; the GLSL tested the puff centre (`transformed`), so a puff that straddles the reveal edge is cut rather than kept or dropped whole |
| `plugins/cyclone/client/spiral.ts` | `onBeforeCompile` | `MeshLambertNodeMaterial`: `position`, `normal`, `color` (eyewall shade), `opacity`, 2 `discard`s | Same reveal-clip note as the deck |
| `plugins/volcanoes/client/plume.ts` | `ShaderMaterial` | `NodeMaterial` (unlit) with slots: `position`, `color`, `opacity`, 2 `discard`s, `output` (display inversion) | Blending happens in linear light before tone mapping, not on display bytes (see Tone mapping) |
| `client/src/render/revealMask.ts` | `applyRevealClip` splice | `discard` effect: `positionWorld.xz / span`, out-of-range uv, mask texel `< REVEAL_CLIP_THRESHOLD`. One `texture()` node and a span `uniform` per mask, re-pointed in `sync()` on a resize. `.sample()` clones reference the base's value (`TextureNode.js:678-686, 205-207`) | — |
| `client/src/plugins/types.ts:136`, `client/src/world.ts:455`, `kit/discRig.ts`, `kit/hazeBank.ts`, `kit/precipitation.ts`, `plugins/cyclone/client/rain.ts`, `plugins/thunderstorm/client/rig.ts` | parameter `Material` | parameter `NodeMaterial`. The haze sheets, precipitation line/points and thunderstorm glow/bolt materials are now built as `MeshBasicNodeMaterial`, `LineBasicNodeMaterial` and `PointsNodeMaterial`: the same classes `NodeLibrary.fromMaterial` would substitute at render | — |
| `plugins/tornado/client/funnel.ts` | 2 `ShaderMaterial`s with hand-merged reveal uniforms | two `NodeMaterial`s with slots (`position`, `color`, `opacity`, `discard`, `output`) and two `applyRevealClip` calls (rule 8). `createFunnel` takes `applyRevealClip` instead of the uniforms. The cone and debris share one `uElapsed` and one `uDaylight` uniform node | The debris' reveal clip is per fragment (see the deck) |
| `client/src/plugins/kit/revealClip.ts` | GLSL re-exports | deleted | — |
| `plugins/monsters/client/geometry.ts` | 2 `onBeforeCompile` (fur `color_fragment`, shell `discard`) | `MeshLambertNodeMaterial`: `color` (× triplanar fur) and `discard` (shell threshold). The triplanar sample reads `positionGeometry` / `normalGeometry` | The GLSL read `transformed` and `objectNormal` at `begin_vertex`. For an unskinned mesh those are the same attributes |
| `plugins/saucers/client/effects.ts` | 1 `onBeforeCompile` | `opacity` slot × `attribute('instancedAlpha')`. All five `MeshBasicMaterial`s in the file are `MeshBasicNodeMaterial` | — |
| `plugins/fire/client/smoke.ts` | `ShaderMaterial` | `NodeMaterial`, **vertexNode / fragmentNode**. The foot distance and the instance scale read `instanceMatrix(mesh)`; GLSL's `normalMatrix` is written as `cameraViewMatrix * (modelNormalMatrix * n)` | Blending (see Tone mapping) |
| `plugins/fire/client/scar.ts` | `ShaderMaterial` | **vertexNode / fragmentNode** | Blending |
| `plugins/fire/client/flames/ribbons.ts` | `ShaderMaterial`, premultiplied custom blend | **vertexNode / fragmentNode**, same `CustomBlending` One / OneMinusSrcAlpha. `uSpinRates` became a `uniformArray` | The display inversion runs before the premultiply. `RIBBON_GAIN` pushes the root colour past 1, which WebGL clipped at the framebuffer; see the round-trip table |
| `plugins/fire/client/flames/shaderPlume.ts` | `ShaderMaterial` | **vertexNode / fragmentNode** | Blending |
| `plugins/fire/client/valueNoiseGlsl.ts` → `valueNoise.ts` | GLSL string | `hash21`, `vnoise`, `fnoise` as `Fn`s with `setLayout` (real WGSL functions) | — |
| `plugins/volcanoes/client/lavaFlow.ts` | `ShaderMaterial`, opaque, alpha-to-coverage | **vertexNode / fragmentNode**. The lava noise is local `Fn`s named `lavaHash21` / `lavaNoise`. Alpha to coverage stays on, and three enables it only when MSAA is on (`WebGPUPipelineUtils.js:213`) | The three `LAVA_*_RGB` strings became number tuples with the same values |
| `plugins/hydro/client/puddles.ts` | `ShaderMaterial` | **fragmentNode** only: its GLSL vertex stage was exactly three's `P * MV * instanceMatrix * position`, so `vertexNode` stays null | Blending |
| `plugins/relics/client/gemMaterial.ts` | `ShaderMaterial`, `toneMapped: false`, `colorspace_fragment` | **vertexNode / fragmentNode**, fragment → `radianceForDisplay(srgb)`. `dFdy` keeps GL's sign (three emits `- dpdy`, `WGSLNodeBuilder.js:221`) | — |
| `plugins/relics/client/relicSpire.ts` | `ShaderMaterial`, `toneMapped: false` | **vertexNode / fragmentNode**. The pulsing `uAlpha` is `material.opacity` through `materialOpacity`, and `index.ts` sets `opacity` | — |
| `client/src/render/celestialVoid.ts` | 4 `ShaderMaterial`s (bake, gas half-res, nebula/wheel composite, stars) | bake, gas and composite are `NodeMaterial`s with **vertexNode / fragmentNode** (full-screen triangle). Stars are **`PointsNodeMaterial` with `sizeNode`** on a `Sprite` with `count`. `WebGLRenderTarget` → `RenderTarget` | See "Celestial void" below |
| `client/src/render/displayRadiance.ts` | — (new) | the ACES constants, inverse matrices and fit inverse (moved from `skyEnvironment.ts`), plus `radianceForDisplay(displayed)` | — |
| `client/src/render/instanceMatrix.ts` | — (new) | see the contract gaps above | — |
| `client/src/render/materialSlots.ts` | — | `discard` memoises its mask nodes | — |
| `client/src/render/shaderSplice.ts` | — | deleted | — |
| `client/src/render/rigSkin.ts:421` | `clone.onBeforeCompile = material.onBeforeCompile` | removed | — |
| `client/src/preview*.ts` (15) | `WebGLRenderer` | `WebGPURenderer` from `three/webgpu`, `await renderer.init()` before the first frame (top-level await, or `main` made async), `scene.background = backgroundRadiance(hex, renderer)` set after the tone-mapping configuration. `previewWater`'s night backdrop goes through the same call. `info.render.calls` → `drawCalls` (previewFire, previewStructures). `previewMusic.ts` has no renderer | — |

Dropped as dead code: the void's `dstars()`, which nothing called, and the `t` argument
of `stars()`, which was never read.

### Celestial void

- **Stars, and why a `Sprite`.** `PointsNodeMaterial.setupVertex` expands a sized quad
  only when `builder.object.isPoints` is false. For a `Points` object it draws plain
  1-pixel points and ignores `sizeNode` (`PointsNodeMaterial.js`, `setupVertex` /
  `setupVertexSprite`). So each grid is a `Sprite` with `count` = its star count.
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
numbers (`NodeUtils.js:322`).

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

**Blending cannot match exactly either.** WebGL blended these transparent programs on
display bytes. WebGPU blends in linear light before the output pass tone-maps. An
opaque pixel over black matches, but a half-transparent smoke puff over a bright sky
will not. The same holds for the stars, which are added over the gas.

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
   originals are in `git show e7490c7:<file>`. Say if any should be restored into
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
