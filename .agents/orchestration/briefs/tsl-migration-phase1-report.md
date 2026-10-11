# Report: WebGPU renderer + TSL migration, phase 1 (client)

Branch `worktree-agent-abf9e857de5b233fe`, merged from `worktree-arena-pad4`
(fast-forward to `5bc22e5`) before any work. Issue #446, arc `arc/gpu-mesher-gates`.

**Status: steps 1–5 of the brief are done; step 6 (plugins, celestial void,
reveal clip) is not started. The client does not run yet** — a `ShaderMaterial`
is refused by the node builder, and the four remaining `onBeforeCompile` splices
are never called on `WebGPURenderer`. Everything below typechecks, tests and
builds; nothing below has been seen on screen.

## Commits

| hash | message |
|---|---|
| `a528f9c` | feat(render): TSL material slot composition helper |
| `965d256` | feat(render): WebGPURenderer, async viewport init, timestamp GPU timer |
| `ff12d36` | feat(terrain): TSL colour and output slots, float self-lit attribute |
| `12a5799` | feat(water): TSL colour, opacity, emissive and band slots |
| `d89613d` | feat(rigs): TSL pose skinning, drop DynamicDrawUsage from client rigs |
| `a7d2e43` | perf(plugins): drop DynamicDrawUsage, which re-uploads whole arrays on WebGPU |
| `1a8ff27` | chore(render): dump terrain and water node graphs for composition diffs |

## Per-file: what it was, what it is

| file | was | now |
|---|---|---|
| `client/src/render/materialSlots.ts` | — (new, 70 lines) | `compose(material, slot, effect)` over six slots + `discard(material, condition)` |
| `client/src/render/nodeMaterialFrom.ts` | — (new) | `toNodeMaterial(source)`: the property copy three's `NodeLibrary.fromMaterial` does, hoisted so a loaded GLB material can carry slots |
| `client/src/render/scene.ts` | `WebGLRenderer`, `localClippingEnabled`, `info.render.calls` | `WebGPURenderer({ trackTimestamp: true })`, `await renderer.init()`, `info.render.drawCalls`, `info.memory.programs`; `localClippingEnabled` gone |
| `client/src/main.tsx` | `createViewport(canvas)` | `await createViewport(canvas)` (top-level await; target is ES2022) |
| `client/src/render/gpuTimer.ts` | `EXT_disjoint_timer_query_webgl2` | `renderer.resolveTimestampsAsync('render')`, one resolve in flight, capped ring of samples; `UNSUPPORTED` when the adapter lacks `timestamp-query` or the perf probe owns the clock |
| `client/src/render/skyEnvironment.ts` | `WebGLRenderer` PMREM | `three/webgpu` `PMREMGenerator`, `RenderTarget`; adds `backgroundRadiance()` (see Background) |
| `client/src/render/skyRig.ts` | `background.setHex(hex)` | `background.copy(backgroundRadiance(hex, renderer))` |
| `client/src/render/terrainMeshes.ts` | `makeSelfLitAware` splice: `vColor` sRGB decode + `outgoingLight = mix(outgoingLight, diffuseColor.rgb, vSelfLit)` | `color` slot = `materialColor * colorSpaceToWorking(vertexColor().rgb, sRGB)`; `output` slot = `mix(output.rgb, diffuseColor.rgb, attribute('selfLit'))`. Material is `MeshStandardNodeMaterial`, `vertexColors` now **false** (three multiplies `vertexColor()` itself when it is true, which would double the term). `DynamicDrawUsage` gone from all four arena attributes |
| `client/src/render/groundShade.ts` | `applyGroundShade` splice on `opaque_fragment` | `output` slot: `vec4(output.rgb * (1 - shade), output.a)` with `uniformArray` for `uShadeA/uShadeB`, `uniform` for sun and count, `Loop`/`Break` for the disc loop. `configureGroundShade`'s boot-only throw is intact — `compiledAgainstMax` now flips inside the `Fn` body, i.e. at first shader build, exactly where the splice used to set it |
| `client/src/terrain/capEmission.ts`, `client/src/terrain/chunkJob.ts` | `selfLit: Uint8Array`, `SELF_LIT = 255`, attribute normalised | `selfLit: Float32Array`, `SELF_LIT = 1`, attribute not normalised (see Blockers) |
| `client/src/render/water.ts` | `makeDepthAware` splices: tint on `color_fragment`, `totalSpecular *=` on a literal line, `totalEmissiveRadiance +=` on `emissivemap_fragment`, `diffuseColor.a *=` on `opaque_fragment` | `color` slot (depth tint), `opacity` slot (depth alpha), `emissive` slot (`+ diffuseColor.rgb * WATER_SELF_LIGHT_RADIANCE`), `specularColorNode` for the specular curve. Material is now `MeshPhysicalNodeMaterial` (see Open questions) |
| `client/src/render/water/waterBands.ts` | `makeBanded` splice on `color_fragment` | `color` slot; `uWaterBandTime` is now a `uniform()` node mutated by the same frame clock |
| `client/src/render/riverRig.ts` | `MeshStandardMaterial` + `makeBanded` + four `DynamicDrawUsage` | `MeshStandardNodeMaterial` + `makeBanded`; usage flags gone |
| `client/src/render/rigHerd.ts` | `poseSkinnedMaterial` splice: `rigPoseMatrix()` GLSL, `transformed` and `objectNormal` | `position` slot inside a `Fn`: `pose * vec4(positionLocal, 1)`, with `normalLocal.assign(pose * vec4(normalLocal, 0))` beside it (the same thing `mat3(pose) * objectNormal` did). Palette read with `textureLoad`. `DynamicDrawUsage` gone from the instance matrix and pose-slot attributes |
| `client/src/render/layerEdgeOverlay.ts`, `client/src/plugins/kit/precipitation.ts` | `DynamicDrawUsage` | gone |
| `client/src/render/celestialVoid.ts` | `renderer.shadowMap.autoUpdate`, `gl.getParameter(ALIASED_POINT_SIZE_RANGE)` | those two lines only: the shadow-map save/restore is dropped (the WebGPU `shadowMap` has no `autoUpdate`) and the point-size cap is the drawing buffer's long edge. **The four `ShaderMaterial`s are untouched** |
| `client/src/perfProbe.ts` | WebGL timer queries, `info.programs`, `getContext()` | timestamp queries, `info.memory.programs`, GPU name from a throwaway WebGL2 context. `programCacheKeys()` returns `[]` — `WebGPURenderer` keeps no enumerable program list, so the drift scenario's program-key diff has no source |
| `plugins/**` (11 files) | 28 `setUsage(DynamicDrawUsage)` | all removed |
| `client/scripts/dumpMaterialGraphs.mts` | — (new) | prints the terrain and water node graphs as JSON; runs under plain Node with no GPU device |

