# Overhangs

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-24 (overhangs, arches and caves — the column becomes a list of spans)

**The problem, in one sentence: a column stores one height, so no cell can be
empty below and solid above.** Everything an overhang, an arch or a cave is
depends on exactly that shape. `picking.ts` states the consequence outright —
"the column is treated as SOLID from its cap downward" — and that sentence, not
the renderer, is the whole obstacle. Raised by the owner (2026-08-24) after
trying to pull one layer out from under another with the Pull tool (#99) and
getting the levels below dragged out with it: the tool was not misbehaving, the
terrain model has no way to express what was being asked for.

**The renderer is already a stack of level sets, and that is what makes this
tractable.** `capEmission.ts` builds a chunk by looping bands, marching squares
over the set `{h ≥ k·BAND_HEIGHT}`, triangulating each contour loop into a cap
and extruding skirts down its edges. It never asks "what is the height here" in
order to make geometry — it asks **"is this cell solid at band k?"** That
question generalises to overhangs without the contour, smoothing or
triangulation machinery changing at all. The change is in what a COLUMN is, not
in how terrain is drawn.

#### The model: a layered heightfield

Each cell holds a short list of solid spans `[floor, ceiling)` instead of a
single height.

| Feature  | What it is in this model |
| -------- | ------------------------ |
| Overhang | a span whose floor is above its neighbour's ceiling |
| Arch     | a column with two spans; the gap between them is the opening |
| Cave     | a connected region of gaps between spans |
| Today    | every cell has exactly one span, `[MIN_HEIGHT, h)` |

That last row is the load-bearing one: **the world as it stands is a strict
special case of the new model**, so this is a widening rather than a
replacement, and it can be introduced with the one-span invariant held and
nothing changing on screen.

**What the renderer needs on top of what it already has: ceiling caps.** Every
cap today faces up. An overhang needs its underside drawn — the same
marching-squares pass, over "which cells have a span ENDING at band k", with
reversed winding and lit from below. That is most of the render work, and it is
new geometry rather than a new pipeline.

#### Rejected alternatives

- **Sparse voxels / marching cubes.** Fully general, and wrong here. Every
  module in `shared/` is 2D-indexed; the terraced band look is the game's visual
  identity and a voxel surface fights it; the wire format and the determinism
  contract (§3.1, §3.3) both get rebuilt from scratch. It buys topology nobody
  has asked for — floating islands, closed bubbles — at the cost of the parts of
  the codebase that currently work.
- **Signed distance field / dual contouring.** The best-looking caves, and the
  furthest from this game. It produces smooth organic surfaces, which is the
  opposite of the terracing that `bandColors`, the water renderer, the brush
  preview and the layer-edge overlay are all built around.
- **Keep the heightmap; add authored overhang props.** Arches and cave mouths as
  placed models with their own collision, terrain untouched. Genuinely the
  cheapest path and what many shipped games do. Rejected as the primary model
  because caves would become rooms entered through a portal rather than
  structure the sculpt tools can carve — but it remains the right answer if the
  goal ever narrows to visual variety alone.

#### Blast radius, measured rather than estimated

38 non-test modules read heights, which sounds fatal and is not: raw `cells[]`
access is concentrated in six files.

| File | direct `cells[]` accesses |
| ---- | ------------------------- |
| `shared/heightmap.ts` | 17 (it owns the type) |
| `client/terrain/mirror.ts` | 9 |
| `shared/rivers.ts` | 5 |
| `shared/chunks.ts`, `server/world/world.ts`, `client/render/brushPreview.ts` | 5 combined |

Everything else goes through `heightAt`/`sampleHeight`. **If those keep meaning
"the top of the topmost span" — the walkable surface — then rivers, pathing,
farmland, traversal, steering, flora, boats, water and fog keep working
untouched**, because the walkable surface stays well defined. The modules that
genuinely must change are the mesh builder, picking, the sculpt math and the
wire format.

#### What gets harder, stated plainly rather than discovered later

- **Picking.** The march must return WHICH SPAN the ray hit, because a ray can
  now enter a cave mouth and strike a floor beneath a ceiling. Structurally it
  is the same loop with a span test instead of a cap test, but every consumer of
  `TerrainRayPick` inherits a new question — which layer did I click? — and the
  sculpt tools all have to answer it.
- **The wire.** `ChunkPayload.heights: number[]` becomes variable-length per
  cell. Determinism survives (still integers, still fixed iteration order), but
  the encoding, the terrain diff and the prediction store's cell-indexed journal
  all assume one value per cell today.
- **Sculpting.** Every tool currently means "move the surface". With spans, each
  has to say which span it moves, and what happens when two merge or one splits.
  That is a design pass per tool, not a mechanical port — and it is deliberately
  NOT part of the first stages below.
- **Water, fog, rivers.** They ask for the height and get the topmost surface,
  which is right for them — until someone wants water inside a cave. Out of
  scope; noted so it is not mistaken for an oversight.

#### The staging (decided): render first, sculpt much later

The owner's ask was explicitly "not to build those things, but to be able to
render them at least", and the staging follows that literally. Each step is
independently verifiable, and the first two change nothing a player can see.

1. **Widen the type to spans, with an invariant that every cell has exactly
   one.** Nothing changes on screen and nothing else moves. Verified by the
   world rendering identically.
2. **Add ceiling caps to the mesh builder and span-aware picking, invariant
   still held.** Still nothing changes on screen — the ceiling pass has nothing
   to draw while every column is one span.
3. **Lift the invariant and hand-author a test chunk containing an arch.** This
   is the step that answers the real question: whether the terraced look, the
   band palette and the lighting hold up with a ceiling in the world. Nothing is
   sculptable yet.
4. **Only then decide what sculpting a second span means**, informed by
   something on screen rather than in the abstract.

   AMENDED 2026-08-27 (issue #224): the first of those decisions is made — see
   "Decisions made 2026-08-27 (a pulled band overhangs a carve; it never fills
   it)" at the end of this file, which overturns the drag's D4 "fill the
   opening" rule.

**Steps 1–3 are the answer to "render them at least."** Step 3 is the decision
point: if the aesthetic does not survive a ceiling, the authored-props
alternative above is the fallback and steps 1–2 are still worth having.

#### Invariants this must not break

- `shared/` stays the single source of truth for terrain math, and stays
  deterministic integer-only with fixed iteration order (§3.3). Spans are
  integers; nothing here needs floating point.
- Clients still send intents, never heights (§3.2). A span-aware sculpt names
  which span it means; the server re-derives what that span is.
- The unlocked-region mask still works by omission (§3.4) — a chunk not sent is
  still a chunk not sent, whatever a column contains.
- `heightAt` keeps meaning the walkable surface, which is what makes the blast
  radius above true. Any change to that meaning invalidates the estimate.

Tracked as #129 (this work), which supersedes #110 (overhangs) in scope.

## Decisions made 2026-08-27 (a pulled band overhangs a carve; it never fills it)

Owner report (#224): "if I carve and I try to pull the layers above, it
instantly fills the carve." Reproduced on a carved column — a floor span, an
opening, a roof span — by pulling a band that lies in the opening.

**This overturns D4's "fill the opening" rule, which is kept below as the
record of what it used to be.** D4 (issue #129, step 4.5) said the receiving
span for a fill to band k is "the highest span whose ceiling lies below k"
(`spanIndexBelowBand`, columns.ts): raising that span's ceiling to the band
"puts material in the opening, and if that reaches the span above the two weld,
which is a sealed cave rather than a deleted one." The reasoning was that a
drag adds material and a sealed cave is at least not a deleted one. In the hand
it is the opposite of what the gesture means: the player who just cut an
opening and grabbed the roof gets the opening filled from the floor up and the
carve destroyed in one click.

**Decision (owner, 2026-08-27): the roof extends as an OVERHANG. The floor span
never rises.** Pulling a band that lies in a gap under the cell's own roof lays
that band's own slab — which welds to the roof above it wherever the join is
too thin to draw — and leaves the span below byte-untouched.

**The rule, stated once, in `columns.ts` `bandFillAt`.** For a cell open at band
k, the fill is `extend` (the ground below rises to the band — the terrace step
the drag has always built) when the column has OPEN SKY above the band, and
`overhang` (the band's own slab) when the column has any span above it. Both
the drag's own fill and `pushLowerLayers`' cascade go through it, so neither
can seal a carve; the cascade additionally refuses `overhang` outright, because
it exists to carry an existing staircase and must never author new roofs.

- **Why the cell's own column decides and not a survey of its neighbours.** The
  neighbour is what ADMITS the fill (`canSpreadBandToSpan` — the anti-cheat that
  keeps "clients send intents, never heights" true of a message naming a band);
  what the cell then looks like is a question its own spans answer completely.
  Neighbours that disagree would need a tie-break, and a tie-break is a rule two
  replicas can drift on.
- **Why no new field on the wire.** The grasped span already travels: a drag
  carries `targetBand`, one column covers a band with at most one span, and both
  replicas resolve the band against their own map. A `spanBand` on a drag intent
  would be the same number twice — and it could not be derived correctly anyway,
  because a pull's `x`/`y` is the CURSOR cell, not the cell whose lip is in the
  player's hand. This is what `sculptInput.ts` `emitDrag` deferred to "plan step
  4.5, D5", now resolved: the span-aware form of the pull is the per-cell rule
  inside `applyDragRegion`, not a wire field.
- **Unlayered worlds cannot reach the new branch, by construction.** A one-span
  column floors at `BEDROCK_FLOOR` and every band of a valid world is at or
  above it, so the span either covers the band or lies below it and there is
  never a span above. Verified: a hard drag pulling a band-4 terrace across a
  disc produces a byte-identical height field before and after this change.
- **The slab is floored one height unit above the boundary below it**, not on
  it, because `spanUndersideHeight` hangs a span one band below its lowest
  FILLED band: a slab floored on the boundary would fill the band under it too,
  be drawn two bands deep, and weld to ground one band down — the floor-to-roof
  weld this decision exists to prevent. Same reconciliation and the same single
  height unit as `BEDROCK_REMNANT`.
- **An opening too thin to hold an overhang still welds, and that is the model
  speaking, not this rule.** `isGapDrawn` says a one-band gap is not drawn;
  a slab laid with less than that clearance merges into what it touches. A
  carve deep enough to see is deep enough to overhang.

**Rejected alternatives.**

- *Keep D4 and refuse the pull under a roof.* Honest, and useless: the owner's
  gesture would do nothing rather than the wrong thing, and there would still be
  no way to extend a roof.
- *Ask the neighbour that holds the band whether it holds it as a roof
  (`spanIndexCoveringBand > 0`) and mirror that.* Closer to the words of the
  report and strictly worse to implement: several neighbours can hold the band
  in different shapes, so it needs a tie-break, and the answer would then depend
  on scan order rather than on the terrain.
- *Carry the grasped span on the drag intent.* See "why no new field" above —
  the cursor cell is not the grabbed cell, so the field would be wrong exactly
  where it mattered.

## Decisions made 2026-09-02 (the carve opens the band the player points at)

Owner report: "It's not working consistently when I attempt to carve layers. It
will just stop. It only goes so far when my expectation is I should be able to
carve all the way through a band." Reproduced in the shared math: a cliff at
band 10 over ground at band 2, grabbing the lowest lip (band 3), cuts ONE cell
and every cut after it is refused.

**The cause was an alignment mismatch between the pick and the cut, not the
anti-cheat rule.** A riser pick names the band whose drawn slab contains the
struck height — band k's face is `[(k−1)·BAND_HEIGHT, k·BAND_HEIGHT]`, and
that is the band that applies (owner, 2026-08-26). The carve as shipped in D6
removed `[spanBand·BH, (spanBand+2)·BH)`, which leaves band `spanBand` solid as
the tunnel floor and opens band `spanBand+1`. The next pick, on the back wall
inside that opening, therefore names `spanBand+1`, whose cut wants to open
`spanBand+2` — a band no neighbour is open at. The plan's 2026-08 note that
"the literal D6 rule stalls after one cell" moved the rule to the bands the cut
opens; it fixed the first cut and left every later cut refused.

**Decision (owner, 2026-09-02): the cut OPENS the grasped band.** A carve
grasped at band S removes `[(S−1)·BH, (S−1+CARVE_BANDS_PER_STROKE)·BH)` and
asks `canCarveBandAt` of bands `S … S+CARVE_BANDS_PER_STROKE−2`. The opening a
cut leaves is exactly the band the next pick inside it names, so the tunnel
walks inward one cell per intent without limit, and the floor of a cut grasped
at the lowest lip of a face is level with the ground outside it. Verified by
simulation against the shared library: five successive cuts inward, each
leaving `[…,32), [64,…)` at band 3.

**Two decisions beside it, from the same report.**

- **A carve lowers by default, and only ever lowers.** The tool has one
  direction, so the raise/lower chord does not apply to it: a plain click
  carves, the modifier is ignored, the direction is not re-resolved
  mid-stroke, and a carve stroke never writes the sticky HUD mode. The wire
  contract is unchanged — `dir: -1`, and the validator still rejects `dir: 1`.
- **The HUD hides the Mode row for the carve**, the same way it hides the Edge
  row for the tools that have no edge (issue #225): a control whose setting
  cannot change the stroke is removed, not disabled. Which tools have no
  direction is one shared list beside `TOOLS_WITHOUT_EDGE_PROFILE`, read by
  both the HUD and the input.

**What does not change.** `bandOfPick` — the drag shares it and the owner's
"that is the band that should apply" stands. `CARVE_BANDS_PER_STROKE` — still
the smallest cut `isGapDrawn` keeps; the cut moved one band down, its depth
did not. The bottom-of-world refusal in `applyCarve` — with the lower `lo` it
also refuses a grasp one band above the floor, whose lower piece would be
empty, which is the same column the storage cannot encode.

**Rejected alternatives.**

- *Have the carve's pick name the band below the struck slab.* Fixes the chain
  by making the carve the one tool that reads a face differently from the
  drag, and reintroduces the "grabbing the bottom half names the band below"
  behaviour the 2026-08-26 decision removed.
- *Ask `canCarveBandAt` of the grasped band as well as the opened one.* Widens
  admission without moving the opening; the next pick still names a band the
  cut never opened.
