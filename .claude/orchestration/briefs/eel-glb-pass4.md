# Brief: fish+whales → Blender pass 4 — the eel (model-only, a spine chain)

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TypeScript strict, three 0.185.1,
SolidJS client, Node 24 server). You run in your own git worktree (the harness created it;
`pwd` to find it). The worktree has no node_modules: run `pnpm install --frozen-lockfile`
first (~45 s; the lockfile must come back unchanged). Commit to the worktree branch,
conventional messages, no attribution. Do not merge, do not push, never touch the main
checkout directly. ExitWorktree is unavailable to you; finish with everything committed.

Owner decision (2026-09-04): every fish and whale in plugins/wildlife becomes a Blender-built
GLB asset, one species per pass. Passes 1–3 (fish 36c9e41, shark 33217ff, ray 40060c9) are
merged. This pass is MODEL-ONLY: the eel (`eel`) goes through the adapter that exists. You add
one `SpeciesAssetSpec`, one row in `species/assets.ts`, one build script, one .glb, and a
rewritten `eel.ts` that keeps its envelope and its `animate` byte-identical in behaviour. You
do NOT change `assetSpecies.ts`.

## Read first — verify every claim against code; comments are claims, not evidence.
Cite file:line from executed code in your report.
1. docs/model-assets.md, "Wildlife species" through "Consuming one": joints, anchors, port is
   −Z, WORLD units at model scale 1, "an envelope extreme is authored in its rest pose", and
   the pass-3 paragraph on rest vs swept envelopes (the eel needs ONE: its extremes are static
   at rest, and a bent eel is shorter than a straight one, so the straight file is the
   conservative reading — say so in eel.ts as the old file does).
2. plugins/wildlife/client/species/assetSpecies.ts (whole) — `installSpeciesAsset`: every
   declared joint resolves by name (nested joints are fine — `asset.node(name)` finds a node
   anywhere in the tree; verify that in client/src/render/rigAsset.ts); the four anchors sit at
   the model's bounding-box extremes; they agree with `spec.envelope`; `flank` agrees with
   `halfWidth` and does not exceed the z extent. Tolerance 0.01.
3. client/src/render/rigSkin.ts `bakeRig` (~L213–330) — CONFIRM that a joint nested under
   another joint composes its parent's rotation (a chain), and that a mesh hanging under the
   deepest joint follows the whole chain. The procedural eel relies on exactly this with nested
   Groups; the .glb must give bakeRig the same tree. Cite the lines.
4. plugins/wildlife/client/species/ray.ts, shark.ts, fish.ts — TEMPLATES: explicit station
   constants, envelope object(s), `*_ASSET`, `assetSpeciesBuilder(spec, animate)`, header
   comment style, the "which side is port" derivation.
5. plugins/wildlife/client/species/eel.ts (whole) — the eel you replace. Colours 0x3d4220 body
   (dark olive), 0x8c8a66 belly (pale), 0x333a1c fins, 0x0f0f0c eyes. `EEL_ENVELOPE` evaluates
   to: length 1.29, halfLength 0.645, halfWidth 0.075, crownY 0.07064932759133065 (ridge
   crest: hull half-height at x = −0.30 minus FIN_SEAT_BITE plus RIDGE_PEAK), bellyY −0.08625
   (hull's deepest station). Nose at +0.595, paddle tip at −0.695 (PEDUNCLE_X −0.555 −
   PADDLE_REACH 0.14). The spine: five joints at body stations SPINE_T = [0.06, 0.26, 0.46,
   0.66, 0.84], NESTED head-to-stem (spine1 is a child of spine0, …), each carrying a hull
   slice that overlaps its neighbours by 0.04 of body length (SLICES); the ridge in two halves
   under spine3/spine4; the paddle under a `tail` hinge at the stem, itself under spine4; eyes
   and pectorals under spine0. `animate`: EEL_TAIL_HZ 1.6, SPINE_AMPLITUDES [0.05, 0.09,
   0.13, 0.17, 0.21], SPINE_LAG_RADIANS 1.1, EEL_TAIL_SWING_RADIANS 0.40, rig wobble
   `sin(beat + 0.6) * 0.03`, pectoral flutter 0.10 lagging 1.1 about a 0.5 rad rest dihedral.
