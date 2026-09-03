# Issue #301 — why a mudslide eats a plateau's top instead of its rim

READ-ONLY diagnosis, 2026-09-02. Every claim below cites the line that does it.
Constants evaluated from `shared/src/constants.ts` (`WORLD_UNIT_CELLS = 4`,
`MAX_STEP = 4`, `RELAX_SLACK = 1`, `BAND_HEIGHT = 16`):
`MUDSLIDE_SLOPE_SPAN_CELLS = 8`, `MUDSLIDE_MAX_DROP_OVER_SPAN = 40`,
`MUDSLIDE_TRIGGER_DROP = 20`, `MUDSLIDE_BRUSH_RADIUS_CELLS = 6`,
`MUDSLIDE_MAX_PATH_CELLS = 96`.

## 1. Root cause (one sentence)

Steepness is qualified over an **8-cell span** while the excavation is applied at
the **sampled cell** with a 6-cell-radius brush, so every cell up to a span back
from a rim reads as "steep" and has its band cut out of the flat ground where it
stands rather than out of the face that made it steep.

## 2. Mechanism, (a)–(d)

### (a) Origin cell

- The survey draws `MUDSLIDE_SURVEY_SAMPLES = 64` **uniform** cells out of
  revealed chunks — `plugins/mudslides/server/slides.ts:583-586`. There is no
  edge/rim preference of any kind in the draw.
- A sample is admitted iff `slopeAt(world, x, y) !== null`
  (`slides.ts:588`). `slopeAt` is `plugins/mudslides/server/terrain.ts:174-202`:
  it takes `here = heightAt(x,y)` (`terrain.ts:180`) and, for each of the eight
  fixed bearings, reads the cell **8 cells away** (`terrain.ts:190-191`) and
  keeps the largest `here - heightAt(nx,ny)` (`terrain.ts:193-197`). It qualifies
  when that drop ≥ 20 (`terrain.ts:200`).
  **This is the defect's source: nothing between (x,y) and the sample 8 cells out
  is looked at.** A cell sitting 7 cells inside a plateau rim, on perfectly level
  tread, qualifies as long as one cell 8 out is 20 units (1.25 bands) lower.
- `slopeAt` also returns `dx, dy` (`terrain.ts:201`) and its own doc comment
  (`terrain.ts:164-167`) claims "the bearing that gives the drop is the bearing
  the mud will take, so finding it here saves the caller a second search."
  **Comment vs. code:** no caller reads `.dx`/`.dy` — all four callers
  (`slides.ts:588`, `slides.ts:605`, `slides.ts:747`, `dev.ts:181`) use only
  `=== null` or `.drop`. The one piece of span-scale direction the plugin
  computes is discarded.
- The trigger picks among saturated sites weighted by saturation
  (`slides.ts:687-703`, called at `slides.ts:724`) — again no geometry.
- `startSlide` re-tests `slopeAt` (`slides.ts:747`), requires the brush footprint
  revealed (`slides.ts:756`), requires a first downhill cell (`slides.ts:758-759`),
  and then **freezes the head at the sampled cell**: `headX: x, headY: y`,
  declared `readonly` (`slides.ts:396-397`, set at `slides.ts:769-770`).
- The dev fixture makes this worse, not better. `scanForSite` scores candidates by
  `dryRunLength` — **how far the mud would run**, steepness only as tie-break
  (`dev.ts:189`, `dev.ts:198`, rationale at `dev.ts:139-143`). A cell set back on a
  plateau top has a *longer* downhill run (top + face + apron) than a rim cell, so
  the forced-slide aid actively prefers the plateau top. It also scans on a
  4-cell grid (`DEV_SEARCH_STEP_CELLS = 4`, `server/src/plugins/kit/devSite.ts:58`,
  used at `dev.ts:177-178`), so it can miss a rim by up to 3 cells even when the
  rim would have scored best.

### (b) Which cells lose height, which gain it

