# Terrace — Design

Standing rules, settled with the project owner. Do not relitigate without new
information, and do not append decisions here: dated decision records live in
`docs/decisions/`, one file per arc. Setup, configuration, layout and the
plugin-author guide are in the README.

## Rules

- `shared/` is the single source of truth for terrain math and protocol types.
  Never duplicate its math. It uses only erasable TypeScript syntax.
- Terrain math is deterministic: integer-only or exactly-specified IEEE ops in
  fixed iteration order, identical on server and client.
- Clients send intents, never heights. The server is authoritative and
  broadcasts diffs; the client predicts with the same math and reconciles.
- Locked chunks are never sent to a client. Chunks unlock per player; the
  simulation runs on the union. When they unlock is a plugin's decision.
- One world live per process. A world is one SQLite file; nothing deletes a
  world implicitly and boot never replaces a missing one.
- Core has no simulation of its own beyond terrain; plugins simulate in
  `onTick`. Nothing "gamey" in core.
- A cell is a column of solid spans, so overhangs and caves are representable.
  Terraces are `BAND_HEIGHT` tall; a click moves one band and a tread is one
  world unit wide. The default brush edits only its footprint; relaxation runs
  only under the smooth tool. Sea and freshwater are derived from the terrain,
  never simulated.
- **≥ 140 fps on the owner's machine** (≈ 7 ms per frame). Anything that does
  not fit is budgeted (`docs/decisions/mesh-budgets.md`) or moved off the
  frame. Terrain edits patch vertex buffers in place, never rebuild geometry.

## Glossary

| Term | Meaning |
|---|---|
| **cell** | One grid position; a column of solid spans whose top ceiling is its height |
| **span** | One solid run `[floor, ceiling)` within a column |
| **band** | One terrace level, `BAND_HEIGHT` tall |
| **world unit** | `WORLD_UNIT_CELLS` cells on a side; the width of one terrace tread |
| **chunk** | `CHUNK_SPAN` world units square; unit of unlock and streaming |
| **mask** | Which chunks are unlocked: one per player token, plus their union for the simulation |
| **token** | A player's durable client-generated identity; chunks unlock per token |
| **intent** | Client → server sculpt request; never raw heights |
| **diff** | Server → clients `CellDiff[]` after an applied edit |
| **snapshot** | Serialized world state (terrain + plugin slices) for join and persistence |
| **World** | The single live authoritative world object in a process |
| **tick** | One fixed-rate sim step (`TICK_HZ`) on the server |
