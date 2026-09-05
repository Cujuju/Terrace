# Brief: fish+whales → Blender pass 3 — the ray (model-only, two envelopes)

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TypeScript strict, three 0.185.1,
SolidJS client, Node 24 server). You run in your own git worktree (the harness created it;
`pwd` to find it). The worktree has no node_modules: run `pnpm install --frozen-lockfile`
first (~45 s; the lockfile must come back unchanged). Commit to the worktree branch,
conventional messages, no attribution. Do not merge, do not push, never touch the main
checkout directly. ExitWorktree is unavailable to you; just finish with everything committed.

Owner decision (2026-09-04): every fish and whale in plugins/wildlife becomes a Blender-built
GLB asset, one species per pass. Pass 1 (36c9e41) landed the adapter and the fish; pass 2
(33217ff) the shark and the single asset list. This pass is MODEL-ONLY: the ray (`ray`) goes
through the adapter that exists. You add one `SpeciesAssetSpec`, one row in
`species/assets.ts`, one build script, one .glb, and a rewritten `ray.ts` that keeps its
placement envelope and its `animate` byte-identical in behaviour. You do NOT change
`assetSpecies.ts`.

## Read first — verify every claim against code; comments are claims, not evidence.
Cite file:line from executed code in your report.
1. docs/model-assets.md, "Wildlife species" through "Consuming one" — joints, anchors, port is
   −Z, units are WORLD units at model scale 1, and the rule added by pass 2: **an envelope
   extreme is authored in its rest pose in the file**. This pass is the first where that rule
   bites hard; see "Two envelopes" below.
2. plugins/wildlife/client/species/assetSpecies.ts (whole) — `installSpeciesAsset` is the check
   your file must pass: every declared joint resolves by name (`rig` must be in the file for a
   BUILT asset — `rigidified` is for downloads only, not for you); the four anchors sit at the
   model's own bounding-box extremes; the anchors agree with `spec.envelope`; `flank` agrees
   with `halfWidth` and does not exceed the z extent. Tolerance 0.01.
3. plugins/wildlife/client/species/shark.ts and fish.ts (whole) — the TEMPLATES for what ray.ts
   becomes: explicit named station constants, envelope object, `*_ASSET` spec,
   `assetSpeciesBuilder(spec, animate)`. Read the header comments; you inherit every decision.
4. plugins/wildlife/client/species/ray.ts (whole) — the ray you replace. Colours 0x3f4b5a body
   (slate blue-grey), 0x0f1114 eyes. `RAY_ENVELOPE`: length 0.33 + 0.76 = 1.09, halfLength
   0.545, halfWidth WING_ROOT_Z + WING_SPAN = 0.59, crownY = 0.59·sin(0.30) + 0.05 ≈ 0.2244,
   bellyY = −0.2244. Evaluate those yourself. Joints today: `rig`, `leftWing`, `rightWing`,
   `tail`. `animate`: wings flap about X at 0.6 Hz, 0.30 rad, opposite signs so both tips rise
   together; the tail yaws 0.12 rad lagging 1.2 rad. No tail beat propulsion.
5. plugins/wildlife/client/placement.ts L184–196 and L333 — `SWIM_PROFILES.ray` and
   `BODY_COLUMNS.ray` read RAY_ENVELOPE, and their comments say crownY/bellyY are "a wing tip at
   the top/bottom of its beat". That is a SWEPT envelope. Do not change placement.ts.
6. plugins/wildlife/client/species/assets.ts — THE ONE LIST; you add one row. index.ts and
   client/src/previewSpecies.ts both loop over it with `loadRigAsset(url, null)`; touch neither.
7. plugins/wildlife/client/index.ts L270–320 — the surface table. Ray is one of
   `SINGLE_SURFACE_SPECIES`; your .glb must bake to ONE surface (one roughness, all
   MeshStandardMaterial, untextured; `materialSignature` in client/src/render/rigSkin.ts ~L111
   is why colour rides as vertex data and roughness does not).
8. tools/blender/build_shark.py (whole) and build_fish.py — the pattern: named constants with
   reasons, `srgb()` for every colour, one `SURFACE_ROUGHNESS`, winding check, the odd-parity
   vertex-inside attachment check that ASSERTS, the envelope print, anchors as Empties, export via
   export_glb.py. The shark's `pectoral_geometry` solves a fin's tip to an exact target; you
   will want the same for the wing tip (flank at exactly 0.59).
9. `/mnt/e/Development/Projects/Terrace/plugins/wildlife/.verify-shark-asset.mts` (untracked,
   in the MAIN checkout — read it from there) — the Node verification: parseRigAsset off disk →
   installSpeciesAsset → bakeRig → surfaces/joints/tris, and `--old` to bake the procedural
   species for the comparison row. Copy to `plugins/wildlife/.verify-ray-asset.mts` in your
   worktree, parameterise, leave uncommitted.
