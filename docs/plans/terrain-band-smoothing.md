# Derived-field smoothing and live comparison

Status: plain binomial implementation built, default off. On September 22 the owner explicitly removed feature protection. Typecheck, shared/client suites and actual GPU parity pass. Live sculpting acceptance remains unresolved; separate renderer reviews are complete.

## September 22 amendment — current specification

This amendment supersedes every feature-preservation requirement, radius-two
dependency, and 21×21 production input window in the original plan below.
The remaining original plan and implementation measurements are retained as
history, including the rejected protected behavior and its measured overhead.

- Shared and WGSL kernels now use a single 3×3 `[1,2,1]²/16` pass. No extrema,
  diagonal, or layered-feature guards remain. Missing-input fallback and world
  clamping remain. The three shared contract cases now verify plain averaging,
  exact arithmetic, immutable inputs, and streaming fallback.
- Mode is `raw | binomial`; persisted `protected-binomial` migrates to `binomial`.
- Filtered CPU/GPU inputs are 19×19; raw CPU input is restored to 18×18 and raw
  GPU input to 17×17. Input bounds, seam invalidation, band support bounds and
  owner search follow the smaller reach. No contour resolution increase occurs.
- GPU uploads/copies use the active mode's length. Resident slots/workgroup
  arrays still reserve the maximum 19×19 capacity, and the second workgroup
  barrier remains unconditional for WGSL uniformity validation.
- Existing worker contract coverage checks both input dimensions and seam,
  world-edge, missing-neighbor and cache agreement. No extra test suite added.
- Verification: workspace typecheck passes; shared 536 pass; client 786 pass,
  one skipped; actual CPU/WebGPU parity passes 80 chunks per mode across five
  fixtures. Historical unrelated mana/reveal failures and the empty temples
  suite remain documented below under the owner's commit exception.
- Protection cost results remain archived; they must not be represented as
  measurements of this revised pipeline. The protected kernel is retained only
  in the scratch investigation for historical comparisons.
- Three requested read-only reviews completed. Findings and remaining runtime
  uncertainties: `E:\Development\Projects\Terrace\docs\investigations\renderer-review-2026-09-22.md`.

## September 22 amendment — #504 absorbed

- Done: smoothed pick ownership and rebuild publication. Stamp/Hard/2.0 closes
  a smoothed pit as in raw mode. Record: `docs/decisions/band-smoothing.md`.
- Open: a height blur widens a 10-band cliff from 0.9 to 2.6 cells (shared-math
  check). Candidate: per-band field, heights clamped to ±1 band around each
  threshold, same kernel. Offline prototype built; owner visual review pending
  (`docs/decisions/band-smoothing.md`). Production port would touch
  `shared/src/drawnFieldFilter.ts`, `shared/src/drawnGround.ts`,
  `client/src/terrain/drawnSurface.ts`, `client/src/terrain/capEmission.ts`,
  `client/src/render/gpuMesher/terrainGpuInputs.ts`, `mesherWgsl.ts`.
- Open: a layered column in the one-cell halo puts the whole chunk on the
  layered path (`capEmission.ts`, GPU `ENTRY_LAYERED`).
- Open: CPU filter cost — nine closure reads per sample, per-sample receipt
  checks, a global cache cleared on every edit.
- Done: `client/test/terrainMeshes.test.ts` now asserts the chart survives a
  rebuild and each newer build is spliced.

## Original implementation and plan (superseded where amended above)
Prototype: `d4664f4e`; follow-up shape requirement: `ed67fc78`.
Tracker: https://github.com/Cujuju/Terrace/issues/503.
Design record: `E:\Development\Projects\Terrace\docs\decisions\band-smoothing.md`.

## Implementation record

The owner authorized implementation, controlled app runs, and minimal contract-level
regression tests. The first increment now implements the shared protected field,
CPU workers, the WGSL backend, ground queries, canonical-contour picking, streaming
invalidation, safe publication, and the persistent **Smooth terrain bands** setting.
The additional post-contour fairing experiment remains unbuilt.

Owner review follow-up: the CPU comparison URL prevented live toggling because
`surface=` overrode the setting permanently. That override now applies only until
an explicit settings change. The reported hole-closing/sculpting behavior still
needs reproduction with the affected brush and an off/on comparison. Idle frame
timings below do not establish acceptable sculpting latency or worst-case cost.
The affected brush is **Stamp, Hard, width 2.0**; the owner confirms that disabling
band smoothing restores expected brush behavior. Stage measurements now show
material overhead, especially in CPU meshing; see
`E:\Development\Projects\Terrace\docs\investigations\terrain-filter-overhead.md`.
This supersedes any inference that similar idle frame medians imply acceptable
sculpting performance. Protection is expensive but has not been proven to cause
the hole-closing failure.

Implementation refinements from measurement and inspection:

- Surface mode is captured in each arena's build-mirror view; each submitted job
  captures arena generation and chunk revision in its completion closure. Workers
  serialize the mode with the input window. GPU resident entries keep scale,
  world size and receipt mask immutable from count through emit. This avoids
  adding duplicate revision fields to every answer format.
- The client adapter keeps a bounded 32,768-sample cache per mirror, cleared on
  terrain revision or receipt changes. Unmanaged diagnostic mirrors bypass it.
  GPU unlayered samples are computed once per workgroup, reused across levels.
- Filtered picking intersects actual published riser segments and shared-field
  tread planes before assigning an original column owner. The earlier raw-column
  candidate heuristic selected nonexistent treads after contours moved. Underside
  selection retains the existing rules because layered-neighbour guards preserve
  those boundaries. Decorative line smoothing never changes picking segments.