- **Loss — always and only at the head.** `scourHead` sculpts at
  `slide.headX, slide.headY` (`slides.ts:803-809`), amount
  `-1 * BAND_HEIGHT = -16` (`slides.ts:802`), radius 6. Nothing ever moves the
  scour point. Three such steps (`MUDSLIDE_HEAD_SCOUR_STEPS = 3`,
  `slides.ts:247`, gated at `slides.ts:916-919`).
  So the removal set is a **~13-cell-wide disc centred on the uniformly-sampled
  cell** — on a plateau, a crater in the middle of the tread.
  **Comment vs. code:** `slides.ts:242-246` says the spread exists so "THE SCARP
  DEEPENS WHILE THE FRONT IS ALREADY RUNNING". The code deepens the *sample
  point*; that point is the scarp only by coincidence.
- **Gain — the front's own cell, then the toe.** Track veneer:
  `deposit(world, slide, slide.x, slide.y, carried * 0.15)` at `slides.ts:930`,
  i.e. **at whatever cell the front currently occupies**, which for the first
  several steps of a plateau slide is still the plateau top. Toe lobe: the last
  `MUDSLIDE_TOE_LOBE_CELLS = 4` path cells (`slides.ts:939-942`).
- Every height change goes through `sculptGuarded` (`terrain.ts:123-158`) — the
  single sculpt call site — which refuses unrevealed footprints (`terrain.ts:130`)
  and measures net displacement before/after (`terrain.ts:140-156`).

### (c) Per tick

`index.ts:207-215`: `surveySites` → `soakSites` → `rollTrigger` → `advanceSlides`.
Inside `advanceSlides` (`slides.ts:1002-1037`) each slide does
`advanceFront` (`slides.ts:1010`) then up to `MAX_STEPS_PER_TICK = 8` sculpt ops
on a 0.3 s cadence (`slides.ts:1017-1024`).
`advanceFront` (`slides.ts:880-912`) moves the front by
`FRONT_SPEED_CELLS_PER_SECOND` whole cells, each step taking `nextFlowCell`
(`slides.ts:899`). `nextFlowCell` (`terrain.ts:252-292`) is **one-cell strict
steepest descent** over the same eight fixed offsets (`terrain.ts:269-279`),
`basin` if no strictly-lower unvisited neighbour exists (`terrain.ts:281`).
`sculptStep` (`slides.ts:915-943`) is head-scour → track deposit → toe dump, in
that order.

### (d) Why that removes the top band instead of the rim

Three things compound:

1. **A span test with no local test.** `terrain.ts:190-197` only compares
   (x,y) against the ring at radius 8. On a plateau whose rim drops ≥ 20 units,
   the qualifying set is the whole **8-cell-wide annulus of flat top inside the
   rim**, plus the rim, plus the face. The top annulus is far larger in cell
   count than the rim itself, so a uniform survey draw (`slides.ts:583-586`) lands
   on the top the overwhelming majority of the time.
2. **The cut is applied at the measured point, not at the steep point.** The
   head is frozen at the sample (`slides.ts:769-770`) and every scour uses it
   (`slides.ts:803-809`). A 13-cell disc centred up to 7 cells inside the rim
   removes one band of tread and never touches the face.
3. **The first deposits land back on the top.** The front leaves the head one
   cell at a time down a nearly-level tread and drops 15 % of its load on each
   cell it occupies (`slides.ts:930`), so mud is *added* to the plateau top
   between the crater and the rim before anything reaches the edge.

Net visible result: a band-deep bite out of the plateau surface with a smear
behind it, and an untouched rim — exactly the owner's report.

## 3. Contract-level fixes