10. tools/blender/render_glb.py, stat_glb.py.

Blender 5.2: "/mnt/e/Program Files/Blender Foundation/Blender 5.2/blender.exe" --background
--python <script> -- <args>. Paths passed INTO Blender are Windows paths (`wslpath -w`).

## Two envelopes — the design decision of this pass, already made

`installSpeciesAsset` measures the file AT REST. The ray's placement envelope is not a rest
envelope: crownY/bellyY are a wing tip at the top/bottom of its 0.30 rad beat. With the wings
authored flat (hinges at identity, the flap symmetric about flat), nothing in the file reaches
±0.2244 and a spec that declared RAY_ENVELOPE would be rejected at install.

Decision: the ray declares TWO envelope objects in ray.ts, and the relationship is written once:

- `RAY_REST_ENVELOPE` — what the FILE measures with the wings flat: `nose`/`tail_tip` x, the
  disc's crown (top of the eyes, or the disc if you seat the eyes lower) and belly (disc
  underside) at rest, `halfWidth` 0.59 (wing tip, flat). This is `RAY_ASSET.envelope` and is
  asserted at install. You choose its crownY/bellyY numbers as you author the disc; they are
  named constants with reasons, not measured after the fact.
- `RAY_ENVELOPE` — what PLACEMENT reads. Same five fields, SAME VALUES as today (length 1.09,
  halfLength 0.545, halfWidth 0.59, crownY ≈ 0.2244, bellyY ≈ −0.2244), written as
  `rest ± wingReach · sin(WING_FLAP_RADIANS)` so a reader sees it is rest + sweep. Keep the
  formula shape it has today (`(WING_ROOT_Z + WING_SPAN) * Math.sin(WING_FLAP_RADIANS) +
  MAX_HALF_HEIGHT`) so the value is byte-identical; if your rest crown is not MAX_HALF_HEIGHT
  (0.05), keep MAX_HALF_HEIGHT as the disc's half-height constant the formula uses and say in
  the comment that the eyes stand above it and are inside the sweep. placement.ts and
  BODY_COLUMNS must produce the same numbers before and after — prove it by printing both
  objects from a scratch script and diffing against `git show HEAD:…/ray.ts` evaluated the
  same way.

Document the rule generally in docs/model-assets.md "Wildlife species", one short paragraph
after the "envelope extreme is authored at rest" one: *a species whose extremes move with its
animation declares two envelopes — the REST envelope the file is checked against
(`SpeciesAssetSpec.envelope`) and the SWEPT envelope placement reads, derived in the species
.ts as rest plus animation amplitude. Fish and shark have one because their extremes are
static; the ray is the first with two.*

## Deliverables

### A. `tools/blender/build_ray.py` → `plugins/wildlife/client/assets/ray.glb`
Built in Blender, not downloaded. Owner's fidelity bar: a real ray, read from above at the play
camera's ~55° angle (the `iso` render) — nearly all wing — and holding up side-on:
- A flattened disc body blending SMOOTHLY into two great triangular wings (a manta/eagle-ray
  silhouette: wing leading edge swept back, tips well aft, trailing edge curving back into the
  body). The disc and wings should read as one continuous surface with thickness that tapers
  to the wing tips — NOT a slab with two plates bolted on. Hinge geometry: each wing mesh is
  a separate object under its hinge Empty, but it must share/penetrate volume with the disc
  at the root (parity check) so the seam is invisible at rest.
- Two cephalic lobes curling forward at the mouth (these are the `nose` extreme at +0.33).
- Eyes on top of the disc; small spiracles or a mouth slit underneath are welcome.
- A whip tail longer than the disc, tapering to the tip at x = −0.76, hung under the `tail`
  Empty at the disc's rear (x ≈ −0.26).
- Gill slits (five) on the underside are welcome if they stay in the one-surface rule.
- Materials: flat colours only, `MeshStandardMaterial`-compatible, one shared roughness. Body
  0x3f4b5a, eyes 0x0f1114 via `srgb()`. A paler underside is welcome as a fourth flat material
  of the same roughness (the ray is seen from above, so it is optional).
- Nothing floating: parity check for every non-disc part, asserted, counts printed.
- Every dimension a named constant with a one-line reason. No magic numbers.

