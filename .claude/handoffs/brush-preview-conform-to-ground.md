# Brush preview: conform the footprint to the drawn ground

Status: wax-melt drape landed (2026-09-18) — verified headed with screenshots.
Commit 2 (midpoint joins) is moot: the drape subsumes it. Ready for review.
Written 2026-09-17, updated 2026-09-18.

## 1. What we are changing and why

The brush cursor today reads as a stencil projected down from the sky: a flat
ring floating at one height with a tall translucent column under it. It is hard
to tell which cells the stroke will actually land on.

Root cause, one sentence: **the preview's geometry is height-invariant and is
placed by a single sampled Y, so it can only ever be a horizontal plane.**

The fix moves height out of the object transform and into the vertices: every
outline point and every interior grid line takes its Y from the drawn ground
under it, so the footprint sits on the terraces like a decal.

Non-goals (do not do these):
- Do not change which cells the brush edits, or the outline's XZ shape. The
  enclosure contract in `client/test/brushPreview.test.ts` must keep passing
  unchanged.
- Do not touch `shared/`, the server, the sculpt intent pipeline, or the
  terrain mesher.
- Do not change the crosshair.
- Do not flip `depthTest` on the ring/grid (see section 8, owner decision).

## 2. The code as it stands

All five files are small; read all of them before starting.

| File | Role today |
| --- | --- |
| `client/src/render/brush/footprintMark.ts` | Builds the cell-space `Mark` (a dry sculpt sim), its marching-squares outline, and the interior grid segments. Pure cell math, no three.js. |
| `client/src/render/brush/brushGeometry.ts` | Turns one `Mark` into three flat `BufferGeometry` at y=0: ring, skirt, cell grid. Built once per `(radius, tool, profile)`. |
| `client/src/render/brush/brushStage.ts` | Owns the scene objects, materials, world-edge clip planes, and the cue painting (refused / offline / ghost / flat). |
| `client/src/render/brushPreview.ts` | Caches one `BrushGeometry` per key, and per frame swaps geometry and sets `object.position` to the aim cell at `hover.surfaceY`. |
| `client/src/render/brush/style.ts` | Colours, opacities, the z-fight lift. |

Key facts you will rely on:

- `world.drawnGroundYAt(cellX, cellZ): number | null` — world Y of the **drawn
  band cap** (the tread top) at a cell. Returns `null` when that cell's chunk
  is not drawn yet. Clamps out-of-world cells to the edge cell.
  (`client/src/world.ts:612`)
- `world.terrainRevisionAt(x, y): number` — bumps whenever the chunk holding
  that cell is redrawn. Clamps out-of-world. (`client/src/world.ts:604`)
- `CELL_WORLD_SIZE === 0.25` and `BAND_WORLD_HEIGHT === 0.25`: one band step is
  exactly one cell wide. Terrain risers are **vertical walls at cell
  boundaries**, with a flat tread per cell — this is why section 6 exists.
- `CHUNK_SIZE === 16` cells; `MAX_BRUSH_RADIUS === 16` cells.
- `markOutline` uses module-global scratch state in `terrain/contours.ts`
  (`loadSampleField` + `marchLevel`). It is only safe to call during
  construction, single-threaded, one at a time. **Keep all `Mark` and outline
  building where it is today: in the constructor loop of `createBrushPreview`.**

## 3. The contract

> The ring and the cell grid are drawn at the drawn-ground cap height of the
> footprint cells beneath them, lifted by `OUTLINE_LIFT_WORLD_UNITS`. Where a
> point touches more than one footprint cell, it rides the **highest** of them,
> and only cells inside the mark are considered.

Two consequences to keep in mind:
- "Only cells inside the mark" means a tall tread just *outside* the footprint
  never lifts the ring. The ring sits on the surface it will edit.
- "Highest" means at a band step the ring runs along the upper lip and drops to
  the lower tread, never sinking into a tread it would edit.

Fallback: if every cell under a point returns `null` (chunk not drawn yet), use
`hover.surfaceY`. With a sampler that always returns `null`, the whole thing
degenerates to exactly today's flat ring — that is what the tests will use.

Band cap (added 2026-09-18, owner direction): when the hover carries a
selected band (`hover.band`, the lit/held band — e.g. mid-carve), every vertex
Y is pinned at or below that band's cap (`drawnBandCapY`), fallback included.
The footprint paints the surface being edited, never the ground above it.
With no selected band the highest-cell rule above stands on its own.

