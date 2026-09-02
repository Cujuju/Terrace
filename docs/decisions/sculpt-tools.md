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
