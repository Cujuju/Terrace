# Brief: skiff GLB, phase 5 — float on the rendered sea, and moor only where the whole orbit is water (GH #327, items 2 and 3, client half)

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TS strict, three.js client, Node 24 server via type stripping).
Work ONLY in the arc worktree (phase 4 is committed there):
  /mnt/e/Development/Projects/Terrace/.claude/worktrees/skiff-glb-models   (branch skiff-glb-models)
Never edit or run git against the main checkout. Commit to branch skiff-glb-models, staging ONLY your exact paths
(never `git add -A`, never a bare `git add`). Do not push. Do not merge. Do not install dependencies. Never start the app.
Comments are claims, not evidence: verify from executed code and cite file:line in your report.
TESTS (owner rule): do NOT add new test cases. You MAY edit existing tests only as far as the changed contract forces
(fixtures, signatures, renamed fields); list every such edit in the report. Run only the structures package's tests,
with a timeout (`timeout 120 pnpm --filter <structures pkg> test`, find the package name in plugins/structures/package.json);
never `pnpm -r test`. Run `pnpm typecheck` from the worktree root.
Read first: .claude/orchestration/briefs/skiff-p4-report.md (the asset now carries a `dryline` Empty).

## Owner defects (2026-09-04, verbatim): "the water should not render inside of the boat. The skiffs also should have
collision detection with terrain and right now they pass into the terrain."

## Part A — the sea inside the hull: the client's half
Root cause (verified): plugins/structures/client/skiffModels.ts floats the asset's `waterline` at SKIFF_FLOAT_WORLD_Y = 0,
but the renderer draws the sea at `SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT` (client/src/render/water.ts:510,
lift = 1/32 world units, client/src/config.ts:248). The comment on SKIFF_FLOAT_WORLD_Y says the lift is "far smaller
than any clearance here"; it is 0.031 against a sole that cleared the waterline by 0.008. On top of that the bob
(SKIFF_BOB_AMPLITUDE_WORLD_UNITS 0.02) is 27 % of the hull's 0.074 side depth — a swell, not the "ripple" its comment claims.
Changes:
1. Float at the RENDERED surface. SKIFF_FLOAT_WORLD_Y becomes the same expression water.ts uses. Do not restate it: export
   one named constant for "world Y of the drawn sea surface" from the module that owns it (water.ts's local `surfaceY`,
   or a new export beside WATER_SURFACE_LIFT in client/src/config.ts — pick the one that (a) water.ts itself can consume
   so the two cannot drift, and (b) does not drag `import.meta.env` (config.ts:59,71) into any node test import graph;
   check what the structures test files actually import before deciding, and say which you chose and why). Change
   water.ts to read that constant (one-line change; nothing else in core). Rewrite the SKIFF_FLOAT_WORLD_Y comment to
   state the true relationship; drop the `: 0` annotation only if the new expression makes it wrong.
2. SKIFF_BOB_AMPLITUDE_WORLD_UNITS = 0.006 (≈8 % of side depth), comment giving that ratio and naming the asset's
   SOLE_DRY_CLEARANCE_MIN (tools/blender/build_skiff.py) it must stay under.
3. installSkiffKit reads the `dryline` anchor and throws (naming the file) unless
   `dryline.y - waterline.y >= SKIFF_BOB_AMPLITUDE_WORLD_UNITS`: the asset's dry-interior promise checked against the
   animation that could break it, at load, so neither side can silently regress the other. Add the anchor to the kit's
   documented contract at the top of the file.