Wax-melt drape (added 2026-09-18, owner direction): the outline is subdivided
at build time into runs of at most `DRAPE_STEP_CELLS` (0.25 cell), each
sub-point clamped inside the mark, and every vertex samples the ground beneath
it. Segments can no longer cut through the air between treads. Grid runs keep
their endpoints but ride the ground per end. Capacities are exact draped
maxima, computed per footprint at construction.

## 4. Commit 1 — conform the ring, grid and hem

Conventional commit, e.g. `feat(brush): draw the footprint on the drawn ground`.

### 4.1 `footprintMark.ts`

**Add** a helper that answers which mark cells a point touches:

```ts
const CELL_TOUCH_EPSILON = 1e-6;

/** The mark cells whose square contains this point; the ring rides the highest. */
export function markCellsTouching(mark: Mark, x: number, z: number): [number, number][] {
  const cells: [number, number][] = [];
  const x0 = Math.ceil(x - 0.5 - CELL_TOUCH_EPSILON);
  const x1 = Math.floor(x + 0.5 + CELL_TOUCH_EPSILON);
  const z0 = Math.ceil(z - 0.5 - CELL_TOUCH_EPSILON);
  const z1 = Math.floor(z + 0.5 + CELL_TOUCH_EPSILON);
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (mark.has(cx, cz)) cells.push([cx, cz]);
    }
  }
  // clampIntoMark guarantees a hit; the aim cell is the safe floor if it ever does not.
  if (cells.length === 0) cells.push([0, 0]);
  return cells;
}
```

Check the epsilon logic by hand before moving on: `x = 2.5` must give cells
`{2, 3}`; `x = 2.0` must give `{2}`.

**Change** `cellGridSegments` to report the cell pair each segment separates,
because each segment's height comes from those two cells:

```ts
export interface GridSegment {
  readonly ax: number; readonly az: number;   // segment endpoints, cell space
  readonly bx: number; readonly bz: number;
  readonly cellAx: number; readonly cellAz: number;
  readonly cellBx: number; readonly cellBz: number;
}

export function cellGridSegments(mark: Mark): GridSegment[]
```

Same segments as today, same order, same count — only the return shape changes.
The east-neighbour case keeps endpoints `(dx+0.5, dy-0.5)-(dx+0.5, dy+0.5)` with
cells `(dx,dy)` and `(dx+1,dy)`; the south case keeps
`(dx-0.5, dy+0.5)-(dx+0.5, dy+0.5)` with cells `(dx,dy)` and `(dx,dy+1)`.

**Delete** `skirtDropWorldUnits` and the now-unused `BAND_WORLD_HEIGHT` and
`OUTLINE_LIFT_WORLD_UNITS` imports. Nothing outside `brushGeometry.ts` uses it
(verified by grep).

### 4.2 `brushGeometry.ts` — becomes cell-space data, not geometry

Rename the export `brushGeometry` to `brushFootprint` and `BrushGeometry` to
`BrushFootprint`. Keep the file name. It no longer imports three.js.

```ts
export interface BrushFootprint {
  /** Outline in cell space, closed (first point repeated): x,z pairs. */
  readonly ringPoints: Float32Array;
  readonly ringCount: number;
  /** ringCellIndex[i]..ringCellIndex[i+1] slices ringCells for point i. */
  readonly ringCellIndex: Int32Array;
  /** dx,dz pairs. */
  readonly ringCells: Int32Array;
  /** Per segment: ax,az,bx,bz in cell space. */
  readonly gridPoints: Float32Array;
  /** Per segment: cellAx,cellAz,cellBx,cellBz. */
  readonly gridCells: Int32Array;
  readonly gridCount: number;
  /** max(|dx|,|dz|) over mark cells — the footprint's half-extent in cells. */
  readonly reachCells: number;
}

export function brushFootprint(
  radius: number, tool: SculptTool, profile: SculptProfile,
): BrushFootprint
```

It calls `oneClickMark`, `markOutline`, `markCellsTouching` per outline point,
and `cellGridSegments`, exactly as today's builder does — but stores cell-space
numbers instead of multiplying by `CELL_WORLD_SIZE` and building
`BufferGeometry`. The `* CELL_WORLD_SIZE` now happens in section 4.3.

Note `ringPoints` is the **closed** loop: `[...outline, outline[0]]`, as today
(WebGPURenderer draws `Line`, not `LineLoop`).

