# Brief: hover-pick contract — a cached pick can never name dead geometry (#324)

Worktree: `/mnt/e/Development/Projects/Terrace/.claude/worktrees/carve-pick-contract`
(branch `carve-pick-contract`, cut from main 2fbd426). Work ONLY there. Commit to
that branch. Do not touch the shared checkout, do not `cd` out of the worktree,
never `git add -A` or bare `git add` — stage exact paths. Never start the app.

Plan approved by the owner 2026-09-04:
`/home/shawn/.claude/plans/terrace-carve-pick-contract.md`. Read it first; this
brief is the executable version of it.

Read `docs/DESIGN.md`, `docs/decisions/picking.md`, `docs/decisions/overhangs.md`
(the 2026-09-02 carve section) before touching code. Do not append to either.

## Rules of evidence
Every claim about existing behaviour must be re-verified by you at file:line
in THIS worktree before you rely on it. Comments are claims, not evidence. The
line numbers below were read on main 2fbd426 and are a starting point only.

## Root cause (one sentence)
`hoverTarget` (client/src/input/sculptInput.ts:442–520) caches a
`TerrainRayPick` — map snapshot (`spanIndex`, `surfaceY`) fused with ray facts
(`x`, `y`, `hitY`, `hitRiser`, `hitX`, `hitZ`) — and patches the snapshot half
after edits (the object literal at ~513), so validity rests on ad-hoc guards
(span count unchanged, `hitY` still inside the slab) that each new edit type can
defeat. `bandOfPick` (client/src/world.ts:483–515) then CLAMPS an out-of-range
struck height into the span, turning a dead claim into a confident wrong band.

## The contract you are implementing
The hover cache pins only immutable ray facts — the CELL the pointer aimed at
and the RAY that aimed at it — and every read re-evaluates that ray against the
pinned column of the LIVE map using the march's own per-cell function. No
map-derived field is ever copied forward between frames.

### 1. `client/src/terrain/picking.ts`
- Factor the per-cell `[tEnter, tExit]` box clip out of `marchCells` (373–) so
  it can be asked for ONE cell. Do not duplicate the scaled-space arithmetic
  (X/Z in cell units via `CELL_WORLD_SIZE` + `CELL_CENTRE_OFFSET`, Y in world
  units); `marchCells` and the new function must share it.
- Add `export function pickTerrainInColumn(mirror, x, y, origin, direction):
  TerrainRayPick | null`:
  1. Ray misses cell (x, y)'s XZ box, or cell not revealed / out of range → null.
  2. `terrainHitInCell` (471–) for that cell. A hit is the answer.
  3. GROUND-UNDER-THE-RAY FALLBACK: the ray crosses the cell in air (over a
     lowered cap, through a carved gap). Answer the TREAD of the highest drawn
     span whose cap lies below the ray's Y sweep in that cell: `hitRiser:
     false`, `hitY === surfaceY === cap`, hit point on that tread inside the
     cell (the ray's XZ at the midpoint of `[tEnter, tExit]` is acceptable;
     say what you chose and why in the doc comment). No such span → null.
- Document on `TerrainRayPick` that `spanIndex` and `surfaceY` are valid only
  for the map the pick was marched against and must never be cached across an
  edit; `hoverTarget` is the only cache and it re-marches.

### 2. `client/src/input/sculptInput.ts` — `hoverTarget`
Replace the cache (`hoverKey`, `hoverCache`, `hoverSpanCount`, `repick`, the
refresh/patch branch) with:
```
key = pointer + camera + worldSize      (UNCHANGED — owner 2026-08-14, outline tracks mid-pan)
key changed → store the ray (origin, direction copies); pinned := full march (pickCell)
every read  → if pinned cell: pick := pickInColumn(pinned.x, pinned.y, ray) ?? full march
              (a full march re-pins the cell and the ray)
