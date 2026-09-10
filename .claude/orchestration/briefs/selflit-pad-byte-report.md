# Report: self-lit flag into the colour pad byte

## Commits

- `93242f0` `feat(terrain): pack self-lit flag into the colour alpha byte`
  (source: `capEmission.ts`, `chunkJob.ts`, `vertexGrid.ts`, `terrainMeshes.ts`)
- `c2e3b78` `test(terrain): update expectations for the colour-alpha self-lit byte`
  (`vertexGrid.test.ts`, `terrainMeshes.test.ts`)

## Per-file change summary

- **`client/src/terrain/capEmission.ts`**
  - `SELF_LIT` (a float, value `1`) renamed to `SELF_LIT_ALPHA_BYTE` (value
    `255`), named as the colour attribute's alpha byte. `LIT_BY_SCENE` (`0`)
    unchanged.
  - Added `COLOR_ALPHA_INDEX = COMPONENTS_PER_COLOR - 1` (named constant for
    the alpha component's index within a vertex's colour group).
  - `ChunkGeometryBuffers.selfLit: Float32Array` field removed; `colors` is
    now the only per-vertex colour store.
  - `createChunkGeometryBuffers` no longer allocates a `selfLit` array.
  - `pushVertex` no longer takes a separate write path for `selfLit`; it
    writes the byte directly into `colors[c + COLOR_ALPHA_INDEX]`. The
    `selfLit: number` parameter is unchanged in every caller
    (`emitCapTriangle`, `emitCeilingTriangle`, `emitSkirtQuad`,
    `writeBlockyFallback`) — it now carries the byte value (0 or 255)
    straight into the colour attribute instead of a separate buffer.
  - `ensureCapacity` (the growth path) no longer copies a `selfLit` buffer.
  - `selfLitFor` / `capSelfLitFor` helpers unchanged in shape, now return the
    byte value.

- **`client/src/terrain/chunkJob.ts`**
  - `ChunkJobAnswer.selfLit: Float32Array` removed.
  - Removed from `chunkJobTransfers`' transfer list.
  - Removed the scratch slice (`scratch.selfLit.slice(...)`) and its use in
    `buildChunkAnswer`'s returned answer.

- **`client/src/terrain/vertexGrid.ts`** (barrel)
  - Re-exports `SELF_LIT_ALPHA_BYTE` (renamed from `SELF_LIT`) and the new
    `COLOR_ALPHA_INDEX` instead of `SELF_LIT`.

- **`client/src/render/terrainMeshes.ts`**
  - Removed the `selfLit` `Float32Array` from the `SuperMesh` type
    (`selfLitAttribute` field), from `bindGeometry` (attribute creation/bind),
    `ensureSuperCapacity` (growth copy), `markDirty`, `addRange`,
    `zeroVertices`, `moveRunDown`, `createSuperMesh`, and `spliceChunk`.
  - Removed the now-dead `SELF_LIT_ATTRIBUTE = 'selfLit'` constant and the
    `attribute` import from `three/tsl` (no longer used anywhere in the
    file).
  - The material's `output` slot now reads `vertexColor().a` instead of
    `attribute('selfLit', 'float')` — the same mix logic
    (`mix(previous.rgb, diffuseColor.rgb, <flag>)`), just sourced from the
    colour attribute's alpha channel. The `color` slot is untouched and still
    reads `.rgb`.
  - Every `{ positions, normals, colors, selfLit }` destructure dropped the
    field (4 call sites: `ensureSuperCapacity`, `zeroVertices`,
    `moveRunDown`, `spliceChunk`).

## Bytes-per-vertex arithmetic

Before: positions `3 × f32` (12 B) + normals `4 × i8` (4 B) + colors
`4 × u8` (4 B) + selfLit `1 × f32` (4 B) = **24 bytes/vertex**.

After: positions `3 × f32` (12 B) + normals `4 × i8` (4 B) + colors
`4 × u8` (4 B) = **20 bytes/vertex**.

