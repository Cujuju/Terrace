# TSL material composition contract (document only)

Issue #446, arc `arc/gpu-mesher-gates`. Written 2026-09-10 from a source
inventory of every `onBeforeCompile` splice and `ShaderMaterial` in `client/`
and `plugins/*/client` (Sonnet sweep, key claims re-read by the lead:
`shaderSplice.ts`, `terrainMeshes.ts:57-93,203-211`, `groundShade.ts:98-200`,
`revealMask.ts:112-150`, `water.ts:72-167`, `water/waterBands.ts:50-96`) and
from the installed three 0.185.1 WebGPU build
(`client/node_modules/three/build/three.webgpu.js`). Settle with the owner
before any file is touched. Gate 4 starts only if gate 2 passes and the tracing
capture shows the stroke tail is upload-bound.

## 1. What composes today, and why it dies on WebGPU

All customisation goes through `spliceShader(source, anchor, replacement,
label)` (`client/src/render/shaderSplice.ts:1-14`): a string `.replace()` of a
literal `#include <chunk>` anchor, throwing if the anchor is absent. Every
helper re-emits the anchor inside its replacement so the next helper can find
it, and every wrapping helper calls the previous `onBeforeCompile` first. So
**call order = compile order = final GLSL text order**, and the only safety
net is the throw.

Verified chains (helper order as called):

| material | file | chain | slot each step really targets |
|---|---|---|---|
| terrain chunks, `MeshStandardMaterial` vertexColors + flatShading + DoubleSide | `terrainMeshes.ts:203-211` | `makeSelfLitAware` → `applyGroundShade` | vertex: `selfLit` attribute, sRGB decode of `vColor`; fragment: `outgoingLight = mix(outgoingLight, diffuseColor, selfLit)` then `outgoingLight *= 1 − shade`, both spliced before `opaque_fragment` |
| water, `MeshStandardMaterial` transparent, depthWrite off, DoubleSide | `water.ts:165-167` | `makeDepthAware` → `applyGroundShade` → `makeBanded` | `diffuseColor.rgb *=` depth tint (`color_fragment`), `*=` band field (`color_fragment`, lands textually *before* the tint because it re-anchored last), `totalEmissiveRadiance += diffuseColor × WATER_SELF_LIGHT_RADIANCE` (`emissivemap_fragment`), specular `*=` curve texture (a literal non-include line), `diffuseColor.a *=` depth alpha (`opaque_fragment`), then ground shade on `outgoingLight` |
| rivers | `riverRig.ts:100-183` | own depth splices → `makeBanded` | same slots as water |
| reveal clip (plugin materials: cumulus decks, disc rigs, cyclone spiral and rain; tornado merges the uniforms by hand) | `revealMask.ts:112-150`, callers via `ctx.applyRevealClip` (`plugins/types.ts:136`) | wraps previous | vertex: world xz varying; fragment: two `discard`s after `clipping_planes_fragment` |
| pose skinning, billboards, fur, instanced alpha | `rigHerd.ts:286-306`, `kit/cumulusDeck.ts:213-256`, `cyclone/client/spiral.ts`, `monsters/client/geometry.ts:220,295`, `saucers/client/effects.ts:67-93` | direct or wrapping | vertex position (`begin_vertex` / `project_vertex`), `alphatest_fragment` discards, `diffuseColor *=`, `normal_fragment` |

The brief's assumed four-way terrain chain (ground shade + reveal clip + band
colour + water emissive on one material) does not exist: band colour is a CPU
palette baked into the `color` attribute (`terrain/bandColors.ts`), reveal clip
never touches terrain, and the emissive is water's.

Counts from source: 16 files with `onBeforeCompile` (12 in `client/src`, 3 in
plugins), 15 `new ShaderMaterial` sites in 6 files. On `WebGPURenderer` with
node materials `onBeforeCompile` is never called (the 2026-09-09 run:
61 splices silently lost) and `ShaderMaterial` is refused by the node builder
(23 refused).

Lifecycle facts that must survive: `configureGroundShade(max)` bakes
`GROUND_SHADE_MAX` into the shader and throws if changed after first compile
(`groundShade.ts:98-109`); terrain and water share one uniforms object
(`groundShade.ts:79-84`), one `setGroundShade` feeds both.

## 2. The contract

**An effect is a node function on one named slot: `(previous: Node) => Node`.**
It receives the slot's current node, returns the slot's new node, and touches
nothing else. Slots are the `NodeMaterial` inputs three already defines; their
defaults are three's own defaults, so a material with no effects is the stock
material.