## Part B — skiffs pass into the terrain: the placement contract
Root cause (verified this session): site.ts's surveySite hands skiffs.ts the NEAREST confirmed-water cells — by
construction the shoreline — and a skiff then orbits up to 0.28 world units (1.1 cells) around it with a 0.36-long hull,
reaching 0.46 world units (1.8 cells) from its anchor. skiffs.ts:70-84 already names this as the residual. Two further
facts, verified: (i) site.ts samples `terrainHeightAt` (the LATTICE band), but what the boat is seen against is the
DRAWN cap, which disagrees with the lattice by a whole band next to a contour (client/src/plugins/types.ts:211-216;
client/src/terrain/drawnGround.ts header) — and the shoreline IS a contour; (ii) the drawn ground is queryable at a
quarter-cell grid through `ctx.drawnGroundYAt` (types.ts:227; world.ts:977-985 → drawnGround.capYAt, an array read into
a precomputed band grid, client/src/terrain/drawnGroundStore.ts:80 BAND_GRID_CELLS = 1/4).
Contract change — "a mooring is a water cell whose whole reachable area is drawn as water":
1. skiffs.ts owns the hull's silhouette budget: export SKIFF_HULL_LENGTH_WORLD_UNITS = 0.36 and SKIFF_HULL_BEAM_WORLD_UNITS
   = 0.14 (moved from skiffModels.ts's SKIFF_FOOTPRINT, which now builds its footprint from them — one source), and a
   DERIVED `SKIFF_MOORING_CLEARANCE_WORLD_UNITS = SKIFF_ORBIT_RADIUS_MAX_WORLD_UNITS + SKIFF_HULL_LENGTH_WORLD_UNITS / 2`
   (the farthest any point of a hull gets from its anchor, whatever the roll or heading — the orbit formula in
   skiffModels.ts writeFrame plus the geometry's reach; justify why the bob does not enter it). Rewrite the residual
   paragraph at skiffs.ts:70-84 to describe the guarantee that now holds and where it is enforced.
2. site.ts: `surveySite(groundAt, drawnAt, x, y)` — a second lookup of the same GroundLookup type for the drawn cap.
   The coastal/inland/pending verdict is UNCHANGED and still uses the lattice count. `waterCells` is renamed `moorings`
   with the new meaning: the nearest confirmed-water cells (lattice, as today) that ALSO pass `isMoorable`: every sample
   of the square of half-side `SKIFF_MOORING_CLEARANCE_CELLS = Math.ceil(SKIFF_MOORING_CLEARANCE_WORLD_UNITS / CELL_WORLD_SIZE)`
   (= 2 today; derive, do not write 2) around the cell, stepped at the drawn ground's own grid pitch (import
   BAND_GRID_CELLS from drawnGroundStore.ts so the two cannot drift; explain in a comment why a coarser step could miss a
   contour bulge between samples), reads `drawnAt` ≤ CONFIRMED_WATER_MAX_WORLD_Y. A null sample (undrawn / unreceived)
   is NOT moorable — the same under-count-never-over-count direction the file banner already commits to. The scan keeps
   going past the coastal threshold until SURVEY_WATER_CELLS_RETAINED moorings are kept or the disc is exhausted (update
   the early-out and its comment; keep the disc as the hard bound). A coastal settlement with zero moorings is still
   coastal (fishing-hut variant) and floats nothing — say so in a comment: that is the guarantee working.
   Cost: state the worst-case sample count per survey in the comment (disc cells + water cells x square samples), and
   MEASURE one realistic survey (a scratch script under /tmp/claude-1000/, not committed) so the report has a number
   against the 7.1 ms budget the cache comment cites; the cache (createSiteSurveyCache) still keys on
   terrainRevisionAt — VERIFY (world.ts / terrain code, cite lines) that the drawn-ground store for a chunk is filled no
   later than the revision counter bump the cache keys on, or that a later pass re-surveys; if a survey can be cached
   against a not-yet-drawn chunk (world.drawnGroundYAt answering the blocky fallback, drawnGround.ts:194-203), say what
   corrects it and when (the 2 Hz pending retry? the next delta?) with evidence, and if nothing does, fix it (e.g. a
   survey whose moorings hit a null/undrawn sample reports `pending: true`).
3. placement.ts `placementsFor` and SiteSurveyCache.surveyAt take `drawnAt` and pass it through; index.ts passes
   `(x, y) => ctx.drawnGroundYAt(x, y)`. skiffsForSettlement's orbitRadius roll is unchanged (the mooring clearance
   already covers the max roll).
4. Existing tests: adjust fixtures/signatures only as the contract forces (the coastal fixtures need a moorable water
   block for `skiffs.length > 0`; `waterCells` → `moorings`). No new `it(...)`. In the report, list the contract-level
   tests you would ADD for the owner to approve (one line each).

## Verification
`pnpm typecheck` clean; structures tests green (paste the summary line); `git diff --stat` of your commit(s). Grep that
no other consumer of `waterCells`, `SKIFF_FOOTPRINT`, or `surveySite(` was missed (whole repo, cite hits).

## Commits (stage exact paths)
- `fix(structures): skiffs float on the drawn sea; dryline asserted against the bob (#327)`
- `fix(structures): skiffs moor only where the whole orbit is drawn as water (#327)`

## Report (short; write it to .claude/orchestration/briefs/skiff-p5-report.md and return it)
Commit hashes; the surface-constant decision; the cache-vs-drawn-store finding with file:line; measured survey cost;
every test edit; proposed tests; anything changed beyond the brief and why; anything not verified.
