# Picking

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-21 (picking marches the height field, issue #61)

**The symptom was "the frame rate drops when I pan the map".** The cause was
that picking answered "which cell is under the cursor" by brute-force
ray/triangle intersection against the chunk meshes, so its cost scaled with
TRIANGLES — which the `BAND_HEIGHT` 64 → 16 re-terrace had just quadrupled.
One centre-screen pick measured **29.5 ms across 214,786 triangles**: a whole
60 fps frame budget, spent before anything drew.

It ran every frame of a pan, and that part is not a bug. `hoverTarget`'s cache
key includes the camera pose because the owner asked (2026-08-14) for the brush
outline to track the cursor mid-pan, so a moving camera is a cache miss by
design. Counted in a live world with the pointer held still: 1 pick per 12
frames with the camera still, **11 per 12 while panning**.

**Decision: terrain is a height field, so pick it as one.** The client already
holds the whole authoritative heightmap (`terrain/mirror.ts`, 512 KB at 512²),
and the query has a closed form — walk the cells the ray crosses (Amanatides &
Woo) and stop at the first column it enters at or below the cap of. Cost is
bounded by CELLS CROSSED rather than triangles and, the point of the exercise,
**is independent of band count**, so re-terracing can never make picking slow
again. Measured on the same world and camera: **29.5 ms → 0.0063 ms**.

`plugins/host.ts` held a second, independent mesh raycast for plugin clicks.
Both now go through one `World.pickCell`, so a brush click and a plugin click
cannot disagree about which cell a ray means — before, they merely happened to
agree. Callers keep only the step that genuinely needs Three: unprojecting the
pointer into a world-space ray.

**Why it is exact, not an approximation.** `vertexGrid.ts` already states the
invariant this needs — marching squares classifies a sample as inside iff
`h ≥ k·BAND_HEIGHT`, which is `quantizeToBand`'s own test, and
`CONTOUR_CELL_CENTRE_GUARD` keeps every contour vertex clear of every cell
centre so no amount of Chaikin smoothing can reclassify one. A per-cell column
of height `quantizeToBand(h)` therefore *is* the rendered surface at the only
points picking cares about. Verified rather than argued: **1,600 of 1,600**
straight-down probes on a live world name the same cell as the mesh raycast.

**Clicking a cliff face now sculpts the cliff.** This is a real behaviour
change and it is deliberate. Over 1,000 oblique picks: 738 identical, 211 off
by one — and all 211 are rays that struck a riser. There the old rule was
arbitrary rather than correct: the mesh draws that face on the smoothed
contour, which wanders within the boundary cell, so rounding its hit point to
the nearest cell centre named the cliff 233 times and the ground at its FOOT
the other 8, decided by which side of a centre the contour happened to fall.
The march has no coin to flip — a face belongs to the column behind it. The
remaining 51 differ by more and are all shallow-pitch silhouette grazes (mean
0.23 cells above 35° of pitch, 2.05 below 20°); 70 of those the raycast cannot
answer stably either, since a 1.3-pixel nudge moves its own answer as far.
Ill-conditioned, not mis-picked.

**Rejected.** Skipping the pick during a camera drag contradicts the settled
2026-08-14 decision. Throttling to every Nth frame divides the cost instead of
removing it and makes the outline lag. `three-mesh-bvh` is a new dependency,
still far slower than closed form on a height field, and its BVH would need
rebuilding on every sculpt.

**Named residual, not fixed here.** One `Mesh` per 16×16 chunk means a
fully-revealed 512² world is ~1024 terrain draw calls with no LOD anywhere.
Frustum culling works, so it only bites zoomed out — which is also when players
pan most. It went unmeasured because software rendering in the dev environment
makes GPU cost unmeasurable; it needs its own issue if the pick fix does not
recover the frame rate on real hardware.
