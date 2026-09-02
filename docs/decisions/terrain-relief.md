# Terrain relief

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## The world re-terraced, and the Populous slump retired (2026-08-20)

Two owner decisions, taken together because the second falls out of the first.

**`BAND_HEIGHT` 64 → 16.** The world was too blocky: a band was drawn one full
cell tall, so every riser was a cube-sized step and the land read as stacked
blocks rather than as terraces. The client now draws a band at a QUARTER of a
cell and there are four times as many of them in the same height range, so the
world keeps exactly its relief while every step in it is four times finer.
`MAX_STEP` moved with it, from `BAND_HEIGHT/2` to `BAND_HEIGHT` — one cell of
run per band, the finest tread that still reads as a terrace. Hills therefore
spread twice as wide as they used to; a full-height mountain's foot moves from
32 cells out to 64.

**No more outward flow.** Because a click and the gradient limit are now the
same number, one click on flat ground satisfies the invariant at its own edge
and nothing spills. That is the Godus look the owner asked for, and it retires
the Populous signature recorded at the top of this document.

**The contract this bought, and why it is the real deliverable.** A band is a
RENDER quantum. Re-terracing the world must not move anything the world is
made OF. Every constant that meant a physical fact but was written as a band
count had to be restated in HEIGHT UNITS with its band count derived — the
strata stack, deep water, the snow line, genesis's coastal staircase and
trench, the noise field's amplitude, the client's own vertical scale. They
interlock, so getting one wrong was not cosmetic: left as "3 bands", a fresh
world's abyss would have been 48 units deep against a 192-unit deep-water line,
and no fresh world would have had deep water anywhere — or any sea monsters.

The same rule settled two rendering questions. The terrain palette became a
ramp GENERATED from height anchors instead of one hex literal per band (it
indexed off its end otherwise), and the owner chose to interpolate between the
anchors, so each of the four bands now standing where one stood gets its own
shade. And the chunk geometry guard had to change kind, not just size: a deep
dig crosses 94 band levels where it crossed 22, which pushed legitimate
triangulation work up into the adversarial population's range and closed a 2.2×
separation to 1.2%. Discrimination moved to the largest single merged polygon —
the quantity ear-clipping is actually quadratic in, and the one metric here that
does not move when the world is re-terraced.

**Costs, measured and accepted.** A fully explored 512² world goes from 1.69 M
triangles to 4.09 M and terrain vertex buffers from 279 MB to 673 MB. Reaching a
given height takes four times the clicks (digging to the world floor is ~96 held
clicks, about 12 s on the hold-repeat ramp, against ~24 before). The per-chunk
triangle ceiling quadrupled to 14.5 MB at the current 111 bytes per triangle,
which promotes vertex-format compression from an optimisation to load-bearing
work.