### 4.3 New file `client/src/render/brush/conform.ts`

This is the per-aim writer. It owns the three live geometries and their
preallocated buffers.

```ts
export interface BrushGround {
  /** Drawn band cap Y at a cell, or null where the terrain is not drawn yet. */
  yAt(cellX: number, cellZ: number): number | null;
  revisionAt(cellX: number, cellZ: number): number;
}

export interface ConformedGeometry {
  readonly ring: BufferGeometry;
  readonly hem: BufferGeometry;
  readonly grid: BufferGeometry;
  /** Rewrites all three if anything it depends on moved; cheap no-op otherwise. */
  syncTo(
    footprint: BrushFootprint,
    footprintId: number,
    aimX: number,
    aimZ: number,
    fallbackY: number,
    ground: BrushGround,
  ): void;
  dispose(): void;
}

export function createConformedGeometry(
  maxRingPoints: number,
  maxGridSegments: number,
): ConformedGeometry
```

Requirements on the implementation:

1. **Preallocate once.** Capacities (the x2 is headroom for Commit 2 — allocate
   it now so Commit 2 never resizes):
   - ring: `2 * maxRingPoints` vertices
   - hem: `6 * 2 * (maxRingPoints - 1)` vertices (2 triangles per ring segment)
   - grid: `2 * maxGridSegments` vertices

   Mark each `position` attribute `setUsage(DynamicDrawUsage)`. After a write,
   `setDrawRange(0, n)` and `attribute.needsUpdate = true`. Never allocate in
   `syncTo`.

2. **Dirty check before writing.** Store the last `footprintId`, `aimX`, `aimZ`,
   `fallbackY` and revision hash as plain scalars and compare them — no string
   keys, no allocation. Return early when nothing moved. This runs every frame;
   a full rewrite at `MAX_BRUSH_RADIUS` is ~1600 grid segments and must not
   happen unless something actually changed. No camera state enters `syncTo` by
   design: panning or rotating with a steady aim supplies identical inputs, so
   orbiting is a cheap no-op until the brush itself moves or the ground under
   it changes. There is deliberately no redraw on pan/rotate.

3. **Revision hash** covers every chunk the footprint can overlap, so another
   player's edit under the footprint's far edge still refreshes it:

   ```ts
   const firstChunkX = Math.floor((aimX - reach) / CHUNK_SIZE);
   const lastChunkX = Math.floor((aimX + reach) / CHUNK_SIZE);
   // same for Z
   let hash = 0;
   for (let cz = firstChunkZ; cz <= lastChunkZ; cz++) {
     for (let cx = firstChunkX; cx <= lastChunkX; cx++) {
       hash = (Math.imul(hash, 31) + ground.revisionAt(cx * CHUNK_SIZE, cz * CHUNK_SIZE)) | 0;
     }
   }
   ```

   At most 4x4 lookups per frame. Use `Math.imul`, not `*`, so the hash stays an
   int32 and cannot drift into float rounding.

4. **Height of a point** — the one rule from section 3, used by both the ring
   and the grid:

   ```ts
   const highestOf = (cells, from, to, aimX, aimZ, fallbackY, ground): number => {
     let y = -Infinity;
     for (let i = from; i < to; i += 2) {
       const sample = ground.yAt(aimX + cells[i], aimZ + cells[i + 1]);
       if (sample !== null && sample > y) y = sample;
     }
     return (y === -Infinity ? fallbackY : y) + OUTLINE_LIFT_WORLD_UNITS;
   };
   ```

5. **Writes.**
   - Ring: per point, `x = ringPoints[2i] * CELL_WORLD_SIZE`, `y = highestOf(...)`,
     `z = ringPoints[2i+1] * CELL_WORLD_SIZE`.
   - Grid: per segment, one Y for both endpoints —
     `max(yAt(cellA), yAt(cellB))` through the same helper, so a grid line lies
     flat on the higher of the two cells it separates.
   - Hem: per ring segment `i -> i+1`, two triangles from `(a, ya) (b, yb)` down
     to `(b, yb - RING_HEM_WORLD_UNITS)` and `(a, ya - RING_HEM_WORLD_UNITS)` —
     the same winding as today's skirt, with per-vertex Y and a fixed shallow
     drop instead of a full-depth curtain.

6. **Y is absolute world Y, not local.** The objects carry XZ only —
   `position.y` is set to 0 in `brushPreview.ts` (section 4.5). Put a one-line
   comment saying so; it is the one surprising thing in the file.