## The background

`scene.background` is tone-mapped on WebGPU because the renderer draws the whole
frame into an intermediate working-space target whenever tone mapping or an
output colour space is set (`Renderer.needsFrameBufferTarget` /
`_getFrameBufferTarget`, `three.webgpu.js:60606`) and converts in a separate
output pass. The clear colour lives inside that target, so it is tone-mapped
too; `Background.update` (`three.webgpu.js:48892`) writes the **linear** value of
`scene.background` straight into `clearColorValue`. That is the whole mechanism
behind the bench's sky reading, and I verified the bench pixels rather than
trusting the summary: `webgl.png` top row is `159,199,232`, `webgpu.png` is
`196,214,226`, and `sRGBencode(ACES(linear(0x9fc7e8), exposure 1.25))` is
`195.5, 214.5, 225.7`. It matches to under one code value.

**Chosen: pre-invert, not "tone mapping off".** Per-material `toneMapped` is
ignored by `WebGPURenderer` (grep: the string does not appear in
`three.webgpu.js`) and a `backgroundNode` goes through the same output pass, so
there is nothing to turn off. `skyEnvironment.backgroundRadiance(hex, renderer)`
returns the radiance that ACES maps back to the authored sRGB value: it inverts
the two 3×3 ACES matrices (computed at module load from the constants already in
that file, no hard-coded inverses) and solves `rrtAndOdtFit` as the quadratic it
is. It is the exact per-channel inverse, not the luminance bisection
`radianceMatchingDisplay` already used for the environment map. If tone mapping
is not ACES it returns the colour unchanged.

**Where it applies, and where it does not.** The app's own scene never sets
`scene.background` — `createViewport` leaves it null and the sky is the celestial
void's mesh plus a black clear, so the app's sky is unaffected either way (ACES
of black is black). The only live caller is `applySkyRig`, which updates a
background *if one exists*; that call now goes through `backgroundRadiance`. The
15 `preview*.ts` harnesses still build their own `WebGLRenderer` and set a plain
`Color`, which is correct for WebGL and untouched. **This means the fix is
untested against the bench's own number** — the bench page is not app code and I
did not re-run it (no app launch). Re-running `ab.html` with the background set
to `backgroundRadiance(SKY_COLOR)` is the check.

