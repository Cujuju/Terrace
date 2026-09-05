# Brief 5A: the wolf in game (#335)

Repo: /mnt/e/Development/Projects/Terrace. You run in your own git worktree (harness-created;
`pwd` and `git branch --show-current` first; use that root for EVERY command — never `cd` to
the main checkout, never edit it). Commit on the branch; do not merge or push.
GitHub issue: Cujuju/Terrace#335. Time box: 90 minutes wall clock; if you are not at D4 by
60 minutes, commit what compiles and report where you are.

Owner, 2026-09-04: "add the wolf in game." The wolf is a Quaternius CC0 model already fetched
(.model-import/src/Wolf.glb; LICENSES.md entry in .model-import/LICENSES.md L16–30). The deer
went in on 2026-09-04 as the first downloaded species and, since merge 86465c2 (#328), a
downloaded animal keeps its real skin weights — so the wolf is imported WITHOUT `--rigidify`,
exactly the way the deer now is. The deer is your worked example for every step.

SCOPE, decided: a new LAND-WALKER species that spawns, walks, idles and is drawn. NO hunting,
no fleeing, no effect on other species — "predator" is what the animal is, not a mechanic;
predation is an owner design decision and is out of this brief (say so in the report as a
named punt). Don't add flags or hooks for it either.

## Read first — verify against code, cite file:line in your report. Comments are claims.

1. plugins/wildlife/client/species/grazer.ts (whole file, post-#328), assets/LICENSES.md
   L14–70 (the deer's exact import command, post-#328), species/assets.ts (THE ONE LIST of
   asset species), species/assetSpecies.ts (`SpeciesAssetSpec`, `rigidified`, `adopt`,
   envelope anchors), species/quadruped.ts (`poseWalk`, the joint names it drives).
2. plugins/wildlife/client/models.ts ~L77, ~L98, ~L544–615 (how a species builder is
   registered and drawn); index.ts ~L265–360 (the draw-budget table, the constants, the
   preload, the boot-time surface-count assertion); placement.ts L36–37, ~L181, ~L300, ~L330,
   ~L669 (every per-species table a walker must have a row in — grep `ibex:` to find them
   all; a missing row is a type error, which is the point).
3. plugins/wildlife/protocol.ts L30–82 (WILDLIFE_HABITAT_SPECIES is APPENDED, never sorted:
   spawn order is deterministic and the order matters); server/species.ts (SPECIES_PROFILES
   L89+, the grazer row L175–238 and its argued numbers), server/species/ibex.ts and
   bison.ts (one file per species with named, argued constants; IdleBouts), server/species/
   profile.ts (SpeciesProfile, SpawnGround, size/schooling tables).
4. plugins/wildlife/test/ — read the tests that pin species tables (grep `ibex`) so you
   know what the new row must satisfy. DO NOT ADD TESTS. Existing table-driven tests that
   enumerate species must still pass; if one enumerates by hand and needs the wolf added to
   its list, that is an edit to an existing test and is allowed — say so in the report.
5. tools/blender/import_model.py (post-#328), stat_glb.py, .model-import/blender.sh,
   .model-import/wolf.log (the previous, rigidified import: bone list at the end — the leg,
   head, tail and IK bone names you will `--rename`/`adopt`).
6. client/src/previewSpecies.ts + client/scripts/shootSpeciesPreview.mjs header (static
   build → http.server on a scratch port → CDP shots; Vite dev on /mnt/e does not watch).
7. .claude/orchestration/briefs/assets-p4-report.md — the #328 report; its "two follow-ups"
   section names the stat_glb.py defect D0 fixes.

## Deliverables

D0. tools/blender/stat_glb.py: `--footprint` fails on any skinned .glb because Blender's glTF
    importer fabricates an `Icosphere` bone-display mesh at the origin (report, follow-up 2).
    Fix at the root: exclude objects the importer created that are not in the file (check
    what the importer marks them with — a custom property, a name, or parent-to-armature —
    verify in Blender rather than guessing; if nothing marks them, drop meshes that are
    children of an armature object and have no vertex groups, and say why that is safe).
    Prove it: stat_glb.py --footprint on the deer passes and prints the same box as before.
D1. Import: `.model-import/out/wolf.glb` → plugins/wildlife/client/assets/wolf.glb via
    import_model.py from .model-import/src/Wolf.glb, no `--rigidify`, `--drop Icosphere`,
    `--forward -Y --up +Z --origin ground`, `--rename` the four upper-leg bones and Head to
    the quadruped joint names (foreLeft/foreRight/hindLeft/hindRight/head), `--height` and
    `--footprint` chosen and ARGUED: the wolf stands lower than the deer's 0.464 and below
    PILGRIM_HEIGHT 0.62 (grazer.ts explains the rule); derive from the deer the way the deer
    derived from its predecessor, state the number and why. Five `--anchor`s at the measured
    extremes (nose, tail_tip, crown, belly, flank) — measure with stat_glb.py after the fit,
    then re-run with the anchors, as the deer's LICENSES.md entry records. Record the exact
    command and the licence in plugins/wildlife/client/assets/LICENSES.md.
D2. Client: species/wolf.ts on the assetSpecies.ts contract (same shape as grazer.ts:
    envelope declared + asserted, joints, `rigidified: true`, `adopt` for the IK targets —
    the wolf's are IKFrontLeg.L/R and IKBackLeg.L/R per wolf.log; also decide what to do
    with PoleTarget* bones, which carry geometry or not — check the weights, cite). Walk via
    poseWalk with its own STRIDE_HZ / swing argued from the server cruise speed and body
    length. Add to species/assets.ts, models.ts, placement.ts tables, previewSpecies.ts
    species map. drawBudget: +1 surface if the file bakes to one — MEASURE
    `blueprint.surfaceCount`, do not assume; index.ts's table and constants updated.
D3. Server: protocol.ts — append `'wolf'` to WILDLIFE_HABITAT_SPECIES (last). server/
    species/wolf.ts — a SpeciesProfile with argued constants: land walker
    (LAND_WALKER_MAX_GRADIENT_PER_CELL), cruise faster than the grazer (0.8) and under the
    fastest thing already on land — check; PANIC/flee speed relations grazer.ts's row argues
    (L183–186) must still hold — read them; small pack (schooling like the bison's group or
    solitary — pick one, argue it); idle bouts (a wolf ranges: mostly moving, short pauses —
    argue the two rates against ibex/bison); spawn ground: open country at any height or
    upland — pick and argue; density LOW (it is a predator by silhouette; a hillside with
    more wolves than deer reads wrong): argue against the grazer's 2 700 and the population
    cap maths in species.ts L190–210. Wire into SPECIES_PROFILES and the re-exports.
    Determinism rule: fixed iteration order, integer/exact math where shared/ is touched
    (you should not need to touch shared/ — if you do, stop and say why).
D4. EYES-ON: preview-species shots of the wolf — side, iso, stride at t=0.125 — saved to
    .model-import/shots/wildlife/wolf-{side,iso,stride}.png. VIEW them (Read tool) before
    claiming anything; describe what you see: hooves/paws on the legs, no seams, no stray
    geometry at the origin, head the right way round (+X forward). If the preview-wildlife
    harness (the pool path) accepts ?species=wolf, shoot that too — it proves the wiring.
D5. `pnpm typecheck` clean; run ONLY `pnpm --filter @terrace/plugin-wildlife test` and the
    client rig tests (`pnpm --filter client exec vitest run test/rigAsset.test.ts
    test/rigSkinMaterials.test.ts test/rigSkin.test.ts`), each under `timeout 300`. Never
    `pnpm -r test`. Also: since this appends a species, run any server test that pins the
    census/spawn order (grep plugins/wildlife/test and server/test for WILDLIFE_HABITAT_SPECIES).
D6. Report at .claude/orchestration/briefs/assets-p5-report.md: every number you chose with
    its argument; file:line for each wiring point; measured envelope and surfaceCount; shot
    paths; the tests run and their counts; the predation punt; anything assumed labelled
    "Assumption:".

## Rules

- Blender runs on Windows through .model-import/blender.sh — read it; paths are E:\ style.
  .model-import/ is gitignored and lives in the SHARED checkout; writing .glb/.png/.log
  outputs there is fine (it is where they live); never run git there.
- Never start or stop the game server/client. A static http.server on a scratch port for the
  preview is fine; record its pid to a file and kill only that pid — never `pkill -f`.
- `git add` exact paths only. Conventional commits, no attribution lines. No new
  dependencies. Comments ≤30 words, only where necessary; constants named and argued.
- Another session works on fish/whales in plugins/wildlife/client/species/{fish,ray,shark,
  eel,angelfish}.ts, server/species/{ray,shark,eel,angelfish}.ts and tools/blender/build_*.py
  — do not touch those files. Keep edits to shared tables (protocol.ts, species.ts,
  models.ts, placement.ts, index.ts, assets.ts) minimal and additive so the merge is clean.