Reduction: 4 bytes/vertex, 16.7%.

`ARENA_TRANSFER_MS_PER_VERTEX` (`19 / 1e6`, in `terrainMeshes.ts`) and the
`CHUNK_ANSWER_BACKLOG_CAP` comment (`~1.6 MB each`) do not name the 4-buffer
byte total explicitly — they're a bench-derived per-vertex transfer cost and
an approximate size comment respectively, not constants that encode
"4 buffers" by name. Left unchanged; flagging this so the owner can decide
whether the "~1.6 MB" comment is worth re-deriving.

## Test expectations changed (old → new)

`client/test/vertexGrid.test.ts`:
- Import: `SELF_LIT` → `SELF_LIT_ALPHA_BYTE`; added `COLOR_ALPHA_INDEX` import.
- `selfLitOf(buffers, base)`: read `buffers.selfLit[base(+1)(+2)]` → read
  `buffers.colors[(base+v) * COMPONENTS_PER_COLOR + COLOR_ALPHA_INDEX]` for
  `v` in `0,1,2`.
- Added helper `colorAlphasFrom(buffers, fromVertex)` (replaces direct
  `buffers.selfLit.subarray(...)` reads).
- `border.selfLit`/`face.selfLit`/`skirt.selfLit`/`cap.selfLit` expectations:
  `SELF_LIT` → `SELF_LIT_ALPHA_BYTE` (values unchanged, `255` vs the old
  float `1`, since the Triangle-fixture field just mirrors whatever byte the
  mesher wrote).
- "leaves the flag on the unused tail alone": `buffers.selfLit.subarray(counts.vertexCount)`
  → `colorAlphasFrom(buffers, counts.vertexCount)` (both before/after
  comparisons).
- "grows the flag buffer alongside the others": `buffers.selfLit.length` check
  → `buffers.colors.length === triangleCapacity * VERTICES_PER_TRIANGLE * COMPONENTS_PER_COLOR`;
  `buffers.selfLit.subarray(0, grown.vertexCount).some(flag => flag === SELF_LIT)`
  → `colorAlphasFrom(buffers, 0).slice(0, grown.vertexCount).some(flag => flag === SELF_LIT_ALPHA_BYTE)`.

`client/test/terrainMeshes.test.ts`:
- Import: added `COMPONENTS_PER_COLOR` from `vertexGrid.ts`.
- `sizedSource` fixture: removed `selfLit` `Float32Array` construction, the
  `selfLit[v] = 1` fill, and the `selfLit` field from the returned
  `ChunkJobAnswer` literal (the type no longer has that field).
- Attribute-name lists `['position', 'normal', 'color', 'selfLit']` →
  `['position', 'normal', 'color']` at 4 call sites (`expectSlotsEqual`,
  `expectHoleInvariants`, one inline `.map`, and `ARENA_ATTRIBUTES`).
- `'binds the self-lit flag as a one-component float attribute'` →
  `'carries the self-lit flag in the colour attribute alpha byte'`: asserted
  attribute `'selfLit'` (itemSize 1, not normalized, `Float32Array`) →
  asserted attribute `'color'` (itemSize `COMPONENTS_PER_COLOR`, normalized
  `true`, `Uint8Array`); vertex count assertion unchanged.
- `'re-uploads and rebinds the flag alongside the other attributes'` →
  `'re-uploads and rebinds the colour attribute, flag included, alongside the others'`:
  every `plainAttribute(..., 'selfLit')` → `plainAttribute(..., 'color')`.

Test count unchanged: 602 before, 602 after (no tests added or removed, only
retargeted).

## Verification output (verbatim)

**`pnpm typecheck`** — all 30 workspace projects `Done`, exit 0 (client, shared,
server, and every plugin). No `selfLit`-related errors remain.

**`cd client && npx vitest run`**
```
 Test Files  41 passed (41)
      Tests  602 passed (602)
```