## Blockers found that the brief did not name

1. **WebGPU has no one-component 8-bit vertex format, and three does not pad
   itemSize 1.** `WebGPUAttributeUtils._getVertexFormat` takes the `itemSize === 1`
   branch and looks the array up in `typeArraysToVertexFormatPrefixForItemSize1`,
   which lists only Int32/Int16/Uint32/Uint16/Float32 — `Uint8Array` is absent,
   so the format is `undefined` and the pipeline is invalid. The padding path
   above it is guarded by `itemSize > 1`. The terrain arena's `selfLit`
   (`Uint8Array` ×1, normalised) is exactly that case. The bench never hit it
   because its material never read the attribute, so three never bound it.
   **Fix applied: `selfLit` is a `Float32Array` and `SELF_LIT` is `1`.** That
   costs 3 bytes per vertex: about +14 % on the post-fix stroke traffic
   (21 → 24 B/vertex) and about +75 MB of arena capacity across the 16
   super-meshes at the shipped headroom. See Open questions for the cheaper fix
   I did not take.
2. **`toneMapped: false` does nothing on WebGPU** (see Background). Four
   celestial-void materials and two relics materials set it. When they are
   migrated they will need the same pre-inversion, or the void's stars and the
   relic gems will come out tone-mapped.
3. **The 8-bit ×3 audit is clean.** After the pad4 merge there is no
   `Int8Array`/`Uint8Array` `BufferAttribute` left anywhere in `client/src` or
   `plugins`: `grep -rnE "new (Instanced)?BufferAttribute\(" | grep -iE "int8|uint8"`
   returns nothing. `frontierFog.ts`'s `COLOR_COMPONENTS_PER_VERTEX` is 4 over a
   `Float32Array`, so the contract's note about it is stale. Every remaining
   8-bit array is a texture or a CPU-side bitset.

## What could not be done, per file

Step 6 is untouched. Nothing below has been edited beyond the two compile-level
lines noted for `celestialVoid.ts`.

| file | what remains |
|---|---|
| `client/src/render/revealMask.ts` | `applyRevealClip` → `discard` effect. Written and verified to typecheck, then **reverted**: narrowing the parameter to `NodeMaterial` cascades through `plugins/types.ts:136`, `world.ts:455`, `kit/discRig.ts`, `kit/cumulusDeck.ts` and five plugin rigs, and one of the callers (`cyclone/client/spiral.ts:339`) passes a `ShaderMaterial`, so it cannot land before spiral does. The node expression that worked: `positionWorld.xz.div(uniform(chunksPerEdge × worldUnitsPerChunk))`, then `uv.lessThan(vec2(0)).any().or(uv.greaterThan(vec2(1)).any()).or(texture(mask).sample(uv).r.lessThan(REVEAL_CLIP_THRESHOLD))`, with `maskNode.value` and the span uniform re-pointed in `sync()` when the world size changes |
| `client/src/plugins/kit/cumulusDeck.ts` | `position` (mass placement + billboard), `normal` (fake sphere), `discard` (puff mask + alpha). Blocked on the same narrowing; also needs `kit/puffDeck.ts`'s GLSL string helpers turned into node helpers, which are shared with `cyclone/spiral.ts` and `volcanoes/plume.ts` |
| `client/src/plugins/kit/puffDeck.ts` | five exported GLSL strings → TSL helpers; three consumers |
| `client/src/plugins/kit/revealClip.ts` | re-exports three GLSL strings for `tornado/funnel.ts`; dies with it |
| `client/src/render/celestialVoid.ts` | 4 `ShaderMaterial`s (gas half-res pass, gas composite, stars, wheel) → `NodeMaterial` with `vertexNode`/`fragmentNode`; stars → `PointsNodeMaterial` with `sizeNode`; all four also need the tone-mapping pre-inversion because `toneMapped: false` is now inert |
| `plugins/cyclone/client/spiral.ts` | `onBeforeCompile` + 1 `ShaderMaterial` → `position`/`discard` |
| `plugins/monsters/client/geometry.ts` | 2 `onBeforeCompile` (fur shells, alpha) → `color`/`discard` |
| `plugins/saucers/client/effects.ts` | 1 `onBeforeCompile` → `opacity` from an instanced attribute |
| `plugins/tornado/client/funnel.ts` | 2 `ShaderMaterial`s (cone, debris) → `NodeMaterial`; the hand-merged reveal uniforms become two `applyRevealClip` calls |
| `plugins/fire/client/{smoke,scar,flames/ribbons,flames/shaderPlume}.ts` | 4 `ShaderMaterial`s |
| `plugins/volcanoes/client/{lavaFlow,plume}.ts` | 2 `ShaderMaterial`s |
| `plugins/relics/client/{gemMaterial,relicSpire}.ts` | 2 `ShaderMaterial`s, both `toneMapped: false` |
| `plugins/hydro/client/puddles.ts` | 1 `ShaderMaterial` |
| `client/src/render/shaderSplice.ts` | still imported by `revealMask.ts`, `cumulusDeck.ts`, `cyclone/spiral.ts`, `saucers/effects.ts`; delete when those four are done |
| `client/src/render/rigSkin.ts:421` | `clone.onBeforeCompile = material.onBeforeCompile` is now a no-op copy; harmless, remove with the rest |
| `client/src/preview*.ts` (15 files) | still build a `WebGLRenderer`. Those that import migrated app code (`previewWater`, `previewRivers`, `previewGrass`, `previewSpecies`, and any using `createRigHerd`) will fail at runtime, because a `NodeMaterial` cannot be built by `WebGLRenderer`. Not in the brief's scope; they typecheck, they will not run |

