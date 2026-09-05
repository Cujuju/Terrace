# Brief 4A report: real skin weights through the bake (#328)

Worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a82057cee5c837b28`,
branch `worktree-agent-a82057cee5c837b28`. Commits:

| commit | deliverable |
|---|---|
| `4f85993` | D1 — render kit (rigSkin/rigHerd/rigAsset + the two tests that asserted the removed contract) |
| `ac6b492` | D2 — deer re-imported as a glTF skin; import_model.py / export_glb.py; grazer.ts, assetSpecies.ts, LICENSES.md |
| `9ba94fc` | D4 — docs/model-assets.md |

Not merged, not pushed. The shared checkout was not edited (see "Incident" at the end).

## D1 — the render kit

### rigSkin.ts

- Header rewritten: "TWO BINDINGS, ONE BAKE" (rigSkin.ts:24-40).
- `bakeRig`'s part loop branches once, on `asSkinnedMesh` (rigSkin.ts:309-321).
  A plain Mesh takes the old path verbatim (`applyMatrix4` + `bindRigidly`); a
  `SkinnedMesh` goes to `bakeSkinnedPiece`.
- `isDrawableMesh` (rigSkin.ts:450) no longer throws for `isBone` /
  `isSkinnedMesh`. A `Bone` is not a Mesh and returns false; a `SkinnedMesh`
  sets `isMesh` and passes. The multi-material check is unchanged.
- `bakeSkinnedPiece` (rigSkin.ts:548-680) — the new work. Per part:
  a remap table `skeleton.bones[i] -> indexOf.get(bone)` (throws naming the
  mesh and the bone if a bone is outside the baked tree, rigSkin.ts:563-570),
  one `Matrix4` per bone for `bone.matrixWorld * skeleton.boneInverses[i]`,
  then per vertex a weighted blend of those, applied to position and (through
  `Matrix3.getNormalMatrix`) to normal, and new `Uint16Array` skinIndex /
  `Float32Array` skinWeight attributes.
- `SKIN_WEIGHT_SUM_TOLERANCE = 1e-3` (rigSkin.ts:518) — weights are rescaled
  only when they miss 1 by more than this. A vertex with no weight at all falls
  back to `RIGID_BIND_WEIGHT` on its first influence rather than collapsing onto
  the origin under a zero matrix.
- `MATRIX_ELEMENTS = 16` (rigSkin.ts:95) — named, not a bare 16 in the blend loop.
- `chainReach` (rigSkin.ts:759) extracted from `poseInvariantReach`; the rigid
  path's arithmetic is unchanged, and the skinned path uses it per bone (below).

### The CPU-skin order, verified against three 0.185's source

`client/node_modules/three/src/objects/SkinnedMesh.js:319-366`
(`applyBoneTransform`):

- :339 `_baseVector.applyMatrix4( this.bindMatrix )` — bindMatrix FIRST.
- :341-353 the four-influence loop:
  `_matrix4.multiplyMatrices( skeleton.bones[boneIndex].matrixWorld, skeleton.boneInverses[boneIndex] )`
  then `target.addScaledVector( ... , weight )`.
- :364 `return target.applyMatrix4( this.bindMatrixInverse )` — bindMatrixInverse LAST.

`src/renderers/shaders/ShaderChunk/skinning_vertex.glsl.js` says the same thing
in GLSL (`bindMatrix * transformed`, four `boneMat* skinVertex * skinWeight.*`,
`bindMatrixInverse * skinned`), and `skinnormal_vertex.glsl.js` builds
`skinMatrix = bindMatrixInverse * (sum) * bindMatrix` and applies it to the
normal. `Skeleton.update()` (`src/objects/Skeleton.js:199-225`, line 214
`_offsetMatrix.multiplyMatrices( matrix, boneInverses[i] )`) confirms that
`matrixWorld * boneInverse` is the per-bone matrix the renderer uses.

What `bakeSkinnedPiece` computes is therefore, per vertex:

```
v_rig = ( mesh.matrixWorld * mesh.bindMatrixInverse )
        * ( SUM_i w_i * bones[i].matrixWorld * boneInverses[i] )
        * mesh.bindMatrix * v
