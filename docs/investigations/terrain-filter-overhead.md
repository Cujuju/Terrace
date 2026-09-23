# Terrain filter overhead measurements

Measured September 21, 2026 (local time), after owner review reported that Stamp,
Hard, width 2.0 fails to close small holes with band smoothing enabled and works
with it disabled. This report measures cost; it does not establish the cause of
that interaction regression. Implementation remains uncommitted and unaccepted.

## Results

All values below are median milliseconds. Raw and protected modes receive
identical cloned terrain and the same hard stamp, radius four cells (HUD width
2.0). The authoritative edit changes the same number of cells in both modes.

| Interior stamp fixture | CPU workers: off | CPU workers: on | GPU build/completion: off | GPU build/completion: on |
|---|---:|---:|---:|---:|
| Genesis noise | 4.1 | 4.7 | 11.5 | 13.0 |
| Terrace | 1.4 | 9.1 | 10.0 | 14.5 |
| Played stress fixture | 8.6 | 46.5 | 10.8 | 23.8 |

The terrace CPU build is approximately 6.5 times baseline; the played stress
fixture is 5.4 times baseline. These increases are material despite earlier
similar idle frame medians. The played fixture has saturated heights and is a
stress case, not a representative live-world latency estimate.

Near a chunk boundary in the noise fixture, the same 32 changed cells require
one raw chunk but two protected chunks. Worker completion increases from 3.7 to
5.4 ms; GPU build/completion increases from 11.0 to 14.5 ms. The expanded filter
dependency region can add work even when the brush changes identical cells.

## September 22 follow-up: plain binomial pipeline

Feature protection has now been removed. A fresh run of the same isolated
Stamp/Hard/2.0 harness produced these median interior single-chunk build times:

| Fixture | CPU raw | CPU binomial | GPU raw | GPU binomial |
|---|---:|---:|---:|---:|
| Genesis noise | 5.0 ms | 4.3 ms | 12.4 ms | 10.9 ms |
| Terrace | 1.5 ms | 4.0 ms | 11.9 ms | 13.0 ms |
| Played stress fixture | 10.8 ms | 26.0 ms | 12.7 ms | 17.9 ms |

Raw and filtered were interleaved with four warm-up pairs and ten measured
pairs. Full per-case data (including seams and skipped no-op stamps) is in
`E:\Development\Projects\Terrace\scratch-band-investigation\binomial-overhead-results.json`.
CPU includes worker round trip; GPU includes extraction, count/readback, emit
and queue wait. This is not frame time or complete brush latency. Reduced noise
geometry can offset filtering work. Other fixtures still incur substantial
cost, particularly layered played terrain.

These results use the reduced windows and plain kernel. Earlier protected
results below/above remain historical: no direct simultaneous protected/plain
pipeline A/B was run, so their difference is not a precise speedup attribution.
The current diagnostic's microkernel section retains the historical protected
reference and bare averaging loop; only its CPU/GPU pipeline uses the revised
production filter (including missing-input checks).

## Historical cost of protection separately from averaging

Uncached evaluation of 16,384 top-field samples, using the same raw source:

| Fixture | Basic binomial | Protected binomial | Ratio | Otherwise changed samples restored to raw |
|---|---:|---:|---:|---:|
| Genesis noise | 1.9 ms | 16.2 ms | 8.5x | 95.7% |
| Terrace | 2.4 ms | 21.9 ms | 9.1x | 19.6% |
| Played | 2.4 ms | 19.5 ms | 8.1x | 43.1% |

The protected path includes its larger source stencil, availability checks,
layer checks, extrema checks, and diagonal checks. This comparison isolates that
combined overhead from the basic nine-sample averaging kernel; it does not
attribute the cost to one individual guard. These are uncached sample costs,
not per-frame costs: the production adapter caches unchanged samples.

The protection rules substantially suppress smoothing on some inputs. They are
therefore a plausible contributor to unexpected appearance. These measurements
do not prove they cause the reported inability to close a hole.

## Method and limits

- Reproducible manual harness:
  `E:\Development\Projects\Terrace\client\preview-filter-overhead.html` and
  `E:\Development\Projects\Terrace\scratch-band-investigation\measure-filter-overhead.mjs`.
- Full raw samples and per-case metadata:
  `E:\Development\Projects\Terrace\scratch-band-investigation\filter-overhead-results.json`.
- Chrome 153 on this Windows machine; isolated one-pixel WebGPU renderer, no
  game plugins or scene rendering in the measured page.
- CPU and GPU: four warm-up pairs followed by ten measured pairs per fixture
  and location. Mode order alternates. Interior, near-seam, and seam cases are
  recorded separately. A stamp that changes nothing is explicitly excluded.
- Kernel: two warm-up batches and nine measured batches, alternating order.
  Each batch traverses the fixture four times. Source reads use the production
  mirror adapter and protected evaluation uses the production shared function.
- CPU time includes request extraction, worker dispatch, meshing, and returned
  answer. GPU time includes extraction, count/readback, buffer allocation, emit,
  and queue completion. GPU results are wall time, not isolated shader time.
- Neither pipeline figure includes publishing to the live arena, brush picking,
  server round trip, plugin grounding, or final frame presentation. They cannot
  be interpreted as an FPS loss or complete pointer-to-display latency.
- The earlier small live-app spot measurements were under different load and
  are superseded for stage comparison by this isolated run.

## Interaction findings still unresolved

A simple isolated one-cell pit produced the same owners and hit bands with the
filter off and on, including oblique rays. That does not reproduce the owner's
stamp failure in their actual terrain. Dirty chunks are temporarily unavailable
for picking until replacement geometry is published; the greater dependency
area and rebuild time can extend this interruption. This is a candidate cause,
not a verified diagnosis. Full live stamp behavior remains an acceptance blocker.

The comparison URL had a separate confirmed usability defect: `surface=` pinned
the mode despite checkbox changes. It now selects only the initial mode, and an
explicit settings change takes control. The settings also show rebuilding status.

## Session cleanup

At the owner's request, the controlled review client and server, the active
`run_server.py` game stack, and this task's automation Chrome/Playwright processes
were shut down after measurement. The active game server received Ctrl-Break for
its graceful shutdown path. Existing Windows port-forwarding listeners were left
configured; they are operating-system services, not running Terrace processes.