Why I stopped here rather than pushing on: what remains is roughly 6,000 lines
across 15 files of hand-written GLSL, and the owner's acceptance test is "it
looks the same", judged from screenshots. Translating that volume in one drop,
with no way to run the app or a GPU, would produce a change that is neither
verifiable nor reviewable. Steps 1–5 are a coherent, checked unit; step 6 is its
own pass.

## Test expectations changed (contract was the reason)

| test | old | new |
|---|---|---|
| `terrainMeshes.test.ts` "binds the self-lit flag as a normalised one-byte attribute" | `normalized === true`, `array instanceof Uint8Array` | renamed to "…as a one-component float attribute"; `normalized === false`, `array instanceof Float32Array` |
| `terrainMeshes.test.ts` "patches the terrain shader so a flagged vertex is shaded unlit" | called `material.onBeforeCompile` on `ShaderLib.physical` and asserted the spliced GLSL text and its position relative to `opaque_fragment` | replaced by "composes the terrain colour and output slots instead of vertex colours": `isNodeMaterial`, `vertexColors === false`, `colorNode !== null`, `outputNode !== null` |
| `terrainMeshes.test.ts` "refuses to silently no-op when three moves an anchor" | expected `/shader patch failed/` | **removed**: there is no anchor to lose. Test count 600 → 599 |
| `rigHerd.test.ts` `paletteOf` helper | read the palette out of `shader.uniforms.rigPosePalette` after calling `onBeforeCompile` | reads `herd.posePalette`. This added `readonly posePalette: DataTexture` to the `RigHerd` interface — the palette had no other observable route once the uniform was gone |

No tests were added.

## Verification, verbatim

```
$ pnpm typecheck
plugins/tornado typecheck: Done
server typecheck$ tsc --noEmit
plugins/volcanoes typecheck: Done
plugins/weather typecheck: Done
plugins/wildlife typecheck: Done
server typecheck: Done
=== EXIT 0 ===
```

```
$ cd client && npx vitest run
 Test Files  41 passed (41)
      Tests  599 passed (599)
   Duration  71.24s (transform 17.43s, setup 0ms, import 33.03s, tests 113.04s, environment 6ms)
```

```
$ cd client && npx vite build
dist/assets/index-m6BFAapo.js               1,845.55 kB │ gzip: 556.01 kB
✓ built in 1.15s
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

Static composition check — the node graphs build under plain Node with no GPU
device, so nothing had to be skipped. Slot-by-slot summary of
`node.toJSON()` (`node type <- child node types`):

```
$ node client/scripts/dumpMaterialGraphs.mts
terrain MeshStandardNodeMaterial
  positionNode: null
  normalNode: null
  colorNode: VarNode <- ColorSpaceNodex1, MaterialNodex1, OperatorNodex1, SplitNodex1, VertexColorNodex1
  opacityNode: null
  emissiveNode: null
  outputNode: VarNode <- AttributeNodex1, JoinNodex2, MathNodex2, Nodex2, OperatorNodex1, PropertyNodex2, SplitNodex5, VarNodex5
  specularColorNode: null
  maskNode: null