- A dirty or unpublished chart is unavailable to ground/pick consumers. Geometry
  is written successfully before its chart and notifications are published.
- Raw top-box fallback is explicitly queried as its published representation.
- The settings show **Rebuilding terrain…** during a live surface switch. A DEV
  `surface=` URL selects the initial comparison mode without saving it; an explicit
  checkbox change takes control so that comparison URLs remain interactive.
- Existing stale full-object expectations in the sculpt defaults/HUD contract
  tests were brought up to date with the already-committed options. No sculpt
  behavior changed as part of this implementation.

Evidence collected so far:

- Shared production kernel versus independent reviewed prototype: **81,920 exact
  sample matches**, including signed bands, layered fields and world edges.
- Actual WebGPU geometry probe: all **80 chunks / five fixtures** pass its existing
  cap/wall area thresholds in both raw and protected modes. The run caught and
  fixed a filtered world-edge clamping mismatch. Raw geometry is unchanged by
  the reduced-denominator, overflow-safe GPU isoline arithmetic.
- Shared suite: **536 passing**. Final client suite: **786 passing, one existing skip**. Workspace typecheck passes.
- The complete workspace run also reports failures in unmodified mana and reveal
  tests, and the temples package's empty test suite (no tests found). These are outside the
  smoothing change; the full workspace command is not green. The owner explicitly
  authorized committing with these unrelated failures documented.
- Private app: both GPU and CPU worker modes render the protected field. GPU toggle rebuilds 400 received chunks, preserves the camera,
  persists the setting, and leaves original terrain data alone. An isolated CPU
  rapid-toggle run settled the last request with identical camera and sampled
  height hash; 400 chunks drained in about 11.2 seconds. A 30-ray live probe after the picking fix
  found 15 tread hits, all agreeing with the shared ground query.
- A follow-up GPU checkbox check queued 402 chunks and drained to zero while
  remaining on the GPU backend. Chunk 528 changed from 11,825 protected triangles
  to 11,643 raw triangles; its measured cap and wall areas changed as well.
- Live spot timing in the isolated Frostwick copy: raw median frame work about
  4.4 ms; protected about 4.5 ms after caching (about 13 ms before caching).
  These observations are not a controlled performance benchmark. A 400-chunk
  rebuild took approximately 13–15 seconds, so the setting is live but its
  transition is visibly incremental, not instantaneous.

Release acceptance is still subject to the owner's production visual review.
The exhaustive stress matrix below is a release checklist, not a claim that
all device-loss, adversarial topology, or edit-load scenarios have been exercised.

## 1. Outcome and scope

Add a persistent **Smooth terrain bands** checkbox. Off reproduces the current
terrain; on uses the demonstrated locally protected derived-field filter.
The same world, camera, stored heights, spans, and sculpt intent pipeline remain
in place. Switching does not reconnect, reload the world, or change saved terrain.
CPU rendering, GPU rendering, picking, and client ground queries must select
the same surface mode. The owner judges the resulting appearance in the app.

Assumption: the first production increment is the demonstrated protected filter
plus the live toggle. The additional bounded contour-smoothing pass is included
as a separate experiment in section 10; it is not part of the working demo and
must not be represented as already designed or implemented.

Root cause and contract change: sampled terrain retains small contour notches
under denser bilinear tracing; introduce one explicit derived-surface contract
that filters those samples and is used by every visual-surface consumer.

Settled requirements:

- Preserve one-cell terraces and small holes. Retain the prototype's ridge,
  channel, and diagonal controls. Any change to protection needs matched images.
- Preserve flat treads and vertical risers. Do not relax the stored world or
  alter what stamp, smooth, drag, or carve writes.
- Retain the broader outline while investigating residual high-frequency noise.
  A numerical displacement tolerance has not been approved.
- Respect deterministic shared math and the existing frame/mesh budgets.
- Do not substitute a cosmetic crease-line toggle for filled terrain changes.

The protected candidate is not a general topology-preserving filter. Broad
plateaus and necks outside its local guards can still move or change topology.
This limitation must remain visible in review and acceptance criteria.

## 2. Verified starting point and concurrency

The offline comparison has nine fixtures, five field variants, and production
four-subdivision versus dense 32-subdivision contours. Five small-feature
controls retain exactly their original contour vertices with local protection;
the layered slice retains its hole outline. Repeated outputs are byte-identical.
Complete interior 21×21 windows match whole-field calculation at 10,404 sample
positions. These observations do not establish streaming, live GPU parity,
underside closure, or frame cost.

Primary source inspected for this plan includes the shared field and band
contract, mirror dependencies, worker messages, CPU meshing, GPU resident windows
and count/emit, arena publication, world rebuilds, preferences, and picking.

At inspection, unrelated edits were present in:

- `E:\Development\Projects\Terrace\shared\src\drawnGround.ts`
- `E:\Development\Projects\Terrace\client\src\world.ts`
- `E:\Development\Projects\Terrace\client\src\plugins\host.ts`
- `E:\Development\Projects\Terrace\client\src\plugins\types.ts`
- `E:\Development\Projects\Terrace\plugins\flora\client\index.ts`
- `E:\Development\Projects\Terrace\scratch-smooth-lab.html`

They add `drawnSampleCellIndex` and dirty-chunk notifications used by flora
grounding, among other work. Preserve and integrate those changes. Re-read the
diffs when implementation starts; do not overwrite them or commit their work.
Do not create/switch the shared checkout's branch without instruction.

Those ground/flora changes were committed as `6f8adc70` while this plan was
being prepared. This is the final code baseline reviewed for the plan;
`scratch-smooth-lab.html` remains unrelated dirty work.

