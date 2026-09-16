# Sculpt tools

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (two owner bug reports: anchored smooth, and paying for nothing)

**Anchored smooth strokes contain their own relaxation.** Owner report on the
synced stack: "smooth, soft appears to be broken" / "it sometimes resets top
layers". Root cause in one sentence: the clicked-cell anchor bound only the
brush pass, so the smooth tool's relaxation — unrestricted inside the
footprint — immediately eroded the higher terrace the anchored brush had just
promised to leave alone, and lifted just-raised ground past the clicked
ceiling. Fix at the contract layer: an anchored smooth stroke hands the
relaxation a per-cell bound for every footprint cell, from pre-relaxation
heights — cells past the anchor target are FROZEN for the stroke; cells short
of it may move up to the target in the stroke's direction and freely against
it (slump stays physical; a wall may still shed into a dug ring). Where a
bound bites, the pair is left over-steep — the same accepted residual, for
the same reason, as issue #26's banded spill. The three anchored call sites
(brush ceiling, level-fill target, relaxation containment) now share ONE
target derivation (`anchoredTargetHeight`). `anchor: 'free'` and
`spill: 'free'` library paths are bit-identical to before.

**Charge follows effect.** Owner report: at the world floor, sculpting
"is not changing the landscape … but it's taking my mana". Root cause in one
sentence: the mana charge was the nominal brush volume and never consulted
the applied diff, so a stroke that changed zero cells (a footprint entirely
at the world floor, or a saturated ceiling) still cost full price. Fix in the
effect phase, where the authoritative diff is already in hand: an applied
intent whose diff is EMPTY charges nothing (and still pushes the balance, so
the client gate's optimistic debit is erased — the same standing-phantom
closure as the deny path). This deliberately does NOT reopen the 2026-08-14
pricing decision: the PRICE stays a pure, terrain-independent function of
(radius, profile) — client gate and server still agree on it without knowing
the terrain — and a stroke that moved even one cell still costs the full
nominal price. Only the degenerate all-or-nothing case changes, and it is
decided server-side at the charge site, not in the shared price function.
Consequence pinned in tests: zero-effect strokes are applied (not denied),
free, and balance-pushed, across every tool × profile; partially-clamped
strokes still pay in full. (The suite's own drain loops now alternate
raise/lower — pumping one cell forever is exactly the free-stroke case now.)

**Terrain at the floor was never the bug** (verified and pinned): widening a
pit at MIN_HEIGHT works — wall cells inside the footprint keep descending
toward the floor; a footprint entirely AT the floor is a true no-op with an
empty diff, under both tools and both profiles.

## Decisions made 2026-09-15 (carve depth is a runtime variable, default one band)

**How deep one carve cuts is a number on the intent, not a constant.** A carve
intent carries `depthBands`, validated to `1 … CARVE_MAX_DEPTH_BANDS` like every
other intent field, and the cut clears slabs `S … S + depthBands - 1` from the
grasped band S (`docs/decisions/overhangs.md`, 2026-09-02). The default is
`CARVE_DEFAULT_DEPTH_BANDS = 1`: one click opens one slab, and two clicks give
an overhang the two slabs of air it needs.

**No HUD control yet.** The wire and the shared math carry the depth; nothing in
the HUD sets it, so every stroke a player can currently make sends the default.
A control is a separate decision, made when there is a reason to cut deeper in
one click rather than two.

**The price scales linearly with depth.** A carve's displacement, which the mana
price is built from, is footprint cells × `depthBands` × `BAND_HEIGHT`, so a
two-band cut costs twice a one-band cut. This does not reopen the 2026-08-14
rule: the price is still a pure, terrain-independent function of the intent's
own fields — now (radius, profile, `depthBands`) — so the client gate and the
server still agree on it without consulting the map.
