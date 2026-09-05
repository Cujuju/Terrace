# Brief: fish+whales → Blender pass 2 — the shark (model-only)

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TypeScript strict, three 0.185.1,
SolidJS client, Node 24 server). You run in your own git worktree (the harness created it;
`pwd` to find it). The worktree has no node_modules: run `pnpm install --frozen-lockfile`
first (~45 s; the lockfile must come back unchanged). Commit to the worktree branch,
conventional messages, no attribution. Do not merge, do not push, never touch the main
checkout directly. When done, call ExitWorktree with action "keep".

Owner decision (2026-09-04): every fish and whale in plugins/wildlife becomes a Blender-built
GLB asset, one species per pass. Pass 1 (merge 36c9e41) landed the adapter and the shallow
fish. This pass is MODEL-ONLY: the shark (`shark`) goes through the adapter that exists. You
add one `SpeciesAssetSpec`, one `SPECIES_ASSETS` row, one build script, one .glb, and a
rewritten `shark.ts` that keeps its envelope and its `animate`. You do NOT change the adapter's
contract (`plugins/wildlife/client/species/assetSpecies.ts`) unless this brief says so.

## Read first — verify every claim against code; comments are claims, not evidence.
Cite file:line from executed code in your report.
1. docs/model-assets.md, whole file, especially "Wildlife species" (joints `rig`, `tail`,
   `pectoral_port`, `pectoral_starboard`; anchors `nose`, `tail_tip`, `crown`, `belly`,
   `flank`; port is −Z; units are WORLD units at model scale 1, not cells).
2. plugins/wildlife/client/species/assetSpecies.ts (whole) — `installSpeciesAsset` is the
   check your file must pass: every declared joint resolves by name; the four anchors sit at
   the model's own bounding-box extremes; the anchors agree with the declared envelope;
   `flank` agrees with `halfWidth` and does not exceed the z extent. Tolerance
   `ENVELOPE_TOLERANCE_CELLS = 0.01`.
3. plugins/wildlife/client/species/fish.ts (whole) — the TEMPLATE for what shark.ts becomes:
   envelope constants + `FISH_ASSET` spec + `assetSpeciesBuilder(spec, animate)`. Read its
   header comments; they explain every decision you inherit.
4. plugins/wildlife/client/species/shark.ts (whole) — the shark you replace. Colours
   0x6b7886 body, 0x5a6674 fins, 0x0f1114 eyes. `SHARK_ENVELOPE`: length 1.72 (nose at
   +0.70 → hull half-length; caudal upper-lobe tip at −0.68−0.34 = −1.02), halfLength 0.86,
   halfWidth 0.42 (PECTORAL TIP, swept and angled), crownY 0.40 (first dorsal tip),
   bellyY −0.26 (PECTORAL TIP, angled down). Verify those numbers by evaluating the
   expressions yourself; then write them as explicit named constants in the new file the way
   fish.ts writes FISH_NOSE_X / FISH_TAIL_TIP_X. `animate`: tail yaw 1.1 Hz, 0.30 rad,
   rig counter-yaw fraction 0.28, NO pectoral motion. Keep all of that byte-for-byte in
   behaviour.
5. plugins/wildlife/client/placement.ts — `SWIM_PROFILES.shark` (~L197) and `BODY_COLUMNS`
   (~L334) read SHARK_ENVELOPE. They say in their own comments that halfWidth is the pectoral
   tips and bellyY the pectoral tip. That is the contract. Do not change placement.ts.
6. plugins/wildlife/client/index.ts L270–345 — the per-species surface table,
   `SINGLE_SURFACE_SPECIES` (shark is one of them: your .glb must bake to ONE surface),
   `SPECIES_ASSETS`, `preload`.
7. client/src/previewSpecies.ts L37–60 and L118–130, L213–218 — the preview harness installs
   FISH_ASSET by hand. It must install the shark too. Two hand-kept asset lists (here and
   index.ts) is duplication; see Deliverable C.
8. tools/blender/build_fish.py (whole, 859 lines) — the build-not-download pattern you copy:
   named constants, `srgb()` for every colour (Base Color is linear; our hexes are sRGB), ONE
   `SURFACE_ROUGHNESS` for every material (roughness is not in rigSkin's material signature,
   so two roughnesses would silently merge), winding check, the vertex-inside parity
   attachment check that ASSERTS, the envelope print, anchors as Empties, export via
   export_glb.py. tools/blender/stat_glb.py and render_glb.py for the checks.
