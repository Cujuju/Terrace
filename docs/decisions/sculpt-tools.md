# Sculpt tools

Facts about the player sculpt tools as they stand. Relaxation rules: `relaxation.md`. Spans and carve: `overhangs.md`. Picking: `picking.md`.

## Tools and modes

- Tools: `stamp`, `smooth`, `drag`, `carve`. Modes: raise / lower (`dir: 1 | -1`). Edge profile `soft | hard` applies to stamp only.
- Smooth carries a Strength (wire `smoothLambda`, integer percent 1–100, default 50), set by a brush-panel slider shown only for smooth. It scales the Laplacian move per pass.
- Smooth direction names net effect (owner decision 2026-09-16): Lower removes, melting toward a target one band above the click; Raise builds, filling toward a target one band below it.
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
- In an anchored smooth, a footprint cell already past the target is frozen for the stroke; every other cell stays within about one band of its start, capped at the target in-stroke. No cell is pinned without a deposit to guard. A bound that bites leaves the pair over-steep; the next stroke repairs it.
- `anchor: 'free'` and `spill: 'free'` are library paths only.

## Price (mana plugin)

- Price = displacement + unlock. Displacement is the nominal brush volume for (radius, profile, tool, sweep steps, carve depth), terrain-independent, so client gate and server agree without seeing the terrain.
- Unlock = `CHUNK_UNLOCK_MANA` per chunk of frontier the stroke's reveal reach opens. Flat, not scaled by perks.
- Charge follows effect: an applied stroke whose diff is empty pays unlock only; a stroke that moved one cell pays the full displacement. Both push the balance so the client's optimistic debit is erased.
- Zero-effect strokes are applied, not denied. Opening the frontier without sculpting is a legitimate act.

## Edges of the world

- A footprint entirely at the world floor is a no-op with an empty diff. Filling a pit at the floor works: pit cells rise toward the melt target while the wall above target stands.
- A column always keeps a bottom span floored at `BEDROCK_BAND`; no validated intent can remove it or throw.
