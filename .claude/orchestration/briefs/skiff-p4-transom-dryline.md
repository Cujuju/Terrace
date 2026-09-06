# Brief: skiff GLB, phase 4 — closed transom + a sealed, dry interior (GH #327, items 1 and 2, asset half)

Repo: /mnt/e/Development/Projects/Terrace. Work ONLY in the arc worktree (main already merged in):
  /mnt/e/Development/Projects/Terrace/.claude/worktrees/skiff-glb-models   (branch skiff-glb-models)
Never edit or run git against the main checkout. Commit to branch skiff-glb-models, staging ONLY your exact paths
(never `git add -A`, never a bare `git add`). Do not push. Do not merge. Do not add or write tests (owner rule).
Do not install dependencies. Never start the app. Comments are claims, not evidence: verify from executed code /
measured output and cite file:line or the printed number in your report.

Blender: "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background --python <script> -- <Windows paths>
(the argument paths are Windows paths, e.g. E:\Development\Projects\Terrace\.claude\worktrees\skiff-glb-models\...).
Prior phase reports for this asset: .claude/orchestration/briefs/skiff-p1-report.md, skiff-p2-report.md, skiff-p3-report.md.

## Files
- tools/blender/build_skiff.py (edit) → plugins/structures/client/assets/skiff.glb (rebuild, commit the binary).
- tools/blender/render_skiff.py, tools/blender/stat_glb.py (use; edit render_skiff.py only if a view needs adding).
- Read-only context: plugins/structures/client/skiffModels.ts (how the asset is consumed: one mesh, `waterline` anchor,
  SKIFF_BOB_AMPLITUDE_WORLD_UNITS, assertAssetFits against 0.36 x 0.14), client/src/config.ts:225-248 (WATER_SURFACE_LIFT).

## Owner defects (2026-09-04, verbatim): "The skiffs are missing a back plate, and the water should not render inside of the boat."

### Defect 1 — open transom. Root cause
build_hull() lofts nine station rings and never caps either end; the stem ring is nearly collapsed (STEM_HALF_FRACTION
0.06) so it passes, the transom ring (TRANSOM_HALF_FRACTION 0.60) is a visible hole.
Fix: add an end-cap face at BOTH ends (the transom ring's five points as one planar n-gon, and the stem ring's likewise),
appended to the hull faces BEFORE Solidify so the skin thickens them with the planking. Wind them with the same
flip_to_outward/assert_outward against the existing hull reference point. Colour: PLANK_COLOR (the transom is planking;
the sheer-strake band is a side-band read). Both ends, not just the transom: the contract is "the loft is closed
everywhere but the rail", so the only Solidify rim is the gunwale. State in the script comment why the stem is capped
too (2 triangles for a closed contract beats a hole that is merely too thin to see today).

### Defect 2 — sea visible inside the hull. Root cause (verified this session by the orchestrator)
The asset guarantees the sole clears the STATIC waterline only: sole top = keel rebase + 0.074 x 0.56 ≈ 0.047 vs
waterline 0.039 → 0.008 clearance. The client then (a) places the waterline at SEA_LEVEL while the renderer draws the
sea at SEA_LEVEL + WATER_SURFACE_LIFT = +0.031 world units (client/src/config.ts:248; skiffModels.ts's
SKIFF_FLOAT_WORLD_Y comment calling the lift "far smaller than any clearance here" is false for this asset), and
(b) bobs the hull ±0.02. The surface therefore sits up to 0.051 above the waterline against a 0.008-high sole, and the
sole is under water most of the cycle. Also the sole stops at 0.14/0.88 of the length and 0.82 of the beam, so the
interior is open to the sea at the ends and along the bilge even when the sole is dry.

The CLIENT half (float at the rendered surface; bob reduced to 0.006; a load-time assert) is phase 5, not yours.
Your half — make the asset carry its own dry-interior contract:

1. SEAL THE INTERIOR AT THE SOLE: the sole becomes a closed prism that spans the FULL length (transom station to stem
   station, sections at the loft stations or a subset that stays within TRIANGLE_BUDGET) with its port/starboard edges
   on the DESIGN SURFACE's half-width at the sole's height (interpolate the section between bilge and rail points at
   that z). The design surface is the Solidify mid-surface, so the sole's edges end INSIDE the 0.006 skin — no gap, no
   coplanar faces, no z-fight (surfaces cross, they do not coincide). Replace FLOOR_START/END/BEAM_FRACTION with the
   derived edge; keep FLOOR_THICKNESS. Result to prove: from directly above, no point of the interior below the sole is
   visible (the top render shows floorboards or planking everywhere inside the rail, no sea).
2. RAISE THE SOLE: FLOOR_HEIGHT_FRACTION such that (sole top − waterline) ≥ SOLE_DRY_CLEARANCE_MIN, a NEW named constant
   = 0.010 world units, with its comment giving the derivation: phase 5's bob amplitude 0.006 + 0.004 float margin,
   both stated as the client's numbers this asset is contracted against. 0.60 satisfies it (0.006 + 0.074x0.60 = 0.0504
   vs waterline 0.0393 → 0.011); confirm from the measured geometry, not from the fraction. The thwarts (0.85) must stay
   a visible bench height above the sole — report the measured gap.
3. EXPORT A `dryline` EMPTY at (0, 0, sole_top_z) alongside `waterline` (same construction). It is the asset's statement
   of "the interior is sealed below this height"; phase 5 asserts dryline.y − waterline.y ≥ bob amplitude at load, so a
   future re-author that lowers the sole or a client that raises the bob fails loudly instead of showing sea in the boat.
4. ASSERT in main(): measured sole top − waterline_z ≥ SOLE_DRY_CLEARANCE_MIN; the loft is closed at both ends (count
   boundary edges of the pre-Solidify hull mesh: only the rail loop may be open — verify with bmesh, print the count);
   tris ≤ TRIANGLE_BUDGET; envelope unchanged (≤ 0.36 x 0.14 x 0.12). If the budget of 300 is exceeded, reduce sole
   sections before touching anything else; report the final count.

## Verification (do all; the report cites the numbers)
- Build → the script's own printout (box, waterline z, dryline z, tris, boundary-edge count).
- stat_glb.py on the exported file with `--footprint 0.36 0.14 --height 0.12` (check its flags first): both Empties
  listed with positions; one mesh; one material; COLOR_0 present.
- render_skiff.py to .skiff-shots/ in the worktree (untracked, never committed): side, top, bow34, game, and a NEW
  `stern34` view (add it if the script lacks one) that shows the transom closed. LOOK at every PNG (Read tool) before
  reporting. Fail conditions: any black/inverted face; sea visible inside the rail from the top view; an open transom.
  The sea plane in render_skiff.py is at z = 0 with the boat sunk by its `waterline`; also render one top view with the
  plane raised to waterline + 0.006 (the bob crest) — the sole must still be dry.

## Commit
One commit: `fix(structures): skiff GLB seals its interior and closes the transom (#327)` — build_skiff.py, skiff.glb,
render_skiff.py if edited. Nothing else.

## Report (short; write it to .claude/orchestration/briefs/skiff-p4-report.md and return it)
Commit hash; measured numbers (waterline z, dryline z, clearance, thwart-sole gap, tris, boundary edges, envelope);
absolute PNG paths with one line each; anything you changed beyond the brief and why; anything you could not verify.
