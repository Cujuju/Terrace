# Deterministic pointer — the face under the cursor is the thing you get

Status: PLANNED 2026-08-27, revised the same day after a three-lens
multi-agent review (23 agents; 0 of 23 claims refuted). Tracker: #217
(`arc/deterministic-pointer`). Revision log at the end.

## Owner decisions (2026-08-26)

1. The sculpt pointer behaves like a CAD pointer: wherever the mouse lands,
   the face under it is the thing you get. No search radius, no nearest-lip
   snap, no tie-breaks.
2. "If you're grabbing the side of a band, then that is the band that should
   apply. I would never grab the band below."
3. "What if we didn't do a snap? What if you specifically had to be on that
   lip to grab it." — a lip has no width, so *on the lip* means **on the riser
   face**.

## The defect, stated once

There are two derivations of "which band is the player aiming at" — the
overlay's nearest-lip-in-plan search (`layerEdgeOverlay.highlightAt`, radius
`GRAB_RADIUS_WORLD_UNITS` = 1.5 cells, tie-broken by `preferBand`) and the
intent's `bandOfPick` (`world.ts`) — and the search one is not a function of
the pixel under the cursor. Everything below collapses both onto the pick.

## What a riser actually is (review finding, load-bearing)

A column is drawn solid from its own cap down to its neighbour's cap
(`picking.ts:150–155`). A cliff that drops five bands at once is therefore
**one span** with **one riser face five bands tall**, belonging to the upper
column, and that face carries five lips (one contour per band the face
crosses — `layerEdgeOverlay` draws all five). `spanIndex` names the span,
not the band; `bandOf(spanCapHeight(spanAt(…, spanIndex)))` on a riser hit
would always return the clifftop band — the exact "only the topmost layer"
defect the owner reported on 2026-08-24 that `hitY` was surfaced to fix.

So the band of a riser hit is a function of the **height struck**, and only
the rounding changes to honour decision 2.

## The rule

`pickTerrainCellByRay` (`client/src/terrain/picking.ts`) reports the face the
ray struck: `hitRiser`, `hitY` (the exact height met), `surfaceY` (the cap),
`spanIndex`, and the column entered.

**Riser hit → band = the band whose slab contains the struck height.** The
slab of band k occupies `[(k−1)·BAND_HEIGHT, k·BAND_HEIGHT]` in height units
(`columns.ts` `spanUndersideHeight`), so:

```
span = spanAt(map, x, y, spanIndex)
band = clamp(ceil(hitY / (HEIGHT_WORLD_SCALE·BAND_HEIGHT)),
             bandOf(spanUndersideHeight(span)) + 1,
             bandOf(spanCapHeight(span)))
```

`ceil`, not `round`: the whole face of band k, top to bottom, is band k's
handle. The clamp keeps a hit exactly on a slab boundary inside the struck
span's drawn range. (Replaces today's `Math.round(hitY / …)`, which made the
bottom half of every face grab the band below — decision 2's complaint.)

**Tread hit → band = `bandOf(spanCapHeight(span))`** (unchanged).

