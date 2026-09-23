# Sources and licences for the models in this directory

CC0 only — the standing rule in docs/model-assets.md ("Sources and licences").
Every entry records the page the licence was read ON, not a mirror.

Downloaded art is CC0 only (above). Models built in this repo are original work
under CC BY 4.0 — see "Original models" below.

## timber-house.glb — removed 2026-09-23

The CreativeTrio "Cottage" (https://poly.pizza/m/YDGLLT0emC, CC0) that tier 2
once loaded is gone from the repo, along with its loader. Tier 2 is drawn from
the authored kit (`authored/*/timber-house.glb`, new geometry, not derived from
the cottage); without the kit it falls back to the procedural timber house.

## Original models — CC BY 4.0

- Licence: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- Author: Cuju Ju
- Credit line: "Terrace buildings" by Cuju Ju, from Terrace, licensed CC BY 4.0.

Covered here:

- `skiff.glb` — built by `tools/blender/build_skiff.py`.
- `authored/original/*.glb` and `authored/low/*.glb` (22 building types, two
  variants each) — new geometry, or first-party procedural models rebuilt in
  Blender, with procedural paint. No third-party mesh or texture is reused;
  generated concept images were references only. Build record:
  `.census/building-kit/README.md`.