water MeshPhysicalNodeMaterial
  positionNode: null
  normalNode: null
  colorNode: VarNode <- ConditionalNodex1, ConstNodex38, MaterialNodex1, MathNodex15, Nodex2, OperatorNodex31, SplitNodex2, TextureNodex1, UniformGroupNodex1, UniformNodex2, VarNodex51
  opacityNode: VarNode <- ConstNodex2, MaterialNodex1, Nodex2, OperatorNodex4, SplitNodex2, TextureNodex1, UniformGroupNodex1, UniformNodex1, VarNodex4
  emissiveNode: VarNode <- ConstNodex1, MaterialNodex1, OperatorNodex2, PropertyNodex1, SplitNodex1, VarNodex1
  outputNode: VarNode <- JoinNodex1, MathNodex1, Nodex2, OperatorNodex1, PropertyNodex1, SplitNodex2, VarNodex3
  specularColorNode: VarNode <- ConstNodex2, ConvertNodex1, Nodex2, OperatorNodex3, SplitNodex2, TextureNodex1, UniformGroupNodex1, UniformNodex1, VarNodex4
  maskNode: null
```

Terrain reads: `colorNode` = `materialColor` × sRGB-decoded `vertexColor`;
`outputNode` = the self-lit `mix` over the `selfLit` attribute and `diffuseColor`,
then the ground-shade multiply. Water reads: the depth tint's `ConditionalNode`
and the band field in `colorNode`, the depth alpha in `opacityNode`, the
self-light in `emissiveNode`, the curve texture in `specularColorNode`, the
ground shade in `outputNode`. Ground shade's
loop body lives inside an `Fn`, so it does not expand in the dump — the dump is a
composition diff, not a shader dump. `renderer.debug.getShaderAsync` was not
usable: it needs a device.

## Open questions for the owner

1. **`selfLit` as a float, or packed into the colour byte the ×4 layout already
   wastes?** I took the float. The cheaper fix is to write `selfLit` into
   `colors[v*4 + 3]` — the pad byte that pad4 created and `capEmission` never
   writes — and drop the attribute entirely: −1 byte per vertex instead of +3,
   and one fewer buffer in every stroke upload. I did not take it because it
   changes `capEmission`, `chunkJob`'s worker protocol, the arena's copy and
   growth paths, and about 30 assertions in `vertexGrid.test.ts`, and I cannot
   measure the result. Worth doing as its own commit if you want the bytes back.
2. **Water's specular curve, and the material class it dragged in.** The brief
   picked `specularColorNode`, which only exists on `MeshPhysicalNodeMaterial`,
   so `water.ts`'s material changed class from Standard to Physical. With
   clearcoat/sheen/transmission/iridescence all at their defaults the lighting
   model is the same `PhysicalLightingModel` and F0 is the same 0.04, so I expect
   no visual change beyond a heavier shader — unverified. The behavioural
   difference from today: the old splice scaled `totalSpecular` after the BRDF,
   the new one scales F0 before it, so deep water damps less at grazing angles
   where Fresnel drives the response to 1 regardless of F0. If that reads wrong,
   `roughnessNode` is the other hook; say which and it is a one-line change.
   Rivers stayed `MeshStandardNodeMaterial` — they have no specular curve.
3. **`forceSinglePass` on the transparent DoubleSide node materials** (water,
   river water, plumes, ribbons) — contract §7 open item, still yours. Not set.
4. **The terrain normal attribute may now be dead.** With `flatShading` the node
   graph never reads `normalLocal`, and three only creates and uploads the
   attributes the graph names — so the arena's `Int8Array ×4` normals may cost
   nothing on the GPU and 4 bytes per vertex of pointless CPU traffic. Unverified;
   worth a look with the arena stats once the app runs, because dropping them
   would be another ~19 % off the stroke bytes.
5. **`programCacheKeys` returns `[]`.** The perf probe's drift scenario reported
   newly compiled programs by cache key; `WebGPURenderer` exposes no such list.
   `info.memory.programs` is a count and is still reported. Say if you want the
   drift check rebuilt on the count instead.
6. **Previews.** 15 `preview*.ts` harnesses still create a `WebGLRenderer`; the
   ones that import migrated app code will throw at runtime. Migrating them is
   mechanical (`new WebGPURenderer(...)` + `await renderer.init()`), but it was
   not in the brief. Want it folded into step 6?