6. plugins/wildlife/client/placement.ts — grep `EEL_ENVELOPE`: SWIM_PROFILES.eel and
   BODY_COLUMNS.eel read it. Do not change placement.ts.
7. plugins/wildlife/client/species/assets.ts — THE ONE LIST; you add one row.
8. plugins/wildlife/client/index.ts ~L270–320 — surface table; eel is one of
   SINGLE_SURFACE_SPECIES; your .glb must bake to ONE surface (four flat colours at one
   roughness, all MeshStandardMaterial, untextured — `materialSignature` in rigSkin.ts ~L111).
9. tools/blender/build_ray.py (whole; the newest and most careful), build_shark.py — the
   pattern: named constants with reasons, `srgb()` for every colour, one `SURFACE_ROUGHNESS`,
   winding check, the odd-parity vertex-inside attachment check that ASSERTS, the envelope
   print, anchors as Empties, export via export_glb.py.
10. `/mnt/e/Development/Projects/Terrace/plugins/wildlife/.verify-ray-asset.mts` and
    `.envelope-diff.mts` (untracked, in the MAIN checkout — read them there; the latter lives in
    the pass-3 worktree's report, recreate it if absent). Copy/parameterise into your worktree
    as `.verify-eel-asset.mts` (+ `--old`) and `.envelope-diff.mts`; leave uncommitted.
11. tools/blender/render_glb.py, stat_glb.py.

Blender 5.2: "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background
--python <script> -- <args>. Paths passed INTO Blender are Windows paths (`wslpath -w`).

## The design decision of this pass, already made: the chain lives in the file

The eel IS the wave: five nested hinges, each swinging a little wider and later than the one
before. bakeRig binds each mesh rigidly to the node it hangs under and composes parent
rotations, so the .glb must carry the same tree the procedural code builds with Groups:

```
rig
└─ spine0 (x = station 0.06)         ← head slice, eyes, pectoral_port, pectoral_starboard
   └─ spine1 (x = station 0.26)      ← slice
      └─ spine2 (x = station 0.46)   ← slice
         └─ spine3 (x = station 0.66)   ← slice, ridge_a
            └─ spine4 (x = station 0.84)   ← slice, ridge_b
               └─ tail (x = PEDUNCLE_X −0.555)  ← paddle
```

Each Empty at IDENTITY rotation, positioned at its body station (in its PARENT's frame, so the
glTF export carries the chain as nested nodes — check the exported tree with stat_glb.py: it
prints `parent=`). Each slice mesh is a child of its joint and overlaps its neighbours by
SLICE_OVERLAP = 0.04 of body length so the seams stay hidden at these per-joint angles (up to
0.21 rad). Verify the overlap hides the seam at the MAX bend: pose the chain at the amplitudes
in Blender (or in Node via bakeRig + a Box3 per slice) and confirm no gap opens between slices;
print the minimum overlap at max bend.

## Deliverables

### A. `tools/blender/build_eel.py` → `plugins/wildlife/client/assets/eel.glb`
Owner's fidelity bar: a real eel, not a segmented tube. From the play camera (~55° down) and
side-on:
- Near-cylindrical body, blunt rounded snout with a slight underslung mouth line, widest just
  behind the head, long taper to a thin stem. Five slices as above, but the SURFACE must read
  continuous at rest: identical section math across slice boundaries (sample one profile
  function; ring count per slice chosen so a ring lands exactly at each boundary).
- A low continuous dorsal ridge along the rear half (two meshes under spine3/spine4 as today, or
  one per slice from spine2 on — your call; the crest at x = −0.30 is crownY). Rounded tail
  paddle (a fan, not a fork) under `tail`. Tiny paired pectorals just behind the head, with a
  visible rounded root. Two eyes flush on the snout.
- Pale belly: a separate underside strip per slice (as the procedural belly crescent) in the
  belly colour, or a fourth flat material on a split of the hull mesh — either way ONE roughness,
  one surface.
- Materials: flat colours only, `srgb()` of 0x3d4220 / 0x8c8a66 / 0x333a1c / 0x0f0f0c.
- Nothing floating: parity check for every non-hull part against the hull slices (union), asserted, counts printed.
- Every dimension a named constant with a one-line reason. No magic numbers.

Anchors (Empties, unparented or under rig, exact names): `nose` (x = +0.595, model x max),
`tail_tip` (x = −0.695, model x min: the paddle's rear), `crown` (y = crownY, model y max:
the ridge crest), `belly` (y = −0.08625, model y min), `flank` (z = ±0.075, the body's widest
station; the flat pectorals may reach further — that is the fish's case, upper bound only).

The pectoral hinges rest at identity (flat in the file), like the fish's: their 0.5 rad rest
dihedral is assigned in `animate`, and they are NOT envelope extremes (belly is the hull). State
that in the file.

### B. `plugins/wildlife/client/species/eel.ts` rewritten
- `EEL_ENVELOPE` exported with IDENTICAL values. crownY is derived today from the hull
  profiles via whaleHull.ts's `profileFromPoints`; keep it Object.is-identical either by keeping
  that small derivation (importing `profileFromPoints` for the envelope alone is acceptable) or
  by writing the full-precision literal with the derivation in the comment. Prove equality with
  the `.envelope-diff.mts` pattern from pass 3 (old vs new: all five fields IDENTICAL, plus
  SWIM_PROFILES.eel / BODY_COLUMNS.eel).
- `EEL_JOINTS = ['rig', 'spine0', 'spine1', 'spine2', 'spine3', 'spine4', 'tail',
  'pectoral_port', 'pectoral_starboard']` — the eel is not a SWIMMER_JOINTS species and says
  so. The old `leftPectoral` was sign +1 → +Z → STARBOARD; carry the sign mapping, not the
  misnomer (`leftPectoral.rotation.x = 0.5 + flutter` → `pectoral_starboard`;
  `rightPectoral` → `pectoral_port` gets `−0.5 − flutter`). Derive in the comment as ray.ts does.
- `EEL_ASSET: SpeciesAssetSpec = { species: 'eel', file: 'eel.glb', joints: EEL_JOINTS,
  envelope: EEL_ENVELOPE }`; `buildEel = assetSpeciesBuilder(EEL_ASSET, animate)` with the SAME
  motion constants and the same per-joint formula.
- `tubeSlice` and the hull profiles go with the body (they were only used here — verify by
  grep). `../whaleHull.ts` / `./bodyKit.ts`: grep and STATE remaining users; delete nothing shared.
- Header comment in the pass-3 style.

### C. Wiring
- `species/assets.ts`: one row. Nothing else (verify index.ts / previewSpecies.ts loop the list).

### D. Verification (report each with the command and its output)
- `pnpm typecheck` at root.
- Wildlife tests PER FILE with a timeout (`test/wildlife.test.ts` with `--hookTimeout 120000`).
  Never whole-workspace. NO new test files. If an existing assertion encodes the procedural
  eel, change the minimum and list it.
- Envelope invariance proof (old vs new, five fields + placement rows).
- Blender build log: winding, attachment counts, envelope measured-vs-declared, minimum slice
  overlap at max bend.
- `stat_glb.py` on eel.glb, showing the nested `parent=` chain.
- `.verify-eel-asset.mts`: accepted, anchors, surfaceCount 1, joints, tris; `--old`.
- Renders: `render_glb.py --name eel --views iso,side,front,top`, uncommitted; VIEW all four
  and write one sentence each. Also ONE posed render at max bend if render_glb.py can take a
  pose — if not, a Node-side check that the posed slices still overlap is enough; say which.
- Triangle budget: aim ≤ ~3 000 tris; report.

## Constraints
- Determinism: nothing in shared/. Client-only + tools.
- Do not start or stop the app. Do not change assetSpecies.ts. Docs: no change needed unless
  you find the chain convention worth one sentence under "Wildlife species" (then one sentence).
- Commit: eel.glb, build_eel.py, eel.ts, assets.ts, (docs if touched), and the report. NOT the
  renders, NOT .verify-*.mts / .envelope-diff.mts / .old-eel.ts.
- Report: `.claude/orchestration/briefs/eel-glb-pass4-report.md` in the worktree: what landed
  (file:line), envelope measured-vs-declared and the old-vs-new equality proof, the chain as
  exported (stat_glb parent lines), slice overlap at max bend, draw-budget table old/new,
  whaleHull/bodyKit remaining users, verification outputs, four render paths with your
  one-sentence read of each, anything left undone and why. End with worktree path, branch,
  final commit hash.
