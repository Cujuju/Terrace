# Sculpt tools

Facts about the player sculpt tools as they stand. Relaxation rules: `relaxation.md`. Spans and carve: `overhangs.md`. Picking: `picking.md`.

## Tools and modes

- Tools: `stamp`, `smooth`, `drag`, `carve`. Modes: raise / lower (`dir: 1 | -1`). Edge profile `soft | hard` applies to stamp only.
- Carve only lowers; the mode chord is ignored and the HUD hides the Mode row for it.
- Plugins terraform through the library-only `settle` operation (deposit, then unbounded relax). Players never send it.

## Carve depth

- A carve intent carries `depthBands`, validated to `1 … CARVE_MAX_DEPTH_BANDS` like any other intent field. The cut clears slabs `S … S + depthBands - 1` from the grasped band S (`overhangs.md`).
- `CARVE_DEFAULT_DEPTH_BANDS` = 1: one click opens one slab, and two clicks give an overhang the two slabs of air it needs.
- No HUD control yet. Nothing in the client sets the field, so every stroke a player can currently make sends the default. A control is a separate decision.
- Displacement scales linearly with depth: footprint cells × `depthBands` × `BAND_HEIGHT`, so a two-band cut costs twice a one-band cut.

## Anchoring

- Player strokes are anchored to the clicked cell's drawn band. One press moves a cell at most one drawn band, landing on the band's canonical level.
- All anchored call sites (brush ceiling, level-fill target, relaxation containment) use one target derivation, `anchoredTargetHeight`.
- In an anchored smooth, a footprint cell already past the target is frozen for the stroke; every other cell may move to the target in the stroke's direction. A bound that bites leaves the pair over-steep; the next stroke repairs it.
- `anchor: 'free'` and `spill: 'free'` are library paths only.

## Price (mana plugin)

- Price = displacement + unlock. Displacement is the nominal brush volume for (radius, profile, tool, sweep steps, carve depth), terrain-independent, so client gate and server agree without seeing the terrain.
- Unlock = `CHUNK_UNLOCK_MANA` per chunk of frontier the stroke's reveal reach opens. Flat, not scaled by perks.
- Charge follows effect: an applied stroke whose diff is empty pays unlock only; a stroke that moved one cell pays the full displacement. Both push the balance so the client's optimistic debit is erased.
- Zero-effect strokes are applied, not denied. Opening the frontier without sculpting is a legitimate act.

## Edges of the world

- A footprint entirely at the world floor is a no-op with an empty diff. Widening a pit at the floor works: wall cells inside the footprint keep descending.
- A column always keeps a bottom span floored at `BEDROCK_BAND`; no validated intent can remove it or throw.