**`cd client && npx vite build`**
```
✓ 379 modules transformed.
...
dist/assets/index-C0cw18NO.js               1,783.70 kB │ gzip: 534.15 kB
✓ built in 1.35s
```
(pre-existing >500kB chunk-size warning, unrelated to this change)

**`node client/scripts/drawnGroundParity.mjs`**
```
PASS relaxed real patch: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS stamped whole-band plateau with 4-cell treads: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS sheer multi-band wall in one cell: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS saddle: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS chunk seam: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
PASS layered column: 38025 samples, 0 mismatches, 0 within one step of a contour, 0 blocky chunks
```

**`node client/scripts/dumpMaterialGraphs.mts`** — terrain `outputNode`,
before (stashed pre-change tree) vs after (working tree):

Before:
```
terrain MeshStandardNodeMaterial
  colorNode: VarNode <- ColorSpaceNodex1, MaterialNodex1, OperatorNodex1, SplitNodex1, VertexColorNodex1
  outputNode: VarNode <- AttributeNodex1, JoinNodex2, MathNodex2, Nodex2, OperatorNodex1, PropertyNodex2, SplitNodex5, VarNodex5
```

After:
```
terrain MeshStandardNodeMaterial
  colorNode: VarNode <- ColorSpaceNodex1, MaterialNodex1, OperatorNodex1, SplitNodex1, VertexColorNodex1
  outputNode: VarNode <- JoinNodex2, MathNodex2, Nodex2, OperatorNodex1, PropertyNodex2, SplitNodex6, VarNodex5, VertexColorNodex1
```

`AttributeNodex1` is gone from `outputNode`; `VertexColorNodex1` and one more
`SplitNode` appear (the `.a` split off `vertexColor()`), confirming the flag
now rides the colour attribute instead of a separate one.

**`grep -rn 'selfLit\|SELF_LIT' client/src client/test`** (verbatim, post-change):

