# Session handoff 2026-09-11 c: crease lines back, GPU lips race, perf-panel pick

## Status
SHIPPED+PUSHED (main)

## Tip
9c71a66 feat(hud): performance panel leads with the picked cell

## What changed
- Crease lines missing on most snapshot chunks: the GPU mesher's single lips
  buffer was clobbered by the next batch's count pass before the previous batch
  copied its records out; batches now take turns on it (`4f775f5`). Live: 0 of
  224 expected chunks without lines (was 118 GPU, 0 CPU).
- Overlay neighbour gate re-evaluated on every neighbour draw (`3d6e82e`); it
  was stale when a west/north neighbour arrived later.
- Perf panel's first row is the picked cell / face / riser band (`9c71a66`),
  no `?pickdebug` needed.
- Owner's "flat slab at the waterline" is the shoreline level drawn by design;
  brief for another agent: [[shore-cap-contour-bounds]].

## Pending
- Owner: crease lines "definitely not the same level of visibility they were
  prior". Facts: default style `crease` = black, opacity 0.33, 1 px
  (`layerEdgeOverlay.ts` CREASE_*); `debug` = cyan 0x35d6e8, 0.9. The overlay
  was always-on cyan 0.9 until `4f64e3c`; `d2b32d0` introduced crease. WebGPU
  lines are 1 px regardless of `linewidth`. Owner to pick colour/opacity.
- Owner's queued design talk: server-side vertex smoothing so the client does
  not refine contours; the shore level is the first case ([[shore-cap-contour-bounds]]).
- Owner's stack on 5174 serves a WSL checkout, not `E:\…\Terrace`; restart it to
  pick up main.

## Resume path
1. `git -C E:\Development\Projects\Terrace log -1 --oneline` (expect 9c71a66).
   Work on local main; the worktree `crease-lines-drawing-798f82` is merged and
   idle.
2. Live probes: owner's server is on 2567 (node, IPv6 `localhost`; 127.0.0.1 hits
   a dead WSL relay). Private client:
   `cd client && VITE_SERVER_PORT=2567 pnpm exec vite --port 5199 --strictPort --host ::1`,
   open `http://localhost:5199/`, drive with the chrome-devtools MCP.
   `window.__terrace.world` (DEV): `chartSource().heightAt/revealedAt`,
   `pickables()`, `terrainMesherActive()`. GPU vertices: read the super-mesh
   position buffer back (i16 x,y,z,slot; xz /1024 wu from `mesh.position`, y /64).
3. Coverage oracle used this session: a chunk with an interior drawn-band edge
   and all four neighbours revealed must have line segments in its area.

## Cross-refs
[[shore-cap-contour-bounds]] [[project_session_handoff_2026_09_11_b_gpu-mesher-cap-spill-frontside]]