```

The leading `matrixWorld * bindMatrixInverse` is the scene-graph transform
applied AROUND the shader's result. Under three's default `AttachedBindMode`
those two cancel (`SkinnedMesh.updateMatrixWorld` re-derives `bindMatrixInverse`
from `matrixWorld`), and GLTFLoader binds with an identity bindMatrix
(`examples/jsm/loaders/GLTFLoader.js:4232`, `mesh.bind( skeleton, _identityMatrix )`),
so for our files the product reduces to the sum alone. Writing it out means the
bake is right for a file bound any other way too. The file's rest pose is read
as it stands — nothing here assumes rest equals bind.

After the bake, `boneInverses[i] = node.matrixWorld.invert()` (rigSkin.ts:282,
unchanged) is the exact inverse of the matrix folded in, so a weighted vertex
cancels at rest exactly as a rigid one does: rest == bind by construction.

### The shader diff (rigHerd.ts:88-118)

Before — one texel-fetch of `skinIndex.x`:

```glsl
attribute vec4 skinIndex;
mat4 rigPoseMatrix() {
	int col = int( skinIndex.x ) * 4;
	int row = int( rigPoseSlot );
	return mat4( texelFetch(...col...), texelFetch(...col+1...),
	             texelFetch(...col+2...), texelFetch(...col+3...) );
}
```

After — the fetch moves into `rigPoseBone(bone, row)` and `rigPoseMatrix()`
blends four of them, mirroring `<skinnormal_vertex>`:

```glsl
attribute vec4 skinIndex;
attribute vec4 skinWeight;
mat4 rigPoseBone( const in float bone, const in int row ) { ...four texelFetch... }
mat4 rigPoseMatrix() {
	int row = int( rigPoseSlot );
	mat4 blended = rigPoseBone( skinIndex.x, row ) * skinWeight.x;
	blended += rigPoseBone( skinIndex.y, row ) * skinWeight.y;
	blended += rigPoseBone( skinIndex.z, row ) * skinWeight.z;
	blended += rigPoseBone( skinIndex.w, row ) * skinWeight.w;
	return blended;
}
```

The two callsites are untouched (rigHerd.ts:416-423): `transformed` and
`objectNormal` still go through `rigPoseMatrix()`. Rigid binding is the
1/0/0/0 case of the same three added lines — one shader, not two. A zero weight
still pays its four texel fetches; branching per influence would cost more than
a fetch from a row already resident.

`instantiateRig` needed no change: it builds a real `SkinnedMesh` bound to a
real `Skeleton` (rigSkin.ts:436-437, `mesh.bind(skeleton, new Matrix4())`), so
three's own `<skinning_vertex>` does the four-way blend. Verified by reading
that chunk, quoted above.

### rigAsset.ts

`assertNotSkinned` and `RIGIDIFY_INSTRUCTION` are GONE — no dead constant, and
`grep -rn 'RIGIDIFY_INSTRUCTION\|assertNotSkinned'` over the worktree returns
nothing. The traverse (rigAsset.ts:123-161) is otherwise unchanged, so the
multi-material check and the per-uv-channel check now apply to a `SkinnedMesh`
exactly as to a Mesh (three sets `isMesh` on both). Header updated
(rigAsset.ts:21-25).

### Verification

- `client/node_modules/.bin/tsc --noEmit` in `client/`: clean.
- `plugins/wildlife`: `npx tsc --noEmit` clean.
- `client`: `vitest run` — 38 files, 580 tests, all pass.
- `plugins/wildlife`: `vitest run` — 5 files, 48 tests, all pass (`wildlife.test.ts`
  needs `--hookTimeout 60000`; its `beforeAll` generates a world and exceeds the
  10 s default on this machine. It passes with the longer hook timeout and
  imports nothing this brief touched).
- No tests added. TWO EXISTING tests asserted the contract this brief removes and
  were rewritten rather than deleted:
  - `client/test/rigAsset.test.ts` — "rejects an armature at load" became
    "accepts an armature and hands the skinned mesh through", against the same
    `skinnedTriangle()` glTF fixture.
  - `client/test/rigSkinMaterials.test.ts` — "refuses an armature" became a
    check that a 0.6/0.4 two-bone weight survives the bake with its indices
    remapped onto the baked depth-first bone list.

## D2 — the deer, re-imported

### tools/blender

- `import_model.py` main (:701-706): `--rigidify` is now OPT-IN. An armature is
  kept and exported as a skin unless the flag is passed; the hard error is gone.
- `apply_renames` (:530-573): `find_bone` added; a `--rename` that names no
  object falls through to the armatures' bones. Blender renames the matching
  vertex groups with the bone, so the skin stays bound. Verified in the run log:
  `renamed bone FrontUpperLeg.L -> foreLeft` and four more.
- `scale_scene` (:157-193): when any armature is present the fit scale is applied
  as ONE root-object transform instead of per-datablock. This was found by
  measurement, not by reading: scaling mesh data, `obj.location` and the armature
  datablock separately left the glTF skin's bone-parented leaf Empties at ~200x
  (`BackLowerLeg.L_end` at `(-9.10, 98.74, -0.04)` where the model is 0.46 tall).
  With the root transform they land at `(-0.237, 0.156, -0.040)`.
- `export_glb.py` `bake_object_transforms` (:31-38): skips a mesh with an
  ARMATURE modifier. Rewriting a bound mesh's vertices without touching the
  skeleton would move the skin off its bones.
- `export_glb.py` `export_scene_glb` (:68-73): `export_skins=True`,
  `export_all_influences=False` (the 4-influence cap three reads),
  `export_rest_position_armature=True` stated explicitly. All three were already
  the operator defaults; they are now written down because each is load-bearing.
  Verified in the output: the .glb carries `skins: [("AnimalArmature", 46)]` and
  every primitive has `JOINTS_0` / `WEIGHTS_0`.

### The import command

Recorded in `plugins/wildlife/client/assets/LICENSES.md`. The diff from the old
one: `--rigidify` dropped, and the five `--anchor`s moved to the new extremes
(`nose` 0.2525 -> 0.2387, `tail_tip` -0.2525 -> -0.2387, `flank` z 0.0875 ->
0.0792; `crown` and `belly` unchanged).

### Envelope, measured before and after

Measured through the game's own loader (`parseRigAsset` + `Box3.setFromObject`),
with `.model-import/measure-envelope.mts` (a throwaway in the gitignored
`.model-import/`, so it is not in the commits):

| | before (`--rigidify`) | after (glTF skin) |
|---|---|---|
| box size x, y, z | 0.505, 0.464, 0.175 | **0.4774, 0.4640, 0.1584** |
| `envelope.length` | 0.505 | 0.4774 |
| `envelope.halfLength` | 0.2525 | 0.2387 |
| `envelope.halfWidth` | 0.0875 | 0.0792 |
| `envelope.crownY` | 0.464 | 0.464 (unchanged; `--height` is the binding axis) |
| `envelope.bellyY` | 0 | 0 |

The shrink is not the model getting smaller — the geometry is identical, 2 096
triangles either way. It is the MEASURE changing: three's `Box3.setFromObject`
calls `SkinnedMesh.computeBoundingBox` for a skinned part (`src/math/Box3.js:340-348`
takes the `object.boundingBox !== undefined` branch, and `SkinnedMesh.js:109-130`
poses every vertex through `getVertexPosition`), where a rigidified model was the
union of each rotated part's own axis-aligned box — the ~0.04 of slack the old
`grazer.ts` comment named. `tools/blender/stat_glb.py` prints the same 0.477 x
0.464 x 0.158, so tool and runtime agree.

`GRAZER_ENVELOPE.bodyHalfLength` is now stated as the whole half-length with the
reason given (grazer.ts:129-138): a smooth-skinned mesh is one surface with no
per-joint partition, so the old "the leg subtrees reach x -0.2525 to 0.1214"
measurement no longer exists to be taken. It over-probes, which is the safe
direction for a ground probe. **This is the one number in the file that is
conservative rather than measured.**

### What the file actually contains

Counted off the .glb's `JOINTS_0` / `WEIGHTS_0` accessors:

- 46 joints in the skin, 41 of them carrying weight.
- **3 457 of 4 316 vertices have more than one influence** — i.e. 80 % of the
  deer is exactly the case `--rigidify` tore.
- The four IK targets DO carry weight (~90 units each), so `GRAZER_ADOPTIONS`
  is still load-bearing. `grazer.ts`'s comment about them was corrected: the
  weights were always on those bones; `--rigidify` only made it visible as whole
  meshes parked on an undriven node.

### assetSpecies.ts

Edits are documentation only, kept minimal for the concurrent fish/whale
session's merge. `SpeciesAssetSpec.rigidified` now reads "a CONVERTED ARMATURE …
whether the import kept the skeleton as a glTF skin or flattened it with
`--rigidify`". Two invariants the brief asked to confirm, confirmed and written
into `prepareRigidified`'s doc:

- `modelAxisPivot` inserts a `Group` between a `Bone` and its parent.
  `bakeRig.collect` is depth-first (rigSkin.ts:260-277), so a parent still
  precedes its children in the bone list — the invariant rigHerd's flat walk
  relies on (rigHerd.ts:155-160) holds.
- `modelAxisPivot` and `adoptKeepingTransform` both call `localiseInto`, which
  preserves the node's world transform. `bakeSkinnedPiece` reads a bone's rest
  from `bone.matrixWorld`, so no vertex moves — proved on screen by the stride
  shot's hooves.

## D3 — eyes-on

Static build (`client/scripts/buildSpeciesPreview.config.mjs`), served by
`python3 -m http.server 8791` from the worktree's `.smoke-shots/species/site`,
pid recorded to `.smoke-shots/species/http.pid` and killed by that pid.
`client/scripts/shootSpeciesPreview.mjs`. The game server/client were never
touched.

| shot | url |
|---|---|
| `.model-import/shots/wildlife/grazer-stride-smooth.png` | `?species=grazer&view=side&t=0.125` |
| `.model-import/shots/wildlife/grazer-side.png` | `?species=grazer&view=side&t=0` |
| `.model-import/shots/wildlife/grazer-iso.png` | `?species=grazer&view=iso&t=0` |
| `.model-import/shots/wildlife/ibex-rigid-iso.png` | `?species=ibex&view=iso&t=0.125` |
| `.model-import/shots/wildlife/fish-rigid-side.png` | `?species=fish&view=side&t=0.125` |

(Copies also in `.smoke-shots/species/out/` in the worktree.)

**What I see, having opened the images.** In the BEFORE shot
(`grazer-stride.png`, unchanged on disk) the deer is visibly torn: a wedge of
grey background shows through the front shoulder where the foreleg meets the
chest, a second gap opens at the rump above the swung hind leg, and the
shoulder/neck join is a hard step with the background visible between the
plates. In `grazer-stride-smooth.png`, at the same view and a matching phase,
the body is one continuous surface — no background anywhere inside the
silhouette, the shoulder and hip fair smoothly into the torso, and all four
hooves sit on their legs with the two diagonal pairs swung as before. The head
and neck read as one piece. The rest shot (`grazer-iso.png`) shows the same
animal standing clean.

`ibex-rigid-iso.png` and `fish-rigid-side.png` are the rigid path: the
hand-built ibex and the built fish draw normally, one surface each, so nothing
about the shader change disturbed 1/0/0/0 binding.

Assumption: `t=0.125` — the phase is not recorded anywhere for the original
shot, and 0.125 s is peak leg swing (`STRIDE_HZ = 2.0`, so `beat = pi/2`). The
leg positions match the before shot closely enough to compare, but I cannot
prove it is the identical frame.

I did NOT do a pixel diff of a boat: `grep -l 'preview-' client/*.html` finds
`preview-boats.html`, but there is no boats shooter in `client/scripts/` (only
`shootSpeciesPreview.mjs` and `shootFirePreview.mjs`), so building one was out
of proportion to the time box. The rigid path's evidence is instead: the two
species shots above, `client/test/rigSkin.test.ts`'s differential pose test, and
580/580 client tests.

### Draw calls

`window.__previewStats` from each shot (the driver prints it verbatim):

| | before | after |
|---|---|---|
| grazer surfaces (= draw calls) | 1 | **1** |
| grazer triangles | 2 096 | **2 096** |

Unchanged — the seven materials still collapse to one surface, because the
merge rule is about materials and the deer's colour is a `COLOR_0` attribute.
The BEFORE numbers are read from `plugins/wildlife/client/index.ts`'s
`GRAZER_ASSET_DRAW_OBJECTS` and from `LICENSES.md`'s recorded 2 096 triangles,
not from a re-run of the old build. `window.__previewDrawCalls` is documented in
`shootSpeciesPreview.mjs`'s header but `previewSpecies.ts` publishes
`__previewStats` (with `surfaces`) instead; I report `surfaces`, which is the
same quantity for this harness.

## Anything assumed

- **Assumption:** `t=0.125` matches the original stride shot's phase (above).
- **Assumption:** the before-column envelope numbers (0.505 / 0.0875 / 0.175)
  are the old `GRAZER_ASSET_ENVELOPE` constants and `stat_glb.py`'s recorded
  output, not a re-measurement of the old .glb — the old file was overwritten.
- **Assumption:** the four IK-target adoptions still matter. Verified that those
  bones carry ~90 weight units each, so the vertices exist; NOT verified on
  screen that removing the adoptions would now break anything.
- Verified, not assumed: the CPU-skin order (three's source, cited above), the
  weight distribution (read out of the .glb's accessors), the envelope numbers
  (measured through `parseRigAsset` and again through `stat_glb.py`), the
  exported skin (read out of the .glb's JSON), the bone renames (import log),
  the leaf-Empty scaling bug and its fix (measured before and after), and the
  seams (looked at).

## Two things a follow-up should pick up

1. `.model-import/verify-rig-asset.mts` still throws `contains a SkinnedMesh`
   for any file it checks. It is inside the gitignored `.model-import/`, in the
   SHARED checkout only, so this worktree could not edit it — it needs that
   throw removed or it will reject every smooth asset from now on.
2. `tools/blender/stat_glb.py`'s `--footprint` check FAILS on any skinned file,
   because Blender's glTF importer builds an 80-triangle `Icosphere` as the
   display shape for zero-length bones and it re-imports as a real mesh at the
   origin with a 2x2x2 box. It is not in the exported file (verified in the
   .glb's JSON). This also corrects `LICENSES.md`'s old claim that the sphere
   ships in the Quaternius pack — it does not; the importer makes it. Both notes
   are written into `LICENSES.md` and `docs/model-assets.md`, but `stat_glb.py`
   itself was left alone as out of this brief's scope.

## Incident (disclosed)

My first three edits ran with `cd /mnt/e/Development/Projects/Terrace && …` and
so landed on `client/src/render/rigSkin.ts` in the SHARED checkout rather than
in this worktree. Caught immediately, before any further command: the edited
file was moved into the worktree and the shared checkout's copy was restored
from the worktree's pristine (HEAD) copy, verified byte-identical by `diff`.
No other shared-checkout file was written, and no git command ever ran against
it. The only lasting effect on the shared checkout is inside the gitignored
`.model-import/` — the new/overwritten shots and the `.glb` outputs, which is
where those belong.