9. client/src/render/rigSkin.ts ~L95–130 (`materialSignature`) — why one surface is not luck.
10. `/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a69c65dfb12ef32f1/plugins/wildlife/.verify-fish-asset.mts`
    — pass 1's uncommitted Node verification script (parseRigAsset off disk → installSpeciesAsset
    → bakeRig → surfaceCount/joints/tris). Copy it into your worktree as
    `plugins/wildlife/.verify-shark-asset.mts`, parameterise for the shark, leave it uncommitted.

Blender 5.2: "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background
--python <script> -- <args>. Paths passed INTO Blender are Windows paths (`wslpath -w`).

## Deliverables

### A. `tools/blender/build_shark.py` → `plugins/wildlife/client/assets/shark.glb`
Built in Blender, not downloaded. The owner's fidelity bar: a real shark, not a grey blob and
not flat plates. Must read as a shark at the play camera's ~55° downward angle (the `iso`
render) and hold up side-on:
- Long fusiform body, round section, belly flattened a little; pointed snout; a narrow
  peduncle with a keel; a slight underslung mouth line is welcome.
- HETEROCERCAL caudal: upper lobe far longer than the lower, a notch between — this is the
  tell that separates it from the fish. Fins have thickness and a rounded root blending into
  the body; never a zero-thickness plane.
- Tall triangular first dorsal amidships (this is crownY), small second dorsal aft, anal fin,
  paired pelvics, broad swept pectorals with anhedral.
- Five gill slits as real grooves/ridges on each flank behind the head; eyes; a countershade
  is welcome (lighter belly) IF it stays inside the one-surface rule below.
- Materials: `MeshStandardMaterial`-compatible flat colours only (no textures, no PBR maps
  beyond colour + the one shared roughness). Body 0x6b7886, fins 0x5a6674, eyes 0x0f1114 via
  `srgb()`. A countershade must be a vertex-colour or a fourth flat material of the same
  roughness — anything that would give a second surface fails the draw-budget assertion.
