# Terrace — sculpting layered terrain (step 4 of #129)

Status: **Steps 4.1 and 4.2 SHIPPED** (2026-08-25, tip `72fd72a`). 4.1 landed the
primitives with no callers; 4.2 landed the wire, the diff, persistence and the
prediction base — `28eddbc`, `05d2bed`, `965edcf`, `72fd72a` — and moved the arch
fixture server-side per P10. `assertSingleSpanWorld` is out of
`heightsForPersistence`, so a carved world persists. **4.2's eyes-on gate is NOT
done** — issue #161. **Step 4.3 is done** (issue #162, `de04137`, after
`2615611` made grid.ts a leaf so heightmap.ts could import the span model at
all). Next: **step 4.4**. Steps 4.5–4.7 unstarted.

Written 2026-08-24 against tip `d06fa44`, after
step 3 (`c30784e`, the arch fixture) put a ceiling on screen and it read. Steps
1–3 are `7e08772`, `28e62d8`, `c30784e`. Design record: `docs/DESIGN.md`,
"Decisions made 2026-08-24 (overhangs, arches and caves — the column becomes a
list of spans)". Build order for steps 1–3:
`~/.claude/plans/terrace-layered-columns.md`. Neither is relitigated here.

## The one-sentence problem

Every sculpt tool means "move the surface", and a column that holds more than
one span has no single surface to move — so each tool must say WHICH span it
has hold of, what happens to the spans above and below it, and what a merge or
a split does to the canonical form `setColumn` enforces.

---

## Part I — the decisions

Seven decisions, each with the alternatives rejected. The steps in Part II
implement exactly these.

### D1. A stroke addresses a span by NAMING A BAND, never by index

**The rule.** `SculptIntent` grows one optional field, `spanBand?: number` —
the terrace band at which the stroke has hold of the column. The server
resolves band → span **from its own heightmap**, through one shared function
`spanIndexCoveringBand(map, x, y, band)`, which returns the index of the span
covering that band or `null`. `null` makes the whole stroke a no-op.
**Absent `spanBand` means the topmost span**, which is what every intent in
existence means today and what every plugin `WorldApi.sculpt` call means.