7. **`frustumCulled = false`** on all three objects (set in `brushStage.ts`).
   Three.js derives the bounding sphere from the whole attribute array,
   including the unused zeroed tail beyond the draw range, so culling would be
   computed from garbage. The brush cursor is always on-screen by construction;
   culling buys nothing.

### 4.4 `brushStage.ts`

- `skirt` to `hem`, `skirtMaterial` to `hemMaterial`, `SKIRT_OPACITY` to
  `HEM_OPACITY`. The word "skirt" would be a lie once it is a hem, and the
  rename is contained to this file plus `brushPreview.ts` (no test reads these
  names).
- The stage no longer receives an `initial: BrushGeometry`; it receives the
  three live geometries from `createConformedGeometry`.
- Set `frustumCulled = false` on `line`, `hem` and `cellGrid`.
- `disposeResources` no longer disposes per-key geometries (there are none);
  the conformed geometries dispose through `ConformedGeometry.dispose()`.
- Everything else — clip planes, cue painting, `show()`, render orders — is
  unchanged. Do not touch it.

### 4.5 `brushPreview.ts`

- Signature gains a fifth **required** parameter:
  `createBrushPreview(scene, canvas, worldSize, denial, ground: BrushGround)`.
  Required, not optional with a default: there is exactly one production
  callsite, and an optional parameter is an API that lets a caller silently fall
  back to the old sky-projected look.
- The construction loop now caches `BrushFootprint` per key instead of
  `BrushGeometry`, and while building it tracks `maxRingPoints` and
  `maxGridSegments` across every key, then creates one `ConformedGeometry` at
  those capacities. Give each cached footprint a stable integer `footprintId`
  (insertion order) for the dirty check.
- `useFootprint(wanted)` no longer assigns `line.geometry` / `skirt.geometry` /
  `cellGrid.geometry` — the geometries never change identity. It just selects
  the cached footprint.
- `placeFootprint()` becomes:

  ```ts
  line.position.set(hover.x * CELL_WORLD_SIZE, 0, hover.y * CELL_WORLD_SIZE);
  hem.position.copy(line.position);
  cellGrid.position.copy(line.position);
  conformed.syncTo(footprint, footprintId, hover.x, hover.y, hover.surfaceY, ground);
  ```

  Note the `0`: height lives in the vertices now.
- There are two paths that place the footprint (the drag/carve seed path around
  line 118 and the ordinary path around line 145). Both must call the same
  `placeFootprint()` helper — today the second path duplicates its body inline.
  Collapse that duplication as part of this change; a second copy is how the
  `syncTo` call gets forgotten in one branch.
- The crosshair is untouched: it keeps `hover.hitX/hitY/hitZ` and its own lift.
- `dispose()` disposes the `ConformedGeometry`, not a map of geometries.
- `BRUSH_PREVIEW_DRAW_OBJECTS` stays **4** (ring, hem, grid, crosshair).

### 4.6 `style.ts`

```ts
/**
 * The hem gives the ring visible thickness against the tread it sits on. Half a
 * band: clearly readable, and strictly short of the next tread down, so it can
 * never be misread as a second surface.
 */
export const RING_HEM_WORLD_UNITS = BAND_WORLD_HEIGHT / 2;
```

Keep `HEM_OPACITY` at today's `OUTLINE_OPACITY / 3`. It will read fainter now
that the volume is small — that is a tuning call for the owner, and this commit
changes one thing.

### 4.7 `main.tsx`

At the `createBrushPreview` call (~line 229):

```ts
{
  yAt: (cellX, cellZ) => world.drawnGroundYAt(cellX, cellZ),
  revisionAt: (cellX, cellZ) => world.terrainRevisionAt(cellX, cellZ),
}
```

### 4.8 Existing tests

Do **not** write new tests — the project rule requires the owner's per-session
permission and it has not been given. Repair what the signature change breaks,
nothing more:

- `client/test/brushPreview.test.ts` and `client/test/brushPreviewCues.test.ts`:
  add a fifth argument to all 20 `createBrushPreview(` callsites. Define once per
  file:

  ```ts
  const FLAT_GROUND = { yAt: () => null, revisionAt: () => 0 };
  ```

  A null-returning sampler collapses the conformed ring to today's flat ring, so
  every existing geometry assertion must keep passing **unchanged**. If one does
  not, you have a real bug — do not edit the assertion, fix the code.