- Nothing floating: every fin, eye and gill detail shares volume with the body. Run the
  odd-parity vertex-inside check (fish's pattern) for every non-body part and ASSERT; print
  the counts.
- Every dimension a named constant with a one-line reason. No magic numbers.

Joints and anchors (Empties, exact names):
- `rig` at the origin, everything under it.
- `tail` AT THE PEDUNCLE (x ≈ −0.68), the caudal mesh its child.
- `pectoral_port` (−Z) and `pectoral_starboard` (+Z) at the flank root, at IDENTITY rotation,
  each pectoral mesh its child. **The anhedral is BAKED INTO THE MESH under the identity hinge**
  — read why in the next paragraph.
- `nose` (x = +0.70, model's x max), `tail_tip` (x = −1.02, model's x min: the upper caudal
  lobe's tip), `crown` (y = +0.40, model's y max: first-dorsal tip), `belly` (y = −0.26,
  model's y min), `flank` (z = ±0.42, |z| ≤ model's z extent).

WHY THE ANHEDRAL IS IN THE MESH, AND A RULE TO WRITE DOWN. The fish authors its pectorals
flat and sets the rest dihedral in `animate`, because it flutters them. The shark's
placement contract (item 5) makes its ANGLED pectoral tip BOTH the `bellyY` extreme (−0.26)
and the `halfWidth` extreme (0.42), and `installSpeciesAsset` measures the file AT REST, before
any `animate` runs. A flat-authored pectoral would leave the file's y-min at the pelvics and the
install would throw. So: an envelope extreme must exist in the file as exported. The shark's
pectorals therefore carry their anhedral in the mesh under an identity hinge, and `animate`
leaves the hinges alone (as the procedural shark does). Add ONE short paragraph to
docs/model-assets.md "Wildlife species" stating the rule generally: *any part that is an
envelope extreme is authored in its rest pose in the file; a hinge whose rest angle is set by
`animate` (the fish's pectorals) cannot be an envelope extreme.* Also amend the `flank` bullet
so it says what `flank` measures: the half-width the species' envelope DECLARES — the body for
the fish, the angled pectoral tip for the shark — never taken from the bounding box.

### B. `plugins/wildlife/client/species/shark.ts` rewritten, fish.ts-shaped
- Keep `SHARK_ENVELOPE` exported with the same five values (now explicit constants with
  reasons, as fish.ts does). Placement must be untouched and byte-identical in behaviour.
- `export const SHARK_ASSET: SpeciesAssetSpec = { species: 'shark', file: 'shark.glb',
  joints: SWIMMER_JOINTS, envelope: SHARK_ENVELOPE }`.
- `export const buildShark = assetSpeciesBuilder(SHARK_ASSET, animate)` with the SAME motion
  (TAIL_HZ 1.1, TAIL_SWING_RADIANS 0.30, BODY_COUNTER_YAW_FRACTION 0.28; tail yaw about Y, rig
  counter-yaw about Y, nothing on pitch, pectorals untouched).
- Header comment in fish.ts's style: what changed, what did not, the anhedral-in-mesh
  decision and why. Verbose on the contract, moderate elsewhere.
- `../whaleHull.ts` and `./bodyKit.ts` lose the shark as a user; grep and STATE in the report
  which species still use each. Do not delete shared code that still has users. Do not touch
  any other species file.

### C. Wiring
- `plugins/wildlife/client/index.ts`: import `sharkUrl from '../assets/shark.glb?url'` (mirror
  fishUrl), add `{ spec: SHARK_ASSET, url: sharkUrl }` to `SPECIES_ASSETS`. Do not change
  `SINGLE_SURFACE_SPECIES` / `WILDLIFE_SPECIES_DRAW_OBJECTS` — the shark must still bake to 1
  surface; if it does not, fix the asset, not the constant.
- `client/src/previewSpecies.ts` must install the shark. Two hand-kept lists is the
  duplication the project forbids: move the `SPECIES_ASSETS` table to a module both import
  (e.g. `plugins/wildlife/client/species/assets.ts`, exporting the table of `{spec, url}`) if
  that creates no import cycle and keeps `.glb?url` resolvable from both (check
  `plugins/wildlife/client/glb-url.d.ts` and `types/glb-url.d.ts`; the checklist says the
  root d.ts covers every package — verify, do not add a new d.ts). If a cycle or a resolution
  problem stops you, keep two lists and say so explicitly in the report with the reason.

### D. Verification (report each with the command and its output)
- `pnpm typecheck` at root.
- Wildlife tests PER FILE: `cd plugins/wildlife && for f in test/*.test.ts; do timeout 240
  npx vitest run "$f"; done`. Running all four together hook-times-out on /mnt/e (known); per
  file is the accepted form. Never run whole-workspace tests. NO new test files (owner's
  per-session rule, not granted). If an existing assertion encodes the procedural shark,
  change the minimum and list it.
- Blender build log: winding, attachment counts, envelope measured-vs-declared print.
- `stat_glb.py` on the exported shark.glb: node names, mesh count, materials, bounds, tris.
- `.verify-shark-asset.mts` under Node: `installSpeciesAsset: accepted shark.glb`, anchors,
  surfaceCount (must be 1), joint count, triangle count; also the OLD procedural shark's
  surfaces/joints/tris measured from `git show HEAD:plugins/wildlife/client/species/shark.ts`
  the way pass 1 did, for the report's draw-budget table.
- Renders: `render_glb.py --name shark --views iso,side,front,top` (no --ground/--water) into
  tools/blender/out/ — uncommitted. VIEW all four yourself (Read the PNGs) before reporting
  and say in one sentence each what you see. If a fin reads as a plate, a part floats, or the
  colour is not the declared grey, fix and re-render before finishing.
- Triangle budget: aim under ~4 000 tris (the fish is 2 012 at 0.72 long; the shark is 2.4×
  longer and gets more, but 140 fps is the benchmark and draw calls, not tris, are the cost —
  keep it reasonable and report the number).

## Constraints
- Determinism: nothing in shared/. Client-only + tools.
- Do not start or stop the app (server/client). In-game eyes-on is the orchestrator's step.
- Do not change assetSpecies.ts's behaviour. Doc additions only as specified in A.
- Commit: the .glb, build_shark.py, shark.ts, index.ts (+ assets.ts if created),
  previewSpecies.ts, docs/model-assets.md, and the report. NOT the renders, NOT the
  .verify-*.mts.
- Report: write `.claude/orchestration/briefs/shark-glb-pass2-report.md` in the worktree:
  what landed (file:line), envelope measured vs declared (Blender and Node), the draw-budget
  table old/new (surfaces/joints/tris), the SPECIES_ASSETS single-list decision and its
  outcome, whaleHull/bodyKit remaining users, verification outputs, the four render paths with
  your one-sentence read of each, anything left undone and why. End the report with the
  worktree path, branch name and final commit hash.