return pick
```
- Nothing derived is stored between frames except the pinned cell coordinates
  and the ray. `pickInColumn` runs every read while the key is unchanged — one
  column's span loop, negligible against the 0.0063 ms full march
  (docs/decisions/picking.md). Do NOT add a `terrainRevisionAt` check; the
  contract must not depend on every mutation bumping a revision.
- The two settled promises must hold and be stated in the doc comment: a held
  stroke targets the cell the player aimed at (no uphill march on raise —
  issue #25; no walk-away on lower), and the outline lies on the ground.
- Consequence to document: after a still-mouse edit a tread hit may honestly
  become a riser hit (raised ground now meets the ray on its face) and vice
  versa. The CELL is what is promised, not the face kind.
- `takeHold`'s "THE NEW LIP IS READ FROM THE MAP AS A CHANGE, not re-picked"
  paragraph (~870) is now partly false (hoverTarget does re-evaluate). Rewrite
  the comment; KEEP the delta mechanism (`before`/`after` via `bandAtCell`) — it
  is still the correct proof that the seed raised the ground, and the
  frontier-halo argument still applies.
- New dep on the `SculptInputDeps` port: `pickInColumn(x, y, origin,
  direction)`; wire it in `client/src/main.tsx` next to `pickCell` (~200).

### 3. `client/src/world.ts`
- `World.pickInColumn(x, y, origin, direction)` → `pickTerrainInColumn`.
- `bandOfPick` (483): one derivation per face kind, NO CLAMP.
  | face | band |
  |---|---|
  | riser | `max(ceil(hitY / (HEIGHT_WORLD_SCALE·BAND_HEIGHT)), lowestDrawn)` — the `max` is the ONE legitimate tie-break: a hit exactly on the underside boundary belongs to the lowest band the span draws |
  | tread (`hitY === surfaceY`) | cap band of the struck span (unchanged) |
  | underside (`hitY < surfaceY`) | lowest drawn band of the struck span — the band whose slab the ray met (today it returns the CAP band; unreachable from a descending camera, fixed for consistency) |
  Precondition: the struck span still contains `hitY` (underside ≤ hitY ≤ cap,
  and `isSpanDrawn`). If not → **null**. Never clamp. Document that with the
  new cache this cannot fire and is the suspenders.
- `carveBand(pick)` — D1, owner 2026-09-04: "It should work on either the
  corner edge or the side face."
  | face | carve band |
  |---|---|
  | riser (side face) | `bandOfPick` |
  | tread (corner edge) | the struck span's CAP band, iff that band's lip lies within `GRAB_RADIUS_WORLD_UNITS` (render/layerEdgeOverlay.ts:201, 1.5 cells) of the point where the ray met the tread (`hitX`, `hitZ`); otherwise null — a flat tread far from any lip carves nothing |
  | underside | `bandOfPick` (lowest drawn band) |
  Belt: before returning any band, re-check `spanIndexCoveringBand(map, x, y,
  band) !== null` (shared/src/columns.ts:392) — the exact test the server
  applies at shared/src/heightmap.ts:2753 — and return null if it fails, so the
  client can never send a band the server would no-op.
- Lip proximity: the distance loop inside `lightBand`
  (render/layerEdgeOverlay.ts:639–660, `distanceSqToSegment` at 601) IS the
  corner-edge test. Factor it into a `lipNear(cell, band, atX, atZ): boolean`
  method on `LayerEdgeOverlay` that `lightBand` also calls — one distance
  rule, not two. `carveBand` asks the overlay through `layerEdges` (already
  held by world.ts).
- Preview/press agreement: the lit lip in the frame loop must come from the
  SAME derivation the press uses. `highlightLayerEdge` (987) lights riser hits
  only — right for the pull, whose tread means "seed". Add the tool to
  `LayerEdgeLight` (91) and light `carveBand(pick)` when the tool is `'carve'`,
  `bandOfPick` for riser hits otherwise. Wire the tool at both call sites in
  main.tsx (~212 `riserBand`, ~279 frame loop). `graspSpanBand` (1036) is
  unchanged.
- `hitX`/`hitZ` for the carve's tread test are the ray's own meeting point;
  `highlightLayerEdge` measures a non-riser hit from the cell lattice today —
  for the carve's lit lip use the same point the press uses (the tread hit
  point) so the two cannot disagree.

### 4. Remove
`World.spanCapAt`, `spanCountAt`, `spanContainsHeight` (interface 285–309,
impl 949–975), their `SculptInputDeps` ports (~88–101) and main.tsx wiring
(202–208). Verify by grep that nothing else uses them before deleting.

## Tests (owner permission granted this session, contract-level only)
Existing conventions: `client/test/picking.test.ts`,
`client/test/sculptRepeat.test.ts` — follow how they build a `TerrainMirror`
and drive `sculptInput`. Add:
- `pickTerrainInColumn`: (a) same answer as `pickTerrainCellByRay` for the
  cell that ray first meets; (b) after lowering that column below the ray,
  fallback returns the tread of the top span with `hitY === surfaceY`; (c)
  through a carved gap, fallback returns the FLOOR piece's tread; (d) ray
  missing the cell's box → null.
- `bandOfPick` via `World.carveBand`/`graspSpanBand`: riser hit exactly on the
  underside boundary → lowest drawn band; a pick whose `hitY` is outside its
  span → null (not the clamped band); underside → lowest drawn band.
- `hoverTarget` pinned cell: pointer still, (a) raise under it → same cell,
  `surfaceY` follows; (b) lower under it past the ray → same cell (fallback);
  (c) the #324 reproduction — riser hit at band k, carve that opens k, k+1 →
  the next `carveBand(hoverTarget())` is NOT k−1 (null on the interior floor,
  or k on a back wall).
- `carveBand` D1: tread hit within `GRAB_RADIUS_WORLD_UNITS` of the cap band's
  lip → cap band; tread hit ≥ 2 cells from any lip → null.
Do not add tests beyond the contract. Do not touch `shared/`.

## Verify before you report
```
pnpm typecheck
cd client && timeout 240 npx vitest run
```
Both must pass. Report: files changed, each removed accessor's last user
(grep proof), the test counts before/after, and any residual failure mode you
see with file:line. Commit as `fix(carve): pin the hover cell and re-derive the
pick from the live map` (conventional commit, no attribution trailers). Do not
merge — the orchestrator reviews and merges.
