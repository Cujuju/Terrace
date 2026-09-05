# Species sheet: pass 6 — the humpback whale (`whale`, variant 0)

Generic brief: `.claude/orchestration/briefs/species-glb-pass-template.md` — read it FIRST; this
sheet carries only what is specific to the humpback. Passes 1–5 (fish, shark, ray, eel,
angelfish) are merged. This is the first WHALE pass, and the whale is wired differently from
every species so far — read "How the whale is wired" before touching anything.

## How the whale is wired (verify each line at file:line, cite in the report)
- One `whale` on the wire is drawn as one of THREE bodies picked by entity id:
  `plugins/wildlife/client/models.ts` `drawableOf` → `whaleDrawables[seed % 3]`, in the order of
  `WHALE_SPECIES = ['humpback', 'blue', 'sperm']` (`client/whaleSpecies.ts`). That order is a
  contract (an individual keeps its body for life) — never reorder it.
- The bodies live in `whaleSpecies.ts` (procedural swept hulls + extruded fins), NOT in
  `species/`. `models.ts` assembles each with `assembleWhale` + `bakeSpecies(root, {rig, flukes})`
  and animates it inline (`WHALE_FLUKE_HZ` 0.45, `WHALE_FLUKE_SWING_RADIANS` 0.3, pitch about Z:
  `flukes.rotation.z = swing·0.3`, `rig.rotation.z = swing·0.3·0.12`). Colour `WHALE_COLOR`
  0x39506b, SMOOTH-shaded (`lambert(WHALE_COLOR, { flatShading: false })`).
- `WHALE_ENVELOPE = { crownY 0.670, bellyY −0.575, length 5.05 }` is the PLACEMENT CONTRACT:
  `placement.ts` BODY_COLUMNS.whale reads crownY/bellyY; SWIM_PROFILES.whale is HAND-SET
  (0.7 / 0.7 / 2.53 / 0.5) with a comment citing length 5.05. `protocol.ts` ~L134 cites it.
  Do not change placement.ts, protocol.ts, or the three numbers.
- Each procedural body is FITTED into that box by `finish()` (uniform `fitScale` = the tightest
  of the three ratios), so today's bodies fill ONE axis each and sit inside on the others.
  Measured 2026-09-04 (scratch script over `buildWhaleGeometrySets()`):

  | body     | fitScale | x min…max        | length | y min…max       | hull halfWidth | tris   | surfaces |
  |----------|----------|------------------|--------|-----------------|----------------|--------|----------|
  | humpback | 0.6907   | −2.2875 … 2.1904 | 4.478  | −0.575 … 0.588  | 0.4145         | 22 424 | 2        |
  | blue     | 0.7902   | −2.5694 … 2.4806 | 5.050  | −0.388 … 0.451  | 0.3646         | 19 332 | 2        |
  | sperm    | 0.7805   | −2.5726 … 2.4774 | 5.050  | −0.551 … 0.473  | 0.4375         | 21 944 | 2        |

  The humpback's belly is a FLIPPER TIP (flippers pitched down-and-out), which is what capped
  its scale. These are the "old" rows for your report; you do not need a `--old` bake.
- `index.ts` ~L260–305: the surface table says `whale × WHALE_SPECIES = 2` surfaces each
  (`TWO_SURFACE_SPECIES = 1 + WHALE_SPECIES.length`), and `attach` ASSERTS the pool agrees.
  Find out WHY a whale bakes to two (the handoff's reading: the extruded fins are non-indexed
  while the hull is indexed, and rigSkin groups by indexed-ness — verify at rigSkin.ts, cite).

## Design decisions, already made
1. **Three assets, three keys, one wire species.** Each whale body becomes its own
   `SpeciesAssetSpec` keyed `whale-humpback` / `whale-blue` / `whale-sperm` (the key is only
   the install-map key in `assetSpecies.ts`; the wire species stays `whale`). This pass lands
   the humpback ONLY; blue (pass 7) and sperm (pass 8) stay procedural and keep drawing.
2. **Every whale asset FILLS the box exactly.** Its rest file measures crownY 0.670, bellyY
   −0.575, nose-to-tail length 5.05 — the same three numbers for all three bodies, so the
   variant envelope is derived, not authored: `whaleEnvelope(halfWidth)` =
   `{ ...WHALE_ENVELOPE, halfLength: WHALE_ENVELOPE.length / 2, halfWidth }` with the variant's
   own hull half-width the one free field. A humpback in the same box as before is ~13 % bigger
   than today's (which was flipper-capped at 4.48 long); that is intended.