Invariants any of these must preserve: integer amounts only (`slides.ts:855-861`,
`WorldApi.sculpt` throws otherwise); fixed neighbour iteration order
(`terrain.ts:30-39`) and seeded RNG (`slides.ts:441`) so identical inputs give
identical outputs; ground moved **only** through `sculptGuarded`
(`terrain.ts:123`); `footprintUnlocked` re-checked at any new sculpt centre
(`slides.ts:756`); server-authoritative — `headX/headY` are on the wire
(`MudslideFlowEvent`, emitted `slides.ts:966-986`) and consumers (structures
demolition, chronicle) read them.

**A — Local-steepness site test (the contract fix).** Redefine "site" as *a cell
that is itself on a face*: qualify only when the cell's own steepest **one-cell**
neighbour drop is at least a fraction of the sim's maximum legal per-cell
gradient (`MAX_STEP + RELAX_SLACK = 5`), with the existing 8-cell span drop kept
as a secondary "there is relief below to run into" test. Because the head is the
qualifying cell, the cut then lands on the rim by construction — the measured
point and the cut point become the same point.
*Touches:* `slopeAt`'s contract (4 callers) + one new constant in `protocol.ts`.
*Size:* ~15 lines plus a re-measurement of the qualifying-cell density.
*Risk:* `MUDSLIDE_TRIGGER_STEEPNESS`'s measured "one unlocked cell in forty"
(`protocol.ts:147-153`) is invalidated; the frequency tiers must be re-measured or
slides become noticeably rarer on rolling terrain.

**B — Keep the site test, retarget the head.** At `startSlide`, walk downhill from
the sampled cell up to `MUDSLIDE_SLOPE_SPAN_CELLS` steps via `nextFlowCell` and
set the head to the cell with the largest single-cell drop to its successor — the
rim. *Touches:* one helper in `terrain.ts` + the head assignment
(`slides.ts:769-770`), plus a `footprintUnlocked` re-check at the relocated head.
*Size:* ~25 lines. *Risk:* the plateau top remains a "site", so the trigger rate
still counts flat ground as steep; and the relocated head can fall in fog, adding
a new silent-abort path.

**C — Scour follows the front.** Make the first N sculpt ops cut at
`slide.x, slide.y` instead of the head, so the scar runs from the sample point
over the rim. *Size:* ~10 lines in `sculptStep`/`scourHead`. *Risk:* highest —
`Slide.gain` is calibrated from the head scour and used to size every deposit
(`slides.ts:848-849`, consumed `slides.ts:861`); learning it across several
different grounds breaks the ledger, and a front that excavates on the run-out
digs into the valley floor it is supposed to be filling. It also makes
`headX/headY` in the flow event stop describing where the ground came from.

**Recommend A.** It is the only one that states the root cause as a contract —
*the cell that is measured is the cell that is cut* — so no future caller can
reintroduce the mismatch. B loses because it leaves the wrong definition of
"site" in place and merely patches the consequence, keeping flat ground in the
saturated-fraction that drives the arrival rate. C loses because it trades a
geometry bug for a mass-ledger bug.

## 4. In-world evidence that proves the fix

Forced slide on a known plateau (`MUDSLIDES_DEV_FORCE`), heights read through
`WorldApi.heightAt` before and after, along a **21-cell transect perpendicular to
the rim** (10 cells of top, the rim cell, 10 cells of face), plus the emitted
`mudslides:flow` event.

- *Before the fix, expected:* the most negative per-cell delta sits ≥4 cells
  **inside** the rim; the rim cell's delta is ≈0 or positive; `event.headX/headY`
  is that interior cell.
- *After the fix, required:* (1) `event.headX/headY` is the cell whose own
  one-cell downhill drop is maximal on the transect, i.e. the rim; (2) the most
  negative delta is at that cell ±1; (3) every transect cell more than
  `MUDSLIDE_BRUSH_RADIUS_CELLS` inside the rim has delta exactly 0; (4)
  `volumeMoved` is unchanged in order of magnitude, so the fix moved the scar
  rather than shrinking the slide.
- Determinism check alongside it: run the same seed twice and assert the flow
  event's `cells` arrays are byte-identical, so the new scan has not introduced
  order dependence.
