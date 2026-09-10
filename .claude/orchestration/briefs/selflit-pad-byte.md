# Brief: self-lit flag into the colour pad byte

Branch `worktree-selflit-pad` (worktree
`E:\Development\Projects\Terrace\.claude\worktrees\selflit-pad`, off the TSL
migration branch at 8eafc83). Issue #446, arc `arc/gpu-mesher-gates`.
Owner decision 2026-09-10: self-lit is a 0/1 flag; a float buys nothing.

## What exists

- The terrain vertex colour is `Uint8Array` ×4 (`COMPONENTS_PER_COLOR = 4`,
  `client/src/terrain/capEmission.ts:69`), written by `pushVertex`
  (`capEmission.ts:256-258`) as three quantised channels; byte 3 is never
  written and is 0. The attribute is bound normalised (`terrainMeshes.ts:234`),
  so in the shader `vertexColor()` is a vec4 whose `.a` is byte 3 / 255.
- Self-lit is a separate `Float32Array` ×1 (`SELF_LIT = 1`, `capEmission.ts:75,
  107, 124, 246`), carried through the worker answer (`chunkJob.ts:48-61,
  217-218, 237-238`), the arena buffers, growth, zeroing, moves and splices
  (`terrainMeshes.ts:147, 235-251, 272, 329, 340, 345-349, 411-415, 474,
  553-557`), and read by the `output` slot as `attribute('selfLit','float')`
  (`terrainMeshes.ts:69, 82`).

## Change

Delete the `selfLit` buffer and attribute everywhere; write the flag into
colour byte 3; read it as `vertexColor().a` in the slot.

- `capEmission.ts`: `SELF_LIT` becomes the byte value (255) with a name that
  says it is the colour alpha byte; `LIT_BY_SCENE` stays 0. `pushVertex`
  writes byte 3. Remove `selfLit` from the buffer set and from every
  `pushVertex` caller's signature only where the parameter would now be
  dead — the `selfLit: number` parameter itself stays, it just lands in the
  colour byte. Growth path (`:775`) loses its selfLit branch.
- `chunkJob.ts`: remove `selfLit` from the answer type, the transfer list and
  the scratch slice.
- `terrainMeshes.ts`: remove the buffer, the attribute, the update ranges,
  the zero/copy/set lines; the `output` slot reads `vertexColor().a`. The
  `color` slot keeps reading `.rgb`. Every `{ positions, normals, colors,
  selfLit }` destructure drops the field.
- `ARENA_TRANSFER_MS_PER_VERTEX` and any per-vertex byte constants that
  encoded 4 buffers: check whether one names the byte total; if so, update
  it and say so.
- Tests: `client/test/vertexGrid.test.ts` (19 references) and
  `client/test/terrainMeshes.test.ts` (11) assert the old layout. Update
  each expectation to the byte-3 layout; never add a test; list every
  changed assertion old → new in the report.

## Verification

- `pnpm typecheck` green; `cd client && npx vitest run` green (602 today,
  count must not change); `cd client && npx vite build` succeeds.
- `node client/scripts/drawnGroundParity.mjs` passes (terrain math untouched).
- `node client/scripts/dumpMaterialGraphs.mts` runs; the terrain `outputNode`
  no longer lists an `AttributeNode`, and the report shows the before/after
  lines for terrain.
- `grep -rn 'selfLit\|SELF_LIT' client/src client/test` output pasted
  verbatim; only the colour-byte name and its callers may remain.

## Rules

- Work only in this worktree, on this branch. Conventional commits, first line
  under 72 chars, no attribution lines; stage exact paths, never `git add -A`.
  One commit for the source change, one for the test expectations is fine;
  a single commit is also fine.
- Do not touch `shared/`, `docs/`, or any file outside the ones named plus
  their direct importers that the typecheck breaks.
- No new dependencies. No new number literals: the byte value and the alpha
  channel index are named constants.
- Prefer no comments; if one is needed, under 30 words.

## Report (`.claude/orchestration/briefs/selflit-pad-byte-report.md`, committed)

Commit hashes; per-file change summary; the bytes-per-vertex before and
after (state the arithmetic); test expectations changed old → new;
verification output verbatim; anything you could not do.
