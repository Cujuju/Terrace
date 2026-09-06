# Brief: riser picks resolve against the DRAWN face, not the box face

Owner report 2026-09-04 (carve tool): "at some camera angles carve does not
work at all" and "it is moving my mouse pointer to different bands — carve
needs to operate on the band I am specifically pointing at."

## Rules of evidence
- Comments are claims. Every fact you rely on is verified at file:line THIS
  session and cited in your report. Comment-sourced findings do not count.
- Do not touch `shared/`. Do not touch `docs/`. Do not add tests (owner
  permission for tests is per-session and was NOT granted this session).
- Existing tests must keep passing: `cd client && timeout 240 npx vitest run`.
  `pnpm typecheck` must pass. Never run the whole-workspace test command.
- Label every assumption as such. Report failures faithfully.

## Root cause (verified by the orchestrator, reproduce it yourself first)
`client/src/terrain/picking.ts:terrainHitInCell` intersects the ray with the
per-cell BOX column: a riser hit is the ray entering cell (i,j)'s box through
a side face at height `entryY`. But `client/src/terrain/capEmission.ts`
draws every riser on the marching-squares contour of that band, and for a
quantised step that contour lies 0.375 cells INSIDE the higher cell's box
(probe: `chunkBandContourLoops` on a straight wall between cells 23 and 24
returns x = 23.875; the box face is at 23.5). So a ray aimed at the visible
face crosses the box face earlier and higher — by 0.375·tan(pitch) bands.
Probe result (90 aims at the drawn face of a 3-band cliff, 6 pitches × 3
azimuths): 25 resolve to a band one or two above the one under the mouse;
above ~70° the ray lands on the top TREAD. The crosshair
(`render/brushPreview.ts` draws it at `hitX/hitY/hitZ`) then floats in front
of and above the visible face, the lit lip is the wrong band, and the carve
cuts the wrong band. Pull has the same defect.

Orchestrator's probe: `/tmp/claude-1000/-mnt-e-Development-Projects-Terrace/cf7a64ed-d157-4d50-8d37-253896979a49/scratchpad/carveProbe.test.ts`
(run from `client/` with `npx vitest run --dir <that dir>`; it writes
`probe.txt` beside itself). Copy it into your worktree's own scratch
location if the scratchpad is gone; it is 100 lines.

## The contract you are implementing
A riser pick names the band of the DRAWN face the ray meets, and its hit
point lies ON that drawn face. One derivation, used by every consumer of a
`TerrainRayPick` (hover cache, lip highlight, crosshair, pull grab, carve).

### 1. New pure module `client/src/terrain/drawnFace.ts`
`intersectRayWithWall(origin, direction, ax, az, bx, bz, yLo, yHi): number | null`
— parametric t (≥ 0) where the ray meets the vertical quad standing on the
world-space segment (ax,az)→(bx,bz) between heights yLo and yHi; null if it
misses. Ray parallel to the wall plane → null. Pure, no Three.

### 2. `client/src/terrain/picking.ts`
Add an optional provider to `pickTerrainCellByRay`, `pickTerrainInColumn`
and `pickPointedCellByRay`, threaded into `terrainHitInCell`:
```
export interface DrawnRisers {
  /** World-space flat [ax, az, bx, bz, ...] segments of band's lip in this chunk, or undefined. */
  segmentsOf(chunkIdx: number, band: number): Float32Array | undefined;
}
```
`null` provider ⇒ today's box behaviour, byte-identical (this is what every
existing test exercises; they must not change).

In `terrainHitInCell`, AFTER the existing loop has chosen the best span hit,
if that hit is a riser (`insideOnEntry`) and the provider is non-null,
refine:
- bands to test: `bandOf(spanUndersideHeight(span)) + 1` … `bandOf(spanCapHeight(span))`
  of the struck span (same range `pickBand.ts:resolvePick` uses).
- chunks to search: the 3×3 chunk neighbourhood of (i,j) — same rule as
  `layerEdgeOverlay.ts:nearbyChunks`. Do NOT filter segments by cell; the
  t-window does that.
- for every segment of every candidate band, `t = intersectRayWithWall(...,
  yLo=(band-1)*BAND_HEIGHT*HEIGHT_WORLD_SCALE, yHi=band*BAND_HEIGHT*HEIGHT_WORLD_SCALE)`,
  keep the smallest t with `tEnter ≤ t ≤ tExit` (the box chord — a drawn face
  inside this box is the only one this cell can own).
- struck: replace the hit's `hitY/hitX/hitZ` with the point at that t.
  `spanIndex`, `surfaceY`, `hitRiser=true`, `x`, `y` unchanged. `resolvePick`
  will name the band from `hitY` via `Math.ceil` — verify that a hit exactly
  on the quad's lower edge (`hitY === yLo`) names `band-1`; guard it by
  nudging nothing: instead compute the band from the segment you struck and
  assert it equals `resolvePick`'s answer in your probe; if they can differ,
  say so in the report with the exact condition (owner decides).
