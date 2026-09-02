# Deep strata

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (Deep Strata — mechanics card 41, and the kraken bar)

**Deep Strata ships in core: the world gets a crust.** Below the sea column's
16 blue bands the range now continues through named strata — basalt (bands
−17..−20), obsidian (−21..−23), and one lava band at the new floor (−24,
MIN_HEIGHT = −1536). The strata are shared constants (`SEA_COLUMN_BANDS`,
`DEEP_BASALT_BANDS`, `DEEP_OBSIDIAN_BANDS`, `DEEP_LAVA_BANDS`) and MIN_HEIGHT
is DERIVED from the stack, never restated; the client palette and the monsters
plugin both derive from the same constants, pinned by tests on each side.

- **The sea column is unchanged on purpose.** 16 bands is the old floor,
  kept exactly: every stored world remains in contract (old MIN sits inside
  the new range), the blue depth ramp renders byte-identically, and "deep
  water" keeps meaning water.
- **Palette regimes.** The blue column's strict-darkening contract now ENDS
  at band −16; the first basalt stop is deliberately BRIGHTER than the blue
  floor (breaking through the seabed reads as a material change), the rock
  darkens strictly to the obsidian floor, and the lava band is the palette's
  one light source — rendered self-lit via the same per-vertex flag the
  seabed rims introduced (`isEmissivePaletteIndex` → cap self-lighting in
  capEmission.ts; contour and blocky-fallback paths share the predicate).
  Underwater riser/lip-border rules (2026-08-19 riser amendment) extend to
  the strata unchanged.
- **Derived budgets followed the range**: SMOOTH_SPREAD_CELLS 64 → 80,
  SMOOTH_PASS_LIMIT 256 → 320, both by existing derivation; stress suites
  converge under the scaled cap. Mana is untouched — pricing is volume per
  stroke (footprint × band), independent of world depth, and the mana suite
  passes unmodified.
- **Hazards are NOT core.** Heat, eruptions, anything gamey in the deep is a
  future plugin reading these same boundary constants (nothing-gamey-in-core
  rule). Punted explicitly, tracked as follow-up.

**The kraken bar moves to the natural ocean floor (owner-decided 2026-08-19).**
`KRAKEN_LAIR_MIN_DEPTH_BANDS` was "half the water column" (8 bands, −512) —
one band below the deepest floor worldgen naturally shows, so every world
demanded one mandatory manual dig before its first kraken; worse, Deep Strata
deepening the range would have silently dragged a column-anchored bar to 12
bands. New derivation (plugins/monsters/server/kinds.ts): genesis oceans
bottom out at band −8 (−512, band multiples by construction) and the first
relaxation to reach a floor's rim shaves up to MAX_STEP/2 = 16 off the extreme
cell — hence the live world's −496 floor. The bar is that relaxed natural
floor in whole bands: **7** (`NATURAL_OCEAN_FLOOR_MIN_DEPTH = 496`). A natural
−496 trench now summons the kraken with no digging; worlds whose noise never
reached band −8 still need a dig, unchanged. Pinned three ways in the monsters
suite: −496 passes admission, a natural-floor basin summons a kraken
behaviourally, and the bar is 7 independent of MIN_HEIGHT (a retune that moves
it fails the pin, not the players).
