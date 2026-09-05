# Phase 1 report — skiff GLB (agent skiff-p1, 2026-09-04)

Commit 5a1d79e on skiff-glb-models: tools/blender/build_skiff.py, tools/blender/render_skiff.py,
plugins/structures/client/assets/skiff.glb. Orchestrator viewed all five renders: PASS.

| measure | value | source |
|---|---|---|
| envelope (glTF x,y,z) | 0.3419 x 0.1041 x 0.1288 (budget 0.36 / 0.12 / 0.14) | parse.mjs via parseRigAsset |
| `waterline` anchor | (0, 0.0393, 0) — draught 0.0393, freeboard amidships 0.0407 | same |
| triangles | 248 | stat_glb.py re-import + index count |
| meshes / materials | 1 mesh `skiff` / 1 material `skiff_wood` | stat_glb.py, parse.mjs |
| colour attribute | yes: COLOR_0 (itemSize 4, count 498), material.vertexColors = true | parse.mjs |
| uv | none (no texture, by design) | stat_glb.py |

Shape: 9 stations, fine stem forward (+X), transom aft, gentle sheer, two thwarts, a sole
(floorboards) above the waterline so the interior is not swamped, short keel strip, sheer
strake carries RAIL_COLOR (no proud gunwale ribbon — ~100 tris for a sub-pixel feature). No oars.
Hull skin is Solidify'd and re-centred on x before transform_apply.

Units: docs/model-assets.md line 3 ("1 unit = 1 cell") is stale — one authoring unit is one
WORLD unit (= 4 cells): build_war_boat.py:47 HULL_LENGTH 0.9, boats index.ts:127-131 places at
cell * CELL_WORLD_SIZE with no scale. Not changed in this arc.

Unverified by the agent: pnpm typecheck (worktree had no node_modules). Orchestrator then ran
`pnpm install --offline --frozen-lockfile` into the worktree and `pnpm typecheck`: passes.
Renders (uncommitted): .claude/worktrees/skiff-glb-models/.skiff-shots/skiff-{game,side,top,bow34,scale}.png