Joints and anchors (Empties, exact names):
- `rig` at the origin.
- `wing_port` at (WING_ROOT_X, 0, −WING_ROOT_Z) and `wing_starboard` at (+WING_ROOT_Z),
  IDENTITY rotation, each wing mesh its child. (The old names `leftWing`/`rightWing` go; port
  is −Z per the docs. The old code's `leftWing` was on +Z, i.e. starboard — do not carry the
  misnomer over.)
- `tail` at (TAIL_ROOT_X, 0, 0), the whip its child.
- `nose` (x = +0.33, model x max: a cephalic lobe tip), `tail_tip` (x = −0.76, model x min),
  `crown` (y = RAY_REST_ENVELOPE.crownY, model y max at rest), `belly` (y =
  RAY_REST_ENVELOPE.bellyY, model y min at rest), `flank` (z = ±0.59, a wing tip, = z extent).

### B. `plugins/wildlife/client/species/ray.ts` rewritten
- Both envelopes as in "Two envelopes"; `RAY_ENVELOPE` exported with identical values.
- `export const RAY_ASSET: SpeciesAssetSpec = { species: 'ray', file: 'ray.glb', joints:
  RAY_JOINTS, envelope: RAY_REST_ENVELOPE }` where `RAY_JOINTS = ['rig', 'wing_port',
  'wing_starboard', 'tail']` — the ray is not a SWIMMER_JOINTS species and says so.
- `export const buildRay = assetSpeciesBuilder(RAY_ASSET, animate)` with the SAME motion:
  WING_FLAP_HZ 0.6, WING_FLAP_RADIANS 0.30, TAIL_WAVE_RADIANS 0.12, TAIL_LAG_RADIANS 1.2.
  Sign discipline, derived not copied: a rotation about +X by θ moves a point at +Z to
  y' = −z·sinθ. Today `leftWing` (+Z) gets `−flap` and `rightWing` (−Z) gets `+flap`, so both
  tips rise together when flap > 0. Therefore `wing_starboard` (+Z) gets `−flap` and
  `wing_port` (−Z) gets `+flap`. Write that derivation in the comment.
- Header comment in the fish/shark style: what changed, what did not, the two-envelope decision.
- `../whaleHull.ts` / `./bodyKit.ts` lose the ray as a user; grep and STATE remaining users.
  Delete nothing shared.

### C. Wiring
- `plugins/wildlife/client/species/assets.ts`: `import { RAY_ASSET } from './ray.ts'`,
  `import rayUrl from '../assets/ray.glb?url'`, one row. Nothing else changes in index.ts or
  previewSpecies.ts (verify they loop the list; if previewSpecies has any ray-specific code,
  say so).

### D. Verification (report each with the command and its output)
- `pnpm typecheck` at root.
- Wildlife tests PER FILE with a timeout: `cd plugins/wildlife && for f in test/*.test.ts; do
  timeout 240 npx vitest run "$f"; done`. `test/wildlife.test.ts` is known to need
  `--hookTimeout 120000` on /mnt/e (pass 2 report) — use it for that file only. Never run
  whole-workspace tests. NO new test files. If an existing assertion encodes the procedural
  ray, change the minimum and list it.
- Placement invariance: the scratch-script diff of RAY_ENVELOPE (and of `BODY_COLUMNS.ray` /
  `SWIM_PROFILES.ray` if you can evaluate them under Node) old vs new — all five numbers equal.
- Blender build log: winding, attachment counts, envelope measured-vs-declared (rest).
- `stat_glb.py` on ray.glb.
- `.verify-ray-asset.mts`: `installSpeciesAsset: accepted ray.glb`, anchors, surfaceCount 1,
  joints, tris; and `--old` for the procedural ray's surfaces/joints/tris.
- Renders: `render_glb.py --name ray --views iso,side,front,top` into tools/blender/out/
  (uncommitted). VIEW all four (Read the PNGs) and write one sentence each. If the wings read
  as bolted plates, the disc-to-wing blend is visibly stepped, or anything floats, fix and
  re-render before finishing.
- Triangle budget: aim ≤ ~3 500 tris; report.

## Constraints
- Determinism: nothing in shared/. Client-only + tools.
- Do not start or stop the app. Do not change assetSpecies.ts. Docs: only the paragraph in
  "Two envelopes".
- Commit: ray.glb, build_ray.py, ray.ts, assets.ts, docs/model-assets.md, and the report. NOT
  the renders, NOT .verify-*.mts.
- Report: `.claude/orchestration/briefs/ray-glb-pass3-report.md` in the worktree: what landed
  (file:line), both envelopes with measured-vs-declared for the rest one and the old-vs-new
  equality proof for the swept one, draw-budget table old/new, whaleHull/bodyKit remaining
  users, verification outputs, four render paths with your one-sentence read of each, anything
  left undone and why. End with worktree path, branch, final commit hash.