- none struck: the ray passes in FRONT of every drawn face inside this box,
  so visually it lands on the drawn tread of the cell it came from (the
  lower neighbour's tread extends 0.375 cells into this box). Resolve it as
  a TREAD hit of that neighbour: the entry side is whichever box face the
  entry point (scaled space) lies on — x-face ⇒ neighbour (i∓1, j), z-face ⇒
  (i, j∓1) — pick the neighbour's highest DRAWN span whose cap `capN <
  entryY`; `tP = tEnter + (capN - entryY)/dy` (requires `dy < 0`); if
  `tP ≤ tExit` return `{x: ni, y: nj, surfaceY: capN, spanIndex: kN,
  hitRiser: false, hitY: capN, hitX/hitZ at tP}`. Otherwise (origin inside
  the box so `tEnter === 0`, `dy ≥ 0`, neighbour off-world or unrevealed, or
  the plane crossing is beyond the box) keep the box riser hit unchanged.
  Cite `mirror.ts` for how you test "revealed".
- The refinement runs for the ONE cell that produced the hit, so it costs a
  few hundred quad tests per pick at most. Say what it measured.

`pickPointedCellByRay` (plugin clicks) gets the same provider so a click on
the drawn lower tread in front of a wall names the lower cell. Its
`distance` must use the refined point.

### 3. Provider wiring
`client/src/render/layerEdgeOverlay.ts` already holds exactly these segments:
`segmentsByChunk: Map<chunkIdx, Map<band, Float32Array>>` filled in
`rebuild` from `chart.lips` (world space; `lipNear` measures them against
`GRAB_RADIUS_WORLD_UNITS`). Expose `segmentsOf(chunkIdx, band)` on the
`LayerEdgeOverlay` interface returning that subarray. Verify at file:line that
the flat layout is `[ax, az, bx, bz]` per segment and that it is world
space, not cell space.

`client/src/world.ts`: `pickCell` (~1037) and the `pickInColumn` dependency
main.tsx wires (~216) pass `layerEdges` (null before the overlay exists).
Check every caller of the three picking functions (`grep -rn
"pickTerrainCellByRay\|pickTerrainInColumn\|pickPointedCellByRay" client
plugins`) and thread the provider through each production path; tests keep
passing null.

Unreceived, frontier-adjacent, blocky, or not-yet-drawn chunks have no
segments (`rebuild` returns early) ⇒ box behaviour there. State this as the
residual in your report.

### 4. Nothing else changes
`pickBand.ts`, `sculptInput.ts`, `brushPreview.ts`, the overlay's
`lipNear`/`lightBand` are untouched: they consume the pick and are fixed by
the pick being right. If you find you need to change one, stop and say why
in the report before doing it.

## Verify before you report
1. Orchestrator's probe, extended: pass a `DrawnRisers` built from
   `chunkBandContourLoops` (the probe already builds those segments) and
   show `carveWrongBand` go 25 → 0 and `carveNull` stay 0 across the same
   90 aims; add 4 aims below the wall foot (aim band 4.9 and 5.1 at pitches
   45 and 75) and show they resolve as a tread of cell 23 (band 5) at a point
   inside cell 24's box. Paste the summary lines.
2. `cd client && timeout 240 npx vitest run` — counts before/after. `pnpm
   typecheck`.
3. EYES-ON, mandatory. Start your own stack from YOUR worktree, owner
   permission granted this turn: copy `.agent-stack/boats-verify/launch.sh`
   and `stop.sh` to `.agent-stack/carve-verify/` and point `WT` at your
   worktree; ports 2599/5199 are free (verified 21:55); world =
   `better-sqlite3` `db.backup()` copy of `.agent-stack/worlds/hollows-of-witherspire.db`
   into `.agent-stack/carve-verify/worlds/` with its id in `.active`
   (`WORLDS=` override). `DB_PATH` at a nonexistent file. `WORLD_SIZE=512`.
   Vite on /mnt/e does not watch files: restart Vite after every client
   edit. Kill by port-owner pid in a script FILE, never an inline `pkill -f`.
   Screenshots: raw CDP against a playwright-cached Chromium, pattern in
   `/mnt/e/Development/Projects/Terrace/.claude/worktrees/boats-pathing/client/.shoot-boats.mjs`
   (camera via `window.__terrace.viewport`; page load under swiftshader takes
   1–3 min). Select the Carve tool, find a cliff of ≥2 bands, put the pointer
   on the visible face's LOWER band at pitches ~30°, ~55°, ~75°, and capture
   BEFORE (main) and AFTER (your branch) with the crosshair and lit lip
   visible. Then press once and capture the cut. Look at every image
   yourself: the crosshair must sit on the visible face at the band under the
   pointer, the lit lip must be that band, the cut must open that band.
   Save images under `.agent-stack/carve-verify/shots/` and list their paths.
   Tear the stack down when done.
4. Commit on your worktree branch (conventional commit, no attribution
   trailers), then `ExitWorktree` with `action: "keep"`. Do not merge.

## Report
Root cause in one sentence; the diff summary; probe numbers before/after;
test counts; typecheck result; screenshot paths with what each shows; the
residuals (chunks without segments; the `hitY === yLo` edge if real; the
still-mouse pinned-cell fallback in `sculptInput.ts:hoverTarget`, which is
out of this brief's scope — note only whether the drawn-face hit changed its
behaviour); every assumption labelled.