3. **One envelope (rest).** The flukes pitch ±0.3 rad about a hinge at the peduncle; the tips
   sweep ±(reach·sin 0.3) in y — well inside 0.67/−0.575 — and their x-extreme only SHORTENS
   under pitch (cos ≤ 1), so the straight file is the conservative reading (the eel's argument).
   The rig roll ×0.12 is unchanged from today. State this in the file.
4. **Belly is authored, not assigned.** The lowest point (−0.575) must be geometry at rest: the
   barrel chest, or a flipper baked at its real hang angle under an IDENTITY hinge if you want a
   flipper tip there. The flippers are RIGID body parts (no joint) exactly as today.
5. **Joints: `WHALE_JOINTS = ['rig', 'flukes']`.** `flukes` is an Empty AT THE PEDUNCLE, both
   fluke blades its children, identity rotation. Anchors `nose` (+2.525), `tail_tip` (−2.525,
   the flukes' trailing edge), `crown` (0.670), `belly` (−0.575), `flank` (±halfWidth, the
   hull's widest station; flippers and flukes reach further — upper-bound case).
6. **New file `species/whale.ts`** — the shared whale-asset piece, written ONCE this pass and
   reused by passes 7–8: `WHALE_JOINTS`, `whaleEnvelope(halfWidth)`, `animateWhale(joints,
   seconds, phase)` with the SAME constants and formula as models.ts today (move
   `WHALE_FLUKE_HZ` / `WHALE_FLUKE_SWING_RADIANS` / the 0.12 body-roll fraction here as named
   exports; models.ts's remaining procedural whale drawables import them from here so each
   number exists once). `species/humpback.ts`: `HUMPBACK_HALF_WIDTH`, `HUMPBACK_ENVELOPE =
   whaleEnvelope(HUMPBACK_HALF_WIDTH)`, `HUMPBACK_ASSET`, `buildHumpback =
   assetSpeciesBuilder(HUMPBACK_ASSET, animateWhale)`. Header comments in the ray.ts style.
7. **`whaleSpecies.ts` loses `humpbackSet`** (its profile numbers go into build_humpback.py's
   header as the reference silhouette); `buildWhaleGeometrySets()` returns the two remaining
   sets, each tagged with its `species`. `WHALE_SPECIES` and `WHALE_ENVELOPE` stay exported
   and unchanged (placement.ts / index.ts / protocol.ts cite them). Export a
   `PROCEDURAL_WHALE_BODIES` count (2) for index.ts's table.
8. **models.ts**: `whaleDrawables` built in `WHALE_SPECIES` order — `humpback` →
   `speciesDrawable(buildHumpback)`, the other two → the procedural path as today (look the set
   up by `species`, never by index). `WHALE_COLOR`/`whaleMaterial` stay for the two.
9. **index.ts table**: SINGLE_SURFACE_SPECIES 8 → 9 (humpback asset), TWO_SURFACE_SPECIES =
   `1 + PROCEDURAL_WHALE_BODIES`. Update the comment table. The `attach` assert must pass —
   prove it by baking under Node in `.verify-humpback-asset.mts` (surfaceCount 1).
10. **previewSpecies.ts**: add `whale-humpback` to `BUILDERS` and to the `?species=` list in the
    header — this sheet authorises that one edit.

## The model
A real Megaptera silhouette, read from the play camera and side-on: barrel chest collapsing to
a narrow, laterally-flattened tail stock; flippers nearly a third of body length (~1.6) with a
scalloped leading edge and rounded tips, hanging down-and-out; tubercles knobbling the rostrum
and jaw line; a small hump with a low stubby dorsal two-thirds back (that hump-plus-dorsal is
the crown); broad flukes with a serrated trailing edge and a deep central notch; the throat's
ventral pleats as shallow grooves (baked relief, not paint); one eye per side just behind the
jaw's gape. Smooth-shaded: shade-smooth every mesh in Blender, export normals, and verify
rigSkin's signature reads `smooth` (client/src/render/rigSkin.ts ~L113–125) and the count
bakes to ONE surface. Colours: body 0x39506b via `srgb()`; you MAY add one pale ventral tone
(throat pleats, flipper undersides, fluke undersides — the humpback's white) and one dark eye —
list the hexes in the report. Triangle aim ≤ ~8 000 (the largest and closest-viewed body in
the water; the procedural one was 22 424).

Every dimension a named constant with a one-line reason; parity (vertex-inside) check for every
non-hull part against the hull, asserted; winding check; envelope print measured-vs-declared.

## Verification specific to this pass
- `.verify-humpback-asset.mts`: `installSpeciesAsset` accepted; anchors; `surfaceCount` 1;
  joints; tris. For the "old" row use the table above.
- Under Node, bake the two remaining procedural whales too (they are what index.ts still counts
  as 2 surfaces each) and show the draw-object tally equals the new `drawBudget`.
- Envelope proof: `HUMPBACK_ENVELOPE.crownY/bellyY/length` `Object.is` WHALE_ENVELOPE's;
  placement rows (SWIM_PROFILES.whale, BODY_COLUMNS.whale) byte-identical old vs new.
- Fluke sweep print: hinge x, tip reach, y sweep at ±0.3 rad, x shortening — all inside the box.
- Renders: iso/side/front/top; the side view must read as a humpback (long flippers, hump,
  serrated flukes) and not as a generic whale.

Report: `.claude/orchestration/briefs/humpback-glb-pass6-report.md`.