- Two helpers must respect the draw range, because the buffers are now
  preallocated and `position.count` is the capacity, not the vertex count:
  - `outlinePoints` in `brushPreview.test.ts`: iterate
    `Math.min(line.geometry.drawRange.count, position.count)`.
  - the grid-segment count assertion ("draws the shared edge of every adjacent
    pair of footprint cells, once"): use `drawRange.count / 2`.
- Leave test names and comments alone otherwise. "leaves the outline geometry
  itself position-independent" still holds as written — it compares X and Z, and
  only Y is aim-dependent now.

## 5. Verification for Commit 1

```
pnpm typecheck
pnpm test
```

Both must pass. Run `git status` first: failing tests in packages you did not
touch are another agent's in-flight work, not your breakage.

Then read back the diff and confirm each of these by grep, not by memory:
- no `BufferGeometry` allocation inside `syncTo` or inside `update`
- `skirtDropWorldUnits` is gone and nothing references it
- `BRUSH_PREVIEW_DRAW_OBJECTS` is still 4
- `frustumCulled = false` on all three footprint objects
- `line.position` sets Y to 0 on both placement paths

**Do not start the client or the server to look at it.** That needs the owner's
permission in the current turn. Commit, then say it is ready for a visual check.

Stage only the files you touched — never `git add -A`.

## 6. Commit 2 — vertical joins at band steps

Stop here and hand back if you are unsure; Commit 1 stands on its own.

With Commit 1, two consecutive ring points at different heights are joined by a
slanted segment that floats over a vertical riser wall (remember: terrain risers
are vertical walls at cell boundaries, treads are flat). This commit makes it a
true staircase.

For each ring segment whose endpoint heights differ by more than
`STEP_JOIN_EPSILON_WORLD_UNITS` (name it; `1e-4` is far below any real band step
of 0.25 and above float noise at these magnitudes), emit two extra vertices at
the segment's XZ midpoint: one at `ya`, one at `yb`. The ring then runs flat
along the upper tread, drops vertically at the midpoint, and runs flat along the
lower one.

The ring buffer already has 2x headroom from section 4.3, so nothing
reallocates. The hem follows the same split (its quads subdivide at the same
midpoints).

Verification: `pnpm typecheck && pnpm test` — the existing tests use
`FLAT_GROUND`, so no step ever triggers and every assertion is untouched. That
means this commit is **not** covered by tests; say so plainly when you hand
back, and flag it for the owner's visual check.

Superseded 2026-09-18 by the wax-melt drape above: subdivision + in-mark
clamp handles every step, so midpoint joins add nothing. The 2x headroom note
below is moot — capacities are now exact per-footprint draped maxima.

Reviewer note (2026-09-18): the 2x ring headroom from section 4.3 does not
cover the worst case — if every segment steps, the ring holds
`3 * ringCount - 2` vertices and the hem `6 * (3 * ringCount - 3)`. Either
recheck the bound or grow the capacities before writing this commit.

## 7. Rejected alternatives (do not "improve" the plan into these)

- **Shader-side conform** — sample a drawn-ground texture in a vertex shader.
  Rejected: no such texture is exposed to overlays, and it would be substantial
  new renderer infrastructure for one cursor.
- **Projective decal** — render the footprint as a decal against the depth
  buffer. Rejected: needs a depth prepass the renderer does not run.
- **Keep the full-depth skirt** — it is the sky-column look we are removing.
- **Per-key exact-size geometries, mutated in place** — simpler than draw
  ranges, but Commit 2 makes the vertex count vary with the terrain under the
  brush, which would force a reallocation every time the aim crosses a step.

## 8. Owner decisions — do not take these yourself

- `depthTest: false` on the ring and grid (`brushStage.ts:88`) means the
  footprint still draws through a hill that occludes part of it. Arguably right
  for a cursor, but it slightly undercuts the on-surface illusion. Leave as is.
- 2026-09-18, superseded by owner direction: the hem is now also
  `depthTest: false`, so the whole footprint paints over the stroke and is
  never stopped by anything rendering above. Ring/grid rule above still holds.
- `HEM_OPACITY` may want raising now that the hem is small. Leave as is.
- Whether to keep Commit 2's staircase or settle for Commit 1's slants.

## 9. Known residual

While a chunk under the footprint is still undrawn, the points over it fall back
to `hover.surfaceY` and read flat until that chunk arrives. The revision hash
refreshes them the frame after it does.