## 3. Decisions for the first implementation

### 3.1 Mode and ownership

Introduce `DrawnSurfaceMode = 'raw' | 'protected-binomial'` in shared code.
The shared API has explicit surface options, including access to available raw
samples; it does not read browser storage or a process-global setting.
Existing callers that omit options retain the raw behavior.

The preference is client-local. Shared means reusable deterministic math, not
that a browser checkbox must change server state. The inspected production
server/plugin sources contain no direct calls to `drawnBandAt`,
`drawnLayerCapAt`, or `drawnHeightAt`; current visual consumers are client-side.
Re-run that callsite audit during implementation. Any future shared query caller
selects its mode explicitly. No protocol, database, sculpt, or server simulation
change is planned for this visual comparison setting.

### 3.2 Exact field contract

Port the local-protection candidate from
`E:\Development\Projects\Terrace\scratch-band-investigation\protected-field.mjs`.

- One binomial pass: weights `[1,2,1]` in each axis, total weight 16.
- Compute each output from original samples only, in a fixed iteration order.
- Retain integer numerator `N`; do not round `N / 16` back into an integer height.
  Query band conversion must scale both the shore offset and band divisor by
  16 as well as the field numerator; avoid a second or missing band bias.
- On mode: original raw sample `h` is represented as `16*h` wherever protected.
  The contour threshold is `16*(drawnLevelThreshold(band) - bias) + bias` for
  the existing extractor's bias convention. Centralize this conversion.
- Off mode: retain the existing unscaled code path, thresholds, rounding,
  simplification, and geometry output. Do not change the baseline while adding
  the comparison.
- Use the prototype's thin-sample, ambiguous-square, and layered-column guards.
  Compute all guard decisions from original per-band samples and actual column
  metadata, not an already-filtered top height.
- Keep band-clamp-only and local-protection-plus-clamp as diagnostic alternatives;
  they are not extra production settings. They suppress substantially more of
  the preferred appearance and band clamping alone can nearly erase a feature.

Name constants for kernel weights, denominator, raw read radius, and window
dimensions. The raw read radius is two samples, derived from the guard's
neighbor-of-neighbor dependency. A 16-square chunk needs 17 output samples per
axis and 21 input samples per axis. Keep output-lattice and input-window strides
separate. Do not replace every existing `17` with `21`.

### 3.3 Missing neighbors and world edges

One global-coordinate policy must serve workers, GPU input extraction, and
interactive queries:

1. Clamp actual world-edge coordinates as today.
2. Check actual receipt/availability before filtering. Do not average default
   map values or worker data left over from a previous request.
3. If the full radius-two neighborhood is available, evaluate the protected
   filter. Otherwise return the original render sample, scaled by 16.
4. The raw fallback retains the existing `renderSampleCell` seam pullback.
   The fallback decision belongs to a global sample coordinate, not a chunk.
5. A chunk arrival changes both data and availability. Rebuild all received
   chunks whose output samples depend on the arrival, including east/south and
   diagonals, not only today's west/north neighbors.

The neighboring 3×3 chunk receipt mask can cover this two-sample halo because
the radius is smaller than a chunk. Verify border clipping and all nine bits.
This policy preserves visibility at unlock boundaries, but may temporarily
reduce smoothing there. Include arrival transitions in visual review.

### 3.4 Layered columns and bounds

Use `columnSampleAtBand` for the requested band, including its open-column
sentinel. Never smooth only top heights and reuse them for buried bands.
Keep the binary underside-cap path unchanged. The layer guard restores all
corners of squares touching layered columns; verify those original boundaries
meet their existing underside caps in full geometry.

The current two-corner-per-axis `anyCellLayered`/`lowestDrawnBandNear` shortcuts
must inspect the entire influence footprint when smoothing is on. Four output
corners each depend on radius two: at most a 6×6 raw footprint for one square.
Any top-only fast path needs proof that none of those inputs is layered.

Do not assume a filtered per-band field is always bounded by the filtered top
field: band-dependent guards may select different raw/filtered values. Bound
level search conservatively by raw top maxima and relevant span floors over
the full footprint. Use the same conservative bounds in CPU planning, GPU
per-square iteration, GPU headers, and queries; tighten only after proof.
Separate candidate iteration bounds from physical lowest-cap/skirt metadata:
a low sample in the outer halo must not, by itself, create a new bottom cap
or change the skirt drop. Derive actual surface extrema from the output field
and applicable column floors, and verify exposed-chunk geometry explicitly.

### 3.5 Live switching and asynchronous builds

Reuse the existing mesher-settings rebuild lifecycle in `world.ts`, preserving
the mirror, prediction ledger, connection, and camera. First implementation
clears the old terrain/charts/overlays and repopulates them through the existing
budgeted scheduler. This avoids adjacent chunks displaying different modes.
It may briefly repopulate visibly; it is live switching, not a guaranteed
single-frame dissolve. Measure the transition before promising instant A/B.

Do not add a second full-world arena just to hide the transition in this first
increment: its peak residency and upload cost have not been budgeted.

Every build captures an immutable mode and surface epoch. Also capture a
per-chunk input revision that changes whenever any dependency is dirtied.
Carry those stamps through CPU requests/answers, queued GPU jobs, fallbacks,
and resident GPU entries. Reject stale answers before buffer writes, chart/lip
publication, and notifications; release retained GPU handles on every rejected
or cancelled path. A late null answer from a disposed epoch must not enqueue
new retries. Never read a mutable UI signal midway through a job.