| slot | three property | default when empty | stage | what lives here |
|---|---|---|---|---|
| `position` | `positionNode` | `positionLocal` | vertex | 8-byte terrain vertex decode (#445 §3), pose-palette skinning, billboard placement, instanced offsets |
| `normal` | `normalNode` | derivative flat normal when `flatShading` (`isFlatShading`, `three.webgpu.js:50901`) | fragment | cumulus fake sphere normal; terrain needs nothing (flatShading) |
| `color` | `colorNode` | `vertexColor()` or `materialColor` | fragment, pre-lighting | terrain palette lookup, water depth tint, water bands, fur triplanar multiply |
| `opacity` | `opacityNode` | `materialOpacity` | fragment, pre-lighting | water depth alpha, instanced alpha fade |
| `emissive` | `emissiveNode` | 0 | fragment, added after lighting (`setupLighting`, `three.webgpu.js:21852-21885`) | water self-light |
| `discard` | a `Discard(cond)` node stacked in the fragment | none | fragment, before lighting | reveal clip mask, puff alpha masks, fur shell threshold — replaces every `alphatest_fragment` / `clipping_planes_fragment` splice |
| `output` | `outputNode` composed on the `output` property node | `output` = `vec4(outgoingLight + emissive, alpha)` after fog (`three.webgpu.js:21308-21317`; no fog is used in this client, grep 2026-09-10) | fragment, post-lighting, pre tone-mapping | self-lit mix, ground shade multiply — exactly where `outgoingLight` was edited |

Rules:

1. **One slot per effect, declared in its signature.** `applyGroundShade` is an
   `output` effect; `applyRevealClip` is a `discard` effect; `makeBanded` is a
   `color` effect. An effect that needs two slots (water depth: `color`,
   `opacity`, `emissive`, and the specular curve) registers one function per
   slot.
2. **Composition is by explicit argument, never by text position.**
   `compose(material, slot, fn)` reads the slot (or its default), calls
   `fn(previous)`, assigns the result. Later composes outer, same as today's
   call order, but the previous value is a node the effect holds in its hand;
   there is no anchor to lose and nothing for three's chunk renames to break.
3. **A material factory is the one place that orders its own slots.** Terrain:
   `output` = shade(selfLit(output)) — self-lit surfaces are still darkened by
   ground-shade discs, the shipped behaviour. Water: `color` = bands(tint(base));
   both are multiplies, so this order is a convention, not a dependency (it is
   the reverse of today's accidental text order, which is harmless for the
   same reason). Effects never assume anything about their neighbours.
4. **Varyings are nodes.** `positionWorld`, `positionView`, `vertexIndex`,
   `instanceIndex` replace every hand-rolled `v*` varying; the reveal clip reads
   `positionWorld.xz` in the fragment stage directly. Vertex-stage-only work
   that must reach the fragment uses `varying()`.
5. **Uniform lifecycles are unchanged.** `uniformArray` sizes are baked into the
   pipeline like `GROUND_SHADE_MAX` is today; `configureGroundShade` keeps its
   boot-only rule and its throw. Shared uniform objects stay shared (terrain
   and water read the same `uniform()` nodes).
6. **Raw WGSL is allowed only through `wgslFn`, and only for a whole stage
   that has no slot.** The gate's compute mesher (#445) is the case. A
   fragment or vertex effect never drops to WGSL: it would re-create the
   text-order problem inside a node graph.
7. **`ShaderMaterial` becomes `NodeMaterial` with the same slots.** A full
   custom program uses `vertexNode` + `fragmentNode` (the escape hatch for the
   celestial void's offscreen passes and star sprites); everything else maps to
   `position` / `color` / `opacity` / `discard`. Flags (`transparent`, `side`,
   `blending`, `depthWrite`, `alphaToCoverage`, `toneMapped`) are the same
   properties on `NodeMaterial`.
8. **Plugin API shape is unchanged.** `ctx.applyRevealClip(material, label)` and
   `applyGroundShade(material, label)` keep their names and arity; the
   parameter type narrows to `NodeMaterial`. Tornado's hand-merged reveal
   uniforms (`tornado/client/funnel.ts:312,336`) become two `applyRevealClip`
   calls.

## 3. The helper

```ts
// client/src/render/materialSlots.ts (proposed; not written)
type Slot = 'position' | 'normal' | 'color' | 'opacity' | 'emissive' | 'output';
compose(material: NodeMaterial, slot: Slot, effect: (previous: Node) => Node): void;
discard(material: NodeMaterial, condition: Node): void;   // stacks Discard(condition)
```

`compose` is the whole contract layer: ~30 lines, one switch over the slot's
property name and default. `discard` appends to a per-material list that the
factory folds into the fragment before lighting (three evaluates `Discard`
where the node is stacked; `colorNode` is the conventional host, which is why
`discard` is a helper and not a raw slot).

## 4. Migration map (22 files)

| today | slot(s) | notes |
|---|---|---|
| `terrainMeshes.ts` `makeSelfLitAware` | `output` (mix by `selfLit` flag bit), `color` (palette `lut.element(index)`) | the sRGB decode splice disappears: the palette is stored linear |
| `groundShade.ts` `applyGroundShade` | `output` | `uniformArray` for `uShadeA/B`; same boot-only max |
| `revealMask.ts` `applyRevealClip` | `discard` | `texture(uRevealMask).sample(uv).r < THRESHOLD` and out-of-range uv |
| `water.ts` `makeDepthAware` | `color`, `opacity`, `emissive`; specular curve → `specularColorNode` or `roughnessNode` (owner's visual call: today it scales `totalSpecular` directly, which has no slot) | the non-include literal anchor is the one splice with no TSL equivalent; flag it |
| `water/waterBands.ts` `makeBanded` | `color` | `uWaterBandTime` stays a shared `uniform()` |
| `riverRig.ts` | as water | |
| `rigHerd.ts` `poseSkinnedMaterial`, `rigSkin.ts` | `position`, `normal` | pose palette as `uniformArray` / storage |
| `kit/cumulusDeck.ts`, `cyclone/client/spiral.ts` | `position`, `discard`, `normal` | |
| `monsters/client/geometry.ts` fur, shell | `color`, `discard` | |
| `saucers/client/effects.ts` | `opacity` (instanced attribute via `attribute()`) | |
| `celestialVoid.ts` (4 `ShaderMaterial`) | `vertexNode` + `fragmentNode` (`NodeMaterial`), star sprites via `PointsNodeMaterial` with `sizeNode` | the Points sizing was already flagged in the 2026-09-09 run |
| `fire/*`, `hydro/puddles.ts`, `relics/*`, `tornado/funnel.ts`, `volcanoes/*` (11 `ShaderMaterial`) | `position` + `color` + `opacity` (+ `discard`) | instanced attributes via `attribute()` / `instanceIndex` |

Also on the migration list, outside materials: the PMREM variant, the GL timer
(`createGpuTimer` on the GL context → WebGPU timestamp queries via
`renderer.resolveTimestampsAsync`), async renderer init (`await renderer.init()`
before the first frame), and `renderer.localClippingEnabled` (node clipping is
always on; `material.clippingPlanes` still works via `ClippingNode`,
`three.webgpu.js:20473`).

## 5. Verification

- **Same look:** the app probe at the default Frostwick pose, WebGL shipped vs
  WebGPU migrated, pixel diff with the gate's metric (3×3 neighbourhood,
  tolerance 8/255) — accepting that the metric floor is 0.19 % (gate 1) and a
  renderer switch will sit above it; the owner judges the screenshots.
- **Same composition:** a per-material dump of the node graph
  (`material.outputNode`, `colorNode`, … as `node.toJSON()` or the built WGSL
  from `renderer.debug.getShaderAsync`) checked into `.gpu-perf/results/` once,
  diffed on later changes. Tests are not proposed here (owner's per-session
  rule).
- **Same lifecycle:** `configureGroundShade` after first compile still throws.

## 6. Rejected

- **Keep GLSL splices by staying on WebGL for everything but terrain.** Two
  renderers cannot share one canvas and depth buffer; the terrain would be
  composited, which breaks water over terrain, reveal clip and every
  depth-tested plugin.
- **A generic "anchor registry" over node graphs** (named insertion points
  effects address by string). It rebuilds the text-order mechanism with extra
  steps; three's slots already are the named points, and there are only seven.
- **Ground shade and self-lit as `color` / `emissive` effects instead of
  `output`.** Numerically close for a rough dielectric (specular F0 = 0.04) but
  not the shipped equation, and it would make the shade skip specular. `output`
  is the exact hook (§2 table).

## 7. Open owner decisions

1. Water specular curve: `specularColorNode` (scale F0) or `roughnessNode`
   (scale roughness) — pick by eye; today's direct `totalSpecular *=` has no
   slot.
2. `forceSinglePass` on the transparent DoubleSide node materials (water,
   plumes, ribbons): the ~0.6 ms/frame item from the options handoff, same
   flag on `NodeMaterial`; still the owner's visual call.
3. Whether `compose` lives in `client/src/render/materialSlots.ts` (proposal)
   or beside `shaderSplice.ts`, which it retires.
