# Monsters

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-22 (the yeti shrinks to a quarter — owner request)

- **The yeti is a QUARTER of the size he was, and everything derived from his
  size goes with him** (owner request: "make the Yeti about 25% of its current
  size", and, asked how far the shrink should reach, "shrink gameplay too" and
  "slow his walk speed too").

  **One number owns it.** `YETI_SCALE = 0.25` in `client/yeti-anatomy.ts`, and
  every LENGTH in that file is written at its original full-size figure and
  passed through a local `scaled()`. The silhouette record therefore still reads
  in the proportions its prose argues for — 6.3 tall, 5 across, a hip at 39% of
  his height, hands below them — and the animal that comes out is 1.575 by 1.25
  world units. The amendment is the multiplier, not two hundred rewritten
  literals, which is what makes it reversible and what makes the next rescale a
  one-line change.

  **What does NOT pass through it, and why each is right.** Angles and fractions
  (the swings, the ~3° lean, the head scan, the eye bulge, the tuft variation,
  the ±22% shade mottle) are dimensionless — a scaled model turns through the
  same angles. The two spatial frequencies divide by it instead, so the same
  NUMBER of wrinkles crosses a body a quarter the size; because the carve is
  sampled at position × frequency, scaling the pair inversely reproduces the old
  surface EXACTLY, four times smaller. `YETI_AMBLE_HZ` and
  `YETI_LEG_SWING_RADIANS` are ratios of scaled quantities (speed over stride,
  stride over leg) and fall out unchanged on their own — which is the whole
  reason the gait survives this untouched.

  **The walk speed is cut with him**, 0.45 → 0.1125 cells/s, because a speed is
  a LENGTH per second: a quarter-size animal holding the old speed crosses its
  own body four times as fast as it used to, which is scurrying. What justified
  0.45 in the first place survives the cut and is now what the test pins — he
  covers his own width in the same eleven seconds, and is still under a third of
  a wildlife grazer, so he cannot read as livestock. What does NOT survive is
  the comparison to the two sea kinds' absolute speeds (Cthulhu's 0.25 brood,
  the kraken's 0.6 hunt): they are four to nine times his size now, so the
  faster one is merely the one with longer legs.

  **His country shrinks by the square.** `YETI_FOOTPRINT_CELLS` drops to 1.25
  world units, and the minimum lair — 2 730 cells — is now WRITTEN as the
  argument that always justified it rather than as a chunk count that happened
  to equal it: 4.5 body-widths across, squared, cut by the 2026-08-19
  reachability third. That formula reproduces the old number to within 1% at his
  old size (2 700 against 2 730) and, unlike a chunk count, follows the animal.
  At the new size it is **168 cells**, a ~13×13 patch, with collapse at 42. The
  consequence is deliberate and was put to the owner in those words: a yeti no
  longer costs a mega-project, and "a fresh world cannot host him" now means a
  modest hilltop rather than a couple of hundred level-fill strokes. He is no
  longer the biggest thing on the mountain and no longer asks for a mountain.

- **The model's tessellation is raised across the board** (same request: "smooth
  out the model a little bit by increasing its fidelity"). The yeti carried the
  LOWEST base counts of the three creatures and it showed on exactly the parts
  that carry this silhouette: two radial segments made an OCTAGONAL leg at
  `MONSTER_MODEL_DETAIL = 4`. The counts are raised per part by what its shape
  has to hold — radial segments for the swept limbs and the ruff tufts, both
  axes for the round masses, and the tufts' path count left alone because a
  straight taper buys nothing from rings along it. **15 600 triangles against
  6 024**, still under Cthulhu's 18 664 and affordable because
  `MAX_LIVING_MONSTERS` is 1.

  It is NOT compensation for the rescale, and the note in the file says so: a
  quarter-size model covers a sixteenth of the screen and would have needed
  fewer triangles, not more. The faceting was there at full size too. The global
  `MONSTER_MODEL_DETAIL` knob was deliberately left alone — it is one number for
  the whole plugin by design, and this was one creature's problem.

- **Two tests changed their basis rather than their numbers**, which is the part
  worth recording. The carve comparison ("he wears fur, not skin") compared
  ABSOLUTE wrinkle depths across three animals; at a quarter size that reads the
  opposite of the truth, so it now compares depth as a FRACTION of each
  creature's own height — the comparison it always meant. The amble test pinned
  an absolute 0.45 and would have passed unchanged through this rescale while
  the animal it described started scurrying; it now pins seconds per body-width.