Rapid toggling is last-choice-wins. Switching back to the current requested
mode is a no-op. Current-world replacement and GPU demotion invalidate the
relevant epochs too. Queued GPU work must retain its requested mode even when
input extraction happens later than the initial `build` call.

Received data is not the same as drawn, current geometry. During rebuilding,
ground queries return unavailable for unpublished chunks and terrain picks
must not strike them. Cancel/reset an active sculpt gesture at a mode switch
so its captured pick does not continue on another surface; do not discard
already-sent intents or the prediction ledger. Camera motion stays available.
Publish readiness only after a successful geometry write, then notify overlays,
rivers, and grounding consumers with the affected chunk set.

### 3.6 GPU implementation and arithmetic

First GPU design: upload the complete 21×21 raw window, column descriptors,
availability, and the captured mode. Evaluate the same protected filter in WGSL
for each requested band. Shared TypeScript owns the executable reference and
constants; the shader translation requires explicit parity verification and
must not introduce an independently tuned algorithm.

This avoids a CPU-generated field buffer for every band of every chunk.
CPU-precomputed filtered fields are a measured optimization alternative if the
shader's guard cost is too high; do not silently switch architecture mid-port.

The input buffers need 441 rather than 289 lattice entries. Recompute offsets,
workgroup arrays/loading, span descriptor references, upload ranges, and storage
limits from constants. Keep 16×16 square dispatch and current contour resolution.
Include halo span pairs in capacity accounting; existing over-budget CPU
fallback must receive the same mode, raw neighborhood, and availability.

For scaled samples, the present `isolineUnits` multiplication by 65536 can
overflow i32. Interpolate fixed-axis endpoints in coordinate units of 1024
instead: cancelling the common factor of 64 leaves the same quotient, while
the restoring division still produces the existing 65536-unit solve result.
Preserve floor/ceil conventions for inside/outside endpoint directions.

For raw range [-1559,1024] and scale 16, endpoint differences are bounded by
42,319,872 and doubled restoring remainders by 84,639,744, within signed i32.
The corresponding conservative CPU bilinear product is below 2^53. These
are partial bounds, not a complete port proof. Check every intermediate:
thresholds, bias, sums, negative floor division, saddle decisions, span reads,
packing, and the scale-dependent steep-edge threshold. Ceilings remain in
their separate unscaled binary convention.

Retain four contour subdivisions and `MAX_POLYLINE = 16`. The enumerated
four-subdivision polygon maximum is 12. Re-enumerate with the final emission
rules; never increase subdivisions without updating every associated capacity
and proving that no truncating guard drops geometry.

## 4. File-by-file implementation map

Paths below are absolute. New files are explicitly marked. Conditional edits
are listed separately so this does not authorize unrelated refactoring.

### Shared surface contract

| File | Required change |
|---|---|
| `E:\Development\Projects\Terrace\shared\src\drawnFieldFilter.ts` **new** | Define mode/options, named kernel and footprint constants, pure integer filter/guards, numerator/threshold conversion, conservative support bounds. No browser state or map writes. |
| `E:\Development\Projects\Terrace\shared\src\drawnGround.ts` | Accept explicit surface context; evaluate filtered corner numerators without height rounding; widen layered/band bounds; preserve raw defaults and the in-flight coordinate helper. Centralize support enumeration for queries and picking. |
| `E:\Development\Projects\Terrace\shared\src\index.ts` | Export the shared contract and types. |

Keep `E:\Development\Projects\Terrace\shared\src\bands.ts`, stored-height and
span formats, and sculpt/protocol modules unchanged unless the arithmetic audit
demonstrates a necessary contract extension. No schema migration is planned.

### Availability, dependencies, CPU meshing, workers

| File | Required change |
|---|---|
| `E:\Development\Projects\Terrace\client\src\terrain\drawnSurface.ts` **new** | Client adapter owning explicit mode/epoch, availability-aware sample access, and shared-kernel calls. Supply the same context to meshing and queries. If profiling requires a cache, key it by mode, input revision, sample coordinate, and band; invalidate using the same dependency function. |
| `E:\Development\Projects\Terrace\client\src\terrain\mirror.ts` | Keep raw storage methods; add mode-aware dependency enumeration and the global missing-neighbor policy. Expand edit and chunk-arrival invalidation; preserve raw-mode seam behavior. |
| `E:\Development\Projects\Terrace\client\src\terrain\predictionLedger.ts` | Route prediction, reconciliation, rollback, and expiry dirty sets through the expanded dependency enumeration. Verify no separate brush-radius-only invalidator bypasses it. |
| `E:\Development\Projects\Terrace\client\src\terrain\contours.ts` | Allow an explicit field scale/context for thresholds and crossings while keeping raw output identical. Reuse current marching and simplification; separate input-halo dimensions from output-lattice dimensions. |
| `E:\Development\Projects\Terrace\client\src\terrain\capEmission.ts` | Plan from conservative filtered-support band bounds; load the correct per-band field; use one contour for caps/risers/lips. Preserve binary underside processing. Reload actual raw samples for existing blocky fallback. |
| `E:\Development\Projects\Terrace\client\src\terrain\chunkJob.ts` | Widen the request window symmetrically to the required halo; carry mode/epoch/input revision and availability; restore them into a bounded worker context. Echo stamps in the answer. Prevent reads outside the copied window. |
| `E:\Development\Projects\Terrace\client\src\render\chunkBuildSource.ts` | Add captured surface build context to the source interface, direct path, worker queue, and CPU fallback. |
| `E:\Development\Projects\Terrace\client\src\render\chunkBuildWorker.ts` | Build using the request's mode and stamps, never stale workspace configuration; clear/reload span and receipt state per job. |
| `E:\Development\Projects\Terrace\client\src\terrain\drawnGroundStore.ts` | Track publication mode/revision and current readiness; pass context to diagnostic `publishPlannedChunk`/`publishPlannedWorld`; invalidate stale charts and polygon caches. |
| `E:\Development\Projects\Terrace\client\src\terrain\capPlanFlat.ts` | Propagate field/mode metadata where needed by consumers; keep physical band IDs, cap heights, and canonical query thresholds distinct from scaled extractor thresholds. |

