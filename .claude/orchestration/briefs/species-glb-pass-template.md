# Species GLB pass — the GENERIC brief (read this, then the species sheet you were given)

You are converting ONE procedural wildlife species into a Blender-built GLB asset, through the
adapter that already exists. Everything species-specific (numbers, colours, joints, the design
decision already made for it) is on a one-page SPECIES SHEET at
`.claude/orchestration/briefs/<species>-glb-pass<N>.md`. This file is the part that is the same
for every species. Where the sheet and this file disagree, the sheet wins.

## Environment and rules
- Repo /mnt/e/Development/Projects/Terrace: pnpm workspace, TypeScript strict, three 0.185.1,
  Node 24. You run in your own git worktree (`pwd`; under `.claude/worktrees/`). Run
  `pnpm install --frozen-lockfile` first (~45 s; lockfile must come back unchanged).
- Commit to the worktree branch, conventional commits, no attribution lines. Never merge, never
  push, never touch the main checkout (reading its untracked `plugins/wildlife/.verify-*.mts`
  is fine). ExitWorktree is unavailable; finish with everything committed.
- Never start or stop the app. Never add or change test files. Never run whole-workspace tests.
- Determinism: nothing in `shared/`. Client-only + tools.
- Comments are claims, not evidence: verify every claim at file:line in EXECUTED code and cite
  it in your report.
- Blender 5.2: `"/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background
  --python <script> -- <args>`. Paths passed INTO Blender are Windows paths (`wslpath -w`).

## Read first
1. docs/model-assets.md, "Wildlife species" → "Consuming one": joints, anchors, **port is −Z**,
   WORLD units at model scale 1, "an envelope extreme is authored in its rest pose in the file",
   rest vs swept envelopes.
2. plugins/wildlife/client/species/assetSpecies.ts (whole) — `installSpeciesAsset` is the check
   your file must pass: every declared joint resolves by name (nested joints fine); anchors
   `nose`/`tail_tip`/`crown`/`belly` sit at the model's own bounding-box extremes AND agree with
   `spec.envelope`; `flank` agrees with `halfWidth` and does not exceed the z extent. Tolerance
   `ENVELOPE_TOLERANCE_CELLS = 0.01`. `rigidified` is for downloads only — not you.
3. The species files already converted — fish.ts, shark.ts, ray.ts, eel.ts, … — as TEMPLATES:
   explicit station constants, envelope object(s), `*_ASSET`, `assetSpeciesBuilder(spec,
   animate)`, header-comment style, the port/starboard sign derivation.
4. The species file you replace (named on the sheet), whole. Its exported envelope is the
   PLACEMENT CONTRACT: grep placement.ts for it. Do not change placement.ts.
5. plugins/wildlife/client/species/assets.ts — THE ONE LIST of `{spec, url}`; you add one row.
   index.ts and client/src/previewSpecies.ts loop it with `loadRigAsset(url, null)`; verify, touch
   neither unless the sheet says so.
6. plugins/wildlife/client/index.ts ~L270–320 — the per-species surface table and `drawBudget`
   assertion. Unless the sheet says otherwise, your .glb must bake to ONE surface: all materials
   `MeshStandardMaterial`, untextured, ONE roughness, colour rides as vertex data
   (`materialSignature`, client/src/render/rigSkin.ts ~L111, omits colour and includes roughness).
7. tools/blender/build_*.py (the newest first) — the pattern: every dimension a named constant
   with a one-line reason; `srgb()` for every colour (Base Color is linear, our hexes are sRGB);
   one `SURFACE_ROUGHNESS`; winding check; the odd-parity vertex-inside attachment check that
   ASSERTS; the envelope print; anchors as Empties; export via export_glb.py.
8. `plugins/wildlife/.verify-<prev>-asset.mts` (untracked, MAIN checkout) — Node verification:
   parseRigAsset off disk → installSpeciesAsset → bakeRig → surfaces/joints/tris; `--old` bakes
   the procedural species from `git show HEAD:…` for the comparison row. `.envelope-diff.mts`
   (if present, else recreate: import old file as `.old-<species>.ts` and new, compare with
   `Object.is`, print placement rows). Copy/parameterise into your worktree; leave uncommitted.
9. tools/blender/render_glb.py, stat_glb.py.

## Deliverables
A. `tools/blender/build_<species>.py` → `plugins/wildlife/client/assets/<species>.glb`. Built,
   not downloaded. Owner's fidelity bar: a real animal, not a blob and not flat plates — fins
   with root thickness and camber, parts blending into the body, nothing floating (parity check
   asserted, counts printed). Read from the play camera (~55° down, the `iso` render) and
   holding up side-on. Colours from the old file via `srgb()`. Joints and anchors as Empties
   with the exact names on the sheet; hinges at IDENTITY rotation; a part that is an envelope
   extreme is authored in its rest pose (a rest angle assigned by `animate` cannot be an
   extreme — bake it into the mesh under the identity hinge instead, as the shark does).
B. `plugins/wildlife/client/species/<species>.ts` rewritten, fish/shark/ray-shaped: envelope
   exported with IDENTICAL values (keep the derivation or write full-precision literals with the
   derivation in the comment; PROVE equality old vs new with `.envelope-diff.mts`, five fields
   plus the placement rows); joints list; `*_ASSET`; `build<Species> =
   assetSpeciesBuilder(*_ASSET, animate)` with the SAME motion constants and formulas. Old
   `left*`/`right*` joints: `sign = +1` was +Z = STARBOARD; carry the sign mapping, not the
   misnomer, and derive it in the comment. Header comment: what changed, what did not, the
   sheet's design decision and why. grep `../whaleHull.ts` and `./bodyKit.ts` users and STATE
   them; delete nothing shared.
C. One row in `species/assets.ts`.

## Verification — report each with the command and its output
- `pnpm typecheck` at root.
- Wildlife tests PER FILE: `cd plugins/wildlife && for f in test/*.test.ts; do timeout 240 npx
  vitest run "$f"; done` (`test/wildlife.test.ts` needs `--hookTimeout 120000` on /mnt/e). If an
  existing assertion encodes the old species, change the minimum and list it.
- Envelope invariance proof (old vs new: five fields + placement rows IDENTICAL).
- Blender build log: winding, attachment counts, envelope measured-vs-declared.
- `stat_glb.py` on the .glb (nodes, `parent=` chain, materials, bounds, tris).
- `.verify-<species>-asset.mts`: `installSpeciesAsset: accepted`, anchors, surfaceCount, joints,
  tris; `--old` for the procedural row.
- Renders: `render_glb.py --name <species> --views iso,side,front,top` into tools/blender/out/
  (uncommitted). VIEW all four (Read the PNGs) and write one sentence each. If a fin reads as a
  plate, a part floats, a seam shows, or the colour is off, fix and re-render before finishing.
- Triangle budget: the sheet's number; report yours.

## Commit and report
- Commit: the .glb, the build script, the species .ts, assets.ts, anything the sheet adds, and
  the report. NOT renders, NOT `.verify-*.mts` / `.envelope-diff.mts` / `.old-*.ts`.
- Report `.claude/orchestration/briefs/<species>-glb-pass<N>-report.md` in the worktree: what
  landed (file:line); envelope measured-vs-declared and the equality proof; draw-budget table
  old/new (surfaces/joints/tris); whaleHull/bodyKit remaining users; verification outputs; four
  render paths with your one-sentence read of each; anything left undone and why. End with
  worktree path, branch, final commit hash.
- Final message: worktree path, branch, final commit hash, four render paths, measured envelope
  numbers, old-vs-new equality, surfaceCount.
