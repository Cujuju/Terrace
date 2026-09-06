# Brief: the hover pick follows the mouse, not a stale pin (GH #349)

Tracker: `Cujuju/Terrace` issue #349, label `arc/carve-pick-contract`.
Predecessors on the same arc: #324 (hover pick contract, shipped e9a065d),
#339 (drawn-face pick, shipped ecf042f). Read
`docs/decisions/picking.md` and `docs/decisions/overhangs.md` first. Both are
settled with the owner; do not relitigate, do not append without permission.

Work in a fresh worktree (`EnterWorktree`), commit there, merge on the shared
checkout, push. All git against the shared checkout via `git -C`, staging
exact paths only. Check `MERGE_HEAD` and `git status` in the same command as
the merge (see `.claude/orchestration/briefs/carve-drawn-face-pick-pass3.md`
for the merge recipe that has worked).

## The owner's words (2026-09-05)

> When I click on a band, it carves, but now I can't just click, click, click
> to continue to carve. I have to move the mouse to reselect an edge vertex.
> I want to be able to do an edge vertex or a side face. At the base level, I
> don't want my mouse snapping to a different band. I always want whatever my
> mouse was pointing at to be what I select.

Evidence: two screenshots, one click apart, mouse not moved
(`/mnt/e/Proton Drive/Shaolo/My files/Screenshots/SS-26.09.05_19.04.11.png`
and `SS-26.09.05_19.04.15.png`). Before: lip highlighted, crosshair just under
the lip. After: highlight gone, crosshair about 30 px straight DOWN from where
the mouse still is, on the floor of the opening the cut just made. A second
click does nothing.

Earlier the same day the owner reported "band three and four missing when
band three is clicked". That is a HELD click (see mechanism 3).

Two prior attempts by the orchestrator were wrong and are NOT on main:
a "carve fires once per press" change (174df97, reverted in 7c95079) treated
the held-click symptom without touching the pin. Do not reintroduce it as the
fix; the held-carve behaviour is decided below as part of the contract.

## Rules of evidence

Comments are claims. Cite `file:line` you verified THIS session for every
fact you rely on. The line numbers below were correct on main at 7c95079;
re-find them. Report failures faithfully, with output. No new tests unless
the owner has granted permission in your session; ask for it in your first
message, because the contract here deserves tests.

## Mechanism (verified from source 2026-09-05)

1. **The pin.** `hoverTarget` (`client/src/input/sculptInput.ts:527`) keys a
   cache on pointer position + camera pose only. While the key is unchanged
   it re-derives the pick from the pinned cell and ray via `pickInColumn`
   (`world.ts:1097` → `pickTerrainInColumn`, `terrain/picking.ts:1167`).
   Nothing releases the pin at stroke end: `stopRepeat` (`:808`) and
   `onPointerUp` (`:1105`) leave `hoverKey`, `hoverCell`, `hoverRay` alone.
   The pin therefore outlives the press that justified it and governs the
   NEXT hover and the NEXT click.

2. **The off-mouse crosshair and the dead click.** After the cut, the pinned
   ray passes through the opening in the pinned column. `pickTerrainInColumn`
   answer 3 (`picking.ts:1211-1236`) returns the floor tread with
   `hitX/hitZ` at the MIDPOINT of the ray's chord across the cell: a point
   not on the ray, hence a crosshair below the mouse. `resolvePick` calls it a
   tread; `carveBandOfPick` (`terrain/pickBand.ts:139`) needs `lipNear` for
   a tread hit and the floor's band has no lip within
   `GRAB_RADIUS_WORLD_UNITS` (`render/layerEdgeOverlay.ts:238`), so the band
   is null and the click sends nothing. The lip highlight is fed by the same
   pick (`world.ts:1028-1065`), which is why it goes dark.

3. **The held click carves the band above.** Each repeat of a held press
   calls `emitIntent` (`:579`), which reads `hoverTarget()` and derives
   `spanBand = carveBand(cell)` afresh (`:635`). In the pinned column the ray
   now meets the ceiling the first cut exposed; an underside hit names the
   roof's lowest drawn band (`pickBand.ts:71`, `bandOf(underside)+1`); the
   repeat carves it. Measured with the shared math + mesh builder: one cut at
   band 3 draws a one-band opening (floor cap 2·BH, ceiling 3·BH), and the
   repeat opens band 4. Probe: `.agent-stack/carve-verify/probe/
   carveMeshOpening.test.ts` (run with `npx vitest run --dir <that dir>` from
   `client/`).