### GPU and publication lifecycle

| File | Required change |
|---|---|
| `E:\Development\Projects\Terrace\client\src\render\gpuMesher\terrainGpuInputs.ts` | Distinct 21×21 input layout, actual availability/layer metadata, mode header, correct conservative band bounds, widened span accounting and checked overflow fallback. |
| `E:\Development\Projects\Terrace\client\src\render\gpuMesher\mesherWgsl.ts` | Load halo inputs; implement shared filter/guard semantics; scale thresholds consistently; fix endpoint arithmetic as above; update per-square band bounds. Count and emit use identical inputs and mode. |
| `E:\Development\Projects\Terrace\client\src\render\gpuMesher\gpuChunkBuildSource.ts` | Capture mode/revisions at enqueue, upload expanded layout, retain input/mode immutably through count→emit, pass context into every fallback, release stale resident entries. |
| `E:\Development\Projects\Terrace\client\src\render\gpuMesher\gpuChunkAnswer.ts` | Carry surface epoch/input revision alongside generation; preserve the emit handle's idempotent release contract. |
| `E:\Development\Projects\Terrace\client\src\render\terrainMeshes.ts` | Capture/check mode and input revisions at submit, receive, and splice. Make successful geometry write precede chart publication and `onChunkDrawn`. Guard disposed/null-result retries. Keep ordinary edit splices within existing budgets. |
| `E:\Development\Projects\Terrace\client\src\render\arenaStore.ts` | Audit write/release success contract; change only if needed to expose a successful publication result consistently. |
| `E:\Development\Projects\Terrace\client\src\render\gpuMesher\gpuArenaStore.ts` | Audit emit failure and stale-handle behavior; preserve packed format and ensure failed writes cannot publish current charts. Changes conditional on the publication audit. |

### Queries, picking, overlays, and dependents

| File | Required change |
|---|---|
| `E:\Development\Projects\Terrace\client\src\terrain\drawnGround.ts` | Bind queries to the explicit surface context and current chart epoch; preserve integer-cell-center versus fractional-coordinate semantics. |
| `E:\Development\Projects\Terrace\client\src\terrain\picking.ts` | Pass surface context/readiness through ray and pinned-column paths; reject unpublished chunks and stale comparison picks. |
| `E:\Development\Projects\Terrace\client\src\terrain\pick\types.ts` | Define typed query/readiness context additions without importing settings into low-level math. |
| `E:\Development\Projects\Terrace\client\src\terrain\pick\bandOwner.ts` | Use the selected derived field for `drawnCapMet`; find legal raw-span owners over actual contributing support, not the fixed eight-neighbor list. Derive candidate coordinates from shared support and retain deterministic tie order. |
| `E:\Development\Projects\Terrace\client\src\terrain\pick\cellHit.ts` | Thread context into hit/owner resolution; ensure a filtered extension maps to a real editable raw span rather than inventing coverage. Preserve underside semantics. |
| `E:\Development\Projects\Terrace\client\src\terrain\pick\drawnFaceRefine.ts` | Refine against authoritative emitted boundaries for the same mode/revision, including layer-specific heights. |
| `E:\Development\Projects\Terrace\client\src\render\layerEdgeOverlay.ts` | Rebuild from new lips/charts; query the selected field where draping is needed. Keep canonical segments used for picking separate from optional cosmetic line smoothing; current `smoothedFlat` must not change collision boundaries. Preserve crease color/opacity/depth behavior. |
| `E:\Development\Projects\Terrace\client\src\world.ts` | Own active surface context; integrate settings rebuild, epoch/revision and readiness gates, prediction dependencies, ground-query support, and affected-chunk notifications. Preserve the concurrent `drawnSampleCellIndex` and dirty-set changes. |

Audit, with edits only if the shared refresh contract does not cover them:

- `E:\Development\Projects\Terrace\client\src\render\water.ts`: sea remains
  occluded by actual land caps; no new independently reconstructed shore mask.
- `E:\Development\Projects\Terrace\client\src\render\riverRig.ts`: force
  visual ground refresh after switching; keep hydrology based on raw terrain.
- `E:\Development\Projects\Terrace\client\src\plugins\host.ts` and
  `E:\Development\Projects\Terrace\client\src\plugins\types.ts`: preserve
  in-flight dirty-set notification work and expose the same readiness behavior.
- `E:\Development\Projects\Terrace\client\src\plugins\kit\groundFollow.ts`
  and `E:\Development\Projects\Terrace\plugins\flora\client\groundChanges.ts`:
  verify revision-based invalidation reaches already-placed objects. Do not
  patch individual species or props to compensate for a missed central event.
- `E:\Development\Projects\Terrace\client\src\terrain\pick\rayMarch.ts`:
  retain ray coordinates and traversal; add a readiness hook only if the
  higher-level picker cannot enforce the gate at every visited square.
- `E:\Development\Projects\Terrace\client\src\terrain\pickBand.ts`: verify
  resolved intents still name valid original spans; do not redefine sculpt bands.

### Settings, comparison instrumentation, documentation