This is the exact precedent `targetBand` already set (protocol.ts: "THE ONE
PIECE OF LEVEL INFORMATION A CLIENT MAY SEND, and it is not a height"), and it
is safe for the same reason: the number names a place in the world the player
aimed at, the server re-derives what is actually there, and a forged value
names no span and moves nothing. `spanBand` is a *grasp*; `targetBand` is a
*destination*; a drag on a layered column carries both, and they are not
interchangeable.

The client derives it from the pick with the derivation that already exists in
`client/src/world.ts` (`highlightLayerEdge`): a riser hit takes
`round(hitY / (HEIGHT_WORLD_SCALE · BAND_HEIGHT))`; a tread or underside hit
takes the band of the face it met. `TerrainRayPick.spanIndex` stays what it is
— a client-local convenience for the hover overlay — and **never goes on the
wire**.

*Rejected: send `TerrainRayPick.spanIndex` itself.* It is a position in a list
whose length is server state. One carve by another player between the pick and
the apply shifts every index above it, so the same message means a different
span on each replica — a determinism break that no amount of validation
catches, because every index in range is structurally valid. It also hands a
hostile client "sculpt span 0" — bedrock, under a mountain, sight unseen.

*Rejected: send the span's floor/ceiling.* Literally sending heights, which
§3.2 forbids outright. It also needs an exact-match test against the server's
column, which fails on any legal drift (a neighbour's stroke merged the span),
turning ordinary concurrency into silent no-ops.

*Rejected: send the ray (origin + direction) and let the server march it.* Puts
floats on the wire and a float march inside the authoritative path, against the
integer-only determinism contract (§3.3); costs a per-intent march at 10 Hz per
player; and makes the server responsible for a fact about the client's camera.

### D2. One primitive owns merge, split and canonical form

**The rule.** Two functions in `shared/src/columns.ts` are the ONLY code in the
repo that writes a column with more than one span:

- `moveSpanCeiling(map, x, y, k, newCeiling)` — moves span `k`'s ceiling, and
  nothing else in the column;
- `carveRange(map, x, y, lo, hi)` — removes the height range `[lo, hi)` from
  every span of the column.

Both re-canonicalise and both end in `setColumn`, so the ascending-with-a-gap
form is enforced in one place and cannot be half-enforced somewhere else. Every
tool below is expressed in terms of these two.

This is the contract-level answer to "what happens when two spans merge or one
splits": nothing in `heightmap.ts` ever needs to know, because nothing in
`heightmap.ts` ever writes a span list.

*Rejected: each tool canonicalises its own writes.* This is exactly the shape
that produced the three-callsite bug `forEachFootprintOffset` was extracted to
kill ("These were three verbatim copies of one loop; one function is what makes
'they agree' a fact rather than a comment"). Four tools × merge + split is
eight chances to disagree about a rule `setColumn` will throw on.

*Rejected: let `setColumn` itself canonicalise (accept overlapping spans and
fix them up).* It would turn a loud, immediate `RangeError` — the thing that
makes step 1's invariant checkable rather than hoped for — into a silent
repair, and two replicas that disagree about a column would then quietly agree
about its repaired form instead of diverging visibly.

### D3. Merge is absorptive; a gap the renderer cannot draw does not exist

**Merge.** When `moveSpanCeiling` raises span `k`'s ceiling to or past span
`k+1`'s floor, the two become the single span `[floor_k, ceiling_{k+1})` — the
raised ceiling is **discarded in favour of the upper span's**. Filling under a
roof cannot push the roof up. Cascades: repeat while the merged span swallows
the next one, so filling a thin gap between three spans merges all three in one
call.

**The visibility rule, which is what actually decides when a merge happens.**
A gap is kept only if the renderer draws air in it. `columns.ts` already states
the two halves of that: a span's cap is `spanCapHeight`, its underside is
`spanUndersideHeight` (one band below its lowest filled band). So the gap
between spans `k` and `k+1` is drawn iff

```
spanUndersideHeight(span[k+1]) > spanCapHeight(span[k])
```

which becomes a named predicate `isGapDrawn(lower, upper)`, the mirror of the
existing `isSpanDrawn(span)`. `moveSpanCeiling` **closes any gap that fails
it**, and `carveRange` **refuses to open one**. No magic number: the threshold
is derived from `BAND_HEIGHT` through the two functions that already define
what a span looks like drawn.

*Assumption (unverified):* that inequality is my reading of
`spanUndersideHeight`/`spanCapHeight`, not something the code states in those
terms. Confirm it by carving a one-band gap into the arch fixture's mound and
checking that nothing appears — before wiring the predicate into anything.

**Split.** Only `carveRange` splits. Lowering a ceiling can shrink a span to
nothing but can never divide one, so there is exactly one source of new spans
in the world, which is what makes "where did this column come from" answerable.

**No invisible solid, no invisible air.** A carve that would leave a sliver
thinner than a band (`!isSpanDrawn`) extends its cut to consume the sliver
instead. The player would otherwise be left with material that renders as
nothing and — because the picking march already gates on `isSpanDrawn` — cannot
be clicked either: terrain you can see through and cannot touch.

*Rejected: keep sub-band slivers as real material.* Honest to the arithmetic,
dishonest to the player: `heightAt` would report solid where nothing is drawn,
so a walker would stand on air and a pick would fall through.

*Rejected: snap gaps closed at a fixed number of world units (e.g. "gaps under
32 units close").* A magic number that silently decouples from `BAND_HEIGHT`,
which has already been re-terraced once (64 → 16, cited in picking.ts). The
derived predicate follows a re-terrace for free.

### D4. What each tool means on a layered column

The governing rule, stated once and true of all four: **a sculpt moves exactly
one span, and every other span in the column is left byte-untouched.** That
sentence is the whole point of the model — the owner's #99 report was that
pulling one layer dragged the layers below out with it, and this is the
sentence that makes that impossible rather than merely unlikely.

**`stamp`** (both profiles). Moves the CEILING of the grabbed span; its floor
never moves.
- Raising: the ceiling rises by the profile's delta, clamped by the anchor
  exactly as today, and additionally clamped by the floor of the span above —
  reaching it merges (D3).
- Lowering: the ceiling falls, clamped at the span's own floor. A non-bottom
  span whose ceiling reaches its floor is **removed**, and its gap joins the gap
  below it. The bottom span's floor is `BEDROCK_FLOOR`, so lowering it digs
  toward the bottom of the world exactly as today.
- On a one-span column every clause above is a no-op, so stamping ordinary
  ground is byte-identical to today. That identity is the step's verification.
- On an UNDERSIDE hit (`hitRiser === false` and `hitY < surfaceY` — the player
  is pointing at a cave roof from below), a raise is **refused**: there is no
  gesture in this game that means "add material to the bottom of a roof". A
  lower on an underside is a carve, and belongs to the carve tool (D6).

**`smooth`.** The brush pass is the stamp's, above. The relaxation pass needs a
notion of "the neighbouring cell's height" that a layered column does not have,
and the answer is a **layer-consistent neighbour**: for each 4-neighbour, the
span resolved by `spanIndexCoveringBand` at the grabbed span's cap band. Two
new rules:
- **Open-neighbour exclusion.** A neighbour with no span at that band is
  *excluded from the relaxation*, not treated as a height. Treating open air as
  a height (sea level, `OPEN_COLUMN_SAMPLE`, anything) makes an artificial cliff
  that relaxation then tries to fill, which is relaxation inventing terrain over
  a void — the same failure mode as the pyramid bug that clause 2 of
  `pushLowerLayers` exists to stop.
- Every relaxation write goes through `moveSpanCeiling`, so a slump that closes
  a gap merges by the same rule an explicit stroke does.
- Consequence, stated plainly: an overhang lip does not slump into the opening
  under it. That is correct — MAX_STEP is a statement about walkable ground, and
  the air under a ledge is not walkable ground.

**`drag`** (Pull). Unchanged in spirit: it moves how far one band extends, never
which bands exist. Two changes:
- The receiving span is the one whose gap contains `targetBand`, resolved by
  `spanIndexCoveringBand` against the *gap*, not the material. Filling toward
  the target may weld the terrace to the span above (merge). **That is
  allowed**: the player is putting material there, and a terrace grown until it
  reaches the roof is a sealed cave, not a deleted one. A drag can never remove
  a roof.
- `canSpreadBandTo` becomes span-aware (D5).

**`carve`** — new (D6).

*Rejected: a sculpt moves the whole column (all spans shift together).* It is
today's behaviour, it is #99, and the owner has already reported it as wrong.

*Rejected: a raise moves the grabbed span's FLOOR down rather than its ceiling
up.* Both are "more material", and floor-down is what you want when thickening
a roof from beneath. Rejected because a gesture must have one meaning: raising
would then mean "up" on a tread and "down" on an underside, and the pick is
view-dependent (`hitRiser`'s own doc says so), so the same click would mean
opposite things from two camera angles.

### D5. The anti-cheat rule: `columnCoversBand`, not `cells[n] >= threshold`

`canSpreadBandTo` — "the whole anti-cheat story", survivor of three Pull
rebuilds — asks whether any of the eight neighbours stands at or above
`band · BAND_HEIGHT`, reading `map.cells` directly. Its span-aware equivalent
is the same eight-neighbour walk with the test replaced by the function step 2
already wrote for the mesh:

```
columnCoversBand(map, nx, ny, band)   // "is this cell SOLID at band k?"
```

This is **strictly tighter than today's test, which is the safe direction to
move**: a neighbour whose topmost ceiling is above the band but which is hollow
at that band (a cave passes under it) satisfies `cells[n] >= threshold` and
should not — the material is not there at that level, so a terrace has nothing
to creep out of. On a world of one-span columns the two tests are identical by
construction (`columnCoversBand` on a one-span column is exactly
`cells[i] >= threshold`), so ordinary play does not change.

Everything the existing rule buys is preserved verbatim: the band can only
creep outward from ground already at it, one cell per intent; a forged
`targetBand` on an unrelated cell is a no-op; each intent stands alone.

`pushLowerLayers` gets the same substitution, and its `treadWasNear` clause
(`bandOf(heightBefore(i)) === band`) becomes "the span covering `band` has its
cap AT `band`" — a step at that level, exactly as the comment already says it
means to ask.

*Rejected: keep the height test and accept the cave case.* It is a way to grow
terrain out of a roof's shadow — the one exploit shape this rule exists to
forbid — and it would be discovered by a player before it was discovered by us.

*Rejected: a new, looser rule for layered columns only.* Two spread rules is
two anti-cheat stories, and the second one gets less scrutiny by construction.

### D6. Carve: yes, build it, and build it LAST

**Decision: yes.** Without it nothing a player can do will ever produce a second
span, so every rule in D2–D5 is unreachable, unverifiable and unseen — and this
project verifies by eyes-on, not by tests. The only layered terrain in existence
today is `archFixture.ts`, which is client-only, non-authoritative and gated
behind `?arch=1` by its own header. Carve is what makes step 4 a feature rather
than a refactor.

**The tool.** A fourth member of `SculptTool`: `'carve'`. It removes material;
it never adds. Direction is always "lower" — a carve intent with `dir: 1` is
rejected by the validator, not silently reinterpreted (the same argument
protocol.ts already makes for rejecting an unknown tool outright).

**What it removes.** For every cell of the brush footprint, the range
`[spanBand · BAND_HEIGHT, (spanBand + CARVE_BANDS_PER_STROKE) · BAND_HEIGHT)`,
through `carveRange`.

`CARVE_BANDS_PER_STROKE`: the smallest count for which the first stroke through
a roof leaves a gap that `isGapDrawn` keeps — which by the underside rule
(`spanUndersideHeight` = one band below the lowest filled band) is **2**, not 1:
a one-band hole puts the roof's underside at the same Y as the floor's cap and
draws nothing at all. Stated as *derived from `isGapDrawn`*, not chosen; the
constant's comment carries that derivation, and a re-terrace re-derives it.
*Assumption (unverified):* the value 2 follows from my reading in D3 — confirm
it with the same one-band experiment, and let the predicate, not the number, be
the authority if they disagree. (For contrast: the fixture's own
`TUNNEL_OPENING_BANDS` is 5, but that is what a *finished* tunnel needs to read
as an arch; repeated strokes deepen a carve.)

**The anti-cheat rule for carve — `canCarveBandAt`, the exact mirror of
`canSpreadBandTo`.** A cell may be carved at band `b` only if at least one of
its eight in-bounds neighbours is **open** at `b` (`!columnCoversBand`).
Off-map neighbours are absent, same as for material.

Air spreads exactly the way material does: one cell at a time, outward from air
that is already there, re-derived from the server's own map, so no message can
conjure a void where there is none. Concretely, a tunnel must start at a cliff
face — the low ground outside the cliff is open at the face's band, which admits
the face cell; carving it makes IT open, which admits the next cell inward on
the next intent. That is the same walk a drag does, and it is why a hostile
client cannot hollow the middle of a mountain in one click.

It has a property worth stating because it looks like a limitation and is not:
**on perfectly flat ground, carving the top band is refused** (every neighbour
covers it), and that is exactly the case where plain lowering is the right tool.
Carve is refused precisely where it is redundant.

**Pricing.** `sculptDisplacementUnits` must price a carve — footprint cells ×
bands removed × `BAND_HEIGHT` — or carve is the one free tool in a game whose
flagship plugin charges mana for the others. In scope for step 4 (see P7).

*Rejected: no carve tool; sculpt only what the fixture authored.* Leaves step 4
with nothing observable to verify, and leaves "the thing that would actually let
a player build the arch" — the owner's stated point of the whole arc — unbuilt
after four steps.

*Rejected: carve as a modifier on the existing lower gesture (shift-lower digs
under the surface).* Overloads a gesture that already has two modifiers, and
makes "did I just lower the hill or tunnel into it" depend on invisible state.
The HUD already carries a tool selector; a fourth tool costs one button.

*Rejected: carve a whole tunnel per stroke (sweep the ray through the mound).*
It is one message that removes hundreds of cells of material with a single
adjacency check, which is the shape of every exploit the drag's per-cell rule
exists to prevent, and it cannot be predicted client-side against terrain the
client may not hold.

### D7. The wire: a sparse side-channel, mirroring the storage exactly

**`ChunkPayload`** grows one optional field:

```ts
interface ChunkPayload {
  cx: number; cy: number;
  heights: number[];              // unchanged: CHUNK_SIZE² topmost ceilings
  layered?: {
    at: number[];                 // in-chunk cell offsets, ASCENDING
    runs: number[];               // per entry: [spanCount, f0, c0, f1, c1, …]
  };
}
```

**`CellDiff`** grows one optional field, `spans?: number[]` (the same flattened
`[f0, c0, …]`), and `h` keeps meaning the topmost ceiling. So a diff for a
one-span cell is byte-identical to today's, and every existing consumer of a
diff — the prediction store's value test, plugins' `onTerrainChanged`, the
mirror's `applyTerrainDiff` — keeps working untouched.

**The rule that makes it correct, and it is load-bearing: ABSENT MEANS ONE
SPAN.** A cell in a diff without `spans`, and a cell in a chunk not listed in
`layered.at`, is the one-span column `[BEDROCK_FLOOR, h)` — so the receiver must
*delete* any side-table entry it holds for that cell. This is already the stated
meaning of `resetColumns` for bulk height writes ("a payload that carries one
height per cell defines a column completely, so any span list it lands on is
stale"), extended to the diff. Without it, a carve that later re-merges a column
back to one span would leave the client's side table holding the split forever.

**Cost.** Zero bytes for a chunk with no layered column — the field is absent —
which keeps the "the 99% case pays nothing" decision from step 1 true on the
wire as well as in memory. A layered column costs `1 + 1 + 2·spanCount` numbers.
*Estimate, unverified:* the fixture's mound is roughly 800 layered columns of
two spans each ≈ 4,800 numbers ≈ 10 KB of JSON across its chunks, against a
chunk payload that already carries `CHUNK_SIZE²` heights. Confirm by logging the
serialised size of a snapshot with the fixture authored server-side (step 2's
verification does exactly this anyway).

**Persistence is not optional and not separable.** `World.heightsForPersistence`
calls `assertSingleSpanWorld(this.map, 'snapshot')` (world.ts:1915). **The first
carve that lands makes the next snapshot THROW** — not degrade, throw — so the
snapshot format carries spans in the same step as the wire, or step 4 ships a
server that dies minutes after the feature is used. Likewise `restore`
(world.ts:1660) calls `clearColumns` because a restore point carries heights
only; once it carries spans, it must restore them.

**Prediction.** Two fixes, both required:
- `createPredictionStore`'s `base` is an `Int16Array` of heights. `rendered.set(base)`
  therefore rolls back heights and leaves span lists standing. The base must be
  a **complete column state**: the Int16Array plus a snapshot of the span side
  table, restored together. Cost is a Map copy per reconciliation, sized by the
  number of layered columns — zero until someone carves.
- `isConfirmed` compares heights, and two different span lists can share a
  topmost ceiling, so value-confirmation can produce a FALSE POSITIVE on a
  layered column — retiring a prediction whose span structure the server never
  applied. Fix: value-confirmation **refuses to confirm any prediction that
  touched a layered column**, falling through to `resolveSeq` (the ack) or the
  deadline. That is the module's own stated principle — "zero evidence must not
  read as agreement" — and the ack has been the primary path since issue #21.

*Rejected: make `heights` variable-length (`number[][]`).* Pays a JS array per
cell in every chunk in the world for a case that is empty 99.9% of the time;
destroys the `heights.length === CHUNK_SIZE²` structural check that today
catches a truncated payload; and rewrites `applyChunkHeights` and the mirror for
terrain almost nobody has.

*Rejected: a second message carrying the layered columns after the chunk.* Two
messages for one chunk means a window in which the client has drawn the chunk
flat, plus an ordering contract to enforce — and this codebase already has one
hard-won ordering contract (ack-after-diff, issue #21) whose doc explains what
it costs. One payload cannot tear.

---

## Part II — build order

Each step is independently verifiable and lands as its own commit. Verification
is `pnpm typecheck` plus eyes-on (project rule: no tests unless the owner asks).
Restart Vite after every edit — `/mnt/e` delivers no inotify events.

### Step 4.1 — the canonical primitives, with no callers

`shared/src/columns.ts` only: `isGapDrawn`, `spanIndexCoveringBand`,
`moveSpanCeiling`, `carveRange`, `canCarveBandAt`, and `canSpreadBandToSpan`
(the `columnCoversBand` form of `canSpreadBandTo`). Nothing else in the repo
changes; nothing calls them yet.

**Verify:** `pnpm typecheck`. The world and the `?arch=1` fixture render exactly
as at `d06fa44` — trivially, since nothing calls the new code. Before moving on,
run the D3 experiment by hand: edit the fixture's `TUNNEL_OPENING_BANDS` to 1 in
a scratch copy, look at it, and confirm the gap is invisible. That is what
licences `isGapDrawn` and the value of `CARVE_BANDS_PER_STROKE`.

### Step 4.2 — the wire, the diff, persistence and the prediction base

`ChunkPayload.layered`, `CellDiff.spans`, `extractChunkHeights`/
`applyChunkHeights`, the snapshot writer and `restore`, `mirror.applyTerrainDiff`,
and the prediction store's base + `isConfirmed` guard (all of D7). The two
`assertSingleSpanWorld` call sites come out **only** as the paths they guard
become genuinely able to carry a span.

**Verify:** `pnpm typecheck`, and then the strongest eyes-on available for free:
**move the arch fixture to the server**, authored once at world genesis behind
the existing dev flag, and delete nothing of it. Then —
1. join fresh: the arch arrives over the wire and renders as it does today;
2. restart the server: the arch comes back from SQLite;
3. join a second browser: it sees the same arch.
No tool has changed, so anything that moves on screen is a wire bug.

### Step 4.3 — span addressing end to end, with no behaviour change

`SculptIntent.spanBand`, its validation (integer, `MIN_BAND..MAX_BAND`, same
shape as `targetBand`), `sculptOptionsOf` carrying it into
`ResolvedSculptOptions`, the pipeline's re-derivation through
`spanIndexCoveringBand`, the client's derivation from the pick, and the same
resolution mirrored in prediction. Absent still means the topmost span, so no
tool behaves differently.

**Verify:** `pnpm typecheck`. Sculpt ordinary ground with every tool and profile
— stamp, smooth, drag, soft, hard — and see byte-identical behaviour. Sculpt the
arch's crest (topmost span) and see a normal stroke. A client sending a
`spanBand` naming a band with no span moves nothing.

### Step 4.4 — `stamp` on a chosen span (D4)

`applyBrush` and `applyLevelFillBrush` write through `moveSpanCeiling` against
the resolved span index instead of writing `map.cells[i]` directly. Underside
hits refuse a raise.

**Verify:** `pnpm typecheck`; ordinary ground unchanged. On the server-side
arch: stamp the tunnel FLOOR repeatedly and watch it rise, weld to the roof and
become one span — the arch closes and the column's side-table entry disappears.
Stamp the crest and watch the roof thicken upward without the floor moving.

### Step 4.5 — `drag` on a chosen span (D4, D5)

`canSpreadBandTo` → the `columnCoversBand` form; `pushLowerLayers`'s two tests
likewise; `applyDragRegion` resolving the receiving span from the gap.

**Verify:** `pnpm typecheck`; a drag on ordinary terrain is unchanged (the two
tests are identical on one-span columns). Then the #99 report itself, on ground
that can finally express it: grab the mound's rim beside a tunnel mouth and pull
— the tunnel floor does not come with it.

### Step 4.6 — `smooth` across a layered column (D4)

The layer-consistent neighbour and the open-neighbour exclusion in `smooth`,
writing through `moveSpanCeiling`.

**Verify:** `pnpm typecheck`; smoothing ordinary terrain is unchanged. Smooth
the ledge beside a tunnel mouth: it does not slump into the opening, and the
roof above is untouched.

### Step 4.7 — the `carve` tool (D6)

`SculptTool: 'carve'`, `CARVE_BANDS_PER_STROKE`, `canCarveBandAt`, the validator
rejecting `dir: 1`, the HUD button, the intent path, prediction, and
`sculptDisplacementUnits` pricing it.

**Verify:** `pnpm typecheck`; then the thing the whole arc is for — **carve an
arch by hand, in a live world, from a cliff face**, with no fixture involved.
It must persist across a restart and appear in a second browser. Screenshot at
several pitches, in light and shade, as step 3 did.

---

## Part III — what stays untouched, and what is punted

### `heightAt` is still the walkable surface

Nothing in this plan changes it, and the six-file blast radius stands. The
consumers relied on for that, named so the reliance is checkable: `rivers.ts`,
`traversal.ts`/`pathing.ts`, `steering.ts`, farmland and flora, boats, the water
and fog renderers, structures, the chart source, `brushPreview.ts`, and
`client/src/world.ts`'s `terrainHeightAt`. Every write in Part II goes through
`moveSpanCeiling`/`carveRange` → `setColumn`, which sets `cells[i]` to the
topmost ceiling by construction.

The one new situation: a carve UNDER the surface leaves `heightAt` unchanged
while the column is hollow. Rivers and paths keep routing over the roof, which
is right, and nothing can walk through the tunnel, which is the punt below.

### Punts, each with a decision

| # | Punt | In scope? | Why |
|---|---|---|---|
| P1 | Layered columns in the snapshot / restore | **YES** | The assertion at world.ts:1915 THROWS on the first snapshot after the first carve; this is a crash, not a missing feature. |
| P2 | The wire (`ChunkPayload`, `CellDiff`) | **YES** | Named as deferred in the steps 1–3 plan and it comes due here: no server-authored span can reach a client without it, so nothing in step 4 is observable. |
| P3 | Pricing a carve in `sculptDisplacementUnits` | **YES** | A free tool beside four charged ones is an exploit, not an omission. |
| P4 | Pathing/traversal through a cave | **NO** | `traversal.ts` is 2D; routing under a roof is a second pathfinder, and no walker needs to today. Already named in the steps 1–3 plan. |
| P5 | Water, fog and rivers inside a cave | **NO** | They take the topmost surface and that stays right for them; water in a cave is a fluid problem, not a sculpt problem. |
| P6 | Structures and flora on a ceiling or a cave floor | **NO** | Placement reads `heightAt`; a second placement surface is its own design pass, and nothing asks for it. |
| P7 | Un-merging (an undo that recovers two spans from one) | **NO** | Merging is destructive and honest about it; the carve tool re-opens what a merge closed, which is the same affordance a player already has for a lowered hill. |
| P8 | Plugin `WorldApi.sculpt` gaining span awareness | **NO** | Absent `spanBand` means the topmost span, so every plugin terraform keeps its exact meaning; a plugin that wants a span can pass one the day it wants one. |
| P9 | The reveal mask reacting to spans | **NO** | The mask works by omission — a chunk not sent is a chunk not sent, whatever a column holds. Unchanged by construction. |
| P10 | Keeping `?arch=1` as a client-side fixture | **NO** | Step 4.2 moves it server-side; two authoring paths for the same mound is two things to keep in agreement, and the client-only one becomes untestable the moment the wire can carry the real thing. |

### Assumptions, labelled

1. **Assumption:** `isGapDrawn` is `spanUndersideHeight(upper) > spanCapHeight(lower)`,
   and therefore `CARVE_BANDS_PER_STROKE` is 2. *Confirm:* the one-band-gap
   experiment in step 4.1, before either is wired to anything.
2. **Assumption:** `columnCoversBand` on a one-span column is exactly
   `cells[i] >= band · BAND_HEIGHT`, so D5's substitution changes nothing in an
   unlayered world. *Confirm:* read `columnCoversBand`'s span loop against
   `spanAt`'s one-span branch (it appears to hold: floor is `BEDROCK_FLOOR`,
   which is `MIN_HEIGHT`, so the `floor <= threshold` half is always true), then
   drag on ordinary terrain in step 4.5 and see no change.
3. **Assumption:** `TerrainRayPick.spanIndex` has no consumer that would need
   the wire — grep at 2026-08-24 found it referenced only in `sculptInput.ts`'s
   hover cache. *Confirm:* re-grep at step 4.3.
4. **Estimate, not a measurement:** the wire cost figures in D7. *Confirm:* log
   the serialised snapshot size in step 4.2.
5. **Assumption:** the prediction store's `base` is the only place authoritative
   terrain is shadowed client-side. *Confirm:* grep for `Int16Array` copies of
   `mirror.map.cells` at step 4.2.

### Issues

#129 (this work), #99 (the Pull tool, whose report started it), #110
(superseded by #129).
