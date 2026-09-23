# Terrace — Design

Standing rules, settled with the owner. Do not relitigate without new
information. Dated decisions live in `docs/decisions/`, one file per arc; never
append them here. Setup, configuration, layout and the plugin-author guide are
in the README.

## Rules

- `shared/` is the single source of truth for terrain math and protocol types.
  Never duplicate its math. Erasable TypeScript syntax only.
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
- Terraces are `BAND_HEIGHT` tall; a click moves one band; a tread is one world
  unit wide.
- The default brush edits only its footprint. Relaxation runs only under the
  smooth tool.
- Sea and freshwater are derived from the terrain, never simulated.

## Rendering and plugins

- Terrain-band smoothing uses one plain 3×3 binomial pass, without small-feature
  protection. The owner judges appearance and sculpting behavior; tiny terraces
  or holes may disappear. Derived-field filtering is the preferred direction;
  the default-off **Smooth terrain bands** setting selects the shared filtered
  field for CPU/GPU geometry, picking and client grounding. Stored terrain is
  unchanged. Production appearance remains subject to owner review. See
  [band smoothing](decisions/band-smoothing.md).
- **≥ 140 fps on the owner's machine** (≈ 7 ms per frame). What does not fit is
  budgeted (`docs/decisions/mesh-budgets.md`) or moved off the frame.
- Terrain edits patch vertex buffers in place, never rebuild geometry.
- three keys every render object's pipeline on the set of visible lights
  (`LightsNode.customCacheKey` hashes every visible light id). A change disposes
  and rebuilds every render object, program and pipeline in the scene.
- A plugin's dynamic point lights are a fixed-size bank
  (`client/src/plugins/kit/lightBank.ts`), created and parented at attach,
  permanently visible, parked by intensity 0 only. Nothing after attach adds,
  removes, hides or reparents a light.
- Spawn paths construct no materials or node graphs: rigs, lights, materials
  and geometries are built at attach (or on idle, as monster templates are),
  pooled and reused.
- `client/src/render/settleWarmup.ts` compiles hidden drawables, and plugin
  drawables not yet drawn, during every snapshot build, before plugins draw
  again. A material set that only exists after that gets a hidden specimen
  in the layer and a `requestShaderWarmup()` call once it is added.
- Nothing hides a plugin layer: that hides its light bank. The build hold
  filters draws instead (`docs/decisions/plugin-host.md`, 2026-09-22).

## Glossary

| Term | Meaning |
|---|---|
| **cell** | One grid position; a column of solid spans whose top ceiling is its height |
| **span** | One solid run in a column, `{ floorBand, ceiling }`; it covers bands `floorBand` through `spanCapBand` |
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