| File | Required change |
|---|---|
| `E:\Development\Projects\Terrace\client\src\state\terrainSurfacePrefs.ts` **new** | Persistent boolean backed by `persistedChoice`; named storage key `terrace.smoothTerrainBands.v1`; default off for baseline review. Optional DEV-only URL pin for reproducible A/B must not overwrite saved choice. |
| `E:\Development\Projects\Terrace\client\src\state\controlPrefs.ts` | Reset the new preference alongside other terrain settings. |
| `E:\Development\Projects\Terrace\client\src\ui\ControlsPanel.tsx` | Add **Smooth terrain bands**, separate from **Smooth lines**. Explain it changes filled terrain. Show a brief rebuilding state if transition latency is visible; no kernel or GPU terminology in the product control. |
| `E:\Development\Projects\Terrace\client\src\main.tsx` | Wire the signal to a world setter, matching existing line-setting effects. Choose this single subscription point; do not also subscribe inside world. |
| `E:\Development\Projects\Terrace\client\src\input\sculptInput.ts` | Reset/cancel the active gesture on a surface-mode transition through the existing lifecycle, while leaving submitted predictions intact. |
| `E:\Development\Projects\Terrace\client\src\input\sculpt\lifecycle.ts` | Conditional adapter if the required cancellation operation is not already exposed. |
| `E:\Development\Projects\Terrace\client\src\perfProbe.ts` | Include mode, epoch, rebuild pending count, switch latency, mesher/fallback path, and relevant workload timing in captures. |
| `E:\Development\Projects\Terrace\client\src\render\gpuMesher\mesherDump.ts` | Record captured mode, halo receipt, revisions, and layout metadata so parity dumps are reproducible. |
| `E:\Development\Projects\Terrace\scratch-band-investigation\build-protected-data.mjs` | Import the production shared filter after porting; compare its output with the archived prototype rather than maintaining two independent kernels. |
| `E:\Development\Projects\Terrace\scratch-band-investigation\protected-field.mjs` | Retire duplicated math in favor of a shared-kernel adapter after parity is established; preserve history and archived geometry. |
| `E:\Development\Projects\Terrace\docs\DESIGN.md` | Update implementation/review status only when it changes; preserve standing rules. |
| `E:\Development\Projects\Terrace\docs\decisions\band-smoothing.md` | Record chosen contract, observed tradeoffs, owner visual decision, validation, and remaining limitations. |
| `E:\Development\Projects\Terrace\docs\plans\terrain-band-smoothing.md` | Keep phase status, scope, and unresolved decisions current. |

## 5. Implementation order and completion gates

| Phase | Work | Exit evidence |
|---|---|---|
| 0. Baseline | Re-read concurrent edits; preserve archived fixtures and current off-mode output. Audit actual query callers and existing verification harnesses. | Exact baseline/source hashes and accepted fixture definitions; unrelated work isolated. |
| 1. Shared contract | Port pure integer filter, options, support enumeration, availability fallback, and conservative bounds. Adapt the offline builder to it. | Prototype parity, input immutability, small-feature retention, complete-window and missing-neighbor behavior. |
| 2. CPU end-to-end | Add mirror dependencies, worker context/window, CPU cap planning, queries and legal picking owners. Keep control hidden until all paths agree. | CPU geometry/query/pick agreement, ceilings and coastline checks, raw-mode output unchanged. |
| 3. Build lifecycle | Add epoch/input-revision stamps, stale-result handling, successful-publication ordering, and readiness gates. | Delayed jobs, rapid switches, edits during rebuild, null/emit failures and disposal produce no stale chart or geometry publication. |
| 4. GPU parity | Extend resident input layout; port integer kernel/guards and scaled solve; update bounds/count/emit/fallback. | Exact sample/mask parity; contour differences bounded only by defined CPU/GPU quantization; no count/emit overflow or leaked entries. |
| 5. Live control | Add/reset preference, world rebuild integration, gesture cancellation, dependent refresh, and instrumentation. | Off→on→off retains terrain hash, camera and connection; settings persistence works; no picks on missing geometry. |
| 6. Visual/performance review | Same-camera production comparisons, both meshers, editing/unlock stress, and owner's high-frequency-noise review. | Owner appearance judgment plus measured steady frame cost, edit cost, switch latency and memory. |
| 7. Close filter increment | Resolve failures, retain default off until review supports a default change, update records and commit exact paths. | All authorized required checks pass; no claim that residual-noise smoothing is implemented. |
| 8. Residual-noise experiment | Follow section 10 independently on top of the approved filter baseline. | Matched visuals and explicit geometry/query feasibility before any production expansion. |

Commit completed coherent increments promptly. Shared-code commits require
`pnpm typecheck` and `pnpm test` to pass, per repository instructions. Attribute
unrelated failures against the current working-tree state instead of rewriting
other agents' files.

## 6. Validation files and cases

New or modified tests require explicit permission for the implementation
session. This plan specifies them; it does not write or authorize them.

