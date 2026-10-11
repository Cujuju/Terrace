# Picking

Facts about how the client answers "which cell, face and band is under the cursor".

## Method

- Terrain is picked as a height field, not a mesh. The pointer is unprojected to a world ray and the ray marches the cells it crosses (Amanatides & Woo), stopping at the first column it enters at or below the drawn surface. Cost scales with cells crossed, never with triangles or band count.
- One entry point, `World.pickCell`, serves the brush and plugin clicks, so both name the same cell for the same ray.
- The pick is exact against the rendered surface: marching squares classifies a sample as inside iff `h ≥ k·BAND_HEIGHT`, the same test the march uses, and contour vertices never reach a cell centre.
- A riser hit is refined to the drawn (smoothed) face of that band before the cell is named, so the outline sits on the wall the player sees.
- The hover pick is re-run whenever the camera pose changes, so the brush outline tracks the cursor mid-pan.

## What a pick names

- `TerrainRayPick`: cell, the span struck, the face (`riser | tread | underside`), the surface height and the exact hit point.
- A face belongs to the column behind it: clicking a cliff sculpts the cliff, not the ground at its foot.
- An entry exactly on a column's own drawn cap is a tread, whatever its height, so a plateau at `MAX_HEIGHT` still picks as ground.
- Rays that strike an underside name the roof span; a raise on an underside is refused by the input layer.
- The band is decided once, where the hit is decided, and rides on the pick. `resolvePick` only clamps it to the span it landed on; nothing downstream re-derives it, and the rule does not vary by tool.
- `drawnBandAtY` is that rule: the band whose slab `((b-1) cap, b cap]` holds a world Y, the inverse of `drawnBandCapY`. Riser and tread take it at the hit point; an underside takes its span's `floorBand`.
- Drawn caps are evenly spaced, so no shore case applies to world-Y-to-band. The shore rule lives in `drawnBandOfSample` (height sample to drawn band) and reaches a pick only through the span clamp: a shore column drawing band 0 clamps a skirt hit to 0, never to water.
- The hit point always lies on the pointer ray, so the crosshair tracks the cursor. A pick re-homed to a neighbouring column names that cell and its surface, never its band: an aim meeting a tall neighbour's smoothed skirt grabs the band under the crosshair, not that column's cap (owner decision 2026-09-18).
- A held carve keeps cutting from the cell the ray strikes, not one it flies over.
- A cell outside received chunks is not pickable.
- A chunk is pickable from its first published chart. A rebuild keeps the previous chart published until the replacement is spliced (2026-09-22).
- Smoothed surface (`binomial`): the stored column under the hit owns the pick — the span covering the drawn band, else the drawn span beneath it. Neighbour search runs only when neither exists. A hit above the owner's cap carries `ownerHitY`; `resolvePick` validates that instead of `hitY` and clamps the band to the owner's cap (2026-09-22).

## Layered columns

- The march scans each column's spans for the earliest hit, so a ray can pass through a carved opening and strike a lower span or a roof underside.
- Face classification and band ownership use the drawn extents of spans defined in `shared/src/columns/span.ts`; picking never restates that rule.

## Known residual

- During a rebuild, treads and ground queries read live terrain while walls come from the published chart. Measured window per edit: 1–6 frames (2026-09-22, private stack, GPU and CPU meshers).
- Smoothed picks scan every band a cell's ray segment spans and neighbouring wall segments, so their cost grows with band count. Measured per pick: 0.01–0.24 ms median, ≤ 0.35 ms p95 (raw: 0.01–0.19 ms, ≤ 0.32 ms p95).
- One mesh per 16×16 chunk with no LOD: a fully revealed 512² world is about 1024 terrain draw calls when zoomed out. Frustum culling applies; nothing else does.