| Ray hits            | Drag (raise chord)     | Drag (lower chord)  | Carve                                              | Stamp / Smooth |
|---------------------|------------------------|---------------------|----------------------------------------------------|----------------|
| riser, band k       | grab band k, this cell | grab band k, this cell | cut from band k, this cell                      | brush at cell  |
| tread (cap)         | **seed** (§Seed)       | nothing             | cut from the cap band where `canCarveBandAt` allows; refused only on flat interior ground (the validator refuses a cell only when *every* neighbour covers the band) | brush at cell |
| roof underside      | nothing                | brush, unchanged (today's behaviour; raise is refused client-side, `sculptInput.ts:456–466`) | nothing | raise: refused; lower: brush (unchanged) |
| nothing             | nothing                | nothing             | nothing                                            | nothing        |

**Lip-exists guard (not a search).** A riser hit's band k is admitted only if
band k's drawn contour has a segment bounding this cell or an 8-neighbour —
the membership test `highlightAt` pass 1 already performs. Kept as a guard
because a drag names `targetBand` and `applyDragRegion` refuses a band
`canSpreadBandTo` cannot reach, and an emitted-then-refused intent still
spends a seq and a mana gate. What is deleted is the *search*: the
nearest-in-plan ranking and the `preferBand` tie-break. The guard answers
yes/no about one band; it never chooses one.

## Seed — the one tread press that still does something

A raise-chord press with Drag selected on a **tread** seeds a one-band
hard-profile plateau under the brush and immediately grabs its lip
(`sculptInput.ts` `startStroke`). Owner-designed, deterministic (cell under
the pointer, brush-sized): it stays. Review corrections:

- **Gate on the tread, not on "nothing grabbed":** seed only when
  `hover !== null && !hover.hitRiser && hover.hitY === hover.surfaceY`.
  Without that gate a raise press on a cave-roof *underside* would seed
  (today `riserBand === null` there too), bypassing the existing underside
  refusal.
- **There is no re-pick after the seed.** `hoverTarget()` is cached on
  pointer position + camera pose only (`sculptInput.ts:342–347`) and does not
  re-march after a terrain edit, so today's second `grabbableLip(hoverTarget())`
  re-uses the pre-seed tread pick. Under the riser-only rule that is null by
  definition. The seed band is therefore **derived from the map, as a change**:
  `before = world.bandAtCell(x, y)`; send the seed; `after = world.bandAtCell(x, y)`;
  `strokeGrab = after > before ? after : null`. `send` returns true for
  intents that predict nothing (`main.tsx:133–139`), so an absolute read after
  the seed is not safe; a delta is.
- `World.bandAtCell(x, y): number | null` = `bandOf(sampleHeight(mirror, x, y))`
  lives in `world.ts` beside the other pick derivations (sculptInput has no
  heightmap, no `bandOf`, and its only height accessor is in world units —
  a unit trap the previous draft walked into).
- Rewrite the stale "the overlay re-contours so the lip already exists"
  comment at `sculptInput.ts:678–682`.
- **The pointer must advertise the seed.** Today's `KNOWN GAP` in
  `brushPreview.ts` (crosshair under-promises on a tread) was kept because the
  ring would flicker as the cursor crossed in and out of grab range. With a
  riser-only rule there is no range: a tread always seeds, a riser always
  grabs. So Drag on a tread shows the **footprint ring** (the seed's exact
  extent), Drag on a riser shows the crosshair.

## Changes, by file

### `client/src/world.ts`
- `bandOfPick`: riser branch becomes the ceil-and-clamp expression above;
  tread branch unchanged. This is shared by `graspSpanBand` and `carveBand`,
  so carve cuts from the lip pointed at (a cap-band rule would have made
  every carve on a cliff face a null stroke at the clifftop).
- `highlightLayerEdge(pick)` → `pick.hitRiser ? bandOfPick(pick) : null`,
  passed through the lip-exists guard, then `overlay.lightBand(...)`. It no
  longer asks the overlay *which* band. Null before the first snapshot, as
  now.
- New `bandAtCell(x, y)` (§Seed).

### `client/src/render/layerEdgeOverlay.ts`
- `highlightAt(cell, preferBand)` → `lightBand(cell, band, atX, atZ)`:
  `cell` drives `nearbyChunks`; `(atX, atZ)` replaces the cell-centre
  `px/pz` in the distance test; the cell-centre bias note at :95–105 is
  superseded for this path. Returns whether band k has a segment bounding
  `cell` or a neighbour (the guard) and lights the segments within
  `HIGHLIGHT_SPAN_WORLD_UNITS` of `(atX, atZ)`.
- Delete `GRAB_RADIUS_WORLD_UNITS` as a *ranking* radius and the
  nearest-band/`preferBand` selection; the membership radius the guard uses
  is the same 1.5-cell "bounds this cell or its neighbours" derivation and
  keeps its doc comment.
- Keep the span-aware contours from `587dd29`.

### `client/src/input/sculptInput.ts`
- `grabbableLip` → `riserBand(pick)`: "the band of the riser under the
  pointer, guard-admitted, or null".
- `startStroke`, Drag: `strokeGrab = riserBand(hover)`; tread + raise → seed
  path (§Seed); tread + lower → emit nothing.
- **Touch:** the grab is currently decided at pointerdown and frozen, but a
  touch stroke only arms after `TOUCH_STROKE_GRACE_MS`, and with no hover and
  no radius the finger's first-contact ray is the only shot. Move the
  `strokeGrab`/seed block into `armStroke` for the `strokeIsTouch` path so the
  ray is re-fired at the settled finger position.
- `dragPlaneCell`: **floors** where every other pick rounds — a permanent
  half-cell bias. Route it through `worldPointToCell` so there is one
  plan-point→cell rule in the client.
- New `heldBand(): number | null` — the frozen `strokeGrab` while a stroke is
  live.

### `client/src/main.tsx`
- Keep `grabbable: grabbedBand !== null && brushTool() === 'drag'` (with the
  riser-only rule `grabbedBand` is already null on a tread; re-deriving
  `hitRiser` here would be a third derivation).
- Frame loop: light `sculptInput.heldBand()` when non-null, else the hover
  derivation. Today the highlight is re-derived from the live pick every
  frame, so during a pull the lit lip goes dark the moment the pointer leaves
  the riser while the player is still holding it.

### `client/src/render/brushPreview.ts`

REVISED 2026-08-27 after phase-1 eyes-on. Owner: "you can see where the mouse
cursor is, you can see the selected band, but the user is forced to manually
figure out where the two would intersect. I want that mouse pointer to be
pointing to those cells on the band lip." Chosen from a modelled comparison:
**exact hit + short lip tick, the tick as long as the brush.**

- Drag on a tread → footprint ring (seed extent). Drag/Carve on a riser →
  **marker at the exact ray hit**, riser colour tinted by the grabbed band.
  Nothing is drawn at the column cap on a riser hit — that is the "stuck on
  the top terrace" defect.
- Marker position: `(hitX, hitY, hitZ)` — the point the pick's ray met the
  terrain. `TerrainRayPick` regains `hitX`/`hitZ` (the entry point the march
  already computes when it sets `hitY`); `client/test/picking.test.ts`
  literals extend accordingly. Known, accepted: the march walks the cell
  lattice, so on a smoothed riser the marker can sit a fraction of a cell off
  the drawn face. After the quarter-cell re-sample a cell is small; verify
  eyes-on, and only if visibly off, ray-cast the rendered chunk mesh for the
  marker alone (the grab stays on the deterministic lattice pick).
- Lip tick: the grabbed band's contour segments within **the brush radius**
  of the marker — `HIGHLIGHT_SPAN_WORLD_UNITS` (fixed 2) is replaced by
  `brushRadius()` in world units, so the lit stretch is exactly the cells a
  press would move. `lightBand` takes the span as a parameter (caller-owned,
  like `atX/atZ`); the lit stretch is centred on the marker, not the cell
  centre. Not the whole nearby contour.
- `BrushHover` gains the band and the hit point; make the new fields optional
  with the cell centre as fallback so `client/test/brushPreview.test.ts`'s
  11 hover literals keep passing.
- Guard-refused band (no reachable lip): marker drawn hollow/grey, no tick.

### `client/src/render/pickDebugOverlay.ts`
- Readout: `hitRiser`, band, guard verdict.

### Tests that exist and will break
- `client/test/picking.test.ts` — unchanged if `TerrainRayPick` is unchanged
  (it is, after dropping `hitX/hitZ`).
- `client/test/brushPreview.test.ts` — see above.
- Run `pnpm test` beside `pnpm typecheck`.

## Not changed (deliberately)

- Shared math and the wire: `SculptIntent` already carries `targetBand` /
  `spanBand`; the server never sees the pointer. Nothing in `shared/`.
- Tread rounding for Stamp/Smooth (`worldPointToCell` rounds to nearest
  vertex) — owner has not asked.
- `hitRiser` stays view-dependent (a riser seen from directly above is not
  hittable). Accepted: the player orbits to grab. CAD behaviour.

## Verification (eyes-on; owner policy: no tests unless asked)

1. Cliff of ≥5 bands, shallow pitch, Drag selected: hovering each height on
   the face lights only the band whose slab contains that height; hovering
   the tread shows the footprint ring and lights no lip.
2. Press a riser and pull: the edge follows from the first pointer move with
   no jump. At maximum zoom, move one cell right: the pull advances one cell
   right when the pointer crosses the cell boundary, not before.
3. While pulling, the grabbed lip stays lit and no other lip lights.
4. Tread + Drag + raise: a plateau seeds and is immediately in hand. Tread +
   Drag + lower: nothing.
5. Carve on the face of a ≥3-band cliff opens a tunnel mouth at the aimed
   lip, not at the clifftop. Carve on flat interior ground: refused.
6. Touch (emulated pointer, `pointerType: 'touch'`): a held finger on a
   riser grabs after the grace window.
7. `pnpm typecheck` and `pnpm test` clean.

Capture 1–5 headlessly on the arch fixture (`previewArch.ts?edges=1`) plus
one live-world screenshot per case; orchestrator views before merging.

## Rejected alternatives

- **Nearest-lip snap for Drag** — rejected by the owner (decision 3).
- **`bandOf(spanCapHeight(span))` on a riser** (first draft) — names the
  clifftop on every multi-band face; regresses the 2026-08-24 report.
- **`round(hitY)`** (today) — bottom half of each face grabs the band below;
  violates decision 2.
- **Delete the lip-exists membership test with the search** — lets a stroke
  name a band the shared math will refuse, after paying seq + mana.
- **Screen-pixel grab radius** — a tolerance is a search. Honest caveat: a
  riser face is one band × one cell (0.25 × 0.25 world units) but its
  *projected* height shrinks with camera pitch; the mouse copes, touch gets
  the arm-time re-pick above instead of a radius.
- **Tread press with Drag falls back to Stamp** — a hidden mode switch; the
  seed rescue covers "nothing to pull".
- **Raw ray entry point as the crosshair** — a lattice crossing, not the
  drawn face.

## Owner decisions taken by this revision (say so if wrong)

- Q1 (seed on tread press with Drag): **keep**, and the pointer advertises
  it with the ring.
- Q2 (carve/drag on a roof underside from below): **no** — inert. Would need
  a `shared/` protocol change (validator forbids carve `dir: 1`) and is its
  own gesture; own arc if ever wanted.
- **New — multi-band face:** on a face that drops several bands at once, the
  band grabbed is the one whose slab contains the struck height (the
  ceil-and-clamp rule). This is the literal reading of decision 2; please
  confirm, since it is the load-bearing change.

## Process

One worktree for the arc; fresh Opus agent per phase; orchestrator reviews
screenshots and ff-merges. Phases: (1) `world.ts` + overlay + input (the
rule, guard, seed, touch, `dragPlaneCell`, `heldBand`); (2) pointer visuals
(`brushPreview`, `main.tsx` frame loop, debug readout, test fixtures);
(3) eyes-on capture.

## Revision log

- 2026-08-27 review (lenses: code-fit, geometry, owner-intent; each
  non-minor claim adversarially re-checked by a second agent; none refuted):
  - BLOCKER — riser band from `spanCapHeight` → clifftop on every face.
    Fixed: ceil(hitY) clamped to the struck span. (Also fixed the derived
    blocker: carve on a face would have cut at the clifftop.)
  - BLOCKER — seed fired on roof undersides. Fixed: tread gate.
  - MAJOR ×9 — seed band unit trap / no re-pick / `send` returns true on
    no-op predictions (→ `bandAtCell` delta); carve-at-tread claim wrong
    (→ table); `brushPreview.test.ts` breakage (→ named); grab could name an
    unspreadable band (→ guard kept); `dragPlaneCell` floors (→ round);
    touch grab frozen pre-arm (→ arm-time pick); highlight dies mid-pull
    (→ `heldBand`); ray entry point is not the drawn face (→ nearest contour
    point; `hitX/hitZ` dropped); pointer must advertise the seed (→ ring).
  - MINOR ×5 — `lightBand` needs the cell; `grabbable` third derivation
    dropped; underside row split by chord; Q1/Q2 answered; multi-band face
    question surfaced to the owner.