| File | Contract coverage |
|---|---|
| `E:\Development\Projects\Terrace\shared\test\drawnFieldFilter.test.ts` **new, permission required** | Deterministic integers, negative bands/sentinel, no mutation, one-pass behavior, guards, support bounds, threshold conversion and field/query agreement. |
| `E:\Development\Projects\Terrace\client\test\drawnGround.test.ts` | Raw/default equivalence; selected-mode fractional/cell-center queries; layered search; unavailable/readiness states. |
| `E:\Development\Projects\Terrace\client\test\mirror.test.ts` | Every edge/corner edit, radius-two dirty readers, arrival-order permutations, world edges and raw fallback. |
| `E:\Development\Projects\Terrace\client\test\prediction.test.ts` and `E:\Development\Projects\Terrace\client\test\predictionGhost.test.ts` | Predicted edits, authoritative echo, rollback, denial and expiry invalidate the same derived consumers. |
| `E:\Development\Projects\Terrace\client\test\vertexGrid.test.ts` | CPU caps/risers/undersides, raw fallback, expanded level ranges, area/feature preservation and existing budgets. |
| `E:\Development\Projects\Terrace\client\test\gpuSpanWindow.test.ts` | Expanded halo layout, receipt state, descriptor offsets, span capacity fallback and mode capture. |
| `E:\Development\Projects\Terrace\client\test\mesherWgslContract.test.ts` | Shared filter constants and scaled arithmetic contract in generated WGSL; supplement source checks with executed GPU comparisons. |
| `E:\Development\Projects\Terrace\client\test\terrainMeshes.test.ts` | Stale generation/revision rejection, rapid switches, late null answers, release semantics, publication after successful writes. |
| `E:\Development\Projects\Terrace\client\test\pickAgreesWithMesh.test.ts` and `E:\Development\Projects\Terrace\client\test\pickContract.test.ts` | Filtered extension owners, cap/riser/underside strikes, chunk borders, unpublished chunks, and cosmetic-line independence. |
| `E:\Development\Projects\Terrace\client\test\worldReset.test.ts` | Setting switch preserves mirror/camera/predictions; world reset and device demotion invalidate old work; current callbacks see affected chunks. |
| `E:\Development\Projects\Terrace\client\test\controlPrefs.test.ts` | Default off, persistence, reset, and malformed stored value handling. |

Extend the existing harnesses, with implementation-session permission:

- `E:\Development\Projects\Terrace\client\test\mesherParityProbe.ts` and
  `E:\Development\Projects\Terrace\client\test\support\mesherFixtures.ts`:
  archived controls and raw/protected mode runs, including quantitative
  geometry checks rather than vertex-count equality across different tessellations.
- `E:\Development\Projects\Terrace\client\scripts\mesherParity.mjs`:
  propagate the selected surface mode into reproducible captures and report it.
- `E:\Development\Projects\Terrace\client\scripts\drawnGroundParity.mjs`:
  extend visual-ground/query comparisons to both modes.
- `E:\Development\Projects\Terrace\client\scripts\mesherHarness.mjs`:
  conditional mode/config plumbing shared by those scripts. Its existing
  server/browser lifecycle means running it requires current-turn app permission.

Do not invent a second renderer harness. Browser screenshots alone do not prove
geometry parity, and static WGSL string assertions do not prove executed math.

Mandatory situations:

- Stamp and stamp-then-smooth, all visible bands, especially the lowest ring.
- Terrace, hole, ridge, channel, diagonal saddle, coast, valley, and full
  overhang with underside; controls on and across chunk boundaries.
- Exhaustive single-square masks and representative threshold equalities.
  Preserve the existing ambiguous-square baseline for this change. The known
  mean-versus-bilinear saddle defect is separate; do not silently fix it here.
- Unreceived halo, each arrival direction/order, clamped world corners, and a
  worker reused after a different chunk/window. No default/stale sample leakage.
- Toggle while jobs are queued, while count has completed but emit has not,
  during editing, during GPU fallback/device loss, and before any world is loaded.
- Off and on clients can view the same authoritative world without transmitting
  heights or changing protocol validity. The clicked raw owner must remain legal.
- All-feature guards checked at original coordinates. A nonzero component count
  alone is insufficient: the clamp-only nearly invisible terrace is a negative
  control for that mistake.

## 7. Performance and release acceptance

Use a fixed world/snapshot, recorded camera, revealed chunk set, mesher/backend,
and identical stroke sequence. Warm existing materials/pipelines before comparing
steady behavior. Record distributions, not one best frame: frame time, CPU
meshing, GPU count/emit, input upload, main-thread splice, query cost, pending
queue drain, peak resident memory, triangle/lip counts, and fallback frequency.

The standing target is at least 140 fps on the owner's machine (about 7.14 ms
per frame). Compare off and on at idle and during the same edits. Report setting
transition duration separately; remeshing every received chunk has a different
cost from a local brush edit. No numerical switch-latency promise is made yet.

Keep the existing scheduler budgets and capacities initially. Optimize only
measured regressions: reuse non-layered filtered samples across band levels,
cache pure sample/guard results by input revision, or evaluate CPU-precomputed
inputs versus shader recomputation. Any optimization must preserve the same
field and archived comparisons. Do not trade away small features to meet a timer.

App start/stop requires permission in the implementation turn. Existing offline
results are not substitutes for the required live parity and performance evidence.

## 8. Alternatives and explicit scope decisions

| Choice | Decision and reason |
|---|---|
| Denser tracing alone | Not the smoothing implementation: it retains the low-band noise and increases geometry. Keep as a diagnostic reference. |
| Bezier rounding of original contours | Not the first production algorithm: the owner preferred filtering, and rounding each existing corner retains the wiggle pattern. |
| Full unprotected filter | Reference only: erases the isolated terrace and fills the hole. |
| Global band clamp | Reference only: nearly collapses small controls and suppresses much of the preferred smoothing. |
| Stronger/repeated field blur | Not a default extension: the current filter already changes footprint area, conflicting with the newer shape-retention priority. |
| Top-height-only smoothing on layered terrain | Rejected: cannot represent buried bands and can diverge from openings/undersides. |
| Cosmetic-only settings toggle | Rejected: it does not change filled caps/risers and cannot answer the requested visual comparison. |
| CPU-only production rollout | Development milestone only; finish GPU and all fallback parity before calling the live setting complete. |
| Separate full-world staging arena | Not in the first increment; use the existing rebuild lifecycle and measure its transition before adding unbudgeted duplicate residency. |
| Fix the independent saddle decider | Separate change, not a hidden dependency; the prototype preserves the existing decision. If a verified failure makes it necessary, isolate the fix and refresh reference images. |
| Stored-terrain smoothing, new server protocol, migration | Excluded: the requested work changes the derived visual surface. |
| Ship post-contour smoothing now | No: its shared-query and GPU-locality contracts are not established; section 10 defines the experiment. |

