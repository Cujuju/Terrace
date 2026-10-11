# Brief: trace orthographic references into a Blender war-boat hull (tier-2 experiment)

## Goal
Prove or disprove that tracing orthographic plan drawings into Blender gives a
visibly better war-boat hull than the current hand-built primitive one, at
game camera distance. Output is a GLB plus renders plus a short report. No
client code changes. Do not start the app.

## Inputs (already downloaded)
Directory: /mnt/e/Development/Projects/Terrace/.boat-ref/
- viking_ship_plan_Holmes_Ancient_and_modern_ships.gif (5598x3678) — 1906
  Holmes plan of the Gokstad ship; contains profile (side) and plan (top)
  views and section lines. Public domain.
- gokstad_schematic.jpg (1800x709, greyscale) — schematic side + plan.
- gokstad_section.jpg (1000x741) — midship cross section.
View them first (Read tool renders images). Decide which gives the cleanest
side profile, plan half-breadth, and midship section. Crop as needed with
PIL (system python3 has PIL). Do not install anything.

## Current model, for scale and comparison
/mnt/e/Development/Projects/Terrace/plugins/boats/client/models.ts
- HULL_LENGTH 0.9 world units (1 cell), HULL_BEAM 0.34, HULL_DEPTH 0.2.
- Hull today = an extruded 5-point plan outline (HULL_OUTLINE) with flat
  bottom and vertical sides, plus mast, yard, sail, 4 oars.
- Real Gokstad L/B is 23.8/5.1 = 4.67; the game's hull is 2.65. The game hull
  is deliberately beamy for legibility from above. Build the traced hull at
  TRUE proportions scaled to length 0.9 AND a second variant with the beam
  stretched to 0.34 (non-uniform Y scale). Report both.

## Method (tier 2 = algorithmic trace, not eyeballing)
1. From the side view: threshold, then per x-column extract the sheer line
   (top of hull) and keel line (bottom). From the plan view: per x-column the
   half-breadth. From the section: the hull cross-section curve (keel to
   gunwale) as a normalized U profile.
2. Sample N stations (N ~ 24) along length. At each station build a cross
   section = section profile scaled to that station's half-breadth and depth
   (keel-to-sheer), positioned at the sheer height. Skin adjacent stations
   into quads, close bow and stern to the stem/stern posts, mirror port.
3. In Blender (headless): build the mesh from those points via bpy from
   JSON, add a Subdivision Surface (1-2 levels) and shade smooth, add a thin
   solidify or a deck plane so it reads as a hull not a shell. Keep tri
   count under 2000 at level 1; report counts at each level.
4. Keep mast + yard as simple cylinders at MAST_HEIGHT = 0.66*0.9 so the
   silhouette is comparable; no sail, no oars.
5. Export .boat-ref/out/hull-true.glb and hull-beamy.glb (Y up, metres =
   world units). Render each from four cameras on a plain grey ground, 512²,
   EEVEE or Workbench: (a) game camera — about 55° down from horizontal,
   distance ~6 units, (b) side, (c) top, (d) bow three-quarter. Save PNGs to
   .boat-ref/out/. Also render the CURRENT outline for comparison: extrude
   HULL_OUTLINE with depth 0.2 in Blender using the same materials and
   cameras, so the comparison is apples to apples.

## Blender
Windows install, run from WSL:
  "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --python E:\...\script.py -- args
Blender 5.2.1 LTS, bundled Python 3.13 with numpy. Paths INSIDE the script are
Windows paths (E:\Development\Projects\Terrace\.boat-ref\...). Put scripts in
.boat-ref/ (project dot-dir, never $HOME). Expect ~10-20 s startup per run.

## Verification you must include in the report
- ls -la of every output with sizes; tri/vert counts per GLB via a bpy import
  in a fresh Blender run (not from your own bookkeeping).
- You must VIEW your renders and describe what you see honestly: does the
  hull read as a longship at the game camera? Any artifacts (twisted quads,
  open ends, flipped normals, self-intersections at bow/stern)? Fix before
  reporting; if you cannot, say so.
- The extracted profiles: save a debug PNG overlaying the traced sheer/keel/
  half-breadth curves on the source crop, so a reviewer can check the trace
  is real and not hand-typed points.

## Report
Write .boat-ref/out/REPORT.md: method used, which source image per view,
tri counts, list of PNGs, findings, and problems. Keep it under 60 lines.
Do not commit anything. Do not touch files outside .boat-ref/.