```
client/src/terrain/capEmission.ts:74:export const SELF_LIT_ALPHA_BYTE = 255;
client/src/terrain/capEmission.ts:181:      skirtSelfLit: selfLitFor(paletteIndex),
client/src/terrain/capEmission.ts:183:      ceilingSelfLit: selfLitFor(ceilingIndex),
client/src/terrain/capEmission.ts:199:        skirtSelfLit: selfLitFor(shoreIndex),
client/src/terrain/capEmission.ts:201:        ceilingSelfLit: selfLitFor(shoreIndex),
client/src/terrain/capEmission.ts:210:function selfLitFor(paletteIndex: number): number {
client/src/terrain/capEmission.ts:211:  return isSeabedPaletteIndex(paletteIndex) ? SELF_LIT_ALPHA_BYTE : LIT_BY_SCENE;
client/src/terrain/capEmission.ts:215:  return isEmissivePaletteIndex(paletteIndex) ? SELF_LIT_ALPHA_BYTE : LIT_BY_SCENE;
client/src/terrain/capEmission.ts:242:  selfLit: number,
client/src/terrain/capEmission.ts:257:  buffers.colors[c + COLOR_ALPHA_INDEX] = selfLit;
client/src/terrain/capEmission.ts:267:  selfLit: number,
client/src/terrain/capEmission.ts:269:  pushVertex(a.x * CELL_WORLD_SIZE, y, a.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
client/src/terrain/capEmission.ts:270:  pushVertex(c.x * CELL_WORLD_SIZE, y, c.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
client/src/terrain/capEmission.ts:271:  pushVertex(b.x * CELL_WORLD_SIZE, y, b.z * CELL_WORLD_SIZE, 0, 1, 0, color, selfLit);
client/src/terrain/capEmission.ts:280:  selfLit: number,
client/src/terrain/capEmission.ts:282:  pushVertex(a.x * CELL_WORLD_SIZE, y, a.z * CELL_WORLD_SIZE, 0, -1, 0, color, selfLit);
client/src/terrain/capEmission.ts:283:  pushVertex(b.x * CELL_WORLD_SIZE, y, b.z * CELL_WORLD_SIZE, 0, -1, 0, color, selfLit);
client/src/terrain/capEmission.ts:284:  pushVertex(c.x * CELL_WORLD_SIZE, y, c.z * CELL_WORLD_SIZE, 0, -1, 0, color, selfLit);
client/src/terrain/capEmission.ts:293:  selfLit: number,
client/src/terrain/capEmission.ts:307:  pushVertex(px, topY, pz, outX, 0, outZ, color, selfLit);
client/src/terrain/capEmission.ts:308:  pushVertex(qx, topY, qz, outX, 0, outZ, color, selfLit);
client/src/terrain/capEmission.ts:309:  pushVertex(qx, bottomY, qz, outX, 0, outZ, color, selfLit);
client/src/terrain/capEmission.ts:311:  pushVertex(px, topY, pz, outX, 0, outZ, color, selfLit);
client/src/terrain/capEmission.ts:312:  pushVertex(qx, bottomY, qz, outX, 0, outZ, color, selfLit);
client/src/terrain/capEmission.ts:313:  pushVertex(px, bottomY, pz, outX, 0, outZ, color, selfLit);
client/src/terrain/capEmission.ts:387:        selfLitFor(index),
client/src/terrain/capEmission.ts:410:        selfLitFor(index),
client/src/terrain/capEmission.ts:432:      selfLitFor(index),
client/src/terrain/vertexGrid.ts:16:  SELF_LIT_ALPHA_BYTE,
client/test/vertexGrid.test.ts:35:  SELF_LIT_ALPHA_BYTE,
client/test/vertexGrid.test.ts:111:  selfLit: number;
client/test/vertexGrid.test.ts:147:      selfLit: selfLitOf(buffers, base),
client/test/vertexGrid.test.ts:165:function selfLitOf(buffers: ChunkGeometryBuffers, base: number): number {
client/test/vertexGrid.test.ts:971:      expect(border.selfLit).toBe(SELF_LIT_ALPHA_BYTE);
client/test/vertexGrid.test.ts:984:      expect(face.selfLit).toBe(SELF_LIT_ALPHA_BYTE);
client/test/vertexGrid.test.ts:1032:      expect(skirt.selfLit).toBe(seabed ? SELF_LIT_ALPHA_BYTE : LIT_BY_SCENE);
client/test/vertexGrid.test.ts:1043:    for (const cap of caps) expect(cap.selfLit).toBe(LIT_BY_SCENE);
client/test/vertexGrid.test.ts:1053:    for (const skirt of skirts) expect(skirt.selfLit).toBe(SELF_LIT_ALPHA_BYTE);
client/test/vertexGrid.test.ts:1054:    for (const cap of capsOf(triangles)) expect(cap.selfLit).toBe(LIT_BY_SCENE);
client/test/vertexGrid.test.ts:1060:    for (const t of triangles) expect(t.selfLit).toBe(LIT_BY_SCENE);
client/test/vertexGrid.test.ts:1083:        .some((flag) => flag === SELF_LIT_ALPHA_BYTE),
```

Only the colour-byte name (`SELF_LIT_ALPHA_BYTE`) and its callers
(`selfLitFor`, the `selfLit` parameter threaded through `pushVertex` and its
emit-helper callers, the `skirtSelfLit`/`ceilingSelfLit`/`capSelfLit` level
fields, and the test-local `Triangle.selfLit`/`selfLitOf` fixture helpers)
remain, as required.

## Anything not done / notes

- Environment had no `node_modules` installed in this worktree; ran
  `pnpm install --frozen-lockfile` (resolved from the existing lockfile, no
  new dependencies) before any verification command would run.
- `ARENA_TRANSFER_MS_PER_VERTEX` and the `CHUNK_ANSWER_BACKLOG_CAP`
  `~1.6 MB each` comment were checked per the brief's instruction but neither
  is a constant that names a 4-buffer byte total, so neither was changed
  (see "Bytes-per-vertex arithmetic" above).
- Everything else in the brief was completed as specified. Branch pushed:
  `git push -u origin worktree-selflit-pad`.
