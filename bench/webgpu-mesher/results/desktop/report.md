# Gate 1 — WebGPU terrace mesher

Verdict: **kill** — first failing criterion: band parity mismatches

Adapter: {"vendor":"nvidia","architecture":"ampere","device":"","description":"","timestampQuery":true,"maxStorageBufferBindingSize":2147483644}
Timing method: timestamp-query

| criterion | measured | limit | |
|---|---|---|---|
| band parity mismatches | 157 | 0 | KILL |
| band parity holes | 0 | 0 | pass |
| isoline port mismatches | 0 | 0 | pass |
| pixel mismatch fraction | 0.002202777777777778 | 0.001 | KILL |
| compute per chunk p50 ms | 0.078848 | 0.1 | pass |
| full-world rebuild ms | 5 | 50 | pass |
| draw p50 ms | 0.690176 | 1 | pass |
| resident GPU bytes | 189583836 | 207000000 | pass |

## Geometry

| | GPU | CPU (shipped) |
|---|---|---|
| triangles | 5207401 | 3917911 |
| vertex bytes | 187.5 MB | 141.0 MB |
| draw p50 ms | 0.690176 | 0.688128 |
| build ms | 5 (GPU) | 1389.9 (Node, single-threaded) |

Resident GPU bytes, GPU mesher: {"vertex":187466436,"height":1048576,"span":1067528,"table":1296,"total":189583836}

## Parity

{
  "samples": 4198401,
  "mismatches": 157,
  "exempt": 73654,
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
  "mismatched": 2379,
  "mismatchFraction": 0.002202777777777778,
  "tolerance": 8,
  "neighbourhood": 3,
  "metricFloorMismatched": 2066,
  "metricFloorFraction": 0.0019129629629629629
}

The shipped CPU mesher fell back to its blocky per-cell path in
6 of 1024 chunks
([1,131,727,773,867,936]). Those chunks are cell-quantized in
cpu.png and drawn at sample resolution in gpu.png, so they are expected to
contribute mismatched pixels.

## Page logs

warning The powerPreference option is currently ignored when calling requestAdapter() on Windows. See https://crbug.com/369219127
warning The powerPreference option is currently ignored when calling requestAdapter() on Windows. See https://crbug.com/369219127
warning The powerPreference option is currently ignored when calling requestAdapter() on Windows. See https://crbug.com/369219127
