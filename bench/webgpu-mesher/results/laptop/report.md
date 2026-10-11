# Gate 1 — WebGPU terrace mesher

Verdict: **kill** — first failing criterion: band parity mismatches

Adapter: {"vendor":"apple","architecture":"metal-3","device":"","description":"","timestampQuery":true,"maxStorageBufferBindingSize":4294967292}
Timing method: timestamp-query

| criterion | measured | limit | |
|---|---|---|---|
| band parity mismatches | 158 | 0 | KILL |
| band parity holes | 0 | 0 | pass |
| isoline port mismatches | 0 | 0 | pass |
| pixel mismatch fraction | 0.002298148148148148 | 0.001 | KILL |
| compute per chunk p50 ms | 0.11279 | 0.1 | KILL |
| full-world rebuild ms | 3.5 | 50 | pass |
| draw p50 ms | 2.348589 | 1 | KILL |
| resident GPU bytes | 189581964 | 207000000 | pass |

## Geometry

| | GPU | CPU (shipped) |
|---|---|---|
| triangles | 5207349 | 3917911 |
| vertex bytes | 187.5 MB | 141.0 MB |
| draw p50 ms | 2.348589 | 3.7351099999999997 |
| build ms | 3.5 (GPU) | 806.2 (Node, single-threaded) |

Resident GPU bytes, GPU mesher: {"vertex":187464564,"height":1048576,"span":1067528,"table":1296,"total":189581964}

## Parity

{
  "samples": 4198401,
  "mismatches": 158,
  "exempt": 73679,
  "holes": 0,
  "examples": [
    "sample (1494, 26): mesh band -11, function band -12",
    "sample (1482, 38): mesh band -11, function band -12",
    "sample (1122, 46): mesh band -8, function band -9",
    "sample (1742, 58): mesh band -12, function band -13",
    "sample (1490, 106): mesh band -11, function band -12",
    "sample (554, 114): mesh band -12, function band -13",
    "sample (1498, 114): mesh band -11, function band -12",
    "sample (1486, 118): mesh band -11, function band -12"
  ]
}

## Pixels

{
  "width": 1200,
  "height": 900,
  "pixels": 1080000,
  "mismatched": 2482,
  "mismatchFraction": 0.002298148148148148,
  "tolerance": 8,
  "neighbourhood": 3,
  "metricFloorMismatched": 2056,
  "metricFloorFraction": 0.0019037037037037037
}

The shipped CPU mesher fell back to its blocky per-cell path in
6 of 1024 chunks
([1,131,727,773,867,936]). Those chunks are cell-quantized in
cpu.png and drawn at sample resolution in gpu.png, so they are expected to
contribute mismatched pixels.

## Page logs

(none)