## 9. Acceptance and rollback

The filter increment is complete only when the live toggle works on CPU and
GPU, raw mode retains its baseline, protected controls survive geometrically,
queries/picking/grounding agree, stale jobs cannot publish, and the owner has
reviewed actual production appearance. General topology preservation and an
unchanged footprint are not claimed by the current local candidate.

Off is the user-visible rollback, with the same rebuild/readiness lifecycle.
Existing CPU fallback remains available for GPU limits/failure and must preserve
the selected filter. If filtered geometry exceeds the established CPU budget,
retain the existing explicit blocky fallback and report it in diagnostics;
never silently truncate or relabel raw geometry as filtered. The established
blocky-query behavior requires an explicit parity audit before release: publish
the actual representation in the chart; route ground queries and picking to
raw column boxes/levels for that representation, rather than evaluating the
filtered field over a blocky mesh. Check boundaries against neighboring smooth
chunks. This is a central representation rule, not a per-plugin workaround.

If phase 6 shows unacceptable shape movement or small-feature changes, return
to the prototype with matched images. Do not quietly retune the filter, enlarge
its reach, or switch defaults without updating the design and comparison.

## 10. Follow-on experiment: residual high-frequency contour noise

This work goes **after** the derived-field filter and contour extraction.
Its reference outline is the selected filtered contour, not a newly relaxed
heightmap. It must not silently change the filter kernel to make its result look
better. Original/raw and filter-only remain visible as references.

First deliverable: extend the offline comparison, using these files:

- `E:\Development\Projects\Terrace\scratch-band-investigation\contour-fairing.mjs`
  **new experimental module**: resample loops by arc length; apply one symmetric
  distance-based averaging pass from immutable input positions; bound movement
  relative to the input polyline; preserve protected neighborhoods and reject
  self-intersections, changed winding/nesting, and cross-band crossings.
- `E:\Development\Projects\Terrace\scratch-band-investigation\build-protected-data.mjs`:
  produce filter-only and filter-plus-fairing geometry from identical inputs;
  retain unrounded measurement coordinates and name all trial parameters.
- `E:\Development\Projects\Terrace\scratch-band-investigation\comparison-template.html`
  and `E:\Development\Projects\Terrace\scratch-band-investigation\build-protected-comparison.mjs`:
  matched views, especially lowest-band close-ups, with the trial identified.
- `E:\Development\Projects\Terrace\docs\decisions\band-smoothing.md`: record
  selected visual tolerance and whether this actually improves the appearance.

Before selecting trial values, measure the residual wiggle spacing in cell
units; choose an averaging support around that observed scale and derive
resampling density from it. The movement limit is total displacement from the
reference, never a per-iteration allowance that accumulates. Report movement
in both directions between curves, area change, minimum separation, feature
survival, and high-frequency turning. These are diagnostics; the owner selects
acceptable appearance and displacement.

Do not put an independent post-process into only CPU loops or crease lines.
Production feasibility must first settle all three of these:

1. CPU chunk loops and GPU per-square polygons need identical shared boundaries
   and seam continuation. Arbitrary whole-loop smoothing is not locally
   equivalent to the present GPU extractor.
2. The resulting boundary must have a deterministic shared query definition;
   existing bilinear `drawnBandAt` cannot remain authoritative after contours
   move independently. Stored per-chunk curves would also require a deliberate
   replacement for GPU plans that currently contain no polygon coordinates.
3. Quantization, protected transitions, inter-band spacing, capacity and cost
   must survive the curve representation, including any subsequent spline fit.

If the offline experiment succeeds, revise sections 3–7 with the selected curve
representation and exact production file changes before implementation. Until
then, the first toggle controls only the demonstrated derived-field filter.

## Pre-Check checklist

| Item | Assessment |
|---|---|
| Magic numbers | Kernel/scale/reach follow the prototype; lattice dimensions and arithmetic bounds are derived; no unapproved curve tolerance is invented. |
| Duplication / contract | Shared deterministic surface context drives clients and worker/reference math; WGSL is a verified backend translation. |
| Symptom versus cause | Raw sampled-field variation survives denser extraction; the plan changes the field consumed by the visual surface. |
| Primary-source verification | Current query, mirror, mesher, worker, queue, settings, and publication code were inspected, including concurrent edits. |
| Broader pattern | Bounds, availability, revisions, picking, overlays, grounded objects and GPU fallback are included. |
| Alternatives | Section 8 records rejected/deferred choices and their concrete tradeoffs. |
| Explicit limits | Topology limits, visible rebuild transition, independent saddle defect and unbuilt curve smoothing are named. |
| Defaults reasoned | Default off preserves baseline comparison; production contour density and existing budgets remain unchanged pending measurements. |
| Contract verification | Section 6 specifies field/parity/seam/lifecycle contracts and names tests; implementation-session test permission remains required. |
| One-sentence framing | One selected derived-field contract replaces inconsistent independent surface evaluation while filtering reproduced contour noise. |
