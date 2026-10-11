# Tier-2 traced war-boat hull — result

**Verdict: proved.** The traced hull is visibly better at the game camera, and the win is the PLAN outline plus the rounded bilge, not the polygons: traced is double-ended with curved sides; the current hull is a blunt-sterned extruded pentagon whose chine is a hard facet from every angle (`game-compare.png`, 4th tile).

**Sources per view.** sheer+keel: `schematic.png` top figure (Nicolaysen longitudinal section) — continuous outer stroke, no perspective. half-breadth: `schematic.png` bottom figure (bird's-eye) — cleanest closed plan outline. midship section: `gokstad_section.jpg` (after Schetelig) — one clean planking line, keel to gunwale. Rejected `plan_small.png` (Holmes 1906): waterlines, buttocks and a curve-of-areas overlay the hull, so no per-column extraction is clean.

**Method** (`extract.py` → `build.py` → `blender_scene.py`):
1. Threshold 160, `scipy.ndimage` components. Keel and both plan edges follow a **continuity walk** — per column take the run boundary nearest the previous column (≤8 px). That steps over rudder, masts and the detached yard, which a naive per-column min/max grabs.
2. Sheer needed a second pass: the strakes above the hull body are drawn as separate hatched bands, so the body component's top edge sits a strake low. Pass 2 lifts to the topmost ink of any component within 40 px; a grey closing (91 px) then deletes the mast-partner block and steering-oar bracket without touching the monotonic bow/stern rise.
3. Stem/stern posts are the ink the sheer filter rejected — same trace, kept.
4. 13 stations × 9 half-section points; the section profile is scaled per station to that station's half-breadth and keel-to-sheer depth, mirrored, skinned into quads, ends collapsed to the stem line, top closed with a deck. Subsurf level 1 + shade smooth; posts are a separate un-subdivided object.
5. `hull-current` rebuilds the in-game hull with the exact arithmetic of `models.ts:239` (`along*0.9`, `across*HULL_BEAM*2`, extrude 0.2), same materials, lights, cameras.

**Trace cross-check:** traced L/B = **4.59** (real Gokstad 23.8/5.1 = 4.67); traced L/D = **11.63** (real ≈ 11.9). Both fall out of the pixels — measured, not typed. `trace-debug.png` overlays the curves on the sources.

**Counts** — fresh Blender import of the GLBs (`verify_glb.py`, `check_mesh.py`):

| glb | tris | verts | bytes | non-manifold | signed vol |
| --- | --- | --- | --- | --- | --- |
| hull-true.glb | 1828 | 1116 | 42188 | 0 (hull) | +0.00486 |
| hull-beamy.glb | 1828 | 1116 | 42188 | 0 (hull) | +0.00842 |
| hull-gamebox.glb | 1828 | 1116 | 42188 | 0 (hull) | +0.02175 |
| hull-current.glb | 120 | 198 | 9216 | 54 † | +0.03273 |

Hull cage 204 quads → 1828 tris at level 1 (under the 2000 budget); 6512 for the hull alone at level 2. † the 54 (and 156 on the posts) are the glTF exporter splitting vertices on flat-shaded faces, not holes — those objects are closed before export and their signed volumes are positive.

**Variants** (L = 0.9 in all): `hull-true` true proportions, beam **0.196**, depth **0.077**. `hull-beamy` beam stretched to HULL_BEAM 0.34 (y × 1.732), depth unchanged. `hull-gamebox` — **added, not in the brief** — beam 0.34 *and* depth stretched to HULL_DEPTH 0.2 (z × 2.585); without it the experiment can't be judged.

**What I see** (viewed all 16 renders):
- Game camera at distance 6: the boat is ~80 px. All three traced variants read as a pointed double-ended boat; the current one reads as a wedge with a cut-off stern. The plan shape is the whole of the improvement.
- `hull-true` / `hull-beamy` read as a **flat leaf** in side view. True-scale depth is 8.4% of length, and 0.077 units is exactly the "flat plank with a card on it" the HULL_DEPTH comment records being fixed once already. Stretching beam alone does not rescue it.
- `hull-gamebox` is the only variant that reads as a hull from side and bow ¾: real freeboard, curved bilge, pointed both ends.
- No artifacts: no twisted quads, no open ends, no bow/stern self-intersection, normals outward. One genuine inward-normal bug was caught by the signed-volume check and fixed before the final export.

**Problems / limits:**
- Stem posts are honest but tiny — the source's posts rise only 4.4% of length above the sheer, ~4 px at the game camera. Viking read would need deliberate exaggeration.
- The traced sheer is nearly flat over the middle 90% (so is the drawing); the sweep lives in the last 5% at each end, which the posts cover.
- Side and plan are registered by normalized length only (1582 vs 1550 px), not by station marks — a sub-1% fore-aft shear is possible.
- The keel timber (~7% of half-beam) is pulled to zero so the half-sections close on the centreline. Sub-pixel at this scale.

**Outputs**, `ls -la` of `.boat-ref/out/` (bytes):
```
REPORT.md 5315   contact-sheet.png 1506914   game-compare.png 91948
trace-debug.png 1046495   curves.json 52434   mesh.json 61873
counts-build.json 352   counts-glb.json 323
hull-true.glb 42188   hull-beamy.glb 42188   hull-gamebox.glb 42188   hull-current.glb 9216
hull-true-{game 241059, side 245779, top 250058, bow34 239817}.png
hull-beamy-{game 240749, side 245735, top 252576, bow34 240909}.png
hull-gamebox-{game 241781, side 251225, top 255062, bow34 247475}.png
hull-current-{game 240858, side 243964, top 249488, bow34 241596}.png
```
Nothing outside `.boat-ref/` was touched; nothing was committed.