4. **Why the pin exists.** Issue #25 (2026-08-19, owner): a HELD stamp must
   not re-pick against the mound it is raising and march uphill ahead of the
   outline. #324 (2026-09-04) made the pin re-derive map facts per read so a
   cached `spanIndex` could never go stale. Both promises are about a stroke
   in progress. Neither says the pin should survive pointer-up.

## Root cause, one sentence

The aimed-cell pin that protects a held stroke is keyed on pointer + camera
alone and is never released when the stroke ends, so between presses the
crosshair, the lip highlight and the next click all target a cell the mouse
is no longer pointing at.

## The contract to implement

C1. **Between presses, the hover pick is the honest march** of the current
    pointer ray against the live map: `pickCell`, every read that the map or
    the ray may have changed. The crosshair is always ON the ray. There is no
    off-ray point in the hover pick; if `pickTerrainInColumn` answer 3 stays
    for held strokes, it must be unreachable from an idle hover.

C2. **During a held stroke, the cell is pinned** (issue #25 stands): from
    press (or touch arming) to release, repeats target the pressed cell. The
    pin is released at `stopRepeat` (pointer-up, cancel, blur) so the very
    next hover read re-marches. Decide and document whether the pin is taken
    at press for ALL tools or only those that repeat; a drag already
    re-targets per pointer move.

C3. **Click, click, click carves inward.** After a carve at band S on the
    face cell, the honest re-march of the same ray meets either the back wall
    (band S's face one cell in: a riser hit, carve S again there) or the
    floor tread. A tread hit far from a lip carves nothing (D1, 2026-09-04,
    `pickBand.ts:110-138`). Verify with a probe which of the two the owner's
    camera pitch produces; the owner expects the click chain to continue, so
    if the honest ray lands on the floor at typical pitches, say so and
    propose, do not silently widen `lipNear`.

C4. **A held carve.** With C2 in place a repeat re-picks inside the pinned
    column and meets the exposed ceiling, so it would still carve band S+1.
    Choose one, state it in the commit, and make it a shared statement rather
    than an `=== 'carve'` at a callsite (pattern: `TOOLS_WITHOUT_DIRECTION`,
    `shared/src/heightmap.ts:225`):
    (a) the carve freezes `spanBand` for the stroke the way `strokeTool` is
        frozen (`:264`, `:962`), so a repeat re-cuts band S at the same cell,
        which `applyCarve` no-ops via its overlap check but `sculptDisplacementUnits`
        still prices in full (`heightmap.ts:1931`): mana burned for nothing,
        so (a) also needs the client to skip an intent that cannot change the
        column; or
    (b) the carve does not repeat (the reverted 174df97 shape, as a shared
        `TOOLS_WITHOUT_HOLD_REPEAT` list beside the other trait lists).
    The orchestrator leans (b); the owner has not chosen. Ask.

C5. **Nothing else moves.** Cut depth (`CARVE_BANDS_PER_STROKE = 2`) and the
    drawing rule are out of scope; a one-cut opening is one band, measured.
    Do not touch `docs/`.

## Rejected alternatives (so you do not re-tread them)

- Invalidate the pin on terrain change (revision counter): breaks #25, the
  held stamp would re-march into its own mound.
- Put the fallback hit point on the ray instead of the chord midpoint: fixes
  the crosshair position, keeps the wrong cell and the dead click.
- Widen `lipNear` so the floor tread carves: changes D1 and makes a flat tread
  carve, which the owner ruled out on 2026-09-04.

## Verification

- `pnpm typecheck` clean; `cd client && timeout 400 npx vitest run` (never
  `pnpm -r test`); shared tests if you touch `shared/`.
- Probe the click chain without a browser: build a mirror, carve at band S
  with `applySculpt`, then re-pick the SAME ray with `pickTerrainCellByRay`
  and show which face/band it names and that `hitX/hitZ` lie on the ray.
  Start from `.agent-stack/carve-verify/probe/pickCaseB.test.ts` for the
  world + `DrawnRisers` setup.
- Eyes-on is the owner's; ask before starting or restarting the app.
  `shared/` changes need a server restart to take effect
  (`terrace-dev-ops-gotchas`).

## Report back

One paragraph per contract item C1-C5 with file:line, then the probe output
showing: crosshair on the ray after a cut; second click at the same pixel
carves the next cell in (or a stated reason it cannot); held-click behaviour
as decided. List anything you left out and why.
