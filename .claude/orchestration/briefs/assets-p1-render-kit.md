# Brief 1A: render kit becomes PBR-complete for authored model assets

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TypeScript strict, three 0.185.1,
SolidJS client, Node 24 server). You run in your own git worktree (the harness created it; `pwd`
to find it). Commit to the worktree branch. Do not merge, do not push, never touch the main
checkout at /mnt/e/Development/Projects/Terrace directly. When done, call ExitWorktree with
action "keep".

Owner decision (2026-09-04): every plugin may use textures and external model assets, and real
third-party models (PBR glTF: baseColor + normal + roughness/metalness + occlusion + emissive
maps) must load correctly. Today the render kit only knows `map` and `emissiveMap`. Your job is
to make the kit correct for the full glTF material set, at the contract layer, with no
per-plugin copies.

Read first, in this order, verifying every claim below against the code (comments are claims,
not evidence — cite file:line in your report):
1. client/src/render/rigAsset.ts (whole file, ~213 lines)
2. client/src/render/rigSkin.ts — materialSignature (~L103), the bake loop (~L255–300),
   blueprint.dispose (~L315–330), isDrawableMesh (~L385), stripUnbakeableAttributes (~L450),
   vertexColoured (~L480)
3. client/src/render/rigHerd.ts — only to confirm a textured material's onBeforeCompile patch
   still works with more maps (it should; note anything that keys on `map` specifically)
4. plugins/boats/client/models.ts — installBoatKit's fit check (~L160–200)
5. plugins/boats/client/glb-url.d.ts and client/src/vite-env.d.ts (~L25–35)
6. docs/model-assets.md
7. client/node_modules/three/src/materials/MeshStandardMaterial.js and
   client/node_modules/three/src/renderers/webgl/WebGLPrograms.js — confirm which maps exist
   and which uv channel each samples (`texture.channel`; aoMap/lightMap default channel 1 → `uv1`).

## Deliverables

### D1 — one shared map-slot helper: client/src/render/materialMaps.ts (new)
- A single named list of every texture slot on a three material that changes how a surface
  is shaded (at minimum: map, emissiveMap, normalMap, roughnessMap, metalnessMap, aoMap,
  alphaMap, bumpMap, lightMap; decide displacementMap and specular/clearcoat slots
  deliberately and say why in a comment). Read the slot names off three's own material
  classes, not from memory.
- `texturesOf(material): Texture[]` (deduplicated, only real textures — reuse rigAsset's
  isTexture guard, moved here).
- `uvChannelsUsed(material): Set<number>` from each texture's `channel`.
- `mapIdentitySignature(material): string` — the identity of every slot, in slot order, so
  both rigSkin's and structures' signatures can call it (structures adoption is phase 2;
  do NOT edit plugins/structures now).
- `colourMapSlots` — which slots are colour data (map, emissiveMap) vs linear data
  (everything else). rigAsset's sRGB fix-up must apply ONLY to colour slots; a normal map
  forced to sRGB is a bug. Assert linear on data slots the same way (fix-up + comment).

### D2 — rigSkin.ts uses the helper
- materialSignature: replace the two hand-written map fields with mapIdentitySignature, and
  add the scalar uniforms that would otherwise merge two differently shaded parts:
  roughness, metalness, normalScale, aoMapIntensity, emissiveIntensity (only when the field
  exists on the material). Keep colour OUT of the signature (that is the design; read the
  comment above materialSignature for why).
- stripUnbakeableAttributes: keep `uv` iff channel 0 is used, keep `uv1` iff channel 1 is
  used (generalise: keep uvN iff channel N used), still delete `tangent` (three derives
  tangents in-shader when the attribute is absent — verify in
  client/node_modules/three/src/renderers/shaders/ShaderChunk/normal_fragment_maps.glsl.js
  or equivalent and cite it). Throw, as today, when a used channel's attribute is missing,
  naming the channel.
- blueprint.dispose: dispose `texturesOf(surface.material)` — no hand-listed slots.
- isDrawableMesh: REJECT `isSkinnedMesh` (and any `Bone`/`Skeleton` in the tree) with an
  error that says the asset must be rigidified: "run tools/blender/import_model.py
  --rigidify" (that tool is being written in parallel by another agent; the message is the
  contract). Today a SkinnedMesh silently bakes at bind pose with no joints.
- vertexColoured: verify the clone carries every slot by reference (three's Material.copy);
  cite the lines. No change expected.

### D3 — rigAsset.ts uses the helper
- The per-mesh uv check uses uvChannelsUsed (uv and uv1), the texture set uses texturesOf,
  dispose uses texturesOf. Delete the local mappedTextureOf/emissiveTextureOf.
- Reject armatures/SkinnedMesh at load with the same message as D2 (fail at load, not at bake).
- Add `assertAssetFits(asset, footprint: { x: number; z: number; y?: number },
  toleranceCells = ASSET_FIT_TOLERANCE_CELLS)`: bounding box of asset.scene must fit the
  footprint in cells (+tolerance). Move boats' BOAT_FIT_TOLERANCE_CELLS (0.02) here as the
  shared named constant with its justification comment; boats calls assertAssetFits with
  {x: 1, z: 1} and keeps its own error wording only where it adds boat-specific meaning.
  Export the helper from rigAsset.ts (or a sibling assetFit.ts if rigAsset.ts passes ~300
  lines — say which and why).

### D4 — one `*.glb?url` declaration
Two copies exist (plugins/boats/client/glb-url.d.ts, client/src/vite-env.d.ts). Make it ONE
file that every plugin package and the client compile against. Options to weigh: (a) a repo
`types/` dir added via `typeRoots` + `"types": [...]` in tsconfig.base.json or per plugin
tsconfig (plugins already carry `"types": ["node"]`, see plugins/boats/tsconfig.json);
(b) a `client/src/render/glb-url.d.ts` added to each plugin tsconfig `include`. Pick the one
that means a NEW plugin gets it for free (or with one line that the pattern already has),
delete both old copies, and prove it with `pnpm typecheck` from the worktree root.

### D5 — docs/model-assets.md "Materials" section
Rewrite the paragraph to state the new contract: full glTF PBR material set supported; which
slots are colour vs data; uv/uv1 rule; armatures rejected (rigidify); merge rule (parts that
differ only in colour merge; anything else shading-relevant splits). Do not touch other
sections (another agent is generalising them).

## Rules
- No new tests (owner rule; permission not granted this session). Existing tests must pass:
  from the worktree root `pnpm typecheck`; then `cd client && timeout 240 npx vitest run`
  and `cd plugins/boats && timeout 240 npx vitest run`. If an existing assertion encodes
  the old two-slot behaviour, change the minimum needed and list each change in the report.
  Never run `pnpm -r test` (hangs).
- No magic numbers: every literal is a named constant with a one-line justification.
- Keep the diff to: client/src/render/**, plugins/boats/client/models.ts, the d.ts files and
  tsconfigs D4 needs, docs/model-assets.md. Nothing in plugins/structures, wildlife,
  monsters, pilgrims — those are phase 2.
- Do not delete existing comments; update them where they became false.
- Commit with a conventional message (`feat(render): …`), no attribution or footers.

## Report (short, file:line for every claim)
- Commit hash(es) and branch.
- The final slot list and the two decisions (displacement/specular; D4 option) with reasons.
- Verification output: typecheck result, vitest results per package (counts), any existing
  assertion you changed and why.
- Anything you found that the brief got wrong.
